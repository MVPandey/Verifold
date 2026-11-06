"""Permission requests reach the person on the board, and the person's answer decides them."""

from verifold.protocol.ids import PERSON
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import Answer
from verifold.runner.session import PermissionChoice, PermissionRequest
from verifold.server.member import Member

IDLE_WAIT = 3_600.0
"""Seconds of each wait for the person's answer. The harness waits as long as the person takes."""

_ALLOW = ('allow', 'yes', 'approve', 'ok')
_REJECT = ('deny', 'no', 'reject', 'refuse')


async def ask_the_person(member: Member, request: PermissionRequest) -> str | None:
    """
    Post the request as an ask to the person, wait for the person's answer, and return the chosen option's ID.

    The ask goes in the agent's own "Permission requests" thread. The person can name an option, or say allow or deny.
    An answer that matches no option rejects the action.
    """
    names = ', '.join(choice.name for choice in request.choices)
    thread = _permission_thread(member)
    asked = await member.post(
        PostRequest(
            kind='ask',
            text=f'Permission needed: {request.title}',
            body=f'Reply with one of: {names}.',
            mentions=(PERSON,),
            thread=thread,
            new_thread=None if thread else _thread_title(member),
        )
    )
    answer = await _answer(member, asked.post.id)
    return choose(answer, request.choices)


def choose(answer: str, choices: tuple[PermissionChoice, ...]) -> str | None:
    """Return the ID of the option that an answer names or means, or the first reject option."""
    text = answer.casefold()
    named = next((choice for choice in choices if choice.name.casefold() in text), None)
    allows = any(word in text for word in _ALLOW) and not any(word in text for word in _REJECT)
    wanted = 'allow' if allows else 'reject'
    meant = next((choice for choice in choices if choice.kind.startswith(wanted)), None)
    fallback = next((choice for choice in choices if choice.kind.startswith('reject')), None)
    chosen = named or meant or fallback
    return chosen.id if chosen else None


def _thread_title(member: Member) -> str:
    return f'Permission requests from {member.agent_id}'


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
        answer = next(
            (
                entry.post.text
                for entry in lab.board.replies(ask_id)
                if isinstance(entry.post, Answer) and entry.post.author == PERSON
            ),
            None,
        )
        if answer is not None:
            return answer
        await lab.wait_for_change(lab.board.seq, IDLE_WAIT)
