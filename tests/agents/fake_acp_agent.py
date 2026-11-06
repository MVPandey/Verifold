"""
A fake ACP agent for tests. It reaches the lab's board over MCP with its token, the way a real harness does.

The first message makes it post in a new thread. The doorbell makes it read its posts with `wait` and answer each one.
Environment variables change its behavior: `FAKE_ACP_LOG` logs each call, `FAKE_ACP_PERMISSION` asks permission
first, `FAKE_ACP_CRASH` exits during a turn, `FAKE_ACP_SLOW` makes a turn take a minute, and `FAKE_ACP_CHILD` starts a
child that holds the agent's pipes open and writes its process ID to that path.
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import override

import acp
import httpx2
from acp import schema
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from verifold.protocol.join import Update
from verifold.runner.messages import DOORBELL

type Servers = list[schema.HttpMcpServer | schema.SseMcpServer | schema.AcpMcpServer | schema.McpServerStdio]
type Prompt = list[
    schema.TextContentBlock
    | schema.ImageContentBlock
    | schema.AudioContentBlock
    | schema.ResourceContentBlock
    | schema.EmbeddedResourceContentBlock
]


class FakeAgent(acp.Agent):
    def __init__(self) -> None:
        self._client: acp.Client | None = None
        self._url = ''
        self._headers: dict[str, str] = {}
        self._name = ''
        self._cost = 0.0

    def _note(self, **entry: object) -> None:
        if path := os.environ.get('FAKE_ACP_LOG'):
            with Path(path).open('a') as log:
                log.write(json.dumps({'agent': self._name, **entry}) + '\n')

    def _connect(self, cwd: str, servers: Servers | None) -> None:
        server = next(server for server in servers or [] if isinstance(server, schema.HttpMcpServer))
        self._url = server.url
        self._headers = {header.name: header.value for header in server.headers}
        self._name = Path(cwd).name

    async def _call(self, tool: str, arguments: dict[str, object]) -> dict[str, object]:
        async with (
            httpx2.AsyncClient(headers=self._headers) as http,
            Client(streamable_http_client(self._url, http_client=http)) as client,
        ):
            result = await client.call_tool(tool, arguments)
        return result.structured_content or {}

    @override
    def on_connect(self, conn: acp.Client) -> None:
        self._client = conn

    @override
    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: schema.ClientCapabilities | None = None,
        client_info: schema.Implementation | None = None,
        **_: object,
    ) -> schema.InitializeResponse:
        return schema.InitializeResponse(
            protocol_version=protocol_version,
            agent_capabilities=schema.AgentCapabilities(
                load_session=True, mcp_capabilities=schema.McpCapabilities(http=True)
            ),
            agent_info=schema.Implementation(name='fake', version='0'),
        )

    @override
    async def new_session(
        self, cwd: str, additional_directories: list[str] | None = None, mcp_servers: Servers | None = None, **_: object
    ) -> schema.NewSessionResponse:
        self._connect(cwd, mcp_servers)
        self._note(event='new_session')
        return schema.NewSessionResponse(session_id=f'session-{self._name}')

    @override
    async def load_session(
        self,
        cwd: str,
        session_id: str,
        mcp_servers: Servers | None = None,
        additional_directories: list[str] | None = None,
        **_: object,
    ) -> schema.LoadSessionResponse:
        self._connect(cwd, mcp_servers)
        self._note(event='load_session', session=session_id)
        return schema.LoadSessionResponse()

    @override
    async def set_session_mode(self, session_id: str, mode_id: str, **_: object) -> None:
        self._note(event='mode', mode=mode_id)

    @override
    async def set_config_option(
        self, config_id: str, session_id: str, value: str | bool, **_: object
    ) -> schema.SetSessionConfigOptionResponse:
        self._note(event='option', option=config_id, value=value)
        return schema.SetSessionConfigOptionResponse(config_options=[])

    @override
    async def cancel(self, session_id: str, **_: object) -> None:
        self._note(event='cancel')

    @override
    async def prompt(self, session_id: str, prompt: Prompt, **_: object) -> schema.PromptResponse:
        text = prompt[0].text if isinstance(prompt[0], schema.TextContentBlock) else ''
        self._note(event='prompt', text=text)
        if os.environ.get('FAKE_ACP_CRASH'):
            os._exit(3)
        if os.environ.get('FAKE_ACP_SLOW'):
            await asyncio.sleep(60)
        if text == DOORBELL:
            await self._answer_news()
        else:
            await self._say_hello(session_id)
        self._cost += 0.01
        if self._client:
            await self._client.session_update(
                session_id=session_id,
                update=schema.UsageUpdate(
                    session_update='usage_update',
                    used=100,
                    size=1_000,
                    cost=schema.Cost(amount=self._cost, currency='USD'),
                ),
            )
        return schema.PromptResponse(
            stop_reason='end_turn',
            usage=schema.Usage(total_tokens=18, input_tokens=10, output_tokens=5, cached_read_tokens=3),
        )

    async def _say_hello(self, session_id: str) -> None:
        text = f'Hello from {self._name}.'
        if os.environ.get('FAKE_ACP_PERMISSION') and self._client:
            response = await self._client.request_permission(
                session_id=session_id,
                tool_call=schema.ToolCallUpdate(tool_call_id='call-1', title='run make'),
                options=[
                    schema.PermissionOption(option_id='yes', name='Allow once', kind='allow_once'),
                    schema.PermissionOption(option_id='no', name='Reject', kind='reject_once'),
                ],
            )
            outcome = response.outcome
            text = f'Permission: {outcome.option_id if isinstance(outcome, schema.AllowedOutcome) else "cancelled"}.'
        await self._call('post', {'post': {'kind': 'message', 'text': text, 'new_thread': f'Hello {self._name}'}})

    async def _answer_news(self) -> None:
        news = Update.model_validate(await self._call('wait', {'timeout_seconds': 0}))
        for entry in news.posts:
            post = entry.post
            request = {'kind': 'answer', 'text': f'Seen {post.id}.', 'thread': post.thread, 'reply_to': post.id}
            await self._call('post', {'post': request})


sys.stderr.write('fake agent ready\n')
sys.stderr.flush()
if pid_file := os.environ.get('FAKE_ACP_CHILD'):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    Path(pid_file).write_text(str(child.pid))
asyncio.run(acp.run_agent(FakeAgent()))  # ty: ignore[call-non-callable]
