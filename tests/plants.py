"""What an agent can put into a repository that it can write, for the tests of what reads such a repository."""

import os
import shutil
import zlib
from contextlib import suppress
from pathlib import Path

import pytest

from verifold.runner import objects
from verifold.runner.git import GIT_ENVIRONMENT, GitError, git

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
off, and the tests' empty home has none of the person's, so only the repository's own settings count.
"""


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
        await git(*named, 'cat-file', '-e', name, cwd=folder, env=PLAIN_GIT)
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
