"""Folding a record's events into its board."""

from collections.abc import Iterable
from dataclasses import replace
from functools import reduce

from verifold.protocol.events import (
    AgentJoined,
    Event,
    LabOpened,
    Posted,
    RerunRequested,
    ThreadOpened,
    TurnEnded,
    WatchSet,
)
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.rules import check_agent, check_post, check_rerun, check_thread, check_turn, check_watch


def apply(board: Board, event: Event) -> Board:
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
        case TurnEnded():
            check_turn(board, event)
            return replace(board, seq=event.seq, turns=(*board.turns, event))
        case RerunRequested():
            check_rerun(board, event)
            return replace(board, seq=event.seq, reruns=(*board.reruns, event))


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
