"""The person's settings files: `~/.verifold/settings.json` for all projects, and `.verifold/settings.json` in one."""

import json
from pathlib import Path

from pydantic import ValidationError

from verifold.protocol.settings import Settings
from verifold.store.errors import SettingsInvalid

SETTINGS_FILE = 'settings.json'


def load_settings(project: Path, home: Path | None = None) -> Settings:
    """
    Return the settings for a new lab in `project`: the project's file over the global file over the defaults.

    Each file may set only some settings. A project's value wins over the global one, setting by setting.

    Raises:
        SettingsInvalid: A file is not a JSON object, or holds a setting that Verifold doesn't know or accept.

    """
    merged: dict[str, object] = {}
    for path in ((home or Path.home()) / '.verifold' / SETTINGS_FILE, project / '.verifold' / SETTINGS_FILE):
        if path.exists():
            merged = _merged(merged, _read(path))
    return Settings.model_validate(merged)


def _read(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise SettingsInvalid(f'{path} must hold a JSON object.')
        # Each file on its own must be valid, so that an error names the file that holds it.
        Settings.model_validate(data)
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        raise SettingsInvalid(f'{path} is not valid settings: {error}') from error
    return data


def _merged(base: dict[str, object], over: dict[str, object]) -> dict[str, object]:
    merged = dict(base)
    for key, value in over.items():
        below = merged.get(key)
        merged[key] = _merged(below, value) if isinstance(below, dict) and isinstance(value, dict) else value
    return merged
