import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import override

import httpx2
import pytest
from conftest import agent
from pydantic import SecretStr

from verifold.protocol.app import (
    HarnessOption,
    SettingsChange,
    SettingsFileView,
    SettingsView,
    SetupView,
    StartRequest,
)
from verifold.protocol.events import TurnSummary
from verifold.protocol.join import FileText, PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.protocol.settings import Settings
from verifold.protocol.usage import Usage
from verifold.server.activity import Activity
from verifold.server.app_api import _changes, app_api
from verifold.server.errors import LabExists, SetupRejected
from verifold.server.lab import Lab
from verifold.society.errors import NotFound
from verifold.store.errors import SettingsChanged, SettingsInvalid, SettingsUnwritable
from verifold.store.record_file import RecordFile

TOKEN = 'person-secret'
START = {'question': 'Is it faster?', 'agents': [{'harness': 'fake', 'count': 2}]}


class Host:
    """A stand-in for the process that runs the folder's lab. It records each start request."""

    def __init__(self, lab: Lab | None) -> None:
        self.lab = lab
        self.started: list[StartRequest] = []

    def setup(self) -> SetupView:
        harnesses = (HarnessOption(name='fake', title='Fake', family='test', available=True),)
        question = self.lab.board.opened.question if self.lab else None
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

    assert view['lab'] == {'version': 1, 'jobs': {'at_time_limit': 'pause', 'at_exit': 'stop'}}
    assert view['project']['path'] == '.verifold/settings.json'
    assert changed.status_code == 200
    assert (stale.status_code, invalid.status_code, harness.status_code) == (409, 400, 422)
    assert 'changed since you opened the settings' in stale.json()['detail']
    assert (unwritable.status_code, unwritable.json()['detail']) == (
        500,
        "Can't write .verifold/settings.json: No space left on device",
    )


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

    assert (refused.status_code, wrong.status_code, by_query.status_code) == (401, 401, 200)


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
    assert (bo['activity']['state'], bo['cost_usd']) == ('starting', None)
    # Ada opened the lab's thread with a result, so that is where she works.
    assert (ada['role'], ada['status'], ada['thread']) == ('theory', 'Deriving the bound.', 't-1')
    assert (bo['role'], bo['status'], bo['thread']) == ('', '', None)
    assert (view['state'], view['close'], view['close_agreed']) == ('open', None, 0)

    await lab.post(PostRequest(kind='close', text='The answer stands.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-2', accepts=True), 'bo')
    done = (await client.get('/lab')).json()
    assert (done['state'], done['close']['id'], done['close_agreed']) == ('closed', 'p-2', 1)


async def test_threads_and_a_thread_read_as_the_person(client: httpx2.AsyncClient) -> None:
    threads = (await client.get('/threads')).json()
    thread = (await client.get('/threads/t-1')).json()
    missing = await client.get('/threads/t-9')

    assert [(summary['thread']['id'], summary['latest']['text']) for summary in threads] == [('t-1', 'Beats random.')]
    assert [item['post']['text'] for item in thread['posts']] == ['Beats random.']
    assert (missing.status_code, missing.json()['detail']) == (404, 'No thread has the ID t-9.')


async def test_the_person_posts_and_gets_a_readable_refusal(client: httpx2.AsyncClient) -> None:
    posted = await client.post('/posts', json={'kind': 'message', 'text': 'Try sorted data too.', 'thread': 't-1'})
    refused = await client.post(
        '/posts', json={'kind': 'objection', 'text': 'Wrong.', 'thread': 't-1', 'reply_to': 'p-9'}
    )

    assert (posted.status_code, posted.json()['post']['author']) == (200, 'person')
    assert (refused.status_code, refused.json()['detail']) == (400, 'Post p-9 does not exist.')


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


async def test_the_answer_route_gives_the_labs_answer_and_a_file_route_gives_a_files_text(
    record_file: RecordFile, activity: Activity
) -> None:
    lab = Lab.create(record_file, 'Does it hold?')
    await lab.open_question_thread()
    await lab.join(agent('bo'))
    async with client_of(Host(lab), activity) as client:
        before = (await client.get('/answer')).json()
        await lab.post(PostRequest(kind='proposal', text='Yes, it holds.', thread='t-1'), 'bo')

        after = (await client.get('/answer')).json()
        file = await client.get('/posts/p-1/file', params={'path': 'answer.md'})
        missing = await client.get('/posts/p-1/file', params={'path': 'other.md'})

    assert before is None
    assert (after['answer']['post']['text'], after['builds_on']) == ('Yes, it holds.', [])
    assert file.json()['text'] == '# The answer'
    assert (missing.status_code, missing.json()['detail']) == (404, 'Post p-1 names no file other.md.')
