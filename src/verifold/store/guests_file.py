"""The file that keeps what an invitation needs after a restart: each invited agent's token, as a digest, and the port."""

import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import Field, ValidationError

from verifold.protocol.ids import AgentId
from verifold.protocol.record import Record

GUESTS_FILE = 'guests.json'


class Guests(Record):
    """The lab's invited agents. The file holds no token, so a reader of it cannot post as an agent."""

    version: Literal[1] = 1
    port: int | None = Field(default=None, ge=1, le=65_535)
    """The port of the address in the invitations. The server takes it again when it can."""
    digests: dict[AgentId, str] = Field(default_factory=dict)
    """The SHA-256 digest of each invited agent's bearer token, in hexadecimal."""


def read_guests(path: Path) -> Guests:
    """Return what the file holds. A file that is missing or not valid holds nothing, so its invitations are void."""
    try:
        return Guests.model_validate_json(path.read_bytes())
    except (OSError, ValidationError):
        return Guests()


def keep_guest(path: Path, agent_id: AgentId, digest: str, port: int | None) -> None:
    """
    Add an invited agent's token digest to the file, with the port that its invitation names.

    Only the person can read the file. The new file replaces the old one at once, so a reader never sees half a file.

    Raises:
        OSError: The file can't be written.

    """
    before = read_guests(path)
    guests = Guests(port=port, digests={**before.digests, agent_id: digest})
    path.parent.mkdir(parents=True, exist_ok=True)
    # `mkstemp` makes a file that only its owner can read and write.
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.', suffix='.new')
    written = Path(name)
    try:
        with os.fdopen(descriptor, 'w') as file:
            file.write(guests.model_dump_json(indent=2) + '\n')
        written.replace(path)
    except OSError:
        written.unlink(missing_ok=True)
        raise
