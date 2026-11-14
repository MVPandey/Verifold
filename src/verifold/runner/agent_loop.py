"""
Supervises one agent.

The agent's harness owns its work. Verifold keeps the agent's ACP session open, rings a doorbell when posts for the
agent arrive after it ended its turn, tells the agent when the whole lab went quiet, and starts the harness again when
its process fails. The doorbell waits for a quiet moment on the board, so that a burst of posts wakes the agent once.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from pydantic import Field, SecretStr

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.agents import Agent
from verifold.protocol.app import AgentState
from verifold.protocol.events import TimeRanOut, TurnSummary
from verifold.protocol.record import Record
from verifold.protocol.settings import AtTimeLimit
from verifold.protocol.usage import Usage
from verifold.runner.git import GitError
from verifold.runner.messages import DOORBELL, JOBS_ENDED, more_time_message, quiet_message
from verifold.runner.permissions import GrantAsks, ask_the_person, refusal, settled
from verifold.runner.session import (
    AgentSession,
    BoardAccess,
    PermissionRequest,
    Place,
    SessionHooks,
    SessionOptions,
)
from verifold.runner.snapshots import snapshot
from verifold.server.activity import Activity
from verifold.server.member import Member
from verifold.society.attention import update
from verifold.society.board import Board


class LoopSettings(Record):
    """How Verifold supervises the lab's agents."""

    mcp_url: str
    turn_timeout: float = Field(default=2 * 3_600, gt=0)
    """Seconds that one turn may run before Verifold cancels it."""
    max_failures: int = Field(default=3, ge=1)
    """How many harness failures in a row stop the agent."""
    retry_after: float = Field(default=30, ge=0)
    """Seconds before the first restart of a failed harness. Each later restart waits twice as long."""
    quiet: float = Field(default=10, ge=0)
    """Seconds without a new event on the board before a doorbell rings, so that one doorbell covers a burst."""
    max_quiet: float = Field(default=45, ge=0)
    """The most seconds that a doorbell waits for the board to go quiet."""
    lull: float = Field(default=90, ge=0)
    """Seconds without a turn or an event before Verifold tells the agents that the lab is quiet. Zero: never."""
    job_poll: float = Field(default=5, gt=0)
    """Seconds between two looks at the processes that an agent with one job left running."""
    job_wait: float = Field(default=3_600, gt=0)
    """The most seconds that the loop of an agent with one job waits for those processes before it ends."""


class AgentSetup(Record):
    """One agent, its harness, its folder, its token, and its first message."""

    agent: Agent
    harness: HarnessEntry
    lab: Path
    """The lab's folder, which marks every process of the agent's harness."""
    folder: Path
    log: Path
    """The file that receives the harness's error output."""
    token: SecretStr
    options: SessionOptions = SessionOptions()
    start: str


@dataclass(frozen=True, slots=True)
class Shared:
    """What the agent loops of one lab share."""

    activity: Activity | None = None
    """Receives what each agent is doing now, for the person's view."""
    grant_asks: GrantAsks | None = None
    """With it, a lab in auto mode refuses a command that no grant covers and asks the person for the grant."""
    has_jobs: Callable[[str], Awaitable[bool]] | None = None
    """Says whether an agent has processes of its own that still run. Without it, no loop waits for them."""


class AgentLoop:
    """Keeps one agent's ACP session open until the agent fails `max_failures` times in a row or the lab stops."""

    def __init__(
        self,
        member: Member,
        setup: AgentSetup,
        settings: LoopSettings,
        done: Callable[[Board], bool] | None = None,
        shared: Shared | None = None,
    ) -> None:
        """
        Prepare to supervise an agent that joined the lab.

        `member` is the same seat that serves the agent's tool calls, so a doorbell never repeats what the agent read
        with `wait`. `done` says whether the agent's one job is done, as for a checker that posted its check. The
        loop of an agent with one job ends when the job is done. It also ends when the agent ends a turn without the
        job and leaves no process running, or one that runs past `job_wait`, because nothing else wakes that agent. `shared` holds what the lab's loops
        share.
        """
        shared = shared or Shared()
        self._grant_asks = shared.grant_asks
        self._has_jobs = shared.has_jobs
        self._done = done
        self._activity = shared.activity
        self._member = member
        self._lab = member.lab
        self._setup = setup
        self._settings = settings
        self._notified = self._lab.board.seq
        self._seen_at_turn = member.seen
        """What the agent had seen when its turn started. A failed turn takes the agent back to it."""
        self._turn_ended = self._lab.board.seq
        """The board's sequence number when the agent's last turn ended. A stop after it concerns the agent's jobs."""

    async def run(self) -> None:
        """Run the agent until it fails too often, or until the caller cancels the loop."""
        try:
            await self._run()
        finally:
            await self._report('stopped')

    async def _run(self) -> None:
        setup = self._setup
        hooks = SessionHooks(permissions=self._permission, step=self._step)
        board = BoardAccess(url=self._settings.mcp_url, token=setup.token)
        resume: str | None = None
        message, failures = setup.start, 0
        while True:
            try:
                options = setup.options.model_copy(update={'resume': resume})
                place = Place(folder=setup.folder, log=setup.log, lab=setup.lab, agent=setup.agent.id)
                async with AgentSession.open(setup.harness, place, board, options, hooks) as session:
                    resume = session.id
                    while True:
                        await self._while_out_of_time()
                        stopped = await self._send(session, message)
                        failures = 0
                        if self._done and self._done(self._lab.board):
                            return
                        if stopped:
                            await self._while_out_of_time()
                            current = self._lab.board
                            message = more_time_message(current.ends_at, current.settings.jobs.at_time_limit)
                        elif self._done:
                            # No post wakes a blind checker. One that waits for its own rerun wakes when the rerun
                            # ends. One that left nothing running would wait for ever, so its loop ends.
                            if not await self._jobs_ended():
                                return
                            await self._while_out_of_time()
                            message = (
                                more_time_message(self._lab.board.ends_at, AtTimeLimit.STOP)
                                if self._jobs_stopped(self._lab.board)
                                else JOBS_ENDED
                            )
                        else:
                            message = await self._news()
            # Any failure of one harness restarts that harness. It must not stop the lab's other agents.
            except Exception as error:
                # While the lab stops, the harness's cleanup can fail too. That error ends the agent and restarts nothing.
                if (task := asyncio.current_task()) and task.cancelling():
                    raise asyncio.CancelledError from error
                failures += 1
                # The failed turn can have lost the tool results that carried its news.
                self._member.rewind(self._seen_at_turn)
                failed = TurnSummary(
                    agent=setup.agent.id, seconds=0, usage=Usage(), error=f'{type(error).__name__}: {error}'
                )
                await self._lab.end_turn(failed)
                if failures >= self._settings.max_failures:
                    return
                await asyncio.sleep(self._settings.retry_after * 2 ** (failures - 1))
                message = DOORBELL if resume else setup.start

    async def _send(self, session: AgentSession, message: str) -> bool:
        # Return whether the turn stopped because the lab ran out of time.
        await self._report('working')
        started = time.monotonic()
        self._seen_at_turn = self._member.seen
        try:
            async with asyncio.timeout(self._settings.turn_timeout) as limit:
                stopper = asyncio.create_task(self._stop_when_out_of_time(limit))
                try:
                    result = await session.send(message)
                finally:
                    stopper.cancel()
        except TimeoutError:
            await session.cancel()
            out_of_time = self._lab.board.out_of_time
            error = (
                'The lab ran out of time, so Verifold cancelled the turn.'
                if out_of_time
                else f'The turn ran past {self._settings.turn_timeout:g} seconds and was cancelled.'
            )
            await self._record(started, Usage(), None, error)
            if not out_of_time:
                await self._report('idle')
            return out_of_time
        stopped = None if result.stop_reason == 'end_turn' else f'The harness stopped: {result.stop_reason}.'
        await self._record(started, result.usage, result.cost_usd, stopped)
        await self._report('idle')
        return False

    async def _stop_when_out_of_time(self, limit: asyncio.Timeout) -> None:
        lab = self._lab
        while not lab.board.out_of_time:
            await lab.wait_for_change(lab.board.seq)
        limit.reschedule(asyncio.get_running_loop().time())

    async def _while_out_of_time(self) -> None:
        lab = self._lab
        if not lab.board.out_of_time:
            return
        await self._report('waiting', 'The lab is out of time. The person can give it more.')
        while lab.board.out_of_time:
            await lab.wait_for_change(lab.board.seq)

    async def _record(self, started: float, usage: Usage, cost_usd: float | None, error: str | None) -> None:
        # Mark the end of the turn before the snapshot, which can take seconds in a large folder.
        self._turn_ended = self._lab.board.seq
        agent_id = self._setup.agent.id
        try:
            commit = await snapshot(self._setup.folder, agent_id)
        except GitError:
            commit = None
        seconds = time.monotonic() - started
        await self._lab.end_turn(
            TurnSummary(agent=agent_id, seconds=seconds, usage=usage, cost_usd=cost_usd, error=error, snapshot=commit)
        )

    async def _jobs_ended(self) -> bool:
        # Wait until the processes that the agent left running end. Return False when it left none, and when they
        # still run after `job_wait` seconds, so a process that never ends does not hold the agent's place.
        if self._has_jobs is None:
            return False
        agent_id = self._setup.agent.id
        waited = False
        try:
            async with asyncio.timeout(self._settings.job_wait):
                while await self._has_jobs(agent_id):
                    if not waited:
                        await self._report('waiting', 'Waits for a process that it left running.')
                        waited = True
                    await asyncio.sleep(self._settings.job_poll)
        except TimeoutError:
            return False
        return waited

    def _jobs_stopped(self, board: Board) -> bool:
        # Whether the time limit stopped the agent's processes after its last turn. The record shows a stop also
        # when the lab got more time before this look.
        return board.settings.jobs.at_time_limit is AtTimeLimit.STOP and any(
            isinstance(entry, TimeRanOut) and entry.seq > self._turn_ended for entry in board.times
        )

    async def _news(self) -> str:
        """
        Wait for posts for the agent, and return the message that wakes it.

        Under `stop`, the time limit also ends the processes of an agent that waits here. That agent wakes when the
        lab gets more time, and its message says so, followed by the doorbell when posts came meanwhile.
        """
        agent_id = self._setup.agent.id
        # An agent that read one page of its posts in its turn gets a doorbell for the rest. An agent that read
        # nothing gets no second doorbell for the same posts.
        if self._member.seen > self._seen_at_turn:
            self._notified = min(self._notified, self._member.seen)
        settled = False
        while True:
            board = self._lab.board
            stopped = self._jobs_stopped(board)
            posts = bool(update(board, agent_id, max(self._notified, self._member.seen)).posts)
            # A post during a stop waits for the wake after more time, so the doorbell rings then.
            if stopped and not board.out_of_time:
                if posts:
                    self._notified = board.seq
                message = more_time_message(board.ends_at, AtTimeLimit.STOP)
                return f'{message} {DOORBELL}' if posts else message
            if posts and not stopped:
                if not settled:
                    await self._settle()
                    settled = True
                    continue
                self._notified = board.seq
                return DOORBELL
            # The lab went quiet after this agent's last turn. The agent hears it once, because its next turn ends later.
            if board.quiet and board.quiet.seq > self._turn_ended and not stopped and not board.out_of_time:
                return quiet_message(board.quiet, board.ends_at)
            await self._lab.wait_for_change(board.seq)

    async def _settle(self) -> None:
        # Wait until the board has no new event for `quiet` seconds, and for `max_quiet` seconds at most.
        lab, settings = self._lab, self._settings
        loop = asyncio.get_running_loop()
        deadline = loop.time() + settings.max_quiet
        while (left := deadline - loop.time()) > 0:
            seq = lab.board.seq
            await lab.wait_for_change(seq, min(settings.quiet, left))
            if lab.board.seq == seq:
                return

    async def _permission(self, request: PermissionRequest) -> str | None:
        board = self._lab.board
        if allowed := settled(board, request):
            return allowed
        if self._grant_asks and board.opened.auto_mode and request.command:
            await self._grant_asks.offer(self._member, request)
            return refusal(request)
        await self._report('waiting', f'Asks you: {request.title}')
        chosen = await ask_the_person(self._member, request)
        await self._report('working')
        return chosen

    async def _step(self, title: str) -> None:
        await self._report('working', title)

    async def _report(self, state: AgentState, detail: str = '') -> None:
        if self._activity:
            await self._activity.set(self._setup.agent.id, state, detail)
