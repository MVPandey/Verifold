import asyncio
import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
from collections.abc import AsyncGenerator, Iterator, Mapping
from contextlib import asynccontextmanager, suppress
from datetime import timedelta
from pathlib import Path

import httpx2
import psutil
import pytest
import uvicorn
from builders import SLEEP, alive, start_orphan, until
from fakes import FAKE_HARNESS
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from pydantic import TypeAdapter

from verifold.app import (
    NORMS_TEMPLATE,
    WRITING_TEMPLATE,
    Host,
    ServeHooks,
    ServeOptions,
    WebServer,
    _agent,
    _crew,
    _options,
    serve,
)
from verifold.harnesses.catalog import CATALOG as BUILT_IN
from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.agents import Agent, AgentChoice, ModelSpec
from verifold.protocol.app import AgentView, LabView, NormsView, StartRequest
from verifold.protocol.events import (
    AgentJoined,
    AgentNamed,
    Event,
    Posted,
    RerunRequested,
    SettingsSet,
    TimeRanOut,
    TurnEnded,
    TurnStarted,
    TurnSummary,
)
from verifold.protocol.settings import AtExit, AtTimeLimit
from verifold.protocol.usage import Usage
from verifold.runner.agent_loop import AgentSetup
from verifold.runner.environment import harness_environment
from verifold.runner.git import GitError, git
from verifold.runner.jobs import Sweep, sweep
from verifold.runner.messages import DOORBELL, RESTARTED, STARTED_AGAIN
from verifold.runner.messages import ON_CALL as ON_CALL_FACT
from verifold.server.errors import LabExists, SetupRejected
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.server.web import web_app
from verifold.society.attention import update
from verifold.society.fold import fold
from verifold.society.standing import standing
from verifold.society.turns import before as place_of
from verifold.store.record_file import RecordFile

events: TypeAdapter[Event] = TypeAdapter(Event)
CATALOG = {'fake': FAKE_HARNESS}
TWO_AGENTS = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake', count=2, model='small'),))


def record(project: Path) -> list[Event]:
    path = project / '.verifold' / 'record.jsonl'
    return [events.validate_json(line) for line in path.read_text().splitlines()] if path.exists() else []


def posts(project: Path) -> list[Posted]:
    """Return the agents' posts. The person's question, which opens every lab, is not among them."""
    return [event for event in record(project) if isinstance(event, Posted) and event.post.author != 'person']


def calls(log: Path) -> list[dict[str, str]]:
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / 'calls.jsonl'
    monkeypatch.setenv('FAKE_ACP_LOG', str(path))
    return path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    path = tmp_path / 'project'
    path.mkdir()
    return path


@asynccontextmanager
async def serving(
    project: Path,
    start: StartRequest | None = None,
    catalog: Mapping[str, HarnessEntry] = CATALOG,
    sweeps: list[Sweep] | None = None,
    options: ServeOptions | None = None,
) -> AsyncGenerator[httpx2.AsyncClient]:
    """Serve the folder, and yield a client of its app API that acts as the person. `sweeps` collects each sweep."""
    ready: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    hooks = ServeHooks(ready=ready.set_result, swept=(sweeps if sweeps is not None else []).append)
    running = asyncio.create_task(serve(project, start, options=options, catalog=catalog, hooks=hooks))
    try:
        async with asyncio.timeout(20):
            base, _, token = (await ready).partition('/#token=')
        headers = {'Authorization': f'Bearer {token}'}
        async with httpx2.AsyncClient(base_url=f'{base}/api', headers=headers) as client:
            yield client
    finally:
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running


async def probed_setup(client: httpx2.AsyncClient) -> dict[str, object]:
    """Return the setup view once Verifold has asked every harness what it offers."""
    while True:
        setup = (await client.get('/setup')).json()
        if not any(harness['probing'] for harness in setup['harnesses']):
            return setup
        await asyncio.sleep(0.05)


def named(*values: str) -> list[dict[str, str]]:
    return [{'value': value, 'name': value} for value in values]


async def test_the_person_starts_a_lab_from_the_setup_screen(
    project: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project) as client:
        before = await probed_setup(client)
        no_lab = await client.get('/lab')
        started = await client.post('/labs', json=TWO_AGENTS.model_dump(mode='json'))
        await until(lambda: len(posts(project)) == 2)
        again = await client.post('/labs', json=TWO_AGENTS.model_dump(mode='json'))

    assert before == {
        'folder': '~/project',
        'harnesses': [
            {
                'name': 'fake',
                'title': 'Fake',
                'family': 'test',
                'available': True,
                'probing': False,
                'offer': {
                    'models': [
                        {'value': 'default', 'name': 'default', 'efforts': named('default', 'low', 'high')},
                        {'value': 'small', 'name': 'small', 'efforts': named('default', 'low')},
                        {'value': 'small-model', 'name': 'small-model', 'efforts': []},
                    ],
                    'efforts': named('default', 'low', 'high'),
                    'modes': [{'value': 'ask', 'name': 'Ask'}, {'value': 'auto', 'name': 'Auto'}],
                    'model': 'default',
                    'effort': 'default',
                    'mode': 'ask',
                },
            }
        ],
        'question': None,
        'defaults': {'agents': None, 'auto_mode': True, 'minutes': None},
        'defaults_from': None,
    }
    assert (no_lab.status_code, started.status_code, again.status_code) == (409, 200, 409)
    # The probe runs in the project folder, which the fake agent takes for its name.
    assert [call['event'] for call in calls(log) if call['agent'] == project.name][:1] == ['new_session']
    assert started.json()['question'] == 'Does it hold?'
    assert sorted((entry.post.author, entry.post.text) for entry in posts(project)) == [
        ('agent-1', 'Hello from agent-1.'),
        ('agent-2', 'Hello from agent-2.'),
    ]
    joined = [event.agent for event in record(project) if isinstance(event, AgentJoined)]
    assert [(agent.id, agent.role, agent.model.name) for agent in joined] == [
        ('agent-1', '', 'small'),
        ('agent-2', '', 'small'),
    ]
    assert {call['agent'] for call in calls(log) if call['event'] == 'mode' and call['mode'] == 'auto'} == {
        'agent-1',
        'agent-2',
    }
    first = next(call['text'] for call in calls(log) if call['event'] == 'prompt' and call['agent'] == 'agent-2')
    # The setup screen asked the harness what it offers, so each name holds the model's name from the first.
    assert first.startswith(
        'Does it hold?\n\nYou are Fake · small 2 (agent-2) in a Verifold lab. '
        'The other agents got this question at the same moment: Fake · small (agent-1, fake).'
    )
    assert 'Thread t-1 on the board holds this question.' in first
    board = fold(record(project))
    question = board.posts[0].post
    assert (board.threads[0].thread.title, question.author, question.text) == (
        'The question',
        'person',
        'Does it hold?',
    )
    assert board.posts[0].seq < board.agents[0].seq
    assert (project / '.verifold' / 'LAB.md').read_text().startswith("# The lab's norms")


async def test_a_resumed_lab_keeps_its_agents_and_the_persons_edits_to_its_norms(project: Path, log: Path) -> None:
    async with serving(project, TWO_AGENTS):
        await until(lambda: len(posts(project)) == 2)
    norms = project / '.verifold' / 'LAB.md'
    norms.write_text('# Our own rules\n')

    async with serving(project) as client:
        await until(lambda: len(posts(project)) == 4)
        setup = (await client.get('/setup')).json()

    assert setup['question'] == 'Does it hold?'
    assert sum(isinstance(event, AgentJoined) for event in record(project)) == 2
    assert norms.read_text() == '# Our own rules\n'
    resumed = [call for call in calls(log) if call['event'] == 'mode'][2:]
    assert sorted(call['agent'] for call in resumed) == ['agent-1', 'agent-2']


async def test_a_lab_that_resumes_keeps_the_auto_mode_that_its_agents_ran_with(project: Path, log: Path) -> None:
    def modes() -> list[object]:
        return [call['mode'] for call in calls(log) if call['event'] == 'mode']

    # The catalog changes between the runs, as when a new Verifold gives the harness another auto mode.
    then = {'fake': FAKE_HARNESS.model_copy(update={'auto_mode': 'ask'})}
    now = {'fake': FAKE_HARNESS.model_copy(update={'auto_mode': 'auto', 'auto_mode_before': 'ask'})}
    async with serving(project, ONE_AGENT, catalog=then):
        await until(lambda: len(posts(project)) == 1)
    joined = next(event for event in record(project) if isinstance(event, AgentJoined))
    async with serving(project, catalog=now):
        await until(lambda: len(modes()) == 2)
    # A record from before Verifold kept the mode with the agent holds none. That lab goes on with the mode from then.
    path = project / '.verifold' / 'record.jsonl'
    path.write_text(path.read_text().replace('"auto_mode":"ask",', '', 1))
    old = next(event for event in record(project) if isinstance(event, AgentJoined))
    async with serving(project, catalog=now):
        await until(lambda: len(modes()) == 3)
    async with serving(project, catalog={'fake': FAKE_HARNESS}):
        await until(lambda: len(modes()) == 4)

    assert (joined.agent.auto_mode, old.agent.auto_mode) == ('ask', None)
    assert modes() == ['ask', 'ask', 'ask', 'auto']


def test_the_built_in_codex_entry_keeps_its_earlier_auto_mode_for_the_labs_from_before() -> None:
    codex = BUILT_IN['codex']
    before = Agent(id='agent-1', name='Agent 1', harness='codex', model=ModelSpec(family='openai'))
    new = _agent(2, codex, AgentChoice(harness='codex'), None, (), auto_mode=True)
    chosen = _agent(3, codex, AgentChoice(harness='codex', mode='read-only'), None, (), auto_mode=True)

    assert (codex.auto_mode, codex.auto_mode_before, new.auto_mode) == ('agent', 'workspace-write', 'agent')
    assert _options(before, codex, auto_mode=True).mode == 'workspace-write'
    assert _options(new, codex, auto_mode=True).mode == 'agent'
    assert _options(chosen, codex, auto_mode=True).mode == 'read-only'
    assert _options(before, codex, auto_mode=False).mode is None
    assert _agent(4, codex, AgentChoice(harness='codex'), None, (), auto_mode=False).auto_mode is None
    # A harness without an earlier mode goes by the catalog, as before.
    assert (
        _options(before.model_copy(update={'harness': 'claude-code'}), BUILT_IN['claude-code'], auto_mode=True).mode
        is None
    )


def turns(project: Path) -> list[TurnEnded]:
    return [event for event in record(project) if isinstance(event, TurnEnded)]


def ended(project: Path) -> int:
    return len(turns(project))


FAST = ServeOptions(quiet=0.05, max_quiet=0.5)
"""A doorbell that rings at once, so that no test waits through the quiet window of a real lab."""

NO_DOORBELL = ServeOptions(quiet=3_600, max_quiet=3_600)
"""A doorbell that does not ring while the test runs, so that a post for an agent still waits at the restart."""


def at_rest(project: Path, agents: tuple[str, ...], after: int = 0) -> bool:
    """
    Return whether each agent ended its last turn by itself, has read event `after`, and has no post that waits for it.

    Nothing more happens for such agents until a new post comes, so a test that waits for this depends on no timing.
    """
    events = record(project)
    if not events:
        return False
    board = fold(events)
    return all(
        (was := place_of(board, agent)).rested is not None
        and was.seen >= after
        and not update(board, agent, was.seen).posts
        for agent in agents
    )


def turns_of(project: Path, agent_id: str) -> int:
    return sum(turn.agent == agent_id for turn in turns(project))


def prompts_of(log: Path, agent_id: str) -> list[str]:
    return [call['text'] for call in calls(log) if call['event'] == 'prompt' and call['agent'] == agent_id]


async def test_after_a_restart_each_agent_keeps_its_conversation_and_waits_where_it_was(
    project: Path, log: Path
) -> None:
    both = ('agent-1', 'agent-2')
    async with serving(project, TWO_AGENTS, options=FAST):
        # Each agent's first post is for the other one. The lab stops only when every such doorbell has rung and
        # its turn is over, so that no post waits for an agent at the restart.
        await until(lambda: at_rest(project, both))
    sessions = {event.agent: event.session for event in record(project) if isinstance(event, TurnStarted)}
    assert sessions == {'agent-1': 'session-agent-1', 'agent-2': 'session-agent-2'}
    rested = (ended(project), len(prompts_of(log, 'agent-1')), turns_of(project, 'agent-1'))

    async with serving(project, options=FAST) as client:
        await until(lambda: sum(call['event'] == 'load_session' for call in calls(log)) == 2)
        # An agent that waits after the restart shows as idle. One that got a message would show as working.
        states: set[str] = set()
        async with asyncio.timeout(20):
            while states != {'idle'}:
                states = {await state_of(client, 'agent-1'), await state_of(client, 'agent-2')}
        # Both agents ended their turns before the restart, so the restart starts no turn.
        assert (ended(project), len(prompts_of(log, 'agent-1'))) == rested[:2]
        ask = {'kind': 'ask', 'text': 'Which layer?', 'thread': 't-1', 'mentions': ['agent-1']}
        asked = await client.post('/posts', json=ask)
        assert asked.status_code == 200
        # The test waits for the answer to this ask and for the end of the turn of the agent that the ask names.
        seen = f'Seen {asked.json()["post"]["id"]}.'
        await until(lambda: any(entry.post.text == seen for entry in posts(project)))
        await until(lambda: turns_of(project, 'agent-1') == rested[2] + 1)

    assert states == {'idle'}
    loaded = [call for call in calls(log) if call['event'] == 'load_session']
    assert sorted(call['session'] for call in loaded) == ['session-agent-1', 'session-agent-2']
    woken = prompts_of(log, 'agent-1')[-1]
    assert woken.startswith(RESTARTED)
    assert woken.endswith(DOORBELL)
    assert f'Your folder is {project / ".verifold" / "agents" / "agent-1"}.' in woken
    assert posts(project)[-1].post.text.startswith('Seen p-')


async def test_an_agent_that_verifold_stopped_stays_stopped_after_a_restart_until_the_person_starts_it(
    project: Path, log: Path
) -> None:
    with RecordFile(project / '.verifold' / 'record.jsonl') as file:
        lab = Lab.create(file, 'Does it hold?')
        for number, harness in ((1, 'fake'), (2, 'fake'), (3, 'lost')):
            fake = Agent(id=f'agent-{number}', name=f'Agent {number}', harness=harness, model=ModelSpec(family='x'))
            await lab.join(fake)
        await lab.start_turn('agent-1', 'session-agent-1', 2)
        for stopped in ('agent-1', 'agent-3'):
            failed = TurnSummary(agent=stopped, seconds=0, usage=Usage(), error='It broke.', seen=2, stopped=True)
            await lab.end_turn(failed)
    lost = FAKE_HARNESS.model_copy(update={'name': 'lost', 'title': 'Lost', 'executable': 'no-such-program'})

    async with serving(project, catalog={'fake': FAKE_HARNESS, 'lost': lost}) as client:
        await until(lambda: len(prompts_of(log, 'agent-2')) == 1)
        await asyncio.sleep(0.3)
        view = (await client.get('/lab')).json()['agents'][0]
        nothing_started = prompts_of(log, 'agent-1')
        other = await client.post('/agents/agent-2/start')
        unknown = await client.post('/agents/agent-9/start')
        missing = await client.post('/agents/agent-3/start')
        # Two requests at once start one harness.
        both = await asyncio.gather(client.post('/agents/agent-1/start'), client.post('/agents/agent-1/start'))
        started, twice = sorted(both, key=lambda response: response.status_code)
        shown = started.json()['agents'][0]['stopped']
        await until(lambda: len(prompts_of(log, 'agent-1')) == 1)
        await asyncio.sleep(0.3)

    assert (view['activity']['state'], view['stopped'], nothing_started) == ('stopped', True, [])
    assert (other.status_code, unknown.status_code, started.status_code) == (400, 404, 200)
    assert other.json()['detail'] == 'Verifold did not stop Agent 2, so it needs no new start.'
    assert (twice.status_code, twice.json()['detail']) == (400, other.json()['detail'].replace('Agent 2', 'Agent 1'))
    assert prompts_of(log, 'agent-1')[0].startswith(STARTED_AGAIN)
    assert (missing.status_code, missing.json()['detail']) == (
        400,
        'This computer does not have Lost, so Agent 3 cannot start.',
    )
    # The row changes when the start is accepted, before the agent's next turn is in the record.
    assert not shown
    assert sum(call['event'] == 'load_session' and call['agent'] == 'agent-1' for call in calls(log)) == 1


async def test_a_lab_starts_with_the_persons_grants_and_a_granted_command_passes(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_COMMAND', './gpu python3 train.py')
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake'),), allow=('./gpu',))

    async with serving(project, start):
        await until(lambda: len(posts(project)) == 1)

    assert fold(record(project)).grants == ('./gpu',)
    assert [posted.post.text for posted in posts(project)] == ['Permission: yes.']


async def test_without_auto_mode_the_persons_default_mode_stays_and_minutes_set_the_end(
    project: Path, log: Path
) -> None:
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake'),), auto_mode=False, minutes=30)

    async with serving(project, start):
        await until(lambda: len(posts(project)) == 1)

    assert all(call['event'] != 'mode' for call in calls(log))
    opened = fold(record(project)).opened
    assert opened.ends_at == opened.at + timedelta(minutes=30)
    assert 'The lab ends at' in next(call['text'] for call in calls(log) if call['event'] == 'prompt')


async def test_an_unknown_harness_is_refused_before_anything_is_recorded(project: Path) -> None:
    start = StartRequest(question='Q?', agents=(AgentChoice(harness='nope'),))

    with pytest.raises(ExceptionGroup) as refused:
        await serve(project, start, catalog=CATALOG)

    assert refused.group_contains(SetupRejected, match='Unknown harness nope')
    assert record(project) == []


@pytest.mark.usefixtures('log')
async def test_a_question_for_a_folder_with_a_lab_is_refused(project: Path) -> None:
    async with serving(project, TWO_AGENTS):
        await until(lambda: len(posts(project)) == 2)

    with pytest.raises(LabExists, match='Run `verifold` here to resume it'):
        await serve(project, TWO_AGENTS, catalog=CATALOG)


async def test_the_person_adds_an_agent_to_a_lab_that_runs_and_it_starts_like_the_others(
    project: Path, log: Path
) -> None:
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'),))

    async with serving(project, start, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
        added = await client.post('/agents', json={'harness': 'fake', 'count': 1})
        await until(lambda: len({e.agent for e in record(project) if isinstance(e, TurnEnded)}) == 2, timeout=60)
        unknown = await client.post('/agents', json={'harness': 'nope'})
        too_many = await client.post('/agents', json={'harness': 'fake', 'count': 19})

    assert [view['agent']['id'] for view in added.json()['agents']] == ['agent-1', 'agent-2']
    starts = [call['text'] for call in calls(log) if call['event'] == 'prompt' and call['agent'] == 'agent-2']
    # Nobody asked the harness what it offers. Agent 1's name got its model when its first turn started.
    assert 'You are Fake · default model 2 (agent-2) in a Verifold lab.' in starts[0]
    assert 'The lab is under way, and these agents work in it: Fake · default (agent-1, fake).' in starts[0]
    assert [joined.agent.name for joined in fold(record(project)).agents] == ['Fake · default', 'Fake · default 2']
    assert (unknown.status_code, too_many.status_code) == (400, 400)
    # A refused add leaves no agent on the record.
    assert len([event for event in record(project) if isinstance(event, AgentJoined)]) == 2
    assert 'at most 20 agents' in too_many.json()['detail']


def invited_parts(text: str) -> tuple[str, str, Path]:
    """Return the board's address, the token, and the folder that an invitation names."""
    url, token, folder = (
        re.findall(rf'^{label} (.+)$', text, re.MULTILINE)[0]
        for label in ('URL:', 'Header: Authorization: Bearer', 'Your folder:')
    )
    return url, token, Path(folder)


@asynccontextmanager
async def board_of(url: str, token: str) -> AsyncGenerator[Client]:
    """Connect to the lab's board the way that an invited agent's harness does."""
    headers = {'Authorization': f'Bearer {token}'}
    async with (
        httpx2.AsyncClient(headers=headers) as http,
        Client(streamable_http_client(url, http_client=http)) as board,
    ):
        yield board


async def state_of(client: httpx2.AsyncClient, agent_id: str) -> str:
    views = (await client.get('/lab')).json()['agents']
    return next(view['activity']['state'] for view in views if view['agent']['id'] == agent_id)


async def test_the_person_invites_an_agent_that_runs_by_itself_and_the_invitation_holds_after_a_restart(
    project: Path, log: Path
) -> None:
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'),))

    async with serving(project, start, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
        invited = (await client.post('/invitations', json={'name': 'Reader'})).json()
        url, token, folder = invited_parts(invited['text'])
        before = await state_of(client, 'agent-2')
        async with board_of(url, token) as board:
            brief = await board.call_tool('brief', {})
            waiting = asyncio.create_task(board.call_tool('wait', {'timeout_seconds': 2}))
            listening = False
            while not waiting.done():
                listening = listening or await state_of(client, 'agent-2') == 'listening'
                await asyncio.sleep(0.05)
            (folder / 'notes.md').write_text('It is faster.\n')
            posted = await board.call_tool(
                'post', {'kind': 'result', 'text': 'It is faster.', 'thread': 't-1', 'files': ['notes.md']}
            )
            alarm = await board.call_tool('alarm', {'minutes': 5})
        after = await state_of(client, 'agent-2')
        view = next(view for view in (await client.get('/lab')).json()['agents'] if view['agent']['id'] == 'agent-2')
        # The person writes to the lab while the invited agent is not connected.
        await client.post('/posts', json={'kind': 'message', 'text': 'Go on with the tail.', 'thread': 't-1'})

    assert (invited['agent'], invited['name']) == ('agent-2', 'Reader')
    assert 'The lab is under way, and these agents work in it: Fake · default (agent-1, fake).' in invited['text']
    assert f"{project / '.verifold' / 'LAB.md'} holds the lab's norms" in invited['text']
    assert folder == project / '.verifold' / 'agents' / 'agent-2'
    assert 'So a token or MCP settings in this folder reach those commits and each blind checker.' in invited['text']
    assert brief.structured_content is not None
    assert brief.structured_content['you'] == 'agent-2'
    assert (before, listening, after) == ('invited', True, 'here')
    assert posted.structured_content is not None
    assert posted.structured_content['post']['evidence'][0]['path'] == 'notes.md'
    assert alarm.is_error
    # Verifold knows no model and no cost of the agent, and it started no harness for it.
    assert (view['agent']['harness'], view['agent']['model']['family']) == ('guest', 'unknown')
    assert (view['turns'], view['posts'], view['cost_usd']) == (0, 1, None)
    assert {call['agent'] for call in calls(log)} == {'agent-1'}
    assert len([event for event in record(project) if isinstance(event, AgentJoined)]) == 2
    # The lab's files hold a digest of the token and not the token, and only the person reads the file.
    guests = project / '.verifold' / 'guests.json'
    assert stat.S_IMODE(guests.stat().st_mode) == 0o600
    assert all(token not in path.read_text(errors='replace') for path in (project / '.verifold').glob('*.json*'))

    async with serving(project, catalog={'fake': FAKE_HARNESS}) as client:
        resumed = await state_of(client, 'agent-2')
        async with board_of(url, token) as board:
            since = await board.call_tool('wait', {'timeout_seconds': 0})
            again = await board.call_tool('brief', {})
        async with board_of(url, f'{token}x') as board:
            wrong = await board.call_tool('brief', {})
        # A new invitation gives the agent a new token, and the old one opens nothing.
        renewed = (await client.post('/invitations/agent-2', json={})).json()
        _, new_token, _ = invited_parts(renewed['text'])
        launched = await client.post('/invitations/agent-1', json={})
        async with board_of(url, token) as board:
            old = await board.call_tool('brief', {})
        async with board_of(url, new_token) as board:
            new = await board.call_tool('brief', {})

    assert resumed == 'here'
    assert again.structured_content is not None
    assert again.structured_content['you'] == 'agent-2'
    # The agent gets what the board got after its own last post, also across the restart.
    assert since.structured_content is not None
    assert 'Go on with the tail.' in [entry['post']['text'] for entry in since.structured_content['posts']]
    assert wrong.is_error
    assert (renewed['agent'], renewed['name'], new_token != token) == ('agent-2', 'Reader', True)
    assert (launched.status_code, old.is_error, new.is_error) == (404, True, False)
    assert {call['agent'] for call in calls(log)} == {'agent-1'}

    # A file that is not valid makes the invitations void for this run, and a new invitation does not overwrite it.
    guests.write_text('{"version": 9}')
    async with serving(project, catalog={'fake': FAKE_HARNESS}) as client:
        shown = await state_of(client, 'agent-2')
        base = str(client.base_url).removesuffix('/api/').removesuffix('/api')
        async with board_of(f'{base}/mcp', new_token) as board:
            void = await board.call_tool('brief', {})
        refused = await client.post('/invitations', json={})
        refused_again = await client.post('/invitations/agent-2', json={})
        kept = guests.read_text()
        # The person deletes the file and invites the agent again.
        guests.unlink()
        back = await client.post('/invitations/agent-2', json={})
        state = await state_of(client, 'agent-2')

    assert (shown, void.is_error) == ('void', True)
    assert (refused.status_code, refused_again.status_code, kept) == (400, 400, '{"version": 9}')
    assert 'is not a valid file of invitations' in refused.json()['detail']
    assert (back.status_code, state) == (200, 'here')
    assert len([event for event in record(project) if isinstance(event, AgentJoined)]) == 2


async def test_an_agent_that_left_stops_for_good_and_an_invited_one_loses_its_token(project: Path) -> None:
    guests = project / '.verifold' / 'guests.json'

    # No doorbell rings before the restart, so each agent has one turn there, and Reader's post waits for agent-1.
    async with serving(project, TWO_AGENTS, options=NO_DOORBELL) as client:
        # Both first turns must be over. An agent that still ran would read Reader's post in that turn, and then no
        # doorbell rings for it after the restart.
        await until(lambda: turns_of(project, 'agent-1') == 1 and turns_of(project, 'agent-2') == 1, timeout=60)
        invited = (await client.post('/invitations', json={'name': 'Reader'})).json()
        url, token, _ = invited_parts(invited['text'])
        async with board_of(url, token) as board:
            # The post names agent-1. A plain message in the question's thread is for nobody, and the wake after the
            # restart would then depend on which agent posted first.
            hello = {'kind': 'message', 'text': 'Reader is here.', 'thread': 't-1', 'mentions': ['agent-1']}
            await board.call_tool('post', hello)
            left = await board.call_tool('leave', {'reason': 'Read it all.'})
            after = await board.call_tool('brief', {})
        await until(lambda: 'agent-3' not in json.loads(guests.read_text())['digests'])
        again = await client.post('/invitations/agent-3', json={})

        removed = await client.delete('/agents/agent-2')
        await until(lambda: len(harness_pids()) == 1)
        views = {view['agent']['id']: view for view in removed.json()['agents']}

    assert (left.is_error, after.is_error) == (False, True)
    assert 'You left this lab' in str(after.content)
    assert (again.status_code, again.json()['detail']) == (
        400,
        'Reader left the lab, and an agent that left does not come back.',
    )
    assert views['agent-1']['left'] is None
    assert (views['agent-2']['left']['by'], views['agent-3']['left']['by']) == ('person', 'agent-3')
    assert views['agent-3']['left']['reason'] == 'Read it all.'

    # After a restart, Verifold starts only the agent that is still in the lab, and the old token opens nothing.
    # The doorbell for Reader's post had not rung when Verifold stopped, so it rings now.
    async with serving(project, options=FAST) as client:
        await until(lambda: turns_of(project, 'agent-1') == 2, timeout=60)
        async with board_of(url, token) as board:
            void = await board.call_tool('brief', {})
        running = len(harness_pids())

    assert (void.is_error, running) == (True, 1)
    assert 'no valid agent token' in str(void.content)
    assert [post.post.author for post in posts(project)].count('agent-2') == 1


async def test_an_agent_that_left_frees_a_place_in_a_full_lab_but_its_number_never_comes_back(tmp_path: Path) -> None:
    full = tmp_path / 'full'
    await asyncio.to_thread(lab_of, full, 20)

    async with serving(full) as client:
        too_many = await client.post('/invitations', json={})
        await client.delete('/agents/agent-7')
        invited = await client.post('/invitations', json={})
        full_again = await client.post('/agents', json={'harness': 'fake'})

    assert (too_many.status_code, invited.status_code, full_again.status_code) == (400, 200, 400)
    assert (invited.json()['agent'], invited.json()['name']) == ('agent-21', 'Agent 21')
    assert 'this one has 20' in full_again.json()['detail']


def lab_of(project: Path, agents: int, harness: str = 'gone', first: int = 1) -> None:
    """Write the record of a lab whose agents this computer cannot start, so that a server only serves it."""
    with RecordFile(project / '.verifold' / 'record.jsonl') as file:
        lab = Lab.create(file, 'Does it hold?')
        for number in range(first, first + agents):
            agent = Agent(id=f'agent-{number}', name=f'Agent {number}', harness=harness, model=ModelSpec(family='x'))
            asyncio.run(lab.join(agent))


async def test_an_invitation_is_refused_in_a_full_lab_without_a_lab_and_when_its_token_cannot_be_kept(
    project: Path, tmp_path: Path
) -> None:
    async with serving(project) as client:
        no_lab = await client.post('/invitations', json={})

    full = tmp_path / 'full'
    await asyncio.to_thread(lab_of, full, 20)
    async with serving(full) as client:
        too_many = await client.post('/invitations', json={})

    # Verifold starts nothing for an invited agent, also when a catalog has a harness with that name.
    blocked = tmp_path / 'blocked'
    await asyncio.to_thread(lab_of, blocked, 1, 'guest')
    (blocked / '.verifold' / 'guests.json').mkdir()
    async with serving(blocked, catalog={'guest': FAKE_HARNESS}) as client:
        unkept = await client.post('/invitations', json={})
        state = await state_of(client, 'agent-1')

    assert (no_lab.status_code, too_many.status_code, unkept.status_code) == (409, 400, 400)
    assert 'at most 20 agents' in too_many.json()['detail']
    assert unkept.json()['detail'].startswith("Can't invite Agent 2:")
    # Verifold holds no digest for the agent that the record has, so only a new invitation lets it join.
    assert state == 'void'
    assert len([event for event in record(blocked) if isinstance(event, AgentJoined)]) == 1


async def test_an_invited_agents_name_cannot_read_as_another_member_or_as_a_name_that_verifold_gives(
    project: Path,
) -> None:
    await asyncio.to_thread(lab_of, project, 2)
    taken = [
        'agent 1', 'AGENT-2', 'Agent', 'checker', 'Blind rerun', 'You', 'person',
        'Agent 7', 'agent-7', 'agent7', 'Checker 3', 'checker-12',
    ]  # fmt: skip

    async with serving(project) as client:
        refused = [(await client.post('/invitations', json={'name': name})).status_code for name in taken]
        reader = (await client.post('/invitations', json={'name': 'Reader'})).json()
        again = [(await client.post('/invitations', json={'name': name})).status_code for name in ('reader', 'READER')]
        # The name that Verifold gives next is free, also when the person types it.
        typed = (await client.post('/invitations', json={'name': 'Agent 4'})).json()
        plain = (await client.post('/invitations', json={})).json()

    assert refused == [400] * len(taken)
    assert again == [400, 400]
    assert [(made['agent'], made['name']) for made in (reader, typed, plain)] == [
        ('agent-3', 'Reader'),
        ('agent-4', 'Agent 4'),
        ('agent-5', 'Agent 5'),
    ]


async def test_a_lab_with_an_invitation_takes_its_port_again_only_when_the_port_is_free(project: Path) -> None:
    # The lab's one agent has the ID that the count of agents would give the next one.
    await asyncio.to_thread(lab_of, project, 1, first=2)
    async with serving(project) as client:
        next_one = (await client.post('/invitations', json={})).json()
        url, _, _ = invited_parts(next_one['text'])
    port = int(url.rsplit(':', 1)[1].removesuffix('/mcp'))

    async with serving(project) as client:
        again = client.base_url.port
    with socket.socket() as taken:
        taken.bind(('127.0.0.1', port))
        taken.listen()
        async with serving(project) as client:
            other = client.base_url.port

    assert (next_one['agent'], next_one['name']) == ('agent-3', 'Agent 3')
    assert again == port
    assert other != port


@pytest.mark.usefixtures('log')
async def test_the_app_reads_a_file_that_backs_a_post_and_the_lab_folder_gets_the_writing_guide(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'),))

    async with serving(project, start, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: any(entry.post.kind == 'result' for entry in posts(project)), timeout=60)
        result = next(entry.post for entry in posts(project) if entry.post.kind == 'result')
        file = await client.get(f'/posts/{result.id}/file', params={'path': 'result.txt'})
        missing = await client.get(f'/posts/{result.id}/file', params={'path': '../secret.txt'})

    assert (file.json()['path'], file.json()['text']) == ('result.txt', '11.8\n')
    assert missing.status_code == 404
    assert (project / '.verifold' / 'WRITING.md').read_text() == WRITING_TEMPLATE


@pytest.mark.usefixtures('log')
async def test_a_rerun_request_starts_a_blind_checker_from_another_family(
    project: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    # The other harness's worker asks before it acts. Its checker must still follow the auto mode answer.
    start = StartRequest(
        question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other', mode='ask'))
    )

    async with serving(project, start, catalog):
        await until(lambda: any(entry.post.kind == 'check' for entry in posts(project)), timeout=60)

    board = fold(record(project))
    result = next(entry.post for entry in board.posts if entry.post.kind == 'result')
    checker = next(entry.agent for entry in board.agents if entry.agent.checks)
    assert (checker.checks, checker.harness, checker.model.family, checker.recruited_by) == (
        result.id,
        'other',
        'other',
        'agent-1',
    )
    assert standing(board, result.id) == 'held_up'
    check = next(entry.post for entry in board.posts if entry.post.kind == 'check')
    assert check.text == 'Reran it blind: 11.8.'
    assert check.evidence[0].path == 'rerun.txt'
    modes = [(call['agent'], call['mode']) for call in calls(log) if call['event'] == 'mode']
    assert ('agent-2', 'ask') in modes
    assert [mode for agent, mode in modes if agent == checker.id] == ['auto']
    assert checker.mode is None
    # Verifold gives the checker no role. Its message holds facts and names the file with the person's norms.
    assert checker.role == ''
    (message,) = prompts_of(log, checker.id)
    assert message.startswith(f'You are {checker.name} ({checker.id}), a blind checker in a Verifold lab.')
    assert f'Your folder is {project / ".verifold" / "agents" / checker.id}.' in message
    assert 'records that its author ran the files of the claim itself' in message
    # The claim's author can write the norms file, so the checker's message does not name it.
    assert 'LAB.md' not in message


ONE_AGENT = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake'),))


async def save_norms(client: httpx2.AsyncClient, name: str, text: str) -> NormsView:
    """Save a norms file as the page does: with the revision of the file as the page last read it."""
    files = (await client.get('/norms')).json()['files']
    read = next(file['revision'] for file in files if file['name'] == name)
    saved = await client.post('/norms', json={'name': name, 'text': text, 'revision': read})
    assert saved.status_code == 200, saved.text
    return NormsView.model_validate(saved.json())


async def test_the_norms_page_edits_what_a_new_lab_gets_and_a_change_in_a_lab_reaches_the_agents_once(
    project: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lab_norms = project / '.verifold' / 'LAB.md'
    async with serving(project, catalog={'fake': FAKE_HARNESS}) as client:
        defaults = (await client.get('/norms')).json()
        first = await save_norms(client, 'LAB.md', '# Our rules\n')
        on_disk = lab_norms.read_text()
        await client.post('/labs', json=ONE_AGENT.model_dump(mode='json'))
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
        before = len(record(project))
        changed = await save_norms(client, 'LAB.md', '# Our rules\n\n- Be brief.\n')
        same = await save_norms(client, 'LAB.md', '# Our rules\n\n- Be brief.\n')
        # A second change within a minute puts no other post on the board. After the minute, a change posts again.
        soon = await save_norms(client, 'WRITING.md', '# Short answers\n')
        monkeypatch.setattr('verifold.app.NORMS_POST_SECONDS', 0)
        writing = await save_norms(client, 'WRITING.md', '# Shorter answers\n')
        # The post is for every agent, so the agent gets a doorbell and takes another turn.
        await until(lambda: len(prompts_of(log, 'agent-1')) > 1, timeout=60)
        # An agent writes the file. The page says so, and a save from the text that the page read is refused.
        lab_norms.write_text('# Our rules\n\n- Be long.\n')
        outside = (await client.get('/norms')).json()['files'][0]
        stale = await client.post(
            '/norms', json={'name': 'LAB.md', 'text': '# Mine\n', 'revision': changed.files[0].revision}
        )
        kept = lab_norms.read_text()
        # An invited agent says that the lab is done. A post of the person would open the lab again.
        invited = (await client.post('/invitations', json={})).json()
        url, token, _ = invited_parts(invited['text'])
        async with board_of(url, token) as board:
            await board.call_tool('post', {'kind': 'close', 'text': 'Done.', 'thread': 't-1'})
        quiet = await save_norms(client, 'LAB.md', '# Our rules\n')
        state = (await client.get('/lab')).json()['state']

    # Before the lab, a file that the folder lacks shows the default, and a save is what the new lab starts with.
    assert [(file['name'], file['saved']) for file in defaults['files']] == [('LAB.md', False), ('WRITING.md', False)]
    assert (defaults['files'][0]['text'], defaults['files'][0]['missing']) == (NORMS_TEMPLATE, [])
    assert (first.told, first.no_post, first.files[0].saved, on_disk) == (
        None,
        'no_lab',
        True,
        '# Our rules\n',
    )
    assert (first.files[0].changed_by, first.files[0].changed_at is not None) == ('page', True)
    assert (project / '.verifold' / 'WRITING.md').read_text() == '# Shorter answers\n'
    # In the lab, a change is one post of the person in the question's thread, which names nobody.
    after = [event.post for event in record(project)[before:] if isinstance(event, Posted)]
    told = [post for post in after if post.author == 'person']
    assert [post.id for post in told] == [changed.told, writing.told]
    assert [(post.thread, post.kind, post.mentions) for post in told] == [('t-1', 'message', ())] * 2
    assert told[0].text == f"The person changed the lab's norms. {lab_norms} holds them."
    assert told[1].text == (
        f'The person changed how the lab writes its answer. {project / ".verifold" / "WRITING.md"} holds the text.'
    )
    assert (changed.no_post, same.told, same.no_post) == (None, None, 'same')
    assert (soon.told, soon.no_post) == (changed.told, 'told_already')
    # The file that an agent wrote stays, and the person sees that it changed outside the page.
    assert (outside['changed_by'], outside['text']) == ('outside', '# Our rules\n\n- Be long.\n')
    assert (stale.status_code, kept) == (409, '# Our rules\n\n- Be long.\n')
    # While a close stands, the file changes and no post goes out, so the lab stays as the agents left it.
    assert (quiet.told, quiet.no_post, lab_norms.read_text(), state) == (None, 'close', '# Our rules\n', 'closed')


async def test_a_lab_keeps_the_norms_file_that_it_has_and_the_page_shows_what_the_default_gained(
    project: Path, log: Path
) -> None:
    folder = project / '.verifold'
    folder.mkdir()
    older = ''.join(line for line in NORMS_TEMPLATE.splitlines(keepends=True) if 'with a rerun' not in line)
    (folder / 'LAB.md').write_text(older)
    (folder / 'WRITING.md').symlink_to(project / 'elsewhere.md')

    async with serving(project, ONE_AGENT, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
        lab_file, writing = (await client.get('/norms')).json()['files']
        refused = await client.post('/norms', json={'name': 'WRITING.md', 'text': '# Mine\n', 'revision': ''})
        saved = await save_norms(client, 'LAB.md', older + '- One more.\n')

    # Verifold adds nothing to the person's file. The page lists the line that the current default has.
    assert (lab_file['text'], lab_file['saved'], lab_file['changed_by']) == (older, True, None)
    assert len(lab_file['missing']) == 1
    assert lab_file['missing'][0].startswith('- When you check a result with a rerun')
    assert (folder / 'LAB.md').read_text() == older + '- One more.\n'
    assert f"{folder / 'LAB.md'} holds the lab's norms" in prompts_of(log, 'agent-1')[0]
    # A file that Verifold can't read shows its own error, and the other file stays readable and editable.
    assert 'is a link' in writing['error']
    assert (writing['text'], writing['revision'], refused.status_code) == ('', '', 400)
    assert 'is a link' in (saved.files[1].error or '')
    # The lab started through no link: nothing is at the place that the link names.
    assert not (project / 'elsewhere.md').exists()


async def test_a_checker_that_runs_too_long_stops_and_the_lab_goes_on(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    monkeypatch.setenv('FAKE_ACP_SLOW_AGENT', 'checker')
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other')))

    def stopped_checker() -> TurnEnded | None:
        stops = (
            event
            for event in record(project)
            if isinstance(event, TurnEnded) and event.error and 'Verifold stopped the checker' in event.error
        )
        return next(stops, None)

    async with serving(project, start, catalog, options=ServeOptions(turn_timeout=3)) as client:
        await until(lambda: stopped_checker() is not None, timeout=60)
        lab = await client.get('/lab')

    summary = stopped_checker()
    assert summary is not None
    assert summary.agent.startswith('checker-')
    assert summary.error == 'The check ran past 3 seconds, so Verifold stopped the checker.'
    assert summary.rerun_failed
    assert lab.status_code == 200
    assert not any(entry.post.kind == 'check' for entry in posts(project))


async def test_a_checker_that_runs_too_long_after_its_check_leaves_a_rerun_that_did_not_fail(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    monkeypatch.setenv('FAKE_ACP_SLOW_AFTER_CHECK', '1')
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other')))

    def stops() -> list[TurnEnded]:
        return [
            event
            for event in record(project)
            if isinstance(event, TurnEnded) and event.error and 'Verifold stopped the checker' in event.error
        ]

    async with serving(project, start, catalog, options=ServeOptions(turn_timeout=3)):
        await until(lambda: bool(stops()), timeout=60)

    assert [stop.rerun_failed for stop in stops()] == [False]
    assert [entry.post.kind for entry in posts(project) if entry.post.author.startswith('checker-')] == ['check']


async def test_two_requests_for_a_rerun_of_one_post_start_one_checker(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    # The checker's turn takes a minute, so its check cannot answer the first request before the second one comes.
    monkeypatch.setenv('FAKE_ACP_SLOW_AGENT', 'checker')
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other')))

    def requests() -> list[RerunRequested]:
        return [event for event in record(project) if isinstance(event, RerunRequested)]

    def checkers() -> list[str]:
        return [event.agent.id for event in record(project) if isinstance(event, AgentJoined) and event.agent.checks]

    async with serving(project, start, catalog) as client:
        await until(lambda: len(requests()) == 1, timeout=60)
        again = await client.post('/reruns', json={'post': requests()[0].post})
        await until(lambda: len(checkers()) == 1, timeout=60)
        await asyncio.sleep(1.5)

    assert again.status_code == 200
    assert [request.by for request in requests()] == ['agent-1', 'person']
    assert len(checkers()) == 1


async def test_a_checker_that_stops_without_a_check_says_so_and_the_person_can_ask_again(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')
    monkeypatch.setenv('FAKE_ACP_NO_CHECK', '1')
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other')))

    def stopped() -> list[str]:
        return [
            event.agent
            for event in record(project)
            if isinstance(event, TurnEnded)
            and event.rerun_failed
            and event.error == 'The checker stopped without a check.'
        ]

    async with serving(project, start, catalog) as client:
        await until(lambda: len(stopped()) == 1, timeout=60)
        result = next(event.post for event in record(project) if isinstance(event, RerunRequested))
        again = await client.post('/reruns', json={'post': result})
        await until(lambda: len(stopped()) == 2, timeout=60)

    assert again.status_code == 200
    assert len(set(stopped())) == 2


async def test_a_rerun_that_fails_to_prepare_its_checker_shows_why_and_the_lab_goes_on(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_RESULT', 'agent-1')

    async def broken(*_: object) -> Path:
        raise GitError('git worktree add failed: no space left on device')

    monkeypatch.setattr('verifold.runner.reruns.checker_folder', broken)
    catalog = {'fake': FAKE_HARNESS, 'other': FAKE_HARNESS.model_copy(update={'name': 'other', 'family': 'other'})}
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'), AgentChoice(harness='other')))

    def failed() -> list[TurnEnded]:
        return [event for event in record(project) if isinstance(event, TurnEnded) and event.error]

    async with serving(project, start, catalog) as client:
        await until(lambda: bool(failed()), timeout=60)
        lab = await client.get('/lab')

    assert [(event.agent.startswith('checker-'), event.error, event.rerun_failed) for event in failed()] == [
        (True, 'GitError: git worktree add failed: no space left on device', True)
    ]
    assert lab.status_code == 200


async def test_a_job_that_an_agent_starts_in_a_session_of_its_own_stops_with_the_lab(
    project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_file = tmp_path / 'job.pid'
    monkeypatch.setenv('FAKE_ACP_JOB', str(job_file))
    sweeps: list[Sweep] = []

    async with serving(project, ONE_AGENT, sweeps=sweeps):
        await until(job_file.exists)
        job = int(job_file.read_text())
        assert alive(job)

    assert not alive(job)
    assert [(found.pid, found.agent) for found in sweeps[-1].stopped] == [(job, 'agent-1')]


@pytest.fixture
def leftover(project: Path) -> Iterator[subprocess.Popen[bytes]]:
    """A process that an earlier run of the lab left, which still carries the lab's mark."""
    process = subprocess.Popen(
        [sys.executable, '-c', SLEEP], env=harness_environment(project, 'agent-1'), start_new_session=True
    )
    yield process
    if process.poll() is None:
        process.kill()
        process.wait()


async def test_serving_first_stops_what_an_earlier_run_of_the_lab_left(
    project: Path, leftover: subprocess.Popen[bytes]
) -> None:
    sweeps: list[Sweep] = []

    async with serving(project, sweeps=sweeps):
        assert leftover.poll() is not None

    assert sweeps[0].earlier_run
    assert [found.pid for found in sweeps[0].stopped] == [leftover.pid]
    assert not sweeps[-1].earlier_run


async def test_the_web_server_leaves_the_stop_signals_to_verifold() -> None:
    handlers = {stop: signal.getsignal(stop) for stop in (signal.SIGINT, signal.SIGTERM)}
    server = WebServer(uvicorn.Config(web_app(), host='127.0.0.1', port=0, log_level='warning'))
    serving = asyncio.create_task(server.serve())

    try:
        await until(lambda: server.started)
        assert {stop: signal.getsignal(stop) for stop in handlers} == handlers
    finally:
        server.should_exit = True
        await serving


def write_settings(project: Path, jobs: dict[str, str]) -> None:
    folder = project / '.verifold'
    folder.mkdir(exist_ok=True)
    (folder / 'settings.json').write_text(json.dumps({'jobs': jobs}))


def paused(pid: int) -> bool:
    return psutil.Process(pid).status() == psutil.STATUS_STOPPED


def harness_pids() -> list[int]:
    pids: list[int] = []
    for child in psutil.Process().children():
        # A child that exited and waits to be collected can't show its command line.
        with suppress(psutil.Error):
            if 'fake_acp_agent.py' in ' '.join(child.cmdline()):
                pids.append(child.pid)
    return pids


@pytest.fixture
def job_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, project: Path) -> Iterator[Path]:
    """Make the fake agent start a job in a session of its own, and stop every process of the lab after the test."""
    path = tmp_path / 'job.pid'
    monkeypatch.setenv('FAKE_ACP_JOB', str(path))
    yield path
    sweep(project, grace=1)


async def test_at_the_time_limit_the_agents_jobs_pause_and_more_time_resumes_them(
    project: Path, job_file: Path
) -> None:
    sweeps: list[Sweep] = []

    async with serving(project, ONE_AGENT, sweeps=sweeps) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: paused(job))
        assert harness_pids()
        assert not any(paused(pid) for pid in harness_pids())
        await client.post('/time', json={'minutes': 5})
        await until(lambda: not paused(job))

    assert [found.pid for found in sweeps[1].paused] == [job]


async def test_with_stop_the_time_limit_ends_the_agents_jobs_but_not_their_harnesses(
    project: Path, job_file: Path
) -> None:
    write_settings(project, {'at_time_limit': 'stop'})

    async with serving(project, ONE_AGENT) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: not alive(job))
        assert harness_pids()
        assert all(alive(pid) for pid in harness_pids())


async def test_with_finish_the_agents_jobs_run_past_the_time_limit(project: Path, job_file: Path) -> None:
    write_settings(project, {'at_time_limit': 'finish'})

    async with serving(project, ONE_AGENT) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: any(isinstance(event, TimeRanOut) for event in record(project)))
        await asyncio.sleep(0.3)
        assert alive(job)
        assert not paused(job)


@pytest.mark.parametrize('changed', ['finish', 'stop'])
async def test_a_change_while_the_lab_is_out_of_time_applies_to_its_paused_jobs_at_once(
    project: Path, job_file: Path, monkeypatch: pytest.MonkeyPatch, changed: str
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(job_file.exists)
        job = int(job_file.read_text())
        await client.post('/time', json={'minutes': 0})
        await until(lambda: paused(job))
        view = (await client.get('/settings')).json()
        change = {'level': 'project', 'key': 'jobs.at_time_limit', 'value': changed, 'revisions': revisions_of(view)}
        await client.post('/settings', json=change)
        if changed == 'finish':
            await until(lambda: not paused(job))
            await client.post('/time', json={'minutes': 5})
            await asyncio.sleep(0.3)
            assert alive(job)
            assert not paused(job)
        else:
            await until(lambda: not alive(job))


async def test_with_keep_the_agents_jobs_outlive_verifold_and_its_next_start(project: Path, job_file: Path) -> None:
    write_settings(project, {'at_exit': 'keep'})

    async with serving(project, ONE_AGENT):
        await until(job_file.exists)
        job = int(job_file.read_text())
    assert alive(job)

    async with serving(project):
        assert alive(job)


async def test_a_lab_follows_the_settings_from_when_it_opened(project: Path) -> None:
    write_settings(project, {'at_time_limit': 'stop'})
    async with serving(project, ONE_AGENT):
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))

    write_settings(project, {'at_time_limit': 'finish'})
    async with serving(project):
        pass

    kept = [event.settings.jobs.at_time_limit for event in record(project) if isinstance(event, SettingsSet)]
    assert kept == [AtTimeLimit.STOP]


@pytest.mark.parametrize('value', ['wait', 'refuse'])
async def test_a_projects_file_says_whether_agents_wait_in_a_lab_that_starts_without_the_setup_screen(
    project: Path, value: str
) -> None:
    # `verifold run` starts a lab like this one, without showing the saved choices. A project's file can still hold
    # either value, because neither lets an answer allow more: a typed yes allows once under both.
    folder = project / '.verifold'
    folder.mkdir(exist_ok=True)
    (folder / 'settings.json').write_text(json.dumps({'permissions': {'while_you_decide': value}}))

    async with serving(project, ONE_AGENT):
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))

    kept = [event.settings.permissions.while_you_decide for event in record(project) if isinstance(event, SettingsSet)]
    assert kept == [value]


async def test_the_persons_change_applies_to_the_running_lab_but_an_agents_edit_does_not(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        # An agent edits the project's file during the lab. Its edit stays out of the lab.
        write_settings(project, {'at_exit': 'keep'})
        before = (await client.get('/settings')).json()
        change = {
            'level': 'all',
            'key': 'jobs.at_time_limit',
            'value': 'stop',
            'revisions': revisions_of(before),
        }
        after = (await client.post('/settings', json=change)).json()
        stale = await client.post('/settings', json={**change, 'value': 'finish'})
        lab = (await client.get('/lab')).json()

    assert before['project']['values'] == {'jobs': {'at_exit': 'keep'}}
    assert before['all_projects'] == {
        'path': '~/.verifold/settings.json',
        'values': {},
        'revision': '',
        'settings': {
            'version': 1,
            'jobs': {'at_time_limit': 'pause', 'at_exit': 'stop'},
            'permissions': {'while_you_decide': 'auto'},
        },
        'defaults': {'agents': None, 'auto_mode': True, 'minutes': None},
    }
    assert after['all_projects']['values'] == {'jobs': {'at_time_limit': 'stop'}}
    assert after['project']['settings']['jobs'] == {'at_time_limit': 'stop', 'at_exit': 'keep'}
    assert after['lab']['jobs'] == {'at_time_limit': 'stop', 'at_exit': 'stop'}
    assert lab['settings'] == after['lab']
    assert stale.status_code == 409
    kept = [event.settings.jobs for event in record(project) if isinstance(event, SettingsSet)]
    assert [(jobs.at_time_limit, jobs.at_exit) for jobs in kept] == [
        (AtTimeLimit.PAUSE, AtExit.STOP),
        (AtTimeLimit.STOP, AtExit.STOP),
    ]


async def test_the_persons_choice_for_permission_requests_applies_to_the_running_lab(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        before = (await client.get('/settings')).json()
        change = {
            'level': 'all',
            'key': 'permissions.while_you_decide',
            'value': 'refuse',
            'revisions': revisions_of(before),
        }
        after = (await client.post('/settings', json=change)).json()

    assert before['lab']['permissions'] == {'while_you_decide': 'auto'}
    assert after['all_projects']['values'] == {'permissions': {'while_you_decide': 'refuse'}}
    assert after['lab']['permissions'] == {'while_you_decide': 'refuse'}
    assert after['lab']['jobs'] == before['lab']['jobs']


def revisions_of(view: dict[str, dict[str, str]]) -> dict[str, str]:
    return {'project': view['project']['revision'], 'all_projects': view['all_projects']['revision']}


def lab_settings(project: Path) -> list[tuple[AtTimeLimit, AtExit]]:
    kept = [event.settings.jobs for event in record(project) if isinstance(event, SettingsSet)]
    return [(jobs.at_time_limit, jobs.at_exit) for jobs in kept]


async def test_a_change_for_all_projects_skips_a_lab_whose_project_has_its_own_setting(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    write_settings(project, {'at_exit': 'stop'})
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        view = (await client.get('/settings')).json()
        change = {'level': 'all', 'key': 'jobs.at_exit', 'value': 'keep', 'revisions': revisions_of(view)}
        changed = (await client.post('/settings', json=change)).json()

    assert changed['all_projects']['settings']['jobs']['at_exit'] == 'keep'
    assert changed['lab']['jobs']['at_exit'] == 'stop'
    assert lab_settings(project) == [(AtTimeLimit.PAUSE, AtExit.STOP)]


async def test_choosing_the_value_that_the_files_hold_makes_the_lab_follow_it(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        # Someone edits the file by hand. The lab keeps its copy until the person chooses the value in the app.
        write_settings(project, {'at_time_limit': 'finish'})
        view = (await client.get('/settings')).json()
        change = {'level': 'project', 'key': 'jobs.at_time_limit', 'value': 'finish', 'revisions': revisions_of(view)}
        changed = (await client.post('/settings', json=change)).json()

    assert view['lab']['jobs']['at_time_limit'] == 'pause'
    assert changed['lab']['jobs']['at_time_limit'] == 'finish'
    assert lab_settings(project) == [(AtTimeLimit.PAUSE, AtExit.STOP), (AtTimeLimit.FINISH, AtExit.STOP)]


async def test_saved_choices_for_new_labs_fill_the_setup_and_leave_a_running_lab_alone(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    saved = {'agents': [{'harness': 'fake', 'count': 3, 'model': 'small', 'mode': None}], 'auto_mode': False}
    async with serving(project) as client:
        view = (await client.get('/settings')).json()
        change = {'level': 'project', 'key': 'setup', 'value': saved, 'revisions': revisions_of(view)}
        changed = (await client.post('/settings', json=change)).json()
        setup = (await client.get('/setup')).json()
        wrong = await client.post('/settings', json={**change, 'value': 'all', 'revisions': revisions_of(changed)})

    written = {'agents': [{'harness': 'fake', 'count': 3, 'model': 'small'}], 'auto_mode': False, 'minutes': None}
    assert changed['project']['values'] == {'setup': written}
    # The setup names the file that its first choices come from, which here is the project's own.
    assert setup['defaults_from'] == changed['project']['path']
    unset = {'effort': None, 'mode': None, 'role': '', 'on_call': False, 'coordinator': False, 'family': None}
    assert changed['project']['defaults'] == {**written, 'agents': [{**written['agents'][0], **unset}]}
    assert setup['defaults'] == changed['project']['defaults']
    assert wrong.status_code == 400
    assert record(project) == []


async def test_saved_choices_change_while_a_lab_runs_without_touching_the_lab(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    async with serving(project, ONE_AGENT) as client:
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        view = (await client.get('/settings')).json()
        saved = {'agents': [{'harness': 'fake', 'count': 2}], 'auto_mode': False}
        change = {'level': 'project', 'key': 'setup', 'value': saved, 'revisions': revisions_of(view)}
        changed = await client.post('/settings', json=change)
        setup = (await client.get('/setup')).json()

    assert changed.status_code == 200
    assert changed.json()['project']['defaults']['auto_mode'] is False
    assert lab_settings(project) == [(AtTimeLimit.PAUSE, AtExit.STOP)]
    # The lab's pages read no saved choices while the lab runs.
    assert setup['defaults'] == {'agents': None, 'auto_mode': True, 'minutes': None}


async def test_a_broken_settings_file_still_shows_the_setup_with_verifolds_defaults(project: Path) -> None:
    async with serving(project) as client:
        (project / '.verifold' / 'settings.json').write_text('{not json')
        setup = await client.get('/setup')

    assert setup.status_code == 200
    assert setup.json()['defaults'] == {'agents': None, 'auto_mode': True, 'minutes': None}


async def test_settings_can_change_before_a_lab_starts(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    revisions = {'project': '', 'all_projects': ''}
    change = {'level': 'project', 'key': 'jobs.at_exit', 'value': 'keep', 'revisions': revisions}

    async with serving(project) as client:
        changed = (await client.post('/settings', json=change)).json()

    assert changed['lab'] is None
    assert changed['project']['settings']['jobs']['at_exit'] == 'keep'
    assert record(project) == []


async def test_a_broken_settings_file_refuses_the_start_and_leaves_no_lab(project: Path) -> None:
    async with serving(project) as client:
        (project / '.verifold' / 'settings.json').write_text('{not json')
        refused = await client.post('/labs', json={'question': 'Does it hold?', 'agents': [{'harness': 'fake'}]})

    assert refused.status_code == 400
    assert 'settings.json' in refused.json()['detail']
    assert record(project) == []


async def test_a_repository_that_tracks_lab_files_is_refused_but_its_settings_file_is_not(
    project: Path, home: Path
) -> None:
    # Verifold's own git helper drops the GIT_ variables that a Git hook sets, which would point at another repository.
    await git('init', '--quiet', cwd=project)
    write_settings(project, {'at_exit': 'keep'})
    await git('add', '.verifold/settings.json', cwd=project)
    author = ('-c', 'user.name=Someone', '-c', 'user.email=someone@example.com')
    await git(*author, 'commit', '--quiet', '-m', 'settings', cwd=project)
    async with serving(project):
        pass
    assert (home / '.verifold' / 'npx').is_dir()

    await git('add', '--force', '.verifold/record.jsonl', cwd=project)
    with pytest.raises(SetupRejected, match=r'The repository tracks \.verifold/record\.jsonl\. Verifold keeps its own'):
        await serve(project, hooks=ServeHooks(ready=lambda _: None))


async def test_a_lab_from_before_settings_takes_the_files_on_its_next_run(project: Path) -> None:
    with RecordFile(project / '.verifold' / 'record.jsonl') as file:
        Lab.create(file, 'Does it hold?')
    write_settings(project, {'at_time_limit': 'finish'})

    async with serving(project):
        pass

    kept = [event.settings.jobs.at_time_limit for event in record(project) if isinstance(event, SettingsSet)]
    assert kept == [AtTimeLimit.FINISH]


@pytest.fixture
def orphan(project: Path) -> Iterator[int]:
    """A job that an earlier run of the lab left: it carries the lab's mark, and its parent is gone."""
    pid = start_orphan(harness_environment(project, 'agent-1'))
    yield pid
    with suppress(psutil.NoSuchProcess):
        psutil.Process(pid).kill()


async def test_only_pause_resumes_jobs_so_under_stop_a_paused_job_stays_paused(project: Path, orphan: int) -> None:
    write_settings(project, {'at_time_limit': 'stop', 'at_exit': 'keep'})
    os.kill(orphan, signal.SIGSTOP)

    async with serving(project, ONE_AGENT):
        await until(lambda: any(isinstance(event, SettingsSet) for event in record(project)))
        await asyncio.sleep(0.3)
        assert paused(orphan)


async def test_under_pause_a_new_run_resumes_a_paused_job_that_keep_kept(project: Path, orphan: int) -> None:
    write_settings(project, {'at_exit': 'keep'})
    os.kill(orphan, signal.SIGSTOP)

    async with serving(project, ONE_AGENT):
        await until(lambda: not paused(orphan))


async def test_a_harness_from_the_persons_settings_shows_in_the_setup_and_runs_a_lab(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('HOME', str(project.parent))
    folder = project.parent / '.verifold'
    folder.mkdir()
    entry = {'command': list(FAKE_HARNESS.command), 'family': 'local', 'title': 'Local agent'}
    (folder / 'settings.json').write_text(json.dumps({'harnesses': {'local': entry}}))
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='local'),))

    async with serving(project, catalog={}) as client:
        setup = (await client.get('/setup')).json()
        started = await client.post('/labs', json=start.model_dump(mode='json'))
        await until(lambda: len(posts(project)) == 1)

    assert [(harness['name'], harness['title'], harness['available']) for harness in setup['harnesses']] == [
        ('local', 'Local agent', True)
    ]
    assert started.status_code == 200
    assert posts(project)[0].post.author == 'agent-1'


async def test_a_mode_from_the_setup_reaches_the_agents_harness_and_its_record(project: Path, log: Path) -> None:
    start = StartRequest(question='Does it hold?', agents=(AgentChoice(harness='fake', mode='ask'),))

    async with serving(project, start):
        await until(lambda: len(posts(project)) == 1)

    joined = next(event.agent for event in record(project) if isinstance(event, AgentJoined))
    assert joined.mode == 'ask'
    assert [call['mode'] for call in calls(log) if call['event'] == 'mode' and call['agent'] == 'agent-1'] == ['ask']


async def test_a_harness_that_fails_its_probe_offers_nothing_and_stops_probing(project: Path) -> None:
    broken = FAKE_HARNESS.model_copy(
        update={'name': 'broken', 'command': (sys.executable, '-c', 'raise SystemExit(1)')}
    )

    async with serving(project, catalog={'broken': broken}) as client:
        setup = await probed_setup(client)

    assert setup['harnesses'] == [
        {'name': 'broken', 'title': 'Fake', 'family': 'test', 'available': True, 'probing': False, 'offer': None}
    ]


SEATS = [
    {'harness': 'fake', 'model': 'small', 'role': 'driver', 'coordinator': True},
    {'harness': 'fake', 'model': 'small-model', 'role': 'direction creator', 'on_call': True, 'family': 'other'},
    {'harness': 'fake', 'count': 2},
]
ON_CALL = StartRequest(
    question='Does it hold?',
    agents=(AgentChoice(harness='fake'), AgentChoice(harness='fake', model='small', on_call=True)),
)


def started(project: Path) -> set[str]:
    """Return the agents that have a turn in the record."""
    return {event.agent for event in record(project) if isinstance(event, TurnStarted)}


async def views(client: httpx2.AsyncClient) -> dict[str, AgentView]:
    return {view.agent.id: view for view in LabView.model_validate((await client.get('/lab')).json()).agents}


async def test_a_lab_starts_with_several_seats_of_one_harness_and_an_on_call_agent_starts_when_a_post_names_it(
    project: Path, log: Path
) -> None:
    async with serving(project, options=FAST) as client:
        await probed_setup(client)
        begun = await client.post('/labs', json={'question': 'Does it hold?', 'agents': SEATS})
        await until(lambda: len(posts(project)) == 3)
        # The person's words that name nobody are for every agent but the one on call.
        steer = await client.post('/posts', json={'kind': 'message', 'text': 'Look at the tail.', 'thread': 't-1'})
        heard = steer.json()['seq']
        await until(lambda: at_rest(project, ('agent-1', 'agent-3', 'agent-4'), after=heard), timeout=60)
        quiet, before = started(project), await views(client)
        prompted = {call['agent'] for call in calls(log) if call['event'] == 'prompt'}
        await client.post(
            '/posts', json={'kind': 'ask', 'text': 'A hard one.', 'thread': 't-1', 'mentions': ['agent-2']}
        )
        await until(lambda: turns_of(project, 'agent-2') == 1, timeout=60)
        after = await views(client)

    assert begun.status_code == 200
    joined = [event.agent for event in record(project) if isinstance(event, AgentJoined)]
    # The harness named its models when the setup asked, so each name holds the model's name from the first.
    assert [agent.name for agent in joined] == [
        'Fake · small',
        'Fake · small-model',
        'Fake · default',
        'Fake · default 2',
    ]
    assert [(agent.given_role, agent.model.family) for agent in joined[:3]] == [
        ('driver', 'test'),
        ('direction creator', 'other'),
        ('', 'test'),
    ]
    assert quiet == {'agent-1', 'agent-3', 'agent-4'}
    assert [(before[agent].on_call, before[agent].coordinator) for agent in ('agent-1', 'agent-2')] == [
        (False, True),
        (True, False),
    ]
    # No harness ran for the on-call agent, so it cost nothing, and the app shows it as idle.
    assert (before['agent-2'].turns, before['agent-2'].cost_usd, before['agent-2'].activity.state) == (
        0,
        None,
        'idle',
    )
    assert prompted == quiet
    first = next(call['text'] for call in calls(log) if call['event'] == 'prompt' and call['agent'] == 'agent-2')
    # Its first message holds the facts of the moment that it starts, and its seat.
    assert 'You are Fake · small-model (agent-2) in a Verifold lab. The lab is under way' in first
    assert 'The person gave your seat this role: direction creator' in first
    assert 'The person put your seat on call.' in first
    assert posts(project)[-1].post.author == 'agent-2'
    assert after['agent-2'].turns == 1
    start = next(event for event in record(project) if isinstance(event, TurnStarted) and event.agent == 'agent-2')
    assert (start.model, start.model_name) == ('small-model', 'small-model')


async def test_an_on_call_agent_that_was_never_called_has_no_turn_after_a_restart_and_starts_when_its_seat_comes_off_call(
    project: Path,
) -> None:
    async with serving(project, ON_CALL, {'fake': FAKE_HARNESS}):
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
    first_run = started(project)

    async with serving(project, catalog={'fake': FAKE_HARNESS}) as client:
        await client.post('/posts', json={'kind': 'message', 'text': 'Go on.', 'thread': 't-1'})
        resumed = (await views(client))['agent-2']
        switched = await client.post('/agents/agent-2/seat', json={'on_call': False})
        await until(lambda: 'agent-2' in started(project), timeout=60)
        missing = await client.post('/agents/agent-9/seat', json={'on_call': True})
        coordinator = await client.post('/agents/agent-2/seat', json={'coordinator': True})
        moved = await client.post('/agents/agent-1/seat', json={'coordinator': True})
        other = await client.post('/agents/agent-2/seat', json={'coordinator': False})
        cleared = await client.post('/agents/agent-1/seat', json={'coordinator': False})

    assert first_run == {'agent-1'}
    assert (resumed.on_call, resumed.turns, resumed.activity.state) == (True, 0, 'idle')
    assert (switched.status_code, missing.status_code) == (200, 404)
    holders = [
        [view['agent']['id'] for view in response.json()['agents'] if view['coordinator']]
        for response in (coordinator, moved, other, cleared)
    ]
    # One agent holds the seat at a time, and taking it from an agent that does not hold it changes nothing.
    assert holders == [['agent-2'], ['agent-1'], ['agent-1'], []]
    board = fold(record(project))
    assert not board.on_call('agent-2')
    # Nobody asked the harness for its models before the lab started, so the first turn of agent 1 named its model.
    renamed = [event for event in record(project) if isinstance(event, AgentNamed)]
    assert [(event.agent, event.name) for event in renamed] == [('agent-1', 'Fake · default')]
    assert [joined.agent.name for joined in board.agents] == ['Fake · default', 'Fake · small']
    assert [start.model for start in board.starts if start.agent == 'agent-1'][:1] == ['default']


async def test_an_on_call_agent_that_a_post_names_while_the_lab_is_out_of_time_starts_when_the_lab_has_time(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seated: list[tuple[str, bool]] = []
    seat = Host._seat

    async def watched(host: Host, lab: Lab, agent: Agent, start: str) -> tuple[Member, AgentSetup]:
        seated.append((agent.id, lab.board.out_of_time))
        return await seat(host, lab, agent, start)

    monkeypatch.setattr(Host, '_seat', watched)
    async with serving(project, ON_CALL, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: turns_of(project, 'agent-1') == 1, timeout=60)
        await client.post('/time', json={'minutes': 0})
        # The record says that the lab is out of time a moment after the person stops it. The ask comes after that.
        await until(lambda: any(isinstance(event, TimeRanOut) for event in record(project)))
        ask = {'kind': 'ask', 'text': 'A hard one.', 'thread': 't-1', 'mentions': ['agent-2']}
        assert (await client.post('/posts', json=ask)).status_code == 200
        idle = await state_of(client, 'agent-2')
        await client.post('/time', json={'minutes': 5})
        await until(lambda: turns_of(project, 'agent-2') == 1, timeout=60)

    # No harness starts for the agent while no turn can run. It starts once, when the lab has time again.
    assert idle == 'idle'
    assert [out_of_time for agent, out_of_time in seated if agent == 'agent-2'] == [False]


async def test_an_on_call_agent_whose_name_changed_while_it_waited_starts_with_its_name_of_now(
    project: Path, log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    labs: list[Lab] = []
    seated: list[str] = []
    seat = Host._seat

    async def watched(host: Host, lab: Lab, agent: Agent, start: str) -> tuple[Member, AgentSetup]:
        labs.append(lab)
        seated.append(agent.name)
        return await seat(host, lab, agent, start)

    monkeypatch.setattr(Host, '_seat', watched)
    async with serving(project, ON_CALL, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: turns_of(project, 'agent-1') == 1, timeout=60)
        # The record gives the waiting agent a new name before any post calls it.
        renamed = await labs[0].name_by_model('agent-2', 'Fake', 'Small v2')
        ask = {'kind': 'ask', 'text': 'A hard one.', 'thread': 't-1', 'mentions': ['agent-2']}
        await client.post('/posts', json=ask)
        await until(lambda: turns_of(project, 'agent-2') == 1, timeout=60)

    assert (renamed, seated[-1]) == ('Fake · Small v2', 'Fake · Small v2')
    assert 'You are Fake · Small v2 (agent-2) in a Verifold lab.' in prompts_of(log, 'agent-2')[0]


async def test_an_on_call_agent_that_cannot_start_does_not_stop_the_lab_and_the_person_starts_it_again(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    failed: list[str] = []
    seat = Host._seat

    async def broken_once(host: Host, lab: Lab, agent: Agent, start: str) -> tuple[Member, AgentSetup]:
        if agent.id == 'agent-2' and not failed:
            failed.append(agent.id)
            raise GitError('fatal: the worktree is gone')
        return await seat(host, lab, agent, start)

    monkeypatch.setattr(Host, '_seat', broken_once)
    async with serving(project, ON_CALL, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: turns_of(project, 'agent-1') == 1, timeout=60)
        ask = {'kind': 'ask', 'text': 'A hard one.', 'thread': 't-1', 'mentions': ['agent-2']}
        await client.post('/posts', json=ask)
        await until(lambda: turns_of(project, 'agent-2') == 1)
        stopped = (await views(client))['agent-2']
        again = await client.post('/agents/agent-2/start')
        # The ask still waits for the agent, so it starts at once.
        await until(lambda: turns_of(project, 'agent-2') == 2, timeout=60)
        started_again = (await views(client))['agent-2']

    entry = next(turn for turn in turns(project) if turn.agent == 'agent-2')
    assert (entry.error, entry.stopped, entry.no_turn) == (
        "Verifold can't start Fake · small: fatal: the worktree is gone",
        True,
        True,
    )
    # The member list says why, and the person starts the agent again from there.
    assert (stopped.stopped, stopped.error, stopped.activity.state) == (True, entry.error, 'stopped')
    assert (again.status_code, started_again.error, started_again.stopped) == (200, None, False)
    assert 'agent-2' in started(project)


async def test_the_person_adds_an_on_call_seat_and_invites_an_agent_with_the_facts_of_its_seat(project: Path) -> None:
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'),))
    seat = {'harness': 'fake', 'model': 'small', 'effort': 'low', 'role': 'lit review', 'on_call': True}

    async with serving(project, start, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
        added = await client.post('/agents', json=seat)
        invite = {'name': 'Reader', 'role': 'reads papers', 'family': 'openai', 'coordinator': True, 'on_call': True}
        invited = (await client.post('/invitations', json=invite)).json()
        plain = (await client.post('/invitations', json={})).json()
        lab = await views(client)
        # The person removes the on-call agent before any post called it, so no harness ever starts for it.
        removed = await client.delete('/agents/agent-2')
        await client.post('/posts', json={'kind': 'message', 'text': 'Go on.', 'thread': 't-1'})
        gone = (await views(client))['agent-2']

    assert added.status_code == 200
    assert (removed.status_code, gone.left is not None, gone.turns) == (200, True, 0)
    assert (lab['agent-2'].agent.name, lab['agent-2'].on_call, lab['agent-2'].turns) == (
        'Fake · small',
        True,
        0,
    )
    assert lab['agent-2'].agent.model == ModelSpec(family='test', name='small', effort='low')
    assert 'agent-2' not in started(project)
    reader = lab['agent-3']
    assert (reader.agent.given_role, reader.agent.model.family) == ('reads papers', 'openai')
    assert (reader.on_call, reader.coordinator) == (True, True)
    _, _, folder = invited_parts(invited['text'])
    assert folder == project / '.verifold' / 'agents' / 'agent-3'
    assert 'The person gave your seat this role: reads papers' in invited['text']
    assert "You hold the lab's coordinator seat." in invited['text']
    # Verifold never starts an invited agent, and its invitation does not say that it does.
    assert ON_CALL_FACT in invited['text']
    assert 'Verifold starts you' not in invited['text']
    # An invitation without facts is as before: a numbered name, and a family that nobody knows.
    assert (plain['name'], lab['agent-4'].agent.model.family, lab['agent-4'].on_call) == (
        'Agent 4',
        'unknown',
        False,
    )


async def test_a_lab_that_is_served_again_asks_the_harnesses_when_the_person_opens_the_form_and_asks_each_once(
    project: Path, log: Path
) -> None:
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'),))

    async with serving(project, start, {'fake': FAKE_HARNESS}) as client:
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
        before = (await client.get('/setup')).json()['harnesses'][0]
        asking = (await client.post('/offers', json={})).json()['harnesses'][0]
        await probed_setup(client)
        after = (await client.get('/setup')).json()['harnesses']
        again = (await client.post('/offers', json={})).json()['harnesses'][0]
        await asyncio.sleep(0.2)

    assert (before['offer'], before['probing'], asking['probing']) == (None, False, True)
    assert [model['value'] for model in after[0]['offer']['models']] == ['default', 'small', 'small-model']
    assert again['probing'] is False
    # The probe runs in the project folder, which the fake agent takes for its name.
    assert len([call for call in calls(log) if call['agent'] == project.name and call['event'] == 'new_session']) == 1


def test_a_checker_comes_from_each_harness_and_family_that_a_seat_states() -> None:
    def seat(number: int, family: str, model: str | None = None) -> Agent:
        return Agent(
            id=f'agent-{number}', name=f'Agent {number}', harness='fake', model=ModelSpec(family=family, name=model)
        )

    crew = _crew(
        (seat(1, 'test', 'small'), seat(2, 'test'), seat(3, 'other', 'small-model')),
        {'fake': FAKE_HARNESS},
        auto_mode=True,
    )

    assert [(entry.name, entry.family, options.model) for entry, options in crew] == [
        ('fake', 'test', 'small'),
        ('fake', 'other', 'small-model'),
    ]
    # A family is the same whatever its capitals. An on-call seat gives its model only when no other seat has its family.
    spared = _crew(
        (seat(1, 'test', 'strong'), seat(2, ' Test ', 'small'), seat(3, 'other', 'strong')),
        {'fake': FAKE_HARNESS},
        auto_mode=True,
        on_call=frozenset({'agent-1', 'agent-3'}),
    )
    assert [(entry.family, options.model) for entry, options in spared] == [(' Test ', 'small'), ('other', 'strong')]


@pytest.mark.usefixtures('log')
async def test_the_person_opens_the_folders_of_the_labs_agents_and_gets_the_path_when_nothing_opens(
    project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The stand-in for the file manager writes down the folder that it got.
    seen, script = tmp_path / 'opened.txt', tmp_path / 'opener'
    script.write_text(f'#!/bin/sh\necho "$1" >> {seen}\n')
    script.chmod(0o755)
    monkeypatch.setattr('verifold.runner.folders.OPENERS', {sys.platform: str(script)})
    start = StartRequest(question='Is it faster?', agents=(AgentChoice(harness='fake'),))
    agents = project / '.verifold' / 'agents'

    async with serving(project) as client:
        no_lab = await client.post('/folder', json={})
    async with serving(project, start, CATALOG) as client:
        await until(lambda: any(isinstance(event, TurnEnded) for event in record(project)), timeout=60)
        every = (await client.post('/folder', json={})).json()
        one = (await client.post('/folder', json={'agent': 'agent-1'})).json()
        unknown = await client.post('/folder', json={'agent': 'agent-9'})
        monkeypatch.setattr('verifold.runner.folders.OPENERS', {})
        no_opener = (await client.post('/folder', json={'agent': 'agent-1'})).json()
        # A folder that is gone, or that became a link to another place, is not opened, and the lab says which one.
        monkeypatch.setattr('verifold.runner.folders.OPENERS', {sys.platform: str(script)})
        agents.rename(tmp_path / 'moved')
        gone = await client.post('/folder', json={})
        agents.symlink_to(tmp_path / 'moved', target_is_directory=True)
        linked = await client.post('/folder', json={'agent': 'agent-1'})
        agents.unlink()
        (tmp_path / 'moved').rename(agents)
    monkeypatch.setattr('verifold.runner.folders.OPENERS', {sys.platform: str(script)})
    async with serving(project, options=ServeOptions(desktop=False)) as client:
        no_desktop = (await client.post('/folder', json={})).json()

    real = agents.resolve()
    assert no_lab.status_code == 409
    assert every == {'path': str(real), 'opened': True}
    assert one == {'path': str(real / 'agent-1'), 'opened': True}
    assert seen.read_text().splitlines() == [str(real), str(real / 'agent-1')]
    assert (unknown.status_code, unknown.json()['detail']) == (404, 'The lab has no agent with the ID agent-9.')
    assert no_opener == {'path': str(real / 'agent-1'), 'opened': False}
    assert (gone.status_code, gone.json()['detail']) == (404, f'{real} is not a folder on this computer.')
    assert (linked.status_code, linked.json()['detail']) == (
        404,
        f'{real / "agent-1"} is a link to another place, so Verifold does not open it.',
    )
    assert no_desktop == {'path': str(real), 'opened': False}
