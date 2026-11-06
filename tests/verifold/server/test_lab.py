import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import Posted
from verifold.protocol.posts import Message, Objection, Result
from verifold.server.lab import Lab
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile

START = datetime(2026, 11, 6, 12, tzinfo=UTC)


def agent(agent_id: str) -> Agent:
    return Agent(id=agent_id, name=agent_id.title(), harness='fake', model=ModelSpec(family='anthropic'))


@pytest.fixture
def record(tmp_path: Path) -> Iterator[RecordFile]:
    with RecordFile(tmp_path / 'record.jsonl') as record:
        yield record


@pytest.fixture
async def ada_and_bo(record: RecordFile) -> Lab:
    ticks = iter(range(1_000))
    lab = Lab.create(record, 'Does it hold?', clock=lambda: START + timedelta(seconds=next(ticks)))
    await lab.join(agent('ada'))
    await lab.join(agent('bo'))
    await lab.open_thread('Does the baseline beat random?', opened_by='ada')
    return lab


async def test_the_lab_numbers_threads_and_posts(ada_and_bo: Lab) -> None:
    second = await ada_and_bo.open_thread('Which layer?', opened_by='bo')
    posted = await ada_and_bo.post(lambda post_id: Result(id=post_id, thread='t-2', author='bo', text='Layer 12.'))

    assert second.thread.id == 't-2'
    assert posted.post.id == 'p-1'
    assert posted.seq == ada_and_bo.board.seq == 6
    assert posted.at == START + timedelta(seconds=5)


async def test_a_rejected_event_leaves_the_record_unchanged(ada_and_bo: Lab, record: RecordFile) -> None:
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        await ada_and_bo.post(
            lambda post_id: Objection(id=post_id, thread='t-1', author='ada', text='Flawed.', reply_to='p-9')
        )

    assert len(record.read()) == ada_and_bo.board.seq == 4


async def test_a_reloaded_lab_has_the_same_board(ada_and_bo: Lab, record: RecordFile) -> None:
    await ada_and_bo.post(lambda post_id: Message(id=post_id, thread='t-1', author='ada', text='Starting.'))

    assert Lab.load(record).board == ada_and_bo.board


async def test_a_waiter_wakes_on_the_next_event(ada_and_bo: Lab) -> None:
    seen = ada_and_bo.board.seq
    waiter = asyncio.create_task(ada_and_bo.events_after(seen, timeout=5))
    await asyncio.sleep(0)

    await ada_and_bo.post(lambda post_id: Message(id=post_id, thread='t-1', author='bo', text='Ready.'))

    events = await waiter
    assert [event.seq for event in events] == [seen + 1]
    assert isinstance(events[0], Posted)


async def test_events_that_exist_return_at_once(ada_and_bo: Lab) -> None:
    events = await ada_and_bo.events_after(1, timeout=0)

    assert [event.seq for event in events] == [2, 3, 4]


async def test_a_waiter_times_out_with_no_events(ada_and_bo: Lab) -> None:
    assert await ada_and_bo.events_after(ada_and_bo.board.seq, timeout=0.01) == ()


def test_the_default_clock_is_utc(record: RecordFile) -> None:
    assert Lab.create(record, 'Does it hold?').board.opened.at.tzinfo is UTC
