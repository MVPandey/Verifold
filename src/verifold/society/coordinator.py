"""
What the lab's coordinator does for the person, and the rules that keep it to the agent that holds the seat.

The person and the coordinator talk in one thread of the lab, the conversation. Every agent can read it. The
coordinator can mark a post or a new thread as one for the person. It can ask the person for a move that only the
person makes: more time, the answer to another agent's permission request, one more agent or one fewer, a setting
of the lab, a revision of the question, or a move of pace. The person's yes makes the move. The person can switch on
a power for one kind of move, and the coordinator's request for such a move then takes effect at once. The power for
pace covers only a move that lowers what the person granted, and any other request of pace waits for the person.

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
from verifold.protocol.moves import (
    AddMove,
    CapMove,
    Move,
    PauseMove,
    PermissionMove,
    QuestionMove,
    RemoveMove,
    ResumeMove,
    SettingMove,
    TimeMove,
    power_of,
)
from verifold.protocol.posts import (
    Action,
    Answer,
    Ask,
    Close,
    MoveRequest,
    PermissionShown,
    Post,
    Proposal,
    Reading,
    Round,
)
from verifold.protocol.threads import Thread
from verifold.society.allowances import action_state
from verifold.society.board import Board
from verifold.society.desk import speaks_for_person
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import latest_time, minutes_text
from verifold.society.pace import check_pace_target, lowers
from verifold.society.spare import outside_grant
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
    # The desk opens a thread for the person with its post for the person, which `society.desk` checks.
    opener = (holder, board.desk)
    if thread.for_person and (thread.opened_by not in opener or thread.conversation):
        raise RejectedEvent(
            'Only the agent that holds the coordinator seat, and the desk, open a thread for the person.'
        )
    if not thread.conversation:
        return
    if thread.between:
        raise RejectedEvent('The conversation with the person is no side thread.')
    if board.conversation:
        raise RejectedEvent(f'The lab has its conversation with the person already: {board.conversation}.')
    # The desk's post for the person is the person's side of the conversation, so it can open the thread too.
    if holder is None or thread.opened_by not in (PERSON, holder, board.desk):
        raise RejectedEvent('The person and the agent that holds the coordinator seat open their conversation.')


def check_marks(board: Board, post: Post, thread: Thread) -> None:
    """
    Check what a post claims for the person: the mark, a request for a move, or an answer that carries one out.

    Raises:
        RejectedEvent: The author does not hold the coordinator seat, a request is outside the conversation or
            names a move that cannot be made, or an answer claims a request that did not get a yes for it.

    """
    # The desk marks its post for the person with `on`, which `society.desk` checks.
    desk = post.on is not None and post.author == board.desk
    if post.for_person and post.author != board.coordinator and not desk:
        raise RejectedEvent(
            'Only the agent that holds the coordinator seat, and the desk with `on`, mark a post as one for the person.'
        )
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


def check_why(board: Board, post: Post) -> None:
    """
    Check that a round of the agent that holds the coordinator seat, and a newer reading of that agent, say why.

    The log of the coordinator's moves shows each such post with its one line of why. A record from before the
    field holds such posts without one, so the board checks this for a new post only, and not as a rule of the
    record.

    Raises:
        RejectedEvent: The post is such a round or reading, and it has no `why`.

    """
    if post.author != board.coordinator or not isinstance(post, Round | Reading) or post.why:
        return
    if isinstance(post, Reading) and not any(isinstance(entry.post, Reading) for entry in board.posts):
        return
    raise RejectedEvent(
        f'A {post.kind} of the agent that holds the coordinator seat is one of its moves, so it says why in one line, '
        'in `why`. The log of the moves shows it to the person and to every agent.'
    )


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
    did not stop it. The lab stands at no budget or disk limit. The move does not let the agents' processes run on after the lab stops or Verifold exits.
    A move of pace lowers what the person granted. A move that adds an agent is covered by the person's grant of
    spare seats too, and by the power for agents only in the lab's own mode.

    The record keeps this rule for every request, also for one from before removals waited for the person. A new
    request follows `covers_now`.
    """
    if isinstance(move, PauseMove | ResumeMove | CapMove) and lowers(board, move, at):
        return False
    if _over(board, at) or _outlasts_a_stop(move):
        return False
    if isinstance(move, AddMove):
        return outside_grant(board, move.seat) is None or ('agents' in board.powers and move.seat.mode is None)
    return power_of(move) in board.powers


def covers_now(board: Board, move: Move, at: datetime) -> bool:
    """
    Return whether a new request of the coordinator takes effect at once, as `power_covers` says.

    A request to remove an agent waits for the person under every power. The coordinator pauses a seat under the
    power for pace, and only the person removes one.
    """
    return not isinstance(move, RemoveMove) and power_covers(board, move, at)


def _over(board: Board, at: datetime) -> bool:
    # Whether the lab's end passed, also when the record does not say so yet, or the lab stands at another limit.
    # The person stops a lab with its end.
    return board.halted is not None or (board.ends_at is not None and at >= board.ends_at)


def _outlasts_a_stop(move: Move) -> bool:
    # The values of the job settings with which processes run on after the lab stops, or after Verifold exits.
    return isinstance(move, SettingMove) and (move.key, move.value) in {
        ('jobs.at_time_limit', 'finish'),
        ('jobs.at_exit', 'keep'),
    }


def _not_covered(board: Board, move: Move, at: datetime) -> str:
    pace = isinstance(move, PauseMove | ResumeMove | CapMove)
    if pace and power_of(move) in board.powers and (refusal := lowers(board, move, at)):
        return f"{refusal} The power for pace only lowers, so only the person's yes makes this move."
    if _over(board, at):
        return "The lab's time ran out or the person stopped the lab, so only the person makes a move now."
    if power_of(move) in board.powers and _outlasts_a_stop(move):
        return (
            "This value lets the agents' processes run on after the lab stops or Verifold exits, so only the "
            "person's yes sets it."
        )
    if isinstance(move, AddMove) and (outside := outside_grant(board, move.seat)):
        mode = " The power for agents adds a seat in the lab's own mode only." if move.seat.mode else ''
        return f"{outside}{mode} So only the person's yes adds this agent."
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


def waiting_posts(board: Board, now: datetime | None = None) -> tuple[Posted, ...]:
    """
    Return the entries of the posts that wait for the person's answer, oldest first.

    They are the asks that name the person and have no answer from the person yet, the coordinator's asks in the
    conversation with the person, the coordinator's requests for a move that wait, and the actions that wait for the
    person. Permission requests are asks too. An ask whose end time came, an ask that carried a harness's request
    after Verifold ended the request, and the ask of an agent that left are not among them. Without `now`, time
    counts from the board's newest event.
    """
    at = now or latest_time(board)
    return tuple(entry for entry in board.posts if _waits_for_person(board, entry, at))


def missed_posts(board: Board, now: datetime | None = None) -> tuple[Posted, ...]:
    """
    Return the entries of the asks and actions for the person that stopped waiting before the person answered.

    They are the asks to the person whose end time came, the asks of a harness that ended with the agent's turn or
    with a restart of Verifold, and the actions whose offers ended, or whose authors left, without an answer. Nothing
    was done for any of them. Oldest first. Without `now`, time counts from the board's newest event.
    """
    at = now or latest_time(board)
    return tuple(entry for entry in board.posts if _missed(board, entry, at))


def _to_person(board: Board, entry: Posted, ask: Ask) -> bool:
    # In the conversation, the ask of the agent that held the coordinator seat when it asked is to the person, also
    # after the seat changed. Another agent's ask there is to the person only when it names the person, as in any
    # thread.
    talks = ask.thread == board.conversation and ask.author == board.coordinator_at(entry.seq)
    return PERSON in ask.mentions or talks


def _waits_for_person(board: Board, entry: Posted, at: datetime) -> bool:
    post = entry.post
    if isinstance(post, Action):
        return action_state(board, entry, at) == 'waits'
    if not isinstance(post, Ask):
        return request_waits(board, entry)
    ended = post.ends_at is not None and post.ends_at <= at
    return (
        _to_person(board, entry, post)
        and not ended
        and waits_for_person(board, post.id)
        and not board.gone(post.author)
    )


def _missed(board: Board, entry: Posted, at: datetime) -> bool:
    post = entry.post
    if isinstance(post, Action):
        return action_state(board, entry, at) == 'missed'
    if not isinstance(post, Ask):
        return False
    if post.request is not None:
        return any(isinstance(reply.post, Answer) and reply.post.missed for reply in board.replies(post.id))
    ended = post.ends_at is not None and post.ends_at <= at
    return ended and _to_person(board, entry, post) and waits_for_person(board, post.id)


def _ask_waits(board: Board, move: PermissionMove) -> bool:
    asked = board.post(move.ask)
    return bool(asked and waits_for_person(board, move.ask) and not board.gone(asked.post.author))


def waiting_for_reply(board: Board) -> tuple[Posted, ...]:
    """
    Return the person's posts in the conversation that wait for the coordinator's reply, oldest first.

    A post of the person there waits until an agent posts in the conversation after it while that agent holds the
    coordinator seat. Any kind of post is such a reply, and one reply answers every earlier post of the person. So
    a reply from an agent that gave the seat up later still counts, and a post of another agent counts for nothing.
    An `answer` of the person, such as its yes to a request or its choice on an ask, is itself a reply and asks
    nothing, so it waits for none. The desk's post for the person there carries the person's word, so it waits as
    a post of the person does. A lab without a conversation has no such post.
    """
    talk = board.conversation
    posts = board.thread_posts(talk) if talk else ()
    replied = next((entry.seq for entry in reversed(posts) if entry.post.author == board.coordinator_at(entry.seq)), 0)
    return tuple(
        entry
        for entry in posts
        if speaks_for_person(entry.post) and not isinstance(entry.post, Answer) and entry.seq > replied
    )


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
    post = oldest.post.id
    whose = f"The person's post {post}" if oldest.post.author == PERSON else f"The desk's post {post} for the person"
    line = f'{whose} in the conversation has waited {waited} for your reply.'
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
        case PauseMove() | ResumeMove() | CapMove():
            check_pace_target(board, move)
            if not move.why:
                raise RejectedEvent('A move of pace says why in one line, in `why`.')


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
