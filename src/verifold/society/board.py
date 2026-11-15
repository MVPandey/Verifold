"""The board: the state that a lab's events add up to."""

from dataclasses import dataclass, field
from datetime import datetime

from verifold.protocol.agents import GUEST
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AlarmSet,
    LabOpened,
    Posted,
    ProfileSet,
    RerunRequested,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    WatchSet,
)
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.settings import Settings


@dataclass(frozen=True, slots=True)
class Board:
    """
    The lab after all its events, in order.

    Each entry is the event that added it, so it keeps its time and sequence number.
    """

    opened: LabOpened
    seq: int
    agents: tuple[AgentJoined, ...] = ()
    left: tuple[AgentLeft, ...] = ()
    """The agents that left the lab or that the person removed, oldest first."""
    threads: tuple[ThreadOpened, ...] = ()
    posts: tuple[Posted, ...] = ()
    watches: tuple[WatchSet, ...] = ()
    alarms: tuple[AlarmSet, ...] = ()
    """The alarms that agents set, oldest first."""
    profiles: tuple[ProfileSet, ...] = ()
    """What each agent said about itself, oldest first."""
    turns: tuple[TurnEnded, ...] = ()
    reruns: tuple[RerunRequested, ...] = ()
    times: tuple[TimeSet | TimeRanOut, ...] = ()
    settings: Settings = field(default_factory=Settings)
    """The person's settings for the lab: the latest that the record holds, or the defaults."""
    grants: tuple[str, ...] = ()
    """The starts of the commands that the person lets every agent run."""

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

    def came(self, joined: AgentJoined, before: int | None = None) -> bool:
        """
        Return whether an agent of the lab is known to be in it.

        An agent that Verifold started is. An invited agent is from its first post, because until then nobody knows
        whether it used its invitation. With `before`, only its posts before that event count.
        """
        if joined.agent.harness != GUEST:
            return True
        return any(
            entry.post.author == joined.agent.id and (before is None or entry.seq < before) for entry in self.posts
        )

    def gone(self, agent_id: AgentId) -> AgentLeft | None:
        """Return the entry that says that an agent left the lab, or `None` while it is in the lab."""
        return next((entry for entry in self.left if entry.agent == agent_id), None)

    def here(self, joined: AgentJoined) -> bool:
        """Return whether an agent is in the lab now: it is known to be in it, and it has not left."""
        return self.came(joined) and not self.gone(joined.agent.id)

    def profile(self, agent_id: AgentId) -> tuple[str, str]:
        """Return the role and the status that an agent gave itself last. Each is empty when it gave none."""
        mine = tuple(entry for entry in self.profiles if entry.agent == agent_id)
        role = next((entry.role for entry in reversed(mine) if entry.role is not None), '')
        status = next((entry.status for entry in reversed(mine) if entry.status is not None), '')
        return role, status

    def thread(self, thread_id: ThreadId) -> ThreadOpened | None:
        """Return the entry of a thread, or `None`."""
        return next((entry for entry in self.threads if entry.thread.id == thread_id), None)

    def is_side(self, thread_id: ThreadId) -> bool:
        """Return whether a thread is a side thread: a thread between named agents, and not one for the whole lab."""
        opened = self.thread(thread_id)
        return bool(opened and opened.thread.between)

    def members(self, thread_id: ThreadId) -> tuple[AgentId, ...]:
        """
        Return the members of a side thread, in the order that they came. A thread that is no side thread has none.

        The agents that the thread opened between come first. Then comes each agent that posted in the thread or
        started to watch it. Nobody leaves the list: an agent that stops watching stays a member and hears nothing
        from the thread until it watches again, and an agent that left the lab stays in the list too. The person and blind checkers post in a side thread without being members.
        """
        opened = self.thread(thread_id)
        if opened is None or not opened.thread.between:
            return ()
        came = sorted(
            (
                *((entry.seq, entry.post.author) for entry in self.posts if entry.post.thread == thread_id),
                *((watch.seq, watch.agent) for watch in self.watches if watch.thread == thread_id and watch.watching),
            )
        )
        agents = {joined.agent.id for joined in self.agents if not joined.agent.checks}
        return tuple(dict.fromkeys((*opened.thread.between, *(agent for _, agent in came if agent in agents))))

    def post(self, post_id: PostId) -> Posted | None:
        """Return the entry of a post, or `None`."""
        return next((entry for entry in self.posts if entry.post.id == post_id), None)

    def replies(self, post_id: PostId) -> tuple[Posted, ...]:
        """Return the entries of the posts that reply to a post, oldest first."""
        return tuple(entry for entry in self.posts if entry.post.reply_to == post_id)

    def built_on(self, post_id: PostId) -> tuple[Posted, ...]:
        """Return the entries of the posts that build on a post, oldest first."""
        return tuple(entry for entry in self.posts if post_id in entry.post.builds_on)
