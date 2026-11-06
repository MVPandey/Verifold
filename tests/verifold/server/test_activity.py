import asyncio

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
