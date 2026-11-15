"""Folding a record's events into its board."""

from collections.abc import Iterable
from dataclasses import replace
from functools import reduce
from typing import assert_never

from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AgentNamed,
    AlarmSet,
    BadgeSet,
    CoordinatorSet,
    DeliverableDecided,
    DeliverableSet,
    Event,
    LabOpened,
    OnCallSet,
    PermissionGranted,
    Posted,
    PowerSet,
    ProfileSet,
    QuestionRevised,
    RequestAnswered,
    RerunRequested,
    RerunTaken,
    ReviewerSet,
    SettingsSet,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    Voted,
    WatchSet,
    WentQuiet,
)
from verifold.society.board import Board
from verifold.society.coordinator import check_answered, check_made, check_power
from verifold.society.deliverables import (
    check_decision,
    check_deliverable,
    check_offer,
    check_offers_thread,
    offers_title,
)
from verifold.society.errors import RejectedEvent
from verifold.society.rules import (
    check_agent,
    check_alarm,
    check_coordinator,
    check_left,
    check_named,
    check_on_call,
    check_post,
    check_profile,
    check_rerun,
    check_reviewer,
    check_revision,
    check_take,
    check_thread,
    check_time,
    check_time_out,
    check_turn,
    check_watch,
)
from verifold.society.votes import check_badge, check_vote, with_badge, with_vote


# One case with one return per event type keeps the match flat.
def apply(board: Board, event: Event) -> Board:  # noqa: PLR0911, PLR0912, PLR0915
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
        case QuestionRevised():
            check_revision(board, event)
            return replace(board, seq=event.seq, revisions=(*board.revisions, event))
        case AgentJoined(agent=agent):
            check_agent(board, agent)
            labels = (*board.labels, (event.seq, agent.id, agent.name))
            return replace(board, seq=event.seq, agents=(*board.agents, event), labels=labels)
        case AgentNamed():
            return _named(board, event)
        case OnCallSet():
            check_on_call(board, event)
            return replace(board, seq=event.seq, on_calls=(*board.on_calls, event))
        case CoordinatorSet():
            check_coordinator(board, event)
            return replace(board, seq=event.seq, coordinators=(*board.coordinators, event))
        case AgentLeft():
            check_left(board, event)
            return replace(board, seq=event.seq, left=(*board.left, event))
        case ThreadOpened(thread=thread):
            check_thread(board, thread)
            check_offers_thread(board, thread)
            return replace(board, seq=event.seq, threads=(*board.threads, event))
        case Posted(post=post):
            check_post(board, post)
            check_offer(board, post)
            return replace(board, seq=event.seq, posts=(*board.posts, event))
        case WatchSet():
            check_watch(board, event)
            return replace(board, seq=event.seq, watches=(*board.watches, event))
        case AlarmSet():
            check_alarm(board, event)
            return replace(board, seq=event.seq, alarms=(*board.alarms, event))
        case ProfileSet():
            check_profile(board, event)
            return _profiled(board, event)
        case ReviewerSet():
            check_reviewer(board, event)
            return replace(board, seq=event.seq, reviewers=(*board.reviewers, event))
        case TurnStarted():
            check_turn(board, event)
            return replace(board, seq=event.seq, starts=(*board.starts, event))
        case TurnEnded():
            check_turn(board, event)
            return replace(board, seq=event.seq, turns=(*board.turns, event))
        case RerunRequested():
            check_rerun(board, event)
            return replace(board, seq=event.seq, reruns=(*board.reruns, event))
        case RerunTaken():
            check_take(board, event)
            return replace(board, seq=event.seq, takes=(*board.takes, event))
        case TimeSet():
            check_time(event)
            check_made(board, event)
            return replace(board, seq=event.seq, times=(*board.times, event))
        case TimeRanOut():
            check_time_out(board, event)
            return replace(board, seq=event.seq, times=(*board.times, event))
        case WentQuiet():
            # A mark from an earlier version. It changes nothing on the board.
            return replace(board, seq=event.seq)
        case SettingsSet(settings=settings):
            check_made(board, event)
            numbers = (*board.seat_numbers, (event.seq, settings.reviewers.seats))
            return replace(board, seq=event.seq, settings=settings, seat_numbers=numbers)
        case PermissionGranted(prefix=prefix):
            grants = board.grants if prefix in board.grants else (*board.grants, prefix)
            return replace(board, seq=event.seq, grants=grants)
        case PowerSet():
            check_power(board, event)
            return replace(board, seq=event.seq, power_sets=(*board.power_sets, event))
        case RequestAnswered():
            check_answered(board, event)
            return replace(board, seq=event.seq, answers=(*board.answers, event))
        case Voted():
            check_vote(board, event)
            return with_vote(board, event)
        case BadgeSet():
            check_badge(board, event)
            return with_badge(board, event)
        case DeliverableSet():
            check_deliverable(board, event)
            return _stated(board, event)
        case DeliverableDecided():
            check_decision(board, event)
            return replace(board, seq=event.seq, decisions=(*board.decisions, event))
        case _:
            assert_never(event)


def _named(board: Board, event: AgentNamed) -> Board:
    # The seat has its new label from here on, and the board keeps the label from before. The label is the agent's
    # name unless the agent chose one.
    check_named(board, event)
    labels = (*board.labels, (event.seq, event.agent, event.name))
    agents = board.agents if board.chosen_name(event.agent) else _with_name(board, event.agent, event.name)
    return replace(board, seq=event.seq, agents=agents, labels=labels)


def _profiled(board: Board, event: ProfileSet) -> Board:
    # A name that the agent chose is its name from here on. An empty name takes the chosen name back, so the seat's
    # label is the name again. The profile events keep every name that the agent chose.
    profiles = (*board.profiles, event)
    if event.name is None:
        return replace(board, seq=event.seq, profiles=profiles)
    name = event.name or board.label(event.agent)
    return replace(board, seq=event.seq, profiles=profiles, agents=_with_name(board, event.agent, name))


def _stated(board: Board, event: DeliverableSet) -> Board:
    # The thread of the offers for a deliverable has the deliverable's sentence in its title. The title follows a
    # new sentence, and the thread's event in the record keeps the title that it opened with.
    title = offers_title(event.deliverable, event.text)
    threads = tuple(
        entry.model_copy(update={'thread': entry.thread.model_copy(update={'title': title})})
        if entry.thread.deliverable == event.deliverable
        else entry
        for entry in board.threads
    )
    return replace(board, seq=event.seq, deliverables=(*board.deliverables, event), threads=threads)


def _with_name(board: Board, agent_id: str, name: str) -> tuple[AgentJoined, ...]:
    return tuple(
        entry.model_copy(update={'agent': entry.agent.model_copy(update={'name': name})})
        if entry.agent.id == agent_id
        else entry
        for entry in board.agents
    )


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
