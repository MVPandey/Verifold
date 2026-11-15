"""The threads of the board."""

from typing import Annotated, Final, Literal

from pydantic import StringConstraints

from verifold.protocol.ids import AgentId, ThreadId
from verifold.protocol.record import Record

type Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]

QUESTION_TITLE: Final = 'The question'
"""The title of the thread that a lab opens with. It holds the person's question, the plans, and the lab's answer."""


type Carries = Literal['permission', 'question']
"""The kind of request of a harness that a thread carries to the person."""


class Thread(Record):
    """One conversation with one subject."""

    id: ThreadId
    title: Title
    opened_by: AgentId
    between: tuple[AgentId, ...] = ()
    """
    The agents that a side thread opened between, with the agent that opened it first. Empty for any other thread.

    A post in a side thread reaches the members that watch it, and not every agent. The person and every agent
    that reads the board can read it. Any other thread is a thread for the whole lab.
    """
    carries: Carries | None = None
    """
    For the thread that Verifold opened for an agent's requests of one kind: that kind. Only the runner sets it, so
    an agent's own thread with a like title never gets a tracked ask. `None` for any other thread, and in a record
    from before Verifold kept it.
    """
