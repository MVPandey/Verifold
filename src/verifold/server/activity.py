"""
What each agent is doing now, and which post of the person in the conversation reached it last.

The runner writes what an agent does from its harness's live updates. The seat that serves an agent's board tools
knows what they carried to the agent. The app reads both.
"""

import asyncio
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Literal

from verifold.protocol.app import AgentActivity, AgentState, Heard, WaitsFor
from verifold.protocol.ids import AgentId
from verifold.server.changes import wait_until
from verifold.server.lab import utc_now
from verifold.server.member import Member


class Activity:
    """The live activity of every agent, in memory. Each change raises `version` and wakes the waiters."""

    def __init__(self, clock: Callable[[], datetime] = utc_now) -> None:
        """Start with no activity."""
        self._clock = clock
        self._by_agent: dict[AgentId, AgentActivity] = {}
        self._guests: set[AgentId] = set()
        self._seats: dict[AgentId, Member] = {}
        self._changed = asyncio.Condition()
        self.version = 0

    def of(self, agent_id: AgentId) -> AgentActivity:
        """Return what an agent is doing now."""
        return self._by_agent.get(agent_id, AgentActivity())

    def shown(self, agent_id: AgentId) -> AgentActivity:
        """
        Return what the app shows that an agent is doing now.

        An agent that nothing reported for is idle: no loop runs it. So `starting` shows only for an agent whose
        harness Verifold starts now, and every part of the app reads the same state.
        """
        return self._by_agent.get(agent_id, AgentActivity(state='idle'))

    def seat(self, member: Member) -> None:
        """Take the seat that serves an agent's board tools from now on. It replaces an earlier seat of the agent."""
        self._seats[member.agent_id] = member

    def heard(self, agent_id: AgentId) -> Heard | None:
        """Return the person's newest post in the conversation that an agent's board tools carried to it, or `None`."""
        seat = self._seats.get(agent_id)
        return seat.heard if seat else None

    async def set(
        self, agent_id: AgentId, state: AgentState, detail: str = '', waits_for: WaitsFor | None = None
    ) -> None:
        """Record what an agent is doing now. `waits_for` says what an agent in the state `waiting` waits for."""
        async with self._changed:
            self._by_agent[agent_id] = AgentActivity(
                state=state, detail=detail[:200], at=self._clock(), waits_for=waits_for
            )
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

        A call of an agent that Verifold started changes no state, because its harness reports what it does. A
        call that carried a post of the person to its agent is a change, whoever started the agent.
        """
        guest, heard = agent_id in self._guests, self.heard(agent_id)
        if guest:
            await self.set(agent_id, 'listening' if tool == 'wait' else 'here')
        try:
            yield
        finally:
            if guest and tool == 'wait':
                await self.set(agent_id, 'here')
            elif self.heard(agent_id) != heard:
                async with self._changed:
                    self.version += 1
                    self._changed.notify_all()

    async def wait_for_change(self, after: int, timeout: float | None) -> None:
        """Return once `version` passes `after`, or after `timeout` seconds when given."""
        await wait_until(self._changed, lambda: self.version > after, timeout)
