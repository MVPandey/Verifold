import asyncio
from collections.abc import Callable
from datetime import date
from pathlib import Path

from fakes import Recording
from pydantic import SecretStr

from verifold.protocol.join import PostRequest
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings
from verifold.server.lab import Lab
from verifold.server.member import Member


def setup_for(lab: Lab, agent_id: str, tmp_path: Path) -> AgentSetup:
    joined = lab.board.agent(agent_id)
    assert joined is not None
    folder = tmp_path / agent_id
    folder.mkdir()
    return AgentSetup(
        agent=joined.agent, project=tmp_path, folder=folder, private=tmp_path / 'private', token=SecretStr('t')
    )


async def until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(10):
        while not condition():
            await asyncio.sleep(0.02)


SETTINGS = LoopSettings(mcp_url='http://127.0.0.1:1/mcp', idle_wait=0.05, retry_after=0)


async def test_the_agent_starts_with_the_opening_prompt_and_resumes_when_a_post_wakes_it(
    lab: Lab, tmp_path: Path
) -> None:
    harness = Recording(tmp_path / 'turns.log')
    loop = AgentLoop(
        Member(lab, 'bo'), setup_for(lab, 'bo', tmp_path), harness, SETTINGS, today=lambda: date(2026, 11, 6)
    )
    running = asyncio.create_task(loop.run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        await asyncio.sleep(0.1)
        assert len(harness.turns()) == 1

        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
        await until(lambda: len(lab.board.turns) == 2)
    finally:
        running.cancel()

    (opening, first_session), (update, second_session) = harness.turns()
    assert 'You are Bo' in opening
    assert first_session == ''
    assert 'ada (ask): Which layer?' in update
    assert second_session == 's-1'
    assert [turn.error for turn in lab.board.turns] == [None, None]


async def test_an_agent_stops_after_failing_turns_in_a_row(lab: Lab, tmp_path: Path) -> None:
    harness = Recording(tmp_path / 'turns.log', exit_code=1)
    loop = AgentLoop(Member(lab, 'bo'), setup_for(lab, 'bo', tmp_path), harness, SETTINGS)

    async with asyncio.timeout(10):
        await loop.run()

    prompts = [prompt for prompt, _ in harness.turns()]
    assert len(prompts) == SETTINGS.max_failures
    assert prompts[1].startswith('Your last turn stopped: recording exited with code 1')
    assert all(turn.error for turn in lab.board.turns)


async def test_each_turn_records_its_time_and_usage(lab: Lab, tmp_path: Path) -> None:
    harness = Recording(tmp_path / 'turns.log')
    running = asyncio.create_task(
        AgentLoop(Member(lab, 'ada'), setup_for(lab, 'ada', tmp_path), harness, SETTINGS).run()
    )
    try:
        await until(lambda: len(lab.board.turns) == 1)
    finally:
        running.cancel()

    turn = lab.board.turns[0]
    assert (turn.agent, turn.usage.input_tokens, turn.cost_usd) == ('ada', 0, None)
    assert turn.seconds > 0
