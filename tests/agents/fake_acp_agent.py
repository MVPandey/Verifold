"""
A fake ACP agent for tests. It reaches the lab's board over MCP with its token, the way a real harness does.

The first message makes it post in a new thread. The doorbell makes it read its posts with `wait` and answer each ask.
It also takes each rerun that this news holds, reads the clean copy, and posts the check with a file of its own folder.
Environment variables change its behavior: `FAKE_ACP_LOG` logs each call, `FAKE_ACP_PERMISSION` asks permission
first, `FAKE_ACP_COMMAND` asks permission for that shell command, which the request names by its call's ID only, `FAKE_ACP_ABORT` makes the only "no" to that request an answer that stops the turn, `FAKE_ACP_QUESTION` asks its user which branch to take, as a form, `FAKE_ACP_CRASH` exits during a turn, `FAKE_ACP_SLOW` makes a turn take a minute, and `FAKE_ACP_CHILD` starts a
child that holds the agent's pipes open and writes its process ID to that path. `FAKE_ACP_JOB` starts a job in a
session of its own, the way that a harness starts a background command, and writes its process ID to that path.
`FAKE_ACP_DESK` makes the agent of that name reply in the desk chat in each turn,
`FAKE_ACP_LEAVE` makes the agent of that name leave the lab at the end of its first turn, and
`FAKE_ACP_SLOW_AFTER_LEAVE` makes that turn take a minute more.
`FAKE_ACP_RESULT` makes the agent of that name post a result with a file and ask for a rerun of it, and
`FAKE_ACP_NO_RERUN` makes it post the result only.

Each session offers a model option `llm` and an effort option `thinking`, under their ACP categories, as real
adapters do under their own IDs, and the modes `ask` and `auto`. As in real adapters, each model has its own effort
levels, and `small-model` has none. `FAKE_ACP_NO_OPTIONS` makes it offer no options, `FAKE_ACP_REFUSE_MODEL`
names a model that it refuses to switch to, and `FAKE_ACP_SLOW_SESSION` and `FAKE_ACP_SLOW_SWITCH` make a new
session or a change take a minute.

`FAKE_ACP_NO_LOAD` makes it say that it loads no sessions, `FAKE_ACP_REFUSE_LOAD` makes it refuse to load one, and
`FAKE_ACP_CRASH_LOAD` makes it exit when it loads one. `FAKE_ACP_CRASH_ONCE` names a file: the agent exits during a
turn when the file is not there, and makes it. `FAKE_ACP_TURN_SECONDS` makes each turn take that long.
`FAKE_ACP_ANSWER_CANCEL` makes a cancel end a slow turn at once, with the turn's tokens and cost, as real adapters
answer the prompt that they stop. Without it, a slow turn runs on after a cancel and never answers in time.
"""

import asyncio
import json
import os
import subprocess
import sys
from contextlib import suppress
from pathlib import Path
from typing import Literal, override

import acp
from acp import schema

from verifold.runner.messages import DOORBELL, RERUN_WANTED

EFFORTS = {'default': ('default', 'low', 'high'), 'small': ('default', 'low'), 'small-model': ()}
"""The effort levels of each model."""

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
        self._session = ''
        self._model = 'default'
        self._cost = 0.0
        self._cancelled = asyncio.Event()

    def _note(self, **entry: object) -> None:
        if path := os.environ.get('FAKE_ACP_LOG'):
            with Path(path).open('a') as log:
                log.write(json.dumps({'agent': self._name, **entry}) + '\n')

    def _connect(self, cwd: str, servers: Servers | None) -> None:
        self._name = Path(cwd).name
        # A session without the board, such as Verifold's question about what the harness offers, posts nothing.
        server = next((server for server in servers or [] if isinstance(server, schema.HttpMcpServer)), None)
        if server:
            self._url = server.url
            self._headers = {header.name: header.value for header in server.headers}

    async def _call(self, tool: str, arguments: dict[str, object]) -> dict[str, object]:
        # The MCP client takes as long to import as the rest of this file. An agent that never reaches the board,
        # such as one that only says what it offers, starts without it.
        import httpx2  # noqa: PLC0415
        from mcp import Client  # noqa: PLC0415
        from mcp.client.streamable_http import streamable_http_client  # noqa: PLC0415

        if self._client:
            start = schema.ToolCallStart(
                session_update='tool_call', tool_call_id=f'call-{tool}', title=f'verifold.{tool}'
            )
            await self._client.session_update(session_id=self._session, update=start)
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
                load_session=not os.environ.get('FAKE_ACP_NO_LOAD'),
                mcp_capabilities=schema.McpCapabilities(http=True),
            ),
            agent_info=schema.Implementation(name='fake', version='0'),
        )

    def _options(self) -> list[schema.SessionConfigOptionSelect | schema.SessionConfigOptionBoolean] | None:
        if os.environ.get('FAKE_ACP_NO_OPTIONS'):
            return None
        options: list[schema.SessionConfigOptionSelect | schema.SessionConfigOptionBoolean] = [
            _select('llm', 'model', tuple(EFFORTS), self._model)
        ]
        if efforts := EFFORTS[self._model]:
            options.append(_select('thinking', 'thought_level', efforts, efforts[0]))
        return options

    @override
    async def new_session(
        self, cwd: str, additional_directories: list[str] | None = None, mcp_servers: Servers | None = None, **_: object
    ) -> schema.NewSessionResponse:
        self._connect(cwd, mcp_servers)
        if os.environ.get('FAKE_ACP_SLOW_SESSION'):
            await asyncio.sleep(60)
        self._session = f'session-{self._name}'
        self._note(event='new_session')
        modes = schema.SessionModeState(
            current_mode_id='ask',
            available_modes=[schema.SessionMode(id='ask', name='Ask'), schema.SessionMode(id='auto', name='Auto')],
        )
        return schema.NewSessionResponse(session_id=self._session, config_options=self._options(), modes=modes)

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
        self._session = session_id
        self._note(event='load_session', session=session_id)
        if os.environ.get('FAKE_ACP_CRASH_LOAD'):
            os._exit(3)
        if os.environ.get('FAKE_ACP_REFUSE_LOAD'):
            raise acp.RequestError.invalid_params({'session': session_id})
        return schema.LoadSessionResponse(config_options=self._options())

    @override
    async def set_session_mode(self, session_id: str, mode_id: str, **_: object) -> None:
        self._note(event='mode', mode=mode_id)

    @override
    async def set_config_option(
        self, config_id: str, session_id: str, value: str | bool, **_: object
    ) -> schema.SetSessionConfigOptionResponse:
        self._note(event='option', option=config_id, value=value)
        if os.environ.get('FAKE_ACP_SLOW_SWITCH'):
            await asyncio.sleep(60)
        if config_id == 'llm':
            if value == os.environ.get('FAKE_ACP_REFUSE_MODEL'):
                raise acp.RequestError.invalid_params({'model': value})
            self._model = str(value)
        return schema.SetSessionConfigOptionResponse(config_options=self._options() or [])

    @override
    async def cancel(self, session_id: str, **_: object) -> None:
        self._note(event='cancel')
        if os.environ.get('FAKE_ACP_ANSWER_CANCEL'):
            self._cancelled.set()

    @override
    async def prompt(self, session_id: str, prompt: Prompt, **_: object) -> schema.PromptResponse:
        text = prompt[0].text if isinstance(prompt[0], schema.TextContentBlock) else ''
        self._note(event='prompt', text=text)
        once = os.environ.get('FAKE_ACP_CRASH_ONCE')
        if os.environ.get('FAKE_ACP_CRASH') or (once and not Path(once).exists()):
            if once:
                Path(once).touch()
            os._exit(3)
        await asyncio.sleep(float(os.environ.get('FAKE_ACP_TURN_SECONDS', '0')))
        if os.environ.get('FAKE_ACP_SLOW'):
            with suppress(TimeoutError):
                await asyncio.wait_for(self._cancelled.wait(), 60)
            if self._cancelled.is_set():
                self._cancelled.clear()
                return await self._stopped(session_id)
        # The doorbell can follow other news, such as a restart of Verifold.
        if os.environ.get('FAKE_ACP_DESK') == self._name:
            await self._call('reply', {'text': f'The desk {self._name} read you.'})
        elif text.endswith((DOORBELL, RERUN_WANTED)):
            await self._answer_news()
        elif os.environ.get('FAKE_ACP_RESULT') == self._name:
            await self._post_result()
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

    async def _stopped(self, session_id: str) -> schema.PromptResponse:
        # The answer to a prompt that a cancel stopped: what the turn used up to the cancel.
        self._cost += 0.05
        if self._client:
            cost = schema.Cost(amount=self._cost, currency='USD')
            update = schema.UsageUpdate(session_update='usage_update', used=900, size=1_000, cost=cost)
            await self._client.session_update(session_id=session_id, update=update)
        return schema.PromptResponse(
            stop_reason='cancelled', usage=schema.Usage(total_tokens=1_200, input_tokens=700, output_tokens=500)
        )

    async def _say_hello(self, session_id: str) -> None:
        text = f'Hello from {self._name}.'
        command = os.environ.get('FAKE_ACP_COMMAND')
        if command and self._client:
            start = schema.ToolCallStart(
                session_update='tool_call',
                tool_call_id='call-1',
                title=command,
                kind='execute',
                raw_input={'command': command},
            )
            await self._client.session_update(session_id=session_id, update=start)
        if (command or os.environ.get('FAKE_ACP_PERMISSION')) and self._client:
            response = await self._client.request_permission(
                session_id=session_id,
                tool_call=schema.ToolCallUpdate(tool_call_id='call-1', title=None if command else 'run make'),
                options=[
                    schema.PermissionOption(option_id='yes', name='Allow once', kind='allow_once'),
                    schema.PermissionOption(option_id='cancel', name='No, and stop', kind='reject_once')
                    if os.environ.get('FAKE_ACP_ABORT')
                    else schema.PermissionOption(option_id='no', name='Reject', kind='reject_once'),
                ],
            )
            outcome = response.outcome
            text = f'Permission: {outcome.option_id if isinstance(outcome, schema.AllowedOutcome) else "cancelled"}.'
        if os.environ.get('FAKE_ACP_QUESTION') and self._client:
            branch = schema.ElicitationStringPropertySchema(type='string', title='Branch', enum=['main', 'dev'])
            form = schema.ElicitationFormSessionMode(
                session_id=session_id,
                requested_schema=schema.ElicitationSchema(properties={'branch': branch}, required=['branch']),
            )
            answered = await self._client.create_elicitation(message='Which branch?', mode=form)
            given = answered.content if isinstance(answered, schema.AcceptElicitationResponse) else None
            text = f'Answer: {json.dumps(given)}.'
        await self._call('post', {'kind': 'message', 'text': text, 'new_thread': f'Hello {self._name}'})
        if os.environ.get('FAKE_ACP_LEAVE') == self._name:
            await self._call('leave', {'reason': 'Nothing is left for me.'})
            if os.environ.get('FAKE_ACP_SLOW_AFTER_LEAVE'):
                await asyncio.sleep(60)

    async def _post_result(self) -> None:
        (Path.cwd() / 'result.txt').write_text('11.8\n')
        posted = await self._call(
            'post',
            {'kind': 'result', 'text': 'sorted() is 11.8x faster.', 'new_thread': 'Speed', 'files': ['result.txt']},
        )
        post = posted.get('post')
        if isinstance(post, dict) and not os.environ.get('FAKE_ACP_NO_RERUN'):
            await self._call('rerun', {'post': post.get('id')})

    async def _answer_news(self) -> None:
        from verifold.protocol.join import RerunTake, Update  # noqa: PLC0415

        news = Update.model_validate(await self._call('wait', {'timeout_seconds': 0}))
        # Only asks get an answer. An answer to every post would make two fake agents answer each other without end.
        for post in (entry.post for entry in news.posts if entry.post.kind == 'ask'):
            request: dict[str, object] = {
                'kind': 'answer',
                'text': f'Seen {post.id}.',
                'thread': post.thread,
                'reply_to': post.id,
            }
            await self._call('post', request)
        # The agent takes each rerun that its news holds, reads the clean copy, reruns in its own folder, and
        # posts the check with a file of its own.
        for wanted in news.reruns:
            taken = RerunTake.model_validate(await self._call('take_rerun', {'post': wanted.post}))
            claimed = (Path(taken.folder) / taken.files[0]).read_text().strip()
            (Path.cwd() / 'rerun.txt').write_text(claimed)
            check: dict[str, object] = {
                'kind': 'check',
                'text': f'Reran it from a clean copy: {claimed}.',
                'reply_to': taken.post,
                'outcome': 'holds',
                'method': 'rerun',
                'files': ['rerun.txt'],
            }
            await self._call('post', check)


def _select(
    option: str, category: Literal['model', 'thought_level'], values: tuple[str, ...], current: str
) -> schema.SessionConfigOptionSelect:
    choices = [schema.SessionConfigSelectOption(value=value, name=value) for value in values]
    return schema.SessionConfigOptionSelect(
        id=option, name=option, category=category, current_value=current, options=choices, type='select'
    )


sys.stderr.write('fake agent ready\n')
sys.stderr.flush()
if pid_file := os.environ.get('FAKE_ACP_CHILD'):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    Path(pid_file).write_text(str(child.pid))
if job_file := os.environ.get('FAKE_ACP_JOB'):
    # Its own session takes the job out of the agent's process group, and it needs none of the agent's pipes.
    job = subprocess.Popen(
        [sys.executable, '-c', 'import time; time.sleep(60)'],
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    # The test reads the file as soon as it exists, so it appears with its content.
    written = Path(f'{job_file}.tmp')
    written.write_text(str(job.pid))
    written.replace(job_file)
asyncio.run(acp.run_agent(FakeAgent()))  # ty: ignore[call-non-callable]
