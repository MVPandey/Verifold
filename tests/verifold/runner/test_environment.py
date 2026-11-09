from pathlib import Path

import pytest

from verifold.runner.environment import AGENT_VARIABLE, LAB_VARIABLE, clean_environment, harness_environment


def test_git_variables_are_dropped_and_the_rest_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GIT_INDEX_FILE', '/repo/.git/index')
    monkeypatch.setenv('VERIFOLD_TEST', 'kept')

    environment = clean_environment()

    assert 'GIT_INDEX_FILE' not in environment
    assert environment['VERIFOLD_TEST'] == 'kept'


def test_a_harness_environment_is_clean_and_marked_with_the_lab_and_the_agent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv('GIT_DIR', '/repo/.git')
    monkeypatch.setenv(LAB_VARIABLE, '/an/outer/lab')

    environment = harness_environment(tmp_path, 'agent-1')

    assert 'GIT_DIR' not in environment
    assert environment[LAB_VARIABLE] == str(tmp_path)
    assert environment[AGENT_VARIABLE] == 'agent-1'
