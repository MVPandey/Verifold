"""Whether the lab is done, by its own agents' word, and the alarms that agents set for themselves."""

from datetime import datetime, timedelta

from verifold.protocol.events import AlarmSet, Posted
from verifold.protocol.ids import AgentId
from verifold.protocol.join import LabState
from verifold.society.board import Board
from verifold.society.standing import agreed, closing


def lab_state(board: Board) -> LabState:
    """
    Return whether the lab is open, closing, or closed.

    It is closing while a close stands, and closed once more than half of the lab's agents stand behind it: its
    author and the agents that agreed. A new objection to the close opens the lab again.

    An invited agent counts among the lab's agents when it posted before the close. Until its first post nobody
    knows whether it came, so an invitation that nobody used does not keep the lab open. Its first post after the
    close does not change the count either, so a closed lab stays closed.

    An agent that left keeps the word that it gave. When it stood behind the close as it left, as the author or with
    its agreement, it still counts: among the lab's agents and behind the close. So agents that finish, agree, and
    leave do not open the lab again, and a close that every agent left behind is closed. An agent that left without
    that word counts on neither side, because nobody can get its word any more. So a lab whose remaining agents
    all stand behind a close is closed.
    """
    close = closing(board)
    if close is None:
        return 'open'
    behind, among = close_count(board, close)
    return 'closed' if behind * 2 > among else 'closing'


def close_count(board: Board, close: Posted) -> tuple[int, int]:
    """Return how many agents stand behind a close, and among how many agents of the lab they count."""
    behind = {close.post.author, *agreed(board, close)}
    among = sum(
        not joined.agent.checks
        and board.came(joined, before=close.seq)
        and (joined.agent.id in behind or not board.gone(joined.agent.id))
        for joined in board.agents
    )
    return len(behind), among


def pending_alarm(board: Board, agent_id: AgentId) -> AlarmSet | None:
    """
    Return the alarm that waits for an agent whose turn has ended, or `None`.

    It is the newest alarm that the agent set in its last turn, unless that one cancels. An alarm from an earlier
    turn is spent. No alarm waits for an agent that left.
    """
    if board.gone(agent_id):
        return None
    ends = tuple(turn.seq for turn in board.turns if turn.agent == agent_id)
    before = ends[-2] if len(ends) > 1 else 0
    alarm = next((alarm for alarm in reversed(board.alarms) if alarm.agent == agent_id), None)
    return alarm if alarm and ends and before < alarm.seq < ends[-1] and alarm.minutes > 0 else None


def rings_at(board: Board, alarm: AlarmSet) -> datetime:
    """Return when an alarm rings: after its minutes, counted from the newest post when the alarm waits for quiet."""
    latest = board.posts[-1].at if alarm.quiet and board.posts else alarm.at
    return max(latest, alarm.at) + timedelta(minutes=alarm.minutes)
