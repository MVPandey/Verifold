"""The messages that Verifold sends an agent: the start of its work, the doorbell, and more time."""

from datetime import UTC, datetime
from pathlib import Path

from verifold.protocol.agents import Agent
from verifold.protocol.events import AlarmSet
from verifold.protocol.posts import Post
from verifold.protocol.settings import AtTimeLimit
from verifold.society.board import Board
from verifold.society.lines import question_thread

DOORBELL = 'New posts for you on the lab board.'
"""The message that wakes an agent after it ended its turn. The agent reads the posts with its board tools."""

DEPARTURE = 'An agent that you named or answered on the lab board has left the lab.'
"""The message that wakes an agent after it ended its turn, when no post came and such an agent left."""

JOBS_ENDED = 'The processes that you left running when your turn ended have ended.'
"""The message that wakes an agent with one job, which ended its turn while its own processes still ran."""


def alarm_message(alarm: AlarmSet) -> str:
    """Return the message that wakes an agent when the alarm that it set rings."""
    why = (
        f'the board got no post for {alarm.minutes:g} minutes'
        if alarm.quiet
        else f'{alarm.minutes:g} minutes passed since you set it'
    )
    return f'The alarm that you set has rung: {why}.'


def cut_short_message(reason: str) -> str:
    """Return the message that resumes an agent whose turn Verifold or its harness ended, with the reason."""
    return f'Your last turn did not end by your choice. {reason}'


BOARD = (
    "The lab's shared board is the MCP server `verifold`. "
    'Its `brief` tool says how the board works and shows what is on it.'
)
"""The line of the start message that points an agent at the board. It names the server, so no agent tries a shell."""


def start_message(
    board: Board, agent: Agent, norms: Path, writing: Path | None = None, *, under_way: bool = False
) -> str:
    """
    Return an agent's first message: the question, who the agent is, who else works on it, and where the norms are.

    With `writing`, it also names the file that says how the lab writes its answer for the person. `under_way` says
    that the agent joins a lab that works already. The caller decides it once for the agents that start together,
    so they all read the same sentence.

    The message holds facts only. `brief` says how the board works, the norms file says how the person wants the
    work done, and the message gives no role.
    """
    peers = ', '.join(
        f'{entry.agent.name} ({entry.agent.id}, {entry.agent.harness})'
        for entry in board.agents
        # An invited agent that has not posted may never come, so it is no peer yet. An agent that left is none.
        if entry.agent.id != agent.id and not entry.agent.checks and board.here(entry)
    )
    # An agent that the person adds to a lab that runs joins work that is under way.
    lead = (
        'The lab is under way, and these agents work in it'
        if under_way
        else 'The other agents got this question at the same moment'
    )
    others = f'{lead}: {peers}.' if peers else 'No other agent works here.'
    lines = [
        board.opened.question,
        '',
        f'You are {agent.name} ({agent.id}) in a Verifold lab. {others}',
        BOARD,
    ]
    if thread := question_thread(board):
        lines.append(f'Thread {thread} on the board holds this question, and every agent watches it.')
    lines.append(f"{norms} holds the lab's norms, which the person sets.")
    if writing:
        lines.append(f'{writing} says how the lab writes its answer for the person.')
    if board.ends_at:
        lines.append(f'The lab ends at {_utc(board.ends_at)}, unless the person gives it more time.')
    return '\n'.join(lines)


RESTARTED = 'Verifold restarted. You worked in this lab before the restart.'
"""How the message for an agent that comes back opens after a restart of Verifold."""

STARTED_AGAIN = 'The person started you again. Your harness had failed too often in a row, so Verifold had stopped it.'
"""How that message opens when the person starts an agent that Verifold had stopped."""

HARNESS_FAILED = 'Your harness failed, and Verifold started it again.'
"""How that message opens when a harness that failed comes back without its conversation."""


def back_message(why: str, start: str, folder: Path, *, kept: bool, cut_off: bool = False) -> str:
    """
    Return the message for an agent that worked in the lab before and comes back: what happened, and what is left.

    `why` says what happened. `kept` says whether the harness loaded the agent's conversation again, and `cut_off`
    that the agent's last turn did not end. An agent without its conversation also gets `start`, the facts that
    every agent gets when it starts. The message holds facts only, and it names the one call that shows the agent
    its place on the board.
    """
    lines = [
        why,
        (
            'Your harness loaded your conversation from before, so you have it.'
            if kept
            else 'Your harness did not load your conversation from before, so this conversation is new.'
        ),
    ]
    if cut_off:
        lines.append('Your last turn did not end: Verifold stopped while it ran.')
    lines.append(f'Your folder is {folder}.')
    lines.append(
        'Call `brief` on the lab board. It shows the board as it is now, with your own role, status, and plan in '
        '`your_line`, and the posts that you have not seen.'
    )
    if not kept:
        lines += ['', 'The rest of this text is what every agent of the lab gets when it starts.', '', start]
    return '\n'.join(lines)


def invitation(start: str, url: str, token: str, folder: Path) -> str:
    """
    Return the text that lets an agent that runs by itself join the lab.

    It says where the board is, who the agent is on it, and where its folder is. Then comes `start`, the facts that
    every agent of the lab gets. Any harness or person can follow it. It holds facts only, and it gives no role.
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
                'restart, call `brief` again: it shows what the board got while you were not connected.'
            ),
            '',
            f'Your folder: {folder}',
            (
                'Verifold pins the files that a post names in `files` from this folder, so a file outside it '
                'cannot back a post.'
            ),
            (
                'Keep the token and your MCP settings outside this folder. Verifold commits the whole folder when '
                'a post names files, and a blind checker gets a copy of it.'
            ),
            '',
            'Call `brief` first. The rest of this text is what every agent of the lab gets when it starts.',
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
    until = f' The lab now ends at {_utc(ends_at)}.' if ends_at else ''
    return (
        f'Your last turn stopped when the lab ran out of time. The person gave the lab more time.{until}'
        f'{JOBS_AFTER_TIME[jobs]}'
    )


def rerun_message(post: Post) -> str:
    """Return a blind checker's first message: the claim, its files, and where to post the check. Nothing else."""
    files = ', '.join(item.path for item in post.evidence)
    return '\n'.join(
        [
            'Rerun this claim blind, from its files alone:',
            f'"{post.text}"',
            f'The files that back it are in your folder, at the version that the claim cites: {files}.',
            'Reproduce the result yourself, and do not trust the claim.',
            (
                f'Then post one `check` in thread {post.thread} that replies to {post.id}, with `outcome` holds or '
                'fails, `method` rerun, and your own files in `files`.'
            ),
        ]
    )


def _utc(at: datetime) -> str:
    return f'{at.astimezone(UTC):%Y-%m-%d %H:%M} UTC'
