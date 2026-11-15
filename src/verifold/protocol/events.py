"""
The events of the society record.

A lab's record is its events in order. Each event has a sequence number and a time, and the board is what the events
add up to. Events are never changed or removed.
"""

from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints

from verifold.protocol.agents import (
    About,
    Agent,
    ChosenName,
    Name,
    Picture,
    Power,
    Role,
    Status,
    ValueId,
    one_line,
)
from verifold.protocol.grants import Grant
from verifold.protocol.ids import PERSON, AgentId, CommitId, PostId, ThreadId
from verifold.protocol.moves import Note, Question
from verifold.protocol.posts import Post
from verifold.protocol.record import Record
from verifold.protocol.settings import MAX_MINUTES, Settings
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
    question: Question
    auto_mode: bool = True
    """The person allowed each harness's own auto mode for the lab's agents."""
    ends_at: AwareDatetime | None = None
    """When the agents stop, unless the person gives the lab more time. `None` means no time limit."""


class QuestionRevised(EventBase):
    """
    The person revised the lab's question. The lab works on the newest text, and the record keeps every version.

    `post` is the post that tells the lab, which comes just before this event: the person's own, or the
    coordinator's post for the person when `by` names the coordinator. No agent tool records a revision by itself.
    """

    type: Literal['question_revised'] = 'question_revised'
    question: Question
    note: Note = ''
    post: PostId
    by: AgentId = PERSON
    """
    Who revised the question: the person, or the lab's coordinator while the person's power to revise the question
    is on. The person's is the default, and it is what a record from before this field holds.
    """
    request: PostId | None = None
    """
    The coordinator's request that the revision came from: the person said yes to it, or the power decided it.
    `None` for a revision that the person made by themselves.
    """


type Reason = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=200)]
"""A reason, as one line: why an agent left its lab, or why the coordinator flagged a profile. It can be empty."""


class AgentJoined(EventBase):
    """An agent joined the lab."""

    type: Literal['agent_joined'] = 'agent_joined'
    agent: Agent


class AgentNamed(EventBase):
    """
    Verifold learned which model an agent runs, and the agent's name says so from now on.

    An agent that starts with its harness's default model can join before Verifold knows the model's name. Its
    name then says "default model". When the agent's session opens and the harness reports the model, Verifold
    records the name with it, once. A name in a post's text reaches the agent under both names.
    """

    type: Literal['agent_named'] = 'agent_named'
    agent: AgentId
    name: Name


class OnCallSet(EventBase):
    """
    The person put an agent's seat on call, or took it off.

    An on-call agent is a member of the lab. No post for every agent wakes it: not the first post of a thread, not
    an ask or a call that names nobody, and not the person's post that names nobody. A plain mention in a plan, a
    message, a result, or another post that addresses nobody wakes it neither. An ask or a call that names it wakes
    it, and so does a post that replies to it or builds on its post, the person's post that names it, and a post in
    a thread that it chose to watch. No agent tool records this event.
    """

    type: Literal['on_call_set'] = 'on_call_set'
    agent: AgentId
    on_call: bool


class CoordinatorSet(EventBase):
    """
    The lab's coordinator changed: an agent holds the seat now, or nobody does.

    A lab has one coordinator at most. The person can give the seat to any agent and can clear it. The agent that
    holds the seat can give it up. An agent can take the seat for itself while the seat is free and open: nobody
    ever held it, its holder gave it up or left the lab by itself, or the person said that agents may take it. A
    seat that the person cleared, or whose holder the person removed, is closed to the agents until the person
    gives it to an agent or opens it. The code acts on nothing but who holds the seat: what a coordinator does is
    for the lab to decide.
    """

    type: Literal['coordinator_set'] = 'coordinator_set'
    agent: AgentId | None
    """The agent that holds the seat from now on, or `None` when nobody does."""
    by: AgentId
    """Who caused it: the person, or the agent itself."""
    open: bool = False
    """With no holder and from the person: whether an agent may take the seat by itself. It means nothing else."""


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
    through: AgentId | None = None
    """
    With `by` the person: the lab's coordinator, when it removed the agent with the power that the person switched
    on. `None` when the person removed the agent, also with a yes to a request of the coordinator.
    """
    request: PostId | None = None
    """
    The coordinator's request that the removal came from: the person said yes to it, or the power decided it. The
    request holds the coordinator's reason, and `reason` stays the word of the one in `by`.
    """


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
    A change to an agent's profile: what the agent is to the lab, in its own words, and what others set on it.

    `role` is an organizational word that the agent picks, such as "theory" or "keeps the map". Two agents can have
    the same one. `status` is one line about the agent's present work. `name` is the name that the agent chose,
    `about` says what lens it brings, and `picture` is its picture from parts. `None` leaves a field as it was, and
    an empty text clears it. The code never acts on any of these texts: they are for the other agents and the
    person to read.

    `by` is who made the change when the agent did not: the person, or the lab's coordinator. The person can take
    back the name, the about line, and the picture, and can give the seat a role. The coordinator can take back
    another agent's name, rewrite its about line, flag its profile with a reason, and give it a role where the
    person gave none. The record keeps every earlier text, and the agent can change its profile again afterwards.
    """

    type: Literal['profile_set'] = 'profile_set'
    agent: AgentId
    role: Role | None = None
    status: Status | None = None
    name: ChosenName | None = None
    """The name that the agent chose. An empty text takes it back, and the seat's label is the name again."""
    about: About | None = None
    picture: Picture | None = None
    no_picture: bool = False
    """Whether the change takes the agent's picture back, so that the agent has none."""
    by: AgentId | None = None
    """Who made the change, when the agent did not: `person`, or the agent that holds the coordinator seat."""
    given_role: Role | None = None
    """The role that `by` gives the agent's seat. An empty text takes it back."""
    flag: Reason | None = None
    """The coordinator's reason for a flag on the profile, as one line. An empty text takes the flag back."""


class ReviewerSet(EventBase):
    """
    An agent holds a reviewer seat from now on, or holds one no longer.

    A lab has a number of reviewer seats, which the person sets. An agent takes a free seat for itself and gives up
    the seat that it holds, and the person can give a seat to any agent or take it. A check of another agent's
    post and a request for an independent rerun of another agent's post take a reviewer seat. So does the taking
    of such a rerun, while an agent in a reviewer seat can take it.
    """

    type: Literal['reviewer_set'] = 'reviewer_set'
    agent: AgentId
    reviewer: bool
    by: AgentId
    """Who caused it: the person, or the agent itself."""


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
    """
    An agent or the person asked for an independent rerun of a post.

    That is a rerun from a clean copy of the post's files by another agent. The request starts nothing. It stays open until the check of such a rerun replies to the post. In a record from
    before agents took reruns, Verifold answered a request by starting a checker of its own.
    """

    type: Literal['rerun_requested'] = 'rerun_requested'
    by: AgentId
    post: PostId


class RerunTaken(EventBase):
    """
    An agent took the rerun of another agent's post that somebody asked for.

    Verifold gave the agent the clean copy of the post's files: plain files, exactly the ones of `commit`, in a
    folder of Verifold's own that no agent's folder holds. The agent's next check of the post with the method
    `rerun` and with files is the check of this take.
    """

    type: Literal['rerun_taken'] = 'rerun_taken'
    agent: AgentId
    post: PostId
    commit: CommitId
    """The commit that the post pins its files to, which the clean copy holds."""


class TimeSet(EventBase):
    """
    A new end of the lab. At `ends_at`, the agents stop until the lab gets more time.

    The person sets it. The coordinator's request for more time sets it too: with the person's yes, or at once
    while the person's power for more time is on.
    """

    type: Literal['time_set'] = 'time_set'
    ends_at: AwareDatetime
    request: PostId | None = None
    """The coordinator's request for more time that set this end, with its yes just before. `None` for the person's own."""


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
    model: ValueId | None = None
    """
    The model that the harness reported for the session when the turn started, as the harness's own ID for it.
    `None` when the harness reported none, and in a record from before Verifold kept it.
    """
    model_name: str | None = None
    """The name that the harness shows for that model."""


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
    """
    In a record from before agents took reruns: whether the rerun of a checker that Verifold started ended here
    without a check. Verifold sets it no longer.
    """
    seen: int | None = Field(default=None, ge=0)
    """The last event that the agent had got when the turn ended. `None` in a record from before Verifold kept it."""
    stopped: bool = False
    """Whether Verifold stopped the agent here, because its harness failed too often in a row."""
    no_turn: bool = False
    """
    Whether the harness failed outside a turn, such as when it started. The entry then ends no turn: it keeps the
    error for the person, and the agent's last turn is the one before it.
    """


ERROR_MODEL_REFUSED = 'ModelRefused'
"""How the error of a harness that refused the model that the lab set starts."""

ERROR_OUT_OF_TIME = 'The lab ran out of time'
"""How the error of a turn that Verifold cancelled at the lab's end starts."""

ERROR_RAN_PAST = 'The turn ran past'
"""How the error of a turn that Verifold cancelled at the limit for one turn starts."""


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
    request: PostId | None = None
    """The coordinator's request for a setting that these settings came from, with its yes just before. `None` otherwise."""


class PermissionGranted(EventBase):
    """
    The person lets every agent of the lab run the commands that start with `prefix`.

    Verifold then answers a harness's permission request for such a command itself. No agent tool records a grant.
    """

    type: Literal['permission_granted'] = 'permission_granted'
    prefix: Grant


class PowerSet(EventBase):
    """
    The person switched a power of the lab's coordinator on or off.

    A power is one kind of move that only the person makes otherwise. While it is on, a request of the coordinator
    for a move of that kind takes effect at once. Every power is off until the person switches it on, and all of
    them are off again when the coordinator seat changes: when the person gives it to another agent or clears it,
    and when its holder gives it up or leaves the lab. No agent tool records this event.
    """

    type: Literal['power_set'] = 'power_set'
    power: Power
    on: bool
    agent: AgentId
    """The agent that holds the coordinator seat, which the power is for."""


class RequestAnswered(EventBase):
    """
    The answer to a coordinator's request for a move: the person's yes or no, or the yes of a power that is on.

    With a yes, the events that make the move follow this one in the record, so the record says that the move came
    from the request. Without this event, a request changes nothing.
    """

    type: Literal['request_answered'] = 'request_answered'
    request: PostId
    yes: bool
    by: AgentId = PERSON
    """Who answered: the person, or the coordinator itself while the person's power for this kind of move is on."""
    minutes: int | None = Field(default=None, ge=1, le=MAX_MINUTES)
    """With the person's yes to more time: the minutes that the person gave, when not the minutes of the request."""


type Event = Annotated[
    LabOpened
    | QuestionRevised
    | AgentJoined
    | AgentNamed
    | OnCallSet
    | CoordinatorSet
    | AgentLeft
    | ThreadOpened
    | Posted
    | WatchSet
    | ProfileSet
    | ReviewerSet
    | AlarmSet
    | TurnStarted
    | TurnEnded
    | RerunRequested
    | RerunTaken
    | TimeSet
    | TimeRanOut
    | WentQuiet
    | SettingsSet
    | PermissionGranted
    | PowerSet
    | RequestAnswered,
    Field(discriminator='type'),
]
