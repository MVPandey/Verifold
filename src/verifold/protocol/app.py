"""The app protocol: what the person's UI reads from a lab, and what it sends."""

from typing import Literal

from pydantic import AwareDatetime, Field

from verifold.protocol.agents import Agent
from verifold.protocol.ids import PostId
from verifold.protocol.record import Record
from verifold.protocol.usage import Usage

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


class RerunRequest(Record):
    """The person asks for a blind rerun of a post."""

    post: PostId
