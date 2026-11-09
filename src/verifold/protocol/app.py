"""The app protocol: what the person's UI reads from a lab, and what it sends."""

from typing import Literal

from pydantic import AwareDatetime, Field, JsonValue

from verifold.protocol.agents import Agent, Label, ValueId
from verifold.protocol.events import Question
from verifold.protocol.ids import PostId
from verifold.protocol.record import Record
from verifold.protocol.settings import Settings, SettingsLevel
from verifold.protocol.usage import Usage

MAX_MINUTES = 7 * 24 * 60
"""The longest time that the person can give a lab at once: one week."""

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


class AgentChoice(Record):
    """How many agents of one harness to start, and with which model, effort, and mode."""

    harness: Label
    count: int = Field(default=1, ge=1, le=20)
    model: ValueId | None = None
    effort: ValueId | None = None
    mode: ValueId | None = None
    """One of the harness's own modes. `None` follows the lab's auto mode choice."""


class StartRequest(Record):
    """The person starts a lab from the setup screen."""

    question: Question
    agents: tuple[AgentChoice, ...] = Field(min_length=1)
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


class SettingsView(Record):
    """The person's settings for all projects and for this project, and the copy that the folder's lab follows."""

    all_projects: SettingsFileView
    project: SettingsFileView
    lab: Settings | None = None
    """The settings that the folder's lab follows, or `None` before a lab starts."""


class SettingsChange(Record):
    """The person changes one setting in one of their settings files."""

    level: SettingsLevel
    key: str = Field(pattern=r'^[a-z_]+(\.[a-z_]+)*$')
    """The setting, with dots between its parts, such as `jobs.at_exit`."""
    value: JsonValue = None
    """The new value. `None` removes the setting, so the one from the next level applies."""
    revision: str
    """The file's revision when the person read it."""


class TimeRequest(Record):
    """The person sets how much longer the agents may work, counted from now. Zero stops them now."""

    minutes: int = Field(ge=0, le=MAX_MINUTES)
