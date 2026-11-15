"""
The events of the society record.

A lab's record is its events in order. Each event has a sequence number and a time, and the board is what the events
add up to. Events are never changed or removed.
"""

from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints

from verifold.protocol.agents import Agent, Role, Status, one_line
from verifold.protocol.grants import Grant
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


type Reason = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=200)]
"""Why an agent left its lab, as one line. It can be empty."""


class AgentLeft(EventBase):
    """
    An agent left the lab, or the person removed it. It is final: the agent's ID never comes back.

    The agent's posts stay. From now on the record takes no post and no other change from it, no post reaches it,
    and it does not count among the lab's agents.
    """

    type: Literal['agent_left'] = 'agent_left'
    agent: AgentId
    by: AgentId
    """Who caused it: the agent itself, or the person."""
    reason: Reason = ''


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


class ProfileSet(EventBase):
    """
    An agent said what it is to the lab and what it does now, in its own words.

    `role` is an organizational word that the agent picks, such as "theory" or "keeps the map". Two agents can have
    the same one. `status` is one line about the agent's present work. `None` leaves a field as it was, and an
    empty text clears it. The code never acts on either: they are for the other agents and the person to read.
    """

    type: Literal['profile_set'] = 'profile_set'
    agent: AgentId
    role: Role | None = None
    status: Status | None = None


MAX_ALARM_MINUTES = 24 * 60
"""The longest time that an agent can set an alarm for: one day."""


class AlarmSet(EventBase):
    """
    An agent asked Verifold to wake it when it is not in a turn and no post for it wakes it first.

    With `quiet`, the alarm rings when the board got no post for `minutes`. Without, it rings `minutes` after the
    agent set it. An agent has one alarm: a new one replaces it, and zero minutes cancels it. The alarm stays until
    it rings. A turn that starts for another reason does not spend it. When its time comes while a turn of the
    agent runs, it rings when that turn ends.
    """

    type: Literal['alarm_set'] = 'alarm_set'
    agent: AgentId
    minutes: float = Field(ge=0, le=MAX_ALARM_MINUTES)
    quiet: bool = False
    stays: bool = False
    """
    Whether the alarm stays until it rings. An alarm from before Verifold kept alarms across turns has `False`: it
    is spent when the agent's next turn starts, as its agent was told, and the record does not say whether it rang.
    """


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


class WentQuiet(EventBase):
    """
    A mark from an earlier version of Verifold, which told the agents when the whole lab had gone quiet.

    Verifold records it no longer, because when to work is each agent's own decision. Old records still hold it.
    """

    type: Literal['went_quiet'] = 'went_quiet'
    seconds: float = Field(gt=0)


type SessionId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
"""The ID that a harness gave an agent's conversation. With it, the harness can load the conversation again."""


class TurnStarted(EventBase):
    """
    Verifold sent an agent a message, so a turn of the agent's harness started.

    A turn that has a start and no end did not end: Verifold stopped or failed while the turn ran. `session` lets
    Verifold load the agent's conversation again after a restart. No view of the board shows it.
    """

    type: Literal['turn_started'] = 'turn_started'
    agent: AgentId
    session: SessionId
    seen: int = Field(ge=0)
    """The last event that the agent had got when the turn started."""
    rang: int | None = Field(default=None, ge=1)
    """The sequence number of the agent's alarm that rang with the message of this turn, or `None`."""


class TurnSummary(Record):
    """What one agent turn cost, how it ended, and the snapshot of the agent's folder after it."""

    agent: AgentId
    seconds: float = Field(ge=0)
    usage: Usage
    cost_usd: float | None = None
    error: str | None = None
    snapshot: CommitId | None = None
    """The commit of the agent's folder after the turn, which other agents and checks can read."""
    rerun_failed: bool = False
    """Whether a blind checker's rerun ended here without a check. The requests that the rerun had get no check."""
    seen: int | None = Field(default=None, ge=0)
    """The last event that the agent had got when the turn ended. `None` in a record from before Verifold kept it."""
    stopped: bool = False
    """Whether Verifold stopped the agent here, because its harness failed too often in a row."""
    no_turn: bool = False
    """
    Whether the harness failed outside a turn, such as when it started. The entry then ends no turn: it keeps the
    error for the person, and the agent's last turn is the one before it.
    """


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


class PermissionGranted(EventBase):
    """
    The person lets every agent of the lab run the commands that start with `prefix`.

    Verifold then answers a harness's permission request for such a command itself. No agent tool records a grant.
    """

    type: Literal['permission_granted'] = 'permission_granted'
    prefix: Grant


type Event = Annotated[
    LabOpened
    | AgentJoined
    | AgentLeft
    | ThreadOpened
    | Posted
    | WatchSet
    | ProfileSet
    | AlarmSet
    | TurnStarted
    | TurnEnded
    | RerunRequested
    | TimeSet
    | TimeRanOut
    | WentQuiet
    | SettingsSet
    | PermissionGranted,
    Field(discriminator='type'),
]
