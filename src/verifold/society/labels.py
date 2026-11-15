"""The names that Verifold gives the agents that it starts: the harness's title and the model's name."""

from collections.abc import Iterable

from verifold.protocol.agents import one_line

DEFAULT_MODEL = 'default model'
"""What a name says for the model of an agent that runs its harness's default model, until the harness names it."""

NOT_LISTED = 'model not listed'
"""
What a name says for the model of a seat that a coordinator's move added with a model that the harness did not
list, until the harness names the model. The model's ID is the coordinator's text, so no name holds it.
"""

MAX_MODEL = 60
"""The most characters of a model's name that a name holds. A longer one keeps its start and its end."""


def label(title: str, model: str | None, taken: Iterable[str]) -> str:
    """
    Return an agent's name, such as "Codex · gpt-6.1-sol": the harness's title and the model's name.

    `model` is the name that the harness shows for the model, or the model's ID when Verifold has no name for it.
    `None` says "default model", because Verifold invents no model name. The name gets a number, from 2, when a name
    in `taken` matches it, whatever its capitals.
    """
    base = plain(title, model)
    used = {name.casefold() for name in taken}
    if base.casefold() not in used:
        return base
    number = 2
    while f'{base} {number}'.casefold() in used:
        number += 1
    return f'{base} {number}'


def plain(title: str, model: str | None) -> str:
    """
    Return a name without a number: the harness's title and the model's name, as one printable line.

    A model's name of more than `MAX_MODEL` characters keeps its start and its end around an ellipsis, because
    the names of two models of one line often differ only at the end.
    """
    shown = one_line(model or '')
    if len(shown) > MAX_MODEL:
        head = (MAX_MODEL - 1) // 2
        shown = f'{shown[:head]}…{shown[len(shown) - (MAX_MODEL - 1 - head) :]}'
    return f'{title} · {shown or DEFAULT_MODEL}'


def is_numbered(name: str, base: str) -> bool:
    """Return whether a name is `base`, or `base` with the number that `label` gives."""
    return name == base or (name.startswith(f'{base} ') and name[len(base) + 1 :].isdecimal())


def awaits_model(name: str, title: str, chosen: str | None = None) -> bool:
    """
    Return whether Verifold built a name for an agent of the harness `title` before the harness named its model.

    Such a name says "default model" or "model not listed", or it holds the ID of the model that the person
    chose, `chosen`.
    """
    bases = (plain(title, None), plain(title, NOT_LISTED), *((plain(title, chosen),) if chosen else ()))
    return any(is_numbered(name, base) for base in bases)
