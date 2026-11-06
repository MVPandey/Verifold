import pytest

from verifold.runner.environment import clean_environment, harness_environment


def test_git_variables_are_dropped_and_the_rest_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GIT_INDEX_FILE', '/repo/.git/index')
    monkeypatch.setenv('VERIFOLD_TEST', 'kept')

    environment = clean_environment()

    assert 'GIT_INDEX_FILE' not in environment
    assert environment['VERIFOLD_TEST'] == 'kept'


def test_a_harness_gets_the_basics_and_its_own_variables_only(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        'ANTHROPIC_API_KEY': 'a',
        'OPENAI_API_KEY': 'o',
        'RUNPOD_API_KEY': 'r',
        'AWS_SECRET_ACCESS_KEY': 's',
        'LC_ALL': 'en_US.UTF-8',
        'GIT_DIR': '/repo/.git',
    }.items():
        monkeypatch.setenv(name, value)

    environment = harness_environment(('ANTHROPIC_', 'CLAUDE_'))

    assert {'PATH', 'HOME', 'LC_ALL', 'ANTHROPIC_API_KEY'} <= set(environment)
    assert not {'OPENAI_API_KEY', 'RUNPOD_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GIT_DIR'} & set(environment)
