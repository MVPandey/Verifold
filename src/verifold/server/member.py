"""One agent's seat in its lab."""

import asyncio
from collections.abc import Awaitable, Callable

from verifold.protocol.agents import GUEST, Picture
from verifold.protocol.events import AgentLeft, AlarmSet, RerunRequested, WatchSet
from verifold.protocol.ids import PERSON, AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import (
    Brief,
    News,
    PostRequest,
    PostView,
    ProfileResult,
    ThreadList,
    ThreadView,
    Update,
)
from verifold.protocol.moves import AddMove, AddSeat, Move
from verifold.protocol.posts import FileEvidence
from verifold.server.errors import BlindCheck, CannotWake, EvidenceRejected, HasLeft, OutOfTime, UnknownAgent
from verifold.server.lab import Adds, Lab
from verifold.society.attention import news, update
from verifold.society.deliverables import live
from verifold.society.identity import post_view
from verifold.society.views import brief, profile_result, side_lines, thread_summaries, thread_view, work_threads

type Pin = Callable[[tuple[str, ...]], Awaitable[tuple[FileEvidence, ...]]]
"""Commits an agent's folder and returns each named file pinned to that commit."""


class Member:
    """
    What one agent does in its lab: post, read, watch, and wait.

    The member remembers how far its agent has read. `news` and `wait` return only what came after, so the agent
    gets each post once, and a post that it got during a turn does not wake it later.
    """

    def __init__(  # noqa: PLR0913
        self,
        lab: Lab,
        agent_id: AgentId,
        pin: Pin | None = None,
        seen: int | None = None,
        *,
        adds: Adds | None = None,
        seat_ok: Callable[[AddSeat], None] | None = None,
    ) -> None:
        """
        Seat an agent that has joined the lab. It has read everything up to now, or up to event `seen` when given.

        `pin` commits the agent's folder and pins the files that a post names. Without it, posts cannot name files.
        `adds` starts an agent for the coordinator's move that adds one. Without it, the lab refuses such a move
        while the coordinator's power over agents is on, and the request waits for the person otherwise.
        `seat_ok` refuses a seat whose harness this computer does not have, when the coordinator asks for it.
        """
        self._adds = adds
        self._seat_ok = seat_ok
        self._lab = lab
        self.agent_id = agent_id
        self._seen = lab.board.seq if seen is None else seen
        self.void = False
        """Whether the agent got a new token, so that this seat's open `wait` must return nothing more."""
        self._pin = pin
        self._briefed = False

    @property
    def seen(self) -> int:
        """The last event that the agent got, from `news` or `wait`."""
        return self._seen

    @property
    def lab(self) -> Lab:
        """The lab that the agent works in."""
        return self._lab

    def check_here(self) -> None:
        """
        Check that the agent is still in the lab. The join endpoint calls it before every tool.

        An agent that left gets nothing more from the board: no write, and no read either. So a token that outlives
        its agent, such as an invited agent's, opens nothing.

        Raises:
            HasLeft: The agent left the lab, or the person removed it.

        """
        left = self._lab.board.gone(self.agent_id)
        if left:
            how = 'The person removed you from this lab' if left.by == PERSON else 'You left this lab'
            if left.through:
                how = f'{left.through}, the coordinator, removed you from this lab with a power that the person gave it'
            elif left.request:
                how = f"The person removed you from this lab, with a yes to the coordinator's request {left.request}"
            raise HasLeft(f'{how}, so the board takes no call from you. Your posts stay on it.')

    async def leave(self, reason: str = '') -> AgentLeft:
        """
        Leave the lab, for good. The agent's posts stay.

        Raises:
            RejectedEvent: The agent is a blind checker.

        """
        return await self._lab.leave(self.agent_id, self.agent_id, reason)

    async def post(self, request: PostRequest) -> PostView:
        """
        Post as the agent, with its files pinned as evidence, and return the post as it stands.

        Raises:
            EvidenceRejected: The post names files, and this member cannot pin them or they are not in the folder.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        board = self._lab.board
        evidence: tuple[FileEvidence, ...] = ()
        if request.files:
            if self._pin is None:
                raise EvidenceRejected('This lab cannot pin files for you.')
            evidence = await self._pin(request.files)
        # A proposal keeps which revisions of the question its author had been shown. An agent that worked on an
        # earlier version can post just after a revision, and its answer is then to that earlier version.
        seen = sum(self._seen >= told.seq for revision in board.revisions if (told := board.post(revision.post)))
        posted = await self._lab.post(request, self.agent_id, evidence, seen)
        return post_view(self._lab.board, posted)

    async def offer(self, deliverable_id: DeliverableId, files: tuple[str, ...], note: str, body: str = '') -> PostView:
        """
        Offer files of the agent's folder for a deliverable of the person, and return the offer as it stands.

        Raises:
            BlindCheck: The agent is a blind checker.
            EvidenceRejected: This member cannot pin files, or a file is not in the folder.
            RejectedEvent: The lab has no such deliverable, or the person removed it.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_not_blind()
        self._check_in_time()
        # The folder gets a commit only for an offer that the board can take.
        live(self._lab.board, deliverable_id)
        if self._pin is None:
            raise EvidenceRejected('This lab cannot pin files for you.')
        evidence = await self._pin(files)
        posted = await self._lab.offer(self.agent_id, deliverable_id, evidence, note, body)
        return post_view(self._lab.board, posted)

    async def request(self, move: Move, text: str, body: str = '') -> PostView:
        """
        Ask the person for a move as the lab's coordinator, and return the request as it stands.

        While the person's power for this kind of move is on, the move takes effect with the request.

        Raises:
            RejectedEvent: The agent does not hold the coordinator seat, or the move cannot be made.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        if isinstance(move, AddMove) and self._seat_ok:
            # A seat whose harness this computer lacks is refused now, so it never waits for the person.
            self._seat_ok(move.seat)
        posted = await self._lab.request(move, text, body, self.agent_id, self._adds)
        return post_view(self._lab.board, posted)

    def news(self) -> News | None:
        """
        Return the posts that the agent has not seen yet, and count them as seen.

        Every board tool adds it to its result, so posts reach an agent that works, not only one that waits. A blind
        checker gets `None`.
        """
        return None if self._checks() else self._unseen()

    def brief(self, how: str) -> Brief:
        """
        Return the lab in one read: its state and time, the other agents and their plans, the threads, and the posts.

        `how` says how the board works. Only the member's first brief carries it.
        """
        self._check_not_blind()
        first, self._briefed = not self._briefed, True
        return brief(self._lab.board, self.agent_id, self._unseen(), how if first else '', now=self._lab.now())

    def _unseen(self) -> News:
        unseen = news(self._lab.board, self.agent_id, self._seen)
        self._seen = unseen.seq
        return unseen

    def rewind(self, seq: int) -> None:
        """
        Count the posts after event `seq` as not seen again.

        A turn that fails can lose the tool results that carried them, so the agent gets them once more.
        """
        self._seen = min(self._seen, seq)

    def threads(self) -> ThreadList:
        """
        Return a summary of each thread that is not a side thread, and one line for each side thread.

        Both have the most recently active first, and the agent's own side threads come before the others.
        """
        self._check_not_blind()
        every = thread_summaries(self._lab.board, self.agent_id)
        return ThreadList(threads=work_threads(every), side_threads=side_lines(every, self.agent_id))

    def thread(self, thread_id: ThreadId) -> ThreadView:
        """Return a thread and its posts."""
        self._check_not_blind()
        return thread_view(self._lab.board, self.agent_id, thread_id)

    async def rerun(self, post_id: PostId) -> RerunRequested:
        """
        Ask for a blind rerun of a post that has files as evidence.

        Raises:
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        return await self._lab.request_rerun(self.agent_id, post_id)

    def _checks(self) -> str | None:
        joined = self._lab.board.agent(self.agent_id)
        return joined.agent.checks if joined else None

    def _check_not_blind(self) -> None:
        if target := self._checks():
            raise BlindCheck(f'You rerun {target} blind, so you cannot read the board.')

    def _is_guest(self) -> bool:
        joined = self._lab.board.agent(self.agent_id)
        return bool(joined and joined.agent.harness == GUEST)

    def _check_in_time(self) -> None:
        # Verifold stops the turn of an agent that it started. It cannot stop an invited agent, so the board
        # refuses that agent instead. The end can pass a moment before the record says so.
        board = self._lab.board
        ended = board.out_of_time or (board.ends_at is not None and self._lab.now() >= board.ends_at)
        if ended and self._is_guest():
            raise OutOfTime(
                "The lab's time ran out or the person stopped the lab, so the board takes no post and no rerun "
                'request from you now. The person can give the lab more time.'
            )

    async def set_alarm(self, minutes: float, *, quiet: bool) -> AlarmSet:
        """
        Ask Verifold to wake the agent when it is in no turn and no post for it wakes it first.

        Raises:
            CannotWake: The agent joined with an invitation, so Verifold cannot wake it.

        """
        self._check_not_blind()
        if self._is_guest():
            # An alarm that never rings would tell the agent a time that means nothing.
            raise CannotWake(
                'You joined with an invitation, so Verifold cannot wake you and sets no alarm. `wait` returns when '
                'a post for you arrives.'
            )
        return await self._lab.set_alarm(self.agent_id, minutes, quiet=quiet)

    async def set_profile(  # noqa: PLR0913
        self,
        role: str | None = None,
        status: str | None = None,
        *,
        name: str | None = None,
        about: str | None = None,
        picture: Picture | None = None,
        coordinator: bool | None = None,
        reviewer: bool | None = None,
    ) -> ProfileResult:
        """
        Record the agent's own profile, and return it after the change.

        With `coordinator`, the agent takes the lab's coordinator seat, or gives it up. With `reviewer`, it takes a
        reviewer seat, or gives it up. The record takes the whole call or nothing. With nothing, the call returns
        the profile as it is.

        Raises:
            RejectedEvent: The agent takes a seat that is not free, gives up a seat that it does not hold, or
                chooses a name that it cannot have.

        """
        self._check_not_blind()
        await self._lab.set_profile(
            self.agent_id,
            role,
            status,
            name=name,
            about=about,
            picture=picture,
            coordinator=coordinator,
            reviewer=reviewer,
        )
        return profile_result(self._lab.board, self.agent_id)

    async def change_profile(
        self,
        agent_id: AgentId,
        *,
        reset_name: bool = False,
        about: str | None = None,
        given_role: str | None = None,
        flag: str | None = None,
    ) -> ProfileResult:
        """
        Change another agent's profile as the lab's coordinator, and return that profile after the change.

        Raises:
            RejectedEvent: The agent that calls does not hold the coordinator seat, or the other agent is not in
                the lab.

        """
        self._check_not_blind()
        await self._lab.change_profile(
            agent_id, self.agent_id, reset_name=reset_name, about=about, given_role=given_role, flag=flag
        )
        return profile_result(self._lab.board, agent_id)

    async def watch(self, thread_id: ThreadId, *, watching: bool) -> WatchSet:
        """Start or stop watching a thread."""
        return await self._lab.watch(self.agent_id, thread_id, watching=watching)

    async def wait(self, timeout: float) -> Update:
        """
        Return what happened since the agent last looked, once a post wakes it or `timeout` seconds pass.

        Posts that don't wake the agent count toward the update's summary, but they don't end the wait. The wait
        also ends when an agent that this agent wrote to leaves the lab.
        """
        self._check_not_blind()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            # The person can remove the agent while it waits. The wait then ends with the reason.
            self.check_here()
            if self.void:
                raise UnknownAgent('This agent got a new invitation, so the token of this call is void.')
            news = update(self._lab.board, self.agent_id, self._seen, self._lab.now())
            remaining = deadline - loop.time()
            if news.posts or news.left or remaining <= 0:
                self._seen = news.seq
                return news
            await self._lab.wait_for_change(news.seq, remaining)
