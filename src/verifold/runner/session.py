"""One agent's ACP session: its harness process, the board attached as its MCP server, and the messages sent to it."""

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import NoReturn, Self, override

import acp
from acp import schema
from acp.client.connection import ClientSideConnection
from pydantic import SecretStr, ValidationError

from verifold import DISTRIBUTION
from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.app import ModelValue, Offer, OptionValue
from verifold.protocol.ids import AgentId
from verifold.protocol.record import Record
from verifold.protocol.usage import Usage
from verifold.runner.environment import harness_environment
from verifold.runner.errors import RunnerError
from verifold.runner.processes import STOP_GRACE, start, stop


class PermissionChoice(Record):
    """One answer that a harness offers to a permission request."""

    id: str
    name: str
    kind: str
    """`allow_once`, `allow_always`, `reject_once`, or `reject_always`."""


class PermissionRequest(Record):
    """A harness asks to run an action that its permission settings do not allow on their own."""

    title: str
    """What the person reads: the command, or else the harness's name for the action."""
    choices: tuple[PermissionChoice, ...]
    command: str | None = None
    """The shell command that the action runs, when the harness reports one."""
    board: bool = False
    """Whether the action is a call to the lab's board, which Verifold itself gave the harness."""


BOARD_SERVER = 'verifold'
"""The name under which a harness gets the lab's board as an MCP server."""

_ENDED = frozenset({'completed', 'failed'})


type McpServers = list[schema.HttpMcpServer | schema.SseMcpServer | schema.AcpMcpServer | schema.McpServerStdio]
type ConfigOption = schema.SessionConfigOptionSelect | schema.SessionConfigOptionBoolean

type Permissions = Callable[[PermissionRequest], Awaitable[str | None]]
"""Decides a permission request: the ID of the chosen answer, or `None` to cancel the action."""


async def _ignore(_: str) -> None:
    return None


@dataclass(frozen=True, slots=True)
class SessionHooks:
    """What the runner hears from a session: permission requests to decide, and each step that the harness starts."""

    permissions: Permissions
    step: Callable[[str], Awaitable[None]] = _ignore
    """Gets the title of each tool call that the harness starts."""


class BoardAccess(Record):
    """Where the agent's harness reaches the lab's board, and the agent's token."""

    url: str
    token: SecretStr


class Place(Record):
    """Where an agent's harness runs, where its error output goes, and the lab and agent that mark its processes."""

    folder: Path
    log: Path
    lab: Path
    agent: AgentId


class SessionOptions(Record):
    """What Verifold changes from the person's own harness settings. `None` keeps the person's setting."""

    model: str | None = None
    effort: str | None = None
    mode: str | None = None
    """One of the harness's own modes. It wins over `auto_mode`."""
    auto_mode: bool = False
    resume: str | None = None
    """A session ID to load, so the agent keeps its conversation."""


class TurnResult(Record):
    """What a harness reported for one message: why it stopped, the tokens, and the cost if it reports one."""

    stop_reason: str
    usage: Usage
    cost_usd: float | None = None


class _Client(acp.Client):
    """
    The client side of the ACP connection. It decides permission requests and tracks the running cost.

    Verifold offers no files, terminals, or forms. The agent learns that from the capabilities in `initialize`, and a
    call to one of them gets a "method not found" error.
    """

    def __init__(self, hooks: SessionHooks, *, names_mcp_server: bool = False) -> None:
        self._hooks = hooks
        self._names_mcp_server = names_mcp_server
        self.cost: float | None = None
        self._calls: dict[str, _Call] = {}
        """Each tool call that runs now. A permission request can name its call by ID only."""

    @override
    async def request_permission(
        self, session_id: str, tool_call: schema.ToolCallUpdate, options: list[schema.PermissionOption], **_: object
    ) -> schema.RequestPermissionResponse:
        call = self._calls.get(tool_call.tool_call_id, _Call()).updated(tool_call)
        # Only a call that runs a command has one. Another tool's `command` field is not a shell command.
        command = _field(call.given, 'command') if call.kind == 'execute' else None
        named = _field(call.given, 'server') == BOARD_SERVER and _field(call.given, 'tool') is not None
        request = PermissionRequest(
            title=command or tool_call.title or call.title or 'an action',
            choices=tuple(
                PermissionChoice(id=option.option_id, name=option.name, kind=option.kind) for option in options
            ),
            command=command,
            # A shell command is never a call to the board, whatever its text says.
            board=self._names_mcp_server and command is None and named,
        )
        chosen = await self._hooks.permissions(request)
        outcome = (
            schema.AllowedOutcome(option_id=chosen, outcome='selected')
            if chosen
            else schema.DeniedOutcome(outcome='cancelled')
        )
        return schema.RequestPermissionResponse(outcome=outcome)

    @override
    async def session_update(self, session_id: str, update: object, **_: object) -> None:
        if isinstance(update, schema.UsageUpdate) and update.cost:
            self.cost = update.cost.amount
        if isinstance(update, schema.ToolCallStart):
            self._calls[update.tool_call_id] = _Call().updated(update)
            if update.title:
                await self._hooks.step(update.title)
        if isinstance(update, schema.ToolCallProgress):
            # A harness can fill in a call's input after its start.
            call = self._calls.pop(update.tool_call_id, _Call())
            if update.status not in _ENDED:
                self._calls[update.tool_call_id] = call.updated(update)

    @override
    async def write_text_file(self, session_id: str, path: str, content: str, **_: object) -> None:
        _unsupported('fs/write_text_file')

    @override
    async def read_text_file(
        self, session_id: str, path: str, line: int | None = None, limit: int | None = None, **_: object
    ) -> schema.ReadTextFileResponse:
        _unsupported('fs/read_text_file')

    @override
    async def create_terminal(
        self,
        session_id: str,
        command: str,
        args: list[str] | None = None,
        env: list[schema.EnvVariable] | None = None,
        cwd: str | None = None,
        output_byte_limit: int | None = None,
        **_: object,
    ) -> schema.CreateTerminalResponse:
        _unsupported('terminal/create')

    @override
    async def terminal_output(self, session_id: str, terminal_id: str, **_: object) -> schema.TerminalOutputResponse:
        _unsupported('terminal/output')

    @override
    async def release_terminal(self, session_id: str, terminal_id: str, **_: object) -> None:
        _unsupported('terminal/release')

    @override
    async def wait_for_terminal_exit(
        self, session_id: str, terminal_id: str, **_: object
    ) -> schema.WaitForTerminalExitResponse:
        _unsupported('terminal/wait_for_exit')

    @override
    async def kill_terminal(self, session_id: str, terminal_id: str, **_: object) -> None:
        _unsupported('terminal/kill')

    @override
    async def create_elicitation(
        self, message: str, mode: schema.ElicitationMode, **_: object
    ) -> schema.CreateElicitationResponse:
        _unsupported('elicitation/create')

    @override
    async def complete_elicitation(self, elicitation_id: str, **_: object) -> None:
        _unsupported('elicitation/complete')

    @override
    async def ext_method(self, method: str, params: dict[str, object]) -> dict[str, object]:
        _unsupported(method)

    @override
    async def ext_notification(self, method: str, params: dict[str, object]) -> None:
        """Ignore notifications that only one harness sends, such as its sign-in status."""

    @override
    def on_connect(self, conn: acp.Agent) -> None:
        """Keep nothing from the connection: Verifold calls the agent through `AgentSession`."""


@dataclass(frozen=True, slots=True)
class _Call:
    """What a harness said about one tool call so far."""

    title: str | None = None
    kind: str | None = None
    given: object = None
    """The call's input, in the harness's own shape."""

    def updated(self, said: schema.ToolCall | schema.ToolCallUpdate) -> '_Call':
        """Return the call with what `said` adds. A part that `said` leaves out stays."""
        return _Call(
            title=said.title or self.title,
            kind=said.kind or self.kind,
            given=self.given if said.raw_input is None else said.raw_input,
        )


def _field(given: object, name: str) -> str | None:
    # A harness reports a tool call's input as it likes. Verifold reads a field only when it is text.
    value = given.get(name) if isinstance(given, dict) else None
    return value.strip() or None if isinstance(value, str) else None


def _unsupported(method: str) -> NoReturn:
    raise acp.RequestError.method_not_found(method)


async def offer_of(harness: HarnessEntry, place: Place, timeout: float) -> Offer:
    """
    Open a session of the harness without a prompt, and return the models, effort levels, and modes that it offers.

    The session gets no board and no message. It switches to each model, because a model can have its own effort
    levels, and then back to the person's model. ACP keeps a switch in the session. A model that the harness refuses
    to switch to is left out, because a lab couldn't use it either. `timeout` limits the talk with the harness: when it
    ends during the switches, the models that are left have unknown effort levels. Verifold stops the harness before
    this returns, also after a failure.

    Raises:
        TimeoutError: The harness didn't open a session within `timeout` seconds.

    """
    deadline = asyncio.get_running_loop().time() + timeout
    async with _connected(harness, place, _Client(SessionHooks(permissions=_refuse))) as connection:
        async with asyncio.timeout_at(deadline):
            await _initialize(connection)
            opened = await connection.new_session(cwd=str(place.folder), mcp_servers=[])
        return await _offer(connection, opened, deadline)


@asynccontextmanager
async def _connected(harness: HarnessEntry, place: Place, client: _Client) -> AsyncGenerator[ClientSideConnection]:
    """Start the harness's ACP agent in the place's folder, and stop its whole process group when the block ends."""
    place.log.parent.mkdir(parents=True, exist_ok=True)
    with place.log.open('ab') as errors:
        process = await start(harness.command, place.folder, errors, harness_environment(place.lab, place.agent))
        if process.stdin is None or process.stdout is None:
            await stop(process)
            raise RunnerError(f'{harness.name} started without its protocol pipes.')
        connection = acp.connect_to_agent(client, process.stdin, process.stdout)
        try:
            yield connection
        finally:
            # Stop the harness first: the connection's reader waits for output that only ends with the process.
            await stop(process)
            with suppress(TimeoutError):
                async with asyncio.timeout(STOP_GRACE):
                    await connection.close()


async def _initialize(connection: ClientSideConnection) -> None:
    await connection.initialize(
        protocol_version=acp.PROTOCOL_VERSION,
        client_capabilities=schema.ClientCapabilities(
            fs=schema.FileSystemCapabilities(read_text_file=False, write_text_file=False), terminal=False
        ),
        client_info=schema.Implementation(name='verifold', version=version(DISTRIBUTION)),
    )


async def _refuse(_: PermissionRequest) -> str | None:
    # A session without a prompt asks nothing. If it did, the answer is no.
    return None


async def _offer(connection: ClientSideConnection, opened: schema.NewSessionResponse, deadline: float) -> Offer:
    options = _by_category(opened.config_options)
    model, effort, modes = options.get('model'), options.get('thought_level'), opened.modes
    values, efforts = _values(model), _values(effort)
    models: list[ModelValue] = []
    for value in values:
        found: tuple[OptionValue, ...] | None = efforts
        if model is not None and value.value != model.current_value:
            try:
                found = await _efforts_with(connection, opened.session_id, model.id, value.value, deadline)
            except acp.RequestError:
                continue  # The harness refuses the model, so a lab couldn't use it either.
        models.append(ModelValue(value=value.value, name=value.name, efforts=found))
    if model is not None and len(values) > 1 and asyncio.get_running_loop().time() < deadline:
        # A harness that remembers its last model gets the person's own model back.
        with suppress(Exception):
            async with asyncio.timeout_at(deadline):
                await connection.set_config_option(
                    config_id=model.id, session_id=opened.session_id, value=model.current_value
                )
    available = modes.available_modes if modes else []
    return Offer(
        models=tuple(models),
        efforts=efforts,
        modes=tuple(found for mode in available if (found := _option(mode.id, mode.name))),
        model=model.current_value if model else None,
        effort=effort.current_value if effort else None,
        mode=modes.current_mode_id if modes else None,
    )


async def _efforts_with(
    connection: ClientSideConnection, session_id: str, option: str, model: str, deadline: float
) -> tuple[OptionValue, ...] | None:
    """
    Return the effort levels that the harness offers with `model`, or `None` when they are not known.

    They are not known when the time is up, or when the switch fails in another way than a refusal, such as a
    harness that exits.

    Raises:
        acp.RequestError: The harness refuses to switch to `model`.

    """
    if asyncio.get_running_loop().time() >= deadline:
        return None
    try:
        async with asyncio.timeout_at(deadline):
            switched = await connection.set_config_option(config_id=option, session_id=session_id, value=model)
    # The time ran out (a TimeoutError), the harness exited (a ConnectionError), or its answer was not valid ACP.
    except (OSError, ValidationError):
        return None
    if not switched.config_options:
        return None  # An empty answer says nothing about the model, as in a lab's session.
    return _values(_by_category(switched.config_options).get('thought_level'))


def _by_category(offered: Sequence[ConfigOption] | None) -> dict[str, schema.SessionConfigOptionSelect]:
    return {
        option.category: option
        for option in offered or []
        if isinstance(option, schema.SessionConfigOptionSelect) and isinstance(option.category, str)
    }


def _values(option: schema.SessionConfigOptionSelect | None) -> tuple[OptionValue, ...]:
    if option is None:
        return ()
    # A harness can group its values, such as models by provider.
    flat: list[schema.SessionConfigSelectOption] = []
    for entry in option.options:
        flat.extend(entry.options if isinstance(entry, schema.SessionConfigSelectGroup) else [entry])
    return tuple(found for value in flat if (found := _option(value.value, value.name)))


def _option(value: str, name: str) -> OptionValue | None:
    # A value that a lab can't record, such as an empty one, is left out of the offer.
    try:
        return OptionValue(value=value, name=name)
    except ValidationError:
        return None


async def _begin(
    connection: ClientSideConnection, harness: HarnessEntry, folder: Path, board: BoardAccess, options: SessionOptions
) -> str:
    """Initialize the connection, open or load the session, and set the options that the lab asks for."""
    await _initialize(connection)
    servers: McpServers = [
        schema.HttpMcpServer(
            type='http',
            name=BOARD_SERVER,
            url=board.url,
            headers=[schema.HttpHeader(name='Authorization', value=f'Bearer {board.token.get_secret_value()}')],
        )
    ]
    if options.resume:
        loaded = await connection.load_session(cwd=str(folder), session_id=options.resume, mcp_servers=servers)
        session_id, offered = options.resume, loaded.config_options
    else:
        opened = await connection.new_session(cwd=str(folder), mcp_servers=servers)
        session_id, offered = opened.session_id, opened.config_options
    for category, value in (('model', options.model), ('thought_level', options.effort)):
        if value:
            option = _option_id(offered or [], category, harness)
            changed = await connection.set_config_option(session_id=session_id, config_id=option, value=value)
            # A model can have its own effort levels. ACP answers a change with the full set of options, so a later
            # option comes from that answer. An empty answer says nothing, so the options from before stay.
            offered = changed.config_options or offered
    # The mode comes last, so that a switch of model can't change it.
    if mode := options.mode or (harness.auto_mode if options.auto_mode else None):
        await connection.set_session_mode(session_id=session_id, mode_id=mode)
    return session_id


def _option_id(offered: Sequence[ConfigOption], category: str, harness: HarnessEntry) -> str:
    """
    Return the ID of the session option in an ACP category, such as `model`, whatever the harness calls it.

    Raises:
        RunnerError: The harness offers no option in that category, so Verifold can't set what the lab asks for.

    """
    found = next((option.id for option in offered if option.category == category), None)
    if found is None:
        what = {'model': 'model', 'thought_level': 'effort'}[category]
        raise RunnerError(f'{harness.title} offers no {what} option over ACP, so Verifold cannot set the {what}.')
    return found


class AgentSession:
    """A running ACP session. Open it with `AgentSession.open`, which stops the harness when the block ends."""

    def __init__(self, connection: ClientSideConnection, session_id: str, client: _Client) -> None:
        """Wrap a session that is open on `connection`."""
        self._connection = connection
        self.id = session_id
        self._client = client

    @classmethod
    @asynccontextmanager
    async def open(
        cls, harness: HarnessEntry, place: Place, board: BoardAccess, options: SessionOptions, hooks: SessionHooks
    ) -> AsyncGenerator[Self]:
        """
        Start the harness's ACP agent in the agent's folder, with the board as its MCP server, and open a session.

        The harness starts with the person's own settings and environment. Verifold sets only the options in
        `options`, through the generic ACP calls. When the block ends, Verifold stops the harness's whole process
        group.
        """
        client = _Client(hooks, names_mcp_server=harness.names_mcp_server)
        async with _connected(harness, place, client) as connection:
            yield cls(connection, await _begin(connection, harness, place.folder, board, options), client)

    async def send(self, text: str) -> TurnResult:
        """Send one message, and return once the harness ends its turn."""
        cost_before = self._client.cost
        response = await self._connection.prompt(session_id=self.id, prompt=[acp.text_block(text)])
        usage = response.usage
        cached = (usage.cached_read_tokens or 0) if usage else 0
        written = (usage.cached_write_tokens or 0) if usage else 0
        cost = self._client.cost
        return TurnResult(
            stop_reason=response.stop_reason,
            usage=Usage(
                input_tokens=(usage.input_tokens + cached + written) if usage else 0,
                cached_input_tokens=cached,
                output_tokens=usage.output_tokens if usage else 0,
            ),
            cost_usd=None if cost is None else cost - (cost_before or 0),
        )

    async def cancel(self) -> None:
        """Ask the harness to stop its current turn."""
        await self._connection.cancel(session_id=self.id)
