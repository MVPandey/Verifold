"""One agent's seat in its lab."""

import asyncio
from collections.abc import Awaitable, Callable

from verifold.protocol.events import RerunRequested, WatchSet
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.join import Brief, News, PostRequest, PostView, ThreadSummary, ThreadView, Update
from verifold.protocol.posts import FileEvidence
from verifold.server.errors import BlindCheck, EvidenceRejected
from verifold.server.lab import Lab
from verifold.society.attention import news, update
from verifold.society.views import brief, post_view, thread_summaries, thread_view

type Pin = Callable[[tuple[str, ...]], Awaitable[tuple[FileEvidence, ...]]]
"""Commits an agent's folder and returns each named file pinned to that commit."""


class Member:
    """
    What one agent does in its lab: post, read, watch, and wait.

    The member remembers how far its agent has read. `news` and `wait` return only what came after, so the agent
    gets each post once, and a post that it got during a turn does not wake it later.
    """

    # ponytail: the read position lives in memory. After a restart the agent starts from the newest event, and it
    # can read the threads to catch up. Record read positions if agents miss too much across restarts.
    def __init__(self, lab: Lab, agent_id: AgentId, pin: Pin | None = None) -> None:
        """
        Seat an agent that has joined the lab. It has read everything up to now.

        `pin` commits the agent's folder and pins the files that a post names. Without it, posts cannot name files.
        """
        self._lab = lab
        self.agent_id = agent_id
        self._seen = lab.board.seq
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

    async def post(self, request: PostRequest) -> PostView:
        """
        Post as the agent, with its files pinned as evidence, and return the post as it stands.

        Raises:
            EvidenceRejected: The post names files, and this member cannot pin them or they are not in the folder.

        """
        evidence: tuple[FileEvidence, ...] = ()
        if request.files:
            if self._pin is None:
                raise EvidenceRejected('This lab cannot pin files for you.')
            evidence = await self._pin(request.files)
        posted = await self._lab.post(request, self.agent_id, evidence)
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
        Return the lab in one read: the other agents and their plans, where the agent's work is of use, and the threads.

        `how` says how the board works. Only the member's first brief carries it.
        """
        self._check_not_blind()
        first, self._briefed = not self._briefed, True
        return brief(self._lab.board, self.agent_id, self._unseen(), how if first else '')

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

    def threads(self) -> tuple[ThreadSummary, ...]:
        """Return a summary of each thread, the most recently active first."""
        self._check_not_blind()
        return thread_summaries(self._lab.board, self.agent_id)

    def thread(self, thread_id: ThreadId) -> ThreadView:
        """Return a thread and its posts."""
        self._check_not_blind()
        return thread_view(self._lab.board, self.agent_id, thread_id)

    async def rerun(self, post_id: PostId) -> RerunRequested:
        """Ask for a blind rerun of a post that has files as evidence."""
        return await self._lab.request_rerun(self.agent_id, post_id)

    def _checks(self) -> str | None:
        joined = self._lab.board.agent(self.agent_id)
        return joined.agent.checks if joined else None

    def _check_not_blind(self) -> None:
        if target := self._checks():
            raise BlindCheck(f'You rerun {target} blind, so you cannot read the board.')

    async def set_profile(self, role: str | None, status: str | None) -> tuple[str, str]:
        """Say what the agent is to the lab and what it does now. Return its role and status after the change."""
        return await self._lab.set_profile(self.agent_id, role, status)

    async def watch(self, thread_id: ThreadId, *, watching: bool) -> WatchSet:
        """Start or stop watching a thread."""
        return await self._lab.watch(self.agent_id, thread_id, watching=watching)

    async def wait(self, timeout: float) -> Update:
        """
        Return what happened since the agent last looked, once a post wakes it or `timeout` seconds pass.

        Posts that don't wake the agent count toward the update's summary, but they don't end the wait.
        """
        self._check_not_blind()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            news = update(self._lab.board, self.agent_id, self._seen)
            remaining = deadline - loop.time()
            if news.posts or remaining <= 0:
                self._seen = news.seq
                return news
            await self._lab.wait_for_change(news.seq, remaining)
