"""Git commands that run with a clean environment."""

import asyncio
from asyncio.subprocess import PIPE
from collections.abc import Mapping
from pathlib import Path

from verifold.runner.environment import clean_environment
from verifold.runner.errors import RunnerError


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
