import pytest
from builders import START
from conftest import agent
from mcp import Client

from verifold.protocol.join import PostRequest
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile

IDEA = {
    'kind': 'idea',
    'text': 'Buy the rate contract after a 4-point fall.',
    'thread': 't-1',
    'parent': 'b-1',
    'test': 'Count the comparable days with a 4-point fall.',
    'rules_out': 'Fewer than 6 of 20 days.',
}


async def test_readings_number_their_branches_in_order_and_an_idea_hangs_on_one_through_the_tools(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        first = await client.call_tool(
            'post',
            {'kind': 'reading', 'text': 'Value counts.', 'thread': 't-1', 'branches': ['Rates', 'Sports']},
        )
        posted = await client.call_tool('post', IDEA)
        partial = await client.call_tool('post', {key: value for key, value in IDEA.items() if key != 'test'})
        second = await client.call_tool(
            'post',
            {
                'kind': 'reading',
                'text': 'Value, settled.',
                'thread': 't-1',
                'branches': ['Calendars'],
                'retires': ['b-2'],
            },
        )
        again = await client.call_tool(
            'post', {'kind': 'reading', 'text': 'Again.', 'thread': 't-1', 'branches': ['rates']}
        )

    assert first.structured_content is not None
    assert first.structured_content['post']['branches'] == [
        {'id': 'b-1', 'title': 'Rates'},
        {'id': 'b-2', 'title': 'Sports'},
    ]
    assert posted.structured_content is not None
    assert (posted.structured_content['post']['kind'], posted.structured_content['post']['parent']) == ('idea', 'b-1')
    assert partial.is_error
    assert 'An idea needs its three parts' in str(partial.content)
    assert second.structured_content is not None
    assert second.structured_content['post']['branches'] == [{'id': 'b-3', 'title': 'Calendars'}]
    assert second.structured_content['post']['retires'] == ['b-2']
    assert again.is_error
    assert 'Branch b-1 has the title "rates" and is in force.' in str(again.content)


async def test_the_map_tool_and_the_steering_tool_show_the_branches_and_a_try_reaches_the_ideas_author(
    lab: Lab,
) -> None:
    await lab.post(PostRequest(kind='reading', text='Value counts.', thread='t-1', branches=('Rates', 'Sports')), 'ada')
    await lab.post(PostRequest.model_validate(IDEA), 'ada')
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        tried = await client.call_tool('post', {'kind': 'plan', 'text': 'I try it.', 'thread': 't-1', 'idea': 'p-3'})
        shown = await client.call_tool('map', {})
        steering = await client.call_tool('steering', {})
        brief = await client.call_tool('brief', {})

    assert not tried.is_error
    assert shown.structured_content is not None
    rates, sports = shown.structured_content['branches']
    assert (rates['id'], rates['ideas'], rates['being_tried'], rates['added_by']) == ('b-1', 1, 1, 'p-2')
    (card,) = rates['idea_list']
    assert (card['id'], card['state'], card['test'], card['tries'][0]['author']) == (
        'p-3',
        'being_tried',
        IDEA['test'],
        'bo',
    )
    assert 'idea_list' not in sports
    assert sports['no_idea_hours'] >= 0
    assert shown.structured_content['news'] is not None
    assert steering.structured_content is not None
    assert steering.structured_content['facts']['branches_without_idea'] == 1
    assert [line['id'] for line in steering.structured_content['branches']] == ['b-1', 'b-2']
    assert brief.structured_content is not None
    assert [line['id'] for line in brief.structured_content['branches']] == ['b-1', 'b-2']


async def test_an_idea_without_a_parent_hangs_on_no_branch_until_its_author_gives_it_one_with_the_map_tool(
    lab: Lab,
) -> None:
    alone = {key: value for key, value in IDEA.items() if key != 'parent'}
    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        # The lab has no reading and no branch yet, and an idea comes all the same.
        posted = await client.call_tool('post', alone)
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        under = await client.call_tool('post', alone | {'text': 'Buy after a 6-point fall.', 'parent': 'p-2'})
        waiting = await client.call_tool('map', {})
        steering = await client.call_tool('steering', {})
        brief = await client.call_tool('brief', {})
    await lab.post(PostRequest(kind='reading', text='Value counts.', thread='t-1', branches=('Rates', 'Sports')), 'ada')
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        # A reading moves no idea, and only an idea's author gives it a branch.
        unmoved = await client.call_tool('map', {})
        not_bos = await client.call_tool('map', {'idea': 'p-2', 'branch': 'b-1'})
        through = await client.call_tool('map', {'idea': 'p-3', 'branch': 'b-1'})
    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        half = await client.call_tool('map', {'idea': 'p-2'})
        given = await client.call_tool('map', {'idea': 'p-2', 'branch': 'b-1'})
        again = await client.call_tool('map', {'idea': 'p-2', 'branch': 'b-2'})

    assert posted.structured_content is not None
    assert posted.structured_content['post']['parent'] is None
    assert not under.is_error
    assert waiting.structured_content is not None
    assert waiting.structured_content['branches'] == []
    assert [(card['id'], card.get('branch')) for card in waiting.structured_content['no_branch']] == [
        ('p-2', None),
        ('p-3', None),
    ]
    assert waiting.structured_content['ideas_without_branch'] == 2
    assert steering.structured_content is not None
    assert steering.structured_content['facts']['ideas_without_branch'] == 2
    assert brief.structured_content is not None
    assert brief.structured_content['ideas_without_branch'] == 2
    assert unmoved.structured_content is not None
    assert [card['id'] for card in unmoved.structured_content['no_branch']] == ['p-2', 'p-3']
    assert 'Idea p-2 is the idea of ada. Only its author gives it a branch.' in str(not_bos.content)
    assert 'Idea p-3 hangs on p-2, so its branch comes from there.' in str(through.content)
    assert '`idea` and `branch` come together' in str(half.content)
    # The idea that hangs on it takes the branch with it.
    assert given.structured_content is not None
    rates = given.structured_content['branches'][0]
    assert (rates['id'], rates['ideas'], [card['id'] for card in rates['idea_list']]) == ('b-1', 2, ['p-2', 'p-3'])
    assert given.structured_content['no_branch'] == []
    assert 'Idea p-2 hangs on branch b-1 already, and its branch stays.' in str(again.content)


async def test_the_board_refuses_a_proposal_that_names_no_result_in_a_lab_of_two_working_agents(lab: Lab) -> None:
    await lab.post(PostRequest(kind='message', text='A note.', thread='t-1'), 'bo')
    bare = PostRequest(kind='proposal', text='Buy it.', thread='t-1')

    for proposal in (bare, bare.model_copy(update={'builds_on': ('p-2',)})):
        with pytest.raises(RejectedEvent, match=r'This proposal names no result\.'):
            await lab.post(proposal, 'ada')
    challenge = PostRequest(
        kind='check',
        text='It holds on 2024 too.',
        body='I took the 2024 data.',
        thread='t-1',
        reply_to='p-1',
        outcome='holds',
        method='challenge',
    )
    await lab.post(challenge, 'bo')
    proposed = await lab.post(bare.model_copy(update={'builds_on': ('p-2', 'p-1')}), 'ada')

    assert proposed.post.kind == 'proposal'


async def test_the_board_refuses_a_proposal_that_rests_on_a_result_without_a_challenge_and_lists_it(lab: Lab) -> None:
    await lab.post(PostRequest(kind='result', text='The fee is 1 cent.', thread='t-1'), 'ada')
    propose = PostRequest(kind='proposal', text='Buy it.', thread='t-1', builds_on=('p-1', 'p-2'))

    with pytest.raises(RejectedEvent, match=r'These results that it builds on have none yet: p-1, p-2\.'):
        await lab.post(propose, 'ada')
    for result in ('p-1', 'p-2'):
        challenge = PostRequest(
            kind='check',
            text='It holds on 2024 too.',
            body='I took the 2024 data.',
            thread='t-1',
            reply_to=result,
            outcome='holds',
            method='challenge',
        )
        await lab.post(challenge, 'bo')
    proposed = await lab.post(propose, 'ada')

    assert proposed.post.kind == 'proposal'


async def test_a_lab_with_one_working_agent_takes_a_proposal_on_a_result_without_a_challenge(
    record_file: RecordFile,
) -> None:
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: START)
    await lab.join(agent('ada'))
    await lab.join(agent('dee'), desk=True)
    await lab.post(PostRequest(kind='result', text='Beats random.', new_thread='Does it beat random?'), 'ada')

    proposed = await lab.post(PostRequest(kind='proposal', text='Use it.', thread='t-2', builds_on=('p-1',)), 'ada')
    bare = await lab.post(PostRequest(kind='proposal', text='Use it as it is.', thread='t-2'), 'ada')

    assert (proposed.post.kind, bare.post.kind) == ('proposal', 'proposal')
