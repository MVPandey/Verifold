"""The names that Verifold gives the agents that it starts: the harness's title and the model's name."""

from collections.abc import Iterable

DEFAULT_MODEL = 'default model'
"""What a name says for the model of an agent that runs its harness's default model, until the harness names it."""

MAX_MODEL = 60
"""The most characters of a model's name that a name holds."""


def label(title: str, model: str | None, taken: Iterable[str]) -> str:
    """
    Return an agent's name, such as "Codex · gpt-6.1-sol": the harness's title and the model's name.

    `model` is the name that the harness shows for the model, or the model's ID when Verifold has no name for it.
    `None` says "default model", because Verifold invents no model name. The name gets a number, from 2, when a name
    in `taken` matches it, whatever its capitals.
    """
    shown = ' '.join((model or '').split())
    if len(shown) > MAX_MODEL:
        shown = f'{shown[: MAX_MODEL - 1]}…'
    base = f'{title} · {shown or DEFAULT_MODEL}'
    used = {name.casefold() for name in taken}
    if base.casefold() not in used:
        return base
    number = 2
    while f'{base} {number}'.casefold() in used:
        number += 1
    return f'{base} {number}'


def awaits_model(name: str, title: str) -> bool:
    """Return whether a name is one that `label` built for an agent of the harness `title` without a model's name."""
    base = label(title, None, ())
    return name == base or (name.startswith(f'{base} ') and name[len(base) + 1 :].isdecimal())
