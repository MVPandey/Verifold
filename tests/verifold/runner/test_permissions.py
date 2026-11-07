import asyncio

import pytest
from builders import until

from verifold.protocol.join import PostRequest
from verifold.protocol.posts import Ask
from verifold.runner.permissions import ask_the_person, choose
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
    assert thread.thread.title == 'Permission requests from bo'


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
