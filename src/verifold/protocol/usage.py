"""What agents' turns cost, and what the lab's files take on disk."""

from pydantic import AwareDatetime, Field

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
