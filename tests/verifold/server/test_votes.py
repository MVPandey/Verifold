import asyncio
from datetime import timedelta

import pytest
from conftest import agent
from mcp import Client

from verifold.app import NORMS_TEMPLATE
from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import BadgeSet, Voted
from verifold.server.errors import OutOfTime
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.society.votes import marks, vote_of
from verifold.store.record_file import RecordFile


async def test_a_vote_is_recorded_once_and_the_same_vote_again_records_nothing(
    lab: Lab, record_file: RecordFile
) -> None:
    seq = lab.board.seq
    first = await lab.vote('bo', 'p-1', 'up', ' It  holds on my data. ')
    again = await lab.vote('bo', 'p-1', 'up', 'It holds on my data.')

    assert first is not None
    assert first is again
    assert (first.reason, lab.board.seq, marks(lab.board, 'p-1')) == ('It holds on my data.', seq + 1, (1, 0, ()))
    # Another reason or another direction replaces the vote, and `none` takes it back.
    changed = await lab.vote('bo', 'p-1', 'down', 'The second seed fails.')
    assert changed is not None
    assert (changed.direction, marks(lab.board, 'p-1'), lab.board.seq) == ('down', (0, 1, ()), seq + 2)
    assert await lab.vote('bo', 'p-1', 'none') is None
    assert (marks(lab.board, 'p-1'), lab.board.seq) == ((0, 0, ()), seq + 3)
    with pytest.raises(RejectedEvent, match='You have no vote on post p-1'):
        await lab.vote('bo', 'p-1', 'none')
    with pytest.raises(RejectedEvent, match='Post p-1 is your own'):
        await lab.vote('ada', 'p-1', 'up', 'Mine.')
    # A refused vote is not in the record, and the record keeps the history of the others.
    stored = [event for event in record_file.read() if isinstance(event, Voted)]
    assert [(event.by, event.direction) for event in stored] == [('bo', 'up'), ('bo', 'down'), ('bo', 'none')]
    assert Lab.load(record_file).board.votes == lab.board.votes


async def test_the_second_of_a_breakthrough_names_the_agent_that_proposed_it(lab: Lab, record_file: RecordFile) -> None:
    await lab.join(agent('cy'), coordinator=True)
    await lab.badge('bo', 'p-1', 'breakthrough', reason='It gives the strategy a size.')
    with pytest.raises(RejectedEvent, match='Only the person, and the agent to which the person gave'):
        await lab.badge('bo', 'p-1', 'breakthrough', 'second')

    seconded = await lab.badge('cy', 'p-1', 'breakthrough', 'second')

    assert (seconded.by, seconded.giver, seconded.reason) == ('cy', 'bo', '')
    assert marks(lab.board, 'p-1') == (0, 0, ('breakthrough',))
    with pytest.raises(RejectedEvent, match='No proposal of a `breakthrough` badge for post p-1 waits'):
        await lab.badge('person', 'p-1', 'breakthrough', 'second')
    # A lab that loads the record again checks every change once more and has the same badges.
    again = Lab.load(record_file).board
    assert marks(again, 'p-1') == (0, 0, ('breakthrough',))
    assert [type(event) for event in record_file.read()[-2:]] == [BadgeSet, BadgeSet]


async def test_a_vote_and_a_badge_end_no_wait_and_the_author_reads_them_afterwards(lab: Lab) -> None:
    ada = Member(lab, 'ada')
    waiting = asyncio.create_task(ada.wait(0.05))
    await asyncio.sleep(0)

    await Member(lab, 'bo').vote('p-1', 'down', 'One seed only.')
    await Member(lab, 'bo').badge('p-1', 'promising', reason='Worth the other seeds.')

    # The wait ran to its end: nothing woke the author. Its result has the vote and the badge.
    news = await waiting
    assert news.posts == ()
    assert [(note.by, note.direction, note.reason) for note in news.votes] == [('bo', 'down', 'One seed only.')]
    assert [(note.by, note.badge, note.action) for note in news.badges] == [('bo', 'promising', 'give')]
    assert ada.news().votes == ()


async def test_the_board_takes_no_vote_and_no_badge_from_a_guest_while_the_lab_is_out_of_time(lab: Lab) -> None:
    await lab.join(Agent(id='guest', name='Guest', harness='guest', model=ModelSpec(family='unknown')))
    guest, bo = Member(lab, 'guest'), Member(lab, 'bo')
    assert (await guest.vote('p-1', 'up', 'It holds.')).up == 1

    await lab.set_time_left(timedelta(0))
    with pytest.raises(OutOfTime, match='no vote, and no badge from you now'):
        await guest.vote('p-1', 'down', 'It does not.')
    with pytest.raises(OutOfTime):
        await guest.badge('p-1', 'promising', reason='Worth it.')
    # Verifold stops the turn of an agent that it started, so the board refuses that agent nothing.
    assert (await bo.vote('p-1', 'down', 'One seed only.')).down == 1
    with pytest.raises(RejectedEvent, match='Post p-9 does not exist'):
        await bo.vote('p-9', 'up', 'Yes.')

    await lab.set_time_left(timedelta(hours=1))
    assert (await guest.badge('p-1', 'promising', reason='Worth it.')).badges[0].given[0].by == 'guest'


async def test_agents_vote_and_give_badges_through_the_mcp_tools(lab: Lab) -> None:
    await lab.join(agent('cy'), coordinator=True)
    ada, bo, cy = Member(lab, 'ada'), Member(lab, 'bo'), Member(lab, 'cy')
    async with Client(join_server(lambda _: bo)) as client:
        up = await client.call_tool('vote', {'post': 'p-1', 'direction': 'up', 'reason': 'It matches my run.'})
        bare = await client.call_tool('vote', {'post': 'p-1', 'direction': 'down'})
        long = await client.call_tool('vote', {'post': 'p-1', 'direction': 'down', 'reason': 'x' * 141})
        given = await client.call_tool('badge', {'post': 'p-1', 'badge': 'promising', 'reason': 'Worth more seeds.'})
        proposed = await client.call_tool(
            'badge', {'post': 'p-1', 'badge': 'breakthrough', 'reason': 'It gives the strategy a size.'}
        )
        own_second = await client.call_tool('badge', {'post': 'p-1', 'badge': 'breakthrough', 'action': 'second'})
    async with Client(join_server(lambda _: cy)) as client:
        brief = await client.call_tool('brief', {})
        seconded = await client.call_tool('badge', {'post': 'p-1', 'badge': 'breakthrough', 'action': 'second'})
    async with Client(join_server(lambda _: ada)) as client:
        own = await client.call_tool('vote', {'post': 'p-1', 'direction': 'up', 'reason': 'Mine.'})
        thread = await client.call_tool('thread', {'thread': 't-1'})
        named = await client.call_tool('thread', {'thread': 't-1', 'votes_of': 'p-1'})
        missing = await client.call_tool('thread', {'thread': 't-1', 'votes_of': 'p-9'})
        later = await client.call_tool('brief', {})

    assert up.structured_content is not None
    assert [up.structured_content[key] for key in ('post', 'up', 'down', 'yours')] == ['p-1', 1, 0, 'up']
    for refused, why in (
        (bare, 'A vote down has a reason of one line'),
        (long, 'at most 140 characters'),
        (own_second, 'Only the person, and the agent to which the person gave the coordinator seat'),
        (own, 'Post p-1 is your own'),
    ):
        assert refused.is_error
        assert why in str(refused.content)
    assert given.structured_content is not None
    assert [line['badge'] for line in given.structured_content['badges']] == ['promising']
    assert proposed.structured_content is not None
    assert [(line['badge'], line['waits']) for line in proposed.structured_content['badges']] == [
        ('promising', False),
        ('breakthrough', True),
    ]
    # The coordinator reads the proposal in its news, in the brief that it calls, and seconds it.
    assert brief.structured_content is not None
    notes = brief.structured_content['news']['badges']
    assert [(note['badge'], note['by'], note['action']) for note in notes] == [('breakthrough', 'bo', 'give')]
    assert seconded.structured_content is not None
    assert [(line['badge'], line['waits']) for line in seconded.structured_content['badges']][1] == (
        'breakthrough',
        False,
    )
    # The author's thread shows who voted and why, and its news has the vote and the changes to the badges.
    assert thread.structured_content is not None
    post = thread.structured_content['posts'][0]
    assert (post['up'], post['down']) == (1, 0)
    assert [(vote['by'], vote['direction'], vote['reason']) for vote in post['votes']] == [
        ('bo', 'up', 'It matches my run.')
    ]
    assert [line['badge'] for line in post['badges']] == ['promising', 'breakthrough']
    assert named.structured_content is not None
    assert [vote['by'] for vote in named.structured_content['posts'][0]['votes']] == ['bo']
    assert missing.is_error
    assert 'Thread t-1 has no post with the ID p-9' in str(missing.content)
    news = thread.structured_content['news']
    assert [(note['by'], note['direction'], note['reason']) for note in news['votes']] == [
        ('bo', 'up', 'It matches my run.')
    ]
    assert [(note['badge'], note['by'], note['action']) for note in news['badges']] == [
        ('promising', 'bo', 'give'),
        ('breakthrough', 'bo', 'give'),
        ('breakthrough', 'cy', 'second'),
    ]
    # A brief has the counts and the badges on the line of the post, and no reason.
    assert later.structured_content is not None
    line = later.structured_content['your_line']['latest']
    assert (line['up'], line['badges']) == (1, ['promising', 'breakthrough'])
    assert 'down' not in line
    assert 'It matches my run.' not in str(later.structured_content)
    assert vote_of(lab.board, 'bo', 'p-1') is not None


def test_the_norms_say_what_a_vote_is_for_and_ask_no_agent_to_earn_votes() -> None:
    norm = 'Vote on a post when you have a reason that helps the others decide what to build on. Say the reason.'
    about = [line for line in NORMS_TEMPLATE.splitlines() if 'vote' in line.lower() or 'badge' in line.lower()]

    assert about == [f'- {norm}']
