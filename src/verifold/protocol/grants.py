"""Grants: the commands that the person lets every agent of a lab run without another question."""

import re
from typing import Annotated

from pydantic import AfterValidator, StringConstraints

_WORD = r'[A-Za-z0-9_./:,+@%-][A-Za-z0-9_./:,+@%=-]*'
_PLAIN = re.compile(rf' *{_WORD}(?: +{_WORD})* *')


def plain(command: str) -> bool:
    """
    Return whether `command` is one plain command: words of letters, digits, and `_ . / : , + @ % - =`, with spaces.

    Every other character can make a shell do more than the command says, such as a pipe, a redirect, a quote, a
    variable, a bracket, or a line break. A word doesn't start with `=`, which some shells expand.
    """
    return _PLAIN.fullmatch(command) is not None


def _one_plain_command(prefix: str) -> str:
    if not plain(prefix):
        raise ValueError('A grant is the start of one plain command: letters, digits, spaces, and _ . / : , + @ % - =.')
    return prefix


type Grant = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200), AfterValidator(_one_plain_command)
]
"""The start of a command, such as `./gpu`. It covers that command with any plain arguments."""
