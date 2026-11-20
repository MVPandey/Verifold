"""The board: the state that a lab's events add up to."""

from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime
from heapq import merge

from verifold.protocol.agents import GUEST, Picture, Power
from verifold.protocol.events import (
    ActingSet,
    ActionDecided,
    ActionsPaused,
    AgentJoined,
    AgentLeft,
    AlarmSet,
    AllowanceDrafted,
    AllowanceEnded,
    AllowanceStarted,
    BadgeSet,
    BudgetSet,
    ClaimLapsed,
    CoordinatorSet,
    DeliverableDecided,
    DeliverableSet,
    DeskSet,
    Halt,
    LabOpened,
    Limit,
    LimitReached,
    LimitsReported,
    ModeSet,
    NotesSet,
    OnCallSet,
    PaceSet,
    Posted,
    PowerSet,
    ProfileSet,
    QuestionRevised,
    RequestAnswered,
    RerunLeaseSet,
    RerunRequested,
    RerunTaken,
    ReviewerSet,
    RoundClosed,
    TaskClaimed,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnInterrupted,
    TurnStarted,
    Voted,
    WatchSet,
)
from verifold.protocol.ids import PERSON, AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.posts import FileOffer
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
    desks: tuple[DeskSet, ...] = ()
    """Each seat that the person made the lab's desk, oldest first."""
    interrupts: tuple[TurnInterrupted, ...] = ()
    """Each turn that the desk ended for the person, oldest first."""
    left: tuple[AgentLeft, ...] = ()
    """The agents that left the lab or that the person removed, oldest first."""
    threads: tuple[ThreadOpened, ...] = ()
    posts: tuple[Posted, ...] = ()
    rounds: tuple[Posted, ...] = ()
    """The posts that opened a round, oldest first. `society.rounds` says which one is open."""
    round_closes: tuple[RoundClosed, ...] = ()
    """Each close of a round that Verifold recorded, oldest first."""
    unnamed_closes: tuple[tuple[PostId, PostId | None], ...] = ()
    """
    Each close that names no candidate, oldest first, with the candidate that it closes on: the newest candidate
    that stood when the close was posted, or `None`. `society.candidates` says why.
    """
    watches: tuple[WatchSet, ...] = ()
    alarms: tuple[AlarmSet, ...] = ()
    """The alarms that agents set, oldest first."""
    profiles: tuple[ProfileSet, ...] = ()
    """What each agent said about itself, oldest first."""
    notes: tuple[NotesSet, ...] = ()
    """Each text that a seat's agent kept as its notes, oldest first."""
    starts: tuple[TurnStarted, ...] = ()
    """The starts of the agents' turns, oldest first. A record from before Verifold kept them has none."""
    turns: tuple[TurnEnded, ...] = ()
    reruns: tuple[RerunRequested, ...] = ()
    takes: tuple[RerunTaken, ...] = ()
    """Each time that an agent took the rerun of a post, oldest first."""
    leases: tuple[RerunLeaseSet, ...] = ()
    """Each time that an agent renewed or gave up its lease on a rerun that it took, oldest first."""
    claims: tuple[TaskClaimed, ...] = ()
    """Each time that an agent claimed a task or renewed its claim, oldest first. `society.tasks` says who holds what."""
    lapses: tuple[ClaimLapsed, ...] = ()
    """Each claim whose lease ended at its time, as Verifold recorded it, oldest first."""
    times: tuple[TimeSet | TimeRanOut, ...] = ()
    budgets: tuple[BudgetSet, ...] = ()
    """Each budget that the person set, oldest first."""
    limits: tuple[LimitReached, ...] = ()
    """Each time that the lab reached its budget or its disk limit, oldest first."""
    seat_limits: tuple[LimitsReported, ...] = ()
    """Each report of the usage limits of a seat's provider that the record kept, oldest first."""
    paces: tuple[PaceSet, ...] = ()
    """Each move of pace, oldest first: the pauses of seats, their ends, and the limits of tokens per hour."""
    spent_tokens: int = 0
    """The input and output tokens of every turn so far, as the harnesses reported them."""
    spent_dollars: float = 0.0
    """The cost of every turn so far, of the harnesses that report one."""
    settings: Settings = field(default_factory=Settings)
    """The person's settings for the lab: the latest that the record holds, or the defaults."""
    seat_numbers: tuple[tuple[int, int | None], ...] = ()
    """Each number of reviewer seats that the person's settings held, with the event that set it, oldest first."""
    settings_history: tuple[tuple[int, Settings], ...] = ()
    """Each of the person's settings for the lab, with the event that set it, oldest first."""
    grants: tuple[str, ...] = ()
    """The starts of the commands that the person lets every agent run."""
    power_sets: tuple[PowerSet, ...] = ()
    """Each time that the person switched a power of the coordinator on or off, oldest first."""
    answers: tuple[RequestAnswered, ...] = ()
    """The answers to the coordinator's requests for a move, oldest first."""
    votes: tuple[Voted, ...] = ()
    """Each vote on a post, oldest first. `society.votes` says which of them stand."""
    badges: tuple[BadgeSet, ...] = ()
    """Each change to a badge on a post, oldest first."""
    votes_on: dict[PostId, dict[AgentId, Voted]] = field(default_factory=dict)
    """
    The latest vote of each voter on each post, by voter, in the order cast: one that stands, or the `none` with
    which the voter took its vote back. No code changes a dictionary of a board.
    """
    badges_on: dict[PostId, tuple[BadgeSet, ...]] = field(default_factory=dict)
    """The changes to the badges of each post, oldest first."""
    deliverables: tuple[DeliverableSet, ...] = ()
    """Each time that the person stated, changed, or removed a deliverable, oldest first."""
    decisions: tuple[DeliverableDecided, ...] = ()
    """The person's decisions about offers of files for a deliverable, oldest first."""
    actings: tuple[ActingSet, ...] = ()
    """Each time that the person made a seat an acting seat or took the mark back, oldest first."""
    modes: tuple[ModeSet, ...] = ()
    """Each change of a seat's harness mode in the lab that runs, oldest first."""
    drafts: tuple[AllowanceDrafted, ...] = ()
    """Each draft of an allowance, oldest first. `society.allowances` says which one is in force."""
    allowance_starts: tuple[AllowanceStarted, ...] = ()
    allowance_ends: tuple[AllowanceEnded, ...] = ()
    """The person's confirmations of drafts and ends of allowances, oldest first."""
    pauses: tuple[ActionsPaused, ...] = ()
    """Each time that the person paused every action or let actions go on, oldest first."""
    action_decisions: tuple[ActionDecided, ...] = ()
    """The person's answers to actions that waited for them, oldest first."""

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

    @property
    def budget(self) -> BudgetSet | None:
        """The budget that the person set last, or `None` while the lab has none."""
        return self.budgets[-1] if self.budgets else None

    @property
    def at_limit(self) -> Limit | None:
        """
        The budget or the disk limit that the lab reached and that stops its agents now, or `None`.

        A budget stands as reached until the person sets the budget again, and the disk limit until the person
        changes it. The record says so again when the lab still has reached it then.
        """
        if not self.limits:
            return None
        last = self.limits[-1]
        if last.limit == 'disk':
            then = self.settings_at(last.seq).disk.limit_gb
            changed = any(seq > last.seq and settings.disk.limit_gb != then for seq, settings in self.settings_history)
            return None if changed else last.limit
        return None if self.budgets and self.budgets[-1].seq > last.seq else last.limit

    @property
    def halted(self) -> Halt | None:
        """Why the lab's agents stop now: its time ran out, or it reached its budget or its disk limit. `None` otherwise."""
        return 'time' if self.out_of_time else self.at_limit

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
        # The desk is no part of the lab's work, so it counts on neither side of a close.
        if self.is_desk(joined.agent.id):
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

    def acting(self, agent_id: AgentId) -> bool:
        """Return whether an agent's seat is an acting seat now: the person's last mark of it says so."""
        latest = next((entry for entry in reversed(self.actings) if entry.agent == agent_id), None)
        return bool(latest and latest.acting)

    def mode_of(self, agent_id: AgentId) -> str | None:
        """Return the harness mode of an agent's seat: the person's last change, or the mode that it joined with."""
        latest = next((entry for entry in reversed(self.modes) if entry.agent == agent_id), None)
        joined = self.agent(agent_id)
        return latest.mode if latest else joined.agent.mode if joined else None

    @property
    def actions_paused(self) -> ActionsPaused | None:
        """The person's pause of every action while it stands, or `None` while actions may go on."""
        latest = self.pauses[-1] if self.pauses else None
        return latest if latest and latest.paused else None

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
    def desk(self) -> AgentId | None:
        """The agent that holds the lab's desk seat, or `None`. An agent that left the lab holds it no longer."""
        holder = self.desks[-1].agent if self.desks else None
        return holder if holder and not self.gone(holder) else None

    def is_desk(self, agent_id: AgentId) -> bool:
        """
        Return whether an agent's seat is or was the lab's desk.

        The person makes a seat the desk when the agent joins, and the seat stays so, also after the agent left.
        """
        return any(entry.agent == agent_id for entry in self.desks)

    @property
    def desk_chat(self) -> ThreadId | None:
        """The thread where the person and the lab's desk talk, or `None` while the lab has none."""
        return next((entry.thread.id for entry in self.threads if entry.thread.desk), None)

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

    def notes_of(self, agent_id: AgentId) -> NotesSet | None:
        """Return a seat's notes as they stand: the latest text that its agent kept, or `None` while it kept none."""
        latest = next((entry for entry in reversed(self.notes) if entry.agent == agent_id), None)
        return latest if latest and latest.text else None

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
        from the thread until it watches again, and an agent that left the lab stays in the list too. The person posts in a side thread without being a member.
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
        # The desk posts for the person, so a post of the desk in a side thread makes it no member.
        agents = {
            joined.agent.id for joined in self.agents if not joined.agent.checks and not self.is_desk(joined.agent.id)
        }
        return tuple(dict.fromkeys((*opened.thread.between, *(agent for _, agent in came if agent in agents))))

    def offers(self, deliverable_id: DeliverableId) -> tuple[Posted, ...]:
        """Return the entries of the offers of files for a deliverable, oldest first."""
        return _index(self.posts).offers.get(deliverable_id, ())

    def offers_thread(self, deliverable_id: DeliverableId) -> ThreadId | None:
        """Return the thread that holds the offers for a deliverable, or `None` until the first offer opens it."""
        return next((entry.thread.id for entry in self.threads if entry.thread.deliverable == deliverable_id), None)

    def thread_posts(self, thread_id: ThreadId) -> tuple[Posted, ...]:
        """Return the entries of the posts of a thread, oldest first."""
        return _index(self.posts).threads.get(thread_id, ())

    def offer_listeners(self, thread_id: ThreadId, before: int | None = None) -> tuple[AgentId, ...]:
        """
        Return the agents that a post of the person in a thread of offers reaches when it names nobody.

        They are the agents that offered files in the thread, and the agents that said that they watch it, without
        the agents that left the lab. With `before`, the list is as it was just before that event. When it is
        empty, such a post is for every agent that is not on call, as the person's words to the lab are.
        """
        ahead = lambda seq: before is None or seq < before
        offered = (
            entry.post.author
            for entry in self.thread_posts(thread_id)
            if isinstance(entry.post, FileOffer) and ahead(entry.seq)
        )
        said = {watch.agent: watch.watching for watch in self.watches if watch.thread == thread_id and ahead(watch.seq)}
        gone = {left.agent for left in self.left if ahead(left.seq)}
        every = dict.fromkeys((*offered, *(agent for agent, watching in said.items() if watching)))
        return tuple(agent for agent in every if agent not in gone)

    def holds_offers(self, thread_id: ThreadId) -> bool:
        """Return whether a thread is the thread of the offers for a deliverable. No post there is for every agent."""
        opened = self.thread(thread_id)
        return bool(opened and opened.thread.deliverable)

    def settings_at(self, seq: int) -> Settings:
        """Return the settings that the lab followed at event `seq`: the latest ones by then, or the defaults."""
        index = bisect_right(self.settings_history, seq, key=lambda pair: pair[0])
        return self.settings_history[index - 1][1] if index else Settings()

    def take(self, agent_id: AgentId, post_id: PostId) -> RerunTaken | None:
        """Return the entry with which an agent took the rerun of a post, or `None`. An agent takes a post once."""
        return next((entry for entry in self.takes if entry.agent == agent_id and entry.post == post_id), None)

    def post(self, post_id: PostId) -> Posted | None:
        """Return the entry of a post, or `None`."""
        # The fold asks this for every new post, and each of its boards has other posts, so building an index for
        # this alone does not pay. A view reads the replies first, so its board has an index, and the lookup uses it.
        index = _built(self.posts)
        if index is not None:
            return index.ids.get(post_id)
        return next((entry for entry in self.posts if entry.post.id == post_id), None)

    def replies(self, post_id: PostId) -> tuple[Posted, ...]:
        """Return the entries of the posts that reply to a post, oldest first."""
        return _index(self.posts).replies.get(post_id, ())

    def built_on(self, post_id: PostId) -> tuple[Posted, ...]:
        """Return the entries of the posts that build on a post, oldest first."""
        return _index(self.posts).builds.get(post_id, ())


@dataclass(frozen=True, slots=True)
class _Index:
    """The posts of one board by ID, by the post that they reply to, by the posts that they build on, by thread, and the offers by deliverable."""

    posts: tuple[Posted, ...]
    ids: dict[PostId, Posted]
    replies: dict[PostId, tuple[Posted, ...]]
    builds: dict[PostId, tuple[Posted, ...]]
    offers: dict[DeliverableId, tuple[Posted, ...]]
    threads: dict[ThreadId, tuple[Posted, ...]]


_indexes: list[_Index] = []
"""The indexes of the boards that were read last. A board never changes, so its index holds for as long as it lives."""

_KEPT_INDEXES = 4


def _built(posts: tuple[Posted, ...]) -> _Index | None:
    # The index of a board's posts when one was built already, or `None`.
    return next((index for index in _indexes if index.posts is posts), None)


def _index(posts: tuple[Posted, ...]) -> _Index:
    # A view asks for the replies to every post, and a scan of all posts for each one costs time that grows with
    # the square of the record. The index is built once for a board's posts, which are one tuple that no code changes.
    built = _built(posts)
    if built is not None:
        return built
    replies: dict[PostId, list[Posted]] = {}
    builds: dict[PostId, list[Posted]] = {}
    offers: dict[DeliverableId, list[Posted]] = {}
    threads: dict[ThreadId, list[Posted]] = {}
    for entry in posts:
        threads.setdefault(entry.post.thread, []).append(entry)
        if isinstance(entry.post, FileOffer):
            offers.setdefault(entry.post.deliverable, []).append(entry)
        if entry.post.reply_to:
            replies.setdefault(entry.post.reply_to, []).append(entry)
        for source in dict.fromkeys(entry.post.builds_on):
            builds.setdefault(source, []).append(entry)
    index = _Index(
        posts=posts,
        ids={entry.post.id: entry for entry in posts},
        replies={post: tuple(entries) for post, entries in replies.items()},
        builds={post: tuple(entries) for post, entries in builds.items()},
        offers={deliverable: tuple(entries) for deliverable, entries in offers.items()},
        threads={thread: tuple(entries) for thread, entries in threads.items()},
    )
    _indexes.append(index)
    del _indexes[:-_KEPT_INDEXES]
    return index
