import asyncio
import os
import signal
from collections.abc import Callable
from importlib.metadata import version
from pathlib import Path

import pytest

from verifold.app import AgentSpec, LabConfig
from verifold.cli import main
from verifold.runner.errors import RunnerError


def test_version_prints_the_installed_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(['--version'])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out == f'verifold {version("verifold")}\n'


def test_no_command_prints_the_help(capsys: pytest.CaptureFixture[str]) -> None:
    main([])

    assert capsys.readouterr().out.startswith('usage: verifold')


@pytest.fixture
def runs(monkeypatch: pytest.MonkeyPatch) -> list[LabConfig]:
    """Replace the lab with a stand-in that records each config it gets."""
    configs: list[LabConfig] = []

    async def run_lab(project: Path, config: LabConfig, on_ready: Callable[[str], None] | None = None) -> None:
        assert project == Path.cwd()
        if on_ready:
            on_ready('http://127.0.0.1:1234/#token=abc')
        configs.append(config)

    monkeypatch.setattr('verifold.cli.run_lab', run_lab)
    return configs


def test_run_starts_a_lab_with_the_given_agents(runs: list[LabConfig]) -> None:
    main(['run', 'Does it hold?', '--agent', 'claude-code:opus', '--agent', 'codex::low'])

    assert runs == [
        LabConfig(
            question='Does it hold?',
            agents=(AgentSpec(harness='claude-code', model='opus'), AgentSpec(harness='codex', effort='low')),
        )
    ]


def test_ask_me_keeps_the_harnesses_own_modes(runs: list[LabConfig]) -> None:
    main(['run', 'Does it hold?', '--ask-me'])

    assert runs == [LabConfig(question='Does it hold?', auto_mode=False)]


def test_run_without_options_uses_the_defaults_and_resumes_without_a_question(
    runs: list[LabConfig], capsys: pytest.CaptureFixture[str]
) -> None:
    main(['run'])

    assert runs == [LabConfig()]
    assert 'Open the lab: http://127.0.0.1:1234/#token=abc' in capsys.readouterr().out


def test_a_lab_error_exits_with_its_message(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run_lab(project: Path, config: LabConfig, on_ready: Callable[[str], None] | None = None) -> None:
        raise RunnerError('This folder has no lab yet.')

    monkeypatch.setattr('verifold.cli.run_lab', run_lab)

    with pytest.raises(SystemExit, match='verifold: This folder has no lab yet'):
        main(['run'])


def test_ctrl_c_stops_the_lab_with_a_note(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    async def run_lab(project: Path, config: LabConfig, on_ready: Callable[[str], None] | None = None) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr('verifold.cli.run_lab', run_lab)

    main(['run'])

    assert 'Stopped the lab.' in capsys.readouterr().out


def test_sigterm_stops_the_lab_like_ctrl_c(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    cancelled: list[bool] = []

    async def run_lab(project: Path, config: LabConfig, on_ready: Callable[[str], None] | None = None) -> None:
        os.kill(os.getpid(), signal.SIGTERM)
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr('verifold.cli.run_lab', run_lab)

    main(['run'])

    assert cancelled == [True]
    assert 'Stopped the lab.' in capsys.readouterr().out
