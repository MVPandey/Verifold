"""
What the lab's coordinator does for the person, and the rules that keep it to the agent that holds the seat.

The person and the coordinator talk in one thread of the lab, the conversation. Every agent can read it. The
coordinator can mark a post or a new thread as one for the person. It can ask the person for a move that only the
person makes: more time, the answer to another agent's permission request, one more agent or one fewer, a setting
of the lab, or a revision of the question. The person's yes makes the move. The person can switch on a power for one
kind of move, and the coordinator's request for such a move then takes effect at once.

These rules hold for every event, so no tool can go around them. Only the agent that holds the coordinator seat
marks a post for the person or asks for a move. Only the person answers a request, unless the power for its kind is
on, and then only the coordinator's own yes counts. A power is on only while the person's switch for the agent that
holds the seat is on. An answer to a permission request picks an answer of the harness for this once, never one that
the harness remembers, never Verifold's grant, and never for the coordinator's own harness.
"""

from typing import Literal

from verifold.protocol.events import AgentLeft, Posted, PowerSet, QuestionRevised, RequestAnswered, TimeSet
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.moves import Move, PermissionMove, QuestionMove, RemoveMove, TimeMove, power_of
from verifold.protocol.posts import Answer, Ask, Close, MoveRequest, PermissionShown, Post, Proposal
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.standing import waits_for_person

_TOLD = 2
"""The most events between a yes to a revision of the question and the revision: a new thread, and the post that tells the lab."""

type Undo = Literal['remove_agent', 'take_minutes']
"""The way back from a move that came from a request: the removal of the agent that it added, or of its minutes."""


def check_power(board: Board, event: PowerSet) -> None:
    """
    Check that the person can switch a power: it is for the agent that holds the coordinator seat now.

    Raises:
        RejectedEvent: Nobody holds the seat, or the event names another agent.

    """
    if board.coordinator is None or event.agent != board.coordinator:
        raise RejectedEvent('A power is for the agent that holds the coordinator seat, and nobody else gets one.')


def check_marked_thread(board: Board, thread: Thread) -> None:
    """
    Check a thread that is the conversation, or that the coordinator opens for the person.

    Raises:
        RejectedEvent: The lab has a conversation already or has no coordinator, somebody other than the person
            and the coordinator opens the conversation, or somebody other than the coordinator marks a thread as
            one for the person.

    """
    holder = board.coordinator
    if thread.for_person and (thread.opened_by != holder or thread.conversation):
        raise RejectedEvent('Only the agent that holds the coordinator seat opens a thread for the person.')
    if not thread.conversation:
        return
    if thread.between:
        raise RejectedEvent('The conversation with the person is no side thread.')
    if board.conversation:
        raise RejectedEvent(f'The lab has its conversation with the person already: {board.conversation}.')
    if holder is None or thread.opened_by not in (PERSON, holder):
        raise RejectedEvent('The person and the agent that holds the coordinator seat open their conversation.')


def check_marks(board: Board, post: Post, thread: Thread) -> None:
    """
    Check what a post claims for the person: the mark, a request for a move, or an answer that carries one out.

    Raises:
        RejectedEvent: The author does not hold the coordinator seat, a request is outside the conversation or
            names a move that cannot be made, or an answer claims a request that did not get a yes for it.

    """
    if post.for_person and post.author != board.coordinator:
        raise RejectedEvent('Only the agent that holds the coordinator seat marks a post as one for the person.')
    if thread.conversation and (post.to_lab or isinstance(post, Proposal | Close)):
        kind = 'post with `to_lab`' if post.to_lab else post.kind
        raise RejectedEvent(
            f'Thread {thread.id} is the conversation with the person, and a {kind} is for the whole lab.'
        )
    if isinstance(post, MoveRequest):
        check_asks(board, post.author)
        if not thread.conversation:
            raise RejectedEvent('A request for a move is a post in the conversation with the person.')
        _check_move(board, post.move, post.author)
    if isinstance(post, Answer) and post.for_request:
        _check_carried(board, post)


def check_asks(board: Board, author: AgentId) -> None:
    """
    Check that an agent can ask the person for a move: it holds the coordinator seat.

    Raises:
        RejectedEvent: Another agent holds the seat, or nobody does.

    """
    if author != board.coordinator:
        raise RejectedEvent('Only the agent that holds the coordinator seat asks the person for a move.')


def check_answered(board: Board, event: RequestAnswered) -> None:
    """
    Check the answer to a request for a move.

    The person answers any request once. The coordinator answers only its own request, only with a yes, and only
    while the person's power for that kind of move is on. Its yes gives no time to a lab whose time ran out, so
    that a lab that the person stopped stays stopped. A yes needs a request whose author still holds the seat
    and a move that can still be made.

    Raises:
        RejectedEvent: The answer breaks one of these rules.

    """
    request = _request(board, event)
    if request is None:
        raise RejectedEvent(f'Post {event.request} is no request for a move.')
    if board.answer_to(event.request):
        raise RejectedEvent(f'The request {event.request} has its answer already.')
    by_person = event.by == PERSON
    if event.minutes is not None and not (event.yes and by_person and isinstance(request.move, TimeMove)):
        raise RejectedEvent("Only the person's yes to a request for more time names minutes.")
    holder = board.coordinator
    powered = event.yes and event.by == request.author and event.by == holder and power_of(request.move) in board.powers
    if not by_person and not powered:
        raise RejectedEvent(
            'The person answers a request for a move. The coordinator answers its own request only with a yes, and '
            'only while the person switched on the power for that kind of move.'
        )
    if powered and isinstance(request.move, TimeMove) and (board.out_of_time or _ended(board, event)):
        raise RejectedEvent("The lab's time ran out, so only the person gives it more time.")
    if event.yes:
        if request.author != holder:
            raise RejectedEvent(
                f'{request.author} holds the coordinator seat no longer, so its request {event.request} ended.'
            )
        _check_move(board, request.move, request.author)


def check_removal(board: Board, left: AgentLeft) -> None:
    """
    Check a removal that names the coordinator in `through`: it follows the coordinator's own yes to that move.

    Raises:
        RejectedEvent: The event before it is not that yes.

    """
    answered = _just_answered(board)
    request = _request(board, answered) if answered else None
    move = request.move if request else None
    made = answered and answered.yes and answered.by == left.through and left.by == PERSON
    if not (made and isinstance(move, RemoveMove) and move.agent == left.agent):
        raise RejectedEvent(
            f'{left.through} removes {left.agent} only with its own request, while the person switched on the '
            'power to add or remove agents.'
        )


def check_reviser(board: Board, revision: QuestionRevised) -> None:
    """
    Check a revision of the question by somebody other than the person: it follows the coordinator's own yes.

    Raises:
        RejectedEvent: No such yes came just before it, or the post that tells the lab is not marked for the person.

    """
    answered = board.answers[-1] if board.answers else None
    request = _request(board, answered) if answered else None
    move = request.move if request else None
    told = board.posts[-1].post
    just = answered and answered.yes and answered.by == revision.by and board.seq - answered.seq <= _TOLD
    if not (just and isinstance(move, QuestionMove) and move.question == revision.question and told.for_person):
        raise RejectedEvent(
            f'{revision.by} revises the question only with its own request, while the person switched on the '
            'power to revise the question.'
        )


def request_waits(board: Board, entry: Posted) -> bool:
    """
    Return whether a request for a move waits for the person's answer.

    It waits while it has no answer and its author holds the coordinator seat. The request of an agent that holds
    the seat no longer ended with its seat.
    """
    post = entry.post
    return isinstance(post, MoveRequest) and not board.answer_to(post.id) and post.author == board.coordinator


def permission_choice(board: Board, move: PermissionMove, by: AgentId) -> tuple[Ask, str]:
    """
    Return the permission request that a move answers, and the choice that it picks, as the ask names it.

    Raises:
        RejectedEvent: The ask is no permission request that waits, it is the request of `by`'s own harness, or the
            option is not one of the harness's answers for this once.

    """
    entry = board.post(move.ask)
    ask = entry.post if entry else None
    if not isinstance(ask, Ask) or not isinstance(ask.shown, PermissionShown):
        raise RejectedEvent(f'Post {move.ask} is no permission request of a harness.')
    if ask.author == by:
        raise RejectedEvent(
            f'Post {move.ask} is a permission request of the harness of {by}. Only the person answers the '
            "request of the coordinator's own harness."
        )
    if not waits_for_person(board, ask.id) or board.gone(ask.author):
        raise RejectedEvent(f'The permission request {move.ask} waits for no answer now.')
    shown = ask.shown
    if move.option not in shown.ids:
        offered = ', '.join(f'`{option}`' for option in shown.ids) or 'none'
        raise RejectedEvent(
            f'The permission request {move.ask} has no answer with the ID `{move.option}`. Its answers: {offered}.'
        )
    label = ask.choices[shown.ids.index(move.option)]
    if label in shown.remembered:
        raise RejectedEvent(
            f'The harness remembers the answer `{move.option}` beyond this lab, so only the person picks it. A '
            'move picks an answer for this once.'
        )
    return ask, label


def joined_by(board: Board, answered: RequestAnswered) -> AgentId | None:
    """Return the agent that joined the lab with a yes to a request for one more agent, or `None`."""
    return next((entry.agent.id for entry in board.agents if entry.seq == answered.seq + 1), None)


def time_given(board: Board, answered: RequestAnswered) -> TimeSet | None:
    """Return the new end of the lab that came with a yes to a request for more time, or `None`."""
    return next((entry for entry in board.times if isinstance(entry, TimeSet) and entry.seq == answered.seq + 1), None)


def undo_of(board: Board, answered: RequestAnswered) -> Undo | None:
    """
    Return the way back from the move that a yes made, when the person has one.

    An agent that the move added can be removed while it is in the lab. The minutes of a move can be taken back
    while nothing else has changed the lab's time since. Every other move has no way back here.
    """
    added = joined_by(board, answered)
    if added and not board.gone(added):
        return 'remove_agent'
    given = time_given(board, answered)
    if given and board.times[-1] is given:
        return 'take_minutes'
    return None


def _ended(board: Board, event: RequestAnswered) -> bool:
    # Whether the lab's end passed before the event, also when the record does not say so yet.
    return board.ends_at is not None and event.at >= board.ends_at


def _request(board: Board, answered: RequestAnswered) -> MoveRequest | None:
    entry = board.post(answered.request)
    return entry.post if entry and isinstance(entry.post, MoveRequest) else None


def _just_answered(board: Board) -> RequestAnswered | None:
    # The answer to a request, when it is the board's newest event.
    answered = board.answers[-1] if board.answers else None
    return answered if answered and answered.seq == board.seq else None


def _check_move(board: Board, move: Move, by: AgentId) -> None:
    # Whether the board can take the move now. `by` is the agent that asks for it.
    match move:
        case TimeMove() if board.ends_at is None:
            raise RejectedEvent('The lab has no time limit, so no move gives it more time.')
        case PermissionMove():
            permission_choice(board, move, by)
        case RemoveMove(agent=agent):
            joined = board.agent(agent)
            if joined is None or joined.agent.checks:
                raise RejectedEvent(f'{agent} is not an agent with a seat in this lab.')
            if board.gone(agent):
                raise RejectedEvent(f'{agent} left this lab already.')
            if agent == by:
                raise RejectedEvent('This move removes another agent. `leave` removes the agent that calls it.')


def _check_carried(board: Board, answer: Answer) -> None:
    # An answer that claims a request decides a permission request. It follows the yes to that request at once.
    answered = _just_answered(board)
    request = _request(board, answered) if answered else None
    move = request.move if request else None
    made = answered and answered.yes and answered.request == answer.for_request and answered.by == answer.author
    if not (request and made and isinstance(move, PermissionMove) and move.ask == answer.reply_to):
        raise RejectedEvent('Only the yes to a request for a move decides a permission request for it.')
    if answer.choice != permission_choice(board, move, request.author)[1]:
        raise RejectedEvent(f'The request {request.id} picks another answer of the permission request.')
