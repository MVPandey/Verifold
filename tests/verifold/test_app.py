import asyncio
import json
import signal
import subprocess
import sys
from collections.abc import AsyncGenerator, Iterator, Mapping
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path

import httpx2
import pytest
import uvicorn
from builders import SLEEP, alive, until
from fakes import FAKE_HARNESS
from pydantic import TypeAdapter

from verifold.app import ServeHooks, WebServer, serve
from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.app import AgentChoice, StartRequest
from verifold.protocol.events import AgentJoined, Event, Posted
from verifold.runner.environment import harness_environment
from verifold.runner.jobs import Sweep
from verifold.server.errors import LabExists, SetupRejected
from verifold.server.web import web_app
from verifold.society.fold import fold
from verifold.society.standing import standing

events: TypeAdapter[Event] = TypeAdapter(Event)
CATALOG = {'fake': FAKE_HARNESS}
TWO_AGENTS = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake', count=2, model='small'),))


def record(project: Path) -> list[Event]:
    path = project / '.verifold' / 'record.jsonl'
    return [events.validate_json(line) for line in path.read_text().splitlines()] if path.exists() else []


def posts(project: Path) -> list[Posted]:
    return [event for event in record(project) if isinstance(event, Posted)]


def calls(log: Path) -> list[dict[str, str]]:
    return [json.loads(line) for line in log.read_text().splitlines()]


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / 'calls.jsonl'
    monkeypatch.setenv('FAKE_ACP_LOG', str(path))
    return path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    path = tmp_path / 'project'
    path.mkdir()
    return path


@asynccontextmanager
async def serving(
    project: Path,
    start: StartRequest | None = None,
    catalog: Mapping[str, HarnessEntry] = CATALOG,
    sweeps: list[Sweep] | None = None,
) -> AsyncGenerator[httpx2.AsyncClient]:
    """Serve the folder, and yield a client of its app API that acts as the person. `sweeps` collects each sweep."""
    ready: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    hooks = ServeHooks(ready=ready.set_result, swept=(sweeps if sweeps is not None else []).append)
    running = asyncio.create_task(serve(project, start, catalog=catalog, hooks=hooks))
    try:
        async with asyncio.timeout(20):
            base, _, token = (await ready).partition('/#token=')
        headers = {'Authorization': f'Bearer {token}'}
        async with httpx2.AsyncClient(base_url=f'{base}/api', headers=headers) as client:
            yield client
    finally:
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running


async def test_the_person_starts_a_lab_from_the_setup_screen(
    project: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project) as client:
        before = (await client.get('/setup')).json()
        no_lab = await client.get('/lab')
        started = await client.post('/labs', json=TWO_AGENTS.model_dump(mode='json'))
        await until(lambda: len(posts(project)) == 2)
        again = await client.post('/labs', json=TWO_AGENTS.model_dump(mode='json'))

    assert before == {
        'folder': '~/project',
        'harnesses': [{'name': 'fake', 'title': 'Fake', 'family': 'test', 'available': True}],
        'question': None,
    }
    assert (no_lab.status_code, started.status_code, again.status_code) == (409, 200, 409)
    assert started.json()['question'] == 'Does it hold?'
    assert sorted((entry.post.author, entry.post.text) for entry in posts(project)) == [
        ('agent-1', 'Hello from agent-1.'),
        ('agent-2', 'Hello from agent-2.'),
    ]
    joined = [event.agent for event in record(project) if isinstance(event, AgentJoined)]
    assert [(agent.id, agent.role, agent.model.name) for agent in joined] == [
        ('agent-1', 'Planner', 'small'),
        ('agent-2', '', 'small'),
    ]
    assert {call['agent'] for call in calls(log) if call['event'] == 'mode' and call['mode'] == 'auto'} == {
        'agent-1',
        'agent-2',
    }
    first = next(call['text'] for call in calls(log) if call['event'] == 'prompt' and call['agent'] == 'agent-2')
    assert first.startswith('Does it hold?\n\nYou are Agent 2 in a Verifold lab. The other agents: Agent 1 (fake).')
    assert (project / '.verifold' / 'LAB.md').read_text().startswith('# How this lab works')


async def test_a_resumed_lab_keeps_its_agents_and_the_persons_edits_to_its_norms(project: Path, log: Path) -> None:
    async with serving(project, TWO_AGENTS):
        await until(lambda: len(posts(project)) == 2)
    norms = project / '.verifold' / 'LAB.md'
    norms.write_text('# Our own rules\n')

    async with serving(project) as client:
        await until(lambda: len(posts(project)) == 4)
        setup = (await client.get('/setup')).json()

    assert setup['question'] == 'Does it hold?'
    assert sum(isinstance(event, AgentJoined) for event in record(project)) == 2
    assert norms.read_text() == '# Our own rules\n'
    resumed = [call for call in calls(log) if call['event'] == 'mode'][2:]
    assert sorted(call['agent'] for call in resumed) == ['agent-1', 'agent-2']


async def test_without_auto_mode_the_persons_default_mode_stays_and_minutes_set_the_end(
    project: Path, log: Path
) -> None:
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake'),), auto_mode=False, minutes=30)

    async with serving(project, start):
        await until(lambda: len(posts(project)) == 1)

    assert all(call['event'] != 'mode' for call in calls(log))
    opened = fold(record(project)).opened
    assert opened.ends_at == opened.at + timedelta(minutes=30)
    assert 'The lab ends at' in next(call['text'] for call in calls(log) if call['event'] == 'prompt')


async def test_an_unknown_harness_is_refused_before_anything_is_recorded(project: Path) -> None:
    start = StartRequest(question='Q?', agents=(AgentChoice(harness='nope'),))

    with pytest.raises(ExceptionGroup) as refused:
        await serve(project, start, catalog=CATALOG)

    assert refused.group_contains(SetupRejected, match='Unknown harness nope')
    assert record(project) == []


@pytest.mark.usefixtures('log')
async def test_a_question_for_a_folder_with_a_lab_is_refused(project: Path) -> None:
    async with serving(project, TWO_AGENTS):
        await until(lambda: len(posts(project)) == 2)

    with pytest.raises(LabExists, match='Run `verifold` here to resume it'):
        await serve(project, TWO_AGENTS, catalog=CATALOG)


@pytest.mark.usefixtures('log')
async def test_a_rerun_request_starts_a_blind_checker_from_another_family(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other')))

    async with serving(project, start, catalog):
        await until(lambda: any(entry.post.kind == 'check' for entry in posts(project)), timeout=60)

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


ONE_AGENT = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake'),))


async def test_a_job_that_an_agent_starts_in_a_session_of_its_own_stops_with_the_lab(
    project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_file = tmp_path / 'job.pid'
    monkeypatch.setenv('FAKE_ACP_JOB', str(job_file))
    sweeps: list[Sweep] = []

    async with serving(project, ONE_AGENT, sweeps=sweeps):
        await until(job_file.exists)
        job = int(job_file.read_text())
        assert alive(job)

    assert not alive(job)
    assert [(found.pid, found.agent) for found in sweeps[-1].stopped] == [(job, 'agent-1')]


@pytest.fixture
def leftover(project: Path) -> Iterator[subprocess.Popen[bytes]]:
    """A process that an earlier run of the lab left, which still carries the lab's mark."""
    process = subprocess.Popen(
        [sys.executable, '-c', SLEEP], env=harness_environment(project, 'agent-1'), start_new_session=True
    )
    yield process
    if process.poll() is None:
        process.kill()
        process.wait()


async def test_serving_first_stops_what_an_earlier_run_of_the_lab_left(
    project: Path, leftover: subprocess.Popen[bytes]
) -> None:
    sweeps: list[Sweep] = []

    async with serving(project, sweeps=sweeps):
        assert leftover.poll() is not None

    assert sweeps[0].earlier_run
    assert [found.pid for found in sweeps[0].stopped] == [leftover.pid]
    assert not sweeps[-1].earlier_run


def test_the_web_server_leaves_the_stop_signals_to_verifold() -> None:
    handlers = {stop: signal.getsignal(stop) for stop in (signal.SIGINT, signal.SIGTERM)}

    with WebServer(uvicorn.Config(web_app())).capture_signals():
        assert {stop: signal.getsignal(stop) for stop in handlers} == handlers
