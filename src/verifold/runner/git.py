"""Git commands that run with a clean environment."""

import asyncio
from asyncio.subprocess import PIPE
from pathlib import Path

from verifold.runner.environment import clean_environment
from verifold.runner.errors import RunnerError


class GitError(RunnerError):
    """A Git command failed. The message holds Git's own error output."""


async def git(*args: str, cwd: Path) -> str:
    """
    Run `git` with `args` in `cwd`, and return its standard output without surrounding whitespace.

    Raises:
        GitError: Git exited with an error.

    """
    process = await asyncio.create_subprocess_exec(
        'git', *args, cwd=cwd, env=clean_environment(), stdin=asyncio.subprocess.DEVNULL, stdout=PIPE, stderr=PIPE
    )
    output, errors = await process.communicate()
    if process.returncode:
        raise GitError(f'git {" ".join(args)} failed: {errors.decode(errors="replace").strip()}')
    return output.decode().strip()


async def has_commits(folder: Path) -> bool:
    """Return whether `folder` is inside a Git repository that has at least one commit."""
    try:
        await git('rev-parse', '--verify', '--quiet', 'HEAD', cwd=folder)
    except GitError:
        return False
    return True
