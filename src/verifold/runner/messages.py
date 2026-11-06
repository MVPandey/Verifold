"""The two messages that Verifold sends an agent: the start of its work, and the doorbell."""

from importlib.resources import files
from pathlib import Path

from verifold.protocol.agents import Agent
from verifold.society.board import Board

DOORBELL = 'New posts for you on the lab board.'
"""The message that wakes an agent after it ended its turn. The agent reads the posts with its board tools."""

LAB_TEMPLATE = files(__package__).joinpath('LAB.md').read_text()
"""The lab's norms when a lab starts. The person edits the copy in the lab's folder."""


def start_message(board: Board, agent: Agent, lab_file: Path) -> str:
    """Return the first message of an agent: the question, who it is, and where the lab's norms are."""
    peers = ', '.join(
        f'{entry.agent.name} ({entry.agent.harness})' for entry in board.agents if entry.agent.id != agent.id
    )
    lines = [
        board.opened.question,
        '',
        f'You are {agent.name} in a Verifold lab. The other agents: {peers or "none yet"}.',
        f"The `verifold` tools are the lab's shared board. {lab_file} describes how the lab works.",
    ]
    if agent.role or agent.brief:
        lines.append(f'Your starting role: {agent.role or "open"}. {agent.brief}'.rstrip())
    return '\n'.join(lines)
