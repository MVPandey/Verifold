import asyncio
from datetime import UTC, datetime

from verifold.protocol.ids import PERSON
from verifold.protocol.join import PostRequest
from verifold.server.activity import Activity
from verifold.server.lab import Lab
from verifold.server.member import Member


async def test_activity_starts_unknown_and_records_each_change() -> None:
    activity = Activity()

    assert activity.of('ada').state == 'starting'
    await activity.set('ada', 'working', 'x' * 500)

    assert (activity.of('ada').state, len(activity.of('ada').detail), activity.version) == ('working', 200, 1)
    assert activity.of('ada').at is not None


async def test_waiters_wake_on_a_change_or_time_out() -> None:
    activity = Activity()
    waiting = asyncio.create_task(activity.wait_for_change(0, timeout=5))
    await asyncio.sleep(0)
    await activity.set('ada', 'idle')

    async with asyncio.timeout(1):
        await waiting
    await activity.wait_for_change(activity.version, timeout=0.01)


async def test_a_guest_is_invited_until_its_first_call_and_listens_while_it_waits() -> None:
    activity = Activity(clock=lambda: datetime(2026, 11, 6, 12, tzinfo=UTC))
    await activity.invite('guest', 'invited')
    await activity.invite('back', 'here')
    await activity.invite('lost', 'void')

    # The record shows that `back` called before this server started. Nobody saw when.
    assert [(activity.of(agent).state, activity.of(agent).at) for agent in ('guest', 'back')] == [
        ('invited', None),
        ('here', None),
    ]
    async with activity.call('guest', 'wait'):
        during = activity.of('guest').state
    after_wait = activity.of('guest')
    async with activity.call('back', 'brief'):
        pass

    assert (during, after_wait.state, after_wait.at is not None) == ('listening', 'here', True)
    assert activity.of('back').at is not None
    # Verifold holds no token digest for `lost`, so it can make no call.
    assert activity.of('lost').state == 'void'


async def test_a_call_of_an_agent_that_verifold_started_changes_nothing() -> None:
    activity = Activity()
    await activity.set('ada', 'working', 'Runs the benchmark')

    async with activity.call('ada', 'wait'):
        during = activity.of('ada')

    assert (during.state, during.detail, activity.version) == ('working', 'Runs the benchmark', 1)


async def test_a_call_that_carried_a_post_of_the_person_to_its_agent_is_a_change(lab: Lab) -> None:
    activity = Activity()
    ada, bo = Member(lab, 'ada'), Member(lab, 'bo')
    activity.seat(ada)
    activity.seat(bo)
    await activity.invite('bo', 'here')
    # Every agent can read the conversation, so a line of the person's post there reaches ada as well.
    await lab.set_coordinator('bo', PERSON)
    steer = await lab.post(PostRequest(kind='message', text='Try the small models.', conversation=True), PERSON)

    # A call that brought no news changes nothing for an agent that Verifold started.
    async with activity.call('ada', 'threads'):
        pass
    quiet = activity.version
    async with activity.call('ada', 'brief'):
        ada.news()
    read = activity.version
    # A guest's call shows when it starts, and what it carried shows when it ends.
    async with activity.call('bo', 'brief'):
        bo.news()

    assert (quiet, read, activity.version) == (1, 2, 4)
    assert [heard.seq for heard in (activity.heard('ada'), activity.heard('bo')) if heard] == [steer.seq, steer.seq]
    # No seat serves an agent that never started, such as one on call that no post reached.
    assert activity.heard('cy') is None
