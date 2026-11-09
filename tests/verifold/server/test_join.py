import pytest
from mcp import Client

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
        watched = await client.call_tool('watch', {'thread': 't-1'})
        thread = await client.call_tool('thread', {'thread': 't-1'})
        threads = await client.call_tool('threads', {})
        news = await client.call_tool('wait', {'timeout_seconds': 0})

    assert tools == {'post', 'threads', 'thread', 'watch', 'rerun', 'wait'}
    assert posted.structured_content is not None
    assert posted.structured_content['post']['id'] == 'p-2'
    assert watched.structured_content is not None
    assert watched.structured_content['watching'] is True
    assert thread.structured_content is not None
    assert [item['standing'] for item in thread.structured_content['posts']] == ['disputed', 'open']
    assert threads.structured_content is not None
    assert news.structured_content is not None
    assert news.structured_content['posts'] == []


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
    for rule in (
        '`person` in `mentions`',
        'end your turn',
        'pins each file',
        'blind rerun',
        'time limit',
        "person's norms",
    ):
        assert rule in instructions
