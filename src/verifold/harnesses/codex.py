"""OpenAI Codex, started with `codex exec` for each turn and resumed by thread ID."""

import json
from typing import override

from pydantic import SecretStr, ValidationError

from verifold.harnesses.base import Harness, Invocation, Turn, TurnReport, Wire
from verifold.protocol.usage import Usage

TOKEN_VARIABLE = 'VERIFOLD_TOKEN'
"""The environment variable that holds the agent's token. Codex reads it, so the token stays off the command line."""


class _Usage(Wire):
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0


class _Item(Wire):
    type: str
    text: str | None = None


class _Error(Wire):
    message: str


class _Event(Wire):
    type: str
    thread_id: str | None = None
    usage: _Usage | None = None
    item: _Item | None = None
    error: _Error | None = None
    message: str | None = None


class Codex(Harness):
    """
    Codex in exec mode, one process for each turn.

    The `-c` options come before `exec`: placed after it, Codex dropped the permission settings in an earlier probe.
    Shell commands run in Codex's workspace-write sandbox, and Codex asks for no approvals. The sandbox has network or
    none, so any network domain on the turn turns network on.
    """

    name = 'codex'
    family = 'openai'

    def __init__(self, executable: str = 'codex') -> None:
        """Use the `codex` executable on the PATH, or another one."""
        self._executable = executable

    @override
    def invocation(self, turn: Turn) -> Invocation:
        config = (
            'approval_policy="never"',
            'sandbox_mode="workspace-write"',
            f'sandbox_workspace_write.network_access={json.dumps(bool(turn.network))}',
            'web_search="live"',
            f'mcp_servers.verifold.url={json.dumps(turn.mcp_url)}',
            f'mcp_servers.verifold.bearer_token_env_var="{TOKEN_VARIABLE}"',
            'mcp_servers.verifold.tool_timeout_sec=120',
            *((f'model={json.dumps(turn.model)}',) if turn.model else ()),
        )
        return Invocation(
            argv=(
                self._executable,
                *(argument for option in config for argument in ('-c', option)),
                'exec',
                '--json',
                *(('resume', turn.session) if turn.session else ()),
                turn.prompt,
            ),
            env=((TOKEN_VARIABLE, SecretStr(turn.token.get_secret_value())),),
        )

    @override
    def read(self, report: TurnReport, line: bytes) -> TurnReport:
        try:
            event = _Event.model_validate_json(line)
        except ValidationError:
            return report
        match event:
            case _Event(type='thread.started', thread_id=str(thread_id)):
                return report.model_copy(update={'session': thread_id})
            case _Event(type='turn.completed', usage=_Usage() as usage):
                return report.model_copy(
                    update={
                        'usage': Usage(
                            input_tokens=report.usage.input_tokens + usage.input_tokens,
                            cached_input_tokens=report.usage.cached_input_tokens + usage.cached_input_tokens,
                            output_tokens=report.usage.output_tokens + usage.output_tokens,
                        )
                    }
                )
            case _Event(type='item.completed', item=_Item(type='agent_message', text=str(text))):
                return report.model_copy(update={'final_text': text})
            case _Event(type='turn.failed', error=_Error(message=message)) | _Event(type='error', message=str(message)):
                return report.model_copy(update={'error': message})
        return report
