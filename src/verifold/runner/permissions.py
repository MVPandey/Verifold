"""
Permission requests and questions of the agents' harnesses, and who decides them.

Verifold allows a call to the lab's own board, and a command that a grant of the person covers. Every other request
goes to the person on the board, with the harness's own answers. The person's setting says what the harness gets
until the person answers. Either the request waits, as it does in a harness that the person runs by hand, or
Verifold refuses it at once and the answer applies when the agent asks for the same again.

The person allows only what the ask shows. So an ask records the whole command or input as data of its own, with
each character that a reader cannot see written as its code point, and the app shows that data in a box apart from
Verifold's sentences. The headline holds Verifold's words only. The body repeats the request as text for the agents
that read the board, inside a code fence. A request that an ask cannot hold whole is refused.
"""

import asyncio
import hashlib
import json
import logging
import math
import re
import unicodedata
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from verifold.protocol.ids import PERSON, PostId
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import (
    MAX_BODY,
    MAX_CHOICE,
    MAX_CHOICES,
    Answer,
    Ask,
    PermissionShown,
    QuestionShown,
    RequestNote,
)
from verifold.protocol.settings import PermissionSettings
from verifold.protocol.threads import Carries
from verifold.runner.session import Answers, FieldValue, PermissionChoice, PermissionRequest, Question, QuestionField
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.grants import agent_waits, grantable, granted
from verifold.society.standing import waits_for_person

logger = logging.getLogger(__name__)

_YES = frozenset(
    {'allow', 'allow it', 'allow once', 'approve', 'approved', 'go ahead', 'ok', 'okay', 'sure', 'y', 'yes'}
    | {'yes please'}
)
"""The answers in the person's own words that allow once. The whole answer must be one of them."""
_NO = frozenset(
    {'cancel', 'deny', 'do not', 'do not allow', "don't", "don't allow", 'dont', 'n', 'never', 'no', 'no thanks'}
    | {'nope', 'refuse', 'reject', 'stop'}
)
"""The answers in the person's own words that reject. The whole answer must be one of them."""
_ONCE = frozenset({'allow_once', 'reject_once'})
_STOPS = re.compile(r'abort|cancel|interrupt|stop')
"""What the ID of an answer holds when the answer stops the agent's turn. ACP has no kind of answer for that."""
_KINDS = frozenset({'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'})
"""ACP's kinds of tool. Only these words of a harness go in a headline."""

ANSWER_LIFE = timedelta(hours=1)
"""How long the person's answer to a refused request waits for the agent's next try of that request."""

_ROOM = 1_000
"""The characters of an ask's body that stay free for Verifold's own sentences in a later ask about the request."""
_START = 2_000
"""How much of a request that is too long to show an ask still shows, with no answer that allows."""

_SAID: dict[RequestNote, str] = {
    'refused': (
        'Verifold refused this at once, as your settings say, so the agent goes on. Your answer applies when the '
        'agent asks for the same again within an hour.'
    ),
    'unclear': (
        'Your last answer picked none of the answers, so the request still waits. The agent can read your words. '
        'In your own words, only "yes" allows once and only "no" rejects, and the name of an answer picks it.'
    ),
    'too_long': (
        'Verifold refused this request of the agent, because an ask cannot hold all of it, and you cannot allow '
        'what you cannot read. Nothing ran. This ask is for your information: an answer to it allows nothing.'
    ),
    'no_decline': (
        "The agent's harness offers no way to decline this request without stopping the agent's turn. So an answer "
        'that rejects it stops the turn.'
    ),
}
"""Verifold's sentence for each note, in the body that agents read. The app writes its own from the note."""
_TURN_ENDED = "This request ended with the agent's turn. An answer to it decides nothing."
_RESTARTED = 'Verifold restarted, so this request ended. An answer to it decides nothing.'
_NOT_USED = (
    'Verifold restarted before the agent asked for the same again, so your answer was not used. An answer to this '
    'ask decides nothing now.'
)
_COVERED = 'A grant now covers this command, so this request ended.'
_GRANTED = 'The grant is recorded.'
_USED = 'The agent asked for the same again, and your answer decided it.'
_REPLACED = 'Your answer picked none of the answers, so a new ask replaces this one.'
_EXPIRED = 'The agent did not ask for the same again within an hour, so your answer was not used.'
_SETTING = 'You changed the permission setting before the agent asked for the same again, so your answer was not used.'
_WAITS = (
    'Your settings changed, and an agent now waits for your answer. This request ended, and an answer to it decides '
    'nothing. The agent asks again if it still needs this.'
)

_IGNORABLE = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x2800, 0x2800),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0xFFFC, 0xFFFC),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)
"""
Unicode's Default_Ignorable_Code_Point set, which a renderer may show as nothing, the blank Braille cell, and the
object replacement character.
"""


def settled(board: Board, request: PermissionRequest) -> str | None:
    """
    Return the ID of the answer that needs no person, or `None` when the person decides.

    Verifold allows once a call to the lab's board and a command that a grant covers. It never picks an answer that
    the harness would remember, so nothing changes in the person's own harness settings.
    """
    allowed = next((choice.id for choice in request.choices if choice.kind == 'allow_once'), None)
    covered = request.command is not None and granted(board.grants, request.command)
    return allowed if request.board or covered else None


def refusal(request: PermissionRequest) -> str | None:
    """
    Return the ID of the answer that declines the request once and lets the agent's turn go on.

    `None` cancels the request, which stops the turn. So Verifold refuses a request by itself only when `declines`
    holds, or when nothing else is left: for an agent that left the lab, and for a request that no ask can show.
    """
    declined = _decline(request)
    return declined.id if declined else None


def _decline(request: PermissionRequest) -> PermissionChoice | None:
    # The first answer that says "no" for this once and whose ID does not say that the turn stops.
    return next(
        (
            choice
            for choice in request.choices
            if choice.kind == 'reject_once' and not _STOPS.search(choice.id.casefold())
        ),
        None,
    )


def declines(request: PermissionRequest) -> bool:
    """
    Return whether the harness offers an answer that declines the request once and lets the agent's turn go on.

    A harness can offer, as its only "no" for this once, an answer that stops the turn. ACP gives that answer the
    same kind as an ordinary "no", so Verifold goes by the answer's ID: `cancel`, `abort`, `interrupt`, or `stop`
    in it means that the turn stops. A "no" that the harness remembers is no answer for Verifold to pick. Without
    an answer to decline with, Verifold can only cancel the request, which stops the turn too.
    """
    return _decline(request) is not None


def grant_choice(prefix: str) -> str:
    """Return the answer that gives a grant, as the person reads it."""
    return f'Allow `{prefix}` for every agent'


def visible(text: str) -> str:
    """
    Return `text` with each character that a reader cannot see, or that changes how text reads, as its code point.

    Those are the control, format, and unassigned characters, every space but the plain one, and the characters
    that a renderer may show as nothing: a carriage return, a zero-width space, a mark that turns the reading
    direction, a variation selector, a filler. A line break and a tab stay. A `<` before `U+` or `u+` in the text is
    written as its code point too, so text cannot look like one of these. Letters that look like other letters stay.
    """
    marked = re.sub(r'<(?=[Uu]\+)', '<U+003C>', text)
    return ''.join(char if _shows(char) else f'<U+{ord(char):04X}>' for char in marked)


def _shows(char: str) -> bool:
    if char in '\n\t ':
        return True
    point = ord(char)
    return unicodedata.category(char)[0] not in 'CZ' and not any(low <= point <= high for low, high in _IGNORABLE)


def fenced(text: str) -> str:
    """Return `text` in a code fence that is longer than any run of backticks in it, so nothing in it ends the fence."""
    fence = '`' * max(3, max((len(run) for run in re.findall(r'`+', text)), default=0) + 1)
    return f'{fence}\n{text}\n{fence}'


def named(request: PermissionRequest) -> str:
    """
    Return what a headline calls the request, in Verifold's words only.

    A headline is read in the same type as Verifold's own words, so it holds no text of a harness or an agent. The
    ask shows the command or the input apart from it.
    """
    command = request.command
    if command is None:
        return f'a tool call ({request.kind})' if request.kind in _KINDS else 'a tool call'
    lines = command.count('\n') + 1
    return 'a shell command' if lines == 1 else f'a shell script of {lines} lines'


def _headline(name: str) -> str:
    return f'Permission needed: {name}'


@dataclass(frozen=True, slots=True)
class _Offer:
    """One answer to a request: its name on the board, and the harness's option, or `None` for the grant."""

    label: str
    choice: PermissionChoice | None


@dataclass(frozen=True, slots=True)
class _Shown:
    """A request as an ask: its body for agents, its data for the app, every answer, and the choices on the ask."""

    body: str
    data: PermissionShown
    offers: tuple[_Offer, ...]
    buttons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _Decision:
    """What the person's answer decides: the harness's option, or `None` to cancel, and whether it gives the grant."""

    option: str | None
    grant: bool = False


def _offers(request: PermissionRequest, prefix: str | None) -> tuple[_Offer, ...]:
    # A choice on the board is one short line. A longer name is cut for the choice, and the ask lists it whole.
    # No answer of the harness has the name of another, or of Verifold's own grant choice.
    offers: list[_Offer] = []
    taken = {grant_choice(prefix).casefold()} if prefix else set()
    for number, choice in enumerate(request.choices, start=1):
        name = ' '.join(visible(choice.name).split()) or f'Answer {number}'
        label = name if len(name) <= MAX_CHOICE else f'{name[: MAX_CHOICE - 1]}…'
        if label.casefold() in taken:
            label = f'{label[: MAX_CHOICE - 6]}… ({number})'
        taken.add(label.casefold())
        offers.append(_Offer(label, choice))
    return (*offers, _Offer(grant_choice(prefix), None)) if prefix else tuple(offers)


def _present(request: PermissionRequest, prefix: str | None, *notes: RequestNote) -> _Shown | None:
    """
    Return the request as an ask, or `None` when an ask cannot show all of it.

    `notes` are the facts that Verifold states about the request. In the body, which agents read, Verifold's
    sentences lead and the command, the input, and the harness's names stay in code fences below them.
    """
    offers = _offers(request, prefix)
    harness = [offer for offer in offers if offer.choice]
    notes = notes if declines(request) else (*notes, 'no_decline')
    grant = (grant_choice(prefix),) if prefix else ()
    buttons = (*(offer.label for offer in harness[: MAX_CHOICES - len(grant)]), *grant)
    listed = len(offers) > len(buttons) or any(offer.choice and offer.label != offer.choice.name for offer in harness)
    data = PermissionShown(
        kind=request.kind if request.kind in _KINDS else '',
        title='' if request.command else visible(request.title),
        command=visible(request.command) if request.command else None,
        given=visible(request.rest if request.command else request.given),
        answers=tuple(visible(offer.choice.name) for offer in harness if offer.choice) if listed else (),
        remembered=tuple(offer.label for offer in harness if offer.choice and offer.choice.kind not in _ONCE),
        grant=prefix,
        ids=tuple(offer.choice.id for offer in harness[: len(buttons) - len(grant)] if offer.choice),
        notes=notes,
    )
    parts = [_SAID[note] for note in notes]
    if data.command:
        parts += ['The command:', fenced(data.command)]
        if data.given:
            parts += ['What the request holds beside the command, as the harness reports it:', fenced(data.given)]
    else:
        parts += ["The harness's name for the request:", fenced(data.title)]
        if data.given:
            parts += ['The request, as the harness reports it:', fenced(data.given)]
    if data.answers:
        parts += ['The answers that the harness offers. To pick one that has no choice here, answer with its name:']
        parts += [fenced('\n'.join(data.answers))]
    if prefix:
        parts.append(
            f'With "{grant_choice(prefix)}", this command runs once, and every agent can run a command that starts '
            f'with `{prefix}` and has plain arguments. A grant names a command, not what a file holds: give it only '
            'for a command that the agents may change.'
        )
    if data.remembered:
        parts.append(
            "These answers are the harness's own. The harness remembers such an answer beyond this lab, and "
            'Verifold cannot show it or undo it later:'
        )
        parts.append(fenced('\n'.join(data.remembered)))
    body = '\n\n'.join(parts)
    # The room is counted without the notes, so a later ask about the same request, with a note, still fits.
    if len(body) - sum(len(_SAID[note]) + 2 for note in notes) + _ROOM > MAX_BODY:
        return None
    return _Shown(body, data, offers, buttons)


@dataclass(frozen=True, slots=True)
class _Reply:
    """The person's answer to an ask: the choice that they pressed, if any, and the words that they wrote."""

    choice: str | None
    words: str


def decide(reply: _Reply, offers: tuple[_Offer, ...], request: PermissionRequest) -> _Decision | None:
    """
    Return what the person's answer decides, or `None` when it decides nothing.

    A press on a choice picks that answer. Words pick an answer only when the whole of them is its name. Otherwise
    only the whole answer "yes", or a word like it, allows, and it allows once: it never picks an answer that the
    harness remembers, and it never gives a grant. Only the whole answer "no", or a word like it, rejects, with the
    answer that lets the agent's turn go on. One "." or "!" can end either. Any other words, such as "yes?", a
    question, or a name with more text after it, decide nothing.
    """
    picked = _name(reply.words if reply.choice is None else reply.choice)
    once = next((choice.id for choice in request.choices if choice.kind == 'allow_once'), None)
    # The names on the ask are all different. A whole name of the harness counts for words only, and only when it
    # is no other answer's name on the ask, such as the name of Verifold's grant.
    named_ = next((offer for offer in offers if picked == _name(offer.label)), None)
    if named_ is None and reply.choice is None and picked:
        whole = [offer for offer in offers if offer.choice and picked == _name(offer.choice.name)]
        named_ = whole[0] if len(whole) == 1 else None
    if named_:
        return _Decision(named_.choice.id) if named_.choice else _Decision(once, grant=True)
    said = '' if reply.choice else _said(reply.words)
    if said in _YES:
        return _Decision(once) if once else None
    declined = _decline(request)
    return _Decision(declined.id) if said in _NO and declined else None


def _name(text: str) -> str:
    return ' '.join(text.split()).casefold()


def _said(answer: str) -> str:
    """Return the person's whole answer, trimmed, in lower case, and without one closing "." or "!"."""
    whole = answer.replace('\u2019', "'").strip(' \t\r\n').casefold()
    return re.sub(r'[.!]$', '', whole)


async def ask_the_person(member: Member, request: PermissionRequest, over: asyncio.Event | None = None) -> str | None:
    """
    Post the request as an ask to the person, wait for the person's answer, and return the chosen option's ID.

    The ask goes in the agent's own "Permission requests" thread, with the harness's options as its choices. For a
    command that a grant can cover, one more choice gives the grant: it allows this command once and lets every agent
    run commands that start the same way. An answer that decides nothing leaves the request waiting, and a new ask
    says so. When `over` is set, the agent's turn ended: the ask ends, the request is cancelled, and a later answer
    decides nothing. A request that an ask cannot show whole is refused, and an ask says so.
    """
    prefix = _offered(request)
    notes: tuple[RequestNote, ...] = ()
    while True:
        shown = _present(request, prefix, *notes)
        if shown is None:
            await _tell_too_long(member, request)
            return refusal(request)
        asked = await _ask(member, _headline(named(request)), shown.buttons, shown.body, shown.data)
        answer = await _answer(member, asked, over)
        if answer is None:
            return None
        decision = decide(answer, shown.offers, request)
        if decision:
            break
        notes = ('unclear',)
    if decision.grant and prefix:
        await member.lab.grant(prefix)
    return decision.option


@dataclass(frozen=True, slots=True)
class _Open:
    """A refused request whose ask has no answer yet. `ask` is `None` while the ask is on its way."""

    ask: PostId | None
    member: Member
    request: PermissionRequest
    shown: _Shown


@dataclass(frozen=True, slots=True)
class _Kept:
    """The person's answer to a refused request: the option, when Verifold read it, and the ask that it answers."""

    option: str | None
    at: datetime
    ask: PostId


class Refusals:
    """
    The asks that stay open after Verifold refused a request at once, and what the person's answers to them give.

    When no agent waits for the person, the agent's harness gets a refusal and the ask stays in Needs you. It is the
    same ask as for a request that waits. The person's answer decides the same request of that agent once, when it
    comes again: the same agent, name, kind of tool, whole input, and answers. An answer with the grant records the
    grant, and Verifold ends the other open asks that the grant covers. Verifold drops an answer that the agent did
    not use within `ANSWER_LIFE`, and every answer when the person changes the permission setting. When the setting
    makes agents wait, the open asks end. Each of these ends shows as a reply on the ask. The asks live in this
    process: after a restart of Verifold, the asks from before wait for nobody, so Verifold ends them, and says so
    on an ask whose answer the agent had not used.
    """

    def __init__(self, lab: Lab) -> None:
        """Prepare to keep the asks of `lab`. The requests that the record still shows as waiting ended before."""
        self._lab = lab
        self._open: dict[str, _Open] = {}
        self._answers: dict[str, _Kept] = {}
        """The person's answer to a request, until that request comes again."""
        self._followed: PermissionSettings = lab.board.settings.permissions
        board = lab.board
        tracked = [entry.post for entry in board.posts if isinstance(entry.post, Ask) and entry.post.shown]
        self._stale = [
            (asked, _RESTARTED if waits_for_person(board, asked.id) else _NOT_USED)
            for asked in tracked
            if waits_for_person(board, asked.id) or _unused(board, asked)
        ]

    async def decide(self, member: Member, request: PermissionRequest) -> str | None:
        """
        Return the answer to a request for which the agent does not wait: the ID of an option, or `None` to cancel.

        When the person answered an earlier ask for the same request of this agent, that answer decides it, once.
        Otherwise the person gets an ask, and the request is refused.
        """
        key = _key(member, request)
        await self._forget()
        kept = self._answers.pop(key, None)
        if kept:
            await self._close(kept.ask, _USED)
            return kept.option
        if key not in self._open:
            shown = _present(request, _offered(request), 'refused')
            if shown is None:
                await _tell_too_long(member, request)
            else:
                await self._post(key, _Open(None, member, request, shown))
        return refusal(request)

    async def run(self) -> None:
        """
        Record what each answered ask gives, a grant or the answer to a request, until the caller cancels this.

        A failure here must not end the server that runs it, so it is logged and the next change is read.
        """
        for stale, why in self._stale:
            await _end(self._lab, stale, why)
        while True:
            board = self._lab.board
            try:
                await self._forget()
                await self._read(board)
            except Exception:
                logger.exception('Verifold could not read the answers to the requests that it refused.')
            await self._lab.wait_for_change(board.seq)

    async def _read(self, board: Board) -> None:
        if self._open and agent_waits(board):
            # Agents wait for the person now, so no agent comes back for an answer to these asks.
            ended, self._open = self._open, {}
            for entry in ended.values():
                if entry.ask:
                    await self._close(entry.ask, _WAITS)
            return
        for key in list(self._open):
            # An earlier answer of this pass can have ended this ask, as a grant ends the asks that it covers.
            entry = self._open.get(key)
            answer = _persons_answer(board, entry.ask) if entry and entry.ask else None
            if entry is None or entry.ask is None or answer is None:
                continue
            decision = decide(answer, entry.shown.offers, entry.request)
            prefix = _offered(entry.request)
            if decision is None:
                await self._close(entry.ask, _REPLACED)
                again = _present(entry.request, prefix, 'unclear', 'refused')
                await self._post(key, replace(entry, shown=again or entry.shown))
                continue
            self._open.pop(key, None)
            if decision.grant and prefix:
                await self._lab.grant(prefix)
                await self._close(entry.ask, _GRANTED)
                await self._end_covered()
            else:
                self._answers[key] = _Kept(decision.option, self._lab.now(), entry.ask)

    async def _post(self, key: str, entry: _Open) -> None:
        # The place is taken before the post, so that the same request at the same moment gets one ask.
        self._open[key] = replace(entry, ask=None)
        asked = None
        try:
            shown = entry.shown
            headline = _headline(named(entry.request))
            asked = await _ask(entry.member, headline, shown.buttons, shown.body, shown.data)
        finally:
            if asked is None:
                self._open.pop(key, None)
            else:
                self._open[key] = replace(entry, ask=asked)

    async def _end_covered(self) -> None:
        grants = self._lab.board.grants
        covered = [
            (key, entry.ask)
            for key, entry in self._open.items()
            if entry.ask and entry.request.command and granted(grants, entry.request.command)
        ]
        for key, asked in covered:
            self._open.pop(key, None)
            await self._close(asked, _COVERED)

    async def _close(self, ask_id: PostId, why: str) -> None:
        asked = self._lab.board.post(ask_id)
        if asked and isinstance(asked.post, Ask):
            await _end(self._lab, asked.post, why)

    async def _forget(self) -> None:
        followed = self._lab.board.settings.permissions
        dropped: list[tuple[_Kept, str]] = []
        if followed != self._followed:
            self._followed = followed
            dropped += [(kept, _SETTING) for kept in self._answers.values()]
            self._answers = {}
        if self._answers:
            now = self._lab.now()
            old = {key for key, kept in self._answers.items() if now - kept.at >= ANSWER_LIFE}
            dropped += [(self._answers.pop(key), _EXPIRED) for key in old]
        for kept, why in dropped:
            await self._close(kept.ask, why)


def _unused(board: Board, asked: Ask) -> bool:
    # A refused request whose ask the person answered, and that no reply of Verifold ended: the answer waited for
    # the agent's next try when Verifold stopped.
    refused = isinstance(asked.shown, PermissionShown) and 'refused' in asked.shown.notes
    replies = [entry.post for entry in board.replies(asked.id) if isinstance(entry.post, Answer)]
    return refused and not any(reply.ends_request for reply in replies)


async def ask_the_question(member: Member, question: Question, over: asyncio.Event | None = None) -> Answers | None:
    """
    Post a harness's question to its user as asks to the person, one for each field, and return the answers.

    A field with a few options offers them as choices, and a yes-or-no field offers "Yes" and "No". The person
    answers every other field in their own words, and can leave out a field that the harness does not need. An
    answer that does not fit its field ends the question without an answer, as a form that the user closes does.
    So does the end of the agent's turn, which sets `over`. The headline holds Verifold's words only, and the
    harness's text is data of its own on the ask, with its characters that a reader cannot see as code points.
    """
    answers: Answers = {}
    total = len(question.fields)
    message, cut = _cut(visible(question.message.strip()), MAX_BODY)
    for part, field in enumerate(question.fields, start=1):
        names = tuple(' '.join(visible(option.name).split()) for option in field.options)
        room = MAX_CHOICES - (not field.required)
        fits = len(names) <= room and all(0 < len(name) <= MAX_CHOICE for name in names)
        picks = field.kind == 'choice' and fits
        choices = ('Yes', 'No') if field.kind == 'boolean' else names if picks else ()
        title, cut_title = _cut(visible(field.title.strip()), MAX_BODY)
        description, cut_description = _cut(visible(field.description), MAX_BODY)
        data = QuestionShown(
            message=message,
            field=title,
            description=description,
            cut=cut or cut_title or cut_description,
            kind=field.kind,
            options=() if picks else names,
            optional=not field.required,
            part=part,
            parts=total,
        )
        headline = 'A question from the harness' + (f', part {part} of {total}' if total > 1 else '')
        skip = ('Skip',) if choices and not field.required else ()
        asked = await _ask(member, headline, (*choices, *skip), _question_body(data), data)
        answer = await _answer(member, asked, over)
        if answer is None:
            return None
        if not field.required and 'skip' in (_name(answer.choice or ''), _said(answer.words)):
            continue
        value = _value(field, answer, names)
        if value is None:
            return None
        answers[field.name] = value
    return answers


def _question_body(data: QuestionShown) -> str:
    """Return one field of a harness's question as text for the agents that read the board."""
    parts = ['The harness asks:', fenced(data.message)] if data.message else []
    parts += ['The field:', fenced(data.field)] if data.field else []
    parts += ['Its description:', fenced(data.description)] if data.description else []
    parts += ['The options:', fenced('\n'.join(data.options))] if data.options else []
    hint = {
        'choices': 'Name each option that you choose, with commas between them.',
        'number': 'Answer with a number.',
        'integer': 'Answer with a whole number.',
    }.get(data.kind)
    parts += [hint] if hint else []
    parts += ['The harness does not need this answer. To leave it out, answer "skip".'] if data.optional else []
    body = '\n\n'.join(parts)
    cut = 'Verifold cut this text, because an ask cannot hold all of it.\n\n'
    return body if len(body) <= MAX_BODY and not data.cut else _cut(f'{cut}{body}', MAX_BODY)[0]


def _cut(text: str, limit: int) -> tuple[str, bool]:
    """Return `text` cut to `limit` characters, never inside a code point that `visible` wrote, and whether it cut."""
    if len(text) <= limit:
        return text, False
    return re.sub(r'<(U(\+[0-9A-F]{0,6})?)?$', '', text[:limit]), True


def _value(field: QuestionField, reply: _Reply, names: tuple[str, ...]) -> FieldValue | None:
    """Return the person's answer as the field's kind of value, or `None` when the answer does not fit the field."""
    words = reply.words
    headline = words.split('\n', 1)[0].strip()
    said = _said(reply.choice or words)
    value: FieldValue | None
    match field.kind:
        case 'text':
            value = words.strip()
        case 'boolean':
            value = False if said in _NO else True if said in _YES else None
        case 'integer' | 'number':
            try:
                value = int(headline) if field.kind == 'integer' else float(headline)
            except ValueError:
                value = None
            # "nan" and "inf" are no numbers that a harness can use.
            if isinstance(value, float) and not math.isfinite(value):
                value = None
        case 'choice':
            # A press on a choice, or words that are an option's whole name.
            value = _option(field, reply.choice or words, names)
        case _:
            picked = [_option(field, part, names) for part in re.split(r'[,\n]', words) if part.strip()]
            value = None if None in picked else [name for name in picked if name is not None]
    return value


def _option(field: QuestionField, picked: str, names: tuple[str, ...]) -> str | None:
    # `names` are the options' names as the ask shows them, in the order of the options.
    wanted = ' '.join(picked.split()).casefold()
    return next(
        (
            option.value
            for option, name in zip(field.options, names, strict=True)
            if wanted and wanted in (name.casefold(), option.value.casefold())
        ),
        None,
    )


def _key(member: Member, request: PermissionRequest) -> str:
    # The whole request, so that two requests that differ anywhere never share an answer.
    parts = [member.agent_id, request.title, request.kind, request.command, request.given]
    answers = [[choice.id, choice.kind] for choice in request.choices]
    return hashlib.sha256(json.dumps([parts, answers]).encode()).hexdigest()


def _offered(request: PermissionRequest) -> str | None:
    # A grant is answered with "allow once", so a request without that answer gets no offer. Nor does a command
    # whose first word is too long for a choice.
    once = any(choice.kind == 'allow_once' for choice in request.choices)
    prefix = grantable(request.command) if request.command and once else None
    return prefix if prefix and len(grant_choice(prefix)) <= MAX_CHOICE else None


async def _tell_too_long(member: Member, request: PermissionRequest) -> None:
    """Tell the person that Verifold refused a request that an ask cannot show whole. The ask offers no allow."""
    whole = request.command or request.given or request.title
    # The start is cut after its hidden characters are written out, so the ask always has room for it.
    start = _cut(visible(whole[:_START]), _START)[0]
    data = PermissionShown(
        kind=request.kind if request.kind in _KINDS else '',
        command=start if request.command else None,
        given='' if request.command else start,
        notes=('too_long',) if declines(request) else ('too_long', 'no_decline'),
        size=len(whole),
    )
    stopped = '' if declines(request) else f' {_SAID["no_decline"]} So this refusal stopped the turn.'
    body = (
        f'{_SAID["too_long"]}{stopped} It has {len(whole):,} characters. It starts with:\n\n{fenced(start)}\n\n'
        'The rest is cut.'
    )
    board = member.lab.board
    told = any(
        isinstance(entry.post, Ask)
        and (entry.post.author, entry.post.shown) == (member.agent_id, data)
        and waits_for_person(board, entry.post.id)
        for entry in board.posts
    )
    if not told:
        await _ask(member, 'Refused: a request that is too long to show', ('OK',), body, data)


async def _ask(
    member: Member, text: str, choices: tuple[str, ...], body: str, shown: PermissionShown | QuestionShown
) -> PostId:
    """Post an ask to the person in the agent's name, marked as the carrier of a request of the agent's harness."""
    about = 'Permission requests' if shown.type == 'permission' else 'Questions'
    thread = _own_thread(member, shown.type, about)
    request = PostRequest(
        kind='ask',
        text=text,
        body=body,
        choices=choices,
        mentions=(PERSON,),
        thread=thread,
        new_thread=None if thread else _thread_title(member, about),
    )
    return (await member.lab.post(request, member.agent_id, mark=shown)).post.id


async def _end(lab: Lab, asked: Ask, why: str) -> None:
    """Record that a request ended, so its ask waits for nobody and says why."""
    request = PostRequest(kind='answer', text=why, thread=asked.thread, reply_to=asked.id)
    # The board takes no post from an agent that left. Its asks wait for nobody already.
    with suppress(RejectedEvent):
        await lab.post(request, asked.author, mark='ends_request')


def _thread_title(member: Member, about: str) -> str:
    joined = member.lab.board.agent(member.agent_id)
    return f'{about} from {joined.agent.name if joined else member.agent_id}'


def _own_thread(member: Member, carries: Carries, about: str) -> str | None:
    """
    Return the agent's thread for one kind of request, or `None` when it has none yet.

    It is the thread that the record marks as that. A record from before the mark has the thread by its title,
    with one of the names that the agent has or had. So an agent whose name changed keeps one thread, and an
    agent's own thread with a like title, such as "Questions from the rerun", gets no tracked ask.
    """
    board = member.lab.board
    names = (*(name for agent, name in board.names() if agent == member.agent_id), member.agent_id)
    titles = {f'{about} from {name}' for name in names}
    own = tuple(entry.thread for entry in board.threads if entry.thread.opened_by == member.agent_id)
    marked = next((thread.id for thread in own if thread.carries == carries), None)
    return marked or next((thread.id for thread in own if thread.carries is None and thread.title in titles), None)


async def _answer(member: Member, ask_id: PostId, over: asyncio.Event | None) -> _Reply | None:
    """
    Return the person's answer to an ask, or `None` when the agent's turn ended first.

    Then the ask is ended on the board, and nothing reads an answer that comes later. The end of the turn wins
    over an answer that arrives at the same moment.
    """
    lab = member.lab
    over = over or asyncio.Event()
    waiting = asyncio.ensure_future(_persons(lab, ask_id))
    ended = asyncio.ensure_future(over.wait())
    try:
        await asyncio.wait({waiting, ended}, return_when=asyncio.FIRST_COMPLETED)
        if waiting.done() and not over.is_set():
            return waiting.result()
        asked = lab.board.post(ask_id)
        if asked and isinstance(asked.post, Ask):
            await _end(lab, asked.post, _TURN_ENDED)
        return None
    finally:
        waiting.cancel()
        ended.cancel()


async def _persons(lab: Lab, ask_id: PostId) -> _Reply:
    while True:
        answer = _persons_answer(lab.board, ask_id)
        if answer is not None:
            return answer
        await lab.wait_for_change(lab.board.seq)


def _persons_answer(board: Board, ask_id: PostId) -> _Reply | None:
    # With a pressed choice, the person's own words are the body. Without one, the whole answer is their words.
    answer = next(
        (
            entry.post
            for entry in board.replies(ask_id)
            if isinstance(entry.post, Answer) and entry.post.author == PERSON
        ),
        None,
    )
    if answer is None:
        return None
    return _Reply(answer.choice, answer.body if answer.choice else f'{answer.text}\n{answer.body}')
