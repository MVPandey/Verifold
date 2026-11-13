"""Notices a quiet lab: when no agent works and nothing reaches the board for a while, the record says so."""

import asyncio
from contextlib import suppress

from verifold.server.activity import Activity
from verifold.server.lab import Lab
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent


async def notice_quiet(lab: Lab, activity: Activity, after: float) -> None:
    """
    Record that the lab went quiet whenever no agent is in a turn and the board gets no event for `after` seconds.

    A doorbell rings only for posts, so nothing else wakes a lab in which every agent ended its turn. The record
    marks each quiet spell once, and a lab that stays quiet after it stays so. Run it for as long as the lab runs.
    """
    while True:
        board, version = lab.board, activity.version
        resting = _resting(board, activity)
        await _change(lab, activity, board.seq, version, after if resting else None)
        if resting and lab.board.seq == board.seq and activity.version == version:
            # A post can arrive while this waits for the lab's lock. The lab then refuses the event.
            with suppress(RejectedEvent):
                await lab.go_quiet(after)


def _resting(board: Board, activity: Activity) -> bool:
    # Whether the lab can go quiet from now: an agent ended a turn, none is in one, and the spell has no mark yet.
    # An agent that waits for the person is in a turn.
    if not board.turns or board.out_of_time or board.in_quiet_spell:
        return False
    return all(activity.of(entry.agent.id).state not in ('working', 'waiting') for entry in board.agents)


async def _change(lab: Lab, activity: Activity, seq: int, version: int, timeout: float | None) -> None:
    # Return once the board or the activity changes, or after `timeout` seconds when given.
    waits = [
        asyncio.create_task(lab.wait_for_change(seq, timeout)),
        asyncio.create_task(activity.wait_for_change(version, timeout)),
    ]
    try:
        await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for wait in waits:
            wait.cancel()
