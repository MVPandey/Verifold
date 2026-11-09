import json
from pathlib import Path

import pytest

from verifold.protocol.settings import AtExit, AtTimeLimit, HarnessSettings, Settings, SettingsFile, SettingsLevel
from verifold.store.errors import SettingsChanged, SettingsInvalid
from verifold.store.settings_file import (
    change_setting,
    load_global_settings,
    load_settings,
    read_settings_file,
    settings_path,
)


def write(folder: Path, data: object) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'settings.json').write_text(json.dumps(data))


def test_without_files_a_lab_gets_the_defaults(tmp_path: Path) -> None:
    settings = load_settings(tmp_path / 'project', home=tmp_path / 'home')

    assert settings == SettingsFile()
    assert settings.lab_settings() == Settings()
    assert settings.harnesses == {}
    assert settings.jobs.at_time_limit is AtTimeLimit.PAUSE
    assert settings.jobs.at_exit is AtExit.STOP


def test_a_projects_settings_win_over_the_global_ones_setting_by_setting(tmp_path: Path) -> None:
    home, project = tmp_path / 'home', tmp_path / 'project'
    write(home / '.verifold', {'jobs': {'at_time_limit': 'stop', 'at_exit': 'keep'}})
    write(project / '.verifold', {'jobs': {'at_time_limit': 'finish'}})

    settings = load_settings(project, home=home)

    assert settings.jobs.at_time_limit is AtTimeLimit.FINISH
    assert settings.jobs.at_exit is AtExit.KEEP


@pytest.mark.parametrize('content', ['{not json', '[]', '{"jobs": {"at_exit": "later"}}', '{"colour": "blue"}'])
def test_an_invalid_file_is_refused_with_its_path(tmp_path: Path, content: str) -> None:
    project = tmp_path / 'project'
    (project / '.verifold').mkdir(parents=True)
    (project / '.verifold' / 'settings.json').write_text(content)

    with pytest.raises(SettingsInvalid, match=r'settings\.json'):
        load_settings(project, home=tmp_path / 'home')


def test_a_file_that_is_not_utf8_is_refused_with_its_path(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    (project / '.verifold').mkdir(parents=True)
    (project / '.verifold' / 'settings.json').write_bytes(b'{"jobs": "\xff"}')

    with pytest.raises(SettingsInvalid, match=r'settings\.json'):
        load_settings(project, home=tmp_path / 'home')


def test_harness_entries_merge_setting_by_setting_and_stay_out_of_the_labs_settings(tmp_path: Path) -> None:
    home, project = tmp_path / 'home', tmp_path / 'project'
    write(
        home / '.verifold', {'harnesses': {'gemini': {'command': ['gemini'], 'family': 'google', 'auto_mode': 'yolo'}}}
    )
    write(project / '.verifold', {'harnesses': {'gemini': {'command': ['gemini', '--acp'], 'family': 'google'}}})

    settings = load_settings(project, home=home)

    assert settings.harnesses == {
        'gemini': HarnessSettings(command=('gemini', '--acp'), family='google', auto_mode='yolo')
    }
    assert settings.lab_settings() == Settings()


def test_a_harness_entry_without_a_command_is_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    write(project / '.verifold', {'harnesses': {'gemini': {'family': 'google'}}})

    with pytest.raises(SettingsInvalid, match=r'settings\.json'):
        load_settings(project, home=tmp_path / 'home')


def test_a_change_sets_one_setting_and_keeps_the_rest_as_written(tmp_path: Path) -> None:
    home = tmp_path / 'home'
    gemini = {'command': ['gemini'], 'family': 'google'}
    write(home / '.verifold', {'harnesses': {'gemini': gemini}, 'jobs': {'at_exit': 'keep'}})
    path = settings_path(SettingsLevel.ALL, tmp_path / 'project', home)
    _, revision = read_settings_file(path)

    change_setting(path, 'jobs.at_time_limit', 'stop', revision)

    values, changed = read_settings_file(path)
    assert values == {'harnesses': {'gemini': gemini}, 'jobs': {'at_exit': 'keep', 'at_time_limit': 'stop'}}
    assert changed not in ('', revision)
    assert load_global_settings(home).jobs == load_settings(tmp_path / 'project', home).jobs
    assert sorted(item.name for item in path.parent.iterdir()) == ['settings.json']


def test_a_change_to_a_missing_file_creates_it_and_a_removal_drops_the_emptied_table(tmp_path: Path) -> None:
    path = settings_path(SettingsLevel.PROJECT, tmp_path / 'project')
    assert read_settings_file(path) == ({}, '')

    change_setting(path, 'jobs.at_exit', 'keep', '')
    change_setting(path, 'jobs.at_exit', None, read_settings_file(path)[1])

    assert read_settings_file(path)[0] == {}


def test_a_change_to_a_file_that_changed_since_it_was_read_is_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    write(project / '.verifold', {'jobs': {'at_exit': 'keep'}})
    path = settings_path(SettingsLevel.PROJECT, project)
    _, revision = read_settings_file(path)
    write(project / '.verifold', {'jobs': {'at_exit': 'stop'}})

    with pytest.raises(SettingsChanged, match=r'settings\.json changed since you opened it'):
        change_setting(path, 'jobs.at_time_limit', 'stop', revision)

    assert read_settings_file(path)[0] == {'jobs': {'at_exit': 'stop'}}


@pytest.mark.parametrize(('key', 'value'), [('jobs.at_exit', 'later'), ('colour', 'blue'), ('jobs', 'all')])
def test_a_change_that_makes_the_file_invalid_is_refused_and_writes_nothing(
    tmp_path: Path, key: str, value: str
) -> None:
    path = settings_path(SettingsLevel.PROJECT, tmp_path / 'project')

    with pytest.raises(SettingsInvalid, match=r'settings\.json is not valid settings'):
        change_setting(path, key, value, '')

    assert not path.exists()


def test_the_settings_for_all_projects_leave_out_the_projects_file(tmp_path: Path) -> None:
    home, project = tmp_path / 'home', tmp_path / 'project'
    write(project / '.verifold', {'jobs': {'at_exit': 'keep'}})

    assert load_global_settings(home).jobs.at_exit is AtExit.STOP
    assert load_settings(project, home).jobs.at_exit is AtExit.KEEP
