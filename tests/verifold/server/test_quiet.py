import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import timedelta

import pytest
from builders import until

from verifold.protocol.events import TurnSummary
from verifold.protocol.join import PostRequest
from verifold.protocol.usage import Usage
from verifold.server.activity import Activity
from verifold.server.lab import Lab
from verifold.server.quiet import notice_quiet
from verifold.society.errors import RejectedEvent

AFTER = 0.1


@asynccontextmanager
async def noticing(lab: Lab, activity: Activity) -> AsyncGenerator[None]:
    task = asyncio.create_task(notice_quiet(lab, activity, AFTER))
    try:
        yield
    finally:
        task.cancel()


async def end_turn(lab: Lab, activity: Activity, agent: str) -> None:
    await lab.end_turn(TurnSummary(agent=agent, seconds=1, usage=Usage()))
    await activity.set(agent, 'idle')


async def test_a_lab_in_which_every_agent_ended_its_turn_goes_quiet_once_until_a_new_post(lab: Lab) -> None:
    activity = Activity()
    async with noticing(lab, activity):
        await end_turn(lab, activity, 'ada')
        await end_turn(lab, activity, 'bo')
        await until(lambda: lab.board.quiet is not None)
        first = lab.board.quiet
        assert first is not None
        assert first.seconds == AFTER

        # The agents wake, post nothing, and end their turns. The spell has its mark, so the lab stays quiet.
        await end_turn(lab, activity, 'ada')
        await asyncio.sleep(3 * AFTER)
        assert lab.board.quiet == first

        # One post from two agents is a wake that brought little, so the next wait is twice as long.
        await lab.post(PostRequest(kind='message', text='Nothing more from me.', thread='t-1'), 'bo')
        await until(lambda: lab.board.quiet != first)
        second = lab.board.quiet
        assert second is not None
        assert (second.seconds, lab.board.slow_spells) == (2 * AFTER, 1)

        # A wake that brought a post from each agent sets the wait back.
        await lab.post(PostRequest(kind='message', text='One more idea.', thread='t-1'), 'ada')
        await lab.post(PostRequest(kind='message', text='I build on it.', thread='t-1'), 'bo')
        await until(lambda: lab.board.quiet != second)
        third = lab.board.quiet
        assert third is not None
        assert (third.seconds, lab.board.slow_spells) == (AFTER, 0)


async def test_a_lab_does_not_go_quiet_while_an_agent_is_in_a_turn_or_waits_for_the_person(lab: Lab) -> None:
    activity = Activity()
    async with noticing(lab, activity):
        await end_turn(lab, activity, 'ada')
        await activity.set('bo', 'working')
        await asyncio.sleep(3 * AFTER)
        assert lab.board.quiet is None

        await activity.set('bo', 'waiting', 'Asks you: run a script')
        await asyncio.sleep(3 * AFTER)
        assert lab.board.quiet is None

        await activity.set('bo', 'starting')
        await asyncio.sleep(3 * AFTER)
        assert lab.board.quiet is None

        await end_turn(lab, activity, 'bo')
        await until(lambda: lab.board.quiet is not None)


async def test_a_lab_does_not_go_quiet_before_a_turn_ended_or_when_it_is_out_of_time(lab: Lab) -> None:
    activity = Activity()
    async with noticing(lab, activity):
        await asyncio.sleep(3 * AFTER)
        assert lab.board.quiet is None

        await lab.set_time_left(timedelta(0))
        await lab.run_out_of_time()
        await end_turn(lab, activity, 'ada')
        await asyncio.sleep(3 * AFTER)
        assert lab.board.quiet is None

        await lab.set_time_left(timedelta(hours=1))
        await until(lambda: lab.board.quiet is not None)


async def test_the_record_marks_a_quiet_spell_once_and_never_in_a_lab_out_of_time(lab: Lab) -> None:
    await lab.go_quiet(180)
    with pytest.raises(RejectedEvent, match='goes quiet once'):
        await lab.go_quiet(180)

    await lab.post(PostRequest(kind='message', text='One more idea.', thread='t-1'), 'bo')
    await lab.set_time_left(timedelta(0))
    await lab.run_out_of_time()
    with pytest.raises(RejectedEvent, match='goes quiet once'):
        await lab.go_quiet(180)
