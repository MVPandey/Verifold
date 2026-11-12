import asyncio
import errno
import io
import json
import os
import signal
import subprocess
import sys
from collections.abc import Iterator
from importlib.metadata import version
from pathlib import Path
from typing import override

import psutil
import pytest
from builders import IGNORES_SIGTERM, SLEEP, alive, until
from fakes import FAKE_HARNESS

from verifold import DISTRIBUTION
from verifold.app import ServeHooks, serve
from verifold.cli import _until_stopped, main
from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.agents import AgentChoice
from verifold.protocol.app import StartRequest
from verifold.runner.environment import harness_environment
from verifold.runner.jobs import Job, Sweep
from verifold.server.errors import LabExists, SetupRejected
from verifold.store.record_file import RecordFile
from verifold.store.server_file import ServerProcess


def test_version_prints_the_installed_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(['--version'])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out == f'verifold {version(DISTRIBUTION)}\n'


@pytest.fixture(autouse=True)
def opened(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record the links that the command opens in a browser, instead of opening them."""
    links: list[str] = []
    monkeypatch.setattr('verifold.cli.webbrowser.open', links.append)
    return links


@pytest.fixture
def serves(monkeypatch: pytest.MonkeyPatch) -> list[StartRequest | None]:
    """Replace the server with a stand-in that records the start request it gets."""
    starts: list[StartRequest | None] = []

    async def serve(project: Path, start: StartRequest | None = None, hooks: ServeHooks | None = None) -> None:
        assert project == Path.cwd()
        assert hooks is not None
        hooks.ready('http://127.0.0.1:1234/#token=abc')
        starts.append(start)

    monkeypatch.setattr('verifold.cli.serve', serve)
    return starts


def test_no_command_serves_the_folder_prints_the_link_and_opens_it(
    serves: list[StartRequest | None], opened: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    main([])

    assert serves == [None]
    assert 'Open the lab: http://127.0.0.1:1234/#token=abc' in capsys.readouterr().out
    assert opened == ['http://127.0.0.1:1234/#token=abc']


@pytest.mark.usefixtures('serves', 'project')
@pytest.mark.parametrize('argv', [['--no-browser'], ['--no-browser', 'run', 'Q?'], ['run', 'Q?', '--no-browser']])
def test_no_browser_only_prints_the_link(argv: list[str], opened: list[str]) -> None:
    main(argv)

    assert opened == []


@pytest.mark.usefixtures('project')
def test_run_starts_a_lab_with_the_given_agents(serves: list[StartRequest | None]) -> None:
    main(['run', 'Does it hold?', '--agent', 'claude-code:opus', '--agent', 'codex::low', '--agent', 'codex:::plan'])

    assert serves == [
        StartRequest(
            question='Does it hold?',
            agents=(
                AgentChoice(harness='claude-code', model='opus'),
                AgentChoice(harness='codex', effort='low'),
                AgentChoice(harness='codex', mode='plan'),
            ),
        )
    ]


def test_run_takes_grants_for_every_agent(serves: list[StartRequest | None]) -> None:
    main(['run', 'Does it hold?', '--agent', 'codex', '--allow', './gpu', '--allow', 'make test'])

    assert serves[0] is not None
    assert serves[0].allow == ('./gpu', 'make test')


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Run in a project folder of its own, with a home folder of its own, so that no real settings apply."""
    folder = tmp_path / 'project'
    (folder / '.verifold').mkdir(parents=True)
    monkeypatch.chdir(folder)
    monkeypatch.setenv('HOME', str(tmp_path / 'home'))
    installed(monkeypatch, 'claude-code', 'codex')
    return folder


def installed(monkeypatch: pytest.MonkeyPatch, *names: str) -> None:
    """Make the harnesses `names` the ones that this computer has."""

    def found(entry: HarnessEntry) -> bool:
        return entry.name in names

    monkeypatch.setattr('verifold.cli.available', found)


def global_settings(project: Path, data: object) -> None:
    folder = project.parent / 'home' / '.verifold'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'settings.json').write_text(json.dumps(data))


def project_settings(project: Path, data: object) -> None:
    (project / '.verifold' / 'settings.json').write_text(json.dumps(data))


@pytest.mark.usefixtures('project')
def test_run_defaults_to_one_agent_of_each_harness_and_ask_me_turns_auto_mode_off(
    serves: list[StartRequest | None],
) -> None:
    main(['run', 'Does it hold?', '--ask-me', '--minutes', '90'])

    agents = (AgentChoice(harness='claude-code'), AgentChoice(harness='codex'))
    assert serves == [StartRequest(question='Does it hold?', agents=agents, auto_mode=False, minutes=90)]


def test_run_fills_in_the_saved_choices_for_new_labs_and_the_command_line_wins(
    serves: list[StartRequest | None], project: Path
) -> None:
    saved = {'agents': [{'harness': 'codex', 'count': 2, 'model': 'mini'}], 'auto_mode': False, 'minutes': 45}
    (project / '.verifold' / 'settings.json').write_text(json.dumps({'setup': saved}))

    main(['run', 'Does it hold?'])
    main(['run', 'Does it hold?', '--agent', 'claude-code', '--minutes', '10'])

    choice = AgentChoice(harness='codex', count=2, model='mini')
    claude = AgentChoice(harness='claude-code')
    assert serves == [
        StartRequest(question='Does it hold?', agents=(choice,), auto_mode=False, minutes=45),
        StartRequest(question='Does it hold?', agents=(claude,), auto_mode=False, minutes=10),
    ]


def test_a_projects_saved_choices_make_run_stricter_but_never_looser(
    serves: list[StartRequest | None], project: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    global_settings(project, {'setup': {'auto_mode': False, 'minutes': 60}})
    agents = [{'harness': 'claude-code', 'count': 2, 'model': 'opus', 'mode': 'bypassPermissions'}]
    project_settings(project, {'setup': {'agents': agents, 'auto_mode': True, 'minutes': None}})

    main(['run', 'Does it hold?'])

    # The project's agent loses its mode, and the project can't turn auto mode on or drop the time limit.
    choice = AgentChoice(harness='claude-code', count=2, model='opus')
    assert serves == [StartRequest(question='Does it hold?', agents=(choice,), auto_mode=False, minutes=60)]
    printed = capsys.readouterr().out
    assert 'Started a lab with 2 claude-code (opus); no auto mode; a time limit of 60 min.' in printed
    assert printed.index('Started a lab') < printed.index('Open the lab')


def test_saved_modes_come_only_from_the_file_for_all_projects_and_not_under_ask_me(
    serves: list[StartRequest | None], project: Path
) -> None:
    global_settings(project, {'setup': {'agents': [{'harness': 'codex', 'mode': 'read-only'}], 'minutes': 30}})
    project_settings(project, {'setup': {'minutes': 90}})

    main(['run', 'Does it hold?'])
    main(['run', 'Does it hold?', '--ask-me'])

    assert [start.agents for start in serves if start] == [
        (AgentChoice(harness='codex', mode='read-only'),),
        (AgentChoice(harness='codex'),),
    ]
    assert [start.minutes for start in serves if start] == [30, 30]


def test_in_the_home_folder_run_keeps_the_persons_own_saved_modes(
    serves: list[StartRequest | None], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / 'home'
    (home / '.verifold').mkdir(parents=True)
    (home / '.verifold' / 'settings.json').write_text(
        json.dumps({'setup': {'agents': [{'harness': 'codex', 'mode': 'plan'}]}})
    )
    monkeypatch.setenv('HOME', str(home))
    monkeypatch.chdir(home)
    installed(monkeypatch, 'codex')

    main(['run', 'Does it hold?'])

    assert serves == [StartRequest(question='Does it hold?', agents=(AgentChoice(harness='codex', mode='plan'),))]


def test_run_without_saved_agents_starts_at_most_twenty_harnesses(
    serves: list[StartRequest | None], project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harnesses = {f'h{number:02}': {'command': [f'h{number:02}'], 'family': 'test'} for number in range(25)}
    global_settings(project, {'harnesses': harnesses})
    installed(monkeypatch, *harnesses)

    main(['run', 'Does it hold?'])

    started = serves[0]
    assert started is not None
    assert [choice.harness for choice in started.agents] == [f'h{number:02}' for number in range(20)]


def test_run_skips_a_saved_harness_that_this_computer_lacks(
    serves: list[StartRequest | None],
    project: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    installed(monkeypatch, 'claude-code')
    global_settings(project, {'setup': {'agents': [{'harness': 'codex', 'count': 3}, {'harness': 'gone'}]}})

    main(['run', 'Does it hold?'])

    # Nothing saved is left, so the lab starts one agent of each harness that this computer has.
    assert serves == [StartRequest(question='Does it hold?', agents=(AgentChoice(harness='claude-code'),))]
    printed = capsys.readouterr().out
    assert 'Skipped codex from your saved choices for new labs: it is not on this computer.' in printed
    assert 'Skipped gone from your saved choices' in printed


@pytest.mark.usefixtures('project')
def test_run_without_any_harness_on_this_computer_exits_and_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    installed(monkeypatch)

    with pytest.raises(SystemExit, match=r'verifold: No harness that Verifold knows is on this computer: claude-code'):
        main(['run', 'Does it hold?'])


def test_run_with_a_broken_settings_file_exits_with_its_error(project: Path) -> None:
    (project / '.verifold' / 'settings.json').write_text('{not json')

    with pytest.raises(SystemExit, match=r'verifold: .*settings\.json is not valid settings'):
        main(['run', 'Does it hold?'])


def stand_in(monkeypatch: pytest.MonkeyPatch, error: BaseException) -> None:
    async def serve(*_: object, **__: object) -> None:
        raise error

    monkeypatch.setattr('verifold.cli.serve', serve)


@pytest.mark.parametrize(
    'error',
    [
        LabExists('This folder has a lab already.'),
        ExceptionGroup('unhandled errors in a TaskGroup', [SetupRejected('Unknown harness nope.')]),
    ],
)
def test_a_known_error_exits_with_its_message(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    stand_in(monkeypatch, error)

    with pytest.raises(SystemExit, match=r'verifold: (This folder has a lab already|Unknown harness nope)\.'):
        main([])


@pytest.mark.usefixtures('project')
def test_an_invalid_option_exits_with_its_message() -> None:
    with pytest.raises(SystemExit, match='verifold: 1 validation error for StartRequest'):
        main(['run', 'Does it hold?', '--minutes', '0'])


def test_an_unknown_error_in_a_group_is_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    stand_in(monkeypatch, ExceptionGroup('unhandled errors in a TaskGroup', [ValueError('bug')]))

    with pytest.raises(ExceptionGroup):
        main([])


@pytest.fixture
def default_sigint() -> Iterator[None]:
    """Give the test Python's own Ctrl+C handler, as a new `verifold` process has."""
    # pytest-asyncio can leave the SIGINT handler of an earlier test's event loop in place.
    previous = signal.signal(signal.SIGINT, signal.default_int_handler)
    yield
    signal.signal(signal.SIGINT, previous)


@pytest.mark.usefixtures('default_sigint')
@pytest.mark.parametrize('stop', [signal.SIGINT, signal.SIGTERM, signal.SIGHUP])
def test_ctrl_c_sigterm_and_a_closed_terminal_stop_the_server_after_its_cleanup(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], stop: signal.Signals
) -> None:
    cancelled: list[bool] = []

    async def serve(*_: object, **__: object) -> None:
        os.kill(os.getpid(), stop)
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr('verifold.cli.serve', serve)

    main([])

    assert cancelled == [True]
    assert 'Stopped.' in capsys.readouterr().out


@pytest.mark.usefixtures('default_sigint')
def test_a_second_ctrl_c_does_not_cut_the_cleanup_short(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cleaned: list[bool] = []

    async def serve(*_: object, **__: object) -> None:
        os.kill(os.getpid(), signal.SIGINT)
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            os.kill(os.getpid(), signal.SIGINT)
            # A second cancel would end this cleanup early.
            await asyncio.sleep(0.2)
            cleaned.append(True)
            raise

    monkeypatch.setattr('verifold.cli.serve', serve)

    main([])

    assert cleaned == [True]
    assert capsys.readouterr().out.count('Stopping the agents') == 1


async def test_ctrl_c_stops_the_agents_and_a_job_that_left_their_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    job_file = tmp_path / 'job.pid'
    monkeypatch.setenv('FAKE_ACP_JOB', str(job_file))
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake'),))

    async def ctrl_c_once_the_job_runs() -> None:
        await until(job_file.exists)
        os.kill(os.getpid(), signal.SIGINT)

    pressing = asyncio.create_task(ctrl_c_once_the_job_runs())
    async with asyncio.timeout(30):
        await _until_stopped(serve(project, start, catalog={'fake': FAKE_HARNESS}))
    await pressing

    assert not alive(int(job_file.read_text()))


def test_the_command_reports_what_each_sweep_did(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def serve(*_: object, hooks: ServeHooks, **__: object) -> None:
        hooks.swept(Sweep(stopped=(Job(pid=11, agent='agent-1', command='python old.py'),), earlier_run=True))
        hooks.swept(Sweep(paused=(Job(pid=10, agent='agent-3', command='python train.py'),)))
        hooks.swept(
            Sweep(
                stopped=(Job(pid=12, agent=None, command='sleep 60'),),
                survived=(Job(pid=13, agent='agent-2', command='stubborn'),),
                unmarked=(Job(pid=14, agent='agent-2', command='zsh'),),
            )
        )

    monkeypatch.setattr('verifold.cli.serve', serve)

    main([])

    out = capsys.readouterr().out
    assert "Paused agent-3's process until the lab gets more time: python train.py (10)" in out
    assert "Stopped agent-1's process from an earlier run: python old.py (11)" in out
    assert "Stopped an agent's process: sleep 60 (12)" in out
    assert "Couldn't stop agent-2's process: stubborn (13). Run `kill -9 13`." in out
    assert "Left running in agent-2's folder, as it may not be the lab's: zsh (14)" in out


def test_stop_says_when_nothing_of_the_lab_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)

    main(['stop'])

    assert "Nothing of this folder's lab was running." in capsys.readouterr().out


@pytest.fixture
def lab_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Work in a project with a lab, and return its lab folder."""
    monkeypatch.chdir(tmp_path)
    folder = Path.cwd() / '.verifold'
    folder.mkdir()
    (folder / 'record.jsonl').touch()
    return folder


@pytest.fixture
def started() -> Iterator[list[subprocess.Popen[bytes]]]:
    """Collect the processes that a test starts, and kill the ones that still run after it."""
    processes: list[subprocess.Popen[bytes]] = []
    yield processes
    for process in processes:
        if process.poll() is None:
            process.kill()
            process.wait()


def named_server(lab_folder: Path, started: list[subprocess.Popen[bytes]], script: str) -> subprocess.Popen[bytes]:
    """Start a stand-in for a server, and name it in the lab's server file."""
    server = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE)
    started.append(server)
    named = ServerProcess(pid=server.pid, started=psutil.Process(server.pid).create_time())
    (lab_folder / 'server.json').write_text(named.model_dump_json())
    return server


def test_stop_ends_a_paused_server_and_then_the_processes_of_its_agents(
    lab_folder: Path, started: list[subprocess.Popen[bytes]], capsys: pytest.CaptureFixture[str]
) -> None:
    server = named_server(lab_folder, started, SLEEP)
    server.send_signal(signal.SIGSTOP)
    job = subprocess.Popen(
        [sys.executable, '-c', SLEEP], env=harness_environment(Path.cwd(), 'agent-1'), start_new_session=True
    )
    started.append(job)

    main(['stop'])

    assert server.poll() is not None
    assert job.poll() is not None
    out = capsys.readouterr().out
    assert f"Stopped the Verifold server ({server.pid}) that served this folder's lab." in out
    assert f"Stopped agent-1's process: {sys.executable} -c {SLEEP} ({job.pid})" in out


def test_stop_kills_a_server_that_ignores_sigterm(
    lab_folder: Path,
    started: list[subprocess.Popen[bytes]],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr('verifold.app.SERVER_STOP_GRACE', 0.3)
    server = named_server(lab_folder, started, IGNORES_SIGTERM)
    assert server.stdout is not None
    assert server.stdout.readline() == b'ready\n'

    main(['stop'])

    assert server.poll() is not None
    assert f'Stopped the Verifold server ({server.pid})' in capsys.readouterr().out


def test_stop_refuses_while_a_process_that_no_file_names_holds_the_record(lab_folder: Path) -> None:
    with (
        RecordFile(lab_folder / 'record.jsonl'),
        pytest.raises(SystemExit, match='verifold: Another process has the record'),
    ):
        main(['stop'])


class ClosedTerminal(io.TextIOBase):
    """Standard output after the terminal closes: each write fails."""

    @override
    def write(self, text: str) -> int:
        raise OSError(errno.EIO, 'Input/output error')


@pytest.mark.usefixtures('default_sigint')
def test_a_closed_terminal_still_stops_the_lab(monkeypatch: pytest.MonkeyPatch) -> None:
    cancelled: list[bool] = []

    async def serve(*_: object, **__: object) -> None:
        os.kill(os.getpid(), signal.SIGHUP)
        try:
            # Without the cancel, this sleep ends on its own and the test fails.
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr('verifold.cli.serve', serve)
    monkeypatch.setattr('sys.stdout', ClosedTerminal())

    main([])

    assert cancelled == [True]


def test_a_signal_that_nohup_ignores_stays_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    during: list[object] = []

    async def serve(*_: object, **__: object) -> None:
        during.append(signal.getsignal(signal.SIGHUP))

    monkeypatch.setattr('verifold.cli.serve', serve)
    previous = signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        main([])
        after = signal.getsignal(signal.SIGHUP)
    finally:
        signal.signal(signal.SIGHUP, previous)

    assert during == [signal.SIG_IGN]
    assert after is signal.SIG_IGN
