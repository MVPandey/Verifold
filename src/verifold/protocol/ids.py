"""The identifiers that the society record uses."""

from typing import Annotated, Final

from pydantic import StringConstraints

type AgentId = Annotated[str, StringConstraints(pattern=r'^[a-z][a-z0-9-]{0,39}$')]
type ThreadId = Annotated[str, StringConstraints(pattern=r'^t-[1-9][0-9]*$')]
type PostId = Annotated[str, StringConstraints(pattern=r'^p-[1-9][0-9]*$')]
type DeliverableId = Annotated[str, StringConstraints(pattern=r'^d-[1-9][0-9]*$')]
type CommitId = Annotated[str, StringConstraints(pattern=r'^[0-9a-f]{40}$')]

PERSON: Final = 'person'
"""The author ID of the person who directs the lab. No agent can join with it."""
type BranchId = Annotated[str, StringConstraints(pattern=r'^b-[1-9][0-9]*$')]
"""A branch of the question, which a reading adds. Verifold numbers the branches of a lab in the order they come."""
type Parent = Annotated[str, StringConstraints(pattern=r'^[bp]-[1-9][0-9]*$')]
"""What an idea hangs on: a branch of the question, such as `b-2`, or another idea, by its post ID, such as `p-14`."""

UNSIGNED: Final = 'unsigned'
"""
The author of an idea of an open round, as the board shows it to every other agent until the round closes. No agent
can join with it.
"""
