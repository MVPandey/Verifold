import hashlib
import zlib
from dataclasses import replace
from pathlib import Path

import pytest

from verifold.runner.folders import agent_folder
from verifold.runner.git import GitError, git
from verifold.runner.objects import Missing, PinnedCommit, Running, TooLarge, fetches_nothing, file_bytes
from verifold.runner.snapshots import pin, snapshot

LIMIT = 1_000


async def committed(path: Path) -> Path:
    path.mkdir()
    (path / 'data.csv').write_text('x,y\n1,2\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=path)
    await git('add', '.', cwd=path)
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Start', cwd=path)
    return path


def at(project: Path, commit: str) -> PinnedCommit:
    """Return a commit of ada's as a post pins it, for the Git of this computer."""
    return PinnedCommit(
        project=project.resolve(),
        author='ada',
        commit=commit,
        seconds=30,
        fetches_nothing=fetches_nothing(),
        running=Running(),
    )


async def a_pin(project: Path) -> PinnedCommit:
    """Give ada files that a post pins, with later work after it, and return the pinned commit."""
    project.mkdir(exist_ok=True)
    author = await agent_folder(project, 'ada')
    (author / 'result.txt').write_text('11.8')
    (author / 'out' / 'deep').mkdir(parents=True)
    (author / 'out' / 'deep' / 'a.json').write_text('{}')
    (author / 'link').symlink_to('result.txt')
    # A repository inside the folder, which a snapshot holds as a submodule without its files.
    await committed(author / 'module')
    pinned = await pin(author, 'ada', ('result.txt',))
    (author / 'result.txt').write_text('changed later')
    (author / 'out' / 'deep' / 'a.json').write_text('{"later": true}')
    await snapshot(author, 'ada')
    return at(project, pinned[0].commit)


def loose(repository: Path, name: str) -> Path:
    """Return the file of a loose object, made writable."""
    path = repository / '.git' / 'objects' / name[:2] / name[2:]
    path.chmod(0o644)
    return path


async def hand_made(author: Path, listing: bytes) -> str:
    """Write a top tree into a repository as it is given, without Git's own checks, and return a commit of it."""
    store = b'tree ' + str(len(listing)).encode() + b'\0' + listing
    tree = hashlib.sha1(store, usedforsecurity=False).hexdigest()
    path = author / '.git' / 'objects' / tree[:2] / tree[2:]
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(zlib.compress(store))
    return await git('-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit-tree', tree, '-m', 'x', cwd=author)


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_file_is_read_at_the_pinned_commit_from_the_projects_repository_or_the_authors(
    tmp_path: Path, *, with_commits: bool
) -> None:
    project = await committed(tmp_path / 'project') if with_commits else tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'

    # In a project with commits the folder is a worktree of the project, and else a repository of its own.
    assert (author / '.git').is_file() == with_commits
    # The file has the bytes of the pinned commit, and not the later ones of the folder or of a later snapshot.
    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'
    assert file_bytes(pinned, 'out/deep/a.json', LIMIT) == b'{}'
    assert (author / 'result.txt').read_text() == 'changed later'
    if with_commits:
        assert file_bytes(pinned, 'data.csv', LIMIT) == b'x,y\n1,2\n'


async def test_a_file_over_the_limit_and_a_path_that_names_no_plain_file_are_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)

    # A file of exactly the limit is read, and one byte more is too many.
    assert file_bytes(pinned, 'result.txt', 4) == b'11.8'
    with pytest.raises(TooLarge, match='it is a blob of 4 bytes'):
        file_bytes(pinned, 'result.txt', 3)
    # A folder, a link, and a submodule are no files, at the path's end and on the way to it.
    no_files = {
        'out': 'out is a folder',
        'out/deep': 'deep is a folder',
        'link': 'link is a link',
        'module': 'module is a submodule',
        'result.txt/x': 'result.txt is a file',
        'link/x': 'link is a link',
        'module/data.csv': 'module is a submodule',
    }
    for path, why in no_files.items():
        with pytest.raises(GitError, match=f'{why} in the pinned commit') as refused:
            file_bytes(pinned, path, LIMIT)
        assert not isinstance(refused.value, Missing | TooLarge), path
    # A name that the commit does not have is missing, and so is a commit that no repository of the lab has.
    for path in ('none.txt', 'out/none.json', 'none/a.json', 'out//deep/a.json', '/result.txt', ''):
        with pytest.raises(Missing, match='The pinned commit has no'):
            file_bytes(pinned, path, LIMIT)
    with pytest.raises(Missing, match='No repository of the lab has the commit deadbeef'):
        file_bytes(replace(pinned, commit='deadbeef' * 5), 'result.txt', LIMIT)
    with pytest.raises(Missing, match='No repository of the lab has the commit'):
        file_bytes(replace(pinned, author='zed'), 'result.txt', LIMIT)


async def test_a_listing_that_git_never_makes_is_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    blob = bytes.fromhex(await git('hash-object', '-w', '--stdin', cwd=author))

    # An entry of a kind that Git does not have, and listings that end inside an ID and inside a name.
    odd = await hand_made(author, b'100000 odd\0' + blob)
    with pytest.raises(GitError, match='odd is an entry of no kind that Verifold reads'):
        file_bytes(at(project, odd), 'odd', LIMIT)
    for listing in (b'100644 result.txt\0' + blob[:10], b'100644 a.txt\0' + blob + b'100644 result.txt'):
        cut = await hand_made(author, listing)
        with pytest.raises(GitError, match='ends inside an entry'):
            file_bytes(at(project, cut), 'result.txt', LIMIT)


async def test_a_replaced_object_is_not_read_and_a_changed_one_is_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    blob = await git('rev-parse', f'{pinned.commit}:result.txt', cwd=author)
    tree = await git('rev-parse', f'{pinned.commit}^{{tree}}', cwd=author)
    later = await git('rev-parse', 'refs/verifold/agents/ada', cwd=author)
    changed = await git('rev-parse', f'{later}:result.txt', cwd=author)
    refused = 'is not the object that its ID names|Git ended before it gave every object'

    # Git is told to give the later commit and the later file in the place of the pinned ones. `git show` then
    # gives the later text, and Verifold still reads the pinned one.
    await git('replace', pinned.commit, later, cwd=author)
    await git('replace', blob, changed, cwd=author)
    assert await git('show', f'{pinned.commit}:result.txt', cwd=author) == 'changed later'
    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'
    # The file's object holds other bytes under the same name.
    kept = loose(author, blob).read_bytes()
    loose(author, blob).write_bytes(zlib.compress(b'blob 4\x0099.9'))
    with pytest.raises(GitError, match=refused):
        file_bytes(pinned, 'result.txt', LIMIT)
    loose(author, blob).write_bytes(kept)
    # The tree's object names the later file under the same name.
    kept = loose(author, tree).read_bytes()
    listing = b'100644 result.txt\0' + bytes.fromhex(changed)
    loose(author, tree).write_bytes(zlib.compress(b'tree ' + str(len(listing)).encode() + b'\0' + listing))
    with pytest.raises(GitError, match=refused):
        file_bytes(pinned, 'result.txt', LIMIT)
    loose(author, tree).write_bytes(kept)

    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'


async def test_a_read_runs_no_command_of_the_repository_and_fetches_no_file_that_it_lacks(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    blob = await git('rev-parse', f'{pinned.commit}:result.txt', cwd=author)
    ran = tmp_path / 'ran'
    # The author's repository names a command wherever Git's configuration can: a file watcher, hooks, a filter,
    # a pager, an editor, and a remote for objects that it lacks, over a transport that runs a command.
    hooks = author / '.git' / 'hooks'
    hooks.mkdir(exist_ok=True)
    for hook in ('reference-transaction', 'post-index-change', 'pre-auto-gc', 'post-checkout'):
        (hooks / hook).write_text(f'#!/bin/sh\ntouch {ran}-hook\n')
        (hooks / hook).chmod(0o755)
    config = author / '.git' / 'config'
    config.write_text(
        config.read_text()
        + f'[core]\n\tfsmonitor = touch {ran}-fsmonitor\n\tsshCommand = touch {ran}-ssh; false\n'
        + f'\tpager = touch {ran}-pager\n\teditor = touch {ran}-editor\n\talternateRefsCommand = touch {ran}-alt\n'
        + f'[filter "evil"]\n\tclean = touch {ran}-clean; cat\n\tsmudge = touch {ran}-smudge; cat\n'
        + '[extensions]\n\tpartialClone = evil\n'
        + f'[remote "evil"]\n\turl = ext::touch {ran}-ext\n\tpromisor = true\n\tpartialclonefilter = blob:none\n'
        + '[protocol "ext"]\n\tallow = always\n'
    )

    # A file that the repository has is read, and one whose object is gone is missing.
    assert file_bytes(pinned, 'out/deep/a.json', LIMIT) == b'{}'
    loose(author, blob).unlink()
    with pytest.raises(Missing, match='does not have the object'):
        file_bytes(pinned, 'result.txt', LIMIT)
    # With a Git from before 2.45, Verifold reads no repository whose configuration names such a remote.
    with pytest.raises(GitError, match='names a remote for objects that it lacks'):
        file_bytes(replace(pinned, fetches_nothing=False), 'out/deep/a.json', LIMIT)

    assert sorted(path.name for path in tmp_path.glob('ran*')) == []
