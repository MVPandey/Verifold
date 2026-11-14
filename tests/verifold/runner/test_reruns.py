import asyncio
from pathlib import Path

import pytest
from builders import until

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import RerunRequested, TurnSummary
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.protocol.usage import Usage
from verifold.runner.reruns import Reruns
from verifold.server.join import Members
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board

EVIDENCE = (FileEvidence(path='bench.json', commit='c' * 40),)


async def unused(*_: object) -> None:
    """Stand in for the supervisor, which the tests replace together with the check itself."""


def a_rerun_loop(lab: Lab, tmp_path: Path) -> Reruns:
    return Reruns(lab, Members(), tmp_path, tuple, unused)


async def a_failed_checker(lab: Lab, checker: str, post: str) -> None:
    """Record a blind checker that joined for `post` and failed, as one whose harness crashed."""
    await lab.join(Agent(id=checker, name=checker, harness='fake', model=ModelSpec(family='openai'), checks=post))
    await lab.end_turn(TurnSummary(agent=checker, seconds=0, usage=Usage(), error='It crashed.', rerun_failed=True))


async def test_requests_for_one_post_share_one_checker_and_the_next_request_follows_a_checker_without_a_check(
    lab: Lab, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []
    release = asyncio.Event()

    async def check(_: Reruns, request: RerunRequested) -> None:
        # The first checker runs until the test lets it go, and then ends without a check and without an event.
        started.append(request.by)
        if request.by == 'bo':
            await release.wait()

    monkeypatch.setattr(Reruns, '_check', check)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', EVIDENCE)
    running = asyncio.create_task(a_rerun_loop(lab, tmp_path).run())
    try:
        await lab.request_rerun('bo', 'p-2')
        await lab.request_rerun('person', 'p-2')
        await until(lambda: started == ['bo'])
        await asyncio.sleep(0.1)
        assert started == ['bo']

        release.set()
        await until(lambda: started == ['bo', 'person'], timeout=5)
    finally:
        running.cancel()


async def test_one_blind_check_answers_every_request_before_it(
    lab: Lab, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []
    closing = asyncio.Event()

    async def check(_: Reruns, request: RerunRequested) -> None:
        # The checker posts its check, and its session then takes a while to close.
        started.append(request.by)
        if request.by != 'bo':
            return
        await lab.join(Agent(id='dee', name='Dee', harness='fake', model=ModelSpec(family='openai'), checks='p-2'))
        answer = PostRequest(kind='check', text='So.', thread='t-1', reply_to='p-2', outcome='holds', method='rerun')
        await Member(lab, 'dee').post(answer)
        await closing.wait()

    def checked(board: Board) -> bool:
        return any(entry.post.kind == 'check' for entry in board.posts)

    monkeypatch.setattr(Reruns, '_check', check)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', EVIDENCE)
    running = asyncio.create_task(a_rerun_loop(lab, tmp_path).run())
    try:
        await lab.request_rerun('bo', 'p-2')
        await lab.request_rerun('person', 'p-2')
        await until(lambda: checked(lab.board))
        # A request after the check is a new rerun. It starts when the first checker's session has closed.
        await lab.request_rerun('ada', 'p-2')
        await asyncio.sleep(0.1)
        assert started == ['bo']

        closing.set()
        await until(lambda: started == ['bo', 'ada'], timeout=5)
    finally:
        running.cancel()


async def test_a_checker_that_fails_starts_no_other_checker_until_a_member_asks_again(
    lab: Lab, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []

    async def check(_: Reruns, request: RerunRequested) -> None:
        started.append(request.by)
        await a_failed_checker(lab, f'checker-{request.seq}', request.post)

    monkeypatch.setattr(Reruns, '_check', check)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', EVIDENCE)
    await lab.request_rerun('bo', 'p-2')
    await lab.request_rerun('person', 'p-2')
    running = asyncio.create_task(a_rerun_loop(lab, tmp_path).run())
    try:
        await until(lambda: started == ['bo'])
        await asyncio.sleep(0.1)
        # The person's request joined the rerun that failed, so it starts no checker of its own.
        assert started == ['bo']

        await lab.request_rerun('person', 'p-2')
        await until(lambda: started == ['bo', 'person'], timeout=5)
    finally:
        running.cancel()


async def test_a_new_loop_starts_checkers_only_for_the_requests_that_still_wait(
    lab: Lab, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []

    async def check(_: Reruns, request: RerunRequested) -> None:
        started.append(request.post)

    monkeypatch.setattr(Reruns, '_check', check)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', EVIDENCE)
    await lab.post(PostRequest(kind='result', text='9.1x.', thread='t-1'), 'ada', EVIDENCE)
    await lab.post(PostRequest(kind='result', text='7.4x.', thread='t-1'), 'ada', EVIDENCE)
    # Before the restart, the rerun of p-2 failed, the time limit cancelled the turn of the checker of p-3, and the
    # request for p-4 had no checker yet.
    await lab.request_rerun('bo', 'p-2')
    await a_failed_checker(lab, 'dee', 'p-2')
    await lab.request_rerun('bo', 'p-3')
    await lab.join(Agent(id='eve', name='Eve', harness='fake', model=ModelSpec(family='openai'), checks='p-3'))
    await lab.end_turn(TurnSummary(agent='eve', seconds=1, usage=Usage(), error='The lab ran out of time.'))
    await lab.request_rerun('person', 'p-4')
    running = asyncio.create_task(a_rerun_loop(lab, tmp_path).run())
    try:
        await until(lambda: len(started) == 2)
        await asyncio.sleep(0.1)
    finally:
        running.cancel()

    assert started == ['p-3', 'p-4']


async def test_an_error_after_the_check_leaves_a_rerun_that_did_not_fail(
    lab: Lab, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def check(_: Reruns, request: RerunRequested) -> None:
        # The checker posts its check, and then its cleanup fails.
        checker = f'checker-{request.seq}'
        await lab.join(Agent(id=checker, name=checker, harness='fake', model=ModelSpec(family='openai'), checks='p-2'))
        answer = PostRequest(kind='check', text='So.', thread='t-1', reply_to='p-2', outcome='holds', method='rerun')
        await Member(lab, checker).post(answer)
        raise RuntimeError('The folder is gone.')

    monkeypatch.setattr(Reruns, '_check', check)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', EVIDENCE)
    await lab.request_rerun('bo', 'p-2')
    running = asyncio.create_task(a_rerun_loop(lab, tmp_path).run())
    try:
        await until(lambda: bool(lab.board.turns))
    finally:
        running.cancel()

    assert [(turn.error, turn.rerun_failed) for turn in lab.board.turns] == [
        ('RuntimeError: The folder is gone.', False)
    ]
