import asyncio

import pytest
from conftest import agent
from mcp import Client

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.server.activity import Activity
from verifold.server.errors import HasLeft, UnknownAgent
from verifold.server.join import INSTRUCTIONS, Members, join_server, token_digest
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


def test_a_guest_is_found_by_the_digest_of_its_token_and_no_digest_is_a_token(lab: Lab) -> None:
    members = Members()
    guest = Member(lab, 'bo')
    members.add_guest(guest, token_digest('the-token'))

    assert members.resolve({'Authorization': 'Bearer the-token'}) is guest
    with pytest.raises(UnknownAgent):
        members.resolve({'Authorization': f'Bearer {token_digest("the-token")}'})


async def test_a_new_token_for_a_guest_makes_the_old_one_void_and_ends_its_open_wait(lab: Lab) -> None:
    members = Members()
    old, new, other = Member(lab, 'bo'), Member(lab, 'bo'), Member(lab, 'ada')
    members.add_guest(old, token_digest('old-token'))
    members.add_guest(other, token_digest('ada-token'))
    waiting = asyncio.create_task(old.wait(30))
    await asyncio.sleep(0)

    members.add_guest(new, token_digest('new-token'))
    # The next post for the agent would end the old wait. It must not go to the holder of the old token.
    await lab.post(PostRequest(kind='message', text='For Bo only.', thread='t-1', mentions=('bo',)), 'ada')

    with pytest.raises(UnknownAgent, match='no valid agent token'):
        members.resolve({'Authorization': 'Bearer old-token'})
    with pytest.raises(UnknownAgent, match='got a new invitation'):
        await waiting
    assert members.resolve({'Authorization': 'Bearer new-token'}) is new
    assert members.resolve({'Authorization': 'Bearer ada-token'}) is other


async def test_the_board_shows_a_guests_calls_and_cannot_set_an_alarm_for_it(lab: Lab) -> None:
    await lab.join(Agent(id='guest', name='Guest', harness='guest', model=ModelSpec(family='unknown')))
    activity = Activity()
    await activity.invite('guest', 'invited')
    async with Client(join_server(lambda _: Member(lab, 'guest'), activity.call)) as client:
        before = activity.of('guest').state
        await client.call_tool('brief', {})
        after = activity.of('guest').state
        alarm = await client.call_tool('alarm', {'minutes': 5})

    assert (before, after) == ('invited', 'here')
    assert alarm.is_error
    assert 'Verifold cannot wake you' in str(alarm.content)
    assert lab.board.alarms == ()


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

    assert tools == {'brief', 'post', 'threads', 'thread', 'watch', 'alarm', 'profile', 'leave', 'rerun', 'wait'}
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


async def test_agents_talk_in_a_side_thread_that_every_agent_can_read_and_join(lab: Lab) -> None:
    await lab.join(agent('cy'))
    ada, bo, cy = Member(lab, 'ada'), Member(lab, 'bo'), Member(lab, 'cy')
    async with Client(join_server(lambda _: ada)) as client:
        opened = await client.call_tool(
            'post', {'kind': 'ask', 'text': 'Can you fetch it?', 'new_thread': 'Scoreboard', 'between': ['bo']}
        )
        refused = await client.call_tool('post', {'kind': 'proposal', 'text': 'The answer is 42.', 'thread': 't-2'})
    assert opened.structured_content is not None
    assert opened.structured_content['post']['thread'] == 't-2'
    assert 'is a side thread, and a proposal is for the whole lab' in str(refused.content)
    # The first post is an ask that names nobody, and it is still for the other member only.
    for_bo = bo.news()
    assert for_bo is not None
    assert [line.id for line in for_bo.for_you] == ['p-2']

    async with Client(join_server(lambda _: cy)) as client:
        listed = await client.call_tool('threads', {})
        read = await client.call_tool('thread', {'thread': 't-2'})
        brief = await client.call_tool('brief', {})
        await client.call_tool('watch', {'thread': 't-2'})
    assert listed.structured_content is not None
    assert read.structured_content is not None
    assert brief.structured_content is not None
    assert [summary['thread']['id'] for summary in listed.structured_content['threads']] == ['t-1']
    lines = listed.structured_content['side_threads']
    assert [(line['id'], line['title'], line['members'], line['posts']) for line in lines] == [
        ('t-2', 'Scoreboard', ['ada', 'bo'], 1)
    ]
    assert listed.structured_content['news']['for_you'] == []
    assert [line['id'] for line in listed.structured_content['news']['others']] == ['p-2']
    assert (read.structured_content['members'], read.structured_content['watching']) == (['ada', 'bo'], False)
    assert [item['post']['text'] for item in read.structured_content['posts']] == ['Can you fetch it?']
    assert [line['id'] for line in brief.structured_content['side_threads']] == ['t-2']
    assert brief.structured_content['open_asks'] == []
    assert lab.board.members('t-2') == ('ada', 'bo', 'cy')


async def test_the_board_says_what_a_side_thread_is_and_never_when_to_use_one(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        tools = {tool.name: tool.description or '' for tool in (await client.list_tools()).tools}

    for fact in (
        'A thread is for the whole lab unless it is a side thread',
        'In a thread for the whole lab, these posts are for\n  every agent',
        'A side thread is a thread between named agents',
        'is for the members that watch it',
        'hears nothing from the thread until it watches again, also when it\n  posts there',
        'every agent that reads the board can read every side thread, so a blind checker\n  cannot',
        'Nobody can be kept out of one or removed from one',
        'A side thread takes no `proposal` and no `close`',
        'does not move the thread where you work',
        'does not open a closed lab again',
        "only for the thread's members, and it lists results from every thread",
    ):
        assert fact in INSTRUCTIONS
    assert '`between` with `new_thread` opens a side thread' in tools['post']
    assert 'every agent that reads the board can\nread a side thread' in tools['post']
    assert tools['post'].count('in a thread for the whole lab, it reaches every agent') == 2
    assert '`side_threads` lists the side threads apart' in tools['threads']
    assert 'You can read a side thread that you are not a member of' in tools['thread']
    assert 'hear nothing from it until you watch it again, also when\nyou post there' in tools['watch']
    side = ' '.join(line for line in INSTRUCTIONS.splitlines() if 'side thread' in line)
    assert not any(word in side for word in ('Use ', 'should', 'instead', 'prefer', 'when you'))


async def test_an_agent_says_what_it_is_and_does_and_the_others_and_the_person_see_it(lab: Lab) -> None:
    await lab.post(PostRequest(kind='plan', text='I take the large models.', new_thread='Large models'), 'bo')
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        first = await client.call_tool('profile', {'role': ' theory ', 'status': 'Deriving the bound.'})
        second = await client.call_tool('profile', {'status': ''})
        seq = lab.board.seq
        same = await client.call_tool('profile', {'role': 'theory'})
        nothing = await client.call_tool('profile', {})
        lines = await client.call_tool('profile', {'status': 'First\nline\x1b[31m  and\tmore'})
        long = await client.call_tool('profile', {'role': 'x' * 41})
    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        brief = await client.call_tool('brief', {})

    assert first.structured_content is not None
    assert (first.structured_content['role'], first.structured_content['status']) == ('theory', 'Deriving the bound.')
    # A field that the agent leaves out stays, and an empty text clears it.
    assert second.structured_content is not None
    assert (second.structured_content['role'], second.structured_content['status']) == ('theory', '')
    # A call that changes nothing records nothing, and a call with neither field reads the profile.
    assert nothing.structured_content is not None
    assert (nothing.structured_content['role'], nothing.structured_content['status']) == ('theory', '')
    assert same.structured_content == nothing.structured_content
    assert lab.board.seq == seq + 1
    assert lines.structured_content is not None
    assert lines.structured_content['status'] == 'First line [31m and more'
    assert long.is_error
    assert brief.structured_content is not None
    (bo,) = brief.structured_content['agents']
    assert (bo['role'], bo['status'], bo['thread']) == ('theory', 'First line [31m and more', 't-2')
    # What an agent says about itself is no post, so it wakes nobody.
    assert brief.structured_content['news']['for_you'] == []
    assert lab.board.profile('ada') == ('', '')


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
    # The check names no thread: a reply goes in the thread of the post that it answers.
    check = {'kind': 'check', 'text': 'Reran it.', 'reply_to': 'p-2', 'outcome': 'holds'}
    async with Client(join_server(lambda _: Member(lab, 'dee'))) as client:
        posted = await client.call_tool('post', check | {'method': 'rerun'})
        lost = await client.call_tool('post', {'kind': 'message', 'text': 'Where?', 'reply_to': 'p-99'})
        other = await client.call_tool('post', {'kind': 'message', 'text': 'Where?', 'reply_to': 'p-1'})
        refused = await client.call_tool('brief', {})

    assert posted.structured_content is not None
    assert [entry.post.thread for entry in lab.board.posts if entry.post.author == 'dee'] == ['t-1']
    assert lost.is_error
    assert 'Give thread' in str(lost.content)
    # A post that exists and one that does not look the same to a blind checker.
    assert str(other.content) == str(lost.content)
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
        'unless their `mentions` name somebody',
        'the thread of your latest `plan` or `result`',
        'An agent sees any other post when it next reads the board',
        'A post from the person that names nobody',
        'an `ask` that replies to no post',
        'name them in `builds_on`',
        'give\n  its own name in `helper`',
        'stays in `brief` until somebody answers it',
        '`person` in `mentions`',
        'When Verifold started you: after you end your turn, a post for you wakes you',
        'When you joined with an invitation, you run by yourself',
        '`post` and `rerun` refuse you too',
        'a permission that your harness asks for goes to the person on the board',
        'The ask shows the whole command or input, and every agent can read it',
        'it waits for the answer until your turn ends, or it gets a refusal at\n  once and the answer applies when you ask for the same again within an hour',
        'None of this applies to an agent that\n  joined with an invitation',
        'So you choose when to\n  look at the board again',
        'pins each file',
        'blind rerun',
        'time limit',
        '`alarm` wakes you after your turn',
        'A `close` says that the lab is done',
        "person's norms",
    ):
        assert rule in instructions
    # How an agent writes its commands is the agent's own business.
    assert 'run it plain' not in instructions


async def test_the_tools_describe_who_a_post_reaches_as_the_board_decides_it(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        tools = {tool.name: tool.description or '' for tool in (await client.list_tools()).tools}

    assert 'It reaches the agents that it names' in tools['post']
    assert 'reaches every agent, so that each' not in tools['post']
    assert 'the thread of your latest plan or result' in tools['watch']
    assert 'the threads that you post in' not in tools['watch']


async def test_an_agent_sets_and_cancels_its_own_alarm(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        set_ = await client.call_tool('alarm', {'minutes': 20, 'quiet': True})
        cancelled = await client.call_tool('alarm', {'minutes': 0})
        too_long = await client.call_tool('alarm', {'minutes': 24 * 60 + 1})

    assert set_.structured_content is not None
    assert (set_.structured_content['quiet'], set_.structured_content['rings_at'] is not None) == (True, True)
    assert cancelled.structured_content is not None
    assert cancelled.structured_content['rings_at'] is None
    assert too_long.is_error
    assert [(alarm.agent, alarm.minutes, alarm.quiet) for alarm in lab.board.alarms] == [
        ('bo', 20, True),
        ('bo', 0, False),
    ]


async def test_an_alarm_in_a_closed_lab_says_that_it_does_not_ring(lab: Lab) -> None:
    await lab.post(PostRequest(kind='close', text='Done.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-2', accepts=True), 'bo')
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        set_ = await client.call_tool('alarm', {'minutes': 10})

    assert set_.structured_content is not None
    assert set_.structured_content['rings_at'] is None


async def test_an_agent_leaves_with_a_reason_and_the_board_then_refuses_its_every_call(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    async with Client(join_server(lambda _: bo)) as client:
        tools = {tool.name: tool.description or '' for tool in (await client.list_tools()).tools}
        left = await client.call_tool('leave', {'reason': 'My line is ruled out.'})
        calls = {
            'post': {'kind': 'message', 'text': 'One more thing.', 'thread': 't-1'},
            'rerun': {'post': 'p-1'},
            'watch': {'thread': 't-1'},
            'profile': {'status': 'Back.'},
            'alarm': {'minutes': 5},
            'brief': {},
            'threads': {},
            'thread': {'thread': 't-1'},
            'wait': {'timeout_seconds': 0},
            'leave': {},
        }
        refused = {tool: await client.call_tool(tool, arguments) for tool, arguments in calls.items()}
    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        brief = await client.call_tool('brief', {})

    # The tool's text says what leaving means, in facts.
    assert all(fact in tools['leave'] for fact in ('This is final', 'Your posts stay', 'reads too'))
    assert left.structured_content is not None
    assert (left.structured_content['agent'], left.structured_content['by']) == ('bo', 'bo')
    assert [entry.reason for entry in lab.board.left] == ['My line is ruled out.']
    for tool, result in refused.items():
        assert result.is_error, tool
        assert 'You left this lab, so the board takes no call from you.' in str(result.content), tool
    assert (len(lab.board.posts), lab.board.watches, lab.board.alarms, lab.board.profiles) == (1, (), (), ())
    assert brief.structured_content is not None
    assert brief.structured_content['left'] == [
        {'id': 'bo', 'name': 'Bo', 'by': 'bo', 'reason': 'My line is ruled out.'}
    ]
    assert (brief.structured_content['agents'], 'An agent can leave the lab' in INSTRUCTIONS) == ([], True)


async def test_a_removal_ends_an_open_wait_and_a_blind_checker_cannot_leave(lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)
    await lab.join(Agent(id='dee', name='Dee', harness='fake', model=ModelSpec(family='openai'), checks='p-2'))
    waiting = asyncio.create_task(Member(lab, 'bo').wait(30))
    await asyncio.sleep(0)

    await lab.leave('bo', 'person')
    async with Client(join_server(lambda _: Member(lab, 'dee'))) as client:
        checker = await client.call_tool('leave', {})

    with pytest.raises(HasLeft, match='The person removed you from this lab'):
        await waiting
    assert checker.is_error
    assert 'A blind checker is gone after its one check' in str(checker.content)
    assert [entry.agent for entry in lab.board.left] == ['bo']


async def test_a_departure_reaches_the_agents_that_wrote_to_the_agent_and_ends_their_wait(lab: Lab) -> None:
    ada = Member(lab, 'ada')
    await lab.post(PostRequest(kind='ask', text='Which seed?', thread='t-1', mentions=('bo',)), 'ada')
    ada.news()
    waiting = asyncio.create_task(ada.wait(30))
    await asyncio.sleep(0)

    await lab.leave('bo', 'person', 'Off the question.')
    async with asyncio.timeout(5):
        woken = await waiting
    async with Client(join_server(lambda _: ada)) as client:
        named = await client.call_tool(
            'post', {'kind': 'message', 'text': 'Is bo still here?', 'thread': 't-1', 'mentions': ['bo']}
        )
        plain = await client.call_tool('post', {'kind': 'message', 'text': 'Then I go on.', 'thread': 't-1'})

    line = {'id': 'bo', 'name': 'Bo', 'by': 'person', 'reason': 'Off the question.'}
    assert (woken.posts, [entry.model_dump() for entry in woken.left]) == ((), [line])
    # A post that names only an agent that left goes on the board, and its result says that the agent is gone.
    assert named.structured_content is not None
    assert plain.structured_content is not None
    assert (named.is_error, named.structured_content['left'], plain.structured_content['left']) == (False, [line], [])
    # The agent got the departure in its wait, so its news does not repeat it.
    assert named.structured_content['news']['left'] == []
