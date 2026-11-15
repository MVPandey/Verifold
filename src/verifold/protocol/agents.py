"""The agents of a lab."""

import re
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, Field, StringConstraints, field_validator, model_validator

from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.record import Record

type Label = Annotated[str, StringConstraints(min_length=1, max_length=40)]

type ValueId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
"""The ID of a value that a harness offers, such as a model. A cloud provider's model IDs can be long."""


def _printable(text: str) -> str:
    if one_line(text) != text:
        raise ValueError(
            f'{text!r} is not one printable line. Give it without line breaks, control characters, invisible '
            'characters, or spaces at its ends or in a row.'
        )
    return text


type TypedId = Annotated[ValueId, AfterValidator(_printable)]
"""
A model, an effort, or a mode that the person typed or saved, as the harness names it. It is one printable line,
because an agent's name can show it. A value that is not one is refused, not changed: the harness would get another ID.
"""

type Name = Annotated[str, AfterValidator(one_line), StringConstraints(min_length=1, max_length=120)]
"""
An agent's display name, as one printable line. A name that Verifold builds holds the harness's title and the
model's name.
"""

type Family = Annotated[str, AfterValidator(one_line), StringConstraints(min_length=1, max_length=40)]
"""A model family that the person states, as one printable line."""


def same_family(one: str, other: str) -> bool:
    """Return whether two model families are the same, whatever their capitals and the spaces around them."""
    return one.strip().casefold() == other.strip().casefold()


def one_line(text: str) -> str:
    """Return the text as one printable line: no line breaks, control characters, or marks that change how it reads."""
    kept = ''.join(mark if mark.isprintable() else ' ' for mark in text)
    return ' '.join(kept.split())


type Role = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=40)]
"""What an agent says that it is to the lab, in its own words, as one line."""

type Status = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=140)]
"""What an agent says that it does now, in one line."""


MIN_CHOSEN_NAME = 2
MAX_CHOSEN_NAME = 24
_CHOSEN = re.compile(r"[A-Za-z0-9]+(?:[ '-][A-Za-z0-9]+)*")


def _chosen(name: str) -> str:
    # An empty name takes the chosen name back, so the seat's label is the name again.
    if not name:
        return name
    if not MIN_CHOSEN_NAME <= len(name) <= MAX_CHOSEN_NAME:
        raise ValueError(f'A name has {MIN_CHOSEN_NAME} to {MAX_CHOSEN_NAME} characters, and {name!r} has {len(name)}.')
    if not _CHOSEN.fullmatch(name):
        raise ValueError(
            f'{name!r} is not a name. A name holds the letters a to z and digits, with one space, hyphen, or '
            'apostrophe between them.'
        )
    return name


type ChosenName = Annotated[str, AfterValidator(one_line), AfterValidator(_chosen)]
"""
The name that an agent chooses for itself, as one printable line of 2 to 24 characters: the letters a to z in
either case and digits, with single spaces, hyphens, and apostrophes between them. Only these characters, so that
no name looks like another through a letter of another alphabet. An empty text takes the chosen name back.
"""

MAX_ABOUT = 240
type About = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=MAX_ABOUT)]
"""
What lens an agent brings: its field and how it approaches a problem, in one or two sentences on one line. An empty
text clears it.
"""

type Shape = Literal['square', 'circle', 'hex', 'diamond', 'arch', 'triangle']
type Color = Literal['#f08c3a', '#3d9be9', '#e05a9c', '#3fb56b', '#e3b341', '#2bb3a3', '#e8674f', '#7d8bd9']
type Symbol = Literal['wave', 'dots', 'arrow', 'fork', 'bars', 'ring', 'plus', 'zigzag', 'orbit', 'slashes']


class Picture(Record):
    """An agent's picture: one shape of six, one color of eight, and one symbol of ten. The app draws it."""

    shape: Shape
    color: Color
    symbol: Symbol


type SeatMark = Literal['coordinator', 'reviewer', 'on_call']
"""A seat that an agent holds, as the record has it: the coordinator seat, a reviewer seat, or a seat on call."""


class ModelSpec(Record):
    """
    The model behind an agent.

    Blind checks compare `family`: a check counts as independent only when its model comes from another family.
    """

    family: Label
    """The family that the person stated for the agent's seat, or else the family of its harness's entry."""
    name: ValueId | None = None
    """The model's name, or `None` for the harness's default model."""
    effort: ValueId | None = None
    """The reasoning effort, or `None` for the harness's default."""


class Agent(Record):
    """One agent in the lab: a harness session with a model and a display name."""

    id: AgentId
    name: Name
    """
    Verifold builds it from the harness's title and the model's name, such as "Codex · gpt-6.1-sol", with a number
    when another agent has the same. An older record holds a name such as "Agent 3", and an invited agent has the
    name that the person gave it.
    """
    harness: Label
    model: ModelSpec
    role: Annotated[str, StringConstraints(max_length=40)] = ''
    brief: Annotated[str, StringConstraints(max_length=8_000)] = ''
    """Older records give agent 1 a planner's role and brief. Verifold no longer sets or sends either."""
    given_role: Role = ''
    """
    The role that the person gave the agent's seat when it joined, in the person's words, such as "driver". Empty
    when the person gave none. A later `profile_set` event can give another. The agent can still say what it is
    with `profile`, and the code never acts on either text.
    """
    mode: ValueId | None = None
    """The harness mode that the person chose for the agent. `None` follows the lab's auto mode choice."""
    model_listed: bool = True
    """
    `False` for a seat that a coordinator's move added with a model that the harness did not list. Its model's ID
    is the coordinator's text: it is in no name that Verifold builds, and it reserves no name, until the harness
    reports the model. `True` for every other seat, and in a record from before this field.
    """
    auto_mode: ValueId | None = None
    """
    The harness's own auto mode at the time the agent joined a lab in auto mode. The agent keeps it for the whole
    lab, also after Verifold's catalog changes. `None` in a lab without auto mode, for a harness without one, and
    in a record from before Verifold kept it.
    """
    recruited_by: AgentId | None = None
    checks: PostId | None = None
    """For a blind checker that Verifold starts: the post that it reruns. It posts one check and reads nothing else."""


GUEST = 'guest'
"""The harness of an agent that the person invited. It runs by itself, and Verifold starts no process for it."""

UNKNOWN_FAMILY = 'unknown'
"""
The model family of an invited agent when the person stated none. Verifold does not know its model, so no check of
its work is independent.
"""

MAX_AGENTS = 20
"""The most agents that one lab starts."""


type Power = Literal['time', 'permissions', 'agents', 'settings', 'question']
"""
A kind of move that the person can hand to the lab's coordinator: more time for the lab, the answers to other
agents' permission requests, one more agent or one fewer, a setting of the lab, or a revision of the question. Each
one is off until the person switches it on.

No power stops the lab, changes a power, or changes how Verifold handles permission requests.
"""

POWERS: tuple[Power, ...] = ('time', 'permissions', 'agents', 'settings', 'question')


class SeatFacts(Record):
    """What the person can say about an agent's seat when they add or invite the agent. Each part is optional."""

    role: Role = ''
    """The role that the person gives the seat, as one line, such as "driver". The code never acts on the text."""
    on_call: bool = False
    """
    Whether the seat is on call. No post for every agent wakes an on-call agent, and neither does a plain mention.
    An ask or a call that names it does, and so does a post that replies to it or builds on its post, the person's
    post that names it, and a post in a thread that it chose to watch.
    """
    coordinator: bool = False
    """Whether the seat's agent is the lab's coordinator. A lab has one coordinator at most."""
    powers: tuple[Power, ...] = ()
    """The powers that the person switches on for the coordinator from the start. Only the coordinator's seat has any."""
    family: Family | None = None
    """
    The model family of the seat's model. `None` takes the family of the harness's entry, or for an invited agent
    says that nobody stated one.
    """

    @model_validator(mode='after')
    def _powers_of_the_coordinator(self) -> Self:
        if self.powers and not self.coordinator:
            raise ValueError('Only the seat of the coordinator has powers.')
        return self

    @field_validator('family')
    @classmethod
    def _a_stated_family(cls, family: str | None) -> str | None:
        if family is not None and same_family(family, UNKNOWN_FAMILY):
            raise ValueError(
                f'`{UNKNOWN_FAMILY}` is how Verifold records a family that nobody stated. Leave the family out, or '
                'state the family.'
            )
        return family


class AgentChoice(SeatFacts):
    """
    One seat: how many agents of one harness to start, with which model, effort, and mode, and the seat's facts.

    A lab can have several seats of one harness, such as two models of it.
    """

    harness: Label
    count: int = Field(default=1, ge=1, le=MAX_AGENTS)
    model: TypedId | None = None
    effort: TypedId | None = None
    mode: TypedId | None = None
    """One of the harness's own modes. `None` follows the lab's auto mode choice."""

    @model_validator(mode='after')
    def _one_coordinator(self) -> Self:
        if self.coordinator and self.count > 1:
            raise ValueError('A lab has one coordinator, so the seat of the coordinator has one agent.')
        return self


def _within_limit(agents: tuple[AgentChoice, ...]) -> tuple[AgentChoice, ...]:
    if sum(agent.count for agent in agents) > MAX_AGENTS:
        raise ValueError(f'A lab starts at most {MAX_AGENTS} agents in all.')
    if sum(agent.coordinator for agent in agents) > 1:
        raise ValueError('A lab has one coordinator. Mark one seat as the coordinator.')
    return agents


type AgentChoices = Annotated[tuple[AgentChoice, ...], Field(min_length=1), AfterValidator(_within_limit)]
"""The seats that a lab starts with: at least one, at most `MAX_AGENTS` agents in all, and one coordinator at most."""
