from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab
from pydantic import ValidationError

from verifold.protocol.events import AlarmCondition, AlarmSet, ConditionKind
from verifold.protocol.posts import Answer, Message, Reading, Task
from verifold.protocol.settings import Settings, TaskSettings
from verifold.protocol.usage import LimitWindow, SeatLimits
from verifold.runner.messages import IN_TURN, alarm_message
from verifold.society.alarms import alarm_line, due, rang_by, rings_at
from verifold.society.lifecycle import pending_alarm


def on(record: RecordBuilder, kind: ConditionKind, threshold: float, minutes: float = 0) -> AlarmSet:
    """Add bo's alarm on one condition of the record, with a time of `minutes` beside it."""
    seq = len(record.events) + 1
    condition = AlarmCondition(kind=kind, threshold=threshold)
    alarm = AlarmSet(seq=seq, at=record.at(seq), agent='bo', minutes=minutes, conditions=(condition,), stays=True)
    record.events.append(alarm)
    return alarm


def window(percent: float) -> SeatLimits:
    return SeatLimits(windows=(LimitWindow(label='5-hour', used_percent=percent, resets_at=START + timedelta(days=1)),))


def rings_once(record: RecordBuilder, alarm: AlarmSet) -> None:
    """Check that the turn that starts with the alarm's ring spends it."""
    record.start('bo', seen=0, rang=alarm.seq)
    assert pending_alarm(record.board(), 'bo') is None


def test_an_alarm_on_the_age_of_the_reading_rings_when_the_reading_is_that_old_and_a_new_reading_moves_it() -> None:
    record = lab()
    alarm = on(record, 'reading_hours', 2)
    board = record.board()
    # Without a reading, the age counts from the lab's opening.
    assert rings_at(board, alarm) == START + timedelta(hours=2)
    record.post(Reading(id='p-1', thread='t-1', author='ada', text='An answer is a sort that holds on real data.'))
    read = record.board()
    newest = read.posts[-1].at

    assert rings_at(read, alarm) == newest + timedelta(hours=2)
    assert rang_by(read, alarm, newest + timedelta(hours=1)) is None
    assert rang_by(read, alarm, newest + timedelta(hours=2)) == alarm.conditions[0]
    rings_once(record, alarm)


def test_an_alarm_on_the_budget_rings_at_the_end_of_the_turn_that_spent_its_share_and_not_before() -> None:
    record = lab().budget(1_000)
    alarm = on(record, 'budget_percent', 50)
    record.turn('ada', tokens=300)
    assert rings_at(record.board(), alarm) is None

    record.turn('cy', tokens=300)
    board = record.board()
    spent = board.turns[-1].at
    assert rings_at(board, alarm) == spent
    assert rang_by(board, alarm, spent) == alarm.conditions[0]
    message = alarm_message(alarm, cause=alarm.conditions[0])
    assert message.endswith('has rung: the lab spent 50 percent of its budget.')
    rings_once(record, alarm)
    # A lab without a budget meets the condition never.
    assert due(lab().board(), alarm.conditions[0], START) is None


def test_an_alarm_on_a_usage_limit_rings_at_the_report_that_reaches_its_percent() -> None:
    record = lab().limits('cy', window(70))
    alarm = on(record, 'limit_percent', 80)
    assert rings_at(record.board(), alarm) is None

    record.limits('cy', window(85))
    board = record.board()
    assert rings_at(board, alarm) == board.seat_limits[-1].at
    # A refusal of the provider meets it too.
    refused = lab().limits('ada', SeatLimits(status='reached'))
    assert due(refused.board(), alarm.conditions[0], START + timedelta(hours=1)) is not None
    rings_once(record, alarm)


def test_an_alarm_on_a_request_that_waits_for_the_person_rings_after_its_minutes_and_ends_with_the_answer() -> None:
    record = lab()
    alarm = on(record, 'request_minutes', 20)
    assert rings_at(record.board(), alarm) is None

    record.permission('p-1', 'bo')
    asked = record.board()
    assert rings_at(asked, alarm) == asked.posts[-1].at + timedelta(minutes=20)
    answered = record.copy().post(
        Answer(id='p-2', thread='t-1', author='person', text='Allow once', reply_to='p-1', choice='Allow once')
    )
    assert rings_at(answered.board(), alarm) is None
    rings_once(record, alarm)


def test_an_alarm_on_a_task_without_an_owner_counts_from_its_post_and_from_the_end_of_its_last_claim() -> None:
    record = lab().settings(Settings(tasks=TaskSettings(lease_minutes=1)))
    alarm = on(record, 'task_minutes', 30)
    record.post(
        Task(id='p-1', thread='t-1', author='ada', text='Rerun the tail.', output='A table.', bounds='One hour.')
    )
    posted = record.board().posts[-1].at
    assert rings_at(record.board(), alarm) == posted + timedelta(minutes=30)

    record.claim('bo', 'p-1')
    claimed = record.board()
    # While a claim stands, the task has an owner.
    assert rings_at(claimed, alarm, claimed.claims[-1].at + timedelta(seconds=30)) is None
    until = claimed.claims[-1].at + timedelta(minutes=1)
    record.post(Message(id='p-2', thread='t-1', author='ada', text='Waiting for the tail.'))
    record.lapse('bo', 'p-1', until)
    assert rings_at(record.board(), alarm, until + timedelta(minutes=1)) == until + timedelta(minutes=30)
    rings_once(record, alarm)


def test_an_alarm_rings_at_the_first_of_its_time_and_its_conditions_and_never_before_it_was_set() -> None:
    record = lab().limits('cy', window(90))
    both = on(record, 'limit_percent', 80, minutes=60)
    board = record.board()

    # The report came before the alarm, so the condition rings it from the alarm's own time, when its turn ends.
    assert rings_at(board, both) == both.at
    assert alarm_line(board, 'bo') is not None
    late = alarm_message(both, IN_TURN, rang_by(board, both, both.at))
    assert late.endswith('The record met it while you were in a turn, so it rings now.')
    # With no condition met, the time rings it, and the message names the minutes.
    timed = on(lab(), 'budget_percent', 90, minutes=15)
    assert rang_by(lab().board(), timed, timed.at + timedelta(minutes=15)) is None
    # Zero minutes with a condition is an alarm, and zero minutes with none cancels it.
    assert pending_alarm(board, 'bo') == both


@pytest.mark.parametrize(('kind', 'threshold'), [('budget_percent', 0), ('limit_percent', 101), ('task_minutes', 0)])
def test_a_condition_takes_a_threshold_within_its_bounds(kind: ConditionKind, threshold: float) -> None:
    with pytest.raises(ValidationError, match='The threshold of'):
        AlarmCondition(kind=kind, threshold=threshold)


def test_the_board_adds_no_condition_and_a_message_of_the_person_rings_no_alarm() -> None:
    record = lab()
    alarm = on(record, 'request_minutes', 5)
    record.post(Message(id='p-1', thread='t-1', author='person', text='How far is the lab?'))
    # A post of the person is no request that waits, so the alarm has no time.
    assert rings_at(record.board(), alarm) is None
    assert alarm.conditions == (AlarmCondition(kind='request_minutes', threshold=5),)
