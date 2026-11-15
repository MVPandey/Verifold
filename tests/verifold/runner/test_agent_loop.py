import asyncio
import json
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from datetime import timedelta
from pathlib import Path

import pytest
from builders import until
from conftest import ServedBoard, agent
from fakes import FAKE_HARNESS

from verifold.protocol.app import AgentState
from verifold.protocol.events import AlarmSet, TurnSummary
from verifold.protocol.join import MAX_NEWS, PostRequest
from verifold.protocol.posts import Ask, PermissionShown, QuestionShown
from verifold.protocol.settings import AtTimeLimit, JobSettings, PermissionSettings, Settings, WhileYouDecide
from verifold.protocol.usage import Usage
from verifold.runner import agent_loop
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings, Shared
from verifold.runner.git import git
from verifold.runner.messages import (
    CLOSED,
    DEPARTURE,
    DOORBELL,
    HARNESS_FAILED,
    IN_TURN,
    JOBS_ENDED,
    OUT_OF_TIME,
    RESTARTED,
    STARTED_AGAIN,
    alarm_message,
    back_message,
    cut_short_message,
    more_time_message,
    time_facts,
)
from verifold.runner.permissions import Refusals
from verifold.runner.session import AgentSession, PermissionChoice, PermissionRequest, TurnResult
from verifold.server.activity import Activity
from verifold.society.board import Board
from verifold.society.lifecycle import lab_state, pending_alarm, rings_at
from verifold.society.turns import before
from verifold.society.views import needs_person


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / 'calls.jsonl'
    monkeypatch.setenv('FAKE_ACP_LOG', str(path))
    return path


def calls(log: Path, event: str) -> list[dict[str, object]]:
    lines = log.read_text().splitlines() if log.exists() else []
    return [call for call in map(json.loads, lines) if call['event'] == event]


async def no_jobs(_agent: str) -> bool:
    return False


def loop_for(
    served: ServedBoard,
    tmp_path: Path,
    activity: Activity | None = None,
    refusals: Refusals | None = None,
    has_jobs: Callable[[str], Awaitable[bool]] | None = None,
    done: Callable[[Board], bool] | None = None,
    **settings: float,
) -> AgentLoop:
    member, token = served.seat('bo')
    joined = served.lab.board.agent('bo')
    assert joined is not None
    folder = tmp_path / 'bo'
    folder.mkdir(exist_ok=True)
    setup = AgentSetup(
        agent=joined.agent,
        harness=FAKE_HARNESS,
        lab=tmp_path,
        folder=folder,
        log=tmp_path / 'bo.log',
        token=token,
        start='Start.',
    )
    # No quiet window by default, so a doorbell rings as soon as a post for the agent arrives.
    options = {'retry_after': 0.0, 'quiet': 0.0} | settings
    return AgentLoop(
        member,
        setup,
        LoopSettings(mcp_url=served.url, **options),
        done,
        shared=Shared(activity=activity, refusals=refusals, has_jobs=has_jobs),
    )


def pass_time(served: ServedBoard, seconds: int) -> None:
    """Move the lab's clock on by `seconds`. Each look at that clock is one second, so no test waits for an alarm."""
    for _ in range(seconds):
        served.lab.now()


SIDE_NOTE = PostRequest(kind='message', text='A side note.', thread='t-1')
"""A post that rings no doorbell for `bo`. The board changes, so the loop of `bo` looks at the clock again."""


def posts_by(served: ServedBoard, author: str) -> list[str]:
    return [entry.post.text for entry in served.lab.board.posts if entry.post.author == author]


async def test_the_agent_starts_and_the_doorbell_rings_only_for_posts_for_it(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        await lab.post(PostRequest(kind='message', text='A side note.', thread='t-1'), 'ada')
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


async def test_a_post_that_the_agent_got_in_a_tool_result_during_its_turn_rings_no_doorbell(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        # The ask arrives before the agent's first post, so the result of that post carries it as news.
        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
        await until(lambda: len(lab.board.turns) == 1)
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']
    assert posts_by(served, 'bo') == ['Hello from bo.']


async def test_one_doorbell_covers_a_burst_of_posts(served: ServedBoard, tmp_path: Path, log: Path) -> None:
    lab = served.lab
    # The posts come with no gap, and the quiet window is far longer than a post takes, so a slow machine cannot
    # split the burst.
    running = asyncio.create_task(loop_for(served, tmp_path, quiet=0.5, max_quiet=10).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        for number in range(3):
            await lab.post(PostRequest(kind='ask', text=f'Question {number}?', thread='t-1', mentions=('bo',)), 'ada')
        await until(lambda: len(lab.board.turns) == 2)
        # A second doorbell would ring after one more quiet window.
        await asyncio.sleep(0.8)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL]
    assert len([text for text in posts_by(served, 'bo') if text.startswith('Seen p-')]) == 3


async def test_an_agent_that_read_one_page_of_its_posts_gets_a_doorbell_for_the_rest(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    member, token = served.seat('bo')
    prompts: list[str] = []
    pages: list[int] = []

    async def read_one_page(_: AgentSession, message: str) -> TurnResult:
        # The agent reads one page of its posts after a doorbell, and then ends its turn.
        prompts.append(message)
        if message == DOORBELL:
            pages.append(len((await member.wait(timeout=0)).posts))
        return TurnResult(stop_reason='end_turn', usage=Usage())

    monkeypatch.setattr(AgentSession, 'send', read_one_page)
    monkeypatch.setattr(served, 'seat', lambda _: (member, token))
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        asks = (
            PostRequest(kind='ask', text=f'Question {number}?', thread='t-1', mentions=('bo',))
            for number in range(MAX_NEWS + 3)
        )
        await asyncio.gather(*(lab.post(ask, 'ada') for ask in asks))
        await until(lambda: len(pages) == 2)
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert prompts == ['Start.', DOORBELL, DOORBELL]
    assert pages == [MAX_NEWS, 3]


async def test_a_doorbell_does_not_wait_longer_than_the_limit_for_a_board_that_stays_busy(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab

    async def chatter() -> None:
        while True:
            await lab.post(PostRequest(kind='message', text='Still busy.', thread='t-1'), 'ada')
            await asyncio.sleep(0.1)

    running = asyncio.create_task(loop_for(served, tmp_path, quiet=5, max_quiet=0.5).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
        busy = asyncio.create_task(chatter())
        try:
            await until(lambda: len(calls(log, 'prompt')) == 2, timeout=5)
        finally:
            busy.cancel()
    finally:
        running.cancel()

    assert calls(log, 'prompt')[1]['text'] == DOORBELL


async def test_the_alarm_that_an_agent_set_in_its_turn_rings_once_after_the_turn(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    # The alarm that the agent sets later replaces this one, so this one never rings.
    stale = await lab.set_alarm('bo', 0.03, quiet=False)
    # Every turn of this agent runs until Verifold cuts it short, so the test can set an alarm inside a turn.
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity, turn_timeout=0.5).run())
    try:
        # The alarm is set in the first turn. That turn is cut, the agent goes on once, and that turn is cut too.
        await until(lambda: len(lab.board.starts) == 1)
        set_ = await lab.set_alarm('bo', 0.02, quiet=False)
        await until(lambda: len(calls(log, 'prompt')) >= 3)
    finally:
        running.cancel()

    cut = cut_short_message('The turn ran past 0.5 seconds and was cancelled.')
    prompts = [call['text'] for call in calls(log, 'prompt')]
    assert prompts[:3] == ['Start.', cut, alarm_message(set_)]
    assert alarm_message(stale) not in prompts
    # The start of the turn that the ring started says which alarm rang.
    assert [start.rang for start in lab.board.starts[:3]] == [None, None, set_.seq]


async def test_an_alarm_stays_through_a_turn_that_a_post_started_and_rings_once_at_its_time(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        # Each look at the lab's clock is one second, so the alarm is some looks ahead.
        set_ = await lab.set_alarm('bo', 0.5, quiet=False)
        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
        await until(lambda: len(lab.board.turns) == 2)
        assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL]
        assert pending_alarm(lab.board, 'bo') == set_
        pass_time(served, 30)
        # The loop looks at the clock again when the board changes.
        await lab.post(SIDE_NOTE, 'ada')
        await until(lambda: len(lab.board.turns) == 3)
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL, alarm_message(set_)]
    assert ([start.rang for start in lab.board.starts], pending_alarm(lab.board, 'bo')) == (
        [None, None, set_.seq],
        None,
    )


async def test_an_alarm_whose_time_comes_while_its_agent_is_in_a_turn_rings_when_that_turn_ends(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    monkeypatch.setenv('FAKE_ACP_TURN_SECONDS', '0.5')
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        set_ = await lab.set_alarm('bo', 0.2, quiet=False)
        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
        await until(lambda: len(lab.board.starts) == 2)
        # The time of the alarm passes while the turn for the post runs.
        pass_time(served, 15)
        assert (len(lab.board.turns), lab.now() > rings_at(lab.board, set_)) == (1, True)
        await until(lambda: len(lab.board.turns) == 3)
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    # The message says why the alarm rings after its time.
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL, alarm_message(set_, IN_TURN)]


async def test_an_alarm_for_a_quiet_board_stays_through_a_turn_that_a_post_started(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        set_ = await lab.set_alarm('bo', 0.5, quiet=True)
        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
        await until(lambda: len(lab.board.turns) == 2)
        assert pending_alarm(lab.board, 'bo') == set_
        pass_time(served, 30)
        # The board changes without a post, so the loop looks at the clock and the board stays quiet.
        await lab.set_profile('ada', None, 'Step 1.')
        await until(lambda: len(lab.board.turns) == 3)
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL, alarm_message(set_)]
    # It rang half a minute after the newest post before it, which came after the agent set it.
    rang = lab.board.starts[-1]
    quiet_from = max(entry.at for entry in lab.board.posts if entry.seq < rang.seq)
    assert (rang.rang, quiet_from > set_.at, rang.at >= quiet_from + timedelta(seconds=30)) == (set_.seq, True, True)


async def test_an_alarm_from_an_older_record_is_spent_when_a_post_starts_the_next_turn(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    monkeypatch.setenv('FAKE_ACP_TURN_SECONDS', '0.5')
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.starts) == 1)
        # The record of an older Verifold says of no alarm that it stays.
        await lab._commit(lambda _, seq, at: AlarmSet(seq=seq, at=at, agent='bo', minutes=0.5))
        await until(lambda: len(lab.board.turns) == 1)
        old = pending_alarm(lab.board, 'bo')
        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
        await until(lambda: len(lab.board.turns) == 2)
        pass_time(served, 60)
        await lab.post(SIDE_NOTE, 'ada')
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert old is not None
    assert not old.stays
    assert pending_alarm(lab.board, 'bo') is None
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL]


async def test_a_harness_that_fails_in_the_turn_that_an_alarm_started_gets_the_alarm_again(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    prompts: list[str] = []

    async def fail_once(_: AgentSession, message: str) -> TurnResult:
        prompts.append(message)
        if len(prompts) == 2:
            raise BrokenPipeError('The harness closed its stdin.')
        return TurnResult(stop_reason='end_turn', usage=Usage())

    monkeypatch.setattr(AgentSession, 'send', fail_once)
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        set_ = await lab.set_alarm('bo', 0.02, quiet=False)
        await until(lambda: len(prompts) == 3)
        await asyncio.sleep(0.5)
    finally:
        running.cancel()

    # The record says that the alarm rang when the failed turn started, so the next message carries it again.
    assert prompts == ['Start.', alarm_message(set_), alarm_message(set_)]
    assert [
        (start.rang, turn.error is None) for start, turn in zip(lab.board.starts, lab.board.turns, strict=True)
    ] == [
        (None, True),
        (set_.seq, False),
        (None, True),
    ]


async def test_an_alarm_that_is_due_rings_with_the_message_about_more_time_when_the_time_limit_stopped_the_processes(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await lab.set_settings(Settings(jobs=JobSettings(at_time_limit=AtTimeLimit.STOP)))
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        set_ = await lab.set_alarm('bo', 0.02, quiet=False)
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        # The loop sees the lab out of time, and then the time of the alarm passes.
        await asyncio.sleep(0.1)
        pass_time(served, 5)
        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    more = more_time_message(lab.board.ends_at, AtTimeLimit.STOP)
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', f'{more} {alarm_message(set_, OUT_OF_TIME)}']
    assert lab.board.starts[-1].rang == set_.seq


async def test_an_alarm_that_its_agent_cancelled_does_not_ring(served: ServedBoard, tmp_path: Path, log: Path) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        await lab.set_alarm('bo', 0.02, quiet=False)
        await lab.set_alarm('bo', 0, quiet=False)
        # The time of the cancelled alarm passes, and the loop looks at the clock.
        pass_time(served, 5)
        await lab.post(SIDE_NOTE, 'ada')
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']


async def test_an_alarm_does_not_ring_in_a_lab_that_is_out_of_time_and_rings_once_after_more_time(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        set_ = await lab.set_alarm('bo', 0.02, quiet=False)
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        # The time of the alarm passes, and the loop looks at the clock.
        pass_time(served, 5)
        await lab.set_profile('ada', None, 'Waits.')
        await asyncio.sleep(0.3)
        assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']

        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.5)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', alarm_message(set_, OUT_OF_TIME)]


async def test_an_alarm_does_not_ring_in_a_closed_lab_and_rings_with_the_doorbell_when_the_lab_is_open_again(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await lab.post(PostRequest(kind='close', text='The answer stands.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-2', accepts=True), 'bo')
    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        set_ = await lab.set_alarm('bo', 0.02, quiet=False)
        # The time of the alarm passes, and the loop looks at the clock.
        pass_time(served, 5)
        await lab.set_profile('ada', None, 'Done.')
        await asyncio.sleep(0.3)
        assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']
        # The alarm still waits. The person's post opens the lab again.
        assert pending_alarm(lab.board, 'bo') == set_
        await lab.post(PostRequest(kind='message', text='Go on with line B.', thread='t-1'), 'person')
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.5)
    finally:
        running.cancel()

    # One message carries the doorbell and the alarm that is due, so the alarm wakes the agent once.
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', f'{DOORBELL} {alarm_message(set_, CLOSED)}']
    assert (lab.board.starts[-1].rang, pending_alarm(lab.board, 'bo')) == (set_.seq, None)


async def test_a_failed_turn_gives_the_agent_its_news_again(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    member, token = served.seat('bo')
    before = member.seen

    async def read_then_crash(*_: object) -> None:
        # The harness got the post in a tool result, and then its process died.
        assert member.news() is not None
        raise BrokenPipeError('The harness closed its stdin.')

    monkeypatch.setattr(AgentSession, 'send', read_then_crash)
    # The loop gets this member, so the test can read as the agent and look at its cursor.
    monkeypatch.setattr(served, 'seat', lambda _: (member, token))
    loop = loop_for(served, tmp_path, max_failures=1)
    await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')

    async with asyncio.timeout(30):
        await loop.run()

    assert member.seen == before
    assert [entry.post.text for entry in (await member.wait(timeout=0)).posts] == ['Which layer?']


async def test_an_agent_with_one_job_that_left_nothing_running_gets_one_turn_for_it(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    loop = loop_for(served, tmp_path, has_jobs=no_jobs)
    loop._done = lambda _: False

    async with asyncio.timeout(30):
        await loop.run()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']
    assert len(served.lab.board.turns) == 1


async def test_an_agent_with_one_job_wakes_when_the_processes_that_it_left_running_end(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    looks: list[str] = []

    async def has_jobs(agent: str) -> bool:
        # The agent's process runs for the first three looks of the first turn, and no process runs after that.
        looks.append(agent)
        return len(looks) <= 3

    loop = loop_for(served, tmp_path, has_jobs=has_jobs, job_poll=0.01)
    loop._done = lambda _: False

    async with asyncio.timeout(30):
        await loop.run()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', JOBS_ENDED]
    assert len(served.lab.board.turns) == 2
    assert set(looks) == {'bo'}


async def test_an_agent_with_one_job_does_not_wait_for_ever_for_a_process_that_never_ends(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    async def always(_agent: str) -> bool:
        return True

    activity = Activity()
    loop = loop_for(served, tmp_path, activity, has_jobs=always, job_poll=0.01, job_wait=0.05)
    loop._done = lambda _: False

    async with asyncio.timeout(30):
        await loop.run()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']


async def test_an_agent_with_one_job_hears_that_the_time_limit_stopped_its_processes(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await lab.set_settings(Settings(jobs=JobSettings(at_time_limit=AtTimeLimit.STOP)))
    stop = asyncio.Event()

    async def until_stopped(_agent: str) -> bool:
        return not stop.is_set()

    loop = loop_for(served, tmp_path, has_jobs=until_stopped, job_poll=0.01)
    loop._done = lambda _: False
    running = asyncio.create_task(loop.run())
    try:
        await until(lambda: bool(lab.board.turns))
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        stop.set()
        await asyncio.sleep(0.1)
        assert len(calls(log, 'prompt')) == 1

        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(calls(log, 'prompt')) == 2)
    finally:
        running.cancel()
        with suppress(asyncio.CancelledError):
            await running

    assert calls(log, 'prompt')[1]['text'] == more_time_message(lab.board.ends_at, AtTimeLimit.STOP)


async def test_an_agent_with_one_job_that_the_time_limit_stopped_goes_on_when_the_lab_gets_more_time(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    lab = served.lab
    loop = loop_for(served, tmp_path)
    loop._done = lambda _: False
    running = asyncio.create_task(loop.run())
    try:
        await until(lambda: bool(calls(log, 'prompt')))
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        await until(lambda: bool(lab.board.turns))
        await asyncio.sleep(0.1)
        # The stop was not the agent's choice, so its one turn is not used up.
        assert not running.done()

        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(calls(log, 'prompt')) == 2)
    finally:
        running.cancel()
        with suppress(asyncio.CancelledError):
            await running

    assert calls(log, 'prompt')[1]['text'] == more_time_message(
        lab.board.ends_at, lab.board.settings.jobs.at_time_limit
    )


async def test_a_failing_harness_is_restarted_with_its_session_and_stops_after_three_failures(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_CRASH', '1')

    async with asyncio.timeout(30):
        await loop_for(served, tmp_path).run()

    # The second failure is a turn in the conversation that the harness loaded, so the last start opens a new one.
    assert len(calls(log, 'new_session')) == 2
    assert [call['session'] for call in calls(log, 'load_session')] == ['session-bo']
    turns = served.lab.board.turns
    assert len(turns) == 3
    assert all(turn.error for turn in turns)
    # The record says that Verifold stopped the agent, so a restart of Verifold does not start it again.
    assert [turn.stopped for turn in turns] == [False, False, True]
    assert before(served.lab.board, 'bo').stopped


async def test_a_turn_past_its_timeout_is_cancelled(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity, turn_timeout=0.5).run())
    try:
        await until(lambda: len(served.lab.board.turns) == 1)
        await until(lambda: bool(calls(log, 'cancel')))
        # The agent did not choose to stop, so it goes on once and hears why. A second cut waits for a post.
        await until(lambda: len(served.lab.board.turns) == 2)
        await until(lambda: activity.of('bo').state == 'idle')
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    cut = 'The turn ran past 0.5 seconds and was cancelled.'
    assert [turn.error for turn in served.lab.board.turns] == [cut, cut]
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', cut_short_message(cut)]


@pytest.mark.usefixtures('log')
async def test_a_permission_request_waits_for_the_persons_answer_on_the_board(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
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

    assert asked.text == 'Permission needed: a tool call'


NO_WAIT = Settings(permissions=PermissionSettings(while_you_decide=WhileYouDecide.REFUSE))
WAIT = Settings(permissions=PermissionSettings(while_you_decide=WhileYouDecide.WAIT))


@pytest.mark.usefixtures('log')
async def test_when_the_person_chose_that_agents_wait_a_command_that_no_grant_can_cover_waits_for_the_answer(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_COMMAND', 'git commit -m "x"')
    lab = served.lab
    await lab.set_settings(WAIT)
    running = asyncio.create_task(loop_for(served, tmp_path, refusals=Refusals(lab)).run())
    try:
        await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
        asked = lab.board.posts[-1].post
        waited = posts_by(served, 'bo')
        await lab.post(PostRequest(kind='answer', text='Allow once', thread=asked.thread, reply_to=asked.id), 'person')
        await until(lambda: 'Permission: yes.' in posts_by(served, 'bo'))
    finally:
        running.cancel()

    assert (lab.board.opened.auto_mode, asked.text) == (True, 'Permission needed: a shell command')
    assert isinstance(asked, Ask)
    assert (asked.choices, asked.request) == (('Allow once', 'Reject'), 'permission')
    assert 'The command:\n\n```\ngit commit -m "x"\n```' in asked.body
    assert all(not text.startswith('Permission:') for text in waited)


@pytest.mark.usefixtures('log')
async def test_a_question_of_the_harness_waits_for_the_persons_answer_on_the_board(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_QUESTION', '1')
    lab = served.lab
    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
        asked = lab.board.posts[-1].post
        state = activity.of('bo')
        await lab.post(PostRequest(kind='answer', text='dev', thread=asked.thread, reply_to=asked.id), 'person')
        await until(lambda: 'Answer: {"branch": "dev"}.' in posts_by(served, 'bo'))
    finally:
        running.cancel()

    assert isinstance(asked, Ask)
    assert (asked.text, asked.choices, asked.mentions) == ('A question from the harness', ('main', 'dev'), ('person',))
    assert asked.shown == QuestionShown(message='Which branch?', field='Branch', kind='choice')
    assert (state.state, state.detail) == ('waiting', 'Asks you: a question of its harness')


@pytest.mark.usefixtures('log')
@pytest.mark.parametrize('settings', [NO_WAIT, None])
async def test_in_a_lab_with_auto_mode_or_by_the_persons_choice_a_command_is_refused_at_once_and_the_ask_stays(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, settings: Settings | None
) -> None:
    monkeypatch.setenv('FAKE_ACP_COMMAND', './gpu python3 train.py')
    lab = served.lab
    if settings:
        await lab.set_settings(settings)
    running = asyncio.create_task(loop_for(served, tmp_path, refusals=Refusals(lab)).run())
    try:
        await until(lambda: 'Permission: no.' in posts_by(served, 'bo'))
    finally:
        running.cancel()

    asks = [entry.post for entry in lab.board.posts if isinstance(entry.post, Ask)]
    assert lab.board.opened.auto_mode
    assert [ask.text for ask in asks] == ['Permission needed: a shell command']
    assert asks[0].choices == ('Allow once', 'Reject', 'Allow `./gpu` for every agent')
    assert [view.post.id for view in needs_person(lab.board)] == [asks[0].id]


@pytest.mark.usefixtures('log')
async def test_a_request_whose_only_no_stops_the_turn_waits_for_the_person_also_when_agents_do_not_wait(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_COMMAND', './gpu python3 train.py')
    monkeypatch.setenv('FAKE_ACP_ABORT', '1')
    lab = served.lab
    await lab.set_settings(NO_WAIT)
    running = asyncio.create_task(loop_for(served, tmp_path, refusals=Refusals(lab)).run())
    try:
        await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
        asked = lab.board.posts[-1].post
        await asyncio.sleep(0.3)
        waited = [text for text in posts_by(served, 'bo') if text.startswith('Permission:')]
        await lab.post(PostRequest(kind='answer', text='Allow once', thread=asked.thread, reply_to=asked.id), 'person')
        await until(lambda: 'Permission: yes.' in posts_by(served, 'bo'))
        await until(lambda: len(lab.board.turns) == 1)
    finally:
        running.cancel()

    assert isinstance(asked, Ask)
    assert isinstance(asked.shown, PermissionShown)
    assert (waited, asked.shown.notes, asked.choices[1]) == ([], ('no_decline',), 'No, and stop')
    assert "offers no way to decline this request without stopping the agent's turn" in asked.body
    assert [turn.error for turn in lab.board.turns] == [None]


@pytest.mark.usefixtures('log')
async def test_a_request_that_waits_ends_with_its_turn_and_the_agents_next_request_is_the_live_one(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_PERMISSION', '1')
    lab = served.lab

    def asks() -> list[Ask]:
        return [entry.post for entry in lab.board.posts if isinstance(entry.post, Ask)]

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        # The lab runs out of time while the request waits, which ends the turn. With more time the agent goes on,
        # and its harness asks again. No turn has a time limit here, so no answer comes too late for its turn.
        await until(lambda: len(asks()) == 1)
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        await until(lambda: len(lab.board.turns) == 1)
        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(asks()) == 2)
        old, live = asks()
        await until(lambda: [view.post.id for view in needs_person(lab.board)] == [live.id])
        await lab.post(PostRequest(kind='answer', text='Allow once', thread=old.thread, reply_to=old.id), 'person')
        await asyncio.sleep(0.2)
        late = [text for text in posts_by(served, 'bo') if text == 'Permission: yes.']
        await lab.post(PostRequest(kind='answer', text='Allow once', thread=live.thread, reply_to=live.id), 'person')
        await until(lambda: 'Permission: yes.' in posts_by(served, 'bo'))
    finally:
        running.cancel()

    ended = [entry.post for entry in lab.board.replies(old.id) if entry.post.author == 'bo']
    assert [post.text for post in ended] == [
        "This request ended with the agent's turn. An answer to it decides nothing."
    ]
    assert (late, 'Permission: cancelled.' in posts_by(served, 'bo')) == ([], True)


MAKE = PermissionRequest(
    title='run make',
    choices=(
        PermissionChoice(id='yes', name='Allow once', kind='allow_once'),
        PermissionChoice(id='no', name='Reject', kind='reject_once'),
    ),
)


async def test_an_agent_with_two_requests_shows_as_waiting_until_the_last_one_has_its_answer(
    served: ServedBoard, tmp_path: Path
) -> None:
    lab = served.lab
    activity = Activity()
    loop = loop_for(served, tmp_path, activity)
    loop._turn_over.clear()
    other = MAKE.model_copy(update={'title': 'run tests'})

    async def answer(number: int) -> None:
        asked = [entry.post for entry in lab.board.posts if isinstance(entry.post, Ask)][number]
        await lab.post(PostRequest(kind='answer', text='Allow once', thread=asked.thread, reply_to=asked.id), 'person')

    first, second = asyncio.create_task(loop._permission(MAKE)), asyncio.create_task(loop._permission(other))
    await until(lambda: len(needs_person(lab.board)) == 2)
    await answer(0)
    one = await first
    between = activity.of('bo').state
    await answer(1)
    two = await second

    assert (one, two, between, activity.of('bo').state) == ('yes', 'yes', 'waiting', 'working')


async def test_an_agent_whose_turn_ended_while_it_waited_does_not_show_as_working(
    served: ServedBoard, tmp_path: Path
) -> None:
    activity = Activity()
    loop = loop_for(served, tmp_path, activity)
    loop._turn_over.clear()
    asking = asyncio.create_task(loop._permission(MAKE))
    await until(lambda: bool(needs_person(served.lab.board)))
    loop._turn_over.set()

    assert (await asking, activity.of('bo').state, needs_person(served.lab.board)) == (None, 'waiting', ())


@pytest.mark.usefixtures('log')
async def test_a_granted_command_runs_without_a_question(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_COMMAND', './gpu python3 train.py')
    lab = served.lab
    await lab.grant('./gpu')
    running = asyncio.create_task(loop_for(served, tmp_path, refusals=Refusals(lab)).run())
    try:
        await until(lambda: 'Permission: yes.' in posts_by(served, 'bo'))
    finally:
        running.cancel()

    assert all(entry.post.kind != 'ask' for entry in lab.board.posts)


@pytest.mark.usefixtures('log')
async def test_each_turn_records_a_snapshot_of_the_agents_folder(served: ServedBoard, tmp_path: Path) -> None:
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


class Recorded(Activity):
    """An activity store that keeps every change, in order."""

    def __init__(self) -> None:
        super().__init__()
        self.changes: list[tuple[str, str, str]] = []

    async def set(self, agent_id: str, state: AgentState, detail: str = '') -> None:
        self.changes.append((agent_id, state, detail))
        await super().set(agent_id, state, detail)


@pytest.mark.usefixtures('log')
async def test_the_loop_reports_what_the_agent_is_doing(served: ServedBoard, tmp_path: Path) -> None:
    activity = Recorded()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: len(served.lab.board.turns) == 1)
        await until(lambda: activity.of('bo').state == 'idle')
    finally:
        running.cancel()
        with suppress(asyncio.CancelledError):
            await running

    states = [(state, detail) for _, state, detail in activity.changes]
    assert states[0] == ('working', '')
    assert ('working', 'verifold.post') in states
    assert states[-2:] == [('idle', ''), ('stopped', '')]


async def test_running_out_of_time_stops_the_turn_until_the_person_gives_more_time(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    lab = served.lab
    activity = Recorded()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: bool(calls(log, 'prompt')))
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        await until(lambda: activity.of('bo').state == 'waiting')
        assert [turn.error for turn in lab.board.turns] == ['The lab ran out of time, so Verifold cancelled the turn.']
        assert calls(log, 'cancel')

        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(calls(log, 'prompt')) == 2)
    finally:
        running.cancel()
        with suppress(asyncio.CancelledError):
            await running

    assert calls(log, 'prompt')[1]['text'] == more_time_message(
        lab.board.ends_at, lab.board.settings.jobs.at_time_limit
    )
    assert activity.of('bo').detail == ''
    assert ('waiting', 'The lab is out of time. The person can give it more.') in [
        (state, detail) for _, state, detail in activity.changes
    ]


async def test_an_agent_out_of_time_wakes_for_its_posts_only_after_more_time(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'person')
        await asyncio.sleep(0.3)
        assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']

        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(lab.board.turns) == 2)
    finally:
        running.cancel()
        with suppress(asyncio.CancelledError):
            await running

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DOORBELL]


class BlockingSession:
    """A session whose turns never end, so the loop waits in a turn until the lab stops it."""

    id = 'session-1'
    loaded = False

    async def send(self, _: str) -> None:
        await asyncio.Event().wait()


async def test_a_cleanup_that_fails_while_the_lab_stops_ends_the_agent_and_restarts_nothing(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[bool] = []

    @asynccontextmanager
    async def open_session(*_: object) -> AsyncGenerator[BlockingSession]:
        opened.append(True)
        if len(opened) > 1:
            # The loop restarted the harness. Ending the loop here makes the test fail instead of hang.
            raise asyncio.CancelledError
        try:
            yield BlockingSession()
        finally:
            # A harness that closed its pipe early makes closing the connection fail.
            raise BrokenPipeError('The harness closed its stdin.')

    monkeypatch.setattr(AgentSession, 'open', open_session)
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: bool(opened))

    running.cancel()
    async with asyncio.timeout(5):
        with pytest.raises(asyncio.CancelledError):
            await running

    assert opened == [True]


async def run_through_a_stop(served: ServedBoard, tmp_path: Path, *, post: bool) -> None:
    """Let the agent end its first turn, stop the lab under `stop`, maybe post for the agent, and add time."""
    lab = served.lab
    await lab.set_settings(Settings(jobs=JobSettings(at_time_limit=AtTimeLimit.STOP)))
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        if post:
            await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'person')
            # The loop sees the post while the lab is still out of time.
            await asyncio.sleep(0.2)
        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(lab.board.turns) == 2)
    finally:
        running.cancel()
        with suppress(asyncio.CancelledError):
            await running


async def test_under_stop_an_idle_agent_hears_that_its_processes_stopped_once_time_comes_back(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    await run_through_a_stop(served, tmp_path, post=False)

    stopped = more_time_message(served.lab.board.ends_at, AtTimeLimit.STOP)
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', stopped]


async def test_under_stop_posts_that_came_meanwhile_ring_after_the_stop_message(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    await run_through_a_stop(served, tmp_path, post=True)

    stopped = more_time_message(served.lab.board.ends_at, AtTimeLimit.STOP)
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', f'{stopped} {DOORBELL}']


async def test_under_stop_a_stop_while_the_turn_is_recorded_still_reaches_the_agent(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    await lab.set_settings(Settings(jobs=JobSettings(at_time_limit=AtTimeLimit.STOP)))
    record_snapshot = agent_loop.snapshot

    async def slow_snapshot(folder: Path, agent_id: str) -> str | None:
        # The lab stops and gets more time while the first turn's snapshot runs, as in a large folder.
        if not lab.board.turns:
            await lab.set_time_left(timedelta(0))
            await lab.run_out_of_time()
            await lab.set_time_left(timedelta(hours=1))
        return await record_snapshot(folder, agent_id)

    monkeypatch.setattr(agent_loop, 'snapshot', slow_snapshot)
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 2)
    finally:
        running.cancel()
        with suppress(asyncio.CancelledError):
            await running

    stopped = more_time_message(lab.board.ends_at, AtTimeLimit.STOP)
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', stopped]


async def test_an_agent_that_leaves_ends_its_turn_itself_and_then_its_harness_stops(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_LEAVE', 'bo')
    lab = served.lab
    activity = Activity()

    async with asyncio.timeout(30):
        await loop_for(served, tmp_path, activity).run()
    # A post for the agent starts nothing, because nothing runs for it any more.
    await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')

    left = lab.board.gone('bo')
    assert left is not None
    assert (left.by, left.reason) == ('bo', 'Nothing is left for me.')
    # The turn in which it left ended by its own choice, after the event, and no other turn came.
    assert [(turn.error, turn.seq > left.seq) for turn in lab.board.turns] == [(None, True)]
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']
    assert (calls(log, 'cancel'), activity.of('bo').state) == ([], 'stopped')


async def test_the_persons_removal_stops_the_agents_turn_at_once_and_ends_its_harness(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: bool(calls(log, 'prompt')))

    await lab.leave('bo', 'person')
    async with asyncio.timeout(30):
        await running

    assert [turn.error for turn in lab.board.turns] == ['The person removed the agent, so Verifold cancelled the turn.']
    assert (len(calls(log, 'cancel')), len(calls(log, 'prompt'))) == (1, 1)


async def test_an_idle_agent_that_the_person_removes_stops_without_another_turn(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    await until(lambda: activity.of('bo').state == 'idle')

    await lab.leave('bo', 'person')
    async with asyncio.timeout(30):
        await running

    assert (len(lab.board.turns), len(calls(log, 'prompt'))) == (1, 1)


async def test_an_agent_that_the_person_removes_while_its_doorbell_waits_for_a_quiet_board_stops_at_once(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    activity = Activity()
    # The board never counts as quiet here, so the doorbell for the ask would wait for an hour.
    running = asyncio.create_task(loop_for(served, tmp_path, activity, quiet=3_600, max_quiet=3_600).run())
    await until(lambda: activity.of('bo').state == 'idle')
    await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
    # The loop takes the post and starts to wait for a quiet board before the person removes the agent.
    for _ in range(50):
        await asyncio.sleep(0)

    await lab.leave('bo', 'person')
    async with asyncio.timeout(30):
        await running

    assert (len(lab.board.turns), len(calls(log, 'prompt'))) == (1, 1)


async def test_an_agent_that_the_person_removes_while_the_lab_is_out_of_time_stops_too(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    lab = served.lab
    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    await until(lambda: bool(calls(log, 'prompt')))
    await lab.set_time_left(timedelta(0))
    await lab.run_out_of_time()
    await until(lambda: activity.of('bo').state == 'waiting')

    await lab.leave('bo', 'person')
    async with asyncio.timeout(30):
        await running
    await lab.set_time_left(timedelta(hours=1))

    assert len(calls(log, 'prompt')) == 1


async def test_a_harness_that_fails_after_its_agent_left_is_not_started_again(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[bool] = []

    @asynccontextmanager
    async def open_session(*_: object) -> AsyncGenerator[BlockingSession]:
        opened.append(True)
        await served.lab.leave('bo', 'person')
        raise BrokenPipeError('The harness closed its stdin.')
        yield BlockingSession()

    monkeypatch.setattr(AgentSession, 'open', open_session)

    # A restart would wait a minute first, and the test would run out of time.
    async with asyncio.timeout(30):
        await loop_for(served, tmp_path, retry_after=60).run()

    assert opened == [True]
    assert [turn.error for turn in served.lab.board.turns] == ['BrokenPipeError: The harness closed its stdin.']


async def test_an_agent_whose_turn_runs_on_after_it_left_is_stopped_after_a_moment(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_LEAVE', 'bo')
    monkeypatch.setenv('FAKE_ACP_SLOW_AFTER_LEAVE', '1')

    async with asyncio.timeout(30):
        await loop_for(served, tmp_path, leave_grace=0.2).run()

    assert [turn.error for turn in served.lab.board.turns] == [
        'The agent left the lab and its turn ran on for 0.2 seconds, so Verifold cancelled the turn.'
    ]
    assert (len(calls(log, 'cancel')), len(calls(log, 'prompt'))) == (1, 1)


async def test_a_permission_request_from_an_agent_that_left_is_refused_and_asks_nobody(
    served: ServedBoard, tmp_path: Path
) -> None:
    lab = served.lab
    loop = loop_for(served, tmp_path)
    choices = (
        PermissionChoice(id='yes', name='Allow once', kind='allow_once'),
        PermissionChoice(id='no', name='Reject', kind='reject_once'),
    )
    await lab.leave('bo', 'bo')
    posts = len(lab.board.posts)

    chosen = await loop._permission(PermissionRequest(title='run make', choices=choices))
    cancelled = await loop._permission(PermissionRequest(title='run make', choices=choices[:1]))

    assert (chosen, cancelled, len(lab.board.posts)) == ('no', None, posts)


async def test_the_ask_of_an_agent_that_the_person_removes_while_it_waits_for_a_permission_needs_nobody(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_PERMISSION', '1')
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: bool(needs_person(lab.board)))
    asked = needs_person(lab.board)[0].post.text

    await lab.leave('bo', 'person')
    async with asyncio.timeout(30):
        await running

    assert (asked, needs_person(lab.board)) == ('Permission needed: a tool call', ())
    assert [turn.error for turn in lab.board.turns] == ['The person removed the agent, so Verifold cancelled the turn.']
    assert len(calls(log, 'cancel')) == 1


async def test_a_removal_while_a_failed_harness_waits_for_its_restart_ends_the_wait_and_starts_nothing(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[bool] = []

    @asynccontextmanager
    async def open_session(*_: object) -> AsyncGenerator[BlockingSession]:
        opened.append(True)
        raise BrokenPipeError('The harness closed its stdin.')
        yield BlockingSession()

    monkeypatch.setattr(AgentSession, 'open', open_session)
    lab = served.lab
    # The restart would come after a minute.
    running = asyncio.create_task(loop_for(served, tmp_path, retry_after=60).run())
    await until(lambda: len(lab.board.turns) == 1)
    await asyncio.sleep(0.1)

    await lab.leave('bo', 'person')
    async with asyncio.timeout(30):
        await running

    assert opened == [True]


async def test_no_alarm_rings_after_an_agent_behind_the_close_left_a_closed_lab(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await lab.join(agent('cy'))
    await lab.post(PostRequest(kind='close', text='The answer stands.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-2', accepts=True), 'cy')
    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: activity.of('bo').state == 'working')
        await lab.set_alarm('bo', 0.02, quiet=False)
        await until(lambda: len(lab.board.turns) == 1)
        # The time of the alarm passes before cy leaves, so the loop looks at the clock when the alarm is due.
        pass_time(served, 5)
        await lab.leave('cy', 'cy')
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert lab_state(lab.board) == 'closed'
    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']


async def test_an_agent_that_ended_its_turn_wakes_when_an_agent_that_it_wrote_to_leaves_an_open_lab(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await lab.join(agent('cy'))
    await lab.post(PostRequest(kind='ask', text='Which seed?', thread='t-1', mentions=('ada',)), 'bo')
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        # Bo wrote nothing to cy, so cy's departure wakes nobody.
        await lab.leave('cy', 'cy')
        await asyncio.sleep(0.3)
        assert len(calls(log, 'prompt')) == 1

        await lab.leave('ada', 'person')
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.3)
    finally:
        running.cancel()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.', DEPARTURE]


async def stop(running: asyncio.Task[None]) -> None:
    """Stop an agent's loop, the way that a stop of Verifold does."""
    running.cancel()
    with suppress(asyncio.CancelledError):
        await running


async def one_turn(served: ServedBoard, tmp_path: Path) -> None:
    """Run the agent for one turn that it ends itself, and then stop Verifold."""
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: len(served.lab.board.turns) == 1)
    await stop(running)


def back(tmp_path: Path, why: str = RESTARTED, *, kept: bool = True, cut_off: bool = False) -> str:
    # The lab's settings stop the agents' processes when Verifold stops, so a restart says so.
    stopped = why == RESTARTED
    return back_message(why, 'Start.', tmp_path / 'bo', kept=kept, cut_off=cut_off, jobs_stopped=stopped)


def prompts(log: Path) -> list[object]:
    return [call['text'] for call in calls(log, 'prompt')]


ASK = PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',))


async def test_the_record_keeps_each_turns_start_and_end_with_the_session_and_what_the_agent_had_seen(
    served: ServedBoard, tmp_path: Path
) -> None:
    lab = served.lab

    await one_turn(served, tmp_path)

    start, end = lab.board.starts[0], lab.board.turns[0]
    # The agent sat down at event 5, the lab's newest. Its post in the turn brought it the news up to that post.
    assert (start.agent, start.session, start.seen) == ('bo', 'session-bo', 5)
    assert end.seen == lab.board.posts[-1].seq
    assert start.seq < end.seen < end.seq
    assert not end.stopped
    was = before(lab.board, 'bo')
    assert (was.seen, was.session, was.rested, was.cut_off) == (end.seen, 'session-bo', start, False)


async def test_after_a_restart_an_agent_that_ended_its_turn_waits_and_its_next_wake_says_what_happened(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await one_turn(served, tmp_path)
    activity = Activity()

    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        # The restart starts no turn: the agent chose to wait, and it waits again.
        await until(lambda: activity.of('bo').state == 'idle')
        await asyncio.sleep(0.3)
        assert prompts(log) == ['Start.']
        await lab.post(ASK, 'ada')
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.3)
    finally:
        await stop(running)

    assert prompts(log) == ['Start.', f'{back(tmp_path)}\n\n{DOORBELL}']
    assert [call['session'] for call in calls(log, 'load_session')] == ['session-bo']
    assert len(calls(log, 'new_session')) == 1
    assert posts_by(served, 'bo')[-1].startswith('Seen p-')


async def test_a_post_that_came_while_verifold_was_down_rings_one_doorbell_after_the_restart(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await one_turn(served, tmp_path)
    await lab.post(ASK, 'ada')

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.5)
    finally:
        await stop(running)

    assert prompts(log) == ['Start.', f'{back(tmp_path)}\n\n{DOORBELL}']
    assert posts_by(served, 'bo')[-1].startswith('Seen p-')


async def test_an_agent_whose_turn_verifold_cut_off_goes_on_at_once_and_its_alarm_from_that_turn_stays(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    monkeypatch.setenv('FAKE_ACP_SLOW', '1')
    first = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: len(calls(log, 'prompt')) == 1)
    set_ = await lab.set_alarm('bo', 0.01, quiet=False)
    await stop(first)
    assert (len(lab.board.starts), len(lab.board.turns), before(lab.board, 'bo').cut_off) == (1, 0, True)
    monkeypatch.delenv('FAKE_ACP_SLOW')

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.5)
    finally:
        await stop(running)

    # The alarm rings once, after the turn that went on at once.
    assert prompts(log) == ['Start.', back(tmp_path, cut_off=True), alarm_message(set_)]


async def test_an_agent_whose_harness_loads_no_session_hears_that_its_conversation_is_new(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    await one_turn(served, tmp_path)
    monkeypatch.setenv('FAKE_ACP_NO_LOAD', '1')
    await lab.post(ASK, 'ada')

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 2)
    finally:
        await stop(running)

    assert prompts(log) == ['Start.', f'{back(tmp_path, kept=False)}\n\n{DOORBELL}']
    assert (len(calls(log, 'new_session')), calls(log, 'load_session')) == (2, [])
    assert all(turn.error is None for turn in lab.board.turns)


async def test_an_agent_from_a_record_without_turn_starts_gets_its_message_at_once(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    # A record from before Verifold kept turn starts cannot tell whether the agent's last turn ended.
    await lab.end_turn(TurnSummary(agent='bo', seconds=1, usage=Usage()))

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 2)
    finally:
        await stop(running)

    assert prompts(log) == [back(tmp_path, kept=False)]


@pytest.mark.parametrize('passed', [True, False])
async def test_an_alarm_that_waited_when_verifold_stopped_rings_once_at_its_time_after_the_restart(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch, *, passed: bool
) -> None:
    lab = served.lab
    monkeypatch.setenv('FAKE_ACP_TURN_SECONDS', '0.5')
    first = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: len(lab.board.starts) == 1)
    set_ = await lab.set_alarm('bo', 1, quiet=False)
    await until(lambda: len(lab.board.turns) == 1)
    await stop(first)

    if passed:
        pass_time(served, 90)
    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        if not passed:
            await asyncio.sleep(0.5)
            assert prompts(log) == ['Start.']
            pass_time(served, 90)
            # The loop looks at the clock again when the board changes.
            await lab.post(SIDE_NOTE, 'ada')
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.5)
    finally:
        await stop(running)

    assert prompts(log) == ['Start.', f'{back(tmp_path)}\n\n{alarm_message(set_)}']


async def test_an_alarm_that_rang_before_verifold_stopped_does_not_ring_again_after_the_restart(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    first = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: len(lab.board.turns) == 1)
    set_ = await lab.set_alarm('bo', 0.02, quiet=False)
    await until(lambda: len(lab.board.turns) == 2)
    await stop(first)
    assert (prompts(log), lab.board.starts[-1].rang) == (['Start.', alarm_message(set_)], set_.seq)

    activity = Activity()
    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: activity.of('bo').state == 'idle')
        pass_time(served, 5)
        # The agent waits again, and a change of the board makes the loop look at the clock.
        await lab.post(SIDE_NOTE, 'ada')
        await asyncio.sleep(0.3)
    finally:
        await stop(running)

    assert (prompts(log), pending_alarm(lab.board, 'bo')) == (['Start.', alarm_message(set_)], None)


async def test_an_agent_that_verifold_stopped_hears_that_the_person_started_it_again(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    monkeypatch.setenv('FAKE_ACP_CRASH', '1')
    async with asyncio.timeout(30):
        await loop_for(served, tmp_path).run()
    monkeypatch.delenv('FAKE_ACP_CRASH')

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 4)
    finally:
        await stop(running)

    assert prompts(log)[-1] == back(tmp_path, STARTED_AGAIN)
    assert not before(lab.board, 'bo').stopped


async def test_a_harness_that_fails_when_it_loads_the_conversation_opens_a_new_one_on_its_last_start(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    await one_turn(served, tmp_path)
    monkeypatch.setenv('FAKE_ACP_CRASH_LOAD', '1')
    await lab.post(ASK, 'ada')

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(calls(log, 'prompt')) == 2)
    finally:
        await stop(running)

    assert (len(calls(log, 'load_session')), len(calls(log, 'new_session'))) == (2, 2)
    assert prompts(log)[1] == f'{back(tmp_path, kept=False)}\n\n{DOORBELL}'
    assert not any(turn.stopped for turn in lab.board.turns)


async def test_a_harness_that_fails_and_cannot_load_its_session_tells_the_agent_that_its_conversation_is_new(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_NO_LOAD', '1')
    monkeypatch.setenv('FAKE_ACP_CRASH_ONCE', str(tmp_path / 'crashed'))

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(calls(log, 'prompt')) == 2)
    finally:
        await stop(running)

    assert prompts(log) == ['Start.', back(tmp_path, HARNESS_FAILED, kept=False)]


async def test_a_harness_that_fails_when_it_starts_spends_no_alarm_and_moves_the_agent_nowhere(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    monkeypatch.setenv('FAKE_ACP_TURN_SECONDS', '0.5')
    first = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: len(lab.board.starts) == 1)
    set_ = await lab.set_alarm('bo', 1, quiet=False)
    await until(lambda: len(lab.board.turns) == 1)
    await stop(first)
    was = before(lab.board, 'bo')
    pass_time(served, 90)
    monkeypatch.setenv('FAKE_ACP_CRASH_LOAD', '1')

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        # The harness fails twice when it loads the conversation, and then it opens a new one.
        await until(lambda: len(lab.board.turns) == 3)
        failed = lab.board.turns[1:]
        assert [(turn.no_turn, turn.seen, bool(turn.error)) for turn in failed] == [(True, was.seen, True)] * 2
        assert (pending_alarm(lab.board, 'bo'), before(lab.board, 'bo')) == (set_, was)
        await until(lambda: len(lab.board.turns) == 4)
        await asyncio.sleep(0.5)
    finally:
        await stop(running)

    assert prompts(log) == ['Start.', f'{back(tmp_path, kept=False)}\n\n{alarm_message(set_)}']


async def test_a_second_restart_after_a_harness_failed_when_it_started_starts_no_turn(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    await one_turn(served, tmp_path)
    monkeypatch.setenv('FAKE_ACP_CRASH_LOAD', '1')
    failing = asyncio.create_task(loop_for(served, tmp_path).run())
    await until(lambda: len(lab.board.turns) == 2)
    await stop(failing)
    monkeypatch.delenv('FAKE_ACP_CRASH_LOAD')
    activity = Activity()

    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: activity.of('bo').state == 'idle')
        await asyncio.sleep(0.5)
    finally:
        await stop(running)

    assert prompts(log) == ['Start.']


@pytest.mark.parametrize('cut_off', [True, False])
async def test_a_blind_checker_starts_its_rerun_again_after_a_restart_and_reads_no_board(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch, *, cut_off: bool
) -> None:
    lab = served.lab
    if cut_off:
        monkeypatch.setenv('FAKE_ACP_SLOW', '1')
        first = asyncio.create_task(loop_for(served, tmp_path).run())
        await until(lambda: len(calls(log, 'prompt')) == 1)
        await stop(first)
        monkeypatch.delenv('FAKE_ACP_SLOW')
    else:
        await one_turn(served, tmp_path)
    assert before(lab.board, 'bo').cut_off is cut_off

    # The loop of an agent with one job ends when a turn leaves the job undone and nothing running.
    async with asyncio.timeout(30):
        await loop_for(served, tmp_path, done=lambda _: False).run()

    assert prompts(log) == ['Start.', 'Start.']
    assert (len(calls(log, 'new_session')), calls(log, 'load_session')) == (2, [])


async def test_a_turn_with_a_start_and_no_prompt_reads_as_a_turn_without_an_end(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    # Verifold stopped between the mark and the message, so the harness never got the turn.
    await lab.start_turn('bo', 'session-bo', 5)

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
    finally:
        await stop(running)

    assert prompts(log) == [back(tmp_path, cut_off=True)]
    assert 'The record has no end for your last turn, so Verifold may have stopped while it ran.' in back(
        tmp_path, cut_off=True
    )


async def test_a_turn_that_fails_in_a_loaded_conversation_goes_on_in_a_new_one(
    served: ServedBoard, tmp_path: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab = served.lab
    await one_turn(served, tmp_path)
    monkeypatch.setenv('FAKE_ACP_CRASH_ONCE', str(tmp_path / 'crashed'))
    await lab.post(ASK, 'ada')

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 3)
    finally:
        await stop(running)

    woken = f'{back(tmp_path)}\n\n{DOORBELL}'
    assert prompts(log) == ['Start.', woken, back(tmp_path, kept=False)]
    assert (len(calls(log, 'load_session')), len(calls(log, 'new_session'))) == (1, 2)
    assert [turn.no_turn for turn in lab.board.turns] == [False, False, False]


async def test_no_agent_of_a_closed_lab_gets_a_message_when_verifold_restarts(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await lab.post(PostRequest(kind='close', text='The answer stands.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-2', accepts=True), 'bo')
    # The stop cut the agent's turn off. In an open lab the agent would go on at once.
    await lab.start_turn('bo', 'session-bo', lab.board.seq)
    assert lab_state(lab.board) == 'closed'

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(calls(log, 'load_session')) == 1)
        await asyncio.sleep(0.5)
        assert prompts(log) == []
        # The person's words open the lab again, and they reach every agent.
        await lab.post(PostRequest(kind='message', text='One more thing.', thread='t-1'), 'person')
        await until(lambda: len(lab.board.turns) == 1)
    finally:
        await stop(running)

    assert prompts(log) == [f'{back(tmp_path, cut_off=True)}\n\n{DOORBELL}']


async def test_an_agent_that_comes_back_to_a_lab_out_of_time_waits_and_then_gets_the_new_end(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    await lab.start_turn('bo', 'session-bo', lab.board.seq)
    await lab.set_time_left(timedelta(0))
    await lab.run_out_of_time()
    activity = Activity()

    running = asyncio.create_task(loop_for(served, tmp_path, activity).run())
    try:
        await until(lambda: activity.of('bo').state == 'waiting')
        await asyncio.sleep(0.3)
        assert prompts(log) == []
        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: len(lab.board.turns) == 1)
    finally:
        await stop(running)

    # The message says already that the stop of Verifold stopped the agent's processes.
    facts = time_facts(lab.board.ends_at, AtTimeLimit.FINISH)
    assert facts.startswith('The person gave the lab more time. The lab now ends at ')
    assert prompts(log) == [f'{back(tmp_path, cut_off=True)}\n\n{facts}']


async def test_a_post_from_before_the_agents_last_turn_that_it_never_read_rings_after_a_restart(
    served: ServedBoard, tmp_path: Path, log: Path
) -> None:
    lab = served.lab
    # The post came before the turn, the turn started for another reason, and the agent read nothing in it.
    await lab.post(ASK, 'ada')
    await lab.start_turn('bo', 'session-bo', 5)
    await lab.end_turn(TurnSummary(agent='bo', seconds=1, usage=Usage(), seen=5))

    running = asyncio.create_task(loop_for(served, tmp_path).run())
    try:
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(0.3)
    finally:
        await stop(running)

    assert prompts(log) == [f'{back(tmp_path)}\n\n{DOORBELL}']
    assert posts_by(served, 'bo')[-1].startswith('Seen p-')
