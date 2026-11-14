"""
Who hears what.

A post is for an agent when it names the agent, replies to one of the agent's posts, builds on one of them, or
lands in a thread that the agent watches. A post names an agent in `mentions` or in its text. An agent watches the
threads that it opens and the thread where it works now, which is the thread of its latest plan or result, until it
says otherwise. Nobody watches the question's thread by default, so a post there is for the agents that it names.

Some posts are for every agent: a close, and an ask, a call, or the first post of a thread when it names nobody. An ask names
nobody when its `mentions` are empty and it replies to no post, so an agent that is stuck reaches every agent that
may know the missing piece. A check is also for the agent that asked for the rerun. The person's words reach the agents by default: a post from the person that
names nobody and replies to no post is for every agent. No post is for a blind checker, which reads nothing but its claim.

A post that is for an agent wakes it. The agent's news holds every post that it has not seen, and says which are for
it. So an agent learns of the rest when it reads the board, and not before.
"""

import re
from functools import lru_cache

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import MAX_NEWS, News, PostLine, Update
from verifold.protocol.posts import Ask, Call, Check, Close, Post
from verifold.society.board import Board
from verifold.society.lines import lines_of

type Names = tuple[tuple[AgentId, str], ...]
"""The ID and the display name of each agent that a post can name."""


def watches_thread(
    board: Board, agent_id: AgentId, thread_id: ThreadId, working: dict[AgentId, ThreadId | None] | None = None
) -> bool:
    """
    Return whether an agent watches a thread now.

    `working` is where each agent works, from `lines_of`. A caller that asks about many posts passes it once.
    """
    latest = next(
        (watch for watch in reversed(board.watches) if watch.agent == agent_id and watch.thread == thread_id), None
    )
    if latest:
        return latest.watching
    opened = board.thread(thread_id)
    if opened is None:
        return False
    working = lines_of(board) if working is None else working
    return opened.thread.opened_by == agent_id or working.get(agent_id) == thread_id


def wakes(
    board: Board, agent_id: AgentId, entry: Posted, working: dict[AgentId, ThreadId | None] | None = None
) -> bool:
    """Return whether a post is for an agent, so that it wakes the agent. No post is for a blind checker."""
    post = entry.post
    reader = board.agent(agent_id)
    if post.author == agent_id or (reader and reader.agent.checks):
        return False
    if _names(board, agent_id, post) or _for_everyone(board, entry):
        return True
    # The person's words that name nobody are for every agent, whoever watches the thread.
    if post.author == PERSON and not post.mentions and not post.reply_to:
        return True
    working = lines_of(board) if working is None else working
    return watches_thread(board, agent_id, post.thread, working)


def update(board: Board, agent_id: AgentId, after: int) -> Update:
    """
    Return what happened after event `after`: the posts for an agent in full, and a summary of the rest.

    It holds at most `MAX_NEWS` posts for the agent, the oldest first. When more wait, it reaches only as far as the
    last one that it holds, so the next update brings the others.
    """
    woken, rest = _unseen(board, agent_id, after)
    shown, others, reach = _page(woken, rest, board.seq)
    return Update(
        seq=reach,
        posts=shown,
        more=len(woken) - len(shown),
        others=tuple(PostLine.of(entry) for entry in others[-MAX_NEWS:]),
        other_posts=len(others),
        threads=tuple(
            entry.thread for entry in board.threads if after < entry.seq <= reach and entry.thread.opened_by != agent_id
        ),
        agents=tuple(
            entry.agent for entry in board.agents if after < entry.seq <= reach and entry.agent.id != agent_id
        ),
        ends_at=board.ends_at,
    )


def news(board: Board, agent_id: AgentId, after: int) -> News:
    """
    Return one line for each post after event `after` that an agent did not write.

    It holds at most `MAX_NEWS` posts for the agent, the oldest first, and reaches as far as `update` does. So a post
    for the agent is never left out. Of the other posts it holds the newest.
    """
    woken, rest = _unseen(board, agent_id, after)
    shown, others, reach = _page(woken, rest, board.seq)
    return News(
        seq=reach,
        for_you=tuple(PostLine.of(entry) for entry in shown),
        more=len(woken) - len(shown),
        others=tuple(PostLine.of(entry) for entry in others[-MAX_NEWS:]),
        left_out=max(len(others) - MAX_NEWS, 0),
    )


def _unseen(board: Board, agent_id: AgentId, after: int) -> tuple[tuple[Posted, ...], tuple[Posted, ...]]:
    # The posts by others after `after`: first the ones for the agent, then the rest.
    working = lines_of(board)
    marked = tuple(
        (wakes(board, agent_id, entry, working), entry)
        for entry in board.posts
        if entry.seq > after and entry.post.author != agent_id
    )
    return tuple(entry for woken, entry in marked if woken), tuple(entry for woken, entry in marked if not woken)


def _page(
    woken: tuple[Posted, ...], rest: tuple[Posted, ...], seq: int
) -> tuple[tuple[Posted, ...], tuple[Posted, ...], int]:
    # The posts for the agent that fit in one result, the other posts up to the same event, and that event.
    shown = woken[:MAX_NEWS]
    reach = shown[-1].seq if len(woken) > MAX_NEWS else seq
    return shown, tuple(entry for entry in rest if entry.seq <= reach), reach


def _workers(board: Board) -> Names:
    return tuple((joined.agent.id, joined.agent.name) for joined in board.agents if not joined.agent.checks)


def _names(board: Board, agent_id: AgentId, post: Post) -> bool:
    # A post names an agent in `mentions`, in its text, as a reply to the agent's post, as a post that builds on the
    # agent's post, or as the check that the agent asked for.
    sources = (post.reply_to, *post.builds_on) if post.reply_to else post.builds_on
    authors = {entry.post.author for entry in map(board.post, sources) if entry}
    if agent_id in post.mentions or agent_id in authors:
        return True
    if isinstance(post, Check) and any(rerun.by == agent_id and rerun.post == post.reply_to for rerun in board.reruns):
        return True
    return agent_id in _in_text(f'{post.text}\n{post.body}', _workers(board))


def _for_everyone(board: Board, entry: Posted) -> bool:
    # Only `mentions` keeps an ask, a call, or the first post of a thread from the other agents. A name in the text adds a
    # reader and takes none away. An ask that replies to a post is for that post's author. A call that replies to a
    # post, such as the caller's own result, still asks every agent for hands.
    post = entry.post
    # Whether the lab is done concerns every agent, whatever the post names.
    if isinstance(post, Close):
        return True
    open_ask = isinstance(post, Call) or (isinstance(post, Ask) and not post.reply_to)
    return not post.mentions and (open_ask or _opens_thread(board, entry))


@lru_cache(maxsize=512)
def _in_text(text: str, names: Names) -> frozenset[AgentId]:
    # Agents write "Agent 2" or "agent-2" in their text more often than they fill `mentions`. Every reader asks
    # about the same post, so the scan of a long body runs once.
    return frozenset(
        agent_id
        for agent_id, name in names
        # A display name matches whole and with its capitals: "Agent 1" is not in "Agent 12" or "the agent 1 run".
        # An ID matches whole and outside a path: "agent-3" is not in "agents/agent-3/out.json".
        if re.search(rf'(?<![\w-]){re.escape(name)}(?![\w-])', text)
        or re.search(rf'(?<![\w/.-]){re.escape(agent_id)}(?![\w/-])', text, re.IGNORECASE)
    )


def _opens_thread(board: Board, entry: Posted) -> bool:
    first = next(other for other in board.posts if other.post.thread == entry.post.thread)
    return first.seq == entry.seq
