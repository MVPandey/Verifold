"""One agent's seat in its lab."""

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal, Protocol

from verifold.protocol.agents import GUEST, Picture
from verifold.protocol.app import Heard
from verifold.protocol.events import AgentLeft, AlarmSet, NotesSet, Posted, RerunRequested, RerunTaken, WatchSet
from verifold.protocol.ids import PERSON, AgentId, DeliverableId, PostId, ThreadId
from verifold.protocol.join import (
    MAX_DESK_FILE,
    MAX_MANIFEST,
    MAX_NEWS,
    Brief,
    DeskFile,
    FileText,
    ManifestLine,
    News,
    Overview,
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
from verifold.server.errors import (
    CannotWake,
    DeskOnly,
    EvidenceRejected,
    HasLeft,
    NoCleanCopy,
    OutOfTime,
    UnknownAgent,
)
from verifold.server.lab import Adds, Lab, Said
from verifold.society.attention import news, update, wakes
from verifold.society.budget import LIMIT_NAMES
from verifold.society.deliverables import live
from verifold.society.desk import check_on, speaks_for_person
from verifold.society.errors import RejectedEvent
from verifold.society.identity import post_view
from verifold.society.lifecycle import utc
from verifold.society.overview import overview
from verifold.society.reruns import RerunKey, kept_until, lease_of, open_take, told_of
from verifold.society.views import brief, profile_result, side_lines, thread_summaries, thread_view, work_threads

type Pin = Callable[[tuple[str, ...]], Awaitable[tuple[FileEvidence, ...]]]
"""Commits an agent's folder and returns each named file pinned to that commit."""

type Files = Callable[[PostId, str], Awaitable[FileText]]
"""Reads a file that backs a post, at the commit that the post pins, as the person's app reads it."""

type Change = Literal['add', 'change', 'remove']
"""What the desk does to a deliverable on the person's word."""


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
        files: Files | None = None,
    ) -> None:
        """
        Seat an agent that has joined the lab. It has read everything up to now, or up to event `seen` when given.

        `pin` commits the agent's folder and pins the files that a post names. Without it, posts cannot name files.
        `copies` gives the clean copy of a post's files for a rerun that the agent takes. Without it, the agent
        takes none.
        `adds` starts an agent for the coordinator's move that adds one. Without it, the lab refuses such a move
        while the coordinator's power over agents is on, and the request waits for the person otherwise.
        `seat_ok` refuses a seat whose harness this computer does not have, when the coordinator asks for it.
        `files` reads a file that backs a post for the desk. Without it, the desk reads no file.
        """
        self._files = files
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
        self._read: dict[ThreadId, int] = {}
        """
        For each thread that the agent read with `thread`, the board's last event at that read. A seat starts with
        none, so after a restart every post of the person before a thread's summary stays in sight once more.
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

        `how` says how the board works. Only the member's first brief carries it. The brief can end its news
        earlier than another result would, to stay one tool result, so the agent counts as having seen only what
        the brief's news holds.
        """
        first, self._briefed = not self._briefed, True
        lab = self._lab
        now = lab.now()

        def page(most: int) -> News:
            return news(lab.board, self.agent_id, self._seen, now, told=self.told, most=most)

        made = brief(lab.board, self.agent_id, page(MAX_NEWS), how if first else '', now=now, disk=lab.disk, page=page)
        self._saw(made.news, now)
        return made

    def _unseen(self) -> News:
        now = self._lab.now()
        unseen = news(self._lab.board, self.agent_id, self._seen, now, told=self.told)
        self._saw(unseen, now)
        return unseen

    def _saw(self, unseen: News, now: datetime) -> None:
        # What a result carries to the agent counts as seen: its posts, its reruns, and the person's posts.
        self._seen = unseen.seq
        self._tell(unseen.reruns, unseen.seq)
        self._hear(now, (*unseen.for_you, *unseen.others))

    async def notes(self, text: str | None = None) -> NotesSet | None:
        """
        Return the notes of the agent's seat, or with `text`, replace them first. An empty text clears them.

        Return `None` while the seat keeps no notes.

        Raises:
            RejectedEvent: The agent is a blind checker.

        """
        if text is None:
            return self._lab.board.notes_of(self.agent_id)
        return await self._lab.set_notes(self.agent_id, text)

    def _hear(self, now: datetime, lines: Iterable[PostLine], full: Iterable[PostView] = ()) -> None:
        # The person's posts in the conversation that a result carries to the agent now, each by its place and
        # whether the result holds it whole. The desk's posts for the person there count as the person's.
        talk = self._lab.board.conversation
        carried = (
            *(
                (line.seq, holds_whole(line.text, line.body))
                for line in lines
                if (line.author == PERSON or line.on is not None) and line.thread == talk
            ),
            *((view.seq, True) for view in full if speaks_for_person(view.post) and view.post.thread == talk),
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
            and speaks_for_person(entry.post)
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
        # The reruns that the lost results told of are news again, and so are the person's posts in a thread that
        # a lost read showed.
        self._told = tuple((key, at) for key, at in self._told if at <= self._seen)
        self._read = {thread: at for thread, at in self._read.items() if at <= self._seen}

    def threads(self) -> ThreadList:
        """
        Return a summary of each thread that is not a side thread, and one line for each side thread.

        Both have the most recently active first, and the agent's own side threads come before the others.
        """
        every = thread_summaries(self._lab.board, self.agent_id, self._lab.now())
        return ThreadList(threads=work_threads(every), side_threads=side_lines(every, self.agent_id))

    def thread(self, thread_id: ThreadId, votes_of: PostId | None = None, *, whole: bool = False) -> ThreadView:
        """
        Return a thread and its posts. The post that `votes_of` names has the longer list of its votes.

        The view starts at the thread's summary while one stands, and with `whole` it holds every post. The
        person's posts before the summary that came after the agent's last read of the thread stay in it.
        """
        now = self._lab.now()
        board = self._lab.board
        view = thread_view(
            board, self.agent_id, thread_id, votes_of, now, fold=not whole, read=self._read.get(thread_id, 0)
        )
        self._read = {**self._read, thread_id: board.seq}
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

    def check_desk(self) -> None:
        """
        Check that the agent holds the lab's desk seat. The join endpoint calls it before every tool of the desk.

        Raises:
            DeskOnly: The agent does not hold the desk seat.

        """
        if self._lab.board.desk != self.agent_id:
            raise DeskOnly(
                "This tool is the desk's, and only the agent that holds the lab's desk seat calls it. "
                f'{self.agent_id} does not hold that seat.'
            )

    def _said(self, on: PostId) -> Said:
        # The person's word that an action rests on. The record's rules check it again in the step of the action,
        # and this check refuses an action that would record nothing before the board looks at anything else.
        self.check_desk()
        check_on(self._lab.board, self.agent_id, on, self._lab.now())
        return Said(by=self.agent_id, post=on)

    def overview(self) -> Overview:
        """Return the lab as the person's app has it, for the desk, with the desk's news."""
        self.check_desk()
        return overview(self._lab.board, self.agent_id, self._lab.now(), self.news(), self._lab.disk)

    async def read_file(self, post_id: PostId, path: str) -> DeskFile:
        """
        Return the text of a file that backs a post, at the commit that the post pins, for the desk.

        The text holds `MAX_DESK_FILE` characters at most, so the result stays one tool result.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            NotFound: The post names no such file, or Verifold does not show it, as the person's app says.

        """
        self.check_desk()
        if self._files is None:
            raise DeskOnly('This lab cannot read files for the desk.')
        read = await self._files(post_id, path)
        text = read.text
        return DeskFile(
            post=post_id,
            path=read.path,
            commit=read.commit,
            text=text[:MAX_DESK_FILE],
            size=len(text),
            cut=len(text) > MAX_DESK_FILE,
            news=self.news(),
        )

    async def reply(self, text: str, body: str = '') -> PostView:
        """
        Post the desk's message to the person in the desk chat, and return it as it stands.

        Raises:
            DeskOnly: The agent does not hold the desk seat.

        """
        self.check_desk()
        chat = self._lab.board.desk_chat
        return await self.post(PostRequest(kind='message', text=text, body=body, thread=chat))

    async def say(  # noqa: PLR0913
        self,
        on: PostId,
        text: str,
        body: str = '',
        *,
        thread: ThreadId | None = None,
        conversation: bool = False,
        reply_to: PostId | None = None,
        mentions: tuple[AgentId, ...] = (),
    ) -> PostView:
        """
        Post the desk's message for the person in a thread or in the conversation, and return it as it stands.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            RejectedEvent: `on` is no post of the person in the desk chat from the last hour, or the board refuses
                the post.

        """
        self._said(on)
        if reply_to and thread is None and not conversation:
            answered = self._lab.board.post(reply_to)
            thread = answered.post.thread if answered else None
        request = PostRequest(
            kind='message',
            text=text,
            body=body,
            thread=None if conversation else thread,
            conversation=conversation,
            reply_to=reply_to,
            mentions=mentions,
            for_person=True,
            on=on,
        )
        return await self.post(request)

    async def open_round(
        self,
        on: PostId,
        text: str,
        minutes: int,
        *,
        thread: ThreadId | None = None,
        new_thread: str | None = None,
    ) -> PostView:
        """
        Open a round for the person, and return it as it stands.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            RejectedEvent: `on` is no post of the person in the desk chat from the last hour, or the board refuses
                the round.

        """
        self._said(on)
        request = PostRequest(
            kind='round',
            text=text,
            minutes=minutes,
            thread=thread,
            new_thread=new_thread,
            for_person=True,
            on=on,
        )
        return await self.post(request)

    async def revise_question(self, on: PostId, question: str, note: str = '') -> str:
        """
        Revise the lab's question for the person, and return what the board recorded, as one sentence.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            RejectedEvent: `on` is no post of the person in the desk chat from the last hour.

        """
        said = self._said(on)
        revised = await self._lab.revise_question(question, note, on=said)
        if revised is None:
            return 'The question has this text already, so the board recorded nothing.'
        return f'The board revised the question, and post {revised.post} tells the lab.'

    async def deliverable(
        self, on: PostId, change: Change, deliverable_id: DeliverableId | None = None, text: str | None = None
    ) -> str:
        """
        State, change, or remove a deliverable for the person, and return what the board recorded, as one sentence.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            RejectedEvent: `on` is no post of the person in the desk chat from the last hour, the change misses
                its deliverable or its sentence, or the lab has no such deliverable.

        """
        said = self._said(on)
        if change == 'add':
            if not text or deliverable_id:
                raise RejectedEvent('`add` takes the sentence in `text` and no `deliverable`.')
            stated = await self._lab.add_deliverable(text, on=said)
            return f'The board stated the deliverable {stated.deliverable}.'
        if deliverable_id is None:
            raise RejectedEvent(f'`{change}` names the deliverable in `deliverable`, such as `d-1`.')
        if change == 'remove':
            await self._lab.remove_deliverable(deliverable_id, on=said)
            return f'The board removed the deliverable {deliverable_id}.'
        if not text:
            raise RejectedEvent('`change` takes the new sentence in `text`.')
        if not await self._lab.change_deliverable(deliverable_id, text, on=said):
            return f'The deliverable {deliverable_id} has this sentence already, so the board recorded nothing.'
        return f'The board changed the sentence of the deliverable {deliverable_id}.'

    async def set_time(self, on: PostId, minutes: int) -> str:
        """
        Set the time that the lab has left for the person, and return what the board recorded, as one sentence.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            RejectedEvent: `on` is no post of the person in the desk chat from the last hour.

        """
        said = self._said(on)
        ends = await self._lab.set_time_left(timedelta(minutes=minutes), on=said)
        return f'The board set the end of the lab to {utc(ends.ends_at)}.'

    async def set_budget(self, on: PostId, tokens: int | None = None, dollars: float | None = None) -> str:
        """
        Set the lab's budget for the person, and return what the board recorded, as one sentence.

        A kind that the call leaves out keeps the budget that it has, so the desk removes no budget. The record
        takes the budget through the function of the person's own route.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            RejectedEvent: `on` is no post of the person in the desk chat from the last hour, or the call names
                no budget.

        """
        said = self._said(on)
        if tokens is None and dollars is None:
            raise RejectedEvent('The call names no budget: `tokens`, `dollars`, or both.')
        now = self._lab.board.budget
        tokens = tokens if tokens is not None else now.tokens if now else None
        dollars = dollars if dollars is not None else now.dollars if now else None
        if not await self._lab.set_budget(tokens, dollars, on=said):
            return 'The lab has this budget already, so the board recorded nothing.'
        kinds = [*((f'{tokens:,} tokens',) if tokens else ()), *((f'{dollars:g} dollars',) if dollars else ())]
        return f'The board set the budget of the lab to {" and ".join(kinds)}.'

    async def interrupt(self, on: PostId, agent_id: AgentId) -> str:
        """
        End an agent's turn for the person, and return what the board recorded, as one sentence.

        Raises:
            DeskOnly: The agent does not hold the desk seat.
            RejectedEvent: `on` is no post of the person in the desk chat from the last hour, or the agent is in no
                turn that Verifold can end.

        """
        said = self._said(on)
        await self._lab.interrupt(agent_id, said)
        return (
            f'The board recorded the end of the turn of {agent_id}. Verifold cancels that turn, and {agent_id} '
            'starts one more turn.'
        )
