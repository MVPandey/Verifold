import asyncio
import json
from datetime import datetime, timedelta

import pytest
from builders import START, until
from conftest import agent
from mcp import Client

from verifold.app import NORMS_TEMPLATE
from verifold.protocol.events import RoundClosed
from verifold.protocol.ids import PERSON
from verifold.protocol.join import SEALED_TEXT, PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.server.timekeeper import keep_rounds
from verifold.society.errors import RejectedEvent
from verifold.society.views import thread_view
from verifold.store.record_file import RecordFile

SECRET = 'Bet on the tail of the cache.'
DETAIL = 'The second seed fails without it.'


class Clock:
    """The lab's clock, which a test moves. It starts at `START`."""

    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now

    def move(self, minutes: float) -> None:
        self.now += timedelta(minutes=minutes)


async def round_lab(record_file: RecordFile, clock: Clock) -> Lab:
    """A lab of ada, bo, cy, and dan on call, with ada's result p-1 in t-1 and ada's round p-2, open for 10 minutes."""
    lab = Lab.create(record_file, 'Does it hold?', clock=clock)
    for name in ('ada', 'bo', 'cy', 'dan'):
        await lab.join(agent(name), on_call=name == 'dan')
    await lab.post(PostRequest(kind='result', text='Beats random.', new_thread='Does it beat random?'), 'ada')
    await lab.post(PostRequest(kind='round', text='What is your best bet now?', thread='t-1', minutes=10), 'ada')
    return lab


def enter(text: str = 'My bet.', **fields: object) -> PostRequest:
    return PostRequest.model_validate({'kind': 'entry', 'text': text, 'thread': 't-1', 'reply_to': 'p-2'} | fields)


async def test_an_agent_opens_a_round_with_the_post_tool_and_the_board_refuses_a_second_one(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        opened = await client.call_tool(
            'post', {'kind': 'round', 'text': 'What would you drop?', 'thread': 't-1', 'minutes': 5}
        )
        long = await client.call_tool('post', {'kind': 'round', 'text': 'Why?', 'thread': 't-1', 'minutes': 16})
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        second = await client.call_tool('post', {'kind': 'round', 'text': 'And this?', 'thread': 't-1', 'minutes': 5})
        brief = await client.call_tool('brief', {})
        message = await client.call_tool('post', {'kind': 'message', 'text': 'Hi.', 'thread': 't-1', 'minutes': 5})

    assert opened.structured_content is not None
    assert (opened.structured_content['post']['kind'], opened.structured_content['post']['minutes']) == ('round', 5)
    assert long.is_error
    assert second.is_error
    closes = lab.board.posts[-1].at + timedelta(minutes=5)
    assert f'Round p-2 is open until {closes:%Y-%m-%d %H:%M} UTC. A lab has one open round at a time.' in str(
        second.content
    )
    assert brief.structured_content is not None
    line = brief.structured_content['round']
    # The round waits for bo, and not for ada, which asked.
    assert (line['round']['id'], line['round']['text'], line['not_entered']) == ('p-2', 'What would you drop?', 1)
    assert message.is_error


async def test_a_round_rings_every_agent_that_is_not_on_call_and_an_entry_rings_nobody(
    record_file: RecordFile,
) -> None:
    clock = Clock()
    lab = Lab.create(record_file, 'Does it hold?', clock=clock)
    for name in ('ada', 'bo', 'cy', 'dan'):
        await lab.join(agent(name), on_call=name == 'dan')
    await lab.post(PostRequest(kind='result', text='Beats random.', new_thread='Does it beat random?'), 'ada')
    bo, dan = Member(lab, 'bo'), Member(lab, 'dan')
    waiting, idle = asyncio.create_task(bo.wait(5)), asyncio.create_task(dan.wait(0.05))
    await asyncio.sleep(0)

    await lab.post(PostRequest(kind='round', text='Best bet?', thread='t-1', minutes=10), 'ada')

    assert [view.post.kind for view in (await waiting).posts] == ['round']
    assert (await idle).posts == ()
    # An entry names ada and replies to ada's round, and it wakes neither ada nor anybody else.
    ada = Member(lab, 'ada')
    waits = asyncio.create_task(ada.wait(0.05))
    await asyncio.sleep(0)
    await lab.post(enter('Ask ada about agent-1.', mentions=('ada',)), 'bo')
    assert (await waits).posts == ()


async def test_the_lab_closes_a_round_in_the_step_of_the_last_entry_and_every_agent_hears_the_entries(
    record_file: RecordFile,
) -> None:
    clock = Clock()
    lab = await round_lab(record_file, clock)
    bo, cy, dan = Member(lab, 'bo'), Member(lab, 'cy'), Member(lab, 'dan')
    await lab.post(enter(SECRET, body=DETAIL), 'bo')
    await lab.post(enter('From the side line.'), 'dan')
    # The opener can enter, and the round does not wait for it.
    await lab.post(enter('Keep the cache.'), 'ada')
    assert not lab.board.round_closes
    waiting = asyncio.create_task(bo.wait(5))
    await asyncio.sleep(0)

    await lab.post(enter('Drop the night runs.'), 'cy')

    # The last entry and the close are one step of the record.
    assert [type(event).__name__ for event in record_file.read()[-2:]] == ['Posted', 'RoundClosed']
    assert lab.board.round_closes[-1].why == 'entered'
    # The close ends a wait, and the news of every agent that the round was for carries the entries.
    (note,) = (await waiting).rounds
    assert [(line.author, line.text) for line in note.entries] == [
        ('bo', SECRET),
        ('dan', 'From the side line.'),
        ('ada', 'Keep the cache.'),
        ('cy', 'Drop the night runs.'),
    ]
    assert [line.author for line in cy.news().rounds[0].entries] == ['bo', 'dan', 'ada', 'cy']
    # dan is on call, and it entered, so it hears the close too.
    assert len(dan.news().rounds) == 1
    # From the close on, an entry is a post like any other.
    await lab.vote('cy', 'p-3', 'up', 'A good bet.')
    await lab.post(PostRequest(kind='objection', text='One seed.', thread='t-1', reply_to='p-3'), 'cy')


async def test_the_opener_closes_its_round_with_a_ruled_out_lead_and_a_round_closes_at_its_time(
    record_file: RecordFile,
) -> None:
    clock = Clock()
    lab = await round_lab(record_file, clock)
    await lab.post(enter(SECRET), 'bo')
    # Another agent's ruled-out lead that replies to the round closes nothing.
    await lab.post(PostRequest(kind='ruled_out', text='Not for me.', thread='t-1', reply_to='p-2'), 'cy')
    assert not lab.board.round_closes

    await lab.post(PostRequest(kind='ruled_out', text='Enough entries.', thread='t-1', reply_to='p-2'), 'ada')

    assert (lab.board.round_closes[-1].why, lab.board.round_closes[-1].seq) == ('opener', lab.board.seq)
    # The next round closes at its time, by the lab's clock: the next step of the record says so first.
    await lab.post(PostRequest(kind='round', text='Again?', thread='t-1', minutes=1), 'bo')
    await lab.post(enter('Mine.', reply_to='p-6'), 'cy')
    clock.move(1)
    with pytest.raises(RejectedEvent, match=r'Round p-6 is closed, so it takes no entry\.'):
        await lab.post(enter('Late.', reply_to='p-6'), 'ada')
    await lab.close_rounds()
    assert [(close.round, close.why) for close in lab.board.round_closes] == [('p-2', 'opener'), ('p-6', 'time')]
    seq = lab.board.seq
    await lab.close_rounds()
    assert lab.board.seq == seq


async def test_a_round_whose_time_passed_while_verifold_was_stopped_closes_when_the_lab_is_served_again(
    record_file: RecordFile,
) -> None:
    clock = Clock()
    lab = await round_lab(record_file, clock)
    await lab.post(enter(SECRET, body=DETAIL), 'bo')
    seq = lab.board.seq
    assert SEALED_TEXT in json.dumps(Member(lab, 'cy').thread('t-1').model_dump(mode='json'))

    # Verifold stops, and the round's time passes. The lab that loads the record shows every entry at once.
    clock.move(30)
    again = Lab.load(record_file, clock=clock)
    assert again.board == lab.board
    cy = Member(again, 'cy', seen=seq)
    assert SECRET in json.dumps(cy.thread('t-1').model_dump(mode='json'))
    keeping = asyncio.create_task(keep_rounds(again))
    try:
        await until(lambda: bool(again.board.round_closes))
    finally:
        keeping.cancel()
    assert again.board.round_closes[-1].why == 'time'
    assert [line.text for line in cy.news().rounds[0].entries] == [SECRET]
    # The record with the round and its close loads again with the same board.
    assert Lab.load(record_file, clock=clock).board == again.board


async def test_a_round_stays_sealed_while_the_lab_is_out_of_time_and_closes_at_its_time_all_the_same(
    record_file: RecordFile,
) -> None:
    clock = Clock()
    lab = await round_lab(record_file, clock)
    await lab.post(enter(SECRET), 'bo')
    await lab.set_time_left(timedelta(0))
    await lab.run_out_of_time()
    cy = Member(lab, 'cy')
    assert SECRET not in json.dumps(cy.thread('t-1').model_dump(mode='json'))

    clock.move(10)
    await lab.close_rounds()
    assert lab.board.round_closes[-1].why == 'time'
    await lab.set_time_left(timedelta(hours=1))
    assert [line.text for line in cy.news().rounds[0].entries] == [SECRET]


async def test_an_agent_reads_no_sealed_entry_through_any_tool_a_helpers_name_a_reply_or_a_link(
    record_file: RecordFile,
) -> None:
    clock = Clock()
    lab = await round_lab(record_file, clock)
    pinned = (FileEvidence(path='tail.py', commit='d' * 40),)
    await lab.post(enter(SECRET, body=DETAIL, helper='scout', mentions=('cy',), builds_on=('p-1',)), 'bo', pinned)
    # The entry names cy and builds on ada's result, and neither hears of it.
    cy = Member(lab, 'cy')

    async def every_result(member: Member) -> str:
        # Each tool that returns a part of the board, as the agent calls it, the refusals among them.
        async with Client(join_server(lambda _: member)) as client:
            calls = (
                ('brief', {}),
                ('threads', {}),
                ('thread', {'thread': 't-1'}),
                ('thread', {'thread': 't-1', 'votes_of': 'p-3'}),
                ('wait', {'timeout_seconds': 0}),
                # A helper's name is the helper's own word, and the token decides who reads.
                ('post', {'kind': 'message', 'text': 'Reading.', 'thread': 't-1', 'helper': 'bo'}),
                ('post', {'kind': 'message', 'text': 'Reading again.', 'thread': 't-1', 'helper': 'Bo'}),
                ('post', {'kind': 'message', 'text': 'Show it.', 'reply_to': 'p-3'}),
                ('post', {'kind': 'objection', 'text': 'Wrong.', 'reply_to': 'p-3'}),
                ('post', {'kind': 'result', 'text': 'Same.', 'thread': 't-1', 'builds_on': ['p-3']}),
                ('vote', {'post': 'p-3', 'direction': 'up', 'reason': 'Good.'}),
                ('badge', {'post': 'p-3', 'badge': 'promising', 'reason': 'Good.'}),
                ('rerun', {'post': 'p-3'}),
                ('take_rerun', {'post': 'p-3'}),
                ('watch', {'thread': 't-1'}),
                ('profile', {}),
            )
            results = [await client.call_tool(name, arguments) for name, arguments in calls]
        refused = [name for (name, _), result in zip(calls, results, strict=True) if result.is_error]
        assert refused == ['post', 'post', 'post', 'vote', 'badge', 'rerun', 'take_rerun']
        return json.dumps([(result.structured_content, str(result.content)) for result in results])

    seen = await every_result(cy)
    for part in (SECRET, DETAIL, 'scout', 'tail.py', 'd' * 40):
        assert part not in seen, part
    assert 'which is open until 2026-11-06 12:10 UTC' in seen
    assert SEALED_TEXT in seen
    # The opener reads nothing either, and the author and the person read the entry whole.
    assert SECRET not in await _thread_of(Member(lab, 'ada'))
    assert SECRET in await _thread_of(Member(lab, 'bo'))
    assert thread_view(lab.board, PERSON, 't-1').posts[2].post.text == SECRET


async def _thread_of(member: Member) -> str:
    async with Client(join_server(lambda _: member)) as client:
        result = await client.call_tool('thread', {'thread': 't-1'})
    return json.dumps(result.structured_content)


def test_the_norms_say_when_to_open_a_round_and_how_to_enter_it() -> None:
    start = NORMS_TEMPLATE.index('## Rounds')
    section = NORMS_TEMPLATE[start : NORMS_TEMPLATE.index('\n## ', start + 1)]

    assert section.strip().split('\n\n')[1:] == [
        (
            'A round asks every agent that is not on call the same question at the same moment, and the board keeps '
            'each entry hidden from the other agents until the round closes. So each agent says what it thinks '
            'before it reads what '
            'the others think. Agents that read each other first end up with the same few ideas.'
        ),
        (
            'Open a round when the lab needs every view at once. The coordinator opens one at each review of the '
            "reading, as the section on the coordinator says, and when the lab's lines stall. A round that "
            'asks what each agent found and what its best bet is, and a round that asks which line each agent would '
            'drop, and why, are examples. Few agents say in a thread that a line of the lab is not worth its hands, '
            "and the sealed entries show where those doubts agree. Any agent opens a wild round when the lab's lines "
            'are all of one kind: one idea from outside the kinds that the lab has tried, with no judgement of it '
            'until the round closes.'
        ),
        (
            "Write your entry from your own work and before you look for hints of the others' entries. After the "
            'round closes, read all of them, and keep the talk about them short: say what you take up and what you '
            'drop. One round is better than three in a row.'
        ),
    ]
    assert NORMS_TEMPLATE.index('## Chain ideas') < start < NORMS_TEMPLATE.index('## The coordinator')


def test_a_close_names_its_round_and_why() -> None:
    assert RoundClosed(seq=2, at=START, round='p-2', why='opener').type == 'round_closed'
