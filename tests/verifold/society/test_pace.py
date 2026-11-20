from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.moves import CapMove, PauseMove, ResumeMove
from verifold.protocol.settings import PaceSettings, Settings
from verifold.protocol.usage import LimitWindow, SeatLimits
from verifold.society.coordinator import power_covers
from verifold.society.errors import RejectedEvent
from verifold.society.pace import (
    cap_of,
    check_pace_target,
    hold,
    limits_of,
    near_limit,
    pause_line,
    pause_of,
    seats_near_limit,
    spent_this_hour,
)

WHY = 'No release before then.'


def led() -> RecordBuilder:
    """A lab whose coordinator `ada` holds the power for pace, with the conversation `t-2`."""
    return lab().coordinator('ada').power('pace', 'ada').thread('t-2', 'ada', conversation=True)


def by_coordinator(builder: RecordBuilder, post_id: str, move: CapMove | PauseMove | ResumeMove) -> RecordBuilder:
    """Add the coordinator's request for a move of pace, its own yes, and the move."""
    return builder.request(post_id, 'ada', move).answered(post_id, by='ada').pace(move, by='ada', request=post_id)


def test_the_coordinators_pause_holds_a_seat_and_the_coordinator_resumes_only_its_own() -> None:
    pause = PauseMove(agent='bo', why=WHY)
    builder = by_coordinator(led(), 'p-1', pause)
    board = builder.board()
    now = builder.at(board.seq)

    held = hold(board, 'bo', now)
    assert held is not None
    assert (held.kind, held.by, held.until) == ('paused', 'ada', None)
    line = pause_line(board, 'bo', now)
    assert line is not None
    assert (line.by, line.why) == ('ada', WHY)
    resumed = by_coordinator(builder.copy(), 'p-2', ResumeMove(agent='bo', why='The release is out.')).board()
    assert pause_of(resumed, 'bo', now + timedelta(minutes=5)) is None

    # The person's own pause stands: the power does not cover its end, and the record refuses the coordinator's.
    person = builder.copy().pace(PauseMove(agent='cy'))
    resume = ResumeMove(agent='cy', why='Go on.')
    assert not power_covers(person.board(), resume, now + timedelta(minutes=5))
    with pytest.raises(RejectedEvent, match='only the person resumes it'):
        by_coordinator(person, 'p-2', resume).board()


def test_a_request_of_pace_that_does_not_lower_waits_for_the_person_and_a_yes_makes_it_the_persons() -> None:
    builder = led().pace(PauseMove(agent='bo'))
    resume = ResumeMove(agent='bo', why='The release is out.')
    board = builder.request('p-1', 'ada', resume).board()

    assert not power_covers(board, resume, builder.at(board.seq))
    with pytest.raises(RejectedEvent, match='only lowers'):
        builder.copy().answered('p-1', by='ada').board()
    made = builder.answered('p-1').pace(resume, request='p-1').board()
    assert pause_of(made, 'bo', builder.at(made.seq)) is None
    assert made.paces[-1].by == 'person'


def test_a_move_of_the_person_replaces_the_coordinators_of_the_same_kind() -> None:
    builder = led().pace(CapMove(tokens_per_hour=1_000))
    by_coordinator(builder, 'p-1', CapMove(tokens_per_hour=500, why='Spend slower.'))
    by_coordinator(builder, 'p-2', PauseMove(agent='bo', why=WHY))

    lowered = builder.board()
    capped = cap_of(lowered, None)
    assert capped is not None
    assert (capped.tokens, capped.by, capped.why) == (500, 'ada', 'Spend slower.')

    raised = builder.copy().pace(CapMove(tokens_per_hour=2_000)).pace(ResumeMove(agent='bo')).board()
    assert cap_of(raised, None) == type(capped)(tokens=2_000, by='person')
    assert pause_of(raised, 'bo', START + timedelta(hours=1)) is None
    assert cap_of(builder.copy().pace(CapMove()).board(), None) is None


@pytest.mark.parametrize(
    ('move', 'refusal'),
    [
        (CapMove(tokens_per_hour=20_000, why='More.'), "above the lab's budget"),
        (CapMove(agent='bo', tokens_per_hour=2_000, why='More.'), "above the person's limit of 1,000 for bo"),
        (CapMove(agent='cy', tokens_per_hour=6_000, why='More.'), "above the person's limit of 5,000 for the lab"),
        (CapMove(agent='cy', why='Back.'), 'No limit of the coordinator stands on cy'),
        (ResumeMove(agent='cy', why='Go on.'), 'No pause of the coordinator stands on cy'),
    ],
)
def test_the_coordinator_only_lowers_what_the_person_granted(move: CapMove | ResumeMove, refusal: str) -> None:
    builder = led().budget(10_000).pace(CapMove(agent='bo', tokens_per_hour=1_000))
    builder.pace(CapMove(tokens_per_hour=5_000)).pace(PauseMove(agent='cy'), by='person')
    builder.pace(ResumeMove(agent='cy'))

    with pytest.raises(RejectedEvent, match=refusal):
        by_coordinator(builder.copy(), 'p-1', move).board()
    lower = by_coordinator(builder.copy(), 'p-1', CapMove(agent='bo', tokens_per_hour=800, why='Less.')).board()
    found = cap_of(lower, 'bo')
    assert found is not None
    assert found.tokens == 800


def test_the_record_takes_a_move_of_pace_of_the_coordinator_only_after_its_request_and_yes() -> None:
    builder = led()
    move = PauseMove(agent='bo', why=WHY)

    with pytest.raises(RejectedEvent, match='after its request'):
        builder.copy().pace(move, by='ada').board()
    with pytest.raises(RejectedEvent, match='just after its yes'):
        builder.copy().request('p-1', 'ada', move).pace(move, by='ada', request='p-1').board()
    other = PauseMove(agent='cy', why=WHY)
    with pytest.raises(RejectedEvent, match='just after its yes'):
        builder.copy().request('p-1', 'ada', move).answered('p-1', by='ada').pace(
            other, by='ada', request='p-1'
        ).board()
    with pytest.raises(RejectedEvent, match='why'):
        builder.copy().request('p-1', 'ada', PauseMove(agent='bo')).board()


def test_a_pause_until_a_time_ends_by_itself_and_ends_after_the_move() -> None:
    builder = lab()
    ends = builder.at(len(builder.events) + 1) + timedelta(minutes=30)
    board = builder.copy().pace(PauseMove(agent='bo', until=ends)).board()

    assert hold(board, 'bo', ends - timedelta(minutes=1)) is not None
    assert hold(board, 'bo', ends) is None
    with pytest.raises(RejectedEvent, match='end before now'):
        builder.copy().pace(PauseMove(agent='bo', until=START)).board()
    with pytest.raises(RejectedEvent, match='is not paused'):
        builder.copy().pace(ResumeMove(agent='bo')).board()


def test_a_limit_of_tokens_per_hour_counts_the_turns_that_ended_in_the_hour() -> None:
    builder = lab().desk('dee').turn('bo', tokens=300).turn('cy', tokens=200).turn('dee', tokens=600)
    builder.pace(CapMove(agent='bo', tokens_per_hour=300)).pace(CapMove(tokens_per_hour=1_000))
    board = builder.board()
    now = builder.at(board.seq)

    assert (spent_this_hour(board, 'bo', now), spent_this_hour(board, None, now)) == (300, 1_100)
    held = hold(board, 'bo', now)
    assert held is not None
    assert (held.kind, held.tokens, held.until) == ('seat', 300, START + timedelta(hours=1))
    lab_held = hold(board, 'cy', now)
    assert lab_held is not None
    assert (lab_held.kind, lab_held.tokens) == ('lab', 1_000)
    # The desk's turns count toward the lab's limit, and the desk takes none.
    assert hold(board, 'dee', now) is None
    # The next hour starts from zero.
    assert hold(board, 'cy', START + timedelta(hours=1)) is None


def test_the_coordinators_share_holds_whoever_holds_the_seat() -> None:
    builder = lab().settings(Settings(pace=PaceSettings(coordinator_tokens_per_hour=500))).coordinator('ada')
    builder.turn('ada', tokens=500).turn('bo', tokens=900)
    board = builder.board()
    now = builder.at(board.seq)

    held = hold(board, 'ada', now)
    assert held is not None
    assert (held.kind, held.tokens, held.by) == ('seat', 500, 'person')
    assert hold(board, 'bo', now) is None
    moved = builder.copy().coordinator('bo').board()
    assert (hold(moved, 'ada', now), getattr(hold(moved, 'bo', now), 'kind', None)) == (None, 'seat')
    unlimited = builder.copy().settings(Settings(pace=PaceSettings(coordinator_tokens_per_hour=0))).board()
    assert cap_of(unlimited, 'ada') is None


def test_the_desk_and_an_invited_agent_take_no_pause_and_no_limit() -> None:
    board = lab().desk('dee').join('gus', harness='guest').leave('cy').board()

    for agent, refusal in (('dee', "desk's seat"), ('gus', 'runs by itself'), ('cy', 'not an agent'), ('zed', 'not')):
        with pytest.raises(RejectedEvent, match=refusal):
            check_pace_target(board, PauseMove(agent=agent))
    check_pace_target(board, CapMove(tokens_per_hour=10))


def test_a_seats_limits_leave_out_a_window_that_started_again_and_count_toward_the_seats_near_a_limit() -> None:
    later = START + timedelta(hours=5)
    five = LimitWindow(label='5-hour', used_percent=91, resets_at=later)
    week = LimitWindow(label='weekly', used_percent=40, resets_at=later + timedelta(days=5))
    builder = lab().limits('bo', SeatLimits(windows=(five, week))).limits('cy', SeatLimits(status='reached'))
    board = builder.board()

    assert limits_of(board, 'bo', START) == SeatLimits(windows=(five, week))
    assert limits_of(board, 'bo', later) == SeatLimits(windows=(week,))
    assert limits_of(board, 'ada', START) is None
    assert (near_limit(None), near_limit(SeatLimits(windows=(week,)))) == (False, False)
    assert (seats_near_limit(board, START), seats_near_limit(board, later)) == (2, 1)
    with pytest.raises(RejectedEvent, match='whose harness Verifold runs'):
        builder.copy().join('gus', harness='guest').limits('gus', SeatLimits()).board()
