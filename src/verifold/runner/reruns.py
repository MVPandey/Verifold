"""Answers rerun requests by starting blind checkers."""

import asyncio
from collections.abc import Awaitable, Callable
from functools import partial
from pathlib import Path

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import RerunRequested
from verifold.protocol.posts import Check
from verifold.runner.agent_loop import AgentSetup
from verifold.runner.folders import LAB_FOLDER, agent_folder, checker_folder
from verifold.runner.messages import rerun_message
from verifold.runner.session import SessionOptions
from verifold.runner.snapshots import pin, snapshot_ref
from verifold.server.join import Members
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board

type Crew = tuple[tuple[HarnessEntry, SessionOptions], ...]
"""The lab's harnesses, each with the options that its agents use."""

type Supervise = Callable[[Member, AgentSetup, Callable[[Board], bool]], Awaitable[None]]
"""Runs one agent's loop until it is done, as the lab runs its other agents."""

IDLE_WAIT = 3_600.0


class Reruns:
    """
    Starts a blind checker for each rerun request.

    The checker comes from a harness of the lab whose model family differs from the author's, when the lab has one.
    It gets the author's files at the cited commit and the claim, but not the thread, and it stops after its check.
    """

    def __init__(self, lab: Lab, members: Members, project: Path, crew: Crew, supervise: Supervise) -> None:
        """Prepare to answer the lab's rerun requests with checkers from `crew`, run by `supervise`."""
        self._lab = lab
        self._members = members
        self._project = project
        self._crew = crew
        self._supervise = supervise

    async def run(self) -> None:
        """Start a checker for each request that has no check yet, now and as requests arrive."""
        async with asyncio.TaskGroup() as group:
            started = 0
            while True:
                board = self._lab.board
                for request in board.reruns[started:]:
                    if not _checked(board, _checker_id(request), request.post):
                        group.create_task(self._check(request))
                started = len(board.reruns)
                await self._lab.wait_for_change(board.seq, IDLE_WAIT)

    async def _check(self, request: RerunRequested) -> None:
        board = self._lab.board
        target = board.post(request.post)
        author = board.agent(target.post.author) if target else None
        if target is None or author is None or not target.post.evidence:
            return
        harness, options = next(
            ((entry, options) for entry, options in self._crew if entry.family != author.agent.model.family),
            self._crew[0],
        )
        checker_id = _checker_id(request)
        joined = board.agent(checker_id)
        checker = joined.agent if joined else (await self._lab.join(_checker(request, harness, options))).agent
        source = await agent_folder(self._project, author.agent.id)
        commit = target.post.evidence[0].commit
        folder = await checker_folder(self._project, checker_id, source, snapshot_ref(author.agent.id), commit)
        member = Member(self._lab, checker_id, pin=partial(pin, folder, checker_id))
        setup = AgentSetup(
            agent=checker,
            harness=harness,
            folder=folder,
            log=self._project / LAB_FOLDER / 'logs' / f'{checker_id}.log',
            token=self._members.add(member),
            options=options,
            start=rerun_message(target.post),
        )
        await self._supervise(member, setup, partial(_checked, agent_id=checker_id, post_id=request.post))


def _checker_id(request: RerunRequested) -> str:
    return f'checker-{request.seq}'


def _checker(request: RerunRequested, harness: HarnessEntry, options: SessionOptions) -> Agent:
    return Agent(
        id=_checker_id(request),
        name=f'Checker {request.seq}',
        harness=harness.name,
        model=ModelSpec(family=harness.family, name=options.model),
        role='Checker',
        recruited_by=request.by,
        checks=request.post,
    )


def _checked(board: Board, agent_id: str, post_id: str) -> bool:
    return any(
        isinstance(entry.post, Check) and entry.post.author == agent_id and entry.post.reply_to == post_id
        for entry in board.posts
    )
