import asyncio
import json
from collections.abc import Callable
from pathlib import Path

import pytest
from fakes import FAKE_HARNESS
from pydantic import TypeAdapter

from verifold.app import AgentSpec, LabConfig, run_lab
from verifold.protocol.events import AgentJoined, Event, Posted
from verifold.runner.errors import RunnerError
from verifold.society.fold import fold
from verifold.society.standing import standing

events: TypeAdapter[Event] = TypeAdapter(Event)
CATALOG = {'fake': FAKE_HARNESS}
TWO_AGENTS = (AgentSpec(harness='fake', model='small'), AgentSpec(harness='fake'))


def record(project: Path) -> list[Event]:
    path = project / '.verifold' / 'record.jsonl'
    return [events.validate_json(line) for line in path.read_text().splitlines()] if path.exists() else []


def posts(log: list[Event]) -> list[Posted]:
    return [event for event in log if isinstance(event, Posted)]


@pytest.fixture
def calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / 'calls.jsonl'
    monkeypatch.setenv('FAKE_ACP_LOG', str(path))
    return path


async def run_until(project: Path, config: LabConfig, done: Callable[[list[Event]], bool]) -> list[Event]:
    running = asyncio.create_task(run_lab(project, config, CATALOG))
    try:
        async with asyncio.timeout(60):
            while not done(record(project)):
                await asyncio.sleep(0.05)
    finally:
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
    return record(project)


async def test_agents_start_over_acp_and_post_with_their_own_identities(tmp_path: Path, calls: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()

    log = await run_until(
        project, LabConfig(question='Does it hold?', agents=TWO_AGENTS), lambda log: len(posts(log)) == 2
    )

    assert sorted((entry.post.author, entry.post.text) for entry in posts(log)) == [
        ('agent-1', 'Hello from agent-1.'),
        ('agent-2', 'Hello from agent-2.'),
    ]
    joined = [event.agent for event in log if isinstance(event, AgentJoined)]
    assert [(agent.id, agent.role, agent.model.name) for agent in joined] == [
        ('agent-1', 'Planner', 'small'),
        ('agent-2', '', None),
    ]
    starts = [json.loads(line) for line in calls.read_text().splitlines()]
    modes = {call['agent'] for call in starts if call['event'] == 'mode' and call['mode'] == 'auto'}
    assert modes == {'agent-1', 'agent-2'}
    first = next(call['text'] for call in starts if call['event'] == 'prompt' and call['agent'] == 'agent-2')
    assert first.startswith('Does it hold?\n\nYou are Agent 2 in a Verifold lab. The other agents: Agent 1 (fake).')
    assert (project / '.verifold' / 'LAB.md').read_text().startswith('# How this lab works')


async def test_a_resumed_lab_keeps_its_agents_and_the_persons_edits_to_its_norms(tmp_path: Path, calls: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    await run_until(project, LabConfig(question='Does it hold?', agents=TWO_AGENTS), lambda log: len(posts(log)) == 2)
    norms = project / '.verifold' / 'LAB.md'
    norms.write_text('# Our own rules\n')

    log = await run_until(project, LabConfig(agents=TWO_AGENTS), lambda log: len(posts(log)) == 4)

    assert sum(isinstance(event, AgentJoined) for event in log) == 2
    assert norms.read_text() == '# Our own rules\n'


async def test_without_auto_mode_the_persons_default_mode_stays(tmp_path: Path, calls: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    config = LabConfig(question='Does it hold?', agents=TWO_AGENTS[:1], auto_mode=False)

    await run_until(project, config, lambda log: len(posts(log)) == 1)

    assert all(json.loads(line)['event'] != 'mode' for line in calls.read_text().splitlines())


async def test_a_new_lab_needs_a_question(tmp_path: Path) -> None:
    with pytest.raises(RunnerError, match='Give the question'):
        await run_lab(tmp_path, LabConfig(agents=TWO_AGENTS), CATALOG)


async def test_an_unknown_harness_is_refused_before_anything_starts(tmp_path: Path) -> None:
    with pytest.raises(RunnerError, match='Unknown harness nope'):
        await run_lab(tmp_path, LabConfig(question='Q?', agents=(AgentSpec(harness='nope'),)), CATALOG)

    assert record(tmp_path) == []


async def test_a_rerun_request_starts_a_blind_checker_from_another_family(
    tmp_path: Path, calls: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    project = tmp_path / 'project'
    project.mkdir()
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    config = LabConfig(question='Is it faster?', agents=(AgentSpec(harness='fake'), AgentSpec(harness='other')))
    running = asyncio.create_task(run_lab(project, config, catalog))
    try:
        async with asyncio.timeout(60):
            while not any(isinstance(event, Posted) and event.post.kind == 'check' for event in record(project)):
                await asyncio.sleep(0.05)
    finally:
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running

    board = fold(record(project))
    result = next(entry.post for entry in board.posts if entry.post.kind == 'result')
    checker = next(entry.agent for entry in board.agents if entry.agent.checks)
    assert (checker.checks, checker.harness, checker.model.family, checker.recruited_by) == (
        result.id,
        'other',
        'other',
        'agent-1',
    )
    assert standing(board, result.id) == 'held_up'
    check = next(entry.post for entry in board.posts if entry.post.kind == 'check')
    assert check.text == 'Reran it blind: 11.8.'
    assert check.evidence[0].path == 'rerun.txt'
