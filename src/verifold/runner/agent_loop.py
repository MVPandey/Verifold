"""
Supervises one agent.

The agent's harness owns its work. Verifold keeps the agent's ACP session open, rings a doorbell when posts for the
agent arrive after it ended its turn, and starts the harness again when its process fails.
"""

import asyncio
import time
from pathlib import Path

from pydantic import Field, SecretStr

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.agents import Agent
from verifold.protocol.record import Record
from verifold.protocol.usage import Usage
from verifold.runner.messages import DOORBELL
from verifold.runner.permissions import ask_the_person
from verifold.runner.session import AgentSession, Board, PermissionRequest, SessionOptions
from verifold.server.member import Member
from verifold.society.attention import update


class LoopSettings(Record):
    """How Verifold supervises the lab's agents."""

    mcp_url: str
    turn_timeout: float = Field(default=2 * 3_600, gt=0)
    """Seconds that one turn may run before Verifold cancels it."""
    idle_wait: float = Field(default=3_600, gt=0)
    """Seconds of each wait for a post while the agent's turn is over."""
    max_failures: int = Field(default=3, ge=1)
    """Failures of the harness in a row after which the agent stops."""
    retry_after: float = Field(default=30, ge=0)
    """Seconds before the first restart of a failed harness. Each later restart waits twice as long."""


class AgentSetup(Record):
    """One agent, its harness, its folder, its token, and its first message."""

    agent: Agent
    harness: HarnessEntry
    folder: Path
    token: SecretStr
    options: SessionOptions = SessionOptions()
    start: str


class AgentLoop:
    """Keeps one agent's ACP session open until the agent fails `max_failures` times in a row or the lab stops."""

    def __init__(self, member: Member, setup: AgentSetup, settings: LoopSettings) -> None:
        """
        Prepare to supervise an agent that joined the lab.

        `member` is the same seat that serves the agent's tool calls, so a doorbell never repeats what the agent read
        with `wait`.
        """
        self._member = member
        self._lab = member.lab
        self._setup = setup
        self._settings = settings
        self._notified = self._lab.board.seq

    async def run(self) -> None:
        """Run the agent until it fails too often, or until the caller cancels the loop."""
        setup = self._setup
        board = Board(url=self._settings.mcp_url, token=setup.token)
        resume: str | None = None
        message, failures = setup.start, 0
        while True:
            try:
                options = setup.options.model_copy(update={'resume': resume})
                async with AgentSession.open(setup.harness, setup.folder, board, options, self._permission) as session:
                    resume = session.id
                    while True:
                        await self._send(session, message)
                        failures = 0
                        await self._news()
                        message = DOORBELL
            # Any failure of one harness restarts that harness. It must not stop the lab's other agents.
            except Exception as error:  # noqa: BLE001
                failures += 1
                await self._lab.end_turn(setup.agent.id, 0, Usage(), None, f'{type(error).__name__}: {error}')
                if failures >= self._settings.max_failures:
                    return
                await asyncio.sleep(self._settings.retry_after * 2 ** (failures - 1))
                message = DOORBELL if resume else setup.start

    async def _send(self, session: AgentSession, message: str) -> None:
        started = time.monotonic()
        try:
            async with asyncio.timeout(self._settings.turn_timeout):
                result = await session.send(message)
        except TimeoutError:
            await session.cancel()
            error = f'The turn ran past {self._settings.turn_timeout:g} seconds and was cancelled.'
            await self._lab.end_turn(self._setup.agent.id, time.monotonic() - started, Usage(), None, error)
            return
        stopped = None if result.stop_reason == 'end_turn' else f'The harness stopped: {result.stop_reason}.'
        await self._lab.end_turn(
            self._setup.agent.id, time.monotonic() - started, result.usage, result.cost_usd, stopped
        )

    async def _news(self) -> None:
        agent_id = self._setup.agent.id
        while not update(self._lab.board, agent_id, max(self._notified, self._member.seen)).posts:
            await self._lab.wait_for_change(self._lab.board.seq, self._settings.idle_wait)
        self._notified = self._lab.board.seq

    async def _permission(self, request: PermissionRequest) -> str | None:
        return await ask_the_person(self._member, request)
