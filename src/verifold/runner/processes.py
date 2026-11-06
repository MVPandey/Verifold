"""Starting and stopping harness processes, with everything they start."""

import asyncio
import os
import signal
from asyncio.subprocess import PIPE, Process
from contextlib import suppress
from pathlib import Path
from typing import IO

from verifold.runner.environment import clean_environment

STOP_GRACE = 5.0
"""Seconds that a process group gets to exit after Verifold asks it to stop, before Verifold kills it."""

STREAM_LIMIT = 64 * 1024 * 1024
"""Bytes in one line of a harness's protocol output."""


async def start(command: tuple[str, ...], cwd: Path, errors: IO[bytes]) -> Process:
    """
    Start `command` in its own process group, with pipes for stdin and stdout, and stderr into `errors`.

    The harness gets the person's environment without Git hook variables. Its own group lets Verifold stop the
    harness together with every process that it starts, such as an adapter's harness or a shell command.
    """
    return await asyncio.create_subprocess_exec(
        *command,
        cwd=cwd,
        env=clean_environment(),
        stdin=PIPE,
        stdout=PIPE,
        stderr=errors,
        start_new_session=True,
        limit=STREAM_LIMIT,
    )


async def stop(process: Process) -> None:
    """Stop a process and its group: SIGTERM, then SIGKILL after `STOP_GRACE` seconds."""
    # Signal the group even when its leader exited already: its children can still run and hold the pipes open.
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
    # Process.wait() also waits until the pipes close, and a child of the process can hold them open for good. The
    # return code is set as soon as the process itself exits.
    while process.returncode is None:
        await asyncio.sleep(0.05)
