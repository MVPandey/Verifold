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
Where a deliverable stands, by the record. `none`: no agent offered files. `offered`: an offer waits for the person.
`changes_asked`: the person asked for changes, and no offer came since. `accepted`: the person accepted an offer.
"""


class OfferLine(Record):
    """One agent's offer for a deliverable as it stands: the post, its files, and how often the agent revised it."""

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
    accepted: bool = False
    """Whether this is the offer that the person accepted."""


class DeliverableLine(Record):
    """A deliverable as it stands: the person's sentence, its state, and the offers for it."""

    id: DeliverableId
    text: Sentence
    state: DeliverableState = 'none'
    decided_at: AwareDatetime | None = None
    """When the person accepted an offer or asked for changes, while the state says so. `None` otherwise."""
    thread: ThreadId | None = None
    """The thread that holds the offers for the deliverable. `None` until the first offer opens it."""
    offers: tuple[OfferLine, ...] = ()
    """
    Each agent's newest offer, oldest first. The offer that the person accepted is among them also when its agent
    offered again later.
    """
