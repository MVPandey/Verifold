from datetime import timedelta

import pytest
from builders import START, RecordBuilder

from verifold.protocol.events import LabOpened
from verifold.society.errors import RejectedEvent


def test_a_lab_has_no_time_limit_unless_it_opens_with_one(record: RecordBuilder) -> None:
    board = record.board()

    assert (board.ends_at, board.out_of_time) == (None, False)
    with pytest.raises(RejectedEvent, match='runs out of time once, at its end'):
        record.ran_out().board()


def test_time_runs_out_at_the_end_and_once() -> None:
    ends_at = START + timedelta(minutes=2)
    early = RecordBuilder(events=[LabOpened(seq=1, at=START, question='Q?', ends_at=ends_at)])
    with pytest.raises(RejectedEvent, match='runs out of time once'):
        early.ran_out().board()

    record = RecordBuilder(events=[LabOpened(seq=1, at=START, question='Q?', ends_at=ends_at)]).join('ada').ran_out()
    board = record.board()
    assert (board.ends_at, board.out_of_time) == (ends_at, True)
    with pytest.raises(RejectedEvent, match='runs out of time once'):
        record.ran_out().board()


def test_the_person_stops_the_lab_now_and_gives_it_more_time_later(record: RecordBuilder) -> None:
    stopped = record.time_set(record.at(6)).ran_out()
    assert stopped.board().out_of_time

    later = record.at(8) + timedelta(hours=1)
    board = stopped.time_set(later).board()

    assert (board.ends_at, board.out_of_time) == (later, False)


def test_a_lab_cannot_end_before_its_end_is_set(record: RecordBuilder) -> None:
    with pytest.raises(RejectedEvent, match='cannot end before'):
        record.time_set(START).board()
