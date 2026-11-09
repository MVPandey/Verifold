"""The agents of a lab."""

from typing import Annotated

from pydantic import StringConstraints

from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.record import Record

type Label = Annotated[str, StringConstraints(min_length=1, max_length=40)]


class ModelSpec(Record):
    """
    The model behind an agent.

    Blind checks compare `family`: a check counts as independent only when its model comes from another family.
    """

    family: Label
    name: Label | None = None
    """The model's name, or `None` for the harness's default model."""
    effort: Label | None = None
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
    recruited_by: AgentId | None = None
    checks: PostId | None = None
    """For a blind checker that Verifold starts: the post that it reruns. It posts one check and reads nothing else."""
