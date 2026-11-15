"""
Which names an agent can choose.

The lab service checks a name when an agent chooses it. The record's rules do not: a record keeps the names that
it holds, so a rule that gets stricter later never stops an older record from loading.

A name is refused when it is, or reads as, another agent's name, a word that the board or the app uses, or a
harness or a model that the lab knows. So no agent passes as another agent, as the person, or as a model that it is
not.
"""

import re
import unicodedata

from verifold.protocol.ids import AgentId
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent

MAX_CHOSEN_NAMES = 5
"""How many times an agent can choose a name in one lab."""

LOOKED_ALIKE = ('person', 'verifold', 'system', 'admin', 'coordinator', 'reviewer')
"""The reserved words that a name does not look like either: a look-alike of one of them is the attack."""

RESERVED_WORDS = (
    *LOOKED_ALIKE,
    'you',
    'human',
    'user',
    'server',
    'moderator',
    'everyone',
    'all',
    'lab',
    'agent',
    'checker',
    'guest',
    'helper',
    'oncall',
)
"""
The words that no chosen name is made of, because the app and the board use them for the person, a seat, or the
lab. "oncall" stands for the seat mark "On call".
"""

MIN_MODEL_WORD = 4
"""The fewest letters of a word of a harness's title or a model's name that no name holds. A shorter one is a fragment."""

_ALIKE = str.maketrans({'1': 'l', 'i': 'l', '0': 'o', '5': 's'})
_POST_OR_THREAD = re.compile(r'[pt]-?\d+')


def alike(name: str) -> str:
    """Return a name without capitals and with the characters that look alike made one: `1`, `i`, `l`, then `0`, `o`, then `5`, `s`, and `rn` as `m`."""
    return unicodedata.normalize('NFKC', name).casefold().replace('rn', 'm').translate(_ALIKE)


def skeleton(name: str) -> str:
    """
    Return a name as two names that look alike share it.

    It is `alike` without spaces, hyphens, and apostrophes. So "Tesse1", "TesseI", and "Tes sel" are "Tessel".
    """
    return re.sub(r"[ '-]", '', alike(name))


def _made_of(squashed: str, words: tuple[str, ...]) -> bool:
    # Whether a text is reserved words run together, each with or without a plural "s", with "the" between them.
    longest = sorted(words, key=len, reverse=True)
    made = re.fullmatch(rf'(?:the|(?:{"|".join(map(re.escape, longest))})s?)+', squashed)
    return bool(made) and squashed.replace('the', '') != ''


def reserved_in(name: str) -> str | None:
    """
    Return the reserved word that a name is made of, or `None`.

    A name is made of reserved words when, without its digits, spaces, hyphens, and apostrophes, it is one or more
    of them run together, with or without "the": "Reviewer2", "ThePerson", "LabCoordinator", "Agents",
    "On Call 2". A longer word that only holds one, such as "Systemic", is none. The words in `LOOKED_ALIKE` also
    count when the name only looks like them, such as "Per5on".
    """
    exact = re.sub(r"[\d '-]", '', name.casefold())
    if _made_of(exact, RESERVED_WORDS):
        return next(word for word in sorted(RESERVED_WORDS, key=len, reverse=True) if word in exact)
    # Digits stay here, because a digit can stand for a letter: only the digits at the ends go.
    looks = skeleton(name).strip('0123456789')
    strict = tuple(skeleton(word) for word in LOOKED_ALIKE)
    if _made_of(skeleton(re.sub(r'^\d+|\d+$', '', name)), strict) or _made_of(looks, strict):
        return next((word for word in LOOKED_ALIKE if skeleton(word) in skeleton(name)), LOOKED_ALIKE[0])
    return None


def model_words(board: Board) -> dict[str, str]:
    """
    Return the names of harnesses and models that no agent takes, by their skeleton, each with the text that it comes from.

    They are each harness's key and title, each model's name, ID, and family, but for the ID of a model that a
    coordinator's move named and the harness did not list, and the model that each harness
    reported for a turn, whole. They are also each word of four or more letters of a harness's title, of a model's
    name as a harness shows it, and of a family: "Opus", "Sonnet", "Claude", "Codex", "Code". A shorter word, such
    as "Sol" or "Max", is a fragment of a model's ID and is free.
    """
    # A label ends with the number of a second seat, so the model's name is the label's part without it.
    parts = tuple(part for _, _, text in board.labels if ' · ' in text for part in text.split(' · '))
    labels = (*parts, *(re.sub(r' \d+$', '', part) for part in parts))
    reported = tuple(start.model_name for start in board.starts)
    families = tuple(joined.agent.model.family for joined in board.agents)
    # The ID of a model that a coordinator named and the harness did not list reserves nothing: it is an agent's text.
    ids = (
        word
        for joined in board.agents
        for word in (joined.agent.harness, joined.agent.model.name if joined.agent.model_listed else None)
    )
    shown = tuple(text for text in (*labels, *reported, *families) if text)
    whole = (*shown, *(text for text in (*ids, *(start.model for start in board.starts)) if text))
    # A word is a run of letters between spaces. A part of an ID, such as "mini" in "gpt-6.1-pro-mini", is none.
    words = (
        (word, text) for text in shown for word in text.split(' ') if word.isalpha() and len(word) >= MIN_MODEL_WORD
    )
    return {skeleton(word): text for word, text in (*((text, text) for text in whole), *words)}


def _reads_as(one: str, other: str) -> bool:
    # Whether one name is the other, or the other followed by a word break or by digits: "Jo's" and "Jo", "Tessel2"
    # and "Tessel", "Mar en" and "Mar".
    if skeleton(one) == skeleton(other):
        return True
    long, short = sorted((alike(one), alike(other)), key=len, reverse=True)
    return long.startswith(short) and bool(re.fullmatch(r"[ '-].*|\d+", long[len(short) :]))


def check_name(board: Board, agent_id: AgentId, name: str) -> None:
    """
    Check that an agent can choose a name. The refusal names what the name collides with.

    Raises:
        RejectedEvent: The agent chose a name `MAX_CHOSEN_NAMES` times already. The name is, looks like, or
            extends by a word or by digits a name that another agent has or had, or the other way round. The name
            is made of reserved words, has the form of the ID of an agent, a post, or a thread, or is or holds the
            name of a harness or a model that the lab knows.

    """
    chosen = sum(entry.agent == agent_id and bool(entry.name) and entry.by is None for entry in board.profiles)
    if chosen >= MAX_CHOSEN_NAMES:
        raise RejectedEvent(
            f'An agent chooses a name at most {MAX_CHOSEN_NAMES} times in a lab, and you chose {chosen}. Your name '
            f'stays {board.chosen_name(agent_id) or board.label(agent_id)}.'
        )
    taken = next(
        (text for agent, text in board.names() if agent != agent_id and ' · ' not in text and _reads_as(name, text)),
        None,
    )
    if taken:
        raise RejectedEvent(
            f'{name} reads as {taken}, a name that another agent has or had. A name stays with the agent that held it.'
        )
    word = reserved_in(name)
    if word:
        raise RejectedEvent(
            f'{name} is made of the word "{word}", which the board uses for the person, a seat, or the lab.'
        )
    ids = {joined.agent.id for joined in board.agents}
    if name.casefold() in ids or _POST_OR_THREAD.fullmatch(name.casefold()):
        raise RejectedEvent(f'{name} has the form of the ID of an agent, a post, or a thread.')
    known = model_words(board)
    parts = (name, *(re.sub(r'\d', '', part) for part in re.split(r"[ '-]", name)))
    model = next((known[skeleton(part)] for part in parts if part and skeleton(part) in known), None)
    if model:
        raise RejectedEvent(
            f'{name} is or holds the name of a harness or a model in this lab ({model}), and a name is not a model.'
        )
