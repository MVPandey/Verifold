"""
The independent reruns of a lab: which are wanted, who took them, and which checks answer them.

An independent rerun is a rerun from a clean copy of a post's files by another agent than the post's author. An
agent or the person asks for one, and the request starts nothing. An agent in a reviewer seat takes it, or any
other agent when no agent in a reviewer seat can. Verifold gives the taker the clean copy, which is an export of
the pinned files in a folder of Verifold's own. The taker's first check with the method `rerun` and with files
after that is the check of the take, and it answers every request that came before it.

A take gives its agent a lease on the rerun for the minutes that the lab's settings held then, and the agent's
renewal starts it again. The lease ends at its time, at the check of the take, when the agent gives it up, when
the agent leaves, and when the rerun is wanted no longer. While it stands, it keeps every other agent from the
rerun, except an agent of another model family than the post while no holder is of another family: only a check
from another family can make the post stand as held up. The server refuses such a take. The record's rules do not,
because a record from before the leases can hold several takes of one rerun at once. Each take there holds its
lease from its own time. A renewal is an event that no such record holds, so the record's rules refuse one that
another agent's lease keeps out.

A wanted rerun is news once for an agent, at the first moment when the agent can take it. The seat that serves
the agent remembers which reruns it told the agent of, and these functions take that memory as `told`.

A record from before agents took reruns holds checkers that Verifold started for each request. Such a checker read
nothing but its claim and posted one check, and that check answers the requests before it in the same way.
"""

from datetime import datetime, timedelta

from verifold.protocol.events import Posted, RerunRequested, RerunTaken
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.join import LeaseLine, RerunLine, RerunOpenTo
from verifold.protocol.posts import Check
from verifold.society.board import Board
from verifold.society.lifecycle import lab_state, latest_time, utc
from verifold.society.reviewers import seats
from verifold.society.standing import other_family
from verifold.society.turns import before

MAX_RERUNS = 2
"""
The most agents whose independent rerun of one post has a check. A post with that many takes no other request, so
that the record of one post stays small.
"""


type RerunKey = tuple[PostId, int]
"""
A wanted rerun as a seat remembers it: the post, and the event of the first request for it that is still open. A
rerun that a check settled and that somebody asks for again is another one.
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
    # is in the lab, did not write the post, and has not taken its rerun. The desk is no part of the lab's work.
    target = board.post(post_id)
    return tuple(
        joined.agent.id
        for joined in board.agents
        if not joined.agent.checks
        and not board.is_desk(joined.agent.id)
        and board.here(joined)
        and (target is None or target.post.author != joined.agent.id)
        and board.take(joined.agent.id, post_id) is None
    )


def open_to(board: Board, post_id: PostId, now: datetime | None = None) -> RerunOpenTo:
    """
    Return who can take the rerun of a post at `now`, by the reviewer seats: `reviewer`, `any`, or `none`.

    The rerun is for the holders of the reviewer seats. The seats limit who reviews, and they do not make a rerun
    impossible. So when no holder can take it, any agent of the lab that did not write the post can: the lab has
    no seats, nobody holds one, or every holder wrote the post, took the rerun already, is on call, was stopped
    by Verifold after its harness failed too often, or is kept out by another agent's lease. `none` means that no
    agent of the lab can take it at all, as in a lab of one agent. A lease keeps out more agents than the seats
    do, as `binding_leases` says. Without `now`, time counts from the board's newest post.
    """
    moment = now or latest_time(board)
    free = _free(board, post_id)
    able = (
        agent
        for agent in free
        if board.reviewer(agent)
        and not board.on_call(agent)
        and not before(board, agent).stopped
        and not binding_leases(board, agent, post_id, moment)
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


def lease_of(board: Board, agent_id: AgentId, post_id: PostId, now: datetime) -> LeaseLine | None:
    """
    Return an agent's lease on the rerun of a post at `now`, or `None` when it holds none.

    The agent's take starts the lease, and each renewal starts it again, for the minutes that the lab's settings
    held at that event. So a later change of the setting leaves a lease as it was, and a lease that ended stays
    ended. A renewal after the lease ended, by its time or because the agent gave it up, starts a new one, so
    `since` moves. The lease ends at the check of the take, when the agent leaves, and when the rerun is wanted no
    longer: the check that settles a rerun ends every lease on it, and a take or a renewal before that check
    starts none after it. An event dated after `now`, as from a clock that jumped, starts no lease.
    """
    if not wanted_reruns(board, post_id):
        return None
    return _lease(board, agent_id, post_id, now, _settled(board, post_id))


def _settled(board: Board, post_id: PostId) -> int:
    # The event of the newest check that settled a rerun of the post, or zero.
    return max((entry.seq for entry in rerun_checks(board, post_id)), default=0)


def _lease(board: Board, agent_id: AgentId, post_id: PostId, now: datetime, settled: int) -> LeaseLine | None:
    # The lease of `lease_of`, for a rerun that is wanted and whose newest settling check is event `settled`.
    taken = open_take(board, agent_id, post_id)
    if taken is None or board.gone(agent_id):
        return None
    renewals = (
        (entry.seq, entry.at, entry.held) for entry in board.leases if (entry.agent, entry.post) == (agent_id, post_id)
    )
    since: datetime | None = None
    until = taken.at
    for seq, at, held in ((taken.seq, taken.at, True), *renewals):
        if seq <= settled or at > now:
            continue
        if not held:
            since = None
            continue
        if since is None or at >= until:
            since = at
        until = at + timedelta(minutes=board.settings_at(seq).reruns.lease_minutes)
    return LeaseLine(agent=agent_id, since=since, until=until) if since and now < until else None


def leases(board: Board, post_id: PostId, now: datetime) -> tuple[LeaseLine, ...]:
    """Return the leases on the rerun of a post that stand at `now`, in the order of the takes."""
    takers = dict.fromkeys(entry.agent for entry in board.takes if entry.post == post_id)
    if not takers or not wanted_reruns(board, post_id):
        return ()
    settled = _settled(board, post_id)
    return tuple(lease for agent in takers if (lease := _lease(board, agent, post_id, now, settled)))


def binding_leases(board: Board, agent_id: AgentId, post_id: PostId, now: datetime) -> tuple[LeaseLine, ...]:
    """
    Return the leases of other agents that keep an agent from the rerun of a post at `now`.

    Every lease of another agent does, except for an agent of another model family than the post while no holder
    is of another family.
    """
    target = board.post(post_id)
    author = board.agent(target.post.author) if target else None
    others = tuple(lease for lease in leases(board, post_id, now) if lease.agent != agent_id)

    def counts(agent: AgentId) -> bool:
        # Whether a check of this agent can make the post stand as held up, by the model families of the seats.
        joined = board.agent(agent)
        return bool(author and joined and other_family(author.agent, joined.agent))

    # For an agent whose check can count, only a lease whose check can count too keeps it out.
    return tuple(lease for lease in others if counts(lease.agent)) if counts(agent_id) else others


def _held(post_id: PostId, binding: tuple[LeaseLine, ...]) -> tuple[str, str]:
    # Who holds the rerun since when and until when, and how a sentence after it names those leases.
    held = ' '.join(
        f'{lease.agent} holds the rerun of post {post_id} since {utc(lease.since)}, until {utc(lease.until)}.'
        for lease in binding
    )
    return held, 'that lease stands' if len(binding) == 1 else 'one of those leases stands'


def lease_refusal(board: Board, agent_id: AgentId, post_id: PostId, now: datetime) -> str | None:
    """Return why other agents' leases keep an agent from taking the rerun of a post at `now`, or `None`."""
    binding = binding_leases(board, agent_id, post_id, now)
    if not binding:
        return None
    held, stands = _held(post_id, binding)
    return f'{held} The board takes no take of the rerun from you while {stands}.'


def renewal_refusal(board: Board, agent_id: AgentId, post_id: PostId, now: datetime) -> str | None:
    """Return why other agents' leases keep an agent from renewing its lease on the rerun of a post, or `None`."""
    binding = binding_leases(board, agent_id, post_id, now)
    if not binding:
        return None
    held, stands = _held(post_id, binding)
    return (
        f'{held} The board renews no lease of yours on the rerun while {stands}. Your take stands, and its check '
        'still answers the requests.'
    )


def kept_until(
    board: Board, agent_id: AgentId, now: datetime, told: frozenset[RerunKey] = frozenset()
) -> datetime | None:
    """
    Return when the first wanted rerun that only a lease keeps from an agent comes free by time, or `None`.

    That is the latest end of the leases that keep the agent from it, the earliest such time of all the reruns. A
    rerun in `told`, which the agent was told of already, does not count: its lease's end is no news for the agent.
    A renewal moves the time, so a caller asks again when the board changes.
    """
    if board.on_call(agent_id):
        return None
    ends = (
        max(lease.until for lease in binding)
        for line in reruns_wanted(board, now)
        if agent_id not in line.asked_by[:1]
        and rerun_key(board, line.post) not in told
        and _may_take(board, agent_id, line.post, now)
        and (binding := binding_leases(board, agent_id, line.post, now))
    )
    return min(ends, default=None)


COPY_MINUTES = 10
"""
The fewest minutes that Verifold keeps a clean copy after a take or a renewal of its rerun, also when the lab's
leases are shorter or there are none.
"""


def copy_kept_until(board: Board, post_id: PostId, now: datetime) -> datetime | None:
    """
    Return until when the clean copy of a post's files is needed, or `None` when nothing needs it at `now`.

    A take of the rerun that waits for its check needs the copy while its agent's lease stands, and for
    `COPY_MINUTES` after its latest take or renewal at least. A take whose agent gave up its lease after that needs
    it no more, and neither does a take of an agent that left. Nothing needs the copy once the rerun is wanted no
    longer: the check that settles it ends every lease on it. A renewal moves the time, so a caller asks again
    when the board changes.
    """
    if lab_state(board) == 'closed' or not wanted_reruns(board, post_id):
        return None
    settled = _settled(board, post_id)
    ends: list[datetime] = []
    for take in board.takes:
        if take.post != post_id or board.gone(take.agent) or open_take(board, take.agent, post_id) is None:
            continue
        calls = (
            (take.seq, take.at, True),
            *(
                (entry.seq, entry.at, entry.held)
                for entry in board.leases
                if (entry.agent, entry.post) == (take.agent, post_id)
            ),
        )
        made = [call for call in calls if call[0] > settled and call[1] <= now]
        if made and made[-1][2]:
            seq, at, _ = made[-1]
            minutes = max(board.settings_at(seq).reruns.lease_minutes, COPY_MINUTES)
            ends.append(at + timedelta(minutes=minutes))
    until = max(ends, default=None)
    return until if until and until > now else None


def rerun_line(board: Board, post_id: PostId, now: datetime | None = None) -> RerunLine | None:
    """
    Return the rerun that is wanted for a post as one line, or `None` when none is wanted.

    The line has the leases that stand at `now`. Without `now`, time counts from the board's newest post.
    """
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
        held_by=leases(board, post_id, now or latest_time(board)),
        open_to=open_to(board, post_id, now),
    )


def reruns_wanted(board: Board, now: datetime | None = None) -> tuple[RerunLine, ...]:
    """Return every rerun that is wanted, one line for each post, in the order of the first open request for it."""
    posts = dict.fromkeys(entry.post for entry in board.reruns)
    lines = filter(None, (rerun_line(board, post, now) for post in posts))
    return tuple(sorted(lines, key=lambda line: line.asked_at))


def _may_take(board: Board, agent_id: AgentId, post_id: PostId, now: datetime) -> bool:
    # Whether the request, the takes, and the seats let an agent take the rerun of a post, whatever the leases say.
    return bool(
        wanted_reruns(board, post_id)
        and agent_id in _free(board, post_id)
        and (board.reviewer(agent_id) or open_to(board, post_id, now) == 'any')
    )


def can_take(board: Board, agent_id: AgentId, post_id: PostId, now: datetime | None = None) -> bool:
    """
    Return whether an agent can take the rerun of a post at `now`.

    It can when a rerun of the post is wanted, the agent is in the lab, another agent wrote the post, the agent has
    not taken it before, the rerun is open to the agent: it holds a reviewer seat, or `open_to` says that any agent
    can take it, and no lease of another agent keeps it out. Without `now`, time counts from the newest post.
    """
    moment = now or latest_time(board)
    return _may_take(board, agent_id, post_id, moment) and not binding_leases(board, agent_id, post_id, moment)


def rerun_key(board: Board, post_id: PostId) -> RerunKey | None:
    """Return the key of the rerun of a post that is wanted now, or `None` when none is."""
    wanted = wanted_reruns(board, post_id)
    return (post_id, wanted[0].seq) if wanted else None


def told_of(board: Board, lines: tuple[RerunLine, ...]) -> frozenset[RerunKey]:
    """Return the keys of the wanted reruns that some lines of reruns hold."""
    return frozenset(key for line in lines if (key := rerun_key(board, line.post)))


def reruns_for(
    board: Board, agent_id: AgentId, told: frozenset[RerunKey] = frozenset(), now: datetime | None = None
) -> tuple[RerunLine, ...]:
    """
    Return the wanted reruns that are news for an agent at `now`: each that it can take and that `told` does not hold.

    A rerun is news once for an agent, at the first moment when the agent can take it: when it becomes wanted, when
    the agent gets a reviewer seat, when it opens to every agent, as when its only holder of a seat took it or
    left, or when a lease that kept the agent out ends. The caller keeps in `told` the reruns that the agent was
    told of, so a later lease that ends tells it nothing. A later request for the same rerun joins it and reaches
    nobody.

    A request reaches the agents that can take it, as a call that names nobody reaches every agent, so it does not
    reach an agent whose seat is on call, not the agent that asked first, and not an agent that a lease keeps out.
    An agent reads every wanted rerun in its brief. Without `now`, time counts from the board's newest post.
    """
    if board.on_call(agent_id):
        return ()
    moment = now or latest_time(board)
    return tuple(
        line
        for line in reruns_wanted(board, moment)
        if agent_id not in line.asked_by[:1]
        and rerun_key(board, line.post) not in told
        and can_take(board, agent_id, line.post, moment)
    )


def _checkers(board: Board, post_id: PostId) -> set[AgentId]:
    # The checkers that Verifold started for a post, in a record from before agents took reruns.
    return {joined.agent.id for joined in board.agents if joined.agent.checks == post_id}
