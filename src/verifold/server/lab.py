"""The service that owns one lab: its record, its board, and the callers that wait for new events."""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Self

from verifold.protocol.agents import Agent
from verifold.protocol.events import (
    AgentJoined,
    Event,
    LabOpened,
    Posted,
    RerunRequested,
    SettingsSet,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
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
from verifold.society.rules import open_reruns
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

    async def join(self, agent: Agent) -> AgentJoined:
        """Add an agent to the lab."""
        board = await self._commit(lambda _, seq, at: AgentJoined(seq=seq, at=at, agent=agent))
        return board.agents[-1]

    async def post(self, request: PostRequest, author: AgentId, evidence: tuple[FileEvidence, ...] = ()) -> Posted:
        """
        Add a post with the next free post ID. With `new_thread`, open its thread in the same step.

        Raises:
            RejectedEvent: The post breaks a rule of the record.
            pydantic.ValidationError: The request does not describe a valid post of its kind.

        """
        opens = (_open_thread(request.new_thread, author),) if request.new_thread else ()
        board = await self._commit(*opens, _add_post(request, author, evidence))
        return board.posts[-1]

    async def open_question_thread(self) -> Posted:
        """
        Open the thread that holds the person's question, with the question as its first post.

        A new lab opens it before its agents join. The agents post their plans and the lab's answer there, and every
        agent watches it. The question's first line with text is the headline, and a longer question is also the
        body.
        """
        question = self._board.opened.question
        # A question can start with a separator that `splitlines` breaks on and the schema's strip keeps.
        first = next((line.strip() for line in question.splitlines() if line.strip()), QUESTION_TITLE)
        headline = first if len(first) <= MAX_HEADLINE else f'{first[: MAX_HEADLINE - 1]}…'
        body = '' if headline == question else question
        return await self.post(PostRequest(kind='message', text=headline, body=body, new_thread=QUESTION_TITLE), PERSON)

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
            if any(entry.by == by for entry in open_reruns(board, post_id)):
                raise RejectedEvent(f'You asked for a blind rerun of {post_id} already. Its check will come to you.')
            return RerunRequested(seq=seq, at=at, by=by, post=post_id)

        board = await self._commit(build)
        return board.reruns[-1]

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


def _open_thread(title: str, opened_by: AgentId) -> Build:
    def build(board: Board, seq: int, at: datetime) -> ThreadOpened:
        thread = Thread(id=f't-{len(board.threads) + 1}', title=title, opened_by=opened_by)
        return ThreadOpened(seq=seq, at=at, thread=thread)

    return build


def _add_post(request: PostRequest, author: AgentId, evidence: tuple[FileEvidence, ...]) -> Build:
    def build(board: Board, seq: int, at: datetime) -> Posted:
        thread_id = request.thread or board.threads[-1].thread.id
        return Posted(seq=seq, at=at, post=request.to_post(f'p-{len(board.posts) + 1}', thread_id, author, evidence))

    return build
