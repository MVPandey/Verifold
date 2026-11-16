"""The person's settings: what Verifold does by default, at two levels, for all projects and for one project."""

from enum import StrEnum
from typing import Literal

from pydantic import Field, field_validator

from verifold.protocol.agents import GUEST, AgentChoices, Label
from verifold.protocol.record import Record

MAX_MINUTES = 7 * 24 * 60
"""The longest time that the person can give a lab at once: one week."""


class AtTimeLimit(StrEnum):
    """What happens to the processes that agents left running when the lab's time ends, or the person stops it."""

    PAUSE = 'pause'
    """Pause them until the person gives the lab more time."""
    STOP = 'stop'
    FINISH = 'finish'
    """Let them run to the end."""


class AtExit(StrEnum):
    """What happens to the processes that agents left running when Verifold exits."""

    STOP = 'stop'
    KEEP = 'keep'
    """Leave them for the next run, which pauses or resumes them with the lab's time."""


class SettingsLevel(StrEnum):
    """Where a setting lives: in the file for all projects, or in one project's file, which wins."""

    PROJECT = 'project'
    ALL = 'all'


class JobSettings(Record):
    """What Verifold does with the processes that agents start on their own, such as a script in the background."""

    at_time_limit: AtTimeLimit = AtTimeLimit.PAUSE
    at_exit: AtExit = AtExit.STOP


class WhileYouDecide(StrEnum):
    """What an agent's harness gets while its permission request waits for the person's answer on the board."""

    AUTO = 'auto'
    """As the lab's auto mode: `refuse` in a lab that the person started in auto mode, and `wait` in any other."""
    WAIT = 'wait'
    """The request waits for the answer, as it does when the person runs the harness by hand."""
    REFUSE = 'refuse'
    """Verifold refuses the request at once, and the answer applies when the agent asks for the same again."""


class PermissionSettings(Record):
    """What Verifold does with a permission request of a harness that the person has to decide."""

    while_you_decide: WhileYouDecide = WhileYouDecide.AUTO


MAX_REVIEWER_SEATS = 20
"""The most reviewer seats that the person can give a lab: one for each agent that a lab can have."""


class ReviewerSettings(Record):
    """How many reviewer seats a lab has."""

    seats: int | None = Field(default=None, ge=0, le=MAX_REVIEWER_SEATS)
    """
    The number of reviewer seats. `None` follows the size of the lab: one seat for every five agents, and one seat
    in a lab of three or four. Zero means that the lab has no reviewer seats, and then a check takes none.
    """


MAX_BOARD_MINUTES = 24 * 60
"""The longest reveal time of votes and the longest lease of a rerun that the person can set: one day."""


class VoteSettings(Record):
    """How long the votes on a new post stay sealed for an agent that has not voted on it."""

    reveal_minutes: int = Field(default=10, ge=0, le=MAX_BOARD_MINUTES)
    """
    The minutes after a post was written in which the board shows an agent no votes on it until it votes on it
    itself. The post's author and the person see them at once. Zero means that no vote is sealed. A post keeps the
    minutes that the lab followed when it was written.
    """


class RerunSettings(Record):
    """How long one agent holds a wanted rerun that it took."""

    lease_minutes: int = Field(default=10, ge=0, le=MAX_BOARD_MINUTES)
    """
    The minutes of the lease that a take of a rerun gives its agent, and that a renewal starts again. While the
    lease stands, the board refuses the take of the same rerun from another agent. Zero means that a take gives no
    lease. A lease keeps the minutes that the lab followed when it was taken or renewed.
    """


class Settings(Record):
    """
    The person's settings, with Verifold's defaults for anything they leave out.

    A project's settings override the person's global ones. A lab keeps a copy of the settings from the time it
    opened, so an agent that edits the files can't change the rules of a running lab.
    """

    version: Literal[1] = 1
    jobs: JobSettings = JobSettings()
    permissions: PermissionSettings = PermissionSettings()
    reviewers: ReviewerSettings = ReviewerSettings()
    votes: VoteSettings = VoteSettings()
    reruns: RerunSettings = RerunSettings()


class HarnessSettings(Record):
    """
    A harness that the person adds, or that replaces a built-in harness of the same name.

    Any agent that speaks ACP can be one. Verifold finds its model, effort, and mode options by their ACP category, so
    an entry needs only the command and the model family.
    """

    command: tuple[str, ...] = Field(min_length=1)
    """The command that starts the harness's ACP agent."""
    family: Label
    """The model family of the harness's default models. An independent rerun by another model needs an agent of another family."""
    title: Label | None = None
    """The name that people know the harness by. Default: the harness's key in the settings."""
    executable: str | None = None
    """The harness's own command, when `command` starts an adapter for it. Default: the first word of `command`."""
    auto_mode: str | None = None
    """The ID of the harness's own auto mode, which Verifold sets when the person allows auto mode."""
    names_mcp_server: bool = False
    """
    Whether the harness itself writes the MCP server's name into a tool call's input, as `server`, beside `tool`.

    Verifold then knows a call to the lab's own board and allows it without a question. Where the model writes the
    input, the name proves nothing, so the default is off.
    """


class SetupDefaults(Record):
    """What a new lab starts with unless the person chooses otherwise: in the setup, and for `verifold run`."""

    agents: AgentChoices | None = None
    """
    The seats that a new lab starts with. A harness can have several, such as two models of it. `None` starts one
    agent of each harness that this computer has, with the person's own settings.
    """
    auto_mode: bool = True
    minutes: int | None = Field(default=None, ge=1, le=MAX_MINUTES)
    """How long the agents may work. `None` means no time limit."""


class SettingsFile(Record):
    """
    What a settings file holds: the settings that a lab follows, how new labs start, and this computer's harnesses.

    A lab records only its settings. It reads the harnesses again at each start, because they describe this computer.
    """

    version: Literal[1] = 1
    jobs: JobSettings = JobSettings()
    permissions: PermissionSettings = PermissionSettings()
    reviewers: ReviewerSettings = ReviewerSettings()
    votes: VoteSettings = VoteSettings()
    reruns: RerunSettings = RerunSettings()
    setup: SetupDefaults = SetupDefaults()
    harnesses: dict[Label, HarnessSettings] = Field(default_factory=dict)

    @field_validator('harnesses')
    @classmethod
    def _no_harness_is_the_guest(cls, harnesses: dict[str, HarnessSettings]) -> dict[str, HarnessSettings]:
        if GUEST in harnesses:
            raise ValueError(
                f'A harness cannot have the name `{GUEST}`. Verifold uses that name for the agents that you invite, '
                'which it does not start. Give the harness another name.'
            )
        return harnesses

    def lab_settings(self) -> Settings:
        """Return the settings that a new lab records and follows."""
        return Settings(
            version=self.version,
            jobs=self.jobs,
            permissions=self.permissions,
            reviewers=self.reviewers,
            votes=self.votes,
            reruns=self.reruns,
        )
