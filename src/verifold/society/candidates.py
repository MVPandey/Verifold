"""
The candidate answers of the lab, and the candidate that a close closes on.

A `proposal` in a thread for the whole lab is a candidate answer. Each author has one candidate at most: the newest
proposal of that author, which supersedes the author's older ones. A candidate stands while its author has not
conceded an objection to it. So a candidate that its author conceded, or that a newer proposal of its author
superseded, does not stand, and an older one does not come back. Nobody edits a post, so nobody edits a candidate.
`candidates` in `society.standing` lists the ones that stand.

A close names the candidate that it closes on, and it stands only while that candidate stands. While the lab is
closed, that candidate is the lab's answer. A close from before closes named a candidate closes on the newest
candidate that stood when it was posted, which is what such a lab showed as its answer.
"""

from verifold.protocol.events import Posted
from verifold.protocol.ids import PostId
from verifold.protocol.posts import Close, Entry, Proposal
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.standing import candidates


def closes_on(board: Board, close: Posted) -> Posted | None:
    """
    Return the candidate that a close closes on, or `None` when it closes on none.

    A close that names a candidate closes on that post. A close that names none closes on the candidate that the
    board settled at the close's place in the record, as `settled` says. So a close that came while no candidate
    stood closes on none, and so does a close from before closes named a candidate in a lab that had no proposal.
    """
    named = close.post.candidate if isinstance(close.post, Close) else None
    if named is None:
        named = next((answer for unnamed, answer in board.unnamed_closes if unnamed == close.post.id), None)
    return board.post(named) if named else None


def settled(board: Board) -> PostId | None:
    """
    Return the candidate that a close that names none closes on, when it comes after the events of `board`.

    It is the newest candidate that stands on that board, or `None`. The board keeps it from the close on, so a
    concession or a newer proposal after the close leaves the answer that the close showed.
    """
    standing = candidates(board)
    return standing[-1].post.id if standing else None


def gone(board: Board) -> tuple[Posted, ...]:
    """
    Return the proposals that stand no more, oldest first: each that its author conceded or replaced with a newer one.

    A proposal in a side thread, from a record from before that rule, is no candidate and is not among them.
    """
    stands = {entry.post.id for entry in candidates(board)}
    return tuple(
        entry
        for entry in board.posts
        if isinstance(entry.post, Proposal) and not board.is_side(entry.post.thread) and entry.post.id not in stands
    )


def own_entry(board: Board, proposal: Posted) -> Posted | None:
    """
    Return the first entry in a proposal's `builds_on` that the proposal's own author wrote, or `None`.

    The proposal holds that entry's detail and files by reference, so an entry of a round becomes its author's
    candidate without a second copy. No post builds on an entry while its round is open, so the round is closed.
    """
    sources = (board.post(source) for source in proposal.post.builds_on)
    return next(
        (
            entry
            for entry in sources
            if entry and isinstance(entry.post, Entry) and entry.post.author == proposal.post.author
        ),
        None,
    )


def check_candidate(board: Board, close: Close) -> None:
    """
    Check that a close names a candidate that stands, when it names one.

    Raises:
        RejectedEvent: The post that the close names is no candidate that stands. The message lists the ones that do.

    """
    if close.candidate is None or any(entry.post.id == close.candidate for entry in candidates(board)):
        return
    raise RejectedEvent(f'Post {close.candidate} is no candidate answer that stands. {_standing_line(board)}')


def check_names_candidate(board: Board, close: Close) -> None:
    """
    Check that a close names a candidate while candidates stand.

    A close in a record from before closes named a candidate names none, so the board checks this for a new close
    only, and not as a rule of the record.

    Raises:
        RejectedEvent: Candidates stand, and the close names none of them.

    """
    if close.candidate is None and candidates(board):
        raise RejectedEvent(f'A close names the candidate that it closes on, in `candidate`. {_standing_line(board)}')


def _standing_line(board: Board) -> str:
    ids = ', '.join(entry.post.id for entry in candidates(board))
    return f'The candidates that stand: {ids}.' if ids else 'No candidate stands, so a close names none.'
