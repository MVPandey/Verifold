"""The board as one agent, or the person, sees it."""

from verifold.protocol.events import Posted, ThreadOpened
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import PostView, ThreadSummary, ThreadView
from verifold.protocol.posts import Ask
from verifold.society.attention import watches_thread
from verifold.society.board import Board
from verifold.society.errors import NotFound
from verifold.society.standing import is_answered, standing


def post_view(board: Board, entry: Posted) -> PostView:
    """Return a post with its time and where it stands."""
    return PostView(seq=entry.seq, at=entry.at, post=entry.post, standing=standing(board, entry.post.id))


def thread_view(board: Board, agent_id: AgentId, thread_id: ThreadId) -> ThreadView:
    """
    Return a thread and its posts.

    Raises:
        NotFound: No thread has this ID.

    """
    opened = board.thread(thread_id)
    if opened is None:
        raise NotFound(f'No thread has the ID {thread_id}.')
    return ThreadView(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, thread_id),
        posts=tuple(post_view(board, entry) for entry in board.posts if entry.post.thread == thread_id),
    )


def thread_summaries(board: Board, agent_id: AgentId) -> tuple[ThreadSummary, ...]:
    """Return one summary for each thread, the most recently active first."""
    summaries = (_summary(board, agent_id, opened) for opened in board.threads)
    return tuple(sorted(summaries, key=lambda summary: summary.last_at, reverse=True))


def _summary(board: Board, agent_id: AgentId, opened: ThreadOpened) -> ThreadSummary:
    posts = tuple(entry for entry in board.posts if entry.post.thread == opened.thread.id)
    return ThreadSummary(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, opened.thread.id),
        posts=len(posts),
        last_at=posts[-1].at if posts else opened.at,
    )


def needs_person(board: Board) -> tuple[PostView, ...]:
    """Return the asks that name the person and have no answer yet, oldest first. Permission requests are asks too."""
    return tuple(
        post_view(board, entry)
        for entry in board.posts
        if isinstance(entry.post, Ask) and PERSON in entry.post.mentions and not is_answered(board, entry.post.id)
    )
