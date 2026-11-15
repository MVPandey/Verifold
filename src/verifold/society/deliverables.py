"""
The deliverables of a lab: who states them, who offers files for them, who decides, and where each one stands.

The person states a deliverable and decides about every offer. An agent offers files with a post. The state of a
deliverable comes from the record alone, and the code reads no offered file.
"""

from verifold.protocol.deliverables import MAX_DELIVERABLES, DeliverableLine, DeliverableState, OfferLine
from verifold.protocol.events import DeliverableDecided, DeliverableSet, Posted
from verifold.protocol.ids import PERSON, DeliverableId, PostId
from verifold.protocol.posts import FileOffer, Post
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent


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


# ponytail: each call scans the posts. An index by deliverable, when a lab holds many offers.
def offers(board: Board, deliverable_id: DeliverableId) -> tuple[Posted, ...]:
    """Return every offer of files for a deliverable, oldest first."""
    return tuple(
        entry for entry in board.posts if isinstance(entry.post, FileOffer) and entry.post.deliverable == deliverable_id
    )


def accepted(board: Board, deliverable_id: DeliverableId) -> DeliverableDecided | None:
    """Return the person's acceptance of an offer for a deliverable while it stands, or `None`."""
    decided = _decided(board, deliverable_id)
    return decided if decided and decided.decision == 'accepted' else None


def _decided(board: Board, deliverable_id: DeliverableId) -> DeliverableDecided | None:
    return next((entry for entry in reversed(board.decisions) if entry.deliverable == deliverable_id), None)


def deliverable_lines(board: Board) -> tuple[DeliverableLine, ...]:
    """
    Return each deliverable as it stands: its sentence, its state, and the offers for it.

    A deliverable is accepted while the person's latest decision about it is an acceptance. So no offer and no
    other post changes that state. Without an acceptance, it has no file until an agent offers one, and it is
    offered from then on. After the person asked for changes, it says so until the next offer comes.
    """
    return tuple(_line(board, entry) for entry in stated(board))


def _line(board: Board, entry: DeliverableSet) -> DeliverableLine:
    offered = offers(board, entry.deliverable)
    decided = _decided(board, entry.deliverable)
    state: DeliverableState = 'offered' if offered else 'none'
    if decided and decided.decision == 'accepted':
        state = 'accepted'
    elif decided and decided.decision == 'changes_asked' and offered[-1].seq < decided.seq:
        state = 'changes_asked'
    took = decided.offer if decided and state == 'accepted' else None
    newest = {offer.post.author: offer.post.id for offer in offered}
    shown = {*newest.values(), took}
    earlier: dict[str, int] = {}
    lines: list[OfferLine] = []
    for offer in offered:
        post = offer.post
        if post.id in shown:
            lines.append(
                OfferLine(
                    post=post.id,
                    by=post.author,
                    at=offer.at,
                    note=post.text,
                    files=tuple(file.path for file in post.evidence),
                    revised=earlier.get(post.author, 0),
                    accepted=post.id == took,
                )
            )
        earlier[post.author] = earlier.get(post.author, 0) + 1
    return DeliverableLine(
        id=entry.deliverable,
        text=entry.text,
        state=state,
        decided_at=decided.at if decided and state in ('accepted', 'changes_asked') else None,
        thread=offered[0].post.thread if offered else None,
        offers=tuple(lines),
    )


def check_deliverable(board: Board, event: DeliverableSet) -> None:
    """
    Check that the person can state, change, or remove a deliverable.

    A new deliverable has the next free ID. A change gives a known deliverable another sentence, and a removal
    is final for its ID. The event names the person's post that tells the lab, which is the board's newest. Only
    before the first agent joins does a deliverable need no such post.

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
        if board.agents:
            raise RejectedEvent('A deliverable in a lab with agents comes with the post of the person that tells them.')
        return
    told = board.posts[-1] if board.posts else None
    if told is None or told.post.id != event.post or told.post.author != PERSON or told.seq != board.seq:
        raise RejectedEvent(f'Post {event.post} is not the post of the person that tells the lab of this deliverable.')


def check_decision(board: Board, event: DeliverableDecided) -> None:
    """
    Check that the person can decide so about an offer.

    The offer is an offer for that deliverable. The event names the person's post that replies to the offer, which
    is the board's newest. An acceptance is taken back only while it stands.

    Raises:
        RejectedEvent: The event breaks one of these rules.

    """
    live(board, event.deliverable)
    if not _offers_for(board, event.offer, event.deliverable):
        raise RejectedEvent(f'Post {event.offer} is no offer of files for the deliverable {event.deliverable}.')
    told = board.posts[-1]
    said = told.post.id == event.post and told.post.author == PERSON and told.post.reply_to == event.offer
    if not said or told.seq != board.seq:
        raise RejectedEvent(f'Post {event.post} is not the reply of the person that tells the author of the offer.')
    standing = accepted(board, event.deliverable)
    if event.decision == 'taken_back' and (standing is None or standing.offer != event.offer):
        raise RejectedEvent(
            f'The person did not accept the offer {event.offer}, so there is no acceptance to take back.'
        )
    if event.decision == 'accepted' and standing and standing.offer == event.offer:
        raise RejectedEvent(f'The person accepted the offer {event.offer} already.')


def _offers_for(board: Board, post_id: PostId, deliverable_id: DeliverableId) -> bool:
    entry = board.post(post_id)
    return bool(entry and isinstance(entry.post, FileOffer) and entry.post.deliverable == deliverable_id)


def check_offer(board: Board, post: Post) -> None:
    """
    Check an offer of files for a deliverable. Any other post passes.

    An agent of the lab offers files for a deliverable that the person stated and did not remove. The first offer
    for a deliverable is the first post of a thread, and every later offer for it goes in that thread.

    Raises:
        RejectedEvent: The offer breaks one of these rules.

    """
    if not isinstance(post, FileOffer):
        return
    if post.author == PERSON:
        raise RejectedEvent('An agent offers files for a deliverable. The person states it and decides.')
    live(board, post.deliverable)
    earlier = offers(board, post.deliverable)
    if earlier and post.thread != earlier[0].post.thread:
        raise RejectedEvent(
            f'The offers for the deliverable {post.deliverable} are in thread {earlier[0].post.thread}.'
        )
    if not earlier and any(entry.post.thread == post.thread for entry in board.posts):
        raise RejectedEvent(f'The first offer for the deliverable {post.deliverable} opens a thread of its own.')
