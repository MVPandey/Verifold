"""The messages that Verifold sends an agent: the start of its work, the doorbell, and more time."""

from datetime import UTC, datetime
from pathlib import Path

from verifold.protocol.agents import Agent
from verifold.protocol.posts import Post
from verifold.protocol.settings import AtTimeLimit
from verifold.society.board import Board
from verifold.society.views import question_thread

DOORBELL = 'New posts for you on the lab board.'
"""The message that wakes an agent after it ended its turn. The agent reads the posts with its board tools."""


def start_message(board: Board, agent: Agent, norms: Path) -> str:
    """
    Return an agent's first message: the question, who the agent is, who else works on it, and where the norms are.

    The message holds facts only. `brief` says how the board works, the norms file says how the person wants the
    work done, and the message gives no role.
    """
    peers = ', '.join(
        f'{entry.agent.name} ({entry.agent.id}, {entry.agent.harness})'
        for entry in board.agents
        if entry.agent.id != agent.id and not entry.agent.checks
    )
    others = (
        f'The other agents got this question at the same moment: {peers}.' if peers else 'No other agent works here.'
    )
    lines = [
        board.opened.question,
        '',
        f'You are {agent.name} ({agent.id}) in a Verifold lab. {others}',
        "The `verifold` tools are the lab's shared board. `brief` says how the board works and shows what is on it.",
    ]
    if thread := question_thread(board):
        lines.append(f'Thread {thread} on the board holds this question, and every agent watches it.')
    lines.append(f"{norms} holds the lab's norms, which the person sets.")
    if board.ends_at:
        lines.append(f'The lab ends at {_utc(board.ends_at)}, unless the person gives it more time.')
    return '\n'.join(lines)


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
