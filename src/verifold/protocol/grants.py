"""Grants: the commands that the person lets every agent of a lab run without another question."""

from typing import Annotated

from pydantic import AfterValidator, StringConstraints

SHELL_OPERATORS = (';', '&', '|', '<', '>', '`', '$(', '\n')
"""What joins, redirects, or nests shell commands. A grant covers one plain command, so none of these is in it."""


def plain(command: str) -> bool:
    """Return whether `command` is one plain command, without a shell operator."""
    return not any(operator in command for operator in SHELL_OPERATORS)


def _one_plain_command(prefix: str) -> str:
    if not plain(prefix):
        raise ValueError('A grant is the start of one plain command, without ; & | < > ` or $(.')
    return prefix


type Grant = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200), AfterValidator(_one_plain_command)
]
"""The start of a command, such as `./gpu`. It covers that command with any arguments."""
