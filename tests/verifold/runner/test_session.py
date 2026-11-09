import asyncio
import json
import os
from pathlib import Path

import psutil
import pytest
from acp import schema
from conftest import ServedBoard
from fakes import FAKE_HARNESS

from verifold.protocol.usage import Usage
from verifold.runner.errors import RunnerError
from verifold.runner.session import (
    AgentSession,
    BoardAccess,
    PermissionRequest,
    Place,
    SessionHooks,
    SessionOptions,
    _offer,
    offer_of,
)


def calls(log: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


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
    options = SessionOptions(model='small-model', effort='low', auto_mode=True)

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
        {'agent': 'bo', 'event': 'mode', 'mode': 'auto'},
        {'agent': 'bo', 'event': 'option', 'option': 'llm', 'value': 'small-model'},
        {'agent': 'bo', 'event': 'option', 'option': 'thinking', 'value': 'low'},
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
        assert session.id == 'session-bo'

    assert calls(log) == [{'agent': 'bo', 'event': 'load_session', 'session': 'session-bo'}]


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


async def test_a_probe_reads_what_a_harness_offers_and_stops_it(folder: Place) -> None:
    offer = await offer_of(FAKE_HARNESS, folder)

    assert [value.value for value in offer.models] == ['default', 'small', 'small-model']
    assert [value.value for value in offer.efforts] == ['default', 'low', 'high']
    assert [(value.value, value.name) for value in offer.modes] == [('ask', 'Ask'), ('auto', 'Auto')]
    assert (offer.model, offer.effort, offer.mode) == ('default', 'default', 'ask')
    assert not [child for child in psutil.Process().children() if 'fake_acp_agent.py' in ' '.join(child.cmdline())]


async def test_a_probe_of_a_harness_without_options_still_reads_its_modes(
    folder: Place, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv('FAKE_ACP_NO_OPTIONS', '1')

    offer = await offer_of(FAKE_HARNESS, folder)

    assert (offer.models, offer.efforts, offer.model, offer.effort) == ((), (), None, None)
    assert offer.mode == 'ask'


def test_an_offer_lists_grouped_values_one_after_another() -> None:
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
            schema.SessionConfigSelectGroup(group='b', name='B', options=[big]),
        ],
    )

    offer = _offer(schema.NewSessionResponse(session_id='s', config_options=[grouped]))

    assert [value.value for value in offer.models] == ['small', 'big']
    assert offer.modes == ()


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
