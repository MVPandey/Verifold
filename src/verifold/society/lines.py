"""Where each agent works: the thread of its latest plan or result."""

from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.posts import Call, Plan, Result, RuledOut
from verifold.protocol.threads import QUESTION_TITLE
from verifold.society.board import Board


def question_thread(board: Board) -> ThreadId | None:
    """Return the thread that a lab opens with, which holds the person's question, or `None` for an older lab."""
    first = board.threads[0].thread if board.threads else None
    return first.id if first and first.opened_by == PERSON and first.title == QUESTION_TITLE else None


def lines_of(board: Board) -> dict[AgentId, ThreadId | None]:
    """
    Return where each agent of the lab works now, for every agent that has worked in a line.

    An agent works in the thread of its latest plan or result outside the question's thread. Every agent plans in
    the question's thread, so a plan there moves nobody. A ruled-out lead ends the agent's work in its thread, and
    the agent then works nowhere until its next plan or result. A ruled-out lead that withdraws the agent's own
    call ends no work.
    """
    question = question_thread(board)
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    lines: dict[AgentId, ThreadId | None] = {}
    for entry in board.posts:
        post = entry.post
        if post.author not in workers or post.thread == question:
            continue
        if isinstance(post, Plan | Result):
            lines[post.author] = post.thread
        elif isinstance(post, RuledOut) and not withdraws(board, post) and lines.get(post.author) == post.thread:
            lines[post.author] = None
    return lines


def withdraws(board: Board, post: RuledOut) -> bool:
    """Return whether a ruled-out lead withdraws its author's own call."""
    target = board.post(post.reply_to) if post.reply_to else None
    return bool(target and isinstance(target.post, Call) and target.post.author == post.author)
