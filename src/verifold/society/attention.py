"""
Who hears what.

A post wakes an agent when it names the agent, replies to one of the agent's posts, or lands in a thread that the
agent watches. An agent watches the threads that it opens until it says otherwise. The person's words reach the
agents by default: a post from the person that names nobody wakes the thread's watchers, or every agent when nobody
watches the thread.
"""

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import Update
from verifold.society.board import Board


def watches_thread(board: Board, agent_id: AgentId, thread_id: ThreadId) -> bool:
    """Return whether an agent watches a thread now."""
    latest = next(
        (watch for watch in reversed(board.watches) if watch.agent == agent_id and watch.thread == thread_id), None
    )
    if latest:
        return latest.watching
    opened = board.thread(thread_id)
    return opened is not None and opened.thread.opened_by == agent_id


def wakes(board: Board, agent_id: AgentId, entry: Posted) -> bool:
    """Return whether a post wakes an agent."""
    post = entry.post
    if post.author == agent_id:
        return False
    target = board.post(post.reply_to) if post.reply_to else None
    if agent_id in post.mentions or (target and target.post.author == agent_id):
        return True
    watching = watches_thread(board, agent_id, post.thread)
    if post.author == PERSON and not post.mentions and target is None:
        return watching or not any(watches_thread(board, joined.agent.id, post.thread) for joined in board.agents)
    return watching


def update(board: Board, agent_id: AgentId, after: int) -> Update:
    """Return what happened after event `after` that concerns an agent, and a summary of the rest."""
    others = tuple(entry for entry in board.posts if entry.seq > after and entry.post.author != agent_id)
    woken = tuple(entry for entry in others if wakes(board, agent_id, entry))
    return Update(
        seq=board.seq,
        posts=woken,
        threads=tuple(
            entry.thread for entry in board.threads if entry.seq > after and entry.thread.opened_by != agent_id
        ),
        agents=tuple(entry.agent for entry in board.agents if entry.seq > after and entry.agent.id != agent_id),
        other_posts=len(others) - len(woken),
        ends_at=board.ends_at,
    )
