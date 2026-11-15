import asyncio
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import psutil

from verifold.protocol.agents import Agent, ModelSpec, Power
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AgentNamed,
    CoordinatorSet,
    Event,
    LabOpened,
    OnCallSet,
    Posted,
    PowerSet,
    ProfileSet,
    QuestionRevised,
    RequestAnswered,
    RerunRequested,
    ReviewerSet,
    SettingsSet,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    WatchSet,
)
from verifold.protocol.moves import Move
from verifold.protocol.posts import Ask, Message, MoveRequest, PermissionShown, Post
from verifold.protocol.settings import ReviewerSettings, Settings
from verifold.protocol.threads import Thread
from verifold.protocol.usage import Usage
from verifold.society.board import Board
from verifold.society.fold import fold

START = datetime(2026, 11, 6, 12, tzinfo=UTC)


@dataclass
class RecordBuilder:
    """Builds a lab record one event a minute, so tests can read times from sequence numbers."""

    events: list[Event] = field(default_factory=lambda: [LabOpened(seq=1, at=START, question='Does it hold?')])

    def copy(self) -> 'RecordBuilder':
        """Return a builder with the same events, so that a test can try one more event and keep this record."""
        return RecordBuilder(events=list(self.events))

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

    def profile(self, agent_id: str, **fields: object) -> 'RecordBuilder':
        """Add a change to an agent's profile: by the agent itself, or with `by`, by the person or the coordinator."""
        seq, at = self._stamp()
        self.events.append(ProfileSet.model_validate({'seq': seq, 'at': at, 'agent': agent_id} | fields))
        return self

    def reviewer(self, agent_id: str, by: str | None = None, *, reviewer: bool = True) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(ReviewerSet(seq=seq, at=at, agent=agent_id, reviewer=reviewer, by=by or agent_id))
        return self

    def reviewer_seats(self, seats: int | None) -> 'RecordBuilder':
        """Add the person's settings with a number of reviewer seats."""
        seq, at = self._stamp()
        self.events.append(SettingsSet(seq=seq, at=at, settings=Settings(reviewers=ReviewerSettings(seats=seats))))
        return self

    def leave(self, agent_id: str, by: str | None = None, reason: str = '') -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(AgentLeft(seq=seq, at=at, agent=agent_id, by=by or agent_id, reason=reason))
        return self

    def thread(
        self,
        thread_id: str,
        opened_by: str,
        title: str = 'Subject',
        between: tuple[str, ...] = (),
        *,
        conversation: bool = False,
        for_person: bool = False,
    ) -> 'RecordBuilder':
        seq, at = self._stamp()
        thread = Thread(
            id=thread_id,
            title=title,
            opened_by=opened_by,
            between=between,
            conversation=conversation,
            for_person=for_person,
        )
        self.events.append(ThreadOpened(seq=seq, at=at, thread=thread))
        return self

    def power(self, power: Power, agent_id: str, *, on: bool = True) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(PowerSet(seq=seq, at=at, power=power, on=on, agent=agent_id))
        return self

    def request(self, post_id: str, author: str, move: Move, thread_id: str = 't-2') -> 'RecordBuilder':
        """Add a request of `author` for a move, in the conversation with the person."""
        return self.post(MoveRequest(id=post_id, thread=thread_id, author=author, text='The lab needs it.', move=move))

    def answered(
        self, request: str, *, yes: bool = True, by: str = 'person', minutes: int | None = None
    ) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(RequestAnswered(seq=seq, at=at, request=request, yes=yes, by=by, minutes=minutes))
        return self

    def permission(self, post_id: str, author: str, thread_id: str = 't-1') -> 'RecordBuilder':
        """Add a permission request of the harness of `author`, as the runner records it, with three answers."""
        shown = PermissionShown(
            kind='execute', command='./gpu train', ids=('once', 'always', 'no'), remembered=('Always allow',)
        )
        ask = Ask(
            id=post_id,
            thread=thread_id,
            author=author,
            text='Permission needed: a shell command',
            mentions=('person',),
            choices=('Allow once', 'Always allow', 'Reject'),
            request='permission',
            shown=shown,
        )
        return self.post(ask)

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

    def start(
        self,
        agent_id: str,
        seen: int,
        session: str = 'session-1',
        rang: int | None = None,
        model_name: str | None = None,
    ) -> 'RecordBuilder':
        seq, at = self._stamp()
        self.events.append(
            TurnStarted(seq=seq, at=at, agent=agent_id, session=session, seen=seen, rang=rang, model_name=model_name)
        )
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
