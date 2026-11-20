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
from datetime import datetime, timedelta
from typing import Annotated, Protocol

from fastapi import Depends, FastAPI, HTTPException, Query, Request, params
from fastapi.responses import JSONResponse
from pydantic import SecretStr, ValidationError
from sse_starlette import EventSourceResponse

from verifold.protocol.agents import AgentChoice
from verifold.protocol.allowances import AllowanceId
from verifold.protocol.app import (
    ActionAnswer,
    ActionsPause,
    AgentView,
    BadgeRequest,
    BudgetRequest,
    ConversationView,
    CoordinatorSeat,
    DashboardPage,
    DeliverableDecision,
    DeliverableRequest,
    DeliverableView,
    DeskView,
    DiskRequest,
    FolderRequest,
    FolderView,
    HeadlineRequest,
    Invitation,
    InviteRequest,
    LabView,
    Need,
    NormsChange,
    NormsView,
    ObstacleView,
    OfferView,
    Outcomes,
    PowerChange,
    ProfileChange,
    QuestionRequest,
    RequestAnswer,
    RerunRequest,
    ReviewerSeats,
    RoundView,
    SeatChange,
    SettingsChange,
    SettingsView,
    SetupView,
    ShareRequest,
    StartRequest,
    TaskCard,
    ThreadCard,
    TimeRequest,
    VoteRequest,
)
from verifold.protocol.deliverables import Decision, DeliverableLine, OfferLine
from verifold.protocol.events import Reason, RerunRequested
from verifold.protocol.ids import PERSON, AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import CandidatesView, FileText, MapView, PostRequest, PostView, ThreadView, line_text
from verifold.protocol.moves import AddSeat, PaceMove, SeatGrant
from verifold.protocol.settings import DiskSettings, PaceSettings
from verifold.protocol.usage import DiskUse, Usage
from verifold.server.actions import allowance_views
from verifold.server.activity import Activity
from verifold.server.conversation import conversation_view
from verifold.server.desk_chat import desk_view
from verifold.server.errors import LabExists, NoLab, ServerError, SetupRejected
from verifold.server.lab import Build, Lab
from verifold.server.measures import dashboard_meta, headline_view, measure_labels
from verifold.server.member import Member
from verifold.server.status import agent_need, all_outcomes, in_turn, missed, profile_edits, thread_needs, waits
from verifold.society.alarms import alarm_line
from verifold.society.board import Board
from verifold.society.budget import budget_line
from verifold.society.deliverables import deliverable_lines, removed_lines, told_at
from verifold.society.errors import NotFound, SocietyError
from verifold.society.ideas import map_view
from verifold.society.identity import post_line, post_view, seat_label
from verifold.society.lifecycle import close_count, lab_state
from verifold.society.lines import lines_of
from verifold.society.obstacles import Obstacle, obstacles
from verifold.society.pace import cap_line, limits_of, pause_line
from verifold.society.reruns import reruns_wanted
from verifold.society.reviewers import seats
from verifold.society.rounds import close_of, closes_at, entries, is_open, waits_for
from verifold.society.standing import agreed, closing, standing
from verifold.society.tasks import task_facts, tasks
from verifold.society.turns import before
from verifold.society.views import (
    candidates_view,
    latest_reading,
    latest_report,
    line_times,
    needs_person,
    thread_summaries,
    thread_view,
    versions,
)
from verifold.society.votes import breakthrough_threads, proposals
from verifold.store.errors import (
    NormsChanged,
    NormsUnreadable,
    RecordChanged,
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

    async def measure_disk(self) -> None:
        """Measure the lab's files now, so that a new disk limit counts what they take at this moment."""
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
    @api.exception_handler(RecordChanged)
    @api.exception_handler(ValidationError)
    async def _refused(_: Request, error: Exception) -> JSONResponse:
        conflict = isinstance(error, NoLab | LabExists | SettingsChanged | NormsChanged)
        status = 404 if isinstance(error, NotFound) else 409 if conflict else 400
        # A file that Verifold can't write is its own failure, not the request's. The reason still reaches the app.
        status = 500 if isinstance(error, SettingsUnwritable | RecordChanged) else status
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
        return _view_of(current(), activity)

    @api.post('/agents', dependencies=[authorized])
    async def add_agents(choice: AgentChoice) -> LabView:
        await host.add_agents(choice)
        return _view_of(current(), activity)

    @api.post('/agents/{agent_id}/start', dependencies=[authorized])
    async def start_again(agent_id: AgentId) -> LabView:
        await host.start_again(agent_id)
        return _view_of(current(), activity)

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
        return _view_of(running, activity)

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
        return _view_of(running, activity)

    @api.post('/time', dependencies=[authorized])
    async def time(request: TimeRequest) -> LabView:
        running = current()
        await running.set_time_left(timedelta(minutes=request.minutes))
        return _view_of(running, activity)

    @api.get('/threads', dependencies=[authorized])
    async def threads() -> tuple[ThreadCard, ...]:
        return _cards(current())

    @api.get('/threads/{thread_id}', dependencies=[authorized])
    async def thread(thread_id: ThreadId) -> ThreadView:
        return thread_view(current().board, PERSON, thread_id)

    @api.get('/posts/{post_id}/file', dependencies=[authorized])
    async def file(post_id: PostId, path: str) -> FileText:
        return await host.file_text(post_id, path)

    @api.post('/folder', dependencies=[authorized])
    async def folder(request: FolderRequest) -> FolderView:
        # The request names an agent of the lab at most, never a path.
        return await host.open_folder(request.agent)

    @api.get('/needs', dependencies=[authorized])
    async def needs() -> tuple[PostView, ...]:
        running = current()
        return needs_person(running.board, running.now())

    @api.post('/posts', dependencies=[authorized])
    async def post(request: PostRequest) -> PostView:
        return await Member(current(), PERSON).post(request)

    @api.post('/reruns', dependencies=[authorized])
    async def rerun(request: RerunRequest) -> RerunRequested:
        return await Member(current(), PERSON).rerun(request.post)

    @api.get('/events', dependencies=[authorized])
    async def events() -> EventSourceResponse:
        return EventSourceResponse(_changes(host, activity))

    _pinned_routes(api, host, authorized)
    _seat_routes(api, host, activity, authorized)
    return api


def _pinned_routes(api: FastAPI, host: Host, authorized: params.Depends) -> None:
    """Add what the lab page pins for the person: the lab's reading, its newest report, its candidates, and its map."""

    @api.get('/reading', dependencies=[authorized])
    async def reading() -> PostView | None:
        return latest_reading(_lab(host).board)

    @api.get('/report', dependencies=[authorized])
    async def report() -> PostView | None:
        return latest_report(_lab(host).board)

    @api.get('/candidates', dependencies=[authorized])
    async def candidates() -> CandidatesView:
        return candidates_view(_lab(host).board)

    @api.get('/map', dependencies=[authorized])
    async def idea_map() -> MapView:
        # The person sees every idea whole, also one that is sealed for the agents in an open round.
        lab = _lab(host)
        return map_view(lab.board, lab.now(), whole=True)


def _dashboard_routes(api: FastAPI, host: Host, activity: Activity, authorized: params.Depends) -> None:
    """Add what the Dashboard tab reads, the agents' page with the board's facts about it, and the headline number."""

    @api.get('/dashboard', dependencies=[authorized])
    async def dashboard() -> DashboardPage | None:
        # The app puts the page's text into a frame that is sealed from the app. No address of the frame holds it.
        meta = dashboard_meta(_lab(host).board)
        if meta is None:
            return None
        page = await host.file_text(meta.post, meta.path)
        return DashboardPage(meta=meta, html=page.text)

    @api.post('/headline', dependencies=[authorized])
    async def headline(request: HeadlineRequest) -> LabView:
        # The same label again records nothing. The person's naming tells the lab in the question's thread.
        lab = _lab(host)
        await lab.name_headline_number(request.label, PERSON)
        return _view_of(lab, activity)


def _coordinator_routes(api: FastAPI, host: Host, authorized: params.Depends) -> None:
    """Add what the person reads and does in the panel for the coordinator: the conversation, powers, and requests."""

    @api.get('/conversation', dependencies=[authorized])
    async def conversation() -> ConversationView:
        return conversation_view(_lab(host).board)

    @api.get('/desk', dependencies=[authorized])
    async def desk() -> DeskView:
        # The person writes to the desk with a post in the desk chat, as in any thread.
        return desk_view(_lab(host).board)

    @api.post('/powers', dependencies=[authorized])
    async def power(change: PowerChange) -> ConversationView:
        lab = _lab(host)
        await lab.set_power(change.power, on=change.on)
        return conversation_view(lab.board)

    @api.post('/grant', dependencies=[authorized])
    async def grant(seats: SeatGrant) -> ConversationView:
        # Only the person grants spare seats: no agent tool and no project's settings file records a grant.
        lab = _lab(host)
        await lab.grant_seats(seats)
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
        return _view_of(_lab(host), activity)

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
        return _view_of(lab, activity)

    @api.post('/reviewers', dependencies=[authorized])
    async def reviewer_seats(request: ReviewerSeats) -> LabView:
        # The number is the lab's own. The settings files keep what new labs start with.
        lab = _lab(host)
        settings = lab.board.settings
        if settings.reviewers.seats != request.seats:
            reviewers = settings.reviewers.model_copy(update={'seats': request.seats})
            await lab.set_settings(settings.model_copy(update={'reviewers': reviewers}))
        return _view_of(lab, activity)

    @api.post('/coordinator', dependencies=[authorized])
    async def coordinator(seat: CoordinatorSeat) -> LabView:
        # The seat has no holder after this. A seat that the person closes stays free until the person gives it.
        lab = _lab(host)
        await lab.set_coordinator(None, PERSON, free=seat.open)
        return _view_of(lab, activity)

    _coordinator_routes(api, host, authorized)
    _dashboard_routes(api, host, activity, authorized)
    _limit_routes(api, host, activity, authorized)
    _allowance_routes(api, host, activity, authorized)
    _vote_routes(api, host, authorized)
    _deliverable_routes(api, host, activity, authorized)


def _limit_routes(api: FastAPI, host: Host, activity: Activity, authorized: params.Depends) -> None:
    """Add the person's limits of the lab beside its time: the budget, the disk limit, and the pace."""

    @api.post('/pace', dependencies=[authorized])
    async def pace(move: PaceMove) -> LabView:
        # The person's move replaces the coordinator's of the same kind, so only the person raises.
        lab = _lab(host)
        await lab.set_pace(move)
        return _view_of(lab, activity)

    @api.post('/pace/coordinator', dependencies=[authorized])
    async def share(request: ShareRequest) -> LabView:
        # The share is the lab's own setting. The settings files keep what new labs start with.
        lab = _lab(host)
        settings = lab.board.settings
        if settings.pace.coordinator_tokens_per_hour != request.tokens_per_hour:
            pace = PaceSettings(coordinator_tokens_per_hour=request.tokens_per_hour)
            await lab.set_settings(settings.model_copy(update={'pace': pace}))
        return _view_of(lab, activity)

    @api.post('/budget', dependencies=[authorized])
    async def budget(request: BudgetRequest) -> LabView:
        lab = _lab(host)
        await lab.set_budget(request.tokens, request.dollars)
        return _view_of(lab, activity)

    @api.post('/disk', dependencies=[authorized])
    async def disk(request: DiskRequest) -> LabView:
        # The limit is the lab's own. The settings files keep what new labs start with.
        lab = _lab(host)
        settings = lab.board.settings
        if settings.disk.limit_gb != request.limit_gb:
            await host.measure_disk()
            await lab.set_settings(settings.model_copy(update={'disk': DiskSettings(limit_gb=request.limit_gb)}))
        return _view_of(lab, activity)


def _allowance_routes(api: FastAPI, host: Host, activity: Activity, authorized: params.Depends) -> None:
    """
    Add the person's own presses on allowances and actions.

    The person confirms a draft, ends an allowance, pauses every action, and answers an action that waits. No tool of
    an agent reaches any of them.
    """

    @api.post('/allowances/{allowance_id}/start', dependencies=[authorized])
    async def start_allowance(allowance_id: AllowanceId) -> LabView:
        lab = _lab(host)
        await lab.start_allowance(allowance_id)
        return _view_of(lab, activity)

    @api.post('/allowances/{allowance_id}/end', dependencies=[authorized])
    async def end_allowance(allowance_id: AllowanceId) -> LabView:
        lab = _lab(host)
        await lab.end_allowance(allowance_id)
        return _view_of(lab, activity)

    @api.post('/actions/pause', dependencies=[authorized])
    async def pause_actions(request: ActionsPause) -> LabView:
        lab = _lab(host)
        await lab.pause_actions(paused=request.paused)
        return _view_of(lab, activity)

    @api.post('/actions/{post_id}/decision', dependencies=[authorized])
    async def decide_action(post_id: PostId, answer: ActionAnswer) -> LabView:
        # The answer is also the person's reply to the action, so its author hears it.
        lab = _lab(host)
        await lab.decide_action(post_id, yes=answer.yes)
        return _view_of(lab, activity)


def _vote_routes(api: FastAPI, host: Host, authorized: params.Depends) -> None:
    """Add the person's votes and badges on posts. Each answer is the post as it stands after the change."""

    @api.post('/votes', dependencies=[authorized])
    async def vote(request: VoteRequest) -> PostView:
        return await Member(_lab(host), PERSON).vote(request.post, request.direction, request.reason)

    @api.post('/badges', dependencies=[authorized])
    async def badge(request: BadgeRequest) -> PostView:
        return await Member(_lab(host), PERSON).badge(
            request.post, request.badge, request.action, request.reason, proof=request.proof, giver=request.giver
        )


DECISIONS: dict[str, Decision] = {'accept': 'accepted', 'ask_changes': 'changes_asked', 'take_back': 'taken_back'}
"""The decision that the record keeps for each of the person's buttons on an offer."""


def _deliverable_routes(api: FastAPI, host: Host, activity: Activity, authorized: params.Depends) -> None:
    """Add the person's actions on deliverables: state one, change it, remove it, and decide about an offer."""

    @api.post('/deliverables', dependencies=[authorized])
    async def add_deliverable(request: DeliverableRequest) -> LabView:
        lab = _lab(host)
        await lab.add_deliverable(request.text)
        return _view_of(lab, activity)

    @api.post('/deliverables/{deliverable_id}', dependencies=[authorized])
    async def change_deliverable(deliverable_id: DeliverableId, request: DeliverableRequest) -> LabView:
        # The same sentence again records nothing.
        lab = _lab(host)
        await lab.change_deliverable(deliverable_id, request.text)
        return _view_of(lab, activity)

    @api.delete('/deliverables/{deliverable_id}', dependencies=[authorized])
    async def remove_deliverable(deliverable_id: DeliverableId) -> LabView:
        lab = _lab(host)
        await lab.remove_deliverable(deliverable_id)
        return _view_of(lab, activity)

    @api.post('/deliverables/{deliverable_id}/decision', dependencies=[authorized])
    async def decide(deliverable_id: DeliverableId, request: DeliverableDecision) -> LabView:
        # The person's decision is also the person's reply to the offer, so the offer's author hears it.
        lab = _lab(host)
        await lab.decide(deliverable_id, DECISIONS[request.decision], request.offer, request.text)
        return _view_of(lab, activity)


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


def _view_of(lab: Lab, activity: Activity) -> LabView:
    return _lab_view(lab.board, activity, lab.now(), lab.disk)


def _lab_view(board: Board, activity: Activity, now: datetime, disk: DiskUse | None = None) -> LabView:
    # `now` dates the leases on the wanted reruns.
    working = lines_of(board)
    done = closing(board)
    waiting = waits(board, now)
    allowances = allowance_views(board, now)
    became = all_outcomes(board)
    needs = {
        entry.agent.id: agent_need(board, activity.shown(entry.agent.id), entry.agent.id, waiting)
        for entry in board.agents
    }
    around = _Around(working=working, needs=needs, became=became, now=now)
    return LabView(
        state=lab_state(board),
        close=post_line(board, done, PERSON) if done else None,
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
        needs_you=len(waiting) + sum(view.stopped for view in allowances),
        waits=waiting,
        thread_needs=thread_needs(board, needs, waiting),
        reruns_wanted=reruns_wanted(board, now),
        proposals=proposals(board),
        breakthrough_threads=breakthrough_threads(board),
        obstacles=tuple(_obstacle_view(board, found) for found in reversed(obstacles(board))),
        round=_round_view(board, now),
        reviewer_seats=seats(board),
        reviewer_seats_set=board.settings.reviewers.seats,
        ends_at=board.ends_at,
        out_of_time=board.out_of_time,
        budget=budget_line(board),
        limit=board.at_limit,
        disk=disk,
        lab_cap=cap_line(board, None, now),
        settings=board.settings,
        deliverables=tuple(_deliverable_view(board, line) for line in deliverable_lines(board)),
        removed_deliverables=removed_lines(board),
        deliverables_told_at=told_at(board),
        allowances=allowances,
        actions_paused=paused.at if (paused := board.actions_paused) else None,
        missed=missed(board, now),
        headline_number=headline_view(board),
        dashboard=dashboard_meta(board),
        measure_labels=measure_labels(board),
    )


def _cards(lab: Lab) -> tuple[ThreadCard, ...]:
    board, now = lab.board, lab.now()
    return tuple(
        ThreadCard(
            **dict(summary),
            last_result_at=result_at,
            last_plan_at=plan_at,
            tasks=_task_cards(board, summary.thread.id, now),
        )
        for summary in thread_summaries(board, PERSON, now)
        for result_at, plan_at in (line_times(board, summary.thread),)
    )


def _task_cards(board: Board, thread_id: ThreadId, now: datetime) -> tuple[TaskCard, ...]:
    # The tasks of a thread that someone is on, or that wait for someone, with who holds each one. A task that is
    # done or withdrawn asks nothing of the lab any more.
    found = ((entry, task_facts(board, entry, now)) for entry in tasks(board) if entry.post.thread == thread_id)
    return tuple(
        TaskCard(
            task=entry.post.id,
            author=entry.post.author,
            text=line_text(entry.post.text),
            state=facts.state,
            agent=facts.holder.agent if facts.holder else facts.hand_back.post.author if facts.hand_back else None,
            until=facts.holder.lease.until if facts.holder else None,
        )
        for entry, facts in found
        if facts.state not in {'done', 'withdrawn'}
    )


def _round_view(board: Board, now: datetime) -> RoundView | None:
    # The newest round: the one that is open, or else the one that closed last. Its agents that did not enter are
    # the ones that it waits for now, or the ones that it waited for at its close.
    opened = board.rounds[-1] if board.rounds else None
    if opened is None:
        return None
    closed = close_of(board, opened.post.id)
    return RoundView(
        round=post_view(board, opened, PERSON),
        open=is_open(board, opened, now),
        closes_at=closes_at(opened),
        closed=closed,
        entries=tuple(post_view(board, entry, PERSON) for entry in entries(board, opened.post.id)),
        not_entered=waits_for(board, opened, closed.seq if closed else None),
    )


def _obstacle_view(board: Board, found: Obstacle) -> ObstacleView:
    entry = found.entry
    return ObstacleView(
        post=post_line(board, entry, PERSON),
        at=entry.at,
        standing=standing(board, entry.post.id),
        state=found.state,
        builders=tuple(post_line(board, builder, PERSON) for builder in found.builders),
    )


def _deliverable_view(board: Board, line: DeliverableLine) -> DeliverableView:
    # The person decides about an offer in the panel that lists it, so each offer comes with its detail.
    offers = tuple(_offer_view(board, offer) for offer in line.offers)
    return DeliverableView(**dict(line.model_copy(update={'offers': offers})))


def _offer_view(board: Board, offer: OfferLine) -> OfferView:
    entry = board.post(offer.post)
    return OfferView(**dict(offer), body=entry.post.body if entry else '')


@dataclass(frozen=True, slots=True)
class _Around:
    """What the lab view works out once for all its agents."""

    working: dict[AgentId, ThreadId | None]
    needs: dict[AgentId, Need]
    became: dict[AgentId, Outcomes]
    now: datetime


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
    notes = board.notes_of(agent_id)
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
        notes=notes.text if notes else '',
        notes_at=notes.at if notes else None,
        outcomes=lab.became.get(agent_id, Outcomes()),
        turns_started=sum(start.agent == agent_id for start in board.starts),
        role=role,
        on_call=board.on_call(agent_id),
        coordinator=board.coordinator == agent_id,
        desk=board.is_desk(agent_id),
        acting=board.acting(agent_id),
        mode=board.mode_of(agent_id),
        status=status,
        thread=lab.working.get(agent_id),
        activity=activity.shown(agent_id),
        heard=activity.heard(agent_id),
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
        limits=limits_of(board, agent_id, lab.now),
        pause=pause_line(board, agent_id, lab.now),
        cap=None if board.is_desk(agent_id) else cap_line(board, agent_id, lab.now),
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
