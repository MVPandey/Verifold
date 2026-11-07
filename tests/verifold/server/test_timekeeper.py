import asyncio
from datetime import timedelta

from builders import until

from verifold.server.lab import Lab
from verifold.server.timekeeper import keep_time


async def test_the_timekeeper_records_each_end_and_waits_for_more_time(lab: Lab) -> None:
    keeping = asyncio.create_task(keep_time(lab))
    try:
        await asyncio.sleep(0.05)
        assert not lab.board.times

        await lab.set_time_left(timedelta(0))
        await until(lambda: lab.board.out_of_time)
        await lab.set_time_left(timedelta(hours=1))
        await asyncio.sleep(0.05)
        assert not lab.board.out_of_time

        await lab.set_time_left(timedelta(0))
        await until(lambda: lab.board.out_of_time)
    finally:
        keeping.cancel()

    assert [event.type for event in lab.board.times] == [
        'time_set',
        'time_ran_out',
        'time_set',
        'time_set',
        'time_ran_out',
    ]
