import pytest
from builders import RecordBuilder, lab

from verifold.protocol.moves import AddMove, AddSeat, RemoveMove, SeatChoice, SeatGrant
from verifold.society.coordinator import covers_now, power_covers
from verifold.society.errors import RejectedEvent
from verifold.society.spare import outside_grant, seats_left, standing_grant

MINI = SeatChoice(harness='fake', model='mini')
FULL = SeatChoice(harness='fake', model='big', mode='full-access')


def led() -> RecordBuilder:
    return lab().coordinator('ada').thread('t-2', 'ada', conversation=True)


def add(seat: AddSeat) -> AddMove:
    return AddMove(seat=seat)


def test_a_grant_covers_its_number_of_seats_of_its_kinds_and_nothing_else() -> None:
    record = led().grant(SeatGrant(seats=2, choices=(MINI, FULL)))
    board = record.board()
    at = record.at(board.seq)

    assert seats_left(board) == 2
    assert power_covers(board, add(AddSeat(harness='fake', model='mini')), at)
    # A mode comes only from a kind of the grant, and a kind names all four values.
    assert power_covers(board, add(AddSeat(harness='fake', model='big', mode='full-access')), at)
    assert not power_covers(board, add(AddSeat(harness='fake', model='big')), at)
    assert outside_grant(board, AddSeat(harness='fake', model='mini', effort='high')) == (
        'The grant of spare seats names no kind of seat with these values. It names: harness fake, model mini, effort '
        'default, mode default; harness fake, model big, effort default, mode full-access.'
    )

    record.request('p-1', 'ada', add(AddSeat(harness='fake', model='mini'))).answered('p-1', by='ada')
    record.request('p-2', 'ada', add(AddSeat(harness='fake', model='mini', fresh=True))).answered('p-2', by='ada')
    used = record.board()
    assert seats_left(used) == 0
    assert (
        outside_grant(used, AddSeat(harness='fake', model='mini'))
        == 'The 2 spare seats that the person granted are used.'
    )
    # Past the grant, the record takes the coordinator's own yes no longer.
    with pytest.raises(RejectedEvent, match=r'are used\. So only the person'):
        record.request('p-3', 'ada', add(AddSeat(harness='fake', model='mini'))).answered('p-3', by='ada').board()


def test_a_new_grant_counts_its_seats_again_and_zero_seats_take_it_back() -> None:
    record = led().grant(SeatGrant(seats=1, choices=(MINI,)))
    record.request('p-1', 'ada', add(AddSeat(harness='fake', model='mini'))).answered('p-1', by='ada')
    assert seats_left(record.board()) == 0

    assert seats_left(record.copy().grant(SeatGrant(seats=1, choices=(MINI,))).board()) == 1
    gone = record.grant(SeatGrant(seats=0)).board()
    assert (standing_grant(gone), outside_grant(gone, AddSeat(harness='fake', model='mini'))) == (
        None,
        'The person granted no spare seats.',
    )
    with pytest.raises(ValueError, match='names at least one kind of seat'):
        SeatGrant(seats=1)


def test_the_power_for_agents_adds_in_the_labs_own_mode_and_no_new_request_removes_an_agent_by_itself() -> None:
    record = led().power('agents', 'ada')
    board = record.board()
    at = record.at(board.seq)

    assert power_covers(board, add(AddSeat(harness='fake')), at)
    assert not power_covers(board, add(AddSeat(harness='fake', mode='full-access')), at)
    # The record keeps the old rule for a removal, so a record from before still loads, and no new request uses it.
    assert power_covers(board, RemoveMove(agent='bo'), at)
    assert not covers_now(board, RemoveMove(agent='bo'), at)
    assert covers_now(board, add(AddSeat(harness='fake')), at)
    # A grant and no power: a seat outside the grant waits for the person.
    granted = led().grant(SeatGrant(seats=1, choices=(MINI,))).board()
    assert not covers_now(granted, add(AddSeat(harness='fake')), at)
