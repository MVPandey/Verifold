"""The obstacles of the lab: the `ruled_out` posts of its lines of work, and what the posts that build on each made of it."""

from dataclasses import dataclass

from verifold.protocol.events import Posted
from verifold.protocol.join import ObstacleState
from verifold.protocol.posts import Plan, Result, RuledOut
from verifold.society.board import Board
from verifold.society.lines import is_line_of_work, withdraws
from verifold.society.standing import standing


@dataclass(frozen=True, slots=True)
class Obstacle:
    """A `ruled_out` post as an obstacle: its state, and the posts that put it there."""

    entry: Posted
    state: ObstacleState
    builders: tuple[Posted, ...]
    """
    For `removed`, the results that stand and build on it. For `taken_up`, the plans and results that build on it.
    Neither holds a post whose author conceded it, ruled it out, or left the lab.
    """


def obstacles(board: Board) -> tuple[Obstacle, ...]:
    """
    Return every obstacle of the lab, oldest first, as `ObstacleState` defines it.

    A record from before obstacles has its `ruled_out` posts as obstacles by the same rule.
    """
    lines = {opened.thread.id for opened in board.threads if is_line_of_work(opened.thread)}
    return tuple(
        _obstacle(board, entry)
        for entry in board.posts
        if isinstance(entry.post, RuledOut) and entry.post.thread in lines and not withdraws(board, entry.post)
    )


def _obstacle(board: Board, entry: Posted) -> Obstacle:
    work = tuple(
        other
        for other in board.built_on(entry.post.id)
        if isinstance(other.post, Plan | Result) and _holds(board, other)
    )
    removing = tuple(
        other for other in work if isinstance(other.post, Result) and standing(board, other.post.id) != 'disputed'
    )
    if removing:
        return Obstacle(entry=entry, state='removed', builders=removing)
    return Obstacle(entry=entry, state='taken_up' if work else 'open', builders=work)


def _holds(board: Board, work: Posted) -> bool:
    # Whether a plan or a result still counts for an obstacle: its author is in the lab, did not concede it, and did
    # not rule it out with a `ruled_out` that replies to it or builds on it.
    author = work.post.author
    around = (*board.replies(work.post.id), *board.built_on(work.post.id))
    ruled = any(isinstance(other.post, RuledOut) and other.post.author == author for other in around)
    return not ruled and not board.gone(author) and standing(board, work.post.id) != 'conceded'
