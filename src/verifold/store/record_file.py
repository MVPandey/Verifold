"""A lab's record as a JSON Lines file."""

import errno
import fcntl
import os
import stat
from io import FileIO
from pathlib import Path
from types import TracebackType
from typing import IO, Self

from pydantic import TypeAdapter, ValidationError

from verifold.protocol.events import Event
from verifold.store.errors import CorruptRecord, RecordChanged, RecordLocked, StoreError

_events: TypeAdapter[Event] = TypeAdapter(Event)

_SIDE_FILE = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
"""How the side file opens: at its end, through no link, and without a wait for the reader of a pipe at its path."""


class RecordFile:
    """
    The record of one lab: one event per line, appended and never rewritten.

    Use it as a context manager. While it is open, the process holds an exclusive lock on the file, so only one
    process writes a record. A crash can leave a half-written last line, and opening the file removes that line.

    The lock stops a second Verifold. It does not stop another program. So the record knows where its own last write
    ended, and it checks the file before each write. It moves what another program added to `foreign`, a file beside
    the record. It writes nothing to a file that another program replaced, removed, or shortened.
    """

    def __init__(self, path: Path) -> None:
        """Prepare to open the record at `path`. Nothing touches the disk until `__enter__`."""
        self._path = path
        self._file: FileIO | None = None
        self._end = 0
        """Where the record ends: the size of the file at the open, and after each write of this object since."""

    @property
    def path(self) -> Path:
        """The record's file."""
        return self._path

    @property
    def foreign(self) -> Path:
        """The file beside the record that keeps what another program added to the record."""
        return self._path.with_suffix('.foreign.jsonl')

    def __enter__(self) -> Self:
        """
        Open the record, lock it, and remove a half-written last line.

        Raises:
            RecordLocked: Another process holds the record open.

        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # Without a buffer, a write that fails leaves nothing behind that a later write would send.
        file = self._path.open('a+b', buffering=0)
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            file.seek(0)
            complete = file.read().rpartition(b'\n')[0]
            self._end = file.truncate(len(complete) + 1 if complete else 0)
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
        Return every event in the record, in order. What another program added since the last write is not in it.

        Raises:
            CorruptRecord: A line is not a valid event.

        """
        file = self._opened()
        file.seek(0)
        try:
            return tuple(_events.validate_json(line) for line in file.read()[: self._end].splitlines())
        except ValidationError as error:
            raise CorruptRecord(
                f'The record {self._path} has a line that is not a valid event. A newer version of Verifold can '
                'have written it.'
            ) from error

    def append(self, *events: Event) -> int:
        """
        Write events at the end of the record in one write, and wait until they are on disk.

        Before the write, the record moves the bytes that another program added since the last write to `foreign`,
        and goes back to where that write ended. Return the number of bytes that it moved.

        When the write fails, the record goes back to its size before the write, so it never keeps part of a commit.

        Raises:
            RecordChanged: Another program replaced, removed, or shortened the file, or the bytes that it added
                can't go to `foreign`. Nothing is written.
            OSError: The disk refused the write. The record is unchanged.

        """
        file = self._opened()
        moved = self._set_aside(file)
        data = b''.join(_events.dump_json(event) + b'\n' for event in events)
        try:
            # A full disk can take only a part of the data. The next call then raises the disk's error.
            written = 0
            while written < len(data):
                written += file.write(data[written:])
            _sync(file)
        except OSError:
            file.truncate(self._end)
            raise
        if written:
            # Another program can write after the check, so the file says where this write ended.
            self._end = file.tell()
        return moved

    def _set_aside(self, file: FileIO) -> int:
        # Check the file before a write, and return how many bytes of another program went to the side file.
        held = os.fstat(file.fileno())
        try:
            same = os.path.samestat(held, self._path.stat())
        except OSError:
            same = False
        if not same:
            raise RecordChanged(
                f'Another program replaced or removed the record {self._path}, so Verifold writes nothing to it.'
            )
        if held.st_size < self._end:
            raise RecordChanged(f'Another program shortened the record {self._path}, so Verifold writes nothing to it.')
        if held.st_size == self._end:
            return 0
        file.seek(self._end)
        added = file.read()
        try:
            _keep(self.foreign, added)
        except OSError as error:
            raise RecordChanged(
                f'Another program added to the record {self._path}. Verifold moves such bytes to {self.foreign}, '
                f'but it cannot write that file: {error.strerror}. Verifold writes nothing to the record until that '
                'path holds a regular file or nothing.'
            ) from error
        file.truncate(self._end)
        return len(added)

    def _opened(self) -> FileIO:
        if self._file is None:
            raise StoreError('Open the record with a with statement first.')
        return self._file


def _keep(path: Path, added: bytes) -> None:
    # A link could take the bytes to any file, so the side file is a regular file that only its owner reads.
    descriptor = os.open(path, _SIDE_FILE, 0o600)
    with os.fdopen(descriptor, 'ab') as side:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError(errno.EINVAL, 'It is not a regular file')
        side.write(added)
        side.flush()
        _sync(side)


def _sync(file: IO[bytes]) -> None:
    # On macOS, fsync leaves data in the drive's cache. F_FULLFSYNC asks the drive to write it.
    if hasattr(fcntl, 'F_FULLFSYNC'):
        fcntl.fcntl(file.fileno(), fcntl.F_FULLFSYNC)
    else:
        os.fsync(file.fileno())
