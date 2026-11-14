"""Whether the lab is done, by its own agents' word, and the alarms that agents set for themselves."""

from datetime import datetime, timedelta

from verifold.protocol.events import AlarmSet, Posted
from verifold.protocol.ids import AgentId
from verifold.protocol.join import LabState
from verifold.protocol.posts import Answer, Close, RuledOut
from verifold.society.board import Board
from verifold.society.standing import standing


def closing(board: Board) -> Posted | None:
    """
    Return the post that says that the lab is done, when one stands: the newest close.

    It stands until an objection to it stands, its author concedes one, or its author withdraws it with a ruled-out
    lead that replies to it. An older close does not come back.
    """
    entry = next((entry for entry in reversed(board.posts) if isinstance(entry.post, Close)), None)
    if entry is None or standing(board, entry.post.id) in {'disputed', 'conceded'}:
        return None
    withdrawn = any(
        isinstance(reply.post, RuledOut) and reply.post.author == entry.post.author
        for reply in board.replies(entry.post.id)
    )
    return None if withdrawn else entry


def agreed(board: Board, close: Posted) -> tuple[AgentId, ...]:
    """Return the agents of the lab that agreed with a close, each once, in the order that they agreed."""
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    return tuple(
        dict.fromkeys(
            reply.post.author
            for reply in board.replies(close.post.id)
            if isinstance(reply.post, Answer)
            and reply.post.accepts
            and reply.post.author in workers
            and reply.post.author != close.post.author
        )
    )


def lab_state(board: Board) -> LabState:
    """
    Return whether the lab is open, closing, or closed.

    It is closing while a close stands, and closed once more than half of the lab's agents stand behind it: its
    author and the agents that agreed. A new objection to the close opens the lab again.
    """
    close = closing(board)
    if close is None:
        return 'open'
    workers = sum(not joined.agent.checks for joined in board.agents)
    return 'closed' if (1 + len(agreed(board, close))) * 2 > workers else 'closing'


def pending_alarm(board: Board, agent_id: AgentId) -> AlarmSet | None:
    """
    Return the alarm that waits for an agent whose turn has ended, or `None`.

    It is the newest alarm that the agent set in its last turn, unless that one cancels. An alarm from an earlier
    turn is spent.
    """
    ends = tuple(turn.seq for turn in board.turns if turn.agent == agent_id)
    before = ends[-2] if len(ends) > 1 else 0
    alarm = next((alarm for alarm in reversed(board.alarms) if alarm.agent == agent_id), None)
    return alarm if alarm and ends and before < alarm.seq < ends[-1] and alarm.minutes > 0 else None


def rings_at(board: Board, alarm: AlarmSet) -> datetime:
    """Return when an alarm rings: after its minutes, counted from the newest post when the alarm waits for quiet."""
    latest = board.posts[-1].at if alarm.quiet and board.posts else alarm.at
    return max(latest, alarm.at) + timedelta(minutes=alarm.minutes)
