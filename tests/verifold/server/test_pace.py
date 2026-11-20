from datetime import timedelta

import pytest
from pydantic import ValidationError

from verifold.protocol.events import PaceSet, RequestAnswered, TurnSummary
from verifold.protocol.join import MoveForm
from verifold.protocol.moves import CapMove, PauseMove, ResumeMove
from verifold.protocol.usage import LimitWindow, SeatLimits, Usage
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.society.pace import pause_of
from verifold.store.record_file import RecordFile

WHY = 'No release before then.'


@pytest.fixture
async def led(lab: Lab) -> Lab:
    """The `lab` fixture with ada as its coordinator."""
    await lab.set_coordinator('ada', 'person')
    return lab


def test_the_request_tool_names_a_move_of_pace_in_its_flat_form() -> None:
    until = '2026-11-06T16:30:00Z'

    assert MoveForm(move='pause', agent='bo', until=until, why=WHY).to_move() == PauseMove.model_validate(
        {'agent': 'bo', 'until': until, 'why': WHY}
    )
    assert MoveForm(move='cap', tokens_per_hour=5_000, why=WHY).to_move() == CapMove(tokens_per_hour=5_000, why=WHY)
    with pytest.raises(ValidationError):
        MoveForm(move='resume', agent='bo', tokens_per_hour=5, why=WHY).to_move()


async def test_a_move_of_pace_under_the_power_takes_effect_at_once_and_keeps_its_why(
    led: Lab, record_file: RecordFile
) -> None:
    await led.set_power('pace', on=True)

    asked = await led.request(PauseMove(agent='bo', why=WHY), 'Pause bo until the release.', '', 'ada')

    answered, made = led.board.answers[-1], led.board.paces[-1]
    assert isinstance(answered, RequestAnswered)
    assert (answered.request, answered.by, answered.yes) == (asked.post.id, 'ada', True)
    assert isinstance(made, PaceSet)
    assert (made.by, made.request, made.move.why) == ('ada', asked.post.id, WHY)
    assert Lab.load(record_file).board == led.board
    with pytest.raises(RejectedEvent, match='why'):
        await led.request(PauseMove(agent='bo'), 'Pause bo.', '', 'ada')


async def test_a_request_of_pace_that_does_not_lower_waits_for_the_persons_yes(led: Lab) -> None:
    await led.set_power('pace', on=True)
    await led.set_pace(PauseMove(agent='bo'))

    asked = await led.request(ResumeMove(agent='bo', why='The release is out.'), 'Resume bo.', '', 'ada')

    assert led.board.answer_to(asked.post.id) is None
    assert pause_of(led.board, 'bo', led.now()) is not None
    await led.answer_request(asked.post.id, yes=True)
    assert led.board.paces[-1].by == 'person'
    assert pause_of(led.board, 'bo', led.now()) is None


async def test_the_brief_says_what_holds_each_seat_and_the_seats_near_a_limit(led: Lab) -> None:
    five = LimitWindow(label='5-hour', used_percent=91, resets_at=led.now() + timedelta(hours=2))
    await led.report_limits('bo', SeatLimits(windows=(five,), status='warning'))
    await led.set_pace(PauseMove(agent='bo', why=WHY))
    await led.set_pace(CapMove(tokens_per_hour=50_000))
    await led.end_turn(TurnSummary(agent='ada', seconds=1, usage=Usage(input_tokens=900, output_tokens=100)))

    mine = Member(led, 'bo').brief('')
    coordinator = Member(led, 'ada').brief('')

    assert mine.your_limits == SeatLimits(windows=(five,), status='warning')
    assert (mine.seats_near_limit, coordinator.seats_near_limit) == (1, 1)
    assert mine.your_pause is not None
    assert (mine.your_pause.by, mine.your_pause.why, mine.your_pause.until) == ('person', WHY, None)
    assert mine.your_cap is None
    assert coordinator.your_cap is not None
    assert (coordinator.your_cap.tokens_per_hour, coordinator.your_cap.share) == (10_000_000, True)
    assert (coordinator.your_cap.spent, coordinator.lab_cap and coordinator.lab_cap.spent) == (1_000, 1_000)
    (line,) = coordinator.agents
    assert (line.pause is not None, line.tokens_per_hour) == (True, None)
    # A brief leaves out what holds nothing, so a lab without limits reads as before.
    dumped = Member(led, 'ada').brief('').model_dump(mode='json')
    assert 'your_pause' not in dumped
    assert 'your_limits' not in dumped


async def test_a_seat_that_left_takes_no_report_of_its_limits(led: Lab) -> None:
    await led.leave('bo', 'person')

    with pytest.raises(RejectedEvent):
        await led.report_limits('bo', SeatLimits())
