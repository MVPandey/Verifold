"""Whether the lab is done, by its own agents' word, and the alarms that agents set for themselves."""

from datetime import UTC, datetime, timedelta

from verifold.protocol.agents import GUEST
from verifold.protocol.events import AlarmSet, Posted
from verifold.protocol.ids import AgentId
from verifold.protocol.join import AlarmLine, LabState
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
    Return the alarm that waits for an agent, or `None`.

    It is the newest alarm that the agent set, unless that one cancels or has rung. A turn that starts for another
    reason does not spend it. No alarm waits for an agent that left.

    An alarm from before Verifold kept alarms across turns keeps the rule that its agent was told: it waits only
    after the turn where the agent set it, and it is spent when the agent's next turn starts.
    """
    alarm = next((alarm for alarm in reversed(board.alarms) if alarm.agent == agent_id), None)
    if alarm is None or alarm.minutes == 0 or board.gone(agent_id):
        return None
    starts = tuple(start for start in board.starts if start.agent == agent_id and start.seq > alarm.seq)
    if alarm.stays:
        return None if any(start.rang == alarm.seq for start in starts) else alarm
    # A harness that failed outside a turn ended no turn, so it spends no alarm.
    ends = tuple(turn.seq for turn in board.turns if turn.agent == agent_id and not turn.no_turn)
    before = ends[-2] if len(ends) > 1 else 0
    return alarm if ends and before < alarm.seq < ends[-1] and not starts else None


def alarm_line(board: Board, agent_id: AgentId) -> AlarmLine | None:
    """Return the alarm that waits for an agent as the agent reads it, or `None` when none waits."""
    alarm = pending_alarm(board, agent_id)
    if alarm is None:
        return None
    # No alarm rings while the lab is out of time or closed, so the alarm has no time then.
    resting = board.out_of_time or lab_state(board) == 'closed'
    return AlarmLine(minutes=alarm.minutes, quiet=alarm.quiet, rings_at=None if resting else rings_at(board, alarm))


def utc(at: datetime) -> str:
    """Return a time as agents read it, in UTC to the minute."""
    return f'{at.astimezone(UTC):%Y-%m-%d %H:%M} UTC'


def latest_time(board: Board) -> datetime:
    """Return the time of the board's newest post, or of the lab's opening. It stands in for a clock that nobody gave."""
    return board.posts[-1].at if board.posts else board.opened.at


def minutes_left(board: Board, now: datetime) -> float | None:
    """Return how many minutes the lab has left at `now`: zero when it is out of time, `None` without a time limit."""
    if board.out_of_time:
        return 0
    if board.ends_at is None:
        return None
    return max((board.ends_at - now).total_seconds() / 60, 0)


def no_alarm_line(board: Board, agent_id: AgentId, now: datetime | None = None) -> str:
    """
    Return the facts for an agent that Verifold started and that has no alarm: what starts its next turn, and the lab.

    The line says that no alarm is set, what then starts the agent's next turn, how much time the lab has left,
    and whether a close stands. It gives no advice. It is empty while an alarm waits, because the news shows that
    alarm, and for an agent that Verifold cannot wake: an invited agent, a blind checker, or an agent that left.
    Without `now`, time counts from the board's newest post.
    """
    joined = board.agent(agent_id)
    if joined is None or joined.agent.harness == GUEST or joined.agent.checks or board.gone(agent_id):
        return ''
    if pending_alarm(board, agent_id):
        return ''
    left = minutes_left(board, now or latest_time(board))
    if left is None:
        time = 'The lab has no time limit.'
    elif left == 0 or board.ends_at is None:
        time = 'The lab is out of time.'
    else:
        time = f'The lab ends at {utc(board.ends_at)}, {left:.0f} minutes from now.'
    close = closing(board)
    if close is None:
        stands = 'No close stands.'
    else:
        behind, among = close_count(board, close)
        stands = (
            f'A close stands: {close.post.id} by {close.post.author}. {behind} of {among} agents stand behind it, '
            f'so the lab is {lab_state(board)}.'
        )
    return (
        'No alarm is set for you. After your turn ends, your next turn starts only when a post for you arrives or '
        f'when an agent that you named or answered leaves. {time} {stands}'
    )


def rings_at(board: Board, alarm: AlarmSet) -> datetime:
    """Return when an alarm rings: after its minutes, counted from the newest post when the alarm waits for quiet."""
    latest = board.posts[-1].at if alarm.quiet and board.posts else alarm.at
    return max(latest, alarm.at) + timedelta(minutes=alarm.minutes)
