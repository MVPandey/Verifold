"""One agent's seat in its lab."""

import asyncio
from collections.abc import Awaitable, Callable

from verifold.protocol.events import RerunRequested, WatchSet
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.join import PostRequest, PostView, ThreadSummary, ThreadView, Update
from verifold.protocol.posts import FileEvidence
from verifold.server.errors import BlindCheck, EvidenceRejected
from verifold.server.lab import Lab
from verifold.society.attention import update
from verifold.society.views import post_view, thread_summaries, thread_view

type Pin = Callable[[tuple[str, ...]], Awaitable[tuple[FileEvidence, ...]]]
"""Commits an agent's folder and returns each named file pinned to that commit."""


class Member:
    """
    What one agent does in its lab: post, read, watch, and wait.

    The member remembers how far its agent has read, so `wait` returns only what came after.
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

    @property
    def seen(self) -> int:
        """The last event that the agent read with `wait`."""
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

    def _check_not_blind(self) -> None:
        joined = self._lab.board.agent(self.agent_id)
        if joined and joined.agent.checks:
            raise BlindCheck(f'You rerun {joined.agent.checks} blind, so you cannot read the board.')

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
