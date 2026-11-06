from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path

import pytest
from builders import START, RecordBuilder
from builders import lab as record_lab

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.server.lab import Lab
from verifold.store.record_file import RecordFile


@pytest.fixture
def record() -> RecordBuilder:
    """A fresh lab record from `builders.lab`."""
    return record_lab()


def agent(agent_id: str) -> Agent:
    return Agent(id=agent_id, name=agent_id.title(), harness='fake', model=ModelSpec(family='anthropic'))


@pytest.fixture
def record_file(tmp_path: Path) -> Iterator[RecordFile]:
    with RecordFile(tmp_path / 'record.jsonl') as record:
        yield record


@pytest.fixture
async def lab(record_file: RecordFile) -> Lab:
    """A lab with `ada` and `bo`, and thread t-1 that ada opened with post p-1."""
    ticks = iter(range(1_000))
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: START + timedelta(seconds=next(ticks)))
    await lab.join(agent('ada'))
    await lab.join(agent('bo'))
    await lab.post(PostRequest(kind='result', text='Beats random.', new_thread='Does it beat random?'), 'ada')
    return lab
