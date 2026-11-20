"""
Tasks: one piece of work that an agent hands to the lab, the one agent that holds it, and the work that comes back.

A task is a post of the kind `task`: its objective in `text`, the output wanted, and its bounds. It can name the agents
that it invites, and an invitation is no order: the board gives a task to nobody and ranks none. Any agent of the lab
but the task's author claims a task while nobody holds it. A claim gives its agent a lease for the minutes of the
lab's settings, as `society.leases` says. A post of the holder that replies to the task, builds on it, or is in the
thread that the task opened starts the lease again while it stands, and so does the holder's claim again. The lease
ends at its time, at the holder's hand-back or ruled-out lead that replies to the task, at the author's withdrawal,
and when the holder leaves. While it stands, the record refuses a claim of the task from every other agent, and an
agent holds one claim at a time. A lease that ends at its time opens the task again, and Verifold records so.

The holder returns the work with a hand-back that replies to the task. The task's author accepts it with an answer
that accepts it, or another agent checks it as it checks a result. A ruled-out lead of the holder that replies to
the task gives the task up and says why. It is an obstacle of the line as every such lead is, and the task is open
again.

These rules hold for every event, so a record that loads follows them too. A record from before tasks holds none.
"""

from dataclasses import dataclass
from datetime import datetime

from verifold.protocol.events import ClaimLapsed, Posted, TaskClaimed
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import ClaimLine, LeaseLine, TaskState, TaskView
from verifold.protocol.posts import Answer, HandBack, RuledOut, Task
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.leases import Hold, Span, Step, span
from verifold.society.lifecycle import utc
from verifold.society.standing import standing


@dataclass(frozen=True, slots=True)
class Holder:
    """The agent that holds a task, or held it last, and the lease of its claim."""

    agent: AgentId
    lease: Span


@dataclass(frozen=True, slots=True)
class TaskFacts:
    """What the record says of a task at one moment: its state, the claim that stands, and the hand-back that counts."""

    state: TaskState
    holder: Holder | None = None
    """The claim that stands, for a task that is `claimed`."""
    hand_back: Posted | None = None
    """The newest hand-back that its author did not concede, for a task that is `handed_back` or `done`."""
    withdrawal: Posted | None = None
    """The author's ruled-out lead that withdrew the task, for a task that is `withdrawn`."""


@dataclass(frozen=True, slots=True)
class Lapse:
    """A claim whose lease ended at its time, which the record has not marked yet."""

    agent: AgentId
    task: PostId
    until: datetime


def tasks(board: Board) -> tuple[Posted, ...]:
    """Return every task of the lab, oldest first."""
    return tuple(entry for entry in board.posts if isinstance(entry.post, Task))


def _withdrawal(board: Board, task: Posted) -> Posted | None:
    # The author's ruled-out lead that replies to its own task withdraws it.
    return next(
        (
            reply
            for reply in board.replies(task.post.id)
            if isinstance(reply.post, RuledOut) and reply.post.author == task.post.author
        ),
        None,
    )


def _hand_back(board: Board, task: Posted) -> Posted | None:
    # The newest hand-back of the task that its author did not concede. A conceded one counts for nothing.
    backs = (
        reply
        for reply in reversed(board.replies(task.post.id))
        if isinstance(reply.post, HandBack) and standing(board, reply.post.id) != 'conceded'
    )
    return next(backs, None)


def accepted(board: Board, task: Posted, back: Posted) -> bool:
    """Return whether the task's author accepted a hand-back of it, with an answer that replies to it and accepts it."""
    return any(
        isinstance(reply.post, Answer) and reply.post.accepts and reply.post.author == task.post.author
        for reply in board.replies(back.post.id)
    )


def claimers(board: Board, task_id: PostId) -> tuple[AgentId, ...]:
    """Return the agents that claimed a task, each once, in the order of their first claims."""
    return tuple(dict.fromkeys(claim.agent for claim in board.claims if claim.task == task_id))


def _steps(board: Board, task: Posted, agent: AgentId) -> tuple[Step, ...]:
    # The steps of an agent on a task, in the order of the record: its claims start a lease, its activity on the task
    # keeps it, and its hand-back, its ruled-out lead that replies to the task, and the author's withdrawal end it.
    task_id, thread = task.post.id, task.post.thread
    posts = board.thread_posts(thread)
    opened = bool(posts) and posts[0].post.id == task_id
    around = (*board.replies(task_id), *board.built_on(task_id), *(posts if opened else ()))
    mine = {entry.seq: entry for entry in around if entry.post.author == agent and entry.seq > task.seq}
    withdrawn = _withdrawal(board, task)
    ends = {withdrawn.seq: withdrawn} if withdrawn else {}

    def hold(entry: Posted) -> Hold:
        returned = isinstance(entry.post, HandBack | RuledOut) and entry.post.reply_to == task_id
        return 'end' if returned or entry.seq in ends else 'keep'

    claimed: tuple[Step, ...] = tuple(
        (claim.seq, claim.at, 'start') for claim in board.claims if (claim.task, claim.agent) == (task_id, agent)
    )
    posted: tuple[Step, ...] = tuple((entry.seq, entry.at, hold(entry)) for entry in {**mine, **ends}.values())
    return tuple(sorted((*claimed, *posted)))


def _holder(board: Board, task: Posted, now: datetime) -> Holder | None:
    # The agent that claimed the task last by `now`, with the lease of its claim that no step ended, standing or
    # ended at its time. The record refuses a claim while another agent's lease stands, so no other agent can hold
    # the task. The lease of an agent that left ended when it left.
    last = next(
        (claim for claim in reversed(board.claims) if claim.task == task.post.id and claim.at <= now),
        None,
    )
    if last is None or board.gone(last.agent):
        return None
    lease = span(_steps(board, task, last.agent), now, lambda seq: board.settings_at(seq).tasks.lease_minutes)
    return Holder(agent=last.agent, lease=lease) if lease else None


def task_facts(board: Board, task: Posted, now: datetime) -> TaskFacts:
    """Return where a task stands at `now`, as `TaskState` says, with the claim that stands or the hand-back that counts."""
    withdrawn = _withdrawal(board, task)
    if withdrawn:
        return TaskFacts(state='withdrawn', withdrawal=withdrawn)
    back = _hand_back(board, task)
    if back:
        done = accepted(board, task, back) or standing(board, back.post.id) in {'checked', 'held_up'}
        return TaskFacts(state='done' if done else 'handed_back', hand_back=back)
    holder = _holder(board, task, now)
    if holder and holder.lease.stands(now):
        return TaskFacts(state='claimed', holder=holder)
    return TaskFacts(state='open')


def open_tasks(board: Board, now: datetime) -> tuple[Posted, ...]:
    """Return the tasks that nobody holds at `now`, oldest first: each is `open`, so any agent but its author claims it."""
    return tuple(entry for entry in tasks(board) if task_facts(board, entry, now).state == 'open')


def held_by(board: Board, agent_id: AgentId, now: datetime) -> tuple[Posted, Holder] | None:
    """Return the task that an agent holds at `now`, with its claim, or `None`. An agent holds one task at a time."""
    for task_id in dict.fromkeys(claim.task for claim in board.claims if claim.agent == agent_id):
        task = board.post(task_id)
        facts = task_facts(board, task, now) if task else None
        if task and facts and facts.holder and facts.holder.agent == agent_id:
            return task, facts.holder
    return None


def lease_line(holder: Holder) -> LeaseLine:
    """Return a claim that stands as a line of its lease."""
    return LeaseLine(agent=holder.agent, since=holder.lease.since, until=holder.lease.until)


def task_view(board: Board, entry: Posted, now: datetime) -> TaskView | None:
    """Return a task's state and who holds it at `now`, or `None` for a post that is no task."""
    if not isinstance(entry.post, Task):
        return None
    facts = task_facts(board, entry, now)
    return TaskView(
        state=facts.state,
        held_by=lease_line(facts.holder) if facts.holder else None,
        hand_back=facts.hand_back.post.id if facts.hand_back else None,
    )


def claim_line(board: Board, agent_id: AgentId, now: datetime) -> ClaimLine | None:
    """Return the task that an agent holds at `now` as one line, with the minutes that its lease has left, or `None`."""
    held = held_by(board, agent_id, now)
    if held is None:
        return None
    task, holder = held
    left = max(int((holder.lease.until - now).total_seconds() // 60), 0)
    return ClaimLine(task=task.post.id, thread=task.post.thread, until=holder.lease.until, minutes_left=left)


def dropped(board: Board, task: Posted) -> tuple[PostId, ...]:
    """Return the ruled-out leads that agents that claimed a task posted in reply to it, oldest first."""
    held = set(claimers(board, task.post.id))
    return tuple(
        reply.post.id
        for reply in board.replies(task.post.id)
        if isinstance(reply.post, RuledOut) and reply.post.author in held
    )


def lapsed(board: Board, task_id: PostId) -> int:
    """Return how many claims of a task the record marks as lapsed: their leases ended at their time."""
    return sum(lapse.task == task_id for lapse in board.lapses)


def lapses_due(board: Board, at: datetime) -> tuple[Lapse, ...]:
    """
    Return the claims whose leases ended by `at` and that the record has not marked as lapsed, in the order of the tasks.

    A claim that a hand-back, a ruled-out lead of its holder, a withdrawal, or the holder's leave ended did not lapse.
    """
    due: list[Lapse] = []
    for task_id in dict.fromkeys(claim.task for claim in board.claims):
        task = board.post(task_id)
        holder = _holder(board, task, at) if task else None
        if task is None or holder is None or holder.lease.stands(at):
            continue
        marked = any(
            (lapse.task, lapse.agent) == (task_id, holder.agent) and lapse.seq > holder.lease.started
            for lapse in board.lapses
        )
        if not marked:
            due.append(Lapse(agent=holder.agent, task=task_id, until=holder.lease.until))
    return tuple(due)


def next_lapse(board: Board, now: datetime) -> datetime | None:
    """Return when the first lease of a claim that stands at `now` ends by time, or `None` when no claim stands."""
    ends = (
        facts.holder.lease.until for task in tasks(board) if (facts := task_facts(board, task, now)).holder is not None
    )
    return min(ends, default=None)


def check_claim(board: Board, event: TaskClaimed) -> None:
    """
    Check that an agent can claim a task at the time of the event, or renew the claim that it holds.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, is a blind checker, or is the desk. The post is no task,
            or the agent wrote it. The task is withdrawn, handed back, or done. Another agent's lease on it stands,
            or the agent holds another task.

    """
    joined = board.agent(event.agent)
    if joined is None or joined.agent.checks:
        raise RejectedEvent(f'{event.agent} is not an agent with a seat in this lab.')
    if board.gone(event.agent):
        raise RejectedEvent(f'{event.agent} left this lab, so the board takes no claim from it.')
    if board.is_desk(event.agent):
        raise RejectedEvent("The desk is no part of the lab's work, so it claims no task.")
    task = board.post(event.task)
    if task is None:
        raise RejectedEvent(f'Post {event.task} does not exist.')
    if not isinstance(task.post, Task):
        raise RejectedEvent(f'Post {event.task} is a {task.post.kind}, and `claim` takes a task.')
    if task.post.author == event.agent:
        raise RejectedEvent(f'Task {event.task} is your own. Another agent claims it.')
    facts = task_facts(board, task, event.at)
    refusal = _closed(event.task, facts, 'claim') or _held_by_another(event, facts)
    if refusal:
        raise RejectedEvent(refusal)
    held = held_by(board, event.agent, event.at)
    if held and held[0].post.id != event.task:
        other, holder = held
        raise RejectedEvent(
            f'You hold task {other.post.id} since {utc(holder.lease.since)}, until {utc(holder.lease.until)}. An '
            f'agent holds one task at a time, and your `hand_back` or `ruled_out` that replies to {other.post.id} '
            'ends that claim.'
        )


def _closed(task_id: PostId, facts: TaskFacts, what: str) -> str | None:
    # Why a task takes no claim or no hand-back, `what`, at all, or `None` while it is open or claimed.
    if facts.withdrawal:
        withdrawal = facts.withdrawal.post
        return f'{withdrawal.author} withdrew task {task_id} with {withdrawal.id}, so it takes no {what}.'
    if facts.hand_back:
        back = facts.hand_back.post
        word = 'and it is done' if facts.state == 'done' else 'and the hand-back waits'
        return f'{back.author} handed task {task_id} back with {back.id}, {word}, so the task takes no {what}.'
    return None


def _held_by_another(event: TaskClaimed, facts: TaskFacts) -> str | None:
    # Why another agent's lease keeps the agent from the task, or `None`.
    holder = facts.holder
    if holder is None or holder.agent == event.agent:
        return None
    return (
        f'{holder.agent} holds task {event.task} since {utc(holder.lease.since)}, until {utc(holder.lease.until)}. '
        'The board takes no claim of it from you while that lease stands.'
    )


def check_lapse(board: Board, event: ClaimLapsed) -> None:
    """
    Check that a claim lapsed: its lease ended at `until` by the time of the event, and the record has not said so.

    Raises:
        RejectedEvent: No such claim has a lease that ended then, or the record marks it as lapsed already.

    """
    due = (lapse for lapse in lapses_due(board, event.at) if (lapse.agent, lapse.task) == (event.agent, event.task))
    if all(lapse.until != event.until for lapse in due):
        raise RejectedEvent(
            f'No claim of {event.agent} on task {event.task} has a lease that ended at {utc(event.until)} without '
            'a mark of its lapse.'
        )


def check_task_post(board: Board, event: Posted) -> None:
    """
    Check a task and a hand-back against the rules of tasks, at the time of the event.

    Raises:
        RejectedEvent: The person posts a task, or a hand-back replies to no task, comes from another agent than the
            one that claimed the task last, or comes for a task that is withdrawn, handed back, or done.

    """
    post = event.post
    if isinstance(post, Task) and post.author == PERSON:
        raise RejectedEvent(
            'A task hands work from one agent to another. A post of yours with no `mentions` and no `reply_to` '
            'reaches every agent.'
        )
    if not isinstance(post, HandBack):
        return
    # The record's rules refuse a reply to a post that does not exist before this check.
    task = board.post(post.reply_to)
    if task is None or not isinstance(task.post, Task):
        raise RejectedEvent(f'Post {post.reply_to} is no task, and a `hand_back` replies to a task.')
    last = next((claim for claim in reversed(board.claims) if claim.task == task.post.id), None)
    if last is None or last.agent != post.author:
        who = f'{last.agent} claimed it last' if last else 'nobody claimed it'
        raise RejectedEvent(
            f'For task {task.post.id}, {who}. The board takes a hand-back from the agent that claimed the task last.'
        )
    refusal = _closed(task.post.id, task_facts(board, task, event.at), 'hand-back')
    if refusal:
        raise RejectedEvent(refusal)
