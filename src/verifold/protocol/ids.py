"""The identifiers that the society record uses."""

from typing import Annotated, Final

from pydantic import StringConstraints

type AgentId = Annotated[str, StringConstraints(pattern=r'^[a-z][a-z0-9-]{0,39}$')]
type ThreadId = Annotated[str, StringConstraints(pattern=r'^t-[1-9][0-9]*$')]
type PostId = Annotated[str, StringConstraints(pattern=r'^p-[1-9][0-9]*$')]
type CommitId = Annotated[str, StringConstraints(pattern=r'^[0-9a-f]{40}$')]

PERSON: Final = 'person'
"""The author ID of the person who directs the lab. No agent can join with it."""
