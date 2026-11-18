"""The service that owns one lab: its record, its board, and the callers that wait for new events."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Self, assert_never

from verifold.protocol.agents import Agent, Picture, Power, one_line
from verifold.protocol.deliverables import Decision
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AgentNamed,
    AlarmSet,
    BadgeSet,
    BudgetSet,
    CoordinatorSet,
    DeliverableDecided,
    DeliverableSet,
    DeskSet,
    Event,
    LabOpened,
    LimitReached,
    NotesSet,
    OnCallSet,
    PermissionGranted,
    Posted,
    PowerSet,
    ProfileSet,
    QuestionRevised,
    RequestAnswered,
    RerunLeaseSet,
    RerunRequested,
    RerunTaken,
    ReviewerSet,
    RoundClosed,
    SettingsSet,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnInterrupted,
    TurnStarted,
    TurnSummary,
    Voted,
    WatchSet,
)
from verifold.protocol.ids import PERSON, AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import PostRequest
from verifold.protocol.moves import (
    AddMove,
    AddSeat,
    Move,
    PermissionMove,
    QuestionMove,
    RemoveMove,
    SettingMove,
    TimeMove,
)
from verifold.protocol.posts import (
    MAX_HEADLINE,
    Answer,
    Ask,
    Check,
    Close,
    FileEvidence,
    FileOffer,
    Mark,
    MoveRequest,
    PermissionShown,
    QuestionShown,
)
from verifold.protocol.settings import Settings
from verifold.protocol.threads import CONVERSATION_TITLE, DESK_TITLE, QUESTION_TITLE, Carries, Thread
from verifold.protocol.usage import DiskUse
from verifold.protocol.votes import Badge, BadgeAction, Direction
from verifold.server.changes import wait_until
from verifold.server.errors import LabExists, SetupRejected
from verifold.society.board import Board
from verifold.society.budget import reached
from verifold.society.candidates import check_names_candidate, check_read
from verifold.society.coordinator import check_asks, permission_choice, power_covers, time_given
from verifold.society.deliverables import accepted, check_decidable, live, offers_title, told_at
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply, fold
from verifold.society.labels import awaits_model, is_numbered, label, plain
from verifold.society.lifecycle import utc
from verifold.society.lines import question_thread
from verifold.society.names import check_name
from verifold.society.reruns import lease_refusal, open_take, open_to, wanted_reruns
from verifold.society.reviewers import check_review, seats_line
from verifold.society.rounds import close_due
from verifold.society.standing import closing
from verifold.society.votes import proposal, revealed, vote_of
from verifold.store.errors import CorruptRecord, RecordChanged
from verifold.store.record_file import RecordFile

logger = logging.getLogger(__name__)

type Clock = Callable[[], datetime]
type Build = Callable[[Board, int, datetime], Event]
type Adds = Callable[[AddSeat, tuple[Build, ...], AgentId], Awaitable[None]]
"""
Adds one agent to the lab in the seat that a move describes, and starts it. The record takes the given events
first, in the same step as the agent, so that it says where the agent came from. The agent is the coordinator
that asked for the seat: a role of the seat is recorded as given by it.
"""


@dataclass(frozen=True, slots=True)
class Said:
    """The person's word that an action of the desk rests on: the desk that acts, and the person's post in the desk chat."""

    by: AgentId
    post: PostId


type Stops = Callable[[RecordChanged], None]
"""
Stops the server: it gets the error when a write finds that another program changed the record. The caller of the
write gets the same error.
"""


def utc_now() -> datetime:
    """Return the current time in UTC."""
    return datetime.now(UTC)


def _stops_nothing(_: RecordChanged) -> None:
    """Leave the stop to the caller of the write, which gets the error."""


class Lab:
    """
    One lab's record and board.

    Every change goes through one lock: the lab checks the event against the board, writes it to the record, and then
    wakes the callers that wait for new events. An event that breaks a rule never reaches the record. Each change
    also records the close of a round that is due, before its own events and after them, so a round closes in the
    step of the entry, the withdrawal, or the change of the lab's agents that ends it. After them, it records that
    the lab reached its budget or its disk limit, in the step of the turn's end, the new budget, the new disk
    limit, or the measure of the disk that reaches it.
    """

    def __init__(self, record: RecordFile, board: Board, clock: Clock = utc_now, stops: Stops = _stops_nothing) -> None:
        """Serve an open record, given the board that its events add up to."""
        self._record = record
        self._clock = clock
        self._board = board
        self._stops = stops
        self._changed = asyncio.Condition()
        self._disk: DiskUse | None = None

    @classmethod
    def load(cls, record: RecordFile, clock: Clock = utc_now, stops: Stops = _stops_nothing) -> Self:
        """
        Serve a record that holds a lab already. `stops` hears when a write finds the record changed.

        Raises:
            CorruptRecord: The record's events do not add up to a board. The message gives the line of the first
                event that does not fit.

        """
        events = record.read()
        line = 1
        try:
            board = fold(events[:1])
            for event in events[1:]:
                line += 1
                board = apply(board, event)
        except RejectedEvent as error:
            raise CorruptRecord(f'The record {record.path} does not add up to a lab at line {line}: {error}') from error
        return cls(record, board, clock, stops)

    @classmethod
    def create(  # noqa: PLR0913
        cls,
        record: RecordFile,
        question: str,
        *,
        auto_mode: bool = True,
        time_left: timedelta | None = None,
        clock: Clock = utc_now,
        stops: Stops = _stops_nothing,
    ) -> Self:
        """
        Open a new lab on `question` in an empty record. With `time_left`, the lab ends that long after it opens.

        `stops` hears when a write finds the record changed.

        Raises:
            LabExists: The record holds a lab already.
            RecordChanged: Another program changed the record since the server opened it.

        """
        if record.read():
            raise LabExists('This record holds a lab already. Load it instead.')
        at = clock()
        ends_at = at + time_left if time_left is not None else None
        opened = LabOpened(seq=1, at=at, question=question, auto_mode=auto_mode, ends_at=ends_at)
        lab = cls(record, fold((opened,)), clock, stops)
        lab._write(opened)
        return lab

    @property
    def board(self) -> Board:
        """The board after every event so far."""
        return self._board

    @property
    def disk(self) -> DiskUse | None:
        """What the lab's files took on disk when Verifold measured them last, or `None` before the first measure."""
        return self._disk

    async def measured(self, disk: DiskUse) -> None:
        """Keep what the lab's files take on disk now. The record says so when they reach the lab's disk limit."""
        self._disk = disk
        await self._commit()

    async def join(  # noqa: PLR0913
        self,
        agent: Agent,
        *,
        on_call: bool = False,
        coordinator: bool = False,
        powers: tuple[Power, ...] = (),
        first: tuple[Build, ...] = (),
        given: tuple[str, AgentId] | None = None,
        desk: bool = False,
    ) -> AgentJoined:
        """
        Add an agent to the lab.

        With `on_call`, the person put its seat on call. With `coordinator`, the person made it the lab's
        coordinator, and `powers` are the powers that the person switched on for it. With `desk`, the person made
        its seat the lab's desk, and the desk chat opens with it when the lab has none. The record takes all of
        them in the same step as the agent. `first` are events that come before the agent in that step, such as the
        yes to the request that asked for it. `given` is a role for the seat and the coordinator that gives it:
        the record keeps it as the coordinator's word, in the same step.

        Raises:
            RejectedEvent: The agent is a checker for one post. Only a record from before agents took reruns holds
                such agents.

        """
        if agent.checks:
            raise RejectedEvent('No agent joins a lab as the checker of one post. An agent of the lab takes a rerun.')
        builds: list[Build] = [*first, lambda _, seq, at: AgentJoined(seq=seq, at=at, agent=agent)]
        if desk:
            builds.append(lambda _, seq, at: DeskSet(seq=seq, at=at, agent=agent.id))
            if not self._board.desk_chat:
                builds.append(_open_thread(DESK_TITLE, PERSON, desk=True))
        if on_call:
            builds.append(lambda _, seq, at: OnCallSet(seq=seq, at=at, agent=agent.id, on_call=True))
        if coordinator:
            builds.append(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=agent.id, by=PERSON))
            builds += [_power(power, agent.id) for power in powers]
        if given:
            role, by = given
            builds.append(lambda _, seq, at: ProfileSet(seq=seq, at=at, agent=agent.id, given_role=role, by=by))
        board = await self._commit(*builds)
        return next(entry for entry in reversed(board.agents) if entry.agent.id == agent.id)

    async def name_by_model(self, agent_id: AgentId, title: str, model: str) -> str:
        """
        Record the name of the model that an agent's harness reported, and return the agent's name after it.

        Only a name that Verifold built before the harness named the model changes: one that says "default model",
        or one that holds the ID of the model that the person chose. Only this agent's name changes. The new name
        keeps clear of every name that an agent of the lab has or had, so a name in an older post never becomes
        the name of another agent. A number, once given, stays with its agent, so numbers can be out of the order
        that the agents joined.
        """
        joined = self._board.agent(agent_id)
        if joined is None or not one_line(model):
            return joined.agent.name if joined else agent_id
        agent, base = joined.agent, plain(title, model)
        now = self._board.label(agent_id)
        if is_numbered(now, base) or not awaits_model(now, title, agent.model.name):
            return agent.name

        def build(board: Board, seq: int, at: datetime) -> AgentNamed:
            taken = (text for other, text in board.names() if other != agent_id)
            return AgentNamed(seq=seq, at=at, agent=agent_id, name=label(title, model, taken))

        board = await self._commit(build)
        named = board.agent(agent_id)
        return named.agent.name if named else agent_id

    async def set_on_call(self, agent_id: AgentId, *, on_call: bool) -> None:
        """
        Record that the person put an agent's seat on call, or took it off. The same answer again records nothing.

        Raises:
            RejectedEvent: The agent is not in the lab, left it, or is a blind checker.

        """
        if self._board.agent(agent_id) and self._board.on_call(agent_id) == on_call:
            return
        await self._commit(lambda _, seq, at: OnCallSet(seq=seq, at=at, agent=agent_id, on_call=on_call))

    async def set_coordinator(self, agent_id: AgentId | None, by: AgentId, *, free: bool = False) -> AgentId | None:
        """
        Record who holds the lab's coordinator seat, and return the holder after the change.

        `by` is the person, who can give the seat to any agent or clear it with `None`, or an agent, which can take
        the seat for itself when nobody holds it and the person did not close it, and give up the seat that it
        holds. When the person clears the seat, `free` says whether an agent may take it by itself. A change that
        leaves the seat as it is records nothing.

        Raises:
            RejectedEvent: The change breaks one of these rules.

        """
        known = agent_id is None or self._board.agent(agent_id)
        same = self._board.coordinator == agent_id and (agent_id is not None or self._board.coordinator_open == free)
        if known and same and by in (PERSON, agent_id):
            return agent_id
        opens = free and agent_id is None and by == PERSON
        board = await self._commit(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=agent_id, by=by, open=opens))
        return board.coordinator

    async def leave(self, agent_id: AgentId, by: AgentId, reason: str = '') -> AgentLeft:
        """
        Record that an agent left the lab. `by` is the agent itself, or the person when the person removed it.

        Raises:
            RejectedEvent: The agent is not in the lab, left already, or is a blind checker.

        """
        board = await self._commit(lambda _, seq, at: AgentLeft(seq=seq, at=at, agent=agent_id, by=by, reason=reason))
        return board.left[-1]

    async def post(  # noqa: PLR0913
        self,
        request: PostRequest,
        author: AgentId,
        evidence: tuple[FileEvidence, ...] = (),
        question_seen: int | None = None,
        mark: Mark | None = None,
        *,
        take: int | None = None,
    ) -> Posted:
        """
        Add a post with the next free post ID. With `new_thread`, open its thread in the same step.

        With `between` too, that thread is a side thread between the author and the agents that `between` names.
        `question_seen` is how many revisions of the question the author had been shown, which a proposal keeps.
        `mark` marks an ask that carries a request of the author's harness, or the answer with which Verifold ends
        such a request. Only the runner gives it. A post from an agent's tool or from the person has none.
        `take` is the event with which the author took the rerun that a check answers. Only the author's seat
        gives it.

        Raises:
            RejectedEvent: The post breaks a rule of the record.
            pydantic.ValidationError: The request does not describe a valid post of its kind.

        """
        # A thread that opens with an ask of the runner is the agent's thread for that kind of request.
        carries = mark.type if mark and mark != 'ends_request' else None
        opens: tuple[Build, ...] = ()
        if request.new_thread:
            opens = (_open_thread(request.new_thread, author, request.between, carries, for_person=request.for_person),)
        elif request.conversation and not self._board.conversation:
            opens = (_open_thread(CONVERSATION_TITLE, author, conversation=True),)
        board = await self._commit(*opens, _add_post(request, author, evidence, question_seen, mark, take=take))
        return board.posts[-1]

    async def open_question_thread(self) -> Posted:
        """
        Open the thread that holds the person's question, with the question as its first post.

        A new lab opens it before its agents join. The agents post their plans and the lab's answer there, and every
        agent watches it. The question's first line with text is the headline, and a longer question is also the
        body.
        """
        question = self._board.opened.question
        headline = _headline(question)
        body = '' if headline == question else question
        return await self.post(PostRequest(kind='message', text=headline, body=body, new_thread=QUESTION_TITLE), PERSON)

    async def revise_question(self, question: str, note: str = '', on: Said | None = None) -> QuestionRevised | None:
        """
        Record that the person revised the question, and return the revision, or `None` when the text is the same.

        The revision comes with a post of the person in the question's thread, which names nobody. So it reaches
        the agents and opens a closed lab again as the person's other words to the lab do, and the thread shows
        each version in order. A lab from before the question had a thread gets one thread for these posts. With
        `on`, the desk revises the question on the person's word, and the post is the desk's post for the person,
        which opens a closed lab again in the same way.
        """
        # The event strips the text, so the same text with spaces around it is no revision.
        question = question.strip()
        if question == self._board.question:
            return None
        board = await self._commit(*_revision(self._board, question, note, on.by if on else PERSON, on=on))
        return board.revisions[-1]

    async def state_deliverables(self, texts: tuple[str, ...]) -> None:
        """
        Record the deliverables that the person stated when the lab opened, before its agents join.

        Raises:
            RejectedEvent: An agent joined already, or the lab would have too many deliverables.

        """
        if texts:
            await self._commit(*(_deliverable(None, text, told=False) for text in texts))

    async def add_deliverable(self, text: str, on: Said | None = None) -> DeliverableSet:
        """
        Record that the person stated one more deliverable, and return it.

        It comes with a post of the person in the question's thread, which names nobody. So it reaches the agents
        and opens a closed lab again, as the person's other words to the lab do. With `on`, the desk states it on
        the person's word, and the post is the desk's post for the person, which opens a closed lab again too.

        Raises:
            RejectedEvent: The lab has too many deliverables.

        """
        form = STATED_FOR_PERSON if on else STATED
        said = f'{form.format(id=_next_deliverable(self._board))}{text}'
        board = await self._commit(*_told_lab(self._board, said, on), _deliverable(None, text, on=on))
        return board.deliverables[-1]

    async def change_deliverable(self, deliverable_id: DeliverableId, text: str, on: Said | None = None) -> bool:
        """
        Record that the person changed the sentence of a deliverable, and return whether the record took a change.

        The same sentence again records nothing. The record keeps the earlier sentence. The offers for the
        deliverable stay, and so does an acceptance. `_change` says when a post tells the lab. With `on`, the desk
        makes the change on the person's word.

        Raises:
            RejectedEvent: The lab has no such deliverable.

        """
        if live(self._board, deliverable_id).text == text:
            return False
        said = f'{(CHANGED_FOR_PERSON if on else CHANGED).format(id=deliverable_id)}{text}'
        await self._change(said, deliverable_id, text, removed=False, on=on)
        return True

    async def remove_deliverable(self, deliverable_id: DeliverableId, on: Said | None = None) -> None:
        """
        Record that the person removed a deliverable. Its offers stay on the board as posts.

        With `on`, the desk removes it on the person's word.

        Raises:
            RejectedEvent: The lab has no such deliverable.

        """
        text = live(self._board, deliverable_id).text
        said = f'{(REMOVED_FOR_PERSON if on else REMOVED).format(id=deliverable_id)}{text}'
        await self._change(said, deliverable_id, text, removed=True, on=on)

    async def _change(
        self, said: str, deliverable_id: DeliverableId, text: str, *, removed: bool, on: Said | None = None
    ) -> None:
        # A new sentence or a removal is no new work for the lab. So its post does not open a closed lab again:
        # while a close stands, the record takes the change without a post. For the whole list, one such post
        # goes out in `TOLD_WINDOW` at most. The agents read every change in `brief`.
        board = self._board
        last = told_at(board)
        quiet = closing(board) is not None or (last is not None and self._clock() - last < TOLD_WINDOW)
        tells = () if quiet else _told_lab(board, said, on)
        await self._commit(*tells, _deliverable(deliverable_id, text, removed=removed, told=not quiet, on=on))

    async def offer(  # noqa: PLR0913
        self,
        author: AgentId,
        deliverable_id: DeliverableId,
        evidence: tuple[FileEvidence, ...],
        note: str,
        body: str = '',
        *,
        helper: str = '',
    ) -> Posted:
        """
        Post an agent's offer of files for a deliverable, and return the post.

        The first offer for a deliverable opens the deliverable's thread, and every later offer goes there.

        Raises:
            RejectedEvent: The lab has no such deliverable, or the author cannot offer files.
            pydantic.ValidationError: The note is no headline, the body is too long, or the offer names no file.

        """
        # No other change comes between this read of the board and the commit, so the first offer opens the thread.
        stands = live(self._board, deliverable_id)
        title = offers_title(deliverable_id, stands.text)
        first = self._board.offers_thread(deliverable_id) is None

        def post(board: Board, seq: int, at: datetime) -> Posted:
            offered = FileOffer(
                id=f'p-{len(board.posts) + 1}',
                thread=board.offers_thread(deliverable_id) or board.threads[-1].thread.id,
                author=author,
                helper=helper,
                text=note,
                body=body,
                deliverable=deliverable_id,
                evidence=evidence,
            )
            return Posted(seq=seq, at=at, post=offered)

        opens = (_open_thread(title, author, deliverable=deliverable_id),) if first else ()
        board = await self._commit(*opens, post)
        return board.posts[-1]

    async def decide(self, deliverable_id: DeliverableId, decision: Decision, offer: PostId, text: str = '') -> None:
        """
        Record what the person decided about an offer: an acceptance, a request for changes, or an acceptance taken back.

        The decision comes with a post of the person that replies to the offer, so the offer's author hears it.
        With a request for changes, `text` holds the person's words, and they are that post. A deliverable has one
        accepted offer at most: an acceptance of another offer first takes the standing one back, in the same
        step, so that its author hears it too.

        Raises:
            RejectedEvent: The post is no offer for the deliverable, its author replaced it, or there is no
                acceptance to take back.
            pydantic.ValidationError: A request for changes has no words.

        """
        board = self._board
        live(board, deliverable_id)
        # The record refuses the same. This says so before the person's reply to another offer is built.
        check_decidable(board, deliverable_id, decision, offer)
        took = accepted(board, deliverable_id)
        back = _decision(board, deliverable_id, 'taken_back', took.offer) if decision == 'accepted' and took else ()
        await self._commit(*back, *_decision(board, deliverable_id, decision, offer, text))

    async def set_alarm(self, agent_id: AgentId, minutes: float, *, quiet: bool) -> AlarmSet:
        """Record that an agent wants to be woken. The alarm replaces the agent's last one, and zero minutes cancels it."""
        board = await self._commit(
            lambda _, seq, at: AlarmSet(seq=seq, at=at, agent=agent_id, minutes=minutes, quiet=quiet, stays=True)
        )
        return board.alarms[-1]

    async def set_notes(self, agent_id: AgentId, text: str) -> NotesSet | None:
        """
        Record a seat's notes: the text replaces the notes that the seat's agent kept before.

        A text that is the notes already records nothing. Return the notes as they stand, or `None` without any.

        Raises:
            RejectedEvent: The agent is not in the lab, left it, or is a blind checker.

        """
        kept = self._board.notes_of(agent_id)
        if text != (kept.text if kept else ''):
            await self._commit(lambda _, seq, at: NotesSet(seq=seq, at=at, agent=agent_id, text=text))
        return self._board.notes_of(agent_id)

    async def set_profile(  # noqa: PLR0913
        self,
        agent_id: AgentId,
        role: str | None = None,
        status: str | None = None,
        *,
        name: str | None = None,
        about: str | None = None,
        picture: Picture | None = None,
        coordinator: bool | None = None,
        reviewer: bool | None = None,
    ) -> tuple[str, str]:
        """
        Record what an agent says that it is and does, and return its role and status after the change.

        With `coordinator` or `reviewer`, the agent takes that seat or gives it up in the same step. The record
        takes the whole call or nothing: when the board refuses one part, such as a seat that is not free, no part
        is recorded. A part that changes nothing records nothing, so an agent can read its own profile with no
        arguments, and one that repeats its status does not fill the record.

        Raises:
            RejectedEvent: The name is taken, reserved, or the name of a harness or a model, or a seat is not free.

        """
        board = self._board
        now_role, now_status = board.profile(agent_id)
        fresh = {
            'role': None if role == now_role else role,
            'status': None if status == now_status else status,
            'name': None if name == board.chosen_name(agent_id) else name,
            'about': None if about == board.about(agent_id) else about,
            'picture': None if picture == board.picture(agent_id) else picture,
        }
        builds: list[Build] = []

        def profile(board: Board, seq: int, at: datetime) -> ProfileSet:
            # The name's rules are here and not in the record's rules, so a record keeps every name that it holds.
            if fresh['name'] and board.agent(agent_id):
                check_name(board, agent_id, str(fresh['name']))
            return ProfileSet.model_validate({'seq': seq, 'at': at, 'agent': agent_id} | fresh)

        if not board.agent(agent_id) or any(value is not None for value in fresh.values()):
            builds.append(profile)
        holder = agent_id if coordinator else None
        # An agent that gives up a seat that it does not hold gets the reason.
        if coordinator is not None and not (coordinator and board.coordinator == agent_id):
            builds.append(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=holder, by=agent_id))
        if reviewer is not None and not (reviewer and board.reviewer(agent_id)):
            builds.append(
                lambda _, seq, at: ReviewerSet(seq=seq, at=at, agent=agent_id, reviewer=bool(reviewer), by=agent_id)
            )
        if builds:
            board = await self._commit(*builds)
        return board.profile(agent_id)

    async def change_profile(  # noqa: PLR0913
        self,
        agent_id: AgentId,
        by: AgentId,
        *,
        reset_name: bool = False,
        about: str | None = None,
        reset_picture: bool = False,
        given_role: str | None = None,
        flag: str | None = None,
    ) -> None:
        """
        Record a change that the person or the lab's coordinator makes to an agent's profile.

        `by` is the person or the coordinator. The record keeps every earlier text, and the agent's next news says
        what changed. A call that changes nothing records nothing.

        Raises:
            RejectedEvent: The change is not one that `by` can make.

        """
        board = self._board
        standing_flag = board.flag(agent_id)
        fresh = {
            'name': '' if reset_name and board.chosen_name(agent_id) else None,
            'about': None if about == board.about(agent_id) else about,
            'no_picture': reset_picture and board.picture(agent_id) is not None,
            'given_role': None if given_role == board.given_role(agent_id)[0] else given_role,
            'flag': None if flag == (standing_flag.flag if standing_flag else '') else flag,
        }
        if board.agent(agent_id) and not any(value not in (None, False) for value in fresh.values()):
            return
        await self._commit(
            lambda _, seq, at: ProfileSet.model_validate({'seq': seq, 'at': at, 'agent': agent_id, 'by': by} | fresh)
        )

    async def set_reviewer(self, agent_id: AgentId, by: AgentId, *, reviewer: bool) -> None:
        """
        Record that an agent holds a reviewer seat from now on, or holds one no longer.

        `by` is the person, who can give a seat to any agent and take it, or the agent itself, which can take a
        free seat and give up the seat that it holds. A change that leaves the seat as it is records nothing.

        Raises:
            RejectedEvent: The change breaks one of these rules.

        """
        same = self._board.agent(agent_id) and self._board.reviewer(agent_id) == reviewer
        # An agent that gives up a seat that it does not hold gets the reason.
        if same and (reviewer or by == PERSON) and by in (PERSON, agent_id):
            return
        await self._commit(lambda _, seq, at: ReviewerSet(seq=seq, at=at, agent=agent_id, reviewer=reviewer, by=by))

    async def watch(self, agent_id: AgentId, thread_id: ThreadId, *, watching: bool) -> WatchSet:
        """Record that an agent starts or stops watching a thread."""
        board = await self._commit(
            lambda _, seq, at: WatchSet(seq=seq, at=at, agent=agent_id, thread=thread_id, watching=watching)
        )
        return board.watches[-1]

    async def request_rerun(self, by: AgentId, post_id: PostId) -> RerunRequested:
        """
        Record a request for an independent rerun of a post. The request starts nothing: an agent of the lab takes it.

        Raises:
            RejectedEvent: The post cannot get a rerun, or the same member has an open request for it already.

        """

        def build(board: Board, seq: int, at: datetime) -> RerunRequested:
            # A record from before this rule can hold such a pair, so the rule is here and not in the record's rules.
            if any(entry.by == by for entry in wanted_reruns(board, post_id)):
                raise RejectedEvent(
                    f'You asked for an independent rerun of {post_id} already. Its check comes to you as a post.'
                )
            # An older record holds requests from before the reviewer seats, so this rule is here too.
            if board.post(post_id):
                check_review(board, by, post_id, 'A request for an independent rerun of')
            return RerunRequested(seq=seq, at=at, by=by, post=post_id)

        board = await self._commit(build)
        return board.reruns[-1]

    async def take_rerun(self, agent_id: AgentId, post_id: PostId, manifest: str | None = None) -> RerunTaken:
        """
        Record that an agent takes the rerun of a post, and return the take.

        `manifest` is the SHA-256 of the clean copy's manifest that the agent got. The take gives the agent a lease
        on the rerun. A second call returns the first take, also when it comes while the first one is being
        recorded, and records nothing: `renew_rerun` renews the lease.

        Raises:
            RejectedEvent: The agent cannot take the rerun, as `check_take` says.

        """
        if taken := self._board.take(agent_id, post_id):
            return taken
        try:
            board = await self._commit(_take(agent_id, post_id, manifest))
        except RejectedEvent:
            # Two calls of one agent at the same time are one take.
            if taken := self._board.take(agent_id, post_id):
                return taken
            raise
        return board.takes[-1]

    async def vote(self, by: AgentId, post_id: PostId, direction: Direction, reason: str = '') -> Voted | None:
        """
        Record a vote of an agent or the person on a post, and return the voter's vote as it stands, or `None`.

        A voter has one vote on a post: a new one replaces it, and `none` takes it back. The same vote again
        records nothing. A vote wakes nobody and changes nothing else on the board. An agent takes back no vote on a
        post whose votes are sealed for the other agents, because a vote and its take-back would show it the tally
        and leave no vote. A vote the other way replaces its vote.

        Raises:
            RejectedEvent: The vote breaks a rule of the record, as `check_vote` says, or an agent takes back its
                vote on a post whose votes are sealed.

        """
        now = vote_of(self._board, by, post_id)
        if now and (now.direction, now.reason) == (direction, one_line(reason)):
            return now

        def build(board: Board, seq: int, at: datetime) -> Voted:
            # A record from before this rule holds early take-backs, so the rule is here and not in the record's rules.
            target = board.post(post_id)
            if direction == 'none' and by != PERSON and target and at < (shows := revealed(board, target)):
                raise RejectedEvent(
                    f'The votes on post {post_id} are sealed until {utc(shows)} for the agents that have not voted, '
                    'and until then the board takes back no vote on it. A vote the other way replaces yours.'
                )
            return Voted(seq=seq, at=at, by=by, post=post_id, direction=direction, reason=reason)

        board = await self._commit(build)
        return vote_of(board, by, post_id)

    async def badge(  # noqa: PLR0913
        self,
        by: AgentId,
        post_id: PostId,
        badge: Badge,
        action: BadgeAction = 'give',
        reason: str = '',
        *,
        proof: PostId | None = None,
        giver: AgentId | None = None,
    ) -> BadgeSet:
        """
        Record a change to a badge on a post: `by` gives it, seconds it, or takes it back.

        A second is for the one proposal of a `breakthrough` that waits on the post. `giver` names whose badge the
        person takes back. A badge wakes nobody and changes nothing else on the board.

        Raises:
            RejectedEvent: The change breaks a rule of the record, as `check_badge` says.

        """

        def build(board: Board, seq: int, at: datetime) -> BadgeSet:
            waiting = proposal(board, post_id) if action == 'second' else None
            return BadgeSet(
                seq=seq,
                at=at,
                by=by,
                post=post_id,
                badge=badge,
                action=action,
                reason=reason,
                proof=proof,
                giver=waiting.by if waiting else giver,
            )

        board = await self._commit(build)
        return board.badges[-1]

    def check_take(self, agent_id: AgentId, post_id: PostId) -> None:
        """
        Check that an agent can take the rerun of a post now, and record nothing.

        The clean copy is made between this check and the take, so a copy that fails leaves no take in the record,
        and a take that the board refuses makes no copy.

        Raises:
            RejectedEvent: No rerun of the post is wanted, the post is the agent's own, the rerun is for an agent
                in a reviewer seat and the agent holds none, or another agent's lease keeps the agent out.

        """
        board = self._board
        apply(board, _take(agent_id, post_id)(board, board.seq + 1, self._clock()))

    async def renew_rerun(self, agent_id: AgentId, post_id: PostId) -> str:
        """
        Renew an agent's lease on the rerun of a post that it took, and return why the board did not, or `''`.

        The board renews the lease while the take waits for its check and the rerun is wanted, unless another
        agent's lease keeps the agent out. Otherwise it records nothing, and the take stands as it was.
        """
        if not wanted_reruns(self._board, post_id):
            return f'No rerun of post {post_id} is wanted now, so no lease on it stands.'
        if open_take(self._board, agent_id, post_id) is None:
            return f'You posted the check of your take of the rerun of post {post_id}, and it ended your lease.'
        try:
            await self._commit(
                lambda _, seq, at: RerunLeaseSet(seq=seq, at=at, agent=agent_id, post=post_id, held=True)
            )
        except RejectedEvent as refused:
            # Another agent's lease keeps the agent out, or its check came in meanwhile.
            return str(refused)
        return ''

    async def give_up_rerun(self, agent_id: AgentId, post_id: PostId) -> RerunTaken:
        """
        Record that an agent gives up its lease on the rerun of a post, and return its take.

        The take stays, and the agent's next check of the post with the method `rerun` and with files is still its
        check. Another agent can take the rerun from now on.

        Raises:
            RejectedEvent: The agent holds no lease on the rerun of the post.

        """
        board = await self._commit(
            lambda _, seq, at: RerunLeaseSet(seq=seq, at=at, agent=agent_id, post=post_id, held=False)
        )
        # The record's rules take no lease without a take.
        return next(entry for entry in board.takes if entry.agent == agent_id and entry.post == post_id)

    async def start_turn(  # noqa: PLR0913
        self,
        agent_id: AgentId,
        session: str,
        seen: int,
        rang: int | None = None,
        *,
        model: str | None = None,
        model_name: str | None = None,
    ) -> TurnStarted:
        """
        Record that a turn of an agent starts, in the harness's conversation `session`, with what it had seen.

        `rang` is the sequence number of the agent's alarm that rang with the turn's message. `model` and
        `model_name` are the model that the harness reported for the session, when it reported one.
        """
        board = await self._commit(
            lambda _, seq, at: TurnStarted(
                seq=seq,
                at=at,
                agent=agent_id,
                session=session,
                seen=seen,
                rang=rang,
                model=model,
                model_name=model_name,
            )
        )
        return board.starts[-1]

    async def end_turn(self, turn: TurnSummary) -> TurnEnded:
        """Record that an agent's harness ended a turn, with what the turn cost and the snapshot after it."""
        board = await self._commit(
            lambda _, seq, at: TurnEnded.model_validate(turn.model_dump() | {'seq': seq, 'at': at})
        )
        return board.turns[-1]

    def now(self) -> datetime:
        """Return the time on the clock that dates the lab's events."""
        return self._clock()

    async def set_time_left(self, left: timedelta, on: Said | None = None) -> TimeSet:
        """
        Record that the lab ends `left` from now, and return the new end. A `left` of zero stops the agents now.

        With `on`, the desk sets it on the person's word.
        """
        by = on.by if on else PERSON
        post = on.post if on else None
        board = await self._commit(lambda _, seq, at: TimeSet(seq=seq, at=at, ends_at=at + left, by=by, on=post))
        return next(entry for entry in reversed(board.times) if isinstance(entry, TimeSet))

    async def interrupt(self, agent_id: AgentId, on: Said) -> TurnInterrupted:
        """
        Record that the desk ends an agent's turn for the person, and return the record's entry.

        The agent's loop cancels the turn when it sees the entry, and the agent then starts one more turn.

        Raises:
            RejectedEvent: The agent is in no turn by the record, Verifold does not run it, or `on` is no post of
                the person in the desk chat from the last hour.

        """
        board = await self._commit(
            lambda _, seq, at: TurnInterrupted(seq=seq, at=at, agent=agent_id, by=on.by, on=on.post)
        )
        return board.interrupts[-1]

    async def set_budget(self, tokens: int | None, dollars: float | None, on: Said | None = None) -> bool:
        """
        Record the lab's budget in tokens and in dollars, and return whether the record took a change.

        It replaces the earlier one, and `None` sets none of a kind. A budget that the lab has spent already stops
        the agents in the same step. The same budget again records nothing. With `on`, the desk sets it on the
        person's word.
        """
        budget = self._board.budget
        if ((budget.tokens, budget.dollars) if budget else (None, None)) == (tokens, dollars):
            return False
        by, post = (on.by, on.post) if on else (PERSON, None)
        await self._commit(lambda _, seq, at: BudgetSet(seq=seq, at=at, tokens=tokens, dollars=dollars, by=by, on=post))
        return True

    async def set_settings(self, settings: Settings) -> None:
        """Record the person's settings for the lab. The lab follows the latest ones."""
        await self._commit(lambda _, seq, at: SettingsSet(seq=seq, at=at, settings=settings))

    async def grant(self, prefix: str) -> None:
        """Record that the person lets every agent run the commands that start with `prefix`."""
        await self._commit(lambda _, seq, at: PermissionGranted(seq=seq, at=at, prefix=prefix))

    async def run_out_of_time(self) -> None:
        """
        Record that the lab reached its end.

        Raises:
            RejectedEvent: The lab has time left, has no time limit, or ran out of time already.

        """
        await self._commit(lambda _, seq, at: TimeRanOut(seq=seq, at=at))

    async def set_power(self, power: Power, *, on: bool) -> None:
        """
        Record that the person switched a power of the coordinator on or off. The same answer again records nothing.

        Raises:
            RejectedEvent: Nobody holds the coordinator seat.

        """
        holder = self._board.coordinator
        if holder is None:
            raise RejectedEvent('A power is for the agent that holds the coordinator seat, and nobody holds it now.')
        if (power in self._board.powers) != on:
            await self._commit(_power(power, holder, on=on))

    async def request(self, move: Move, text: str, body: str, author: AgentId, adds: Adds | None = None) -> Posted:
        """
        Post the coordinator's request for a move in the conversation with the person, and return the post.

        The request opens the conversation when the lab has none. While the person's power covers the move, the
        same step records the coordinator's yes and makes the move. Otherwise the request waits for the person's
        answer, and nothing else changes: so it does when the lab's time ran out or the person stopped the lab.

        Raises:
            RejectedEvent: The author does not hold the coordinator seat, or the move cannot be made.
            SetupRejected: The move adds an agent at once, and this lab cannot start one from here.
            pydantic.ValidationError: The text is no headline, or the body is too long.

        """
        board = self._board
        # The record's rules refuse the request of any other agent. This says so before a thread opens for it.
        check_asks(board, author)
        opens = () if board.conversation else (_open_thread(CONVERSATION_TITLE, author, conversation=True),)

        def post(board: Board, seq: int, at: datetime) -> Posted:
            request = MoveRequest(
                id=f'p-{len(board.posts) + 1}',
                thread=board.conversation or board.threads[-1].thread.id,
                author=author,
                text=text,
                body=body,
                move=move,
            )
            return Posted(seq=seq, at=at, post=request)

        builds: tuple[Build, ...] = (*opens, post)
        if power_covers(board, move, self._clock()):
            builds = (*builds, _answered(None, author, yes=True))
            if isinstance(move, AddMove):
                await _add(adds, move, builds, author)
                board = self._board
            else:
                board = await self._commit(*builds, *_effects(board, move, author))
        else:
            board = await self._commit(*builds)
        return next(
            entry
            for entry in reversed(board.posts)
            if isinstance(entry.post, MoveRequest) and entry.post.author == author
        )

    async def answer_request(
        self,
        request_id: PostId,
        *,
        yes: bool,
        minutes: int | None = None,
        adds: Adds | None = None,
    ) -> RequestAnswered:
        """
        Record the person's answer to a request of the coordinator for a move, and with a yes make the move.

        The person's answer is also a post of the person that replies to the request, so the coordinator hears it
        as it hears the person's other words in the conversation. With a yes, the events of the move follow the
        answer in the same step, so that either all of it is in the record or none of it is. `minutes` gives
        another amount than the request names, for a request for more time.

        Raises:
            RejectedEvent: The post is no request that can take this answer, or the move cannot be made any more.
            SetupRejected: The move adds an agent, and this lab cannot start one from here.

        """
        board = self._board
        entry = board.post(request_id)
        request = entry.post if entry and isinstance(entry.post, MoveRequest) else None
        builds: tuple[Build, ...] = (_answered(request_id, PERSON, yes=yes, minutes=minutes),)
        if request:
            said = PostRequest(kind='answer', text=YES if yes else NO, thread=request.thread, reply_to=request_id)
            builds = (_add_post(said, PERSON, ()), *builds)
        if not yes or request is None:
            await self._commit(*builds)
        elif isinstance(request.move, AddMove):
            await _add(adds, request.move, builds, request.author)
        else:
            await self._commit(*builds, *_effects(board, request.move, PERSON, minutes))
        return self._board.answers[-1]

    async def take_minutes_back(self, request_id: PostId) -> None:
        """
        Record that the person takes back the minutes that a request for more time gave the lab.

        Raises:
            RejectedEvent: The request gave no minutes, the lab's time changed since, or the lab would end now.

        """

        def build(board: Board, seq: int, at: datetime) -> TimeSet:
            answered = board.answer_to(request_id)
            given = time_given(board, answered) if answered else None
            entry = board.post(request_id)
            move = entry.post.move if entry and isinstance(entry.post, MoveRequest) else None
            if not answered or given is None or board.times[-1] is not given or not isinstance(move, TimeMove):
                raise RejectedEvent(
                    f"The request {request_id} gave the lab no minutes, or the lab's time changed since. Set the "
                    "lab's time yourself."
                )
            ends_at = given.ends_at - timedelta(minutes=answered.minutes or move.minutes)
            if ends_at <= at:
                raise RejectedEvent('Without these minutes the lab ends now. To stop the lab, set its time to zero.')
            return TimeSet(seq=seq, at=at, ends_at=ends_at)

        await self._commit(build)

    async def close_rounds(self) -> None:
        """Record the close of each round whose close is due now, such as a round whose time came. Nothing else changes."""
        await self._commit()

    async def wait_for_change(self, after: int, timeout: float | None = None) -> None:
        """Return once the board has an event after `after`, or after `timeout` seconds when given."""
        await wait_until(self._changed, lambda: self._board.seq > after, timeout)

    async def _commit(self, *builds: Build) -> Board:
        # The condition's lock serializes changes. Each event comes from the board that it joins, so IDs and sequence
        # numbers never collide, and `apply` rejects a bad event before anything reaches the record.
        async with self._changed:
            events: list[Event] = []
            at = self._clock()
            board = _close_rounds(self._board, at, events)
            for build in builds:
                event = build(board, board.seq + 1, at)
                board = apply(board, event)
                events.append(event)
            board = _close_rounds(board, at, events)
            board = _reach_limits(board, at, events, self._disk)
            if not events:
                return board
            self._write(*events)
            self._board = board
            self._changed.notify_all()
            return board

    def _write(self, *events: Event) -> None:
        # Every write to the record goes through here. The terminal says what the record moved out of its file,
        # also when the write then fails. A record that another program changed stops the server.
        before = self._record.moved
        try:
            self._record.append(*events)
        except RecordChanged as error:
            self._stops(error)
            raise
        finally:
            if moved := self._record.moved - before:
                logger.warning(
                    'Verifold moved %s that another program added to the end of the record to %s.',
                    '1 byte' if moved == 1 else f'{moved} bytes',
                    self._record.foreign,
                )


REVISED: Final = 'The person revised the question: '
"""How the post that tells the lab of a revision starts. The new question follows it."""

REVISED_TITLE: Final = 'The question, revised'
"""The title of the thread that holds the revisions in a lab from before the question had a thread."""

REVISED_FOR_PERSON: Final = 'The coordinator revised the question for the person: '
"""How that post starts when the coordinator revised the question with the person's power."""

REVISED_BY_DESK: Final = 'The desk revised the question for the person: '
"""How that post starts when the desk revised the question on the person's word."""

YES: Final = 'Yes'
NO: Final = 'Not now'
"""The person's answer to a request for a move, as the conversation shows it."""


STATED: Final = 'The person stated a deliverable, {id}: '
"""How the post that tells the lab of a new deliverable starts. The person's sentence follows it."""

CHANGED: Final = 'The person changed the sentence of the deliverable {id} to: '
"""How that post starts when the person changed a deliverable. The new sentence follows it."""

REMOVED: Final = 'The person removed the deliverable {id}: '
"""How that post starts when the person removed a deliverable. The sentence that it had follows it."""

STATED_FOR_PERSON: Final = 'The desk stated a deliverable for the person, {id}: '
CHANGED_FOR_PERSON: Final = 'The desk changed the sentence of the deliverable {id} for the person to: '
REMOVED_FOR_PERSON: Final = 'The desk removed the deliverable {id} for the person: '
"""How these posts start when the desk made the change on the person's word."""

ACCEPTED: Final = 'The person accepted these files for the deliverable {id}.'
"""The person's reply to an offer that they accepted."""

TAKEN_BACK: Final = 'The person took back the acceptance of these files for the deliverable {id}.'
"""The person's reply to an offer whose acceptance they took back."""

DELIVERABLES_TITLE: Final = 'Deliverables'
"""The title of the thread that holds the person's deliverables in a lab from before the question had a thread."""

TOLD_WINDOW: Final = timedelta(seconds=60)
"""How long after a post about a new sentence or a removal the next such change sends no post."""


def _next_deliverable(board: Board) -> DeliverableId:
    return f'd-{len({entry.deliverable for entry in board.deliverables}) + 1}'


def _deliverable(
    deliverable_id: DeliverableId | None,
    text: str,
    *,
    removed: bool = False,
    told: bool = True,
    on: Said | None = None,
) -> Build:
    # Without an ID, the deliverable is a new one. With `told`, the board's newest post tells the lab of it. With
    # `on`, the desk makes the change on the person's word.
    return lambda board, seq, at: DeliverableSet(
        seq=seq,
        at=at,
        deliverable=deliverable_id or _next_deliverable(board),
        text=text,
        removed=removed,
        post=board.posts[-1].post.id if told else None,
        by=on.by if on else PERSON,
        on=on.post if on else None,
    )


def _told_lab(board: Board, said: str, on: Said | None = None) -> tuple[Build, ...]:
    # The person's post that tells the lab of a deliverable, in the question's thread, or the desk's post for the
    # person with `on`. A lab from before the question had a thread gets one thread for these posts.
    thread = question_thread(board) or next(
        (
            opened.thread.id
            for opened in board.threads
            if opened.thread.title == DELIVERABLES_TITLE and opened.thread.opened_by == PERSON
        ),
        None,
    )
    author = on.by if on else PERSON
    opens = () if thread else (_open_thread(DELIVERABLES_TITLE, author, for_person=on is not None),)
    request = PostRequest(
        kind='message',
        text=said,
        thread=thread,
        new_thread=None if thread else DELIVERABLES_TITLE,
        for_person=on is not None,
        on=on.post if on else None,
    )
    return (*opens, _add_post(request, author, ()))


def _decision(
    board: Board, deliverable_id: DeliverableId, decision: Decision, offer: PostId, text: str = ''
) -> tuple[Build, ...]:
    # The person's reply to the offer, and the decision after it.
    entry = board.post(offer)
    thread = entry.post.thread if entry else None
    words = {'accepted': ACCEPTED, 'taken_back': TAKEN_BACK}
    said = text if decision == 'changes_asked' else words[decision].format(id=deliverable_id)
    reply = PostRequest(kind='message', text=said, thread=thread, reply_to=offer)
    return (
        _add_post(reply, PERSON, ()),
        lambda board, seq, at: DeliverableDecided(
            seq=seq,
            at=at,
            deliverable=deliverable_id,
            decision=decision,
            offer=offer,
            post=board.posts[-1].post.id,
        ),
    )


def _revision(  # noqa: PLR0913
    board: Board, question: str, note: str, by: AgentId, *, requested: bool = False, on: Said | None = None
) -> tuple[Build, ...]:
    # The post that tells the lab of a revision, in the question's thread, and the revision after it. A lab from
    # before the question had a thread gets one thread for these posts, whoever revised the question first. With
    # `requested`, the revision is the move of the request that just got its yes. With `on`, the desk revised it.
    earlier = {told.post.thread for revision in board.revisions if (told := board.post(revision.post))}
    opening = REVISED if by == PERSON else REVISED_BY_DESK if on else REVISED_FOR_PERSON
    whole = f'{opening}{question}'
    text = _headline(whole)
    # A question that fits in the headline is not repeated in the body.
    parts = ('' if text == whole else question, f'Why: {note}' if note else '')
    body = '\n\n'.join(part for part in parts if part)
    thread = question_thread(board) or next(
        (
            opened.thread.id
            for opened in board.threads
            if opened.thread.title == REVISED_TITLE
            and (opened.thread.opened_by == PERSON or opened.thread.id in earlier)
        ),
        None,
    )
    request = PostRequest(
        kind='message',
        text=text,
        body=body,
        thread=thread,
        new_thread=None if thread else REVISED_TITLE,
        for_person=by != PERSON,
        on=on.post if on else None,
    )
    opens = (_open_thread(REVISED_TITLE, by, for_person=on is not None),) if thread is None else ()
    return (
        *opens,
        _add_post(request, by, ()),
        lambda board, seq, at: QuestionRevised(
            seq=seq,
            at=at,
            question=question,
            note=note,
            post=board.posts[-1].post.id,
            by=by,
            request=board.answers[-1].request if requested else None,
            on=on.post if on else None,
        ),
    )


def _power(power: Power, agent: AgentId, *, on: bool = True) -> Build:
    return lambda _, seq, at: PowerSet(seq=seq, at=at, power=power, on=on, agent=agent)


def _answered(request_id: PostId | None, by: AgentId, *, yes: bool, minutes: int | None = None) -> Build:
    # Without an ID, the request is the board's newest post: the request that the same step posted.
    def build(board: Board, seq: int, at: datetime) -> RequestAnswered:
        request = request_id or board.posts[-1].post.id
        return RequestAnswered(seq=seq, at=at, request=request, yes=yes, by=by, minutes=minutes)

    return build


async def _add(adds: Adds | None, move: AddMove, first: tuple[Build, ...], asked_by: AgentId) -> None:
    if adds is None:
        raise SetupRejected('This lab cannot start an agent from here.')
    await adds(move.seat, first, asked_by)


type RecordedMove = TimeMove | PermissionMove | RemoveMove | SettingMove | QuestionMove
"""A move that the record alone makes. A move that adds an agent is not one, because the host starts the agent."""


def _effects(board: Board, move: RecordedMove, by: AgentId, minutes: int | None = None) -> tuple[Build, ...]:
    """
    Return the events that make a move after the yes to its request. `by` is who said yes.

    They are the events that the person's own move records, and each names the request where its record can.
    `minutes` is the amount that the person gave in place of the request's. No event holds the coordinator's
    words as the person's: the reason stays in the request.
    """
    match move:
        case TimeMove():
            return (_more_time(minutes or move.minutes),)
        case PermissionMove():
            return (_permission_answer(move, by),)
        case RemoveMove():
            return (_removal(move, by),)
        case SettingMove():
            return (_setting(move),)
        case QuestionMove():
            if move.question == board.question:
                raise RejectedEvent('The question has this text already.')
            # The note is the coordinator's word. The person's revision carries none of it.
            return _revision(board, move.question, '' if by == PERSON else move.note, by, requested=True)
        case _:
            assert_never(move)


def _more_time(minutes: int) -> Build:
    def build(board: Board, seq: int, at: datetime) -> TimeSet:
        # The minutes count from the lab's end, or from now when the end has passed. So no move ends a lab earlier.
        ends_at = max(board.ends_at or at, at) + timedelta(minutes=minutes)
        return TimeSet(seq=seq, at=at, ends_at=ends_at, request=board.answers[-1].request)

    return build


def _permission_answer(move: PermissionMove, by: AgentId) -> Build:
    def build(board: Board, seq: int, at: datetime) -> Posted:
        # The record's rules check the answer against the request and its author once more.
        ask, label = permission_choice(board, move, by)
        answer = Answer(
            id=f'p-{len(board.posts) + 1}',
            thread=ask.thread,
            author=by,
            text=label,
            reply_to=ask.id,
            choice=label,
            for_request=board.answers[-1].request,
        )
        return Posted(seq=seq, at=at, post=answer)

    return build


def _removal(move: RemoveMove, by: AgentId) -> Build:
    # The removal is the person's. With the coordinator's power, it names the coordinator too. The reason is the
    # coordinator's, so it stays in the request, which the removal names.
    through = None if by == PERSON else by
    return lambda board, seq, at: AgentLeft(
        seq=seq, at=at, agent=move.agent, by=PERSON, through=through, request=board.answers[-1].request
    )


def _setting(move: SettingMove) -> Build:
    section, _, name = move.key.partition('.')

    def build(board: Board, seq: int, at: datetime) -> SettingsSet:
        # The section is validated again, so the setting holds a value of its own type.
        now = getattr(board.settings, section)
        changed = type(now).model_validate(now.model_dump() | {name: move.value})
        settings = board.settings.model_copy(update={section: changed})
        return SettingsSet(seq=seq, at=at, settings=settings, request=board.answers[-1].request)

    return build


def _take(agent_id: AgentId, post_id: PostId, manifest: str | None = None) -> Build:
    def build(board: Board, seq: int, at: datetime) -> RerunTaken:
        target = board.post(post_id)
        if target is None or not target.post.evidence:
            raise RejectedEvent(f'No rerun of post {post_id} is wanted now. `rerun` asks for one.')
        # A rerun is for the holders of the reviewer seats, and for any agent when no holder can take it. A lease
        # keeps out one agent at a time. An older record has neither rule, so they are here and not in the
        # record's rules. The author's own take gets the record's own reason.
        own = target.post.author == agent_id
        seated = board.reviewer(agent_id) or own
        if not seated and wanted_reruns(board, post_id) and open_to(board, post_id, at) == 'reviewer':
            raise RejectedEvent(
                f"The rerun of another agent's post takes a reviewer seat while an agent in such a seat can take "
                f'it. {seats_line(board)}'
            )
        if not own and (refusal := lease_refusal(board, agent_id, post_id, at)):
            raise RejectedEvent(refusal)
        commit = target.post.evidence[0].commit
        return RerunTaken(seq=seq, at=at, agent=agent_id, post=post_id, commit=commit, manifest=manifest)

    return build


def _close_rounds(board: Board, at: datetime, events: list[Event]) -> Board:
    # Each close of a round that is due at `at`, added to the events of one step. The record's rules check it again.
    while due := close_due(board, at):
        event = RoundClosed(seq=board.seq + 1, at=at, round=due[0], why=due[1])
        board = apply(board, event)
        events.append(event)
    return board


def _reach_limits(board: Board, at: datetime, events: list[Event], disk: DiskUse | None) -> Board:
    # The record's note that the lab reached its budget or its disk limit, added to the events of one step. The
    # record's rules check it again.
    if board.at_limit is not None:
        return board
    total = disk.total if disk else None
    limit = reached(board, total)
    if limit is None:
        return board
    event = LimitReached(seq=board.seq + 1, at=at, limit=limit, disk_bytes=total if limit == 'disk' else None)
    events.append(event)
    return apply(board, event)


def _headline(text: str) -> str:
    # The first line with text, cut to a headline. A question can start with a separator that `splitlines` breaks
    # on and the schema's strip keeps.
    first = next((line.strip() for line in text.splitlines() if line.strip()), QUESTION_TITLE)
    return first if len(first) <= MAX_HEADLINE else f'{first[: MAX_HEADLINE - 1]}…'


def _open_thread(  # noqa: PLR0913
    title: str,
    opened_by: AgentId,
    between: tuple[AgentId, ...] = (),
    carries: Carries | None = None,
    *,
    conversation: bool = False,
    for_person: bool = False,
    deliverable: DeliverableId | None = None,
    desk: bool = False,
) -> Build:
    # The author is always in its own side thread, and comes first. An agent that names itself changes nothing.
    members = tuple(dict.fromkeys((opened_by, *between))) if between else ()

    def build(board: Board, seq: int, at: datetime) -> ThreadOpened:
        thread = Thread(
            id=f't-{len(board.threads) + 1}',
            title=title,
            opened_by=opened_by,
            between=members,
            carries=carries,
            conversation=conversation,
            for_person=for_person,
            deliverable=deliverable,
            desk=desk,
        )
        return ThreadOpened(seq=seq, at=at, thread=thread)

    return build


def _add_post(  # noqa: PLR0913
    request: PostRequest,
    author: AgentId,
    evidence: tuple[FileEvidence, ...],
    question_seen: int | None = None,
    mark: Mark | None = None,
    *,
    take: int | None = None,
) -> Build:
    def build(board: Board, seq: int, at: datetime) -> Posted:
        # A new thread, and a conversation that this step opens, is the board's newest thread.
        talk = board.conversation if request.conversation else None
        thread_id = request.thread or talk or board.threads[-1].thread.id
        # No field of a request holds a take either, so only the seat that pinned the files can give one. A take
        # has one check: when another check of the same take came first, this one is a check like any other.
        still = take if request.reply_to and open_take(board, author, request.reply_to) else None
        post = request.to_post(f'p-{len(board.posts) + 1}', thread_id, author, evidence, question_seen, take=still)
        # No field of a request holds a mark, so no agent and no person's post can carry one.
        if isinstance(post, Answer) and mark == 'ends_request':
            post = post.model_copy(update={'ends_request': True})
        elif isinstance(post, Ask) and isinstance(mark, PermissionShown | QuestionShown):
            post = post.model_copy(update={'request': mark.type, 'shown': mark})
        # The coordinator's post for the person is for the whole lab where such a post can stand, so that it
        # reaches the agents as the person's own post does.
        aside = board.is_side(thread_id) or thread_id == board.conversation
        if post.for_person and author == board.coordinator and not (post.mentions or post.reply_to or aside):
            post = post.model_copy(update={'to_lab': True})
        # An older record holds closes that name no candidate, or that came before any reading, so these rules are
        # here and not in the record's rules. The person posts no close, and the record's rules say so.
        if isinstance(post, Close) and author != PERSON:
            check_names_candidate(board, post)
            check_read(board)
        # An older record holds checks from before the reviewer seats, so this rule is here and not in the record's
        # rules.
        # The one check of a rerun that its author took needs no seat of its own: the take was open to the author.
        if isinstance(post, Check) and post.take is None and board.post(post.reply_to):
            check_review(board, author, post.reply_to, 'A check on')
        return Posted(seq=seq, at=at, post=post)

    return build
