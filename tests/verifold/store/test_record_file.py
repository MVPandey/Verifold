import errno
import os
import resource
import stat
from collections.abc import Callable
from io import FileIO
from pathlib import Path

import pytest
from builders import lab

from verifold.society.fold import fold
from verifold.store import record_file
from verifold.store.errors import CorruptRecord, RecordChanged, RecordLocked, StoreError
from verifold.store.record_file import TAIL, RecordFile


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


def test_a_line_that_is_no_event_is_an_error_that_gives_the_line(tmp_path: Path) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    with RecordFile(path) as record:
        record.append(first, second)
    add(path, b'{"type": "unknown"}\n')

    with (
        RecordFile(path) as record,
        pytest.raises(CorruptRecord, match=rf'^Line 3 of the record {path} is not a valid event\. Another program can'),
    ):
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
        record.append(second)
        assert record.read() == (first, second)
        assert record.moved == 0
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
        record.append()
        record.append(first)
        add(path, b'a line\n')
        record.append()
        record.append(second)

        assert record.moved == len(b'a line\n')
        assert record.read() == (first, second)


def test_what_another_program_adds_at_the_end_moves_to_a_file_beside_the_record_and_the_record_still_folds(
    tmp_path: Path,
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    # A line with the number of the next event. With it, the record would hold event 2 twice.
    foreign = second.model_dump_json().encode() + b'\n'

    with RecordFile(path) as record:
        record.append(first)
        add(path, foreign)
        mine = record.read()
        record.append(second)

        assert mine == (first,)
        assert record.moved == len(foreign)
        assert len(path.read_bytes().splitlines()) == 2
        assert record.foreign == tmp_path / 'record.foreign.jsonl'
        assert record.foreign.read_bytes() == foreign
        assert stat.S_IMODE(record.foreign.stat().st_mode) == 0o600
    with RecordFile(path) as record:
        assert record.read() == (first, second)
        assert fold(record.read()).seq == 2


def test_each_later_addition_goes_to_the_end_of_the_same_file_which_only_its_owner_reads(tmp_path: Path) -> None:
    first, second, third, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first)
        # The file is there already, and others can read it.
        record.foreign.write_bytes(b'from before\n')
        record.foreign.chmod(0o644)
        add(path, b'one line\n')
        record.append(second)
        add(path, b'half a line')
        record.append(third)

        assert record.moved == len(b'one line\nhalf a line')
        assert record.foreign.read_bytes() == b'from before\none line\nhalf a line'
        assert stat.S_IMODE(record.foreign.stat().st_mode) == 0o600
        assert record.read() == (first, second, third)
        assert path.read_bytes().count(b'\n') == 3


def test_what_another_program_adds_while_the_record_moves_its_bytes_moves_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    move = record_file._add
    later = [b'a second line\n']

    def and_more_arrives(side: Path, data: bytes) -> None:
        move(side, data)
        if later:
            add(path, later.pop())

    with RecordFile(path) as record:
        record.append(first)
        add(path, b'a first line\n')
        monkeypatch.setattr(record_file, '_add', and_more_arrives)
        record.append(second)

        assert record.foreign.read_bytes() == b'a first line\na second line\n'
        assert record.moved == len(b'a first line\na second line\n')
        assert record.read() == (first, second)
        assert path.read_bytes().count(b'\n') == 2


def test_a_program_that_goes_on_adding_while_the_record_moves_its_bytes_does_not_hold_the_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    move = record_file._add

    def and_more_arrives(side: Path, data: bytes) -> None:
        move(side, data)
        add(path, b'more\n')

    with RecordFile(path) as record:
        record.append(first)
        written = path.read_bytes()
        add(path, b'a line\n')
        monkeypatch.setattr(record_file, '_add', and_more_arrives)

        with pytest.raises(RecordChanged, match=r': the program went on adding\. Verifold stops, and what'):
            record.append(second)
        assert path.read_bytes() == written + b'a line\n' + b'more\n' * 16
        assert record.foreign.read_bytes() == b'a line\n' + b'more\n' * 15
        assert record.moved == 0


def rewrite(path: Path, content: bytes) -> None:
    """Save the record in place, as an editor does that keeps the file: cut it, and write it again."""
    path.write_bytes(content)


def longer(written: bytes) -> list[bytes]:
    return [written.replace(b'Does it hold?', b'Does it hold??', 1)]


def shorter_and_then_longer(written: bytes) -> list[bytes]:
    return [b'', written + b'{"more": 1}\n']


def as_long_with_another_end(written: bytes) -> list[bytes]:
    return [written[:-3] + b'X' + written[-2:]]


@pytest.mark.parametrize('saves', [longer, shorter_and_then_longer, as_long_with_another_end])
def test_a_record_that_another_program_rewrote_in_place_gets_no_write_and_stays_as_that_program_wrote_it(
    tmp_path: Path, saves: Callable[[bytes], list[bytes]]
) -> None:
    first, second, third, fourth, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first, second, third)
        for content in saves(path.read_bytes()):
            rewrite(path, content)

            with pytest.raises(RecordChanged, match=rf'^Another program shortened or rewrote the record {path}, so'):
                record.append(fourth)
            assert path.read_bytes() == content
        assert record.moved == 0
        assert not record.foreign.exists()
        assert not record.kept.exists()


def test_a_long_record_compares_its_last_bytes_and_sees_no_change_of_the_same_length_before_them(
    tmp_path: Path,
) -> None:
    first, second, third, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    many = [first.model_copy(update={'seq': seq}) for seq in range(1, 60)]

    with RecordFile(path) as record:
        record.append(*many)
        written = path.read_bytes()
        changed = b'X' + written[1:]
        rewrite(path, changed)
        record.append(second)
        now = path.read_bytes()
        rewrite(path, *as_long_with_another_end(now))

        assert len(written) > TAIL
        assert now == changed + second.model_dump_json().encode() + b'\n'
        with pytest.raises(RecordChanged, match='shortened or rewrote'):
            record.append(third)


def replace(path: Path) -> None:
    """Save the record as an editor does that writes a new file: write it, and rename it over the record."""
    saved = path.with_name('record.jsonl.saved')
    saved.write_bytes(path.read_bytes().splitlines(keepends=True)[0])
    saved.replace(path)


@pytest.mark.parametrize('change', [replace, Path.unlink])
def test_a_record_that_another_program_replaced_or_removed_gets_no_write_and_what_was_written_is_kept(
    tmp_path: Path, change: Callable[[Path], None]
) -> None:
    first, second, third, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first, second)
        written = path.read_bytes()
        change(path)
        after = path.read_bytes() if path.exists() else None

        for _ in range(2):
            with pytest.raises(RecordChanged) as refused:
                record.append(third)
        assert str(refused.value) == (
            f'Another program replaced or removed the record {path}, so Verifold stops. '
            f'What Verifold wrote is in {tmp_path / "record.kept.jsonl"}.'
        )
        assert (path.read_bytes() if path.exists() else None) == after
        # The copy is made once, also when a second write is refused.
        assert record.kept.read_bytes() == written
        assert stat.S_IMODE(record.kept.stat().st_mode) == 0o600
        assert not record.foreign.exists()


def test_a_record_that_holds_nothing_leaves_no_copy_when_another_program_removes_it(tmp_path: Path) -> None:
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        path.unlink()

        with pytest.raises(RecordChanged, match=r'replaced or removed the record .*, so Verifold stops\.$'):
            record.append(lab().events[0])
        assert not record.kept.exists()


def test_a_copy_that_cannot_be_kept_is_named_with_the_reason(tmp_path: Path) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    elsewhere = tmp_path / 'elsewhere'

    with RecordFile(path) as record:
        record.append(first)
        record.kept.symlink_to(elsewhere)
        path.unlink()

        with pytest.raises(RecordChanged) as refused:
            record.append(second)
        assert str(refused.value).endswith(
            f'so Verifold stops. Verifold could not keep what it wrote in {record.kept}: '
            'the path holds a link, a file with a second name, or no regular file.'
        )
        assert not elsewhere.exists()


def link(side: Path, record: Path) -> None:
    side.symlink_to(record.with_name('elsewhere'))


def second_name(side: Path, record: Path) -> None:
    side.hardlink_to(record)


def pipe(side: Path, _: Path) -> None:
    os.mkfifo(side)


@pytest.mark.parametrize('taken', [link, second_name, pipe])
def test_a_side_file_that_is_a_link_a_second_name_or_no_regular_file_is_refused_and_nothing_is_lost(
    tmp_path: Path, taken: Callable[[Path, Path], None]
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    with RecordFile(path) as record:
        record.append(first)
        taken(record.foreign, path)
        # A pipe opens for a writer only when it has a reader.
        reader = os.open(record.foreign, os.O_RDONLY | os.O_NONBLOCK) if taken is pipe else None
        add(path, b'a line\n')
        before = path.read_bytes()

        try:
            with pytest.raises(RecordChanged) as refused:
                record.append(second)
        finally:
            if reader is not None:
                os.close(reader)
        assert str(refused.value) == (
            f'Another program added to the record {path}, and Verifold could not move what it added to '
            f'{record.foreign}: the path holds a link, a file with a second name, or no regular file. '
            'Verifold stops, and what the program added is still at the end of the record.'
        )
        assert path.read_bytes() == before
        assert not (tmp_path / 'elsewhere').exists()
        assert record.moved == 0


def test_a_side_file_that_the_disk_refuses_is_named_with_the_disks_reason_and_gets_the_bytes_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'

    def full_disk(_: object) -> None:
        raise OSError(errno.ENOSPC, 'No space left on device')

    with RecordFile(path) as record:
        record.append(first)
        add(path, b'a line\n')
        before = path.read_bytes()
        with monkeypatch.context() as patched:
            patched.setattr(record_file, '_sync', full_disk)
            with pytest.raises(RecordChanged) as refused:
                record.append(second)
        # The disk has room again. The record still takes no write, so the side file gets the bytes no second time.
        with pytest.raises(RecordChanged, match='No space left on device'):
            record.append(second)

        assert str(refused.value) == (
            f'Another program added to the record {path}, and Verifold could not move what it added to '
            f'{record.foreign}: No space left on device. '
            'Verifold stops, and what the program added is still at the end of the record.'
        )
        assert record.foreign.read_bytes() == b'a line\n'
        assert path.read_bytes() == before
        assert record.moved == 0


def test_what_another_program_writes_between_the_check_and_the_write_is_found_at_the_next_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second, third, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    check = RecordFile._check

    def and_then_a_line_arrives(self: RecordFile, file: FileIO) -> str | None:
        found = check(self, file)
        add(path, b'a line\n')
        return found

    with RecordFile(path) as record:
        record.append(first)
        with monkeypatch.context() as patched:
            patched.setattr(RecordFile, '_check', and_then_a_line_arrives)
            record.append(second)
        content = path.read_bytes()

        with pytest.raises(RecordChanged, match='shortened or rewrote'):
            record.append(third)
        assert content.count(b'a line\n') == 1
        assert path.read_bytes() == content
        assert not record.foreign.exists()


def test_a_write_that_fails_removes_its_own_bytes_and_none_that_another_program_wrote_before_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second, *_ = lab().events
    path = tmp_path / 'record.jsonl'
    check = RecordFile._check

    def and_then_a_line_arrives(self: RecordFile, file: FileIO) -> str | None:
        found = check(self, file)
        add(path, b'a line\n')
        return found

    def full_disk(_: object) -> None:
        raise OSError(errno.ENOSPC, 'No space left on device')

    with RecordFile(path) as record:
        record.append(first)
        written = path.read_bytes()
        with monkeypatch.context() as patched:
            patched.setattr(RecordFile, '_check', and_then_a_line_arrives)
            patched.setattr(record_file, '_sync', full_disk)
            with pytest.raises(OSError, match='No space'):
                record.append(second)

        assert path.read_bytes() == written + b'a line\n'
        # The line is after the record's end, so the next write moves it.
        record.append(second)
        assert record.foreign.read_bytes() == b'a line\n'
        assert record.read() == (first, second)
