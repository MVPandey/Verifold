import asyncio
from datetime import timedelta

import pytest
from builders import START, until
from conftest import agent
from mcp import Client

from verifold.protocol.join import ClaimResult, PostRequest
from verifold.protocol.settings import Settings, TaskSettings
from verifold.server.app_api import _cards
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.server.timekeeper import keep_claims
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile

LEASE = 10

TASK = {
    'kind': 'task',
    'text': 'Rerun the tail test on the 2025 data.',
    'output': 'One table with the five runs.',
    'bounds': 'The 2025 data only, and 20 minutes at most.',
}


class Clock:
    """The lab's clock, which a test moves."""

    def __init__(self) -> None:
        self.now = START

    def pass_minutes(self, minutes: float) -> None:
        self.now += timedelta(minutes=minutes)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def tasked(record_file: RecordFile, clock: Clock) -> Lab:
    """A lab of ada, bo, and cy with a lease of `LEASE` minutes, and ada's task p-1, which opened thread t-1."""
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: clock.now)
    for name in ('ada', 'bo', 'cy'):
        await lab.join(agent(name))
    await lab.set_settings(Settings(tasks=TaskSettings(lease_minutes=LEASE)))
    await lab.post(PostRequest.model_validate(TASK | {'new_thread': 'The tail test'}), 'ada')
    return lab


async def test_two_agents_that_claim_one_task_at_the_same_moment_get_one_owner(tasked: Lab) -> None:
    outcomes = await asyncio.gather(
        Member(tasked, 'bo').claim('p-1'), Member(tasked, 'cy').claim('p-1'), return_exceptions=True
    )

    won = [outcome for outcome in outcomes if isinstance(outcome, ClaimResult)]
    lost = [outcome for outcome in outcomes if isinstance(outcome, RejectedEvent)]
    assert (len(won), len(lost)) == (1, 1)
    (claim,) = tasked.board.claims
    assert str(lost[0]).startswith(f'{claim.agent} holds task p-1 since 2026-11-06 12:00 UTC, until')
    assert (won[0].task, won[0].output, won[0].held_until) == (
        'p-1',
        'One table with the five runs.',
        START + timedelta(minutes=LEASE),
    )


async def test_the_lab_records_the_lapse_of_a_claim_in_the_step_of_the_next_claim(tasked: Lab, clock: Clock) -> None:
    await Member(tasked, 'bo').claim('p-1')
    clock.pass_minutes(4)
    # bo's post in the thread that the task opened starts the lease again.
    await tasked.post(PostRequest(kind='message', text='Run 1 is in.', thread='t-1'), 'bo')
    clock.pass_minutes(LEASE - 1)

    with pytest.raises(RejectedEvent, match='until 2026-11-06 12:14 UTC'):
        await Member(tasked, 'cy').claim('p-1')
    assert tasked.board.lapses == ()
    clock.pass_minutes(1)
    claimed = await Member(tasked, 'cy').claim('p-1')

    (lapsed,) = tasked.board.lapses
    assert (lapsed.agent, lapsed.task, lapsed.until) == ('bo', 'p-1', START + timedelta(minutes=4 + LEASE))
    # The record says that the claim lapsed just before the next one.
    assert lapsed.seq == tasked.board.claims[-1].seq - 1
    assert claimed.held_since == clock.now


async def test_the_keeper_of_claims_waits_while_a_lease_stands_and_records_a_lapse_at_its_first_look(
    tasked: Lab, clock: Clock
) -> None:
    keeping = asyncio.create_task(keep_claims(tasked))
    try:
        await Member(tasked, 'bo').claim('p-1')
        await asyncio.sleep(0.05)
        assert tasked.board.lapses == ()
    finally:
        keeping.cancel()
    # The lease ends while no keeper runs, as when Verifold was stopped, and the next keeper records the lapse.
    clock.pass_minutes(LEASE)
    keeping = asyncio.create_task(keep_claims(tasked))
    try:
        await until(lambda: bool(tasked.board.lapses))
        await asyncio.sleep(0.05)
    finally:
        keeping.cancel()

    assert [(lapse.agent, lapse.until) for lapse in tasked.board.lapses] == [('bo', START + timedelta(minutes=LEASE))]


async def test_an_agent_claims_renews_and_hands_back_a_task_over_the_board(tasked: Lab, clock: Clock) -> None:
    hand_back = {
        'kind': 'hand_back',
        'text': 'Ran all five.',
        'reply_to': 'p-1',
        'findings': 'The tail holds in four.',
        'concerns': '',
        'deviations': 'None.',
    }
    async with Client(join_server(lambda _: Member(tasked, 'bo'))) as client:
        claimed = await client.call_tool('claim', {'task': 'p-1'})
        clock.pass_minutes(3)
        renewed = await client.call_tool('claim', {'task': 'p-1'})
        own = await client.call_tool('claim', {'task': 'p-9'})
        handed = await client.call_tool('post', hand_back)
    async with Client(join_server(lambda _: Member(tasked, 'cy'))) as client:
        refused = await client.call_tool('claim', {'task': 'p-1'})

    assert claimed.structured_content is not None
    assert renewed.structured_content is not None
    assert handed.structured_content is not None
    assert (claimed.structured_content['bounds'], claimed.structured_content['held_until']) == (
        'The 2025 data only, and 20 minutes at most.',
        '2026-11-06T12:10:00Z',
    )
    assert renewed.structured_content['held_until'] == '2026-11-06T12:13:00Z'
    assert own.is_error
    # An empty part of the hand-back counts as left out.
    post = handed.structured_content['post']
    assert (post['kind'], post['findings'], post['concerns'], post['thread']) == (
        'hand_back',
        'The tail holds in four.',
        '',
        't-1',
    )
    assert refused.is_error
    assert 'bo handed task p-1 back with p-2, and the hand-back waits' in str(refused.content)


async def test_the_card_of_a_thread_says_who_holds_each_task_and_which_one_nobody_holds(
    tasked: Lab, clock: Clock
) -> None:
    await tasked.post(PostRequest.model_validate(TASK | {'thread': 't-1', 'text': 'Chart the runs.'}), 'ada')
    await tasked.post(PostRequest.model_validate(TASK | {'thread': 't-1', 'text': 'Not needed.'}), 'ada')
    await tasked.post(PostRequest(kind='ruled_out', text='Dropped it.', thread='t-1', reply_to='p-3'), 'ada')
    await Member(tasked, 'bo').claim('p-1')
    await Member(tasked, 'cy').claim('p-2')
    await tasked.post(PostRequest(kind='hand_back', text='Charted.', thread='t-1', reply_to='p-2'), 'cy')
    await tasked.post(PostRequest.model_validate(TASK | {'thread': 't-1', 'text': 'Check the loader.'}), 'ada')
    clock.pass_minutes(2)

    (card,) = _cards(tasked)

    # A withdrawn task is not on the card. The others say who is on them, and until when.
    assert [(task.task, task.state, task.text, task.agent, task.until) for task in card.tasks] == [
        ('p-1', 'claimed', 'Rerun the tail test on the 2025 data.', 'bo', START + timedelta(minutes=LEASE)),
        ('p-2', 'handed_back', 'Chart the runs.', 'cy', None),
        ('p-6', 'open', 'Check the loader.', None, None),
    ]
