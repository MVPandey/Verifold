import json
from pathlib import Path

import pytest

from verifold.protocol.settings import AtExit, AtTimeLimit, Settings
from verifold.store.errors import SettingsInvalid
from verifold.store.settings_file import load_settings


def write(folder: Path, data: object) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'settings.json').write_text(json.dumps(data))


def test_without_files_a_lab_gets_the_defaults(tmp_path: Path) -> None:
    settings = load_settings(tmp_path / 'project', home=tmp_path / 'home')

    assert settings == Settings()
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
