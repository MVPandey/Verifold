"""The agents of a lab."""

from typing import Annotated, Self

from pydantic import AfterValidator, Field, StringConstraints, model_validator

from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.record import Record

type Label = Annotated[str, StringConstraints(min_length=1, max_length=40)]

type Name = Annotated[str, StringConstraints(min_length=1, max_length=120)]
"""An agent's display name. A name that Verifold builds holds the harness's title and the model's name."""


def one_line(text: str) -> str:
    """Return the text as one printable line: no line breaks, control characters, or marks that change how it reads."""
    kept = ''.join(mark if mark.isprintable() else ' ' for mark in text)
    return ' '.join(kept.split())


type Role = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=40)]
"""What an agent says that it is to the lab, in its own words, as one line."""

type Status = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=140)]
"""What an agent says that it does now, in one line."""

type ValueId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
"""The ID of a value that a harness offers, such as a model. A cloud provider's model IDs can be long."""


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
    The role that the person gave the agent's seat, in the person's words, such as "driver". Empty when the person
    gave none. The agent can still say what it is with `profile`, and the code never acts on either text.
    """
    mode: ValueId | None = None
    """The harness mode that the person chose for the agent. `None` follows the lab's auto mode choice."""
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


class SeatFacts(Record):
    """What the person can say about an agent's seat when they add or invite the agent. Each part is optional."""

    role: Role = ''
    """The role that the person gives the seat, as one line, such as "driver". The code never acts on the text."""
    on_call: bool = False
    """
    Whether the seat is on call. No post for every agent wakes an on-call agent. A post that names it, replies to
    it, or builds on its post does, and so does a post in a thread that it chose to watch.
    """
    coordinator: bool = False
    """Whether the seat's agent is the lab's coordinator. A lab has one coordinator at most."""
    family: Label | None = None
    """The model family of the seat's model. `None` takes the family of the harness's entry."""


class AgentChoice(SeatFacts):
    """
    One seat: how many agents of one harness to start, with which model, effort, and mode, and the seat's facts.

    A lab can have several seats of one harness, such as two models of it.
    """

    harness: Label
    count: int = Field(default=1, ge=1, le=MAX_AGENTS)
    model: ValueId | None = None
    effort: ValueId | None = None
    mode: ValueId | None = None
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
