import asyncio

import pytest
from conftest import agent
from fakes import FakeCopies
from mcp import Client

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import AlarmLine, AlarmResult, Brief, News, PostRequest, ThreadList, Update
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

    assert tools == {
        'brief',
        'post',
        'request',
        'threads',
        'thread',
        'watch',
        'alarm',
        'profile',
        'leave',
        'rerun',
        'take_rerun',
        'wait',
    }
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
        'The person and every agent can read every side thread',
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
    assert 'You asked for an independent rerun of p-2 already' in str(third.content)


async def test_an_agent_takes_a_rerun_over_the_board_and_posts_its_check_without_a_thread(lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)

    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        return tuple(FileEvidence(path=path, commit='d' * 40) for path in paths)

    copies = FakeCopies()
    bo = Member(lab, 'bo', pin=pin, copies=copies)
    await lab.request_rerun('ada', 'p-2')
    # The check names no thread: a reply goes in the thread of the post that it answers.
    check = {'kind': 'check', 'text': 'Reran it.', 'reply_to': 'p-2', 'outcome': 'holds', 'method': 'rerun'}
    async with Client(join_server(lambda _: bo)) as client:
        taken = await client.call_tool('take_rerun', {'post': 'p-2'})
        posted = await client.call_tool('post', check | {'files': ['rerun.json']})
        own = await client.call_tool('take_rerun', {'post': 'p-1'})

    assert taken.structured_content is not None
    assert posted.structured_content is not None
    assert (taken.structured_content['folder'], taken.structured_content['files']) == (
        str(copies.folder / 'p-2'),
        ['bench.json'],
    )
    # The rerun that the agent took is no news for it.
    assert taken.structured_content['news']['reruns'] == []
    assert (posted.structured_content['post']['thread'], posted.structured_content['post']['take']) == (
        't-1',
        lab.board.takes[0].seq,
    )
    assert posted.structured_content['post']['evidence'] == [{'type': 'file', 'path': 'rerun.json', 'commit': 'd' * 40}]
    assert own.is_error
    assert 'No rerun of post p-1 is wanted now' in str(own.content)


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
    # The text opens with the tool that gives the board's state, as a fact and not as an order.
    assert instructions.startswith('This is the board of a Verifold lab. `brief` gives the board as it is now')
    # The text wraps, so the rules are compared without its line breaks.
    flat = ' '.join(instructions.split())
    for rule in (
        'A `plan` says what',
        'at most 1000 characters',
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
        '`builds_on` names the posts, in any thread, that a post builds on',
        "`helper` on a post holds the helper's own name",
        'stays in `brief` until somebody answers it',
        '`person` in `mentions`',
        'When Verifold started you: after you end your turn, a post for you wakes you',
        'When you joined with an invitation, you run by yourself',
        '`post`, `rerun`, and `take_rerun` refuse you too',
        'a permission that your harness asks for goes to the person on the board',
        'The ask shows the whole command or input, and every agent can read it',
        'it waits for the answer until your turn ends, or it gets a refusal at once and the answer applies when you ask for the same again within an hour',
        'None of this applies to an agent that joined with an invitation',
        'The order of these fields ranks nothing',
        'The person can change the norms while the lab runs',
        'When no alarm waits, `no_alarm` in `brief` and in `wait` says what starts your next turn as the lab stands',
        'pins each file',
        'An independent rerun is a rerun of a post from a clean copy of its files by another agent than its author',
        'Verifold starts no agent for it',
        'time limit',
        '`alarm` wakes you when you are not in a turn',
        'Your alarm stays until it rings',
        'A `close` says that the lab is done',
        "person's norms",
    ):
        assert rule in flat, rule
    # How an agent writes its commands is the agent's own business.
    assert 'run it plain' not in instructions


async def test_the_tools_describe_who_a_post_reaches_as_the_board_decides_it(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        tools = {tool.name: tool.description or '' for tool in (await client.list_tools()).tools}

    assert 'It reaches the agents that it names' in tools['post']
    assert 'reaches every agent, so that each' not in tools['post']
    assert 'the thread of your latest plan or result' in tools['watch']
    assert 'the threads that you post in' not in tools['watch']


async def test_an_agent_sets_and_cancels_its_own_alarm_and_every_result_says_which_alarm_waits(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        none = await client.call_tool('brief', {})
        set_ = await client.call_tool('alarm', {'minutes': 20, 'quiet': True})
        threads = await client.call_tool('threads', {})
        waited = await client.call_tool('wait', {'timeout_seconds': 0})
        brief = await client.call_tool('brief', {})
        replaced = await client.call_tool('alarm', {'minutes': 5})
        cancelled = await client.call_tool('alarm', {'minutes': 0})
        after = await client.call_tool('threads', {})
        too_long = await client.call_tool('alarm', {'minutes': 24 * 60 + 1})
        text = next(tool.description or '' for tool in (await client.list_tools()).tools if tool.name == 'alarm')

    first, now = Brief.model_validate(none.structured_content), Brief.model_validate(brief.structured_content)
    assert (first.your_alarm, first.news.alarm) == (None, None)
    was_set = AlarmResult.model_validate(set_.structured_content)
    assert was_set.rings_at is not None
    waits = AlarmLine(minutes=20, quiet=True, rings_at=was_set.rings_at)
    assert (was_set.quiet, was_set.news and was_set.news.alarm) == (True, waits)
    listed = ThreadList.model_validate(threads.structured_content)
    assert (listed.news and listed.news.alarm, Update.model_validate(waited.structured_content).alarm) == (waits, waits)
    assert (now.your_alarm, now.news.alarm) == (waits, waits)
    new = AlarmResult.model_validate(replaced.structured_content)
    assert new.news is not None
    assert new.news.alarm == AlarmLine(minutes=5, rings_at=new.rings_at)
    gone = AlarmResult.model_validate(cancelled.structured_content)
    assert (gone.rings_at, gone.news and gone.news.alarm) == (None, None)
    assert ThreadList.model_validate(after.structured_content).news == News(seq=lab.board.seq)
    # With no alarm, `brief` says what starts the agent's next turn as the lab stands. With one, it is empty.
    assert first.no_alarm == (
        'No alarm is set for you. After you end this turn, your next turn starts only when a post for you arrives '
        'or when an agent that you named or answered leaves. The lab has no time limit. No close stands.'
    )
    assert now.no_alarm == ''
    assert too_long.is_error
    assert [(alarm.agent, alarm.minutes, alarm.quiet, alarm.stays) for alarm in lab.board.alarms] == [
        ('bo', 20, True, True),
        ('bo', 5, False, True),
        ('bo', 0, False, True),
    ]
    for fact in (
        'It stays until it rings',
        'until you cancel it with zero minutes',
        'does not spend it',
        'it rings\nwhen that turn ends',
        'Verifold sets no alarm for you',
    ):
        assert fact in text


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
        {'id': 'bo', 'name': 'Bo', 'by': 'bo', 'reason': 'My line is ruled out.', 'through': None, 'request': None}
    ]
    assert (brief.structured_content['agents'], 'An agent can leave the lab' in INSTRUCTIONS) == ([], True)


async def test_a_removal_ends_an_open_wait(lab: Lab) -> None:
    waiting = asyncio.create_task(Member(lab, 'bo').wait(30))
    await asyncio.sleep(0)

    await lab.leave('bo', 'person')

    with pytest.raises(HasLeft, match='The person removed you from this lab'):
        await waiting
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

    line = {'id': 'bo', 'name': 'Bo', 'by': 'person', 'reason': 'Off the question.', 'through': None, 'request': None}
    assert (woken.posts, [entry.model_dump() for entry in woken.left]) == ((), [line])
    # A post that names only an agent that left goes on the board, and its result says that the agent is gone.
    assert named.structured_content is not None
    assert plain.structured_content is not None
    assert (named.is_error, named.structured_content['left'], plain.structured_content['left']) == (False, [line], [])
    # The agent got the departure in its wait, so its news does not repeat it.
    assert named.structured_content['news']['left'] == []


async def test_the_wait_tool_states_what_starts_the_next_turn_and_gives_no_advice(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        text = next(tool.description or '' for tool in (await client.list_tools()).tools if tool.name == 'wait')
        waited = await client.call_tool('wait', {'timeout_seconds': 0})
        await client.call_tool('alarm', {'minutes': 10})
        with_alarm = await client.call_tool('wait', {'timeout_seconds': 0})

    flat = ' '.join(text.split())
    assert 'nothing to do' not in flat
    assert 'you can also end your turn' not in flat.lower()
    assert 'Verifold starts your next turn when a post for you arrives' in flat
    assert 'No turn starts while the lab is out of time.' in flat
    update = Update.model_validate(waited.structured_content)
    assert update.alarm is None
    assert update.no_alarm == (
        'No alarm is set for you. After you end this turn, your next turn starts only when a post for you arrives '
        'or when an agent that you named or answered leaves. The lab has no time limit. No close stands.'
    )
    assert Update.model_validate(with_alarm.structured_content).no_alarm == ''


async def test_a_headline_takes_a_full_sentence_and_a_longer_one_is_refused_with_its_length_and_the_limit(
    lab: Lab,
) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        long = await client.call_tool('post', {'kind': 'message', 'text': 'x' * 1000, 'thread': 't-1'})
        too_long = await client.call_tool('post', {'kind': 'message', 'text': 'x' * 1001, 'thread': 't-1'})
        schema = next(tool for tool in (await client.list_tools()).tools if tool.name == 'post').input_schema

    assert not long.is_error
    assert too_long.is_error
    assert '`text` has 1001 characters, and the limit of a headline is 1000.' in str(too_long.content)
    assert '`body` takes up to 20000 characters.' in str(too_long.content)
    assert schema['$defs']['Headline']['maxLength'] == 1000
