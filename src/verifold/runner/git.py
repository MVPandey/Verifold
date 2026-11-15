"""Git commands that run with a clean environment."""

import asyncio
import os
from asyncio.subprocess import PIPE
from collections.abc import Mapping
from pathlib import Path

from verifold.runner.environment import clean_environment
from verifold.runner.errors import RunnerError

GIT_OPTIONS = ('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=false', '-c', 'protocol.allow=never')  # fmt: skip
"""
Options of every Git command that reads the objects of a pinned commit: no hook, no file watcher, and no transport.
A repository's own `protocol.<name>.allow` overrides `protocol.allow`, so that option alone stops no fetch from a
repository that an agent can write. `GIT_NO_LAZY_FETCH` does. With a Git that does not know it, Verifold reads a
repository's configuration itself first, and reads no repository whose configuration can make Git fetch.
"""

GIT_ENVIRONMENT = {
    'GIT_NO_LAZY_FETCH': '1',
    'GIT_NO_REPLACE_OBJECTS': '1',
    'GIT_CONFIG_GLOBAL': os.devnull,
    'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_ATTR_NOSYSTEM': '1',
    'GIT_TERMINAL_PROMPT': '0',
}
"""Git fetches no object that a repository lacks, replaces none, and reads no configuration of the person or the system."""


class GitError(RunnerError):
    """A Git command failed. The message holds Git's own error output."""


async def git(*args: str, cwd: Path, env: Mapping[str, str] | None = None, strip: bool = True) -> str:
    """
    Run `git` with `args` in `cwd`, and return its standard output, stripped unless `strip` is false.

    `env` adds variables to the clean environment, such as a temporary `GIT_INDEX_FILE`.

    Raises:
        GitError: Git exited with an error.

    """
    process = await asyncio.create_subprocess_exec(
        'git',
        *args,
        cwd=cwd,
        env=clean_environment() | dict(env or {}),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=PIPE,
        stderr=PIPE,
    )
    output, errors = await process.communicate()
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
