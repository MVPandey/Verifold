from pathlib import Path

import pytest
from builders import lab

from verifold.store.errors import CorruptRecord, RecordLocked, StoreError
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
