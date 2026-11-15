"""The board: the state that a lab's events add up to."""

from dataclasses import dataclass, field
from datetime import datetime
from heapq import merge

from verifold.protocol.agents import GUEST, Picture, Power
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
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
    ReviewerSet,
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
    """The revisions of the question, oldest first. Each one says who made it and which request it came from."""
    agents: tuple[AgentJoined, ...] = ()
    """Each agent's entry, with the name that the agent has now."""
    labels: tuple[tuple[int, AgentId, str], ...] = ()
    """Each label that a seat got, with the sequence number of the event that gave it, oldest first."""
    reviewers: tuple[ReviewerSet, ...] = ()
    """Each time that an agent took, got, gave up, or lost a reviewer seat, oldest first."""
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

    # ponytail: the lookups of agents and threads scan the tuples. The posts have an index.
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
        since = self.seat_since
        switches = {entry.power: entry.on for entry in self.power_sets if entry.seq > since and entry.agent == holder}
        return frozenset(power for power, on in switches.items() if on)

    @property
    def seat_since(self) -> int:
        """The event of the latest change of the coordinator seat, or zero when the seat never changed."""
        return self.coordinators[-1].seq if self.coordinators else 0

    def coordinator_at(self, seq: int) -> AgentId | None:
        """Return the agent that the record named as the holder of the coordinator seat just before an event, or `None`."""
        return next((entry.agent for entry in reversed(self.coordinators) if entry.seq < seq), None)

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

    def label(self, agent_id: AgentId, before: int | None = None) -> str:
        """
        Return the label of an agent's seat.

        It is the name that Verifold built from the harness's title and the model's name, or the name that the
        person gave an invited agent.

        With `before`, return the label that the seat had just before that event. An agent that joined later has
        its first label.
        """
        mine = tuple((seq, text) for seq, agent, text in self.labels if agent == agent_id)
        past = tuple(text for seq, text in mine if before is None or seq < before)
        return past[-1] if past else mine[0][1] if mine else agent_id

    def names(self) -> tuple[tuple[AgentId, str], ...]:
        """
        Return every name that an agent of the lab has or had, each with its agent, oldest first.

        An agent's names are each label that its seat had and each name that it chose. A name stays its agent's
        for ever, so a name in an older post means the same agent.
        """
        # Both lists are in the order of the record, so one merge keeps that order.
        chosen = ((entry.seq, entry.agent, entry.name) for entry in self.profiles if entry.name)
        return tuple(dict.fromkeys((agent, text) for _, agent, text in merge(self.labels, chosen)))

    def chosen_names(self) -> tuple[tuple[AgentId, str], ...]:
        """Return every name that an agent chose, now or before, each with its agent, oldest first."""
        return tuple(dict.fromkeys((entry.agent, entry.name) for entry in self.profiles if entry.name))

    def about_by(self, agent_id: AgentId) -> AgentId | None:
        """Return who wrote an agent's about line: the agent itself or a coordinator. `None` when it has none."""
        latest = next(
            (entry for entry in reversed(self.profiles) if entry.agent == agent_id and entry.about is not None), None
        )
        return (latest.by or agent_id) if latest and latest.about else None

    def chosen_name(self, agent_id: AgentId) -> str:
        """Return the name that an agent chose and still has, or an empty text when its seat's label is its name."""
        return next(
            (entry.name for entry in reversed(self.profiles) if entry.agent == agent_id and entry.name is not None), ''
        )

    def about(self, agent_id: AgentId) -> str:
        """Return an agent's about line as it is now. It is empty when the agent has none."""
        return next(
            (entry.about for entry in reversed(self.profiles) if entry.agent == agent_id and entry.about is not None),
            '',
        )

    def picture(self, agent_id: AgentId) -> Picture | None:
        """Return the picture that an agent chose and still has, or `None`."""
        latest = next(
            (
                entry
                for entry in reversed(self.profiles)
                if entry.agent == agent_id and (entry.picture or entry.no_picture)
            ),
            None,
        )
        return latest.picture if latest and not latest.no_picture else None

    def given_role(self, agent_id: AgentId) -> tuple[str, AgentId]:
        """
        Return the role that somebody gave an agent's seat, and who gave it: the person, or a coordinator.

        The text is empty when nobody gave one. The role that the person gave the seat when the agent joined stands
        until a later change.
        """
        given = next(
            (entry for entry in reversed(self.profiles) if entry.agent == agent_id and entry.given_role is not None),
            None,
        )
        if given and given.given_role is not None:
            return given.given_role, given.by or PERSON
        joined = self.agent(agent_id)
        return (joined.agent.given_role if joined else ''), PERSON

    def flag(self, agent_id: AgentId) -> ProfileSet | None:
        """
        Return the coordinator's flag on an agent's profile, or `None`.

        A flag stands until the coordinator takes it back, or until the agent changes its name, its about line, or
        its picture.
        """
        for entry in reversed(self.profiles):
            if entry.agent != agent_id:
                continue
            if entry.flag is not None:
                return entry if entry.flag else None
            own = entry.by is None and (entry.name is not None or entry.about is not None or entry.picture is not None)
            if own:
                return None
        return None

    def reviewer(self, agent_id: AgentId) -> bool:
        """Return whether an agent holds a reviewer seat. An agent that left the lab holds none."""
        latest = next((entry for entry in reversed(self.reviewers) if entry.agent == agent_id), None)
        return bool(latest and latest.reviewer and not self.gone(agent_id))

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
        # The fold asks this for every new post, and each of its boards has other posts, so no index pays here.
        return next((entry for entry in self.posts if entry.post.id == post_id), None)

    def replies(self, post_id: PostId) -> tuple[Posted, ...]:
        """Return the entries of the posts that reply to a post, oldest first."""
        return _index(self.posts).replies.get(post_id, ())

    def built_on(self, post_id: PostId) -> tuple[Posted, ...]:
        """Return the entries of the posts that build on a post, oldest first."""
        return _index(self.posts).builds.get(post_id, ())


@dataclass(frozen=True, slots=True)
class _Index:
    """The posts of one board by the post that they reply to, and by the posts that they build on."""

    posts: tuple[Posted, ...]
    replies: dict[PostId, tuple[Posted, ...]]
    builds: dict[PostId, tuple[Posted, ...]]


_indexes: list[_Index] = []
"""The indexes of the boards that were read last. A board never changes, so its index holds for as long as it lives."""

_KEPT_INDEXES = 4


def _index(posts: tuple[Posted, ...]) -> _Index:
    # A view asks for the replies to every post, and a scan of all posts for each one costs time that grows with
    # the square of the record. The index is built once for a board's posts, which are one tuple that no code changes.
    for index in _indexes:
        if index.posts is posts:
            return index
    replies: dict[PostId, list[Posted]] = {}
    builds: dict[PostId, list[Posted]] = {}
    for entry in posts:
        if entry.post.reply_to:
            replies.setdefault(entry.post.reply_to, []).append(entry)
        for source in dict.fromkeys(entry.post.builds_on):
            builds.setdefault(source, []).append(entry)
    index = _Index(
        posts=posts,
        replies={post: tuple(entries) for post, entries in replies.items()},
        builds={post: tuple(entries) for post, entries in builds.items()},
    )
    _indexes.append(index)
    del _indexes[:-_KEPT_INDEXES]
    return index
