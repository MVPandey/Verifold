"""Runs Verifold in a project folder: the server, the setup screen, and the folder's lab once it starts."""

import asyncio
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import timedelta
from functools import partial
from importlib.resources import files
from pathlib import Path
from typing import override

import psutil
import uvicorn
from pydantic import Field, JsonValue

from verifold.harnesses.catalog import CATALOG, NPX_PROJECT, HarnessEntry, available, catalog_with
from verifold.protocol.agents import MAX_AGENTS, Agent, AgentChoice, ModelSpec
from verifold.protocol.app import (
    HarnessOption,
    Offer,
    SettingsChange,
    SettingsFileView,
    SettingsView,
    SetupView,
    StartRequest,
)
from verifold.protocol.events import TurnSummary
from verifold.protocol.ids import PostId
from verifold.protocol.join import FileText
from verifold.protocol.record import Record
from verifold.protocol.settings import AtExit, SettingsLevel, SetupDefaults
from verifold.protocol.usage import Usage
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings, Shared
from verifold.runner.folders import LAB_FOLDER, agent_folder, agents_folder, tracked_lab_files
from verifold.runner.git import GitError, git
from verifold.runner.jobs import JOB_GRACE, Sweep, keep_jobs, running_jobs, sweep
from verifold.runner.messages import start_message
from verifold.runner.permissions import GrantAsks
from verifold.runner.reruns import Crew, Reruns
from verifold.runner.session import Place, SessionOptions, offer_of
from verifold.runner.snapshots import pin
from verifold.server.activity import Activity
from verifold.server.app_api import app_api, new_person_token
from verifold.server.errors import LabExists, NoLab, SetupRejected
from verifold.server.join import Members, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.server.timekeeper import keep_time
from verifold.server.web import WEB_FOLDER, web_app
from verifold.society.board import Board
from verifold.society.errors import NotFound
from verifold.store.errors import SettingsInvalid
from verifold.store.record_file import RecordFile
from verifold.store.server_file import running_server, server_file
from verifold.store.settings_file import (
    SettingsValues,
    change_setting,
    load_settings,
    read_settings_file,
    recorded_settings,
    settings_of,
    settings_path,
)

SERVER_FILE = 'server.json'
"""The file in the lab folder that names the process serving the lab."""

SERVER_GRACE = 10.0
"""Seconds that the web server gets to close its connections after the agents stop, before Verifold cancels it."""

PROBE_TIMEOUT = 60.0
"""Seconds that a harness gets to tell the setup screen what it offers. A first run can download its adapter."""

SERVER_STOP_GRACE = 30.0
"""Seconds that `stop_lab` gives a server to stop its agents and exit, before it kills the server."""

NORMS_TEMPLATE = files('verifold.society').joinpath('LAB.md').read_text()
"""The norms that a new lab starts with. The person edits the copy in the lab's folder."""
WRITING_TEMPLATE = files('verifold.society').joinpath('WRITING.md').read_text()
"""How the lab writes its answer for the person. A lab folder gets a copy, which the person can change."""
MAX_FILE_BYTES = 1_000_000
"""The largest file that the app shows as text."""


class ServeOptions(Record):
    """How the server runs: its port on 127.0.0.1, how long one agent turn may take, and the app that it serves."""

    port: int = Field(default=0, ge=0, le=65_535)
    """0 picks a free port."""
    turn_timeout: float = Field(default=2 * 3_600, gt=0)
    web: Path = WEB_FOLDER
    """The folder of the built app."""


def _ignore(_: object) -> None:
    """Drop what a hook reports."""


@dataclass(frozen=True, slots=True)
class ServeHooks:
    """What the caller of `serve` hears: the link to the app, and what each sweep of the lab's processes did."""

    ready: Callable[[str], None] = _ignore
    """Gets the link to the app, with the person's token, once the server listens."""
    swept: Callable[[Sweep], None] = _ignore
    """Gets what each sweep did: one sweep when the server starts, and one when it stops."""


class LabStop(Record):
    """What `stop_lab` stopped: the server's process ID, when a server ran, and what the sweep after it did."""

    server: int | None
    sweep: Sweep


class WebServer(uvicorn.Server):
    """A uvicorn server that leaves the stop signals to Verifold, which stops the agents before the server."""

    @override
    @contextmanager
    def capture_signals(self) -> Generator[None]:
        # uvicorn's own handler closes the server on Ctrl+C and then waits for the agents' board connections. Those
        # stay open until the agents stop, and the agents would stop only after the server.
        yield


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
        self._swept: Callable[[Sweep], None] = _ignore
        self._offers: dict[str, Offer] = {}
        self._grant_asks: GrantAsks | None = None
        self._probing: set[str] = set()
        self._adding = asyncio.Lock()

    @property
    def lab(self) -> Lab | None:
        """The folder's lab, or `None` before it starts."""
        return self._lab

    def attach(self, group: asyncio.TaskGroup, settings: LoopSettings, swept: Callable[[Sweep], None]) -> None:
        """Run the lab's agents in `group`, with `settings`, from now on. `swept` gets what each pause or stop did."""
        self._group = group
        self._settings = settings
        self._swept = swept

    async def probe(self) -> None:
        """
        Ask each harness that this computer has what it offers, for the setup screen, all at once.

        A harness that fails or takes longer than `PROBE_TIMEOUT` seconds offers nothing, and the setup screen then
        takes free text for it.
        """
        harnesses = [entry for entry in self._catalog.values() if available(entry)]
        self._probing = {entry.name for entry in harnesses}
        await asyncio.gather(*(self._probe(entry) for entry in harnesses))

    async def _probe(self, harness: HarnessEntry) -> None:
        # The probe runs in the project folder, so the harness reads the project's own settings, as the agents'
        # worktrees do.
        place = Place(
            folder=self._project,
            log=self._project / LAB_FOLDER / 'logs' / f'probe-{harness.name}.log',
            lab=self._project,
            agent='probe',
        )
        try:
            # Whatever goes wrong, the harness offers nothing, and the person types the model and the effort instead.
            with suppress(Exception):
                self._offers[harness.name] = await offer_of(harness, place, PROBE_TIMEOUT)
        finally:
            self._probing.discard(harness.name)

    def settings(self) -> SettingsView:
        """Return the person's settings files, and the copy that the folder's lab follows."""
        paths = {level: settings_path(level, self._project) for level in SettingsLevel}
        # Each file is read once, so that its values, its revision, and what it adds up to agree.
        read = {level: read_settings_file(path, level) for level, path in paths.items()}
        values = {level: data for level, (data, _) in read.items()}

        def view(level: SettingsLevel, adds_up: Mapping[SettingsLevel, SettingsValues]) -> SettingsFileView:
            data, revision = read[level]
            total = settings_of(adds_up)
            return SettingsFileView(
                path=_shown(paths[level]),
                values=data,
                revision=revision,
                settings=total.lab_settings(),
                defaults=total.setup,
            )

        return SettingsView(
            all_projects=view(SettingsLevel.ALL, {SettingsLevel.ALL: values[SettingsLevel.ALL]}),
            project=view(SettingsLevel.PROJECT, values),
            lab=self._lab.board.settings if self._lab else None,
        )

    async def file_text(self, post_id: PostId, path: str) -> FileText:
        """
        Return the text of a file that backs a post, at the commit that the post pins.

        Raises:
            NoLab: The folder has no lab.
            NotFound: The post does not name the file, the file is gone, it is too large, or it is not text.

        """
        if self._lab is None:
            raise NoLab('This folder has no lab yet. Start one from the setup screen.')
        entry = self._lab.board.post(post_id)
        file = next((item for item in entry.post.evidence if item.path == path), None) if entry else None
        if entry is None or file is None:
            raise NotFound(f'Post {post_id} names no file {path}.')
        folder = agents_folder(self._project) / entry.post.author
        blob = f'{file.commit}:{file.path}'
        try:
            size = int(await git('cat-file', '-s', blob, cwd=folder))
            if size > MAX_FILE_BYTES:
                raise NotFound(f'{path} is larger than {MAX_FILE_BYTES:,} bytes, so the app does not show it.')
            text = await git('show', blob, cwd=folder, strip=False)
        except UnicodeDecodeError as error:
            raise NotFound(f'{path} is not a text file.') from error
        except (GitError, OSError, ValueError) as error:
            raise NotFound(f'{path} is not in the folder of {entry.post.author} at {file.commit[:8]}.') from error
        return FileText(path=file.path, commit=file.commit, text=text)

    async def change_settings(self, change: SettingsChange) -> SettingsView:
        """
        Change one setting in one of the person's settings files, and apply it to the folder's lab.

        The lab takes the setting when the change decides it for this project. A change for all projects doesn't
        reach a lab whose project has a setting of its own. The lab takes nothing else from the files, so an edit that
        an agent made to them stays out of it.
        """
        paths = {level: settings_path(level, self._project) for level in SettingsLevel}
        revisions = {SettingsLevel.PROJECT: change.revisions.project, SettingsLevel.ALL: change.revisions.all_projects}
        values = change_setting(paths, change.level, change.key, _written(change.value), revisions)
        decides = change.level is SettingsLevel.PROJECT or not _holds(values[SettingsLevel.PROJECT], change.key)
        # The choices for new labs don't change a running lab. Only the job settings do.
        if self._lab is not None and decides and change.key.startswith('jobs.'):
            name = change.key.removeprefix('jobs.')
            chosen = getattr(settings_of(values).jobs, name)
            running = self._lab.board.settings
            # The lab follows the person's choice, also when the files held it already but the lab doesn't.
            if getattr(running.jobs, name) != chosen:
                jobs = running.jobs.model_copy(update={name: chosen})
                await self._lab.set_settings(running.model_copy(update={'jobs': jobs}))
        return self.settings()

    def setup(self) -> SetupView:
        """Return the harnesses that this computer has, and the folder's lab, if any."""
        # The lab's pages don't use the choices for new labs, so a running lab reads no settings file here.
        defaults, source = self._defaults() if self._lab is None else (SetupDefaults(), None)
        return SetupView(
            defaults=defaults,
            defaults_from=source,
            folder=_shown(self._project),
            harnesses=tuple(
                HarnessOption(
                    name=entry.name,
                    title=entry.title,
                    family=entry.family,
                    available=available(entry),
                    probing=entry.name in self._probing,
                    offer=self._offers.get(entry.name),
                )
                for entry in self._catalog.values()
            ),
            question=self._lab.board.opened.question if self._lab else None,
        )

    def _defaults(self) -> tuple[SetupDefaults, str | None]:
        # The saved choices for new labs, and the file that they come from. A broken settings file doesn't hide the
        # setup: the start then refuses, with the file's error.
        paths = {level: settings_path(level, self._project) for level in SettingsLevel}
        try:
            values = {level: read_settings_file(path, level)[0] for level, path in paths.items()}
            defaults = settings_of(values).setup
        except SettingsInvalid:
            return SetupDefaults(), None
        holder = next((level for level in (SettingsLevel.PROJECT, SettingsLevel.ALL) if 'setup' in values[level]), None)
        return defaults, None if holder is None else _shown(paths[holder])

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
        # A broken settings file must refuse the start before the record holds anything.
        settings = load_settings(self._project).lab_settings()
        lab = Lab.create(self._record, request.question, auto_mode=request.auto_mode, time_left=time_left)
        await lab.set_settings(settings)
        for prefix in request.allow:
            await lab.grant(prefix)
        await lab.open_question_thread()
        self._lab = lab
        chosen = [choice for choice in request.agents for _ in range(choice.count)]
        for number, choice in enumerate(chosen, start=1):
            await lab.join(_agent(number, self._catalog[choice.harness], choice))
        await self._launch()

    async def resume(self) -> None:
        """Serve the lab that the folder's record holds, and start its agents again."""
        self._lab = Lab.load(self._record)
        if recorded_settings(self._record.read()) is None:
            await self._lab.set_settings(load_settings(self._project).lab_settings())
        await self._launch()

    async def _launch(self) -> None:
        lab, group, settings = self._lab, self._group, self._settings
        if lab is None or group is None or settings is None:
            raise SetupRejected('Attach the host to the server before a lab starts.')
        norms = self._project / LAB_FOLDER / 'LAB.md'
        if not norms.exists():
            norms.write_text(NORMS_TEMPLATE)
        writing = self._project / LAB_FOLDER / 'WRITING.md'
        if not writing.exists():
            writing.write_text(WRITING_TEMPLATE)
        group.create_task(keep_time(lab))
        group.create_task(keep_jobs(lab, self._project, self._swept))
        self._grant_asks = GrantAsks(lab)
        group.create_task(self._grant_asks.run())
        # A lab that is served again is under way for all of its agents. A new lab is so for none of them.
        under_way = bool(lab.board.turns)
        for agent in self._workers(lab):
            await self._run_agent(lab, agent, under_way=under_way)
        group.create_task(Reruns(lab, self._members, self._project, partial(self._crew, lab), self._supervise).run())

    def _workers(self, lab: Lab) -> tuple[Agent, ...]:
        # The lab's agents that Verifold runs: no blind checkers, and no agent of a harness that this computer lacks.
        return tuple(
            entry.agent for entry in lab.board.agents if not entry.agent.checks and entry.agent.harness in self._catalog
        )

    def _crew(self, lab: Lab) -> Crew:
        return _crew(self._workers(lab), self._catalog, auto_mode=lab.board.opened.auto_mode)

    async def _run_agent(self, lab: Lab, agent: Agent, *, under_way: bool) -> None:
        group, settings = self._group, self._settings
        if group is None or settings is None:
            raise SetupRejected('Attach the host to the server before a lab starts.')
        norms = self._project / LAB_FOLDER / 'LAB.md'
        writing = self._project / LAB_FOLDER / 'WRITING.md'
        start = start_message(lab.board, agent, norms, writing, under_way=under_way)
        member, setup = await self._seat(lab, agent, start)
        await self._activity.set(agent.id, 'starting')
        group.create_task(AgentLoop(member, setup, settings, shared=self._shared()).run())

    async def add_agents(self, choice: AgentChoice) -> None:
        """
        Add agents of one harness to the lab that runs, and start them.

        Raises:
            NoLab: The folder has no lab.
            SetupRejected: The harness is unknown, or the lab would have more than `MAX_AGENTS` agents.

        """
        lab = self._lab
        if lab is None:
            raise NoLab('This folder has no lab yet. Start one from the setup screen.')
        entry = self._catalog.get(choice.harness)
        if entry is None:
            raise SetupRejected(f'Unknown harness {choice.harness}. Choose from: {", ".join(self._catalog)}.')
        if not available(entry):
            raise SetupRejected(f'This computer does not have {entry.title}, so an agent of it cannot start.')
        # One add at a time, so that two requests cannot pass the limit together.
        async with self._adding:
            members = sum(not joined.agent.checks for joined in lab.board.agents)
            if members + choice.count > MAX_AGENTS:
                raise SetupRejected(f'A lab has at most {MAX_AGENTS} agents, and this one has {members}.')
            for _ in range(choice.count):
                number = 1 + sum(not joined.agent.checks for joined in lab.board.agents)
                while lab.board.agent(f'agent-{number}'):
                    number += 1
                agent = _agent(number, entry, choice)
                # The folder comes first. An agent that the record holds and that has no folder could never start.
                try:
                    await agent_folder(self._project, agent.id)
                except (GitError, OSError) as error:
                    raise SetupRejected(f"Can't make the folder of {agent.name}: {error}") from error
                await lab.join(agent)
                await self._run_agent(lab, agent, under_way=True)

    def _shared(self) -> Shared:
        return Shared(activity=self._activity, grant_asks=self._grant_asks, has_jobs=self._has_jobs)

    async def _has_jobs(self, agent: str) -> bool:
        return bool(await asyncio.to_thread(running_jobs, self._project, agent))

    async def _seat(self, lab: Lab, agent: Agent, start: str) -> tuple[Member, AgentSetup]:
        folder = await agent_folder(self._project, agent.id)
        member = Member(lab, agent.id, pin=partial(pin, folder, agent.id))
        setup = AgentSetup(
            agent=agent,
            harness=self._catalog[agent.harness],
            lab=self._project,
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
        limit = self._settings.turn_timeout
        try:
            async with asyncio.timeout(limit):
                await AgentLoop(member, setup, self._settings, done, self._shared()).run()
        except TimeoutError:
            # A checker that runs too long stops, and the lab goes on. Its post stays unchecked, and the board says why.
            error = f'The check ran past {limit:g} seconds, so Verifold stopped the checker.'
            checked = done(member.lab.board)
            await member.lab.end_turn(_stopped_checker(setup.agent.id, error, checked=checked, seconds=limit))
            return
        if not done(member.lab.board):
            # The failed rerun frees its requests, so a member can ask again and get another checker.
            error = 'The checker stopped without a check.'
            await member.lab.end_turn(_stopped_checker(setup.agent.id, error, checked=False))


async def serve(
    project: Path,
    start: StartRequest | None = None,
    options: ServeOptions | None = None,
    catalog: Mapping[str, HarnessEntry] = CATALOG,
    hooks: ServeHooks | None = None,
) -> None:
    """
    Serve Verifold for the folder at `project` until the caller cancels it.

    A folder with a lab resumes it. A folder without one starts `start` when given, or waits for the person to start a
    lab from the setup screen.

    When it starts and when it stops, the server sweeps the processes that carry the lab's mark: first the ones that an
    earlier run left, and at the end the ones that the agents started.

    Raises:
        LabExists: `start` is given, and the folder has a lab already.
        SetupRejected: `start` names a harness that Verifold does not know, which comes in an exception group, or
            the project's repository tracks lab files.
        RecordLocked: Another process serves this folder already.

    """
    options, hooks = options or ServeOptions(), hooks or ServeHooks()
    if tracked := await tracked_lab_files(project):
        raise SetupRejected(
            f'The repository tracks {", ".join(tracked)}. Verifold keeps its own lab in {LAB_FOLDER}/, so it does not '
            f'start on lab files that came with the repository. Remove them with `git rm --cached {" ".join(tracked)}` '
            'or delete them, then run verifold again.'
        )
    # The built-in adapters' npm project, which holds nothing, so that npm reads nothing from the project.
    NPX_PROJECT.mkdir(parents=True, exist_ok=True)
    with RecordFile(project / LAB_FOLDER / 'record.jsonl') as record, server_file(project / LAB_FOLDER / SERVER_FILE):
        events = record.read()
        resuming = bool(events)
        if resuming and start:
            raise LabExists('This folder has a lab already. Run `verifold` here to resume it.')
        # The files give this computer's harnesses at every start. A lab follows the settings in its record, so the
        # files' other settings matter only for a lab that starts now.
        files = load_settings(project)
        catalog = catalog_with(files.harnesses, catalog)
        opening = recorded_settings(events) or files.lab_settings()
        if opening.jobs.at_exit is AtExit.STOP:
            # This process holds the record, so no other server runs the lab, and every marked process is a leftover.
            leftovers = await asyncio.to_thread(sweep, project)
            hooks.swept(leftovers.model_copy(update={'earlier_run': True}))
        members, activity, person_token = Members(), Activity(), new_person_token()
        host = Host(project, record, catalog, members, activity)
        http = join_server(members.resolve).streamable_http_app(host='127.0.0.1')
        http.mount('/api', app_api(host, activity, person_token))
        http.mount('/', web_app(options.web))
        server = WebServer(
            uvicorn.Config(http, host='127.0.0.1', port=options.port, log_level='warning', timeout_graceful_shutdown=5)
        )
        serving = asyncio.create_task(server.serve())
        try:
            port = await _bound_port(server)
            settings = LoopSettings(mcp_url=f'http://127.0.0.1:{port}/mcp', turn_timeout=options.turn_timeout)
            async with asyncio.TaskGroup() as group:
                host.attach(group, settings, hooks.swept)
                if resuming:
                    await host.resume()
                elif start:
                    await host.start(start)
                else:
                    group.create_task(host.probe())
                hooks.ready(f'http://127.0.0.1:{port}/#token={person_token.get_secret_value()}')
                await asyncio.Event().wait()
        finally:
            # The task group has stopped the agents' harnesses. Their processes stop next, and the web server last, also
            # when the hook fails.
            try:
                if (host.lab.board.settings if host.lab else opening).jobs.at_exit is AtExit.STOP:
                    hooks.swept(await asyncio.to_thread(sweep, project))
            finally:
                server.should_exit = True
                await _closed(serving)


def stop_lab(project: Path) -> LabStop:
    """
    Stop the server that serves the lab in `project`, and then every process that the lab's agents started.

    The server gets SIGTERM and SIGCONT, so that a paused server stops too, and SIGKILL after `SERVER_STOP_GRACE`
    seconds. Then this process takes the record and sweeps, which also stops what a killed or crashed server left. It
    blocks while it waits.

    Raises:
        RecordLocked: A process that the server file doesn't name still serves the lab.

    """
    server = running_server(project / LAB_FOLDER / SERVER_FILE)
    if server:
        _end(server)
    record = project / LAB_FOLDER / 'record.jsonl'
    if not record.exists():
        return LabStop(server=server.pid if server else None, sweep=Sweep())
    with RecordFile(record):
        return LabStop(server=server.pid if server else None, sweep=sweep(project))


def _end(server: psutil.Process) -> None:
    with suppress(psutil.Error):
        server.terminate()
        server.resume()
        try:
            server.wait(SERVER_STOP_GRACE)
        except psutil.TimeoutExpired:
            server.kill()
            server.wait(JOB_GRACE)


async def _closed(serving: asyncio.Task[None]) -> None:
    # uvicorn waits for its open connections, such as the event stream of an app tab that stays open.
    await asyncio.wait({serving}, timeout=SERVER_GRACE)
    serving.cancel()
    with suppress(asyncio.CancelledError):
        await serving


def _stopped_checker(checker: str, error: str, *, checked: bool, seconds: float = 0) -> TurnSummary:
    # The rerun failed only when the checker stopped before it posted its check.
    return TurnSummary(agent=checker, seconds=seconds, usage=Usage(), error=error, rerun_failed=not checked)


def _agent(number: int, harness: HarnessEntry, choice: AgentChoice) -> Agent:
    return Agent(
        id=f'agent-{number}',
        name=f'Agent {number}',
        harness=harness.name,
        model=ModelSpec(family=harness.family, name=choice.model, effort=choice.effort),
        mode=choice.mode,
    )


def _options(agent: Agent, *, auto_mode: bool) -> SessionOptions:
    return SessionOptions(model=agent.model.name, effort=agent.model.effort, mode=agent.mode, auto_mode=auto_mode)


def _crew(agents: tuple[Agent, ...], catalog: Mapping[str, HarnessEntry], *, auto_mode: bool) -> Crew:
    # One entry per harness, in the order that the agents joined, with the model and effort of the harness's first
    # agent. Checkers come from this crew. A checker follows the auto mode answer, not a worker's mode, because it
    # must be able to run the work again.
    first = {agent.harness: agent for agent in reversed(agents)}
    harnesses = dict.fromkeys(agent.harness for agent in agents)
    return tuple(
        (catalog[name], _options(first[name].model_copy(update={'mode': None}), auto_mode=auto_mode))
        for name in harnesses
    )


def _written(value: str | SetupDefaults | None) -> JsonValue:
    # The choices for new labs go into the file in full, so that a project's choices never take a part from the ones
    # for all projects. Each agent leaves out what it doesn't set.
    if not isinstance(value, SetupDefaults):
        return value
    agents: list[JsonValue] | None = None
    if value.agents is not None:
        agents = [agent.model_dump(mode='json', exclude_defaults=True) for agent in value.agents]
    written: dict[str, JsonValue] = {'agents': agents, 'auto_mode': value.auto_mode, 'minutes': value.minutes}
    return written


def _holds(values: SettingsValues, key: str) -> bool:
    # Whether a settings file holds the setting with dots in `key`.
    found: JsonValue = values
    for part in key.split('.'):
        if not isinstance(found, dict) or part not in found:
            return False
        found = found[part]
    return True


def _shown(path: Path) -> str:
    # The home folder shows as ~, the way that people write paths.
    home = Path.home()
    return f'~/{path.relative_to(home)}' if path.is_relative_to(home) else str(path)


async def _bound_port(server: uvicorn.Server) -> int:
    while not server.started:
        await asyncio.sleep(0.01)
    return server.servers[0].sockets[0].getsockname()[1]
