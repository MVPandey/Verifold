"""What every harness adapter provides, and the schemas that adapters share."""

from abc import ABC, abstractmethod
from pathlib import Path

from pydantic import BaseModel, ConfigDict, SecretStr

from verifold.protocol.record import Record


class Wire(BaseModel):
    """A message from a harness's own output. It is immutable and ignores fields that Verifold does not read."""

    model_config = ConfigDict(frozen=True, extra='ignore')


class Turn(Record):
    """One turn of one agent: the prompt, the agent's folder, and how its harness reaches the lab."""

    prompt: str
    folder: Path
    private: Path
    """A folder that only Verifold and this agent's harness read. Adapters write config files with secrets here."""
    mcp_url: str
    token: SecretStr
    network: tuple[str, ...] = ()
    """Domains that the agent's shell commands may reach. Empty means no network for shell commands."""
    model: str | None = None
    session: str | None = None
    """The harness's session ID to resume, or `None` for the agent's first turn."""


class ConfigFile(Record):
    """A file that the driver writes, readable only by the user, before it starts the harness."""

    path: Path
    content: SecretStr


class Invocation(Record):
    """How to start a harness for one turn."""

    argv: tuple[str, ...]
    env: tuple[tuple[str, SecretStr], ...] = ()
    files: tuple[ConfigFile, ...] = ()


class Usage(Record):
    """Tokens that a turn used. Cached input tokens are part of the input tokens."""

    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0


class TurnReport(Record):
    """What a harness reported about one turn, as its output stream arrived."""

    session: str | None = None
    usage: Usage = Usage()
    cost_usd: float | None = None
    final_text: str = ''
    error: str | None = None


class Harness(ABC):
    """An agent harness that Verifold can start for one turn and resume later."""

    name: str
    family: str
    """The model family that the harness uses by default. Blind checks compare families."""

    @abstractmethod
    def invocation(self, turn: Turn) -> Invocation:
        """Return the command, environment, and config files that start this turn."""

    @abstractmethod
    def read(self, report: TurnReport, line: bytes) -> TurnReport:
        """Return the report after one line of the harness's output stream. Lines it does not know change nothing."""
