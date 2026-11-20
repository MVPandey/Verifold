"""
The person's grant of spare seats: how many agents the lab's coordinator may add by itself, and of which kinds.

The newest grant stands, and zero seats take it back. Each agent that the coordinator adds by itself after the grant,
with its own yes to its own request, takes one of its seats, also when the power for agents covered the add too. A
seat that the grant covers names a harness, a model, an effort, and a mode that one of the grant's kinds names. The
grant covers no removal: a request to remove an agent waits for the person.
"""

from verifold.protocol.events import SeatsGranted
from verifold.protocol.ids import PERSON
from verifold.protocol.moves import AddMove, AddSeat, SeatGrant
from verifold.protocol.posts import MoveRequest
from verifold.society.board import Board


def standing_grant(board: Board) -> SeatsGranted | None:
    """Return the person's grant of spare seats that stands, or `None` when the person granted none or took it back."""
    granted = board.seat_grants[-1] if board.seat_grants else None
    return granted if granted and granted.grant.seats else None


def seats_used(board: Board, granted: SeatsGranted) -> int:
    """Return how many agents the coordinator added by itself, with its own yes, after a grant."""
    return sum(
        isinstance(entry.post, MoveRequest) and isinstance(entry.post.move, AddMove)
        for answered in board.answers
        if answered.seq > granted.seq and answered.yes and answered.by != PERSON
        if (entry := board.post(answered.request))
    )


def seats_left(board: Board) -> int:
    """Return how many spare seats the grant that stands has left. Zero without a grant."""
    granted = standing_grant(board)
    return max(granted.grant.seats - seats_used(board, granted), 0) if granted else 0


def outside_grant(board: Board, seat: AddSeat) -> str | None:
    """
    Return why the person's grant of spare seats does not cover a seat, or `None` when it covers it.

    It covers a seat while it has a seat left and one of its kinds names the seat's harness, model, effort, and mode.
    """
    granted = standing_grant(board)
    if granted is None:
        return 'The person granted no spare seats.'
    if not seats_left(board):
        used = granted.grant.seats
        return f'The {used} spare {"seat" if used == 1 else "seats"} that the person granted {"is" if used == 1 else "are"} used.'
    if seat.choice() not in granted.grant.choices:
        return f'The grant of spare seats names no kind of seat with these values. It names: {kinds(granted.grant)}.'
    return None


def kinds(grant: SeatGrant) -> str:
    """Return the kinds of seat that a grant names, as one line for an agent. `default` is the harness's own value."""
    return '; '.join(
        f'harness {choice.harness}, model {choice.model or "default"}, effort {choice.effort or "default"}, '
        f'mode {choice.mode or "default"}'
        for choice in grant.choices
    )
