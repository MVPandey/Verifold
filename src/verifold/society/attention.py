"""
Who hears what.

A post is for an agent when it names the agent, replies to one of the agent's posts, builds on one of them, or
lands in a thread that the agent watches. A post names an agent in `mentions`, or in its text with the agent's ID
or its full name. An agent watches the
threads that it opens and the thread where it works now, which is the thread of its latest plan or result, until it
says otherwise. Nobody watches the question's thread by default, so a post there is for the agents that it names.

Some posts are for every agent: a close, and an ask, a call, or the first post of a thread when it names nobody. An ask names
nobody when its `mentions` are empty and it replies to no post, so an agent that is stuck reaches every agent that
may know the missing piece. A check is also for the agent that asked for the rerun. The person's words reach the agents by default: a post from the person that
names nobody and replies to no post is for every agent. No post is for a blind checker, which reads nothing but its claim.
No post is for an agent that left the lab.

An on-call agent hears less. No post for every agent is for it, and neither are the person's words that name nobody.
It watches a thread only when it said so with `watch`, or as a member of a side thread. So a post is for it when
the post names it, replies to it, builds on its post, or lands in such a thread. A close is for it once it has
posted, because from then on it counts among the agents that decide whether the lab is done.

A side thread is a thread between named agents. Its members are those agents and every agent that posted in it or
started to watch it since. A member watches it until it says otherwise, and then it hears nothing from the thread
until it watches again, also when it posts there. A post in a side thread is for the members that watch it and for
nobody else, whatever its kind, whoever wrote it, and whether it is the thread's first: only a name, a reply, or
`builds_on` reaches another agent. Every other thread is a thread for the whole lab.

The conversation is the thread where the person and the lab's coordinator talk. A post of the person there is for
the agent that holds the coordinator seat. That agent watches the thread until it says otherwise, and no other agent
does unless it said so with `watch`. So a post of the coordinator there is for no other agent, unless it names the
agent, replies to it, or builds on its post. The coordinator can mark a post as one for the person. In a thread
for the whole lab, such a post that names nobody and replies to no post is for every agent that is not on call, as
the person's own post is.

An agent that left the lab is news for the agents that wrote to it: the ones whose posts name it or reply to it.

A post that is for an agent wakes it. The agent's news holds every post that it has not seen, and says which are for
it. So an agent learns of the rest when it reads the board, and not before.
"""

import re
from datetime import datetime
from functools import lru_cache

from verifold.protocol.events import AgentLeft, Posted
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import MAX_NEWS, LeftLine, News, PostLine, Update
from verifold.protocol.posts import Ask, Call, Check, Close, Post
from verifold.society.board import Board
from verifold.society.lifecycle import alarm_line, no_alarm_line
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
    if opened.thread.between:
        return agent_id in board.members(thread_id)
    if opened.thread.conversation:
        return agent_id == board.coordinator
    if board.on_call(agent_id):
        # An on-call agent watches a thread only by its own word, so its own work does not make every post in a
        # thread wake it.
        return False
    working = lines_of(board) if working is None else working
    return opened.thread.opened_by == agent_id or working.get(agent_id) == thread_id


def wakes(
    board: Board, agent_id: AgentId, entry: Posted, working: dict[AgentId, ThreadId | None] | None = None
) -> bool:
    """
    Return whether a post is for an agent, so that it wakes the agent.

    No post is for a blind checker, and none is for an agent that left the lab.
    """
    post = entry.post
    reader = board.agent(agent_id)
    if post.author == agent_id or (reader and reader.agent.checks) or board.gone(agent_id):
        return False
    if _names(board, agent_id, post):
        return True
    talk = post.thread == board.conversation
    if talk or board.is_side(post.thread):
        # A side thread is for the members that watch it. No post in it is for every agent, the person's neither.
        # The same holds for the conversation, where the person's words are for the coordinator, whatever it watches.
        told = talk and post.author == PERSON and agent_id == board.coordinator
        return told or watches_thread(board, agent_id, post.thread)
    if reader and board.on_call(agent_id):
        # No post for every agent is for an on-call agent, but a close is once the agent counts for it.
        if isinstance(post, Close) and board.counts(reader, before=entry.seq):
            return True
    elif _for_everyone(board, entry) or (
        (post.author == PERSON or post.for_person) and not post.mentions and not post.reply_to
    ):
        # The person's words that name nobody are for every agent, whoever watches the thread. So are the words
        # that the coordinator posts for the person.
        return True
    working = lines_of(board) if working is None else working
    return watches_thread(board, agent_id, post.thread, working)


def update(board: Board, agent_id: AgentId, after: int, now: datetime | None = None) -> Update:
    """
    Return what happened after event `after`: the posts for an agent in full, and a summary of the rest.

    It holds at most `MAX_NEWS` posts for the agent, the oldest first. When more wait, it reaches only as far as the
    last one that it holds, so the next update brings the others. `now` dates the time that the lab has left.
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
        # An invited agent that has not posted may never come. Its first post announces it.
        agents=tuple(
            entry.agent
            for entry in board.agents
            if after < entry.seq <= reach and entry.agent.id != agent_id and board.here(entry)
        ),
        left=departures(board, agent_id, after, reach),
        alarm=alarm_line(board, agent_id),
        no_alarm=no_alarm_line(board, agent_id, now),
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
        left=departures(board, agent_id, after, reach),
        alarm=alarm_line(board, agent_id),
    )


def left_line(board: Board, left: AgentLeft) -> LeftLine:
    """Return an agent that left as one line: who it is, who caused it, and the reason."""
    joined = board.agent(left.agent)
    name = joined.agent.name if joined else left.agent
    return LeftLine(id=left.agent, name=name, by=left.by, reason=left.reason, through=left.through)


def departures(board: Board, agent_id: AgentId, after: int, reach: int) -> tuple[LeftLine, ...]:
    """
    Return the agents that left after event `after`, up to event `reach`, and that an agent wrote to before.

    An agent wrote to another when one of its posts names the other, in `mentions` or in its text, or replies to
    one of the other's posts. So an agent that waits for an answer learns that none comes.
    """
    return tuple(
        left_line(board, left)
        for left in board.left
        if after < left.seq <= reach and left.agent != agent_id and _wrote_to(board, agent_id, left)
    )


def gone_named(board: Board, post: Post) -> tuple[LeftLine, ...]:
    """Return the agents that a post names in `mentions` or answers with `reply_to`, and that left the lab."""
    answered = board.post(post.reply_to) if post.reply_to else None
    named = dict.fromkeys((*post.mentions, *((answered.post.author,) if answered else ())))
    return tuple(left_line(board, left) for agent in named if (left := board.gone(agent)))


def _wrote_to(board: Board, agent_id: AgentId, left: AgentLeft) -> bool:
    name = left_line(board, left).name
    return any(
        entry.post.author == agent_id
        and entry.seq < left.seq
        and (
            left.agent in entry.post.mentions
            or bool((answered := board.post(entry.post.reply_to or '')) and answered.post.author == left.agent)
            or left.agent in _in_text(f'{entry.post.text}\n{entry.post.body}', ((left.agent, name),))
        )
        for entry in board.posts
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
    # Each agent with its name, and with each name that it had before, so that an older post still names it.
    checkers = {joined.agent.id for joined in board.agents if joined.agent.checks}
    now = tuple((joined.agent.id, joined.agent.name) for joined in board.agents)
    former = tuple((event.agent, before) for event, before in board.renames)
    return tuple(pair for pair in (*now, *former) if pair[0] not in checkers)


def _names(board: Board, agent_id: AgentId, post: Post) -> bool:
    # A post names an agent in `mentions`, in its text, as a reply to the agent's post, as a post that builds on the
    # agent's post, or as the check that the agent asked for.
    sources = (post.reply_to, *post.builds_on) if post.reply_to else post.builds_on
    authors = {entry.post.author for entry in map(board.post, sources) if entry}
    if agent_id in post.mentions or agent_id in authors:
        return True
    if isinstance(post, Check) and any(rerun.by == agent_id and rerun.post == post.reply_to for rerun in board.reruns):
        return True
    # An ask that carries a harness's request shows a command or a tool's input. A name in that text names nobody.
    if isinstance(post, Ask) and post.request:
        return False
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
    # Agents write a name or "agent-2" in their text more often than they fill `mentions`. Every reader asks
    # about the same post, so the scan of a long body runs once.
    # An ID matches whole and outside a path: "agent-3" is not in "agents/agent-3/out.json".
    found = {
        agent_id
        for agent_id, _ in names
        if re.search(rf'(?<![\w/.-]){re.escape(agent_id)}(?![\w/-])', text, re.IGNORECASE)
    }
    # A display name matches whole and with its capitals: "Agent 1" is not in "Agent 12" or "the agent 1 run". The
    # longest name goes first and leaves the text, so "Codex · gpt-6 2" does not also name "Codex · gpt-6". A name
    # does not end where its last word goes on, as "Codex · gpt-6" in "Codex · gpt-6.1-sol": a dot ends a name only
    # when no letter or digit follows it.
    rest = text
    for agent_id, name in sorted(names, key=lambda pair: len(pair[1]), reverse=True):
        whole = rf'(?<![\w-]){re.escape(name)}(?![\w-]|\.\w)'
        if re.search(whole, rest):
            found.add(agent_id)
            rest = re.sub(whole, ' ', rest)
    return frozenset(found)


def _opens_thread(board: Board, entry: Posted) -> bool:
    first = next(other for other in board.posts if other.post.thread == entry.post.thread)
    return first.seq == entry.seq
