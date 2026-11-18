"""
The deliverables of a lab: who states them, who offers files for them, who decides, and where each one stands.

The person states a deliverable and decides about every offer. An agent offers files with a post. The state of a
deliverable and of each offer comes from the record alone, and the code reads no offered file.
"""

from datetime import datetime

from verifold.protocol.deliverables import (
    MAX_DELIVERABLES,
    Decision,
    DeliverableLine,
    DeliverableState,
    OfferLine,
    OfferState,
    RemovedDeliverable,
)
from verifold.protocol.events import DeliverableDecided, DeliverableSet, Posted
from verifold.protocol.ids import PERSON, DeliverableId, PostId
from verifold.protocol.posts import Ask, Close, FileOffer, Post, Proposal
from verifold.protocol.threads import MAX_TITLE, Thread, Title
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.standing import conceded_to, disputes, is_answered, standing

OFFERS_TITLE = 'Deliverable {id}: '
"""How the title of the thread with the offers for a deliverable starts. The deliverable's sentence follows it."""


_AGENTS_OFFER = 'An agent offers files for a deliverable. The person states it and decides.'


def offers_title(deliverable_id: DeliverableId, text: str) -> Title:
    """Return the title of the thread that holds the offers for a deliverable, with its sentence cut to fit."""
    title = f'{OFFERS_TITLE.format(id=deliverable_id)}{text}'
    return title if len(title) <= MAX_TITLE else f'{title[: MAX_TITLE - 1]}…'


def stated(board: Board) -> tuple[DeliverableSet, ...]:
    """Return the deliverables that the person stated and did not remove, each with its sentence now, oldest first."""
    latest = {entry.deliverable: entry for entry in board.deliverables}
    return tuple(entry for entry in latest.values() if not entry.removed)


def live(board: Board, deliverable_id: DeliverableId) -> DeliverableSet:
    """
    Return a deliverable of the lab as it stands.

    Raises:
        RejectedEvent: The lab has no such deliverable, or the person removed it.

    """
    latest = next((entry for entry in reversed(board.deliverables) if entry.deliverable == deliverable_id), None)
    if latest is None:
        raise RejectedEvent(f'This lab has no deliverable {deliverable_id}. `brief` lists the deliverables.')
    if latest.removed:
        raise RejectedEvent(f'The person removed the deliverable {deliverable_id}.')
    return latest


def told_at(board: Board) -> datetime | None:
    """
    Return when a post of the person last told the lab of a new sentence or a removal, or `None`.

    A post about a new deliverable does not count: each new deliverable has its own post.
    """
    seen: set[DeliverableId] = set()
    latest = None
    for entry in board.deliverables:
        if entry.deliverable in seen and entry.post:
            latest = entry.at
        seen.add(entry.deliverable)
    return latest


def accepted(board: Board, deliverable_id: DeliverableId) -> DeliverableDecided | None:
    """
    Return the person's acceptance of an offer for a deliverable while it stands, or `None`.

    An acceptance stands from the person's decision until the person takes it back. A request for changes to
    another offer leaves it as it is.
    """
    latest = next(
        (
            entry
            for entry in reversed(board.decisions)
            if entry.deliverable == deliverable_id and entry.decision != 'changes_asked'
        ),
        None,
    )
    return latest if latest and latest.decision == 'accepted' else None


def newest_offer(board: Board, offer: FileOffer) -> PostId:
    """Return the newest offer of an offer's author for the same deliverable, which is the offer itself or replaces it."""
    return next(
        entry.post.id for entry in reversed(board.offers(offer.deliverable)) if entry.post.author == offer.author
    )


def deliverable_lines(board: Board) -> tuple[DeliverableLine, ...]:
    """
    Return each deliverable as it stands: its sentence, its state, and the offers for it, each with its own state.

    The person decides about one offer at a time. An offer is accepted while the person's acceptance of it stands,
    and the person asked for changes to it when that is their latest decision about it. An agent's newer offer
    replaces its earlier one and waits for the person. A deliverable is accepted while an acceptance stands. So
    no offer and no other post changes that. Without one, it is offered while at least one offer waits, changes
    are asked when the person asked the author of every offer for changes, and otherwise it has no file.
    """
    return tuple(_line(board, entry) for entry in stated(board))


def _line(board: Board, entry: DeliverableSet) -> DeliverableLine:
    offered = board.offers(entry.deliverable)
    took = accepted(board, entry.deliverable)
    newest = {offer.post.author: offer.post.id for offer in offered}
    shown = {*newest.values(), took.offer if took else None}
    # The person's latest decision about each offer.
    decided = {decision.offer: decision for decision in board.decisions if decision.deliverable == entry.deliverable}
    earlier: dict[str, int] = {}
    lines: list[OfferLine] = []
    for offer in offered:
        post = offer.post
        if post.id in shown:
            lines.append(_offer_line(board, offer, earlier.get(post.author, 0), decided.get(post.id), took))
        earlier[post.author] = earlier.get(post.author, 0) + 1
    current = tuple(line for line in lines if line.post in newest.values())
    asked = tuple(line.decided_at for line in current if line.state == 'changes_asked' and line.decided_at)
    thread = board.offers_thread(entry.deliverable)
    others = board.thread_posts(thread) if thread else ()
    state: DeliverableState = 'none'
    at = None
    if took:
        state, at = 'accepted', took.at
    elif any(line.state == 'waiting' for line in current):
        state = 'offered'
    elif asked:
        state, at = 'changes_asked', max(asked)
    return DeliverableLine(
        id=entry.deliverable,
        text=entry.text,
        state=state,
        decided_at=at,
        thread=thread,
        offers=tuple(lines),
        disputed=tuple(
            other.post.id
            for other in others
            if other.post.id not in shown and standing(board, other.post.id) == 'disputed'
        ),
        open_asks=tuple(
            other.post.id for other in others if isinstance(other.post, Ask) and not is_answered(board, other.post.id)
        ),
    )


def removed_lines(board: Board) -> tuple[RemovedDeliverable, ...]:
    """
    Return the deliverables that the person removed after agents offered files for them, oldest first.

    The thread of such a deliverable stays on the board with its offers. It takes no new offer.
    """
    latest = {entry.deliverable: entry for entry in board.deliverables}
    return tuple(
        RemovedDeliverable(
            id=entry.deliverable,
            text=entry.text,
            removed_at=entry.at,
            thread=thread,
            active=any(said.seq > entry.seq for said in board.thread_posts(thread)),
        )
        for entry in latest.values()
        if entry.removed and (thread := board.offers_thread(entry.deliverable))
    )


def _offer_line(
    board: Board, offer: Posted, revised: int, decided: DeliverableDecided | None, took: DeliverableDecided | None
) -> OfferLine:
    post = offer.post
    state: OfferState = 'waiting'
    if took and took.offer == post.id:
        state, decided = 'accepted', took
    elif decided and decided.decision == 'changes_asked':
        state = 'changes_asked'
    stands = standing(board, post.id)
    against = disputes(board, post.id) if stands == 'disputed' else ()
    return OfferLine(
        post=post.id,
        by=post.author,
        at=offer.at,
        note=post.text,
        files=tuple(file.path for file in post.evidence),
        revised=revised,
        state=state,
        decided_at=decided.at if decided and state != 'waiting' else None,
        standing=stands,
        disputed_by=against[-1].post.id if against else None,
        conceded_to=conceded_to(board, post.id) if stands == 'conceded' else None,
    )


def check_deliverable(board: Board, event: DeliverableSet) -> None:
    """
    Check that the person, or the desk on the person's word, can state, change, or remove a deliverable.

    A new deliverable has the next free ID. A change gives a known deliverable another sentence, and a removal
    is final for its ID. When the event names a post, that post is the board's newest, and its author is the one
    in `by`: it tells the lab. A new deliverable in a lab with agents comes with such a post. A new sentence and a removal can come
    without one, and the agents then read the change in `brief`.

    Raises:
        RejectedEvent: The event breaks one of these rules.

    """
    known = tuple(entry for entry in board.deliverables if entry.deliverable == event.deliverable)
    if not known:
        ids = len({entry.deliverable for entry in board.deliverables})
        if event.deliverable != f'd-{ids + 1}' or event.removed:
            raise RejectedEvent(f'This lab has no deliverable {event.deliverable}. The next new one is d-{ids + 1}.')
        if len(stated(board)) >= MAX_DELIVERABLES:
            raise RejectedEvent(f'A lab has {MAX_DELIVERABLES} deliverables at most. Remove one first.')
    elif known[-1].removed:
        raise RejectedEvent(f'The deliverable {event.deliverable} was removed. State it again as a new one.')
    elif not event.removed and known[-1].text == event.text:
        raise RejectedEvent(f'The deliverable {event.deliverable} has this sentence already.')
    if event.post is None:
        if board.agents and not known:
            raise RejectedEvent(
                'A new deliverable in a lab with agents comes with the post of the person that tells them.'
            )
        return
    # The desk's change comes with the desk's post for the person, which `society.desk` checks.
    told = board.posts[-1] if board.posts else None
    if told is None or told.post.id != event.post or told.post.author != event.by or told.seq != board.seq:
        raise RejectedEvent(f'Post {event.post} is not the post of the person that tells the lab of this deliverable.')


def check_decision(board: Board, event: DeliverableDecided) -> None:
    """
    Check that the person can decide so about an offer.

    The offer is an offer for that deliverable. The event names the person's post that replies to the offer, which
    is the board's newest. The person accepts or asks for changes to an agent's newest offer, and accepts one
    offer for a deliverable at a time. An acceptance is taken back only while it stands.

    Raises:
        RejectedEvent: The event breaks one of these rules.

    """
    live(board, event.deliverable)
    check_decidable(board, event.deliverable, event.decision, event.offer)
    took = accepted(board, event.deliverable)
    if event.decision == 'accepted' and took:
        raise RejectedEvent(
            f'The person accepted the offer {took.offer} for the deliverable {event.deliverable}. The acceptance of '
            'another offer comes after that one is taken back.'
        )
    told = board.posts[-1]
    said = told.post.id == event.post and told.post.author == PERSON and told.post.reply_to == event.offer
    if not said or told.seq != board.seq:
        raise RejectedEvent(f'Post {event.post} is not the reply of the person that tells the author of the offer.')


def check_decidable(board: Board, deliverable_id: DeliverableId, decision: Decision, offer_id: PostId) -> None:
    """
    Check that a decision fits the offer that it names: it is an offer for the deliverable, and the decision fits it.

    The person accepts or asks for changes to an agent's newest offer, which their acceptance does not hold
    already, and takes back only the acceptance that stands.

    Raises:
        RejectedEvent: The post is no offer for the deliverable, its author replaced it, or the decision does not
            fit the acceptance that stands.

    """
    entry = board.post(offer_id)
    if not (entry and isinstance(entry.post, FileOffer) and entry.post.deliverable == deliverable_id):
        raise RejectedEvent(f'Post {offer_id} is no offer of files for the deliverable {deliverable_id}.')
    took = accepted(board, deliverable_id)
    if decision == 'taken_back':
        if took is None or took.offer != offer_id:
            raise RejectedEvent(
                f'The person did not accept the offer {offer_id}, so there is no acceptance to take back.'
            )
        return
    if took and took.offer == offer_id:
        after = (
            '' if decision == 'accepted' else ' A request for changes to it comes after the acceptance is taken back.'
        )
        raise RejectedEvent(f'The person accepted the offer {offer_id} already.{after}')
    if decision == 'changes_asked' and board.gone(entry.post.author):
        raise RejectedEvent(
            f'The author of the offer {offer_id} left the lab, so nobody hears a request for changes to it.'
        )
    newest = newest_offer(board, entry.post)
    if newest != offer_id:
        raise RejectedEvent(
            f'The author of the offer {offer_id} offered again, and the offer {newest} replaces it. The decision is '
            f'about {newest}.'
        )


def check_offers_thread(board: Board, thread: Thread) -> None:
    """
    Check the thread that holds the offers for a deliverable. Any other thread passes.

    An agent opens it for a deliverable that stands, and a deliverable has one such thread.

    Raises:
        RejectedEvent: The thread breaks one of these rules.

    """
    if thread.deliverable is None:
        return
    live(board, thread.deliverable)
    if thread.opened_by == PERSON:
        raise RejectedEvent(_AGENTS_OFFER)
    if thread.between or board.offers_thread(thread.deliverable):
        raise RejectedEvent(
            f'The first offer of an agent for the deliverable {thread.deliverable} opens its one thread, which is '
            'for the whole lab to read.'
        )


def check_offer(board: Board, post: Post) -> None:
    """
    Check a post against the rules for offers of files. A post that is no offer and in no thread of offers passes.

    An agent of the lab offers files for a deliverable that the person stated and did not remove. Every offer for
    a deliverable goes in the thread of that deliverable. That thread takes no proposal and no close.

    Raises:
        RejectedEvent: The post breaks one of these rules.

    """
    if board.holds_offers(post.thread) and isinstance(post, Proposal | Close):
        raise RejectedEvent('The thread of the offers for a deliverable takes no proposal and no close.')
    if not isinstance(post, FileOffer):
        return
    if post.author == PERSON:
        raise RejectedEvent(_AGENTS_OFFER)
    live(board, post.deliverable)
    if post.thread != board.offers_thread(post.deliverable):
        raise RejectedEvent(
            f'An offer for the deliverable {post.deliverable} goes in the thread of that deliverable, which the '
            'first offer opens.'
        )
