"""The file that names the process serving a lab, so that `verifold stop` can find it from another terminal."""

from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import psutil
from pydantic import ValidationError

from verifold.protocol.record import Record

START_TOLERANCE = 1.0
"""Seconds by which two readings of one process's start time can differ, such as after a clock change on Linux."""


class ServerProcess(Record):
    """The process that serves a lab. Its start time tells it apart from a later process that gets the same ID."""

    pid: int
    started: float


@contextmanager
def server_file(path: Path) -> Generator[None]:
    """Name this process in `path` while the block runs, and remove the file after it."""
    this = psutil.Process()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(ServerProcess(pid=this.pid, started=this.create_time()).model_dump_json())
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


def running_server(path: Path) -> psutil.Process | None:
    """Return the process that `path` names while it runs, or `None` when there is no such file or process."""
    try:
        named = ServerProcess.model_validate_json(path.read_text())
        process = psutil.Process(named.pid)
        same = abs(process.create_time() - named.started) < START_TOLERANCE
    except (OSError, ValidationError, psutil.Error):
        return None
    return process if same else None
