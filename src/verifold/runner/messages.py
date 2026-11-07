"""The messages that Verifold sends an agent: the start of its work, the doorbell, and more time."""

from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path

from verifold.protocol.agents import Agent
from verifold.protocol.posts import Post
from verifold.society.board import Board

DOORBELL = 'New posts for you on the lab board.'
"""The message that wakes an agent after it ended its turn. The agent reads the posts with its board tools."""

LAB_TEMPLATE = files(__package__).joinpath('LAB.md').read_text()
"""The norms that a new lab starts with. The person edits the copy in the lab's folder."""


def start_message(board: Board, agent: Agent, lab_file: Path) -> str:
    """Return an agent's first message: the question, who the agent is, and where the lab's norms are."""
    peers = ', '.join(
        f'{entry.agent.name} ({entry.agent.harness})' for entry in board.agents if entry.agent.id != agent.id
    )
    lines = [
        board.opened.question,
        '',
        f'You are {agent.name} in a Verifold lab. The other agents: {peers or "none yet"}.',
        f"The `verifold` tools are the lab's shared board. {lab_file} describes how the lab works.",
    ]
    if board.ends_at:
        lines.append(f'The lab ends at {_utc(board.ends_at)}, unless the person gives it more time.')
    if agent.role or agent.brief:
        lines.append(f'Your starting role: {agent.role or "open"}. {agent.brief}'.rstrip())
    return '\n'.join(lines)


def more_time_message(ends_at: datetime | None) -> str:
    """Return the message that resumes an agent whose turn stopped when the lab ran out of time."""
    until = f' The lab now ends at {_utc(ends_at)}.' if ends_at else ''
    return f'Your last turn stopped when the lab ran out of time. The person gave the lab more time.{until}'


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
