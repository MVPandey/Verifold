import asyncio
from datetime import UTC, timedelta

import pytest
from builders import START

from verifold.protocol.events import Posted
from verifold.protocol.join import PostRequest
from verifold.server.lab import Lab
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile


def message(text: str, thread: str = 't-1') -> PostRequest:
    return PostRequest(kind='message', text=text, thread=thread)


async def test_a_post_can_open_its_thread_in_one_step(lab: Lab) -> None:
    posted = await lab.post(PostRequest(kind='ask', text='Which layer?', new_thread='Which layer?'), 'bo')
    board = lab.board

    assert (posted.post.id, posted.post.thread) == ('p-2', 't-2')
    assert board.threads[-1].thread.opened_by == 'bo'
    assert board.threads[-1].at == posted.at == START + timedelta(seconds=4)
    assert posted.seq == board.seq == 7


async def test_a_rejected_post_leaves_no_trace(lab: Lab, record_file: RecordFile) -> None:
    before = lab.board.seq

    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        await lab.post(PostRequest(kind='objection', text='Flawed.', thread='t-1', reply_to='p-9'), 'bo')
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        await lab.post(PostRequest(kind='message', text='Hi.', new_thread='New subject', mentions=('zed',)), 'bo')

    assert len(record_file.read()) == lab.board.seq == before
    assert len(lab.board.threads) == 1


async def test_posts_at_the_same_time_get_their_own_ids(lab: Lab) -> None:
    posted = await asyncio.gather(*(lab.post(message(f'Note {n}.'), 'bo') for n in range(20)))

    assert sorted(entry.post.id for entry in posted) == sorted(f'p-{n}' for n in range(2, 22))


async def test_watches_are_recorded(lab: Lab) -> None:
    watch = await lab.watch('bo', 't-1', watching=True)

    assert lab.board.watches == (watch,)


async def test_a_reloaded_lab_has_the_same_board(lab: Lab, record_file: RecordFile) -> None:
    await lab.post(message('Starting.'), 'ada')

    assert Lab.load(record_file).board == lab.board


async def test_a_waiter_wakes_on_the_next_event(lab: Lab) -> None:
    seen = lab.board.seq
    waiter = asyncio.create_task(lab.events_after(seen, timeout=5))
    await asyncio.sleep(0)

    await lab.post(message('Ready.'), 'bo')

    events = await waiter
    assert [event.seq for event in events] == [seen + 1]
    assert isinstance(events[0], Posted)


async def test_events_that_exist_return_at_once(lab: Lab) -> None:
    events = await lab.events_after(1, timeout=0)

    assert [event.seq for event in events] == [2, 3, 4, 5]


async def test_a_waiter_times_out_with_no_events(lab: Lab) -> None:
    assert await lab.events_after(lab.board.seq, timeout=0.01) == ()


def test_the_default_clock_is_utc(record_file: RecordFile) -> None:
    assert Lab.create(record_file, 'Does it hold?').board.opened.at.tzinfo is UTC
