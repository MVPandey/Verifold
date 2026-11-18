"""One agent's seat in its lab."""

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from verifold.protocol.agents import GUEST, Picture
from verifold.protocol.app import Heard
from verifold.protocol.events import AgentLeft, AlarmSet, Posted, RerunRequested, RerunTaken, WatchSet
from verifold.protocol.ids import PERSON, AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import (
    MAX_MANIFEST,
    Brief,
    ManifestLine,
    News,
    PostLine,
    PostRequest,
    PostView,
    ProfileResult,
    RerunLine,
    RerunTake,
    ThreadList,
    ThreadView,
    Update,
    holds_whole,
)
from verifold.protocol.moves import AddMove, AddSeat, Move
from verifold.protocol.posts import FileEvidence
from verifold.protocol.votes import Badge, BadgeAction, Direction
from verifold.server.errors import CannotWake, EvidenceRejected, HasLeft, NoCleanCopy, OutOfTime, UnknownAgent
from verifold.server.lab import Adds, Lab
from verifold.society.attention import news, update, wakes
from verifold.society.budget import LIMIT_NAMES
from verifold.society.deliverables import live
from verifold.society.errors import RejectedEvent
from verifold.society.identity import post_view
from verifold.society.reruns import RerunKey, kept_until, lease_of, open_take, told_of
from verifold.society.views import brief, profile_result, side_lines, thread_summaries, thread_view, work_threads

type Pin = Callable[[tuple[str, ...]], Awaitable[tuple[FileEvidence, ...]]]
"""Commits an agent's folder and returns each named file pinned to that commit."""


@dataclass(frozen=True, slots=True)
class MadeCopy:
    """The clean copy of the files that a post pins, as Verifold verified it for one take."""

    folder: Path
    files: tuple[ManifestLine, ...]
    """Each file of the copy with its size and the SHA-256 of its bytes, in the order of the paths."""
    listing: Path
    """The file beside the copy that holds the manifest."""
    digest: str
    """The SHA-256 of that file's bytes."""


class CleanCopy(Protocol):
    """The clean copies of the files that the posts of a lab pin, each in a folder of Verifold's own."""

    async def __call__(self, claim: Posted) -> MadeCopy:
        """
        Return the clean copy of the files that a post pins.

        It makes the copy when it is not there, and it checks at each call that the copy is exactly the pinned
        commit's files.
        """
        ...

    async def kept(self, claim: Posted, digest: str) -> MadeCopy | None:
        """
        Return the clean copy of a post's files as a take left it, or `None` when it is not there as it was.

        It is there when its folder is and its manifest file has the SHA-256 `digest`. The copy has no lines of the
        manifest: this checks one file, and the manifest's SHA-256 checks the rest.
        """
        ...


class Member:
    """
    What one agent does in its lab: post, read, watch, and wait.

    The member remembers how far its agent has read. `news` and `wait` return only what came after, so the agent
    gets each post once, and a post that it got during a turn does not wake it later. It also remembers the
    person's newest post in the conversation that a result carried to the agent, when, and whether whole, which
    the person's app shows.
    """

    def __init__(  # noqa: PLR0913
        self,
        lab: Lab,
        agent_id: AgentId,
        pin: Pin | None = None,
        seen: int | None = None,
        *,
        copies: CleanCopy | None = None,
        adds: Adds | None = None,
        seat_ok: Callable[[AddSeat], None] | None = None,
    ) -> None:
        """
        Seat an agent that has joined the lab. It has read everything up to now, or up to event `seen` when given.

        `pin` commits the agent's folder and pins the files that a post names. Without it, posts cannot name files.
        `copies` gives the clean copy of a post's files for a rerun that the agent takes. Without it, the agent
        takes none.
        `adds` starts an agent for the coordinator's move that adds one. Without it, the lab refuses such a move
        while the coordinator's power over agents is on, and the request waits for the person otherwise.
        `seat_ok` refuses a seat whose harness this computer does not have, when the coordinator asks for it.
        """
        self._adds = adds
        self._seat_ok = seat_ok
        self._lab = lab
        self.agent_id = agent_id
        self._seen = lab.board.seq if seen is None else seen
        self._told: tuple[tuple[RerunKey, int], ...] = ()
        """
        Each wanted rerun that a result of this seat told the agent of, with the event that the result reached. A
        seat starts with none, so after a restart an agent can be told of a rerun a second time, and never not.
        """
        before = self._heard_before()
        self._heard: tuple[Heard, ...] = (before,) if before else ()
        """Each fact of what the results carried, the newest last, so that a failed turn can go back to an earlier one."""
        self.void = False
        """Whether the agent got a new token, so that this seat's open `wait` must return nothing more."""
        self._pin = pin
        self._copies = copies
        self._briefed = False

    @property
    def seen(self) -> int:
        """The last event that the agent got, from `news` or `wait`."""
        return self._seen

    @property
    def told(self) -> frozenset[RerunKey]:
        """The wanted reruns that this seat told the agent of. The news tells each once."""
        return frozenset(key for key, _ in self._told)

    def _tell(self, lines: tuple[RerunLine, ...], seq: int) -> None:
        # The reruns that a result carries to the agent now, so that no later result tells of them again.
        fresh = told_of(self._lab.board, lines) - self.told
        self._told = (*self._told, *((key, seq) for key in sorted(fresh)))

    @property
    def heard(self) -> Heard | None:
        """
        The person's newest post in the conversation that a result of the agent's board tools carried to it.

        A seat that starts at a place in the record, as after a restart of Verifold, has no time for the posts
        before that place.
        """
        return self._heard[-1] if self._heard else None

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
            RejectedEvent: The agent left already.

        """
        return await self._lab.leave(self.agent_id, self.agent_id, reason)

    async def post(self, request: PostRequest) -> PostView:
        """
        Post as the agent, with its files pinned as evidence, and return the post as it stands.

        The agent's first check with the method `rerun` and with files, of a post whose rerun it took, is the check
        of that take, and the post records the take. Its files are pinned from the agent's folder, as any post's.

        Raises:
            EvidenceRejected: The post names files, and this member cannot pin them or they are not in the folder.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        board = self._lab.board
        evidence: tuple[FileEvidence, ...] = ()
        # A rerun with files, of a post whose rerun the agent took, is the check of that take.
        reruns = request.kind == 'check' and request.method == 'rerun' and request.files
        taken = open_take(board, self.agent_id, request.reply_to) if reruns and request.reply_to else None
        if request.files:
            if self._pin is None:
                raise EvidenceRejected('This lab cannot pin files for you.')
            evidence = await self._pin(request.files)
        # A proposal keeps which revisions of the question its author had been shown. An agent that worked on an
        # earlier version can post just after a revision, and its answer is then to that earlier version.
        seen = sum(self._seen >= told.seq for revision in board.revisions if (told := board.post(revision.post)))
        posted = await self._lab.post(request, self.agent_id, evidence, seen, take=taken.seq if taken else None)
        return post_view(self._lab.board, posted, self.agent_id, self._lab.now())

    async def offer(
        self, deliverable_id: DeliverableId, files: tuple[str, ...], note: str, body: str = '', helper: str = ''
    ) -> PostView:
        """
        Offer files of the agent's folder for a deliverable of the person, and return the offer as it stands.

        `helper` names the helper of the agent that wrote the offer, as on any post.

        Raises:
            EvidenceRejected: This member cannot pin files, or a file is not in the folder.
            RejectedEvent: The lab has no such deliverable, or the person removed it.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        # The folder gets a commit only for an offer that the board can take.
        live(self._lab.board, deliverable_id)
        if self._pin is None:
            raise EvidenceRejected('This lab cannot pin files for you.')
        # A path that the call names twice is one file of the offer.
        evidence = await self._pin(tuple(dict.fromkeys(files)))
        posted = await self._lab.offer(self.agent_id, deliverable_id, evidence, note, body, helper=helper)
        return post_view(self._lab.board, posted, self.agent_id, self._lab.now())

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
        return post_view(self._lab.board, posted, self.agent_id, self._lab.now())

    def news(self) -> News:
        """
        Return the posts that the agent has not seen yet, and count them as seen.

        Every board tool adds it to its result, so posts reach an agent that works, not only one that waits.
        """
        return self._unseen()

    def brief(self, how: str) -> Brief:
        """
        Return the lab in one read: its state and time, the other agents and their plans, the threads, and the posts.

        `how` says how the board works. Only the member's first brief carries it.
        """
        first, self._briefed = not self._briefed, True
        lab = self._lab
        return brief(lab.board, self.agent_id, self._unseen(), how if first else '', now=lab.now(), disk=lab.disk)

    def _unseen(self) -> News:
        now = self._lab.now()
        unseen = news(self._lab.board, self.agent_id, self._seen, now, told=self.told)
        self._seen = unseen.seq
        self._tell(unseen.reruns, unseen.seq)
        self._hear(now, (*unseen.for_you, *unseen.others))
        return unseen

    def _hear(self, now: datetime, lines: Iterable[PostLine], full: Iterable[PostView] = ()) -> None:
        # The person's posts in the conversation that a result carries to the agent now, each by its place and
        # whether the result holds it whole.
        talk = self._lab.board.conversation
        carried = (
            *(
                (line.seq, holds_whole(line.text, line.body))
                for line in lines
                if line.author == PERSON and line.thread == talk
            ),
            *((view.seq, True) for view in full if view.post.author == PERSON and view.post.thread == talk),
        )
        newest = max(carried, default=None)
        heard = self.heard
        # A place and its whole flag compare as a pair: a newer post, or the same post whole after its cut line.
        if newest and (heard is None or newest > (heard.seq, heard.whole)):
            seq, whole = newest
            self._heard = (*self._heard, Heard(seq=seq, at=now, whole=whole))

    def _heard_before(self) -> Heard | None:
        # The person's newest post in the conversation for the agent, between its join and the place where it is.
        # The agent's news brought it every post for it up to that place, at a time that this seat does not know.
        # A line holds a short post whole, and of a longer one this seat knows only that its line was cut.
        board = self._lab.board
        joined = board.agent(self.agent_id)
        if joined is None:
            return None
        mine = (
            entry
            for entry in reversed(board.posts)
            if joined.seq < entry.seq <= self._seen
            and entry.post.author == PERSON
            and entry.post.thread == board.conversation
            and wakes(board, self.agent_id, entry)
        )
        newest = next(mine, None)
        return Heard(seq=newest.seq, whole=holds_whole(newest.post.text, newest.post.body)) if newest else None

    def rewind(self, seq: int) -> None:
        """
        Count the posts after event `seq` as not seen again.

        A turn that fails can lose the tool results that carried them, so the agent gets them once more. What the
        results before it carried stays, with its time.
        """
        self._seen = min(self._seen, seq)
        self._heard = tuple(heard for heard in self._heard if heard.seq <= self._seen)
        # The reruns that the lost results told of are news again.
        self._told = tuple((key, at) for key, at in self._told if at <= self._seen)

    def threads(self) -> ThreadList:
        """
        Return a summary of each thread that is not a side thread, and one line for each side thread.

        Both have the most recently active first, and the agent's own side threads come before the others.
        """
        every = thread_summaries(self._lab.board, self.agent_id, self._lab.now())
        return ThreadList(threads=work_threads(every), side_threads=side_lines(every, self.agent_id))

    def thread(self, thread_id: ThreadId, votes_of: PostId | None = None) -> ThreadView:
        """Return a thread and its posts. The post that `votes_of` names has the longer list of its votes."""
        now = self._lab.now()
        view = thread_view(self._lab.board, self.agent_id, thread_id, votes_of, now)
        self._hear(now, (), view.posts)
        return view

    async def rerun(self, post_id: PostId) -> RerunRequested:
        """
        Ask for an independent rerun of a post that has files as evidence. The request starts nothing.

        Raises:
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        return await self._lab.request_rerun(self.agent_id, post_id)

    async def take_rerun(self, post_id: PostId, *, give_up: bool = False) -> RerunTake:
        """
        Take the rerun of a post that somebody asked for, and return the claim with the clean copy of its files.

        The copy is in a folder of Verifold's own, and the take is recorded when the copy is there. So a copy that
        fails, and a take that the board refuses, record nothing. A take checks the copy and returns its manifest,
        and it gives the agent a lease on the rerun. A later call of the agent renews the lease, and it checks only
        that the copy's folder is there and that its manifest file has the SHA-256 that the record keeps. Then it
        returns them without the manifest's lines, and it makes the copy again when either check fails. When the
        board does not renew the lease, `not_renewed` says why. With `give_up`, the call ends the
        agent's lease and makes no copy.

        Raises:
            RejectedEvent: The agent cannot take the rerun: the post does not exist or is its own, no rerun of it
                is wanted, the rerun is for an agent in a reviewer seat and the agent holds none, or another
                agent's lease keeps it out. Or it gives up a lease that it does not hold.
            NoCleanCopy: This seat makes no clean copies, or Verifold could not make this one.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        claim = self._lab.board.post(post_id)
        if claim is None:
            raise RejectedEvent(f'Post {post_id} does not exist.')
        if give_up:
            return self._claim(claim, await self._lab.give_up_rerun(self.agent_id, post_id))
        if self._copies is None:
            raise NoCleanCopy('This lab cannot make a clean copy for you.')
        if (taken := self._lab.board.take(self.agent_id, post_id)) is not None:
            # An export can take minutes, so a later call checks the folder and the manifest's file, and exports
            # again only when one of them is gone or changed.
            why = await self._lab.renew_rerun(self.agent_id, post_id)
            kept = await self._copies.kept(claim, taken.manifest) if taken.manifest else None
            made = kept or await self._copies(claim)
            return self._copy(self._claim(claim, taken), made).model_copy(update={'not_renewed': why})
        self._lab.check_take(self.agent_id, post_id)
        made = await self._copies(claim)
        return self._copy(self._claim(claim, await self._lab.take_rerun(self.agent_id, post_id, made.digest)), made)

    @staticmethod
    def _copy(claim: RerunTake, made: MadeCopy) -> RerunTake:
        # The claim with where its clean copy is, and the copy's manifest as far as this call checked it.
        return claim.model_copy(
            update={
                'folder': str(made.folder),
                'manifest': made.files if len(made.files) <= MAX_MANIFEST else (),
                'manifest_files': len(made.files),
                'manifest_file': str(made.listing),
                'manifest_sha256': made.digest,
            }
        )

    def _claim(self, claim: Posted, taken: RerunTaken) -> RerunTake:
        # The claim with the agent's lease on its rerun as it stands now, and no clean copy.
        lease = lease_of(self._lab.board, self.agent_id, claim.post.id, self._lab.now())
        return RerunTake(
            post=claim.post.id,
            thread=claim.post.thread,
            author=claim.post.author,
            text=claim.post.text,
            body=claim.post.body,
            files=tuple(file.path for file in claim.post.evidence),
            commit=taken.commit,
            held_since=lease.since if lease else None,
            held_until=lease.until if lease else None,
        )

    async def vote(self, post_id: PostId, direction: Direction, reason: str = '') -> PostView:
        """
        Vote on a post as the agent, or take the vote back, and return the post as it stands.

        Raises:
            RejectedEvent: The post is the agent's own, a vote up or down has no reason, or the agent has no vote
                to take back.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        await self._lab.vote(self.agent_id, post_id, direction, reason)
        return self._view(post_id)

    async def badge(  # noqa: PLR0913
        self,
        post_id: PostId,
        badge: Badge,
        action: BadgeAction = 'give',
        reason: str = '',
        *,
        proof: PostId | None = None,
        giver: AgentId | None = None,
    ) -> PostView:
        """
        Give a post a badge as the agent, second a `breakthrough`, or take a badge back, and return the post.

        Raises:
            RejectedEvent: The change breaks a rule of the record, as `check_badge` says.
            OutOfTime: The agent joined with an invitation, and the lab is out of time or stopped.

        """
        self._check_in_time()
        await self._lab.badge(self.agent_id, post_id, badge, action, reason, proof=proof, giver=giver)
        return self._view(post_id)

    def _view(self, post_id: PostId) -> PostView:
        entry = self._lab.board.post(post_id)
        if entry is None:
            raise RejectedEvent(f'Post {post_id} does not exist.')
        return post_view(self._lab.board, entry, self.agent_id, self._lab.now())

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
                "The lab's time ran out or the person stopped the lab, so the board takes no post, no rerun "
                'request, no take of a rerun, no vote, and no badge from you now. The person can give the lab '
                'more time.'
            )
        if board.at_limit and self._is_guest():
            raise OutOfTime(
                f'The lab reached its {LIMIT_NAMES[board.at_limit]}, so the board takes no post, no rerun request, '
                'no take of a rerun, no vote, and no badge from you now. The person can raise it.'
            )

    async def set_alarm(self, minutes: float, *, quiet: bool) -> AlarmSet:
        """
        Ask Verifold to wake the agent when it is in no turn and no post for it wakes it first.

        Raises:
            CannotWake: The agent joined with an invitation, so Verifold cannot wake it.

        """
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
        also ends when an agent that this agent wrote to leaves the lab, when a round that concerns the agent
        closes, when somebody asks for a rerun that this agent can take, and when a lease that kept the agent from
        such a rerun ends without a check.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            # The person can remove the agent while it waits. The wait then ends with the reason.
            self.check_here()
            if self.void:
                raise UnknownAgent('This agent got a new invitation, so the token of this call is void.')
            now = self._lab.now()
            news = update(self._lab.board, self.agent_id, self._seen, now, told=self.told)
            remaining = deadline - loop.time()
            if news.posts or news.left or news.rounds or news.reruns or remaining <= 0:
                self._seen = news.seq
                self._tell(news.reruns, news.seq)
                self._hear(now, news.others, news.posts)
                return news
            # A rerun that only a lease keeps from the agent comes free at the lease's end, which is no event.
            free = kept_until(self._lab.board, self.agent_id, now, self.told)
            frees = remaining if free is None else min(remaining, (free - now).total_seconds())
            await self._lab.wait_for_change(news.seq, frees)
