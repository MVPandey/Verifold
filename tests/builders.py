import asyncio
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import psutil

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AgentNamed,
    CoordinatorSet,
    Event,
    LabOpened,
    OnCallSet,
    Posted,
    QuestionRevised,
    RerunRequested,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    WatchSet,
)
from verifold.protocol.posts import Message, Post
from verifold.protocol.threads import Thread
from verifold.protocol.usage import Usage
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
        self,
        agent_id: str,
        family: str = 'anthropic',
        recruited_by: str | None = None,
        checks: str | None = None,
        harness: str = 'fake',
        name: str | None = None,
    ) -> 'RecordBuilder':
        seq, at = self._stamp()
        agent = Agent(
            id=agent_id,
            name=name or agent_id.title(),
            harness=harness,
            model=ModelSpec(family=family),
            recruited_by=recruited_by,
            checks=checks,
        )
        self.events.append(AgentJoined(seq=seq, at=at, agent=agent))
        return self

    def named(self, agent_id: str, name: str) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(AgentNamed(seq=seq, at=at, agent=agent_id, name=name))
        return self

    def on_call(self, agent_id: str, *, on_call: bool = True) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(OnCallSet(seq=seq, at=at, agent=agent_id, on_call=on_call))
        return self

    def coordinator(self, agent_id: str | None, by: str = 'person', *, free: bool = False) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(CoordinatorSet(seq=seq, at=at, agent=agent_id, by=by, open=free))
        return self

    def leave(self, agent_id: str, by: str | None = None, reason: str = '') -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(AgentLeft(seq=seq, at=at, agent=agent_id, by=by or agent_id, reason=reason))
        return self

    def thread(
        self, thread_id: str, opened_by: str, title: str = 'Subject', between: tuple[str, ...] = ()
    ) -> 'RecordBuilder':
        seq, at = self._stamp()
        thread = Thread(id=thread_id, title=title, opened_by=opened_by, between=between)
        self.events.append(ThreadOpened(seq=seq, at=at, thread=thread))
        return self

    def post(self, post: Post) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(Posted(seq=seq, at=at, post=post))
        return self

    def revise(self, question: str, post_id: str, thread_id: str = 't-1', note: str = '') -> 'RecordBuilder':
        """Add the person's revision of the question, with the post that tells the lab."""
        self.post(
            Message(id=post_id, thread=thread_id, author='person', text=f'The person revised the question: {question}')
        )
        seq, at = self._stamp()
        self.events.append(QuestionRevised(seq=seq, at=at, question=question, note=note, post=post_id))
        return self

    def watch(self, agent_id: str, thread_id: str, *, watching: bool = True) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(WatchSet(seq=seq, at=at, agent=agent_id, thread=thread_id, watching=watching))
        return self

    def rerun(self, by: str, post_id: str) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(RerunRequested(seq=seq, at=at, by=by, post=post_id))
        return self

    def turn(
        self,
        agent_id: str,
        error: str | None = None,
        *,
        rerun_failed: bool = False,
        seen: int | None = None,
        stopped: bool = False,
    ) -> 'RecordBuilder':
        seq, at = self._stamp()
        turn = TurnEnded(
            seq=seq,
            at=at,
            agent=agent_id,
            seconds=0,
            usage=Usage(),
            error=error,
            rerun_failed=rerun_failed,
            seen=seen,
            stopped=stopped,
        )
        self.events.append(turn)
        return self

    def start(self, agent_id: str, seen: int, session: str = 'session-1', rang: int | None = None) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(TurnStarted(seq=seq, at=at, agent=agent_id, session=session, seen=seen, rang=rang))
        return self

    def time_set(self, ends_at: datetime) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(TimeSet(seq=seq, at=at, ends_at=ends_at))
        return self

    def ran_out(self) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(TimeRanOut(seq=seq, at=at))
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


SLEEP = 'import time; time.sleep(60)'
"""A Python script for a process that just runs."""

IGNORES_SIGTERM = (
    'import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("ready", flush=True)\ntime.sleep(60)'
)
"""A Python script that ignores SIGTERM and prints `ready` once it does."""


def alive(pid: int) -> bool:
    """Return whether the process runs. A zombie has ended, so it doesn't count."""
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def start_orphan(environment: dict[str, str]) -> int:
    """Start a sleeping process whose parent exits at once, so it belongs to no one here, and return its ID."""
    # The job holds none of its parent's pipes, or this would wait for the job to end.
    script = (
        'import subprocess, sys\n'
        'quiet = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}\n'
        'job = subprocess.Popen(\n'
        '    [sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True, **quiet\n'
        ')\n'
        'print(job.pid)'
    )
    parent = subprocess.run([sys.executable, '-c', script], env=environment, capture_output=True, text=True, check=True)
    return int(parent.stdout)
