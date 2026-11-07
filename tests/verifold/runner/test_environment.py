import pytest

from verifold.runner.environment import clean_environment


def test_git_variables_are_dropped_and_the_rest_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GIT_INDEX_FILE', '/repo/.git/index')
    monkeypatch.setenv('VERIFOLD_TEST', 'kept')

    environment = clean_environment()

    assert 'GIT_INDEX_FILE' not in environment
    assert environment['VERIFOLD_TEST'] == 'kept'
