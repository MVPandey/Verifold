"""
Supervises one agent.

The agent's harness owns its work. Verifold keeps the agent's ACP session open, rings a doorbell when posts for the
agent arrive after it ended its turn, and starts the harness again when its process fails.
"""

import asyncio
import time
from collections.abc import Callable
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
from verifold.runner.messages import DOORBELL, more_time_message
from verifold.runner.permissions import ask_the_person
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


class AgentLoop:
    """Keeps one agent's ACP session open until the agent fails `max_failures` times in a row or the lab stops."""

    def __init__(
        self,
        member: Member,
        setup: AgentSetup,
        settings: LoopSettings,
        done: Callable[[Board], bool] | None = None,
        activity: Activity | None = None,
    ) -> None:
        """
        Prepare to supervise an agent that joined the lab.

        `member` is the same seat that serves the agent's tool calls, so a doorbell never repeats what the agent read
        with `wait`. `done` ends the loop after a turn, as for a checker that posted its check. `activity` receives
        what the agent is doing now, for the person's view.
        """
        self._done = done
        self._activity = activity
        self._member = member
        self._lab = member.lab
        self._setup = setup
        self._settings = settings
        self._notified = self._lab.board.seq

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
                        else:
                            message = await self._news()
            # Any failure of one harness restarts that harness. It must not stop the lab's other agents.
            except Exception as error:
                # While the lab stops, the harness's cleanup can fail too. That error ends the agent and restarts nothing.
                if (task := asyncio.current_task()) and task.cancelling():
                    raise asyncio.CancelledError from error
                failures += 1
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
        agent_id = self._setup.agent.id
        try:
            commit = await snapshot(self._setup.folder, agent_id)
        except GitError:
            commit = None
        seconds = time.monotonic() - started
        await self._lab.end_turn(
            TurnSummary(agent=agent_id, seconds=seconds, usage=usage, cost_usd=cost_usd, error=error, snapshot=commit)
        )

    async def _news(self) -> str:
        """
        Wait for posts for the agent, and return the message that wakes it.

        Under `stop`, the time limit also ends the processes of an agent that waits here. That agent wakes when the
        lab gets more time, and its message says so, followed by the doorbell when posts came meanwhile.
        """
        agent_id = self._setup.agent.id
        since = self._lab.board.seq
        while True:
            board = self._lab.board
            # The record shows a stop also when the lab got more time before this wait looked.
            stopped = board.settings.jobs.at_time_limit is AtTimeLimit.STOP and any(
                isinstance(entry, TimeRanOut) and entry.seq > since for entry in board.times
            )
            posts = bool(update(board, agent_id, max(self._notified, self._member.seen)).posts)
            if posts:
                self._notified = board.seq
            if stopped and not board.out_of_time:
                message = more_time_message(board.ends_at, AtTimeLimit.STOP)
                return f'{message} {DOORBELL}' if posts else message
            if posts and not stopped:
                return DOORBELL
            await self._lab.wait_for_change(board.seq)

    async def _permission(self, request: PermissionRequest) -> str | None:
        await self._report('waiting', f'Asks you: {request.title}')
        chosen = await ask_the_person(self._member, request)
        await self._report('working')
        return chosen

    async def _step(self, title: str) -> None:
        await self._report('working', title)

    async def _report(self, state: AgentState, detail: str = '') -> None:
        if self._activity:
            await self._activity.set(self._setup.agent.id, state, detail)
