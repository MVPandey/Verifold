"""
The summaries of threads: who posts one, which one stands, and which posts before it stay in sight.

A summary says what a thread has established up to it. The newest summary of a thread is the thread's summary
while it stands: no failed check and no standing objection disputes it, and its author conceded no objection to it.
A disputed or conceded summary leaves the thread without one, and a reader gets the whole thread again until a
newer summary stands. A summary is an ordinary post, so it takes checks, objections, votes, and badges as any post
does.

A reader's view of a thread starts at its summary, and some posts before the summary stay in it by rule, because
they still ask something of the lab or of the reader. `in_sight` says which.
"""

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.posts import Ask, Call, Check, Objection, Summary
from verifold.society.board import Board
from verifold.society.desk import speaks_for_person
from verifold.society.errors import RejectedEvent
from verifold.society.lines import is_line_of_work
from verifold.society.obstacles import obstacles
from verifold.society.reruns import wanted_reruns
from verifold.society.standing import disputes, is_answered, is_open_call, standing


def check_summary(board: Board, summary: Summary) -> None:
    """
    Check that a summary can go on the board.

    It is in a line of work, or in a side thread that its author is a member of, and the thread holds posts. Its
    author is an agent of the lab that posted in the thread before, or the agent that holds the coordinator seat,
    and not the desk.

    Raises:
        RejectedEvent: One of these does not hold. The message says which.

    """
    if summary.author == PERSON:
        raise RejectedEvent(
            "A summary is the agents' word on what a thread has established. A reply to it tells them where it is "
            'wrong.'
        )
    if board.is_desk(summary.author):
        raise RejectedEvent("The desk is no part of the lab's work, so the board takes no summary from it.")
    opened = board.thread(summary.thread)
    side = board.is_side(summary.thread)
    if side and summary.author not in board.members(summary.thread):
        raise RejectedEvent(
            f'Thread {summary.thread} is a side thread, and you are no member of it, so you post no summary of it.'
        )
    if opened and not side and not is_line_of_work(opened.thread):
        raise RejectedEvent(
            f'Thread {summary.thread} is no line of work: a summary is for a line of work or a side thread, not for '
            'the conversation, the desk chat, or a thread of offers.'
        )
    posts = board.thread_posts(summary.thread)
    if not posts:
        raise RejectedEvent(f'Thread {summary.thread} has no post yet, so it has nothing to summarize.')
    if summary.author != board.coordinator and all(entry.post.author != summary.author for entry in posts):
        raise RejectedEvent(
            f'You have not posted in thread {summary.thread}. An agent that posted there, or the agent that holds '
            'the coordinator seat, posts its summary.'
        )


def standing_summary(board: Board, thread_id: ThreadId) -> Posted | None:
    """Return the summary of a thread: its newest summary, while that one stands. `None` when it has none or it does not."""
    newest = next((entry for entry in reversed(board.thread_posts(thread_id)) if isinstance(entry.post, Summary)), None)
    if newest is None or standing(board, newest.post.id) in {'disputed', 'conceded'}:
        return None
    return newest


def in_sight(board: Board, reader: AgentId, before: tuple[Posted, ...], read: int) -> tuple[Posted, ...]:
    """
    Return the posts before a thread's summary that stay in a reader's view, oldest first.

    `before` holds the thread's posts before the summary, and `read` is the event up to which the reader read the
    thread before. These posts stay:

    - a post that waits for the reader: an objection or a failed check that disputes a post of the reader, and an
      ask that names the reader or replies to its post, which the reader has not answered
    - a post of the person, or of the desk for the person, after `read`
    - an open ask: no answer replies to it, and its author is in the lab
    - an open call: nobody took it, and its caller did not withdraw it
    - an open obstacle: a ruled-out lead of a line of work that no plan and no result builds on
    - a post whose independent rerun is wanted
    """
    blocking = {found.entry.post.id for found in obstacles(board) if found.state == 'open'}

    def stays(entry: Posted) -> bool:
        post = entry.post
        return (
            _waits_for(board, reader, entry)
            or (speaks_for_person(post) and entry.seq > read)
            or (isinstance(post, Ask) and not is_answered(board, post.id) and not board.gone(post.author))
            or (isinstance(post, Call) and is_open_call(board, post.id))
            or post.id in blocking
            or bool(wanted_reruns(board, post.id))
        )

    return tuple(entry for entry in before if stays(entry))


def _waits_for(board: Board, reader: AgentId, entry: Posted) -> bool:
    # A post that waits for the reader's answer: a dispute of the reader's post, which the reader concedes or
    # answers, and an ask to the reader that the reader has not answered.
    post = entry.post
    target = board.post(post.reply_to) if post.reply_to else None
    mine = target is not None and target.post.author == reader
    if isinstance(post, Objection | Check):
        return mine and target is not None and entry in disputes(board, target.post.id)
    if isinstance(post, Ask):
        return (mine or reader in post.mentions) and not is_answered(board, post.id, by=reader)
    return False
