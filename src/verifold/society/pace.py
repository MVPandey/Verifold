"""
The pace of the lab: the seats' usage limits, the pauses of seats, and the limits of tokens for one hour.

The usage limits are the ones that the seats' harnesses report of their providers. A limit of tokens counts the input and the output tokens of the turns that ended in the hour of the clock, in UTC,
as the budget counts them. A turn reports what it spent when it ends, so a limit holds back the next turn and stops
no turn that runs. A pause stops no turn that runs either: the seat finishes it, and no post but the person's starts
another. The desk is the person's, so it takes no pause and no limit, and its turns count toward the lab's limit.

The person and the coordinator each have their own pause and their own limit for each seat and for the lab. A move
of the person replaces both of the same kind. The coordinator's own move only lowers what the person granted.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from verifold.protocol.agents import GUEST
from verifold.protocol.events import LimitsReported, PaceSet
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.join import CapLine, PauseLine
from verifold.protocol.moves import CapMove, PaceMove, PauseMove, ResumeMove
from verifold.protocol.posts import MoveRequest
from verifold.protocol.usage import SeatLimits
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent

NEAR_LIMIT = 80
"""The percent of a window above which a seat counts as near its provider's limit."""

type HoldKind = Literal['paused', 'seat', 'lab']
"""Why a seat's next turn waits: a pause, the seat's own limit of tokens per hour, or the lab's."""


@dataclass(frozen=True, slots=True)
class Cap:
    """The limit of tokens per hour that holds a seat or the lab: the lowest that stands, and who set it."""

    tokens: int
    by: AgentId
    why: str = ''
    share: bool = False
    """Whether the limit is the person's setting for the coordinator's seat, and no move."""


@dataclass(frozen=True, slots=True)
class Hold:
    """What keeps a seat's next turn from starting now, and until when."""

    kind: HoldKind
    by: AgentId
    until: datetime | None
    """When the seat may start a turn again. `None` for a pause that lasts until somebody resumes the seat."""
    tokens: int | None = None
    """For a limit: its tokens per hour."""


def limits_of(board: Board, agent_id: AgentId, now: datetime) -> SeatLimits | None:
    """
    Return a seat's usage limits as its harness reported them last, or `None` when it reported none.

    A window whose reset time passed by `now` is left out: its count started again, and no report says how far.
    """
    reported = next((entry for entry in reversed(board.seat_limits) if entry.agent == agent_id), None)
    if reported is None:
        return None
    limits = reported.limits
    windows = tuple(window for window in limits.windows if window.resets_at is None or window.resets_at > now)
    return limits.model_copy(update={'windows': windows}) if len(windows) != len(limits.windows) else limits


def near_limit(limits: SeatLimits | None) -> bool:
    """Return whether a window of the limits is above `NEAR_LIMIT` percent, or the provider refuses requests."""
    if limits is None:
        return False
    return limits.status == 'reached' or any(window.used_percent > NEAR_LIMIT for window in limits.windows)


def seats_near_limit(board: Board, now: datetime) -> int:
    """Return how many seats in the lab are near their provider's limit now, as `near_limit` says."""
    return sum(
        near_limit(limits_of(board, joined.agent.id, now))
        for joined in board.agents
        if not joined.agent.checks and not board.gone(joined.agent.id)
    )


def check_limits(board: Board, event: LimitsReported) -> None:
    """
    Check a report of a seat's limits: it is of an agent that Verifold runs and that is in the lab.

    Raises:
        RejectedEvent: The agent is not in the lab, or Verifold does not run it.

    """
    joined = board.agent(event.agent)
    if joined is None or board.gone(event.agent) or joined.agent.harness == GUEST:
        raise RejectedEvent(f'{event.agent} is no agent in this lab whose harness Verifold runs.')


def pause_of(board: Board, agent_id: AgentId, now: datetime) -> PaceSet | None:
    """Return the pause of a seat that stands at `now`, the person's first, or `None` while the seat is not paused."""
    person, coordinator = _layers(board, 'pause', agent_id)
    return next((entry for entry in (person, coordinator) if entry and _lasts(entry, now)), None)


def cap_of(board: Board, agent_id: AgentId | None) -> Cap | None:
    """
    Return the lowest limit of tokens per hour that holds a seat, or the lab with `None`, or `None` when none does.

    The limits of a seat are the person's, the coordinator's, and for the coordinator's seat the person's setting
    for it. The lab's limit holds every seat too, and `hold` says so apart.
    """
    found = [
        Cap(tokens=entry.move.tokens_per_hour, by=entry.by, why=entry.move.why)
        for entry in _layers(board, 'cap', agent_id)
        if entry and isinstance(entry.move, CapMove) and entry.move.tokens_per_hour
    ]
    share = board.settings.pace.coordinator_tokens_per_hour
    if agent_id is not None and agent_id == board.coordinator and share:
        found.append(Cap(tokens=share, by=PERSON, share=True))
    return min(found, key=lambda cap: cap.tokens, default=None)


def hour_of(now: datetime) -> datetime:
    """Return the start of the hour of the clock that holds `now`, in UTC."""
    return now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def spent_this_hour(board: Board, agent_id: AgentId | None, now: datetime) -> int:
    """Return the tokens of the turns of a seat, or of the lab with `None`, that ended in the hour that holds `now`."""
    start = hour_of(now)
    total = 0
    for turn in reversed(board.turns):
        if turn.at < start:
            break
        if agent_id is None or turn.agent == agent_id:
            total += turn.usage.input_tokens + turn.usage.output_tokens
    return total


def hold(board: Board, agent_id: AgentId, now: datetime) -> Hold | None:
    """
    Return what keeps a seat's next turn from starting at `now`, or `None` when nothing does.

    A pause comes first, then the seat's own limit of tokens per hour, then the lab's. The desk has none of them.
    """
    if board.is_desk(agent_id):
        return None
    pause = pause_of(board, agent_id, now)
    if pause and isinstance(pause.move, PauseMove):
        return Hold(kind='paused', by=pause.by, until=pause.move.until)
    next_hour = hour_of(now) + timedelta(hours=1)
    seat = cap_of(board, agent_id)
    if seat and spent_this_hour(board, agent_id, now) >= seat.tokens:
        return Hold(kind='seat', by=seat.by, until=next_hour, tokens=seat.tokens)
    lab = cap_of(board, None)
    if lab and spent_this_hour(board, None, now) >= lab.tokens:
        return Hold(kind='lab', by=lab.by, until=next_hour, tokens=lab.tokens)
    return None


def pause_line(board: Board, agent_id: AgentId, now: datetime) -> PauseLine | None:
    """Return the pause of a seat that stands at `now` as one line, or `None`."""
    pause = pause_of(board, agent_id, now)
    if pause is None or not isinstance(pause.move, PauseMove):
        return None
    return PauseLine(by=pause.by, since=pause.at, until=pause.move.until, why=pause.move.why)


def cap_line(board: Board, agent_id: AgentId | None, now: datetime) -> CapLine | None:
    """Return the lowest limit of tokens per hour of a seat, or of the lab with `None`, with this hour's spending."""
    cap = cap_of(board, agent_id)
    if cap is None:
        return None
    return CapLine(
        tokens_per_hour=cap.tokens,
        spent=spent_this_hour(board, agent_id, now),
        hour_ends=hour_of(now) + timedelta(hours=1),
        by=cap.by,
        why=cap.why,
        share=cap.share,
    )


def check_pace_target(board: Board, move: PaceMove) -> None:
    """
    Check the seat that a move of pace names: an agent in the lab that Verifold runs, and not the desk.

    Raises:
        RejectedEvent: The move names no such seat.

    """
    if move.agent is None:
        return
    joined = board.agent(move.agent)
    if joined is None or joined.agent.checks or board.gone(move.agent):
        raise RejectedEvent(f'{move.agent} is not an agent in this lab.')
    if board.is_desk(move.agent):
        raise RejectedEvent("The desk's seat is the person's, so it takes no pause and no limit.")
    if joined.agent.harness == GUEST:
        raise RejectedEvent(f'{move.agent} runs by itself, so Verifold starts no turn of it to pause or to hold back.')


def lowers(board: Board, move: PaceMove, at: datetime) -> str | None:
    """
    Return why the coordinator's own move of pace would not lower what the person granted, or `None` when it lowers.

    It pauses a seat, ends its own pause of a seat while the person's pause does not stand, sets a limit no higher
    than the person's limit for the seat or the lab and the lab's budget in tokens, or takes back its own limit.
    """
    if isinstance(move, PauseMove):
        return None
    if isinstance(move, ResumeMove):
        person, coordinator = _layers(board, 'pause', move.agent)
        if person and _lasts(person, at):
            return f'The person paused {move.agent}, so only the person resumes it.'
        return (
            None if coordinator and _lasts(coordinator, at) else f'No pause of the coordinator stands on {move.agent}.'
        )
    if move.tokens_per_hour is None:
        _, coordinator = _layers(board, 'cap', move.agent)
        return None if coordinator else f'No limit of the coordinator stands on {_scope(move.agent)}.'
    return _above(board, move.agent, move.tokens_per_hour)


def check_pace(board: Board, event: PaceSet) -> None:
    """
    Check a move of pace against the rules of the record.

    The seat is an agent of the lab that Verifold runs, other than the desk, and a pause ends after the move. A move
    that names a request follows the yes to that request at once, with the request's move. The coordinator's own
    move follows its own yes under the power for pace, and it lowers what the person granted.

    Raises:
        RejectedEvent: The move breaks one of these rules.

    """
    move = event.move
    check_pace_target(board, move)
    if isinstance(move, PauseMove) and move.until is not None and move.until <= event.at:
        raise RejectedEvent('The pause would end before now. Give a later time, or none to pause until a resume.')
    if isinstance(move, ResumeMove) and pause_of(board, move.agent, event.at) is None:
        raise RejectedEvent(f'{move.agent} is not paused.')
    answered = board.answers[-1] if board.answers and board.answers[-1].seq == board.seq else None
    if event.request is not None:
        entry = board.post(event.request)
        asked = entry.post.move if entry and isinstance(entry.post, MoveRequest) else None
        made = answered and answered.yes and answered.request == event.request and answered.by == event.by
        if not (made and asked == move):
            raise RejectedEvent(
                f'Only the move of the request {event.request}, just after its yes, names that request.'
            )
    if event.by == PERSON:
        return
    if event.request is None or event.by != board.coordinator:
        raise RejectedEvent(
            "A move of pace is the person's, or the coordinator's under the person's power for pace, after its request."
        )
    if refusal := lowers(board, move, event.at):
        raise RejectedEvent(refusal)


def _above(board: Board, agent: AgentId | None, tokens: int) -> str | None:
    # Why a limit of the coordinator would be higher than what the person granted, or `None`.
    budget = board.budget.tokens if board.budget else None
    if budget is not None and tokens > budget:
        return f"A limit of {tokens:,} tokens an hour is above the lab's budget of {budget:,} tokens."
    scopes = (agent, None) if agent is not None else (None,)
    for scope in scopes:
        person, _ = _layers(board, 'cap', scope)
        mine = person.move.tokens_per_hour if person and isinstance(person.move, CapMove) else None
        if mine is not None and tokens > mine:
            return f"A limit of {tokens:,} tokens an hour is above the person's limit of {mine:,} for {_scope(scope)}."
    return None


def _scope(agent: AgentId | None) -> str:
    return 'the lab' if agent is None else agent


def _layers(
    board: Board, kind: Literal['pause', 'cap'], agent: AgentId | None
) -> tuple[PaceSet | None, PaceSet | None]:
    # The person's move and the coordinator's move of one kind for one seat, or the lab with `None`, that stand. A
    # move of the person replaces both. A resume or a limit of `None` takes its maker's move back.
    person: PaceSet | None = None
    coordinator: PaceSet | None = None
    for entry in board.paces:
        move = entry.move
        if move.agent != agent or (kind == 'cap') != isinstance(move, CapMove):
            continue
        sets = isinstance(move, PauseMove) or (isinstance(move, CapMove) and move.tokens_per_hour is not None)
        if entry.by == PERSON:
            person, coordinator = (entry if sets else None), None
        else:
            coordinator = entry if sets else None
    return person, coordinator


def _lasts(entry: PaceSet, now: datetime) -> bool:
    move = entry.move
    return isinstance(move, PauseMove) and (move.until is None or move.until > now)
