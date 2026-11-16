import asyncio
from datetime import timedelta

from builders import until

from verifold.protocol.join import PostRequest
from verifold.server.lab import Lab
from verifold.server.timekeeper import keep_rounds, keep_time


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


async def test_the_keeper_of_rounds_waits_while_a_round_is_open_and_records_nothing_without_one(lab: Lab) -> None:
    keeping = asyncio.create_task(keep_rounds(lab))
    try:
        await lab.post(PostRequest(kind='round', text='Best bet?', thread='t-1', minutes=10), 'ada')
        # The round's time is minutes away, so the keeper waits and records nothing.
        await asyncio.sleep(0.05)
        assert not lab.board.round_closes
        await lab.post(PostRequest(kind='ruled_out', text='Enough.', thread='t-1', reply_to='p-2'), 'ada')
        await asyncio.sleep(0.05)
        assert [close.why for close in lab.board.round_closes] == ['opener']
    finally:
        keeping.cancel()
