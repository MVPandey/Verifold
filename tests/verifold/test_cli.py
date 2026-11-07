import asyncio
import os
import signal
from collections.abc import Callable
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


def test_no_command_serves_the_folder_and_prints_the_link(
    serves: list[StartRequest | None], capsys: pytest.CaptureFixture[str]
) -> None:
    main([])

    assert serves == [None]
    assert 'Open the lab: http://127.0.0.1:1234/#token=abc' in capsys.readouterr().out


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
    main(['run', 'Does it hold?', '--ask-me'])

    assert serves == [StartRequest(question='Does it hold?', agents=DEFAULT_AGENTS, auto_mode=False)]


def stand_in(monkeypatch: pytest.MonkeyPatch, error: BaseException) -> None:
    async def serve(project: Path, start: StartRequest | None = None, **_: object) -> None:
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


def test_an_unknown_error_in_a_group_is_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    stand_in(monkeypatch, ExceptionGroup('unhandled errors in a TaskGroup', [ValueError('bug')]))

    with pytest.raises(ExceptionGroup):
        main([])


def test_ctrl_c_stops_with_a_note(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    stand_in(monkeypatch, KeyboardInterrupt())

    main([])

    assert 'Stopped.' in capsys.readouterr().out


def test_sigterm_stops_like_ctrl_c(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    cancelled: list[bool] = []

    async def serve(project: Path, start: StartRequest | None = None, **_: object) -> None:
        os.kill(os.getpid(), signal.SIGTERM)
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr('verifold.cli.serve', serve)

    main([])

    assert cancelled == [True]
    assert 'Stopped.' in capsys.readouterr().out
