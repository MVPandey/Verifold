import asyncio
from collections.abc import AsyncIterator

import httpx2
import pytest
from pydantic import SecretStr

from verifold.protocol.events import TurnSummary
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.protocol.usage import Usage
from verifold.server.activity import Activity
from verifold.server.app_api import _changes, app_api
from verifold.server.lab import Lab

TOKEN = 'person-secret'


@pytest.fixture
def activity() -> Activity:
    return Activity()


@pytest.fixture
async def client(lab: Lab, activity: Activity) -> AsyncIterator[httpx2.AsyncClient]:
    transport = httpx2.ASGITransport(app=app_api(lab, activity, SecretStr(TOKEN)))
    headers = {'Authorization': f'Bearer {TOKEN}'}
    async with httpx2.AsyncClient(transport=transport, base_url='http://lab', headers=headers) as client:
        yield client


async def test_every_request_needs_the_persons_token(lab: Lab, activity: Activity) -> None:
    transport = httpx2.ASGITransport(app=app_api(lab, activity, SecretStr(TOKEN)))
    async with httpx2.AsyncClient(transport=transport, base_url='http://lab') as anonymous:
        refused = await anonymous.get('/lab')
        wrong = await anonymous.get('/lab', headers={'Authorization': 'Bearer nope'})
        by_query = await anonymous.get('/lab', params={'token': TOKEN})

    assert (refused.status_code, wrong.status_code, by_query.status_code) == (401, 401, 200)


async def test_the_lab_view_shows_each_agents_activity_and_cost(
    client: httpx2.AsyncClient, lab: Lab, activity: Activity
) -> None:
    await activity.set('ada', 'working', 'Run pytest')
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


async def test_threads_and_a_thread_read_as_the_person(client: httpx2.AsyncClient) -> None:
    threads = (await client.get('/threads')).json()
    thread = (await client.get('/threads/t-1')).json()
    missing = await client.get('/threads/t-9')

    assert [summary['thread']['id'] for summary in threads] == ['t-1']
    assert [item['post']['text'] for item in thread['posts']] == ['Beats random.']
    assert (missing.status_code, missing.json()['detail']) == (404, 'No thread has the ID t-9.')


async def test_the_person_posts_and_gets_a_readable_refusal(client: httpx2.AsyncClient) -> None:
    posted = await client.post('/posts', json={'kind': 'message', 'text': 'Try sorted data too.', 'thread': 't-1'})
    refused = await client.post(
        '/posts', json={'kind': 'objection', 'text': 'Wrong.', 'thread': 't-1', 'reply_to': 'p-9'}
    )

    assert (posted.status_code, posted.json()['post']['author']) == (200, 'person')
    assert (refused.status_code, refused.json()['detail']) == (400, 'Post p-9 does not exist.')


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
    changes = _changes(lab, activity)
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
