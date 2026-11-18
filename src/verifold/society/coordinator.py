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

from datetime import datetime
from typing import Literal

from verifold.protocol.events import (
    AgentLeft,
    Posted,
    PowerSet,
    QuestionRevised,
    RequestAnswered,
    SettingsSet,
    TimeSet,
)
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.join import RequestEnd
from verifold.protocol.moves import Move, PermissionMove, QuestionMove, RemoveMove, SettingMove, TimeMove, power_of
from verifold.protocol.posts import Answer, Ask, Close, MoveRequest, PermissionShown, Post, Proposal
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import latest_time, minutes_text
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
    if post.for_person and isinstance(post, Proposal | Close):
        raise RejectedEvent(
            f"A {post.kind} is the agents' own word, so no {post.kind} is marked as one for the person."
        )
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
    while the person's power covers the move: the power for that kind of move is on, the lab has time, and the
    move is not one that lets processes run on after a stop. So a lab that the person stopped, or whose time ran
    out, takes no move without the person. A yes needs a request from the present holding of the coordinator
    seat, and a move that can still be made.

    Raises:
        RejectedEvent: The answer breaks one of these rules.

    """
    entry = board.post(event.request)
    request = entry.post if entry and isinstance(entry.post, MoveRequest) else None
    if entry is None or request is None:
        raise RejectedEvent(f'Post {event.request} is no request for a move.')
    if board.answer_to(event.request):
        raise RejectedEvent(f'The request {event.request} has its answer already.')
    by_person = event.by == PERSON
    if event.minutes is not None and not (event.yes and by_person and isinstance(request.move, TimeMove)):
        raise RejectedEvent("Only the person's yes to a request for more time names minutes.")
    own_yes = event.yes and event.by == request.author and event.by == board.coordinator
    if not by_person and not (own_yes and power_covers(board, request.move, event.at)):
        raise RejectedEvent(_not_covered(board, request.move, event.at))
    # A request that ended takes no answer: no yes, and no "no" either.
    end = request_end(board, entry)
    if end == 'seat':
        raise RejectedEvent(
            f'The coordinator seat changed after {request.author} asked, so its request {event.request} ended.'
        )
    if end == 'ask' and isinstance(request.move, PermissionMove):
        raise RejectedEvent(
            f'The permission request {request.move.ask} waits for no answer now, so the request {event.request} ended.'
        )
    if event.yes:
        _check_move(board, request.move, request.author)


def check_made(board: Board, event: TimeSet | SettingsSet) -> None:
    """
    Check a new end of the lab, or new settings, that names a request of the coordinator.

    Such an event is the move of that request, just after its yes.

    Raises:
        RejectedEvent: The event before it is not the yes to such a request.

    """
    if event.request is None:
        return
    answered = _just_answered(board)
    request = _request(board, answered) if answered else None
    kind = TimeMove if isinstance(event, TimeSet) else SettingMove
    if not (
        answered and answered.yes and answered.request == event.request and request and isinstance(request.move, kind)
    ):
        raise RejectedEvent(f'Only the move of the request {event.request}, just after its yes, names that request.')


def power_covers(board: Board, move: Move, at: datetime) -> bool:
    """
    Return whether a power of the coordinator covers a move at a moment, so that the move needs no yes of the person.

    The person's switch for that kind of move is on. The lab has time: its time did not run out, and the person
    did not stop it. The move does not let the agents' processes run on after the lab stops or Verifold exits.
    """
    return power_of(move) in board.powers and not _over(board, at) and not _outlasts_a_stop(move)


def _over(board: Board, at: datetime) -> bool:
    # Whether the lab's end passed, also when the record does not say so yet. The person stops a lab with its end.
    return board.out_of_time or (board.ends_at is not None and at >= board.ends_at)


def _outlasts_a_stop(move: Move) -> bool:
    # The values of the job settings with which processes run on after the lab stops, or after Verifold exits.
    return isinstance(move, SettingMove) and (move.key, move.value) in {
        ('jobs.at_time_limit', 'finish'),
        ('jobs.at_exit', 'keep'),
    }


def _not_covered(board: Board, move: Move, at: datetime) -> str:
    if power_of(move) in board.powers and _over(board, at):
        return "The lab's time ran out or the person stopped the lab, so only the person makes a move now."
    if power_of(move) in board.powers and _outlasts_a_stop(move):
        return (
            "This value lets the agents' processes run on after the lab stops or Verifold exits, so only the "
            "person's yes sets it."
        )
    return (
        'The person answers a request for a move. The coordinator answers its own request only with a yes, and '
        'only while the person switched on the power for that kind of move.'
    )


def check_removal(board: Board, left: AgentLeft) -> None:
    """
    Check a removal that names a request of the coordinator: it is the move of that request, just after its yes.

    The removal is the person's, and its reason is empty: the coordinator's reason is in the request. With the
    person's yes it names no coordinator in `through`, and with the coordinator's own yes it names that agent.

    Raises:
        RejectedEvent: The event before it is not the yes to such a request, or the removal says something else.

    """
    answered = _just_answered(board)
    request = _request(board, answered) if answered else None
    move = request.move if request else None
    through = None if answered is None or answered.by == PERSON else answered.by
    made = answered and answered.yes and answered.request == left.request and left.by == PERSON
    if not (made and isinstance(move, RemoveMove) and move.agent == left.agent and left.through == through):
        raise RejectedEvent(
            f'A removal of {left.agent} names a request of the coordinator only as the move of that request, just '
            'after its yes.'
        )
    if left.reason:
        raise RejectedEvent("The request holds the coordinator's reason, so the removal has no reason of its own.")


def check_reviser(board: Board, revision: QuestionRevised) -> None:
    """
    Check a revision of the question that names a request of the coordinator, or that the person did not make.

    It follows the yes to that request, with the question of the request. With the person's yes it is the
    person's revision and has no note, because the coordinator's reason is in the request. With the
    coordinator's own yes it is the coordinator's, and the post that tells the lab is marked as one for the person.

    Raises:
        RejectedEvent: No such yes came just before it, or the revision says something else.

    """
    answered = board.answers[-1] if board.answers else None
    request = _request(board, answered) if answered else None
    move = request.move if request else None
    told = board.posts[-1].post
    just = answered and answered.yes and board.seq - answered.seq <= _TOLD and answered.request == revision.request
    same = isinstance(move, QuestionMove) and move.question == revision.question
    words = told.for_person if revision.by != PERSON else not revision.note
    if not (just and answered.by == revision.by and same and words):
        raise RejectedEvent(
            'A revision of the question names a request of the coordinator only as the move of that request, just '
            'after its yes. An agent revises the question only so, under the power to revise it.'
        )


def request_end(board: Board, entry: Posted) -> RequestEnd | None:
    """
    Return why a request for a move without an answer waits for none, or `None` while it waits.

    A request ends for good when the coordinator seat changes after it, also when its author gets the seat again
    later. A request to answer a permission request ends when that permission request got its answer or ended.
    """
    post = entry.post
    if not isinstance(post, MoveRequest):
        return None
    if post.author != board.coordinator or entry.seq < board.seat_since:
        return 'seat'
    if isinstance(post.move, PermissionMove) and not _ask_waits(board, post.move):
        return 'ask'
    return None


def request_waits(board: Board, entry: Posted) -> bool:
    """Return whether a request for a move waits for the person's answer: it has none, and it has not ended."""
    post = entry.post
    return isinstance(post, MoveRequest) and not board.answer_to(post.id) and request_end(board, entry) is None


def _ask_waits(board: Board, move: PermissionMove) -> bool:
    asked = board.post(move.ask)
    return bool(asked and waits_for_person(board, move.ask) and not board.gone(asked.post.author))


def waiting_for_reply(board: Board) -> tuple[Posted, ...]:
    """
    Return the person's posts in the conversation that wait for the coordinator's reply, oldest first.

    A post of the person there waits until an agent posts in the conversation after it while that agent holds the
    coordinator seat. Any kind of post is such a reply, and one reply answers every earlier post of the person. So
    a reply from an agent that gave the seat up later still counts, and a post of another agent counts for nothing.
    A lab without a conversation has no such post.
    """
    talk = board.conversation
    posts = board.thread_posts(talk) if talk else ()
    replied = next((entry.seq for entry in reversed(posts) if entry.post.author == board.coordinator_at(entry.seq)), 0)
    return tuple(entry for entry in posts if entry.post.author == PERSON and entry.seq > replied)


def no_reply_line(board: Board, agent_id: AgentId, now: datetime | None = None) -> str:
    """
    Return one line for the agent that holds the coordinator seat about the person's posts that wait for its reply.

    The line names the oldest of them with the whole minutes that it has waited by the lab's clock, and counts the
    later ones. It is empty while no post waits, and for every other agent. Without `now`, time counts from the
    board's newest post.
    """
    waiting = waiting_for_reply(board) if agent_id == board.coordinator else ()
    if not waiting:
        return ''
    oldest, more = waiting[0], len(waiting) - 1
    waited = minutes_text(max(((now or latest_time(board)) - oldest.at).total_seconds() / 60, 0))
    line = f"The person's post {oldest.post.id} in the conversation has waited {waited} for your reply."
    if more:
        posts, wait = ('post', 'waits') if more == 1 else ('posts', 'wait')
        line += f' {more} later {posts} of the person there {wait} too.'
    return line


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
    if not _ask_waits(board, move):
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
    return next(
        (entry for entry in board.times if isinstance(entry, TimeSet) and entry.request == answered.request), None
    )


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
