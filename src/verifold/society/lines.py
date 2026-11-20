"""Where each agent works: the thread of its latest plan or result."""

from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.posts import Call, Close, Plan, Result, Round, RuledOut, Task
from verifold.protocol.threads import QUESTION_TITLE, Thread
from verifold.society.board import Board


def is_line_of_work(thread: Thread) -> bool:
    """
    Return whether a thread is a line of work: one for the whole lab, and no talk with the person and no offers.

    The conversation, the desk chat, and a thread of offers are no lines of work.
    """
    return not (thread.between or thread.conversation or thread.desk or thread.deliverable)


def question_thread(board: Board) -> ThreadId | None:
    """Return the thread that a lab opens with, which holds the person's question, or `None` for an older lab."""
    first = board.threads[0].thread if board.threads else None
    return first.id if first and first.opened_by == PERSON and first.title == QUESTION_TITLE else None


def lines_of(board: Board) -> dict[AgentId, ThreadId | None]:
    """
    Return where each agent of the lab works now, for every agent that has worked in a line.

    An agent works in the thread of its latest plan or result outside the question's thread. Every agent plans in
    the question's thread, so a plan there moves nobody. Nor does a plan or a result in a side thread, or in the conversation with the person, which is
    talk beside the agents' work: its author keeps its line, its team, and its watch. A ruled-out lead ends the agent's work in its thread, and
    the agent then works nowhere until its next plan or result. A ruled-out lead that withdraws the agent's own
    call, task, close, or round ends no work. An agent that left the lab works nowhere.
    """
    question = question_thread(board)
    workers = {
        joined.agent.id for joined in board.agents if not joined.agent.checks and not board.gone(joined.agent.id)
    }
    talk = {
        opened.thread.id
        for opened in board.threads
        if opened.thread.between or opened.thread.conversation or opened.thread.desk
    }
    beside = talk | {question}
    lines: dict[AgentId, ThreadId | None] = {}
    for entry in board.posts:
        post = entry.post
        if post.author not in workers or post.thread in beside:
            continue
        if isinstance(post, Plan | Result):
            lines[post.author] = post.thread
        elif isinstance(post, RuledOut) and not withdraws(board, post) and lines.get(post.author) == post.thread:
            lines[post.author] = None
    return lines


def withdraws(board: Board, post: RuledOut) -> bool:
    """Return whether a ruled-out lead withdraws its author's own call, task, close, or round."""
    target = board.post(post.reply_to) if post.reply_to else None
    withdrawn = Call | Task | Close | Round
    return bool(target and isinstance(target.post, withdrawn) and target.post.author == post.author)
