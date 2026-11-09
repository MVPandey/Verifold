"""The person's settings: what Verifold does by default, at two levels, for all projects and for one project."""

from enum import StrEnum
from typing import Literal

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
