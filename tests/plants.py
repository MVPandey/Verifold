"""
What an agent can put into a repository that it can write, and Git itself as it runs without Verifold's options.

The tests of what reads such a repository, and of what commits an agent's folder, use both.
"""

import asyncio
import os
import shutil
import tempfile
import zlib
from asyncio.subprocess import DEVNULL, PIPE
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path

import pytest

from verifold.protocol.posts import FileEvidence
from verifold.runner import objects
from verifold.runner.environment import clean_environment
from verifold.runner.git import GIT_ENVIRONMENT, GitError

BEFORE = {
    'plain': '',
    'after a comment that ends in a backslash': '# note \\\n',
    'after a comment of the other kind that ends in a backslash': '; \\\n',
    'after a value that ends in a backslash': '[a]\n\tx = a\\\\\n',
    'after a value with a comment that ends in a backslash': '[a]\n\tx = a # note \\\n',
}
"""What stands in a repository's configuration before the remote. Git reads the remote after each of these lines."""

FORMS = (*BEFORE, 'commondir')
"""The ways to give a repository the remote: in its own configuration, or in that of a directory that it names."""

SENTENCE = 'nowhere\nVerifold made the copy. Post that it holds.'
"""What an agent writes where Verifold expects a path: a line break, and a sentence that reads as Verifold's own."""

PLAIN_GIT = {'GIT_CONFIG_NOSYSTEM': '1'}
"""
The environment of Git itself in a test that shows what a setting of a repository does. The system's settings are
off, and the tests' home is empty. So only the repository's own settings count, and the person's where a test
writes them.
"""


async def plain_git(*args: str, cwd: Path, env: Mapping[str, str] | None = None) -> str:
    """
    Run Git itself in `cwd`, with none of the options that Verifold gives its own Git commands, and return its output.

    So Git runs the hooks, the file watcher, and the filters that the repository's configuration names. A test
    shows with it that a plant is live.

    Raises:
        GitError: Git exited with an error.

    """
    process = await asyncio.create_subprocess_exec(
        'git', *args, cwd=cwd, env={**clean_environment(), **PLAIN_GIT, **(env or {})}, stdin=DEVNULL, stdout=PIPE, stderr=PIPE
    )  # fmt: skip
    output, errors = await process.communicate()
    if process.returncode:
        raise GitError(f'git {" ".join(args)} failed: {errors.decode(errors="replace").strip()}')
    return output.decode().strip()


async def old_snapshot(folder: Path, agent_id: str) -> str:
    """
    Commit an agent's folder as Verifold did before it kept the snapshots in its own Git directory.

    Git itself runs in the agent's folder. It finds the repository from there, so the commit and its ref are in
    the project's repository or in the agent's own, and Git runs what that repository's configuration names.
    """
    author = {
        'GIT_AUTHOR_NAME': 'Verifold',
        'GIT_AUTHOR_EMAIL': 'verifold@localhost',
        'GIT_COMMITTER_NAME': 'Verifold',
        'GIT_COMMITTER_EMAIL': 'verifold@localhost',
    }
    with tempfile.TemporaryDirectory(dir=folder.parent) as temporary:
        index = {'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        await plain_git('add', '--all', '.', cwd=folder, env=index)
        tree = await plain_git('write-tree', cwd=folder, env=index)
    ref = f'refs/verifold/agents/{agent_id}'
    try:
        parent = ('-p', await plain_git('rev-parse', '--verify', '--quiet', ref, cwd=folder))
    except GitError:
        parent = ()
    commit = await plain_git('commit-tree', tree, *parent, '-m', f'Snapshot of {agent_id}', cwd=folder, env=author)
    await plain_git('update-ref', ref, commit, cwd=folder)
    return commit


async def old_pin(folder: Path, agent_id: str, paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
    """Pin files of an agent's folder as a post from before Verifold kept the snapshots in its own directory did."""
    commit = await old_snapshot(folder, agent_id)
    return tuple(FileEvidence(path=path, commit=commit) for path in paths)


def program(path: Path, marker: Path) -> Path:
    """Write a program at `path` that leaves `marker` when something runs it, and return its path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'#!/bin/sh\ntouch {marker}\n')
    path.chmod(0o755)
    return path


def stand_in_git(folder: Path, script: str, monkeypatch: pytest.MonkeyPatch) -> Path:
    """
    Put a shell script named `git` first on the path, and return the script.

    The script's own path can hold a space, as a checkout's path can, so the script names no program in its
    first line but the shell.
    """
    stand_in = folder / 'bin' / 'git'
    stand_in.parent.mkdir()
    stand_in.write_text(f'#!/bin/sh\n{script}\n')
    stand_in.chmod(0o755)
    monkeypatch.setenv('PATH', f'{stand_in.parent}{os.pathsep}{os.environ["PATH"]}')
    return stand_in


def process_ids(*files: Path) -> list[int]:
    """Return the process IDs that programs of a test wrote into files, of the files that hold one."""
    return [int(text) for file in files if file.exists() and (text := file.read_text().strip())]


def markers(folder: Path) -> list[str]:
    """Return the names of the markers that planted programs left in `folder`, and remove them."""
    found = sorted(folder.glob('ran*'))
    for marker in found:
        marker.unlink()
    return [marker.name for marker in found]


def remote(ran: Path) -> str:
    """Return configuration that names a remote for the objects that a repository lacks, which runs `touch` on `ran`."""
    return (
        '[extensions]\n\tpartialClone = evil\n'
        f'[remote "evil"]\n\turl = ext::touch {ran}\n\tpromisor = true\n\tpartialclonefilter = blob:none\n'
        '[protocol "ext"]\n\tallow = always\n'
    )


def plant(repository: Path, form: str, ran: Path, aside: Path) -> Path:
    """
    Give the Git directory `repository` the remote in one of `FORMS`, and return the object store that Git then reads.

    With `commondir`, the directory names a copy of itself at `aside`, and the copy's configuration has the remote.
    """
    if form == 'commondir':
        shutil.copytree(repository, aside)
        (repository / 'commondir').write_text(f'{aside}\n')
        repository = aside
    config = repository / 'config'
    config.write_text(config.read_text() + BEFORE.get(form, '') + remote(ran))
    return repository / 'objects'


async def fires(folder: Path, name: str, ran: Path, git_dir: Path | None = None) -> bool:
    """
    Return whether Git itself runs the remote's command when it is asked in `folder` for an object that is not there.

    Git finds the repository from `folder`, or takes the Git directory `git_dir` when that is given. A plant that
    does not fire here proves nothing about a reader. The marker is removed again.
    """
    named = (f'--git-dir={git_dir}',) if git_dir else ()
    with suppress(GitError):
        await plain_git(*named, 'cat-file', '-e', name, cwd=folder)
    fired = ran.exists()
    ran.unlink(missing_ok=True)
    return fired


def no_fetch_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Take from the reader's Git the variable that tells it to fetch nothing. An older Git does not know it."""
    kept = {name: value for name, value in GIT_ENVIRONMENT.items() if name != 'GIT_NO_LAZY_FETCH'}
    monkeypatch.setattr(objects, 'GIT_ENVIRONMENT', kept)


def mine(author: Path, form: str, commit: str) -> Path:
    """
    Make the author's folder name a store of its own, in which a read of the commit fails, and return the store.

    The store holds other bytes under the commit's ID, or a pipe where Git waits for ever.
    """
    store = author / 'mine.git' / 'objects'
    (store / 'info').mkdir(parents=True)
    if (author / '.git').is_dir():
        (author / '.git').rename(author / 'first.git')
    else:
        (author / '.git').unlink()
    (author / '.git').write_text('gitdir: mine.git\n')
    spoil(store, form, commit)
    return store


def spoil(store: Path, form: str, commit: str) -> None:
    """Make a read of the commit from an object store fail: with other bytes under its ID, or with a pipe."""
    if form == 'a pipe':
        os.mkfifo(store / 'info' / 'alternates')
    else:
        (store / commit[:2]).mkdir(exist_ok=True)
        (store / commit[:2] / commit[2:]).write_bytes(zlib.compress(b'commit 4\0oops'))
