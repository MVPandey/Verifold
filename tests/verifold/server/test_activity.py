import asyncio
from datetime import UTC, datetime

from verifold.server.activity import Activity


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
