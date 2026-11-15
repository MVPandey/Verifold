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
from verifold.protocol.posts import Answer, Ask, Check, Close, Objection, Report, Result, RuledOut
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


def in_turn(activity: AgentActivity) -> bool:
    """
    Return whether a turn of an agent runs now, by its harness's live updates.

    A turn in which the harness waits for the person's answer runs. An agent that waits for more time for the lab,
    or for a process that it left running, is in no turn.
    """
    return activity.state == 'working' or (activity.state == 'waiting' and activity.waits_for in ('person', None))


def agent_need(board: Board, activity: AgentActivity, agent_id: AgentId, waiting: tuple[Wait, ...]) -> Need:
    """Return the one status of an agent: the first of `NEEDS` that applies."""
    mine = {wait.kind for wait in waiting if wait.agent == agent_id}
    for kind in ('approval', 'answer'):
        if kind in mine:
            return kind
    if board.gone(agent_id):
        return 'left'
    # A harness that starts is about to run a turn, so it does not show as idle.
    if in_turn(activity) or activity.state == 'starting':
        return 'working'
    if activity.state in ('stopped', 'void'):
        return 'stopped'
    return 'waiting' if activity.state == 'listening' or _asks_an_agent(board, agent_id) else 'idle'


def _asks_an_agent(board: Board, agent_id: AgentId) -> bool:
    # An ask of the agent that names an agent of the lab, and that still waits for one of them.
    return any(
        isinstance(entry.post, Ask) and entry.post.author == agent_id and _waits_on(board, entry)
        for entry in board.posts
    )


def _waits_on(board: Board, ask: Posted) -> bool:
    """
    Return whether an ask still waits for an agent that it names.

    The wait ends when a named agent replies to the ask or builds on it, when every named agent left the lab, and
    when the asker's own answer or ruled-out lead replies to the ask.
    """
    named = {agent for agent in ask.post.mentions if agent != PERSON}
    if not any(not board.gone(agent) for agent in named):
        return False
    replies = board.replies(ask.post.id)
    own = any(entry.post.author == ask.post.author and isinstance(entry.post, Answer | RuledOut) for entry in replies)
    return not own and not any(entry.post.author in named for entry in (*replies, *board.built_on(ask.post.id)))


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
    return all_outcomes(board).get(agent_id, Outcomes())


def all_outcomes(board: Board) -> dict[AgentId, Outcomes]:
    """
    Return what became of each author's posts, in one pass over the board.

    Each result is looked at once, and the replies to a post and the posts that build on it come from the board's
    index, so the time grows with the number of posts and not with its square.
    """
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    found: dict[AgentId, dict[str, list[Posted]]] = {}
    for entry in board.posts:
        post = entry.post
        lists = found.setdefault(post.author, {'built_on': [], 'held': [], 'refuted': [], 'open_asks': []})
        if isinstance(post, Result):
            state = standing(board, post.id)
            if state in ('checked', 'held_up'):
                lists['held'].append(entry)
            if state in ('disputed', 'conceded'):
                lists['refuted'].append(entry)
            if any(
                other.post.author != post.author
                and other.post.author in workers
                and not isinstance(other.post, Report | Check | Objection | Close)
                for other in board.built_on(post.id)
            ):
                lists['built_on'].append(entry)
        elif isinstance(post, RuledOut) and not withdraws(board, post):
            lists['refuted'].append(entry)
        elif isinstance(post, Ask) and not is_answered(board, post.id):
            lists['open_asks'].append(entry)
    return {
        author: Outcomes.model_validate({name: _refs(entries) for name, entries in lists.items()})
        for author, lists in found.items()
    }


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
