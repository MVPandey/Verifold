"""What the person's panel for the desk reads: the desk chat, and what the desk did on the person's word."""

from verifold.protocol.app import DeskAction, DeskView
from verifold.protocol.events import BudgetSet, DeliverableSet, Posted, QuestionRevised, TimeSet
from verifold.protocol.ids import PERSON, PostId
from verifold.protocol.posts import Round
from verifold.society.board import Board
from verifold.society.views import thread_view


def desk_view(board: Board) -> DeskView:
    """Return the desk, the desk chat as the person reads it, and each action of the desk with the post it rests on."""
    chat = board.desk_chat
    return DeskView(
        desk=board.desk,
        thread=thread_view(board, PERSON, chat) if chat else None,
        actions=desk_actions(board),
    )


def desk_actions(board: Board) -> tuple[DeskAction, ...]:
    """
    Return each action of the desk, oldest first, as the record keeps it with `on`.

    A revision of the question and a change of a deliverable come with the desk's post that tells the lab, and that
    post is part of the action, so it is no action of its own.
    """
    moves: tuple[QuestionRevised | DeliverableSet | TimeSet | BudgetSet, ...] = (
        *board.revisions,
        *board.deliverables,
        *(entry for entry in board.times if isinstance(entry, TimeSet)),
        *board.budgets,
    )
    told = {move.post for move in moves if isinstance(move, QuestionRevised | DeliverableSet) and move.on}
    actions = (
        *(
            (entry.seq, _posted(entry, on))
            for entry in board.posts
            if (on := entry.post.on) and entry.post.id not in told
        ),
        *((move.seq, _moved(board, move, on)) for move in moves if (on := move.on)),
        *(
            (entry.seq, DeskAction(on=entry.on, at=entry.at, kind='interrupt', agent=entry.agent))
            for entry in board.interrupts
        ),
        *(
            (entry.seq, DeskAction(on=on, at=entry.at, kind='allowance', allowance=entry.allowance))
            for entry in board.drafts
            if (on := entry.on)
        ),
    )
    return tuple(action for _, action in sorted(actions, key=lambda pair: pair[0]))


def _posted(entry: Posted, on: PostId) -> DeskAction:
    post = entry.post
    kind = 'round' if isinstance(post, Round) else 'post'
    return DeskAction(on=on, at=entry.at, kind=kind, post=post.id, thread=post.thread)


def _moved(board: Board, move: QuestionRevised | DeliverableSet | TimeSet | BudgetSet, on: PostId) -> DeskAction:
    match move:
        case QuestionRevised():
            said = board.post(move.post)
            return DeskAction(
                on=on, at=move.at, kind='question', post=move.post, thread=said.post.thread if said else None
            )
        case DeliverableSet():
            said = board.post(move.post) if move.post else None
            first = next(entry for entry in board.deliverables if entry.deliverable == move.deliverable)
            change = 'removed' if move.removed else 'added' if first is move else 'changed'
            return DeskAction(
                on=on,
                at=move.at,
                kind='deliverable',
                post=move.post,
                thread=said.post.thread if said else None,
                deliverable=move.deliverable,
                change=change,
            )
        case TimeSet():
            return DeskAction(on=on, at=move.at, kind='time', ends_at=move.ends_at)
        case BudgetSet():
            return DeskAction(on=on, at=move.at, kind='budget', tokens=move.tokens, dollars=move.dollars)
