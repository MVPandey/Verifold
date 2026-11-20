"""Folding a record's events into its board."""

from collections.abc import Iterable
from dataclasses import replace
from functools import reduce
from typing import assert_never

from verifold.protocol.events import (
    ActingSet,
    ActionDecided,
    ActionsPaused,
    AgentJoined,
    AgentLeft,
    AgentNamed,
    AlarmSet,
    AllowanceDrafted,
    AllowanceEnded,
    AllowanceStarted,
    BadgeSet,
    BudgetSet,
    ClaimLapsed,
    CoordinatorSet,
    DeliverableDecided,
    DeliverableSet,
    DeskSet,
    Event,
    LabOpened,
    LimitReached,
    LimitsReported,
    ModeSet,
    NotesSet,
    OnCallSet,
    PaceSet,
    PermissionGranted,
    Posted,
    PowerSet,
    ProfileSet,
    QuestionRevised,
    RequestAnswered,
    RerunLeaseSet,
    RerunRequested,
    RerunTaken,
    ReviewerSet,
    RoundClosed,
    SettingsSet,
    TaskClaimed,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnInterrupted,
    TurnStarted,
    Voted,
    WatchSet,
    WentQuiet,
)
from verifold.protocol.posts import Close, Round
from verifold.society.allowances import (
    check_acting,
    check_action_post,
    check_decided,
    check_draft,
    check_end,
    check_mode,
    check_pause,
    check_start,
)
from verifold.society.board import Board
from verifold.society.budget import check_limit
from verifold.society.candidates import settled
from verifold.society.coordinator import check_answered, check_made, check_power
from verifold.society.deliverables import (
    check_decision,
    check_deliverable,
    check_offer,
    check_offers_thread,
    offers_title,
)
from verifold.society.desk import check_desk_move, check_desk_post, check_desk_set, check_interrupt
from verifold.society.errors import RejectedEvent
from verifold.society.pace import check_limits, check_pace
from verifold.society.rounds import check_close, check_rounds
from verifold.society.rules import (
    check_agent,
    check_alarm,
    check_coordinator,
    check_lease,
    check_left,
    check_named,
    check_notes,
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
from verifold.society.tasks import check_claim, check_lapse, check_task_post
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
            check_desk_move(board, event)
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
        case DeskSet():
            check_desk_set(board, event)
            return replace(board, seq=event.seq, desks=(*board.desks, event))
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
            check_rounds(board, event)
            check_desk_post(board, event)
            check_task_post(board, event)
            check_action_post(board, event)
            rounds = (*board.rounds, event) if isinstance(post, Round) else board.rounds
            # A close that names no candidate closes on what stood just before it, also after a later concession.
            unnamed = (
                (*board.unnamed_closes, (post.id, settled(board)))
                if isinstance(post, Close) and post.candidate is None
                else board.unnamed_closes
            )
            posts = (*board.posts, event)
            return replace(board, seq=event.seq, posts=posts, rounds=rounds, unnamed_closes=unnamed)
        case RoundClosed():
            check_close(board, event)
            return replace(board, seq=event.seq, round_closes=(*board.round_closes, event))
        case WatchSet():
            check_watch(board, event)
            return replace(board, seq=event.seq, watches=(*board.watches, event))
        case AlarmSet():
            check_alarm(board, event)
            return replace(board, seq=event.seq, alarms=(*board.alarms, event))
        case ProfileSet():
            check_profile(board, event)
            return _profiled(board, event)
        case NotesSet():
            check_notes(board, event)
            return replace(board, seq=event.seq, notes=(*board.notes, event))
        case ReviewerSet():
            check_reviewer(board, event)
            return replace(board, seq=event.seq, reviewers=(*board.reviewers, event))
        case TurnStarted():
            check_turn(board, event)
            return replace(board, seq=event.seq, starts=(*board.starts, event))
        case TurnEnded(usage=usage, cost_usd=cost):
            check_turn(board, event)
            return replace(
                board,
                seq=event.seq,
                turns=(*board.turns, event),
                spent_tokens=board.spent_tokens + usage.input_tokens + usage.output_tokens,
                spent_dollars=board.spent_dollars + max(cost or 0.0, 0.0),
            )
        case TurnInterrupted():
            check_interrupt(board, event)
            return replace(board, seq=event.seq, interrupts=(*board.interrupts, event))
        case RerunRequested():
            check_rerun(board, event)
            return replace(board, seq=event.seq, reruns=(*board.reruns, event))
        case RerunTaken():
            check_take(board, event)
            return replace(board, seq=event.seq, takes=(*board.takes, event))
        case RerunLeaseSet():
            check_lease(board, event)
            return replace(board, seq=event.seq, leases=(*board.leases, event))
        case TaskClaimed():
            check_claim(board, event)
            return replace(board, seq=event.seq, claims=(*board.claims, event))
        case ClaimLapsed():
            check_lapse(board, event)
            return replace(board, seq=event.seq, lapses=(*board.lapses, event))
        case TimeSet():
            check_time(event)
            check_made(board, event)
            check_desk_move(board, event)
            return replace(board, seq=event.seq, times=(*board.times, event))
        case TimeRanOut():
            check_time_out(board, event)
            return replace(board, seq=event.seq, times=(*board.times, event))
        case BudgetSet():
            check_desk_move(board, event)
            return replace(board, seq=event.seq, budgets=(*board.budgets, event))
        case LimitReached():
            check_limit(board, event)
            return replace(board, seq=event.seq, limits=(*board.limits, event))
        case LimitsReported():
            check_limits(board, event)
            return replace(board, seq=event.seq, seat_limits=(*board.seat_limits, event))
        case PaceSet():
            check_pace(board, event)
            return replace(board, seq=event.seq, paces=(*board.paces, event))
        case WentQuiet():
            # A mark from an earlier version. It changes nothing on the board.
            return replace(board, seq=event.seq)
        case SettingsSet(settings=settings):
            check_made(board, event)
            numbers = (*board.seat_numbers, (event.seq, settings.reviewers.seats))
            history = (*board.settings_history, (event.seq, settings))
            return replace(board, seq=event.seq, settings=settings, seat_numbers=numbers, settings_history=history)
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
            check_desk_move(board, event)
            return _stated(board, event)
        case DeliverableDecided():
            check_decision(board, event)
            return replace(board, seq=event.seq, decisions=(*board.decisions, event))
        case _:
            return _allowances(board, event)


def _allowances(  # noqa: PLR0911
    board: Board,
    event: ActingSet | ModeSet | AllowanceDrafted | AllowanceStarted | AllowanceEnded | ActionsPaused | ActionDecided,
) -> Board:
    # The events of acting seats, their modes, their allowances, and the person's answers to their actions.
    match event:
        case ActingSet():
            check_acting(board, event)
            return replace(board, seq=event.seq, actings=(*board.actings, event))
        case ModeSet():
            check_mode(board, event)
            return replace(board, seq=event.seq, modes=(*board.modes, event))
        case AllowanceDrafted():
            check_draft(board, event)
            return replace(board, seq=event.seq, drafts=(*board.drafts, event))
        case AllowanceStarted():
            check_start(board, event)
            return replace(board, seq=event.seq, allowance_starts=(*board.allowance_starts, event))
        case AllowanceEnded():
            check_end(board, event)
            return replace(board, seq=event.seq, allowance_ends=(*board.allowance_ends, event))
        case ActionsPaused():
            check_pause(board, event)
            return replace(board, seq=event.seq, pauses=(*board.pauses, event))
        case ActionDecided():
            check_decided(board, event)
            return replace(board, seq=event.seq, action_decisions=(*board.action_decisions, event))
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
