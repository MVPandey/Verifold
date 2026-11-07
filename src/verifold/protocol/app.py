"""The app protocol: what the person's UI reads from a lab, and what it sends."""

from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, StringConstraints

from verifold.protocol.agents import Agent, Label
from verifold.protocol.ids import PostId
from verifold.protocol.record import Record
from verifold.protocol.usage import Usage

MAX_MINUTES = 7 * 24 * 60
"""The longest time that the person can give a lab at once: one week."""

type AgentState = Literal['starting', 'working', 'waiting', 'idle', 'stopped']
"""`waiting` means the agent's harness waits for the person, as with a permission request."""


class AgentActivity(Record):
    """What an agent is doing now, from its harness's live updates. It is not part of the record."""

    state: AgentState = 'starting'
    detail: str = ''
    """The latest step that the harness reported, such as a tool call's title."""
    at: AwareDatetime | None = None


class AgentView(Record):
    """One agent as the person sees it: who it is, what it is doing, and what it has cost so far."""

    agent: Agent
    activity: AgentActivity
    turns: int = Field(ge=0)
    posts: int = Field(ge=0)
    usage: Usage
    cost_usd: float | None = None
    """The cost that the harness reported. `None` when the harness reports tokens only."""


class LabView(Record):
    """The lab at a glance."""

    question: str
    opened_at: AwareDatetime
    seq: int
    agents: tuple[AgentView, ...]
    threads: int
    posts: int
    needs_you: int
    ends_at: AwareDatetime | None = None
    """When the agents stop. `None` means no time limit."""
    out_of_time: bool = False
    """The lab reached its end. Its agents wait until the person gives it more time."""


class RerunRequest(Record):
    """The person asks for a blind rerun of a post."""

    post: PostId


class HarnessOption(Record):
    """A harness that the setup screen offers, and whether this computer has it."""

    name: Label
    family: Label
    available: bool


class SetupView(Record):
    """What the setup screen needs: the harnesses, and the lab that the folder holds, if any."""

    harnesses: tuple[HarnessOption, ...]
    question: str | None = None
    """The question of the lab in this folder, or `None` when the folder has no lab yet."""


class AgentChoice(Record):
    """How many agents of one harness to start, and with which model and effort."""

    harness: Label
    count: int = Field(default=1, ge=1, le=20)
    model: Label | None = None
    effort: Label | None = None


class StartRequest(Record):
    """The person starts a lab from the setup screen."""

    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000)]
    agents: tuple[AgentChoice, ...] = Field(min_length=1)
    auto_mode: bool = True
    minutes: int | None = Field(default=None, ge=1, le=MAX_MINUTES)
    """How long the agents may work. `None` means no time limit."""


class TimeRequest(Record):
    """The person sets how long the lab's agents may still work, from now. Zero stops them now."""

    minutes: int = Field(ge=0, le=MAX_MINUTES)
