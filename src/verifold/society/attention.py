"""
Who hears what.

A post is for an agent when it names the agent, replies to one of the agent's posts, or lands in a thread that the
agent watches. An agent watches the threads that the person opens, the threads that it opens, and the threads that it
posts in, until it says otherwise.

Some posts are for every agent: a proposal, and the first post of a thread when it names nobody. A check is also for
the agent that asked for the rerun. The person's words reach the agents by default: a post from the person that names
nobody wakes the thread's watchers, or every agent when nobody watches the thread.

A post that is for an agent wakes it. The agent's news holds every post that it has not seen, and says which are for
it.
"""

import re

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import MAX_NEWS, News, PostLine, Update
from verifold.protocol.posts import Check, Post, Proposal
from verifold.society.board import Board


def watches_thread(board: Board, agent_id: AgentId, thread_id: ThreadId) -> bool:
    """Return whether an agent watches a thread now."""
    latest = next(
        (watch for watch in reversed(board.watches) if watch.agent == agent_id and watch.thread == thread_id), None
    )
    if latest:
        return latest.watching
    opened = board.thread(thread_id)
    if opened is None:
        return False
    return opened.thread.opened_by in {agent_id, PERSON} or any(
        entry.post.thread == thread_id and entry.post.author == agent_id for entry in board.posts
    )


def wakes(board: Board, agent_id: AgentId, entry: Posted) -> bool:
    """Return whether a post is for an agent, so that it wakes the agent."""
    post = entry.post
    if post.author == agent_id:
        return False
    target = board.post(post.reply_to) if post.reply_to else None
    if agent_id in post.mentions or (target and target.post.author == agent_id) or _names(board, agent_id, post):
        return True
    if isinstance(post, Proposal) or (not post.mentions and _opens_thread(board, entry)):
        return True
    if isinstance(post, Check) and any(rerun.by == agent_id and rerun.post == post.reply_to for rerun in board.reruns):
        return True
    watching = watches_thread(board, agent_id, post.thread)
    if post.author == PERSON and not post.mentions and target is None:
        return watching or not any(watches_thread(board, joined.agent.id, post.thread) for joined in board.agents)
    return watching


def update(board: Board, agent_id: AgentId, after: int) -> Update:
    """Return what happened after event `after`: the posts for an agent in full, and a summary of the rest."""
    woken, rest = _unseen(board, agent_id, after)
    return Update(
        seq=board.seq,
        posts=woken,
        others=tuple(PostLine.of(entry) for entry in rest[-MAX_NEWS:]),
        other_posts=len(rest),
        threads=tuple(
            entry.thread for entry in board.threads if entry.seq > after and entry.thread.opened_by != agent_id
        ),
        agents=tuple(entry.agent for entry in board.agents if entry.seq > after and entry.agent.id != agent_id),
        ends_at=board.ends_at,
    )


def news(board: Board, agent_id: AgentId, after: int) -> News:
    """Return one line for each post after event `after` that an agent did not write: the newest in each list."""
    woken, rest = _unseen(board, agent_id, after)
    return News(
        for_you=tuple(PostLine.of(entry) for entry in woken[-MAX_NEWS:]),
        others=tuple(PostLine.of(entry) for entry in rest[-MAX_NEWS:]),
        left_out=max(len(woken) - MAX_NEWS, 0) + max(len(rest) - MAX_NEWS, 0),
    )


def _unseen(board: Board, agent_id: AgentId, after: int) -> tuple[tuple[Posted, ...], tuple[Posted, ...]]:
    # The posts by others after `after`: first the ones for the agent, then the rest.
    marked = tuple(
        (wakes(board, agent_id, entry), entry)
        for entry in board.posts
        if entry.seq > after and entry.post.author != agent_id
    )
    return tuple(entry for woken, entry in marked if woken), tuple(entry for woken, entry in marked if not woken)


def _names(board: Board, agent_id: AgentId, post: Post) -> bool:
    # Agents write "Agent 2" or "agent-2" in their text more often than they fill `mentions`. Names match whole, so
    # "Agent 1" is not in "Agent 12".
    joined = board.agent(agent_id)
    names = {agent_id, joined.agent.name} if joined else {agent_id}
    text = f'{post.text}\n{post.body}'
    return any(re.search(rf'(?<![\w-]){re.escape(name)}(?![\w-])', text, re.IGNORECASE) for name in names)


def _opens_thread(board: Board, entry: Posted) -> bool:
    first = next(other for other in board.posts if other.post.thread == entry.post.thread)
    return first.seq == entry.seq
