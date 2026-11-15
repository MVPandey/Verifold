"""Which commands the person's grants cover, and whether an agent waits for the person's answer to a request."""

from collections.abc import Iterable

from pydantic import TypeAdapter, ValidationError

from verifold.protocol.grants import Grant, plain
from verifold.protocol.settings import WhileYouDecide
from verifold.society.board import Board

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


def agent_waits(board: Board) -> bool:
    """
    Return whether an agent's harness waits while its request waits for the person's answer.

    The person's setting says so. Without one, the lab follows the person's choice of auto mode: in a lab with auto
    mode the harness gets a refusal at once and the agent goes on, and in a lab without it the harness waits.
    """
    chosen = board.settings.permissions.while_you_decide
    return not board.opened.auto_mode if chosen is WhileYouDecide.AUTO else chosen is WhileYouDecide.WAIT


def grantable(command: str) -> str | None:
    """Return what a grant for `command` would name, which is its first word, or `None` when no grant can cover it."""
    if not plain(command):
        return None
    try:
        return _GRANT.validate_python(command.split(maxsplit=1)[0])
    except ValidationError:
        return None
