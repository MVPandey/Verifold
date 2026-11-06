"""A lab's record as a JSON Lines file."""

import fcntl
import os
from pathlib import Path
from types import TracebackType
from typing import IO, Self

from pydantic import TypeAdapter, ValidationError

from verifold.protocol.events import Event
from verifold.store.errors import CorruptRecord, RecordLocked, StoreError

_events: TypeAdapter[Event] = TypeAdapter(Event)


class RecordFile:
    """
    The record of one lab: one event per line, appended and never rewritten.

    Use it as a context manager. While it is open, the process holds an exclusive lock on the file, so only one
    process writes a record. A crash can leave a half-written last line, and opening the file removes that line.
    """

    def __init__(self, path: Path) -> None:
        """Prepare to open the record at `path`. Nothing touches the disk until `__enter__`."""
        self._path = path
        self._file: IO[bytes] | None = None

    def __enter__(self) -> Self:
        """
        Open the record, lock it, and remove a half-written last line.

        Raises:
            RecordLocked: Another process holds the record open.

        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        file = self._path.open('a+b')
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            file.seek(0)
            complete = file.read().rpartition(b'\n')[0]
            file.truncate(len(complete) + 1 if complete else 0)
        except BlockingIOError as error:
            file.close()
            raise RecordLocked(f'Another process has the record {self._path} open.') from error
        except BaseException:
            file.close()
            raise
        self._file = file
        return self

    def __exit__(
        self, kind: type[BaseException] | None, error: BaseException | None, traceback: TracebackType | None
    ) -> None:
        """Close the record and release its lock."""
        if self._file:
            self._file.close()
            self._file = None

    def read(self) -> tuple[Event, ...]:
        """
        Return every event in the record, in order.

        Raises:
            CorruptRecord: A line is not a valid event.

        """
        file = self._opened()
        file.seek(0)
        try:
            return tuple(_events.validate_json(line) for line in file.read().splitlines())
        except ValidationError as error:
            raise CorruptRecord(f'The record {self._path} has a line that is not a valid event.') from error

    def append(self, *events: Event) -> None:
        """
        Write events at the end of the record in one write, and wait until they are on disk.

        When the write fails, the record goes back to its size before the write, so it never keeps part of a commit.

        Raises:
            OSError: The disk refused the write. The record is unchanged.

        """
        file = self._opened()
        size = file.seek(0, os.SEEK_END)
        try:
            file.write(b''.join(_events.dump_json(event) + b'\n' for event in events))
            file.flush()
            _sync(file)
        except OSError:
            file.truncate(size)
            raise

    def _opened(self) -> IO[bytes]:
        if self._file is None:
            raise StoreError('Open the record with a with statement first.')
        return self._file


def _sync(file: IO[bytes]) -> None:
    # On macOS, fsync leaves data in the drive's cache. F_FULLFSYNC asks the drive to write it.
    if hasattr(fcntl, 'F_FULLFSYNC'):
        fcntl.fcntl(file.fileno(), fcntl.F_FULLFSYNC)
    else:
        os.fsync(file.fileno())
