"""
The lab's norms: the two files that say how the person wants the work done and the answer written.

They are the only place for words that tell an agent how to behave. The person reads and edits them, by hand or on
the app's Norms page. A new lab starts with Verifold's defaults. Verifold never changes a file that exists, except
when the person saves it from the page.
"""

import hashlib
import os
import stat
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path

from verifold.protocol.app import MAX_NORMS, NORMS_NAMES, NormsName
from verifold.store.errors import NormsUnreadable
from verifold.store.settings_file import write_regular

DEFAULTS: dict[NormsName, str] = {
    name: files('verifold.society').joinpath(name).read_text(encoding='utf-8') for name in NORMS_NAMES
}
"""The text that a new lab starts with, for each norms file."""


@dataclass(frozen=True, slots=True)
class NormsRead:
    """A norms file as it is on the disk, or Verifold's default when the folder has no such file."""

    text: str
    saved: bool
    """Whether the folder has the file."""
    changed_at: datetime | None = None
    """When the file last changed, or `None` for the default."""


def revision(text: str) -> str:
    """Return the hash that names one text of a norms file."""
    return hashlib.sha256(text.encode('utf-8', errors='replace')).hexdigest()


def read_norms(folder: Path, name: NormsName) -> NormsRead:
    """
    Return a norms file in the lab folder. A folder without the file gives Verifold's default, which a new lab gets.

    Only a regular file is read. A link could show any file, and a pipe, a device, or a folder at that path would
    block the read or never end it.

    Raises:
        NormsUnreadable: The path holds something other than a regular file, or the file is not UTF-8 text, or it
            is larger than `MAX_NORMS` characters.

    """
    path = folder / name
    try:
        found = path.lstat()
    except FileNotFoundError:
        return NormsRead(text=DEFAULTS[name], saved=False)
    except OSError as error:
        raise NormsUnreadable(f"Can't read {path}: {error}") from error
    if not stat.S_ISREG(found.st_mode):
        what = 'a link' if stat.S_ISLNK(found.st_mode) else 'not a regular file'
        raise NormsUnreadable(f'{path} is {what}. Verifold reads only a regular file here.')
    try:
        # The file can become something else after the check. `O_NONBLOCK` keeps an open of a pipe from waiting.
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(descriptor, encoding='utf-8') as file:
            text = file.read(MAX_NORMS + 1)
    except (OSError, UnicodeDecodeError) as error:
        raise NormsUnreadable(f"Can't read {path} as text: {error}") from error
    if len(text) > MAX_NORMS:
        raise NormsUnreadable(f'{path} has more than {MAX_NORMS:,} characters, so the app does not show it.')
    return NormsRead(text=text, saved=True, changed_at=datetime.fromtimestamp(found.st_mtime, UTC))


def missing_lines(name: NormsName, text: str) -> tuple[str, ...]:
    """
    Return the lines of Verifold's current default that a norms file does not have, in the default's order.

    A lab keeps the file that it started with, so a default that gained a norm since leaves that file without it.
    The person sees these lines on the Norms page and decides. Verifold adds nothing to the file.
    """
    have = {line.strip() for line in text.splitlines()}
    return tuple(line for line in DEFAULTS[name].splitlines() if line.strip() and line.strip() not in have)


def write_norms(folder: Path, name: NormsName, text: str) -> None:
    """
    Write a norms file in the lab folder.

    Raises:
        SettingsUnwritable: The file is a link, or it can't be written.

    """
    write_regular(folder / name, text)


def write_missing_norms(folder: Path) -> None:
    """
    Give the lab folder each norms file that it lacks, with Verifold's default text.

    A path that holds anything stays as it is, also a link that leads nowhere: Verifold writes through no link.

    Raises:
        SettingsUnwritable: A file can't be written.

    """
    for name, text in DEFAULTS.items():
        if not os.path.lexists(folder / name):
            write_regular(folder / name, text)
