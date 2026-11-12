import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from datetime import timedelta
from pathlib import Path

import pytest
from builders import until
from conftest import ServedBoard
from fakes import FAKE_HARNESS

from verifold.protocol.app import AgentState
from verifold.protocol.join import MAX_NEWS, PostRequest
from verifold.protocol.settings import AtTimeLimit, JobSettings, Settings
from verifold.protocol.usage import Usage
from verifold.runner import agent_loop
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings, Shared
from verifold.runner.git import git
from verifold.runner.messages import DOORBELL, more_time_message
from verifold.runner.permissions import GrantAsks
from verifold.runner.session import AgentSession, TurnResult
from verifold.server.activity import Activity


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / 'calls.jsonl'
    monkeypatch.setenv('FAKE_ACP_LOG', str(path))
    return path


def calls(log: Path, event: str) -> list[dict[str, object]]:
    lines = log.read_text().splitlines() if log.exists() else []
    return [call for call in map(json.loads, lines) if call['event'] == event]


def loop_for(
    served: ServedBoard,
    tmp_path: Path,
    activity: Activity | None = None,
    grant_asks: GrantAsks | None = None,
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
        shared=Shared(activity=activity, grant_asks=grant_asks),
    )


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
    # The quiet window is far longer than the gaps, so a slow machine cannot split the burst.
    running = asyncio.create_task(loop_for(served, tmp_path, quiet=1.5, max_quiet=10).run())
    try:
        await until(lambda: len(lab.board.turns) == 1)
        for number in range(3):
            await lab.post(PostRequest(kind='ask', text=f'Question {number}?', thread='t-1', mentions=('bo',)), 'ada')
            await asyncio.sleep(0.05)
        await until(lambda: len(lab.board.turns) == 2)
        await asyncio.sleep(2)
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


async def test_an_agent_with_one_job_gets_one_turn_for_it(served: ServedBoard, tmp_path: Path, log: Path) -> None:
    loop = loop_for(served, tmp_path)
    loop._done = lambda _: False

    async with asyncio.timeout(30):
        await loop.run()

    assert [call['text'] for call in calls(log, 'prompt')] == ['Start.']
    assert len(served.lab.board.turns) == 1


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

    assert asked.text == 'Permission needed: run make'


@pytest.mark.usefixtures('log')
async def test_in_auto_mode_a_command_without_a_grant_is_refused_at_once_and_the_person_gets_an_ask(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_COMMAND', './gpu python3 train.py')
    lab = served.lab
    running = asyncio.create_task(loop_for(served, tmp_path, grant_asks=GrantAsks(lab)).run())
    try:
        await until(lambda: 'Permission: no.' in posts_by(served, 'bo'))
    finally:
        running.cancel()

    asks = [entry.post for entry in lab.board.posts if entry.post.kind == 'ask']
    assert [ask.text for ask in asks] == ['Refused without a grant: ./gpu python3 train.py']


@pytest.mark.usefixtures('log')
async def test_a_granted_command_runs_without_a_question(
    served: ServedBoard, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_COMMAND', './gpu python3 train.py')
    lab = served.lab
    await lab.grant('./gpu')
    running = asyncio.create_task(loop_for(served, tmp_path, grant_asks=GrantAsks(lab)).run())
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
