"""The app protocol: what the person's UI reads from a lab, and what it sends."""

from typing import Literal

from pydantic import AwareDatetime, Field, JsonValue

from verifold.protocol.agents import Agent, AgentChoices, Label, ValueId
from verifold.protocol.events import Question
from verifold.protocol.ids import PostId
from verifold.protocol.record import Record
from verifold.protocol.settings import MAX_MINUTES, Settings, SettingsLevel, SetupDefaults
from verifold.protocol.usage import Usage

type AgentState = Literal['starting', 'working', 'waiting', 'idle', 'stopped']
"""`waiting` means that the harness waits for the person, for example for a permission answer."""


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
    settings: Settings = Settings()
    """The settings that the lab follows, such as what happens to the agents' processes when the person stops it."""


class RerunRequest(Record):
    """The person asks for a blind rerun of a post."""

    post: PostId


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


type SettingKey = Literal['jobs.at_time_limit', 'jobs.at_exit', 'setup']
"""The settings that the app changes. Harness commands are not among them, so the app can't change what a lab runs."""


class SettingsRevisions(Record):
    """The revision of each settings file when the person read it."""

    project: str
    all_projects: str


class SettingsChange(Record):
    """The person changes one setting in one of their settings files."""

    level: SettingsLevel
    key: SettingKey
    value: str | SetupDefaults | None = None
    """
    The new value: a job setting's answer, or the choices for new labs. `None` removes the setting, so the one for
    all projects, or Verifold's default, applies.
    """
    revisions: SettingsRevisions
    """
    Both files' revisions. The files add up, so a change refuses to apply when either one changed since the person
    read it: it could apply a setting that the person didn't see.
    """


class TimeRequest(Record):
    """The person sets how much longer the agents may work, counted from now. Zero stops them now."""

    minutes: int = Field(ge=0, le=MAX_MINUTES)
