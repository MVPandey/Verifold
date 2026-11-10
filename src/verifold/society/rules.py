"""
The integrity rules of the record.

These rules keep the record consistent: references point at things that exist, nobody checks their own work, and
only the author of a post can concede an objection to it. How agents should work is a norm for the agents, not a rule
here.
"""

from verifold.protocol.agents import Agent
from verifold.protocol.events import Posted, RerunRequested, TimeRanOut, TimeSet, TurnEnded, WatchSet
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.posts import Answer, Check, Objection, Post
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent

MAX_RERUNS = 2
"""The most blind reruns that one post can have. Each one ends with a blind checker's check."""


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


def check_thread(board: Board, thread: Thread) -> None:
    """
    Check that a thread can open on the board.

    Raises:
        RejectedEvent: The ID is taken, or the author is not in the lab.

    """
    if board.thread(thread.id):
        raise RejectedEvent(f'Thread {thread.id} exists already.')
    _check_member(board, thread.opened_by)


def check_post(board: Board, post: Post) -> None:
    """
    Check that a post can go on the board.

    Raises:
        RejectedEvent: The post breaks a rule of the record. The message says what to change.

    """
    if board.post(post.id):
        raise RejectedEvent(f'Post {post.id} exists already.')
    _check_member(board, post.author)
    _check_blind(board, post)
    for mention in post.mentions:
        _check_member(board, mention)
    if not board.thread(post.thread):
        raise RejectedEvent(f'Thread {post.thread} does not exist. Open a thread first.')
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
    if not board.thread(watch.thread):
        raise RejectedEvent(f'Thread {watch.thread} does not exist.')


def check_turn(board: Board, turn: TurnEnded) -> None:
    """
    Check that a turn belongs to an agent in the lab.

    Raises:
        RejectedEvent: The agent is not in the lab.

    """
    if not board.agent(turn.agent):
        raise RejectedEvent(f'{turn.agent} is not an agent in this lab.')


def check_rerun(board: Board, rerun: RerunRequested) -> None:
    """
    Check that a post can get a blind rerun.

    Raises:
        RejectedEvent: The post does not exist, has no files as evidence, or has all its blind reruns already, or the
            same member asked already and that request is still open.

    """
    _check_member(board, rerun.by)
    target = board.post(rerun.post)
    if target is None:
        raise RejectedEvent(f'Post {rerun.post} does not exist.')
    if not target.post.evidence:
        raise RejectedEvent(f'Post {rerun.post} has no files as evidence, so a checker has nothing to rerun.')
    if len(blind_checks(board, rerun.post)) >= MAX_RERUNS:
        raise RejectedEvent(f'Post {rerun.post} has {MAX_RERUNS} blind reruns already.')
    if any(entry.by == rerun.by for entry in open_reruns(board, rerun.post)):
        raise RejectedEvent(f'You asked for a blind rerun of {rerun.post} already. Its check will come to you.')


def blind_checks(board: Board, post_id: PostId) -> tuple[Posted, ...]:
    """Return the checks of a post that its blind checkers posted, oldest first."""
    checkers = {joined.agent.id for joined in board.agents if joined.agent.checks == post_id}
    return tuple(
        entry for entry in board.replies(post_id) if isinstance(entry.post, Check) and entry.post.author in checkers
    )


def open_reruns(board: Board, post_id: PostId) -> tuple[RerunRequested, ...]:
    """
    Return the requests for a blind rerun of a post that no blind check has answered yet, oldest first.

    One blind check answers every request that came before it. So a request that arrives while a rerun runs joins
    that rerun, and the lab starts one checker for both.
    """
    latest = max((entry.seq for entry in blind_checks(board, post_id)), default=0)
    return tuple(entry for entry in board.reruns if entry.post == post_id and entry.seq > latest)


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


def _check_concession(board: Board, answer: Answer, target: Post) -> None:
    objected = board.post(target.reply_to) if isinstance(target, Objection) else None
    if objected is None:
        raise RejectedEvent('Only an answer to an objection can accept it.')
    if objected.post.author != answer.author:
        raise RejectedEvent(f'Only {objected.post.author}, who wrote {objected.post.id}, can accept this objection.')
