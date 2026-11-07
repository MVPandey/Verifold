"""What each agent is doing now. The runner writes it from the harnesses' live updates, and the app reads it."""

import asyncio
from collections.abc import Callable
from datetime import datetime

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

    async def wait_for_change(self, after: int, timeout: float) -> None:
        """Return once `version` passes `after`, or after `timeout` seconds."""
        await wait_until(self._changed, lambda: self.version > after, timeout)
