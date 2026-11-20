"""
The events of the society record.

A lab's record is its events in order. Each event has a sequence number and a time, and the board is what the events
add up to. Events are never changed or removed.
"""

from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints, WithJsonSchema

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
from verifold.protocol.allowances import AllowanceId, AllowanceTerms
from verifold.protocol.deliverables import Decision, Sentence
from verifold.protocol.grants import Grant
from verifold.protocol.ids import PERSON, AgentId, CommitId, DeliverableId, PostId, ThreadId
from verifold.protocol.moves import Note, PaceMove, Question
from verifold.protocol.posts import Post
from verifold.protocol.record import Record, by_person, unset
from verifold.protocol.settings import MAX_BUDGET_DOLLARS, MAX_BUDGET_TOKENS, MAX_MINUTES, Settings
from verifold.protocol.threads import Thread
from verifold.protocol.usage import SeatLimits, Usage
from verifold.protocol.votes import Badge, BadgeAction, Direction, Why


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
    coordinator's or the desk's post for the person when `by` names one of them. No agent tool records a revision
    by itself.
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
    on: PostId | None = Field(default=None, exclude_if=unset)
    """
    With `by` the lab's desk: the person's post in the desk chat that the revision rests on. `None` for every other
    revision.
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
    an ask, a call, or a task that names nobody, and not the person's post that names nobody. A plain mention in a plan, a
    message, a result, or another post that addresses nobody wakes it neither. An ask, a call, or a task that names it wakes
    it, and so does a post that replies to it or builds on its post, the person's post that names it, and a post in
    a thread that it chose to watch. No agent tool records this event.
    """

    type: Literal['on_call_set'] = 'on_call_set'
    agent: AgentId
    on_call: bool


class DeskSet(EventBase):
    """
    The person made an agent's seat the lab's desk, in the step in which the agent joined.

    The desk answers the person in the desk chat, and it acts on the person's word: each of its actions names the
    person's post in the desk chat that it rests on. It is no part of the lab's work. Only a post of the person in
    the desk chat wakes it, it counts for no round, no close, and no reviewer seat, and the board takes no plan,
    result, check, proposal, ruled-out lead, objection, close, entry, vote, badge, or take of a rerun from it. A
    lab has one desk at most. No agent tool records this event.
    """

    type: Literal['desk_set'] = 'desk_set'
    agent: AgentId


class ActingSet(EventBase):
    """
    The person made an agent's seat an acting seat, or took the mark back.

    An acting seat acts in the world with a key of its own. Only an acting seat holds an allowance and declares an
    action with `act`. The coordinator and the desk are never acting seats, and neither is an invited agent, whose
    turns Verifold cannot stop. No agent tool records this event.
    """

    type: Literal['acting_set'] = 'acting_set'
    agent: AgentId
    acting: bool


class ModeSet(EventBase):
    """
    The person changed the harness mode of an agent's seat in a lab that runs.

    The seat keeps this mode from now on. When the session of its harness runs in another mode, Verifold starts the
    session again in this one before the seat's next turn. No agent tool records this event.
    """

    type: Literal['mode_set'] = 'mode_set'
    agent: AgentId
    mode: ValueId


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


MAX_SEAT_NOTES = 6_000
"""
The most characters of a seat's notes. The seat's every brief carries them whole, and a brief is one tool result, so
the notes have a limit.
"""


def _fits_the_notes(text: str) -> str:
    # The schema's own error for `max_length` names the limit and not the length, so the agent cannot tell how much
    # to cut.
    if len(text) > MAX_SEAT_NOTES:
        raise ValueError(f'The notes have {len(text)} characters, and the limit is {MAX_SEAT_NOTES}.')
    return text


type SeatNotes = Annotated[
    str, AfterValidator(_fits_the_notes), WithJsonSchema({'type': 'string', 'maxLength': MAX_SEAT_NOTES})
]
"""The text of a seat's notes, `MAX_SEAT_NOTES` characters at most. An empty text means that the seat has none."""


class NotesSet(EventBase):
    """
    A seat's notes from now on: a text that the seat's agent wrote for itself, in place of its earlier notes.

    The board shows a seat's notes to that seat's agent in its brief and to the person in the app, and the record
    keeps every earlier text. The code never acts on the text. The desk can keep notes too.
    """

    type: Literal['notes_set'] = 'notes_set'
    agent: AgentId
    text: SeatNotes = ''


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
    manifest: Annotated[str, StringConstraints(pattern=r'^[0-9a-f]{64}$')] | None = None
    """
    The SHA-256 of the clean copy's manifest as Verifold gave it to the agent: one line for each file, with the
    SHA-256 of the file's bytes and its path. `None` in a record from before Verifold kept it.
    """


class RerunLeaseSet(EventBase):
    """
    An agent that took the rerun of a post renewed its lease on it, or gave it up.

    The take gives the agent a lease for the minutes that the lab's settings held then. With `held`, the lease
    starts again at this event, for the minutes that the settings hold then. Without it, the lease ends here. The
    lease also ends at its time, at the check of the take, at the check that settles the rerun, and when the agent
    leaves the lab. While it stands, it keeps every other agent from the rerun, with one exception: while no
    holder is of another model family than the post, an agent of another family can take it. The record refuses a
    renewal that another agent's lease keeps out.
    """

    type: Literal['rerun_lease_set'] = 'rerun_lease_set'
    agent: AgentId
    post: PostId
    held: bool


class TaskClaimed(EventBase):
    """
    An agent claimed a task, or renewed the claim that it holds.

    A claim makes the agent the one that holds the task, with a lease for the minutes that the lab's settings held
    then. A post of the holder that replies to the task, builds on it, or is in the thread that the task opened
    starts the lease again while it stands, and so does this event again. The lease ends at its time, at the
    holder's hand-back or ruled-out lead that replies to the task, at the author's withdrawal of the task, and when
    the holder leaves. While it stands, the record refuses a claim of the task from every other agent. An agent
    holds one claim at a time, and the author of a task claims it never.
    """

    type: Literal['task_claimed'] = 'task_claimed'
    agent: AgentId
    task: PostId


class ClaimLapsed(EventBase):
    """
    The lease of a claim ended at its time, so the task is open again for any agent but its author.

    Verifold records it once for each claim whose lease ended at `until` with no hand-back, no ruled-out lead of
    the holder, and no withdrawal before it. A claim whose time passed while Verifold was stopped lapses when
    Verifold serves the lab again, and its lease ended for every view at `until` already. No agent tool records
    this event.
    """

    type: Literal['claim_lapsed'] = 'claim_lapsed'
    agent: AgentId
    task: PostId
    until: AwareDatetime
    """When the lease ended."""


class AllowanceDrafted(EventBase):
    """
    A draft of an allowance: what the person lets one acting seat do in the world without a question to them.

    The person drafts one, or the lab's desk does on the person's word, with `on`. A draft allows nothing. It starts
    only when the person confirms it with `allowance_started`, and no agent tool records that event or any change
    of an allowance after it. A newer draft for the same seat stands beside the older one, and the person confirms
    the one that they want.
    """

    type: Literal['allowance_drafted'] = 'allowance_drafted'
    allowance: AllowanceId
    terms: AllowanceTerms
    by: AgentId = Field(default=PERSON, exclude_if=by_person)
    """Who drafted it: the person, or the lab's desk on the person's word."""
    on: PostId | None = Field(default=None, exclude_if=unset)
    """With `by` the desk: the person's post in the desk chat that the draft rests on."""


class AllowanceStarted(EventBase):
    """
    The person confirmed a draft of an allowance.

    The allowance is in force until its end, until the person ends it, or until the person starts another one for the
    same seat. No agent tool records this event.
    """

    type: Literal['allowance_started'] = 'allowance_started'
    allowance: AllowanceId


class AllowanceEnded(EventBase):
    """
    The person ended an allowance.

    It allows nothing more. An action that was done stays done: the board undoes nothing in the world. No agent tool
    records this event.
    """

    type: Literal['allowance_ended'] = 'allowance_ended'
    allowance: AllowanceId


class ActionsPaused(EventBase):
    """
    The person paused every action of the lab, or let actions go on.

    While actions are paused, the board takes no action from any seat. No agent tool records this event.
    """

    type: Literal['actions_paused'] = 'actions_paused'
    paused: bool


class ActionDecided(EventBase):
    """
    The person's answer to an action that waits for them, before its offer ends.

    `post` is the person's post that replies to the action, which comes just before this event, so the action's
    author hears the answer. A yes lets the author do the action, and it draws nothing from an allowance. No agent
    tool records this event.
    """

    type: Literal['action_decided'] = 'action_decided'
    action: PostId
    yes: bool
    post: PostId


type RoundEnd = Literal['time', 'entered', 'opener']
"""
Why a round closed. `time`: its minutes passed by the lab's clock. `entered`: every agent of the lab that is not on
call and has not left had entered. `opener`: its opener withdrew it with a ruled-out lead that replies to it.
"""


class RoundClosed(EventBase):
    """
    A round closed, and its entries show to every agent from now on.

    Verifold records it when the round's time comes, or in the step of the event that makes the round's end true:
    the last entry, the opener's ruled-out lead, or a change of the lab's agents. A round whose time passed while
    Verifold was stopped closes when Verifold serves the lab again. No agent tool records this event. A record from
    before rounds holds neither this event nor a round, so it loads and folds as before. A Verifold from before
    rounds cannot read a record that holds either.
    """

    type: Literal['round_closed'] = 'round_closed'
    round: PostId
    why: RoundEnd


class TimeSet(EventBase):
    """
    A new end of the lab. At `ends_at`, the agents stop until the lab gets more time.

    The person sets it. The coordinator's request for more time sets it too: with the person's yes, or at once
    while the person's power for more time is on. So does the lab's desk on the person's word, with `on`.
    """

    type: Literal['time_set'] = 'time_set'
    ends_at: AwareDatetime
    request: PostId | None = None
    """The coordinator's request for more time that set this end, with its yes just before. `None` for the person's own."""
    by: AgentId = Field(default=PERSON, exclude_if=by_person)
    """Who set this end: the person, or the lab's desk on the person's word. A record from before this field holds the person."""
    on: PostId | None = Field(default=None, exclude_if=unset)
    """With `by` the desk: the person's post in the desk chat that this end rests on."""


class TimeRanOut(EventBase):
    """The lab reached its end. Verifold cancelled the agents' turns, and they wait until the person sets a new end."""

    type: Literal['time_ran_out'] = 'time_ran_out'


class BudgetSet(EventBase):
    """
    The person set the lab's budget, which replaces the earlier one, or the lab's desk did on the person's word.

    The lab has spent what the harnesses reported at the ends of its turns: in tokens, the input and the output
    tokens of `turn_ended.usage` together, and in dollars, the `cost_usd` of the turns whose harness reports a
    cost. When what it spent reaches a budget, the agents stop as at the time limit, until the person sets a budget
    that the lab has not spent. A record from before budgets holds no such event, and its lab has no budget.
    """

    type: Literal['budget_set'] = 'budget_set'
    tokens: int | None = Field(default=None, ge=1, le=MAX_BUDGET_TOKENS)
    """The budget in tokens. `None` means no budget in tokens."""
    dollars: float | None = Field(default=None, gt=0, le=MAX_BUDGET_DOLLARS)
    """The budget in US dollars. `None` means no budget in dollars."""
    by: AgentId = Field(default=PERSON, exclude_if=by_person)
    """Who set it: the person, or the lab's desk on the person's word. A record from before this field holds the person."""
    on: PostId | None = Field(default=None, exclude_if=unset)
    """With `by` the desk: the person's post in the desk chat that this budget rests on."""


type Limit = Literal['tokens', 'dollars', 'disk']
"""
A limit of the lab other than its time. `tokens` and `dollars`: what the lab spent reached its budget. `disk`: the
lab's files reached its disk limit.
"""

type Halt = Literal['time'] | Limit
"""Why the agents of a lab stop: its time ran out, or it reached one of its other limits."""


class LimitReached(EventBase):
    """
    The lab reached its budget or its disk limit. Verifold cancelled the agents' turns, and they wait.

    The record says so once for each time that the lab reaches a limit. For `tokens` and `dollars` it stands until
    the person sets the budget again, and for `disk` until the person changes the disk limit. When the lab still
    has reached the limit then, the record says so again at once.
    """

    type: Literal['limit_reached'] = 'limit_reached'
    limit: Limit
    disk_bytes: int | None = Field(default=None, ge=0)
    """With `disk`: the bytes of the lab's files that Verifold measured."""


class LimitsReported(EventBase):
    """
    The usage limits of the provider behind an agent's seat, as its harness reported them.

    Verifold records them when they changed since the record's last report for the seat: at the end of a turn,
    and at once during a turn when a window passes 50, 80, or 95 percent or the status changes. A harness that
    reports no limits gives its seat no such event. No agent tool records this event.
    """

    type: Literal['limits_reported'] = 'limits_reported'
    agent: AgentId
    limits: SeatLimits


class PaceSet(EventBase):
    """
    A move of pace: the pause of a seat, its end, or a limit of tokens for one hour, of a seat or of the lab.

    `by` made it: the person, also with a yes to the coordinator's request, or the coordinator under the person's
    power for pace. The coordinator's own move only lowers. It pauses another seat than the desk, sets a limit no
    higher than a limit that the person set and the lab's budget in tokens, and ends only a pause or a limit that
    the coordinator made. A move of the person replaces the coordinator's of the same kind for the same seat or the
    lab. The move holds one line of why. No agent tool records this event without a request.
    """

    type: Literal['pace_set'] = 'pace_set'
    move: PaceMove
    by: AgentId = Field(default=PERSON, exclude_if=by_person)
    request: PostId | None = Field(default=None, exclude_if=unset)
    """The coordinator's request that the move came from, with its yes just before. `None` for the person's own."""


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
    """
    The commit of the agent's folder after the turn. It is in the Git directory of Verifold's own. In a record from
    before that directory held the snapshots, it is in the repository of the agent's folder.
    """
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

ERROR_AT_LIMIT = 'The lab reached its'
"""How the error of a turn that Verifold cancelled at the lab's budget or disk limit starts."""
ERROR_INTERRUPTED = 'The desk ended the turn for the person'
"""How the error of a turn that Verifold cancelled for the lab's desk starts."""


class TurnInterrupted(EventBase):
    """
    The lab's desk ended an agent's turn for the person, so that the agent starts a new turn and reads its news now.

    Verifold cancels the turn as it cancels a turn at the limit for one turn, and the end of the turn says why. The
    agent then starts one more turn. `on` is the person's post in the desk chat that the interrupt rests on.
    """

    type: Literal['turn_interrupted'] = 'turn_interrupted'
    agent: AgentId
    by: AgentId
    """The agent that holds the desk seat."""
    on: PostId


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


class Voted(EventBase):
    """
    An agent or the person voted on a post, or took its vote back.

    A voter has one vote on a post: this one replaces its earlier one, and `none` takes it back. A vote up or down
    has a reason. Nobody votes on its own post, and a request of a harness, a request for a move, and the person's
    decision about an offer take no vote. A vote changes nothing else on the board and wakes nobody.
    """

    type: Literal['voted'] = 'voted'
    by: AgentId
    """The voter: an agent, or `person`."""
    post: PostId
    direction: Direction
    reason: Why = ''


class BadgeSet(EventBase):
    """
    A change to a badge on a post: somebody gave it, seconded it, or took it back.

    A badge is about an agent's work: no post of the person takes one, and neither does a request. `promising` and
    `confirmed` come from any agent but the post's author, and from the person. A `confirmed` from an agent names
    in `proof` a check of the post that holds. An agent but the author proposes `breakthrough` with `give`, and
    it stands when the person seconds it, or the agent to which the person gave the coordinator seat before the
    proposal. That agent seconds no proposal of its own, and nobody seconds for its own post. A giver takes its own
    badge back, and the person takes any badge back. A giver gives one kind of badge to one post `MAX_GIVES` times
    at most. A badge changes nothing else on the board and wakes nobody.
    """

    type: Literal['badge_set'] = 'badge_set'
    by: AgentId
    """Who made the change: an agent, or `person`."""
    post: PostId
    badge: Badge
    action: BadgeAction = 'give'
    reason: Why = ''
    """Why. A `give` has one. A `second` can have one."""
    proof: PostId | None = None
    """With `give` of `confirmed`: a check of the post with the outcome `holds`, from another agent than its author."""
    giver: AgentId | None = None
    """
    Whose badge a `second` or a `take_back` is about. A `second` names the agent that proposed the badge. A
    `take_back` without it takes back the badge that `by` gave.
    """


class DeliverableSet(EventBase):
    """
    The person stated a deliverable, changed its sentence, or removed it, or the lab's desk did on the person's word.

    A deliverable is what the person wants to hold at the end of the lab, as one sentence. A new ID states one, a
    known ID with a new text changes its sentence, and `removed` removes it. The record keeps every earlier
    sentence. `post` is the post that tells the lab, which comes just before this event: the person's own, or the
    desk's post for the person. A deliverable that the person stated when the lab opened, before any agent joined,
    has none. No agent tool records this event, other than the desk's with `on`.
    """

    type: Literal['deliverable_set'] = 'deliverable_set'
    deliverable: DeliverableId
    text: Sentence
    """The sentence from now on. With `removed`, the sentence that the deliverable had last."""
    removed: bool = False
    post: PostId | None = None
    by: AgentId = Field(default=PERSON, exclude_if=by_person)
    """
    Who made the change: the person, or the lab's desk on the person's word. The post that tells the lab is then
    the desk's post for the person. A record from before this field holds the person.
    """
    on: PostId | None = Field(default=None, exclude_if=unset)
    """With `by` the desk: the person's post in the desk chat that the change rests on."""


class DeliverableDecided(EventBase):
    """
    The person decided about an offer of files for a deliverable.

    The person accepted the offer, asked its author for changes, or took back their acceptance of it. `post` is the
    person's post that replies to the offer, which comes just before this event, so the offer's author hears the
    decision. With `changes_asked`, that post holds the person's words. A deliverable is accepted only by this
    event, and only this event takes an acceptance back. No agent tool records it.
    """

    type: Literal['deliverable_decided'] = 'deliverable_decided'
    deliverable: DeliverableId
    decision: Decision
    offer: PostId
    post: PostId


type Event = Annotated[
    LabOpened
    | QuestionRevised
    | AgentJoined
    | AgentNamed
    | OnCallSet
    | DeskSet
    | ActingSet
    | ModeSet
    | CoordinatorSet
    | AgentLeft
    | ThreadOpened
    | Posted
    | WatchSet
    | ProfileSet
    | NotesSet
    | ReviewerSet
    | AlarmSet
    | TurnStarted
    | TurnEnded
    | TurnInterrupted
    | RerunRequested
    | RerunTaken
    | RerunLeaseSet
    | TaskClaimed
    | ClaimLapsed
    | RoundClosed
    | TimeSet
    | TimeRanOut
    | BudgetSet
    | LimitReached
    | LimitsReported
    | PaceSet
    | WentQuiet
    | SettingsSet
    | PermissionGranted
    | PowerSet
    | RequestAnswered
    | Voted
    | BadgeSet
    | DeliverableSet
    | DeliverableDecided
    | AllowanceDrafted
    | AllowanceStarted
    | AllowanceEnded
    | ActionsPaused
    | ActionDecided,
    Field(discriminator='type'),
]
