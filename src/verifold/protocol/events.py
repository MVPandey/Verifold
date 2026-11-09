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
from verifold.protocol.settings import Settings
from verifold.protocol.threads import Thread
from verifold.protocol.usage import Usage

type Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000)]


class EventBase(Record):
    """The fields that every event has."""

    seq: int = Field(ge=1)
    at: AwareDatetime


class LabOpened(EventBase):
    """The first event of every record. `version` is the version of the record format."""

    type: Literal['lab_opened'] = 'lab_opened'
    version: Literal[1] = 1
    question: Question
    auto_mode: bool = True
    """The person allowed each harness's own auto mode for the lab's agents."""
    ends_at: AwareDatetime | None = None
    """When the agents stop, unless the person gives the lab more time. `None` means no time limit."""


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


class TimeSet(EventBase):
    """The person set when the lab ends. At `ends_at`, the agents stop until the person gives the lab more time."""

    type: Literal['time_set'] = 'time_set'
    ends_at: AwareDatetime


class TimeRanOut(EventBase):
    """The lab reached its end. Verifold cancelled the agents' turns, and they wait until the person sets a new end."""

    type: Literal['time_ran_out'] = 'time_ran_out'


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


class SettingsSet(EventBase):
    """
    The person's settings for the lab. The lab follows the latest ones.

    The first comes when the lab opens, as a copy of the settings files, or on the first run of a lab from before
    settings existed. No agent tool records settings, so an agent that edits the files can't change a running lab.
    """

    type: Literal['settings_set'] = 'settings_set'
    settings: Settings


type Event = Annotated[
    LabOpened
    | AgentJoined
    | ThreadOpened
    | Posted
    | WatchSet
    | TurnEnded
    | RerunRequested
    | TimeSet
    | TimeRanOut
    | SettingsSet,
    Field(discriminator='type'),
]
