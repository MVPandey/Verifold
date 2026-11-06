from importlib.metadata import version

import pytest

from verifold.cli import main


def test_version_prints_the_installed_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(['--version'])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out == f'verifold {version("verifold")}\n'


def test_no_command_prints_the_help(capsys: pytest.CaptureFixture[str]) -> None:
    main([])

    assert capsys.readouterr().out.startswith('usage: verifold')
