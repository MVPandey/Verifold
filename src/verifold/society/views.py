"""The board as one agent, or the person, sees it."""

from verifold.protocol.agents import Agent
from verifold.protocol.events import Posted, ThreadOpened
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import MAX_NEWS, AgentLine, Brief, News, PostLine, PostView, ThreadSummary, ThreadView
from verifold.protocol.posts import Ask, Plan, Report, Result
from verifold.protocol.threads import QUESTION_TITLE
from verifold.society.attention import watches_thread
from verifold.society.board import Board
from verifold.society.errors import NotFound
from verifold.society.standing import is_answered, standing


def post_view(board: Board, entry: Posted) -> PostView:
    """Return a post with its time, where it stands, and the posts that build on it."""
    return PostView(
        seq=entry.seq,
        at=entry.at,
        post=entry.post,
        standing=standing(board, entry.post.id),
        built_on_by=tuple(other.post.id for other in board.built_on(entry.post.id)),
    )


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
        latest=PostLine.of(latest) if latest else None,
        disputed=results.count('disputed'),
        checked=sum(state in {'checked', 'held_up'} for state in results),
        not_checked=results.count('open'),
        open_asks=sum(isinstance(entry.post, Ask) and not is_answered(board, entry.post.id) for entry in entries),
    )


def question_thread(board: Board) -> ThreadId | None:
    """Return the thread that a lab opens with, which holds the person's question, or `None` for an older lab."""
    first = board.threads[0].thread if board.threads else None
    return first.id if first and first.opened_by == PERSON and first.title == QUESTION_TITLE else None


def brief(board: Board, agent_id: AgentId, news: News, how: str = '') -> Brief:
    """
    Return the lab for one agent in one read.

    It holds the other agents with their latest plans, the asks that nobody has answered, their results that nobody
    has checked, the disputed posts, the newest threads, and the agent's `news`. `how` says how the board works.
    """
    others = tuple(joined.agent for joined in board.agents if joined.agent.id != agent_id and not joined.agent.checks)
    stands = tuple((entry, standing(board, entry.post.id)) for entry in board.posts)
    not_checked = tuple(
        PostLine.of(entry)
        for entry, state in stands
        if isinstance(entry.post, Result) and entry.post.author != agent_id and state == 'open'
    )
    disputed = tuple(PostLine.of(entry) for entry, state in stands if state == 'disputed')
    open_asks = tuple(
        PostLine.of(entry)
        for entry in board.posts
        if isinstance(entry.post, Ask)
        and entry.post.author != agent_id
        and entry.post.mentions != (PERSON,)
        and not is_answered(board, entry.post.id)
    )
    summaries = thread_summaries(board, agent_id)
    return Brief(
        you=agent_id,
        how=how,
        agents=tuple(_agent_line(board, agent) for agent in others),
        open_asks=open_asks[-MAX_NEWS:],
        not_checked=not_checked[-MAX_NEWS:],
        disputed=disputed[-MAX_NEWS:],
        threads=summaries[:MAX_NEWS],
        more_threads=max(len(summaries) - MAX_NEWS, 0),
        news=news,
        ends_at=board.ends_at,
    )


def _agent_line(board: Board, agent: Agent) -> AgentLine:
    posts = tuple(entry for entry in board.posts if entry.post.author == agent.id)
    plan = next((entry for entry in reversed(posts) if isinstance(entry.post, Plan)), None)
    return AgentLine(
        id=agent.id,
        name=agent.name,
        harness=agent.harness,
        plan=PostLine.of(plan) if plan else None,
        latest=PostLine.of(posts[-1]) if posts and posts[-1] is not plan else None,
    )


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


def latest_report(board: Board) -> PostView | None:
    """Return the newest report on the board, or `None` when no agent has posted one."""
    entry = next((entry for entry in reversed(board.posts) if isinstance(entry.post, Report)), None)
    return post_view(board, entry) if entry else None
