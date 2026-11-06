"""Runs a lab: the record, the join endpoint, and one loop for each agent."""

import asyncio
from collections.abc import Mapping
from pathlib import Path

import uvicorn
from pydantic import Field, SecretStr

from verifold.harnesses.base import Harness
from verifold.protocol.agents import Agent, Label, ModelSpec
from verifold.protocol.record import Record
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings
from verifold.runner.errors import RunnerError
from verifold.runner.folders import LAB_FOLDER, agent_folder
from verifold.runner.prompts import PEER_BRIEF, PLANNER_BRIEF, PLANNER_ROLE
from verifold.server.join import Members, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.store.record_file import RecordFile

DEFAULT_NETWORK = (
    'pypi.org',
    'files.pythonhosted.org',
    'github.com',
    'raw.githubusercontent.com',
    'huggingface.co',
    'cdn-lfs.huggingface.co',
)
"""Domains that agents' shell commands reach by default: package and model downloads."""


class AgentSpec(Record):
    """One agent to start: its harness, and its model when not the harness's default."""

    harness: Label
    model: Label | None = None
    family: Label | None = None
    """The model family, when the harness runs a family other than its default."""


class LabConfig(Record):
    """A lab to run in a project folder."""

    question: str | None = None
    """The question of a new lab. Leave it out to resume the lab in the folder."""
    agents: tuple[AgentSpec, ...] = Field(default=(AgentSpec(harness='claude-code'), AgentSpec(harness='codex')))
    network: tuple[str, ...] = DEFAULT_NETWORK
    port: int = Field(default=0, ge=0, le=65_535)
    """The port of the join endpoint on 127.0.0.1. 0 picks a free port."""
    turn_timeout: float = Field(default=2 * 3_600, gt=0)


async def run_lab(project: Path, config: LabConfig, harnesses: Mapping[str, Harness]) -> None:
    """
    Run the lab in `project` until every agent stops, or until the caller cancels it.

    Raises:
        RunnerError: The folder has no lab and the config has no question, or an agent names an unknown harness.
        RecordLocked: Another process runs this lab already.

    """
    lab_folder = project / LAB_FOLDER
    with RecordFile(lab_folder / 'record.jsonl') as record:
        unknown = sorted({spec.harness for spec in config.agents} - set(harnesses))
        if unknown:
            raise RunnerError(f'Unknown harness {", ".join(unknown)}. Choose from: {", ".join(harnesses)}.')
        lab = await _open(record, config)
        members = Members()
        seats = []
        for number, spec in enumerate(config.agents, start=1):
            harness = harnesses[spec.harness]
            agent = await _join(lab, number, spec, harness)
            seats.append((await _seat(lab, project, members, agent), harness))
        server = uvicorn.Server(
            uvicorn.Config(
                join_server(members.resolve).streamable_http_app(host='127.0.0.1'),
                host='127.0.0.1',
                port=config.port,
                log_level='warning',
            )
        )
        serving = asyncio.create_task(server.serve())
        try:
            settings = LoopSettings(
                mcp_url=f'http://127.0.0.1:{await _bound_port(server)}/mcp',
                network=config.network,
                turn_timeout=config.turn_timeout,
            )
            async with asyncio.TaskGroup() as group:
                for (member, setup), harness in seats:
                    group.create_task(AgentLoop(member, setup, harness, settings).run())
        finally:
            server.should_exit = True
            await serving


async def _open(record: RecordFile, config: LabConfig) -> Lab:
    events = record.read()
    if events:
        return Lab(record, events)
    if not config.question:
        raise RunnerError('This folder has no lab yet. Give the question to start one.')
    return Lab.create(record, config.question)


async def _join(lab: Lab, number: int, spec: AgentSpec, harness: Harness) -> Agent:
    agent_id = f'agent-{number}'
    joined = lab.board.agent(agent_id)
    if joined:
        return joined.agent
    planner = number == 1
    agent = Agent(
        id=agent_id,
        name=f'Agent {number}',
        harness=spec.harness,
        model=ModelSpec(family=spec.family or harness.family, name=spec.model),
        role=PLANNER_ROLE if planner else '',
        brief=PLANNER_BRIEF if planner else PEER_BRIEF,
    )
    return (await lab.join(agent)).agent


async def _seat(lab: Lab, project: Path, members: Members, agent: Agent) -> tuple[Member, AgentSetup]:
    member = Member(lab, agent.id)
    setup = AgentSetup(
        agent=agent,
        project=project,
        folder=await agent_folder(project, agent.id),
        private=project / LAB_FOLDER / 'private' / agent.id,
        token=SecretStr(members.add(member)),
    )
    return member, setup


async def _bound_port(server: uvicorn.Server) -> int:
    while not server.started:
        await asyncio.sleep(0.01)
    return server.servers[0].sockets[0].getsockname()[1]
