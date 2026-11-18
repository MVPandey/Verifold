"""
The lab's limits other than its time: its budget in tokens and in dollars, and its disk limit.

What the lab spent is the sum over the ends of its turns in the record. A turn reports what it spent when it ends,
so the lab can pass its budget by the turns that run when it reaches it. When what it spent reaches a budget, or
its files reach the disk limit, the record says so, and the agents stop as at the time limit.
"""

from verifold.protocol.events import Limit, LimitReached
from verifold.protocol.join import BudgetLine
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent

GB = 1024**3
"""The bytes of one gigabyte, as the disk limit counts them."""


def budget_line(board: Board) -> BudgetLine:
    """Return the lab's budget, what the lab spent, and what is left."""
    budget = board.budget
    tokens = budget.tokens if budget else None
    dollars = budget.dollars if budget else None
    return BudgetLine(
        tokens=tokens,
        dollars=dollars,
        spent_tokens=board.spent_tokens,
        spent_dollars=round(board.spent_dollars, 4),
        tokens_left=None if tokens is None else max(tokens - board.spent_tokens, 0),
        dollars_left=None if dollars is None else round(max(dollars - board.spent_dollars, 0), 4),
    )


def disk_limit(board: Board) -> int | None:
    """Return the lab's disk limit in bytes, or `None` when it has none."""
    limit = board.settings.disk.limit_gb
    return limit * GB if limit else None


LIMITS: tuple[Limit, ...] = ('tokens', 'dollars', 'disk')

LIMIT_NAMES: dict[Limit, str] = {'tokens': 'budget in tokens', 'dollars': 'budget in dollars', 'disk': 'disk limit'}
"""Each limit as a sentence names it."""


def reached(board: Board, disk_bytes: int | None = None) -> Limit | None:
    """
    Return the first limit that the lab has reached now, or `None`.

    `disk_bytes` is what the lab's files took when Verifold measured them last, or `None` before a measure.
    """
    return next((limit for limit in LIMITS if _reaches(board, limit, disk_bytes)), None)


def _reaches(board: Board, limit: Limit, disk_bytes: int | None) -> bool:
    budget = board.budget
    match limit:
        case 'tokens':
            return bool(budget and budget.tokens is not None and board.spent_tokens >= budget.tokens)
        case 'dollars':
            return bool(budget and budget.dollars is not None and board.spent_dollars >= budget.dollars)
        case 'disk':
            most = disk_limit(board)
            return most is not None and disk_bytes is not None and disk_bytes >= most


def check_limit(board: Board, event: LimitReached) -> None:
    """
    Check that the lab has reached the limit that the event names, and that no other limit of it stands.

    Raises:
        RejectedEvent: The lab stands at a limit already, or it has not reached this one.

    """
    if board.at_limit is not None:
        raise RejectedEvent(f'The lab stands at its {LIMIT_NAMES[board.at_limit]} already.')
    if not _reaches(board, event.limit, event.disk_bytes if event.limit == 'disk' else None):
        raise RejectedEvent(f'The lab has not reached its {LIMIT_NAMES[event.limit]}.')
