"""
Permission requests and questions of the agents' harnesses, and who decides them.

Verifold allows a call to the lab's own board, and a command that a grant of the person covers. Every other request
goes to the person on the board, with the harness's own answers. The person's setting says what the harness gets
until the person answers. Either the request waits, as it does in a harness that the person runs by hand, or
Verifold refuses it at once and the answer applies when the agent asks for the same again.

The person allows only what the ask shows. So an ask shows the whole command or input, with each character that a
reader cannot see written as its code point, inside a code fence that keeps a renderer from changing it. A request
that an ask cannot hold whole is refused. Verifold's own sentences stay outside the fence.
"""

import asyncio
import hashlib
import json
import math
import re
import unicodedata
from contextlib import suppress
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from verifold.protocol.grants import plain
from verifold.protocol.ids import PERSON, PostId
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_BODY, MAX_CHOICE, MAX_CHOICES, MAX_HEADLINE, Answer, Ask, HarnessRequest
from verifold.protocol.settings import PermissionSettings
from verifold.runner.session import Answers, FieldValue, PermissionChoice, PermissionRequest, Question, QuestionField
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.grants import grantable, granted
from verifold.society.standing import waits_for_person

_YES = frozenset(
    {'allow', 'allow it', 'allow once', 'approve', 'approved', 'go ahead', 'ok', 'okay', 'sure', 'y', 'yes'}
    | {'yes please', 'yes allow', 'yes allow it', 'yes allow once', 'yes go ahead'}
)
"""The answers in the person's own words that allow once. The whole answer must be one of them."""
_NO = frozenset({'cancel', 'deny', "don't", 'dont', 'n', 'never', 'no', 'nope', 'refuse', 'reject', 'stop'})
"""The first words of an answer in the person's own words that reject."""
_WORDS = re.compile(r"[a-z]+(?:'[a-z]+)?")
_ONCE = frozenset({'allow_once', 'reject_once'})

ANSWER_LIFE = timedelta(hours=1)
"""How long the person's answer to a refused request waits for the agent's next try of that request."""

_ROOM = 1_000
"""The characters of an ask's body that stay free for Verifold's own sentences in a later ask about the request."""
_START = 2_000
"""How much of a request that is too long to show an ask still shows, with no answer that allows."""

_REFUSED = (
    'Verifold refused this at once, as your settings say, so the agent goes on. Your answer applies when the agent '
    'asks for the same again within an hour.'
)
_UNCLEAR = (
    'Your last answer picked none of the answers, so the request still waits. The agent can read your words. In '
    'your own words, "yes" allows once, "no" rejects, and the name of an answer picks that answer.'
)
_TURN_ENDED = "This request ended with the agent's turn. An answer to it decides nothing."
_RESTARTED = 'Verifold restarted, so this request ended. An answer to it decides nothing.'
_COVERED = 'A grant now covers this command, so this request ended.'
_TOO_LONG = 'Refused: a request that is too long to show'


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
    """Return the ID of the answer that refuses the request once, or `None`, which cancels it."""
    return next((choice.id for choice in request.choices if choice.kind == 'reject_once'), None)


def grant_choice(prefix: str) -> str:
    """Return the answer that gives a grant, as the person reads it."""
    return f'Allow `{prefix}` for every agent'


def visible(text: str) -> str:
    """
    Return `text` with each character that a reader cannot see, or that changes how text reads, as its code point.

    Those are the control, format, and unassigned characters, and every space but the plain one: a carriage
    return, a zero-width space, a mark that turns the reading direction. A line break and a tab stay.
    """
    return ''.join(
        char if char in '\n\t ' or unicodedata.category(char)[0] not in 'CZ' else f'<U+{ord(char):04X}>'
        for char in text
    )


def fenced(text: str) -> str:
    """Return `text` in a code fence that is longer than any run of backticks in it, so nothing in it ends the fence."""
    fence = '`' * max(3, max((len(run) for run in re.findall(r'`+', text)), default=0) + 1)
    return f'{fence}\n{text}\n{fence}'


def named(request: PermissionRequest) -> str:
    """
    Return what a headline calls the request, in one line that cannot mislead.

    A plain command that fits is its own name. Any other command is named by its size, and the ask's body shows it.
    A request without a command has the harness's name for it, in one line.
    """
    command = request.command
    if command is None:
        return ' '.join(visible(request.title).split()) or 'an action'
    if plain(command) and len(command) <= MAX_HEADLINE - len(_headline('')):
        return command
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
    """A request as an ask: its headline, its body, every answer, and the answers that the ask has room to offer."""

    headline: str
    body: str
    offers: tuple[_Offer, ...]
    buttons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _Decision:
    """What the person's answer decides: the harness's option, or `None` to cancel, and whether it gives the grant."""

    option: str | None
    grant: bool = False


def _offers(request: PermissionRequest, prefix: str | None) -> tuple[_Offer, ...]:
    # A choice on the board is one short line. A longer name is cut for the choice, and the body lists it whole.
    offers: list[_Offer] = []
    for number, choice in enumerate(request.choices, start=1):
        name = ' '.join(visible(choice.name).split()) or f'Answer {number}'
        label = name if len(name) <= MAX_CHOICE else f'{name[: MAX_CHOICE - 1]}…'
        if any(label.casefold() == offer.label.casefold() for offer in offers):
            label = f'{label[: MAX_CHOICE - 6]}… ({number})'
        offers.append(_Offer(label, choice))
    return (*offers, _Offer(grant_choice(prefix), None)) if prefix else tuple(offers)


def _present(request: PermissionRequest, prefix: str | None, *notes: str) -> _Shown | None:
    """
    Return the request as an ask, or `None` when an ask cannot show all of it.

    `notes` are Verifold's own sentences, which lead the body. The command, the input, and the harness's names stay
    in code fences below them.
    """
    offers = _offers(request, prefix)
    harness = [offer for offer in offers if offer.choice]
    grant = (grant_choice(prefix),) if prefix else ()
    buttons = (*(offer.label for offer in harness[: MAX_CHOICES - len(grant)]), *grant)
    name = named(request)
    parts: list[str] = []
    if request.command:
        parts += ['The command:', fenced(visible(request.command))]
        if request.rest:
            parts += ['What the request holds beside the command, as the harness reports it:']
            parts += [fenced(visible(request.rest))]
    else:
        if len(_headline(name)) > MAX_HEADLINE or name != request.title:
            parts += ["The harness's name for the request:", fenced(visible(request.title))]
        if request.given:
            parts += ['The request, as the harness reports it:', fenced(visible(request.given))]
    if len(offers) > len(buttons) or any(offer.choice and offer.label != offer.choice.name for offer in harness):
        parts += ['The answers that the harness offers. To pick one that has no choice here, answer with its name:']
        parts += [fenced('\n'.join(visible(offer.choice.name) for offer in harness if offer.choice))]
    if prefix:
        parts.append(
            f'With "{grant_choice(prefix)}", this command runs once, and every agent can run a command that starts '
            f'with `{prefix}` and has plain arguments. A grant names a command, not what a file holds: give it only '
            'for a command that the agents may change.'
        )
    own = [f'"{offer.label}"' for offer in harness if offer.choice and offer.choice.kind not in _ONCE]
    if own:
        parts.append(
            f"The harness's own: {', '.join(own)}. The harness remembers such an answer beyond this lab, and "
            'Verifold cannot show it or undo it later.'
        )
    body = '\n\n'.join(parts)
    if len(body) + _ROOM > MAX_BODY:
        return None
    headline = _headline(name)
    cut = headline if len(headline) <= MAX_HEADLINE else f'{headline[: MAX_HEADLINE - 1]}…'
    return _Shown(cut, '\n\n'.join((*notes, body)).strip(), offers, buttons)


def decide(answer: str, offers: tuple[_Offer, ...], request: PermissionRequest) -> _Decision | None:
    """
    Return what the person's answer decides, or `None` when it decides nothing.

    An answer whose first line is the name of an answer picks that answer, as a choice in the app does. In the
    person's own words, only a whole answer such as "yes" allows, and it allows once: it never picks an answer that
    the harness remembers, and it never gives a grant. An answer that starts with a word such as "no" rejects. Any
    other answer, such as a question, decides nothing.
    """
    headline = ' '.join(answer.split('\n', 1)[0].split()).casefold()
    once = next((choice.id for choice in request.choices if choice.kind == 'allow_once'), None)
    for offer in offers:
        names = {offer.label.casefold(), ' '.join(offer.choice.name.split()).casefold() if offer.choice else ''}
        if headline in names:
            return _Decision(offer.choice.id) if offer.choice else _Decision(once, grant=True)
    words = _words(answer)
    if ' '.join(words) in _YES:
        return _Decision(once) if once else None
    if words[:1] and (words[0] in _NO or words[:2] == ('do', 'not')):
        return _Decision(refusal(request))
    return None


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
    notes: tuple[str, ...] = ()
    while True:
        shown = _present(request, prefix, *notes)
        if shown is None:
            await _tell_too_long(member, request)
            return refusal(request)
        asked = await _ask(member, shown.headline, shown.buttons, shown.body, 'permission')
        answer = await _answer(member, asked, over)
        if answer is None:
            return None
        decision = decide(answer, shown.offers, request)
        if decision:
            break
        notes = (_UNCLEAR,)
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


class Refusals:
    """
    The asks that stay open after Verifold refused a request at once, and what the person's answers to them give.

    When no agent waits for the person, the agent's harness gets a refusal and the ask stays in Needs you. It is the
    same ask as for a request that waits. The person's answer decides the same request of that agent once, when it
    comes again: the same agent, name, kind of tool, whole input, and answers. An answer with the grant records the
    grant, and Verifold ends the other open asks that the grant covers. Verifold drops an answer that the agent did
    not use within `ANSWER_LIFE`, and every answer when the person changes the permission setting. The asks live in
    this process: after a restart of Verifold, the asks from before wait for nobody, so Verifold ends them.
    """

    def __init__(self, lab: Lab) -> None:
        """Prepare to keep the asks of `lab`. The requests that the record still shows as waiting ended before."""
        self._lab = lab
        self._open: dict[str, _Open] = {}
        self._answers: dict[str, tuple[str | None, datetime]] = {}
        """The person's answer to a request, and when Verifold read it, until that request comes again."""
        self._followed: PermissionSettings = lab.board.settings.permissions
        board = lab.board
        self._stale = [
            entry.post
            for entry in board.posts
            if isinstance(entry.post, Ask) and entry.post.request and waits_for_person(board, entry.post.id)
        ]

    async def decide(self, member: Member, request: PermissionRequest) -> str | None:
        """
        Return the answer to a request for which the agent does not wait: the ID of an option, or `None` to cancel.

        When the person answered an earlier ask for the same request of this agent, that answer decides it, once.
        Otherwise the person gets an ask, and the request is refused.
        """
        key = _key(member, request)
        self._forget()
        if key in self._answers:
            return self._answers.pop(key)[0]
        if key not in self._open:
            shown = _present(request, _offered(request), _REFUSED)
            if shown is None:
                await _tell_too_long(member, request)
            else:
                await self._post(key, _Open(None, member, request, shown))
        return refusal(request)

    async def run(self) -> None:
        """Record what each answered ask gives, a grant or the answer to a request, until the caller cancels this."""
        for stale in self._stale:
            await _end(self._lab, stale, _RESTARTED)
        while True:
            board = self._lab.board
            self._forget()
            for key, entry in list(self._open.items()):
                answer = _persons_answer(board, entry.ask) if entry.ask else None
                if answer is None:
                    continue
                decision = decide(answer, entry.shown.offers, entry.request)
                prefix = _offered(entry.request)
                if decision is None:
                    again = _present(entry.request, prefix, _UNCLEAR, _REFUSED)
                    await self._post(key, replace(entry, shown=again or entry.shown))
                    continue
                del self._open[key]
                if decision.grant and prefix:
                    await self._lab.grant(prefix)
                    await self._end_covered()
                else:
                    self._answers[key] = (decision.option, self._lab.now())
            await self._lab.wait_for_change(board.seq)

    async def _post(self, key: str, entry: _Open) -> None:
        # The place is taken before the post, so that the same request at the same moment gets one ask.
        self._open[key] = replace(entry, ask=None)
        asked = None
        try:
            shown = entry.shown
            asked = await _ask(entry.member, shown.headline, shown.buttons, shown.body, 'permission')
        finally:
            if asked is None:
                del self._open[key]
            else:
                self._open[key] = replace(entry, ask=asked)

    async def _end_covered(self) -> None:
        board = self._lab.board
        covered = [
            (key, entry)
            for key, entry in self._open.items()
            if entry.ask and entry.request.command and granted(board.grants, entry.request.command)
        ]
        for key, entry in covered:
            del self._open[key]
            asked = board.post(entry.ask) if entry.ask else None
            if asked and isinstance(asked.post, Ask):
                await _end(self._lab, asked.post, _COVERED)

    def _forget(self) -> None:
        followed = self._lab.board.settings.permissions
        if followed != self._followed:
            self._followed = followed
            self._answers.clear()
        if self._answers:
            now = self._lab.now()
            self._answers = {key: kept for key, kept in self._answers.items() if now - kept[1] < ANSWER_LIFE}


async def ask_the_question(member: Member, question: Question, over: asyncio.Event | None = None) -> Answers | None:
    """
    Post a harness's question to its user as asks to the person, one for each field, and return the answers.

    A field with a few options offers them as choices, and a yes-or-no field offers "Yes" and "No". The person
    answers every other field in their own words, and can leave out a field that the harness does not need. An
    answer that does not fit its field ends the question without an answer, as a form that the user closes does.
    So does the end of the agent's turn, which sets `over`.
    """
    answers: Answers = {}
    for field in question.fields:
        names = tuple(' '.join(option.name.split()) for option in field.options)
        room = MAX_CHOICES - (not field.required)
        fits = len(names) <= room and all(0 < len(name) <= MAX_CHOICE for name in names)
        picks = field.kind == 'choice' and fits
        choices = ('Yes', 'No') if field.kind == 'boolean' else names if picks else ()
        message = question.message.strip()
        alone = len(question.fields) == 1 and message
        headline = ': '.join(part for part in (message, '' if alone else field.title.strip()) if part)
        hints = (
            question.message if len(headline) > MAX_HEADLINE else '',
            field.description,
            '' if picks or not names else f'The options: {", ".join(names)}.',
            {
                'choices': 'Name each option that you choose, with commas between them.',
                'number': 'Answer with a number.',
                'integer': 'Answer with a whole number.',
            }.get(field.kind, ''),
            '' if field.required else 'The harness does not need this answer. To leave it out, answer "skip".',
        )
        body = '\n\n'.join(hint for hint in hints if hint)
        if len(body) > MAX_BODY:
            body = f'Verifold cut this text, because an ask cannot hold all of it.\n\n{body}'[:MAX_BODY]
        skip = ('Skip',) if choices and not field.required else ()
        asked = await _ask(member, headline or 'A question', (*choices, *skip), body, 'question')
        answer = await _answer(member, asked, over)
        if answer is None:
            return None
        if not field.required and _words(answer) == ('skip',):
            continue
        value = _value(field, answer)
        if value is None:
            return None
        answers[field.name] = value
    return answers


def _value(field: QuestionField, answer: str) -> FieldValue | None:
    """Return the person's answer as the field's kind of value, or `None` when the answer does not fit the field."""
    headline = answer.split('\n', 1)[0].strip()
    words = _words(answer)
    value: FieldValue | None
    match field.kind:
        case 'text':
            value = answer.strip()
        case 'boolean':
            value = False if words[:1] and words[0] in _NO else True if ' '.join(words) in _YES else None
        case 'integer' | 'number':
            try:
                value = int(headline) if field.kind == 'integer' else float(headline)
            except ValueError:
                value = None
            # "nan" and "inf" are no numbers that a harness can use.
            if isinstance(value, float) and not math.isfinite(value):
                value = None
        case 'choice':
            value = _option(field, headline)
        case _:
            picked = [_option(field, part) for part in re.split(r'[,\n]', answer) if part.strip()]
            value = None if None in picked else [name for name in picked if name is not None]
    return value


def _option(field: QuestionField, picked: str) -> str | None:
    wanted = ' '.join(picked.split()).casefold()
    return next(
        (
            option.value
            for option in field.options
            if wanted in (' '.join(option.name.split()).casefold(), option.value.casefold())
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
    body = (
        'Verifold refused this request of the agent, because an ask cannot hold all of it, and you cannot allow what '
        f'you cannot read. Nothing ran. It has {len(whole):,} characters. It starts with:\n\n'
        f'{fenced(visible(whole[:_START]))}\n\nThe rest is cut. This ask is for your information: an answer to it '
        'allows nothing.'
    )
    board = member.lab.board
    told = any(
        isinstance(entry.post, Ask)
        and entry.post.request
        and (entry.post.author, entry.post.text, entry.post.body) == (member.agent_id, _TOO_LONG, body)
        and waits_for_person(board, entry.post.id)
        for entry in board.posts
    )
    if not told:
        await _ask(member, _TOO_LONG, ('OK',), body, 'permission')


async def _ask(member: Member, text: str, choices: tuple[str, ...], body: str, mark: HarnessRequest) -> PostId:
    """Post an ask to the person in the agent's name, marked as the carrier of a request of the agent's harness."""
    title = _thread_title(member, 'Permission requests' if mark == 'permission' else 'Questions')
    thread = _own_thread(member, title)
    request = PostRequest(
        kind='ask',
        text=' '.join(text.split())[:MAX_HEADLINE],
        body=body,
        choices=choices,
        mentions=(PERSON,),
        thread=thread,
        new_thread=None if thread else title,
    )
    return (await member.lab.post(request, member.agent_id, mark=mark)).post.id


async def _end(lab: Lab, asked: Ask, why: str) -> None:
    """Record that a request ended without the person's answer, so its ask leaves Needs you and says why."""
    request = PostRequest(kind='answer', text=why, thread=asked.thread, reply_to=asked.id)
    # The board takes no post from an agent that left. Its asks wait for nobody already.
    with suppress(RejectedEvent):
        await lab.post(request, asked.author, mark='ends_request')


def _words(text: str) -> tuple[str, ...]:
    return tuple(_WORDS.findall(text.casefold().replace('\u2019', "'")))


def _thread_title(member: Member, about: str) -> str:
    joined = member.lab.board.agent(member.agent_id)
    return f'{about} from {joined.agent.name if joined else member.agent_id}'


def _own_thread(member: Member, title: str) -> str | None:
    return next(
        (
            entry.thread.id
            for entry in member.lab.board.threads
            if entry.thread.opened_by == member.agent_id and entry.thread.title == title
        ),
        None,
    )


async def _answer(member: Member, ask_id: PostId, over: asyncio.Event | None) -> str | None:
    """
    Return the person's answer to an ask, or `None` when the agent's turn ended first.

    Then the ask is ended on the board, and nothing reads an answer that comes later.
    """
    lab = member.lab
    waiting = asyncio.ensure_future(_persons(lab, ask_id))
    ended = asyncio.ensure_future((over or asyncio.Event()).wait())
    try:
        await asyncio.wait({waiting, ended}, return_when=asyncio.FIRST_COMPLETED)
        if waiting.done():
            return waiting.result()
        asked = lab.board.post(ask_id)
        if asked and isinstance(asked.post, Ask):
            await _end(lab, asked.post, _TURN_ENDED)
        return None
    finally:
        waiting.cancel()
        ended.cancel()


async def _persons(lab: Lab, ask_id: PostId) -> str:
    while True:
        answer = _persons_answer(lab.board, ask_id)
        if answer is not None:
            return answer
        await lab.wait_for_change(lab.board.seq)


def _persons_answer(board: Board, ask_id: PostId) -> str | None:
    # The whole answer counts: a picked option leads the text, and the person's own words can follow in the body.
    return next(
        (
            f'{entry.post.text}\n{entry.post.body}'
            for entry in board.replies(ask_id)
            if isinstance(entry.post, Answer) and entry.post.author == PERSON
        ),
        None,
    )
