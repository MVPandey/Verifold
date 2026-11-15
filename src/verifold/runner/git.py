"""Git commands that run with a clean environment, and the Git directory of Verifold's own."""

import asyncio
import os
import secrets
import stat
from asyncio.subprocess import PIPE
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path
from types import MappingProxyType

from verifold.runner.environment import clean_environment
from verifold.runner.errors import RunnerError

HOOKS_OFF = ('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false')
"""Options of every Git command that Verifold runs: no hook and no file watcher, whatever a repository says."""

_TRANSPORT_OFF = ('-c', 'core.sshCommand=false', '-c', 'protocol.allow=never')
"""No transport. Only a command on the Git directory of Verifold's own gets these, with the options above."""

GIT_OPTIONS = (*HOOKS_OFF, *_TRANSPORT_OFF)
"""
Options of every Git command on the Git directory of Verifold's own: no hook, no file watcher, and no transport.
Such a command reads its configuration from that directory, so no repository of the lab changes these options.
"""

GIT_SECONDS = 300.0
"""How long one Git command may run before Verifold ends it."""

GIT_ENVIRONMENT: Mapping[str, str] = MappingProxyType(
    {
        'GIT_NO_LAZY_FETCH': '1',
        'GIT_NO_REPLACE_OBJECTS': '1',
        'GIT_CONFIG_GLOBAL': os.devnull,
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_ATTR_NOSYSTEM': '1',
        'GIT_TERMINAL_PROMPT': '0',
    }
)
"""Git fetches no object that a repository lacks, replaces none, and reads no configuration of the person or the system."""

OWN_REPOSITORY = 'snapshots.git'
"""
The Git directory of Verifold's own, in the lab's folder. It holds the snapshots of the agents' folders. Git also
reads the objects of the lab's repositories through it, so Git reads the configuration that Verifold wrote there
and no configuration of a repository.
"""

MAX_SMALL_FILE = 4096
"""The most bytes of a file that names a Git directory, or of a file of Verifold's own Git directory."""

_OWN_FILES: Mapping[str, str] = MappingProxyType(
    {'HEAD': 'ref: refs/heads/main\n', 'config': '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'}
)
"""The files that make Verifold's own Git directory a bare repository, with the whole text of each."""


class GitError(RunnerError):
    """A Git command failed, or Verifold does not read what a repository holds. The message says which."""


async def git(*args: str, cwd: Path, env: Mapping[str, str] | None = None, strip: bool = True) -> str:
    """
    Run `git` with `args` in `cwd`, and return its standard output, stripped unless `strip` is false.

    Every command has hooks and the file watcher off. `env` adds variables to the clean environment, such as a
    temporary `GIT_INDEX_FILE`.

    Raises:
        GitError: Git exited with an error, or it did not end in `GIT_SECONDS` and Verifold ended it.

    """
    process = await asyncio.create_subprocess_exec(
        'git',
        *HOOKS_OFF,
        *args,
        cwd=cwd,
        env=clean_environment() | dict(env or {}),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=PIPE,
        stderr=PIPE,
    )
    try:
        output, errors = await asyncio.wait_for(process.communicate(), GIT_SECONDS)
    except TimeoutError:
        # Git waits for ever for a pipe where it expects a file, such as an agent's `.gitignore`.
        with suppress(ProcessLookupError):
            process.kill()
        await process.wait()
        raise GitError(f'git {" ".join(args)} did not end in {GIT_SECONDS:g} seconds, so Verifold ended it.') from None
    if process.returncode:
        raise GitError(f'git {" ".join(args)} failed: {errors.decode(errors="replace").strip()}')
    text = output.decode()
    return text.strip() if strip else text


async def commit_of(folder: Path, ref: str) -> str | None:
    """Return the commit that `ref` names in the repository at `folder`, or `None` when it names no commit."""
    try:
        return await git('rev-parse', '--verify', '--quiet', ref, cwd=folder)
    except GitError:
        return None


async def own_git(lab: Path, *args: str, env: Mapping[str, str] | None = None) -> str:
    """
    Run `git` with `args` on the Git directory of Verifold's own, from the lab's folder, and return its output.

    Git reads the configuration that Verifold wrote there, and none of the person, of the system, or of a
    repository of the lab. `GIT_COMMON_DIR` keeps it there also when a file in the directory names another one.
    Git uses no transport, fetches no object, and replaces none.

    Raises:
        GitError: The directory is not a folder of this user's, Git exited with an error, or it did not end in time.

    """
    own = own_repository(lab)
    return await git(
        *_TRANSPORT_OFF,
        f'--git-dir={own}',
        *args,
        cwd=lab,
        env={**GIT_ENVIRONMENT, 'GIT_COMMON_DIR': str(own), **(env or {})},
    )


def own_repository(lab: Path) -> Path:
    """
    Return the Git directory of Verifold's own in the lab's folder, and make it when it is not there.

    Verifold writes the directory itself, so Git reads no template and no configuration of the person to make it.
    Each call checks `HEAD` and `config`, and writes one again when it is not the text that Verifold wrote. It
    removes a `commondir` file: Git keeps its refs in the directory that such a file names, whatever
    `GIT_COMMON_DIR` says.

    Raises:
        GitError: The path holds a link or something that is no folder, the folder is not this user's, or Verifold
            cannot write one of its files.

    """
    home = lab / OWN_REPOSITORY
    refused = f'{home} is not a folder of yours, so Verifold does not use it as its Git directory.'
    try:
        with suppress(FileExistsError):
            home.mkdir(0o700)
        handle = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as error:
        raise GitError(refused) from error
    try:
        if os.fstat(handle).st_uid != os.getuid():
            raise GitError(refused)
        os.fchmod(handle, 0o700)
        for name in ('objects', 'refs'):
            with suppress(FileExistsError):
                os.mkdir(name, 0o700, dir_fd=handle)
        for name, wanted in _OWN_FILES.items():
            if _own_text(handle, name) != wanted:
                _write_own(handle, name, wanted)
        with suppress(FileNotFoundError):
            os.unlink('commondir', dir_fd=handle)
    except OSError as error:
        raise GitError(f'Verifold cannot write its own Git directory {home}: {error}') from error
    finally:
        os.close(handle)
    return home


def small_text(path: Path | str, inside: int | None = None) -> str | None:
    """
    Return the text of a small plain file, or `None` when nothing is at the path.

    The path is relative to the folder with the handle `inside`, when that is given. Verifold reads only a regular
    file here, through no link, and never waits for one: a pipe at the path would hold the read.

    Raises:
        GitError: The path holds a link, a pipe, a folder, a file of more than `MAX_SMALL_FILE` bytes, or bytes
            that are no text.

    """
    refused = f'{path} is no plain text file of at most {MAX_SMALL_FILE:,} bytes, so Verifold does not read it.'
    try:
        file = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=inside)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except (OSError, ValueError) as error:
        raise GitError(refused) from error
    try:
        data = os.read(file, MAX_SMALL_FILE + 1) if stat.S_ISREG(os.fstat(file).st_mode) else None
        if data is None or len(data) > MAX_SMALL_FILE or b'\0' in data:
            raise GitError(refused)
        return data.decode()
    except (OSError, UnicodeDecodeError) as error:
        raise GitError(refused) from error
    finally:
        os.close(file)


def _own_text(home: int, name: str) -> str | None:
    # The text of a file of Verifold's own Git directory, or `None` when the file is not there or is no plain file.
    try:
        return small_text(name, home)
    except GitError:
        return None


def _write_own(home: int, name: str, text: str) -> None:
    # Write a file of Verifold's own Git directory anew: under another name first, and then in the place of what
    # stood there. A link there is replaced as a link.
    fresh = f'.{name}-{secrets.token_hex(8)}'
    file = os.open(fresh, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=home)
    try:
        with os.fdopen(file, 'w') as out:
            out.write(text)
        os.replace(fresh, name, src_dir_fd=home, dst_dir_fd=home)
    except BaseException:
        with suppress(OSError):
            os.unlink(fresh, dir_fd=home)
        raise
