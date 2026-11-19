import asyncio
import json
import os
from contextlib import suppress
from pathlib import Path

import acp
import psutil
import pytest
from acp import schema
from conftest import ServedBoard
from fakes import FAKE_HARNESS

from verifold.protocol.app import Offer
from verifold.protocol.usage import Usage
from verifold.runner.errors import RunnerError
from verifold.runner.session import (
    AgentSession,
    Answers,
    BoardAccess,
    PermissionRequest,
    Place,
    Question,
    SessionHooks,
    SessionOptions,
    _Client,
    _model_now,
    _values,
    offer_of,
)
from verifold.server.status import STEPS


def calls(log: Path) -> list[dict[str, object]]:
    # The fake harness appends to the log, so a read can end inside a line. Only the lines that end are whole.
    return [json.loads(line) for line in log.read_text().split('\n')[:-1]] if log.exists() else []


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / 'calls.jsonl'
    monkeypatch.setenv('FAKE_ACP_LOG', str(path))
    return path


@pytest.fixture
def folder(tmp_path: Path) -> Place:
    path = tmp_path / 'bo'
    path.mkdir()
    return Place(folder=path, log=tmp_path / 'logs' / 'bo.log', lab=tmp_path, agent='bo')


async def no_permission(request: PermissionRequest) -> str | None:
    raise AssertionError(f'Unexpected permission request: {request}')


NO_PERMISSION = SessionHooks(permissions=no_permission)


async def test_a_session_posts_on_the_board_and_reports_usage_and_cost(
    served: ServedBoard, folder: Place, log: Path
) -> None:
    _, token = served.seat('bo')
    options = SessionOptions(model='small', effort='low', auto_mode=True)

    async with AgentSession.open(
        FAKE_HARNESS, folder, BoardAccess(url=served.url, token=token), options, NO_PERMISSION
    ) as session:
        first = await session.send('Start.')
        second = await session.send('Again.')

    assert session.id == 'session-bo'
    assert [entry.post.text for entry in served.lab.board.posts if entry.post.author == 'bo'] == [
        'Hello from bo.',
        'Hello from bo.',
    ]
    assert first.usage == Usage(input_tokens=13, cached_input_tokens=3, output_tokens=5)
    assert first.stop_reason == 'end_turn'
    assert first.cost_usd == pytest.approx(0.01)
    assert second.cost_usd == pytest.approx(0.01)
    settings = [call for call in calls(log) if call['event'] in ('mode', 'option')]
    assert settings == [
        {'agent': 'bo', 'event': 'option', 'option': 'llm', 'value': 'small'},
        {'agent': 'bo', 'event': 'option', 'option': 'thinking', 'value': 'low'},
        {'agent': 'bo', 'event': 'mode', 'mode': 'auto'},
    ]


async def test_a_session_keeps_the_persons_settings_unless_asked(served: ServedBoard, folder: Place, log: Path) -> None:
    _, token = served.seat('bo')

    async with AgentSession.open(
        FAKE_HARNESS, folder, BoardAccess(url=served.url, token=token), SessionOptions(), NO_PERMISSION
    ):
        pass

    assert [call['event'] for call in calls(log)] == ['new_session']


async def test_a_session_can_be_loaded_again(served: ServedBoard, folder: Place, log: Path) -> None:
    _, token = served.seat('bo')
    options = SessionOptions(resume='session-bo')

    async with AgentSession.open(
        FAKE_HARNESS, folder, BoardAccess(url=served.url, token=token), options, NO_PERMISSION
    ) as session:
        assert (session.id, session.loaded) == ('session-bo', True)

    assert calls(log) == [{'agent': 'bo', 'event': 'load_session', 'session': 'session-bo'}]


@pytest.mark.parametrize('switch', ['FAKE_ACP_NO_LOAD', 'FAKE_ACP_REFUSE_LOAD'])
async def test_a_harness_that_cannot_load_the_session_opens_a_new_one(
    served: ServedBoard, folder: Place, log: Path, monkeypatch: pytest.MonkeyPatch, switch: str
) -> None:
    monkeypatch.setenv(switch, '1')
    _, token = served.seat('bo')
    options = SessionOptions(resume='session-gone', model='small')

    async with AgentSession.open(
        FAKE_HARNESS, folder, BoardAccess(url=served.url, token=token), options, NO_PERMISSION
    ) as session:
        assert (session.id, session.loaded) == ('session-bo', False)

    # A harness that says that it loads no sessions is not asked. The lab's options go to the new session.
    asked = [] if switch == 'FAKE_ACP_NO_LOAD' else ['load_session']
    assert [call['event'] for call in calls(log)] == [*asked, 'new_session', 'option']


@pytest.mark.parametrize(('decision', 'posted'), [('yes', 'Permission: yes.'), (None, 'Permission: cancelled.')])
async def test_permission_requests_go_to_the_handler(
    served: ServedBoard, folder: Place, monkeypatch: pytest.MonkeyPatch, decision: str | None, posted: str
) -> None:
    monkeypatch.setenv('FAKE_ACP_PERMISSION', '1')
    _, token = served.seat('bo')
    requests: list[PermissionRequest] = []

    async def decide(request: PermissionRequest) -> str | None:
        requests.append(request)
        return decision

    async with AgentSession.open(
        FAKE_HARNESS,
        folder,
        BoardAccess(url=served.url, token=token),
        SessionOptions(),
        SessionHooks(permissions=decide),
    ) as session:
        await session.send('Start.')

    assert [(request.title, [choice.id for choice in request.choices]) for request in requests] == [
        ('run make', ['yes', 'no'])
    ]
    assert served.lab.board.posts[-1].post.text == posted


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def test_closing_a_session_stops_the_harness_with_its_children_and_keeps_its_errors(
    served: ServedBoard, folder: Place, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pid_file = tmp_path / 'child.pid'
    monkeypatch.setenv('FAKE_ACP_CHILD', str(pid_file))
    _, token = served.seat('bo')

    async with asyncio.timeout(15):
        async with AgentSession.open(
            FAKE_HARNESS, folder, BoardAccess(url=served.url, token=token), SessionOptions(), NO_PERMISSION
        ):
            child = int(pid_file.read_text())
            assert alive(child)
        await asyncio.sleep(0.1)

    assert not alive(child)
    assert 'fake agent ready' in folder.log.read_text()


async def test_a_harness_without_a_model_option_refuses_a_model_instead_of_ignoring_it(
    served: ServedBoard, folder: Place, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_NO_OPTIONS', '1')
    _, token = served.seat('bo')

    with pytest.raises(RunnerError, match='Fake offers no model option over ACP'):
        async with AgentSession.open(
            FAKE_HARNESS, folder, BoardAccess(url=served.url, token=token), SessionOptions(model='big'), NO_PERMISSION
        ):
            pass


def fake_harnesses() -> list[psutil.Process]:
    found: list[psutil.Process] = []
    for child in psutil.Process().children():
        # A child that exited and waits to be collected can't show its command line.
        with suppress(psutil.Error):
            if 'fake_acp_agent.py' in ' '.join(child.cmdline()):
                found.append(child)
    return found


def efforts_of(offer: Offer) -> dict[str, list[str] | None]:
    return {
        model.value: None if model.efforts is None else [effort.value for effort in model.efforts]
        for model in offer.models
    }


async def test_a_probe_reads_each_models_effort_levels_and_stops_the_harness(folder: Place, log: Path) -> None:
    offer = await offer_of(FAKE_HARNESS, folder, timeout=30)

    assert efforts_of(offer) == {'default': ['default', 'low', 'high'], 'small': ['default', 'low'], 'small-model': []}
    assert [value.value for value in offer.efforts] == ['default', 'low', 'high']
    assert [(value.value, value.name) for value in offer.modes] == [('ask', 'Ask'), ('auto', 'Auto')]
    assert (offer.model, offer.effort, offer.mode) == ('default', 'default', 'ask')
    # The probe ends on the person's own model, for a harness that remembers its last one.
    assert [call['value'] for call in calls(log) if call['event'] == 'option'] == ['small', 'small-model', 'default']
    assert not fake_harnesses()


async def test_a_probe_leaves_out_a_model_that_the_harness_refuses(
    folder: Place, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_REFUSE_MODEL', 'small')

    offer = await offer_of(FAKE_HARNESS, folder, timeout=30)

    assert efforts_of(offer) == {'default': ['default', 'low', 'high'], 'small-model': []}


async def test_a_probe_that_runs_out_of_time_during_the_switches_keeps_what_it_read(
    folder: Place, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW_SWITCH', '1')

    offer = await offer_of(FAKE_HARNESS, folder, timeout=2)

    assert efforts_of(offer) == {'default': ['default', 'low', 'high'], 'small': None, 'small-model': None}
    assert offer.mode == 'ask'
    assert not fake_harnesses()


async def test_a_probe_of_a_harness_without_options_still_reads_its_modes(
    folder: Place, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_NO_OPTIONS', '1')

    offer = await offer_of(FAKE_HARNESS, folder, timeout=30)

    assert (offer.models, offer.efforts, offer.model, offer.effort) == ((), (), None, None)
    assert offer.mode == 'ask'


async def test_a_probe_that_runs_out_of_time_still_stops_the_harness(
    folder: Place, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_SLOW_SESSION', '1')

    with pytest.raises(TimeoutError):
        await offer_of(FAKE_HARNESS, folder, timeout=0.5)

    assert not fake_harnesses()


async def test_a_session_reports_its_model_the_persons_own_or_the_one_that_the_lab_set(
    served: ServedBoard, folder: Place, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, token = served.seat('bo')
    board = BoardAccess(url=served.url, token=token)

    async with AgentSession.open(FAKE_HARNESS, folder, board, SessionOptions(), NO_PERMISSION) as own:
        default = own.model
    async with AgentSession.open(FAKE_HARNESS, folder, board, SessionOptions(model='small'), NO_PERMISSION) as set_:
        chosen = set_.model
    monkeypatch.setenv('FAKE_ACP_NO_OPTIONS', '1')
    async with AgentSession.open(FAKE_HARNESS, folder, board, SessionOptions(), NO_PERMISSION) as silent:
        unknown = silent.model

    assert default is not None
    assert chosen is not None
    assert (default.value, chosen.value, chosen.name, unknown) == ('default', 'small', 'small', None)


def test_a_model_that_the_harness_accepts_and_does_not_list_has_its_id_for_a_name() -> None:
    listed = schema.SessionConfigOptionSelect(
        id='model',
        name='Model',
        category='model',
        current_value='small',
        type='select',
        options=[schema.SessionConfigSelectOption(value='small', name='Small')],
    )

    own, typed, none = _model_now([listed], None), _model_now([listed], 'fable-5'), _model_now([], 'fable-5')

    assert own is not None
    assert typed is not None
    assert (own.name, typed.value, typed.name, none) == ('Small', 'fable-5', 'fable-5', None)


def test_grouped_values_come_one_after_another() -> None:
    small = schema.SessionConfigSelectOption(value='small', name='Small')
    big = schema.SessionConfigSelectOption(value='big', name='Big')
    grouped = schema.SessionConfigOptionSelect(
        id='model',
        name='Model',
        category='model',
        current_value='small',
        type='select',
        options=[
            schema.SessionConfigSelectGroup(group='a', name='A', options=[small]),
            schema.SessionConfigSelectGroup(
                group='b', name='B', options=[big, schema.SessionConfigSelectOption(value='', name='Empty')]
            ),
        ],
    )

    # A value that a lab can't record is left out.
    assert [value.value for value in _values(grouped)] == ['small', 'big']


async def test_an_effort_comes_from_the_options_of_the_chosen_model(served: ServedBoard, folder: Place) -> None:
    _, token = served.seat('bo')

    with pytest.raises(RunnerError, match='Fake offers no effort option over ACP'):
        async with AgentSession.open(
            FAKE_HARNESS,
            folder,
            BoardAccess(url=served.url, token=token),
            SessionOptions(model='small-model', effort='low'),
            NO_PERMISSION,
        ):
            pass


async def test_a_chosen_mode_wins_over_auto_mode(served: ServedBoard, folder: Place, log: Path) -> None:
    _, token = served.seat('bo')

    async with AgentSession.open(
        FAKE_HARNESS,
        folder,
        BoardAccess(url=served.url, token=token),
        SessionOptions(mode='ask', auto_mode=True),
        NO_PERMISSION,
    ):
        pass

    assert [call['mode'] for call in calls(log) if call['event'] == 'mode'] == ['ask']


OPTIONS = [schema.PermissionOption(option_id='yes', name='Allow', kind='allow_once')]


class Asked:
    """A client, with the requests that its handler got."""

    def __init__(self, *, names_mcp_server: bool = True) -> None:
        self.requests: list[PermissionRequest] = []
        self.client = _Client(SessionHooks(permissions=self._decide), names_mcp_server=names_mcp_server)

    async def _decide(self, request: PermissionRequest) -> str | None:
        self.requests.append(request)
        return 'yes'

    async def after(self, *updates: schema.ToolCallStart | schema.ToolCallProgress) -> PermissionRequest:
        """Return the request that the handler gets when the harness asks about `call-1` after `updates`."""
        for update in updates:
            await self.client.session_update('s', update)
        await self.client.request_permission('s', schema.ToolCallUpdate(tool_call_id='call-1'), OPTIONS)
        return self.requests[-1]


def started(title: str, given: object, kind: schema.ToolKind = 'execute') -> schema.ToolCallStart:
    return schema.ToolCallStart(
        session_update='tool_call', tool_call_id='call-1', title=title, kind=kind, raw_input=given
    )


def progress(**said: object) -> schema.ToolCallProgress:
    return schema.ToolCallProgress.model_validate(
        {'session_update': 'tool_call_update', 'tool_call_id': 'call-1'} | said
    )


async def test_each_step_of_a_harness_reaches_the_runner_by_its_kind_and_never_by_its_title() -> None:
    kinds: list[str] = []

    async def step(kind: str) -> None:
        kinds.append(kind)

    client = _Client(SessionHooks(permissions=NO_PERMISSION.permissions, step=step))
    untitled = schema.ToolCallStart(session_update='tool_call', tool_call_id='call-3', title='')
    for update in (started('pytest -q', {}), started('Guardian Review', {}, 'other'), untitled):
        await client.session_update('s', update)

    assert kinds == ['execute', 'other', 'other']
    # The app shows Verifold's words for a kind, and none for a call of another kind, such as a review of the harness.
    assert [STEPS.get(kind, '') for kind in kinds] == ['Runs a command', '', '']


async def test_a_request_that_names_only_its_call_gets_the_calls_command() -> None:
    asked = Asked()

    running = await asked.after(started('./gpu x', {'command': ' ./gpu x '}))
    ended = await asked.after(progress(status='completed'))
    unknown = await Asked().after()

    assert (running.title, running.command, running.board) == ('./gpu x', './gpu x', False)
    assert (ended.title, ended.command) == ('an action', None)
    assert (unknown.title, unknown.command, unknown.board) == ('an action', None, False)


async def test_a_call_gets_what_the_harness_adds_after_its_start() -> None:
    request = await Asked().after(started('Terminal', None), progress(raw_input={'command': 'make test'}))

    assert (request.title, request.command) == ('make test', 'make test')


async def test_only_a_call_that_runs_a_command_has_one() -> None:
    remote = await Asked().after(started('remote.exec', {'host': 'a', 'command': './gpu x'}, kind='other'))

    assert (remote.title, remote.command, remote.kind, remote.rest) == ('remote.exec', None, 'other', '')
    assert json.loads(remote.given) == {'host': 'a', 'command': './gpu x'}


@pytest.mark.parametrize(
    ('given', 'command'),
    [
        ({'command': ['./gpu', 'x']}, './gpu x'),
        ({'cmd': './gpu x'}, './gpu x'),
        ({'command': ['git', 'commit', '-m', 'two words']}, "git commit -m 'two words'"),
        ({'command': ['/bin/bash', '-lc', './gpu x']}, './gpu x'),
        ({'cmd': ['sh', '-c', 'make test | tail -1']}, 'make test | tail -1'),
        ({'command': ['python3', '-c', 'print(1)']}, "python3 -c 'print(1)'"),
    ],
)
async def test_a_command_is_text_or_a_list_of_arguments_and_a_shell_with_one_script_is_that_script(
    given: object, command: str
) -> None:
    request = await Asked().after(started('Terminal', given))

    assert (request.title, request.command, request.kind, request.rest) == (command, command, 'execute', '')
    assert json.loads(request.given) == given


@pytest.mark.parametrize('given', [{'command': ['./gpu', 7]}, {'command': []}, {'argv': './gpu x'}, {'script': 'x'}])
async def test_a_command_in_a_shape_that_verifold_does_not_know_keeps_the_harnesss_title_and_input(
    given: object,
) -> None:
    request = await Asked().after(started('Run the trainer', given))

    assert (request.title, request.command, request.rest) == ('Run the trainer', None, '')
    assert json.loads(request.given) == given


async def test_a_request_carries_its_whole_input_and_what_it_holds_beside_the_command() -> None:
    long = await Asked().after(started('Write', {'text': 'x' * 50_000}, kind='edit'))
    odd = await Asked().after(started('Write', {'path': Path('notes.md')}, kind='edit'))
    beside = await Asked().after(started('sh', {'cmd': './gpu x', 'cwd': '/tmp', 'timeout': 5}))
    nothing = await Asked().after()

    assert (json.loads(long.given), 'notes.md' in odd.given) == ({'text': 'x' * 50_000}, True)
    assert (beside.command, json.loads(beside.rest)) == ('./gpu x', {'cwd': '/tmp', 'timeout': 5})
    assert json.loads(beside.given) == {'cmd': './gpu x', 'cwd': '/tmp', 'timeout': 5}
    assert (nothing.given, nothing.rest, nothing.kind) == ('', '', '')


BRANCH = schema.ElicitationStringPropertySchema(
    type='string',
    title='Branch',
    description='Where the work goes.',
    one_of=[schema.EnumOption(const='main', title='Main'), schema.EnumOption(const='dev', title='Dev')],
)
SETS = schema.ElicitationMultiSelectPropertySchema(
    type='array', items=schema.StringMultiSelectItems(type='string', enum=['a', 'b'])
)
TITLED = schema.ElicitationMultiSelectPropertySchema(
    type='array', items=schema.TitledMultiSelectItems(any_of=[schema.EnumOption(const='a', title='Alpha')])
)
FIELDS: dict[str, object] = {
    'name': schema.ElicitationStringPropertySchema(type='string'),
    'level': schema.ElicitationStringPropertySchema(type='string', enum=['low', 'high']),
    'branch': BRANCH,
    'gpus': schema.ElicitationIntegerPropertySchema(type='integer'),
    'rate': schema.ElicitationNumberPropertySchema(type='number'),
    'dry': schema.ElicitationBooleanPropertySchema(type='boolean'),
    'sets': SETS,
    'titled': TITLED,
}


def form(properties: dict[str, object]) -> schema.ElicitationFormSessionMode:
    asked = schema.ElicitationSchema.model_validate({'properties': properties, 'required': ['name', 'branch']})
    return schema.ElicitationFormSessionMode(session_id='s', requested_schema=asked)


class Questioned:
    """A client, with the questions that its handler got and the answer that it gives."""

    def __init__(self, answers: Answers | None) -> None:
        self.questions: list[Question] = []
        self._answers = answers
        self.client = _Client(SessionHooks(permissions=NO_PERMISSION.permissions, questions=self._answer))

    async def _answer(self, question: Question) -> Answers | None:
        self.questions.append(question)
        return self._answers


async def test_a_form_of_the_harness_reaches_its_user_field_by_field_and_the_answers_go_back() -> None:
    questioned = Questioned({'name': 'Run 7', 'dry': True})

    response = await questioned.client.create_elicitation('Set up the run', form(FIELDS))

    (question,) = questioned.questions
    assert question.message == 'Set up the run'
    assert [(field.name, field.title, field.kind) for field in question.fields] == [
        ('name', 'name', 'text'),
        ('level', 'level', 'choice'),
        ('branch', 'Branch', 'choice'),
        ('gpus', 'gpus', 'integer'),
        ('rate', 'rate', 'number'),
        ('dry', 'dry', 'boolean'),
        ('sets', 'sets', 'choices'),
        ('titled', 'titled', 'choices'),
    ]
    assert [[(option.value, option.name) for option in field.options] for field in question.fields] == [
        [],
        [('low', 'low'), ('high', 'high')],
        [('main', 'Main'), ('dev', 'Dev')],
        [],
        [],
        [],
        [('a', 'a'), ('b', 'b')],
        [('a', 'Alpha')],
    ]
    assert question.fields[2].description == 'Where the work goes.'
    assert [field.name for field in question.fields if field.required] == ['name', 'branch']
    assert isinstance(response, schema.AcceptElicitationResponse)
    assert response.content == {'name': 'Run 7', 'dry': True}


async def test_a_question_without_an_answer_is_cancelled_and_a_session_without_a_user_answers_none() -> None:
    cancelled = await Questioned(None).client.create_elicitation('Which?', form({'branch': BRANCH}))
    alone = await _Client(NO_PERMISSION).create_elicitation('Which?', form({'branch': BRANCH}))

    assert [type(response) for response in (cancelled, alone)] == [schema.CancelElicitationResponse] * 2


@pytest.mark.parametrize(
    'mode',
    [
        schema.ElicitationUrlSessionMode(session_id='s', elicitation_id='e-1', url='https://example.com/sign-in'),
        form({'when': {'type': 'date'}}),
        form({'sets': {'type': 'array', 'items': {'type': 'number'}}}),
        form({}),
    ],
)
async def test_a_question_that_the_board_cannot_show_gets_an_error_that_says_so(mode: schema.ElicitationMode) -> None:
    questioned = Questioned({})

    with pytest.raises(acp.RequestError) as refused:
        await questioned.client.create_elicitation('Sign in', mode)

    assert (refused.value.code, questioned.questions) == (-32602, [])
    assert 'It cannot show this.' in str(refused.value.data)


async def test_a_call_to_the_labs_board_is_marked_where_the_harness_names_the_server() -> None:
    board_call = started('mcp.verifold.post', {'server': 'verifold', 'tool': 'post', 'arguments': {}})

    marked = await Asked().after(board_call)
    unnamed = await Asked(names_mcp_server=False).after(board_call)
    other = await Asked().after(started('mcp.files.read', {'server': 'files', 'tool': 'read'}))
    no_tool = await Asked().after(started('odd', {'server': 'verifold'}))
    shell = await Asked().after(started('sh', {'command': 'echo', 'server': 'verifold', 'tool': 'post'}))
    odd = await Asked().after(started('odd', ['verifold']))

    assert (marked.title, marked.board) == ('mcp.verifold.post', True)
    assert [request.board for request in (unnamed, other, no_tool, shell, odd)] == [False] * 5


async def test_the_requests_own_input_wins_over_the_calls() -> None:
    asked = Asked()
    await asked.client.session_update('s', started('make', {'command': 'make'}))
    request = schema.ToolCallUpdate(tool_call_id='call-1', title='Run command', raw_input={'command': 'make test'})
    response = await asked.client.request_permission('s', request, OPTIONS)

    assert (asked.requests[0].title, asked.requests[0].command) == ('make test', 'make test')
    assert isinstance(response.outcome, schema.AllowedOutcome)
