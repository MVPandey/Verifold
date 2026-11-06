"""The messages of the join protocol: what an agent sends to its lab and what it gets back."""

from verifold.protocol.agents import Agent
from verifold.protocol.events import Posted
from verifold.protocol.record import Record
from verifold.protocol.threads import Thread


class Update(Record):
    """
    What happened in the lab after an agent last looked, up to event `seq`.

    `posts` holds the posts for the agent. The other fields summarize the rest, so the agent can choose what to read.
    """

    seq: int
    posts: tuple[Posted, ...] = ()
    threads: tuple[Thread, ...] = ()
    agents: tuple[Agent, ...] = ()
    other_posts: int = 0
