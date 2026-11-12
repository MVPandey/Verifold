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
PIPED = COMMAND.model_copy(update={'command': './gpu python3 train.py | tail -1'})


async def answered(lab: Lab, text: str, body: str = '') -> None:
    """Answer the newest ask as the person."""
    asked = next(entry.post for entry in reversed(lab.board.posts) if entry.post.kind == 'ask')
    await lab.post(PostRequest(kind='answer', text=text, body=body, thread=asked.thread, reply_to=asked.id), 'person')


def asks(lab: Lab) -> list[Ask]:
    return [entry.post for entry in lab.board.posts if isinstance(entry.post, Ask)]


async def test_verifold_allows_a_call_to_the_board_and_a_granted_command_once(lab: Lab) -> None:
    board_call = PermissionRequest(title='mcp.verifold.post', choices=CHOICES, board=True)
    before = settled(lab.board, COMMAND)
    await lab.grant('./gpu')

    assert before is None
    assert (settled(lab.board, board_call), settled(lab.board, COMMAND)) == ('once', 'once')
    assert settled(lab.board, PIPED) is None
    assert settled(lab.board, PermissionRequest(title='run make', choices=CHOICES)) is None


def test_a_request_without_an_allow_once_answer_goes_to_the_person(lab: Lab) -> None:
    assert settled(lab.board, PermissionRequest(title='post', choices=CHOICES[1:], board=True)) is None


def test_a_refusal_picks_the_reject_answer_or_cancels() -> None:
    assert (refusal(COMMAND), refusal(COMMAND.model_copy(update={'choices': CHOICES[:2]}))) == ('no', None)


async def test_the_person_can_answer_a_command_with_a_grant_for_every_agent(lab: Lab) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), COMMAND))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Allow `./gpu` for every agent')

    assert asks(lab)[0].choices == ('Allow once', 'Allow always', 'Reject', 'Allow `./gpu` for every agent')
    assert await asking == 'once'
    assert lab.board.grants == ('./gpu',)


@pytest.mark.parametrize(
    ('text', 'body', 'chosen'),
    [
        ('Allow once', '', 'once'),
        ('Allow', 'gpu for every agent', 'once'),
        ('Allow ./gpu for every agent? No, never.', '', 'no'),
        ('yes', '', 'once'),
    ],
)
async def test_only_the_grant_choice_gives_a_grant_when_the_harness_asks(
    lab: Lab, text: str, body: str, chosen: str
) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), COMMAND))
    await until(lambda: bool(asks(lab)))
    await answered(lab, text, body)

    assert await asking == chosen
    assert lab.board.grants == ()


@pytest.mark.parametrize(
    'request_',
    [
        PIPED,
        COMMAND.model_copy(update={'choices': CHOICES[1:]}),
        COMMAND.model_copy(update={'command': f'/{"long/" * 16}python3 train.py'}),
        PermissionRequest(title='run make', choices=CHOICES),
    ],
)
async def test_a_request_that_no_grant_can_cover_offers_none(lab: Lab, request_: PermissionRequest) -> None:
    grant_asks = GrantAsks(lab)
    await grant_asks.offer(Member(lab, 'ada'), request_)
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), request_))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Reject')
    await asking

    assert [ask.choices for ask in asks(lab)] == [tuple(choice.name for choice in request_.choices)]


async def test_agents_refused_at_the_same_moment_share_one_ask_and_the_answer_gives_the_grant(lab: Lab) -> None:
    grant_asks = GrantAsks(lab)
    watching = asyncio.create_task(grant_asks.run())
    probe = COMMAND.model_copy(update={'command': './gpu python3 probe.py'})
    try:
        await asyncio.gather(grant_asks.offer(Member(lab, 'bo'), COMMAND), grant_asks.offer(Member(lab, 'ada'), probe))
        await answered(lab, grant_choice('./gpu'))
        await until(lambda: lab.board.grants == ('./gpu',))
    finally:
        watching.cancel()

    (asked,) = asks(lab)
    assert (asked.author, asked.mentions) == ('bo', ('person',))
    assert asked.text == 'Refused without a grant: ./gpu python3 train.py'
    assert asked.choices == ('Allow `./gpu` for every agent', 'No')
    assert './gpu python3 train.py' in asked.body


@pytest.mark.parametrize(
    ('text', 'grants', 'asked'),
    [
        ('yes, fine', ('./gpu',), 1),
        ('Allow ./gpu for every agent', ('./gpu',), 1),
        ('No', (), 1),
        ('Allow ./gpu for every agent? No, never.', (), 1),
        ('Let me go look at it first.', (), 2),
    ],
)
async def test_a_yes_gives_the_grant_a_no_ends_the_asks_and_another_answer_lets_the_next_refusal_ask(
    lab: Lab, text: str, grants: tuple[str, ...], asked: int
) -> None:
    grant_asks = GrantAsks(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(grant_asks.run())
    try:
        await grant_asks.offer(bo, COMMAND)
        await answered(lab, text)
        await until(lambda: './gpu' not in grant_asks._open)
        # A covered command is not refused, so only a command without its grant comes here again.
        if not grants:
            await grant_asks.offer(bo, COMMAND)
    finally:
        watching.cancel()

    assert lab.board.grants == grants
    assert len(asks(lab)) == asked


async def test_the_picked_choice_gives_the_grant_whatever_the_command_is_called(lab: Lab) -> None:
    grant_asks = GrantAsks(lab)
    watching = asyncio.create_task(grant_asks.run())
    try:
        await grant_asks.offer(Member(lab, 'bo'), COMMAND.model_copy(update={'command': './stop now'}))
        await answered(lab, 'allow `./stop` for every agent')
        await until(lambda: lab.board.grants == ('./stop',))
    finally:
        watching.cancel()


async def test_an_ask_that_fails_frees_its_place(lab: Lab, monkeypatch: pytest.MonkeyPatch) -> None:
    grant_asks = GrantAsks(lab)
    bo = Member(lab, 'bo')

    async def fail(_: PostRequest) -> None:
        raise RuntimeError('The board is away.')

    with monkeypatch.context() as patch:
        patch.setattr(bo, 'post', fail)
        with pytest.raises(RuntimeError):
            await grant_asks.offer(bo, COMMAND)
    await grant_asks.offer(bo, COMMAND)

    assert len(asks(lab)) == 1
