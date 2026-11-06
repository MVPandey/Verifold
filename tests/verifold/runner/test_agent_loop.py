import asyncio
import json
from pathlib import Path

import pytest
from builders import until
from conftest import ServedBoard
from fakes import FAKE_HARNESS

from verifold.protocol.join import PostRequest
from verifold.protocol.usage import Usage
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings
from verifold.runner.git import git
from verifold.runner.messages import DOORBELL


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / 'calls.jsonl'
    monkeypatch.setenv('FAKE_ACP_LOG', str(path))
    return path


def calls(log: Path, event: str) -> list[dict[str, object]]:
    lines = log.read_text().splitlines() if log.exists() else []
    return [call for call in map(json.loads, lines) if call['event'] == event]


def loop_for(served: ServedBoard, tmp_path: Path, **settings: float) -> AgentLoop:
    member, token = served.seat('bo')
    joined = served.lab.board.agent('bo')
    assert joined is not None
    folder = tmp_path / 'bo'
    folder.mkdir(exist_ok=True)
    setup = AgentSetup(
        agent=joined.agent, harness=FAKE_HARNESS, folder=folder, log=tmp_path / 'bo.log', token=token, start='Start.'
    )
    return AgentLoop(member, setup, LoopSettings(mcp_url=served.url, retry_after=0, **settings))


def posts_by(served: ServedBoard, author: str) -> list[str]:
    return [entry.post.text for entry in served.lab.board.posts if entry.post.author == author]


async def test_the_agent_starts_and_the_doorbell_rings_only_for_posts_for_it(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        await lab.post(PostRequest(kind='message', text='Not for bo.', thread='t-1'), 'ada')
        await asyncio.sleep(0.3)
        assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']

        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'person')
        await until(lambda: len(lab.board.turns) == 2)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL]
    assert posts_by(served, 'bo')[0] == 'Hello from bo.'
    assert posts_by(served, 'bo')[-1].startswith('Seen p-')
    turn = lab.board.turns[-1]
    assert (turn.agent, turn.usage, turn.error) == (
        'bo',
        Usage(input_tokens=13, cached_input_tokens=3, output_tokens=5),
        None,
    )
    assert turn.cost_usd == pytest.approx(0.01)


async def test_a_failing_harness_is_restarted_with_its_session_and_stops_after_three_failures(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_CRASH', '1')

    async with asyncio.timeout(30):
        await loop_for(served, tmp_path).run()

    assert len(calls(log, 'new_session')) == 1
    assert [call['session'] for call in calls(log, 'load_session')] == ['session-bo', 'session-bo']
    turns = served.lab.board.turns
    assert len(turns) == 3
    assert all(turn.error for turn in turns)


async def test_a_turn_past_its_timeout_is_cancelled(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    running = asyncio.create_task(loop_for(served, tmp_path, turn_timeout=0.5).run())
    try:
        await until(lambda: len(served.lab.board.turns) == 1)
        await until(lambda: bool(calls(log, 'cancel')))
    finally:
        running.cancel()

    assert served.lab.board.turns[0].error == 'The turn ran past 0.5 seconds and was cancelled.'


async def test_a_permission_request_waits_for_the_persons_answer_on_the_board(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_PERMISSION', '1')
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
        asked = lab.board.posts[-1].post
        await lab.post(PostRequest(kind='answer', text='Allow once', thread=asked.thread, reply_to=asked.id), 'person')
        await until(lambda: 'Permission: yes.' in posts_by(served, 'bo'))
    finally:
        running.cancel()

    assert asked.text == 'Permission needed: run make'


async def test_each_turn_records_a_snapshot_of_the_agents_folder(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    loop = loop_for(served, tmp_path)
    await git('init', '--quiet', cwd=tmp_path / 'bo')
    (tmp_path / 'bo' / 'notes.md').write_text('benchmark plan')
    running = asyncio.create_task(loop.run())
    try:
        await until(lambda: len(served.lab.board.turns) == 1)
    finally:
        running.cancel()

    commit = served.lab.board.turns[0].snapshot
    assert commit is not None
    assert await git('show', f'{commit}:notes.md', cwd=tmp_path / 'bo') == 'benchmark plan'
