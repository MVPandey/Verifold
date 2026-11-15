"""Runs Verifold in a project folder: the server, the setup screen, and the folder's lab once it starts."""

import asyncio
import re
import secrets
import socket
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
from pathlib import Path
from typing import override
from urllib.parse import urlsplit

import psutil
import uvicorn
from pydantic import Field, JsonValue

from verifold.harnesses.catalog import CATALOG, NPX_PROJECT, HarnessEntry, available, catalog_with
from verifold.protocol.agents import GUEST, MAX_AGENTS, UNKNOWN_FAMILY, Agent, AgentChoice, ModelSpec
from verifold.protocol.app import (
    NORMS_NAMES,
    NORMS_POST_SECONDS,
    FolderView,
    HarnessOption,
    Invitation,
    InviteRequest,
    NoPost,
    NormsChange,
    NormsFile,
    NormsName,
    NormsView,
    Offer,
    SeatChange,
    SettingsChange,
    SettingsFileView,
    SettingsView,
    SetupView,
    StartRequest,
)
from verifold.protocol.events import TurnSummary
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import FileText, PostRequest
from verifold.protocol.moves import AddSeat
from verifold.protocol.record import Record
from verifold.protocol.settings import AtExit, SettingsLevel, SetupDefaults
from verifold.protocol.usage import Usage
from verifold.runner.agent_loop import AgentLoop, AgentSetup, LoopSettings, Shared
from verifold.runner.errors import NoAgentFolder, NoFileManager
from verifold.runner.folders import LAB_FOLDER, agent_folder, agents_folder, open_folder, real_folder, tracked_lab_files
from verifold.runner.git import GitError, git
from verifold.runner.jobs import JOB_GRACE, Sweep, keep_jobs, sweep
from verifold.runner.messages import invitation, start_message
from verifold.runner.permissions import Refusals
from verifold.runner.reruns import CleanCopies
from verifold.runner.session import Place, SessionOptions, offer_of
from verifold.runner.snapshots import pin
from verifold.server.activity import Activity
from verifold.server.app_api import app_api, new_person_token
from verifold.server.errors import LabExists, NoLab, SetupRejected
from verifold.server.join import Members, join_server, token_digest
from verifold.server.lab import Build, Lab
from verifold.server.member import Member
from verifold.server.timekeeper import keep_time
from verifold.server.web import WEB_FOLDER, web_app
from verifold.society.attention import update
from verifold.society.board import Board
from verifold.society.errors import NotFound, SocietyError
from verifold.society.labels import NOT_LISTED, label
from verifold.society.lines import question_thread
from verifold.society.standing import closing
from verifold.society.turns import before
from verifold.store.errors import GuestsInvalid, NormsChanged, NormsUnreadable, SettingsInvalid, StoreError
from verifold.store.guests_file import GUESTS_FILE, Guests, drop_guest, keep_guest, read_guests
from verifold.store.norms_file import (
    DEFAULTS,
    missing_lines,
    read_norms,
    revision,
    write_missing_norms,
    write_norms,
)
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

NORMS_TEMPLATE = DEFAULTS['LAB.md']
"""The norms that a new lab starts with. The person edits the copy in the lab's folder."""
WRITING_TEMPLATE = DEFAULTS['WRITING.md']
"""How the lab writes its answer for the person. A lab folder gets a copy, which the person can change."""
MAX_FILE_BYTES = 1_000_000
"""The largest file that the app shows as text."""
NORMS_CHANGED = {
    'LAB.md': "The person changed the lab's norms. {path} holds them.",
    'WRITING.md': 'The person changed how the lab writes its answer. {path} holds the text.',
}
"""The person's post that tells the agents of a change to a norms file. It states the change and where the text is."""


class ServeOptions(Record):
    """
    How the server runs.

    It holds the port on 127.0.0.1, how long one agent turn may take, how long a doorbell waits for a quiet board,
    and the app that the server serves.
    """

    port: int = Field(default=0, ge=0, le=65_535)
    """0 picks a free port."""
    turn_timeout: float = Field(default=2 * 3_600, gt=0)
    quiet: float = Field(default=10, ge=0)
    """Seconds without a new event on the board before an agent's doorbell rings."""
    max_quiet: float = Field(default=45, ge=0)
    """The most seconds that a doorbell waits for the board to go quiet."""
    web: Path = WEB_FOLDER
    """The folder of the built app."""
    desktop: bool = True
    """Whether the server may open a folder in the file manager. `--no-browser` says that it has no desktop to use."""


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
        self._copies = CleanCopies(project)
        """Gives the clean copies for reruns, each verified against the pinned commit at every take."""
        self._desktop = True
        self._record = record
        self._catalog = catalog
        self._members = members
        self._activity = activity
        self._lab: Lab | None = None
        self._group: asyncio.TaskGroup | None = None
        self._settings: LoopSettings | None = None
        self._swept: Callable[[Sweep], None] = _ignore
        self._offers: dict[str, Offer] = {}
        self._refusals: Refusals | None = None
        self._probing: set[str] = set()
        self._asked: set[str] = set()
        """The harnesses that Verifold asked what they offer, whatever came of it. It asks each one once."""
        self._adding = asyncio.Lock()
        self._norms_saved: dict[NormsName, str] = {}
        """The revision of the last text of each norms file that the person saved from the app, in this process."""
        self._norms_told: tuple[datetime, PostId] | None = None
        """When the last post told the lab of a change to its norms, and which post it was."""
        self._loops: dict[AgentId, asyncio.Task[None]] = {}
        """The task that supervises each agent that Verifold started."""

    @property
    def lab(self) -> Lab | None:
        """The folder's lab, or `None` before it starts."""
        return self._lab

    def attach(
        self,
        group: asyncio.TaskGroup,
        settings: LoopSettings,
        swept: Callable[[Sweep], None],
        *,
        desktop: bool = True,
    ) -> None:
        """
        Run the lab's agents in `group`, with `settings`, from now on. `swept` gets what each pause or stop did.

        Without `desktop`, the host opens no folder in the file manager and only says where the folder is.
        """
        self._desktop = desktop
        self._group = group
        self._settings = settings
        self._swept = swept

    async def probe(self) -> None:
        """
        Ask each harness that this computer has what it offers, for the setup screen, all at once.

        A harness that fails or takes longer than `PROBE_TIMEOUT` seconds offers nothing, and the setup screen then
        takes free text for it.
        """
        await self._probe_each(self._to_ask())

    def ask_harnesses(self) -> SetupView:
        """
        Ask each harness that Verifold did not ask yet what it offers, in the background, and return the setup.

        A lab that is served again asked none, so the form that adds an agent asks when the person opens it. The
        setup shows which harnesses Verifold asks now.
        """
        asked = self._to_ask()
        if asked and self._group:
            self._group.create_task(self._probe_each(asked))
        return self.setup()

    def _to_ask(self) -> list[HarnessEntry]:
        # Marks the harnesses as asked at once, so that the setup shows them as asked before the first answer.
        harnesses = [entry for entry in self._catalog.values() if available(entry) and entry.name not in self._asked]
        self._asked |= {entry.name for entry in harnesses}
        self._probing |= {entry.name for entry in harnesses}
        return harnesses

    async def _probe_each(self, harnesses: list[HarnessEntry]) -> None:
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

    async def open_folder(self, agent_id: AgentId | None = None) -> FolderView:
        """
        Open the folder where the lab's agents work, or the folder of one agent, in the file manager.

        The path comes from the lab and never from the request: `agent_id` must be an agent of the lab. The answer
        holds the path also when nothing opened, so the person can go there by hand.

        Raises:
            NoLab: The folder has no lab.
            NotFound: The lab has no such agent, or the folder is missing or is a link to another place.

        """
        if self._lab is None:
            raise NoLab('This folder has no lab yet. Start one from the setup screen.')
        if agent_id is not None and self._lab.board.agent(agent_id) is None:
            raise NotFound(f'The lab has no agent with the ID {agent_id}.')
        try:
            folder = real_folder(self._project, agent_id)
        except NoAgentFolder as error:
            raise NotFound(str(error)) from error
        opened = False
        if self._desktop:
            with suppress(NoFileManager):
                await asyncio.to_thread(open_folder, folder)
                opened = True
        return FolderView(path=str(folder), opened=opened)

    def norms(self, told: PostId | None = None, no_post: NoPost | None = None) -> NormsView:
        """
        Return the lab's two norms files as they are in the lab folder.

        Before a lab starts, a file that the folder lacks shows Verifold's default, which the new lab gets. Each
        file is read by itself: one that Verifold can't read shows its own error, and the other stays as it is.
        """
        return NormsView(files=tuple(self._norms_file(name) for name in NORMS_NAMES), told=told, no_post=no_post)

    def _norms_file(self, name: NormsName) -> NormsFile:
        folder = self._project / LAB_FOLDER
        path = _shown(folder / name)
        try:
            read = read_norms(folder, name)
        except NormsUnreadable as error:
            return NormsFile(name=name, path=path, error=str(error))
        now = revision(read.text)
        mine = self._norms_saved.get(name)
        return NormsFile(
            name=name,
            path=path,
            text=read.text,
            saved=read.saved,
            revision=now,
            changed_at=read.changed_at,
            # Without a save from the page in this process, nothing says who wrote the file.
            changed_by=None if mine is None or not read.saved else 'page' if mine == now else 'outside',
            missing=missing_lines(name, read.text),
        )

    async def change_norms(self, change: NormsChange) -> NormsView:
        """
        Save the person's new text for one norms file, and tell the lab's agents that it changed.

        The file's name is one of two fixed names in the lab folder, so no request reaches another path. Before a
        lab starts, the saved file is what the new lab gets, because a lab writes only the files that are missing.
        The save names the revision that the person read. When the file changed since, for example because an
        agent wrote it, the save is refused, so that it writes over nothing that the person didn't see.

        In a lab, a post of the person in the question's thread says that the file changed and where it is. It
        names nobody, so it reaches the agents by the path that the person's other words take. No post goes out
        when the text is the same, when the lab has no question thread, when a close stands, because a post of the
        person would open that lab again, or when such a post went out less than `NORMS_POST_SECONDS` ago. After
        the file is written, nothing here raises: a post that the board refuses leaves a saved file and no post.

        Raises:
            NormsUnreadable: The path holds something that Verifold does not read.
            NormsChanged: The file changed since the person read it.
            SettingsUnwritable: The file is a link, or it can't be written.

        """
        folder = self._project / LAB_FOLDER
        read = read_norms(folder, change.name)
        if revision(read.text) != change.revision:
            raise NormsChanged(f'{_shown(folder / change.name)} changed since you opened it. This is its new text.')
        if read.saved and read.text == change.text:
            return self.norms(no_post='same')
        write_norms(folder, change.name, change.text)
        self._norms_saved[change.name] = revision(change.text)
        told, no_post = await self._tell_of_norms(change.name)
        return self.norms(told, no_post)

    async def _tell_of_norms(self, name: NormsName) -> tuple[PostId | None, NoPost | None]:
        # Post that a norms file changed. Return the post, or why none went out.
        lab = self._lab
        if lab is None:
            return None, 'no_lab'
        thread = question_thread(lab.board)
        if thread is None:
            return None, 'no_thread'
        if closing(lab.board):
            return None, 'close'
        if self._norms_told and (lab.now() - self._norms_told[0]).total_seconds() < NORMS_POST_SECONDS:
            return self._norms_told[1], 'told_already'
        text = NORMS_CHANGED[name].format(path=self._project / LAB_FOLDER / name)
        try:
            posted = await lab.post(PostRequest(kind='message', text=text, thread=thread), PERSON)
        except (SocietyError, StoreError, OSError):
            return None, 'refused'
        self._norms_told = (lab.now(), posted.post.id)
        return posted.post.id, None

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
        # The choices for new labs don't change a running lab. Only the settings that a lab follows do.
        if self._lab is not None and decides and change.key != 'setup':
            section, name = change.key.split('.')
            chosen = getattr(getattr(settings_of(values), section), name)
            running = self._lab.board.settings
            # The lab follows the person's choice, also when the files held it already but the lab doesn't.
            if getattr(getattr(running, section), name) != chosen:
                changed = getattr(running, section).model_copy(update={name: chosen})
                await self._lab.set_settings(running.model_copy(update={section: changed}))
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
            question=self._lab.board.question if self._lab else None,
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
        if request.reviewer_seats is not None:
            seats = None if request.reviewer_seats == 'size' else request.reviewer_seats
            settings = settings.model_copy(update={'reviewers': settings.reviewers.model_copy(update={'seats': seats})})
        lab = Lab.create(self._record, request.question, auto_mode=request.auto_mode, time_left=time_left)
        await lab.set_settings(settings)
        for prefix in request.allow:
            await lab.grant(prefix)
        await lab.open_question_thread()
        await lab.state_deliverables(request.deliverables)
        self._lab = lab
        chosen = [choice for choice in request.agents for _ in range(choice.count)]
        for number, choice in enumerate(chosen, start=1):
            await self._join(lab, number, choice, auto_mode=request.auto_mode)
        await self._launch()

    async def _join(  # noqa: PLR0913
        self,
        lab: Lab,
        number: int,
        choice: AgentChoice,
        *,
        auto_mode: bool,
        first: tuple[Build, ...] = (),
        given: tuple[str, AgentId] | None = None,
        asked: bool = False,
    ) -> Agent:
        # Add one agent of a seat to the record, with its name and the facts that the person gave the seat. `given`
        # is a role that the coordinator gives the seat, which the record keeps as the coordinator's. With `asked`,
        # a coordinator's move named the seat.
        harness = self._catalog[choice.harness]
        agent = _agent(
            number,
            harness,
            choice,
            self._offers.get(harness.name),
            _names(lab.board),
            auto_mode=auto_mode,
            asked=asked,
        )
        await lab.join(
            agent,
            on_call=choice.on_call,
            coordinator=choice.coordinator,
            powers=choice.powers,
            first=first,
            given=given,
        )
        return agent

    async def resume(self) -> None:
        """
        Serve the lab that the folder's record holds, and start its agents again.

        Each agent goes on from its turns in the record: its harness loads its conversation when it can, and its
        seat starts at what the agent had seen. An agent that Verifold stopped, because its harness failed too
        often, stays stopped until the person starts it again.
        """
        self._lab = Lab.load(self._record)
        if recorded_settings(self._record.read()) is None:
            await self._lab.set_settings(load_settings(self._project).lab_settings())
        await self._launch()

    async def _launch(self) -> None:
        lab, group, settings = self._lab, self._group, self._settings
        if lab is None or group is None or settings is None:
            raise SetupRejected('Attach the host to the server before a lab starts.')
        # A path that holds anything stays as it is, also a link that leads nowhere.
        write_missing_norms(self._project / LAB_FOLDER)
        group.create_task(keep_time(lab))
        group.create_task(keep_jobs(lab, self._project, self._swept))
        self._refusals = Refusals(lab)
        group.create_task(self._refusals.run())
        # A lab that is served again is under way for all of its agents. A new lab is so for none of them.
        under_way = bool(lab.board.turns or lab.board.starts)
        for agent in self._workers(lab):
            if before(lab.board, agent.id).stopped:
                # The app shows what it showed before the restart. Only the person starts this agent again.
                await self._activity.set(agent.id, 'stopped')
            else:
                await self._run_agent(lab, agent, under_way=under_way)
        # An agent of a harness that this computer lacks has no loop, and the app says why.
        for entry in lab.board.agents:
            agent = entry.agent
            runs = agent.checks or agent.harness == GUEST or agent.harness in self._catalog
            if not runs and not lab.board.gone(agent.id):
                await self._activity.set(agent.id, 'stopped', NO_HARNESS)
        # An invited agent keeps its seat and its token. It runs by itself, so nothing starts here. One that left
        # gets no seat.
        digests = _kept(self._guests_file).digests
        for agent in (entry.agent for entry in lab.board.agents if entry.agent.harness == GUEST):
            if not lab.board.gone(agent.id):
                await self._seat_guest(lab, agent, digests.get(agent.id))
        group.create_task(self._forget_guests(lab))

    async def _forget_guests(self, lab: Lab) -> None:
        # Drops the token digest of each invited agent that left, whoever caused it. The board refuses the agent
        # from the moment that the record says so. Without the digest, a restart gives the agent no seat either.
        done = 0
        while True:
            board = lab.board
            for left in board.left[done:]:
                joined = board.agent(left.agent)
                if joined and joined.agent.harness == GUEST:
                    # A file that can't change keeps a digest that opens nothing, because the agent gets no seat.
                    with suppress(GuestsInvalid, OSError):
                        drop_guest(self._guests_file, left.agent)
            done = len(board.left)
            await lab.wait_for_change(board.seq)

    def _workers(self, lab: Lab) -> tuple[Agent, ...]:
        # The lab's agents that Verifold runs: no invited agents, no agent that left, no agent of a harness that
        # this computer lacks, and no checker of a record from before agents took reruns.
        return tuple(
            entry.agent
            for entry in lab.board.agents
            if not entry.agent.checks
            and entry.agent.harness != GUEST
            and entry.agent.harness in self._catalog
            and not lab.board.gone(entry.agent.id)
        )

    async def _run_agent(self, lab: Lab, agent: Agent, *, under_way: bool) -> None:
        group, settings = self._group, self._settings
        if group is None or settings is None:
            raise SetupRejected('Attach the host to the server before a lab starts.')
        if lab.board.on_call(agent.id) and not before(lab.board, agent.id).worked:
            # Verifold starts no turn for an on-call agent. The folder comes now, so that a failure shows here.
            await agent_folder(self._project, agent.id)
            await self._activity.set(agent.id, 'idle')
            self._loops[agent.id] = group.create_task(self._run_when_called(lab, agent, settings))
            return
        member, setup = await self._seat(lab, agent, self._start_message(lab, agent, under_way=under_way))
        await self._activity.set(agent.id, 'starting')
        self._loops[agent.id] = group.create_task(AgentLoop(member, setup, settings, shared=self._shared()).run())

    def _start_message(self, lab: Lab, agent: Agent, *, under_way: bool) -> str:
        norms = self._project / LAB_FOLDER / 'LAB.md'
        writing = self._project / LAB_FOLDER / 'WRITING.md'
        return start_message(lab.board, agent, norms, writing, under_way=under_way)

    async def _run_when_called(self, lab: Lab, agent: Agent, settings: LoopSettings) -> None:
        # An on-call agent that never worked has no harness and no turn. It starts when the first post for it
        # arrives, or when the person takes its seat off call. Its first message then holds the facts of that
        # moment. After a restart the wait starts again from the agent's join, so a post from before still counts.
        # No harness starts while the lab is out of time, because no turn can run then.
        seen = before(lab.board, agent.id).seen
        while True:
            board = lab.board
            if board.gone(agent.id):
                return
            called = not board.on_call(agent.id) or update(board, agent.id, seen).posts
            if called and not board.out_of_time:
                break
            await lab.wait_for_change(board.seq)
        # The agent can have a new name by now, so its seat and its first message take it from the board.
        joined = lab.board.agent(agent.id)
        agent = joined.agent if joined else agent
        try:
            member, setup = await self._seat(lab, agent, self._start_message(lab, agent, under_way=True))
        except (GitError, OSError) as error:
            # One agent that cannot start must not stop the lab. The record keeps why, the member list shows it,
            # and the person can start the agent again.
            failed = f"Verifold can't start {agent.name}: {error}"
            await lab.end_turn(
                TurnSummary(agent=agent.id, seconds=0, usage=Usage(), error=failed, stopped=True, no_turn=True)
            )
            await self._activity.set(agent.id, 'stopped')
            return
        await self._activity.set(agent.id, 'starting')
        await AgentLoop(member, setup, settings, shared=self._shared()).run()

    async def start_again(self, agent_id: AgentId) -> None:
        """
        Start an agent that Verifold stopped because its harness failed too often in a row.

        The agent keeps its ID, its folder, and its posts. Its harness loads its conversation again when it can.
        The agent gets a message at once, which says what happened. The app shows it as stopped no longer.

        Raises:
            NoLab: The folder has no lab.
            NotFound: The lab has no agent with that ID that Verifold runs.
            SetupRejected: Verifold did not stop the agent, its harness runs already, or this computer lacks it.

        """
        lab = self._running()
        agent = next((worker for worker in self._workers(lab) if worker.id == agent_id), None)
        if agent is None:
            raise NotFound(f'The lab has no agent with the ID {agent_id} that Verifold runs.')
        entry = self._catalog[agent.harness]
        if not available(entry):
            raise SetupRejected(f'This computer does not have {entry.title}, so {agent.name} cannot start.')
        # One start at a time, so that two requests cannot start two harnesses for one agent.
        async with self._adding:
            loop = self._loops.get(agent_id)
            if not before(lab.board, agent_id).stopped or (loop and not loop.done()):
                raise SetupRejected(f'Verifold did not stop {agent.name}, so it needs no new start.')
            await self._run_agent(lab, agent, under_way=True)

    async def add_seat(self, seat: AddSeat, first: tuple[Build, ...], asked_by: AgentId) -> None:
        """
        Add the one agent of a seat that the coordinator's move describes, and start it.

        The seat gives a harness, a model, an effort, and whether the agent is on call. Everything else is as in a
        seat that the person adds with no facts: the family of the harness, the lab's auto mode, no coordinator
        mark, and no power. A role of the seat is recorded as given by `asked_by`, the coordinator that asked.
        The record takes `first` in the same step as the agent, before it.
        """
        self.check_seat(seat)
        choice = AgentChoice(harness=seat.harness, model=seat.model, effort=seat.effort, on_call=seat.on_call)
        await self.add_agents(choice, first, given=(seat.role, asked_by) if seat.role else None, asked=True)

    def check_seat(self, seat: AddSeat) -> None:
        """
        Check that this computer has the harness of a seat that a coordinator's move names.

        The board calls it when the coordinator asks, so a request for a harness that cannot start never waits for
        the person.

        Raises:
            SetupRejected: The harness is not in the catalog, or this computer does not have it.

        """
        entry = self._catalog.get(seat.harness)
        if entry is None or not available(entry):
            raise SetupRejected(
                f'This computer has no harness with the key `{seat.harness}`. It has: '
                f'{", ".join(name for name, known in self._catalog.items() if available(known))}.'
            )

    async def add_agents(
        self,
        choice: AgentChoice,
        first: tuple[Build, ...] = (),
        given: tuple[str, AgentId] | None = None,
        *,
        asked: bool = False,
    ) -> None:
        """
        Add agents of one harness to the lab that runs, and start them.

        With `asked`, the seat comes from a coordinator's move, so its model's ID is an agent's text: the agent's
        name holds the model's name only when the harness lists the model.

        `first` are events that the record takes in the same step as the first agent, before it: the yes to the
        coordinator's request that asked for the agent. `given` is a role that the coordinator gives the seat.

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
            members = _members(lab.board)
            if members + choice.count > MAX_AGENTS:
                raise SetupRejected(f'A lab has at most {MAX_AGENTS} agents, and this one has {members}.')
            for _ in range(choice.count):
                number = _free_number(lab.board)
                # The folder comes first. An agent that the record holds and that has no folder could never start.
                try:
                    await agent_folder(self._project, f'agent-{number}')
                except (GitError, OSError) as error:
                    raise SetupRejected(f"Can't make the folder of agent-{number}: {error}") from error
                agent = await self._join(
                    lab, number, choice, auto_mode=lab.board.opened.auto_mode, first=first, given=given, asked=asked
                )
                first = ()
                await self._run_agent(lab, agent, under_way=True)

    async def change_seat(self, agent_id: AgentId, change: SeatChange) -> None:
        """
        Change an agent's seat as the person says: on call or not, the coordinator seat, and a reviewer seat.

        An on-call agent that never worked starts when its seat comes off call.

        Raises:
            NoLab: The folder has no lab.
            NotFound: The lab has no agent with that ID.
            RejectedEvent: The agent left the lab or is a blind checker.

        """
        lab = self._running()
        if lab.board.agent(agent_id) is None:
            raise NotFound(f'The lab has no agent with the ID {agent_id}.')
        if change.on_call is not None:
            await lab.set_on_call(agent_id, on_call=change.on_call)
        if change.coordinator:
            await lab.set_coordinator(agent_id, PERSON)
        elif change.coordinator is False and lab.board.coordinator == agent_id:
            await lab.set_coordinator(None, PERSON)
        if change.reviewer is not None:
            await lab.set_reviewer(agent_id, PERSON, reviewer=change.reviewer)

    async def invite(self, request: InviteRequest | None = None) -> Invitation:
        """
        Add an agent that runs by itself to the lab that runs, and return its invitation, which holds its token.

        Verifold starts nothing for it. The agent joins when its own harness connects to the board with the token,
        and it uses the board's `wait` tool to hear the lab. The token is in the invitation and nowhere else:
        Verifold keeps a digest of it, so the invitation still works after a restart.

        Raises:
            NoLab: The folder has no lab.
            SetupRejected: The lab would have more than `MAX_AGENTS` agents, the name is taken or reads like
                another member's, or Verifold can't make the agent's folder or keep its token's digest.

        """
        lab = self._running()
        request = request or InviteRequest()
        name = request.name
        # One at a time, with the adds, so that two requests cannot pass the limit or take the same number.
        async with self._adding:
            members = _members(lab.board)
            if members >= MAX_AGENTS:
                raise SetupRejected(f'A lab has at most {MAX_AGENTS} agents, and this one has {members}.')
            number = _free_number(lab.board)
            default = f'Agent {number}'
            if name and name != default and _name_taken(lab.board, name):
                raise SetupRejected(
                    f'The name {name} is taken, or it reads like the name of another member of the lab. Choose '
                    'another name.'
                )
            agent = Agent(
                id=f'agent-{number}',
                name=name or default,
                harness=GUEST,
                model=ModelSpec(family=request.family or UNKNOWN_FAMILY),
                given_role=request.role,
            )
            return await self._invitation(lab, agent, joins=request)

    async def invite_again(self, agent_id: AgentId) -> Invitation:
        """
        Give an invited agent a new token, and return its new invitation. Its earlier token is void from now on.

        The person uses it when the invitation is lost, when its token leaked, or when Verifold holds no digest
        for the agent.

        Raises:
            NoLab: The folder has no lab.
            NotFound: The lab has no invited agent with that ID.
            SetupRejected: The agent left the lab, or Verifold can't keep the new token's digest.

        """
        lab = self._running()
        joined = lab.board.agent(agent_id)
        if joined is None or joined.agent.harness != GUEST:
            raise NotFound(f'The lab has no invited agent with the ID {agent_id}.')
        if lab.board.gone(agent_id):
            raise SetupRejected(f'{joined.agent.name} left the lab, and an agent that left does not come back.')
        async with self._adding:
            return await self._invitation(lab, joined.agent)

    def _running(self) -> Lab:
        if self._lab is None or self._settings is None:
            raise NoLab('This folder has no lab yet. Start one from the setup screen.')
        return self._lab

    async def _invitation(self, lab: Lab, agent: Agent, joins: InviteRequest | None = None) -> Invitation:
        # With `joins`, the agent is new, and it joins the record with the facts that the person gave its seat.
        url = self._settings.mcp_url if self._settings else ''
        token = secrets.token_urlsafe(32)
        digest = token_digest(token)
        # The folder and the digest come first. An agent that the record holds and that has neither could never
        # join. A digest without an agent opens nothing, and the next invitation replaces it.
        try:
            folder = await agent_folder(self._project, agent.id)
            keep_guest(self._guests_file, agent.id, digest, urlsplit(url).port)
        except (GitError, OSError, GuestsInvalid) as error:
            raise SetupRejected(f"Can't invite {agent.name}: {error}") from error
        if joins:
            await lab.join(agent, on_call=joins.on_call, coordinator=joins.coordinator, powers=joins.powers)
        await self._seat_guest(lab, agent, digest)
        start = self._start_message(lab, agent, under_way=True)
        return Invitation(agent=agent.id, name=agent.name, text=invitation(start, url, token, folder))

    @property
    def _guests_file(self) -> Path:
        return self._project / LAB_FOLDER / GUESTS_FILE

    async def _seat_guest(self, lab: Lab, agent: Agent, digest: str | None) -> None:
        board = lab.board
        if digest is None:
            # Verifold holds no digest, such as after the person removed the file. Only a new invitation helps.
            await self._activity.invite(agent.id, 'void')
            return
        # The agent has read the board up to its own last post, or up to its join when it has none. So a seat that
        # a restart or a new invitation makes still brings what came since.
        own = any(entry.post.author == agent.id for entry in board.posts)
        folder = await agent_folder(self._project, agent.id)
        member = Member(
            lab,
            agent.id,
            pin=partial(pin, folder, agent.id),
            seen=before(board, agent.id).seen,
            copies=self._copies,
            adds=self.add_seat,
            seat_ok=self.check_seat,
        )
        self._members.add_guest(member, digest)
        # A `brief` leaves no mark on the record, so an agent that only read the board shows as invited again.
        called = own or any(
            (
                any(watch.agent == agent.id for watch in board.watches),
                any(rerun.by == agent.id for rerun in board.reruns),
                any(take.agent == agent.id for take in board.takes),
                any(profile.agent == agent.id for profile in board.profiles),
                any(entry.by == agent.id for entry in board.coordinators),
            )
        )
        await self._activity.invite(agent.id, 'here' if called else 'invited')

    def _shared(self) -> Shared:
        return Shared(activity=self._activity, refusals=self._refusals)

    async def _seat(self, lab: Lab, agent: Agent, start: str) -> tuple[Member, AgentSetup]:
        folder = await agent_folder(self._project, agent.id)
        # The seat starts at what the record says that the agent had seen. So after a restart, the posts for the
        # agent that came since reach it by the usual rules.
        member = Member(
            lab,
            agent.id,
            pin=partial(pin, folder, agent.id),
            seen=before(lab.board, agent.id).seen,
            copies=self._copies,
            adds=self.add_seat,
            seat_ok=self.check_seat,
        )
        setup = AgentSetup(
            agent=agent,
            harness=self._catalog[agent.harness],
            lab=self._project,
            folder=folder,
            log=self._project / LAB_FOLDER / 'logs' / f'{agent.id}.log',
            token=self._members.add(member),
            options=_options(agent, self._catalog[agent.harness], auto_mode=lab.board.opened.auto_mode),
            start=start,
        )
        return member, setup


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
        http = join_server(members.resolve, activity.call).streamable_http_app(host='127.0.0.1')
        http.mount('/api', app_api(host, activity, person_token))
        http.mount('/', web_app(options.web))
        # An invitation names the board's address. So a lab with invited agents takes its last port again when it can.
        kept = _kept(project / LAB_FOLDER / GUESTS_FILE).port
        port = options.port or (kept if kept and _is_free(kept) else 0)
        server = WebServer(
            uvicorn.Config(http, host='127.0.0.1', port=port, log_level='warning', timeout_graceful_shutdown=5)
        )
        serving = asyncio.create_task(server.serve())
        try:
            port = await _bound_port(server)
            settings = LoopSettings(
                mcp_url=f'http://127.0.0.1:{port}/mcp',
                turn_timeout=options.turn_timeout,
                quiet=options.quiet,
                max_quiet=options.max_quiet,
            )
            async with asyncio.TaskGroup() as group:
                host.attach(group, settings, hooks.swept, desktop=options.desktop)
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


def _kept(path: Path) -> Guests:
    # What the guests file holds. A file that is not valid holds nothing for this run, so its invitations are void
    # until the person invites the agents again. The file stays as it is.
    try:
        return read_guests(path)
    except GuestsInvalid:
        return Guests()


NO_HARNESS = 'Its harness is not on this computer.'
"""What the app shows for an agent whose harness this computer lacks, so that Verifold cannot start it."""

RESERVED_NAMES = frozenset({'agent', 'checker', 'blind rerun', 'independent rerun', 'you', PERSON})
"""The names that the app and the board use for something else."""
NUMBERED_NAME = re.compile(r'(agent|checker)[ -]?\d+')
"""The form of the names and IDs that Verifold gives, such as "Agent 3", "agent-3", and "Checker 12"."""


def _name_taken(board: Board, name: str) -> bool:
    # A name in the text of a post reaches its agent, so a name must not read as another agent's name or ID, as
    # one that Verifold gives later, or as the person.
    folded = name.casefold()
    used = {text.casefold() for text in (*_names(board), *(joined.agent.id for joined in board.agents))}
    return folded in used | RESERVED_NAMES or bool(NUMBERED_NAME.fullmatch(folded))


def _members(board: Board) -> int:
    # How many agents the lab has now, for the limit. A blind checker is none, and an agent that left frees its place.
    return sum(not joined.agent.checks and not board.gone(joined.agent.id) for joined in board.agents)


def _free_number(board: Board) -> int:
    # The next agent's number: one whose ID no agent has yet. Only Verifold gives a name such as "Agent 3", and only
    # to `agent-3`, so the name is free too. An agent that left keeps its ID and its name, so no number comes back.
    number = 1 + sum(not joined.agent.checks for joined in board.agents)
    while board.agent(f'agent-{number}'):
        number += 1
    return number


def _is_free(port: int) -> bool:
    # Whether this process can listen on the port now.
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            return False
    return True


def _agent(  # noqa: PLR0913
    number: int,
    harness: HarnessEntry,
    choice: AgentChoice,
    offer: Offer | None,
    taken: tuple[str, ...],
    *,
    auto_mode: bool,
    asked: bool = False,
) -> Agent:
    # The agent's record keeps the harness's auto mode of today, so a later change of the catalog leaves this lab
    # as it is. With `asked`, a coordinator's move named the seat. Its model's ID is then an agent's text, so the
    # name holds the harness's own name for the model when the harness lists it, and "model not listed" when it
    # does not, until the harness reports its model.
    shown = _model_name(offer, choice.model)
    listed = not asked or choice.model is None or _lists(offer, choice.model)
    return Agent(
        auto_mode=harness.auto_mode if auto_mode else None,
        id=f'agent-{number}',
        name=label(harness.title, shown if listed else NOT_LISTED, taken),
        harness=harness.name,
        model=ModelSpec(family=choice.family or harness.family, name=choice.model, effort=choice.effort),
        mode=choice.mode,
        given_role=choice.role,
        model_listed=listed,
    )


def _lists(offer: Offer | None, model: str) -> bool:
    # Whether the harness told Verifold that it offers a model.
    return offer is not None and any(entry.value == model for entry in offer.models)


def _model_name(offer: Offer | None, model: str | None) -> str | None:
    # The name that the harness shows for a seat's model. A model that the harness did not list keeps its ID. The
    # harness's default model has a name only when the harness said which model that is.
    value = model or (offer.model if offer else None)
    listed = next((entry.name for entry in offer.models if entry.value == value), None) if offer else None
    return listed or model


def _names(board: Board) -> tuple[str, ...]:
    # Every name that an agent of the lab has or had, so that a new name matches none of them.
    return tuple(name for _, name in board.names())


def _options(agent: Agent, harness: HarnessEntry, *, auto_mode: bool) -> SessionOptions:
    """
    Return what Verifold sets in the agent's harness session.

    The person's own mode for the agent wins. In a lab in auto mode, the agent runs in the auto mode that its
    record holds. A record from before Verifold kept it goes on with the auto mode that Verifold set then.
    """
    kept = agent.auto_mode or harness.auto_mode_before
    mode = agent.mode or (kept if auto_mode else None)
    return SessionOptions(model=agent.model.name, effort=agent.model.effort, mode=mode, auto_mode=auto_mode)


def _written(value: int | str | SetupDefaults | None) -> JsonValue:
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
