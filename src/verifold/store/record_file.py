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

TAIL = 4096
"""
How many of the record's last bytes are compared before each write. A change by another program that keeps these
bytes and the record's length is not seen.
"""

_OWN_FILE = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
"""How a file beside the record opens: at its end, through no link, and without a wait for a pipe's reader."""

_NOT_OWN = 'the path holds a link, a file with a second name, or no regular file'

_MOVES = 16
"""How often one check moves what another program added, before it takes that program to be one that never stops."""


class RecordFile:
    """
    The record of one lab: one event per line, appended and never rewritten.

    Use it as a context manager. While it is open, the process holds an exclusive lock on the file, so only one
    process writes a record. A crash can leave a half-written last line, and opening the file removes that line.

    The lock stops a second Verifold. It does not stop another program. So the record knows where its own last write
    ended and which bytes came before that end, and it checks the file before each write:

    - Bytes that another program added after that end go to `foreign`, a file beside the record.
    - A file that another program replaced, removed, shortened, or rewrote gets no write, now or later. When the
      path names another file or none, the record as this object wrote it goes to `kept`, a file beside the record.

    The check sees the path, the record's length, and its last `TAIL` bytes. It sees no other change.
    """

    def __init__(self, path: Path) -> None:
        """Prepare to open the record at `path`. Nothing touches the disk until `__enter__`."""
        self._path = path
        self._file: FileIO | None = None
        self._end = 0
        """Where the record ends: the size of the file at the open, plus what this object wrote since."""
        self._tail = b''
        """The record's last bytes before `_end`, at most `TAIL` of them."""
        self._moved = 0
        self._refusal: str | None = None
        """Why the record takes no more writes, once a check found that another program changed it."""

    @property
    def path(self) -> Path:
        """The record's file."""
        return self._path

    @property
    def foreign(self) -> Path:
        """The file beside the record that keeps what another program added to the record."""
        return self._path.with_suffix('.foreign.jsonl')

    @property
    def kept(self) -> Path:
        """The file beside the record that keeps the record as this object wrote it, once the path names another."""
        return self._path.with_suffix('.kept.jsonl')

    @property
    def moved(self) -> int:
        """How many bytes of other programs this object moved from the record to `foreign` since it opened."""
        return self._moved

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
            content = file.read()
            complete = content.rpartition(b'\n')[0]
            self._end = file.truncate(len(complete) + 1 if complete else 0)
            self._tail = content[: self._end][-TAIL:]
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
            CorruptRecord: A line is not a valid event. The message gives the line.

        """
        lines = self._written(self._opened()).splitlines()
        return tuple(self._event(number, line) for number, line in enumerate(lines, start=1))

    def append(self, *events: Event) -> None:
        """
        Write events at the end of the record in one write, and wait until they are on disk.

        Before the write, the record moves the bytes that another program added after its end to `foreign`, and
        `moved` counts them. When the write fails, the record keeps none of the write's bytes, so it never keeps
        part of a commit.

        Raises:
            RecordChanged: Another program replaced, removed, shortened, or rewrote the file, or the bytes that it
                added can't go to `foreign`. Nothing is written, and every later call raises the same.
            OSError: The disk refused the write. The record is unchanged.

        """
        file = self._opened()
        if self._refusal is None:
            self._refusal = self._check(file)
        if self._refusal:
            raise RecordChanged(self._refusal)
        data = b''.join(_events.dump_json(event) + b'\n' for event in events)
        written = 0
        try:
            # A full disk can take only a part of the data. The next call then raises the disk's error.
            while written < len(data):
                written += file.write(data[written:])
            _sync(file)
        except OSError:
            if written:
                # Another program can have written since the check, so only this write's own bytes go.
                file.truncate(file.tell() - written)
            raise
        # When another program wrote since the check, its bytes are before these. The next check then finds that
        # the record does not end with what this object wrote.
        self._end += written
        self._tail = (self._tail + data)[-TAIL:]

    def _check(self, file: FileIO) -> str | None:
        # Move what another program added after the record's end to `foreign`. Return why the record takes no more
        # writes, when another program changed more than that.
        descriptor = file.fileno()
        try:
            same = os.path.samestat(os.fstat(descriptor), self._path.stat())
        except OSError:
            same = False
        if not same:
            return self._keep(file)
        copied, why = self._end, None
        # More can arrive while the bytes move, so the size is read again after each move. A program that never
        # stops must not hold the server here.
        for _ in range(_MOVES):
            # The record's own bytes are compared before each look at the size, and so also just before the cut.
            if os.pread(descriptor, len(self._tail), self._end - len(self._tail)) != self._tail:
                return f'Another program shortened or rewrote the record {self._path}, so Verifold stops.'
            size = os.fstat(descriptor).st_size
            if size <= copied:
                if copied > self._end:
                    file.truncate(self._end)
                    self._moved += copied - self._end
                return None
            added = os.pread(descriptor, size - copied, copied)
            try:
                _add(self.foreign, added)
            except OSError as error:
                why = error.strerror
                break
            copied += len(added)
        return (
            f'Another program added to the record {self._path}, and Verifold could not move what it added to '
            f'{self.foreign}: {why or "the program went on adding"}. Verifold stops, and what the program added '
            'is still at the end of the record.'
        )

    def _keep(self, file: FileIO) -> str:
        # The path names another file or none, so only this process still has the record as it wrote it. Copy it to
        # a file that outlives the process, and return what happened in one line.
        gone = f'Another program replaced or removed the record {self._path}, so Verifold stops.'
        if not self._end:
            return gone
        try:
            _add(self.kept, self._written(file))
        except OSError as error:
            return f'{gone} Verifold could not keep what it wrote in {self.kept}: {error.strerror}.'
        return f'{gone} What Verifold wrote is in {self.kept}.'

    def _written(self, file: FileIO) -> bytes:
        file.seek(0)
        return file.read()[: self._end]

    def _event(self, number: int, line: bytes) -> Event:
        try:
            return _events.validate_json(line)
        except ValidationError as error:
            raise CorruptRecord(
                f'Line {number} of the record {self._path} is not a valid event. Another program can have written '
                'it, or a newer version of Verifold.'
            ) from error

    def _opened(self) -> FileIO:
        if self._file is None:
            raise StoreError('Open the record with a with statement first.')
        return self._file


def _add(path: Path, data: bytes) -> None:
    # Write at the end of a file of Verifold's own beside the record. A link, or a second name of another file,
    # could take the bytes to any file. So the file is a regular file with one name, and only its owner reads it.
    try:
        descriptor = os.open(path, _OWN_FILE, 0o600)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise OSError(errno.ELOOP, _NOT_OWN) from error
        raise
    with os.fdopen(descriptor, 'ab') as file:
        found = os.fstat(descriptor)
        if not stat.S_ISREG(found.st_mode) or found.st_nlink != 1:
            raise OSError(errno.EINVAL, _NOT_OWN)
        os.fchmod(descriptor, 0o600)
        file.write(data)
        file.flush()
        _sync(file)


def _sync(file: IO[bytes]) -> None:
    # On macOS, fsync leaves data in the drive's cache. F_FULLFSYNC asks the drive to write it.
    if hasattr(fcntl, 'F_FULLFSYNC'):
        fcntl.fcntl(file.fileno(), fcntl.F_FULLFSYNC)
    else:
        os.fsync(file.fileno())
