"""Where posts stand in the society: what objections, checks, and answers have done to them."""

from datetime import datetime, timedelta
from typing import Literal

from verifold.protocol.ids import PostId
from verifold.protocol.posts import Answer, Check, Objection, Proposal
from verifold.society.board import Board
from verifold.society.errors import NotFound

type Standing = Literal['open', 'checked', 'disputed', 'conceded']
type Decision = Literal['open', 'decided', 'disputed', 'withdrawn']


def standing(board: Board, post_id: PostId) -> Standing:
    """
    Return where a post stands.

    A post is `conceded` when its author accepted an objection to it. It is `disputed` when a check of it failed, or
    when an objection stands. A check that holds overrules an earlier objection when its author is not the objector.
    It is `checked` when another agent's check holds and nothing stands against it. Otherwise it is `open`.
    """
    replies = board.replies(post_id)
    objections = tuple((entry.seq, entry.post) for entry in replies if isinstance(entry.post, Objection))
    checks = tuple((entry.seq, entry.post) for entry in replies if isinstance(entry.post, Check))
    if any(_conceded(board, objection) for _, objection in objections):
        return 'conceded'
    if any(check.outcome == 'fails' for _, check in checks):
        return 'disputed'
    if any(not _overruled(seq, objection, checks) for seq, objection in objections):
        return 'disputed'
    return 'checked' if checks else 'open'


def is_answered(board: Board, post_id: PostId) -> bool:
    """Return whether any answer replies to a post."""
    return any(isinstance(entry.post, Answer) for entry in board.replies(post_id))


def decision(board: Board, proposal_id: PostId, now: datetime, window: timedelta) -> Decision:
    """
    Return the state of a proposal at `now`.

    A proposal is `decided` once `window` has passed since it was posted with no objection standing. A later
    objection makes it `disputed` again. It is `withdrawn` when its author accepted an objection to it.

    Raises:
        NotFound: No proposal has this ID.

    """
    entry = board.post(proposal_id)
    if entry is None or not isinstance(entry.post, Proposal):
        raise NotFound(f'No proposal has the ID {proposal_id}.')
    match standing(board, proposal_id):
        case 'conceded':
            return 'withdrawn'
        case 'disputed':
            return 'disputed'
    return 'decided' if now - entry.at >= window else 'open'


def _conceded(board: Board, objection: Objection) -> bool:
    return any(isinstance(entry.post, Answer) and entry.post.accepts for entry in board.replies(objection.id))


def _overruled(objection_seq: int, objection: Objection, checks: tuple[tuple[int, Check], ...]) -> bool:
    return any(
        seq > objection_seq and check.outcome == 'holds' and check.author != objection.author for seq, check in checks
    )
