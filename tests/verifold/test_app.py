import asyncio
import json
import os
import signal
import subprocess
import sys
from collections.abc import AsyncGenerator, Iterator, Mapping
from contextlib import asynccontextmanager, suppress
from datetime import timedelta
from pathlib import Path

import httpx2
import psutil
import pytest
import uvicorn
from builders import SLEEP, alive, start_orphan, until
from fakes import FAKE_HARNESS
from pydantic import TypeAdapter

from verifold.app import ServeHooks, WebServer, serve
from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.app import AgentChoice, StartRequest
from verifold.protocol.events import AgentJoined, Event, Posted, SettingsSet, TimeRanOut
from verifold.protocol.settings import AtExit, AtTimeLimit
from verifold.runner.environment import harness_environment
from verifold.runner.git import git
from verifold.runner.jobs import Sweep, sweep
from verifold.server.errors import LabExists, SetupRejected
from verifold.server.lab import Lab
from verifold.server.web import web_app
from verifold.society.fold import fold
from verifold.society.standing import standing
from verifold.store.record_file import RecordFile

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


async def probed_setup(client: httpx2.AsyncClient) -> dict[str, object]:
    """Return the setup view once Verifold has asked every harness what it offers."""
    while True:
        setup = (await client.get('/setup')).json()
        if not any(harness['probing'] for harness in setup['harnesses']):
            return setup
        await asyncio.sleep(0.05)


def named(*values: str) -> list[dict[str, str]]:
    return [{'value': value, 'name': value} for value in values]


async def test_the_person_starts_a_lab_from_the_setup_screen(
    project: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project) as client:
        before = await probed_setup(client)
        no_lab = await client.get('/lab')
        started = await client.post('/labs', json=TWO_AGENTS.model_dump(mode='json'))
        await until(lambda: len(posts(project)) == 2)
        again = await client.post('/labs', json=TWO_AGENTS.model_dump(mode='json'))

    assert before == {
        'folder': '~/project',
        'harnesses': [
            {
                'name': 'fake',
                'title': 'Fake',
                'family': 'test',
                'available': True,
                'probing': False,
                'offer': {
                    'models': [
                        {'value': 'default', 'name': 'default', 'efforts': named('default', 'low', 'high')},
                        {'value': 'small', 'name': 'small', 'efforts': named('default', 'low')},
                        {'value': 'small-model', 'name': 'small-model', 'efforts': []},
                    ],
                    'efforts': named('default', 'low', 'high'),
                    'modes': [{'value': 'ask', 'name': 'Ask'}, {'value': 'auto', 'name': 'Auto'}],
                    'model': 'default',
                    'effort': 'default',
                    'mode': 'ask',
                },
            }
        ],
        'question': None,
    }
    assert (no_lab.status_code, started.status_code, again.status_code) == (409, 200, 409)
    # The probe runs in the project folder, which the fake agent takes for its name.
    assert [call['event'] for call in calls(log) if call['agent'] == project.name][:1] == ['new_session']
    assert started.json()['question'] == 'Does it hold?'
    assert sorted((entry.post.author, entry.post.text) for entry in posts(project)) == [
        ('agent-1', 'Hello from agent-1.'),
        ('agent-2', 'Hello from agent-2.'),
    ]
    joined = [event.agent for event in record(project) if isinstance(event, AgentJoined)]
    assert [(agent.id, agent.role, agent.model.name) for agent in joined] == [
        ('agent-1', '', 'small'),
        ('agent-2', '', 'small'),
    ]
    assert {call['agent'] for call in calls(log) if call['event'] == 'mode' and call['mode'] == 'auto'} == {
        'agent-1',
        'agent-2',
    }
    first = next(call['text'] for call in calls(log) if call['event'] == 'prompt' and call['agent'] == 'agent-2')
    assert first.startswith('Does it hold?\n\nYou are Agent 2 in a Verifold lab. The other agents: Agent 1 (fake).')
    assert (project / '.verifold' / 'LAB.md').read_text().startswith("# The lab's norms")


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
    project: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    # The other harness's worker asks before it acts. Its checker must still follow the auto mode answer.
    start = StartRequest(
        question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other', mode='ask'))
    )

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
    modes = [(call['agent'], call['mode']) for call in calls(log) if call['event'] == 'mode']
    assert ('agent-2', 'ask') in modes
    assert [mode for agent, mode in modes if agent == checker.id] == ['auto']
    assert checker.mode is None


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


async def test_the_web_server_leaves_the_stop_signals_to_verifold() -> None:
    handlers = {stop: signal.getsignal(stop) for stop in (signal.SIGINT, signal.SIGTERM)}
    server = WebServer(uvicorn.Config(web_app(), host='127.0.0.1', port=0, log_level='warning'))
    serving = asyncio.create_task(server.serve())

    try:
        await until(lambda: server.started)
        assert {stop: signal.getsignal(stop) for stop in handlers} == handlers
    finally:
        server.should_exit = True
        await serving


def write_settings(project: Path, jobs: dict[str, str]) -> None:
    folder = project / '.verifold'
    folder.mkdir(exist_ok=True)
    (folder / 'settings.json').write_text(json.dumps({'jobs': jobs}))


def paused(pid: int) -> bool:
    return psutil.Process(pid).status() == psutil.STATUS_STOPPED


def harness_pids() -> list[int]:
    pids: list[int] = []
    for child in psutil.Process().children():
        # A child that exited and waits to be collected can't show its command line.
        with suppress(psutil.Error):
            if 'fake_acp_agent.py' in ' '.join(child.cmdline()):
                pids.append(child.pid)
    return pids


@pytest.fixture
def job_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, project: Path) -> Iterator[Path]:
    """Make the fake agent start a job in a session of its own, and stop every process of the lab after the test."""
    path = tmp_path / 'job.pid'
    monkeypatch.setenv('FAKE_ACP_JOB', str(path))
    yield path
    sweep(project, grace=1)


async def test_at_the_time_limit_the_agents_jobs_pause_and_more_time_resumes_them(
    project: Path, job_file: Path
) -> None:
    sweeps: list[Sweep] = []

    async with serving(project, ONE_AGENT, sweeps=sweeps) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: paused(job))
        assert harness_pids()
        assert not any(paused(pid) for pid in harness_pids())
        await client.post('/time', json={'minutes': 5})
        await until(lambda: not paused(job))

    assert [found.pid for found in sweeps[1].paused] == [job]


async def test_with_stop_the_time_limit_ends_the_agents_jobs_but_not_their_harnesses(
    project: Path, job_file: Path
) -> None:
    write_settings(project, {'at_time_limit': 'stop'})

    async with serving(project, ONE_AGENT) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: not alive(job))
        assert harness_pids()
        assert all(alive(pid) for pid in harness_pids())


async def test_with_finish_the_agents_jobs_run_past_the_time_limit(project: Path, job_file: Path) -> None:
    write_settings(project, {'at_time_limit': 'finish'})

    async with serving(project, ONE_AGENT) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: any(isinstance(event, TimeRanOut) for event in record(project)))
        await asyncio.sleep(0.3)
        assert alive(job)
        assert not paused(job)


@pytest.mark.parametrize('changed', ['finish', 'stop'])
async def test_a_change_while_the_lab_is_out_of_time_applies_to_its_paused_jobs_at_once(
    project: Path, job_file: Path, monkeypatch: pytest.MonkeyPatch, changed: str
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: paused(job))
        view = (await client.get('/settings')).json()
        change = {'level': 'project', 'key': 'jobs.at_time_limit', 'value': changed, 'revisions': revisions_of(view)}
        await client.post('/settings', json=change)
        if changed == 'finish':
            await until(lambda: not paused(job))
            await client.post('/time', json={'minutes': 5})
            await asyncio.sleep(0.3)
            assert alive(job)
            assert not paused(job)
        else:
            await until(lambda: not alive(job))


async def test_with_keep_the_agents_jobs_outlive_verifold_and_its_next_start(project: Path, job_file: Path) -> None:
    write_settings(project, {'at_exit': 'keep'})

    async with serving(project, ONE_AGENT):
        await until(job_file.exists)
        job = int(job_file.read_text())
    assert alive(job)

    async with serving(project):
        assert alive(job)


async def test_a_lab_follows_the_settings_from_when_it_opened(project: Path) -> None:
    write_settings(project, {'at_time_limit': 'stop'})
    async with serving(project, ONE_AGENT):
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))

    write_settings(project, {'at_time_limit': 'finish'})
    async with serving(project):
        pass

    kept = [event.settings.jobs.at_time_limit for event in record(project) if isinstance(event, SettingsSet)]
    assert kept == [AtTimeLimit.STOP]


async def test_the_persons_change_applies_to_the_running_lab_but_an_agents_edit_does_not(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        # An agent edits the project's file during the lab. Its edit stays out of the lab.
        write_settings(project, {'at_exit': 'keep'})
        before = (await client.get('/settings')).json()
        change = {
            'level': 'all',
            'key': 'jobs.at_time_limit',
            'value': 'stop',
            'revisions': revisions_of(before),
        }
        after = (await client.post('/settings', json=change)).json()
        stale = await client.post('/settings', json={**change, 'value': 'finish'})
        lab = (await client.get('/lab')).json()

    assert before['project']['values'] == {'jobs': {'at_exit': 'keep'}}
    assert before['all_projects'] == {
        'path': '~/.verifold/settings.json',
        'values': {},
        'revision': '',
        'settings': {'version': 1, 'jobs': {'at_time_limit': 'pause', 'at_exit': 'stop'}},
    }
    assert after['all_projects']['values'] == {'jobs': {'at_time_limit': 'stop'}}
    assert after['project']['settings']['jobs'] == {'at_time_limit': 'stop', 'at_exit': 'keep'}
    assert after['lab']['jobs'] == {'at_time_limit': 'stop', 'at_exit': 'stop'}
    assert lab['settings'] == after['lab']
    assert stale.status_code == 409
    kept = [event.settings.jobs for event in record(project) if isinstance(event, SettingsSet)]
    assert [(jobs.at_time_limit, jobs.at_exit) for jobs in kept] == [
        (AtTimeLimit.PAUSE, AtExit.STOP),
        (AtTimeLimit.STOP, AtExit.STOP),
    ]


def revisions_of(view: dict[str, dict[str, str]]) -> dict[str, str]:
    return {'project': view['project']['revision'], 'all_projects': view['all_projects']['revision']}


def lab_settings(project: Path) -> list[tuple[AtTimeLimit, AtExit]]:
    kept = [event.settings.jobs for event in record(project) if isinstance(event, SettingsSet)]
    return [(jobs.at_time_limit, jobs.at_exit) for jobs in kept]


async def test_a_change_for_all_projects_skips_a_lab_whose_project_has_its_own_setting(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    write_settings(project, {'at_exit': 'stop'})
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        view = (await client.get('/settings')).json()
        change = {'level': 'all', 'key': 'jobs.at_exit', 'value': 'keep', 'revisions': revisions_of(view)}
        changed = (await client.post('/settings', json=change)).json()

    assert changed['all_projects']['settings']['jobs']['at_exit'] == 'keep'
    assert changed['lab']['jobs']['at_exit'] == 'stop'
    assert lab_settings(project) == [(AtTimeLimit.PAUSE, AtExit.STOP)]


async def test_choosing_the_value_that_the_files_hold_makes_the_lab_follow_it(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        # Someone edits the file by hand. The lab keeps its copy until the person chooses the value in the app.
        write_settings(project, {'at_time_limit': 'finish'})
        view = (await client.get('/settings')).json()
        change = {'level': 'project', 'key': 'jobs.at_time_limit', 'value': 'finish', 'revisions': revisions_of(view)}
        changed = (await client.post('/settings', json=change)).json()

    assert view['lab']['jobs']['at_time_limit'] == 'pause'
    assert changed['lab']['jobs']['at_time_limit'] == 'finish'
    assert lab_settings(project) == [(AtTimeLimit.PAUSE, AtExit.STOP), (AtTimeLimit.FINISH, AtExit.STOP)]


async def test_settings_can_change_before_a_lab_starts(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    revisions = {'project': '', 'all_projects': ''}
    change = {'level': 'project', 'key': 'jobs.at_exit', 'value': 'keep', 'revisions': revisions}

    async with serving(project) as client:
        changed = (await client.post('/settings', json=change)).json()

    assert changed['lab'] is None
    assert changed['project']['settings']['jobs']['at_exit'] == 'keep'
    assert record(project) == []


async def test_a_broken_settings_file_refuses_the_start_and_leaves_no_lab(project: Path) -> None:
    async with serving(project) as client:
        (project / '.verifold' / 'settings.json').write_text('{not json')
        refused = await client.post('/labs', json={'question': 'Does it hold?', 'agents': [{'harness': 'fake'}]})

    assert refused.status_code == 400
    assert 'settings.json' in refused.json()['detail']
    assert record(project) == []


async def test_a_repository_that_tracks_lab_files_is_refused_but_its_settings_file_is_not(
    project: Path, home: Path
) -> None:
    # Verifold's own git helper drops the GIT_ variables that a Git hook sets, which would point at another repository.
    await git('init', '--quiet', cwd=project)
    write_settings(project, {'at_exit': 'keep'})
    await git('add', '.verifold/settings.json', cwd=project)
    author = ('-c', 'user.name=Someone', '-c', 'user.email=someone@example.com')
    await git(*author, 'commit', '--quiet', '-m', 'settings', cwd=project)
    async with serving(project):
        pass
    assert (home / '.verifold' / 'npx').is_dir()

    await git('add', '--force', '.verifold/record.jsonl', cwd=project)
    with pytest.raises(SetupRejected, match=r'The repository tracks \.verifold/record\.jsonl\. Verifold keeps its own'):
        await serve(project, hooks=ServeHooks(ready=lambda _: None))


async def test_a_lab_from_before_settings_takes_the_files_on_its_next_run(project: Path) -> None:
    with RecordFile(project / '.verifold' / 'record.jsonl') as file:
        Lab.create(file, 'Does it hold?')
    write_settings(project, {'at_time_limit': 'finish'})

    async with serving(project):
        pass

    kept = [event.settings.jobs.at_time_limit for event in record(project) if isinstance(event, SettingsSet)]
    assert kept == [AtTimeLimit.FINISH]


@pytest.fixture
def orphan(project: Path) -> Iterator[int]:
    """A job that an earlier run of the lab left: it carries the lab's mark, and its parent is gone."""
    pid = start_orphan(harness_environment(project, 'agent-1'))
    yield pid
    with suppress(psutil.NoSuchProcess):
        psutil.Process(pid).kill()


async def test_only_pause_resumes_jobs_so_under_stop_a_paused_job_stays_paused(project: Path, orphan: int) -> None:
    write_settings(project, {'at_time_limit': 'stop', 'at_exit': 'keep'})
    os.kill(orphan, signal.SIGSTOP)

    async with serving(project, ONE_AGENT):
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        await asyncio.sleep(0.3)
        assert paused(orphan)


async def test_under_pause_a_new_run_resumes_a_paused_job_that_keep_kept(project: Path, orphan: int) -> None:
    write_settings(project, {'at_exit': 'keep'})
    os.kill(orphan, signal.SIGSTOP)

    async with serving(project, ONE_AGENT):
        await until(lambda: not paused(orphan))


async def test_a_harness_from_the_persons_settings_shows_in_the_setup_and_runs_a_lab(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    folder = project.parent / '.verifold'
    folder.mkdir()
    entry = {'command': list(FAKE_HARNESS.command), 'family': 'local', 'title': 'Local agent'}
    (folder / 'settings.json').write_text(json.dumps({'harnesses': {'local': entry}}))
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='local'),))

    async with serving(project, catalog={}) as client:
        setup = (await client.get('/setup')).json()
        started = await client.post('/labs', json=start.model_dump(mode='json'))
        await until(lambda: len(posts(project)) == 1)

    assert [(harness['name'], harness['title'], harness['available']) for harness in setup['harnesses']] == [
        ('local', 'Local agent', True)
    ]
    assert started.status_code == 200
    assert posts(project)[0].post.author == 'agent-1'


async def test_a_mode_from_the_setup_reaches_the_agents_harness_and_its_record(project: Path, log: Path) -> None:
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake', mode='ask'),))

    async with serving(project, start):
        await until(lambda: len(posts(project)) == 1)

    joined = next(event.agent for event in record(project) if isinstance(event, AgentJoined))
    assert joined.mode == 'ask'
    assert [call['mode'] for call in calls(log) if call['event'] == 'mode' and call['agent'] == 'agent-1'] == ['ask']


async def test_a_harness_that_fails_its_probe_offers_nothing_and_stops_probing(project: Path) -> None:
    broken = FAKE_HARNESS.model_copy(
        update={'name': 'broken', 'command': (sys.executable, '-c', 'raise SystemExit(1)')}
    )

    async with serving(project, catalog={'broken': broken}) as client:
        setup = await probed_setup(client)

    assert setup['harnesses'] == [
        {'name': 'broken', 'title': 'Fake', 'family': 'test', 'available': True, 'probing': False, 'offer': None}
    ]
