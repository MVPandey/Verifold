"""Where posts stand after the objections, checks, and answers to them."""

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import Standing
from verifold.protocol.posts import Answer, Check, Close, Objection, Plan, RuledOut
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


def takers(board: Board, call_id: PostId) -> tuple[AgentId, ...]:
    """
    Return the agents that took a call, each once, in the order that they took it.

    An agent of the lab takes a call with a plan that replies to it. The caller's own plan takes nothing.
    """
    call = board.post(call_id)
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    return tuple(
        dict.fromkeys(
            entry.post.author
            for entry in board.replies(call_id)
            if isinstance(entry.post, Plan)
            and call
            and entry.post.author != call.post.author
            and entry.post.author in workers
        )
    )


def is_open_call(board: Board, call_id: PostId) -> bool:
    """Return whether a call still needs an agent: nobody took it, and the caller did not withdraw it."""
    call = board.post(call_id)
    withdrawn = any(
        isinstance(entry.post, RuledOut) and call and entry.post.author == call.post.author
        for entry in board.replies(call_id)
    )
    return not withdrawn and not takers(board, call_id)


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


def closing(board: Board) -> Posted | None:
    """
    Return the post that says that the lab is done, when one stands: the newest close.

    It stands until an objection to it stands, its author concedes one, its author withdraws it with a ruled-out
    lead that replies to it, or the person posts to the lab after it. An older close does not come back.
    """
    entry = next((entry for entry in reversed(board.posts) if isinstance(entry.post, Close)), None)
    if entry is None or standing(board, entry.post.id) in {'disputed', 'conceded'}:
        return None
    withdrawn = any(
        isinstance(reply.post, RuledOut) and reply.post.author == entry.post.author
        for reply in board.replies(entry.post.id)
    )
    # The person's new words to the lab open it again: the agents have something to do.
    steered = any(
        later.post.author == PERSON and later.post.reply_to is None and later.seq > entry.seq for later in board.posts
    )
    return None if withdrawn or steered else entry


def agreed(board: Board, close: Posted) -> tuple[AgentId, ...]:
    """Return the agents of the lab that agreed with a close, each once, in the order that they agreed."""
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    return tuple(
        dict.fromkeys(
            reply.post.author
            for reply in board.replies(close.post.id)
            if isinstance(reply.post, Answer)
            and reply.post.accepts
            # An agent takes its agreement back when it concedes an objection to it.
            and standing(board, reply.post.id) not in {'conceded', 'disputed'}
            and reply.post.author in workers
            and reply.post.author != close.post.author
        )
    )
