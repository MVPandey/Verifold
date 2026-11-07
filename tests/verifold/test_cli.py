import asyncio
import os
import signal
from collections.abc import Callable, Iterator
from importlib.metadata import version
from pathlib import Path

import pytest

from verifold.cli import DEFAULT_AGENTS, main
from verifold.protocol.app import AgentChoice, StartRequest
from verifold.server.errors import LabExists, SetupRejected


def test_version_prints_the_installed_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(['--version'])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out == f'verifold {version("verifold")}\n'


@pytest.fixture(autouse=True)
def opened(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record the links that the command opens in a browser, instead of opening them."""
    links: list[str] = []
    monkeypatch.setattr('verifold.cli.webbrowser.open', links.append)
    return links


@pytest.fixture
def serves(monkeypatch: pytest.MonkeyPatch) -> list[StartRequest | None]:
    """Replace the server with a stand-in that records the start request it gets."""
    starts: list[StartRequest | None] = []

    async def serve(
        project: Path, start: StartRequest | None = None, on_ready: Callable[[str], None] | None = None
    ) -> None:
        assert project == Path.cwd()
        if on_ready:
            on_ready('http://127.0.0.1:1234/#token=abc')
        starts.append(start)

    monkeypatch.setattr('verifold.cli.serve', serve)
    return starts


def test_no_command_serves_the_folder_prints_the_link_and_opens_it(
    serves: list[StartRequest | None], opened: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    main([])

    assert serves == [None]
    assert 'Open the lab: http://127.0.0.1:1234/#token=abc' in capsys.readouterr().out
    assert opened == ['http://127.0.0.1:1234/#token=abc']


@pytest.mark.usefixtures('serves')
@pytest.mark.parametrize('argv', [['--no-browser'], ['--no-browser', 'run', 'Q?'], ['run', 'Q?', '--no-browser']])
def test_no_browser_only_prints_the_link(argv: list[str], opened: list[str]) -> None:
    main(argv)

    assert opened == []


def test_run_starts_a_lab_with_the_given_agents(serves: list[StartRequest | None]) -> None:
    main(['run', 'Does it hold?', '--agent', 'claude-code:opus', '--agent', 'codex::low'])

    assert serves == [
        StartRequest(
            question='Does it hold?',
            agents=(AgentChoice(harness='claude-code', model='opus'), AgentChoice(harness='codex', effort='low')),
        )
    ]


def test_run_defaults_to_one_agent_of_each_harness_and_ask_me_turns_auto_mode_off(
    serves: list[StartRequest | None],
) -> None:
    main(['run', 'Does it hold?', '--ask-me', '--minutes', '90'])

    assert serves == [StartRequest(question='Does it hold?', agents=DEFAULT_AGENTS, auto_mode=False, minutes=90)]


def stand_in(monkeypatch: pytest.MonkeyPatch, error: BaseException) -> None:
    async def serve(*_: object, **__: object) -> None:
        raise error

    monkeypatch.setattr('verifold.cli.serve', serve)


@pytest.mark.parametrize(
    'error',
    [
        LabExists('This folder has a lab already.'),
        ExceptionGroup('unhandled errors in a TaskGroup', [SetupRejected('Unknown harness nope.')]),
    ],
)
def test_a_known_error_exits_with_its_message(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    stand_in(monkeypatch, error)

    with pytest.raises(SystemExit, match=r'verifold: (This folder has a lab already|Unknown harness nope)\.'):
        main([])


def test_an_invalid_option_exits_with_its_message() -> None:
    with pytest.raises(SystemExit, match='verifold: 1 validation error for StartRequest'):
        main(['run', 'Does it hold?', '--minutes', '0'])


def test_an_unknown_error_in_a_group_is_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    stand_in(monkeypatch, ExceptionGroup('unhandled errors in a TaskGroup', [ValueError('bug')]))

    with pytest.raises(ExceptionGroup):
        main([])


@pytest.fixture
def default_sigint() -> Iterator[None]:
    """Give the test Python's own Ctrl+C handler, as a new `verifold` process has."""
    # pytest-asyncio can leave the SIGINT handler of an earlier test's event loop in place.
    previous = signal.signal(signal.SIGINT, signal.default_int_handler)
    yield
    signal.signal(signal.SIGINT, previous)


@pytest.mark.usefixtures('default_sigint')
@pytest.mark.parametrize('stop', [signal.SIGINT, signal.SIGTERM])
def test_ctrl_c_and_sigterm_stop_the_server_after_its_cleanup(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], stop: signal.Signals
) -> None:
    cancelled: list[bool] = []

    async def serve(*_: object, **__: object) -> None:
        os.kill(os.getpid(), stop)
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr('verifold.cli.serve', serve)

    main([])

    assert cancelled == [True]
    assert 'Stopped.' in capsys.readouterr().out
