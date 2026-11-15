"""
The lab's reviewer seats: how many it has, who holds them, and what takes one.

Exploring and testing is every agent's work, and a few agents hold reviewer seats for the rest. A check of another
agent's result and a request for a blind rerun take a reviewer seat, with three exceptions: a post that the
agent's own post builds on or replies to, a post that the lab's answer builds on, and the answer itself. An
objection takes no seat. The person is never limited, and neither is a blind checker, which is no agent of the lab.
A lab with no reviewer seats limits nobody.
"""

from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.posts import Proposal
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent

AGENTS_FOR_A_SEAT = 5
"""How many agents a lab has for each reviewer seat, when the person set no number."""

SMALLEST_LAB_WITH_A_SEAT = 3
"""The fewest agents with which a lab has a reviewer seat, when the person set no number."""


def default_seats(agents: int) -> int:
    """
    Return how many reviewer seats a lab of `agents` agents has when the person set no number.

    It is one seat for every five agents, rounded down, and at least one seat from three agents. A lab of one or
    two agents has none, so that its agents can check each other.
    """
    if agents < SMALLEST_LAB_WITH_A_SEAT:
        return 0
    return max(agents // AGENTS_FOR_A_SEAT, 1)


def seats(board: Board) -> int:
    """
    Return how many reviewer seats the lab has: the number that the person set, or else the number for its size.

    The size counts the agents that are in the lab now: each agent that Verifold started and each invited agent
    that came, without the agents that left and the blind checkers.
    """
    chosen = board.settings.reviewers.seats
    if chosen is not None:
        return chosen
    return default_seats(sum(not joined.agent.checks and board.here(joined) for joined in board.agents))


def holders(board: Board) -> tuple[AgentId, ...]:
    """Return the agents that hold a reviewer seat now, in the order that they joined."""
    return tuple(joined.agent.id for joined in board.agents if board.reviewer(joined.agent.id))


def free_seats(board: Board) -> int:
    """Return how many reviewer seats nobody holds. The person can give more seats than the lab has, and then none is free."""
    return max(seats(board) - len(holders(board)), 0)


def seats_line(board: Board) -> str:
    """Return the state of the reviewer seats as one sentence: how many the lab has, who holds them, and how many are free."""
    held = holders(board)
    names = ', '.join(held) if held else 'nobody'
    count, free = seats(board), free_seats(board)
    return f'The lab has {count}, held by {names}; {free} {"is" if free == 1 else "are"} free.'


def may_review(board: Board, agent_id: AgentId, post_id: PostId) -> bool:
    """Return whether an agent can check a post, or ask for a blind rerun of it, as the module's note says."""
    joined = board.agent(agent_id)
    if agent_id == PERSON or (joined and joined.agent.checks) or seats(board) == 0 or board.reviewer(agent_id):
        return True
    own = any(
        entry.post.author == agent_id and (post_id in entry.post.builds_on or entry.post.reply_to == post_id)
        for entry in board.posts
    )
    # The lab's answer is its newest proposal in a thread for the whole lab, as `answer` in `views` has it.
    answer = next(
        (
            entry.post
            for entry in reversed(board.posts)
            if isinstance(entry.post, Proposal) and not board.is_side(entry.post.thread)
        ),
        None,
    )
    return own or bool(answer and (post_id == answer.id or post_id in answer.builds_on))


def check_review(board: Board, agent_id: AgentId, post_id: PostId, what: str) -> None:
    """
    Check that an agent can check a post or ask for a blind rerun of it. `what` names the move, such as "A check".

    Raises:
        RejectedEvent: The move takes a reviewer seat, and the agent holds none.

    """
    if not may_review(board, agent_id, post_id):
        raise RejectedEvent(
            f'{what} on a post that your work does not build on takes a reviewer seat. {seats_line(board)}'
        )
