import pytest
from builders import RecordBuilder
from pydantic import TypeAdapter

from verifold.protocol.events import Event, TurnEnded
from verifold.protocol.posts import Message
from verifold.society.errors import RejectedEvent
from verifold.society.turns import Before, before


def test_an_agent_without_a_turn_has_read_the_board_up_to_its_join_or_its_own_last_post(
    record: RecordBuilder,
) -> None:
    # `ada` joined as event 2, and `bo` as event 3.
    assert before(record.board(), 'bo') == Before(seen=3)

    record.post(Message(id='p-1', thread='t-1', author='bo', text='A note.'))
    record.post(Message(id='p-2', thread='t-1', author='ada', text='Another.'))

    assert before(record.board(), 'bo').seen == record.board().posts[0].seq
    assert before(record.board(), 'ada').seen == record.board().posts[1].seq


def test_a_record_from_before_turns_had_starts_and_read_positions_still_loads(record: RecordBuilder) -> None:
    old = (
        '{"seq": 6, "at": "2026-11-06T12:05:00Z", "type": "turn_ended", "agent": "bo", "seconds": 2.5, '
        '"usage": {"input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}}'
    )
    turn = TypeAdapter(Event).validate_json(old)
    assert isinstance(turn, TurnEnded)
    assert (turn.seen, turn.stopped) == (None, False)
    record.events.append(turn)

    was = before(record.board(), 'bo')

    # The record cannot tell whether the agent ended its last turn, or where it had read to.
    assert was == Before(seen=3, worked=True, ended=6)


def test_an_agent_that_ended_its_turn_is_where_the_turn_left_it(record: RecordBuilder) -> None:
    record.start('bo', seen=3, session='session-a').turn('bo', seen=5)
    record.start('bo', seen=5, session='session-b').turn('bo', seen=8)
    board = record.board()

    was = before(board, 'bo')

    assert was == Before(seen=8, session='session-b', worked=True, rested=board.starts[-1], ended=board.seq)
    assert before(board, 'ada') == Before(seen=2)


def test_a_turn_that_did_not_end_takes_the_agent_back_to_what_it_had_seen_at_its_start(
    record: RecordBuilder,
) -> None:
    record.start('bo', seen=3).turn('bo', seen=6).start('bo', seen=6)

    was = before(record.board(), 'bo')

    assert (was.seen, was.cut_off, was.rested, was.session) == (6, True, None, 'session-1')


def test_a_turn_that_ended_with_an_error_is_no_rest(record: RecordBuilder) -> None:
    record.start('bo', seen=3).turn('bo', error='The turn ran past 7200 seconds and was cancelled.', seen=4)

    was = before(record.board(), 'bo')

    assert (was.seen, was.cut_off, was.rested, was.stopped) == (4, False, None, False)


def test_an_agent_that_verifold_stopped_stays_stopped_until_a_turn_of_it_starts(record: RecordBuilder) -> None:
    record.start('bo', seen=3).turn('bo', error='BrokenPipeError', seen=3, stopped=True)
    assert before(record.board(), 'bo').stopped

    record.start('bo', seen=3)
    assert not before(record.board(), 'bo').stopped

    record.turn('bo', seen=7)
    assert not before(record.board(), 'bo').stopped


def test_the_start_of_a_turn_needs_an_agent_of_the_lab(record: RecordBuilder) -> None:
    with pytest.raises(RejectedEvent, match='nobody is not an agent in this lab'):
        record.start('nobody', seen=1).board()
