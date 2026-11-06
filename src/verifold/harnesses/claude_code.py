"""Claude Code, started with `claude -p` for each turn and resumed by session ID."""

from typing import Literal, override

from pydantic import ConfigDict, SecretStr, ValidationError
from pydantic.alias_generators import to_camel

from verifold.harnesses.base import ConfigFile, Harness, Invocation, Turn, TurnReport, Usage, Wire

CREDENTIAL_PATHS = (
    '~/.ssh',
    '~/.aws/credentials',
    '~/.config/gh',
    '~/.git-credentials',
    '~/.netrc',
    '~/.claude/.credentials.json',
    '~/.codex/auth.json',
    '~/.runpod',
    '~/Library/Keychains',
)
"""Paths that neither shell commands nor the Read tool may open."""


class _Settings(Wire):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)


class _Filesystem(_Settings):
    deny_read: tuple[str, ...]


class _Network(_Settings):
    allowed_domains: tuple[str, ...]


class _Sandbox(_Settings):
    enabled: bool = True
    auto_allow_bash_if_sandboxed: bool = True
    fail_if_unavailable: bool = True
    allow_unsandboxed_commands: bool = False
    filesystem: _Filesystem
    network: _Network


class _Permissions(_Settings):
    allow: tuple[str, ...]
    deny: tuple[str, ...]


class _SessionSettings(_Settings):
    sandbox: _Sandbox
    permissions: _Permissions


class _McpServer(_Settings):
    type: Literal['http'] = 'http'
    url: str
    headers: dict[str, str]


class _McpConfig(_Settings):
    mcp_servers: dict[str, _McpServer]


class _Usage(Wire):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


class _Event(Wire):
    type: str
    subtype: str | None = None
    session_id: str | None = None
    result: str | None = None
    is_error: bool = False
    total_cost_usd: float | None = None
    usage: _Usage | None = None


class ClaudeCode(Harness):
    """
    Claude Code in print mode, one process for each turn.

    Shell commands run in Claude Code's sandbox, which allows writes only in the agent's folder and reaches only the
    turn's network domains. File tools edit only the agent's folder. `dontAsk` denies every other action without a
    prompt. The agent loads only Verifold's MCP server, never the person's own.
    """

    name = 'claude-code'
    family = 'anthropic'

    def __init__(self, executable: str = 'claude') -> None:
        """Use the `claude` executable on the PATH, or another one."""
        self._executable = executable

    @override
    def invocation(self, turn: Turn) -> Invocation:
        settings = turn.private / 'claude-settings.json'
        mcp = turn.private / 'claude-mcp.json'
        return Invocation(
            argv=(
                self._executable,
                '-p',
                turn.prompt,
                '--output-format',
                'stream-json',
                '--verbose',
                '--permission-mode',
                'dontAsk',
                '--settings',
                str(settings),
                '--strict-mcp-config',
                '--mcp-config',
                str(mcp),
                *(('--model', turn.model) if turn.model else ()),
                *(('--resume', turn.session) if turn.session else ()),
            ),
            files=(
                ConfigFile(path=settings, content=SecretStr(_settings(turn).model_dump_json(by_alias=True))),
                ConfigFile(path=mcp, content=SecretStr(_mcp(turn).model_dump_json(by_alias=True))),
            ),
        )

    @override
    def read(self, report: TurnReport, line: bytes) -> TurnReport:
        try:
            event = _Event.model_validate_json(line)
        except ValidationError:
            return report
        if event.type != 'result':
            return report.model_copy(update={'session': event.session_id or report.session})
        usage = event.usage or _Usage()
        cached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        return report.model_copy(
            update={
                'session': event.session_id or report.session,
                'final_text': event.result or '',
                'cost_usd': event.total_cost_usd,
                'usage': Usage(
                    input_tokens=usage.input_tokens + cached,
                    cached_input_tokens=usage.cache_read_input_tokens,
                    output_tokens=usage.output_tokens,
                ),
                'error': (event.result or event.subtype or 'Claude Code reported an error.')
                if event.is_error
                else None,
            }
        )


def _settings(turn: Turn) -> _SessionSettings:
    # A rule path that starts with `//` is absolute. The sandbox covers shell commands, and these rules cover Read.
    reads = tuple(f'Read(/{path})' if path.startswith('/') else f'Read({path})' for path in CREDENTIAL_PATHS)
    return _SessionSettings(
        sandbox=_Sandbox(
            filesystem=_Filesystem(deny_read=CREDENTIAL_PATHS), network=_Network(allowed_domains=turn.network)
        ),
        permissions=_Permissions(
            allow=('Edit(./**)', 'Write(./**)', 'WebSearch', 'WebFetch', 'mcp__verifold'),
            deny=reads + tuple(f'{rule[:-1]}/**)' for rule in reads),
        ),
    )


def _mcp(turn: Turn) -> _McpConfig:
    headers = {'Authorization': f'Bearer {turn.token.get_secret_value()}'}
    return _McpConfig(mcp_servers={'verifold': _McpServer(url=turn.mcp_url, headers=headers)})
