"""
Permission requests and questions of the agents' harnesses, and who decides them.

Verifold allows a call to the lab's own board, and a command that a grant of the person covers. Every other request
goes to the person on the board, with the harness's own answers. The person's setting says what the harness gets
until the person answers. Either the request waits, as it does in a harness that the person runs by hand, or
Verifold refuses it at once and the answer applies when the agent asks for the same again.
"""

import re

from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_CHOICE, MAX_CHOICES, MAX_HEADLINE, Answer
from verifold.runner.session import Answers, FieldValue, PermissionChoice, PermissionRequest, Question, QuestionField
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board
from verifold.society.grants import grantable, granted

_POSITIVE = frozenset({'allow', 'approve', 'go', 'ok', 'okay', 'sure', 'yes'})
_NEGATIVE = frozenset({'cancel', 'deny', "don't", 'dont', 'never', 'no', 'not', 'refuse', 'reject', 'stop'})
_WORDS = re.compile(r"[a-z]+(?:'[a-z]+)?")


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


async def ask_the_person(member: Member, request: PermissionRequest) -> str | None:
    """
    Post the request as an ask to the person, wait for the person's answer, and return the chosen option's ID.

    The ask goes in the agent's own "Permission requests" thread, with the harness's options as its choices. For a
    command, one more choice gives a grant: it allows this command once and lets every agent run commands that start
    the same way. The person can pick an option or answer in their own words. An answer that matches no option
    rejects the action.
    """
    prefix = _offered(request)
    names = tuple(choice.name for choice in request.choices)
    choices = (*names, grant_choice(prefix)) if prefix else names
    asked = await _ask(member, _headline(request), choices, _input(request))
    answer = await _answer(member, asked)
    if prefix and _gives(answer, prefix, any_yes=False):
        await member.lab.grant(prefix)
        # The grant covers this command, and the person's answer allows it now.
        return next(choice.id for choice in request.choices if choice.kind == 'allow_once')
    return choose(answer, request.choices)


type _Key = str | tuple[AgentId, str, str]
"""What an open ask is about: the start of a command, for a grant, or one agent's request by its title and input."""


class Refusals:
    """
    The asks that stay open after Verifold refused a request at once, and what the person's answers to them give.

    The person can choose that no agent waits for them. The agent's harness then gets a refusal, and the ask stays in
    Needs you. For a command that a grant can cover, the ask offers the grant, and with it the next such command
    passes, for every agent. For every other request, the ask has the harness's own answers, and the person's
    answer decides the same request of that agent once, when it comes again. The asks live in this process: after a
    restart of Verifold, an answer to an ask from before gives nothing, and the next refusal asks again.
    """

    def __init__(self, lab: Lab) -> None:
        """Prepare to keep the asks of `lab`."""
        self._lab = lab
        self._open: dict[_Key, PostId | None] = {}
        """The ask for each key that has no answer yet. `None` holds the place of an ask that is on its way."""
        self._declined: set[str] = set()
        """The grants that the person said no to. Verifold doesn't offer them again."""
        self._answers: dict[_Key, str] = {}
        """The person's answer to one agent's request, until that request comes again."""

    async def decide(self, member: Member, request: PermissionRequest) -> str | None:
        """
        Return the answer to a request for which the agent does not wait: the ID of an option, or `None` to cancel.

        When the person answered an earlier ask for the same request of this agent, that answer decides it, once.
        Otherwise the person gets an ask, and the request is refused.
        """
        answer = None if self._grant(request) else self._answers.pop(_one(member, request), None)
        if answer is not None:
            return choose(answer, request.choices)
        await self.offer(member, request)
        return refusal(request)

    async def offer(self, member: Member, request: PermissionRequest) -> None:
        """
        Ask the person about a request that Verifold refused.

        A command that a grant can cover gets an ask for the grant, unless the person said no to that grant. Every
        other request gets an ask with the harness's own answers. It asks nothing while such an ask is open.
        """
        prefix = self._grant(request)
        key = prefix or _one(member, request)
        if key in self._open:
            return
        if prefix:
            headline, choices = f'Refused without a grant: {request.title}', (grant_choice(prefix), 'No')
            body = (
                f'Verifold refused this command at once, as your settings say:\n\n'
                f'{(request.command or "")[:MAX_SHOWN]}'
                f'\n\nWith the grant, every agent can run a command that starts with `{prefix}` and has plain '
                'arguments. A grant names a command, not what a file holds: give it only for a command that the '
                'agents may change.'
            )
        else:
            headline, choices = _headline(request), tuple(choice.name for choice in request.choices)
            shown = _input(request)
            body = (
                f'{shown}\n\n' if shown else ''
            ) + 'Verifold refused this at once, as your settings say. Your answer applies when the agent asks again.'
        # The place is taken before the post, so that agents that are refused at the same moment share one ask.
        self._open[key] = None
        asked = None
        try:
            asked = await _ask(member, headline, choices, body)
        finally:
            if asked is None:
                del self._open[key]
            else:
                self._open[key] = asked

    def _grant(self, request: PermissionRequest) -> str | None:
        # After the person's no to a grant, a command that it would cover is asked as that one command.
        prefix = _offered(request)
        return None if prefix in self._declined else prefix

    async def run(self) -> None:
        """Record what each answered ask gives, a grant or the answer to a request, until the caller cancels this."""
        while True:
            board = self._lab.board
            answered = [
                (key, answer)
                for key, ask_id in self._open.items()
                if ask_id and (answer := _persons_answer(board, ask_id)) is not None
            ]
            for key, answer in answered:
                if not isinstance(key, str):
                    self._answers[key] = answer
                # The ask offers nothing but the grant, so a plain yes gives it.
                elif _gives(answer, key, any_yes=True):
                    await self._lab.grant(key)
                elif _NEGATIVE.intersection(_words(answer)):
                    self._declined.add(key)
                # The place stays taken until the grant is on the board, so that no refusal asks in between.
                del self._open[key]
            await self._lab.wait_for_change(board.seq)


async def ask_the_question(member: Member, question: Question) -> Answers | None:
    """
    Post a harness's question to its user as asks to the person, one for each field, and return the answers.

    A field with a few options offers them as choices, and a yes-or-no field offers "Yes" and "No". The person
    answers every other field in their own words. An answer that does not fit its field ends the question without
    an answer, as a form that the user closes does.
    """
    answers: Answers = {}
    for field in question.fields:
        names = tuple(option.name.strip() for option in field.options)
        fits = len(names) <= MAX_CHOICES and all(0 < len(name) <= MAX_CHOICE for name in names)
        picks = field.kind == 'choice' and fits
        choices = ('Yes', 'No') if field.kind == 'boolean' else names if picks else ()
        alone = len(question.fields) == 1 and question.message
        headline = question.message if alone else f'{question.message}: {field.title}'.removeprefix(': ')
        hints = (
            question.message if len(headline) > MAX_HEADLINE else '',
            field.description,
            '' if picks or not names else f'The options: {", ".join(names)}.',
            {
                'choices': 'Name each option that you choose, with commas between them.',
                'number': 'Answer with a number.',
                'integer': 'Answer with a whole number.',
            }.get(field.kind, ''),
        )
        body = '\n\n'.join(hint for hint in hints if hint)
        asked = await _ask(member, headline, choices, body, 'Questions')
        value = _value(field, await _answer(member, asked))
        if value is None:
            return None
        answers[field.name] = value
    return answers


def _value(field: QuestionField, answer: str) -> FieldValue | None:
    """Return the person's answer as the field's kind of value, or `None` when the answer does not fit the field."""
    headline = answer.split('\n', 1)[0].strip()
    words = set(_words(answer))
    value: FieldValue | None
    match field.kind:
        case 'text':
            value = answer.strip()
        case 'boolean':
            value = False if _NEGATIVE & words else True if _POSITIVE & words else None
        case 'integer' | 'number':
            try:
                value = int(headline) if field.kind == 'integer' else float(headline)
            except ValueError:
                value = None
        case 'choice':
            value = _option(field, headline)
        case _:
            named = [_option(field, part) for part in re.split(r'[,\n]', answer) if part.strip()]
            value = None if None in named else [name for name in named if name is not None]
    return value


def _option(field: QuestionField, named: str) -> str | None:
    wanted = named.strip().casefold()
    return next(
        (
            option.value
            for option in field.options
            if wanted in (option.name.strip().casefold(), option.value.casefold())
        ),
        None,
    )


def _headline(request: PermissionRequest) -> str:
    return f'Permission needed: {request.title}'


def _input(request: PermissionRequest) -> str:
    """Return what the ask's body shows of the request: its input, or a command that the headline cannot hold."""
    cut = len(_headline(request)) > MAX_HEADLINE
    return request.detail or (request.command or '' if cut else '')[:MAX_SHOWN]


def _one(member: Member, request: PermissionRequest) -> _Key:
    return (member.agent_id, request.title, request.detail)


MAX_SHOWN = 2_000
"""The most characters of a command that an ask shows."""


def _offered(request: PermissionRequest) -> str | None:
    # A grant is answered with "allow once", so a request without that answer gets no offer. Nor does a command
    # whose first word is too long for a choice.
    once = any(choice.kind == 'allow_once' for choice in request.choices)
    prefix = grantable(request.command) if request.command and once else None
    return prefix if prefix and len(grant_choice(prefix)) <= MAX_CHOICE else None


async def _ask(
    member: Member, text: str, choices: tuple[str, ...], body: str, about: str = 'Permission requests'
) -> PostId:
    title = _thread_title(member, about)
    thread = _own_thread(member, title)
    asked = await member.post(
        PostRequest(
            kind='ask',
            text=text[:MAX_HEADLINE],
            body=body,
            choices=choices,
            mentions=(PERSON,),
            thread=thread,
            new_thread=None if thread else title,
        )
    )
    return asked.post.id


def _gives(answer: str, prefix: str, *, any_yes: bool) -> bool:
    """
    Return whether the person's answer gives the grant for `prefix`.

    The picked choice gives it. In the person's own words, a word such as "no" gives nothing, then the choice at the
    start of the first line gives it, and with `any_yes` an answer that starts with a word such as "yes" does too.
    """
    choice = grant_choice(prefix)
    headline = answer.split('\n', 1)[0].strip()
    if headline.casefold() == choice.casefold():
        return True
    words, name = _words(answer), _words(choice)
    if _NEGATIVE.intersection(words):
        return False
    return _words(headline)[: len(name)] == name or (any_yes and words[:1] != () and words[0] in _POSITIVE)


def choose(answer: str, choices: tuple[PermissionChoice, ...]) -> str | None:
    """
    Return the ID of the option that the person's answer chooses, or `None` to cancel the request.

    An answer that starts with an option's name chooses that option, as when the person picks it in the app. Otherwise
    a word such as "no" or "don't" rejects. Then an option named anywhere wins, then a word such as "yes" allows once.
    Any other answer rejects. Words match whole, so "now" is not "no".
    """
    words = _words(answer)
    names = sorted(((_words(choice.name), choice) for choice in choices), key=lambda item: len(item[0]), reverse=True)
    leading = next((choice for name, choice in names if name and words[: len(name)] == name), None)
    if leading:
        return leading.id
    rejected = next((choice for choice in choices if choice.kind.startswith('reject')), None)
    if _NEGATIVE.intersection(words):
        return rejected.id if rejected else None
    named = next((choice for name, choice in names if _contains(words, name)), None)
    allowed = next((choice for choice in choices if choice.kind.startswith('allow')), None)
    chosen = named or (allowed if _POSITIVE.intersection(words) else None) or rejected
    return chosen.id if chosen else None


def _words(text: str) -> tuple[str, ...]:
    return tuple(_WORDS.findall(text.casefold().replace('\u2019', "'")))


def _contains(words: tuple[str, ...], phrase: tuple[str, ...]) -> bool:
    return bool(phrase) and any(words[start : start + len(phrase)] == phrase for start in range(len(words)))


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


async def _answer(member: Member, ask_id: PostId) -> str:
    lab = member.lab
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
