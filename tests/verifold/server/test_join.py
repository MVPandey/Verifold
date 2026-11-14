import pytest
from mcp import Client

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.server.errors import UnknownAgent
from verifold.server.join import INSTRUCTIONS, Members, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member


def test_members_are_found_by_their_bearer_token(lab: Lab) -> None:
    members = Members()
    ada = Member(lab, 'ada')
    token = members.add(ada)

    assert members.resolve({'Authorization': f'Bearer {token}'}) is ada
    assert members.resolve({'authorization': f'bearer {token}'}) is ada


@pytest.mark.parametrize('headers', [None, {}, {'authorization': 'Bearer wrong'}, {'authorization': 'Basic abc'}])
def test_a_request_without_a_valid_token_is_refused(lab: Lab, headers: dict[str, str] | None) -> None:
    members = Members()
    members.add(Member(lab, 'ada'))

    with pytest.raises(UnknownAgent, match='no valid agent token'):
        members.resolve(headers)


async def test_agents_work_through_the_mcp_tools(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    async with Client(join_server(lambda _: bo)) as client:
        tools = {tool.name for tool in (await client.list_tools()).tools}
        posted = await client.call_tool(
            'post', {'kind': 'objection', 'text': 'Leak.', 'thread': 't-1', 'reply_to': 'p-1'}
        )
        await client.call_tool(
            'post',
            {
                'kind': 'message',
                'text': 'I start from this.',
                'thread': 't-1',
                'builds_on': ['p-1'],
                'helper': ' skeptic ',
            },
        )
        watched = await client.call_tool('watch', {'thread': 't-1'})
        thread = await client.call_tool('thread', {'thread': 't-1'})
        threads = await client.call_tool('threads', {})
        news = await client.call_tool('wait', {'timeout_seconds': 0})

    assert tools == {'brief', 'post', 'threads', 'thread', 'watch', 'rerun', 'wait'}
    assert posted.structured_content is not None
    assert posted.structured_content['post']['id'] == 'p-2'
    assert watched.structured_content is not None
    assert (watched.structured_content['thread'], watched.structured_content['watching']) == ('t-1', True)
    assert thread.structured_content is not None
    assert [item['standing'] for item in thread.structured_content['posts']] == ['disputed', 'open', 'open']
    assert [item['built_on_by'] for item in thread.structured_content['posts']] == [['p-3'], [], []]
    assert thread.structured_content['posts'][2]['post']['builds_on'] == ['p-1']
    assert [item['post']['helper'] for item in thread.structured_content['posts']] == ['', '', 'skeptic']
    assert [item['post']['author'] for item in thread.structured_content['posts']][2] == 'bo'
    assert threads.structured_content is not None
    assert [summary['thread']['id'] for summary in threads.structured_content['threads']] == ['t-1']
    assert news.structured_content is not None
    assert news.structured_content['posts'] == []


async def test_every_tool_result_carries_the_posts_that_the_agent_has_not_seen(lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    bo = Member(lab, 'bo')
    calls = (
        ('post', {'kind': 'plan', 'text': 'I take the large models.', 'thread': 't-1'}),
        ('threads', {}),
        ('thread', {'thread': 't-1'}),
        ('watch', {'thread': 't-1'}),
        ('rerun', {'post': 'p-2'}),
        ('brief', {}),
    )
    seen: list[list[str]] = []
    async with Client(join_server(lambda _: bo)) as client:
        await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)
        for number, (tool, arguments) in enumerate(calls):
            await lab.post(PostRequest(kind='message', text=f'Note {number}.', thread='t-1'), 'ada')
            result = await client.call_tool(tool, arguments)
            assert result.structured_content is not None
            news = result.structured_content['news']
            seen.append([line['text'] for line in (*news['for_you'], *news['others'])])
        brief = result.structured_content

    assert seen == [['11.8x.', 'Note 0.'], ['Note 1.'], ['Note 2.'], ['Note 3.'], ['Note 4.'], ['Note 5.']]
    assert (brief['news']['seq'], brief['news']['more'], brief['news']['left_out']) == (lab.board.seq, 0, 0)
    assert brief['how'] == INSTRUCTIONS
    assert [line['id'] for line in brief['not_checked']] == ['p-1', 'p-2']
    assert brief['open_asks'] == []


async def test_a_rerun_request_says_when_it_joins_a_rerun_that_runs_already(lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)
    async with (
        Client(join_server(lambda _: Member(lab, 'ada'))) as ada,
        Client(join_server(lambda _: Member(lab, 'bo'))) as bo,
    ):
        first = await ada.call_tool('rerun', {'post': 'p-2'})
        second = await bo.call_tool('rerun', {'post': 'p-2'})
        third = await bo.call_tool('rerun', {'post': 'p-2'})

    assert first.structured_content is not None
    assert second.structured_content is not None
    assert (first.structured_content['joins'], second.structured_content['joins']) == (None, 'ada')
    assert third.is_error
    assert 'You asked for a blind rerun of p-2 already' in str(third.content)


async def test_a_blind_checker_posts_its_check_and_gets_no_news(lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)
    await lab.join(Agent(id='dee', name='Dee', harness='fake', model=ModelSpec(family='openai'), checks='p-2'))
    check = {'kind': 'check', 'text': 'Reran it.', 'thread': 't-1', 'reply_to': 'p-2', 'outcome': 'holds'}
    async with Client(join_server(lambda _: Member(lab, 'dee'))) as client:
        posted = await client.call_tool('post', check | {'method': 'rerun'})
        refused = await client.call_tool('brief', {})

    assert posted.structured_content is not None
    assert (posted.structured_content['standing'], posted.structured_content['news']) == ('open', None)
    assert refused.is_error
    assert 'rerun p-2 blind' in str(refused.content)


async def test_a_broken_rule_comes_back_to_the_agent_as_a_readable_error(lab: Lab) -> None:
    ada = Member(lab, 'ada')
    async with Client(join_server(lambda _: ada)) as client:
        result = await client.call_tool(
            'post', {'kind': 'objection', 'text': 'Mine.', 'thread': 't-1', 'reply_to': 'p-1'}
        )

    assert result.is_error
    assert 'is your own' in str(result.content)


async def test_an_unknown_agent_gets_a_readable_error() -> None:
    async with Client(join_server(Members().resolve)) as client:
        result = await client.call_tool('threads', {})

    assert result.is_error
    assert 'no valid agent token' in str(result.content)


async def test_the_post_tool_takes_flat_fields(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        schema = next(tool for tool in (await client.list_tools()).tools if tool.name == 'post').input_schema

    assert {'kind', 'text', 'thread', 'new_thread', 'reply_to', 'outcome'} <= set(schema['properties'])
    assert set(schema['required']) == {'kind', 'text'}


async def test_the_post_tool_pins_the_files_that_it_names(lab: Lab) -> None:
    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        return tuple(FileEvidence(path=path, commit='b' * 40) for path in paths)

    async with Client(join_server(lambda _: Member(lab, 'bo', pin=pin))) as client:
        posted = await client.call_tool(
            'post', {'kind': 'result', 'text': 'Done.', 'thread': 't-1', 'files': ['a.json']}
        )

    assert posted.structured_content is not None
    assert posted.structured_content['post']['evidence'] == [{'type': 'file', 'path': 'a.json', 'commit': 'b' * 40}]


async def test_a_harness_that_joins_reads_the_protocol_from_the_board(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        instructions = client.instructions

    assert instructions == INSTRUCTIONS
    assert instructions.startswith('You are one agent in a Verifold lab. Call `brief` first.')
    for rule in (
        'A `plan` says what',
        'at most 300 characters',
        '`holds` or `fails`',
        'has `news`',
        "A line is the post's headline",
        '`wait` has no `news`',
        '`left_out` counts',
        'unless their\n  `mentions`',
        'the thread of your latest `plan` or `result`',
        'No other post wakes anybody',
        'An `ask` that replies to no post',
        'name them in `builds_on`',
        'give\n  its own name in `helper`',
        'When you are stuck, post an `ask` with no `mentions`',
        '`person` in `mentions`',
        'When you end your turn',
        'you choose when to look',
        'pins each file',
        'blind rerun',
        'time limit',
        "person's norms",
    ):
        assert rule in instructions
