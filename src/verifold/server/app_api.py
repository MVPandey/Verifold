"""
The app API: what the person's UI reads from the lab, and the person's actions.

Every request carries the person's token, in an `Authorization: Bearer` header or, for the event stream, a `token`
query parameter, because a browser's EventSource cannot set headers. The token keeps other web pages from acting as
the person on this local server.
"""

import asyncio
import secrets
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated, Protocol

from fastapi import Depends, FastAPI, HTTPException, Query, Request, params
from fastapi.responses import JSONResponse
from pydantic import SecretStr, ValidationError
from sse_starlette import EventSourceResponse

from verifold.protocol.agents import AgentChoice
from verifold.protocol.app import (
    AgentView,
    ConversationView,
    CoordinatorSeat,
    DeliverableDecision,
    DeliverableRequest,
    FolderRequest,
    FolderView,
    Invitation,
    InviteRequest,
    LabView,
    Need,
    NormsChange,
    NormsView,
    Outcomes,
    PowerChange,
    ProfileChange,
    QuestionRequest,
    RequestAnswer,
    RerunRequest,
    ReviewerSeats,
    SeatChange,
    SettingsChange,
    SettingsView,
    SetupView,
    StartRequest,
    TimeRequest,
)
from verifold.protocol.deliverables import Decision
from verifold.protocol.events import Reason, RerunRequested
from verifold.protocol.ids import PERSON, AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import AnswerView, FileText, PostRequest, PostView, ThreadSummary, ThreadView
from verifold.protocol.moves import AddSeat
from verifold.protocol.usage import Usage
from verifold.server.activity import Activity
from verifold.server.conversation import conversation_view
from verifold.server.errors import LabExists, NoLab, ServerError, SetupRejected
from verifold.server.lab import Build, Lab
from verifold.server.member import Member
from verifold.server.status import agent_need, all_outcomes, in_turn, profile_edits, thread_needs, waits
from verifold.society.board import Board
from verifold.society.deliverables import deliverable_lines, removed_lines, told_at
from verifold.society.errors import NotFound, SocietyError
from verifold.society.identity import post_line, seat_label
from verifold.society.lifecycle import alarm_line, close_count, lab_state
from verifold.society.lines import lines_of
from verifold.society.reruns import reruns_wanted
from verifold.society.reviewers import seats
from verifold.society.standing import agreed, closing
from verifold.society.turns import before
from verifold.society.views import (
    answer_view,
    latest_report,
    needs_person,
    thread_summaries,
    thread_view,
    versions,
)
from verifold.store.errors import (
    NormsChanged,
    NormsUnreadable,
    SettingsChanged,
    SettingsInvalid,
    SettingsUnwritable,
)

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

    def norms(self) -> NormsView:
        """Return the lab's norms files, or the defaults that a new lab gets."""
        ...

    async def change_norms(self, change: NormsChange) -> NormsView:
        """Save a new text for one norms file, and tell the lab's agents that it changed."""
        ...

    async def file_text(self, post_id: PostId, path: str) -> FileText:
        """Return the text of a file that backs a post, at the commit that the post pins."""
        ...

    async def open_folder(self, agent_id: AgentId | None = None) -> FolderView:
        """Open the folder where the lab's agents work, or one agent's folder, and return where it is."""
        ...

    async def add_agents(self, choice: AgentChoice) -> None:
        """Add the agents of one seat to the lab that runs, and start them."""
        ...

    async def add_seat(self, seat: AddSeat, first: tuple[Build, ...], asked_by: AgentId) -> None:
        """Add the one agent of a seat that a coordinator's move describes. The record takes `first` with it."""
        ...

    async def change_seat(self, agent_id: AgentId, change: SeatChange) -> None:
        """Put an agent's seat on call or take it off, and give or take the lab's coordinator seat."""
        ...

    def ask_harnesses(self) -> SetupView:
        """Ask the harnesses that Verifold did not ask yet what they offer, in the background, and return the setup."""
        ...

    async def invite(self, request: InviteRequest | None = None) -> Invitation:
        """Add an agent that runs by itself to the lab that runs, and return its invitation."""
        ...

    async def invite_again(self, agent_id: AgentId) -> Invitation:
        """Give an invited agent a new token, which makes its earlier one void, and return its new invitation."""
        ...

    async def start_again(self, agent_id: AgentId) -> None:
        """Start an agent that Verifold stopped because its harness failed too often."""
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
    @api.exception_handler(NormsUnreadable)
    @api.exception_handler(NormsChanged)
    @api.exception_handler(ValidationError)
    async def _refused(_: Request, error: Exception) -> JSONResponse:
        conflict = isinstance(error, NoLab | LabExists | SettingsChanged | NormsChanged)
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

    @api.get('/norms', dependencies=[authorized])
    async def norms() -> NormsView:
        return host.norms()

    @api.post('/norms', dependencies=[authorized])
    async def change_norms(change: NormsChange) -> NormsView:
        # The request names one of two files, never a path.
        return await host.change_norms(change)

    @api.get('/lab', dependencies=[authorized])
    async def lab() -> LabView:
        return _lab_view(current().board, activity)

    @api.post('/agents', dependencies=[authorized])
    async def add_agents(choice: AgentChoice) -> LabView:
        await host.add_agents(choice)
        return _lab_view(current().board, activity)

    @api.post('/agents/{agent_id}/start', dependencies=[authorized])
    async def start_again(agent_id: AgentId) -> LabView:
        await host.start_again(agent_id)
        return _lab_view(current().board, activity)

    @api.delete('/agents/{agent_id}', dependencies=[authorized])
    async def remove_agent(agent_id: AgentId, reason: Reason = '') -> LabView:
        # The record is all that the removal writes. The agent's loop, its seat, and its token follow the record.
        running = current()
        joined = running.board.agent(agent_id)
        if joined is None:
            raise NotFound(f'The lab has no agent with the ID {agent_id}.')
        if running.board.gone(agent_id):
            raise SetupRejected(f'{joined.agent.name} has left the lab already.')
        await running.leave(agent_id, PERSON, reason)
        return _lab_view(running.board, activity)

    @api.post('/invitations', dependencies=[authorized])
    async def invite(request: InviteRequest) -> Invitation:
        return await host.invite(request)

    @api.post('/invitations/{agent_id}', dependencies=[authorized])
    async def invite_again(agent_id: AgentId) -> Invitation:
        return await host.invite_again(agent_id)

    @api.post('/question', dependencies=[authorized])
    async def revise_question(request: QuestionRequest) -> LabView:
        # A text that is the same as the question records nothing.
        running = current()
        await running.revise_question(request.question, request.note)
        return _lab_view(running.board, activity)

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

    @api.post('/folder', dependencies=[authorized])
    async def folder(request: FolderRequest) -> FolderView:
        # The request names an agent of the lab at most, never a path.
        return await host.open_folder(request.agent)

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

    _seat_routes(api, host, activity, authorized)
    return api


def _coordinator_routes(api: FastAPI, host: Host, authorized: params.Depends) -> None:
    """Add what the person reads and does in the panel for the coordinator: the conversation, powers, and requests."""

    @api.get('/conversation', dependencies=[authorized])
    async def conversation() -> ConversationView:
        return conversation_view(_lab(host).board)

    @api.post('/powers', dependencies=[authorized])
    async def power(change: PowerChange) -> ConversationView:
        lab = _lab(host)
        await lab.set_power(change.power, on=change.on)
        return conversation_view(lab.board)

    @api.post('/requests/{post_id}', dependencies=[authorized])
    async def answer_request(post_id: PostId, answer: RequestAnswer) -> ConversationView:
        # A yes makes the move as the person's own: the same events that the person's own move records.
        lab = _lab(host)
        await lab.answer_request(post_id, yes=answer.yes, minutes=answer.minutes, adds=host.add_seat)
        return conversation_view(lab.board)

    @api.post('/requests/{post_id}/minutes', dependencies=[authorized])
    async def take_minutes_back(post_id: PostId) -> ConversationView:
        lab = _lab(host)
        await lab.take_minutes_back(post_id)
        return conversation_view(lab.board)


def _seat_routes(api: FastAPI, host: Host, activity: Activity, authorized: params.Depends) -> None:
    """Add the person's actions on seats: what the harnesses offer, one agent's seat, and the coordinator seat."""

    @api.post('/offers', dependencies=[authorized])
    async def offers() -> SetupView:
        # The form that adds an agent to a lab that was served again has no offers until the harnesses are asked.
        return host.ask_harnesses()

    @api.post('/agents/{agent_id}/seat', dependencies=[authorized])
    async def change_seat(agent_id: AgentId, change: SeatChange) -> LabView:
        await host.change_seat(agent_id, change)
        return _lab_view(_lab(host).board, activity)

    @api.post('/agents/{agent_id}/profile', dependencies=[authorized])
    async def change_profile(agent_id: AgentId, change: ProfileChange) -> LabView:
        # The person takes back what an agent chose, or gives its seat a role. The record keeps the earlier text.
        lab = _lab(host)
        if lab.board.agent(agent_id) is None:
            raise NotFound(f'The lab has no agent with the ID {agent_id}.')
        await lab.change_profile(
            agent_id,
            PERSON,
            reset_name=change.reset_name,
            about='' if change.reset_about else None,
            reset_picture=change.reset_picture,
            given_role=change.role,
        )
        return _lab_view(lab.board, activity)

    @api.post('/reviewers', dependencies=[authorized])
    async def reviewer_seats(request: ReviewerSeats) -> LabView:
        # The number is the lab's own. The settings files keep what new labs start with.
        lab = _lab(host)
        settings = lab.board.settings
        if settings.reviewers.seats != request.seats:
            reviewers = settings.reviewers.model_copy(update={'seats': request.seats})
            await lab.set_settings(settings.model_copy(update={'reviewers': reviewers}))
        return _lab_view(lab.board, activity)

    @api.post('/coordinator', dependencies=[authorized])
    async def coordinator(seat: CoordinatorSeat) -> LabView:
        # The seat has no holder after this. A seat that the person closes stays free until the person gives it.
        lab = _lab(host)
        await lab.set_coordinator(None, PERSON, free=seat.open)
        return _lab_view(lab.board, activity)

    _coordinator_routes(api, host, authorized)
    _deliverable_routes(api, host, activity, authorized)


DECISIONS: dict[str, Decision] = {'accept': 'accepted', 'ask_changes': 'changes_asked', 'take_back': 'taken_back'}
"""The decision that the record keeps for each of the person's buttons on an offer."""


def _deliverable_routes(api: FastAPI, host: Host, activity: Activity, authorized: params.Depends) -> None:
    """Add the person's actions on deliverables: state one, change it, remove it, and decide about an offer."""

    @api.post('/deliverables', dependencies=[authorized])
    async def add_deliverable(request: DeliverableRequest) -> LabView:
        lab = _lab(host)
        await lab.add_deliverable(request.text)
        return _lab_view(lab.board, activity)

    @api.post('/deliverables/{deliverable_id}', dependencies=[authorized])
    async def change_deliverable(deliverable_id: DeliverableId, request: DeliverableRequest) -> LabView:
        # The same sentence again records nothing.
        lab = _lab(host)
        await lab.change_deliverable(deliverable_id, request.text)
        return _lab_view(lab.board, activity)

    @api.delete('/deliverables/{deliverable_id}', dependencies=[authorized])
    async def remove_deliverable(deliverable_id: DeliverableId) -> LabView:
        lab = _lab(host)
        await lab.remove_deliverable(deliverable_id)
        return _lab_view(lab.board, activity)

    @api.post('/deliverables/{deliverable_id}/decision', dependencies=[authorized])
    async def decide(deliverable_id: DeliverableId, request: DeliverableDecision) -> LabView:
        # The person's decision is also the person's reply to the offer, so the offer's author hears it.
        lab = _lab(host)
        await lab.decide(deliverable_id, DECISIONS[request.decision], request.offer, request.text)
        return _lab_view(lab.board, activity)


def _lab(host: Host) -> Lab:
    lab = host.lab
    if lab is None:
        raise NoLab('This folder has no lab yet. Start one from the setup screen.')
    return lab


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
    waiting = waits(board)
    became = all_outcomes(board)
    needs = {
        entry.agent.id: agent_need(board, activity.shown(entry.agent.id), entry.agent.id, waiting)
        for entry in board.agents
    }
    around = _Around(working=working, needs=needs, became=became)
    return LabView(
        state=lab_state(board),
        close=post_line(board, done) if done else None,
        close_agreed=len(agreed(board, done)) if done else 0,
        close_among=close_count(board, done)[1] if done else 0,
        question=board.question,
        coordinator_open=board.coordinator_open,
        versions=versions(board),
        opened_at=board.opened.at,
        seq=board.seq,
        agents=tuple(_agent_view(board, activity, entry.agent.id, around) for entry in board.agents),
        threads=len(board.threads),
        posts=len(board.posts),
        needs_you=len(waiting),
        waits=waiting,
        thread_needs=thread_needs(board, needs, waiting),
        reruns_wanted=reruns_wanted(board),
        reviewer_seats=seats(board),
        reviewer_seats_set=board.settings.reviewers.seats,
        ends_at=board.ends_at,
        out_of_time=board.out_of_time,
        settings=board.settings,
        deliverables=deliverable_lines(board),
        removed_deliverables=removed_lines(board),
        deliverables_told_at=told_at(board),
    )


@dataclass(frozen=True, slots=True)
class _Around:
    """What the lab view works out once for all its agents."""

    working: dict[AgentId, ThreadId | None]
    needs: dict[AgentId, Need]
    became: dict[AgentId, Outcomes]


def _agent_view(
    board: Board,
    activity: Activity,
    agent_id: str,
    lab: '_Around',
) -> AgentView:
    joined = board.agent(agent_id)
    if joined is None:
        raise NotFound(f'No agent has the ID {agent_id}.')
    turns = tuple(turn for turn in board.turns if turn.agent == agent_id)
    costs = tuple(turn.cost_usd for turn in turns if turn.cost_usd is not None)
    role, status = board.profile(agent_id)
    given, giver = board.given_role(agent_id)
    flag = board.flag(agent_id)
    return AgentView(
        agent=joined.agent,
        seat=seat_label(board, agent_id),
        chosen_name=board.chosen_name(agent_id),
        about=board.about(agent_id),
        picture=board.picture(agent_id),
        given_role=given,
        given_by=giver if given else None,
        reviewer=board.reviewer(agent_id),
        flag=flag.flag or '' if flag else '',
        edits=profile_edits(board, agent_id),
        need=lab.needs[agent_id],
        in_turn=in_turn(activity.shown(agent_id)),
        about_by=board.about_by(agent_id),
        outcomes=lab.became.get(agent_id, Outcomes()),
        turns_started=sum(start.agent == agent_id for start in board.starts),
        role=role,
        on_call=board.on_call(agent_id),
        coordinator=board.coordinator == agent_id,
        status=status,
        thread=lab.working.get(agent_id),
        activity=activity.shown(agent_id),
        left=board.gone(agent_id),
        # The record says so until the agent's next turn starts. The person's new start shows at once.
        stopped=before(board, agent_id).stopped and activity.of(agent_id).state == 'stopped',
        turns=len(turns),
        turn_ended_at=next((turn.at for turn in reversed(turns) if not turn.no_turn), None),
        alarm=alarm_line(board, agent_id),
        posts=sum(entry.post.author == agent_id for entry in board.posts),
        usage=Usage(
            input_tokens=sum(turn.usage.input_tokens for turn in turns),
            cached_input_tokens=sum(turn.usage.cached_input_tokens for turn in turns),
            output_tokens=sum(turn.usage.output_tokens for turn in turns),
        ),
        cost_usd=sum(costs) if costs else None,
        error=failed.error if (failed := board.failure(agent_id)) else None,
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
