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
from pydantic import SecretStr

from verifold import DISTRIBUTION
from verifold.harnesses.catalog import HarnessEntry
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
    choices: tuple[PermissionChoice, ...]


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

    def __init__(self, hooks: SessionHooks) -> None:
        self._hooks = hooks
        self.cost: float | None = None

    @override
    async def request_permission(
        self, session_id: str, tool_call: schema.ToolCallUpdate, options: list[schema.PermissionOption], **_: object
    ) -> schema.RequestPermissionResponse:
        request = PermissionRequest(
            title=tool_call.title or 'an action',
            choices=tuple(
                PermissionChoice(id=option.option_id, name=option.name, kind=option.kind) for option in options
            ),
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
        if isinstance(update, schema.ToolCallStart) and update.title:
            await self._hooks.step(update.title)

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


def _unsupported(method: str) -> NoReturn:
    raise acp.RequestError.method_not_found(method)


async def _begin(
    connection: ClientSideConnection, harness: HarnessEntry, folder: Path, board: BoardAccess, options: SessionOptions
) -> str:
    """Initialize the connection, open or load the session, and set the options that the lab asks for."""
    await connection.initialize(
        protocol_version=acp.PROTOCOL_VERSION,
        client_capabilities=schema.ClientCapabilities(
            fs=schema.FileSystemCapabilities(read_text_file=False, write_text_file=False), terminal=False
        ),
        client_info=schema.Implementation(name='verifold', version=version(DISTRIBUTION)),
    )
    servers: McpServers = [
        schema.HttpMcpServer(
            type='http',
            name='verifold',
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
    if options.auto_mode and harness.auto_mode:
        await connection.set_session_mode(session_id=session_id, mode_id=harness.auto_mode)
    for category, value in (('model', options.model), ('thought_level', options.effort)):
        if value:
            option = _option_id(offered or [], category, harness)
            await connection.set_config_option(session_id=session_id, config_id=option, value=value)
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
        client = _Client(hooks)
        place.log.parent.mkdir(parents=True, exist_ok=True)
        with place.log.open('ab') as errors:
            process = await start(harness.command, place.folder, errors, harness_environment(place.lab, place.agent))
            if process.stdin is None or process.stdout is None:
                await stop(process)
                raise RunnerError(f'{harness.name} started without its protocol pipes.')
            connection = acp.connect_to_agent(client, process.stdin, process.stdout)
            try:
                session_id = await _begin(connection, harness, place.folder, board, options)
                yield cls(connection, session_id, client)
            finally:
                # Stop the harness first: the connection's reader waits for output that only ends with the process.
                await stop(process)
                with suppress(TimeoutError):
                    async with asyncio.timeout(STOP_GRACE):
                        await connection.close()

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
