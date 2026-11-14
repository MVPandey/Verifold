"""The agents of a lab."""

from typing import Annotated

from pydantic import AfterValidator, Field, StringConstraints

from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.record import Record

type Label = Annotated[str, StringConstraints(min_length=1, max_length=40)]


def _one_line(text: str) -> str:
    # One line of printable text: no line breaks, no control characters, and no marks that change how text reads.
    kept = ''.join(mark if mark.isprintable() else ' ' for mark in text)
    return ' '.join(kept.split())


type Role = Annotated[str, AfterValidator(_one_line), StringConstraints(max_length=40)]
"""What an agent says that it is to the lab, in its own words, as one line."""

type Status = Annotated[str, AfterValidator(_one_line), StringConstraints(max_length=140)]
"""What an agent says that it does now, in one line."""

type ValueId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
"""The ID of a value that a harness offers, such as a model. A cloud provider's model IDs can be long."""


class ModelSpec(Record):
    """
    The model behind an agent.

    Blind checks compare `family`: a check counts as independent only when its model comes from another family.
    """

    family: Label
    name: ValueId | None = None
    """The model's name, or `None` for the harness's default model."""
    effort: ValueId | None = None
    """The reasoning effort, or `None` for the harness's default."""


class Agent(Record):
    """One agent in the lab: a harness session with a model and a display name."""

    id: AgentId
    name: Label
    harness: Label
    model: ModelSpec
    role: Annotated[str, StringConstraints(max_length=40)] = ''
    brief: Annotated[str, StringConstraints(max_length=8_000)] = ''
    """Older records give agent 1 a planner's role and brief. Verifold no longer sets or sends either."""
    mode: ValueId | None = None
    """The harness mode that the person chose for the agent. `None` follows the lab's auto mode choice."""
    recruited_by: AgentId | None = None
    checks: PostId | None = None
    """For a blind checker that Verifold starts: the post that it reruns. It posts one check and reads nothing else."""


MAX_AGENTS = 20
"""The most agents that one lab starts."""


class AgentChoice(Record):
    """How many agents of one harness to start, and with which model, effort, and mode."""

    harness: Label
    count: int = Field(default=1, ge=1, le=MAX_AGENTS)
    model: ValueId | None = None
    effort: ValueId | None = None
    mode: ValueId | None = None
    """One of the harness's own modes. `None` follows the lab's auto mode choice."""


def _within_limit(agents: tuple[AgentChoice, ...]) -> tuple[AgentChoice, ...]:
    if sum(agent.count for agent in agents) > MAX_AGENTS:
        raise ValueError(f'A lab starts at most {MAX_AGENTS} agents in all.')
    return agents


type AgentChoices = Annotated[tuple[AgentChoice, ...], Field(min_length=1), AfterValidator(_within_limit)]
"""The agents that a lab starts: at least one, and at most `MAX_AGENTS` in all."""
