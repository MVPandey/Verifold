"""Keeps one agent working: runs its turns, and wakes it when a post for it arrives."""

import asyncio
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path

from pydantic import Field, SecretStr

from verifold.harnesses.base import Harness, Turn
from verifold.protocol.agents import Agent
from verifold.protocol.join import Update
from verifold.protocol.record import Record
from verifold.runner.driver import run_turn
from verifold.runner.prompts import opening_prompt, update_prompt
from verifold.server.lab import Lab
from verifold.server.member import Member


class LoopSettings(Record):
    """How the runner treats one agent's turns."""

    mcp_url: str
    network: tuple[str, ...] = ()
    turn_timeout: float = Field(default=2 * 3_600, gt=0)
    """Seconds that one turn may run before Verifold stops it."""
    idle_wait: float = Field(default=3_600, gt=0)
    """Seconds of each wait for a post while the agent sleeps between turns."""
    max_failures: int = Field(default=3, ge=1)
    """Failed turns in a row after which the agent stops."""
    retry_after: float = Field(default=30, ge=0)
    """Seconds before the first retry of a failed turn. Each later retry waits twice as long."""


class AgentSetup(Record):
    """Who an agent is, where it works, and how its harness reaches the lab."""

    agent: Agent
    project: Path
    folder: Path
    private: Path
    """A folder that only Verifold and this agent's harness read, for config files with secrets."""
    token: SecretStr


class AgentLoop:
    """
    One agent's life in the lab.

    The agent works in long turns and calls `wait` to sleep inside a turn. When its harness ends a turn, the loop
    sleeps until a post for the agent arrives, and then resumes the same harness session with those posts.
    """

    def __init__(
        self,
        lab: Lab,
        setup: AgentSetup,
        harness: Harness,
        settings: LoopSettings,
        today: Callable[[], date] = date.today,
    ) -> None:
        """Prepare the loop of an agent that joined the lab. `today` gives the date in the opening prompt."""
        self._lab = lab
        self._setup = setup
        self._harness = harness
        self._settings = settings
        self._today = today
        self._member = Member(lab, setup.agent.id)

    async def run(self) -> None:
        """Run the agent until it fails `max_failures` turns in a row, or until the caller cancels the loop."""
        setup = self._setup
        opening = opening_prompt(self._lab.board, setup.agent, setup.folder, setup.project, self._today())
        prompt, session, failures = opening, None, 0
        while True:
            started = time.monotonic()
            report = await run_turn(self._harness, self._turn(prompt, session), self._settings.turn_timeout)
            await self._lab.end_turn(
                setup.agent.id, time.monotonic() - started, report.usage, report.cost_usd, report.error
            )
            session = report.session or session
            if report.error is None:
                failures = 0
                prompt = update_prompt(self._lab.board, await self._next_update())
                continue
            failures += 1
            if failures >= self._settings.max_failures:
                return
            await asyncio.sleep(self._settings.retry_after * 2 ** (failures - 1))
            prompt = opening if session is None else f'Your last turn stopped: {report.error}\nContinue your work.'

    def _turn(self, prompt: str, session: str | None) -> Turn:
        return Turn(
            prompt=prompt,
            folder=self._setup.folder,
            private=self._setup.private,
            mcp_url=self._settings.mcp_url,
            token=self._setup.token,
            network=self._settings.network,
            model=self._setup.agent.model.name,
            session=session,
        )

    async def _next_update(self) -> Update:
        while True:
            news = await self._member.wait(self._settings.idle_wait)
            if news.posts:
                return news
