"""One agent's ACP session: its harness process, the board attached as its MCP server, and the messages sent to it."""

from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from typing import NoReturn, Self, override

import acp
from acp import schema
from acp.client.connection import ClientSideConnection
from pydantic import SecretStr

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.record import Record
from verifold.protocol.usage import Usage
from verifold.runner.environment import clean_environment


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

type Permissions = Callable[[PermissionRequest], Awaitable[str | None]]
"""Decides a permission request: the ID of the chosen answer, or `None` to cancel the action."""


class Board(Record):
    """Where the agent's harness reaches the lab's board, and the agent's token."""

    url: str
    token: SecretStr


class SessionOptions(Record):
    """What Verifold changes from the person's own harness settings. `None` keeps the person's setting."""

    model: str | None = None
    effort: str | None = None
    auto_mode: bool = False
    resume: str | None = None
    """A session ID to load, so the agent keeps its conversation."""


class TurnResult(Record):
    """What a harness reported about one message: why it stopped, the tokens, and the cost, when it reports one."""

    stop_reason: str
    usage: Usage
    cost_usd: float | None = None


class _Client(acp.Client):
    """
    The client side of the ACP connection: permission requests and the running cost.

    Verifold offers no file or terminal methods, so it keeps the protocol's defaults for them.
    """

    def __init__(self, permissions: Permissions) -> None:
        self._permissions = permissions
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
        chosen = await self._permissions(request)
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

    # Verifold offers no files, terminals, or forms. The agent learns that from the capabilities in `initialize`.
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
        cls, harness: HarnessEntry, folder: Path, board: Board, options: SessionOptions, permissions: Permissions
    ) -> AsyncGenerator[Self]:
        """
        Start the harness's ACP agent in `folder`, with the board as its MCP server, and open or load a session.

        The harness starts with the person's own settings and environment. Verifold sets only the options in
        `options`, through the generic ACP calls.
        """
        client = _Client(permissions)
        async with acp.spawn_agent_process(client, *harness.command, env=clean_environment(), cwd=folder) as (
            connection,
            _,
        ):
            await connection.initialize(
                protocol_version=acp.PROTOCOL_VERSION,
                client_capabilities=schema.ClientCapabilities(
                    fs=schema.FileSystemCapabilities(read_text_file=False, write_text_file=False), terminal=False
                ),
                client_info=schema.Implementation(name='verifold', version=version('verifold')),
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
                await connection.load_session(cwd=str(folder), session_id=options.resume, mcp_servers=servers)
                session_id = options.resume
            else:
                session_id = (await connection.new_session(cwd=str(folder), mcp_servers=servers)).session_id
            if options.auto_mode and harness.auto_mode:
                await connection.set_session_mode(session_id=session_id, mode_id=harness.auto_mode)
            for option_id, value in ((harness.model_option, options.model), (harness.effort_option, options.effort)):
                if option_id and value:
                    await connection.set_config_option(session_id=session_id, config_id=option_id, value=value)
            yield cls(connection, session_id, client)

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
