import asyncio
from collections.abc import Callable
from pathlib import Path

import pytest
from fakes import McpAgent
from pydantic import TypeAdapter

from verifold.app import AgentSpec, LabConfig, run_lab
from verifold.protocol.events import AgentJoined, Event, Posted
from verifold.runner.errors import RunnerError

events: TypeAdapter[Event] = TypeAdapter(Event)
TWO_AGENTS = (AgentSpec(harness='mcp-agent'), AgentSpec(harness='mcp-agent'))


def record(project: Path) -> list[Event]:
    path = project / '.verifold' / 'record.jsonl'
    return [events.validate_json(line) for line in path.read_text().splitlines()] if path.exists() else []


async def run_until(project: Path, config: LabConfig, done: Callable[[list[Event]], bool]) -> list[Event]:
    running = asyncio.create_task(run_lab(project, config, {'mcp-agent': McpAgent()}))
    try:
        async with asyncio.timeout(30):
            while not done(record(project)):
                await asyncio.sleep(0.05)
    finally:
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
    return record(project)


def posts(log: list[Event]) -> list[Posted]:
    return [event for event in log if isinstance(event, Posted)]


async def test_agents_join_over_mcp_with_their_own_tokens_and_post(tmp_path: Path) -> None:
    config = LabConfig(question='Does it hold?', agents=TWO_AGENTS)

    log = await run_until(tmp_path, config, lambda log: len(posts(log)) == 2)

    assert sorted((entry.post.author, entry.post.text) for entry in posts(log)) == [
        ('agent-1', 'Hello from agent-1.'),
        ('agent-2', 'Hello from agent-2.'),
    ]
    joined = [event.agent for event in log if isinstance(event, AgentJoined)]
    assert [(agent.id, agent.role) for agent in joined] == [('agent-1', 'Planner'), ('agent-2', '')]
    assert (tmp_path / '.verifold' / 'agents' / 'agent-2').is_dir()


async def test_a_lab_resumes_with_the_same_agents(tmp_path: Path) -> None:
    config = LabConfig(question='Does it hold?', agents=TWO_AGENTS)
    await run_until(tmp_path, config, lambda log: len(posts(log)) == 2)

    log = await run_until(tmp_path, LabConfig(agents=TWO_AGENTS), lambda log: len(posts(log)) == 4)

    assert sum(isinstance(event, AgentJoined) for event in log) == 2
    assert {entry.post.author for entry in posts(log)[2:]} == {'agent-1', 'agent-2'}


async def test_a_new_lab_needs_a_question(tmp_path: Path) -> None:
    with pytest.raises(RunnerError, match='Give the question'):
        await run_lab(tmp_path, LabConfig(agents=TWO_AGENTS), {'mcp-agent': McpAgent()})


async def test_an_unknown_harness_is_refused_before_anything_starts(tmp_path: Path) -> None:
    with pytest.raises(RunnerError, match='Unknown harness nope'):
        await run_lab(tmp_path, LabConfig(question='Q?', agents=(AgentSpec(harness='nope'),)), {})

    assert record(tmp_path) == []
