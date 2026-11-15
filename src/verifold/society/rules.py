"""
The integrity rules of the record.

These rules keep the record consistent: references point at things that exist, nobody checks their own work, and
only the author of a post can concede an objection to it. How agents should work is a norm for the agents, not a rule
here.
"""

from verifold.protocol.agents import Agent
from verifold.protocol.events import (
    AgentLeft,
    AgentNamed,
    AlarmSet,
    CoordinatorSet,
    OnCallSet,
    Posted,
    ProfileSet,
    QuestionRevised,
    RerunRequested,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    WatchSet,
)
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.posts import Answer, Check, Close, Objection, Post, Proposal
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import lab_state
from verifold.society.standing import closing

MAX_RERUNS = 2
"""The most blind reruns that one post can have. Each one ends with a blind checker's check."""

MAX_CHECKERS = 4
"""The most blind checkers that one post can get. A checker that fails counts, so failures can't start checkers without end."""


def check_agent(board: Board, agent: Agent) -> None:
    """
    Check that an agent can join the board.

    Raises:
        RejectedEvent: The ID is taken or reserved, or the recruiter is not in the lab.

    """
    if agent.id == PERSON or board.agent(agent.id):
        raise RejectedEvent(f'The agent ID {agent.id} is taken. Choose another ID.')
    if agent.recruited_by:
        _check_member(board, agent.recruited_by)
    if agent.checks and not board.post(agent.checks):
        raise RejectedEvent(f'Post {agent.checks} does not exist.')


def check_named(board: Board, named: AgentNamed) -> str:
    """
    Check that an agent can get a new name, and return the name that it has now.

    A name that an agent has or had is never another agent's name, so that a name in an older post means the
    same agent for ever.

    Raises:
        RejectedEvent: The agent is not in the lab, or another agent has or had the name.

    """
    joined = board.agent(named.agent)
    if not joined:
        raise RejectedEvent(f'{named.agent} is not an agent in this lab.')
    folded = named.name.casefold()
    others = (entry.agent.name for entry in board.agents if entry.agent.id != named.agent)
    former = (before for event, before in board.renames if event.agent != named.agent)
    if any(name.casefold() == folded for name in (*others, *former)):
        raise RejectedEvent(f'Another agent has or had the name {named.name}.')
    return joined.agent.name


def check_on_call(board: Board, event: OnCallSet) -> None:
    """
    Check that a seat can go on call or come off it.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, or is a blind checker.

    """
    _check_seat(board, event.agent)


def check_coordinator(board: Board, event: CoordinatorSet) -> None:
    """
    Check that the lab's coordinator can change.

    The person can give the seat to any agent of the lab and can clear it. An agent can take the seat for itself
    when nobody holds it and the person did not close it, and give up the seat that it holds.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, or is a blind checker, an agent names another agent,
            an agent takes a seat that somebody holds or that the person closed, or an agent gives up a seat that
            it does not hold.

    """
    if event.agent:
        _check_seat(board, event.agent)
    if event.by == PERSON:
        return
    _check_seat(board, event.by)
    holder = board.coordinator
    if event.agent is None:
        if holder != event.by:
            raise RejectedEvent('You are not the coordinator of this lab, so you have no seat to give up.')
        return
    if event.agent != event.by:
        raise RejectedEvent('An agent takes the coordinator seat for itself. Only the person gives it to another.')
    if holder and holder != event.by:
        raise RejectedEvent(
            f'{holder} is the coordinator of this lab. The seat is free when {holder} gives it up or the person '
            'gives it to another agent.'
        )
    if not holder and not board.coordinator_open:
        raise RejectedEvent(
            'The person closed the coordinator seat, so no agent takes it by itself. The person can give it to an '
            'agent or open it.'
        )


def _check_seat(board: Board, agent_id: AgentId) -> None:
    joined = board.agent(agent_id)
    if not joined:
        raise RejectedEvent(f'{agent_id} is not an agent in this lab.')
    _check_here(board, agent_id)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker has no seat in the lab: it posts one check and is gone.')


def check_revision(board: Board, revision: QuestionRevised) -> None:
    """
    Check that a revision of the question comes with the person's post that tells the lab.

    Raises:
        RejectedEvent: The post is not the board's newest, or the person did not write it.

    """
    told = board.posts[-1] if board.posts else None
    if told is None or told.post.id != revision.post or told.post.author != PERSON or told.seq != board.seq:
        raise RejectedEvent(f'Post {revision.post} is not the post of the person that tells the lab of this revision.')


def check_left(board: Board, left: AgentLeft) -> None:
    """
    Check that an agent can leave the lab, by its own choice or the person's.

    Raises:
        RejectedEvent: The agent is not in the lab, left already, or is a blind checker, or somebody other than the
            agent itself and the person caused it.

    """
    joined = board.agent(left.agent)
    if not joined:
        raise RejectedEvent(f'{left.agent} is not an agent in this lab.')
    _check_here(board, left.agent)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker is gone after its one check, so it does not leave and nobody removes it.')
    if left.by not in (left.agent, PERSON):
        raise RejectedEvent(f'Only {left.agent} itself or the person can remove {left.agent} from the lab.')


def check_thread(board: Board, thread: Thread) -> None:
    """
    Check that a thread can open on the board.

    Raises:
        RejectedEvent: The ID is taken, the author is not in the lab, or a side thread names somebody that it cannot.

    """
    if board.thread(thread.id):
        raise RejectedEvent(f'Thread {thread.id} exists already.')
    _check_member(board, thread.opened_by)
    _check_here(board, thread.opened_by)
    if thread.between:
        _check_between(board, thread)


def check_post(board: Board, post: Post) -> None:
    """
    Check that a post can go on the board.

    Raises:
        RejectedEvent: The post breaks a rule of the record. The message says what to change.

    """
    if board.post(post.id):
        raise RejectedEvent(f'Post {post.id} exists already.')
    _check_member(board, post.author)
    _check_here(board, post.author)
    _check_blind(board, post)
    for mention in post.mentions:
        _check_member(board, mention)
    opened = board.thread(post.thread)
    if not opened:
        raise RejectedEvent(f'Thread {post.thread} does not exist. Open a thread first.')
    for built_on in post.builds_on:
        if not board.post(built_on):
            raise RejectedEvent(f'Post {built_on} does not exist, so no post can build on it.')
    if isinstance(post, Proposal | Close) and opened.thread.between:
        raise RejectedEvent(
            f'Thread {post.thread} is a side thread, and a {post.kind} is for the whole lab. Post it in a thread '
            'that is not a side thread.'
        )
    if isinstance(post, Close):
        _check_close(board, post)
    if post.reply_to is None:
        return
    target = board.post(post.reply_to)
    if target is None:
        raise RejectedEvent(f'Post {post.reply_to} does not exist.')
    if target.post.thread != post.thread:
        raise RejectedEvent(f'Post {post.reply_to} is in thread {target.post.thread}. Reply in that thread.')
    match post:
        case Objection() | Check() if target.post.author == post.author:
            raise RejectedEvent(f'Post {post.reply_to} is your own. Another agent must object to it or check it.')
        case Answer(accepts=True):
            _check_concession(board, post, target.post)


def check_watch(board: Board, watch: WatchSet) -> None:
    """
    Check that an agent can watch a thread.

    Raises:
        RejectedEvent: The agent is not in the lab, or the thread does not exist.

    """
    if not board.agent(watch.agent):
        raise RejectedEvent(f'{watch.agent} is not an agent in this lab.')
    _check_here(board, watch.agent)
    if not board.thread(watch.thread):
        raise RejectedEvent(f'Thread {watch.thread} does not exist.')


def check_alarm(board: Board, alarm: AlarmSet) -> None:
    """
    Check that an agent can set an alarm.

    Raises:
        RejectedEvent: The agent is not in the lab, or is a blind checker.

    """
    joined = board.agent(alarm.agent)
    if not joined:
        raise RejectedEvent(f'{alarm.agent} is not an agent in this lab.')
    _check_here(board, alarm.agent)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker posts one check and sets no alarm.')


def check_profile(board: Board, profile: ProfileSet) -> None:
    """
    Check that an agent can say what it is and what it does.

    Raises:
        RejectedEvent: The agent is not in the lab, is a blind checker, or changes nothing.

    """
    joined = board.agent(profile.agent)
    if not joined:
        raise RejectedEvent(f'{profile.agent} is not an agent in this lab.')
    _check_here(board, profile.agent)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker has no role and no status.')
    if profile.role is None and profile.status is None:
        raise RejectedEvent('Give a role, a status, or both.')


def check_turn(board: Board, turn: TurnStarted | TurnEnded) -> None:
    """
    Check that a turn belongs to an agent in the lab, and that only a blind checker's turn ends a rerun.

    Raises:
        RejectedEvent: The agent is not in the lab, the turn starts with the ring of an alarm that the agent did
            not set, or the turn ends a rerun and the agent is not a blind checker.

    """
    joined = board.agent(turn.agent)
    if not joined:
        raise RejectedEvent(f'{turn.agent} is not an agent in this lab.')
    rang = turn.rang if isinstance(turn, TurnStarted) else None
    if rang is not None and not any(alarm.seq == rang and alarm.agent == turn.agent for alarm in board.alarms):
        raise RejectedEvent(f'Event {rang} is no alarm of {turn.agent}, so it cannot ring for this turn.')
    if isinstance(turn, TurnEnded) and turn.rerun_failed and not joined.agent.checks:
        raise RejectedEvent(f'{turn.agent} is not a blind checker, so its turn cannot end a rerun.')


def check_rerun(board: Board, rerun: RerunRequested) -> None:
    """
    Check that a post can get a blind rerun.

    Raises:
        RejectedEvent: The post does not exist, has no files as evidence, has all its blind reruns already, or got
            all the blind checkers that a post can get.

    """
    _check_member(board, rerun.by)
    _check_here(board, rerun.by)
    target = board.post(rerun.post)
    if target is None:
        raise RejectedEvent(f'Post {rerun.post} does not exist.')
    if not target.post.evidence:
        raise RejectedEvent(f'Post {rerun.post} has no files as evidence, so a checker has nothing to rerun.')
    if len(blind_checks(board, rerun.post)) >= MAX_RERUNS:
        raise RejectedEvent(f'Post {rerun.post} has {MAX_RERUNS} blind reruns already.')
    # A request that joins the rerun of a request that waits starts no checker of its own.
    if len(_checkers(board, rerun.post)) >= MAX_CHECKERS and not waiting_reruns(board, rerun.post):
        raise RejectedEvent(f'Post {rerun.post} got {MAX_CHECKERS} blind checkers already, and a post gets no more.')


def blind_checks(board: Board, post_id: PostId) -> tuple[Posted, ...]:
    """Return the first check of each blind checker of a post, oldest first. One checker is one blind rerun."""
    checkers = _checkers(board, post_id)
    first: dict[AgentId, Posted] = {}
    for entry in board.replies(post_id):
        if isinstance(entry.post, Check) and entry.post.author in checkers:
            first.setdefault(entry.post.author, entry)
    return tuple(first.values())


def open_reruns(board: Board, post_id: PostId) -> tuple[RerunRequested, ...]:
    """
    Return the requests for a blind rerun of a post that no blind check has answered yet, oldest first.

    One blind check answers every request that came before it. So a request that arrives while a rerun runs joins
    that rerun, and the lab starts one checker for both.
    """
    latest = max((entry.seq for entry in blind_checks(board, post_id)), default=0)
    return tuple(entry for entry in board.reruns if entry.post == post_id and entry.seq > latest)


def waiting_reruns(board: Board, post_id: PostId) -> tuple[RerunRequested, ...]:
    """
    Return the open requests for a post that came after its last failed rerun, oldest first.

    A rerun that fails leaves the requests before it without a check. Those requests start no other checker, and
    their members can ask again. A turn that fails without the end of the rerun, such as one that the time limit
    cancelled, frees no request, because the same checker goes on.
    """
    checkers = _checkers(board, post_id)
    failed = max((turn.seq for turn in board.turns if turn.rerun_failed and turn.agent in checkers), default=0)
    return tuple(entry for entry in open_reruns(board, post_id) if entry.seq > failed)


def _checkers(board: Board, post_id: PostId) -> set[AgentId]:
    return {joined.agent.id for joined in board.agents if joined.agent.checks == post_id}


def check_time(time: TimeSet) -> None:
    """
    Check that a new end of the lab is not earlier than the moment that it was set.

    Raises:
        RejectedEvent: The end is in the past.

    """
    if time.ends_at < time.at:
        raise RejectedEvent('The lab cannot end before the moment that its end is set.')


def check_time_out(board: Board, event: TimeRanOut) -> None:
    """
    Check that the lab reached its end, and that the record does not say so already.

    Raises:
        RejectedEvent: The lab has no time limit, has time left, or ran out of time already.

    """
    ends_at = board.ends_at
    if ends_at is None or event.at < ends_at or board.out_of_time:
        raise RejectedEvent('The lab runs out of time once, at its end.')


def _check_blind(board: Board, post: Post) -> None:
    joined = board.agent(post.author)
    target = joined.agent.checks if joined else None
    if target and not (isinstance(post, Check) and post.reply_to == target):
        raise RejectedEvent(f'You rerun {target} blind. Post one check that replies to {target}.')


def _check_member(board: Board, author: AgentId) -> None:
    if author != PERSON and not board.agent(author):
        raise RejectedEvent(f'{author} is not an agent in this lab.')


def _check_here(board: Board, agent_id: AgentId) -> None:
    # The record takes nothing more from an agent that left. Other agents can still name it, reply to its posts,
    # and check them, and the turn that it was in still ends.
    if board.gone(agent_id):
        raise RejectedEvent(f'{agent_id} left this lab, so the board takes no post and no other change from it.')


def _check_between(board: Board, thread: Thread) -> None:
    # A side thread is between agents of the lab that can hear it. The person can post in any thread already.
    others = tuple(agent for agent in thread.between if agent != thread.opened_by)
    if thread.opened_by == PERSON or thread.between[0] != thread.opened_by or not others:
        raise RejectedEvent('A side thread is between the agent that opens it and at least one other agent.')
    for agent in others:
        joined = board.agent(agent)
        if not joined:
            raise RejectedEvent(f'{agent} is not an agent in this lab, so no side thread is between you and it.')
        if joined.agent.checks:
            raise RejectedEvent(f'{agent} is a blind checker, which reads nothing but its claim.')
        if board.gone(agent):
            raise RejectedEvent(f'{agent} left this lab, so no post reaches it.')
        if not board.came(joined):
            raise RejectedEvent(f'{agent} has an invitation and has not posted yet, so nobody knows whether it came.')


def _check_close(board: Board, close: Close) -> None:
    if close.author == PERSON:
        raise RejectedEvent("A close is the agents' word that the lab is done. You can stop the lab at any time.")
    standing_close = closing(board)
    if standing_close is None or standing_close.post.author == close.author:
        return
    # Nobody can ask the author of a close to withdraw it once that author left. So another agent's close replaces
    # it, unless the lab is closed already: the agents that stood behind the old close keep their word.
    if board.gone(standing_close.post.author):
        if lab_state(board) == 'closed':
            raise RejectedEvent(
                f'The lab is closed already: more than half of its agents stood behind {standing_close.post.id}. '
                'It takes no other close.'
            )
        return
    raise RejectedEvent(
        f'{standing_close.post.author} says in {standing_close.post.id} that the lab is done. Agree with an '
        f'answer to it that has `accepts: true`, or object to it.'
    )


def _check_concession(board: Board, answer: Answer, target: Post) -> None:
    if isinstance(target, Close):
        if target.author == answer.author:
            raise RejectedEvent(f'Post {target.id} is your own. Another agent agrees with it.')
        return
    objected = board.post(target.reply_to) if isinstance(target, Objection) else None
    if objected is None:
        raise RejectedEvent('Only an answer to an objection or to a close can accept it.')
    if objected.post.author != answer.author:
        raise RejectedEvent(f'Only {objected.post.author}, who wrote {objected.post.id}, can accept this objection.')
