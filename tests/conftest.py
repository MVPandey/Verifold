import asyncio
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import pytest
import uvicorn
from builders import START, RecordBuilder
from builders import lab as record_lab
from pydantic import SecretStr

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.server.join import Members, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
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


@dataclass
class ServedBoard:
    """A lab whose board is served over MCP on 127.0.0.1, the way agents reach it."""

    lab: Lab
    url: str
    members: Members

    def seat(self, agent_id: str) -> tuple[Member, SecretStr]:
        """Seat an agent of the lab, and return its member and token."""
        member = Member(self.lab, agent_id)
        return member, SecretStr(self.members.add(member))


@pytest.fixture
async def served(lab: Lab) -> AsyncIterator[ServedBoard]:
    """The `lab` fixture with its board served over MCP on a free port."""
    members = Members()
    app = join_server(members.resolve).streamable_http_app(host='127.0.0.1')
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=0, log_level='warning'))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    yield ServedBoard(lab=lab, url=f'http://127.0.0.1:{port}/mcp', members=members)
    server.should_exit = True
    await serving
