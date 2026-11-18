import asyncio
import inspect
import time
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import override

import httpx2
import pytest
from builders import RecordBuilder, until
from conftest import agent
from pydantic import SecretStr

from verifold.protocol.agents import Agent, AgentChoice, ModelSpec, Picture
from verifold.protocol.app import (
    FolderView,
    HarnessOption,
    Invitation,
    InviteRequest,
    NormsChange,
    NormsFile,
    NormsView,
    SeatChange,
    SettingsChange,
    SettingsFileView,
    SettingsView,
    SetupView,
    StartRequest,
)
from verifold.protocol.events import Posted, TurnSummary
from verifold.protocol.ids import PERSON
from verifold.protocol.join import FileText, PostRequest
from verifold.protocol.moves import AddSeat
from verifold.protocol.posts import Ask, FileEvidence, Objection, PermissionShown, Result
from verifold.protocol.settings import Settings
from verifold.protocol.usage import DiskUse, Usage
from verifold.server import status as status_module
from verifold.server.activity import Activity
from verifold.server.app_api import _changes, _lab_view, app_api
from verifold.server.errors import LabExists, NoLab, SetupRejected
from verifold.server.lab import Build, Lab
from verifold.server.member import Member
from verifold.society import board as board_module
from verifold.society.board import Board
from verifold.society.errors import NotFound
from verifold.store.errors import (
    NormsChanged,
    NormsUnreadable,
    SettingsChanged,
    SettingsInvalid,
    SettingsUnwritable,
)
from verifold.store.record_file import RecordFile

TOKEN = 'person-secret'
START = {'question': 'Is it faster?', 'agents': [{'harness': 'fake', 'count': 2}]}


class Host:
    """A stand-in for the process that runs the folder's lab. It records each start request."""

    def __init__(self, lab: Lab | None) -> None:
        self.lab = lab
        self.started: list[StartRequest] = []
        self.added: list[AgentChoice] = []
        self.invited: list[str | None] = []
        self.norms_text = '# Norms'
        self.requests: list[InviteRequest] = []
        self.seats: list[tuple[str, SeatChange]] = []
        self.asked = 0

    def setup(self) -> SetupView:
        harnesses = (HarnessOption(name='fake', title='Fake', family='test', available=True),)
        question = self.lab.board.question if self.lab else None
        return SetupView(folder='~/code/sort-bench', harnesses=harnesses, question=question)

    async def start(self, request: StartRequest) -> None:
        if self.lab:
            raise LabExists('This folder has a lab already.')
        if request.agents[0].harness != 'fake':
            raise SetupRejected('Unknown harness nope.')
        self.started.append(request)

    def settings(self) -> SettingsView:
        def level(path: str) -> SettingsFileView:
            return SettingsFileView(path=path, values={}, revision='', settings=Settings())

        lab = self.lab.board.settings if self.lab else None
        return SettingsView(
            all_projects=level('~/.verifold/settings.json'), project=level('.verifold/settings.json'), lab=lab
        )

    async def change_settings(self, change: SettingsChange) -> SettingsView:
        if change.revisions.project == 'old':
            raise SettingsChanged('.verifold/settings.json changed since you opened the settings.')
        if change.value == 'later':
            raise SettingsInvalid('.verifold/settings.json is not valid settings: later.')
        if change.value == 'full':
            raise SettingsUnwritable("Can't write .verifold/settings.json: No space left on device")
        return self.settings()

    def norms(self) -> NormsView:
        if self.norms_text == 'a link':
            raise NormsUnreadable('.verifold/LAB.md is a link. Verifold reads only a regular file here.')
        file = NormsFile(name='LAB.md', path='.verifold/LAB.md', text=self.norms_text, saved=True, revision='r1')
        return NormsView(files=(file,))

    async def change_norms(self, change: NormsChange) -> NormsView:
        if change.revision != 'r1':
            raise NormsChanged('.verifold/LAB.md changed since you opened it. This is its new text.')
        if change.text == 'full':
            raise SettingsUnwritable("Can't write .verifold/LAB.md: No space left on device")
        self.norms_text = change.text
        return self.norms().model_copy(update={'told': 'p-9'})

    async def add_seat(self, seat: AddSeat, first: tuple[Build, ...], asked_by: str) -> None:
        raise SetupRejected(f'This stand-in starts no agent for {asked_by}: {seat.harness}, {len(first)}.')

    async def add_agents(self, choice: AgentChoice) -> None:
        if choice.harness != 'fake':
            raise SetupRejected('Unknown harness nope.')
        self.added.append(choice)

    async def change_seat(self, agent_id: str, change: SeatChange) -> None:
        if self.lab is None or self.lab.board.agent(agent_id) is None:
            raise NotFound(f'The lab has no agent with the ID {agent_id}.')
        self.seats.append((agent_id, change))

    def ask_harnesses(self) -> SetupView:
        self.asked += 1
        return self.setup()

    async def invite(self, request: InviteRequest | None = None) -> Invitation:
        request = request or InviteRequest()
        name = request.name
        self.requests.append(request)
        if self.lab is None:
            raise NoLab('This folder has no lab yet. Start one from the setup screen.')
        if name == 'Ada':
            raise SetupRejected('The lab has the name Ada already. Choose another name.')
        self.invited.append(name)
        return Invitation(agent='agent-3', name=name or 'Agent 3', text='URL: http://127.0.0.1:1/mcp')

    async def invite_again(self, agent_id: str) -> Invitation:
        if agent_id != 'agent-3':
            raise NotFound(f'The lab has no invited agent with the ID {agent_id}.')
        return Invitation(agent=agent_id, name='Agent 3', text='URL: http://127.0.0.1:1/mcp\nnew token')

    async def start_again(self, agent_id: str) -> None:
        if agent_id != 'bo':
            raise SetupRejected('Verifold did not stop Ada, so it needs no new start.')

    async def open_folder(self, agent_id: str | None = None) -> FolderView:
        if agent_id not in {None, 'ada'}:
            raise NotFound(f'The lab has no agent with the ID {agent_id}.')
        return FolderView(path=f'/project/.verifold/agents/{agent_id or ""}'.rstrip('/'), opened=agent_id is None)

    async def file_text(self, post_id: str, path: str) -> FileText:
        if path != 'answer.md':
            raise NotFound(f'Post {post_id} names no file {path}.')
        return FileText(path=path, commit='c' * 40, text='# The answer')


@pytest.fixture
def activity() -> Activity:
    return Activity()


def client_of(host: Host, activity: Activity) -> httpx2.AsyncClient:
    transport = httpx2.ASGITransport(app=app_api(host, activity, SecretStr(TOKEN)))
    headers = {'Authorization': f'Bearer {TOKEN}'}
    return httpx2.AsyncClient(transport=transport, base_url='http://lab', headers=headers)


@pytest.fixture
async def client(lab: Lab, activity: Activity) -> AsyncIterator[httpx2.AsyncClient]:
    async with client_of(Host(lab), activity) as client:
        yield client


async def test_the_setup_screen_starts_a_lab_once_and_refuses_unknown_harnesses(activity: Activity) -> None:
    host = Host(None)
    async with client_of(host, activity) as client:
        setup = (await client.get('/setup')).json()
        no_lab = await client.get('/lab')
        unknown = await client.post('/labs', json={**START, 'agents': [{'harness': 'nope'}]})
        started = await client.post('/labs', json=START)
        empty = await client.post('/labs', json={**START, 'question': '  '})

    assert setup['folder'] == '~/code/sort-bench'
    assert setup['harnesses'] == [
        {'name': 'fake', 'title': 'Fake', 'family': 'test', 'available': True, 'probing': False, 'offer': None}
    ]
    assert (no_lab.status_code, no_lab.json()['detail']) == (
        409,
        'This folder has no lab yet. Start one from the setup screen.',
    )
    assert (unknown.status_code, unknown.json()['detail']) == (400, 'Unknown harness nope.')
    assert started.status_code == 200
    assert empty.status_code == 422
    assert host.started == [StartRequest.model_validate(START)]


class BrokenSettingsHost(Host):
    """A host whose settings file is broken."""

    @override
    async def start(self, request: StartRequest) -> None:
        raise SettingsInvalid('~/code/sort-bench/.verifold/settings.json is not valid settings: not JSON.')


async def test_a_broken_settings_file_comes_back_as_a_readable_refusal(activity: Activity) -> None:
    async with client_of(BrokenSettingsHost(None), activity) as client:
        refused = await client.post('/labs', json=START)

    assert refused.status_code == 400
    assert 'settings.json is not valid settings' in refused.json()['detail']


async def test_settings_pass_through_and_refusals_say_why(client: httpx2.AsyncClient) -> None:
    revisions = {'project': '', 'all_projects': ''}
    change = {'level': 'project', 'key': 'jobs.at_exit', 'value': 'keep', 'revisions': revisions}

    view = (await client.get('/settings')).json()
    changed = await client.post('/settings', json=change)
    stale = await client.post('/settings', json={**change, 'revisions': {**revisions, 'project': 'old'}})
    invalid = await client.post('/settings', json={**change, 'value': 'later'})
    unwritable = await client.post('/settings', json={**change, 'value': 'full'})
    # The app changes job settings only, so it can't put a command in a harness entry.
    command = {'command': ['/bin/sh', '-c', 'true'], 'family': 'anthropic'}
    harness = await client.post('/settings', json={**change, 'key': 'harnesses.claude-code', 'value': command})

    assert view['lab'] == {
        'version': 1,
        'jobs': {'at_time_limit': 'pause', 'at_exit': 'stop'},
        'permissions': {'while_you_decide': 'auto'},
        'reviewers': {'seats': None},
        'votes': {'reveal_minutes': 10},
        'reruns': {'lease_minutes': 10},
        'disk': {'limit_gb': 100},
    }
    assert view['project']['path'] == '.verifold/settings.json'
    assert changed.status_code == 200
    assert (stale.status_code, invalid.status_code, harness.status_code) == (409, 400, 422)
    assert 'changed since you opened the settings' in stale.json()['detail']
    assert (unwritable.status_code, unwritable.json()['detail']) == (
        500,
        "Can't write .verifold/settings.json: No space left on device",
    )


async def test_the_person_reads_and_saves_the_norms_by_name_and_never_by_path(activity: Activity) -> None:
    host = Host(None)
    async with client_of(host, activity) as client:
        read = await client.get('/norms')
        saved = await client.post('/norms', json={'name': 'LAB.md', 'text': '# Ours', 'revision': 'r1'})
        stale = await client.post('/norms', json={'name': 'LAB.md', 'text': '# Ours', 'revision': 'r0'})
        unnamed = await client.post('/norms', json={'name': 'LAB.md', 'text': '# Ours'})
        other = await client.post('/norms', json={'name': '../settings.json', 'text': '{}', 'revision': 'r1'})
        path = await client.post(
            '/norms', json={'name': 'LAB.md', 'path': '/etc/passwd', 'text': 'x', 'revision': 'r1'}
        )
        large = await client.post('/norms', json={'name': 'WRITING.md', 'text': 'x' * 100_001, 'revision': 'r1'})
        full = await client.post('/norms', json={'name': 'LAB.md', 'text': 'full', 'revision': 'r1'})
        host.norms_text = 'a link'
        link = await client.get('/norms')

    assert read.json()['files'] == [
        {
            'name': 'LAB.md',
            'path': '.verifold/LAB.md',
            'text': '# Norms',
            'saved': True,
            'revision': 'r1',
            'error': None,
            'changed_at': None,
            'changed_by': None,
            'missing': [],
        }
    ]
    assert (read.json()['told'], read.json()['no_post']) == (None, None)
    # A save names the revision that the person read. One from an older read is refused, and so is one with none.
    assert (stale.status_code, unnamed.status_code) == (409, 422)
    assert 'changed since you opened it' in stale.json()['detail']
    assert (saved.status_code, saved.json()['told'], saved.json()['files'][0]['text']) == (200, 'p-9', '# Ours')
    # The request names one of two files. Another name, a path, or a text that is too long changes nothing.
    assert (other.status_code, path.status_code, large.status_code) == (422, 422, 422)
    assert (full.status_code, full.json()['detail']) == (500, "Can't write .verifold/LAB.md: No space left on device")
    assert (link.status_code, 'is a link' in link.json()['detail']) == (400, True)


async def test_a_folder_with_a_lab_refuses_another(client: httpx2.AsyncClient) -> None:
    setup = (await client.get('/setup')).json()
    refused = await client.post('/labs', json=START)

    assert setup['question'] == 'Does it hold?'
    assert (refused.status_code, refused.json()['detail']) == (409, 'This folder has a lab already.')


async def test_every_request_needs_the_persons_token(lab: Lab, activity: Activity) -> None:
    transport = httpx2.ASGITransport(app=app_api(Host(lab), activity, SecretStr(TOKEN)))
    async with httpx2.AsyncClient(transport=transport, base_url='http://lab') as anonymous:
        refused = await anonymous.get('/lab')
        wrong = await anonymous.get('/lab', headers={'Authorization': 'Bearer nope'})
        by_query = await anonymous.get('/lab', params={'token': TOKEN})
        norms = await anonymous.post('/norms', json={'name': 'LAB.md', 'text': '# Theirs', 'revision': 'r1'})

    assert (refused.status_code, wrong.status_code, by_query.status_code) == (401, 401, 200)
    assert norms.status_code == 401


async def test_the_lab_view_shows_each_agents_activity_and_cost(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity
) -> None:
    await activity.set('ada', 'working', 'Run pytest')
    await lab.set_profile('ada', 'theory', 'Deriving the bound.')
    usage = Usage(input_tokens=100, cached_input_tokens=60, output_tokens=7)
    await lab.end_turn(TurnSummary(agent='ada', seconds=3, usage=usage, cost_usd=0.25))
    await lab.end_turn(TurnSummary(agent='ada', seconds=2, usage=usage, cost_usd=0.5))

    view = (await client.get('/lab')).json()

    assert view['question'] == 'Does it hold?'
    ada, bo = view['agents']
    assert (ada['activity']['state'], ada['activity']['detail'], ada['turns'], ada['posts']) == (
        'working',
        'Run pytest',
        2,
        1,
    )
    assert ada['usage'] == {'input_tokens': 200, 'cached_input_tokens': 120, 'output_tokens': 14}
    assert ada['cost_usd'] == pytest.approx(0.75)
    # Nothing reported for bo, so no loop runs it: it shows as idle, not as starting.
    assert (bo['activity']['state'], bo['need'], bo['in_turn'], bo['cost_usd']) == ('idle', 'idle', False, None)
    await activity.set('bo', 'starting')
    (started,) = [view for view in (await client.get('/lab')).json()['agents'] if view['agent']['id'] == 'bo']
    assert (started['activity']['state'], started['need'], started['in_turn']) == ('starting', 'working', True)
    # Ada opened the lab's thread with a result, so that is where she works.
    assert (ada['role'], ada['status'], ada['thread']) == ('theory', 'Deriving the bound.', 't-1')
    assert (bo['role'], bo['status'], bo['thread']) == ('', '', None)
    assert (view['state'], view['close'], view['close_agreed']) == ('open', None, 0)

    await lab.post(PostRequest(kind='close', text='The answer stands.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-2', accepts=True), 'bo')
    done = (await client.get('/lab')).json()
    assert (done['state'], done['close']['id'], done['close_agreed']) == ('closed', 'p-2', 1)


async def test_the_lab_view_says_when_an_agent_ended_its_turn_and_when_its_alarm_rings(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    async def views() -> tuple[tuple[str | None, str | None], ...]:
        agents = (await client.get('/lab')).json()['agents']
        return tuple((view['turn_ended_at'], view['alarm'] and view['alarm']['rings_at']) for view in agents)

    assert await views() == ((None, None), (None, None))

    ended = await lab.end_turn(TurnSummary(agent='ada', seconds=3, usage=Usage()))
    # A harness that fails outside a turn ends no turn.
    await lab.end_turn(TurnSummary(agent='ada', seconds=0, usage=Usage(), error='It did not start.', no_turn=True))
    set_ = await lab.set_alarm('ada', 10, quiet=False)
    rings = (set_.at + timedelta(minutes=10)).isoformat().replace('+00:00', 'Z')
    assert await views() == ((ended.at.isoformat().replace('+00:00', 'Z'), rings), (None, None))

    # No alarm rings while the lab is out of time, or closed.
    await lab.set_time_left(timedelta(0))
    await lab.run_out_of_time()
    held = (await client.get('/lab')).json()['agents'][0]['alarm']
    assert held == {'minutes': 10, 'quiet': False, 'rings_at': None}
    await lab.set_time_left(timedelta(hours=1))
    assert (await views())[0][1] == rings
    await lab.post(PostRequest(kind='close', text='The answer stands.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-2', accepts=True), 'bo')
    assert (await views())[0][1] is None


async def test_threads_and_a_thread_read_as_the_person(client: httpx2.AsyncClient) -> None:
    threads = (await client.get('/threads')).json()
    thread = (await client.get('/threads/t-1')).json()
    missing = await client.get('/threads/t-9')

    assert [(summary['thread']['id'], summary['latest']['text']) for summary in threads] == [('t-1', 'Beats random.')]
    assert [item['post']['text'] for item in thread['posts']] == ['Beats random.']
    assert (missing.status_code, missing.json()['detail']) == (404, 'No thread has the ID t-9.')


async def test_a_card_says_when_its_line_had_its_newest_result_and_the_lab_view_lists_every_obstacle(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    for text in ('No edge after fees.', 'No edge at night.', 'No edge on weekends.'):
        await lab.post(PostRequest(kind='ruled_out', text=text, thread='t-1'), 'bo')
    await lab.post(PostRequest(kind='plan', text='Maker side.', thread='t-1', builds_on=('p-3',)), 'ada')
    await lab.post(PostRequest(kind='result', text='Maker side pays.', thread='t-1', builds_on=('p-4',)), 'ada')

    (card,) = (await client.get('/threads')).json()
    obstacles = (await client.get('/lab')).json()['obstacles']
    at = {entry.post.id: entry.at.isoformat().replace('+00:00', 'Z') for entry in lab.board.posts}

    # The card has the times of the line's newest result and plan, and the minutes since them by the lab's clock.
    assert (card['last_result_at'], card['last_plan_at']) == (at['p-6'], at['p-5'])
    assert (card['result_minutes_ago'], card['plan_minutes_ago'], card['open_obstacles']) == (0, 0, 1)
    # The newest first, each with who posted it, when, where it stands as a post, and the posts that build on it.
    assert [
        (item['post']['id'], item['state'], item['standing'], [one['id'] for one in item['builders']])
        for item in obstacles
    ] == [('p-4', 'removed', 'open', ['p-6']), ('p-3', 'taken_up', 'open', ['p-5']), ('p-2', 'open', 'open', [])]
    assert (obstacles[2]['post']['author'], obstacles[2]['at']) == ('bo', at['p-2'])


async def test_the_person_opens_a_round_and_reads_each_entry_as_it_comes_and_then_the_close(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    opened = await client.post(
        '/posts', json={'kind': 'round', 'text': 'Best bet?', 'new_thread': 'Best bet?', 'minutes': 5}
    )
    assert opened.status_code == 200
    question = opened.json()['post']
    first = (await client.get('/lab')).json()['round']
    assert (first['round']['post']['text'], first['open'], first['closed'], first['entries']) == (
        'Best bet?',
        True,
        None,
        [],
    )
    assert first['not_entered'] == ['ada', 'bo']
    assert first['closes_at'] == (lab.board.posts[-1].at + timedelta(minutes=5)).isoformat().replace('+00:00', 'Z')

    entry = PostRequest(kind='entry', text='Keep the cache.', thread=question['thread'], reply_to=question['id'])
    await lab.post(entry, 'bo')
    # The person reads the entry whole while the round is open.
    second = (await client.get('/lab')).json()['round']
    assert ([item['post']['text'] for item in second['entries']], second['not_entered']) == (
        ['Keep the cache.'],
        ['ada'],
    )
    await lab.post(entry.model_copy(update={'text': 'Drop the night runs.'}), 'ada')
    last = (await client.get('/lab')).json()['round']
    assert (last['open'], last['closed']['why'], last['not_entered']) == (False, 'entered', [])
    # The person enters no round.
    refused = await client.post('/posts', json=entry.model_dump(mode='json', exclude_defaults=True))
    assert refused.status_code == 400


async def test_the_person_reads_a_side_thread_and_posts_in_it(client: httpx2.AsyncClient, lab: Lab) -> None:
    await lab.post(
        PostRequest(kind='message', text='Can you fetch it?', new_thread='Scoreboard', between=('bo',)), 'ada'
    )

    threads = (await client.get('/threads')).json()
    posted = await client.post('/posts', json={'kind': 'message', 'text': 'Use the public one.', 'thread': 't-2'})
    thread = (await client.get('/threads/t-2')).json()
    refused = await client.post(
        '/posts', json={'kind': 'message', 'text': 'Hello.', 'new_thread': 'A word', 'between': ['bo']}
    )

    assert [(summary['thread']['id'], summary['thread']['between'], summary['members']) for summary in threads] == [
        ('t-2', ['ada', 'bo'], ['ada', 'bo']),
        ('t-1', [], []),
    ]
    assert posted.status_code == 200
    assert (thread['members'], [item['post']['author'] for item in thread['posts']]) == (
        ['ada', 'bo'],
        ['ada', 'person'],
    )
    assert (refused.status_code, 'at least one other agent' in refused.json()['detail']) == (400, True)


async def test_the_person_posts_and_gets_a_readable_refusal(client: httpx2.AsyncClient) -> None:
    posted = await client.post('/posts', json={'kind': 'message', 'text': 'Try sorted data too.', 'thread': 't-1'})
    refused = await client.post(
        '/posts', json={'kind': 'objection', 'text': 'Wrong.', 'thread': 't-1', 'reply_to': 'p-9'}
    )

    assert (posted.status_code, posted.json()['post']['author']) == (200, 'person')
    assert (refused.status_code, refused.json()['detail']) == (400, 'Post p-9 does not exist.')


async def test_the_person_posts_a_headline_of_1000_characters_which_is_more_than_a_tool_takes_from_an_agent(
    client: httpx2.AsyncClient,
) -> None:
    posted = await client.post('/posts', json={'kind': 'message', 'text': 'x' * 1000, 'thread': 't-1'})
    refused = await client.post('/posts', json={'kind': 'message', 'text': 'x' * 1001, 'thread': 't-1'})

    assert (posted.status_code, len(posted.json()['post']['text'])) == (200, 1000)
    assert refused.status_code == 422
    assert 'The headline has 1001 characters, and the limit is 1000. `body` takes the detail' in refused.text


async def test_the_person_reads_why_a_post_failed_when_another_program_changed_the_record(
    client: httpx2.AsyncClient, record_file: RecordFile
) -> None:
    record_file.path.unlink()

    failed = await client.post('/posts', json={'kind': 'message', 'text': 'Try sorted data too.', 'thread': 't-1'})

    why = f'Another program replaced or removed the record {record_file.path}, so Verifold stops.'
    assert (failed.status_code, failed.json()['detail']) == (
        500,
        f'{why} What Verifold wrote is in {record_file.path.with_name("record.kept.jsonl")}.',
    )


async def test_the_report_route_gives_the_newest_report_or_nothing(client: httpx2.AsyncClient, lab: Lab) -> None:
    before = (await client.get('/report')).json()
    await lab.post(PostRequest(kind='report', text='Nothing trained yet.', thread='t-1'), 'bo')
    await lab.post(PostRequest(kind='report', text='The baseline is in.', body='Loss 0.39.', thread='t-1'), 'bo')

    after = (await client.get('/report')).json()

    assert before is None
    assert (after['post']['kind'], after['post']['text'], after['post']['body']) == (
        'report',
        'The baseline is in.',
        'Loss 0.39.',
    )


async def test_needs_you_lists_open_asks_to_the_person_until_answered(client: httpx2.AsyncClient, lab: Lab) -> None:
    await lab.post(PostRequest(kind='ask', text='Rent a GPU?', thread='t-1', mentions=('person',)), 'bo')

    open_asks = (await client.get('/needs')).json()
    await client.post('/posts', json={'kind': 'answer', 'text': 'Yes.', 'thread': 't-1', 'reply_to': 'p-2'})

    assert [item['post']['text'] for item in open_asks] == ['Rent a GPU?']
    assert (await client.get('/needs')).json() == []
    assert (await client.get('/lab')).json()['needs_you'] == 0


async def test_the_person_asks_for_a_rerun_of_a_post_with_evidence(client: httpx2.AsyncClient, lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)

    accepted = await client.post('/reruns', json={'post': 'p-2'})
    refused = await client.post('/reruns', json={'post': 'p-1'})

    assert (accepted.status_code, accepted.json()['by']) == (200, 'person')
    assert refused.status_code == 400
    assert 'no files as evidence' in refused.json()['detail']


async def test_the_event_stream_says_when_the_lab_or_an_agent_changes(lab: Lab, activity: Activity) -> None:
    changes = _changes(Host(lab), activity)
    first = asyncio.ensure_future(anext(changes))
    await asyncio.sleep(0.01)
    await activity.set('bo', 'working')
    second_activity = await first

    nxt = asyncio.ensure_future(anext(changes))
    await asyncio.sleep(0.01)
    await lab.post(PostRequest(kind='message', text='Hi.', thread='t-1'), 'bo')
    second_post = await nxt
    await changes.aclose()

    assert second_activity == {'event': 'change', 'data': f'{{"seq": {lab.board.seq - 1}, "activity": 1}}'}
    assert second_post['data'] == f'{{"seq": {lab.board.seq}, "activity": 1}}'


async def test_the_lab_view_says_which_post_of_the_person_reached_an_agent_and_the_stream_says_when_it_does(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity, record_file: RecordFile
) -> None:
    await lab.set_coordinator('bo', PERSON)
    bo = Member(lab, 'bo')
    activity.seat(bo)
    said = {'kind': 'message', 'text': 'Hi Bo,', 'body': 'Try the small models.', 'conversation': True}
    steer = (await client.post('/posts', json=said)).json()
    recorded = len(record_file.read())
    before = {view['agent']['id']: view['heard'] for view in (await client.get('/lab')).json()['agents']}
    changes = _changes(Host(lab), activity)
    change = asyncio.ensure_future(anext(changes))
    # The stream reads the activity's version when it starts, and the call comes after that.
    await until(lambda: inspect.getasyncgenstate(changes) == inspect.AGEN_RUNNING)

    # A result of bo's board tools carries the post, as the join endpoint runs each call.
    async with activity.call('bo', 'brief'):
        bo.news()
    told = await change
    await changes.aclose()
    after = {view['agent']['id']: view['heard'] for view in (await client.get('/lab')).json()['agents']}

    assert before == {'ada': None, 'bo': None}
    assert told == {'event': 'change', 'data': f'{{"seq": {lab.board.seq}, "activity": 1}}'}
    heard = after['bo']
    assert (after['ada'], heard['seq'], heard['whole'], heard['at'] > steer['at']) == (None, steer['seq'], True, True)
    # The app reads it from the server that runs. The record gets no event for it.
    assert len(record_file.read()) == recorded


async def test_before_a_lab_starts_the_event_stream_follows_the_activity(activity: Activity) -> None:
    changes = _changes(Host(None), activity)
    first = asyncio.ensure_future(anext(changes))
    await asyncio.sleep(0.01)
    await activity.set('agent-1', 'starting')
    change = await first
    await changes.aclose()

    assert change == {'event': 'change', 'data': '{"seq": 0, "activity": 1}'}


async def test_the_person_sets_how_long_the_agents_may_still_work(client: httpx2.AsyncClient, lab: Lab) -> None:
    stopping = (await client.post('/time', json={'minutes': 0})).json()
    await lab.run_out_of_time()
    out = (await client.get('/lab')).json()
    more = (await client.post('/time', json={'minutes': 30})).json()
    refused = await client.post('/time', json={'minutes': -1})

    assert (stopping['ends_at'] is not None, stopping['out_of_time'], out['out_of_time']) == (True, False, True)
    assert more['out_of_time'] is False
    assert lab.board.ends_at == lab.board.times[-1].at + timedelta(minutes=30)
    assert refused.status_code == 422


async def test_the_person_sets_the_budget_and_the_disk_limit_and_the_lab_shows_what_it_spent(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    await lab.end_turn(
        TurnSummary(agent='ada', seconds=1, usage=Usage(input_tokens=700, output_tokens=300), cost_usd=2)
    )
    before = (await client.get('/lab')).json()
    stopped = (await client.post('/budget', json={'tokens': 1_000, 'dollars': 5})).json()
    raised = (await client.post('/budget', json={'tokens': 4_000})).json()
    await lab.measured(DiskUse(at=lab.now(), folders={'ada': 3 * 1024**3}, total=3 * 1024**3))
    full = (await client.post('/disk', json={'limit_gb': 2})).json()
    none = (await client.post('/disk', json={'limit_gb': 0})).json()
    refused = await client.post('/budget', json={'tokens': 0})

    assert (before['budget']['spent_tokens'], before['budget']['spent_dollars'], before['limit']) == (1_000, 2, None)
    assert (stopped['limit'], stopped['budget']['tokens_left'], stopped['budget']['dollars_left']) == ('tokens', 0, 3)
    assert (raised['limit'], raised['budget']['tokens_left'], raised['budget']['dollars']) == (None, 3_000, None)
    assert (full['limit'], full['settings']['disk']['limit_gb'], full['disk']['total']) == ('disk', 2, 3 * 1024**3)
    assert (none['limit'], none['settings']['disk']['limit_gb']) == (None, 0)
    assert refused.status_code == 422


async def test_the_candidates_route_gives_the_candidate_answers_and_a_file_route_gives_a_files_text(
    record_file: RecordFile, activity: Activity
) -> None:
    lab = Lab.create(record_file, 'Does it hold?')
    await lab.open_question_thread()
    await lab.join(agent('bo'))
    async with client_of(Host(lab), activity) as client:
        before = (await client.get('/candidates')).json()
        await lab.post(PostRequest(kind='proposal', text='Yes, it holds.', thread='t-1'), 'bo')

        after = (await client.get('/candidates')).json()
        file = await client.get('/posts/p-1/file', params={'path': 'answer.md'})
        missing = await client.get('/posts/p-1/file', params={'path': 'other.md'})

    assert before == {'standing': [], 'gone': [], 'closes_on': None}
    (candidate,) = after['standing']
    assert (candidate['candidate']['post']['text'], candidate['builds_on'], after['closes_on']) == (
        'Yes, it holds.',
        [],
        None,
    )
    assert file.json()['text'] == '# The answer'
    assert (missing.status_code, missing.json()['detail']) == (404, 'Post p-1 names no file other.md.')


async def test_the_person_adds_an_agent_to_the_lab_that_runs(lab: Lab, activity: Activity) -> None:
    host = Host(lab)
    async with client_of(host, activity) as client:
        added = await client.post('/agents', json={'harness': 'fake', 'count': 2})
        refused = await client.post('/agents', json={'harness': 'nope'})

    assert added.status_code == 200
    assert [(choice.harness, choice.count) for choice in host.added] == [('fake', 2)]
    assert (refused.status_code, refused.json()['detail']) == (400, 'Unknown harness nope.')


async def test_the_person_adds_a_seat_with_its_facts_changes_a_seat_and_asks_the_harnesses(
    lab: Lab, activity: Activity
) -> None:
    host = Host(lab)
    seat = {'harness': 'fake', 'model': 'opus', 'role': ' direction\ncreator ', 'on_call': True, 'family': 'other'}
    async with client_of(host, activity) as client:
        added = await client.post('/agents', json=seat)
        two = await client.post('/agents', json={'harness': 'fake', 'count': 2, 'coordinator': True})
        long = await client.post('/agents', json={'harness': 'fake', 'role': 'r' * 41})
        changed = await client.post('/agents/ada/seat', json={'on_call': True})
        missing = await client.post('/agents/nobody/seat', json={'coordinator': True})
        offers = await client.post('/offers', json={})
        invited = await client.post('/invitations', json={'role': 'reads', 'family': 'openai', 'coordinator': True})

    assert (added.status_code, two.status_code, long.status_code) == (200, 422, 422)
    assert 'the seat of the coordinator has one agent' in str(two.json())
    # A role is one line, like the role that an agent gives itself.
    assert host.added == [
        AgentChoice(harness='fake', model='opus', role='direction creator', on_call=True, family='other')
    ]
    assert (changed.status_code, missing.status_code) == (200, 404)
    assert host.seats == [('ada', SeatChange(on_call=True))]
    assert (offers.status_code, offers.json()['question'], host.asked) == (200, 'Does it hold?', 1)
    assert invited.status_code == 200
    assert host.requests == [InviteRequest(role='reads', family='openai', coordinator=True)]


async def test_the_person_closes_and_opens_a_coordinator_seat_that_nobody_holds(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity
) -> None:
    await lab.set_coordinator('ada', 'ada')
    first = (await client.get('/lab')).json()
    closed = await client.post('/coordinator', json={'open': False})
    opened = await client.post('/coordinator', json={'open': True})
    async with client_of(Host(None), activity) as nowhere:
        no_lab = await nowhere.post('/coordinator', json={'open': True})

    # A seat with a holder is not open, and the person's clear takes the holder and closes the seat.
    assert (first['coordinator_open'], [view['coordinator'] for view in first['agents']]) == (False, [True, False])
    assert (closed.json()['coordinator_open'], [view['coordinator'] for view in closed.json()['agents']]) == (
        False,
        [False, False],
    )
    assert opened.json()['coordinator_open'] is True
    assert no_lab.status_code == 409
    assert [(entry.agent, entry.by, entry.open) for entry in lab.board.coordinators[1:]] == [
        (None, 'person', False),
        (None, 'person', True),
    ]


async def test_the_lab_view_says_why_an_agents_harness_failed_last(client: httpx2.AsyncClient, lab: Lab) -> None:
    refused = 'RequestError: The model fable-9 is not available.'
    await lab.end_turn(TurnSummary(agent='bo', seconds=0, usage=Usage(), error=refused, no_turn=True))
    await lab.end_turn(TurnSummary(agent='ada', seconds=1, usage=Usage(), error='It broke.'))
    await lab.end_turn(TurnSummary(agent='ada', seconds=1, usage=Usage()))

    ada, bo = (await client.get('/lab')).json()['agents']
    await lab.start_turn('bo', 'session-1', 3)
    again = (await client.get('/lab')).json()['agents'][1]

    # The person reads the harness's own words. A turn that ended well after a failure clears it, and so does
    # the start of a later turn.
    assert (ada['error'], bo['error'], again['error']) == (None, refused, None)


async def test_the_lab_view_says_who_is_on_call_who_coordinates_and_which_role_the_person_gave(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    await lab.join(agent('cy').model_copy(update={'given_role': 'driver'}), on_call=True, coordinator=True)
    await lab.set_profile('cy', 'theory', None)

    ada, _, cy = (await client.get('/lab')).json()['agents']

    assert (ada['on_call'], ada['coordinator'], ada['agent']['given_role']) == (False, False, '')
    assert (cy['on_call'], cy['coordinator'], cy['agent']['given_role'], cy['role']) == (True, True, 'driver', 'theory')


async def test_the_person_invites_an_agent_and_gets_its_invitation(lab: Lab, activity: Activity) -> None:
    host = Host(lab)
    async with client_of(host, activity) as client:
        plain = await client.post('/invitations', json={})
        named = await client.post('/invitations', json={'name': ' The\nreader '})
        taken = await client.post('/invitations', json={'name': 'Ada'})
        empty = await client.post('/invitations', json={'name': '  '})
        again = await client.post('/invitations/agent-3')
        launched = await client.post('/invitations/ada')
    async with client_of(Host(None), activity) as client:
        no_lab = await client.post('/invitations', json={})

    assert plain.json() == {'agent': 'agent-3', 'name': 'Agent 3', 'text': 'URL: http://127.0.0.1:1/mcp'}
    # A name is one line.
    assert (named.json()['name'], host.invited) == ('The reader', [None, 'The reader'])
    assert (taken.status_code, taken.json()['detail']) == (
        400,
        'The lab has the name Ada already. Choose another name.',
    )
    assert (empty.status_code, no_lab.status_code) == (422, 409)
    assert again.json()['text'].endswith('new token')
    assert (launched.status_code, launched.json()['detail']) == (404, 'The lab has no invited agent with the ID ada.')


async def test_the_person_starts_an_agent_that_verifold_stopped_and_the_lab_view_says_which_agent_stopped(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity
) -> None:
    await lab.end_turn(TurnSummary(agent='bo', seconds=0, usage=Usage(), error='It broke.', stopped=True))
    await activity.set('bo', 'stopped')

    started = await client.post('/agents/bo/start')
    refused = await client.post('/agents/ada/start')
    ada, bo = started.json()['agents']
    # The record says that the agent stopped until its next turn starts. The view follows the new start at once.
    await activity.set('bo', 'starting')
    _, again = (await client.get('/lab')).json()['agents']

    assert (started.status_code, ada['stopped'], bo['stopped'], again['stopped']) == (200, False, True, False)
    assert (refused.status_code, refused.json()['detail']) == (
        400,
        'Verifold did not stop Ada, so it needs no new start.',
    )


async def test_the_person_removes_an_agent_once_and_the_lab_view_shows_who_left(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    await lab.post(PostRequest(kind='plan', text='Sweep the layers.', new_thread='Layers'), 'bo')

    removed = await client.delete('/agents/bo', params={'reason': ' Off\nthe question. '})
    again = await client.delete('/agents/bo')
    unknown = await client.delete('/agents/zed')
    long = await client.delete('/agents/ada', params={'reason': 'x' * 201})
    ada, bo = removed.json()['agents']

    assert (removed.status_code, ada['left']) == (200, None)
    assert (bo['left']['by'], bo['left']['reason'], bo['thread'], bo['posts']) == (
        'person',
        'Off the question.',
        None,
        1,
    )
    assert (again.status_code, again.json()['detail']) == (400, 'Bo has left the lab already.')
    assert (unknown.status_code, unknown.json()['detail']) == (404, 'The lab has no agent with the ID zed.')
    assert (long.status_code, [entry.agent for entry in lab.board.left]) == (422, ['bo'])


async def test_the_lab_view_counts_a_close_among_the_agents_that_keep_their_word_and_drops_the_ask_of_a_gone_agent(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    await lab.post(PostRequest(kind='ask', text='May I use the GPU?', thread='t-1', mentions=('person',)), 'bo')
    await lab.post(PostRequest(kind='close', text='The answer stands.', thread='t-1'), 'ada')
    before = (await client.get('/lab')).json()

    await client.delete('/agents/ada')
    await client.delete('/agents/bo')
    after = (await client.get('/lab')).json()
    needs = (await client.get('/needs')).json()

    assert (before['state'], before['close_agreed'], before['close_among'], before['needs_you']) == ('closing', 0, 2, 1)
    # Ada keeps its word behind the close, and bo gave none, so one of one stands behind it.
    assert (after['state'], after['close_agreed'], after['close_among'], after['needs_you']) == ('closed', 0, 1, 0)
    assert needs == []


async def test_the_person_revises_the_question_and_the_lab_shows_every_version(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    revised = await client.post('/question', json={'question': ' Does it hold on ARM? ', 'note': 'x86 only so far.'})
    seq = lab.board.seq
    same = await client.post('/question', json={'question': 'Does it hold on ARM?'})
    empty = await client.post('/question', json={'question': '  '})
    stranger = await client.post('/question', json={'question': 'Why?'}, headers={'Authorization': 'Bearer no'})

    view = revised.json()
    assert view['question'] == 'Does it hold on ARM?'
    assert [(version['question'], version['note'], version['post']) for version in view['versions']] == [
        ('Does it hold?', '', None),
        ('Does it hold on ARM?', 'x86 only so far.', 'p-2'),
    ]
    # The same text records nothing.
    assert (same.status_code, same.json()['versions'], lab.board.seq) == (200, view['versions'], seq)
    assert (empty.status_code, stranger.status_code) == (422, 401)


async def test_a_folder_with_no_lab_takes_no_revision(activity: Activity) -> None:
    async with client_of(Host(None), activity) as client:
        refused = await client.post('/question', json={'question': 'Why?'})

    assert refused.status_code == 409


async def test_the_person_states_changes_and_removes_deliverables_and_no_other_caller_does(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    none = (await client.get('/lab')).json()['deliverables']
    added = await client.post('/deliverables', json={'text': ' A one-page\nanswer. '})
    await client.post('/deliverables', json={'text': 'A script that runs it again.'})
    changed = await client.post('/deliverables/d-1', json={'text': 'A two-page answer.'})
    seq = lab.board.seq
    same = await client.post('/deliverables/d-1', json={'text': 'A two-page answer.'})
    unchanged = lab.board.seq
    removed = await client.delete('/deliverables/d-2')
    empty = await client.post('/deliverables', json={'text': ' \n '})
    long = await client.post('/deliverables', json={'text': 'x' * 301})
    unknown = await client.post('/deliverables/d-9', json={'text': 'Something.'})
    gone = await client.delete('/deliverables/d-2')
    no_id = await client.delete('/deliverables/first')
    stranger = await client.post('/deliverables', json={'text': 'Mine.'}, headers={'Authorization': 'Bearer no'})

    assert none == []
    assert added.json()['deliverables'] == [
        {
            'id': 'd-1',
            'text': 'A one-page answer.',
            'state': 'none',
            'decided_at': None,
            'thread': None,
            'offers': [],
            'disputed': [],
            'open_asks': [],
        }
    ]
    assert [line['text'] for line in changed.json()['deliverables']] == [
        'A two-page answer.',
        'A script that runs it again.',
    ]
    # The same sentence again records nothing.
    assert (same.status_code, unchanged) == (200, seq)
    assert [line['id'] for line in removed.json()['deliverables']] == ['d-1']
    # A removed deliverable without offers has no thread to keep in reach.
    assert removed.json()['removed_deliverables'] == []
    assert [reply.status_code for reply in (empty, long, unknown, gone, no_id, stranger)] == [
        422,
        422,
        400,
        400,
        422,
        401,
    ]
    assert unknown.json()['detail'] == 'This lab has no deliverable d-9. `brief` lists the deliverables.'
    # A new deliverable and the first new sentence are posts of the person. The removal came in the same minute,
    # so it sent no post. The record keeps every sentence.
    assert [entry.post.author for entry in lab.board.posts[1:]] == ['person'] * 3
    assert removed.json()['deliverables_told_at'] == changed.json()['deliverables_told_at'] is not None
    assert added.json()['deliverables_told_at'] is None
    assert [entry.text for entry in lab.board.deliverables if entry.deliverable == 'd-1'] == [
        'A one-page answer.',
        'A two-page answer.',
    ]


async def test_the_person_accepts_an_offer_asks_for_changes_and_takes_an_acceptance_back(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    await client.post('/deliverables', json={'text': 'A one-page answer.'})
    evidence = (FileEvidence(path='answer.md', commit='c' * 40),)
    offer = (await lab.offer('ada', 'd-1', evidence, 'The answer.', 'It has **no** numbers yet.')).post.id
    offered = (await client.get('/lab')).json()['deliverables'][0]

    wordless = await client.post('/deliverables/d-1/decision', json={'decision': 'ask_changes', 'offer': offer})
    early = await client.post('/deliverables/d-1/decision', json={'decision': 'take_back', 'offer': offer})
    asked = await client.post(
        '/deliverables/d-1/decision', json={'decision': 'ask_changes', 'offer': offer, 'text': ' Add the numbers. '}
    )
    accepted = await client.post('/deliverables/d-1/decision', json={'decision': 'accept', 'offer': offer})
    twice = await client.post('/deliverables/d-1/decision', json={'decision': 'accept', 'offer': offer})
    other = await client.post('/deliverables/d-1/decision', json={'decision': 'accept', 'offer': 'p-1'})
    word = await client.post('/deliverables/d-1/decision', json={'decision': 'met', 'offer': offer})
    back = await client.post('/deliverables/d-1/decision', json={'decision': 'take_back', 'offer': offer})

    assert (offered['state'], offered['thread']) == ('offered', 't-3')
    assert offered['offers'] == [
        {
            'post': offer,
            'by': 'ada',
            'at': offered['offers'][0]['at'],
            'note': 'The answer.',
            'files': ['answer.md'],
            'revised': 0,
            'state': 'waiting',
            'decided_at': None,
            'standing': 'open',
            'disputed_by': None,
            'conceded_to': None,
            # The person decides about the offer where the app lists it, so the app's view has its detail.
            'body': 'It has **no** numbers yet.',
        }
    ]
    assert [reply.status_code for reply in (wordless, early, twice, other, word)] == [400, 400, 400, 400, 422]
    states = [reply.json()['deliverables'][0] for reply in (asked, accepted, back)]
    assert [line['state'] for line in states] == ['changes_asked', 'accepted', 'offered']
    assert [line['offers'][0]['state'] for line in states] == ['changes_asked', 'accepted', 'waiting']
    assert (states[0]['decided_at'] is not None, states[2]['decided_at']) == (True, None)
    said = [entry.post for entry in lab.board.posts if entry.post.author == 'person' and entry.post.reply_to == offer]
    assert [post.text for post in said] == [
        'Add the numbers.',
        'The person accepted these files for the deliverable d-1.',
        'The person took back the acceptance of these files for the deliverable d-1.',
    ]
    # The file of an offer opens as the file of any post does.
    file = await client.get(f'/posts/{offer}/file', params={'path': 'answer.md'})
    assert file.json()['text'] == '# The answer'


async def test_the_setup_takes_deliverables_and_a_folder_with_no_lab_takes_none(activity: Activity) -> None:
    host = Host(None)
    async with client_of(host, activity) as client:
        started = await client.post('/labs', json={**START, 'deliverables': [' A one-page answer. ', 'A script.']})
        many = await client.post('/labs', json={**START, 'deliverables': ['One more.'] * 21})
        empty = await client.post('/labs', json={**START, 'deliverables': ['']})
        refused = await client.post('/deliverables', json={'text': 'A script.'})

    assert [reply.status_code for reply in (started, many, empty, refused)] == [200, 422, 422, 409]
    assert host.started[0].deliverables == ('A one-page answer.', 'A script.')


async def test_the_person_opens_the_agents_folder_and_only_an_agent_of_the_lab_names_one(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity
) -> None:
    every = await client.post('/folder', json={})
    one = await client.post('/folder', json={'agent': 'ada'})
    unknown = await client.post('/folder', json={'agent': 'zed'})
    path = await client.post('/folder', json={'agent': '../../etc'})
    extra = await client.post('/folder', json={'path': '/etc'})
    async with client_of(Host(lab), activity) as stranger:
        stranger.headers.pop('Authorization')
        refused = await stranger.post('/folder', json={})

    assert every.json() == {'path': '/project/.verifold/agents', 'opened': True}
    assert one.json() == {'path': '/project/.verifold/agents/ada', 'opened': False}
    assert (unknown.status_code, unknown.json()['detail']) == (404, 'The lab has no agent with the ID zed.')
    # An agent's ID has no slash and no dot, and the request has no field for a path.
    assert (path.status_code, extra.status_code, refused.status_code) == (422, 422, 401)


async def test_the_lab_view_holds_each_agents_identity_status_and_what_waits_for_the_person(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity
) -> None:
    await lab.join(Agent(id='agent-3', name='Sorrel', harness='guest', model=ModelSpec(family='unknown')))
    await lab.set_profile('bo', role='builder', name='Tessel', about='I run a number twice.')
    await lab.set_profile('bo', picture=Picture(shape='hex', color='#f08c3a', symbol='orbit'))
    await lab.set_reviewer('bo', 'person', reviewer=True)
    await lab.start_turn('ada', 'session-1', 0, model_name='Opus 5.5')
    await activity.set('ada', 'working', 'Run pytest')
    await activity.set('bo', 'idle')
    await activity.invite('agent-3', 'invited')
    await lab.post(
        PostRequest(kind='ask', text='Permission needed', new_thread='Permission requests', mentions=('person',)),
        'ada',
        mark=PermissionShown(command='ls'),
    )
    await lab.post(PostRequest(kind='ask', text='May we read it?', thread='t-1', mentions=('person',)), 'bo')

    view = (await client.get('/lab')).json()

    ada, bo, guest = view['agents']
    assert (ada['agent']['name'], ada['seat'], ada['picture'], ada['need'], ada['turns'], ada['turns_started']) == (
        'Ada',
        'Ada',
        None,
        'approval',
        0,
        1,
    )
    assert (bo['agent']['name'], bo['seat'], bo['about'], bo['reviewer'], bo['need']) == (
        'Tessel',
        'Bo',
        'I run a number twice.',
        True,
        'answer',
    )
    assert bo['picture'] == {'shape': 'hex', 'color': '#f08c3a', 'symbol': 'orbit'}
    assert (ada['chosen_name'], bo['chosen_name'], guest['chosen_name']) == ('', 'Tessel', '')
    assert (guest['agent']['name'], guest['seat'], guest['need']) == (
        'Sorrel',
        'Own harness · model not reported',
        'idle',
    )
    assert [(wait['kind'], wait['agent'], wait['what'], wait['post'], wait['thread']) for wait in view['waits']] == [
        ('approval', 'ada', 'Asks to run a command', 'p-2', 't-2'),
        ('answer', 'bo', 'May we read it?', 'p-3', 't-1'),
    ]
    assert (view['needs_you'], view['thread_needs']) == (2, {'t-1': 'approval', 't-2': 'approval'})
    assert (view['reviewer_seats'], view['reviewer_seats_set']) == (0, None)
    assert bo['outcomes'] == {'built_on': [], 'held': [], 'refuted': [], 'open_asks': [{'id': 'p-3', 'thread': 't-1'}]}
    # A post in a thread shows who wrote it, with the seat's label when it is not the name.
    posts = (await client.get('/threads/t-1')).json()['posts']
    assert [post['by'] for post in posts] == [
        {'name': 'Ada', 'seat': '', 'marks': [], 'role': ''},
        {'name': 'Tessel', 'seat': 'Bo', 'marks': ['reviewer'], 'role': 'builder'},
    ]


async def test_the_person_takes_back_what_an_agent_chose_and_gives_its_seat_a_role(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    await lab.set_profile(
        'bo', name='Tessel', about='A lens.', picture=Picture(shape='hex', color='#f08c3a', symbol='orbit')
    )

    role = await client.post('/agents/bo/profile', json={'role': 'driver'})
    reset = await client.post(
        '/agents/bo/profile', json={'reset_name': True, 'reset_about': True, 'reset_picture': True, 'role': 'scout'}
    )
    missing = await client.post('/agents/nobody/profile', json={'role': 'driver'})
    long = await client.post('/agents/bo/profile', json={'role': 'x' * 41})

    assert (role.status_code, reset.status_code, missing.status_code, long.status_code) == (200, 200, 404, 422)
    (given,) = [view for view in role.json()['agents'] if view['agent']['id'] == 'bo']
    assert (given['given_role'], given['given_by'], given['agent']['name']) == ('driver', 'person', 'Tessel')
    (bo,) = [view for view in reset.json()['agents'] if view['agent']['id'] == 'bo']
    assert (bo['agent']['name'], bo['about'], bo['picture'], bo['given_role']) == ('Bo', '', None, 'scout')
    assert [(edit['by'], edit['part'], edit['before'], edit['after']) for edit in bo['edits']] == [
        ('person', 'role', '', 'driver'),
        ('person', 'name', 'Tessel', ''),
        ('person', 'about', 'A lens.', ''),
        ('person', 'picture', 'hex, #f08c3a, orbit', ''),
        ('person', 'role', 'driver', 'scout'),
    ]


async def test_the_person_sets_the_number_of_reviewer_seats_of_the_lab(client: httpx2.AsyncClient, lab: Lab) -> None:
    for name in ('cy', 'dee'):
        await lab.join(Agent(id=name, name=name.title(), harness='fake', model=ModelSpec(family='anthropic')))
    before = (await client.get('/lab')).json()
    seq = lab.board.seq

    three = await client.post('/reviewers', json={'seats': 3})
    same = await client.post('/reviewers', json={'seats': 3})
    after = lab.board.seq
    back = await client.post('/reviewers', json={'seats': None})
    many = await client.post('/reviewers', json={'seats': 21})

    assert (before['reviewer_seats'], before['reviewer_seats_set']) == (1, None)
    assert (three.json()['reviewer_seats'], three.json()['reviewer_seats_set'], after) == (3, 3, seq + 1)
    assert (same.json()['reviewer_seats'], back.json()['reviewer_seats'], back.json()['reviewer_seats_set']) == (
        3,
        1,
        None,
    )
    assert many.status_code == 422
    # The other settings of the lab stay as they are.
    assert lab.board.settings.jobs == Settings().jobs


async def test_an_agent_that_waits_for_more_time_or_its_own_process_is_in_no_turn_and_one_that_asks_the_person_is(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity
) -> None:
    await lab.join(Agent(id='cy', name='Cy', harness='fake', model=ModelSpec(family='anthropic')))
    await lab.set_time_left(timedelta(0))
    await lab.run_out_of_time()
    await activity.set('ada', 'waiting', 'The lab is out of time. The person can give it more.', 'time')
    await activity.set('bo', 'waiting', 'Waits for a process that it left running.', 'process')
    await activity.set('cy', 'waiting', 'Asks you: a permission', 'person')

    view = (await client.get('/lab')).json()

    # An out-of-time lab shows no agent as working, so the app shows that the lab is out of time.
    assert view['out_of_time'] is True
    assert [(agent['need'], agent['in_turn'], agent['activity']['waits_for']) for agent in view['agents']] == [
        ('idle', False, 'time'),
        ('idle', False, 'process'),
        ('working', True, 'person'),
    ]
    # An approval inside a turn that runs is still a turn that runs.
    ask = PostRequest(kind='ask', text='Permission needed', new_thread='Permission requests', mentions=('person',))
    await lab.post(ask, 'cy', mark=PermissionShown(command='ls'))
    (cy,) = [agent for agent in (await client.get('/lab')).json()['agents'] if agent['agent']['id'] == 'cy']
    assert (cy['need'], cy['in_turn']) == ('approval', True)


async def test_the_person_takes_back_the_name_of_an_agent_that_left_and_the_view_says_who_wrote_an_about_line(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    await lab.set_coordinator('ada', 'person')
    await lab.set_profile('bo', name='Overlord', about='I rule.')
    await lab.change_profile('bo', 'ada', about='Runs numbers twice.')
    written = (await client.get('/lab')).json()['agents']
    await lab.leave('bo', 'person')

    reset = await client.post('/agents/bo/profile', json={'reset_name': True, 'reset_about': True})
    role = await client.post('/agents/bo/profile', json={'role': 'driver'})

    assert [(view['about'], view['about_by']) for view in written] == [('', None), ('Runs numbers twice.', 'ada')]
    assert (reset.status_code, role.status_code) == (200, 400)
    bo = reset.json()['agents'][1]
    assert (bo['agent']['name'], bo['chosen_name'], bo['about'], bo['about_by'], bo['need']) == (
        'Bo',
        '',
        '',
        None,
        'left',
    )


def long_record(events: int) -> Board:
    """Return a board of fourteen agents with `events` events: results that build on each other, objections, and asks."""
    record = RecordBuilder()
    names = [f'agent-{number}' for number in range(1, 15)]
    for name in names:
        record.join(name)
    record.thread('t-1', opened_by='agent-1')
    results: list[str] = []
    authors: dict[str, str] = {}
    for number in range(1, events - 15):
        author, post = names[number % 14], f'p-{number}'
        if number % 3 == 0 and results:
            target = results[(number * 2_654_435_761 >> 7) % len(results)]
            other = names[(number + 1) % 14] if authors[target] == author else author
            record.post(Objection(id=post, thread='t-1', author=other, text='No.', reply_to=target))
        elif number % 3 == 1:
            record.post(Result(id=post, thread='t-1', author=author, text='Holds.', builds_on=tuple(results[-2:])))
            results.append(post)
            authors[post] = author
        else:
            record.post(Ask(id=post, thread='t-1', author=author, text='Who?', mentions=(names[(number + 3) % 14],)))
    board = record.board()
    assert board.seq == events
    return board


def test_the_lab_view_of_a_long_record_does_work_that_grows_with_the_record_and_not_with_its_square(
    activity: Activity, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The view once scanned every post for each result, and asked where each result stands twice: 0.31 seconds for
    # 3,000 events and 2.78 for 9,000. With the board's index it takes 0.02 and 0.11 seconds. A time on a shared
    # machine says little, so the test counts the work: how often the view builds the index of a board's posts,
    # and how often it asks where a post stands. Both counts grow with the record and not with its square.
    built: list[int] = []
    asked: list[str] = []
    index, stands = board_module._index, status_module.standing

    def counted_index(posts: tuple[Posted, ...]) -> object:
        before = len(board_module._indexes), board_module._indexes[-1:] if board_module._indexes else None
        found = index(posts)
        if (len(board_module._indexes), board_module._indexes[-1:]) != before:
            built.append(len(posts))
        return found

    def counted_standing(board: Board, post_id: str) -> str:
        asked.append(post_id)
        return stands(board, post_id)

    monkeypatch.setattr(board_module, '_index', counted_index)
    monkeypatch.setattr(status_module, 'standing', counted_standing)
    counts = []
    for events in (2_000, 6_000):
        board = long_record(events)
        built.clear()
        asked.clear()
        started = time.perf_counter()
        view = _lab_view(board, activity, board.opened.at)
        taken = time.perf_counter() - started
        results = sum(isinstance(entry.post, Result) for entry in board.posts)
        assert sum(len(agent.outcomes.refuted) for agent in view.agents) > events // 40
        # One index for the board, and one question for each result.
        assert (built, len(asked)) == ([len(board.posts)], results)
        counts.append(len(asked))
        # A loose bound on the time too: the scan of every post for each result took seconds here.
        assert taken < 3.0, f'The lab view of {events} events took {taken:.2f} seconds.'
    assert counts[1] < 3.1 * counts[0]


async def test_the_person_votes_gives_promising_seconds_and_declines_through_the_app(
    client: httpx2.AsyncClient, lab: Lab
) -> None:
    check = PostRequest(kind='check', text='Same.', thread='t-1', reply_to='p-1', outcome='holds', method='rerun')
    await lab.post(check, 'bo')
    await lab.join(agent('cy'))
    await lab.post(PostRequest(kind='result', text='On 114 pairs too.', thread='t-1', builds_on=('p-1',)), 'bo')
    await lab.badge('bo', 'p-1', 'breakthrough', reason='It gives the strategy a size.')
    await lab.badge('cy', 'p-3', 'breakthrough', reason='It holds on every pair.')
    waiting = (await client.get('/lab')).json()

    voted = await client.post('/votes', json={'post': 'p-1', 'direction': 'up', 'reason': 'This is what I asked.'})
    bare = await client.post('/votes', json={'post': 'p-1', 'direction': 'down'})
    back = await client.post('/votes', json={'post': 'p-1', 'direction': 'none'})
    promising = await client.post('/badges', json={'post': 'p-1', 'badge': 'promising', 'reason': 'Go on here.'})
    confirmed = await client.post(
        '/badges', json={'post': 'p-1', 'badge': 'confirmed', 'reason': 'p-2 repeats it.', 'proof': 'p-2'}
    )
    no_proof = await client.post(
        '/badges', json={'post': 'p-3', 'badge': 'confirmed', 'reason': 'It builds on it.', 'proof': 'p-1'}
    )
    seconded = await client.post('/badges', json={'post': 'p-1', 'badge': 'breakthrough', 'action': 'second'})
    declined = await client.post(
        '/badges', json={'post': 'p-3', 'badge': 'breakthrough', 'action': 'take_back', 'giver': 'cy'}
    )
    taken = await client.post('/badges', json={'post': 'p-1', 'badge': 'promising', 'action': 'take_back'})
    after = (await client.get('/lab')).json()
    thread = (await client.get('/threads/t-1')).json()

    # A proposal that waits is in the lab view. It is none of the waits.
    assert [(wait['post'], wait['by']) for wait in waiting['proposals']] == [('p-1', 'bo'), ('p-3', 'cy')]
    assert (waiting['needs_you'], waiting['waits'], waiting['breakthrough_threads']) == (0, [], [])
    assert (voted.status_code, voted.json()['up'], voted.json()['votes'][0]['by']) == (200, 1, 'person')
    assert (bare.status_code, bare.json()['detail']) == (
        400,
        'A vote down has a reason of one line. `reason` holds it.',
    )
    assert (back.json()['up'], back.json()['votes']) == (0, [])
    assert [line['badge'] for line in promising.json()['badges']] == ['promising', 'breakthrough']
    assert confirmed.json()['badges'][1]['given'][0]['proof'] == 'p-2'
    assert (no_proof.status_code, no_proof.json()['detail']) == (
        400,
        'Post p-1 is no check of post p-3 with the outcome `holds`.',
    )
    assert seconded.json()['badges'][2]['second']['by'] == 'person'
    assert (declined.status_code, declined.json()['badges']) == (200, [])
    assert [line['badge'] for line in taken.json()['badges']] == ['confirmed', 'breakthrough']
    assert (after['proposals'], after['breakthrough_threads']) == ([], ['t-1'])
    # No status of an agent or a thread changed with any of it.
    assert [view['need'] for view in after['agents']] == [view['need'] for view in waiting['agents']]
    assert after['thread_needs'] == waiting['thread_needs']
    assert [item['post']['id'] for item in thread['posts']] == ['p-1', 'p-2', 'p-3']
