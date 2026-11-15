"""
The lab's norms: the two files that say how the person wants the work done and the answer written.

They are the only place for words that tell an agent how to behave. The person reads and edits them, by hand or on
the app's Norms page. A new lab starts with Verifold's defaults.
"""

from importlib.resources import files
from pathlib import Path

from verifold.protocol.app import MAX_NORMS, NORMS_NAMES, NormsName
from verifold.store.errors import NormsUnreadable
from verifold.store.settings_file import write_regular

DEFAULTS: dict[NormsName, str] = {name: files('verifold.society').joinpath(name).read_text() for name in NORMS_NAMES}
"""The text that a new lab starts with, for each norms file."""


def read_norms(folder: Path, name: NormsName) -> tuple[str, bool]:
    """
    Return the text of a norms file in the lab folder, and whether the folder has the file.

    A folder without the file gives Verifold's default, which a new lab gets.

    Raises:
        NormsUnreadable: The file is a link, is not text, or is larger than `MAX_NORMS` characters.

    """
    path = folder / name
    if path.is_symlink():
        raise NormsUnreadable(f'{path} is a link. Verifold reads only a regular file here.')
    if not path.exists():
        return DEFAULTS[name], False
    try:
        with path.open(encoding='utf-8') as file:
            text = file.read(MAX_NORMS + 1)
    except (OSError, UnicodeDecodeError) as error:
        raise NormsUnreadable(f"Can't read {path} as text: {error}") from error
    if len(text) > MAX_NORMS:
        raise NormsUnreadable(f'{path} has more than {MAX_NORMS:,} characters, so the app does not show it.')
    return text, True


def write_norms(folder: Path, name: NormsName, text: str) -> None:
    """
    Write a norms file in the lab folder.

    Raises:
        SettingsUnwritable: The file is a link, or it can't be written.

    """
    write_regular(folder / name, text)
