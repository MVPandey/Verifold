import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import AgentJoined, Event, LabOpened, Posted, RerunRequested, ThreadOpened, WatchSet
from verifold.protocol.posts import Post
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.fold import fold

START = datetime(2026, 11, 6, 12, tzinfo=UTC)


@dataclass
class RecordBuilder:
    """Builds a lab record one event a minute, so tests can read times from sequence numbers."""

    events: list[Event] = field(default_factory=lambda: [LabOpened(seq=1, at=START, question='Does it hold?')])

    def at(self, seq: int) -> datetime:
        return START + timedelta(minutes=seq - 1)

    def _stamp(self) -> tuple[int, datetime]:
        seq = len(self.events) + 1
        return seq, self.at(seq)

    def join(
        self, agent_id: str, family: str = 'anthropic', recruited_by: str | None = None, checks: str | None = None
    ) -> 'RecordBuilder':
        seq, at = self._stamp()
        agent = Agent(
            id=agent_id,
            name=agent_id.title(),
            harness='fake',
            model=ModelSpec(family=family),
            recruited_by=recruited_by,
            checks=checks,
        )
        self.events.append(AgentJoined(seq=seq, at=at, agent=agent))
        return self

    def thread(self, thread_id: str, opened_by: str) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(
            ThreadOpened(seq=seq, at=at, thread=Thread(id=thread_id, title='Subject', opened_by=opened_by))
        )
        return self

    def post(self, post: Post) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(Posted(seq=seq, at=at, post=post))
        return self

    def watch(self, agent_id: str, thread_id: str, watching: bool = True) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(WatchSet(seq=seq, at=at, agent=agent_id, thread=thread_id, watching=watching))
        return self

    def rerun(self, by: str, post_id: str) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(RerunRequested(seq=seq, at=at, by=by, post=post_id))
        return self

    def board(self) -> Board:
        return fold(self.events)


def lab() -> RecordBuilder:
    """A lab with agents `ada` and `bo` from one family, `cy` from another, and thread `t-1`."""
    return RecordBuilder().join('ada').join('bo').join('cy', family='openai').thread('t-1', opened_by='ada')


async def until(condition: Callable[[], bool], timeout: float = 20) -> None:
    """Wait until `condition` holds, or fail after `timeout` seconds."""
    async with asyncio.timeout(timeout):
        while not condition():
            await asyncio.sleep(0.02)
