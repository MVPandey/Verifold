"""
The app API: what the person's UI reads from the lab, and the person's actions.

Every request carries the person's token, in an `Authorization: Bearer` header or, for the event stream, a `token`
query parameter, because a browser's EventSource cannot set headers. The token keeps other web pages from acting as
the person on this local server.
"""

import asyncio
import secrets
from collections.abc import AsyncGenerator, Callable
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import SecretStr, ValidationError
from sse_starlette import EventSourceResponse

from verifold.protocol.app import AgentView, LabView, RerunRequest
from verifold.protocol.events import RerunRequested
from verifold.protocol.ids import PERSON, ThreadId
from verifold.protocol.join import PostRequest, PostView, ThreadSummary, ThreadView
from verifold.protocol.usage import Usage
from verifold.server.activity import Activity
from verifold.server.errors import ServerError
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board
from verifold.society.errors import NotFound, SocietyError
from verifold.society.views import needs_person, thread_summaries, thread_view

HEARTBEAT = 15.0
"""Seconds between messages on a quiet event stream, so that proxies and browsers keep it open."""


def app_api(lab: Lab, activity: Activity, person_token: SecretStr) -> FastAPI:
    """Return the app API for one lab. It acts as the person who holds `person_token`."""
    api = FastAPI(title='Verifold', docs_url=None, redoc_url=None, openapi_url=None)
    person = Member(lab, PERSON)
    authorized = Depends(_authorize(person_token))

    @api.exception_handler(SocietyError)
    @api.exception_handler(ServerError)
    @api.exception_handler(ValidationError)
    async def _refused(_: Request, error: Exception) -> JSONResponse:
        return JSONResponse({'detail': str(error)}, status_code=404 if isinstance(error, NotFound) else 400)

    @api.get('/lab', dependencies=[authorized])
    async def lab_view() -> LabView:
        board = lab.board
        return LabView(
            question=board.opened.question,
            opened_at=board.opened.at,
            seq=board.seq,
            agents=tuple(_agent_view(board, activity, entry.agent.id) for entry in board.agents),
            threads=len(board.threads),
            posts=len(board.posts),
            needs_you=len(needs_person(board)),
        )

    @api.get('/threads', dependencies=[authorized])
    async def threads() -> tuple[ThreadSummary, ...]:
        return thread_summaries(lab.board, PERSON)

    @api.get('/threads/{thread_id}', dependencies=[authorized])
    async def thread(thread_id: ThreadId) -> ThreadView:
        return thread_view(lab.board, PERSON, thread_id)

    @api.get('/needs', dependencies=[authorized])
    async def needs() -> tuple[PostView, ...]:
        return needs_person(lab.board)

    @api.post('/posts', dependencies=[authorized])
    async def post(request: PostRequest) -> PostView:
        return await person.post(request)

    @api.post('/reruns', dependencies=[authorized])
    async def rerun(request: RerunRequest) -> RerunRequested:
        return await person.rerun(request.post)

    @api.get('/events', dependencies=[authorized])
    async def events() -> EventSourceResponse:
        return EventSourceResponse(_changes(lab, activity))

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


def _agent_view(board: Board, activity: Activity, agent_id: str) -> AgentView:
    joined = board.agent(agent_id)
    if joined is None:
        raise NotFound(f'No agent has the ID {agent_id}.')
    turns = tuple(turn for turn in board.turns if turn.agent == agent_id)
    costs = tuple(turn.cost_usd for turn in turns if turn.cost_usd is not None)
    return AgentView(
        agent=joined.agent,
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


async def _changes(lab: Lab, activity: Activity) -> AsyncGenerator[dict[str, str]]:
    # Each message says only what changed. The UI reads the views again, so the stream never repeats the record.
    seq, version = lab.board.seq, activity.version
    while True:
        waits = {
            asyncio.ensure_future(lab.wait_for_change(seq, HEARTBEAT)),
            asyncio.ensure_future(activity.wait_for_change(version, HEARTBEAT)),
        }
        _, pending = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        for waiting in pending:
            waiting.cancel()
        seq, version = lab.board.seq, activity.version
        yield {'event': 'change', 'data': f'{{"seq": {seq}, "activity": {version}}}'}
