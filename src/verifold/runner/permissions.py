"""Permission requests reach the person on the board, and the person's answer decides them."""

import re

from verifold.protocol.ids import PERSON
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_HEADLINE, Answer
from verifold.runner.session import PermissionChoice, PermissionRequest
from verifold.server.member import Member

_POSITIVE = frozenset({'allow', 'approve', 'go', 'ok', 'okay', 'sure', 'yes'})
_NEGATIVE = frozenset({'cancel', 'deny', "don't", 'dont', 'never', 'no', 'not', 'refuse', 'reject', 'stop'})
_WORDS = re.compile(r"[a-z]+(?:'[a-z]+)?")


async def ask_the_person(member: Member, request: PermissionRequest) -> str | None:
    """
    Post the request as an ask to the person, wait for the person's answer, and return the chosen option's ID.

    The ask goes in the agent's own "Permission requests" thread, with the harness's options as its choices. The person
    can pick an option or answer in their own words. An answer that matches no option rejects the action.
    """
    thread = _permission_thread(member)
    asked = await member.post(
        PostRequest(
            kind='ask',
            text=f'Permission needed: {request.title}'[:MAX_HEADLINE],
            choices=tuple(choice.name for choice in request.choices),
            mentions=(PERSON,),
            thread=thread,
            new_thread=None if thread else _thread_title(member),
        )
    )
    answer = await _answer(member, asked.post.id)
    return choose(answer, request.choices)


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


async def _answer(member: Member, ask_id: str) -> str:
    lab = member.lab
    while True:
        # The whole answer counts: a picked option leads the text, and the person's own words can follow in the body.
        answer = next(
            (
                f'{entry.post.text}\n{entry.post.body}'
                for entry in lab.board.replies(ask_id)
                if isinstance(entry.post, Answer) and entry.post.author == PERSON
            ),
            None,
        )
        if answer is not None:
            return answer
        await lab.wait_for_change(lab.board.seq)
