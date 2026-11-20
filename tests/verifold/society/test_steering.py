from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.join import News, SteeringFacts
from verifold.protocol.moves import AddMove, AddSeat, CapMove, PauseMove, RemoveMove, SeatChoice, SeatGrant, TimeMove
from verifold.protocol.posts import Objection, Plan, Reading, Result, Round, Task
from verifold.protocol.usage import LimitWindow, SeatLimits
from verifold.society.coordinator import check_why
from verifold.society.errors import RejectedEvent
from verifold.society.steering import move_line, moves, spare_seats, steering_facts
from verifold.society.views import brief


def result(post_id: str, thread: str, author: str, builds_on: tuple[str, ...] = ()) -> Result:
    return Result(id=post_id, thread=thread, author=author, text=f'Result {post_id}.', builds_on=builds_on)


def test_each_steering_fact_is_a_count_a_share_a_rate_or_an_age_of_the_record() -> None:
    record = lab().budget(10_000).thread('t-2', opened_by='bo', title='The tail')
    record.post(Reading(id='p-1', thread='t-1', author='ada', text='An answer is a sort that holds on real data.'))
    record.post(Round(id='p-2', thread='t-1', author='bo', text='Which line would you drop?', minutes=5))
    record.post(result('p-3', 't-1', 'ada'))
    record.post(result('p-4', 't-2', 'bo', builds_on=('p-3',)))
    record.post(result('p-5', 't-2', 'bo', builds_on=('p-4',)))
    record.post(Task(id='p-6', thread='t-1', author='ada', text='Rerun p-4.', output='A table.', bounds='One hour.'))
    record.permission('p-7', 'cy')
    record.turn('ada', tokens=1_000).turn('bo', tokens=1_000)
    record.limits('cy', SeatLimits(windows=(LimitWindow(label='5-hour', used_percent=91),)))
    board = record.board()
    now = board.turns[-1].at + timedelta(minutes=10)

    facts = steering_facts(board, now)

    assert facts == SteeringFacts(
        lines=2,
        new_lines=2,
        results=3,
        # Two of the three results are in the tail's line.
        busiest_line_share=67,
        # p-4 builds on ada's result, and p-5 only on bo's own.
        built_on_others=1,
        tokens_last_hour=2_000,
        # 8,000 tokens are left at 2,000 an hour.
        budget_hours_left=4.0,
        seats_near_limit=1,
        reading_hours_ago=0.3,
        round_hours_ago=0.3,
        unowned_tasks=1,
        waits_for_person=1,
    )
    # An hour later, the rates count nothing, and the ages grow.
    later = steering_facts(board, now + timedelta(hours=1))
    assert (later.results, later.new_lines, later.tokens_last_hour, later.budget_hours_left) == (0, 0, 0, None)
    assert (later.busiest_line_share, later.reading_hours_ago) == (None, 1.3)
    # A lab without a reading or a round has neither age.
    empty = steering_facts(lab().board(), START)
    assert (empty.reading_hours_ago, empty.round_hours_ago, empty.lines) == (None, None, 1)


def led() -> RecordBuilder:
    """A lab whose coordinator `ada` holds the powers for pace and time, with the conversation `t-2`."""
    builder = lab().coordinator('ada').power('pace', 'ada').power('time', 'ada')
    return builder.thread('t-2', 'ada', conversation=True)


def test_the_log_of_moves_holds_the_coordinators_requests_that_got_a_yes_its_rounds_and_its_readings() -> None:
    record = led()
    record.post(Reading(id='p-1', thread='t-1', author='ada', text='The question asks for speed.'))
    pause = PauseMove(agent='bo', why='No release before then.')
    record.request('p-2', 'ada', pause).answered('p-2', by='ada').pace(pause, by='ada', request='p-2')
    record.request('p-3', 'ada', RemoveMove(agent='cy'))
    record.request('p-4', 'ada', CapMove(tokens_per_hour=100, why='Slower.')).answered('p-4', yes=False)
    record.time_set(START + timedelta(hours=2))
    record.request('p-8', 'ada', TimeMove(minutes=30)).answered('p-8', by='ada')
    record.time_set(START + timedelta(hours=2, minutes=30), request='p-8')
    record.post(
        Round(id='p-5', thread='t-1', author='ada', text='What can settle by 9?', minutes=15, why='You set a goal.')
    )
    # A round of another agent is no move of the coordinator.
    record.post(Plan(id='p-6', thread='t-1', author='bo', text='I run the tail.'))
    record.post(Objection(id='p-7', thread='t-2', author='bo', text='My run needs the next hour.', reply_to='p-2'))
    board = record.board()
    now = board.posts[-1].at

    made = moves(board)
    lines = [move_line(board, move, now) for move in made]

    assert [(line.post, line.kind, line.why) for line in lines] == [
        ('p-5', 'round', 'You set a goal.'),
        # Any other move than one of pace has its reason in the request's headline.
        ('p-8', 'time', 'The lab needs it.'),
        ('p-2', 'pause', 'No release before then.'),
        # The first reading needs no why, and it is still a move of the coordinator.
        ('p-1', 'reading', ''),
    ]
    paused = lines[2]
    assert (paused.agent, paused.yes_by, paused.by, paused.disputed) == ('bo', 'ada', 'ada', True)
    assert lines[0].minutes_ago == 2
    # Every agent reads the newest moves in its brief, and the coordinator reads its steering facts too.
    theirs, its = brief(board, 'bo', News(seq=0), now=now), brief(board, 'ada', News(seq=0), now=now)
    assert ([move.post for move in theirs.moves], theirs.steering) == (['p-5', 'p-8', 'p-2', 'p-1'], None)
    assert its.steering == steering_facts(board, now)


def test_a_round_and_a_newer_reading_of_the_coordinator_say_why_and_the_first_reading_needs_none() -> None:
    board = led().post(Reading(id='p-1', thread='t-1', author='ada', text='Speed.')).board()
    round_ = Round(id='p-2', thread='t-1', author='ada', text='What now?', minutes=5)

    with pytest.raises(RejectedEvent, match='says why in one line'):
        check_why(board, round_)
    with pytest.raises(RejectedEvent, match='says why in one line'):
        check_why(board, Reading(id='p-2', thread='t-1', author='ada', text='Speed, and memory.'))
    check_why(led().board(), Reading(id='p-1', thread='t-1', author='ada', text='Speed.'))
    check_why(board, round_.model_copy(update={'why': 'Few new lines in the last hour.'}))
    # Another agent's round is no move of the coordinator.
    check_why(board, round_.model_copy(update={'author': 'bo'}))


def test_the_coordinators_brief_holds_the_grant_of_spare_seats_and_no_other_brief_does() -> None:
    kind = SeatChoice(harness='fake', model='mini')
    record = led().grant(SeatGrant(seats=2, choices=(kind,)))
    record.request('p-1', 'ada', AddMove(seat=AddSeat(harness='fake', model='mini'))).answered('p-1', by='ada')
    board = record.board()

    seats = spare_seats(board)
    assert seats is not None
    assert (seats.left, seats.of, seats.kinds) == (1, 2, (kind,))
    assert brief(board, 'ada', News(seq=0)).spare_seats == seats
    assert brief(board, 'bo', News(seq=0)).spare_seats is None
    assert [move.kind for move in moves(board)] == ['add_agent']


def test_a_cap_of_the_lab_names_no_seat_in_the_log() -> None:
    cap = CapMove(tokens_per_hour=5_000, why='Spend slower.')
    record = led().request('p-1', 'ada', cap).answered('p-1', by='ada').pace(cap, by='ada', request='p-1')
    (move,) = moves(record.board())
    assert (move.kind, move.agent, move.why) == ('cap', None, 'Spend slower.')
