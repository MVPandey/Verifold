"""
The lab's reviewer seats: how many it has, who holds them, and what takes one.

Exploring and testing is every agent's work, and a few agents hold reviewer seats for the rest. A check of another
agent's post and a request for an independent rerun of another agent's post take a reviewer seat. So does the
taking of such a rerun, while an agent in a reviewer seat can take it: the seats limit who reviews, and they make
no rerun impossible. An objection takes no seat, and neither does a result that reproduces another's: that is
building. The person is never limited. A lab with no reviewer seats limits nobody.
"""

from verifold.protocol.ids import PERSON, AgentId, PostId
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
    that came, without the agents that left and without the desk, which is no part of the lab's work. A checker in a
    record from before agents took reruns is none.
    """
    chosen = board.settings.reviewers.seats
    if chosen is not None:
        return chosen
    workers = (joined for joined in board.agents if not joined.agent.checks and not board.is_desk(joined.agent.id))
    return default_seats(sum(board.here(joined) for joined in workers))


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
    return f'The lab has {count}: held by {names}; {free} {"is" if free == 1 else "are"} free.'


def may_review(board: Board, agent_id: AgentId, post_id: PostId) -> bool:
    """Return whether an agent can check a post or ask for an independent rerun of it, as the module's note says."""
    target = board.post(post_id)
    own = target is not None and target.post.author == agent_id
    return agent_id == PERSON or own or seats(board) == 0 or board.reviewer(agent_id)


def check_review(board: Board, agent_id: AgentId, post_id: PostId, what: str) -> None:
    """
    Check that an agent can check a post or ask for an independent rerun of it.

    `what` names the move, such as "A check on".

    Raises:
        RejectedEvent: The move takes a reviewer seat, and the agent holds none.

    """
    if not may_review(board, agent_id, post_id):
        raise RejectedEvent(
            f"{what} another agent's post takes a reviewer seat. {seats_line(board)} `profile` with `reviewer: true` "
            'takes a free seat, and the person can give one. An objection needs no seat, and an author can ask for an '
            'independent rerun of its own post.'
        )
