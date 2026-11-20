from collections.abc import Callable
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from builders import START, RecordBuilder, lab
from pydantic import ValidationError

from verifold.protocol.allowances import AllowanceTerms
from verifold.protocol.events import (
    ActingSet,
    ActionDecided,
    ActionsPaused,
    AllowanceDrafted,
    AllowanceEnded,
    AllowanceStarted,
    Event,
    ModeSet,
)
from verifold.protocol.posts import Action, Message, Objection, Result
from verifold.society.allowances import checked
from verifold.society.errors import RejectedEvent

type Make = Callable[[int, datetime], Event]

TERMS = AllowanceTerms(
    holder='bo', purpose='Buy', unit='USD', per_action=Decimal(5), total=Decimal(10), ends_at=START + timedelta(hours=1)
)


def add(record: RecordBuilder, make: Make) -> RecordBuilder:
    seq, at = record._stamp()
    record.events.append(make(seq, at))
    return record


def acting() -> RecordBuilder:
    """`builders.lab` with a guest `gus`, bo's acting seat, ada's result p-1, and bo's draft a-1."""
    record = lab().join('gus', harness='guest')
    add(record, lambda seq, at: ActingSet(seq=seq, at=at, agent='bo', acting=True))
    record.post(Result(id='p-1', thread='t-1', author='ada', text='The spread is 2 points.'))
    return add(record, lambda seq, at: AllowanceDrafted(seq=seq, at=at, allowance='a-1', terms=TERMS))


def action(**changes: object) -> Action:
    fields: dict[str, object] = {
        'id': 'p-2',
        'thread': 't-1',
        'author': 'bo',
        'text': 'Buy.',
        'builds_on': ('p-1',),
        'cost': Decimal(1),
        'undoable': False,
        'offer_ends': START + timedelta(hours=2),
        'needs': 'none',
    }
    return Action.model_validate(fields | changes)


@pytest.mark.parametrize(
    ('make', 'refusal'),
    [
        (lambda seq, at: ActingSet(seq=seq, at=at, agent='zed', acting=True), 'zed is not an agent with a seat'),
        (lambda seq, at: ActingSet(seq=seq, at=at, agent='gus', acting=True), 'joined with an invitation'),
        (lambda seq, at: ModeSet(seq=seq, at=at, agent='zed', mode='auto'), 'zed is not an agent with a seat'),
        (lambda seq, at: ModeSet(seq=seq, at=at, agent='gus', mode='auto'), 'its own harness sets its mode'),
        (
            lambda seq, at: AllowanceDrafted(seq=seq, at=at, allowance='a-9', terms=TERMS),
            'The next allowance of this lab is a-2',
        ),
        (
            lambda seq, at: AllowanceDrafted(seq=seq, at=at, allowance='a-2', terms=TERMS, on='p-1'),
            'Only a draft of the desk names in `on`',
        ),
        (
            lambda seq, at: AllowanceDrafted(
                seq=seq, at=at, allowance='a-2', terms=TERMS.model_copy(update={'ends_at': START})
            ),
            'which is before the draft',
        ),
        (lambda seq, at: AllowanceStarted(seq=seq, at=at, allowance='a-9'), 'The lab has no allowance a-9'),
        (lambda seq, at: AllowanceEnded(seq=seq, at=at, allowance='a-1'), 'did not start, so it has nothing to end'),
        (lambda seq, at: ActionsPaused(seq=seq, at=at, paused=False), 'Actions are not paused'),
        (lambda seq, at: ActionDecided(seq=seq, at=at, action='p-1', yes=True, post='p-1'), 'Post p-1 is no action'),
    ],
)
def test_the_record_refuses_a_change_of_an_acting_seat_or_an_allowance_that_breaks_its_rules(
    make: Make, refusal: str
) -> None:
    with pytest.raises(RejectedEvent, match=refusal):
        add(acting(), make).board()


def test_a_seat_that_left_or_lost_its_mark_takes_no_allowance() -> None:
    gone = acting().leave('bo')
    unmarked = add(acting(), lambda seq, at: ActingSet(seq=seq, at=at, agent='bo', acting=False))

    with pytest.raises(RejectedEvent, match='bo left this lab, so its seat does not change'):
        add(gone.copy(), lambda seq, at: ActingSet(seq=seq, at=at, agent='bo', acting=True)).board()
    with pytest.raises(RejectedEvent, match='bo is no acting seat of this lab now'):
        add(unmarked, lambda seq, at: AllowanceStarted(seq=seq, at=at, allowance='a-1')).board()


def test_a_draft_whose_end_came_does_not_start() -> None:
    record = acting()
    for _ in range(61):
        record.watch('ada', 't-1')

    with pytest.raises(RejectedEvent, match='The allowance a-1 ended at 2026-11-06 13:00 UTC'):
        add(record, lambda seq, at: AllowanceStarted(seq=seq, at=at, allowance='a-1')).board()


def test_the_record_takes_an_action_only_from_an_acting_seat_with_an_offer_that_has_not_ended() -> None:
    with pytest.raises(RejectedEvent, match='ada is not an acting seat'):
        acting().post(action(author='ada')).board()
    with pytest.raises(RejectedEvent, match='which is before the action is declared'):
        acting().post(action(offer_ends=START)).board()


def test_the_persons_answer_comes_with_the_persons_reply_to_an_action_whose_author_is_in_the_lab() -> None:
    record = acting().post(action())
    unanswered = record.copy().post(Message(id='p-3', thread='t-1', author='person', text='Yes.'))
    gone = record.copy().leave('bo').post(Message(id='p-3', thread='t-1', author='person', text='Yes.', reply_to='p-2'))

    with pytest.raises(RejectedEvent, match='Post p-3 is not the post of the person that answers the action p-2'):
        add(unanswered, lambda seq, at: ActionDecided(seq=seq, at=at, action='p-2', yes=True, post='p-3')).board()
    with pytest.raises(RejectedEvent, match='bo left the lab, so nothing waits for this answer'):
        add(gone, lambda seq, at: ActionDecided(seq=seq, at=at, action='p-2', yes=True, post='p-3')).board()


def test_a_disputed_post_has_no_check_that_stands_for_an_action() -> None:
    record = acting().post(Objection(id='p-2', thread='t-1', author='cy', text='Wrong data.', reply_to='p-1'))

    assert not checked(record.board(), 'p-1', 'bo')


@pytest.mark.parametrize(
    ('changes', 'error'),
    [
        ({'unit': ' '}, 'The unit holds no text'),
        ({'unit': 'u' * 21}, 'The unit has 21 characters, and the limit is 20'),
        ({'per_action': Decimal(11)}, 'no more for one action than in total'),
        ({'total': Decimal(0)}, 'greater than 0'),
    ],
)
def test_the_terms_of_an_allowance_hold_a_unit_and_bounds_that_fit(changes: dict[str, object], error: str) -> None:
    with pytest.raises(ValidationError, match=error):
        AllowanceTerms.model_validate(TERMS.model_dump() | changes)


def test_an_action_says_why_it_waits_or_that_its_allowance_allowed_it_and_rests_on_a_post() -> None:
    with pytest.raises(ValidationError, match='or it waits for the person and says why'):
        action(needs=None)
    with pytest.raises(ValidationError, match='names in `builds_on` the posts that it rests on'):
        action(builds_on=())
