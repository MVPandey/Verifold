"""
The lab's desk: the seat that answers the person in the desk chat and acts on the person's word.

The person makes a seat the desk when the agent joins, and a lab has one desk at most. The desk chat is the thread
between the person and the desk. It opens in the step of the desk's join, and only the person and the desk post
there. A post of the person there is for the desk alone, and a post of the desk there is for the person.

The desk is no part of the lab's work. No news, call, round, or wanted rerun wakes it, and it counts for no round, no
close, and no reviewer seat. The board takes from it a `message` in the desk chat, and outside the desk chat only a
post for the person: a `message` or a `round`. It takes no vote, no badge, no rerun request, no take of a rerun, no
alarm, and no seat from it.

Each action of the desk names in `on` the person's post in the desk chat that it rests on, and the record keeps
`on` with the action. These rules hold for every event, so no tool can go around them: `on` names a post of the
person, in the desk chat, from the last `MAX_ON_MINUTES` minutes by the lab's clock, and the actor holds the desk
seat. So no post of an agent, and no post of the person in another thread, stands in for the person's word.
"""

from datetime import datetime, timedelta

from verifold.protocol.agents import GUEST
from verifold.protocol.events import (
    DeliverableSet,
    DeskSet,
    Posted,
    QuestionRevised,
    TimeSet,
    TurnInterrupted,
)
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.posts import Close, Entry, Message, Post, Proposal, Round
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.turns import before

MAX_ON_MINUTES = 60
"""How old the person's post in the desk chat may be, by the lab's clock, for an action of the desk to rest on it."""


def speaks_for_person(post: Post) -> bool:
    """
    Return whether a post carries the person's word: a post of the person, or a post of the desk for the person.

    The record's rules take `on` only on the desk's post for the person, so the field marks such a post.
    """
    return post.author == PERSON or post.on is not None


def check_desk_set(board: Board, event: DeskSet) -> None:
    """
    Check that the person can make an agent's seat the lab's desk: in the step of its join, and while no desk stands.

    Raises:
        RejectedEvent: The agent did not join just before, it joined with an invitation or as a blind checker, or
            the lab has its desk already.

    """
    joined = board.agent(event.agent)
    if joined is None or joined.seq != board.seq:
        raise RejectedEvent('A seat becomes the desk in the step in which its agent joins the lab.')
    if joined.agent.harness == GUEST or joined.agent.checks:
        raise RejectedEvent(
            'An invited agent runs by itself, so Verifold cannot start its turn when the person writes to it. The '
            'desk is a seat that Verifold starts.'
        )
    if board.desk:
        raise RejectedEvent(f'The lab has its desk already: {board.desk}. A lab has one desk at most.')


def check_desk_chat(board: Board, thread: Thread) -> None:
    """
    Check a thread that is the desk chat: the person opens it once, in the step in which the first desk joins.

    Raises:
        RejectedEvent: The lab has a desk chat already, the thread comes without a new desk, or it is another kind
            of thread too.

    """
    if board.desk_chat:
        raise RejectedEvent(f'The lab has its desk chat already: {board.desk_chat}.')
    if not board.desks or board.desks[-1].seq != board.seq or thread.opened_by != PERSON:
        raise RejectedEvent("The desk chat opens in the step in which the person seats the lab's desk.")
    if thread.between or thread.conversation or thread.for_person or thread.deliverable or thread.carries:
        raise RejectedEvent('The desk chat is a thread of its own kind, between the person and the desk.')


def check_on(board: Board, by: AgentId, on: PostId | None, at: datetime) -> None:
    """
    Check that an action of `by` at `at` rests on the person's word.

    It does when `by` holds the desk seat, and `on` is a post of the person in the desk chat from the last
    `MAX_ON_MINUTES` minutes before `at`.

    Raises:
        RejectedEvent: One of these does not hold. The message says which.

    """
    if by == PERSON or by != board.desk:
        raise RejectedEvent(
            f"Only the lab's desk acts on the person's word with `on`, and {by} does not hold the desk seat."
        )
    if on is None:
        raise RejectedEvent("An action of the desk names in `on` the person's post in the desk chat that it rests on.")
    told = board.post(on)
    if told is None:
        raise RejectedEvent(f'Post {on} does not exist, so no action rests on it.')
    if told.post.author != PERSON:
        raise RejectedEvent(
            f'Post {on} is a post of {told.post.author}, not of the person. Only a post of the person in the desk '
            'chat backs an action of the desk.'
        )
    chat = board.desk_chat
    if told.post.thread != chat:
        raise RejectedEvent(
            f'Post {on} is in thread {told.post.thread}, not in the desk chat {chat}. Only a post of the person in '
            'the desk chat backs an action of the desk.'
        )
    if at - told.at > timedelta(minutes=MAX_ON_MINUTES):
        minutes = int((at - told.at).total_seconds() // 60)
        raise RejectedEvent(
            f'Post {on} of the person is {minutes} minutes old. An action of the desk rests on a post of the person '
            f'in the desk chat from the last {MAX_ON_MINUTES} minutes.'
        )


def check_desk_post(board: Board, event: Posted) -> None:
    """
    Check a post against the rules of the desk and of the desk chat, at the time of its event.

    Raises:
        RejectedEvent: An agent other than the desk posts in the desk chat or names a post in `on`, a post there is
            for the whole lab, or the desk posts a kind that it does not post, or a post for the person that rests
            on no post of the person in the desk chat from the last `MAX_ON_MINUTES` minutes.

    """
    post = event.post
    chat = board.desk_chat
    in_chat = chat is not None and post.thread == chat
    desk = board.is_desk(post.author)
    if post.on is not None and not desk:
        raise RejectedEvent("Only the desk's post for the person names in `on` a post of the person.")
    if in_chat and post.author != PERSON and not desk:
        raise RejectedEvent(
            f'Thread {chat} is the desk chat between the person and the desk, so the board takes no post of '
            f'{post.author} there.'
        )
    if in_chat and (post.to_lab or isinstance(post, Proposal | Close | Round | Entry)):
        kind = 'post with `to_lab`' if post.to_lab else post.kind
        raise RejectedEvent(f'Thread {chat} is the desk chat, and a {kind} is for the whole lab.')
    if not desk:
        return
    if in_chat:
        if not isinstance(post, Message) or post.for_person or post.on is not None:
            raise RejectedEvent(
                'In the desk chat, the desk posts a `message` to the person, with no `for_person` and no `on`.'
            )
        return
    if not isinstance(post, Message | Round):
        raise RejectedEvent(
            f"The desk is no part of the lab's work, so the board takes no {post.kind} from it. Outside the desk "
            'chat, the desk posts for the person a `message` or a `round`.'
        )
    if not post.for_person or post.on is None:
        raise RejectedEvent(
            'Outside the desk chat, the desk posts only for the person: with `for_person`, and with `on`, the '
            "person's post in the desk chat that the post rests on."
        )
    check_on(board, post.author, post.on, event.at)


def check_desk_move(board: Board, event: TimeSet | DeliverableSet | QuestionRevised) -> None:
    """
    Check a new end of the lab, a change of a deliverable, or a revision of the question by the desk.

    Such a move names the desk in `by` and the person's post that it rests on in `on`. Every other move names
    nobody in `on`. A change of a deliverable and a revision of the question come with the desk's post for the
    person that tells the lab, and that post rests on the same post of the person.

    Raises:
        RejectedEvent: The move names `on` without the desk in `by`, or the desk without `on`, or it breaks
            `check_on`, or its post rests on another post.

    """
    by = event.by
    if by == PERSON or (isinstance(event, QuestionRevised) and by == board.coordinator and event.on is None):
        if event.on is not None:
            raise RejectedEvent("Only a move of the desk names in `on` the person's post that it rests on.")
        return
    if isinstance(event, TimeSet) and event.request is not None:
        raise RejectedEvent("Only the person's own end of the lab, or the desk's, names who set it.")
    check_on(board, by, event.on, event.at)
    told = event.post if isinstance(event, DeliverableSet | QuestionRevised) else None
    said = board.post(told) if told else None
    if told and (said is None or said.post.on != event.on):
        raise RejectedEvent(f'Post {told} does not rest on post {event.on} of the person.')


def check_interrupt(board: Board, event: TurnInterrupted) -> None:
    """
    Check that the desk can end an agent's turn for the person.

    The agent is in the lab, Verifold runs it, and a turn of it started and has not ended by the record. The desk
    ends no turn of its own, and a turn once.

    Raises:
        RejectedEvent: One of these does not hold, or the interrupt breaks `check_on`.

    """
    check_on(board, event.by, event.on, event.at)
    joined = board.agent(event.agent)
    if joined is None or joined.agent.checks:
        raise RejectedEvent(f'{event.agent} is not an agent with a seat in this lab.')
    if board.gone(event.agent):
        raise RejectedEvent(f'{event.agent} left this lab, so it has no turn.')
    if board.is_desk(event.agent):
        raise RejectedEvent('The desk ends no turn of its own.')
    if joined.agent.harness == GUEST:
        raise RejectedEvent(
            f'{event.agent} joined with an invitation and runs by itself, so Verifold cannot end its turn.'
        )
    started = next((turn for turn in reversed(board.starts) if turn.agent == event.agent), None)
    if started is None or not before(board, event.agent).cut_off:
        raise RejectedEvent(f'{event.agent} is in no turn by the record, so there is no turn to end.')
    if interrupted(board, event.agent, started.seq):
        raise RejectedEvent(f'The desk ended the turn of {event.agent} already, and Verifold cancels it.')


def interrupted(board: Board, agent_id: AgentId, since: int) -> TurnInterrupted | None:
    """Return the desk's newest interrupt of an agent's turn after event `since`, or `None`."""
    return next((entry for entry in reversed(board.interrupts) if entry.agent == agent_id and entry.seq > since), None)
