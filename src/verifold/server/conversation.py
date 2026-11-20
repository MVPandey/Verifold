"""What the person's panel for the coordinator reads: the conversation, the powers, the grant, and the moves."""

from verifold.protocol.agents import POWERS
from verifold.protocol.app import ConversationView, Deed, MoveView, PowerView
from verifold.protocol.ids import PERSON
from verifold.protocol.moves import PermissionMove, power_of
from verifold.protocol.posts import MoveRequest
from verifold.society.board import Board
from verifold.society.coordinator import joined_by, undo_of, waiting_for_reply
from verifold.society.steering import moves, spare_seats
from verifold.society.views import needs_person, post_view, thread_view


def conversation_view(board: Board) -> ConversationView:
    """Return the conversation between the person and the coordinator, the powers, and the moves made for the person."""
    talk = board.conversation
    thread = thread_view(board, PERSON, talk) if talk else None
    requests = tuple(entry.post for entry in board.posts if isinstance(entry.post, MoveRequest))
    asked = {request.move.ask for request in requests if isinstance(request.move, PermissionMove)}
    return ConversationView(
        coordinator=board.coordinator,
        thread=thread,
        # Another agent's ask to the person there stays on the Needs you page, as its asks in any thread do.
        waits=tuple(
            item.post.id
            for item in needs_person(board)
            if item.post.thread == talk and item.post.author == board.coordinator
        ),
        no_reply=tuple(entry.post.id for entry in waiting_for_reply(board)),
        asks=tuple(post_view(board, entry, PERSON) for entry in board.posts if entry.post.id in asked),
        powers=_powers(board),
        deeds=_deeds(board),
        moves=tuple(
            MoveView(
                post=post_view(board, move.entry, PERSON),
                kind=move.kind,
                at=move.at,
                by=move.by,
                why=move.why,
                agent=move.agent,
                yes_by=move.yes_by,
            )
            for move in moves(board)
        ),
        grant=spare_seats(board),
    )


def _powers(board: Board) -> tuple[PowerView, ...]:
    # Each power with the switch that put it on, and the moves that the holder made with it since.
    holder = board.coordinator
    since = board.coordinators[-1].seq if board.coordinators else 0
    made = tuple(
        (answered, entry.post)
        for answered in board.answers
        if answered.by == holder and answered.seq > since
        if (entry := board.post(answered.request)) and isinstance(entry.post, MoveRequest)
    )
    return tuple(
        PowerView(
            power=power,
            on=power in board.powers,
            since=next(
                (
                    switch.at
                    for switch in reversed(board.power_sets)
                    if switch.power == power and switch.on and power in board.powers
                ),
                None,
            ),
            used=sum(power_of(request.move) == power for _, request in made),
        )
        for power in POWERS
    )


def _deeds(board: Board) -> tuple[Deed, ...]:
    return tuple(
        Deed(request=post_view(board, entry, PERSON), agent=joined_by(board, answered), undo=undo_of(board, answered))
        for answered in reversed(board.answers)
        if answered.yes and (entry := board.post(answered.request))
    )
