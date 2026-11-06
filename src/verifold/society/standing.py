"""Where posts stand in the society: what objections, checks, and answers have done to them."""

from datetime import datetime, timedelta
from typing import Literal

from verifold.protocol.ids import PostId
from verifold.protocol.join import Standing
from verifold.protocol.posts import Answer, Check, Objection, Proposal
from verifold.society.board import Board
from verifold.society.errors import NotFound

type Decision = Literal['open', 'decided', 'disputed', 'withdrawn']


def standing(board: Board, post_id: PostId) -> Standing:
    """
    Return where a post stands.

    A post is `conceded` when its author accepted an objection to it. It is `disputed` when a check of it failed, or
    when an objection stands. A check that holds overrules an earlier objection when its author is not the objector.
    It is `held_up` when a blind checker from another model family reran it and its check holds, and nothing stands
    against it. It is `checked` when another agent's check holds and nothing stands against it. Otherwise it is
    `open`. Checks and objections that their own authors conceded do not count.
    """
    # A conceded check or objection no longer counts against or for its target.
    replies = tuple(entry for entry in board.replies(post_id) if standing(board, entry.post.id) != 'conceded')
    objections = tuple((entry.seq, entry.post) for entry in replies if isinstance(entry.post, Objection))
    checks = tuple((entry.seq, entry.post) for entry in replies if isinstance(entry.post, Check))
    if any(_conceded(board, objection) for _, objection in objections):
        return 'conceded'
    if any(check.outcome == 'fails' for _, check in checks):
        return 'disputed'
    if any(not _overruled(seq, objection, checks) for seq, objection in objections):
        return 'disputed'
    if any(_independent_rerun(board, post_id, check) for _, check in checks):
        return 'held_up'
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


def _independent_rerun(board: Board, post_id: PostId, check: Check) -> bool:
    checker = board.agent(check.author)
    target = board.post(post_id)
    author = board.agent(target.post.author) if target else None
    return bool(
        check.outcome == 'holds'
        and check.method == 'rerun'
        and checker
        and author
        and checker.agent.checks == post_id
        and checker.agent.model.family != author.agent.model.family
    )


def _conceded(board: Board, objection: Objection) -> bool:
    return any(isinstance(entry.post, Answer) and entry.post.accepts for entry in board.replies(objection.id))


def _overruled(objection_seq: int, objection: Objection, checks: tuple[tuple[int, Check], ...]) -> bool:
    return any(
        seq > objection_seq and check.outcome == 'holds' and check.author != objection.author for seq, check in checks
    )
