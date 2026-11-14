"""Folding a record's events into its board."""

from collections.abc import Iterable
from dataclasses import replace
from functools import reduce
from typing import assert_never

from verifold.protocol.events import (
    AgentJoined,
    AlarmSet,
    Event,
    LabOpened,
    PermissionGranted,
    Posted,
    ProfileSet,
    RerunRequested,
    SettingsSet,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    WatchSet,
    WentQuiet,
)
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.rules import (
    check_agent,
    check_alarm,
    check_post,
    check_profile,
    check_rerun,
    check_thread,
    check_time,
    check_time_out,
    check_turn,
    check_watch,
)


# One case with one return per event type keeps the match flat.
def apply(board: Board, event: Event) -> Board:  # noqa: PLR0911, PLR0912
    """
    Return the board after one more event.

    Raises:
        RejectedEvent: The event is out of sequence or breaks a rule of the record.

    """
    if event.seq != board.seq + 1:
        raise RejectedEvent(f'Event {event.seq} does not follow event {board.seq}.')
    match event:
        case LabOpened():
            raise RejectedEvent('A record has one lab_opened event, and it comes first.')
        case AgentJoined(agent=agent):
            check_agent(board, agent)
            return replace(board, seq=event.seq, agents=(*board.agents, event))
        case ThreadOpened(thread=thread):
            check_thread(board, thread)
            return replace(board, seq=event.seq, threads=(*board.threads, event))
        case Posted(post=post):
            check_post(board, post)
            return replace(board, seq=event.seq, posts=(*board.posts, event))
        case WatchSet():
            check_watch(board, event)
            return replace(board, seq=event.seq, watches=(*board.watches, event))
        case AlarmSet():
            check_alarm(board, event)
            return replace(board, seq=event.seq, alarms=(*board.alarms, event))
        case ProfileSet():
            check_profile(board, event)
            return replace(board, seq=event.seq, profiles=(*board.profiles, event))
        case TurnEnded():
            check_turn(board, event)
            return replace(board, seq=event.seq, turns=(*board.turns, event))
        case RerunRequested():
            check_rerun(board, event)
            return replace(board, seq=event.seq, reruns=(*board.reruns, event))
        case TimeSet():
            check_time(event)
            return replace(board, seq=event.seq, times=(*board.times, event))
        case TimeRanOut():
            check_time_out(board, event)
            return replace(board, seq=event.seq, times=(*board.times, event))
        case WentQuiet():
            # A mark from an earlier version. It changes nothing on the board.
            return replace(board, seq=event.seq)
        case SettingsSet(settings=settings):
            return replace(board, seq=event.seq, settings=settings)
        case PermissionGranted(prefix=prefix):
            grants = board.grants if prefix in board.grants else (*board.grants, prefix)
            return replace(board, seq=event.seq, grants=grants)
        case _:
            assert_never(event)


def fold(events: Iterable[Event]) -> Board:
    """
    Return the board that a record adds up to.

    Raises:
        RejectedEvent: The record does not start with `lab_opened` as event 1, or a later event breaks a rule.

    """
    remaining = iter(events)
    first = next(remaining, None)
    if not isinstance(first, LabOpened) or first.seq != 1:
        raise RejectedEvent('A record starts with lab_opened as event 1.')
    return reduce(apply, remaining, Board(opened=first, seq=first.seq))
