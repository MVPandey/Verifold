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
from verifold.protocol.events import AgentLeft, Note, Question
from verifold.protocol.grants import Grant
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.join import (
    AlarmLine,
    LabState,
    PostLine,
    PostView,
    QuestionVersion,
    RerunLine,
    ThreadView,
)
from verifold.protocol.record import Record
from verifold.protocol.settings import MAX_MINUTES, MAX_REVIEWER_SEATS, Settings, SettingsLevel, SetupDefaults
from verifold.protocol.usage import Usage

type AgentState = Literal['starting', 'working', 'waiting', 'idle', 'stopped', 'invited', 'here', 'listening', 'void']
"""
`waiting` means that the harness waits for the person, for example for a permission answer.

The last four are for an invited agent, which Verifold sees only through its board calls: `invited` until its
first call, `listening` while its `wait` call is open, `here` after any other call, and `void` when Verifold holds
no digest of its token, so only a new invitation lets it join.
"""


type WaitsFor = Literal['person', 'time', 'process']
"""
What an agent in the state `waiting` waits for. `person`: its harness waits for the person's answer inside a turn
that runs. `time`: the lab is out of time, and the agent's turn starts when the person gives it more. `process`:
the agent ended its turn while a process that it started still ran, and its turn starts when the process ends.
"""


class AgentActivity(Record):
    """What an agent is doing now, from its harness's live updates. It is not part of the record."""

    state: AgentState = 'starting'
    detail: str = ''
    """The latest step that the harness reported, such as a tool call's title."""
    at: AwareDatetime | None = None
    waits_for: WaitsFor | None = None
    """With the state `waiting`: what the agent waits for. `None` in any other state."""


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
    status: str = ''
    """What the agent says that it does now."""
    thread: ThreadId | None = None
    """The thread where the agent works now, or `None` when it works in none."""
    activity: AgentActivity
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
    reviewer_seats: int = 0
    """How many reviewer seats the lab has."""
    reviewer_seats_set: int | None = None
    """The number that the person set, or `None` while the number follows the size of the lab."""
    ends_at: AwareDatetime | None = None
    """When the agents stop. `None` means no time limit."""
    out_of_time: bool = False
    """The lab reached its end. Its agents wait until the person gives it more time."""
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
    'jobs.at_time_limit', 'jobs.at_exit', 'permissions.while_you_decide', 'reviewers.seats', 'setup'
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
    The new value: the answer of a job or permission setting, or the choices for new labs. `None` removes the setting, so the one for
    all projects, or Verifold's default, applies.
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


class TimeRequest(Record):
    """The person sets how much longer the agents may work, counted from now. Zero stops them now."""

    minutes: int = Field(ge=0, le=MAX_MINUTES)
