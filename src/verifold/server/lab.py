"""The service that owns one lab: its record, its board, and the callers that wait for new events."""

import asyncio
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from typing import Self

from verifold.protocol.agents import Agent
from verifold.protocol.events import AgentJoined, Event, LabOpened, Posted, ThreadOpened
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.posts import Post
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.fold import apply, fold
from verifold.store.record_file import RecordFile

type Clock = Callable[[], datetime]


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
        Serve a record that is open, with the events that it holds.

        Raises:
            RejectedEvent: The events do not add up to a board.

        """
        self._record = record
        self._clock = clock
        self._events = list(events)
        self._board = fold(events)
        self._changed = asyncio.Condition()

    @classmethod
    def load(cls, record: RecordFile, clock: Clock = utc_now) -> Self:
        """Serve a record that holds a lab already."""
        return cls(record, record.read(), clock)

    @classmethod
    def create(cls, record: RecordFile, question: str, clock: Clock = utc_now) -> Self:
        """Open a new lab on `question` in an empty record."""
        opened = LabOpened(seq=1, at=clock(), question=question)
        record.append(opened)
        return cls(record, (opened,), clock)

    @property
    def board(self) -> Board:
        """The board after every event so far."""
        return self._board

    async def join(self, agent: Agent) -> AgentJoined:
        """Add an agent to the lab."""
        return await self._commit(lambda seq, at: AgentJoined(seq=seq, at=at, agent=agent))

    async def open_thread(self, title: str, opened_by: AgentId) -> ThreadOpened:
        """Open a thread with the next free thread ID."""
        thread_id = f't-{len(self._board.threads) + 1}'
        return await self._commit(
            lambda seq, at: ThreadOpened(seq=seq, at=at, thread=Thread(id=thread_id, title=title, opened_by=opened_by))
        )

    async def post(self, draft: Callable[[PostId], Post]) -> Posted:
        """Add the post that `draft` builds from the next free post ID."""
        post_id = f'p-{len(self._board.posts) + 1}'
        return await self._commit(lambda seq, at: Posted(seq=seq, at=at, post=draft(post_id)))

    async def events_after(self, seq: int, timeout: float) -> tuple[Event, ...]:
        """Return the events after `seq`. Wait up to `timeout` seconds for one when there are none yet."""
        async with self._changed:
            with suppress(TimeoutError):
                async with asyncio.timeout(timeout):
                    await self._changed.wait_for(lambda: self._board.seq > seq)
            return tuple(self._events[seq:])

    async def _commit[E: Event](self, build: Callable[[int, datetime], E]) -> E:
        # The condition's lock serializes changes, so IDs and sequence numbers come from the board that the event
        # joins. `apply` rejects a bad event before anything reaches the record.
        async with self._changed:
            event = build(self._board.seq + 1, self._clock())
            board = apply(self._board, event)
            self._record.append(event)
            self._board = board
            self._events.append(event)
            self._changed.notify_all()
            return event
