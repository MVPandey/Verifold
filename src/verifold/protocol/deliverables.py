"""
The deliverables of a lab: what the person wants to hold at the end, and the files that agents offer for each.

A deliverable is one sentence of the person. Only the person states it, changes it, and removes it. An agent offers
files for it with a post, and the person accepts an offer, asks for changes, or takes an acceptance back. Verifold
reads no offered file and never marks a deliverable as met.
"""

from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, StringConstraints

from verifold.protocol.agents import one_line
from verifold.protocol.ids import AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.record import Record

MAX_SENTENCE = 300
"""The most characters in a deliverable's sentence."""

MAX_DELIVERABLES = 20
"""The most deliverables that a lab has at one time. A removed one does not count."""


def _sentence(text: str) -> str:
    line = one_line(text)
    if not line:
        raise ValueError('A deliverable is one sentence, and this one holds no text.')
    return line


type Sentence = Annotated[str, StringConstraints(max_length=MAX_SENTENCE), AfterValidator(_sentence)]
"""What the person wants to hold at the end of the lab, as one printable line."""

type Decision = Literal['accepted', 'changes_asked', 'taken_back']
"""What the person decided about an offer: they accepted it, asked for changes, or took their acceptance back."""

type DeliverableState = Literal['none', 'offered', 'changes_asked', 'accepted']
"""
Where a deliverable stands, by the record. `accepted`: the person's acceptance of an offer stands. `offered`: no
acceptance stands, and at least one offer waits for the person. `changes_asked`: the person asked the author of
every offer for changes, and none offered again. `none`: no agent offered files.
"""


type OfferState = Literal['waiting', 'changes_asked', 'accepted']
"""
Where one offer stands, by the person's decisions about it. `waiting`: the person decided nothing about it, or took
their acceptance of it back. `changes_asked`: the person asked its author for changes. `accepted`: the person's
acceptance of it stands.
"""

type OfferStanding = Literal['open', 'checked', 'held_up', 'disputed', 'conceded']
"""Where the post of an offer stands after the objections, checks, and answers to it, as for any post."""


class OfferLine(Record):
    """One agent's offer for a deliverable as it stands: the post, its files, and what the person decided about it."""

    post: PostId
    """The post that holds the offer. Its files open at the commit that the post pins."""
    by: AgentId
    at: AwareDatetime
    note: str
    """The agent's note on the offer, as one headline."""
    files: tuple[str, ...]
    """The paths of the offered files in the agent's folder."""
    revised: int = 0
    """How many earlier offers of the same agent for this deliverable this one replaced."""
    state: OfferState = 'waiting'
    decided_at: AwareDatetime | None = None
    """When the person accepted the offer or asked for changes, while `state` says so. `None` otherwise."""
    standing: OfferStanding = 'open'
    disputed_by: PostId | None = None
    """While `standing` is `disputed`: the newest failed check or objection to the offer that still stands."""
    conceded_to: PostId | None = None
    """While `standing` is `conceded`: the objection to the offer that its author accepted."""


class DeliverableLine(Record):
    """A deliverable as it stands: the person's sentence, its state, and the offers for it."""

    id: DeliverableId
    text: Sentence
    state: DeliverableState = 'none'
    decided_at: AwareDatetime | None = None
    """When the person accepted an offer or last asked for changes, while the state says so. `None` otherwise."""
    thread: ThreadId | None = None
    """The thread that holds the offers for the deliverable. `None` until the first offer opens it."""
    offers: tuple[OfferLine, ...] = ()
    """
    Each agent's newest offer, oldest first, each with its own state. The offer that the person accepted is among
    them also when its agent offered again later.
    """
    disputed: tuple[PostId, ...] = ()
    """The other posts of the thread that stand disputed: an earlier offer, or what an agent said there."""
    open_asks: tuple[PostId, ...] = ()
    """The asks in the thread that no answer replies to."""


class RemovedDeliverable(Record):
    """A deliverable that the person removed after agents offered files for it, with the thread that holds the offers."""

    id: DeliverableId
    text: Sentence
    """The sentence that the deliverable had last."""
    removed_at: AwareDatetime
    thread: ThreadId
    active: bool = False
    """Whether a post came to the thread after the removal."""
