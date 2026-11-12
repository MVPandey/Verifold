"""Which commands the person's grants cover."""

import shlex
from collections.abc import Iterable

from verifold.protocol.grants import plain

MAX_GRANT = 200


def granted(grants: Iterable[str], command: str) -> bool:
    """
    Return whether a grant covers `command`.

    A grant covers the command that it names, with any arguments. It covers no command with a shell operator, such as
    a pipe or a redirect, because the grant would then let through whatever the operator adds.
    """
    command = command.strip()
    return plain(command) and any(command == grant or command.startswith(f'{grant} ') for grant in grants)


def grantable(command: str) -> str | None:
    """Return what a grant for `command` would name, which is its first word, or `None` when no grant fits it."""
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    first = words[0] if words else ''
    # A first word that sets a variable, such as `A=1 make`, names no command.
    fits = bool(first) and plain(first) and '=' not in first and len(first) <= MAX_GRANT
    return first if fits else None
