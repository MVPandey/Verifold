"""The person's settings files: `~/.verifold/settings.json` for all projects, and `.verifold/settings.json` in one."""

import hashlib
import json
import os
import stat
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path

from pydantic import JsonValue

from verifold.protocol.events import Event, SettingsSet
from verifold.protocol.settings import Settings, SettingsFile, SettingsLevel
from verifold.store.errors import SettingsChanged, SettingsInvalid, SettingsUnwritable

SETTINGS_FILE = 'settings.json'

LEVELS = (SettingsLevel.ALL, SettingsLevel.PROJECT)
"""The levels in the order that they add up: a project's file wins over the one for all projects."""

type SettingsValues = dict[str, JsonValue]
"""What a settings file holds, as written."""


def settings_path(level: SettingsLevel, project: Path, home: Path | None = None) -> Path:
    """Return the settings file of `level`: `~/.verifold/settings.json` for all projects, or the project's own."""
    folder = (home or Path.home()) if level is SettingsLevel.ALL else project
    return folder / '.verifold' / SETTINGS_FILE


def load_settings(project: Path, home: Path | None = None) -> SettingsFile:
    """
    Return the settings for `project`: the project's file over the global file over the defaults.

    Each file may set only some settings. A project's value wins over the global one, setting by setting. Harnesses
    come only from the global file.

    Raises:
        SettingsInvalid: A file is not a JSON object, or holds a setting that Verifold doesn't know or accept there.

    """
    return settings_of({level: read_settings_file(settings_path(level, project, home), level)[0] for level in LEVELS})


def settings_of(values: Mapping[SettingsLevel, SettingsValues]) -> SettingsFile:
    """Return the settings that files with `values` add up to, over the defaults. A missing level holds nothing."""
    merged: SettingsValues = {}
    for level in LEVELS:
        merged = _merged(merged, values.get(level, {}))
    return SettingsFile.model_validate(merged)


def read_settings_file(path: Path, level: SettingsLevel) -> tuple[SettingsValues, str]:
    """
    Return what the settings file of `level` holds, as written, and its revision: a hash of its content.

    A file that doesn't exist holds nothing, and its revision is empty.

    Raises:
        SettingsInvalid: The file is not a JSON object, or holds a setting that Verifold doesn't know or accept at
            its level. A project's file can't hold harnesses: it can come from someone else, such as a cloned
            repository, or from an agent, and a harness's command runs on this computer.

    """
    if not path.exists():
        return {}, ''
    content = _content(path)
    data = _parsed(path, content)
    # In the home folder, the project's file is the file for all projects.
    own = path.parent.parent.resolve() != Path.home().resolve()
    if level is SettingsLevel.PROJECT and own and 'harnesses' in data:
        raise SettingsInvalid(
            f"{path} holds harnesses. A project's file can come from someone else, such as a cloned repository, or "
            'from an agent, so only ~/.verifold/settings.json may add or change a harness. Remove the harnesses from '
            'this file, and add one to ~/.verifold/settings.json only if you trust its command.'
        )
    return data, hashlib.sha256(content).hexdigest()


MAX_SETTINGS_BYTES = 64 * 1024
"""The largest settings file that Verifold reads. Settings files are small, and a huge one would only cost memory."""


def _content(path: Path) -> bytes:
    # A pipe or a device in place of the file would block a read or never end it, so only a regular file is read.
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise SettingsInvalid(f'{path} is not a regular file.')
            content = file.read(MAX_SETTINGS_BYTES + 1)
    except OSError as error:
        raise SettingsInvalid(f'{path} is not valid settings: {error}') from error
    if len(content) > MAX_SETTINGS_BYTES:
        raise SettingsInvalid(f'{path} is larger than {MAX_SETTINGS_BYTES // 1024} KiB.')
    return content


def change_setting(
    paths: Mapping[SettingsLevel, Path],
    level: SettingsLevel,
    key: str,
    value: JsonValue,
    revisions: Mapping[SettingsLevel, str],
) -> dict[SettingsLevel, SettingsValues]:
    """
    Set one setting in the file of `level`, or remove it when `value` is `None`, and keep the rest as written.

    `key` names the setting with dots, such as `jobs.at_exit`. A removal also removes a table that it empties. Each
    file in `paths` must still be at its revision in `revisions`, because the files add up: a change on top of a file
    that changed since the person read it could apply a setting that the person didn't see. Return what each file
    holds after the change, as this call read and wrote it.

    Raises:
        SettingsChanged: A file changed since the person read it.
        SettingsInvalid: A file or the change is not valid.
        SettingsUnwritable: The file can't be written.

    """
    values: dict[SettingsLevel, SettingsValues] = {}
    for each, path in paths.items():
        values[each], revision = read_settings_file(path, each)
        if revision != revisions.get(each):
            raise SettingsChanged(
                f'{path} changed since you opened the settings. Look at its new values, then change them again.'
            )
    values[level] = _with(values[level], key.split('.'), value)
    _check(paths[level], values[level])
    _write(paths[level], values[level])
    return values


def _write(path: Path, values: SettingsValues) -> None:
    # A link could take the write to any file, so Verifold writes only a regular file. A link that appears after this
    # check is replaced, not followed.
    if path.is_symlink():
        raise SettingsUnwritable(
            f'{path} is a link. Verifold changes only a regular file, so edit the file that it links to.'
        )
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else None
        # A new file with a name of its own: nothing that waits at a fixed name can take the write somewhere else.
        descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.', suffix='.new')
    except OSError as error:
        raise SettingsUnwritable(f"Can't write {path}: {error}") from error
    written = Path(name)
    try:
        with os.fdopen(descriptor, 'w') as file:
            file.write(json.dumps(values, indent=2) + '\n')
            file.flush()
            os.fsync(file.fileno())
        if mode is not None:
            written.chmod(mode)
        # The new file replaces the old one at once, so that a reader never sees half a file.
        written.replace(path)
    except OSError as error:
        written.unlink(missing_ok=True)
        raise SettingsUnwritable(f"Can't write {path}: {error}") from error


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
