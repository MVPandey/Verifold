import errno
import os
import resource
import stat
from collections.abc import Callable
from pathlib import Path

import pytest
from builders import lab

from verifold.society.fold import fold
from verifold.store.errors import CorruptRecord, RecordChanged, RecordLocked, StoreError
from verifold.store.record_file import RecordFile


def test_events_round_trip_in_order(tmp_path: Path) -> None:
    events = lab().events
    path = tmp_path / 'lab' / 'record.jsonl'

    with RecordFile(path) as record:
        for event in events:
            record.append(event)
    with RecordFile(path) as record:
        assert record.read() == tuple(events)


def test_a_new_record_is_empty(tmp_path: Path) -> None:
    with RecordFile(tmp_path / 'record.jsonl') as record:
        assert record.read() == ()


def test_opening_removes_a_half_written_last_line(tmp_path: Path) -> None:
    path = tmp_path / 'record.jsonl'
    first = lab().events[0]
    with RecordFile(path) as record:
        record.append(first)
    with path.open('ab') as file:
        file.write(b'{"type": "posted", "seq"')

    with RecordFile(path) as record:
        assert record.read() == (first,)
        record.append(first.model_copy(update={'seq': 2}))
    assert path.read_bytes().count(b'\n') == 2


def test_a_record_with_only_a_half_written_line_opens_empty(tmp_path: Path) -> None:
    path = tmp_path / 'record.jsonl'
    path.write_bytes(b'{"type": "lab_op')

    with RecordFile(path) as record:
        assert record.read() == ()
    assert path.read_bytes() == b''


def test_a_bad_complete_line_is_an_error(tmp_path: Path) -> None:
    path = tmp_path / 'record.jsonl'
    path.write_bytes(b'{"type": "unknown"}\n')

    with RecordFile(path) as record, pytest.raises(CorruptRecord, match='not a valid event'):
        record.read()


def test_one_writer_at_a_time(tmp_path: Path) -> None:
    path = tmp_path / 'record.jsonl'

    with RecordFile(path), pytest.raises(RecordLocked, match='has the record'):
        RecordFile(path).__enter__()
    with RecordFile(path) as record:
        assert record.read() == ()


def test_a_closed_record_refuses_access(tmp_path: Path) -> None:
    with pytest.raises(StoreError, match='with statement'):
        RecordFile(tmp_path / 'record.jsonl').read()


def test_several_events_append_in_one_write(tmp_path: Path) -> None:
    events = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(*events)
        assert record.read() == tuple(events)


def test_a_failed_write_leaves_the_record_as_it_was(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    first, *rest = lab().events
    path = tmp_path / 'record.jsonl'

    def full_disk(_: object) -> None:
        raise OSError(28, 'No space left on device')

    with RecordFile(path) as record:
        record.append(first)
        monkeypatch.setattr('verifold.store.record_file._sync', full_disk)
        with pytest.raises(OSError, match='No space'):
            record.append(*rest)
        assert record.read() == (first,)


def test_a_write_that_the_disk_cuts_short_leaves_the_record_as_it_was(tmp_path: Path) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first)
        size = path.stat().st_size
        soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
        # The file takes ten bytes more, so the write of the next event stops after its start.
        resource.setrlimit(resource.RLIMIT_FSIZE, (size + 10, hard))
        try:
            with pytest.raises(OSError, match='large') as refused:
                record.append(second)
        finally:
            resource.setrlimit(resource.RLIMIT_FSIZE, (soft, hard))

        assert refused.value.errno == errno.EFBIG
        assert path.stat().st_size == size
        # The start of the failed write is gone, so the next write finds nothing of another program.
        assert record.append(second) == 0
        assert record.read() == (first, second)
        assert not record.foreign.exists()


def add(path: Path, data: bytes) -> None:
    """Write to the record as another program does: through a file of its own, at the end."""
    with path.open('ab') as other:
        other.write(data)


def test_a_write_of_no_events_keeps_the_end_of_the_record(tmp_path: Path) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    # The open reads past this half line and removes it, and a write of nothing does not move the end there.
    path.write_bytes(b'{"type": "lab_op')

    with RecordFile(path) as record:
        assert record.append() == 0
        assert record.append(first) == 0
        add(path, b'a line\n')
        assert record.append() == len(b'a line\n')
        assert record.append(second) == 0
        assert record.read() == (first, second)


def test_what_another_program_adds_moves_to_a_file_beside_the_record_and_the_record_still_folds(
    tmp_path: Path,
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    # A line with the number of the next event. With it, the record would hold event 2 twice.
    foreign = second.model_dump_json().encode() + b'\n'

    with RecordFile(path) as record:
        assert record.append(first) == 0
        add(path, foreign)
        mine = record.read()
        moved = record.append(second)

        assert mine == (first,)
        assert moved == len(foreign)
        assert len(path.read_bytes().splitlines()) == 2
        assert record.foreign == tmp_path / 'record.foreign.jsonl'
        assert record.foreign.read_bytes() == foreign
        assert stat.S_IMODE(record.foreign.stat().st_mode) == 0o600
    with RecordFile(path) as record:
        assert record.read() == (first, second)
        assert fold(record.read()).seq == 2


def test_each_later_addition_of_another_program_goes_to_the_end_of_the_same_file(tmp_path: Path) -> None:
    first, second, third, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first)
        add(path, b'one line\n')
        record.append(second)
        add(path, b'half a line')
        moved = record.append(third)

        assert moved == len(b'half a line')
        assert record.foreign.read_bytes() == b'one line\nhalf a line'
        assert record.read() == (first, second, third)
        assert path.read_bytes().count(b'\n') == 3


def replace(path: Path) -> None:
    """Save the record as an editor does: write a new file, and rename it over the record."""
    saved = path.with_name('record.jsonl.saved')
    saved.write_bytes(path.read_bytes())
    saved.replace(path)


@pytest.mark.parametrize('change', [replace, Path.unlink])
def test_a_record_that_another_program_replaced_or_removed_gets_no_write(
    tmp_path: Path, change: Callable[[Path], None]
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first)
        change(path)
        after = path.read_bytes() if path.exists() else None

        with pytest.raises(RecordChanged, match=r'replaced or removed the record .* writes nothing to it'):
            record.append(second)
        assert (path.read_bytes() if path.exists() else None) == after
        assert record.read() == (first,)
        assert not record.foreign.exists()


def test_a_record_that_another_program_shortened_gets_no_write(tmp_path: Path) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first)
        os.truncate(path, 10)

        with pytest.raises(RecordChanged, match=r'shortened the record .* writes nothing to it'):
            record.append(second)
        assert path.stat().st_size == 10


def test_a_link_in_the_place_of_the_side_file_is_refused_and_the_record_stays_as_it_was(tmp_path: Path) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    elsewhere = tmp_path / 'elsewhere'

    with RecordFile(path) as record:
        record.append(first)
        record.foreign.symlink_to(elsewhere)
        add(path, b'a line\n')
        before = path.read_bytes()

        with pytest.raises(RecordChanged, match=r'cannot write that file: .* writes nothing to the record until'):
            record.append(second)
        assert path.read_bytes() == before
        assert not elsewhere.exists()

        # Without the link, the next write moves the line and goes through.
        record.foreign.unlink()
        assert record.append(second) == len(b'a line\n')
        assert record.read() == (first, second)


def test_a_pipe_in_the_place_of_the_side_file_is_refused(tmp_path: Path) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first)
        os.mkfifo(record.foreign)
        # A pipe opens for a writer only when it has a reader.
        reader = os.open(record.foreign, os.O_RDONLY | os.O_NONBLOCK)
        add(path, b'a line\n')
        before = path.read_bytes()
        try:
            with pytest.raises(RecordChanged, match='It is not a regular file'):
                record.append(second)
            assert os.read(reader, 100) == b''
        finally:
            os.close(reader)
        assert path.read_bytes() == before
