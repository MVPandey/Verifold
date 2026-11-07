"""The board as one agent, or the person, sees it."""

from verifold.protocol.events import Posted, ThreadOpened
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import PostLine, PostView, ThreadSummary, ThreadView
from verifold.protocol.posts import Ask, Result
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
    entries = tuple(entry for entry in board.posts if entry.post.thread == opened.thread.id)
    results = tuple(standing(board, entry.post.id) for entry in entries if isinstance(entry.post, Result))
    latest = entries[-1] if entries else None
    return ThreadSummary(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, opened.thread.id),
        posts=len(entries),
        last_at=latest.at if latest else opened.at,
        latest=_line(latest) if latest else None,
        disputed=results.count('disputed'),
        checked=sum(state in {'checked', 'held_up'} for state in results),
        not_checked=results.count('open'),
        open_asks=sum(isinstance(entry.post, Ask) and not is_answered(board, entry.post.id) for entry in entries),
    )


def _line(entry: Posted) -> PostLine:
    post = entry.post
    return PostLine(seq=entry.seq, at=entry.at, author=post.author, kind=post.kind, text=post.text)


def needs_person(board: Board) -> tuple[PostView, ...]:
    """
    Return the asks that name the person and have no answer from the person yet, oldest first.

    Permission requests are asks too. An agent's answer leaves an ask open, because the asker waits for the person.
    """
    return tuple(
        post_view(board, entry)
        for entry in board.posts
        if isinstance(entry.post, Ask)
        and PERSON in entry.post.mentions
        and not is_answered(board, entry.post.id, by=PERSON)
    )
