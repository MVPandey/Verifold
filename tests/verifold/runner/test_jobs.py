import signal
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import psutil
import pytest
from builders import IGNORES_SIGTERM, SLEEP

from verifold.runner.environment import harness_environment
from verifold.runner.jobs import COMMAND_LENGTH, sweep


@pytest.fixture
def lab(tmp_path: Path) -> Path:
    path = tmp_path / 'lab'
    path.mkdir()
    return path


@pytest.fixture
def started() -> Iterator[list[subprocess.Popen[bytes]]]:
    """Collect the processes that a test starts, and kill the ones that still run after it."""
    processes: list[subprocess.Popen[bytes]] = []
    yield processes
    for process in processes:
        if process.poll() is None:
            process.kill()
            process.wait()


def marked(
    started: list[subprocess.Popen[bytes]], lab: Path, script: str = SLEEP, stdout: int | None = None
) -> subprocess.Popen[bytes]:
    # A session of its own, as a harness's background command has.
    process = subprocess.Popen(
        [sys.executable, '-c', script], env=harness_environment(lab, 'agent-1'), start_new_session=True, stdout=stdout
    )
    started.append(process)
    return process


def test_a_sweep_stops_the_labs_marked_processes_and_leaves_other_labs_alone(
    lab: Path, tmp_path: Path, started: list[subprocess.Popen[bytes]]
) -> None:
    mine = marked(started, lab)
    theirs = marked(started, tmp_path / 'other-lab')

    result = sweep(lab)

    assert [(job.pid, job.agent) for job in result.stopped] == [(mine.pid, 'agent-1')]
    assert result.stopped[0].command.endswith(SLEEP)
    assert (result.survived, result.unmarked, result.earlier_run) == ((), (), False)
    assert mine.poll() is not None
    assert theirs.poll() is None


def test_a_paused_process_and_one_that_ignores_sigterm_stop_too(
    lab: Path, started: list[subprocess.Popen[bytes]]
) -> None:
    paused = marked(started, lab)
    paused.send_signal(signal.SIGSTOP)
    stubborn = marked(started, lab, IGNORES_SIGTERM, stdout=subprocess.PIPE)
    assert stubborn.stdout is not None
    assert stubborn.stdout.readline() == b'ready\n'

    result = sweep(lab, grace=0.5)

    assert sorted(job.pid for job in result.stopped) == sorted([paused.pid, stubborn.pid])
    assert paused.poll() is not None
    assert stubborn.poll() is not None


def test_a_process_that_outlives_the_sweep_is_reported(
    lab: Path, started: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch
) -> None:
    survivor = marked(started, lab)
    monkeypatch.setattr(psutil.Process, 'terminate', lambda _: None)
    monkeypatch.setattr(psutil.Process, 'kill', lambda _: None)

    result = sweep(lab, grace=0.1)

    assert [job.pid for job in result.survived] == [survivor.pid]
    assert result.stopped == ()


def test_an_unmarked_process_in_an_agents_folder_is_listed_and_left_running(
    lab: Path, started: list[subprocess.Popen[bytes]]
) -> None:
    folder = lab / '.verifold' / 'agents' / 'agent-2' / 'exp'
    folder.mkdir(parents=True)
    shell = subprocess.Popen([sys.executable, '-c', SLEEP], cwd=folder)
    started.append(shell)

    result = sweep(lab, grace=0.1)

    assert [(job.pid, job.agent) for job in result.unmarked] == [(shell.pid, 'agent-2')]
    assert result.stopped == ()
    assert shell.poll() is None


def test_a_long_command_line_is_shortened(lab: Path, started: list[subprocess.Popen[bytes]]) -> None:
    marked(started, lab, SLEEP + '  # ' + 'x' * 200)

    (job,) = sweep(lab).stopped

    assert len(job.command) == COMMAND_LENGTH
    assert job.command.endswith('…')


def hide_environment(monkeypatch: pytest.MonkeyPatch, pid: int) -> None:
    """Make one process show no environment, as macOS does for its own programs, such as sleep and zsh."""
    environ = psutil.Process.environ
    monkeypatch.setattr(psutil.Process, 'environ', lambda process: {} if process.pid == pid else environ(process))


def test_a_process_that_hides_its_environment_counts_as_the_agents_whose_folder_it_runs_in(
    lab: Path, started: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = lab / '.verifold' / 'agents' / 'agent-2'
    folder.mkdir(parents=True)
    job = subprocess.Popen([sys.executable, '-c', SLEEP], cwd=folder, start_new_session=True)
    started.append(job)
    hide_environment(monkeypatch, job.pid)

    result = sweep(lab, grace=0.5)

    assert [(found.pid, found.agent) for found in result.stopped] == [(job.pid, 'agent-2')]
    assert job.poll() is not None


def test_a_process_that_hides_its_environment_but_has_a_terminal_is_left_running(
    lab: Path, started: list[subprocess.Popen[bytes]], monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = lab / '.verifold' / 'agents' / 'agent-2'
    folder.mkdir(parents=True)
    shell = subprocess.Popen([sys.executable, '-c', SLEEP], cwd=folder)
    started.append(shell)
    hide_environment(monkeypatch, shell.pid)
    terminal = psutil.Process.terminal
    monkeypatch.setattr(
        psutil.Process, 'terminal', lambda process: '/dev/ttys009' if process.pid == shell.pid else terminal(process)
    )

    result = sweep(lab, grace=0.1)

    assert [(found.pid, found.agent) for found in result.unmarked] == [(shell.pid, 'agent-2')]
    assert result.stopped == ()
    assert shell.poll() is None


FORKS_WHEN_STOPPED = (
    'import signal, subprocess, sys, time\n'
    'def stop(*_):\n'
    '    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)\n'
    '    sys.exit(0)\n'
    'signal.signal(signal.SIGTERM, stop)\n'
    'print("ready", flush=True)\n'
    'time.sleep(60)'
)


def test_a_sweep_looks_again_for_processes_that_a_stopping_process_started(
    lab: Path, started: list[subprocess.Popen[bytes]]
) -> None:
    parent = marked(started, lab, FORKS_WHEN_STOPPED, stdout=subprocess.PIPE)
    assert parent.stdout is not None
    assert parent.stdout.readline() == b'ready\n'

    result = sweep(lab, grace=1)

    assert len(result.stopped) == 2
    assert result.survived == ()
    assert sweep(lab, grace=0.1).stopped == ()


def test_a_marked_sleep_in_an_agents_folder_stops(lab: Path, started: list[subprocess.Popen[bytes]]) -> None:
    folder = lab / '.verifold' / 'agents' / 'agent-1'
    folder.mkdir(parents=True)
    # On macOS, /bin/sleep hides its environment, so the agent's folder is what finds it.
    job = subprocess.Popen(
        ['/bin/sleep', '60'], cwd=folder, env=harness_environment(lab, 'agent-1'), start_new_session=True
    )
    started.append(job)

    result = sweep(lab, grace=0.5)

    assert [(found.pid, found.agent) for found in result.stopped] == [(job.pid, 'agent-1')]
    assert job.poll() is not None


def test_a_sweep_looks_again_only_while_still_holds(lab: Path, started: list[subprocess.Popen[bytes]]) -> None:
    parent = marked(started, lab, FORKS_WHEN_STOPPED, stdout=subprocess.PIPE)
    assert parent.stdout is not None
    assert parent.stdout.readline() == b'ready\n'

    first = sweep(lab, grace=1, still=lambda: False)
    later = sweep(lab, grace=0.5)

    assert [job.pid for job in first.stopped] == [parent.pid]
    assert len(later.stopped) == 1
