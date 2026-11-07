"""Starting and stopping harness processes, with everything they start."""

import asyncio
import os
import signal
from asyncio.subprocess import PIPE, Process
from contextlib import suppress
from pathlib import Path
from typing import IO

from verifold.runner.environment import clean_environment

EXIT_GRACE = 2.0
"""Seconds that a harness gets to exit on its own after its stdin closes, so it can save its session."""

STOP_GRACE = 5.0
"""Seconds that a process group gets to exit after SIGTERM, before Verifold kills it."""

STREAM_LIMIT = 64 * 1024 * 1024
"""The longest line of protocol output that Verifold reads from a harness, in bytes."""


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
    """
    Stop a process and its group.

    Closing stdin asks an ACP agent to exit, so it can save its session. After `EXIT_GRACE` seconds the group gets
    SIGTERM, and after `STOP_GRACE` more seconds SIGKILL. The group is signalled even when its leader exited already,
    because its children can still run and hold the pipes open.
    """
    if process.stdin:
        process.stdin.close()
    await _exited(process, EXIT_GRACE)
    _signal_group(process, signal.SIGTERM)
    await _exited(process, STOP_GRACE)
    _signal_group(process, signal.SIGKILL)
    await _exited(process, None)


def _signal_group(process: Process, sent: signal.Signals) -> None:
    # The group can be gone already. macOS also refuses a group whose last members are still exiting.
    with suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, sent)


async def _exited(process: Process, seconds: float | None) -> None:
    # Process.wait() also waits until the pipes close, and a child of the process can hold them open for good. The
    # return code is set as soon as the process itself exits.
    with suppress(TimeoutError):
        async with asyncio.timeout(seconds):
            while process.returncode is None:
                await asyncio.sleep(0.05)
