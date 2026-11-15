"""The service that owns one lab: its record, its board, and the callers that wait for new events."""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Final, Self

from verifold.protocol.agents import Agent
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AgentNamed,
    AlarmSet,
    CoordinatorSet,
    Event,
    LabOpened,
    OnCallSet,
    PermissionGranted,
    Posted,
    ProfileSet,
    QuestionRevised,
    RerunRequested,
    SettingsSet,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    TurnSummary,
    WatchSet,
)
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_HEADLINE, FileEvidence
from verifold.protocol.settings import Settings
from verifold.protocol.threads import QUESTION_TITLE, Thread
from verifold.server.changes import wait_until
from verifold.server.errors import LabExists
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply, fold
from verifold.society.labels import awaits_model, label
from verifold.society.lines import question_thread
from verifold.society.rules import waiting_reruns
from verifold.store.record_file import RecordFile

type Clock = Callable[[], datetime]
type Build = Callable[[Board, int, datetime], Event]


def utc_now() -> datetime:
    """Return the current time in UTC."""
    return datetime.now(UTC)


class Lab:
    """
    One lab's record and board.

    Every change goes through one lock: the lab checks the event against the board, writes it to the record, and then
    wakes the callers that wait for new events. An event that breaks a rule never reaches the record.
    """

    def __init__(self, record: RecordFile, events: tuple[Event, ...], clock: Clock = utc_now) -> None:
        """
        Serve an open record, given the events that it holds.

        Raises:
            RejectedEvent: The events do not add up to a board.

        """
        self._record = record
        self._clock = clock
        self._board = fold(events)
        self._changed = asyncio.Condition()

    @classmethod
    def load(cls, record: RecordFile, clock: Clock = utc_now) -> Self:
        """Serve a record that holds a lab already."""
        return cls(record, record.read(), clock)

    @classmethod
    def create(
        cls,
        record: RecordFile,
        question: str,
        *,
        auto_mode: bool = True,
        time_left: timedelta | None = None,
        clock: Clock = utc_now,
    ) -> Self:
        """
        Open a new lab on `question` in an empty record. With `time_left`, the lab ends that long after it opens.

        Raises:
            LabExists: The record holds a lab already.

        """
        if record.read():
            raise LabExists('This record holds a lab already. Load it instead.')
        at = clock()
        ends_at = at + time_left if time_left is not None else None
        opened = LabOpened(seq=1, at=at, question=question, auto_mode=auto_mode, ends_at=ends_at)
        record.append(opened)
        return cls(record, (opened,), clock)

    @property
    def board(self) -> Board:
        """The board after every event so far."""
        return self._board

    async def join(self, agent: Agent, *, on_call: bool = False, coordinator: bool = False) -> AgentJoined:
        """
        Add an agent to the lab.

        With `on_call`, the person put its seat on call. With `coordinator`, the person made it the lab's
        coordinator. The record takes both in the same step as the agent.
        """
        builds: list[Build] = [lambda _, seq, at: AgentJoined(seq=seq, at=at, agent=agent)]
        if on_call:
            builds.append(lambda _, seq, at: OnCallSet(seq=seq, at=at, agent=agent.id, on_call=True))
        if coordinator:
            builds.append(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=agent.id, by=PERSON))
        board = await self._commit(*builds)
        return next(entry for entry in reversed(board.agents) if entry.agent.id == agent.id)

    async def name_by_model(self, agent_id: AgentId, title: str, model: str) -> str:
        """
        Record the name of the model that an agent's harness reported, and return the agent's name after it.

        Only a name that says "default model" for the model of the harness `title` changes, and it changes once.
        The new name keeps clear of every name that an agent of the lab has or had.
        """
        joined = self._board.agent(agent_id)
        if joined is None or not model.strip() or not awaits_model(joined.agent.name, title):
            return joined.agent.name if joined else agent_id

        def build(board: Board, seq: int, at: datetime) -> AgentNamed:
            others = (entry.agent.name for entry in board.agents if entry.agent.id != agent_id)
            former = (before for _, before in board.renames)
            return AgentNamed(seq=seq, at=at, agent=agent_id, name=label(title, model, (*others, *former)))

        board = await self._commit(build)
        return board.renames[-1][0].name

    async def set_on_call(self, agent_id: AgentId, *, on_call: bool) -> None:
        """
        Record that the person put an agent's seat on call, or took it off. The same answer again records nothing.

        Raises:
            RejectedEvent: The agent is not in the lab, left it, or is a blind checker.

        """
        if self._board.agent(agent_id) and self._board.on_call(agent_id) == on_call:
            return
        await self._commit(lambda _, seq, at: OnCallSet(seq=seq, at=at, agent=agent_id, on_call=on_call))

    async def set_coordinator(self, agent_id: AgentId | None, by: AgentId) -> AgentId | None:
        """
        Record who holds the lab's coordinator seat, and return the holder after the change.

        `by` is the person, who can give the seat to any agent or clear it with `None`, or an agent, which can take
        the seat for itself when nobody holds it and give up the seat that it holds. A change that leaves the seat
        as it is records nothing.

        Raises:
            RejectedEvent: The change breaks one of these rules.

        """
        known = agent_id is None or self._board.agent(agent_id)
        if known and self._board.coordinator == agent_id and by in (PERSON, agent_id):
            return agent_id
        board = await self._commit(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=agent_id, by=by))
        return board.coordinator

    async def leave(self, agent_id: AgentId, by: AgentId, reason: str = '') -> AgentLeft:
        """
        Record that an agent left the lab. `by` is the agent itself, or the person when the person removed it.

        Raises:
            RejectedEvent: The agent is not in the lab, left already, or is a blind checker.

        """
        board = await self._commit(lambda _, seq, at: AgentLeft(seq=seq, at=at, agent=agent_id, by=by, reason=reason))
        return board.left[-1]

    async def post(
        self,
        request: PostRequest,
        author: AgentId,
        evidence: tuple[FileEvidence, ...] = (),
        question_seen: int | None = None,
    ) -> Posted:
        """
        Add a post with the next free post ID. With `new_thread`, open its thread in the same step.

        With `between` too, that thread is a side thread between the author and the agents that `between` names.
        `question_seen` is how many revisions of the question the author had been shown, which a proposal keeps.

        Raises:
            RejectedEvent: The post breaks a rule of the record.
            pydantic.ValidationError: The request does not describe a valid post of its kind.

        """
        opens = (_open_thread(request.new_thread, author, request.between),) if request.new_thread else ()
        board = await self._commit(*opens, _add_post(request, author, evidence, question_seen))
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

    async def revise_question(self, question: str, note: str = '') -> QuestionRevised | None:
        """
        Record that the person revised the question, and return the revision, or `None` when the text is the same.

        The revision comes with a post of the person in the question's thread, which names nobody. So it reaches
        the agents and opens a closed lab again as the person's other words to the lab do, and the thread shows
        each version in order. A lab from before the question had a thread gets one thread for these posts.
        """
        # The event strips the text, so the same text with spaces around it is no revision.
        question = question.strip()
        if question == self._board.question:
            return None
        whole = f'{REVISED}{question}'
        text = _headline(whole)
        # A question that fits in the headline is not repeated in the body.
        parts = ('' if text == whole else question, f'Why: {note}' if note else '')
        body = '\n\n'.join(part for part in parts if part)
        thread = question_thread(self._board) or next(
            (
                opened.thread.id
                for opened in self._board.threads
                if opened.thread.opened_by == PERSON and opened.thread.title == REVISED_TITLE
            ),
            None,
        )
        request = PostRequest(
            kind='message', text=text, body=body, thread=thread, new_thread=None if thread else REVISED_TITLE
        )
        opens = (_open_thread(REVISED_TITLE, PERSON),) if thread is None else ()
        board = await self._commit(
            *opens,
            _add_post(request, PERSON, ()),
            lambda board, seq, at: QuestionRevised(
                seq=seq, at=at, question=question, note=note, post=board.posts[-1].post.id
            ),
        )
        return board.revisions[-1]

    async def set_alarm(self, agent_id: AgentId, minutes: float, *, quiet: bool) -> AlarmSet:
        """Record that an agent wants to be woken after its turn. Zero minutes cancels its alarm."""
        board = await self._commit(
            lambda _, seq, at: AlarmSet(seq=seq, at=at, agent=agent_id, minutes=minutes, quiet=quiet)
        )
        return board.alarms[-1]

    async def set_profile(self, agent_id: AgentId, role: str | None, status: str | None) -> tuple[str, str]:
        """
        Record what an agent says that it is and does, and return its role and status after the change.

        A call that changes nothing records nothing, so an agent can read its own profile with no arguments, and one
        that repeats its status does not fill the record.
        """
        now_role, now_status = self._board.profile(agent_id)
        wanted = (now_role if role is None else role, now_status if status is None else status)
        if self._board.agent(agent_id) and wanted == (now_role, now_status):
            return wanted
        board = await self._commit(
            lambda _, seq, at: ProfileSet(seq=seq, at=at, agent=agent_id, role=role, status=status)
        )
        return board.profile(agent_id)

    async def watch(self, agent_id: AgentId, thread_id: ThreadId, *, watching: bool) -> WatchSet:
        """Record that an agent starts or stops watching a thread."""
        board = await self._commit(
            lambda _, seq, at: WatchSet(seq=seq, at=at, agent=agent_id, thread=thread_id, watching=watching)
        )
        return board.watches[-1]

    async def request_rerun(self, by: AgentId, post_id: PostId) -> RerunRequested:
        """
        Record a request for a blind rerun of a post. The runner answers it by starting a checker.

        Raises:
            RejectedEvent: The post cannot get a rerun, or the same member has an open request for it already.

        """

        def build(board: Board, seq: int, at: datetime) -> RerunRequested:
            # A record from before this rule can hold such a pair, so the rule is here and not in the record's rules.
            if any(entry.by == by for entry in waiting_reruns(board, post_id)):
                raise RejectedEvent(f'You asked for a blind rerun of {post_id} already. Its check will come to you.')
            return RerunRequested(seq=seq, at=at, by=by, post=post_id)

        board = await self._commit(build)
        return board.reruns[-1]

    async def start_turn(
        self, agent_id: AgentId, session: str, seen: int, model: str | None = None, model_name: str | None = None
    ) -> TurnStarted:
        """
        Record that a turn of an agent starts, in the harness's conversation `session`, with what it had seen.

        `model` and `model_name` are the model that the harness reported for the session, when it reported one.
        """
        board = await self._commit(
            lambda _, seq, at: TurnStarted(
                seq=seq, at=at, agent=agent_id, session=session, seen=seen, model=model, model_name=model_name
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

    async def set_time_left(self, left: timedelta) -> None:
        """Record that the lab ends `left` from now. A `left` of zero stops the agents now."""
        await self._commit(lambda _, seq, at: TimeSet(seq=seq, at=at, ends_at=at + left))

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

    async def wait_for_change(self, after: int, timeout: float | None = None) -> None:
        """Return once the board has an event after `after`, or after `timeout` seconds when given."""
        await wait_until(self._changed, lambda: self._board.seq > after, timeout)

    async def _commit(self, *builds: Build) -> Board:
        # The condition's lock serializes changes. Each event comes from the board that it joins, so IDs and sequence
        # numbers never collide, and `apply` rejects a bad event before anything reaches the record.
        async with self._changed:
            board, events, at = self._board, [], self._clock()
            for build in builds:
                event = build(board, board.seq + 1, at)
                board = apply(board, event)
                events.append(event)
            self._record.append(*events)
            self._board = board
            self._changed.notify_all()
            return board


REVISED: Final = 'The person revised the question: '
"""How the post that tells the lab of a revision starts. The new question follows it."""

REVISED_TITLE: Final = 'The question, revised'
"""The title of the thread that holds the revisions in a lab from before the question had a thread."""


def _headline(text: str) -> str:
    # The first line with text, cut to a headline. A question can start with a separator that `splitlines` breaks
    # on and the schema's strip keeps.
    first = next((line.strip() for line in text.splitlines() if line.strip()), QUESTION_TITLE)
    return first if len(first) <= MAX_HEADLINE else f'{first[: MAX_HEADLINE - 1]}…'


def _open_thread(title: str, opened_by: AgentId, between: tuple[AgentId, ...] = ()) -> Build:
    # The author is always in its own side thread, and comes first. An agent that names itself changes nothing.
    members = tuple(dict.fromkeys((opened_by, *between))) if between else ()

    def build(board: Board, seq: int, at: datetime) -> ThreadOpened:
        thread = Thread(id=f't-{len(board.threads) + 1}', title=title, opened_by=opened_by, between=members)
        return ThreadOpened(seq=seq, at=at, thread=thread)

    return build


def _add_post(
    request: PostRequest, author: AgentId, evidence: tuple[FileEvidence, ...], question_seen: int | None = None
) -> Build:
    def build(board: Board, seq: int, at: datetime) -> Posted:
        thread_id = request.thread or board.threads[-1].thread.id
        post = request.to_post(f'p-{len(board.posts) + 1}', thread_id, author, evidence, question_seen)
        return Posted(seq=seq, at=at, post=post)

    return build
