"""The folders where agents work."""

import shutil
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

from verifold.protocol.ids import AgentId
from verifold.runner.errors import NoAgentFolder, NoFileManager
from verifold.runner.git import GitError, GitTimeout, commit_of, git

LAB_FOLDER = '.verifold'
"""The folder in the project that holds the lab: its record, the agents' folders, and their private files."""

OPENERS = {'darwin': 'open', 'linux': 'xdg-open'}
"""The command that opens a folder in the file manager, for each platform that has one."""

OPEN_SECONDS = 10.0
"""How long the opener may take. Nobody knows what an opener that runs longer did, so it does not count as opened."""

WORKTREE_SECONDS = 1800.0
"""
How long `git worktree add` may run before Verifold ends it. It checks the project's files out with the person's
own filters, which takes long in a large project.
"""

PARTIAL_CLONE = (
    "This repository is a partial clone, and Verifold lets Git fetch nothing when it makes an agent's folder. "
    'When Git says above that it cannot read or fetch an object, the folder needs files that the repository '
    'lacks. `git backfill --no-sparse` in the project fetches them.'
)
"""
What follows Git's error after `git worktree add` failed in a repository that lacks objects by design. It says
what makes the folder possible, as a fact, because an agent with the power to add agents reads it too.
"""


def real_folder(project: Path, agent_id: AgentId | None = None) -> Path:
    """
    Return the folder that holds every agent's folder, or the folder of one agent, when it is safe to open.

    An agent can replace its folder with a link: to a program, which the file manager's opener would start, or to
    another folder, whose files a snapshot would hold. So the folder must be a real folder at its own place in the
    lab's folder, with no link on the way to it.

    Raises:
        NoAgentFolder: The folder does not exist, or it is a link or lies behind one.

    """
    agents = agents_folder(project.resolve())
    folder = agents / agent_id if agent_id else agents
    if not folder.is_dir():
        raise NoAgentFolder(f'{folder} is not a folder on this computer.')
    if folder.resolve() != folder:
        raise NoAgentFolder(f'{folder} is a link to another place, so Verifold does not open it.')
    return folder


def open_folder(folder: Path) -> None:
    """
    Open a folder in the file manager of this computer.

    Raises:
        NoFileManager: The platform has no command that opens a folder, or the command failed or did not end in
            time, as on a computer without a desktop.

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
    except subprocess.TimeoutExpired as error:
        raise NoFileManager(
            f'{name} did not end in {OPEN_SECONDS:g} seconds, so the folder may not be open.'
        ) from error
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

    Git checks the files out with the project's and the person's own filters, and it fetches no object that the
    project's repository lacks. When Git fails, or when Verifold ends it, Verifold removes what Git made of the
    folder. So a folder that this returns is one that Git made whole.

    Raises:
        GitTimeout: Git did not end in time, and Verifold ended it.
        GitError: Git could not make the folder. In a partial clone, the message says what to do.

    """
    folder = agents_folder(project) / agent_id
    if folder.exists():
        return folder
    folder.parent.mkdir(parents=True, exist_ok=True)
    if await commit_of(project, 'HEAD') is None:
        folder.mkdir()
        try:
            await git('init', '--quiet', cwd=folder)
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return folder
    await _exclude_lab_folder(project)
    branch = f'verifold/{agent_id}'
    existing = await git('branch', '--list', branch, cwd=project)
    names = (str(folder), branch) if existing else ('-b', branch, str(folder))
    try:
        no_fetch = {'GIT_NO_LAZY_FETCH': '1'}
        await git('worktree', 'add', '--quiet', *names, cwd=project, env=no_fetch, seconds=WORKTREE_SECONDS)
    except BaseException as error:
        # Also at a cancel, which ends Git in the middle of the checkout.
        await _discard(project, folder)
        if isinstance(error, GitError) and not isinstance(error, GitTimeout) and await _partial_clone(project):
            raise GitError(f'{error}\n{PARTIAL_CLONE}') from error
        raise
    return folder


async def _discard(project: Path, folder: Path) -> None:
    # Remove what `git worktree add` left when it did not end well: the folder, and the worktree's entry in the
    # project's repository, which Git locks until the worktree is whole. Git removes both when it fails by
    # itself, and neither when Verifold ends it.
    try:
        with suppress(GitError):
            await git('worktree', 'remove', '--force', '--force', str(folder), cwd=project)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


async def _partial_clone(project: Path) -> bool:
    # Whether the project's repository names a remote for the objects that it lacks, as a partial clone does.
    try:
        return bool(
            await git('config', '--get-regexp', r'^(extensions\.partialclone|remote\..*\.promisor)$', cwd=project)
        )
    except GitError:
        return False


async def _exclude_lab_folder(project: Path) -> None:
    exclude = Path(await git('rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', cwd=project))
    rule = f'/{LAB_FOLDER}/'
    lines = exclude.read_text().splitlines() if exclude.exists() else []
    if rule not in lines:
        exclude.parent.mkdir(parents=True, exist_ok=True)
        exclude.write_text('\n'.join([*lines, rule]) + '\n')
