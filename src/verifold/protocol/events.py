"""
The events of the society record.

A lab's record is its events in order. Each event has a sequence number and a time, and the board is what the events
add up to. Events are never changed or removed.
"""

from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, StringConstraints

from verifold.protocol.agents import Agent
from verifold.protocol.ids import AgentId, ThreadId
from verifold.protocol.posts import Post
from verifold.protocol.record import Record
from verifold.protocol.threads import Thread


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


type Event = Annotated[LabOpened | AgentJoined | ThreadOpened | Posted | WatchSet, Field(discriminator='type')]
