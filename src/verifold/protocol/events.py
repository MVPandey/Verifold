"""
The events of the society record.

A lab's record is its events in order. Each event has a sequence number and a time, and the board is what the events
add up to. Events are never changed or removed.
"""

from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, StringConstraints

from verifold.protocol.agents import Agent
from verifold.protocol.ids import AgentId, CommitId, PostId, ThreadId
from verifold.protocol.posts import Post
from verifold.protocol.record import Record
from verifold.protocol.threads import Thread
from verifold.protocol.usage import Usage


class EventBase(Record):
    """The fields that every event has."""

    seq: int = Field(ge=1)
    at: AwareDatetime


class LabOpened(EventBase):
    """The first event of every record. `version` is the version of the record format."""

    type: Literal['lab_opened'] = 'lab_opened'
    version: Literal[1] = 1
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000)]


class AgentJoined(EventBase):
    """An agent joined the lab."""

    type: Literal['agent_joined'] = 'agent_joined'
    agent: Agent


class ThreadOpened(EventBase):
    """A thread opened."""

    type: Literal['thread_opened'] = 'thread_opened'
    thread: Thread


class Posted(EventBase):
    """A post went on the board."""

    type: Literal['posted'] = 'posted'
    post: Post


class WatchSet(EventBase):
    """An agent started or stopped watching a thread. Every post in a watched thread wakes the agent."""

    type: Literal['watch_set'] = 'watch_set'
    agent: AgentId
    thread: ThreadId
    watching: bool


class RerunRequested(EventBase):
    """An agent or the person asked for a blind rerun of a post. Verifold answers it by starting a checker."""

    type: Literal['rerun_requested'] = 'rerun_requested'
    by: AgentId
    post: PostId


class TurnSummary(Record):
    """What one agent turn cost, how it ended, and the snapshot of the agent's folder after it."""

    agent: AgentId
    seconds: float = Field(ge=0)
    usage: Usage
    cost_usd: float | None = None
    error: str | None = None
    snapshot: CommitId | None = None
    """The commit of the agent's folder after the turn, which other agents and checks can read."""


class TurnEnded(EventBase, TurnSummary):
    """An agent's harness ended a turn. The record keeps what the turn cost and why it failed, if it did."""

    type: Literal['turn_ended'] = 'turn_ended'


type Event = Annotated[
    LabOpened | AgentJoined | ThreadOpened | Posted | WatchSet | TurnEnded | RerunRequested,
    Field(discriminator='type'),
]
