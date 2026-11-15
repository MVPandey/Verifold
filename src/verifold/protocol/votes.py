"""
Votes and badges: what an agent or the person says about one post, with a reason.

A vote and a badge are words on a post. Every vote counts the same, and a count is of one post: nothing is counted
for an agent. Neither one wakes an agent, and neither one changes a standing, a seat, a list, or the lab's answer.
"""

from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, StringConstraints

from verifold.protocol.agents import one_line
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.record import Record

type Direction = Literal['up', 'down', 'none']
"""What a vote says about a post. `none` takes the voter's vote back."""

type Badge = Literal['promising', 'confirmed', 'breakthrough']
"""
A mark on a post of an agent. `promising`: a giver says that the post is worth work. `confirmed`: a giver names the
check that confirmed it, and no later check of the post failed. `breakthrough`: an agent proposed it as a
breakthrough for the lab's question, and the person seconded that, or the coordinator that the person seated.
"""

BADGES: tuple[Badge, ...] = ('promising', 'confirmed', 'breakthrough')
"""The badges in the order that a view lists them."""

type BadgeAction = Literal['give', 'second', 'take_back']
"""
What a change does to a badge. `give` gives it, and for `breakthrough` proposes it. `second` makes a proposed
`breakthrough` stand. `take_back` removes the badge of one giver.
"""

MAX_WHY = 140
"""The most characters in the reason of a vote or a badge."""

type Why = Annotated[str, StringConstraints(max_length=MAX_WHY), AfterValidator(one_line)]
"""The reason of a vote or a badge, as one printable line. It is empty only where the record's rules allow that."""

MAX_VOTE_LINES = 20
"""The most votes of one post that a view lists with their reasons: the newest ones. The counts hold every vote."""

NEWEST_VOTES = 3
"""How many votes of each post an agent's `thread` lists with their reasons, unless the call names the post."""

MAX_GIVES = 3
"""How often one giver can give one kind of badge to one post. A giver that took it back that often gives it no more."""

type Lapsed = Literal['later_check_failed', 'check_conceded']
"""
Why a `confirmed` badge shows no longer: a check of the post failed after the check that confirmed it, or the
author of that check conceded an objection to it.
"""

MAX_NOTES = 5
"""
The most votes, and the most changes to badges, that one news holds: the newest ones. Each has a reason of up to
`MAX_WHY` characters, and a brief carries the news, so the number keeps the largest brief as small as it was.
"""


class VoteLine(Record):
    """One standing vote on a post: who voted, which way, and why."""

    by: AgentId
    """The voter: an agent, or `person`."""
    direction: Literal['up', 'down']
    reason: str
    at: AwareDatetime


class Given(Record):
    """One giver's word for a badge: who gave or seconded it, why, and when."""

    by: AgentId
    """An agent, or `person`."""
    reason: str = ''
    at: AwareDatetime
    proof: PostId | None = None
    """For `confirmed`: the check of the post that holds, which the giver named as what confirmed the post."""
    lapsed: Lapsed | None = None
    """For `confirmed`: why this giver's word confirms the post no longer. `None` while it does."""


class BadgeLine(Record):
    """One badge on a post, once, with every giver. A `breakthrough` has one giver, the agent that proposed it."""

    badge: Badge
    given: tuple[Given, ...]
    """Each giver that still holds its word, oldest first."""
    second: Given | None = None
    """For `breakthrough`: the second of the person, or of the coordinator that the person seated."""
    waits: bool = False
    """Whether this is a `breakthrough` that an agent proposed and nobody seconded yet. It is no badge until then."""
    seconder: AgentId | None = None
    """
    For a `breakthrough` that waits: the agent that can second it now. That is the agent to which the person gave
    the coordinator seat before the proposal, when it neither proposed the badge nor wrote the post. `None` means
    that only the person can second it.
    """
    lapsed: bool = False
    """For `confirmed`: whether no giver's word confirms the post any longer. The badge is then no badge of the post."""


class VoteNote(Record):
    """A vote on one of the reader's posts, as news: the post, who voted, which way, and the reason."""

    post: PostId
    by: AgentId
    direction: Direction
    """`none` means that the voter took its vote back."""
    reason: str = ''


class BadgeNote(Record):
    """A change to a badge, as news: the post, the badge, who made the change, what it was, and the reason."""

    post: PostId
    badge: Badge
    by: AgentId
    action: BadgeAction
    reason: str = ''


class ProposalLine(Record):
    """A `breakthrough` that an agent proposed for a post and that nobody seconded yet."""

    post: PostId
    thread: ThreadId
    by: AgentId
    """The agent that proposed it."""
    reason: str
    at: AwareDatetime
