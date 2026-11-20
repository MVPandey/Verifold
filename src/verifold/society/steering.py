"""
What the lab's coordinator steers by: the steering facts, and the log of its own moves.

The steering facts are counts, shares, rates, and ages that the record holds, computed for one moment. None of them
ranks an agent, a line of work, or an idea. Each fact is one field of `SteeringFacts` and one function here.

A move of the coordinator is a post of its own that changed the lab: a request for a move that got a yes, from the
person or from the coordinator under a power or a grant, a round that it opened, or a reading that it posted. The
log needs no record of its own: each move is a post, so an agent objects to a move as to any post, with an
`objection` that replies to it, and the coordinator hears it as a reply.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.join import MoveLine, SpareSeats, SteeringFacts, SteerKind
from verifold.protocol.moves import AddMove, CapMove, PauseMove, RemoveMove, ResumeMove
from verifold.protocol.posts import MoveRequest, Reading, Result, Round
from verifold.society.board import Board
from verifold.society.budget import budget_line
from verifold.society.coordinator import joined_by, waiting_posts
from verifold.society.lines import is_line_of_work
from verifold.society.pace import seats_near_limit
from verifold.society.spare import seats_left, standing_grant
from verifold.society.standing import standing
from verifold.society.tasks import open_tasks

WINDOW = timedelta(hours=1)
"""The window of each rate of the steering facts: the last hour by the lab's clock."""


@dataclass(frozen=True, slots=True)
class Steer:
    """One move of the coordinator: the post that holds it, when it took effect, and what the log shows of it."""

    entry: Posted
    at: datetime
    by: AgentId
    kind: SteerKind
    why: str
    agent: AgentId | None = None
    yes_by: AgentId | None = None


def moves(board: Board) -> tuple[Steer, ...]:
    """Return the coordinator's moves, the newest first, as the module says."""
    requested = tuple(
        _requested(entry, entry.post, answered.at, answered.by, joined_by(board, answered))
        for answered in board.answers
        if answered.yes
        if (entry := board.post(answered.request)) and isinstance(entry.post, MoveRequest)
    )
    posted = tuple(
        Steer(entry=entry, at=entry.at, by=entry.post.author, kind=entry.post.kind, why=entry.post.why or '')
        for entry in board.posts
        if isinstance(entry.post, Round | Reading) and entry.post.author == board.coordinator_at(entry.seq)
    )
    return tuple(sorted((*requested, *posted), key=lambda move: (move.at, move.entry.seq), reverse=True))


def _requested(entry: Posted, request: MoveRequest, at: datetime, yes_by: AgentId, added: AgentId | None) -> Steer:
    # A move that came from a request: a move of pace keeps its own why, and any other move has its reason in the
    # request's headline.
    move = request.move
    match move:
        case AddMove():
            agent, why = added, request.text
        case PauseMove() | ResumeMove() | CapMove():
            agent, why = move.agent, move.why or request.text
        case RemoveMove():
            agent, why = move.agent, request.text
        case _:
            agent, why = None, request.text
    return Steer(entry=entry, at=at, by=request.author, kind=move.type, why=why, agent=agent, yes_by=yes_by)


def move_line(board: Board, move: Steer, now: datetime) -> MoveLine:
    """Return one move of the coordinator as a fact for an agent, with its age at `now`."""
    return MoveLine(
        post=move.entry.post.id,
        kind=move.kind,
        by=move.by,
        minutes_ago=max(int((now - move.at).total_seconds() // 60), 0),
        why=move.why,
        agent=move.agent,
        yes_by=move.yes_by,
        disputed=standing(board, move.entry.post.id) == 'disputed',
    )


def steering_facts(board: Board, now: datetime) -> SteeringFacts:
    """Return the lab's steering facts at `now`, as `SteeringFacts` says."""
    since = now - WINDOW
    lines = {opened.thread.id: opened.at for opened in board.threads if is_line_of_work(opened.thread)}
    results = tuple(entry for entry in board.posts if isinstance(entry.post, Result) and since < entry.at <= now)
    in_lines = [entry.post.thread for entry in results if entry.post.thread in lines]
    busiest = max((in_lines.count(thread) for thread in set(in_lines)), default=0)
    tokens, dollars = _spent(board, since, now)
    reading = next((entry for entry in reversed(board.posts) if isinstance(entry.post, Reading)), None)
    rounds = board.rounds[-1] if board.rounds else None
    return SteeringFacts(
        lines=len(lines),
        new_lines=sum(since < at <= now for at in lines.values()),
        results=len(results),
        busiest_line_share=round(100 * busiest / len(results)) if results else None,
        built_on_others=sum(_built_on_others(board, entry) for entry in results),
        tokens_last_hour=tokens,
        dollars_last_hour=round(dollars, 4),
        budget_hours_left=_hours_left(board, tokens, dollars),
        seats_near_limit=seats_near_limit(board, now),
        reading_hours_ago=_hours(now - reading.at) if reading else None,
        round_hours_ago=_hours(now - rounds.at) if rounds else None,
        unowned_tasks=len(open_tasks(board, now)),
        waits_for_person=len(waiting_posts(board, now)),
    )


def spare_seats(board: Board) -> SpareSeats | None:
    """Return the spare seats that the person's grant has left, with its kinds, or `None` without a grant."""
    granted = standing_grant(board)
    if granted is None:
        return None
    return SpareSeats(left=seats_left(board), of=granted.grant.seats, kinds=granted.grant.choices)


def _built_on_others(board: Board, entry: Posted) -> bool:
    # A result builds on another agent's work when a post in its `builds_on` has another agent as its author.
    author = entry.post.author
    return any(
        (built := board.post(post_id)) is not None and built.post.author not in (author, PERSON)
        for post_id in entry.post.builds_on
    )


def _spent(board: Board, since: datetime, now: datetime) -> tuple[int, float]:
    # The tokens and the dollars of the turns that ended in the window.
    tokens, dollars = 0, 0.0
    for turn in reversed(board.turns):
        if turn.at <= since:
            break
        if turn.at <= now:
            tokens += turn.usage.input_tokens + turn.usage.output_tokens
            dollars += max(turn.cost_usd or 0.0, 0.0)
    return tokens, dollars


def _hours_left(board: Board, tokens: int, dollars: float) -> float | None:
    # The hours until a budget is spent at the window's rate, the first budget first.
    line = budget_line(board)
    hours = (
        *((line.tokens_left / tokens,) if line.tokens_left is not None and tokens else ()),
        *((line.dollars_left / dollars,) if line.dollars_left is not None and dollars else ()),
    )
    return round(min(hours), 1) if hours else None


def _hours(span: timedelta) -> float:
    return round(max(span.total_seconds(), 0) / 3_600, 1)
