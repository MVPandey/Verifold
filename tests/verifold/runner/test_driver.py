import asyncio
import os
import stat
import sys
from pathlib import Path
from typing import override

import pytest
from pydantic import SecretStr

from verifold.harnesses.base import ConfigFile, Harness, Invocation, Turn, TurnReport
from verifold.runner.driver import run_turn


class Scripted(Harness):
    """A harness that runs a Python script and keeps each output line as the final text."""

    name = 'scripted'
    family = 'test'

    def __init__(self, script: str) -> None:
        self._script = script

    @override
    def invocation(self, turn: Turn) -> Invocation:
        return Invocation(
            argv=(sys.executable, '-c', self._script),
            env=(('AGENT_SECRET', SecretStr('s3cret')),),
            files=(ConfigFile(path=turn.private / 'config.json', content=SecretStr('{"token": "s3cret"}')),),
        )

    @override
    def read(self, report: TurnReport, line: bytes) -> TurnReport:
        return report.model_copy(update={'final_text': report.final_text + line.decode()})


@pytest.fixture
def turn(tmp_path: Path) -> Turn:
    folder = tmp_path / 'folder'
    folder.mkdir()
    return Turn(
        prompt='Go.',
        folder=folder,
        private=tmp_path / 'private',
        mcp_url='http://127.0.0.1:1/mcp',
        token=SecretStr('t'),
    )


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def test_a_turn_runs_in_the_folder_with_a_clean_environment_and_private_files(
    turn: Turn, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('GIT_DIR', '/somewhere/else/.git')
    script = 'import os; print(os.environ["AGENT_SECRET"]); print("GIT_DIR" in os.environ); print(os.getcwd())'

    report = await run_turn(Scripted(script), turn, timeout=30)

    assert report.final_text.splitlines() == ['s3cret', 'False', str(turn.folder.resolve())]
    assert report.error is None
    assert stat.S_IMODE(turn.private.stat().st_mode) == 0o700
    assert stat.S_IMODE((turn.private / 'config.json').stat().st_mode) == 0o600


async def test_a_failed_exit_reports_the_end_of_stderr(turn: Turn) -> None:
    script = 'import sys; print("partial"); sys.stderr.write("x" * 9000 + "Not signed in."); sys.exit(3)'

    report = await run_turn(Scripted(script), turn, timeout=30)

    assert report.final_text == 'partial\n'
    assert report.error is not None
    assert report.error.startswith('scripted exited with code 3: xxx')
    assert report.error.endswith('Not signed in.')
    assert len(report.error) < 4_200


async def test_a_turn_past_its_timeout_is_stopped_with_its_children(turn: Turn, tmp_path: Path) -> None:
    pids = tmp_path / 'pids'
    script = (
        'import os, subprocess, sys, time; '
        'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]); '
        f'open({str(pids)!r}, "w").write(f"{{os.getpid()}} {{child.pid}}"); '
        'print("started", flush=True); time.sleep(60)'
    )

    report = await run_turn(Scripted(script), turn, timeout=1)

    assert report.error == 'scripted ran past 1 seconds and was stopped.'
    assert report.final_text == 'started\n'
    harness_pid, child_pid = map(int, pids.read_text().split())
    await asyncio.sleep(0.1)
    assert not alive(harness_pid)
    assert not alive(child_pid)


async def test_a_cancelled_turn_stops_its_harness(turn: Turn, tmp_path: Path) -> None:
    pid_file = tmp_path / 'pid'
    script = f'import os, time; open({str(pid_file)!r}, "w").write(str(os.getpid())); time.sleep(60)'
    running = asyncio.create_task(run_turn(Scripted(script), turn, timeout=60))
    while not pid_file.exists() or not pid_file.read_text():
        await asyncio.sleep(0.05)

    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running

    assert not alive(int(pid_file.read_text()))


async def test_a_harness_that_ignores_the_stop_signal_is_killed(
    turn: Turn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr('verifold.runner.driver.STOP_GRACE', 0.2)
    pid_file = tmp_path / 'pid'
    script = (
        'import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
        f'open({str(pid_file)!r}, "w").write(str(os.getpid())); print("stubborn", flush=True); time.sleep(60)'
    )

    report = await run_turn(Scripted(script), turn, timeout=1)

    assert report.error == 'scripted ran past 1 seconds and was stopped.'
    assert not alive(int(pid_file.read_text()))
