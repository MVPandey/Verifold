"""What each agent is doing now. The runner writes it from the harnesses' live updates, and the app reads it."""

import asyncio
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Literal

from verifold.protocol.app import AgentActivity, AgentState
from verifold.protocol.ids import AgentId
from verifold.server.changes import wait_until
from verifold.server.lab import utc_now


class Activity:
    """The live activity of every agent, in memory. Each change raises `version` and wakes the waiters."""

    def __init__(self, clock: Callable[[], datetime] = utc_now) -> None:
        """Start with no activity."""
        self._clock = clock
        self._by_agent: dict[AgentId, AgentActivity] = {}
        self._guests: set[AgentId] = set()
        self._changed = asyncio.Condition()
        self.version = 0

    def of(self, agent_id: AgentId) -> AgentActivity:
        """Return what an agent is doing now."""
        return self._by_agent.get(agent_id, AgentActivity())

    async def set(self, agent_id: AgentId, state: AgentState, detail: str = '') -> None:
        """Record what an agent is doing now."""
        async with self._changed:
            self._by_agent[agent_id] = AgentActivity(state=state, detail=detail[:200], at=self._clock())
            self.version += 1
            self._changed.notify_all()

    async def invite(self, agent_id: AgentId, state: Literal['invited', 'here', 'void']) -> None:
        """
        Show an agent as a guest from now on: an agent that runs by itself, which Verifold sees only in its calls.

        It is `invited` until its first call. It is `here` when the record shows that it called before, with no
        time for a call that this server did not see. It is `void` when Verifold holds no token digest for it.
        """
        async with self._changed:
            self._guests.add(agent_id)
            self._by_agent[agent_id] = AgentActivity(state=state)
            self.version += 1
            self._changed.notify_all()

    @asynccontextmanager
    async def call(self, agent_id: AgentId, tool: str) -> AsyncGenerator[None]:
        """
        Show a guest's board call while the block runs: `listening` during a `wait`, and `here` for any other call.

        A call of an agent that Verifold started changes nothing, because its harness reports what it does.
        """
        if agent_id not in self._guests:
            yield
            return
        await self.set(agent_id, 'listening' if tool == 'wait' else 'here')
        try:
            yield
        finally:
            if tool == 'wait':
                await self.set(agent_id, 'here')

    async def wait_for_change(self, after: int, timeout: float | None) -> None:
        """Return once `version` passes `after`, or after `timeout` seconds when given."""
        await wait_until(self._changed, lambda: self.version > after, timeout)
