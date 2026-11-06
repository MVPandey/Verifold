"""
The integrity rules of the record.

These rules keep the record consistent: references point at things that exist, nobody checks their own work, and
only the author of a post can concede an objection to it. How agents should work is a norm for the agents, not a rule
here.
"""

from verifold.protocol.agents import Agent
from verifold.protocol.events import TurnEnded, WatchSet
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.posts import Answer, Check, Objection, Post
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent


def check_agent(board: Board, agent: Agent) -> None:
    """
    Check that an agent can join the board.

    Raises:
        RejectedEvent: The ID is taken or reserved, or the recruiter is not in the lab.

    """
    if agent.id == PERSON or board.agent(agent.id):
        raise RejectedEvent(f'The agent ID {agent.id} is taken. Choose another ID.')
    if agent.recruited_by and not board.agent(agent.recruited_by):
        raise RejectedEvent(f'{agent.recruited_by} is not an agent in this lab.')


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


def _check_member(board: Board, author: AgentId) -> None:
    if author != PERSON and not board.agent(author):
        raise RejectedEvent(f'{author} is not an agent in this lab.')


def _check_concession(board: Board, answer: Answer, target: Post) -> None:
    objected = board.post(target.reply_to) if isinstance(target, Objection) else None
    if objected is None:
        raise RejectedEvent('Only an answer to an objection can accept it.')
    if objected.post.author != answer.author:
        raise RejectedEvent(f'Only {objected.post.author}, who wrote {objected.post.id}, can accept this objection.')
