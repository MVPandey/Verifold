"""The folders where agents work."""

import asyncio
import os
import shutil
import stat
import subprocess
import sys
from collections.abc import Generator
from contextlib import contextmanager, suppress
from pathlib import Path

from verifold.protocol.ids import AgentId
from verifold.runner.errors import NoAgentFolder, NoFileManager
from verifold.runner.git import GitCut, GitError, commit_of, git, unlock

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
    'lacks. Git fetches them for a worktree that is added by hand: `git worktree add --detach <a new folder> HEAD` '
    'in the project, and then `git worktree remove <that folder>`.'
)
"""
What follows Git's error after `git worktree add` failed in a repository that lacks objects by design. It says
what makes the folder possible, as a fact, because an agent with the power to add agents reads it too. The
command is the one that Verifold runs, so it fetches what the folder needs and no more, with any version of Git.
"""

type _Made = int
"""
The handle of the folder that a call made, held open until the call ends. It tells that folder from any other one
at its path. A folder's number alone does not: a file system gives a removed folder's number to the next new one.
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

    Verifold makes the folder itself, empty, holds it open, and Git fills it. Git checks the files out with the
    project's and the person's own filters, and it fetches no object that the project's repository lacks.

    When `git worktree add` fails by itself, it removes what it made, and Verifold removes nothing but the
    folder that this call made, when that folder is empty. When Git is cut, Verifold removes what this call
    made: the folder with what Git put there, the worktree's entry in the project's repository, and the branch
    when the call made that too, with a lock that Git left at it. Git is cut when Verifold ends it, at the time
    limit or because the caller was cancelled, and when a signal of another program ends it. After a `git init`
    that failed in any way, the new folder goes with what Git put there. Verifold never removes what was at the
    path before the call, or another folder that came to the path meanwhile.

    Two things can stay. Git does not always clean up: it cannot when it is killed, and sometimes it leaves an
    empty lock when the signal to end reaches it at the moment when it makes that lock. Then another lock of
    Git's, such as `packed-refs.lock`, can stay in the project's repository, with the branch that the call
    made, or an entry of the worktree without its folder. Git names what stands in its way in its next error,
    and Verifold removes none of these. And when the computer stops, or Verifold is killed, in the middle of a
    call, a folder that Git did not finish can stay, and a later call returns that folder as it is.

    Raises:
        OSError: The system could not say whether the folder is there, or something else made it at that moment.
        GitCut: Git did not end by itself: Verifold ended it at the time limit, or a signal ended it.
        GitError: Git could not make the folder. In a partial clone, the message says what makes it possible.

    """
    folder = agents_folder(project) / agent_id
    if _there(folder):
        return folder
    folder.parent.mkdir(parents=True, exist_ok=True)
    head = await commit_of(project, 'HEAD')
    if head is None:
        with _made(folder) as made:
            try:
                await git('init', '--quiet', cwd=folder)
            except BaseException:
                # Only Git put something into the folder, which this call made empty a moment ago.
                _remove(folder, made, whole=True)
                raise
        return folder
    await _exclude_lab_folder(project)
    branch = f'verifold/{agent_id}'
    existing = await git('branch', '--list', branch, cwd=project)
    names = (str(folder), branch) if existing else ('-b', branch, str(folder))
    with _made(folder) as made:
        try:
            no_fetch = {'GIT_NO_LAZY_FETCH': '1'}
            await git('worktree', 'add', '--quiet', *names, cwd=project, env=no_fetch, seconds=WORKTREE_SECONDS)
        except BaseException as error:
            if isinstance(error, GitCut | asyncio.CancelledError):
                # Git made the branch at the project's last commit, when the call named a new one.
                await _discard(project, folder, made, None if existing else (f'refs/heads/{branch}', head))
                raise
            _remove(folder, made, whole=False)
            if isinstance(error, GitError) and await _partial_clone(project):
                raise GitError(f'{error}\n{PARTIAL_CLONE}') from error
            raise
    return folder


def _there(folder: Path) -> bool:
    """
    Return whether something is at the place of an agent's folder.

    Raises:
        OSError: The system could not say, as without permission to look. That is no sign that nothing is there,
            so the caller makes no folder and removes none.

    """
    try:
        folder.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise OSError(f'Verifold cannot look at {folder}, so it makes no folder there: {error.strerror}.') from error
    return True


@contextmanager
def _made(folder: Path) -> Generator[_Made]:
    """
    Make an agent's folder, empty, and hold it open for as long as the call works on it.

    Only one caller can make the folder, so from here on it is this call's own.

    Raises:
        OSError: Something else made the folder since the caller looked.

    """
    try:
        folder.mkdir()
    except FileExistsError as error:
        raise OSError(f'Something else made {folder} at the same moment, so Verifold leaves it as it is.') from error
    try:
        handle = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        # Without the handle the call cannot fill the folder, and an empty one would pass for the agent's later.
        with suppress(OSError):
            folder.rmdir()
        raise
    try:
        yield handle
    finally:
        os.close(handle)


def _mine(folder: Path, made: _Made) -> bool:
    # Whether the folder at the path is still the one that this call made, and no other that took its place. The
    # call holds its folder open, so no other folder has that folder's device and number.
    try:
        held, now = os.fstat(made), folder.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(now.st_mode) and (now.st_dev, now.st_ino) == (held.st_dev, held.st_ino)


def _remove(folder: Path, made: _Made, *, whole: bool) -> None:
    """
    Remove the folder that this call made, when it is still at its path.

    With `whole`, Git did not remove what it made: it was cut in the middle of its work, or it is `git init`,
    which removes nothing. The folder then goes with what Git put there. Verifold removes that through the
    folder's handle, so it removes nothing of another folder that takes the path meanwhile. Without `whole`,
    `git worktree add` failed by itself and removed what it made. The folder then goes only when it is empty:
    Git also fails because something else put a file there, and that file is not this call's to remove.
    """
    if not _mine(folder, made):
        return
    if whole:
        for name in os.listdir(made):  # noqa: PTH208
            try:
                os.unlink(name, dir_fd=made)
            except OSError:
                shutil.rmtree(name, dir_fd=made, ignore_errors=True)
    with suppress(OSError):
        folder.rmdir()


async def _discard(project: Path, folder: Path, made: _Made, branch: tuple[str, str] | None) -> None:
    """
    Remove what this call made of a worktree, after `git worktree add` was cut.

    That is the folder, the worktree's entry in the project's repository, which Git locks until the worktree is
    whole, and the branch, when Git made it for this call: `branch` holds its ref and the commit that Git made
    it at, and the ref goes only while it still names that commit. So the next call starts at the project's
    last commit of then. A lock that Git left at that ref goes first, when it holds nothing or that commit:
    with the lock there, no later call could make the branch. Git removes the folder and the entry itself when
    SIGTERM ends it. Nothing goes when another folder stands at the path.
    """
    try:
        if _mine(folder, made) or not os.path.lexists(folder):
            with suppress(GitError):
                await git('worktree', 'remove', '--force', '--force', str(folder), cwd=project)
            if branch:
                ref, commit = branch
                with suppress(GitError):
                    held = await git('rev-parse', '--path-format=absolute', '--git-path', f'{ref}.lock', cwd=project)
                    unlock(Path(held), commit)
                    await git('update-ref', '-d', ref, commit, cwd=project)
    finally:
        _remove(folder, made, whole=True)


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
