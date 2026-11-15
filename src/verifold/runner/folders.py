"""The folders where agents work."""

import shutil
import subprocess
import sys
from pathlib import Path

from verifold.protocol.ids import AgentId, CommitId
from verifold.runner.errors import NoFileManager
from verifold.runner.git import GitError, commit_of, git

LAB_FOLDER = '.verifold'
"""The folder in the project that holds the lab: its record, the agents' folders, and their private files."""

OPENERS = {'darwin': 'open', 'linux': 'xdg-open'}
"""The command that opens a folder in the file manager, for each platform that has one."""

OPEN_SECONDS = 10.0
"""How long the opener may take. An opener that runs longer has started the file manager and waits for it."""


def open_folder(folder: Path) -> None:
    """
    Open a folder in the file manager of this computer.

    Raises:
        NoFileManager: The platform has no command that opens a folder, or the command failed, as it does on a
            computer without a desktop.

    """
    name = OPENERS.get(sys.platform)
    command = shutil.which(name) if name else None
    if command is None:
        raise NoFileManager('This computer has no command that opens a folder in a file manager.')
    try:
        done = subprocess.run(
            [command, str(folder)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=OPEN_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return
    except OSError as error:
        raise NoFileManager(f'{name} did not start: {error}') from error
    if done.returncode:
        raise NoFileManager(f'{name} could not open the folder. This computer may have no desktop.')


async def tracked_lab_files(project: Path) -> tuple[str, ...]:
    """
    Return the files in the project's lab folder that its Git repository tracks, other than the settings file.

    The lab's record and its norms are Verifold's own. A repository that tracks them brings a lab that someone else
    wrote, with its agents, their modes, and their prompts. A folder outside a repository tracks nothing.
    """
    try:
        # A file system that ignores case, as macOS does by default, checks `.VERIFOLD/` out into the lab folder too.
        listed = await git('ls-files', '--', f':(icase){LAB_FOLDER}', cwd=project)
    except GitError:
        return ()
    return tuple(name for name in listed.splitlines() if name.casefold() != f'{LAB_FOLDER}/settings.json')


def agents_folder(project: Path) -> Path:
    """Return the folder that holds each agent's folder."""
    return project / LAB_FOLDER / 'agents'


async def agent_folder(project: Path, agent_id: AgentId) -> Path:
    """
    Return the agent's folder, and create it on the first call.

    In a project with Git commits, the folder is a worktree of the project on the branch `verifold/<agent ID>`, and
    the lab folder is excluded from the project's Git status. In any other project, the folder is a new repository,
    so the agent can still commit its work. A later call returns the same folder, so a resumed agent keeps its work.
    """
    folder = agents_folder(project) / agent_id
    if folder.exists():
        return folder
    folder.parent.mkdir(parents=True, exist_ok=True)
    if await commit_of(project, 'HEAD') is None:
        folder.mkdir()
        await git('init', '--quiet', cwd=folder)
        return folder
    await _exclude_lab_folder(project)
    branch = f'verifold/{agent_id}'
    existing = await git('branch', '--list', branch, cwd=project)
    await git(
        'worktree', 'add', '--quiet', *((str(folder), branch) if existing else ('-b', branch, str(folder))), cwd=project
    )
    return folder


async def _exclude_lab_folder(project: Path) -> None:
    exclude = Path(await git('rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', cwd=project))
    rule = f'/{LAB_FOLDER}/'
    lines = exclude.read_text().splitlines() if exclude.exists() else []
    if rule not in lines:
        exclude.parent.mkdir(parents=True, exist_ok=True)
        exclude.write_text('\n'.join([*lines, rule]) + '\n')


async def checker_folder(project: Path, checker_id: AgentId, source: Path, ref: str, commit: CommitId) -> Path:
    """
    Return a blind checker's folder: a new repository with the author's files at the commit that the evidence cites.

    The folder holds only what the author's snapshot holds, fetched from the author's folder. A later call returns the
    same folder.
    """
    folder = agents_folder(project) / checker_id
    if folder.exists():
        return folder
    folder.mkdir(parents=True)
    await git('init', '--quiet', cwd=folder)
    await git('fetch', '--quiet', str(source), ref, cwd=folder)
    await git('checkout', '--quiet', '--detach', commit, cwd=folder)
    return folder
