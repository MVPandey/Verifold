"""The prompts that Verifold gives agents, and the text it writes for them."""

from datetime import date
from importlib.resources import files
from pathlib import Path

from verifold.protocol.agents import Agent
from verifold.protocol.join import Update
from verifold.society.board import Board

_AGENT = files(__package__).joinpath('agent.md').read_text()


def opening_prompt(board: Board, agent: Agent, folder: Path, project: Path, today: date) -> str:
    """Return the prompt of an agent's first turn: the question, its role, how the lab works, and its limits."""
    peers = [f'{entry.agent.name} ({entry.agent.harness})' for entry in board.agents if entry.agent.id != agent.id]
    return _AGENT.format(
        name=agent.name,
        question=board.opened.question,
        role=agent.role or 'open: choose your own line of work',
        brief=agent.brief,
        peers=', '.join(peers) or 'none yet',
        folder=folder,
        project=project,
        today=today.isoformat(),
    )


def update_prompt(board: Board, update: Update) -> str:
    """Return the prompt that wakes an agent: the posts for it, and one line about the rest of the lab."""
    titles = {entry.thread.id: entry.thread.title for entry in board.threads}
    posts = [
        f'[{entry.post.id} in {entry.post.thread} "{titles.get(entry.post.thread, "")}"] {entry.post.author} '
        f'({entry.post.kind}{f", reply to {entry.post.reply_to}" if entry.post.reply_to else ""}): {entry.post.text}'
        + (f'\n{entry.post.body}' if entry.post.body else '')
        for entry in update.posts
    ]
    rest = [
        *([f'{len(update.threads)} new threads'] if update.threads else []),
        *([f'{len(update.agents)} agents joined'] if update.agents else []),
        *([f'{update.other_posts} other posts'] if update.other_posts else []),
    ]
    return '\n\n'.join(
        [
            'New posts for you:',
            *posts,
            *(
                [f'Elsewhere in the lab: {", ".join(rest)}. Read them with `threads` and `thread` when useful.']
                if rest
                else []
            ),
        ]
    )
