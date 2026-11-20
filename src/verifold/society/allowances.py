"""
Allowances and actions: the rules of the record, and where each allowance and action stands.

An allowance comes from the person only. The person drafts one, or the desk drafts one on the person's word with
`on`, and the allowance is in force only after the person's own confirmation, which no agent tool records. It names
one acting seat, and the coordinator and the desk are never acting seats. A seat holds the allowance that the person
started for it last, until its end time, or until the person ends it.

An acting seat declares each action with a post of the kind `action` before it does it. The board answers in the
same step, and Verifold records the answer with the post: inside the allowance in force, the action is allowed and
its cost is drawn from it. Otherwise the action waits for the person until its offer ends, and a yes of the person
draws nothing from any allowance. Above the allowance's `check_above`, the record takes an action only when a check
that holds, from another agent than the action's author, replies to a post that the action rests on. While the
person paused actions, the record takes none. The action's newest receipt gives its real cost, and the allowance
counts that cost in place of the declared one. When what an allowance allowed costs more than its total, the seat
stops until the person ends that allowance or starts another one for it.

These rules hold for every event, so a record that loads follows them too. A record from before allowances holds
none of these events or posts.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from verifold.protocol.agents import GUEST
from verifold.protocol.allowances import ActionNeed, ActionState, AllowanceId
from verifold.protocol.events import (
    ActingSet,
    ActionDecided,
    ActionsPaused,
    AllowanceDrafted,
    AllowanceEnded,
    AllowanceStarted,
    ModeSet,
    Posted,
)
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import AllowanceLine
from verifold.protocol.posts import Action, Ask, Check, Receipt
from verifold.society.board import Board
from verifold.society.desk import check_on
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import utc
from verifold.society.standing import disputes, standing


@dataclass(frozen=True, slots=True)
class Verdict:
    """The board's answer to an action at the moment that its author declares it."""

    allowance: AllowanceId | None
    allowed: bool
    needs: ActionNeed | None


def draft(board: Board, allowance_id: AllowanceId) -> AllowanceDrafted | None:
    """Return the draft of an allowance, or `None`."""
    return next((entry for entry in board.drafts if entry.allowance == allowance_id), None)


def started(board: Board, allowance_id: AllowanceId) -> AllowanceStarted | None:
    """Return the person's confirmation of an allowance, or `None` while it is a draft."""
    return next((entry for entry in board.allowance_starts if entry.allowance == allowance_id), None)


def ended(board: Board, allowance_id: AllowanceId) -> AllowanceEnded | None:
    """Return the person's end of an allowance, or `None`."""
    return next((entry for entry in board.allowance_ends if entry.allowance == allowance_id), None)


def newest(board: Board, agent_id: AgentId) -> AllowanceDrafted | None:
    """Return the allowance that the person started last for a seat, in force or not, or `None`."""
    drafts = (draft(board, entry.allowance) for entry in reversed(board.allowance_starts))
    return next((entry for entry in drafts if entry and entry.terms.holder == agent_id), None)


def in_force(board: Board, agent_id: AgentId, at: datetime) -> AllowanceDrafted | None:
    """Return the allowance that a seat holds at `at`: the newest one, while it has not ended. `None` otherwise."""
    held = newest(board, agent_id)
    return held if held and not ended(board, held.allowance) and at < held.terms.ends_at else None


def actions(board: Board, allowance_id: AllowanceId) -> tuple[Posted, ...]:
    """Return the actions that were declared under an allowance, oldest first, allowed or not."""
    return tuple(
        entry for entry in board.posts if isinstance(entry.post, Action) and entry.post.allowance == allowance_id
    )


def receipt(board: Board, action: Posted) -> Posted | None:
    """Return the newest receipt of an action from its author, or `None`."""
    return next(
        (
            entry
            for entry in reversed(board.replies(action.post.id))
            if isinstance(entry.post, Receipt) and entry.post.author == action.post.author
        ),
        None,
    )


def cost_of(board: Board, action: Posted) -> Decimal:
    """Return what an action costs as the record has it: its newest receipt's cost, or else its declared cost."""
    got = receipt(board, action)
    if got and isinstance(got.post, Receipt):
        return got.post.cost
    return action.post.cost if isinstance(action.post, Action) else Decimal(0)


def drawn(board: Board, allowance_id: AllowanceId) -> Decimal:
    """Return what an allowance has allowed so far: the cost of each action that it allowed, by its newest receipt."""
    return sum(
        (cost_of(board, entry) for entry in actions(board, allowance_id) if _allowed(entry)),
        Decimal(0),
    )


def _allowed(entry: Posted) -> bool:
    return isinstance(entry.post, Action) and entry.post.allowed


def stopped(board: Board, agent_id: AgentId) -> AllowanceDrafted | None:
    """
    Return the allowance whose actions passed its total and that stops a seat now, or `None`.

    It stops the seat while it is the newest allowance that the person started for the seat and the person has not
    ended it, also after its end time: only the person lets the seat go on.
    """
    held = newest(board, agent_id)
    if held is None or ended(board, held.allowance):
        return None
    return held if drawn(board, held.allowance) > held.terms.total else None


def allowance_line(board: Board, agent_id: AgentId, at: datetime) -> AllowanceLine | None:
    """Return the newest allowance that the person started for a seat as one line, or `None` when it has none."""
    held = newest(board, agent_id)
    if held is None:
        return None
    terms, used = held.terms, drawn(board, held.allowance)
    return AllowanceLine(
        allowance=held.allowance,
        purpose=terms.purpose,
        unit=terms.unit,
        per_action=terms.per_action,
        total=terms.total,
        drawn=used,
        left=max(terms.total - used, Decimal(0)),
        ends_at=terms.ends_at,
        check_above=terms.check_above,
        in_force=in_force(board, agent_id, at) is not None,
        stopped=stopped(board, agent_id) is not None,
    )


def verdict(board: Board, agent_id: AgentId, cost: Decimal, at: datetime) -> Verdict:
    """Return the board's answer to an action of a seat that costs `cost`, declared at `at`."""
    held = in_force(board, agent_id, at)
    if held is None:
        return Verdict(allowance=None, allowed=False, needs='none')
    terms = held.terms
    if cost > terms.per_action:
        return Verdict(allowance=held.allowance, allowed=False, needs='per_action')
    if drawn(board, held.allowance) + cost > terms.total:
        return Verdict(allowance=held.allowance, allowed=False, needs='total')
    return Verdict(allowance=held.allowance, allowed=True, needs=None)


def checked(board: Board, post_id: PostId, author: AgentId) -> bool:
    """
    Return whether a check of a post stands for an action of `author`.

    It does when a check that holds replies to the post, its author is not `author`, nothing disputes the check, its
    author conceded nothing, and nothing disputes the post.
    """
    if disputes(board, post_id):
        return False
    return any(
        isinstance(entry.post, Check)
        and entry.post.outcome == 'holds'
        and entry.post.author != author
        and standing(board, entry.post.id) not in {'disputed', 'conceded'}
        for entry in board.replies(post_id)
    )


def decision(board: Board, action_id: PostId) -> ActionDecided | None:
    """Return the person's answer to an action, or `None` while it has none."""
    return next((entry for entry in board.action_decisions if entry.action == action_id), None)


def action_state(board: Board, entry: Posted, at: datetime) -> ActionState:
    """Return where an action stands at `at`, as `ActionState` says. An action whose author left waits for nobody."""
    post = entry.post
    if not isinstance(post, Action) or post.allowed:
        return 'allowed'
    answered = decision(board, post.id)
    if answered:
        return 'yes' if answered.yes else 'no'
    return 'missed' if at >= post.offer_ends or board.gone(post.author) else 'waits'


def check_acting(board: Board, event: ActingSet) -> None:
    """
    Check that the person can make a seat an acting seat, or take the mark back.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, is a blind checker, or, for the mark, is an invited
            agent, the desk, or the coordinator.

    """
    joined = board.agent(event.agent)
    if joined is None or joined.agent.checks:
        raise RejectedEvent(f'{event.agent} is not an agent with a seat in this lab.')
    if board.gone(event.agent):
        raise RejectedEvent(f'{event.agent} left this lab, so its seat does not change.')
    if not event.acting:
        return
    if joined.agent.harness == GUEST:
        raise RejectedEvent(
            f'{event.agent} joined with an invitation and runs by itself, so Verifold cannot stop its turns at the '
            'limit of an allowance. An acting seat is a seat that Verifold starts.'
        )
    if board.is_desk(event.agent) or board.coordinator == event.agent:
        raise RejectedEvent('An acting seat is not the coordinator and not the desk.')


def check_mode(board: Board, event: ModeSet) -> None:
    """
    Check that the person can change the harness mode of a seat in the lab that runs.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, or runs by itself.

    """
    joined = board.agent(event.agent)
    if joined is None or joined.agent.checks or board.gone(event.agent):
        raise RejectedEvent(f'{event.agent} is not an agent with a seat in this lab.')
    if joined.agent.harness == GUEST:
        raise RejectedEvent(f'{event.agent} joined with an invitation, and its own harness sets its mode.')


def check_draft(board: Board, event: AllowanceDrafted) -> None:
    """
    Check a draft of an allowance: from the person, or from the desk on the person's word, for an acting seat.

    Raises:
        RejectedEvent: The ID is not the next one, the desk drafts without `on` or breaks `check_on`, another agent
            drafts, the holder is not an acting seat of the lab, or the allowance ends before the draft.

    """
    expected = f'a-{len(board.drafts) + 1}'
    if event.allowance != expected:
        raise RejectedEvent(f'The next allowance of this lab is {expected}.')
    if event.by == PERSON:
        if event.on is not None:
            raise RejectedEvent("Only a draft of the desk names in `on` the person's post that it rests on.")
    else:
        check_on(board, event.by, event.on, event.at)
    holder = event.terms.holder
    if board.agent(holder) is None or board.gone(holder) or not board.acting(holder):
        raise RejectedEvent(
            f'{holder} is not an acting seat of this lab. Only an acting seat holds an allowance, and the person '
            'makes a seat one.'
        )
    if event.terms.ends_at <= event.at:
        raise RejectedEvent(f'The allowance ends at {utc(event.terms.ends_at)}, which is before the draft.')


def check_start(board: Board, event: AllowanceStarted) -> None:
    """
    Check that the person can confirm a draft: the newest one for its seat, while it has not ended.

    Raises:
        RejectedEvent: No such draft exists, it started already, a newer draft for the same seat replaces it, its
            end time came, or its holder is no acting seat now.

    """
    drafted = draft(board, event.allowance)
    if drafted is None:
        raise RejectedEvent(f'The lab has no allowance {event.allowance}.')
    if started(board, event.allowance):
        raise RejectedEvent(f'The allowance {event.allowance} started already.')
    holder = drafted.terms.holder
    newer = next((entry for entry in reversed(board.drafts) if entry.terms.holder == holder), drafted)
    if newer.allowance != event.allowance:
        raise RejectedEvent(f'The draft {newer.allowance} for {holder} replaces {event.allowance}.')
    if drafted.terms.ends_at <= event.at:
        raise RejectedEvent(f'The allowance {event.allowance} ended at {utc(drafted.terms.ends_at)}.')
    if board.gone(holder) or not board.acting(holder):
        raise RejectedEvent(f'{holder} is no acting seat of this lab now, so it holds no allowance.')


def check_end(board: Board, event: AllowanceEnded) -> None:
    """
    Check that the person can end an allowance: one that started and that the person has not ended.

    Raises:
        RejectedEvent: The allowance did not start, or the person ended it already.

    """
    if not started(board, event.allowance):
        raise RejectedEvent(f'The allowance {event.allowance} did not start, so it has nothing to end.')
    if ended(board, event.allowance):
        raise RejectedEvent(f'You ended the allowance {event.allowance} already.')


def check_pause(board: Board, event: ActionsPaused) -> None:
    """
    Check that a pause of every action changes something.

    Raises:
        RejectedEvent: Actions are paused already, or they are not paused.

    """
    if event.paused == (board.actions_paused is not None):
        raise RejectedEvent('Actions are paused already.' if event.paused else 'Actions are not paused.')


def check_decided(board: Board, event: ActionDecided) -> None:
    """
    Check the person's answer to an action: it comes with the person's reply, before the action's offer ends.

    Raises:
        RejectedEvent: The post is no action that waits for the person, it has an answer, its author left, its offer
            ended, or the reply just before is not the person's post that replies to it.

    """
    entry = board.post(event.action)
    if entry is None or not isinstance(entry.post, Action) or entry.post.allowed:
        raise RejectedEvent(f'Post {event.action} is no action that waits for your answer.')
    action = entry.post
    if decision(board, action.id):
        raise RejectedEvent(f'You answered the action {action.id} already.')
    if board.gone(action.author):
        raise RejectedEvent(f'{action.author} left the lab, so nothing waits for this answer.')
    if event.at >= action.offer_ends:
        raise RejectedEvent(
            f'The offer of the action {action.id} ended at {utc(action.offer_ends)}. Nothing was done, and an answer '
            'decides nothing now.'
        )
    told = board.posts[-1] if board.posts else None
    if (
        told is None
        or told.seq != board.seq
        or told.post.id != event.post
        or told.post.author != PERSON
        or told.post.reply_to != action.id
    ):
        raise RejectedEvent(f'Post {event.post} is not the post of the person that answers the action {action.id}.')


def check_action_post(board: Board, event: Posted) -> None:
    """
    Check an action, a receipt, and an ask's end time against these rules, at the time of the event.

    Raises:
        RejectedEvent: The author of an action is not an acting seat, actions are paused, the offer ended, the
            board's answer is not the one that these rules give, or the action needs a check first. A receipt
            replies to no action of its author that may be done. An ask ends before it is posted.

    """
    post = event.post
    if isinstance(post, Ask) and post.ends_at is not None and post.ends_at <= event.at:
        raise RejectedEvent(f'The ask ends at {utc(post.ends_at)}, which is before it is posted.')
    if isinstance(post, Receipt):
        _check_receipt(board, post)
    if not isinstance(post, Action):
        return
    if not board.acting(post.author):
        raise RejectedEvent(
            f'{post.author} is not an acting seat. The board takes an action only from a seat that the person made '
            'an acting seat.'
        )
    if paused := board.actions_paused:
        raise RejectedEvent(
            f'The person paused every action at {utc(paused.at)}, so the board takes no action now. The person can '
            'let actions go on.'
        )
    if post.offer_ends <= event.at:
        raise RejectedEvent(f'The offer ends at {utc(post.offer_ends)}, which is before the action is declared.')
    answer = verdict(board, post.author, post.cost, event.at)
    if (post.allowance, post.allowed, post.needs) != (answer.allowance, answer.allowed, answer.needs):
        raise RejectedEvent("An action carries the board's own answer to it, which only Verifold sets.")
    held = draft(board, answer.allowance) if answer.allowed and answer.allowance else None
    line = held.terms.check_above if held else None
    if (
        held
        and line is not None
        and post.cost > line
        and not any(checked(board, p, post.author) for p in post.builds_on)
    ):
        raise RejectedEvent(
            f'Above {line} {held.terms.unit}, the allowance {held.allowance} takes an action only after a check: a '
            f'`check` that holds, from another agent than you, of a post that the action rests on. None of '
            f'{", ".join(post.builds_on)} has one that stands.'
        )


def _check_receipt(board: Board, post: Receipt) -> None:
    # The record's rules refuse a reply to a post that does not exist before this check.
    action = board.post(post.reply_to)
    if action is None or not isinstance(action.post, Action) or action.post.author != post.author:
        raise RejectedEvent(f'Post {post.reply_to} is no action of yours, and a receipt replies to your own action.')
    answered = decision(board, action.post.id)
    if not action.post.allowed and not (answered and answered.yes):
        raise RejectedEvent(
            f'The action {action.post.id} was not allowed: its allowance did not allow it, and the person did not '
            'say yes to it.'
        )
