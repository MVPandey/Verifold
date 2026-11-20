"""
When an alarm that an agent set for itself rings: at its time, or when the record meets one of its conditions.

An agent asks for each alarm and for each of its conditions. The board sets no alarm by itself and adds no
condition. Each condition is a fact of the record with the agent's own threshold, and `DUE` holds one function for
each kind: it returns when the record met the condition, or when it meets it at a time that the record sets already,
such as the hour at which the reading is old enough. It returns `None` while no event has met the condition and no
time is set, such as a budget that the lab has not spent so far. A new kind of condition is a new value of
`ConditionKind`, its bounds, its words, and one function here.
"""

from collections.abc import Callable, Iterator
from datetime import datetime, timedelta

from verifold.protocol.events import AlarmCondition, AlarmSet, ConditionKind
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.join import AlarmLine
from verifold.protocol.posts import HandBack, Reading, RuledOut
from verifold.society.allowances import actions, draft, in_force
from verifold.society.board import Board
from verifold.society.coordinator import waiting_posts
from verifold.society.ideas import without_idea
from verifold.society.lifecycle import lab_state, latest_time, pending_alarm
from verifold.society.pace import limits_of
from verifold.society.tasks import open_tasks

type Due = Callable[[Board, float, datetime], datetime | None]
"""When the record meets one kind of condition with a threshold, as the module says."""


def _reading(board: Board, hours: float, _: datetime) -> datetime | None:
    # The newest reading, or the lab's opening while it has none, is `hours` old.
    newest = next((entry.at for entry in reversed(board.posts) if isinstance(entry.post, Reading)), board.opened.at)
    return newest + timedelta(hours=hours)


def _budget(board: Board, percent: float, _: datetime) -> datetime | None:
    # The first end of a turn at which what the lab spent reached the percent of a budget that stands now.
    budget = board.budget
    if budget is None:
        return None
    tokens = budget.tokens * percent / 100 if budget.tokens else None
    dollars = budget.dollars * percent / 100 if budget.dollars else None
    spent_tokens, spent_dollars = 0, 0.0
    for turn in board.turns:
        spent_tokens += turn.usage.input_tokens + turn.usage.output_tokens
        spent_dollars += max(turn.cost_usd or 0.0, 0.0)
        if (tokens is not None and spent_tokens >= tokens) or (dollars is not None and spent_dollars >= dollars):
            return turn.at
    return None


def _limit(board: Board, percent: float, now: datetime) -> datetime | None:
    # The report of a seat's limits that stands now and has a window at the percent, or a provider that refuses it.
    reports = (
        next((entry for entry in reversed(board.seat_limits) if entry.agent == joined.agent.id), None)
        for joined in board.agents
        if not board.gone(joined.agent.id)
    )
    met = (
        report.at
        for report in reports
        if report
        and (limits := limits_of(board, report.agent, now))
        and (limits.status == 'reached' or any(window.used_percent >= percent for window in limits.windows))
    )
    return min(met, default=None)


def _request(board: Board, minutes: float, now: datetime) -> datetime | None:
    # The oldest post that waits for the person's answer has waited `minutes`.
    waiting = waiting_posts(board, now)
    return waiting[0].at + timedelta(minutes=minutes) if waiting else None


def _task(board: Board, minutes: float, now: datetime) -> datetime | None:
    # The open task that has had no owner longest has had none for `minutes`.
    since = min((_unowned_since(board, task.post.id, task.at) for task in open_tasks(board, now)), default=None)
    return since + timedelta(minutes=minutes) if since else None


def _action(board: Board, hours: float, now: datetime) -> datetime | None:
    # An allowance in force whose seat declared no action for `hours`, since its last action or since its start.
    quiet = (
        max((started.at, *(entry.at for entry in actions(board, started.allowance))))
        for started in board.allowance_starts
        if (held := draft(board, started.allowance)) and in_force(board, held.terms.holder, now) == held
    )
    since = min(quiet, default=None)
    return since + timedelta(hours=hours) if since else None


def _branch(board: Board, hours: float, _: datetime) -> datetime | None:
    # The branch in force without an idea that came first has had none for `hours`, since the reading that added it.
    since = min((held.added.at for held in without_idea(board)), default=None)
    return since + timedelta(hours=hours) if since else None


def _unowned_since(board: Board, task_id: PostId, posted: datetime) -> datetime:
    # When the task last had an owner: the end of the last claim's lease by its time, the holder's hand-back or
    # ruled-out lead that gave the task up, or the holder's leave. A task that nobody claimed has had none since it
    # was posted.
    author = board.post(task_id)
    ends = (
        *(lapse.until for lapse in board.lapses if lapse.task == task_id),
        *(
            reply.at
            for reply in board.replies(task_id)
            if isinstance(reply.post, HandBack | RuledOut) and author and reply.post.author != author.post.author
        ),
        *(left.at for claim in board.claims if claim.task == task_id if (left := board.gone(claim.agent))),
    )
    return max((posted, *ends))


DUE: dict[ConditionKind, Due] = {
    'reading_hours': _reading,
    'budget_percent': _budget,
    'limit_percent': _limit,
    'request_minutes': _request,
    'task_minutes': _task,
    'action_hours': _action,
    'branch_hours': _branch,
}
"""When the record meets each kind of condition."""

WORDS: dict[ConditionKind, str] = {
    'reading_hours': "the lab's reading is {threshold:g} hours old, or the lab has had no reading for that long",
    'budget_percent': 'the lab spent {threshold:g} percent of its budget',
    'limit_percent': "a seat is at {threshold:g} percent of a window of its provider's usage limits",
    'request_minutes': "a post has waited {threshold:g} minutes for the person's answer",
    'task_minutes': 'an open task has had no owner for {threshold:g} minutes',
    'action_hours': 'an allowance in force has had no action for {threshold:g} hours',
    'branch_hours': 'a branch of the question has had no idea for {threshold:g} hours',
}
"""What the record met, for each kind of condition, as the message of the alarm says it."""


def due(board: Board, condition: AlarmCondition, now: datetime) -> datetime | None:
    """Return when the record meets a condition, as `DUE` says, or `None` while no event met it and no time is set."""
    return DUE[condition.kind](board, condition.threshold, now)


def _parts(board: Board, alarm: AlarmSet, now: datetime) -> Iterator[tuple[datetime, AlarmCondition | None]]:
    # The time of the alarm and the time of each condition that the record sets, each no earlier than the alarm.
    if alarm.minutes:
        latest = board.posts[-1].at if alarm.quiet and board.posts else alarm.at
        yield max(latest, alarm.at) + timedelta(minutes=alarm.minutes), None
    for condition in alarm.conditions:
        if (when := due(board, condition, now)) is not None:
            yield max(when, alarm.at), condition


def rings_at(board: Board, alarm: AlarmSet, now: datetime | None = None) -> datetime | None:
    """
    Return when an alarm rings: at its time, or when the record meets one of its conditions, whichever comes first.

    Its time is its minutes after it was set, counted from the newest post when it waits for quiet. No part rings
    before the alarm was set. `None` for an alarm on conditions alone while the record meets none and sets no time for one. Without `now`,
    time counts from the board's newest post.
    """
    return min((when for when, _ in _parts(board, alarm, now or latest_time(board))), default=None)


def rang_by(board: Board, alarm: AlarmSet, now: datetime) -> AlarmCondition | None:
    """Return the condition that rings an alarm that is due at `now`, or `None` when its time rings it."""
    due_now = sorted(
        ((when, condition) for when, condition in _parts(board, alarm, now) if when <= now),
        key=lambda part: (part[0], part[1] is not None),
    )
    return due_now[0][1] if due_now else None


def condition_words(condition: AlarmCondition) -> str:
    """Return what the record met for a condition, as one clause of a sentence."""
    return WORDS[condition.kind].format(threshold=condition.threshold)


def alarm_line(board: Board, agent_id: AgentId, now: datetime | None = None) -> AlarmLine | None:
    """Return the alarm that waits for an agent as the agent reads it, or `None` when none waits."""
    alarm = pending_alarm(board, agent_id)
    if alarm is None:
        return None
    # No alarm rings while the lab is out of time, at a limit, or closed, so the alarm has no time then.
    resting = board.halted is not None or lab_state(board) == 'closed'
    return AlarmLine(
        minutes=alarm.minutes,
        quiet=alarm.quiet,
        conditions=alarm.conditions,
        rings_at=None if resting else rings_at(board, alarm, now),
    )
