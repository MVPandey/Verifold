"""The person's settings files: `~/.verifold/settings.json` for all projects, and `.verifold/settings.json` in one."""

import hashlib
import json
from collections.abc import Iterable, Sequence
from pathlib import Path

from pydantic import JsonValue

from verifold.protocol.events import Event, SettingsSet
from verifold.protocol.settings import Settings, SettingsFile, SettingsLevel
from verifold.store.errors import SettingsChanged, SettingsInvalid

SETTINGS_FILE = 'settings.json'


def settings_path(level: SettingsLevel, project: Path, home: Path | None = None) -> Path:
    """Return the settings file of `level`: `~/.verifold/settings.json` for all projects, or the project's own."""
    folder = (home or Path.home()) if level is SettingsLevel.ALL else project
    return folder / '.verifold' / SETTINGS_FILE


def load_settings(project: Path, home: Path | None = None) -> SettingsFile:
    """
    Return the settings for `project`: the project's file over the global file over the defaults.

    Each file may set only some settings. A project's value wins over the global one, setting by setting.

    Raises:
        SettingsInvalid: A file is not a JSON object, or holds a setting that Verifold doesn't know or accept.

    """
    return _load(settings_path(level, project, home) for level in (SettingsLevel.ALL, SettingsLevel.PROJECT))


def load_global_settings(home: Path | None = None) -> SettingsFile:
    """
    Return the settings for all projects: the global file over the defaults.

    Raises:
        SettingsInvalid: The file is not a JSON object, or holds a setting that Verifold doesn't know or accept.

    """
    return _load([settings_path(SettingsLevel.ALL, Path(), home)])


def read_settings_file(path: Path) -> tuple[dict[str, JsonValue], str]:
    """
    Return what a settings file holds, as written, and its revision: a hash of its content.

    A file that doesn't exist holds nothing, and its revision is empty.

    Raises:
        SettingsInvalid: The file is not a JSON object, or holds a setting that Verifold doesn't know or accept.

    """
    if not path.exists():
        return {}, ''
    try:
        content = path.read_bytes()
    except OSError as error:
        raise SettingsInvalid(f'{path} is not valid settings: {error}') from error
    return _parsed(path, content), hashlib.sha256(content).hexdigest()


def change_setting(path: Path, key: str, value: JsonValue, revision: str) -> None:
    """
    Set one setting in a settings file, or remove it when `value` is `None`, and keep the rest as written.

    `key` names the setting with dots, such as `jobs.at_exit`. The file changes only when it is still at `revision`,
    so that a change never overwrites one that the person didn't see. A removal also removes a table that it empties.

    Raises:
        SettingsChanged: The file changed since `revision`.
        SettingsInvalid: The file or the change is not valid.

    """
    data, current = read_settings_file(path)
    if current != revision:
        raise SettingsChanged(f'{path} changed since you opened it. Look at its new values, then change them again.')
    changed = _with(data, key.split('.'), value)
    _check(path, changed)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write a whole new file and then replace the old one, so that a reader never sees half a file.
    written = path.with_name(f'.{path.name}.new')
    written.write_text(json.dumps(changed, indent=2) + '\n')
    written.replace(path)


def _load(paths: Iterable[Path]) -> SettingsFile:
    merged: dict[str, JsonValue] = {}
    for path in paths:
        if path.exists():
            merged = _merged(merged, read_settings_file(path)[0])
    return SettingsFile.model_validate(merged)


def _parsed(path: Path, content: bytes) -> dict[str, JsonValue]:
    try:
        data = json.loads(content.decode())
    # A file that isn't UTF-8 raises a ValueError, and so does a JSON error.
    except ValueError as error:
        raise SettingsInvalid(f'{path} is not valid settings: {error}') from error
    if not isinstance(data, dict):
        raise SettingsInvalid(f'{path} must hold a JSON object.')
    _check(path, data)
    return data


def _check(path: Path, data: dict[str, JsonValue]) -> None:
    # Each file on its own must be valid, so that an error names the file that holds it.
    try:
        SettingsFile.model_validate(data)
    except ValueError as error:
        raise SettingsInvalid(f'{path} is not valid settings: {error}') from error


def _with(data: dict[str, JsonValue], keys: list[str], value: JsonValue) -> dict[str, JsonValue]:
    first, *rest = keys
    changed = dict(data)
    if rest:
        below = changed.get(first)
        inner = _with(below if isinstance(below, dict) else {}, rest, value)
        if inner:
            changed[first] = inner
        else:
            changed.pop(first, None)
    elif value is None:
        changed.pop(first, None)
    else:
        changed[first] = value
    return changed


def _merged(base: dict[str, JsonValue], over: dict[str, JsonValue]) -> dict[str, JsonValue]:
    merged = dict(base)
    for key, value in over.items():
        below = merged.get(key)
        merged[key] = _merged(below, value) if isinstance(below, dict) and isinstance(value, dict) else value
    return merged


def recorded_settings(events: Sequence[Event]) -> Settings | None:
    """Return the latest settings that a lab's record holds, or `None` for a record from before settings existed."""
    return next((event.settings for event in reversed(events) if isinstance(event, SettingsSet)), None)
