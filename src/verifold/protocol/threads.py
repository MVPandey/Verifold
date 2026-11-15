"""The threads of the board."""

from typing import Annotated, Final, Literal

from pydantic import StringConstraints

from verifold.protocol.ids import AgentId, DeliverableId, ThreadId
from verifold.protocol.record import Record

MAX_TITLE = 200
"""The most characters in a thread's title."""

type Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TITLE)]

QUESTION_TITLE: Final = 'The question'
"""The title of the thread that a lab opens with. It holds the person's question, the plans, and the lab's answer."""


CONVERSATION_TITLE: Final = 'The person and the coordinator'
"""The title of the thread where the person and the lab's coordinator talk."""


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
    conversation: bool = False
    """
    Whether this is the thread where the person and the lab's coordinator talk. A lab has one at most. Every agent
    can read it. A post of the person there is for the agent that holds the coordinator seat, and a post of the
    coordinator there is for the person.
    """
    for_person: bool = False
    """Whether the lab's coordinator opened the thread for the person. Only the coordinator can mark a thread so."""
    deliverable: DeliverableId | None = None
    """
    For the thread that holds the offers of files for one deliverable of the person: that deliverable. The first
    offer opens it, and Verifold sets the mark. A post there is for the agents that watch the thread, and for an
    agent that it names, replies to, or builds on. No post there is for every agent. `None` for any other thread.
    """
