"""
How checks tested a result: reproduced from its own files, or challenged on something that its author did not use.

A rerun that matches shows that the result's files give its numbers again. A challenge tests the claim beyond the
data that produced it: other dates, other data, or a changed assumption. These marks stand beside a result's
standing and change none of it. A challenge is a check, so one that fails disputes the result as any failed check
does, and one that holds counts as any check that holds. Only a rerun can make a result stand as held up.
"""

from collections import Counter

from verifold.protocol.events import Posted
from verifold.protocol.ids import PostId
from verifold.protocol.join import RestsOn, Support, Tested
from verifold.protocol.posts import Check, Result
from verifold.society.board import Board
from verifold.society.standing import standing


def how_tested(board: Board, post_id: PostId) -> tuple[Tested, ...]:
    """
    Return how checks tested a result, in a fixed order: reproduced, challenged, challenge failed.

    A check counts unless its own author conceded an objection to it. Every other kind of post has none.
    """
    entry = board.post(post_id)
    if entry is None or not isinstance(entry.post, Result):
        return ()
    checks = tuple(
        (reply.post.method, reply.post.outcome)
        for reply in board.replies(post_id)
        if isinstance(reply.post, Check) and standing(board, reply.post.id) != 'conceded'
    )
    marks: tuple[tuple[Tested, bool], ...] = (
        ('reproduced', ('rerun', 'holds') in checks),
        ('challenged', ('challenge', 'holds') in checks),
        ('challenge_failed', ('challenge', 'fails') in checks),
    )
    return tuple(mark for mark, holds in marks if holds)


def support(board: Board, post_id: PostId) -> Support:
    """Return how a result stands under the work that builds on it, as `Support` says."""
    match standing(board, post_id):
        case 'disputed' | 'conceded' as fallen:
            return fallen
        case 'open':
            return 'not_checked'
        case 'checked' | 'held_up':
            marks = how_tested(board, post_id)
            if 'challenged' in marks:
                return 'challenged'
            return 'reproduced_only' if 'reproduced' in marks else 'checked_otherwise'


def rests_on(board: Board, candidate: Posted) -> RestsOn | None:
    """
    Return the results that a post builds on directly, counted by how each stands, or `None` when it builds on none.

    A result counts once, also when `builds_on` names it twice.
    """
    results = tuple(
        dict.fromkeys(
            found.post.id
            for post_id in candidate.post.builds_on
            if (found := board.post(post_id)) and isinstance(found.post, Result)
        )
    )
    if not results:
        return None
    counts = Counter(support(board, post_id) for post_id in results)
    return RestsOn(
        challenged=counts['challenged'],
        reproduced_only=counts['reproduced_only'],
        checked_otherwise=counts['checked_otherwise'],
        not_checked=counts['not_checked'],
        disputed=counts['disputed'],
        conceded=counts['conceded'],
    )
