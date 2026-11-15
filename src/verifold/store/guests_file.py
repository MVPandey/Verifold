"""The file that keeps what an invitation needs after a restart: each invited agent's token, as a digest, and the port."""

import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import Field, ValidationError

from verifold.protocol.ids import AgentId
from verifold.protocol.record import Record
from verifold.store.errors import GuestsInvalid

GUESTS_FILE = 'guests.json'


class Guests(Record):
    """The lab's invited agents. The file holds no token, so a reader of it cannot post as an agent."""

    version: Literal[1] = 1
    port: int | None = Field(default=None, ge=1, le=65_535)
    """The port of the address in the invitations. The server takes it again when it can."""
    digests: dict[AgentId, str] = Field(default_factory=dict)
    """The SHA-256 digest of each invited agent's bearer token, in hexadecimal."""


def read_guests(path: Path) -> Guests:
    """
    Return what the file holds. A file that does not exist holds nothing.

    Raises:
        GuestsInvalid: The file is there, and it can't be read or is not a guests file of this version.

    """
    if not path.exists():
        return Guests()
    try:
        return Guests.model_validate_json(path.read_bytes())
    except (OSError, ValidationError) as error:
        raise GuestsInvalid(
            f'{path} is not a valid file of invitations, so Verifold cannot change it without losing the tokens '
            'that it holds. Delete the file, which makes every invitation void, and then invite each agent again.'
        ) from error


def keep_guest(path: Path, agent_id: AgentId, digest: str, port: int | None) -> None:
    """
    Add an invited agent's token digest to the file, with the port that its invitation names.

    A digest that the file holds for the agent already is replaced, so the agent's earlier token is void. Other
    users of the computer cannot read the file. The lab's own agents can, and a digest opens nothing. The new file
    replaces the old one at once, so a reader never sees half a file.

    Raises:
        GuestsInvalid: The file is there and is not valid. It stays as it is.
        OSError: The file can't be written.

    """
    before = read_guests(path)
    _write(path, Guests(port=port, digests={**before.digests, agent_id: digest}))


def drop_guest(path: Path, agent_id: AgentId) -> None:
    """
    Remove an invited agent's token digest from the file, so the agent's token is void after a restart too.

    A file that holds no digest for the agent stays as it is.

    Raises:
        GuestsInvalid: The file is there and is not valid. It stays as it is.
        OSError: The file can't be written.

    """
    before = read_guests(path)
    if agent_id in before.digests:
        kept = {agent: digest for agent, digest in before.digests.items() if agent != agent_id}
        _write(path, before.model_copy(update={'digests': kept}))


def _write(path: Path, guests: Guests) -> None:
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
