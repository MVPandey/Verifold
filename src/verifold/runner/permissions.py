"""
Permission requests of the agents' harnesses, and who decides them.

Verifold allows a call to the lab's own board, and a command that a grant of the person covers. Every other request
goes to the person on the board. Under auto mode, a command without a grant is refused at once, so that the lab never
waits for the person, and the person gets an ask that offers the grant.
"""

import re

from verifold.protocol.ids import PERSON, PostId
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_HEADLINE, Answer
from verifold.runner.session import PermissionChoice, PermissionRequest
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
    asked = await _ask(member, request, (*names, grant_choice(prefix)) if prefix else names, '')
    answer = await _answer(member, asked)
    if prefix and _leads(answer, grant_choice(prefix)):
        await member.lab.grant(prefix)
        # The person allowed this command too, also when it has an operator that the grant doesn't cover.
        return next(choice.id for choice in request.choices if choice.kind == 'allow_once')
    return choose(answer, request.choices)


class GrantAsks:
    """
    The asks that offer the person a grant after Verifold refused a command, and the grants that the answers give.

    Under auto mode the lab doesn't wait for the person. The agent gets a refusal at once, and the ask stays open. When
    the person picks the grant, the next such command passes, for every agent. The asks live in this process: after a
    restart of Verifold, an answer to an ask from before gives no grant, and the next refusal asks again.
    """

    def __init__(self, lab: Lab) -> None:
        """Prepare to keep the asks of `lab`."""
        self._lab = lab
        self._open: dict[PostId, str] = {}

    async def offer(self, member: Member, request: PermissionRequest) -> None:
        """Ask the person for the grant that would cover the request's command, unless such an ask is open."""
        prefix = _offered(request)
        if prefix is None or prefix in self._open.values():
            return
        body = (
            f'Verifold refused this command, so that the lab does not wait:\n\n{request.command}\n\n'
            f'The grant lets every agent run a command that starts with `{prefix}` and has no shell operator, such as '
            'a pipe or a redirect.'
        )
        self._open[await _ask(member, request, (grant_choice(prefix), 'No'), body)] = prefix

    async def run(self) -> None:
        """Record the grant of each ask that the person answers with it, until the caller cancels this."""
        while True:
            board = self._lab.board
            answers = {ask_id: _persons_answer(board, ask_id) for ask_id in self._open}
            given = {self._open.pop(ask_id): answer for ask_id, answer in answers.items() if answer is not None}
            for prefix, answer in given.items():
                if _leads(answer, grant_choice(prefix)):
                    await self._lab.grant(prefix)
            await self._lab.wait_for_change(board.seq)


def _offered(request: PermissionRequest) -> str | None:
    # A grant is answered with "allow once", so a request without that answer gets no offer.
    once = any(choice.kind == 'allow_once' for choice in request.choices)
    return grantable(request.command) if request.command and once else None


async def _ask(member: Member, request: PermissionRequest, choices: tuple[str, ...], body: str) -> PostId:
    thread = _permission_thread(member)
    asked = await member.post(
        PostRequest(
            kind='ask',
            text=f'Permission needed: {request.title}'[:MAX_HEADLINE],
            body=body,
            choices=choices,
            mentions=(PERSON,),
            thread=thread,
            new_thread=None if thread else _thread_title(member),
        )
    )
    return asked.post.id


def _leads(answer: str, choice: str) -> bool:
    name = _words(choice)
    return _words(answer)[: len(name)] == name


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


def _thread_title(member: Member) -> str:
    joined = member.lab.board.agent(member.agent_id)
    return f'Permission requests from {joined.agent.name if joined else member.agent_id}'


def _permission_thread(member: Member) -> str | None:
    title = _thread_title(member)
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
