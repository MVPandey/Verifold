"""Runs one turn of a harness as a child process."""

import asyncio
import os
import signal
from asyncio import StreamReader
from asyncio.subprocess import PIPE, Process
from contextlib import suppress

from verifold.harnesses.base import Harness, Invocation, Turn, TurnReport
from verifold.runner.environment import clean_environment
from verifold.runner.errors import RunnerError

STDERR_KEPT = 4_096
"""Bytes at the end of stderr that a failed turn's report quotes."""

STOP_GRACE = 5.0
"""Seconds that a harness gets to exit after Verifold asks it to stop, before Verifold kills it."""


async def run_turn(harness: Harness, turn: Turn, timeout: float) -> TurnReport:
    """
    Run one turn, and return what the harness reported.

    A harness that exits with an error, or runs past `timeout` seconds, gives a report with `error` set. The harness
    runs in its own process group, so stopping it also stops the subagents and shell commands that it started.
    Verifold stops the group when the turn times out or when the caller cancels it.
    """
    invocation = harness.invocation(turn)
    _write_files(invocation)
    process = await asyncio.create_subprocess_exec(
        *invocation.argv,
        cwd=turn.folder,
        env=clean_environment() | {name: value.get_secret_value() for name, value in invocation.env},
        stdin=asyncio.subprocess.DEVNULL,
        stdout=PIPE,
        stderr=PIPE,
        start_new_session=True,
        limit=16 * 1024 * 1024,
    )
    stdout, stderr = process.stdout, process.stderr
    if stdout is None or stderr is None:
        raise RunnerError(f'{harness.name} started without output pipes.')
    tail = asyncio.create_task(_tail(stderr))
    report = TurnReport()
    try:
        async with asyncio.timeout(timeout):
            async for line in stdout:
                report = harness.read(report, line)
            await process.wait()
    except TimeoutError:
        report = report.model_copy(update={'error': f'{harness.name} ran past {timeout:g} seconds and was stopped.'})
    finally:
        await _stop(process)
        errors = await tail
    if process.returncode and report.error is None:
        message = errors.decode(errors='replace').strip() or 'no error output'
        return report.model_copy(update={'error': f'{harness.name} exited with code {process.returncode}: {message}'})
    return report


def _write_files(invocation: Invocation) -> None:
    for file in invocation.files:
        file.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        file.path.touch(mode=0o600)
        file.path.chmod(0o600)
        file.path.write_text(file.content.get_secret_value())


async def _tail(stream: StreamReader) -> bytes:
    kept = b''
    while chunk := await stream.read(65_536):
        kept = (kept + chunk)[-STDERR_KEPT:]
    return kept


async def _stop(process: Process) -> None:
    if process.returncode is not None:
        return
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        async with asyncio.timeout(STOP_GRACE):
            await process.wait()
    except TimeoutError:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
