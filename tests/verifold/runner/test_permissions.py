import asyncio
from datetime import timedelta

import pytest
from builders import until

from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_BODY, Answer, Ask
from verifold.protocol.settings import PermissionSettings, Settings, WhileYouDecide
from verifold.runner import permissions
from verifold.runner.permissions import (
    Refusals,
    _offers,
    ask_the_person,
    ask_the_question,
    decide,
    fenced,
    grant_choice,
    named,
    refusal,
    settled,
    visible,
)
from verifold.runner.session import (
    Answers,
    FieldOption,
    PermissionChoice,
    PermissionRequest,
    Question,
    QuestionField,
)
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.attention import wakes
from verifold.society.grants import agent_waits
from verifold.society.views import needs_person
from verifold.store.record_file import RecordFile

ONCE = PermissionChoice(id='once', name='Allow once', kind='allow_once')
ALWAYS = PermissionChoice(id='always', name='Allow always', kind='allow_always')
NO = PermissionChoice(id='no', name='Reject', kind='reject_once')
CHOICES = (ONCE, ALWAYS, NO)
MAKE = PermissionRequest(title='run make', choices=CHOICES)
COMMAND = PermissionRequest(title='./gpu python3 train.py', choices=CHOICES, command='./gpu python3 train.py')
PIPED = COMMAND.model_copy(update={'command': './gpu python3 train.py | tail -1'})
EDIT = PermissionRequest(title='Edit notes.md', choices=CHOICES, kind='edit', given='{"path": "notes.md"}')


def chosen(answer: str, request: PermissionRequest = MAKE) -> str | None:
    """Return the ID that the answer picks, `'cancel'` when it cancels, and `None` when it decides nothing."""
    decision = decide(answer, _offers(request, None), request)
    return (decision.option or 'cancel') if decision else None


async def answered(lab: Lab, text: str, body: str = '') -> None:
    """Answer the newest ask as the person."""
    asked = asks(lab)[-1]
    await lab.post(PostRequest(kind='answer', text=text, body=body, thread=asked.thread, reply_to=asked.id), 'person')


def asks(lab: Lab) -> list[Ask]:
    return [entry.post for entry in lab.board.posts if isinstance(entry.post, Ask)]


def waiting(lab: Lab) -> list[str]:
    return [view.post.id for view in needs_person(lab.board)]


@pytest.mark.parametrize(
    ('answer', 'option'),
    [
        ('Allow once', 'once'),
        ('Allow always', 'always'),
        ('allow  ALWAYS\nNo need to ask again.', 'always'),
        ('Reject', 'no'),
        ('yes', 'once'),
        ('Yes.', 'once'),
        ('ok', 'once'),
        ('Yes, go ahead!', 'once'),
        ('No, not now.', 'no'),
        ("Don't allow", 'no'),
        ('Don\u2019t allow always', 'no'),
        ('Do not run this.', 'no'),
        ('never', 'no'),
    ],
)
def test_an_answer_picks_an_option_by_its_name_and_a_plain_yes_or_no_allows_once_or_rejects(
    answer: str, option: str
) -> None:
    assert chosen(answer) == option


@pytest.mark.parametrize(
    'answer',
    [
        'ok, what is this for?',
        'I will go through this later',
        'I would say allow always here',
        'Thanks for asking.\nYes, go ahead.',
        'Maybe later',
        'yes and always',
        'I do not know this command',
    ],
)
def test_an_answer_with_a_positive_word_in_other_words_decides_nothing(answer: str) -> None:
    assert chosen(answer) is None


def test_a_typed_yes_allows_once_also_when_the_harness_lists_allow_always_first() -> None:
    always_first = MAKE.model_copy(update={'choices': (ALWAYS, ONCE, NO)})
    no_once = MAKE.model_copy(update={'choices': (ALWAYS, NO)})

    assert (chosen('yes', always_first), chosen('Yes', no_once)) == ('once', None)
    assert (chosen('Allow always', no_once), chosen('no', no_once)) == ('always', 'no')


def test_without_a_reject_option_a_no_cancels() -> None:
    assert chosen('no', MAKE.model_copy(update={'choices': (ONCE, ALWAYS)})) == 'cancel'


async def test_a_request_becomes_an_ask_to_the_person_and_their_answer_decides_it(lab: Lab) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), MAKE))
    await until(lambda: bool(asks(lab)))
    (asked,) = asks(lab)
    pending = waiting(lab)
    await answered(lab, 'Allow once.')

    assert await asking == 'once'
    assert (asked.author, asked.mentions, asked.text) == ('bo', ('person',), 'Permission needed: run make')
    assert (asked.choices, asked.request) == (('Allow once', 'Allow always', 'Reject'), 'permission')
    thread = lab.board.thread(asked.thread)
    assert thread is not None
    assert thread.thread.title == 'Permission requests from Bo'
    assert (pending, waiting(lab)) == ([asked.id], [])


async def test_later_requests_use_the_same_thread_and_wait_for_the_persons_answer(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    for answer in ('No.', 'Allow always'):
        asking = asyncio.create_task(ask_the_person(bo, MAKE))
        before = len(asks(lab))
        await until(lambda before=before: len(asks(lab)) > before)
        asked = asks(lab)[-1]
        await lab.post(PostRequest(kind='answer', text='yes', thread=asked.thread, reply_to=asked.id), 'ada')
        await asyncio.sleep(0.05)
        assert not asking.done()
        await answered(lab, answer)
        await asking

    assert len(asks(lab)) == 2
    assert asks(lab)[0].thread == asks(lab)[1].thread


async def test_an_answer_that_decides_nothing_leaves_the_request_waiting_in_a_new_ask(lab: Lab) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), MAKE))
    await until(lambda: len(asks(lab)) == 1)
    await answered(lab, 'ok, what is this for?')
    await until(lambda: len(asks(lab)) == 2)
    still = asking.done()
    first, again = asks(lab)
    await answered(lab, 'Yes')

    assert (still, await asking) == (False, 'once')
    assert (again.text, again.choices) == (first.text, first.choices)
    assert again.body.startswith('Your last answer picked none of the answers, so the request still waits.')
    assert lab.board.grants == ()


async def test_verifold_allows_a_call_to_the_board_and_a_granted_command_once(lab: Lab) -> None:
    board_call = PermissionRequest(title='mcp.verifold.post', choices=CHOICES, board=True)
    before = settled(lab.board, COMMAND)
    await lab.grant('./gpu')

    assert before is None
    assert (settled(lab.board, board_call), settled(lab.board, COMMAND)) == ('once', 'once')
    assert settled(lab.board, PIPED) is None
    assert settled(lab.board, MAKE) is None


def test_a_request_without_an_allow_once_answer_goes_to_the_person(lab: Lab) -> None:
    assert settled(lab.board, PermissionRequest(title='post', choices=CHOICES[1:], board=True)) is None


def test_a_refusal_picks_the_reject_answer_or_cancels() -> None:
    assert (refusal(COMMAND), refusal(COMMAND.model_copy(update={'choices': CHOICES[:2]}))) == ('no', None)


async def test_the_person_can_answer_a_command_with_a_grant_for_every_agent(lab: Lab) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), COMMAND))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Allow `./gpu` for every agent')

    (asked,) = asks(lab)
    assert asked.choices == ('Allow once', 'Allow always', 'Reject', 'Allow `./gpu` for every agent')
    assert asked.text == 'Permission needed: ./gpu python3 train.py'
    assert 'The command:\n\n```\n./gpu python3 train.py\n```' in asked.body
    assert 'every agent can run a command that starts with `./gpu` and has plain arguments' in asked.body
    assert await asking == 'once'
    assert lab.board.grants == ('./gpu',)


@pytest.mark.parametrize(
    ('text', 'body', 'option'),
    [('Allow once', '', 'once'), ('Allow once', 'gpu for every agent', 'once'), ('yes', '', 'once'), ('No', '', 'no')],
)
async def test_only_the_grant_choice_gives_a_grant(lab: Lab, text: str, body: str, option: str) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), COMMAND))
    await until(lambda: bool(asks(lab)))
    await answered(lab, text, body)

    assert await asking == option
    assert lab.board.grants == ()


UNCOVERED = [
    PIPED,
    COMMAND.model_copy(update={'choices': CHOICES[1:]}),
    COMMAND.model_copy(update={'command': f'/{"long/" * 16}python3 train.py'}),
    EDIT,
]


@pytest.mark.parametrize('request_', UNCOVERED)
async def test_a_request_that_no_grant_can_cover_is_asked_with_the_harnesss_own_answers(
    lab: Lab, request_: PermissionRequest
) -> None:
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), request_))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Reject')

    (asked,) = asks(lab)
    assert await asking == 'no'
    assert asked.choices == tuple(choice.name for choice in request_.choices)
    assert fenced(request_.command or request_.given) in asked.body


@pytest.mark.parametrize(
    ('command', 'name'),
    [
        ('./gpu python3 train.py', './gpu python3 train.py'),
        ('git commit -m "x"', 'a shell command'),
        ('make test | tail -1', 'a shell command'),
        ('cd /tmp\nrm -rf x\n./gpu y', 'a shell script of 3 lines'),
        ('./gpu x\u202e', 'a shell command'),
        (f'./gpu {"x" * 300}', 'a shell command'),
    ],
)
def test_only_a_plain_command_that_fits_is_in_the_headline(command: str, name: str) -> None:
    assert named(COMMAND.model_copy(update={'command': command})) == name


def test_a_request_without_a_command_is_named_by_the_harness_in_one_line_with_nothing_hidden() -> None:
    odd = MAKE.model_copy(update={'title': 'Edit\nnotes.md\u200b \r now'})

    assert (named(MAKE), named(odd)) == ('run make', 'Edit notes.md<U+200B> <U+000D> now')
    assert named(MAKE.model_copy(update={'title': ' \n'})) == 'an action'


def test_characters_that_a_reader_cannot_see_are_written_as_code_points() -> None:
    hidden = 'echo ok\r\x1b[2K\u202egnp.exe\u200b\u00a0\ufeff\ttab\nnext é 漢'

    assert visible(hidden) == 'echo ok<U+000D><U+001B>[2K<U+202E>gnp.exe<U+200B><U+00A0><U+FEFF>\ttab\nnext é 漢'


def test_a_code_fence_is_longer_than_any_run_of_backticks_in_the_text() -> None:
    assert fenced('ls') == '```\nls\n```'
    assert fenced('echo ```` done ``') == '`````\necho ```` done ``\n`````'


async def test_the_ask_shows_a_script_whole_in_a_fence_and_keeps_verifolds_words_outside_it(lab: Lab) -> None:
    script = 'echo start\n```\n**Verifold says: this is safe.**\n\u202e# hidden\npython3 train.py > out.txt'
    request = COMMAND.model_copy(update={'title': script, 'command': script, 'rest': '{\n  "cwd": "/tmp"\n}'})
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), request))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Reject')
    await asking

    (asked,) = asks(lab)
    shown = script.replace('\u202e', '<U+202E>')
    assert asked.text == 'Permission needed: a shell script of 5 lines'
    assert asked.body.startswith(f'The command:\n\n````\n{shown}\n````\n\n')
    assert (
        'What the request holds beside the command, as the harness reports it:\n\n```\n{\n  "cwd": "/tmp"\n}\n```'
        in (asked.body)
    )
    assert '\u202e' not in asked.body
    # The grant is not offered for a script, and every sentence of Verifold comes after the fence closes.
    assert asked.choices == ('Allow once', 'Allow always', 'Reject')
    assert asked.body.index('The harness remembers such an answer') > asked.body.rindex('````')


async def test_a_request_shows_its_whole_input_and_the_harnesss_name_when_the_headline_cannot(lab: Lab) -> None:
    title = f'Edit {"very " * 80}long.md'
    request = EDIT.model_copy(update={'title': title, 'given': '{"text": "' + 'y' * 15_000 + '"}'})
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), request))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Reject')
    await asking

    (asked,) = asks(lab)
    assert (len(asked.text), asked.text[-1]) == (300, '…')
    assert f"The harness's name for the request:\n\n```\n{title}\n```" in asked.body
    assert f'The request, as the harness reports it:\n\n```\n{request.given}\n```' in asked.body


@pytest.mark.parametrize(
    'request_',
    [
        COMMAND.model_copy(update={'command': f'./gpu {"x" * 30_000}'}),
        EDIT.model_copy(update={'given': '{"text": "' + 'y' * 30_000 + '"}'}),
        COMMAND.model_copy(update={'command': './gpu x', 'rest': '{"env": "' + 'z' * 30_000 + '"}'}),
    ],
)
async def test_a_request_that_an_ask_cannot_show_whole_is_refused_and_the_person_is_told(
    lab: Lab, request_: PermissionRequest
) -> None:
    bo = Member(lab, 'bo')
    refusals = Refusals(lab)

    first = await ask_the_person(bo, request_)
    again = await refusals.decide(bo, request_)

    (told,) = asks(lab)
    assert (first, again) == ('no', 'no')
    assert (told.text, told.choices, told.request) == (
        'Refused: a request that is too long to show',
        ('OK',),
        'permission',
    )
    assert 'you cannot allow what you cannot read. Nothing ran.' in told.body
    assert 'The rest is cut.' in told.body
    assert len(told.body) < MAX_BODY
    assert not refusals._open
    await answered(lab, 'yes')
    await ask_the_person(bo, request_)
    assert (len(asks(lab)), lab.board.grants) == (2, ())


async def test_the_longest_request_that_an_ask_can_hold_is_shown_whole(lab: Lab) -> None:
    request = COMMAND.model_copy(update={'command': f'./gpu {"x" * 18_000}'})
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), request))
    await until(lambda: bool(asks(lab)))
    await answered(lab, 'Allow once')

    assert await asking == 'once'
    assert request.command is not None
    assert request.command in asks(lab)[0].body


async def test_answers_that_the_board_cannot_hold_are_cut_for_the_choice_and_listed_whole(lab: Lab) -> None:
    long = PermissionChoice(id='long', name=f'Allow {"every " * 30}time', kind='allow_always')
    twin = PermissionChoice(id='twin', name=f'Allow {"every " * 30}day', kind='allow_always')
    blank = PermissionChoice(id='blank', name=' \n ', kind='reject_always')
    many = tuple(PermissionChoice(id=f'm{number}', name=f'Mode {number}', kind='mode') for number in range(9))
    request = COMMAND.model_copy(update={'choices': (ONCE, long, twin, blank, *many)})
    bo = Member(lab, 'bo')
    picked: list[str | None] = []
    for answer in ('cut', twin.name, 'Mode 8', 'Answer 4', 'Allow `./gpu` for every agent'):
        asking = asyncio.create_task(ask_the_person(bo, request))
        before = len(asks(lab))
        await until(lambda before=before: len(asks(lab)) > before)
        await answered(lab, asks(lab)[-1].choices[1] if answer == 'cut' else answer)
        picked.append(await asking)

    asked = asks(lab)[0]
    assert picked == ['long', 'twin', 'm8', 'blank', 'once']
    assert (len(asked.choices), asked.choices[-1]) == (10, 'Allow `./gpu` for every agent')
    assert (len(asked.choices[1]), asked.choices[1][-1], asked.choices[2][-5:]) == (100, '…', '… (3)')
    assert asked.choices[3] == 'Answer 4'
    assert 'To pick one that has no choice here, answer with its name:' in asked.body
    assert all(choice.name in asked.body for choice in (long, twin, *many))
    assert lab.board.grants == ('./gpu',)


async def test_the_ask_says_that_an_answer_which_the_harness_remembers_is_the_harnesss_own(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    for request in (MAKE, MAKE.model_copy(update={'choices': (ONCE, NO)})):
        asking = asyncio.create_task(ask_the_person(bo, request))
        before = len(asks(lab))
        await until(lambda before=before: len(asks(lab)) > before)
        await answered(lab, 'Reject')
        await asking

    remembered, once = asks(lab)
    fact = (
        'The harness\'s own: "Allow always". The harness remembers such an answer beyond this lab, and Verifold '
        'cannot show it or undo it later.'
    )
    assert (fact in remembered.body, "The harness's own" in once.body) == (True, False)
    assert remembered.choices == ('Allow once', 'Allow always', 'Reject')


async def test_a_request_ends_with_the_agents_turn_and_a_later_answer_decides_nothing(lab: Lab) -> None:
    over = asyncio.Event()
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), COMMAND, over))
    await until(lambda: bool(asks(lab)))
    pending = waiting(lab)
    over.set()
    outcome = await asking
    await answered(lab, 'Allow `./gpu` for every agent')
    await asyncio.sleep(0.05)

    (asked,) = asks(lab)
    ended = next(entry.post for entry in lab.board.replies(asked.id) if isinstance(entry.post, Answer))
    assert (outcome, pending, waiting(lab), lab.board.grants) == (None, [asked.id], [], ())
    assert (ended.author, ended.ends_request) == ('bo', True)
    assert ended.text == "This request ended with the agent's turn. An answer to it decides nothing."


async def test_no_agent_and_no_person_can_mark_a_post_as_verifolds(lab: Lab) -> None:
    assert not {'request', 'ends_request', 'mark'} & set(PostRequest.model_fields)
    lookalike = await lab.post(
        PostRequest(kind='ask', text='Permission needed: rm -rf /', mentions=('person',), thread='t-1'), 'bo'
    )
    await lab.post(PostRequest(kind='answer', text='Ended.', thread='t-1', reply_to=lookalike.post.id), 'bo')
    wrong = await lab.post(PostRequest(kind='ask', text='Odd', thread='t-1'), 'bo', mark='ends_request')

    assert isinstance(lookalike.post, Ask)
    assert isinstance(wrong.post, Ask)
    assert (lookalike.post.request, wrong.post.request) == (None, None)
    # An agent's own answer ends nothing: its ask still waits for the person.
    assert waiting(lab) == [lookalike.post.id]


async def test_a_name_in_a_command_or_an_input_wakes_no_agent(lab: Lab) -> None:
    request = COMMAND.model_copy(update={'title': 'python3 ada.py', 'command': 'python3 ada.py --for "Ada"'})
    asking = asyncio.create_task(ask_the_person(Member(lab, 'bo'), request))
    await until(lambda: bool(asks(lab)))
    tracked = lab.board.posts[-1]
    own = await lab.post(PostRequest(kind='ask', text='Ada, which seed?', mentions=('person',), thread='t-1'), 'bo')
    asking.cancel()

    assert 'Ada' in f'{tracked.post.text}{tracked.post.body}'
    assert (wakes(lab.board, 'ada', tracked), wakes(lab.board, 'ada', own)) == (False, True)


NO_WAIT = Settings(permissions=PermissionSettings(while_you_decide=WhileYouDecide.REFUSE))


@pytest.mark.parametrize(
    'case',
    [
        (True, None, False),
        (False, None, True),
        (True, WhileYouDecide.AUTO, False),
        (False, WhileYouDecide.AUTO, True),
        (True, WhileYouDecide.WAIT, True),
        (False, WhileYouDecide.REFUSE, False),
    ],
)
async def test_without_a_setting_an_agent_waits_only_in_a_lab_without_auto_mode_and_a_setting_wins(
    record_file: RecordFile, case: tuple[bool, WhileYouDecide | None, bool]
) -> None:
    auto_mode, chosen, waits = case
    # A record from before the setting holds none, so that lab goes on as it did: by its auto mode.
    lab = Lab.create(record_file, 'Does it hold?', auto_mode=auto_mode)
    if chosen:
        await lab.set_settings(Settings(permissions=PermissionSettings(while_you_decide=chosen)))

    assert agent_waits(lab.board) is waits


@pytest.mark.parametrize('request_', [COMMAND, *UNCOVERED])
async def test_a_refused_request_is_asked_and_the_answer_decides_its_next_try_once(
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
    assert [ask.author for ask in asks(lab)] == ['bo', 'ada', 'bo']
    assert asks(lab)[0].body.startswith('Verifold refused this at once, as your settings say, so the agent goes on.')
    assert asks(lab)[0].choices[: len(request_.choices)] == tuple(choice.name for choice in request_.choices)
    assert lab.board.grants == ()


async def test_under_refusal_a_plain_command_offers_allow_once_and_the_grant_and_a_typed_yes_allows_once(
    lab: Lab,
) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.decide(bo, COMMAND)
        await answered(lab, 'yes')
        await until(lambda: not refusals._open)
        tried = await refusals.decide(bo, COMMAND)
    finally:
        watching.cancel()

    assert asks(lab)[0].choices == ('Allow once', 'Allow always', 'Reject', 'Allow `./gpu` for every agent')
    assert (tried, lab.board.grants) == ('once', ())


async def test_under_refusal_the_grant_choice_gives_the_grant_and_ends_the_other_asks_that_it_covers(lab: Lab) -> None:
    refusals = Refusals(lab)
    probe = COMMAND.model_copy(update={'title': './gpu probe.py', 'command': './gpu probe.py'})
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.decide(Member(lab, 'ada'), probe)
        await refusals.decide(Member(lab, 'ada'), PIPED)
        await refusals.decide(Member(lab, 'bo'), COMMAND)
        await answered(lab, grant_choice('./gpu'))
        await until(lambda: len(refusals._open) == 1)
    finally:
        watching.cancel()

    probed, piped, _ = asks(lab)
    ended = [entry.post for entry in lab.board.replies(probed.id)]
    assert lab.board.grants == ('./gpu',)
    assert [(post.author, post.text) for post in ended] == [
        ('ada', 'A grant now covers this command, so this request ended.')
    ]
    assert waiting(lab) == [piped.id]


async def test_under_refusal_an_answer_that_decides_nothing_asks_again(lab: Lab) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.decide(bo, PIPED)
        await answered(lab, 'Let me go look at it first.')
        await until(lambda: len(asks(lab)) == 2)
        tried = await refusals.decide(bo, PIPED)
        await answered(lab, 'no')
        await until(lambda: not refusals._open)
        rejected = await refusals.decide(bo, PIPED)
    finally:
        watching.cancel()

    assert (tried, rejected, len(asks(lab))) == ('no', 'no', 2)
    assert asks(lab)[1].body.startswith('Your last answer picked none of the answers')
    assert 'Verifold refused this at once' in asks(lab)[1].body


async def test_requests_whose_inputs_differ_only_late_or_in_the_kind_of_tool_share_no_answer(lab: Lab) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')
    start = '{"text": "' + 'y' * 5_000
    one = EDIT.model_copy(update={'given': f'{start}a"}}'})
    late = EDIT.model_copy(update={'given': f'{start}b"}}'})
    kind = one.model_copy(update={'kind': 'delete'})
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.decide(bo, one)
        await answered(lab, 'Allow once')
        await until(lambda: not refusals._open)
        others = [await refusals.decide(bo, late), await refusals.decide(bo, kind)]
        same = await refusals.decide(bo, one)
    finally:
        watching.cancel()

    assert (others, same, len(asks(lab))) == (['no', 'no'], 'once', 3)


async def test_a_stored_answer_is_dropped_after_its_time_and_when_the_person_changes_the_setting(
    lab: Lab, monkeypatch: pytest.MonkeyPatch
) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')
    watching = asyncio.create_task(refusals.run())
    try:
        await refusals.decide(bo, PIPED)
        await answered(lab, 'Allow once')
        await until(lambda: not refusals._open)
        await lab.set_settings(NO_WAIT)
        changed = await refusals.decide(bo, PIPED)
        await answered(lab, 'Allow once')
        await until(lambda: not refusals._open)
        monkeypatch.setattr(permissions, 'ANSWER_LIFE', timedelta(0))
        late = await refusals.decide(bo, PIPED)
    finally:
        watching.cancel()

    assert (changed, late, len(asks(lab))) == ('no', 'no', 3)


async def test_after_a_restart_the_requests_from_before_end_and_an_answer_to_them_decides_nothing(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    before = Refusals(lab)
    await before.decide(bo, COMMAND)
    own = await lab.post(PostRequest(kind='ask', text='Which seed?', mentions=('person',), thread='t-1'), 'bo')
    restarted = Refusals(lab)
    watching = asyncio.create_task(restarted.run())
    try:
        await until(lambda: waiting(lab) == [own.post.id])
        await answered(lab, grant_choice('./gpu'))
        await asyncio.sleep(0.05)
        tried = await restarted.decide(bo, COMMAND)
    finally:
        watching.cancel()

    ended = lab.board.replies(asks(lab)[0].id)[0].post
    assert ended.text == 'Verifold restarted, so this request ended. An answer to it decides nothing.'
    assert (tried, lab.board.grants, len(asks(lab))) == ('no', (), 3)


async def test_an_ask_that_fails_frees_its_place(lab: Lab, monkeypatch: pytest.MonkeyPatch) -> None:
    refusals = Refusals(lab)
    bo = Member(lab, 'bo')

    async def fail(*_: object, **__: object) -> None:
        raise RuntimeError('The board is away.')

    with monkeypatch.context() as patch:
        patch.setattr(lab, 'post', fail)
        with pytest.raises(RuntimeError):
            await refusals.decide(bo, COMMAND)
    await refusals.decide(bo, COMMAND)

    assert len(asks(lab)) == 1


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
    for number, (text, body) in enumerate(replies, start=len(asks(lab)) + 1):
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
    assert [(ask.text, ask.choices, ask.request) for ask in asks(lab)] == [
        ('Set up the run: Name', (), 'question'),
        ('Set up the run: GPUs', (), 'question'),
        ('Set up the run: Rate', (), 'question'),
        ('Set up the run: Dry run', ('Yes', 'No'), 'question'),
        ('Set up the run: Branch', ('Main', 'Dev'), 'question'),
        ('Set up the run: Sets', (), 'question'),
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
    [
        ('gpus', 'a few'),
        ('gpus', '2.5'),
        ('rate', 'fast'),
        ('rate', 'nan'),
        ('rate', 'inf'),
        ('rate', '-Infinity'),
        ('dry', 'maybe'),
        ('dry', 'ok, what is this for?'),
        ('branch', 'release'),
        ('sets', 'Alpha, Gamma'),
    ],
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
    blank = Question(message=' ', fields=(FORM.fields[3].model_copy(update={'title': ' '}),))

    assert await asked_question(lab, Question(message='', fields=(FORM.fields[3],)), [('yes', '')]) == {'dry': True}
    assert await asked_question(lab, blank, [('yes', '')]) == {'dry': True}
    assert [ask.text for ask in asks(lab)] == ['Dry run', 'A question']


async def test_a_description_that_an_ask_cannot_hold_is_cut_and_the_ask_says_so(lab: Lab) -> None:
    field = FORM.fields[0].model_copy(update={'description': 'word ' * 10_000})

    assert await asked_question(lab, Question(message='Name it', fields=(field,)), [('Run 7', '')]) == {'name': 'Run 7'}
    assert len(asks(lab)[0].body) == MAX_BODY
    assert asks(lab)[0].body.startswith('Verifold cut this text, because an ask cannot hold all of it.')


async def test_the_person_can_leave_out_a_field_that_the_harness_does_not_need(lab: Lab) -> None:
    optional = tuple(field.model_copy(update={'required': False}) for field in (FORM.fields[0], FORM.fields[4]))
    form = Question(message='Set up the run', fields=(*optional, FORM.fields[3]))

    answers = await asked_question(lab, form, [('skip', ''), ('Skip', ''), ('Yes', '')])

    assert answers == {'dry': True}
    assert [ask.choices for ask in asks(lab)] == [(), ('Main', 'Dev', 'Skip'), ('Yes', 'No')]
    assert 'The harness does not need this answer. To leave it out, answer "skip".' in asks(lab)[0].body
    assert 'skip' not in asks(lab)[2].body


async def test_options_that_the_board_cannot_offer_as_choices_are_listed_and_named_in_the_answer(lab: Lab) -> None:
    many = tuple(FieldOption(value=f'v{number}', name=f'Option {number}') for number in range(12))
    pick = Question(message='Which one?', fields=(QuestionField(name='one', title='One', kind='choice', options=many),))

    assert await asked_question(lab, pick, [('option 11', '')]) == {'one': 'v11'}
    assert (asks(lab)[0].choices, asks(lab)[0].body.startswith('The options: Option 0, Option 1,')) == ((), True)


async def test_a_question_ends_with_the_agents_turn(lab: Lab) -> None:
    over = asyncio.Event()
    asking = asyncio.create_task(ask_the_question(Member(lab, 'bo'), FORM, over))
    await until(lambda: bool(asks(lab)))
    pending = waiting(lab)
    over.set()

    assert (await asking, pending, waiting(lab), len(asks(lab))) == (None, [asks(lab)[0].id], [], 1)
