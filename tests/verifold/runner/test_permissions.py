import asyncio

import pytest
from builders import until

from verifold.protocol.join import PostRequest
from verifold.protocol.posts import Ask
from verifold.runner.permissions import (
    Refusals,
    ask_the_person,
    ask_the_question,
    choose,
    grant_choice,
    refusal,
    settled,
)
from verifold.runner.session import Answers, FieldOption, PermissionChoice, PermissionRequest, Question, QuestionField
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


UNCOVERED = [
    PIPED,
    COMMAND.model_copy(update={'choices': CHOICES[1:]}),
    COMMAND.model_copy(update={'command': f'/{"long/" * 16}python3 train.py'}),
    PermissionRequest(title='Edit notes.md', choices=CHOICES, detail='{"path": "notes.md"}'),
]


@pytest.mark.parametrize('request_', UNCOVERED)
async def test_a_request_that_no_grant_can_cover_is_asked_with_the_harnesss_own_answers(
    lab: Lab, request_: PermissionRequest
) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), request_))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Reject')
    await asking

    (asked,) = asks(lab)
    assert (asked.choices, asked.body) == (tuple(choice.name for choice in request_.choices), request_.detail)


@pytest.mark.parametrize('request_', UNCOVERED)
async def test_a_refused_request_that_no_grant_can_cover_is_asked_and_the_answer_decides_its_next_try_once(
    lab: Lab, request_: PermissionRequest
) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(refusals.run())
    try:
        first = await refusals.decide(bo, request_)
        again = await refusals.decide(bo, request_)
        await answered(lab, request_.choices[0].name)
        await until(lambda: not refusals._open)
        other = await refusals.decide(Member(lab, 'ada'), request_)
        tried = await refusals.decide(bo, request_)
        later = await refusals.decide(bo, request_)
    finally:
        watching.cancel()

    refused = refusal(request_)
    assert (first, again, other, tried, later) == (refused, refused, refused, request_.choices[0].id, refused)
    assert [(ask.author, ask.text) for ask in asks(lab)] == [
        (author, f'Permission needed: {request_.title}') for author in ('bo', 'ada', 'bo')
    ]
    assert asks(lab)[0].choices == tuple(choice.name for choice in request_.choices)
    assert request_.detail in asks(lab)[0].body
    assert 'Your answer applies when the agent asks again.' in asks(lab)[0].body
    assert lab.board.grants == ()


async def test_an_answer_in_the_persons_own_words_that_names_no_option_rejects_the_next_try(lab: Lab) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.decide(bo, PIPED)
        await answered(lab, 'Maybe later')
        await until(lambda: not refusals._open)
        tried = await refusals.decide(bo, PIPED)
    finally:
        watching.cancel()

    assert (tried, len(asks(lab))) == ('no', 1)


FORM = Question(
    message='Set up the run',
    fields=(
        QuestionField(name='name', title='Name', kind='text', description='What the run is called.'),
        QuestionField(name='gpus', title='GPUs', kind='integer'),
        QuestionField(name='rate', title='Rate', kind='number'),
        QuestionField(name='dry', title='Dry run', kind='boolean'),
        QuestionField(
            name='branch',
            title='Branch',
            kind='choice',
            options=(FieldOption(value='main', name='Main'), FieldOption(value='dev', name='Dev')),
        ),
        QuestionField(
            name='sets',
            title='Sets',
            kind='choices',
            options=(FieldOption(value='a', name='Alpha'), FieldOption(value='b', name='Beta')),
        ),
    ),
)


async def asked_question(lab: Lab, question: Question, replies: list[tuple[str, str]]) -> Answers | None:
    """Ask `question` as bo, answer each ask in turn as the person, and return what the harness gets."""
    asking = asyncio.create_task(ask_the_question(Member(lab, 'bo'), question))
    for number, (text, body) in enumerate(replies, start=1):
        await until(lambda number=number: len(asks(lab)) == number)
        await answered(lab, text, body)
    return await asking


async def test_a_question_becomes_one_ask_for_each_field_and_the_answers_keep_each_fields_kind(lab: Lab) -> None:
    replies = [('Run 7', 'The second try.'), ('2', ''), ('0.5', ''), ('Yes', ''), ('dev', ''), ('Alpha, b', '')]

    answers = await asked_question(lab, FORM, replies)

    assert answers == {
        'name': 'Run 7\nThe second try.',
        'gpus': 2,
        'rate': 0.5,
        'dry': True,
        'branch': 'dev',
        'sets': ['a', 'b'],
    }
    assert [(ask.text, ask.choices) for ask in asks(lab)] == [
        ('Set up the run: Name', ()),
        ('Set up the run: GPUs', ()),
        ('Set up the run: Rate', ()),
        ('Set up the run: Dry run', ('Yes', 'No')),
        ('Set up the run: Branch', ('Main', 'Dev')),
        ('Set up the run: Sets', ()),
    ]
    assert [ask.body for ask in asks(lab)] == [
        'What the run is called.',
        'Answer with a whole number.',
        'Answer with a number.',
        '',
        '',
        'The options: Alpha, Beta.\n\nName each option that you choose, with commas between them.',
    ]
    thread = lab.board.thread(asks(lab)[0].thread)
    assert thread is not None
    assert (thread.thread.title, {ask.thread for ask in asks(lab)}) == ('Questions from Bo', {asks(lab)[0].thread})


@pytest.mark.parametrize(
    ('field', 'reply'),
    [('gpus', 'a few'), ('rate', 'fast'), ('dry', 'maybe'), ('branch', 'release'), ('sets', 'Alpha, Gamma')],
)
async def test_an_answer_that_does_not_fit_its_field_ends_the_question_without_an_answer(
    lab: Lab, field: str, reply: str
) -> None:
    one = Question(message='Set up the run', fields=tuple(each for each in FORM.fields if each.name == field))

    assert await asked_question(lab, one, [(reply, '')]) is None


async def test_a_no_answers_a_yes_or_no_field_and_a_long_question_goes_in_the_body(lab: Lab) -> None:
    long = 'Run it dry? ' * 40
    dry = Question(message=long, fields=(FORM.fields[3],))

    assert await asked_question(lab, dry, [('No, run it.', '')]) == {'dry': False}
    assert (asks(lab)[0].text, asks(lab)[0].body) == (long.strip()[:300].strip(), long)


async def test_a_question_without_a_message_is_asked_by_its_fields_title(lab: Lab) -> None:
    assert await asked_question(lab, Question(message='', fields=(FORM.fields[3],)), [('yes', '')]) == {'dry': True}
    assert asks(lab)[0].text == 'Dry run'


async def test_options_that_the_board_cannot_offer_as_choices_are_listed_and_named_in_the_answer(lab: Lab) -> None:
    many = tuple(FieldOption(value=f'v{number}', name=f'Option {number}') for number in range(12))
    pick = Question(message='Which one?', fields=(QuestionField(name='one', title='One', kind='choice', options=many),))

    assert await asked_question(lab, pick, [('option 11', '')]) == {'one': 'v11'}
    assert (asks(lab)[0].choices, asks(lab)[0].body.startswith('The options: Option 0, Option 1,')) == ((), True)


async def test_agents_refused_at_the_same_moment_share_one_ask_and_the_answer_gives_the_grant(lab: Lab) -> None:
    refusals = Refusals(lab)
    watching = asyncio.create_task(refusals.run())
    probe = COMMAND.model_copy(update={'command': './gpu python3 probe.py'})
    try:
        await asyncio.gather(refusals.offer(Member(lab, 'bo'), COMMAND), refusals.offer(Member(lab, 'ada'), probe))
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
        ('No', (), 2),
        ('Allow ./gpu for every agent? No, never.', (), 2),
        ('Let me go look at it first.', (), 2),
    ],
)
async def test_a_yes_gives_the_grant_a_no_ends_the_offer_and_another_answer_lets_the_next_refusal_offer_it(
    lab: Lab, text: str, grants: tuple[str, ...], asked: int
) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.offer(bo, COMMAND)
        await answered(lab, text)
        await until(lambda: './gpu' not in refusals._open)
        # A covered command is not refused, so only a command without its grant comes here again.
        if not grants:
            await refusals.offer(bo, COMMAND)
    finally:
        watching.cancel()

    assert lab.board.grants == grants
    assert len(asks(lab)) == asked
    # After a no to the grant, the command is asked as that one command, with the harness's own answers.
    again = 'Refused without a grant' if 'look' in text else 'Permission needed'
    assert all(ask.text.startswith(again) for ask in asks(lab)[1:])


async def test_a_command_that_the_headline_cannot_hold_is_shown_whole_in_the_ask(lab: Lab) -> None:
    command = f'python3 train.py --note "{"long " * 80}"'
    long = COMMAND.model_copy(update={'title': command, 'command': command})
    refusals = Refusals(lab)
    await refusals.offer(Member(lab, 'ada'), long)
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), long))
    await until(lambda: len(asks(lab)) == 2)
    await answered(lab, 'Reject')
    await asking

    refused, waited = asks(lab)
    assert (len(refused.text), waited.body, refused.body.startswith(f'{command}\n\n')) == (300, command, True)


async def test_the_picked_choice_gives_the_grant_whatever_the_command_is_called(lab: Lab) -> None:
    refusals = Refusals(lab)
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.offer(Member(lab, 'bo'), COMMAND.model_copy(update={'command': './stop now'}))
        await answered(lab, 'allow `./stop` for every agent')
        await until(lambda: lab.board.grants == ('./stop',))
    finally:
        watching.cancel()


async def test_an_ask_that_fails_frees_its_place(lab: Lab, monkeypatch: pytest.MonkeyPatch) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')

    async def fail(_: PostRequest) -> None:
        raise RuntimeError('The board is away.')

    with monkeypatch.context() as patch:
        patch.setattr(bo, 'post', fail)
        with pytest.raises(RuntimeError):
            await refusals.offer(bo, COMMAND)
    await refusals.offer(bo, COMMAND)

    assert len(asks(lab)) == 1
