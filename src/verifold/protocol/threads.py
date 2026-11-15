"""The threads of the board."""

from typing import Annotated, Final

from pydantic import StringConstraints

from verifold.protocol.ids import AgentId, ThreadId
from verifold.protocol.record import Record

type Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]

QUESTION_TITLE: Final = 'The question'
"""The title of the thread that a lab opens with. It holds the person's question, the plans, and the lab's answer."""


class Thread(Record):
    """One conversation with one subject."""

    id: ThreadId
    title: Title
    opened_by: AgentId
    between: tuple[AgentId, ...] = ()
    """
    The agents that a side thread opened between, with the agent that opened it first. Empty for any other thread.

    A post in a side thread reaches its members and not every agent. Every agent and the person can read it.
    """
