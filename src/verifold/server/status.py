"""
The one status of each agent and each thread, and what waits for the person.

The status comes from the record and from the agents' live activity, so it is for the person's app and never for an
agent. `Need` in the app protocol says what each status means.
"""

from collections.abc import Iterable
from typing import Literal

from verifold.protocol.app import NEEDS, AgentActivity, Need, Outcomes, PostRef, ProfileEdit, Wait
from verifold.protocol.events import Posted, ProfileSet
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.posts import Ask, Check, Close, Objection, Report, Result, RuledOut
from verifold.society.board import Board
from verifold.society.lines import lines_of, withdraws
from verifold.society.standing import is_answered, standing
from verifold.society.views import needs_person, team

APPROVAL_COMMAND = 'Asks to run a command'
APPROVAL_OTHER = 'Asks for a permission of its harness'
HARNESS_QUESTION = 'Its harness asks you a question'
"""Verifold's own words for a request of a harness, so that no text of a harness stands among the waits."""


def waits(board: Board) -> tuple[Wait, ...]:
    """Return what waits for the person: the approvals first, then the answers, each group oldest first."""
    found = tuple(
        Wait(
            kind='approval' if view.post.request == 'permission' else 'answer',
            agent=view.post.author,
            what=_what(view.post),
            since=view.at,
            post=view.post.id,
            thread=view.post.thread,
        )
        for view in needs_person(board)
        if isinstance(view.post, Ask)
    )
    return tuple(sorted(found, key=lambda wait: wait.kind != 'approval'))


def _what(ask: Ask) -> str:
    if ask.request == 'permission':
        command = ask.shown is not None and ask.shown.type == 'permission' and ask.shown.command is not None
        return APPROVAL_COMMAND if command else APPROVAL_OTHER
    return HARNESS_QUESTION if ask.request else ask.text


def agent_need(board: Board, activity: AgentActivity, agent_id: AgentId, waiting: tuple[Wait, ...]) -> Need:
    """Return the one status of an agent: the first of `NEEDS` that applies."""
    mine = {wait.kind for wait in waiting if wait.agent == agent_id}
    for kind in ('approval', 'answer'):
        if kind in mine:
            return kind
    if board.gone(agent_id):
        return 'left'
    if activity.state in ('working', 'waiting'):
        return 'working'
    if activity.state in ('stopped', 'void'):
        return 'stopped'
    return 'waiting' if activity.state == 'listening' or _asks_an_agent(board, agent_id) else 'idle'


def _asks_an_agent(board: Board, agent_id: AgentId) -> bool:
    # An ask of the agent that names an agent of the lab and has no answer yet.
    return any(
        isinstance(entry.post, Ask)
        and entry.post.author == agent_id
        and any(named != PERSON and not board.gone(named) for named in entry.post.mentions)
        and not is_answered(board, entry.post.id)
        for entry in board.posts
    )


def thread_needs(board: Board, needs: dict[AgentId, Need], waiting: tuple[Wait, ...]) -> dict[ThreadId, Need]:
    """
    Return the one status of each thread.

    It is the first of `NEEDS` that applies to an ask in the thread that waits for the person, or to an agent of
    its team. A thread with neither is idle.
    """
    lines = lines_of(board)
    return {
        opened.thread.id: min(
            (
                *(wait.kind for wait in waiting if wait.thread == opened.thread.id),
                *(needs[agent] for agent in team(board, opened, lines) if agent in needs),
            ),
            key=NEEDS.index,
            default='idle',
        )
        for opened in board.threads
    }


def outcomes(board: Board, agent_id: AgentId) -> Outcomes:
    """Return what became of an agent's posts, as lists of posts, each oldest first."""
    mine = tuple(entry for entry in board.posts if entry.post.author == agent_id)
    results = tuple((entry, standing(board, entry.post.id)) for entry in mine if isinstance(entry.post, Result))
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}

    def built(entry: Posted) -> bool:
        return any(
            other.post.author != agent_id
            and other.post.author in workers
            and not isinstance(other.post, Report | Check | Objection | Close)
            for other in board.built_on(entry.post.id)
        )

    return Outcomes(
        built_on=_refs(entry for entry, _ in results if built(entry)),
        held=_refs(entry for entry, state in results if state in ('checked', 'held_up')),
        refuted=_refs(
            entry
            for entry in mine
            if (isinstance(entry.post, Result) and standing(board, entry.post.id) in ('disputed', 'conceded'))
            or (isinstance(entry.post, RuledOut) and not withdraws(board, entry.post))
        ),
        open_asks=_refs(
            entry for entry in mine if isinstance(entry.post, Ask) and not is_answered(board, entry.post.id)
        ),
    )


def _refs(entries: Iterable[Posted]) -> tuple[PostRef, ...]:
    return tuple(PostRef(id=entry.post.id, thread=entry.post.thread) for entry in entries)


type Part = Literal['name', 'about', 'picture', 'role', 'flag']


def _parts(entry: ProfileSet) -> dict[Part, str | None]:
    # What a change sets for each part of a profile that another can change, or `None` where it sets nothing.
    chosen = entry.picture
    picture = '' if entry.no_picture else f'{chosen.shape}, {chosen.color}, {chosen.symbol}' if chosen else None
    return {'name': entry.name, 'about': entry.about, 'picture': picture, 'role': entry.given_role, 'flag': entry.flag}


def profile_edits(board: Board, agent_id: AgentId) -> tuple[ProfileEdit, ...]:
    """
    Return each change that the person or a coordinator made to an agent's profile, oldest first.

    Each one has the text that the changed part held before.
    """
    joined = board.agent(agent_id)
    now: dict[Part, str] = {
        'name': '',
        'about': '',
        'picture': '',
        'role': joined.agent.given_role if joined else '',
        'flag': '',
    }
    edits: list[ProfileEdit] = []
    for entry in board.profiles:
        if entry.agent != agent_id:
            continue
        for part, text in _parts(entry).items():
            if text is None:
                continue
            if entry.by is not None and entry.by != agent_id and text != now[part]:
                edits.append(ProfileEdit(at=entry.at, by=entry.by, part=part, before=now[part], after=text))
            now[part] = text
    return tuple(edits)
