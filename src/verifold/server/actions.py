"""What the person's app shows of the allowances and the actions of the acting seats."""

from datetime import datetime

from verifold.protocol.app import ActionView, AllowanceState, AllowanceView
from verifold.protocol.events import AllowanceDrafted, Posted
from verifold.protocol.join import line_text
from verifold.protocol.posts import Action, Receipt
from verifold.society.allowances import action_state, actions, drawn, ended, newest, receipt, started, stopped
from verifold.society.board import Board


def allowance_views(board: Board, now: datetime) -> tuple[AllowanceView, ...]:
    """
    Return the drafts that wait for the person's confirmation, and then every allowance that the person started.

    A draft waits while it is the newest one for its seat, came after the seat's newest allowance, has not reached
    its end time, and its seat is an acting seat in the lab. The allowances come newest first.
    """
    waiting = tuple(
        _view(board, entry, 'draft', now)
        for entry in reversed(board.drafts)
        if not started(board, entry.allowance) and _waits(board, entry, now)
    )
    begun = tuple(
        _view(board, entry, _state(board, entry, now), now)
        for start in reversed(board.allowance_starts)
        if (entry := next((draft for draft in board.drafts if draft.allowance == start.allowance), None))
    )
    return (*waiting, *begun)


def _waits(board: Board, entry: AllowanceDrafted, now: datetime) -> bool:
    holder = entry.terms.holder
    newer = next(draft for draft in reversed(board.drafts) if draft.terms.holder == holder)
    held = newest(board, holder)
    after = held is None or entry.seq > next(
        start.seq for start in board.allowance_starts if start.allowance == held.allowance
    )
    here = board.acting(holder) and not board.gone(holder)
    return newer is entry and after and here and now < entry.terms.ends_at


def _state(board: Board, entry: AllowanceDrafted, now: datetime) -> AllowanceState:
    if ended(board, entry.allowance):
        return 'ended'
    held = newest(board, entry.terms.holder)
    if held is None or held.allowance != entry.allowance:
        return 'replaced'
    return 'in_force' if now < entry.terms.ends_at else 'over'


def _view(board: Board, entry: AllowanceDrafted, state: AllowanceState, now: datetime) -> AllowanceView:
    begun, done = started(board, entry.allowance), ended(board, entry.allowance)
    held = stopped(board, entry.terms.holder)
    return AllowanceView(
        allowance=entry.allowance,
        terms=entry.terms,
        state=state,
        drafted_at=entry.at,
        by=entry.by,
        on=entry.on,
        started_at=begun.at if begun else None,
        ended_at=done.at if done else None,
        drawn=drawn(board, entry.allowance),
        stopped=held is not None and held.allowance == entry.allowance,
        actions=tuple(action_view(board, action, now) for action in reversed(actions(board, entry.allowance))),
    )


def action_view(board: Board, entry: Posted, now: datetime) -> ActionView:
    """Return one action as the person's app shows it, with where it stands at `now` and its newest receipt."""
    post = entry.post
    if not isinstance(post, Action):
        raise TypeError(f'Post {post.id} is no action.')
    got = receipt(board, entry)
    real = got.post.cost if got and isinstance(got.post, Receipt) else None
    return ActionView(
        post=post.id,
        thread=post.thread,
        agent=post.author,
        at=entry.at,
        what=line_text(post.text),
        cost=post.cost,
        undoable=post.undoable,
        offer_ends=post.offer_ends,
        state=action_state(board, entry, now),
        needs=post.needs,
        real_cost=real,
        receipt=got.post.id if got else None,
    )
