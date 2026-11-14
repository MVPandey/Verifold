"""
The app API: what the person's UI reads from the lab, and the person's actions.

Every request carries the person's token, in an `Authorization: Bearer` header or, for the event stream, a `token`
query parameter, because a browser's EventSource cannot set headers. The token keeps other web pages from acting as
the person on this local server.
"""

import asyncio
import secrets
from collections.abc import AsyncGenerator, Callable
from datetime import timedelta
from typing import Annotated, Protocol

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import SecretStr, ValidationError
from sse_starlette import EventSourceResponse

from verifold.protocol.app import (
    AgentView,
    LabView,
    RerunRequest,
    SettingsChange,
    SettingsView,
    SetupView,
    StartRequest,
    TimeRequest,
)
from verifold.protocol.events import RerunRequested
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.join import AnswerView, FileText, PostLine, PostRequest, PostView, ThreadSummary, ThreadView
from verifold.protocol.usage import Usage
from verifold.server.activity import Activity
from verifold.server.errors import LabExists, NoLab, ServerError
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board
from verifold.society.errors import NotFound, SocietyError
from verifold.society.lifecycle import agreed, closing, lab_state
from verifold.society.lines import lines_of
from verifold.society.views import answer_view, latest_report, needs_person, thread_summaries, thread_view
from verifold.store.errors import SettingsChanged, SettingsInvalid, SettingsUnwritable

HEARTBEAT = 15.0
"""Seconds between messages on a quiet event stream, so that proxies and browsers keep it open."""


class Host(Protocol):
    """What the app API needs from the process that runs the folder's lab."""

    @property
    def lab(self) -> Lab | None:
        """The folder's lab, or `None` before the person starts one."""
        ...

    def setup(self) -> SetupView:
        """Return what the setup screen offers."""
        ...

    async def start(self, request: StartRequest) -> None:
        """Start a lab and its agents."""
        ...

    def settings(self) -> SettingsView:
        """Return the person's settings files, and the copy that the folder's lab follows."""
        ...

    async def change_settings(self, change: SettingsChange) -> SettingsView:
        """Change one setting, and apply the change to the folder's lab."""
        ...

    async def file_text(self, post_id: PostId, path: str) -> FileText:
        """Return the text of a file that backs a post, at the commit that the post pins."""
        ...


def app_api(host: Host, activity: Activity, person_token: SecretStr) -> FastAPI:
    """Return the app API for the folder's lab. It acts as the person who holds `person_token`."""
    api = FastAPI(title='Verifold', docs_url=None, redoc_url=None, openapi_url=None)
    authorized = Depends(_authorize(person_token))

    def current() -> Lab:
        lab = host.lab
        if lab is None:
            raise NoLab('This folder has no lab yet. Start one from the setup screen.')
        return lab

    @api.exception_handler(SocietyError)
    @api.exception_handler(ServerError)
    @api.exception_handler(SettingsInvalid)
    @api.exception_handler(SettingsChanged)
    @api.exception_handler(SettingsUnwritable)
    @api.exception_handler(ValidationError)
    async def _refused(_: Request, error: Exception) -> JSONResponse:
        conflict = isinstance(error, NoLab | LabExists | SettingsChanged)
        status = 404 if isinstance(error, NotFound) else 409 if conflict else 400
        # A file that Verifold can't write is its own failure, not the request's. The reason still reaches the app.
        status = 500 if isinstance(error, SettingsUnwritable) else status
        return JSONResponse({'detail': str(error)}, status_code=status)

    @api.get('/setup', dependencies=[authorized])
    async def setup() -> SetupView:
        return host.setup()

    @api.post('/labs', dependencies=[authorized])
    async def start(request: StartRequest) -> SetupView:
        await host.start(request)
        return host.setup()

    @api.get('/settings', dependencies=[authorized])
    async def settings() -> SettingsView:
        return host.settings()

    @api.post('/settings', dependencies=[authorized])
    async def change_settings(change: SettingsChange) -> SettingsView:
        return await host.change_settings(change)

    @api.get('/lab', dependencies=[authorized])
    async def lab() -> LabView:
        return _lab_view(current().board, activity)

    @api.post('/time', dependencies=[authorized])
    async def time(request: TimeRequest) -> LabView:
        running = current()
        await running.set_time_left(timedelta(minutes=request.minutes))
        return _lab_view(running.board, activity)

    @api.get('/threads', dependencies=[authorized])
    async def threads() -> tuple[ThreadSummary, ...]:
        return thread_summaries(current().board, PERSON)

    @api.get('/threads/{thread_id}', dependencies=[authorized])
    async def thread(thread_id: ThreadId) -> ThreadView:
        return thread_view(current().board, PERSON, thread_id)

    @api.get('/report', dependencies=[authorized])
    async def report() -> PostView | None:
        return latest_report(current().board)

    @api.get('/answer', dependencies=[authorized])
    async def answer() -> AnswerView | None:
        return answer_view(current().board)

    @api.get('/posts/{post_id}/file', dependencies=[authorized])
    async def file(post_id: PostId, path: str) -> FileText:
        return await host.file_text(post_id, path)

    @api.get('/needs', dependencies=[authorized])
    async def needs() -> tuple[PostView, ...]:
        return needs_person(current().board)

    @api.post('/posts', dependencies=[authorized])
    async def post(request: PostRequest) -> PostView:
        return await Member(current(), PERSON).post(request)

    @api.post('/reruns', dependencies=[authorized])
    async def rerun(request: RerunRequest) -> RerunRequested:
        return await Member(current(), PERSON).rerun(request.post)

    @api.get('/events', dependencies=[authorized])
    async def events() -> EventSourceResponse:
        return EventSourceResponse(_changes(host, activity))

    return api


def new_person_token() -> SecretStr:
    """Return a new token for the person."""
    return SecretStr(secrets.token_urlsafe(32))


def _authorize(person_token: SecretStr) -> Callable[[Request, str | None], None]:
    def check(request: Request, token: Annotated[str | None, Query()] = None) -> None:
        scheme, _, sent = request.headers.get('authorization', '').partition(' ')
        given = sent if scheme.lower() == 'bearer' else token or ''
        if not secrets.compare_digest(given, person_token.get_secret_value()):
            raise HTTPException(status_code=401, detail='Open the lab with the link that verifold printed.')

    return check


def _lab_view(board: Board, activity: Activity) -> LabView:
    working = lines_of(board)
    done = closing(board)
    return LabView(
        state=lab_state(board),
        close=PostLine.of(done) if done else None,
        close_agreed=len(agreed(board, done)) if done else 0,
        question=board.opened.question,
        opened_at=board.opened.at,
        seq=board.seq,
        agents=tuple(_agent_view(board, activity, entry.agent.id, working) for entry in board.agents),
        threads=len(board.threads),
        posts=len(board.posts),
        needs_you=len(needs_person(board)),
        ends_at=board.ends_at,
        out_of_time=board.out_of_time,
        settings=board.settings,
    )


def _agent_view(board: Board, activity: Activity, agent_id: str, working: dict[AgentId, ThreadId | None]) -> AgentView:
    joined = board.agent(agent_id)
    if joined is None:
        raise NotFound(f'No agent has the ID {agent_id}.')
    turns = tuple(turn for turn in board.turns if turn.agent == agent_id)
    costs = tuple(turn.cost_usd for turn in turns if turn.cost_usd is not None)
    role, status = board.profile(agent_id)
    return AgentView(
        agent=joined.agent,
        role=role,
        status=status,
        thread=working.get(agent_id),
        activity=activity.of(agent_id),
        turns=len(turns),
        posts=sum(entry.post.author == agent_id for entry in board.posts),
        usage=Usage(
            input_tokens=sum(turn.usage.input_tokens for turn in turns),
            cached_input_tokens=sum(turn.usage.cached_input_tokens for turn in turns),
            output_tokens=sum(turn.usage.output_tokens for turn in turns),
        ),
        cost_usd=sum(costs) if costs else None,
    )


async def _changes(host: Host, activity: Activity) -> AsyncGenerator[dict[str, str]]:
    # Each message says only what changed. The UI reads the views again, so the stream never repeats the record.
    # Before a lab starts, only the activity changes: starting a lab marks its agents as starting.
    seq, version = _seq(host), activity.version
    while True:
        waits = {asyncio.ensure_future(activity.wait_for_change(version, HEARTBEAT))}
        if lab := host.lab:
            waits.add(asyncio.ensure_future(lab.wait_for_change(seq, HEARTBEAT)))
        _, pending = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        for waiting in pending:
            waiting.cancel()
        seq, version = _seq(host), activity.version
        yield {'event': 'change', 'data': f'{{"seq": {seq}, "activity": {version}}}'}


def _seq(host: Host) -> int:
    lab = host.lab
    return lab.board.seq if lab else 0
