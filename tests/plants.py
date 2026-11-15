"""Git settings that make Git run a command, for the tests of what reads a repository that an agent can write."""

import shutil
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


async def fires(folder: Path, name: str, ran: Path) -> bool:
    """
    Return whether Git itself runs the remote's command when it is asked in `folder` for an object that is not there.

    A plant that does not fire here proves nothing about a reader. The marker is removed again.
    """
    with suppress(GitError):
        await git('cat-file', '-e', name, cwd=folder)
    fired = ran.exists()
    ran.unlink(missing_ok=True)
    return fired


def no_fetch_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    """Take from the reader's Git the variable that tells it to fetch nothing. An older Git does not know it."""
    kept = {name: value for name, value in GIT_ENVIRONMENT.items() if name != 'GIT_NO_LAZY_FETCH'}
    monkeypatch.setattr(objects, 'GIT_ENVIRONMENT', kept)
