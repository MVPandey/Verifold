"""What agents' turns cost, what the lab's files take on disk, and the usage limits of the seats' providers."""

import re
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, StringConstraints, field_validator

from verifold.protocol.ids import AgentId
from verifold.protocol.record import Record


class Usage(Record):
    """Tokens that a turn used. `input_tokens` includes the cached ones."""

    input_tokens: int = Field(default=0, ge=0)
    cached_input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


class DiskUse(Record):
    """
    The bytes that the lab's files take on disk, as Verifold measured them at the end of a turn.

    It is no part of the record: it describes this computer at one moment.
    """

    at: AwareDatetime
    folders: dict[AgentId, int] = Field(default_factory=dict)
    """Each agent's folder that Verifold measured, by agent."""
    reruns: int = Field(default=0, ge=0)
    """The clean copies for reruns."""
    snapshots: int = Field(default=0, ge=0)
    """Verifold's own Git directory, which holds the snapshots of the agents' folders."""
    total: int = Field(default=0, ge=0)
    """All of them together."""


type LimitStatus = Literal['allowed', 'warning', 'reached']
"""
The status of a provider's usage limit. The harness reports it in its own words, and the harness's entry gives
Verifold's word for each: the provider takes the seat's requests, it takes them and warns that a limit is near, or it
refuses them.
"""

type WindowLabel = Annotated[str, StringConstraints(min_length=1, max_length=40)]
"""The name of a limit's window in the words that the person reads after "of the", such as "5-hour" or "weekly"."""


class LimitWindow(Record):
    """One window of a provider's usage limit: how much of it the seat's account used, and when it starts again."""

    label: WindowLabel
    used_percent: float = Field(ge=0, le=100)
    resets_at: AwareDatetime | None = None
    """When the window starts again from zero. `None` when the harness reports no time."""


class SeatLimits(Record):
    """
    The usage limits of the provider behind a seat, as its harness reported them last.

    The windows are the account's, so the seats of one account show the same windows. A harness that reports no
    limits gives its seat none.
    """

    windows: tuple[LimitWindow, ...] = ()
    status: LimitStatus | None = None
    """The provider's status, when the harness reports one."""


type FieldPath = Annotated[str, StringConstraints(max_length=200)]
"""A place in a JSON value, as the names of its fields with dots between them. An empty path is the value itself."""


class MetaLimits(Record):
    """
    A harness that reports its provider's usage limits in the `_meta` of its ACP session updates, under one key.

    The value under the key holds the windows. Each path of `windows` leads to one window, or to an object whose
    every value is a window under the window's name. The other fields name a field of a window, or of the value for
    `status`. An empty name means that the harness reports no such field.
    """

    source: Literal['meta'] = 'meta'
    key: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    windows: tuple[FieldPath, ...] = ('',)
    name: FieldPath = ''
    """The field of a window that names it. A window under an object has its key there as its name."""
    minutes: FieldPath = ''
    """The field of a window with its length in minutes, which names a window that has no other name."""
    used: FieldPath = Field(min_length=1)
    """The field with how much of the window the account used."""
    scale: float = Field(default=100, gt=0)
    """What `used` counts as all of the window: 1 for a share such as 0.62, and 100 for a percent."""
    resets: FieldPath = ''
    """The field with the time when the window starts again: Unix seconds, or an ISO time."""
    status: FieldPath = ''
    statuses: dict[str, LimitStatus] = Field(default_factory=dict)
    """The harness's words for its status, each with Verifold's word. A word that is not here sets no status."""
    labels: dict[str, WindowLabel] = Field(default_factory=dict)
    """The harness's names of windows, each with the words that the person reads. Another name is its own label."""


class CommandLimits(Record):
    """
    A harness that answers one of its own commands with a text that holds its provider's usage limits.

    The harness answers the command by itself, without a turn of its model, so the command reaches no agent and
    costs no tokens. Verifold sends it only between two turns, and only while the harness lists the command among
    its commands. Each match of `line` in the answer is one window.
    """

    source: Literal['command'] = 'command'
    command: Annotated[str, StringConstraints(pattern=r'^/[A-Za-z0-9_-]{1,40}$')]
    """The command with its slash, such as `/status`."""
    line: Annotated[str, StringConstraints(min_length=1, max_length=2_000)]
    """
    A regular expression for one window, with named groups: `name`, and `used` or `left` in percent, and optionally
    `time`, a clock time such as 21:23 on this computer's clock, and `date`, such as "Nov 25" or "25 Nov".
    """
    labels: dict[str, WindowLabel] = Field(default_factory=dict)
    """The harness's names of windows, each with the words that the person reads. Another name is its own label."""

    @field_validator('line')
    @classmethod
    def _a_pattern(cls, line: str) -> str:
        try:
            groups = set(re.compile(line).groupindex)
        except re.error as error:
            raise ValueError(f'`line` is no regular expression: {error}') from error
        if 'name' not in groups or not groups & {'used', 'left'}:
            raise ValueError('`line` needs the named groups `name`, and `used` or `left`.')
        return line


type LimitSource = Annotated[MetaLimits | CommandLimits, Field(discriminator='source')]
"""How a harness reports its provider's usage limits over ACP: in the `_meta` of its updates, or in reply to a command."""
