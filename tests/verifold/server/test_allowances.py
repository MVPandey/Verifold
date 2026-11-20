from datetime import timedelta
from decimal import Decimal

import pytest
from builders import START
from conftest import agent

from verifold.protocol.allowances import AllowanceTerms
from verifold.protocol.events import TurnSummary
from verifold.protocol.ids import PERSON
from verifold.protocol.join import ActRequest, PostRequest
from verifold.protocol.posts import Action, FileEvidence
from verifold.protocol.settings import ReviewerSettings, Settings
from verifold.protocol.usage import Usage
from verifold.server.actions import allowance_views
from verifold.server.lab import ACTION_YES, Lab, Said
from verifold.server.member import Member
from verifold.server.status import missed, waits
from verifold.society.allowances import allowance_line, check_action_post, in_force, stopped
from verifold.society.attention import wakes
from verifold.society.errors import RejectedEvent
from verifold.society.pace import hold
from verifold.society.views import needs_person
from verifold.store.record_file import RecordFile

RECEIPT = (FileEvidence(path='receipt.json', commit='c' * 40),)


class Clock:
    """The lab's clock, which a test moves."""

    def __init__(self) -> None:
        self.now = START

    def pass_minutes(self, minutes: float) -> None:
        self.now += timedelta(minutes=minutes)


@pytest.fixture
def clock() -> Clock:
    return Clock()


def terms(**changes: object) -> AllowanceTerms:
    fields: dict[str, object] = {
        'holder': 'bo',
        'purpose': 'Place orders on the exchange',
        'unit': 'USD',
        'per_action': Decimal(10),
        'total': Decimal(25),
        'ends_at': START + timedelta(hours=8),
    }
    return AllowanceTerms.model_validate(fields | changes)


def action(cost: str, minutes: int = 30, rests_on: tuple[str, ...] = ('p-1',)) -> ActRequest:
    return ActRequest(
        what=f'Buy at {cost}',
        cost=Decimal(cost),
        undoable=False,
        rests_on=rests_on,
        offer_ends=START + timedelta(minutes=minutes),
    )


@pytest.fixture
async def acting(record_file: RecordFile, clock: Clock) -> Lab:
    """A lab of ada, bo, and cy, where bo holds an acting seat, and ada's result p-1 opened thread t-1."""
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: clock.now)
    for name in ('ada', 'bo', 'cy'):
        await lab.join(agent(name), acting=name == 'bo')
    await lab.post(PostRequest(kind='result', text='The spread is 2 points.', new_thread='Spreads'), 'ada')
    return lab


async def started(lab: Lab, **changes: object) -> Lab:
    drafted = await lab.draft_allowance(terms(**changes))
    await lab.start_allowance(drafted.allowance)
    return lab


async def test_an_allowance_starts_only_with_the_persons_confirmation_and_the_desks_draft_allows_nothing(
    acting: Lab,
) -> None:
    await acting.join(agent('dee'), desk=True)
    said = await acting.post(PostRequest(kind='message', text='bo may buy up to $10 each.', thread='t-2'), PERSON)
    drafted = await Member(acting, 'dee').draft_allowance(said.post.id, terms())

    assert 'allows nothing until the person confirms it' in drafted
    assert in_force(acting.board, 'bo', acting.now()) is None
    assert (await Member(acting, 'bo').act(action('4'))).needs == 'none'
    view = allowance_views(acting.board, acting.now())[0]
    assert (view.state, view.by, view.on) == ('draft', 'dee', said.post.id)

    await acting.start_allowance('a-1')

    assert (await Member(acting, 'bo').act(action('4'))).allowed
    assert allowance_views(acting.board, acting.now())[0].state == 'in_force'


async def test_no_agent_drafts_an_allowance_without_the_desk_seat_and_the_persons_word(acting: Lab) -> None:
    said = await acting.post(PostRequest(kind='message', text='Go.', thread='t-1'), PERSON)

    with pytest.raises(RejectedEvent, match=r"Only the lab's desk acts on the person's word"):
        await acting.draft_allowance(terms(), on=Said(by='ada', post=said.post.id))
    with pytest.raises(RejectedEvent, match='not an acting seat'):
        await acting.draft_allowance(terms(holder='ada'))


async def test_act_is_allowed_inside_the_bounds_and_at_each_bound_and_waits_for_the_person_outside(
    acting: Lab,
) -> None:
    bo = Member(await started(acting), 'bo')

    at_one = await bo.act(action('10'))
    above_one = await bo.act(action('10.01'))
    at_total = await bo.act(action('10'))
    left = await bo.act(action('5'))
    past_total = await bo.act(action('0.000001'))

    assert (at_one.allowed, at_one.needs) == (True, None)
    assert (above_one.allowed, above_one.needs) == (False, 'per_action')
    assert (at_total.allowed, left.allowed) == (True, True)
    assert left.allowance is not None
    assert (left.allowance.drawn, left.allowance.left) == (Decimal(25), Decimal(0))
    assert (past_total.allowed, past_total.needs) == (False, 'total')


async def test_an_action_after_the_allowances_end_waits_for_the_person(acting: Lab, clock: Clock) -> None:
    bo = Member(await started(acting), 'bo')

    clock.pass_minutes(8 * 60)
    late = await bo.act(action('1', minutes=9 * 60))

    assert (late.allowed, late.needs) == (False, 'none')
    line = allowance_line(acting.board, 'bo', acting.now())
    assert line is not None
    assert not line.in_force


async def test_a_request_outlives_its_agents_turn_and_the_persons_yes_rings_the_seat(acting: Lab, clock: Clock) -> None:
    bo = Member(await started(acting), 'bo')
    asked = await bo.act(action('40'))
    await acting.end_turn(TurnSummary(agent='bo', seconds=1, usage=Usage()))
    clock.pass_minutes(20)

    (view,) = needs_person(acting.board, acting.now())
    assert (view.post.id, view.post.kind) == (asked.action, 'action')
    (wait,) = waits(acting.board, acting.now())
    assert (wait.kind, wait.what) == ('approval', 'Asks you to allow an action')

    decided = await acting.decide_action(asked.action, yes=True)

    reply = acting.board.post(decided.post)
    assert reply is not None
    assert (reply.post.author, reply.post.text, reply.post.reply_to) == (PERSON, ACTION_YES, asked.action)
    assert wakes(acting.board, 'bo', reply)
    assert needs_person(acting.board, acting.now()) == ()
    # A yes of the person draws nothing from the allowance.
    assert allowance_views(acting.board, acting.now())[0].drawn == 0


async def test_a_yes_after_the_offer_ended_decides_nothing_and_says_so(acting: Lab, clock: Clock) -> None:
    bo = Member(await started(acting), 'bo')
    asked = await bo.act(action('40', minutes=30))
    clock.pass_minutes(31)

    with pytest.raises(RejectedEvent, match='Nothing was done, and an answer decides nothing now'):
        await acting.decide_action(asked.action, yes=True)
    assert acting.board.action_decisions == ()
    assert needs_person(acting.board, acting.now()) == ()
    (gone,) = missed(acting.board, acting.now())
    assert (gone.post, gone.ended_at) == (asked.action, START + timedelta(minutes=30))


async def test_the_drawn_amount_follows_the_real_cost_of_the_newest_receipt(acting: Lab) -> None:
    bo = Member(await started(acting), 'bo')
    done = await bo.act(action('10'))

    await acting.post(
        PostRequest(
            kind='receipt', text='Filled 40 at 9c.', reply_to=done.action, thread=done.thread, cost=Decimal('3.6')
        ),
        'bo',
        RECEIPT,
    )
    line = allowance_line(acting.board, 'bo', acting.now())

    assert line is not None
    assert (line.drawn, line.left) == (Decimal('3.6'), Decimal('21.4'))
    assert (await bo.act(action('10'))).allowed
    assert (await bo.act(action('10'))).allowed


async def test_a_receipt_comes_from_the_actions_author_for_an_action_that_may_be_done(acting: Lab) -> None:
    bo = Member(await started(acting), 'bo')
    waiting = await bo.act(action('40'))
    receipt = PostRequest(kind='receipt', text='Done.', reply_to=waiting.action, thread='t-1', cost=Decimal(1))

    with pytest.raises(RejectedEvent, match='was not allowed'):
        await acting.post(receipt, 'bo', RECEIPT)
    with pytest.raises(RejectedEvent, match='is no action of yours'):
        await acting.post(receipt, 'ada', RECEIPT)


async def test_above_its_line_an_action_needs_a_check_of_its_evidence_by_another_agent(acting: Lab) -> None:
    bo = Member(await started(acting, check_above=Decimal(5)), 'bo')
    await acting.set_settings(Settings(reviewers=ReviewerSettings(seats=0)))
    # bo checks ada's result itself, and that check is no check for bo's own action.
    await acting.post(
        PostRequest(kind='check', text='Holds.', reply_to='p-1', thread='t-1', outcome='holds', method='code_read'),
        'bo',
    )

    assert (await bo.act(action('5'))).allowed
    with pytest.raises(RejectedEvent, match='None of p-1 has one that stands'):
        await bo.act(action('6'))

    await acting.post(
        PostRequest(kind='check', text='Holds.', reply_to='p-1', thread='t-1', outcome='holds', method='rerun'), 'cy'
    )

    assert (await bo.act(action('6'))).allowed


async def test_the_coordinator_holds_no_acting_seat_and_so_no_allowance(acting: Lab) -> None:
    await acting.set_coordinator('ada', PERSON)

    with pytest.raises(RejectedEvent, match='An acting seat is not the coordinator'):
        await acting.set_acting('ada', acting=True)
    with pytest.raises(RejectedEvent, match='an acting seat takes no coordinator seat'):
        await acting.set_coordinator('bo', PERSON)
    with pytest.raises(RejectedEvent, match='not an acting seat'):
        await acting.draft_allowance(terms(holder='ada'))
    with pytest.raises(RejectedEvent, match='ada is not an acting seat'):
        await Member(acting, 'ada').act(action('1'))


async def test_actions_that_pass_the_total_stop_the_seat_until_the_person_ends_the_allowance(acting: Lab) -> None:
    bo = Member(await started(acting), 'bo')
    done = await bo.act(action('10'))
    await acting.post(
        PostRequest(kind='receipt', text='Slipped.', reply_to=done.action, thread=done.thread, cost=Decimal(26)),
        'bo',
        RECEIPT,
    )

    held = hold(acting.board, 'bo', acting.now())
    assert held is not None
    assert (held.kind, held.by, held.until) == ('allowance', 'bo', None)
    assert allowance_views(acting.board, acting.now())[0].stopped
    assert (await bo.act(action('1'))).needs == 'total'

    await acting.end_allowance('a-1')

    assert stopped(acting.board, 'bo') is None
    assert hold(acting.board, 'bo', acting.now()) is None
    assert allowance_views(acting.board, acting.now())[0].state == 'ended'


async def test_a_later_receipt_with_a_lower_cost_does_not_lift_the_stop(acting: Lab) -> None:
    bo = Member(await started(acting), 'bo')
    done = await bo.act(action('10'))
    slipped = PostRequest(kind='receipt', text='Slipped.', reply_to=done.action, thread=done.thread, cost=Decimal(26))
    await acting.post(slipped, 'bo', RECEIPT)
    lower = slipped.model_copy(update={'text': 'It cost 1 after all.', 'cost': Decimal(1)})
    await acting.post(lower, 'bo', RECEIPT)

    line = allowance_line(acting.board, 'bo', acting.now())
    held = hold(acting.board, 'bo', acting.now())
    assert line is not None
    assert held is not None
    assert (line.drawn, line.stopped, held.kind) == (Decimal(1), True, 'allowance')
    # Every action of the stopped seat waits for the person, also one that fits what the allowance has left.
    assert (await bo.act(action('1'))).needs == 'total'


async def test_a_new_allowance_for_the_seat_lifts_the_stop_and_counts_from_zero(acting: Lab) -> None:
    bo = Member(await started(acting), 'bo')
    done = await bo.act(action('10'))
    await acting.post(
        PostRequest(kind='receipt', text='Slipped.', reply_to=done.action, thread=done.thread, cost=Decimal(26)),
        'bo',
        RECEIPT,
    )

    await started(acting, total=Decimal(50))

    assert stopped(acting.board, 'bo') is None
    states = [(view.allowance, view.state) for view in allowance_views(acting.board, acting.now())]
    assert states == [('a-2', 'in_force'), ('a-1', 'replaced')]
    assert (await bo.act(action('10'))).allowed


async def test_while_the_person_paused_actions_act_answers_so_and_records_nothing(acting: Lab) -> None:
    bo = Member(await started(acting), 'bo')
    await acting.pause_actions(paused=True)
    posts = len(acting.board.posts)

    with pytest.raises(RejectedEvent, match='The person paused every action at 2026-11-06 12:00 UTC'):
        await bo.act(action('1'))
    assert len(acting.board.posts) == posts
    await acting.pause_actions(paused=True)
    assert len(acting.board.pauses) == 1

    await acting.pause_actions(paused=False)

    assert (await bo.act(action('1'))).allowed


async def test_an_ended_allowance_allows_nothing_and_a_second_end_is_refused(acting: Lab) -> None:
    bo = Member(await started(acting), 'bo')
    await acting.end_allowance('a-1')

    assert (await bo.act(action('1'))).needs == 'none'
    with pytest.raises(RejectedEvent, match='ended the allowance a-1 already'):
        await acting.end_allowance('a-1')
    with pytest.raises(RejectedEvent, match='started already'):
        await acting.start_allowance('a-1')


async def test_only_the_newest_draft_for_a_seat_starts(acting: Lab) -> None:
    await acting.draft_allowance(terms())
    await acting.draft_allowance(terms(total=Decimal(40)))

    with pytest.raises(RejectedEvent, match='The draft a-2 for bo replaces a-1'):
        await acting.start_allowance('a-1')
    assert [view.allowance for view in allowance_views(acting.board, acting.now())] == ['a-2']


async def test_an_ask_that_ends_moves_from_what_waits_to_what_the_person_missed(acting: Lab, clock: Clock) -> None:
    ends = START + timedelta(minutes=10)
    await acting.post(PostRequest(kind='ask', text='Buy now?', thread='t-1', mentions=(PERSON,), ends_at=ends), 'ada')

    assert [view.post.text for view in needs_person(acting.board, acting.now())] == ['Buy now?']
    clock.pass_minutes(10)

    assert needs_person(acting.board, acting.now()) == ()
    (gone,) = missed(acting.board, acting.now())
    assert (gone.what, gone.ended_at, gone.kind) == ('Buy now?', ends, 'answer')
    with pytest.raises(RejectedEvent, match='which is before it is posted'):
        await acting.post(PostRequest(kind='ask', text='Late?', thread='t-1', ends_at=ends), 'ada')


async def test_an_action_rests_on_posts_and_the_board_sets_its_answer(acting: Lab) -> None:
    await started(acting)

    with pytest.raises(RejectedEvent, match='Post p-9 does not exist'):
        await acting.act('bo', action('1', rests_on=('p-9',)))
    with pytest.raises(ValueError, match='goes through the `act` tool'):
        PostRequest(kind='action', text='Buy.', thread='t-1')
    forged = Action(
        id='p-9',
        thread='t-1',
        author='bo',
        text='Buy.',
        builds_on=('p-1',),
        cost=Decimal(40),
        undoable=False,
        offer_ends=START + timedelta(hours=1),
        allowance='a-1',
        allowed=True,
    )
    with pytest.raises(RejectedEvent, match="carries the board's own answer"):
        check_action_post(acting.board, acting.board.posts[-1].model_copy(update={'post': forged}))


async def test_the_acting_seats_brief_has_its_allowance_and_the_pause_and_no_other_brief_has_either(
    acting: Lab,
) -> None:
    bo = Member(await started(acting), 'bo')
    await bo.act(action('4'))
    await acting.pause_actions(paused=True)

    mine, theirs = bo.brief(''), Member(acting, 'ada').brief('')

    assert mine.allowance is not None
    assert (mine.allowance.allowance, mine.allowance.drawn, mine.allowance.left) == ('a-1', Decimal(4), Decimal(21))
    assert (mine.allowance.in_force, mine.allowance.stopped, mine.actions_paused) == (True, False, True)
    assert (theirs.allowance, theirs.actions_paused) == (None, False)
    assert 'allowance' not in theirs.model_dump_json()
    assert mine.your_line is not None
    assert mine.your_line.acting
    assert [(line.id, line.acting) for line in theirs.agents] == [('bo', True), ('cy', False)]
