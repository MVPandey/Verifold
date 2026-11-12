"""Which commands the person's grants cover."""

from collections.abc import Iterable

from pydantic import TypeAdapter, ValidationError

from verifold.protocol.grants import Grant, plain

_GRANT: TypeAdapter[str] = TypeAdapter(Grant)


def granted(grants: Iterable[str], command: str) -> bool:
    """
    Return whether a grant covers `command`.

    A grant covers the command that it names, with any arguments, when the whole command is plain. A command with a
    pipe, a redirect, a quote, or another sign of the shell gets no grant, because the sign can add what the grant
    doesn't name.
    """
    command = command.strip()
    return plain(command) and any(command == grant or command.startswith(f'{grant} ') for grant in grants)


def grantable(command: str) -> str | None:
    """Return what a grant for `command` would name, which is its first word, or `None` when no grant can cover it."""
    if not plain(command):
        return None
    try:
        return _GRANT.validate_python(command.split(maxsplit=1)[0])
    except ValidationError:
        return None
