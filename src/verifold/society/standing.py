"""Where posts stand after the objections, checks, and answers to them."""

from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.join import Standing
from verifold.protocol.posts import Answer, Check, Objection
from verifold.society.board import Board


def standing(board: Board, post_id: PostId) -> Standing:
    """
    Return where a post stands. The first state that applies wins.

    - `conceded`: the post's author accepted an objection to it.
    - `disputed`: a check of the post failed, or an objection stands. A later check that holds overrules an
      objection, unless the objector wrote that check.
    - `held_up`: a blind checker from another model family reran the post, and its check holds.
    - `checked`: another agent's check holds.
    - `open`: none of the above.

    Checks and objections that their own authors conceded don't count.
    """
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


def is_answered(board: Board, post_id: PostId, by: AgentId | None = None) -> bool:
    """Return whether an answer replies to a post: any answer, or with `by`, an answer from that author."""
    return any(
        isinstance(entry.post, Answer) and (by is None or entry.post.author == by) for entry in board.replies(post_id)
    )


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
