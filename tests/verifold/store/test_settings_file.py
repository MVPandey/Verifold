import json
import stat
from pathlib import Path

import pytest

from verifold.protocol.settings import AtExit, AtTimeLimit, HarnessSettings, Settings, SettingsFile, SettingsLevel
from verifold.store.errors import SettingsChanged, SettingsInvalid, SettingsUnwritable
from verifold.store.settings_file import (
    SettingsValues,
    change_setting,
    load_settings,
    read_settings_file,
    settings_of,
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


PROJECT, ALL = SettingsLevel.PROJECT, SettingsLevel.ALL


class Files:
    """The two settings files of a project in `tmp_path`, with a home folder of their own."""

    def __init__(self, tmp_path: Path) -> None:
        self.home, self.project = tmp_path / 'home', tmp_path / 'project'
        self.paths = {level: settings_path(level, self.project, self.home) for level in SettingsLevel}

    def revisions(self) -> dict[SettingsLevel, str]:
        return {level: read_settings_file(path)[1] for level, path in self.paths.items()}

    def change(self, level: SettingsLevel, key: str, value: str | None) -> dict[SettingsLevel, SettingsValues]:
        return change_setting(self.paths, level, key, value, self.revisions())


def test_a_change_sets_one_setting_and_keeps_the_rest_as_written(tmp_path: Path) -> None:
    files = Files(tmp_path)
    gemini = {'command': ['gemini'], 'family': 'google'}
    write(files.home / '.verifold', {'harnesses': {'gemini': gemini}, 'jobs': {'at_exit': 'keep'}})
    before = files.revisions()

    values = files.change(ALL, 'jobs.at_time_limit', 'stop')

    written = {'harnesses': {'gemini': gemini}, 'jobs': {'at_exit': 'keep', 'at_time_limit': 'stop'}}
    assert values == {ALL: written, PROJECT: {}}
    assert read_settings_file(files.paths[ALL])[0] == written
    assert files.revisions()[ALL] not in ('', before[ALL])
    assert settings_of(values).jobs == load_settings(files.project, files.home).jobs
    assert sorted(item.name for item in files.paths[ALL].parent.iterdir()) == ['settings.json']


def test_a_change_to_a_missing_file_creates_it_and_a_removal_drops_the_emptied_table(tmp_path: Path) -> None:
    files = Files(tmp_path)
    assert read_settings_file(files.paths[PROJECT]) == ({}, '')

    files.change(PROJECT, 'jobs.at_exit', 'keep')
    files.change(PROJECT, 'jobs.at_exit', None)

    assert read_settings_file(files.paths[PROJECT])[0] == {}


@pytest.mark.parametrize('level', list(SettingsLevel))
def test_a_change_is_refused_when_either_file_changed_since_it_was_read(tmp_path: Path, level: SettingsLevel) -> None:
    files = Files(tmp_path)
    revisions = files.revisions()
    # The file that changed may be the other one: the two add up, so either could change what the change means.
    write(files.paths[level].parent, {'jobs': {'at_exit': 'keep'}})

    with pytest.raises(SettingsChanged, match=r'settings\.json changed since you opened the settings'):
        change_setting(files.paths, PROJECT, 'jobs.at_time_limit', 'stop', revisions)

    assert read_settings_file(files.paths[PROJECT])[0] == ({'jobs': {'at_exit': 'keep'}} if level is PROJECT else {})


@pytest.mark.parametrize(('key', 'value'), [('jobs.at_exit', 'later'), ('colour', 'blue'), ('jobs', 'all')])
def test_a_change_that_makes_the_file_invalid_is_refused_and_writes_nothing(
    tmp_path: Path, key: str, value: str
) -> None:
    files = Files(tmp_path)

    with pytest.raises(SettingsInvalid, match=r'settings\.json is not valid settings'):
        files.change(PROJECT, key, value)

    assert not files.paths[PROJECT].exists()


def test_a_change_keeps_the_files_mode(tmp_path: Path) -> None:
    files = Files(tmp_path)
    write(files.paths[PROJECT].parent, {})
    files.paths[PROJECT].chmod(0o600)

    files.change(PROJECT, 'jobs.at_exit', 'keep')

    assert stat.S_IMODE(files.paths[PROJECT].stat().st_mode) == 0o600


def test_a_change_to_a_settings_file_that_is_a_link_is_refused(tmp_path: Path) -> None:
    files = Files(tmp_path)
    # A link can point at any file that holds valid settings, such as another config file or the global settings.
    other = tmp_path / 'other.json'
    other.write_text('{}')
    files.paths[PROJECT].parent.mkdir(parents=True)
    files.paths[PROJECT].symlink_to(other)

    with pytest.raises(SettingsUnwritable, match=r'settings\.json is a link'):
        files.change(PROJECT, 'jobs.at_exit', 'keep')

    assert other.read_text() == '{}'


def test_a_change_never_writes_through_a_file_that_waits_at_a_fixed_name(tmp_path: Path) -> None:
    files = Files(tmp_path)
    victim = tmp_path / 'victim.txt'
    victim.write_text('keep me')
    folder = files.paths[PROJECT].parent
    folder.mkdir(parents=True)
    (folder / '.settings.json.new').symlink_to(victim)

    files.change(PROJECT, 'jobs.at_exit', 'keep')

    assert victim.read_text() == 'keep me'
    assert not files.paths[PROJECT].is_symlink()


def test_a_file_that_cant_be_written_says_why_and_leaves_nothing_behind(tmp_path: Path) -> None:
    files = Files(tmp_path)
    files.home.mkdir()
    # The folder of the file for all projects is a file, so nothing can be written in it.
    (files.home / '.verifold').write_text('')

    with pytest.raises(SettingsUnwritable, match=r"Can't write .*settings\.json"):
        change_setting(files.paths, ALL, 'jobs.at_exit', 'keep', {ALL: '', PROJECT: ''})


def test_the_settings_for_all_projects_leave_out_the_projects_file(tmp_path: Path) -> None:
    files = Files(tmp_path)
    write(files.project / '.verifold', {'jobs': {'at_exit': 'keep'}})
    values = {level: read_settings_file(path)[0] for level, path in files.paths.items()}

    assert settings_of({ALL: values[ALL]}).jobs.at_exit is AtExit.STOP
    assert settings_of(values).jobs.at_exit is AtExit.KEEP
