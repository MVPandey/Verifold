"""Whether the lab is done, by its own agents' word, and the alarms that agents set for themselves."""

from datetime import UTC, datetime, timedelta

from verifold.protocol.agents import GUEST
from verifold.protocol.events import AlarmSet, Posted
from verifold.protocol.ids import AgentId
from verifold.protocol.join import AlarmLine, LabState
from verifold.society.board import Board
from verifold.society.budget import LIMIT_NAMES
from verifold.society.standing import agreed, closing


def lab_state(board: Board) -> LabState:
    """
    Return whether the lab is open, closing, or closed.

    It is closing while a close stands, and closed once more than half of the lab's agents stand behind it: its
    author and the agents that agreed. A new objection to the close opens the lab again.

    An invited agent counts among the lab's agents when it posted before the close. Until its first post nobody
    knows whether it came, so an invitation that nobody used does not keep the lab open. Its first post after the
    close does not change the count either, so a closed lab stays closed. An on-call agent counts by the same
    rule: from its first post, because until then no post for every agent reached it.

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
        and board.counts(joined, before=close.seq)
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
    # No alarm rings while the lab is out of time, at a limit, or closed, so the alarm has no time then.
    resting = board.halted is not None or lab_state(board) == 'closed'
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


def minutes_text(minutes: float) -> str:
    """Return a span of minutes in words, in whole minutes: "less than a minute", "1 minute", or "14 minutes"."""
    whole = int(minutes)
    if whole == 0:
        return 'less than a minute'
    return '1 minute' if whole == 1 else f'{whole} minutes'


def no_alarm_line(board: Board, agent_id: AgentId, now: datetime | None = None) -> str:
    """
    Return the facts for an agent that Verifold started and that has no alarm, as the lab stands now.

    The line says that no alarm is set, what starts the agent's next turn in the lab's present state, how much time
    the lab has left, and whether a close stands. It names only what does start a turn in that state:

    - While the lab is out of time, Verifold stops the turn that reads this, and the next turn starts when the
      person gives the lab more time. At its budget or its disk limit, the next turn starts when the person raises
      that limit.
    - In a closed lab, a post for the agent starts it. The leaving of another agent does not.
    - In any other lab, a post for the agent starts it, and so does the leaving of an agent that it named or
      answered.

    The line speaks of a turn that the agent ends itself, because Verifold resumes once a turn that it or the
    harness cut short. It gives no advice. It is empty while an alarm waits, because the result shows that alarm,
    and for an agent that Verifold cannot wake: an invited agent, a blind checker, or an agent that left. For the
    desk, it says that a post of the person in the desk chat starts its next turn in every state of the lab, because
    a halt rests no desk. Without `now`, time counts from the board's newest post.
    """
    joined = board.agent(agent_id)
    if joined is None or joined.agent.harness == GUEST or joined.agent.checks or board.gone(agent_id):
        return ''
    if board.is_desk(agent_id):
        return (
            'The desk sets no alarm. After you end this turn, your next turn starts only when a post of the person '
            'in the desk chat arrives, also while the lab is out of time, at its budget or its disk limit, or closed.'
        )
    left = minutes_left(board, now or latest_time(board))
    if pending_alarm(board, agent_id):
        return ''
    state = lab_state(board)
    if left == 0:
        starts = (
            'The lab is out of time, so Verifold stops this turn. Your next turn starts when the person gives the '
            'lab more time.'
        )
    elif board.at_limit is not None:
        starts = (
            f'The lab reached its {LIMIT_NAMES[board.at_limit]}, so Verifold stops this turn. Your next turn starts '
            f'when the person sets a {LIMIT_NAMES[board.at_limit]} that the lab has not reached.'
        )
    else:
        also = '' if state == 'closed' else ' or when an agent that you named or answered leaves'
        starts = f'After you end this turn, your next turn starts only when a post for you arrives{also}.'
        if left is None or board.ends_at is None:
            starts += ' The lab has no time limit.'
        else:
            starts += f' The lab ends at {utc(board.ends_at)}, {minutes_text(left)} from now.'
    close = closing(board)
    if close is None:
        stands = 'No close stands.'
    else:
        behind, among = close_count(board, close)
        stands = (
            f'A close stands: {close.post.id} by {close.post.author}. {behind} of {among} agents stand behind it, '
            f'so the lab is {state}.'
        )
    return f'No alarm is set for you. {starts} {stands}'


def rings_at(board: Board, alarm: AlarmSet) -> datetime:
    """Return when an alarm rings: after its minutes, counted from the newest post when the alarm waits for quiet."""
    latest = board.posts[-1].at if alarm.quiet and board.posts else alarm.at
    return max(latest, alarm.at) + timedelta(minutes=alarm.minutes)
