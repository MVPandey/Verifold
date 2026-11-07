"""Runs Verifold in a project folder: the server, the setup screen, and the folder's lab once it starts."""

import asyncio
from collections.abc import Callable, Mapping
from datetime import timedelta
from functools import partial
from pathlib import Path

import uvicorn
from pydantic import Field

from verifold.harnesses.catalog import CATALOG, HarnessEntry, available
from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.app import HarnessOption, SetupView, StartRequest
from verifold.protocol.record import Record
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings
from verifold.runner.folders import LAB_FOLDER, agent_folder
from verifold.runner.messages import LAB_TEMPLATE, start_message
from verifold.runner.reruns import Crew, Reruns
from verifold.runner.session import SessionOptions
from verifold.runner.snapshots import pin
from verifold.server.activity import Activity
from verifold.server.app_api import app_api, new_person_token
from verifold.server.errors import LabExists, SetupRejected
from verifold.server.join import Members, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.server.timekeeper import keep_time
from verifold.server.web import WEB_FOLDER, web_app
from verifold.society.board import Board
from verifold.store.record_file import RecordFile

PLANNER_ROLE = 'Planner'
PLANNER_BRIEF = (
    'Open a thread titled "Plan" with 2 to 6 different ways to attack the question, each with what would count as a '
    'result. Then work on one of them yourself.'
)


class ServeOptions(Record):
    """How the server runs: its port on 127.0.0.1, how long one agent turn may take, and the app that it serves."""

    port: int = Field(default=0, ge=0, le=65_535)
    """0 picks a free port."""
    turn_timeout: float = Field(default=2 * 3_600, gt=0)
    web: Path = WEB_FOLDER
    """The folder of the built app."""


class Host:
    """The folder's lab, once the person starts it or the server resumes it, and the agents that work in it."""

    def __init__(
        self,
        project: Path,
        record: RecordFile,
        catalog: Mapping[str, HarnessEntry],
        members: Members,
        activity: Activity,
    ) -> None:
        """Prepare a host for the folder at `project`. Call `attach` before a lab starts."""
        self._project = project
        self._record = record
        self._catalog = catalog
        self._members = members
        self._activity = activity
        self._lab: Lab | None = None
        self._group: asyncio.TaskGroup | None = None
        self._settings: LoopSettings | None = None

    @property
    def lab(self) -> Lab | None:
        """The folder's lab, or `None` before it starts."""
        return self._lab

    def attach(self, group: asyncio.TaskGroup, settings: LoopSettings) -> None:
        """Run the lab's agents in `group`, with `settings`, from now on."""
        self._group = group
        self._settings = settings

    def setup(self) -> SetupView:
        """Return the harnesses that this computer has, and the folder's lab, if any."""
        return SetupView(
            folder=_shown(self._project),
            harnesses=tuple(
                HarnessOption(name=entry.name, family=entry.family, available=available(entry))
                for entry in self._catalog.values()
            ),
            question=self._lab.board.opened.question if self._lab else None,
        )

    async def start(self, request: StartRequest) -> None:
        """
        Start a new lab on the person's question, with the agents that they chose.

        Raises:
            LabExists: The folder has a lab already.
            SetupRejected: A choice names a harness that Verifold does not know.

        """
        if self._lab:
            raise LabExists('This folder has a lab already.')
        unknown = sorted({choice.harness for choice in request.agents} - set(self._catalog))
        if unknown:
            raise SetupRejected(f'Unknown harness {", ".join(unknown)}. Choose from: {", ".join(self._catalog)}.')
        time_left = timedelta(minutes=request.minutes) if request.minutes else None
        lab = Lab.create(self._record, request.question, auto_mode=request.auto_mode, time_left=time_left)
        self._lab = lab
        chosen = [choice for choice in request.agents for _ in range(choice.count)]
        for number, choice in enumerate(chosen, start=1):
            await lab.join(_agent(number, self._catalog[choice.harness], choice.model, choice.effort))
        await self._launch()

    async def resume(self) -> None:
        """Serve the lab that the folder's record holds, and start its agents again."""
        self._lab = Lab.load(self._record)
        await self._launch()

    async def _launch(self) -> None:
        lab, group, settings = self._lab, self._group, self._settings
        if lab is None or group is None or settings is None:
            raise SetupRejected('Attach the host to the server before a lab starts.')
        lab_file = self._project / LAB_FOLDER / 'LAB.md'
        if not lab_file.exists():
            lab_file.write_text(LAB_TEMPLATE)
        group.create_task(keep_time(lab))
        workers = tuple(
            entry.agent for entry in lab.board.agents if not entry.agent.checks and entry.agent.harness in self._catalog
        )
        for agent in workers:
            member, setup = await self._seat(lab, agent, start_message(lab.board, agent, lab_file))
            await self._activity.set(agent.id, 'starting')
            group.create_task(AgentLoop(member, setup, settings, activity=self._activity).run())
        crew = _crew(workers, self._catalog, auto_mode=lab.board.opened.auto_mode)
        if crew:
            group.create_task(Reruns(lab, self._members, self._project, crew, self._supervise).run())

    async def _seat(self, lab: Lab, agent: Agent, start: str) -> tuple[Member, AgentSetup]:
        folder = await agent_folder(self._project, agent.id)
        member = Member(lab, agent.id, pin=partial(pin, folder, agent.id))
        setup = AgentSetup(
            agent=agent,
            harness=self._catalog[agent.harness],
            folder=folder,
            log=self._project / LAB_FOLDER / 'logs' / f'{agent.id}.log',
            token=self._members.add(member),
            options=_options(agent, auto_mode=lab.board.opened.auto_mode),
            start=start,
        )
        return member, setup

    async def _supervise(self, member: Member, setup: AgentSetup, done: Callable[[Board], bool]) -> None:
        if self._settings is None:
            return
        async with asyncio.timeout(self._settings.turn_timeout):
            await AgentLoop(member, setup, self._settings, done, self._activity).run()


async def serve(
    project: Path,
    start: StartRequest | None = None,
    options: ServeOptions | None = None,
    catalog: Mapping[str, HarnessEntry] = CATALOG,
    on_ready: Callable[[str], None] | None = None,
) -> None:
    """
    Serve Verifold for the folder at `project` until the caller cancels it.

    A folder with a lab resumes it. A folder without one starts `start` when given, or waits for the person to start a
    lab from the setup screen. `on_ready` gets the link to the app, with the person's token, once the server listens.

    Raises:
        LabExists: `start` is given, and the folder has a lab already.
        SetupRejected: `start` names a harness that Verifold does not know. It comes in an exception group.
        RecordLocked: Another process serves this folder already.

    """
    options = options or ServeOptions()
    with RecordFile(project / LAB_FOLDER / 'record.jsonl') as record:
        resuming = bool(record.read())
        if resuming and start:
            raise LabExists('This folder has a lab already. Run `verifold` here to resume it.')
        members, activity, person_token = Members(), Activity(), new_person_token()
        host = Host(project, record, catalog, members, activity)
        http = join_server(members.resolve).streamable_http_app(host='127.0.0.1')
        http.mount('/api', app_api(host, activity, person_token))
        http.mount('/', web_app(options.web))
        server = uvicorn.Server(
            uvicorn.Config(http, host='127.0.0.1', port=options.port, log_level='warning', timeout_graceful_shutdown=5)
        )
        serving = asyncio.create_task(server.serve())
        try:
            port = await _bound_port(server)
            settings = LoopSettings(mcp_url=f'http://127.0.0.1:{port}/mcp', turn_timeout=options.turn_timeout)
            async with asyncio.TaskGroup() as group:
                host.attach(group, settings)
                if resuming:
                    await host.resume()
                elif start:
                    await host.start(start)
                if on_ready:
                    on_ready(f'http://127.0.0.1:{port}/#token={person_token.get_secret_value()}')
                await asyncio.Event().wait()
        finally:
            server.should_exit = True
            await serving


def _agent(number: int, harness: HarnessEntry, model: str | None, effort: str | None) -> Agent:
    planner = number == 1
    return Agent(
        id=f'agent-{number}',
        name=f'Agent {number}',
        harness=harness.name,
        model=ModelSpec(family=harness.family, name=model, effort=effort),
        role=PLANNER_ROLE if planner else '',
        brief=PLANNER_BRIEF if planner else '',
    )


def _options(agent: Agent, *, auto_mode: bool) -> SessionOptions:
    return SessionOptions(model=agent.model.name, effort=agent.model.effort, auto_mode=auto_mode)


def _crew(agents: tuple[Agent, ...], catalog: Mapping[str, HarnessEntry], *, auto_mode: bool) -> Crew:
    # One entry per harness, in the order that the agents joined, with the options of the harness's first agent.
    # Checkers come from this crew.
    first = {agent.harness: agent for agent in reversed(agents)}
    harnesses = dict.fromkeys(agent.harness for agent in agents)
    return tuple((catalog[name], _options(first[name], auto_mode=auto_mode)) for name in harnesses)


def _shown(path: Path) -> str:
    # The home folder shows as ~, the way that people write paths.
    home = Path.home()
    return f'~/{path.relative_to(home)}' if path.is_relative_to(home) else str(path)


async def _bound_port(server: uvicorn.Server) -> int:
    while not server.started:
        await asyncio.sleep(0.01)
    return server.servers[0].sockets[0].getsockname()[1]
