"""
The independent reruns of a lab: which are wanted, who took them, and which checks answer them.

An independent rerun is a rerun from a clean copy of a post's files by another agent than the post's author. An
agent or the person asks for one, and the request starts nothing. An agent in a reviewer seat takes it, or any
other agent when no agent in a reviewer seat can. Verifold gives the taker the clean copy, which is an export of
the pinned files in a folder of Verifold's own. The taker's first check with the method `rerun` and with files
after that is the check of the take, and it answers every request that came before it.

A record from before agents took reruns holds checkers that Verifold started for each request. Such a checker read
nothing but its claim and posted one check, and that check answers the requests before it in the same way.
"""

from dataclasses import replace

from verifold.protocol.events import Posted, RerunRequested, RerunTaken
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.join import RerunLine, RerunOpenTo
from verifold.protocol.posts import Check
from verifold.protocol.settings import ReviewerSettings
from verifold.society.board import Board
from verifold.society.reviewers import seats
from verifold.society.turns import before

MAX_RERUNS = 2
"""
The most agents whose independent rerun of one post has a check. A post with that many takes no other request, so
that the record of one post stays small.
"""


def rerun_checks(board: Board, post_id: PostId) -> tuple[Posted, ...]:
    """
    Return the first check of each independent rerun of a post, oldest first. One agent is one rerun.

    A check is one when it is the check of its author's take, which the record marks. The check of a checker that
    Verifold started, in a record from before agents took reruns, is one too.
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


def _free(board: Board, post_id: PostId) -> tuple[AgentId, ...]:
    # The agents of the lab that could still take the rerun of a post, whatever seats they hold: each agent that
    # is in the lab, did not write the post, and has not taken its rerun.
    target = board.post(post_id)
    return tuple(
        joined.agent.id
        for joined in board.agents
        if not joined.agent.checks
        and board.here(joined)
        and (target is None or target.post.author != joined.agent.id)
        and board.take(joined.agent.id, post_id) is None
    )


def open_to(board: Board, post_id: PostId) -> RerunOpenTo:
    """
    Return who can take the rerun of a post now: `reviewer`, `any`, or `none`.

    The rerun is for the holders of the reviewer seats. The seats limit who reviews, and they do not make a rerun
    impossible. So when no holder can take it, any agent of the lab that did not write the post can: the lab has
    no seats, nobody holds one, or every holder wrote the post, took the rerun already, is on call, or was stopped
    by Verifold after its harness failed too often. `none` means that no agent of the lab can take it at all, as
    in a lab of one agent.
    """
    free = _free(board, post_id)
    able = (
        agent
        for agent in free
        if board.reviewer(agent) and not board.on_call(agent) and not before(board, agent).stopped
    )
    if seats(board) > 0 and any(able):
        return 'reviewer'
    return 'any' if free else 'none'


def open_take(board: Board, agent_id: AgentId, post_id: PostId) -> RerunTaken | None:
    """
    Return an agent's take of the rerun of a post while the take has no check yet, or `None`.

    The agent's next check of the post with the method `rerun` and with files is the check of that take. One take
    is one such check: a later check of the same agent is a check like any other.
    """
    taken = board.take(agent_id, post_id)
    checked = any(
        isinstance(entry.post, Check) and entry.post.author == agent_id and entry.post.take is not None
        for entry in board.replies(post_id)
    )
    return None if checked else taken


def _earlier(board: Board, seq: int) -> Board:
    # The board as it was after event `seq`, as far as who can take a rerun goes: the agents, the seats, who left,
    # who is on call, the takes, the turns, and the posts.
    number = next((seats for at, seats in reversed(board.seat_numbers) if at <= seq), None)
    settings = board.settings.model_copy(update={'reviewers': ReviewerSettings(seats=number)})
    return replace(
        board,
        seq=seq,
        agents=tuple(entry for entry in board.agents if entry.seq <= seq),
        reviewers=tuple(entry for entry in board.reviewers if entry.seq <= seq),
        on_calls=tuple(entry for entry in board.on_calls if entry.seq <= seq),
        left=tuple(entry for entry in board.left if entry.seq <= seq),
        posts=tuple(entry for entry in board.posts if entry.seq <= seq),
        takes=tuple(entry for entry in board.takes if entry.seq <= seq),
        starts=tuple(entry for entry in board.starts if entry.seq <= seq),
        turns=tuple(entry for entry in board.turns if entry.seq <= seq),
        settings=settings,
    )


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
        open_to=open_to(board, post_id),
    )


def reruns_wanted(board: Board) -> tuple[RerunLine, ...]:
    """Return every rerun that is wanted, one line for each post, in the order of the first open request for it."""
    posts = dict.fromkeys(entry.post for entry in board.reruns)
    return tuple(sorted(filter(None, (rerun_line(board, post) for post in posts)), key=lambda line: line.asked_at))


def can_take(board: Board, agent_id: AgentId, post_id: PostId) -> bool:
    """
    Return whether an agent can take the rerun of a post now.

    It can when a rerun of the post is wanted, the agent is in the lab, another agent wrote the post, the agent has
    not taken it before, and the rerun is open to the agent: it holds a reviewer seat, or `open_to` says that any
    agent can take it.
    """
    return bool(
        wanted_reruns(board, post_id)
        and agent_id in _free(board, post_id)
        and (board.reviewer(agent_id) or open_to(board, post_id) == 'any')
    )


def reruns_for(board: Board, agent_id: AgentId, after: int, reach: int) -> tuple[RerunLine, ...]:
    """
    Return the reruns that are news for an agent from event `after` to event `reach`, among those that it can take.

    A rerun is news once for an agent, when the agent can first take it:

    - The post becomes wanted, with its first request. A later request for the same rerun joins it and reaches
      nobody.
    - The agent gets a reviewer seat while reruns are wanted.
    - A rerun that was for the reviewer seats opens to any agent, as when its only holder took it or left.

    A request reaches the agents that can take it, as a call that names nobody reaches every agent, so it does not
    reach an agent whose seat is on call, and not the agent that asked. An agent reads every wanted rerun in its
    brief.
    """
    if board.on_call(agent_id):
        return ()
    mine = tuple(
        line
        for line in reruns_wanted(board)
        if agent_id not in line.asked_by[:1] and can_take(board, agent_id, line.post)
    )
    if not mine:
        return ()
    seated = any(after < entry.seq <= reach and entry.agent == agent_id and entry.reviewer for entry in board.reviewers)
    was: Board | None = None

    def opened(line: RerunLine) -> bool:
        # Whether the rerun was for the reviewer seats at `after` and is open to any agent now.
        nonlocal was
        if line.open_to != 'any':
            return False
        was = was or _earlier(board, after)
        return open_to(was, line.post) == 'reviewer'

    return tuple(
        line for line in mine if seated or after < wanted_reruns(board, line.post)[0].seq <= reach or opened(line)
    )


def _checkers(board: Board, post_id: PostId) -> set[AgentId]:
    # The checkers that Verifold started for a post, in a record from before agents took reruns.
    return {joined.agent.id for joined in board.agents if joined.agent.checks == post_id}
