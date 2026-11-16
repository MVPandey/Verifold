"""
Rounds: a question to every agent at once, and the entries that answer it, sealed until the round closes.

A round is a post of the kind `round`, with the minutes that it stays open. An agent answers with one post of the
kind `entry` that replies to it. While the round is open, an entry is sealed for every agent but its author. Every
view of the board for such an agent comes from `for_reader`, which holds each sealed entry without its headline,
its body, its helper, its files, its mentions, its links, and its mark for the person. So no result shows the
entry's content, and nothing that the board derives from that content either, such as the posts that an entry
builds on. A view shows that the entry exists, who wrote it, and how many agents entered. The person sees every
entry at once. An entry wakes nobody: the round's close tells of it.

The seal is the board's. The record on disk holds every entry whole, and an agent that can read files outside its
folder can read them there. The norms ask agents not to.

A round closes at its time by the lab's clock, when every agent that it waits for has entered, as `waits_for` says,
or when its opener withdraws it with a ruled-out lead that replies to it. Verifold records the close
as an event, and the news of the agents carries it. A round whose time passed is closed for every view at once,
also before Verifold records the event, as after a stop of Verifold.

The rules here hold for every event, so a record that loads follows them too: one open round at a time, a round
in a thread for the whole lab that names nobody, one entry for each agent in an open round, no entry from the
person, no reply to a sealed entry, no vote, badge, rerun request, or link to it, and a close that is true.
"""

from dataclasses import replace
from datetime import datetime, timedelta

from verifold.protocol.events import Posted, RoundClosed, RoundEnd
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import SEALED_TEXT
from verifold.protocol.posts import Entry, Round, RuledOut
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import latest_time, utc
from verifold.society.turns import stopped


def closes_at(opened: Posted) -> datetime:
    """Return when a round closes by the lab's clock: its minutes after it was posted."""
    minutes = opened.post.minutes if isinstance(opened.post, Round) else 0
    return opened.at + timedelta(minutes=minutes)


def close_of(board: Board, round_id: PostId) -> RoundClosed | None:
    """Return the close of a round that Verifold recorded, or `None`."""
    return next((event for event in board.round_closes if event.round == round_id), None)


def is_open(board: Board, opened: Posted, now: datetime | None = None) -> bool:
    """
    Return whether a round is open at `now`: Verifold recorded no close of it, and its time has not come.

    Without `now`, time counts from the board's newest post, which is never later than the lab's clock, so a view
    without a clock keeps an entry sealed longer and never shorter.
    """
    return close_of(board, opened.post.id) is None and (now or latest_time(board)) < closes_at(opened)


def open_round(board: Board, now: datetime | None = None) -> Posted | None:
    """Return the round that is open at `now`, or `None`. A round opens only while no other is open, so it is the newest."""
    newest = board.rounds[-1] if board.rounds else None
    return newest if newest and is_open(board, newest, now) else None


def round_of(board: Board, entry: Posted) -> Posted | None:
    """Return the round that an entry answers, or `None` for a post that is no entry."""
    if not isinstance(entry.post, Entry):
        return None
    target = board.post(entry.post.reply_to)
    return target if target and isinstance(target.post, Round) else None


def entries(board: Board, round_id: PostId) -> tuple[Posted, ...]:
    """Return the entries of a round, oldest first."""
    return tuple(entry for entry in board.replies(round_id) if isinstance(entry.post, Entry))


def waits_for(board: Board, opened: Posted, before: int | None = None) -> tuple[AgentId, ...]:
    """
    Return the agents that a round waits for, in the order that they joined: the ones that were asked and have not entered.

    A round waits for every agent that it was for and that can still enter: an agent of the lab that is known to
    be in it, so not an invited agent that has not posted yet, and that is not on call, has not left, and is not a
    seat that Verifold stopped. It does not wait for its opener, which asked the question. The opener and an agent
    on call can still enter. With `before`, the list is as it was just before that event, as at a round's close.
    """
    ahead = lambda seq: before is None or seq < before
    entered = {entry.post.author for entry in entries(board, opened.post.id) if ahead(entry.seq)}
    gone = {left.agent for left in board.left if ahead(left.seq)}
    return tuple(
        joined.agent.id
        for joined in board.agents
        if ahead(joined.seq)
        and not joined.agent.checks
        and joined.agent.id != opened.post.author
        and board.came(joined, before)
        and joined.agent.id not in gone
        and not board.on_call(joined.agent.id, before)
        and not stopped(board, joined.agent.id, before)
        and joined.agent.id not in entered
    )


def withdrawn(board: Board, opened: Posted) -> bool:
    """Return whether the opener of a round withdrew it with a ruled-out lead that replies to it."""
    return any(
        isinstance(entry.post, RuledOut) and entry.post.author == opened.post.author
        for entry in board.replies(opened.post.id)
    )


def close_due(board: Board, at: datetime) -> tuple[PostId, RoundEnd] | None:
    """
    Return the round whose close is due at `at` and why, or `None` when Verifold has no close to record.

    The time comes first, then the opener's withdrawal, then the last entry that the round waited for. A round
    closes on its entries only when it has one, so a round in a lab whose agents are all on call runs to its time.
    """
    for opened in board.rounds:
        if close_of(board, opened.post.id):
            continue
        if at >= closes_at(opened):
            return opened.post.id, 'time'
        if withdrawn(board, opened):
            return opened.post.id, 'opener'
        if entries(board, opened.post.id) and not waits_for(board, opened):
            return opened.post.id, 'entered'
    return None


def sealed(board: Board, reader: AgentId, entry: Posted, now: datetime | None = None) -> bool:
    """Return whether an entry is sealed for a reader at `now`: another agent wrote it, and its round is open."""
    if not isinstance(entry.post, Entry) or reader in (PERSON, entry.post.author):
        return False
    held = round_of(board, entry)
    return held is not None and is_open(board, held, now)


def stripped(entry: Posted) -> Posted:
    """Return an entry as a sealed view shows it: its ID, its thread, its author, and its round, with `SEALED_TEXT`."""
    hidden = {
        'text': SEALED_TEXT,
        'body': '',
        'helper': '',
        'mentions': (),
        'builds_on': (),
        'evidence': (),
        'for_person': False,
    }
    return entry.model_copy(update={'post': entry.post.model_copy(update=hidden)})


_sealed: list[tuple[Board, AgentId, Board]] = []
"""The boards that `for_reader` built last, each with the board and the reader that it was built from."""

_KEPT = 16


def for_reader(board: Board, reader: AgentId, now: datetime | None = None) -> Board:
    """
    Return the board as an agent sees it at `now`: each entry that is sealed for the agent is `stripped`.

    Every view for an agent reads this board, so a sealed entry's content is in no result and changes no count, no
    link, and no list. The board is the same object when nothing is sealed for the reader, and a board that this
    returned comes back as it is.
    """
    held = open_round(board, now) if reader != PERSON else None
    hidden = {entry.post.id for entry in entries(board, held.post.id) if entry.post.author != reader} if held else set()
    if not hidden:
        return board
    for source, who, built in _sealed:
        if who == reader and (board is source or board is built):
            return built
    posts = tuple(stripped(entry) if entry.post.id in hidden else entry for entry in board.posts)
    built = replace(board, posts=posts)
    _sealed.append((board, reader, built))
    del _sealed[:-_KEPT]
    return built


def check_unsealed(board: Board, post_id: PostId, at: datetime, what: str) -> None:
    """
    Check that a post is no entry of a round that is open at `at`, which takes `what`.

    Raises:
        RejectedEvent: The post is an entry of a round that is open, and the message says until when.

    """
    # Only the newest round can be open, so a record without an open round costs no search of its posts.
    held = open_round(board, at)
    target = board.post(post_id) if held else None
    if held and target and isinstance(target.post, Entry) and target.post.reply_to == held.post.id:
        raise RejectedEvent(
            f'Post {post_id} is an entry of round {held.post.id}, which is open until {utc(closes_at(held))}. '
            f'Until the round closes, the entry takes no {what}.'
        )


def check_rounds(board: Board, event: Posted) -> None:
    """
    Check a post against the rules of the rounds, at the time of its event.

    Raises:
        RejectedEvent: The post opens a second round, a round is not for the whole lab or names somebody, an entry
            answers no open round or is a second entry of its author, or the post replies to a sealed entry or
            builds on one. The message says which.

    """
    post, at = event.post, event.at
    if post.reply_to:
        check_unsealed(board, post.reply_to, at, 'reply')
    for source in dict.fromkeys(post.builds_on):
        check_unsealed(board, source, at, 'post that builds on it')
    if isinstance(post, Round):
        _check_round(board, post, at)
    elif isinstance(post, Entry):
        _check_entry(board, post, at)


def _check_round(board: Board, post: Round, at: datetime) -> None:
    if board.is_side(post.thread) or post.thread == board.conversation or board.holds_offers(post.thread):
        raise RejectedEvent(
            'A round is for the whole lab, so it is in a thread for the whole lab: not a side thread, the '
            'conversation, or a thread of offers.'
        )
    if post.mentions:
        raise RejectedEvent('A round is for every agent that is not on call, so it names nobody in `mentions`.')
    other = open_round(board, at)
    if other:
        raise RejectedEvent(
            f'Round {other.post.id} is open until {utc(closes_at(other))}. A lab has one open round at a time.'
        )


def _check_entry(board: Board, post: Entry, at: datetime) -> None:
    target = board.post(post.reply_to)
    if target is None or not isinstance(target.post, Round):
        raise RejectedEvent(f'An entry replies to a round, and post {post.reply_to} is no round.')
    if post.author == PERSON:
        raise RejectedEvent('An entry is the word of an agent. The person sees every entry and enters none.')
    if not is_open(board, target, at):
        raise RejectedEvent(f'Round {target.post.id} is closed, so it takes no entry.')
    mine = next((entry for entry in entries(board, target.post.id) if entry.post.author == post.author), None)
    if mine:
        raise RejectedEvent(
            f'You entered round {target.post.id} with post {mine.post.id}. An agent has one entry in a round, and '
            'the board changes no entry.'
        )


def check_close(board: Board, event: RoundClosed) -> None:
    """
    Check that a round can close, for the reason that the event gives.

    Raises:
        RejectedEvent: The post is no round, it closed already, or its reason does not hold.

    """
    opened = board.post(event.round)
    if opened is None or not isinstance(opened.post, Round):
        raise RejectedEvent(f'Post {event.round} is no round.')
    if close_of(board, event.round):
        raise RejectedEvent(f'Round {event.round} closed already.')
    holds = {
        'time': event.at >= closes_at(opened),
        'opener': withdrawn(board, opened),
        'entered': bool(entries(board, event.round)) and not waits_for(board, opened),
    }
    if not holds[event.why]:
        raise RejectedEvent(f'Round {event.round} does not close for the reason `{event.why}` now.')
