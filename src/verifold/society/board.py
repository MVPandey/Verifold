"""The board: the state that a lab's events add up to."""

from dataclasses import dataclass
from datetime import datetime

from verifold.protocol.events import (
    AgentJoined,
    LabOpened,
    Posted,
    RerunRequested,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    WatchSet,
)
from verifold.protocol.ids import AgentId, PostId, ThreadId


@dataclass(frozen=True, slots=True)
class Board:
    """
    The lab after all its events, in order.

    Each entry is the event that added it, so it keeps its time and sequence number.
    """

    opened: LabOpened
    seq: int
    agents: tuple[AgentJoined, ...] = ()
    threads: tuple[ThreadOpened, ...] = ()
    posts: tuple[Posted, ...] = ()
    watches: tuple[WatchSet, ...] = ()
    turns: tuple[TurnEnded, ...] = ()
    reruns: tuple[RerunRequested, ...] = ()
    times: tuple[TimeSet | TimeRanOut, ...] = ()

    @property
    def ends_at(self) -> datetime | None:
        """When the lab ends, or `None` when it has no time limit."""
        latest = next((entry for entry in reversed(self.times) if isinstance(entry, TimeSet)), None)
        return latest.ends_at if latest else self.opened.ends_at

    @property
    def out_of_time(self) -> bool:
        """Whether the lab reached its end, and the person has not set a new end since."""
        return bool(self.times) and isinstance(self.times[-1], TimeRanOut)

    # ponytail: lookups scan the tuples. Index them if a board grows past about 10,000 posts.
    def agent(self, agent_id: AgentId) -> AgentJoined | None:
        """Return the entry of a joined agent, or `None`."""
        return next((entry for entry in self.agents if entry.agent.id == agent_id), None)

    def thread(self, thread_id: ThreadId) -> ThreadOpened | None:
        """Return the entry of a thread, or `None`."""
        return next((entry for entry in self.threads if entry.thread.id == thread_id), None)

    def post(self, post_id: PostId) -> Posted | None:
        """Return the entry of a post, or `None`."""
        return next((entry for entry in self.posts if entry.post.id == post_id), None)

    def replies(self, post_id: PostId) -> tuple[Posted, ...]:
        """Return the entries of the posts that reply to a post, oldest first."""
        return tuple(entry for entry in self.posts if entry.post.reply_to == post_id)
