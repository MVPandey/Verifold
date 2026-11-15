"""The board: the state that a lab's events add up to."""

from dataclasses import dataclass, field
from datetime import datetime

from verifold.protocol.agents import GUEST, Power
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AgentNamed,
    AlarmSet,
    CoordinatorSet,
    LabOpened,
    OnCallSet,
    Posted,
    PowerSet,
    ProfileSet,
    QuestionRevised,
    RequestAnswered,
    RerunRequested,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    WatchSet,
)
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.settings import Settings


@dataclass(frozen=True, slots=True)
class Board:
    """
    The lab after all its events, in order.

    Each entry is the event that added it, so it keeps its time and sequence number.
    """

    opened: LabOpened
    seq: int
    revisions: tuple[QuestionRevised, ...] = ()
    """The person's revisions of the question, oldest first."""
    agents: tuple[AgentJoined, ...] = ()
    """Each agent's entry, with the name that the agent has now."""
    renames: tuple[tuple[AgentNamed, str], ...] = ()
    """Each new name that an agent got, with the name that it had before, oldest first."""
    on_calls: tuple[OnCallSet, ...] = ()
    """Each time that the person put a seat on call or took it off, oldest first."""
    coordinators: tuple[CoordinatorSet, ...] = ()
    """Each change of the lab's coordinator, oldest first."""
    left: tuple[AgentLeft, ...] = ()
    """The agents that left the lab or that the person removed, oldest first."""
    threads: tuple[ThreadOpened, ...] = ()
    posts: tuple[Posted, ...] = ()
    watches: tuple[WatchSet, ...] = ()
    alarms: tuple[AlarmSet, ...] = ()
    """The alarms that agents set, oldest first."""
    profiles: tuple[ProfileSet, ...] = ()
    """What each agent said about itself, oldest first."""
    starts: tuple[TurnStarted, ...] = ()
    """The starts of the agents' turns, oldest first. A record from before Verifold kept them has none."""
    turns: tuple[TurnEnded, ...] = ()
    reruns: tuple[RerunRequested, ...] = ()
    times: tuple[TimeSet | TimeRanOut, ...] = ()
    settings: Settings = field(default_factory=Settings)
    """The person's settings for the lab: the latest that the record holds, or the defaults."""
    grants: tuple[str, ...] = ()
    """The starts of the commands that the person lets every agent run."""
    power_sets: tuple[PowerSet, ...] = ()
    """Each time that the person switched a power of the coordinator on or off, oldest first."""
    answers: tuple[RequestAnswered, ...] = ()
    """The answers to the coordinator's requests for a move, oldest first."""

    @property
    def question(self) -> str:
        """The question that the lab works on now: the person's latest revision, or the text that the lab opened with."""
        return self.revisions[-1].question if self.revisions else self.opened.question

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
        return joined.agent.harness != GUEST or self._posted(joined.agent.id, before)

    def counts(self, joined: AgentJoined, before: int | None = None) -> bool:
        """
        Return whether an agent counts among the lab's agents when they decide that the lab is done.

        An agent does when it is known to be in the lab. An on-call agent does from its first post, by the rule
        for an invited agent: until then no post for every agent reached it, so the lab does not wait for its word.
        With `before`, the seat counts as it was at that event. So a switch of the seat after a close changes
        neither who counted for the close nor whether the lab is closed. An agent that joined after that event
        does not count, whatever its seat: a seat that the person adds to a closed lab leaves it closed.
        """
        if before is not None and joined.seq > before:
            return False
        if self.on_call(joined.agent.id, before):
            return self._posted(joined.agent.id, before)
        return self.came(joined, before)

    def _posted(self, agent_id: AgentId, before: int | None) -> bool:
        return any(entry.post.author == agent_id and (before is None or entry.seq < before) for entry in self.posts)

    def on_call(self, agent_id: AgentId, before: int | None = None) -> bool:
        """
        Return whether the person put an agent's seat on call, and did not take it off since.

        With `before`, return whether the seat was on call just before that event.
        """
        switches = (
            entry
            for entry in reversed(self.on_calls)
            if entry.agent == agent_id and (before is None or entry.seq < before)
        )
        latest = next(switches, None)
        return bool(latest and latest.on_call)

    @property
    def coordinator(self) -> AgentId | None:
        """The agent that holds the lab's coordinator seat, or `None`. An agent that left the lab holds it no longer."""
        holder = self.coordinators[-1].agent if self.coordinators else None
        return holder if holder and not self.gone(holder) else None

    @property
    def coordinator_open(self) -> bool:
        """
        Whether an agent may take the coordinator seat by itself now.

        It may while nobody holds the seat and the person did not close it: nobody ever held it, its holder gave it
        up or left the lab by itself, or the person said that agents may take it. The person closes the seat when
        they clear it or remove its holder.
        """
        if not self.coordinators:
            return True
        last = self.coordinators[-1]
        if last.agent is None:
            return last.by != PERSON or last.open
        left = self.gone(last.agent)
        return left is not None and left.by == last.agent

    @property
    def powers(self) -> frozenset[Power]:
        """
        The powers that the agent that holds the coordinator seat has now.

        A power is on when the person switched it on for this holder after the seat last changed, and did not
        switch it off since. So no power outlives a change of the seat, and an agent that takes the seat by itself
        starts with none.
        """
        holder = self.coordinator
        if holder is None:
            return frozenset()
        since = self.coordinators[-1].seq
        switches = {entry.power: entry.on for entry in self.power_sets if entry.seq > since and entry.agent == holder}
        return frozenset(power for power, on in switches.items() if on)

    @property
    def conversation(self) -> ThreadId | None:
        """The thread where the person and the lab's coordinator talk, or `None` while the lab has none."""
        return next((entry.thread.id for entry in self.threads if entry.thread.conversation), None)

    def answer_to(self, request_id: PostId) -> RequestAnswered | None:
        """Return the answer to a coordinator's request for a move, or `None` while it has none."""
        return next((entry for entry in self.answers if entry.request == request_id), None)

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

    def failure(self, agent_id: AgentId) -> TurnEnded | None:
        """
        Return the entry of an agent's latest turn, or of the latest start of its harness, when that failed.

        A failure shows no longer once a turn of the agent started after it, or a later turn ended well.
        """
        latest = next((turn for turn in reversed(self.turns) if turn.agent == agent_id), None)
        if latest is None or latest.error is None:
            return None
        again = any(start.agent == agent_id and start.seq > latest.seq for start in self.starts)
        return None if again else latest

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
