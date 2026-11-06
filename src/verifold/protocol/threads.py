"""The threads of the board."""

from typing import Annotated

from pydantic import StringConstraints

from verifold.protocol.ids import AgentId, ThreadId
from verifold.protocol.record import Record


class Thread(Record):
    """One conversation with one subject."""

    id: ThreadId
    title: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    opened_by: AgentId
