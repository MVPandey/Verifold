"""
The independent reruns of a lab: which are wanted, who took them, and which checks answer them.

An independent rerun is a rerun from a clean copy of a post's files by another agent than the post's author. An
agent or the person asks for one, and the request starts nothing. An agent that can check the post takes it, and
Verifold makes the clean copy for that agent. The agent's check with the method `rerun`, whose files come from that
copy, answers every request that came before it.

A record from before agents took reruns holds checkers that Verifold started for each request. Such a checker read
nothing but its claim and posted one check, and that check answers the requests before it in the same way.
"""

from verifold.protocol.events import Posted, RerunRequested
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.join import RerunLine
from verifold.protocol.posts import Check
from verifold.society.board import Board
from verifold.society.reviewers import may_review

MAX_RERUNS = 2
"""
The most agents whose independent rerun of one post has a check. A post with that many takes no other request, so
that the record of one post stays small.
"""


def rerun_checks(board: Board, post_id: PostId) -> tuple[Posted, ...]:
    """
    Return the first check of each independent rerun of a post, oldest first. One agent is one rerun.

    A check is one when its files come from the clean copy that Verifold made for its author's take. The check of a
    checker that Verifold started, in a record from before agents took reruns, is one too.
    """
    checkers = _checkers(board, post_id)
    first: dict[AgentId, Posted] = {}
    for entry in board.replies(post_id):
        if isinstance(entry.post, Check) and (entry.post.take is not None or entry.post.author in checkers):
            first.setdefault(entry.post.author, entry)
    return tuple(first.values())


def wanted_reruns(board: Board, post_id: PostId) -> tuple[RerunRequested, ...]:
    """
    Return the requests for a rerun of a post that no check of an independent rerun has answered, oldest first.

    One such check answers every request that came before it. In a record from before agents took reruns, a rerun
    that failed left the requests before it without a check, and those requests stay as they were: they want
    nothing.
    """
    checkers = _checkers(board, post_id)
    answered = max((entry.seq for entry in rerun_checks(board, post_id)), default=0)
    failed = max((turn.seq for turn in board.turns if turn.rerun_failed and turn.agent in checkers), default=0)
    return tuple(entry for entry in board.reruns if entry.post == post_id and entry.seq > max(answered, failed))


def rerun_line(board: Board, post_id: PostId) -> RerunLine | None:
    """Return the rerun that is wanted for a post as one line, or `None` when none is wanted."""
    wanted = wanted_reruns(board, post_id)
    target = board.post(post_id)
    if not wanted or target is None:
        return None
    checked = {entry.post.author for entry in rerun_checks(board, post_id)}
    return RerunLine(
        post=post_id,
        thread=target.post.thread,
        asked_by=tuple(dict.fromkeys(entry.by for entry in wanted)),
        asked_at=wanted[0].at,
        taken_by=tuple(
            entry.agent
            for entry in board.takes
            if entry.post == post_id and entry.agent not in checked and not board.gone(entry.agent)
        ),
    )


def reruns_wanted(board: Board) -> tuple[RerunLine, ...]:
    """Return every rerun that is wanted, one line for each post, in the order of the first open request for it."""
    posts = dict.fromkeys(entry.post for entry in board.reruns)
    return tuple(sorted(filter(None, (rerun_line(board, post) for post in posts)), key=lambda line: line.asked_at))


def can_take(board: Board, agent_id: AgentId, post_id: PostId) -> bool:
    """
    Return whether an agent can take the rerun of a post now.

    It can when a rerun of the post is wanted, the agent is in the lab, another agent wrote the post, the agent has
    not taken it before, and the agent can check the post: it holds a reviewer seat, or the lab has none.
    """
    joined = board.agent(agent_id)
    target = board.post(post_id)
    return bool(
        joined
        and target
        and not joined.agent.checks
        and not board.gone(agent_id)
        and target.post.author != agent_id
        and board.take(agent_id, post_id) is None
        and wanted_reruns(board, post_id)
        and may_review(board, agent_id, post_id)
    )


def reruns_for(board: Board, agent_id: AgentId, after: int, reach: int) -> tuple[RerunLine, ...]:
    """
    Return the reruns that an agent can take, among those that somebody else asked for from `after` to `reach`.

    A request reaches the agents that can take it, as a call that names nobody reaches every agent. So it does not
    reach an agent whose seat is on call. An agent reads every wanted rerun in its brief.
    """
    if board.on_call(agent_id):
        return ()
    posts = dict.fromkeys(entry.post for entry in board.reruns if after < entry.seq <= reach and entry.by != agent_id)
    lines = (rerun_line(board, post) for post in posts if can_take(board, agent_id, post))
    return tuple(line for line in lines if line)


def _checkers(board: Board, post_id: PostId) -> set[AgentId]:
    # The checkers that Verifold started for a post, in a record from before agents took reruns.
    return {joined.agent.id for joined in board.agents if joined.agent.checks == post_id}
