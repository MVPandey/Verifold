"""Runs one turn of a harness as a child process."""

import asyncio
import os
import signal
from asyncio import StreamReader
from asyncio.subprocess import PIPE, Process
from contextlib import suppress

from verifold.harnesses.base import Harness, Invocation, Turn, TurnReport
from verifold.runner.environment import harness_environment
from verifold.runner.errors import RunnerError

LINE_LIMIT = 16 * 1024 * 1024
"""Bytes in one line of a harness's output. A longer line is skipped."""

STDERR_KEPT = 4_096
"""Bytes at the end of stderr that a failed turn's report quotes."""

STOP_GRACE = 5.0
"""Seconds that a harness gets to exit after Verifold asks it to stop, and that its output gets to drain."""


async def run_turn(harness: Harness, turn: Turn, timeout: float) -> TurnReport:
    """
    Run one turn, and return what the harness reported.

    A harness that exits with an error, or runs past `timeout` seconds, gives a report with `error` set. The harness
    runs in its own process group. When the harness exits, when the turn times out, or when the caller cancels it,
    Verifold stops the whole group, so no shell command or subagent of the turn keeps running or holds its output open.
    """
    invocation = harness.invocation(turn)
    _write_files(invocation)
    process = await asyncio.create_subprocess_exec(
        *invocation.argv,
        cwd=turn.folder,
        env=harness_environment(harness.environment)
        | {name: value.get_secret_value() for name, value in invocation.env},
        stdin=asyncio.subprocess.DEVNULL,
        stdout=PIPE,
        stderr=PIPE,
        start_new_session=True,
        limit=LINE_LIMIT,
    )
    if process.stdout is None or process.stderr is None:
        await _stop(process)
        raise RunnerError(f'{harness.name} started without output pipes.')
    reader = _Reader(harness)
    reading = asyncio.create_task(reader.read(process.stdout))
    tail = asyncio.create_task(_tail(process.stderr))
    timed_out = False
    try:
        async with asyncio.timeout(timeout):
            await _exited(process)
    except TimeoutError:
        timed_out = True
    finally:
        await _stop(process)
        errors = await _drain(reading, tail)
    if timed_out:
        return reader.report.model_copy(
            update={'error': f'{harness.name} ran past {timeout:g} seconds and was stopped.'}
        )
    if process.returncode and reader.report.error is None:
        message = errors.decode(errors='replace').strip() or 'no error output'
        return reader.report.model_copy(
            update={'error': f'{harness.name} exited with code {process.returncode}: {message}'}
        )
    return reader.report


class _Reader:
    """Folds a harness's output lines into its report. The report survives a cancelled read."""

    def __init__(self, harness: Harness) -> None:
        self._harness = harness
        self.report = TurnReport()

    async def read(self, stream: StreamReader) -> None:
        while True:
            try:
                line = await stream.readuntil(b'\n')
            except asyncio.IncompleteReadError as end:
                if end.partial:
                    self.report = self._harness.read(self.report, end.partial)
                return
            except asyncio.LimitOverrunError as overrun:
                # Skip the part of an over-long line that the buffer holds. The rest of it fails to parse later.
                await stream.readexactly(overrun.consumed)
                continue
            self.report = self._harness.read(self.report, line)


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
    # Signal the group even when its leader exited already: its children can still run and hold the output open.
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    if process.returncode is None:
        with suppress(TimeoutError):
            async with asyncio.timeout(STOP_GRACE):
                await _exited(process)
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    await _exited(process)


async def _exited(process: Process) -> None:
    # Process.wait() also waits until the output pipes close, and a child that the harness left running can hold
    # them open for good. The return code is set as soon as the harness itself exits.
    while process.returncode is None:
        await asyncio.sleep(0.05)


async def _drain(reading: asyncio.Task[None], tail: asyncio.Task[bytes]) -> bytes:
    # A process outside the group can still hold the pipes open. Stop reading after STOP_GRACE seconds.
    try:
        async with asyncio.timeout(STOP_GRACE):
            await reading
            return await tail
    except TimeoutError:
        tail.cancel()
        return b''
