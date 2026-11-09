"""The person's settings: what Verifold does by default, at two levels, for all projects and for one project."""

from enum import StrEnum
from typing import Literal

from pydantic import Field

from verifold.protocol.agents import Label
from verifold.protocol.record import Record


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


class JobSettings(Record):
    """What Verifold does with the processes that agents start on their own, such as a script in the background."""

    at_time_limit: AtTimeLimit = AtTimeLimit.PAUSE
    at_exit: AtExit = AtExit.STOP


class Settings(Record):
    """
    The person's settings, with Verifold's defaults for anything they leave out.

    A project's settings override the person's global ones. A lab keeps a copy of the settings from the time it
    opened, so an agent that edits the files can't change the rules of a running lab.
    """

    version: Literal[1] = 1
    jobs: JobSettings = JobSettings()


class HarnessSettings(Record):
    """
    A harness that the person adds, or that replaces a built-in harness of the same name.

    Any agent that speaks ACP can be one. Verifold finds its model, effort, and mode options by their ACP category, so
    an entry needs only the command and the model family.
    """

    command: tuple[str, ...] = Field(min_length=1)
    """The command that starts the harness's ACP agent."""
    family: Label
    """The model family of the harness's default models. A blind check needs a checker from another family."""
    title: Label | None = None
    """The name that people know the harness by. Default: the harness's key in the settings."""
    executable: str | None = None
    """The harness's own command, when `command` starts an adapter for it. Default: the first word of `command`."""
    auto_mode: str | None = None
    """The ID of the harness's own auto mode, which Verifold sets when the person allows auto mode."""


class SettingsFile(Record):
    """
    What a settings file holds: the settings that a lab follows, and the harnesses that this computer offers.

    A lab records only its settings. It reads the harnesses again at each start, because they describe this computer.
    """

    version: Literal[1] = 1
    jobs: JobSettings = JobSettings()
    harnesses: dict[Label, HarnessSettings] = Field(default_factory=dict)

    def lab_settings(self) -> Settings:
        """Return the settings that a new lab records and follows."""
        return Settings(version=self.version, jobs=self.jobs)
