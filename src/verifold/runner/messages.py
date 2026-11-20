"""
The messages that Verifold sends an agent: the start of its work, the doorbell, and more time.

Every message here holds facts only: what happened, what the record shows, and where things are. No sentence tells
an agent what to do with its work or how to behave. Such a sentence is a norm, and norms live in the lab's
`LAB.md` and `WRITING.md`, which the person reads and edits. A message names those files. How to get the board's
state is a fact that an agent with a new conversation needs, so a message says what `brief` gives and orders no
call. `tests/verifold/test_words.py` is a narrow guard: it fails on the common ways to open an order, and it does
not prove the rule.
"""

from datetime import datetime
from pathlib import Path

from verifold.protocol.agents import Agent
from verifold.protocol.events import AlarmCondition, AlarmSet, Halt, Limit
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.join import line_text
from verifold.protocol.posts import Reading
from verifold.protocol.settings import AtTimeLimit
from verifold.society.alarms import condition_words
from verifold.society.allowances import in_force
from verifold.society.board import Board
from verifold.society.budget import LIMIT_NAMES, budget_line
from verifold.society.deliverables import stated
from verifold.society.lifecycle import utc as _utc
from verifold.society.lines import question_thread
from verifold.society.obstacles import obstacles

DOORBELL = 'New posts for you on the lab board.'
"""The message that wakes an agent after it ended its turn. The agent reads the posts with its board tools."""

DEPARTURE = 'An agent that you named or answered on the lab board has left the lab.'
"""The message that wakes an agent after it ended its turn, when no post came and such an agent left."""

ROUND_CLOSED = 'A round closed on the lab board, and its entries show to every agent now.'
"""The message that wakes an agent for the close of a round that concerns it, when no post for it came."""

RERUN_WANTED = 'An independent rerun that you can take is wanted on the lab board.'
"""The message that wakes an agent after it ended its turn, when no post came and it can take a rerun that is wanted."""


IN_TURN = 'while you were in a turn'
OUT_OF_TIME = 'while the lab was out of time'
AT_LIMIT = 'while the lab stood at its budget or its disk limit'
CLOSED = 'while the lab was closed'
"""Why an alarm rings after its time, in the cases that Verifold knows."""


def alarm_message(alarm: AlarmSet, late: str = '', cause: AlarmCondition | None = None) -> str:
    """
    Return the message that wakes an agent when the alarm that it set rings.

    `late` says why the alarm rings after its time, such as `IN_TURN`. It is empty when the alarm rings at its
    time, and when Verifold does not know why it is late. `cause` is the condition of the alarm that the record
    met, and `None` when the alarm's time rang it.
    """
    if cause is not None:
        rung = f'The alarm that you set at {_utc(alarm.at)} has rung: {condition_words(cause)}.'
        return f'{rung} The record met it {late}, so it rings now.' if late else rung
    rung = (
        f'The alarm that you set at {_utc(alarm.at)} has rung: the board got no post for {alarm.minutes:g} minutes.'
        if alarm.quiet
        else f'The alarm that you set at {_utc(alarm.at)} for {alarm.minutes:g} minutes has rung.'
    )
    return f'{rung} Its time came {late}, so it rings now.' if late else rung


def cut_short_message(reason: str) -> str:
    """Return the message that resumes an agent whose turn Verifold or its harness ended, with the reason."""
    return f'Your last turn did not end by your choice. {reason}'


BOARD = (
    "The lab's shared board is the MCP server `verifold`. "
    'Its `brief` tool says how the board works and shows what is on it.'
)
"""The line of the start message that points an agent at the board. It names the server, so no agent tries a shell."""


ON_CALL = (
    'The person put your seat on call. A post is for you when it is an ask, a call, or a task that names you, replies to '
    'your post, builds on your post, is the check of a rerun that you asked for, or is a post of the person that '
    'names you, and when it is in a thread that you watch with `watch` or in a side thread that you are a member '
    'of. A close is for you once you have posted. No other post is for you: a name in a plan, a message, or a '
    'result is not.'
)
"""What the start message says to an on-call agent. It holds for an agent that Verifold runs and for an invited one."""

DESK = (
    "The person made your seat the lab's desk. The desk chat, thread {chat} on the board, is where the person and "
    'the desk talk. A post of the person there starts your turn, also while the lab is out of time, at its budget '
    'or its disk limit, or closed, and no other post on the board does. Your turns count toward what the lab '
    "spent. The desk is no part of the lab's work: the board takes no plan, result, check, proposal, close, vote, "
    'or badge from it, and it counts for no round and no close. The tools `overview`, `read_file`, `reply`, `say`, '
    '`open_round`, `revise_question`, `deliverable`, `set_time`, `set_budget`, `interrupt`, and `draft_allowance` '
    "are the desk's alone, and their descriptions say what each one does. Each action names in `on` the person's post in the "
    'desk chat that it rests on, from the last 60 minutes.'
)
"""What the start message says to the desk."""

FRESH = (
    'Your seat starts with a fresh view, as the coordinator asked when it added the seat. Until you post your first '
    'plan, `brief` leaves out the candidate answers, the report, and the dashboard. `thread` shows every post.'
)
"""What the start message says to a seat that starts with a fresh view."""

MAX_RULED_OUT = 10
"""The most leads that were ruled out, the newest, that the start message of a fresh seat names."""

HAS_DESK = (
    "{name} ({id}) holds the lab's desk seat: it answers the person in the desk chat and acts on the person's "
    "word, and it is no part of the lab's work."
)
"""What the start message of every other agent says about the lab's desk."""


def start_message(
    board: Board, agent: Agent, norms: Path, writing: Path | None = None, *, under_way: bool = False
) -> str:
    """
    Return an agent's first message: the question, who the agent is, who else works on it, and where the norms are.

    With `writing`, it also names the file that says how the lab writes its answer for the person. `under_way` says
    that the agent joins a lab that works already. The caller decides it once for the agents that start together,
    so they all read the same sentence.

    The message holds facts only. `brief` says how the board works, and the norms file says how the person wants
    the work done. A role that the person gave the agent's seat is one of the facts, in the person's words, and the
    message says nothing about what to do with it.
    """
    peers = ', '.join(
        f'{entry.agent.name} ({entry.agent.id}, {entry.agent.harness})'
        for entry in board.agents
        # An invited agent that has not posted may never come, so it is no peer yet. An agent that left is none,
        # and neither is the desk, which is no part of the lab's work.
        if entry.agent.id != agent.id
        and not entry.agent.checks
        and board.here(entry)
        and not board.is_desk(entry.agent.id)
    )
    # An agent that the person adds to a lab that runs joins work that is under way.
    lead = (
        'The lab is under way, and these agents work in it'
        if under_way
        else 'The other agents got this question at the same moment'
    )
    others = f'{lead}: {peers}.' if peers else 'No other agent works here.'
    lines = [
        board.question,
        '',
        f'You are {agent.name} ({agent.id}) in a Verifold lab. {others}',
        BOARD,
    ]
    # The role as it stands now: a later change of it, also one that cleared it, replaces the seat's first role.
    changed = any(entry.agent == agent.id and entry.given_role is not None for entry in board.profiles)
    role, giver = board.given_role(agent.id) if changed else (agent.given_role, PERSON)
    if role:
        who = 'The person' if giver == PERSON else f'{giver}, as the coordinator of the lab,'
        lines.append(f'{who} gave your seat this role: {role}')
    if board.coordinator == agent.id:
        lines.append("You hold the lab's coordinator seat.")
    if board.on_call(agent.id):
        lines.append(ON_CALL)
    desk = board.agent(board.desk) if board.desk else None
    if desk and desk.agent.id == agent.id:
        lines.append(DESK.format(chat=board.desk_chat))
    elif desk:
        lines.append(HAS_DESK.format(name=desk.agent.name, id=desk.agent.id))
    if thread := question_thread(board):
        lines.append(f'Thread {thread} on the board holds this question.')
    if agent.fresh:
        lines.extend(_fresh_view(board))
    if board.revisions:
        lines.append(
            f'The question was revised, last at {_utc(board.revisions[-1].at)}. The text above is the '
            'current one, and `brief` lists the posts that hold the revisions.'
        )
    if count := len(stated(board)):
        lines.append(
            f'The person stated {count} {"deliverable" if count == 1 else "deliverables"}: what the person wants '
            'to hold at the end of the lab. `brief` lists each one with the files offered for it.'
        )
    lines.append(f"{norms} holds the lab's norms, which the person sets and can change while the lab runs.")
    if writing:
        lines.append(f'{writing} says how the lab writes its answer for the person.')
    if board.ends_at:
        lines.append(f'The lab ends at {_utc(board.ends_at)}, unless it gets more time.')
    return '\n'.join(lines)


def _fresh_view(board: Board) -> list[str]:
    # The question, the lab's reading, and what was ruled out, for a seat that starts with a fresh view. Each line
    # of a post is its headline, cut as in a brief.
    lines = [FRESH]
    reading = next((entry for entry in reversed(board.posts) if isinstance(entry.post, Reading)), None)
    if reading:
        lines.append(f"Post {reading.post.id} holds the lab's reading of the question: {line_text(reading.post.text)}")
    ruled = tuple(item.entry for item in reversed(obstacles(board)))
    if ruled:
        shown = ruled[:MAX_RULED_OUT]
        count = f'{len(ruled)} {"lead was" if len(ruled) == 1 else "leads were"} ruled out'
        lines.append(f'{count}. The newest {len(shown)}:' if len(shown) < len(ruled) else f'{count}:')
        lines.extend(f'- {entry.post.id}: {line_text(entry.post.text)}' for entry in shown)
    return lines


RESTARTED = 'Verifold restarted. You worked in this lab before the restart.'
"""How the message for an agent that comes back opens after a restart of Verifold."""

STARTED_AGAIN = 'The person started you again. Your harness had failed too often in a row, so Verifold had stopped it.'
"""How that message opens when the person starts an agent that Verifold had stopped."""

HARNESS_FAILED = 'Your harness failed, and Verifold started it again.'
"""How that message opens when a harness that failed comes back without its conversation."""

MODE_CHANGED = 'The person changed the mode of your seat to {mode}, so Verifold started your harness again in it.'
"""How that message opens when the person changed the seat's harness mode in the lab that runs."""


def stop_lifted(board: Board, agent_id: AgentId, at: datetime) -> str:
    """
    Return what an acting seat gets when the board's stop at the total of its allowance no longer holds it.

    The board held its turns while the actions of its allowance cost more than the total. Only the person lifts the
    stop: they ended that allowance, or they started another one for the seat.
    """
    held = in_force(board, agent_id, at)
    lifted = (
        f'The person started the allowance {held.allowance} for you: up to {held.terms.per_action} '
        f'{held.terms.unit} an action and {held.terms.total} {held.terms.unit} in all, until {_utc(held.terms.ends_at)}.'
        if held
        else 'The person ended your allowance, so you hold none in force.'
    )
    return f'Verifold held your turns while the actions of your allowance cost more than its total. {lifted}'


def back_message(  # noqa: PLR0913
    why: str, start: str, folder: Path, *, kept: bool, cut_off: bool = False, jobs_stopped: bool = False
) -> str:
    """
    Return the message for an agent that worked in the lab before and comes back: what happened, and what is left.

    `why` says what happened. `kept` says whether the harness reported that it loaded the agent's conversation,
    `cut_off` that the record has no end for the agent's last turn, and `jobs_stopped` that Verifold stopped the
    agent's processes. `start`, the facts that every agent gets when it starts, comes last, also with a loaded
    conversation: a harness can load a conversation that holds nothing. The message holds facts only. One of them
    is which tool gives the agent its place on the board.
    """
    lines = [
        why,
        (
            'Your harness reported that it loaded your conversation from before.'
            if kept
            else 'Your harness did not load your conversation from before, so this conversation is new.'
        ),
    ]
    if cut_off:
        lines.append('The record has no end for your last turn, so Verifold may have stopped while it ran.')
    if jobs_stopped:
        lines.append('Verifold stopped any program that you had left running in the background.')
    lines.append(f'Your folder is {folder}.')
    lines.append(
        '`brief` on the lab board gives the board as it is now, with your own role, status, and plan in '
        '`your_line`, and the posts that you have not seen.'
    )
    lines += ['', 'The rest of this text is what every agent of the lab gets when it starts.', '', start]
    return '\n'.join(lines)


def invitation(start: str, url: str, token: str, folder: Path) -> str:
    """
    Return the text that lets an agent that runs by itself join the lab.

    It says where the board is, who the agent is on it, and where its folder is. Then comes `start`, the facts that
    every agent of the lab gets. Any harness or person can follow it. It holds facts only.
    """
    return '\n'.join(
        [
            'This is an invitation for one agent to a Verifold lab, where agents work on a question for a person.',
            (
                'Verifold did not start you, so it cannot wake you or stop you. You hear the board only in the '
                'results of your own calls, and its `wait` tool returns when a post for you arrives.'
            ),
            '',
            "The lab's board is an MCP server. Its name in the text below is `verifold`.",
            'Transport: streamable HTTP',
            f'URL: {url}',
            f'Header: Authorization: Bearer {token}',
            (
                'The token says who you are on the board, so whoever has it posts as you. It stays valid when '
                'Verifold restarts, and Verifold then takes the same port again when the port is free. After a '
                'restart, `brief` shows what the board got while you were not connected.'
            ),
            '',
            f'Your folder: {folder}',
            (
                'Verifold pins the files that a post names in `files` from this folder, so a file outside it '
                'cannot back a post.'
            ),
            (
                'Verifold commits the whole folder when a post names files, and an agent that takes a rerun of '
                'such a post gets a copy of that commit. So a token or MCP settings in this folder reach those '
                'commits and each such agent.'
            ),
            '',
            (
                '`brief` gives the board as it is now. The rest of this text is what every agent of the lab gets '
                'when it starts.'
            ),
            '',
            start,
        ]
    )


JOBS_AFTER_TIME = {
    AtTimeLimit.PAUSE: ' Verifold paused any process that you left running, and it runs again now.',
    AtTimeLimit.STOP: ' Verifold stopped any process that you left running.',
    AtTimeLimit.FINISH: '',
}
"""What the message that resumes an agent says about its processes, for each setting."""


def more_time_message(ends_at: datetime | None, jobs: AtTimeLimit) -> str:
    """Return the message that resumes an agent whose turn stopped when the lab ran out of time, per `jobs`."""
    return f'Your last turn stopped when the lab ran out of time. {time_facts(ends_at, jobs)}'


def limit_message(limit: Limit, board: Board, jobs: AtTimeLimit) -> str:
    """Return the message that resumes an agent whose turn stopped when the lab reached a limit, per `jobs`."""
    return f'Your last turn stopped when the lab reached its {LIMIT_NAMES[limit]}. {limit_facts(limit, board, jobs)}'


def go_on_message(halts: tuple[Halt, ...], board: Board, jobs: AtTimeLimit) -> str:
    """
    Return the message that resumes an agent whose turn stopped at the lab's time or at another of its limits.

    `halts` holds each halt that the agent waited through, the one that stopped its turn first, and the message
    names each one.
    """
    first, *more = halts
    stopped = 'ran out of time' if first == 'time' else f'reached its {LIMIT_NAMES[first]}'
    also = ''.join(f' {_also(halt)}' for halt in more)
    return f'Your last turn stopped when the lab {stopped}.{also} {go_on_facts(halts, board, jobs)}'


def _also(halt: Halt) -> str:
    return 'The lab also ran out of time.' if halt == 'time' else f'The lab also reached its {LIMIT_NAMES[halt]}.'


def go_on_facts(halts: tuple[Halt, ...], board: Board, jobs: AtTimeLimit) -> str:
    """Return what an agent that waited at the lab's time or at its other limits gets when the lab goes on."""
    facts = ' '.join(_more_time(board.ends_at) if halt == 'time' else _limit_changed(halt, board) for halt in halts)
    return f'{facts}{JOBS_AFTER_TIME[jobs]}'


def limit_facts(limit: Limit, board: Board, jobs: AtTimeLimit) -> str:
    """Return what an agent that waited at a limit gets: the limit as it is now, and what happened to its processes."""
    return f'{_limit_changed(limit, board)}{JOBS_AFTER_TIME[jobs]}'


def _limit_changed(limit: Limit, board: Board) -> str:
    # Who changed the limit, and the limit as it is now. The desk sets a budget on the person's word, and only the
    # person sets the disk limit.
    if limit == 'disk':
        most = board.settings.disk.limit_gb
        now = f' The disk limit is now {most} GB.' if most else ' The lab has no disk limit now.'
        return f'The person changed the disk limit.{now}'
    line = budget_line(board)
    left = (
        *((f'{line.tokens_left:,} tokens',) if line.tokens_left is not None else ()),
        *((f'{line.dollars_left:.2f} dollars',) if line.dollars_left is not None else ()),
    )
    budget = f' The budget has {" and ".join(left)} left.' if left else ' The lab has no budget now.'
    by_desk = board.budget is not None and board.budget.by != PERSON
    who = 'The desk changed the budget for the person.' if by_desk else 'The person changed the budget.'
    return f'{who}{budget}'


def time_facts(ends_at: datetime | None, jobs: AtTimeLimit) -> str:
    """Return what an agent that waited for more time gets: the lab's new end, and what happened to its processes."""
    return f'{_more_time(ends_at)}{JOBS_AFTER_TIME[jobs]}'


def _more_time(ends_at: datetime | None) -> str:
    until = f' The lab now ends at {_utc(ends_at)}.' if ends_at else ''
    return f'The person gave the lab more time.{until}'
