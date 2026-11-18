"""The app protocol: what the person's UI reads from a lab, and what it sends."""

from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, Field, JsonValue, StringConstraints

from verifold.protocol.agents import (
    Agent,
    AgentChoices,
    Label,
    Name,
    Picture,
    Power,
    Role,
    SeatFacts,
    ValueId,
    one_line,
)
from verifold.protocol.deliverables import (
    MAX_DELIVERABLES,
    DeliverableLine,
    OfferLine,
    RemovedDeliverable,
    Sentence,
)
from verifold.protocol.events import AgentLeft, Limit, Note, Question, RoundClosed
from verifold.protocol.grants import Grant
from verifold.protocol.ids import AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import (
    AlarmLine,
    BudgetLine,
    LabState,
    ObstacleState,
    PostLine,
    PostView,
    QuestionVersion,
    RerunLine,
    Standing,
    ThreadSummary,
    ThreadView,
)
from verifold.protocol.posts import MAX_HEADLINE, Body
from verifold.protocol.record import Record
from verifold.protocol.settings import (
    MAX_BOARD_MINUTES,
    MAX_BUDGET_DOLLARS,
    MAX_BUDGET_TOKENS,
    MAX_DISK_GB,
    MAX_MINUTES,
    MAX_REVIEWER_SEATS,
    Settings,
    SettingsLevel,
    SetupDefaults,
)
from verifold.protocol.usage import DiskUse, Usage
from verifold.protocol.votes import Badge, BadgeAction, Direction, ProposalLine, Why

type AgentState = Literal['starting', 'working', 'waiting', 'idle', 'stopped', 'invited', 'here', 'listening', 'void']
"""
`waiting` means that the harness waits for the person, for example for a permission answer.

The last four are for an invited agent, which Verifold sees only through its board calls: `invited` until its
first call, `listening` while its `wait` call is open, `here` after any other call, and `void` when Verifold holds
no digest of its token, so only a new invitation lets it join.
"""


type WaitsFor = Literal['person', 'time', 'limit', 'process', 'retry']
"""
What an agent in the state `waiting` waits for. `person`: its harness waits for the person's answer inside a turn
that runs. `time`: the lab is out of time, and the agent's turn starts when the person gives it more. `limit`: the
lab reached its budget or its disk limit, and the agent's turn starts when the person raises it. `process`: the
agent ended its turn while a process that it started still ran, and its turn starts when the process ends.
`retry`: its harness failed, and Verifold starts it again at the time in `retry`.
"""


class Retry(Record):
    """A harness that failed and that Verifold starts again: how often it failed in a row, and when it tries again."""

    failures: int = Field(ge=1)
    """How many times in a row the harness failed. The agent's `error` is the last one."""
    at: AwareDatetime
    """When Verifold starts the harness again."""
    provider_limit: bool = False
    """
    Whether the error says that the provider limits the harness, such as a rate limit, a usage limit, a quota, or
    the HTTP status 429. Verifold then waits until the reset time that the error names, when it names one.
    """


class AgentActivity(Record):
    """What an agent is doing now, from its harness's live updates. It is not part of the record."""

    state: AgentState = 'starting'
    detail: str = ''
    """The latest step that the harness reported, such as a tool call's title."""
    at: AwareDatetime | None = None
    waits_for: WaitsFor | None = None
    """With the state `waiting`: what the agent waits for. `None` in any other state."""
    retry: Retry | None = None
    """While the agent waits for `retry`: how its harness failed, and when Verifold starts it again."""


class Heard(Record):
    """
    The person's newest post in the conversation that a result of an agent's board tools carried to the agent.

    It is a live fact of the server that runs, and no event in the record holds it. It says that a tool result
    held the post. It says nothing about what the agent made of the post.
    """

    seq: int
    """The post's place in the record."""
    at: AwareDatetime | None = None
    """When the result carried the post. `None` when that was before this server started."""
    whole: bool
    """
    Whether a result carried the whole post: a line of the news that held all of its body, the post in full in
    `wait`, or the conversation in `thread`. `False` when the results carried only a line with a cut body.
    """


type Need = Literal['approval', 'answer', 'working', 'waiting', 'idle', 'stopped', 'left']
"""
The one status of an agent or a thread, in the order of who needs the person. The first that applies is the status.

- `approval`: a permission request of the agent's harness waits for the person.
- `answer`: another ask of the agent to the person waits.
- `working`: the agent is in a turn, by its harness's live updates, or its harness starts.
- `waiting`: the agent is in no turn, and it waits for another agent: an ask of it that names an agent has no
  answer, or its `wait` call is open.
- `idle`: the agent is in no turn and waits for nobody. An agent that waits for more time for the lab, or for a
  process that it left running, is idle too, and its activity says what it waits for.
- `stopped`: Verifold stopped the agent, or its harness is not running and cannot start.
- `left`: the agent left the lab.

A thread has the first status that applies to an ask in it that waits for the person or to an agent of its team.
"""

NEEDS: tuple[Need, ...] = ('approval', 'answer', 'working', 'waiting', 'idle', 'stopped', 'left')
"""The statuses in their order."""


class Wait(Record):
    """One thing that waits for the person: an approval or an answer, with who asks, what, and since when."""

    kind: Literal['approval', 'answer']
    agent: AgentId
    what: str
    """
    What waits, in one line. For a request of a harness, the words are Verifold's own, so no text of a harness
    stands here. For an agent's own ask, it is the ask's headline.
    """
    since: AwareDatetime
    post: PostId
    thread: ThreadId


class PostRef(Record):
    """A post by its ID and its thread, so that the app can link to it."""

    id: PostId
    thread: ThreadId


class Outcomes(Record):
    """What became of an agent's posts, as lists of posts. It is no score and ranks nobody."""

    built_on: tuple[PostRef, ...] = ()
    """The agent's results that another agent built on."""
    held: tuple[PostRef, ...] = ()
    """The agent's results that a check holds up."""
    refuted: tuple[PostRef, ...] = ()
    """The agent's results that are disputed or conceded, and the leads that it ruled out."""
    open_asks: tuple[PostRef, ...] = ()
    """The agent's asks that have no answer yet."""


class ProfileEdit(Record):
    """One change that the person or a coordinator made to an agent's profile, with the text from before."""

    at: AwareDatetime
    by: AgentId
    part: Literal['name', 'about', 'picture', 'role', 'flag']
    before: str = ''
    """The text that the part held before the change. For a picture, its three parts in words."""
    after: str = ''


class AgentView(Record):
    """One agent as the person sees it: who it is, what it is doing, and what it has cost so far."""

    agent: Agent
    """The agent as the record has it. Its `name` is the name that it chose, or else the label of its seat."""
    seat: str = ''
    """The label of the agent's seat: its harness's title and its model's name, or what stands for an invited agent."""
    chosen_name: str = ''
    """The name that the agent chose, or an empty text while its seat's label or the person's name for it is its name."""
    about: str = ''
    """What lens the agent brings, in its own words."""
    picture: Picture | None = None
    """The picture that the agent chose, or `None`."""
    given_role: str = ''
    """The role that somebody gave the agent's seat."""
    given_by: AgentId | None = None
    """Who gave it: `person`, or the agent that held the coordinator seat. `None` without a given role."""
    reviewer: bool = False
    """Whether the agent holds a reviewer seat."""
    flag: str = ''
    """The reason of the coordinator's flag on the agent's profile, while one stands."""
    edits: tuple[ProfileEdit, ...] = ()
    """The changes that the person or a coordinator made to the agent's profile, oldest first."""
    need: Need = 'idle'
    """The agent's one status."""
    in_turn: bool = False
    """
    Whether a turn of the agent runs now or is about to, by its harness's live updates. A turn in which the
    harness waits for the person's answer runs, and a harness that Verifold starts now counts. An agent that waits
    for more time or for its own process is in no turn.
    """
    about_by: AgentId | None = None
    """Who wrote the about line: the agent itself, or the coordinator that rewrote it. `None` without one."""
    outcomes: Outcomes = Outcomes()
    turns_started: int = 0
    """How many turns of the agent started. It is above `turns` while a turn runs."""
    role: str = ''
    """What the agent says that it is to the lab, in its own words."""
    on_call: bool = False
    """Whether the person put the agent's seat on call, so that only a post for the agent itself wakes it."""
    coordinator: bool = False
    """Whether the agent holds the lab's coordinator seat."""
    desk: bool = False
    """Whether the agent's seat is the lab's desk, which answers the person in the desk chat and acts on the person's word."""
    status: str = ''
    """What the agent says that it does now."""
    thread: ThreadId | None = None
    """The thread where the agent works now, or `None` when it works in none."""
    activity: AgentActivity
    heard: Heard | None = None
    """
    The person's newest post in the conversation that the agent's board tools carried to it, or `None` when they
    carried none.
    """
    left: AgentLeft | None = None
    """When the agent left the lab, who caused it, and why. `None` while the agent is in the lab."""
    stopped: bool = False
    """
    Whether Verifold stopped the agent because its harness failed too often, and the agent has not started since.
    The person can start it again.
    """
    turns: int = Field(ge=0)
    turn_ended_at: AwareDatetime | None = None
    """When the agent's last turn ended. `None` when no turn of the agent ended."""
    alarm: AlarmLine | None = None
    """The alarm that waits for the agent, or `None`. Its `rings_at` is `None` while the lab is out of time or closed."""
    posts: int = Field(ge=0)
    usage: Usage
    cost_usd: float | None = None
    """The cost that the harness reported. `None` when the harness reports tokens only."""
    error: str | None = None
    """Why the agent's latest turn, or the latest start of its harness, failed. `None` when it did not fail."""


class OfferView(OfferLine):
    """
    An offer as the person's app shows it: the line that agents read in `brief`, and the detail of the offer's post.

    The person accepts an offer or asks for changes in the panel for the deliverables, so the app shows the
    detail there. `brief` holds the line alone, and `thread` shows the detail to an agent.
    """

    body: Body = ''


class DeliverableView(DeliverableLine):
    """A deliverable as the person's app shows it: each of its offers comes with its detail."""

    offers: tuple[OfferView, ...] = ()


class ThreadCard(ThreadSummary):
    """A thread's summary as the person's app shows it on its card, with the times of the line's newest result and plan."""

    last_result_at: AwareDatetime | None = None
    """When the newest result of the line of work was posted. `None` without one, and for any other thread."""
    last_plan_at: AwareDatetime | None = None
    """When the newest plan of the line of work was posted. `None` without one, and for any other thread."""


class ObstacleView(Record):
    """
    An obstacle as the person's app shows it: its post, its time, its standing, and its state as an obstacle.

    `state` is as `ObstacleState` says, and `standing` is where the `ruled_out` post itself stands, as any post does.
    """

    post: PostLine
    at: AwareDatetime
    standing: Standing
    state: ObstacleState
    builders: tuple[PostLine, ...] = ()
    """
    The posts that give the obstacle its state, oldest first: for `removed`, the results that build on it and stand,
    and for `taken_up`, the plans and results that build on it. Empty for `open`.
    """


class RoundView(Record):
    """
    A round as the person's app shows it: the round, when it closes, its entries, and the agents that did not enter.

    The person sees every entry whole as it arrives, also while the round is open. The agents see one another's
    entries only from the close on.
    """

    round: PostView
    open: bool
    """Whether the round is open now by the lab's clock."""
    closes_at: AwareDatetime
    """When the round closes by the lab's clock, unless it closes earlier."""
    closed: RoundClosed | None = None
    """The close of the round, with when and why. `None` until Verifold records it."""
    entries: tuple[PostView, ...] = ()
    """The entries, oldest first."""
    not_entered: tuple[AgentId, ...] = ()
    """
    The agents that the round waits for now, or waited for at its close, that did not enter: the agents of the lab
    that are not on call and have not left.
    """


class LabView(Record):
    """The lab at a glance."""

    question: str
    """The question that the lab works on now."""
    coordinator_open: bool = True
    """Whether an agent may take the coordinator seat by itself: nobody holds it, and the person did not close it."""
    versions: tuple[QuestionVersion, ...] = ()
    """Every version of the question, oldest first: the text that the lab opened with, and then each revision."""
    opened_at: AwareDatetime
    seq: int
    agents: tuple[AgentView, ...]
    threads: int
    posts: int
    needs_you: int
    waits: tuple[Wait, ...] = ()
    """What waits for the person: the approvals first, then the answers, and in each the one that waits longest first."""
    thread_needs: dict[ThreadId, Need] = Field(default_factory=dict)
    """The one status of each thread."""
    reruns_wanted: tuple[RerunLine, ...] = ()
    """The reruns that are wanted, oldest first: who asked for each, when, and which agents took it."""
    proposals: tuple[ProposalLine, ...] = ()
    """
    Each `breakthrough` badge that an agent proposed and nobody seconded yet, oldest first. It waits for the
    coordinator or the person, it is none of `waits`, and it changes no status.
    """
    breakthrough_threads: tuple[ThreadId, ...] = ()
    """The threads that hold a post with a `breakthrough` badge that stands."""
    obstacles: tuple[ObstacleView, ...] = ()
    """Every obstacle of the lab's lines of work, the newest first, open, taken up, and removed."""
    round: RoundView | None = None
    """The round that is open, or else the newest round that closed. `None` in a lab without rounds."""
    reviewer_seats: int = 0
    """How many reviewer seats the lab has."""
    reviewer_seats_set: int | None = None
    """The number that the person set, or `None` while the number follows the size of the lab."""
    ends_at: AwareDatetime | None = None
    """When the agents stop. `None` means no time limit."""
    out_of_time: bool = False
    """The lab reached its end. Its agents wait until the person gives it more time."""
    budget: BudgetLine = BudgetLine()
    """The lab's budget, what it spent, and what is left."""
    limit: Limit | None = None
    """The budget or the disk limit that the lab reached. Its agents wait until the person raises it."""
    disk: DiskUse | None = None
    """What the lab's files take on disk, as Verifold measured them last. `None` before the first measure."""
    state: LabState = 'open'
    """Whether the lab's agents say that it is done. A closed lab is not stopped: the person can go on."""
    close: PostLine | None = None
    """The post that says that the lab is done, while it stands."""
    close_agreed: int = 0
    """How many other agents agreed with it."""
    close_among: int = 0
    """Among how many agents its author and the agents that agreed count. Zero while no close stands."""
    settings: Settings = Settings()
    """The settings that the lab follows, such as what happens to the agents' processes when the person stops it."""
    deliverables: tuple[DeliverableView, ...] = ()
    """What the person wants to hold at the end of the lab, each with its state and the files that agents offered."""
    removed_deliverables: tuple[RemovedDeliverable, ...] = ()
    """The deliverables that the person removed after agents offered files for them, with the thread of the offers."""
    deliverables_told_at: AwareDatetime | None = None
    """
    When a post of the person last told the lab of a new sentence or a removal. For a minute after it, and while
    a close stands, such a change sends no post, and the agents read it in `brief`.
    """


class InviteRequest(SeatFacts):
    """
    The person invites an agent that runs by itself, and can state the facts of its seat.

    Verifold does not know the agent's model. With `family`, the person states its model family, so that an
    independent rerun by an agent of another family can hold up its results.
    """

    name: Annotated[str, AfterValidator(one_line), StringConstraints(min_length=1, max_length=40)] | None = None
    """The agent's display name, as one line. `None` gives it the next name, such as "Agent 3"."""


class SeatChange(Record):
    """The person changes an agent's seat in the lab that runs. `None` leaves a part as it is."""

    on_call: bool | None = None
    """Put the seat on call, or take it off."""
    coordinator: bool | None = None
    """Give the agent the lab's coordinator seat, or take the seat from the agent that holds it."""
    reviewer: bool | None = None
    """Give the agent a reviewer seat, or take the seat that it holds."""


class ProfileChange(Record):
    """The person changes an agent's profile: takes back what the agent chose, or gives its seat a role."""

    reset_name: bool = False
    """Take the agent's chosen name back, so that its seat's label is its name again."""
    reset_about: bool = False
    reset_picture: bool = False
    role: Role | None = None
    """The role that the person gives the seat. An empty text takes it back, and `None` leaves it as it is."""


class ReviewerSeats(Record):
    """The person sets how many reviewer seats the lab has."""

    seats: int | None = Field(default=None, ge=0, le=MAX_REVIEWER_SEATS)
    """The number of seats. `None` follows the size of the lab again."""


class CoordinatorSeat(Record):
    """The person leaves the coordinator seat without a holder, and says whether an agent may take it by itself."""

    open: bool


class Invitation(Record):
    """An invited agent, and the text that lets it join. The app shows the text once, and Verifold doesn't keep it."""

    agent: AgentId
    name: Name
    text: str
    """What the agent needs to join: the board's address, its bearer token, its folder, and the lab's facts."""


class RerunRequest(Record):
    """The person asks for an independent rerun of a post."""

    post: PostId


class VoteRequest(Record):
    """The person votes on a post, or takes their vote back with `none`."""

    post: PostId
    direction: Direction
    reason: Why = ''
    """Why, as one line. A vote up or down has one."""


class BadgeRequest(Record):
    """The person gives a post a badge, seconds a `breakthrough` that an agent proposed, or takes a badge back."""

    post: PostId
    badge: Badge
    action: BadgeAction = 'give'
    reason: Why = ''
    proof: PostId | None = None
    """With `confirmed`: the check or the result that confirmed the post, when the person names one."""
    giver: AgentId | None = None
    """With `take_back`: whose badge the person takes back. `None` takes back the person's own."""


class FolderRequest(Record):
    """The person asks to see the folder where the lab's agents work, or the folder of one agent."""

    agent: AgentId | None = None
    """The agent whose folder to open. `None` opens the folder that holds every agent's folder."""


class FolderView(Record):
    """A folder of the lab on the server's computer, and whether the server opened it in the file manager."""

    path: str
    opened: bool
    """`False` when the server started with `--no-browser`, or when its computer has no command that opens a folder."""


class OptionValue(Record):
    """One value that a harness offers for an option, such as a model, with the name that the harness shows for it."""

    value: ValueId
    name: str


class ModelValue(OptionValue):
    """A model that a harness offers, and the effort levels that the harness offers with it."""

    efforts: tuple[OptionValue, ...] | None = None
    """`None` when the harness didn't switch to the model, so its effort levels are not known."""


class Offer(Record):
    """
    The models, effort levels, and modes that a harness offers, and the person's current ones.

    `efforts` and `effort` are for the person's current model. Each model in `models` has its own effort levels.
    """

    models: tuple[ModelValue, ...] = ()
    efforts: tuple[OptionValue, ...] = ()
    modes: tuple[OptionValue, ...] = ()
    model: str | None = None
    effort: str | None = None
    mode: str | None = None


class HarnessOption(Record):
    """A harness that the setup screen offers, whether this computer has it, and what the harness offers."""

    name: Label
    title: Label
    family: Label
    available: bool
    probing: bool = False
    """Verifold is still asking the harness what it offers."""
    offer: Offer | None = None
    """What a session of the harness offers, or `None` until the harness answers, or when it didn't."""


class SetupView(Record):
    """What the setup screen needs: the project folder, the harnesses, and the folder's lab, if any."""

    folder: str
    """The project folder, with `~` for the home folder."""
    harnesses: tuple[HarnessOption, ...]
    question: str | None = None
    """The question of the lab in this folder, or `None` when the folder has no lab yet."""
    defaults: SetupDefaults = SetupDefaults()
    """What the setup starts with: the person's saved choices for new labs, or Verifold's defaults."""
    defaults_from: str | None = None
    """The settings file that the saved choices come from, which can be the project's own, or `None`."""


class StartRequest(Record):
    """The person starts a lab from the setup screen."""

    question: Question
    agents: AgentChoices
    auto_mode: bool = True
    minutes: int | None = Field(default=None, ge=1, le=MAX_MINUTES)
    """How long the agents may work. `None` means no time limit."""
    allow: tuple[Grant, ...] = ()
    """The starts of the commands that every agent may run from the first minute, such as `./gpu`."""
    reviewer_seats: Annotated[int, Field(ge=0, le=MAX_REVIEWER_SEATS)] | Literal['size'] | None = None
    """
    How many reviewer seats the lab has. `size` follows the size of the lab, whatever the settings files say, and
    `None` takes the number from the person's settings files.
    """
    reveal_minutes: int | None = Field(default=None, ge=0, le=MAX_BOARD_MINUTES)
    """How long a new post hides its votes, in place of `votes.reveal_minutes` of the files. `None` takes the files'."""
    lease_minutes: int | None = Field(default=None, ge=0, le=MAX_BOARD_MINUTES)
    """How long a take holds a rerun, in place of `reruns.lease_minutes` of the files. `None` takes the files'."""
    budget_tokens: int | None = Field(default=None, ge=1, le=MAX_BUDGET_TOKENS)
    """The lab's budget in tokens. `None` means no budget in tokens."""
    budget_dollars: float | None = Field(default=None, gt=0, le=MAX_BUDGET_DOLLARS)
    """The lab's budget in US dollars. `None` means no budget in dollars."""
    disk_gb: int | None = Field(default=None, ge=0, le=MAX_DISK_GB)
    """The lab's disk limit, in place of `disk.limit_gb` of the files. `None` takes the files'."""
    deliverables: tuple[Sentence, ...] = Field(default=(), max_length=MAX_DELIVERABLES)
    """What the person wants to hold at the end of the lab, each as one sentence. They can add more while it runs."""


class SettingsFileView(Record):
    """One of the person's settings files: where it is, what it holds as written, and what it adds up to."""

    path: str
    values: dict[str, JsonValue]
    revision: str
    """A hash of the file. A change names it, so that it can't overwrite a change that the person didn't see."""
    settings: Settings
    """For all projects: the file over Verifold's defaults. For a project: its file over the one for all projects."""
    defaults: SetupDefaults = SetupDefaults()
    """What new labs start with at this level, added up in the same way."""


class SettingsView(Record):
    """The person's settings for all projects and for this project, and the copy that the folder's lab follows."""

    all_projects: SettingsFileView
    project: SettingsFileView
    lab: Settings | None = None
    """The settings that the folder's lab follows, or `None` before a lab starts."""


type SettingKey = Literal[
    'jobs.at_time_limit',
    'jobs.at_exit',
    'permissions.while_you_decide',
    'reviewers.seats',
    'votes.reveal_minutes',
    'reruns.lease_minutes',
    'disk.limit_gb',
    'setup',
]
"""The settings that the app changes. Harness commands are not among them, so the app can't change what a lab runs."""


class SettingsRevisions(Record):
    """The revision of each settings file when the person read it."""

    project: str
    all_projects: str


class SettingsChange(Record):
    """The person changes one setting in one of their settings files."""

    level: SettingsLevel
    key: SettingKey
    value: int | str | SetupDefaults | None = None
    """
    The new value: the answer of a job or permission setting, a number of seats or minutes, or the choices for new
    labs. `None` removes the setting, so the one for all projects, or Verifold's default, applies.
    """
    revisions: SettingsRevisions
    """
    Both files' revisions. The files add up, so a change refuses to apply when either one changed since the person
    read it: it could apply a setting that the person didn't see.
    """


type NormsName = Literal['LAB.md', 'WRITING.md']
"""The files of the lab folder that hold the norms. The app reads and writes these two names and no other path."""

NORMS_NAMES: tuple[NormsName, ...] = ('LAB.md', 'WRITING.md')

MAX_NORMS = 100_000
"""The most characters in a norms file that the app shows or saves."""


class NormsFile(Record):
    """One norms file as the Norms page shows it."""

    name: NormsName
    path: str
    """Where the file is, with `~` for the home folder."""
    text: str = ''
    saved: bool = False
    """`False` when the folder has no such file yet, so `text` is the default that a new lab gets."""
    revision: str = ''
    """A hash of `text`. A save names it, so that it can't write over a text that the person didn't see."""
    error: str | None = None
    """Why Verifold can't read the file, such as that it is a link. The page then shows no text for it."""
    changed_at: AwareDatetime | None = None
    """When the file last changed, or `None` when the folder has no such file."""
    changed_by: Literal['page', 'outside'] | None = None
    """
    Whether the file holds the last text that this server saved from the Norms page, or another text, which
    somebody wrote outside the page. `None` when this server saved nothing from the page yet, so it can't tell.
    """
    missing: tuple[str, ...] = ()
    """The lines of Verifold's current default that the file does not have. Verifold never adds them itself."""


type NoPost = Literal['same', 'no_lab', 'no_thread', 'close', 'told_already', 'refused']
"""
Why a save put no post on the board: the text is the same, no lab runs, the lab has no thread for the question, a
close stands, a post told the lab of a change less than `NORMS_POST_SECONDS` ago, or the board refused the post.
"""

NORMS_POST_SECONDS = 60
"""After a post that tells the lab of a change to the norms, a save within this time puts no other post on the board."""


class NormsView(Record):
    """The lab's norms: how the person wants the work done, and how the lab writes its answer."""

    files: tuple[NormsFile, ...]
    told: PostId | None = None
    """After a save: the person's post that tells the agents of the change, also when an earlier save posted it."""
    no_post: NoPost | None = None
    """After a save that put no post on the board: why."""


class NormsChange(Record):
    """The person saves a new text for one norms file."""

    name: NormsName
    text: Annotated[str, StringConstraints(max_length=MAX_NORMS)]
    revision: str
    """The revision of the file when the person read it. The save is refused when the file changed since."""


class PowerView(Record):
    """One power of the coordinator as the person sees it: whether it is on, since when, and how often it was used."""

    power: Power
    on: bool = False
    since: AwareDatetime | None = None
    """When the person switched it on. `None` while it is off."""
    used: int = 0
    """How many moves the agent that holds the seat made with it."""


class Deed(Record):
    """A move that came from a request of the coordinator: with the person's yes, or under a power."""

    request: PostView
    """The request, with its answer in `decision`: who said yes, and when."""
    agent: AgentId | None = None
    """For a move that added an agent: that agent."""
    undo: Literal['remove_agent', 'take_minutes'] | None = None
    """The way back that the person has now: the removal of that agent, or of the minutes. `None` when there is none."""


class ConversationView(Record):
    """What the person's panel for the coordinator shows: the conversation, the powers, and what was done for the person."""

    coordinator: AgentId | None = None
    """The agent that holds the coordinator seat, or `None`."""
    thread: ThreadView | None = None
    """The thread where the person and the coordinator talk, or `None` while the lab has none."""
    waits: tuple[PostId, ...] = ()
    """The posts of that thread that wait for the person's answer: requests for a move, and asks."""
    no_reply: tuple[PostId, ...] = ()
    """
    The person's posts in that thread that wait for the coordinator's reply, oldest first, with the desk's posts for
    the person there. Such a post, other than an `answer`, waits until an agent posts in the thread after it while
    that agent holds the coordinator seat. The coordinator's `brief` and its news say the same.
    """
    asks: tuple[PostView, ...] = ()
    """The permission requests that the requests in the conversation name, each with what its harness asks for."""
    powers: tuple[PowerView, ...] = ()
    """Every power, in a fixed order."""
    deeds: tuple[Deed, ...] = ()
    """The moves that came from the coordinator's requests, newest first."""


class PowerChange(Record):
    """The person switches a power of the coordinator on or off."""

    power: Power
    on: bool


class RequestAnswer(Record):
    """The person answers a request of the coordinator for a move."""

    yes: bool
    minutes: int | None = Field(default=None, ge=1, le=MAX_MINUTES)
    """With a yes to more time: another amount than the request names."""


class QuestionRequest(Record):
    """The person revises the lab's question."""

    question: Question
    note: Note = ''
    """Why, as one line. It can be empty."""


class DeliverableRequest(Record):
    """The person states a deliverable, or gives one another sentence."""

    text: Sentence


class DeliverableDecision(Record):
    """The person decides about an offer of files for a deliverable."""

    decision: Literal['accept', 'ask_changes', 'take_back']
    offer: PostId
    """The offer that the person accepts, wants changed, or accepted before."""
    text: Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_HEADLINE)] = ''
    """With `ask_changes`: what the person wants changed. It reaches the offer's author as a reply to the offer."""


class BudgetRequest(Record):
    """The person sets the lab's budget. It replaces the earlier one, and `None` sets no budget of that kind."""

    tokens: int | None = Field(default=None, ge=1, le=MAX_BUDGET_TOKENS)
    dollars: float | None = Field(default=None, gt=0, le=MAX_BUDGET_DOLLARS)


class DiskRequest(Record):
    """The person sets the lab's disk limit, in gigabytes. Zero means no limit."""

    limit_gb: int = Field(ge=0, le=MAX_DISK_GB)


class TimeRequest(Record):
    """The person sets how much longer the agents may work, counted from now. Zero stops them now."""

    minutes: int = Field(ge=0, le=MAX_MINUTES)


type DeskDeed = Literal['post', 'round', 'question', 'deliverable', 'time', 'interrupt']
"""
What the desk did on the person's word: a post for the person, a round, a revision of the question, a change of a
deliverable, a new end of the lab, or the end of an agent's turn.
"""


class DeskAction(Record):
    """
    One action of the desk, with the person's post in the desk chat that it rests on, as the record keeps it.

    The app writes its own line for each kind, so no text of an agent stands in its sentence.
    """

    on: PostId
    """The person's post in the desk chat that the action rests on."""
    at: AwareDatetime
    kind: DeskDeed
    post: PostId | None = None
    """The post that the action made: the desk's post for the person, its round, or the post that tells the lab."""
    thread: ThreadId | None = None
    """The thread of that post."""
    agent: AgentId | None = None
    """For the end of a turn: the agent whose turn the desk ended."""
    deliverable: DeliverableId | None = None
    """For a change of a deliverable: its ID."""
    change: Literal['added', 'changed', 'removed'] | None = None
    """For a change of a deliverable: what the desk did to it."""
    ends_at: AwareDatetime | None = None
    """For a new end of the lab: the end that the desk set."""


class DeskView(Record):
    """What the person's panel for the desk shows: the desk, the desk chat, and what the desk did on the person's word."""

    desk: AgentId | None = None
    """The agent that holds the desk seat, or `None` while the lab has none."""
    thread: ThreadView | None = None
    """The desk chat, or `None` while the lab has none."""
    actions: tuple[DeskAction, ...] = ()
    """Each action of the desk, oldest first. The app shows each one under the post of the person that it rests on."""
