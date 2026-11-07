"""The threads of the board."""

from typing import Annotated

from pydantic import StringConstraints

from verifold.protocol.ids import AgentId, ThreadId
from verifold.protocol.record import Record

type Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class Thread(Record):
    """One conversation with one subject."""

    id: ThreadId
    title: Title
    opened_by: AgentId
