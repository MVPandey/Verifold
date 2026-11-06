"""Runs a lab: the record, the board's MCP endpoint, and one supervised ACP session for each agent."""

import asyncio
from collections.abc import Mapping
from pathlib import Path

import uvicorn
from pydantic import Field, SecretStr

from verifold.harnesses.catalog import CATALOG, HarnessEntry
from verifold.protocol.agents import Agent, Label, ModelSpec
from verifold.protocol.record import Record
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings
from verifold.runner.errors import RunnerError
from verifold.runner.folders import LAB_FOLDER, agent_folder
from verifold.runner.messages import LAB_TEMPLATE, start_message
from verifold.runner.session import SessionOptions
from verifold.server.join import Members, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.store.record_file import RecordFile

PLANNER_ROLE = 'Planner'
PLANNER_BRIEF = (
    'Open a thread titled "Plan" with 2 to 6 different ways to attack the question, each with what would count as a '
    'result. Then work on one of them yourself.'
)


class AgentSpec(Record):
    """One agent to start: its harness, and the model and effort when not the person's defaults."""

    harness: Label
    model: Label | None = None
    effort: Label | None = None


class LabConfig(Record):
    """A lab to run in a project folder."""

    question: str | None = None
    """The question of a new lab. Leave it out to resume the lab in the folder."""
    agents: tuple[AgentSpec, ...] = Field(default=(AgentSpec(harness='claude-code'), AgentSpec(harness='codex')))
    auto_mode: bool = True
    """The person allows each harness's own auto mode. Without it, permission requests come to the person."""
    port: int = Field(default=0, ge=0, le=65_535)
    """The port of the board's MCP endpoint on 127.0.0.1. 0 picks a free port."""
    turn_timeout: float = Field(default=2 * 3_600, gt=0)


async def run_lab(project: Path, config: LabConfig, catalog: Mapping[str, HarnessEntry] = CATALOG) -> None:
    """
    Run the lab in `project` until every agent stops, or until the caller cancels it.

    Raises:
        RunnerError: The folder has no lab and the config has no question, or an agent names an unknown harness.
        RecordLocked: Another process runs this lab already.

    """
    unknown = sorted({spec.harness for spec in config.agents} - set(catalog))
    if unknown:
        raise RunnerError(f'Unknown harness {", ".join(unknown)}. Choose from: {", ".join(catalog)}.')
    lab_folder = project / LAB_FOLDER
    with RecordFile(lab_folder / 'record.jsonl') as record:
        lab = await _open(record, config)
        lab_file = lab_folder / 'LAB.md'
        if not lab_file.exists():
            lab_file.write_text(LAB_TEMPLATE)
        members, seats = await _seat_agents(lab, project, config, catalog, lab_file)
        server = uvicorn.Server(
            uvicorn.Config(
                join_server(members.resolve).streamable_http_app(host='127.0.0.1'),
                host='127.0.0.1',
                port=config.port,
                log_level='warning',
                timeout_graceful_shutdown=5,
            )
        )
        serving = asyncio.create_task(server.serve())
        try:
            settings = LoopSettings(
                mcp_url=f'http://127.0.0.1:{await _bound_port(server)}/mcp', turn_timeout=config.turn_timeout
            )
            async with asyncio.TaskGroup() as group:
                for member, setup in seats:
                    group.create_task(AgentLoop(member, setup, settings).run())
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


async def _join(lab: Lab, number: int, spec: AgentSpec, harness: HarnessEntry) -> Agent:
    agent_id = f'agent-{number}'
    joined = lab.board.agent(agent_id)
    if joined:
        return joined.agent
    planner = number == 1
    agent = Agent(
        id=agent_id,
        name=f'Agent {number}',
        harness=spec.harness,
        model=ModelSpec(family=harness.family, name=spec.model),
        role=PLANNER_ROLE if planner else '',
        brief=PLANNER_BRIEF if planner else '',
    )
    return (await lab.join(agent)).agent


async def _seat_agents(
    lab: Lab, project: Path, config: LabConfig, catalog: Mapping[str, HarnessEntry], lab_file: Path
) -> tuple[Members, list[tuple[Member, AgentSetup]]]:
    # Every agent joins first, so each start message names all the other agents.
    agents = [await _join(lab, number, spec, catalog[spec.harness]) for number, spec in enumerate(config.agents, 1)]
    members = Members()
    seats: list[tuple[Member, AgentSetup]] = []
    for agent, spec in zip(agents, config.agents, strict=True):
        member = Member(lab, agent.id)
        setup = AgentSetup(
            agent=agent,
            harness=catalog[spec.harness],
            folder=await agent_folder(project, agent.id),
            log=project / LAB_FOLDER / 'logs' / f'{agent.id}.log',
            token=SecretStr(members.add(member)),
            options=SessionOptions(model=spec.model, effort=spec.effort, auto_mode=config.auto_mode),
            start=start_message(lab.board, agent, lab_file),
        )
        seats.append((member, setup))
    return members, seats


async def _bound_port(server: uvicorn.Server) -> int:
    while not server.started:
        await asyncio.sleep(0.01)
    return server.servers[0].sockets[0].getsockname()[1]
