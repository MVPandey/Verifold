import asyncio

import pytest
from builders import until

from verifold.protocol.join import PostRequest
from verifold.protocol.posts import Ask
from verifold.runner.permissions import GrantAsks, ask_the_person, choose, grant_choice, refusal, settled
from verifold.runner.session import PermissionChoice, PermissionRequest
from verifold.server.lab import Lab
from verifold.server.member import Member

CHOICES = (
    PermissionChoice(id='once', name='Allow once', kind='allow_once'),
    PermissionChoice(id='always', name='Allow always', kind='allow_always'),
    PermissionChoice(id='no', name='Reject', kind='reject_once'),
)


@pytest.mark.parametrize(
    ('answer', 'chosen'),
    [
        ('Allow always', 'always'),
        ('Allow always, no need to ask again.', 'always'),
        ('yes, go ahead', 'once'),
        ('ok, install it now', 'once'),
        ('I would say allow always here', 'always'),
        ('No, not now.', 'no'),
        ('allow? no.', 'no'),
        ("Don't allow", 'no'),
        ('Don\u2019t allow always', 'no'),
        ('Maybe later', 'no'),
        ('Reject', 'no'),
    ],
)
def test_the_answer_names_or_means_an_option(answer: str, chosen: str) -> None:
    assert choose(answer, CHOICES) == chosen


def test_without_a_reject_option_an_unclear_or_negative_answer_cancels() -> None:
    assert (choose('Maybe later', CHOICES[:2]), choose('no', CHOICES[:2])) == (None, None)


async def test_a_request_becomes_an_ask_to_the_person_and_their_answer_decides_it(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    request = PermissionRequest(title='run make', choices=CHOICES)

    asking = asyncio.create_task(ask_the_person(bo, request))
    await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
    asked = lab.board.posts[-1].post
    await lab.post(PostRequest(kind='answer', text='Allow once.', thread=asked.thread, reply_to=asked.id), 'person')

    assert await asking == 'once'
    assert (asked.author, asked.mentions, asked.text) == ('bo', ('person',), 'Permission needed: run make')
    assert isinstance(asked, Ask)
    assert asked.choices == ('Allow once', 'Allow always', 'Reject')
    thread = lab.board.thread(asked.thread)
    assert thread is not None
    assert thread.thread.title == 'Permission requests from Bo'


async def test_later_requests_use_the_same_thread_and_wait_for_the_persons_answer(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    request = PermissionRequest(title='run make', choices=CHOICES)
    for answer in ('No.', 'Allow always'):
        asking = asyncio.create_task(ask_the_person(bo, request))
        await until(lambda: lab.board.posts[-1].post.kind == 'ask')
        asked = lab.board.posts[-1].post
        await lab.post(PostRequest(kind='answer', text='Not me.', thread=asked.thread, reply_to=asked.id), 'ada')
        await asyncio.sleep(0.05)
        assert not asking.done()
        await lab.post(PostRequest(kind='answer', text=answer, thread=asked.thread, reply_to=asked.id), 'person')
        await asking

    asks = [entry.post for entry in lab.board.posts if entry.post.kind == 'ask']
    assert len(asks) == 2
    assert asks[0].thread == asks[1].thread


async def test_the_whole_answer_decides_not_only_its_first_line(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    asking = asyncio.create_task(ask_the_person(bo, PermissionRequest(title='run make', choices=CHOICES)))
    await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
    asked = lab.board.posts[-1].post

    answer = PostRequest(kind='answer', text='Thanks for asking.', body='Yes, go ahead.', thread=asked.thread)
    await lab.post(answer.model_copy(update={'reply_to': asked.id}), 'person')

    assert await asking == 'once'


COMMAND = PermissionRequest(title='./gpu python3 train.py', choices=CHOICES, command='./gpu python3 train.py')


async def test_verifold_allows_a_call_to_the_board_and_a_granted_command_once(lab: Lab) -> None:
    board_call = PermissionRequest(title='mcp.verifold.post', choices=CHOICES, board=True)
    piped = COMMAND.model_copy(update={'command': './gpu python3 train.py | tail -1'})
    before = settled(lab.board, COMMAND)
    await lab.grant('./gpu')

    assert before is None
    assert (settled(lab.board, board_call), settled(lab.board, COMMAND)) == ('once', 'once')
    assert settled(lab.board, piped) is None
    assert settled(lab.board, PermissionRequest(title='run make', choices=CHOICES)) is None


def test_a_request_without_an_allow_once_answer_goes_to_the_person(lab: Lab) -> None:
    assert settled(lab.board, PermissionRequest(title='post', choices=CHOICES[1:], board=True)) is None


def test_a_refusal_picks_the_reject_answer_or_cancels() -> None:
    assert (refusal(COMMAND), refusal(COMMAND.model_copy(update={'choices': CHOICES[:2]}))) == ('no', None)


async def test_the_person_can_answer_a_command_with_a_grant_for_every_agent(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    piped = COMMAND.model_copy(update={'command': './gpu python3 train.py | tail -1'})

    asking = asyncio.create_task(ask_the_person(bo, piped))
    await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
    asked = lab.board.posts[-1].post
    answer = PostRequest(kind='answer', text='Allow `./gpu` for every agent', thread=asked.thread, reply_to=asked.id)
    await lab.post(answer, 'person')

    assert isinstance(asked, Ask)
    assert asked.choices == ('Allow once', 'Allow always', 'Reject', 'Allow `./gpu` for every agent')
    # The person allowed this command too, although the grant doesn't cover its pipe.
    assert await asking == 'once'
    assert lab.board.grants == ('./gpu',)


async def test_a_plain_allow_gives_no_grant(lab: Lab) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), COMMAND))
    await until(lambda: any(entry.post.kind == 'ask' for entry in lab.board.posts))
    asked = lab.board.posts[-1].post
    await lab.post(PostRequest(kind='answer', text='Allow once', thread=asked.thread, reply_to=asked.id), 'person')

    assert await asking == 'once'
    assert lab.board.grants == ()


async def test_after_a_refusal_the_person_gets_one_ask_for_the_grant_and_their_answer_gives_it(lab: Lab) -> None:
    asks = GrantAsks(lab)
    watching = asyncio.create_task(asks.run())
    try:
        await asks.offer(Member(lab, 'bo'), COMMAND)
        await asks.offer(Member(lab, 'ada'), COMMAND.model_copy(update={'command': './gpu python3 probe.py'}))
        asked = [entry.post for entry in lab.board.posts if entry.post.kind == 'ask']
        answer = PostRequest(kind='answer', text=grant_choice('./gpu'), thread=asked[0].thread, reply_to=asked[0].id)
        await lab.post(answer, 'person')
        await until(lambda: lab.board.grants == ('./gpu',))
    finally:
        watching.cancel()

    assert len(asked) == 1
    assert isinstance(asked[0], Ask)
    assert (asked[0].author, asked[0].mentions) == ('bo', ('person',))
    assert asked[0].choices == ('Allow `./gpu` for every agent', 'No')
    assert './gpu python3 train.py' in asked[0].body


async def test_a_no_to_the_grant_gives_none_and_the_next_refusal_asks_again(lab: Lab) -> None:
    asks = GrantAsks(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(asks.run())
    try:
        await asks.offer(bo, COMMAND)
        asked = lab.board.posts[-1].post
        await lab.post(PostRequest(kind='answer', text='No', thread=asked.thread, reply_to=asked.id), 'person')
        await asyncio.sleep(0.1)
        await asks.offer(bo, COMMAND)
    finally:
        watching.cancel()

    assert lab.board.grants == ()
    assert [entry.post.kind for entry in lab.board.posts].count('ask') == 2


async def test_a_command_that_no_grant_fits_gets_no_ask(lab: Lab) -> None:
    asks = GrantAsks(lab)

    await asks.offer(Member(lab, 'bo'), COMMAND.model_copy(update={'command': 'A=1 make'}))
    await asks.offer(Member(lab, 'bo'), COMMAND.model_copy(update={'choices': CHOICES[1:]}))

    assert all(entry.post.kind != 'ask' for entry in lab.board.posts)
