import hashlib
import os
import re
import shutil
import zlib
from dataclasses import replace
from pathlib import Path

import pytest
from plants import (
    BEFORE,
    FORMS,
    SENTENCE,
    fires,
    mine,
    no_fetch_switch,
    old_pin,
    old_snapshot,
    plain_git,
    plant,
    remote,
    spoil,
)

from verifold.runner import objects
from verifold.runner.folders import agent_folder
from verifold.runner.git import GIT_ENVIRONMENT, MAX_SMALL_FILE, GitError, git, own_repository
from verifold.runner.objects import Missing, NoRepository, Objects, PinnedCommit, Running, TooLarge, file_bytes
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
    """Return a commit of ada's as a post pins it."""
    return PinnedCommit(project=project.resolve(), author='ada', commit=commit, seconds=30, running=Running())


async def a_pin(project: Path) -> PinnedCommit:
    """
    Give ada files that a post pinned before Verifold kept the snapshots in its own Git directory, and later work.

    The pinned commit, which this returns, is in the project's repository or in the author's own.
    """
    project.mkdir(exist_ok=True)
    author = await agent_folder(project, 'ada')
    (author / 'result.txt').write_text('11.8')
    (author / 'out' / 'deep').mkdir(parents=True)
    (author / 'out' / 'deep' / 'a.json').write_text('{}')
    (author / 'link').symlink_to('result.txt')
    # A repository inside the folder, which a snapshot holds as a submodule without its files.
    await committed(author / 'module')
    pinned = await old_pin(author, 'ada', ('result.txt',))
    (author / 'result.txt').write_text('changed later')
    (author / 'out' / 'deep' / 'a.json').write_text('{"later": true}')
    await old_snapshot(author, 'ada')
    return at(project, pinned[0].commit)


def loose(store: Path, name: str) -> Path:
    """Return the file of a loose object in an object store, made writable."""
    path = store / name[:2] / name[2:]
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
        # The project's repository has the commit also when the author's folder is gone.
        shutil.rmtree(author)
        assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_file_that_verifold_pinned_in_its_own_directory_is_read_after_the_author_deleted_the_whole_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, with_commits: bool
) -> None:
    project = await committed(tmp_path / 'project') if with_commits else tmp_path / 'project'
    project.mkdir(exist_ok=True)
    author = await agent_folder(project, 'ada')
    (author / 'result.txt').write_text('11.8')
    pinned = await pin(project, 'ada', ('result.txt',))
    (author / 'result.txt').write_text('changed later')
    await snapshot(project, 'ada')
    # No repository of the lab has the commit: Git itself, in the author's folder, does not find it.
    with pytest.raises(GitError):
        await plain_git('cat-file', '-e', pinned[0].commit, cwd=author)
    shutil.rmtree(author)
    looked: list[Path] = []
    monkeypatch.setattr(objects, '_store', looked.append)

    # Verifold's own store has the commit, so the read looks for no store of the project or of the author.
    assert file_bytes(at(project, pinned[0].commit), 'result.txt', LIMIT) == b'11.8'
    assert looked == []


async def test_a_file_over_the_limit_and_a_path_that_names_no_plain_file_are_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)

    # A file of exactly the limit is read, and one byte more is too many.
    assert file_bytes(pinned, 'result.txt', 4) == b'11.8'
    with pytest.raises(TooLarge, match=re.escape('result.txt has 4 bytes, and this read takes at most 3')):
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
    # A name that the commit does not have is missing, and so is a commit that the author's repository lacks.
    for path in ('none.txt', 'out/none.json', 'none/a.json', 'out//deep/a.json', '/result.txt', ''):
        with pytest.raises(Missing, match='The pinned commit has no'):
            file_bytes(pinned, path, LIMIT)
    with pytest.raises(Missing, match='No repository of the lab has the commit deadbeef'):
        file_bytes(replace(pinned, commit='deadbeef' * 5), 'result.txt', LIMIT)
    # An author without a folder has no repository. That is another error than a file that the commit lacks.
    with pytest.raises(NoRepository, match='found no repository of the lab that it can read') as none:
        file_bytes(replace(pinned, author='zed'), 'result.txt', LIMIT)
    assert not isinstance(none.value, Missing)


async def test_a_listing_that_git_never_makes_or_that_is_too_large_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    blob = bytes.fromhex(await git('hash-object', '-w', '--stdin', cwd=author))
    one = b'100644 result.txt\0' + blob

    # An entry of a kind that Git does not have, and listings that end inside an ID and inside a name.
    odd = await hand_made(author, b'100000 odd\0' + blob)
    with pytest.raises(GitError, match='odd is an entry of no kind that Verifold reads'):
        file_bytes(at(project, odd), 'odd', LIMIT)
    for listing in (b'100644 result.txt\0' + blob[:10], b'100644 a.txt\0' + blob + b'100644 result.txt'):
        cut = await hand_made(author, listing)
        with pytest.raises(GitError, match='ends inside an entry'):
            file_bytes(at(project, cut), 'result.txt', LIMIT)
    # An entry that calls a folder's listing a file.
    listing = await git('rev-parse', f'{odd}^{{tree}}', cwd=author)
    wrong = await hand_made(author, b'100644 result.txt\0' + bytes.fromhex(listing))
    with pytest.raises(GitError, match=f'The object {listing} is a tree, and Verifold reads a blob there'):
        file_bytes(at(project, wrong), 'result.txt', LIMIT)
    # One name twice, also when the path asks for another name of that listing.
    twice = await hand_made(author, one + one + b'100644 other.txt\0' + blob)
    for path in ('result.txt', 'other.txt'):
        with pytest.raises(GitError, match='has one name twice'):
            file_bytes(at(project, twice), path, LIMIT)
    # A listing over the limit for listings is refused as a listing, and not as a file that is too large.
    large = await hand_made(author, one + b''.join(b'100644 f%d\0' % number + blob for number in range(40)))
    assert file_bytes(at(project, large), 'result.txt', LIMIT) == b''
    monkeypatch.setattr(objects, 'MAX_TREE_BYTES', 500)
    with pytest.raises(
        GitError, match=r'The tree [0-9a-f]{40} has 1,[0-9]{3} bytes, and Verifold reads at most 500'
    ) as big:
        file_bytes(at(project, large), 'result.txt', LIMIT)
    assert not isinstance(big.value, TooLarge)
    monkeypatch.undo()
    # That listing has 41 entries. Verifold reads that many, and not one entry more than the limit.
    monkeypatch.setattr(objects, 'MAX_FOLDER_ENTRIES', 41)
    assert file_bytes(at(project, large), 'result.txt', LIMIT) == b''
    monkeypatch.setattr(objects, 'MAX_FOLDER_ENTRIES', 40)
    with pytest.raises(GitError, match=r'The listing of the folder [0-9a-f]{40} has more than 40 entries'):
        file_bytes(at(project, large), 'result.txt', LIMIT)


async def test_a_replaced_object_is_not_read_and_a_changed_one_is_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    store = author / '.git' / 'objects'
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
    kept = loose(store, blob).read_bytes()
    loose(store, blob).write_bytes(zlib.compress(b'blob 4\x0099.9'))
    with pytest.raises(GitError, match=refused):
        file_bytes(pinned, 'result.txt', LIMIT)
    loose(store, blob).write_bytes(kept)
    # The tree's object names the later file under the same name.
    kept = loose(store, tree).read_bytes()
    listing = b'100644 result.txt\0' + bytes.fromhex(changed)
    loose(store, tree).write_bytes(zlib.compress(b'tree ' + str(len(listing)).encode() + b'\0' + listing))
    with pytest.raises(GitError, match=refused):
        file_bytes(pinned, 'result.txt', LIMIT)
    loose(store, tree).write_bytes(kept)

    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'


@pytest.mark.parametrize(
    ('with_commits', 'form'), [*((False, form) for form in FORMS), *((True, form) for form in BEFORE)]
)
async def test_git_asks_no_remote_that_a_repository_names_for_an_object_that_it_lost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, with_commits: bool, form: str
) -> None:
    project = await committed(tmp_path / 'project') if with_commits else tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    blob = await git('rev-parse', f'{pinned.commit}:result.txt', cwd=author)
    ran = tmp_path / 'ran'
    # The repository whose configuration Git reads in the author's folder names a remote for the objects that it
    # lacks, over a transport that runs a command. In a project with commits that is the project's own repository.
    store = plant(project / '.git' if with_commits else author / '.git', form, ran, tmp_path / 'aside.git')
    loose(store, blob).unlink()
    no_fetch_switch(monkeypatch)

    # Git itself, asked in the author's folder for the lost file, runs the command.
    assert await fires(author, blob, ran)
    # Verifold reads a file that the repository has, and says that the lost one is missing.
    assert file_bytes(pinned, 'out/deep/a.json', LIMIT) == b'{}'
    with pytest.raises(Missing, match='does not have the object'):
        file_bytes(pinned, 'result.txt', LIMIT)
    assert not ran.exists()


async def test_a_project_that_git_opens_only_with_the_persons_own_settings_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await committed(tmp_path / 'project')
    pinned = await a_pin(project)
    # Git takes every repository that it finds as another user's, as it takes a project that needs the person's
    # `safe.directory` setting. Without the person's and the system's settings, it then opens no repository in the
    # project.
    other_owner = {'GIT_TEST_ASSUME_DIFFERENT_OWNER': '1'}
    with pytest.raises(GitError, match='dubious ownership'):
        await git('rev-parse', '--git-dir', cwd=project, env={**GIT_ENVIRONMENT, **other_owner})
    monkeypatch.setattr(objects, 'GIT_ENVIRONMENT', {**GIT_ENVIRONMENT, **other_owner})

    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'


@pytest.mark.parametrize('name', ['.git', 'commondir'])
async def test_a_file_that_names_a_git_directory_is_followed_only_when_it_is_a_small_plain_file(
    tmp_path: Path, name: str
) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    moved, outside = tmp_path / 'moved.git', tmp_path / 'outside'
    if name == '.git':
        # The author's folder names its Git directory in a file, as a worktree does.
        (author / '.git').rename(moved)
        file, names = author / '.git', f'gitdir: {moved}\n'
    else:
        # The author's Git directory names the directory that has the objects, as a worktree's does.
        shutil.copytree(author / '.git', moved)
        shutil.rmtree(author / '.git' / 'objects')
        file, names = author / '.git' / 'commondir', f'{moved}\n'
    outside.write_text(names)

    file.write_text(names)
    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'
    # A pipe, a link, and a file that is too large are not read, and the read ends at once with the reason.
    shapes = {
        'a pipe': os.mkfifo,
        'a link': lambda path: path.symlink_to(outside),
        'large': lambda path: path.write_text(names + '#' * MAX_SMALL_FILE),
    }
    start = re.escape(str(author / '.git'))
    unread = 'is no plain text file of at most 4,096 bytes' if name == '.git' else 'leads to a `commondir` file that'
    for make in shapes.values():
        file.unlink()
        make(file)
        with pytest.raises(NoRepository, match=f'found no repository of the lab that it can read .* {start} {unread}'):
            file_bytes(pinned, 'result.txt', LIMIT)
    # A file that names no Git directory, or a directory without objects.
    file.unlink()
    file.write_text('x\n')
    nothing = 'names no Git directory' if name == '.git' else 'leads to no folder of Git objects'
    with pytest.raises(NoRepository, match=f'{start} {nothing}'):
        file_bytes(pinned, 'result.txt', LIMIT)


@pytest.mark.parametrize('place', ['gitdir', 'commondir', 'the path of commondir'])
async def test_an_error_holds_no_text_that_a_file_of_the_authors_folder_names(tmp_path: Path, place: str) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    if place == 'commondir':
        (author / '.git' / 'commondir').write_text(f'{SENTENCE}\n')
    else:
        (author / '.git').rename(tmp_path / 'moved.git')
        (author / '.git').write_text(f'gitdir: {SENTENCE}\n')
    if place == 'the path of commondir':
        # The `.git` file names a directory that is there, and whose `commondir` is no file that Verifold reads.
        (author / SENTENCE).mkdir(parents=True)
        os.mkfifo(author / SENTENCE / 'commondir')

    with pytest.raises(NoRepository) as refused:
        file_bytes(pinned, 'result.txt', LIMIT)

    # The error names the `.git` of the folder, which is Verifold's own path, and nothing that a file there holds.
    no_file = 'leads to a `commondir` file that is no small plain text file'
    why = no_file if place == 'the path of commondir' else 'leads to no folder of Git objects'
    assert str(refused.value) == (
        f'Verifold found no repository of the lab that it can read and that has the commit {pinned.commit}. '
        f'{author / ".git"} {why}.'
    )


def test_an_error_names_no_kind_of_object_that_git_does_not_have(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A stand-in for Git that gives an object a kind of its own.
    (tmp_path / 'git').write_text('#!/bin/sh\nread name\necho "$name sentence 4"\ncat > /dev/null\n')
    (tmp_path / 'git').chmod(0o755)
    monkeypatch.setenv('PATH', f'{tmp_path}{os.pathsep}{os.environ["PATH"]}')
    reader = Objects(tmp_path, tmp_path, tmp_path, 30)

    try:
        with pytest.raises(GitError, match='Git gave no kind and size that Verifold knows') as refused:
            reader.ask('ab' * 20)
    finally:
        reader.close()
    assert 'sentence' not in str(refused.value)


async def test_git_reads_the_configuration_that_verifold_wrote_and_no_other_in_its_own_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    blob = await git('rev-parse', f'{pinned.commit}:result.txt', cwd=author)
    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'
    own = project / '.verifold' / 'snapshots.git'
    written = (own / 'config').read_text()
    ran = tmp_path / 'ran'
    loose(author / '.git' / 'objects', blob).unlink()
    no_fetch_switch(monkeypatch)

    # Somebody adds the remote to the configuration of Verifold's own directory. Git itself would then ask it.
    (own / 'config').write_text(written + remote(ran))
    assert await fires(tmp_path, blob, ran, own)
    with pytest.raises(Missing, match='does not have the object'):
        file_bytes(pinned, 'result.txt', LIMIT)
    assert (own / 'config').read_text() == written
    # Somebody makes the own directory name another directory for its configuration, which has the remote.
    plant(author / '.git', 'plain', ran, tmp_path / 'aside.git')
    (own / 'commondir').write_text(f'{author / ".git"}\n')
    assert await fires(tmp_path, blob, ran, own)
    with pytest.raises(Missing, match='does not have the object'):
        file_bytes(pinned, 'result.txt', LIMIT)
    assert not ran.exists()
    # A link where the own directory belongs is refused, and nothing is written through it.
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    shutil.rmtree(own)
    own.symlink_to(elsewhere)
    with pytest.raises(GitError, match='is not a folder of yours') as refused:
        file_bytes(pinned, 'out/deep/a.json', LIMIT)
    assert not isinstance(refused.value, Missing)
    assert list(elsewhere.iterdir()) == []


async def test_a_pipe_in_the_object_store_ends_a_read_at_its_time_limit_and_a_stop_ends_it_at_once(
    tmp_path: Path,
) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    # A pipe where Git expects the list of the store's other object stores. Git waits there for ever.
    os.mkfifo(author / '.git' / 'objects' / 'info' / 'alternates')

    with pytest.raises(GitError, match='did not answer in time') as late:
        file_bytes(replace(pinned, seconds=0.05), 'result.txt', LIMIT)
    assert not isinstance(late.value, Missing | NoRepository)
    # After the server stopped, a read ends at once, long before its time limit.
    pinned.running.stop()
    with pytest.raises(GitError, match='did not answer in time'):
        file_bytes(replace(pinned, seconds=600), 'result.txt', LIMIT)


@pytest.mark.parametrize('form', ['other bytes', 'a pipe'])
async def test_a_store_of_the_authors_own_takes_no_commit_away_that_the_projects_repository_has(
    tmp_path: Path, form: str
) -> None:
    project = await committed(tmp_path / 'project')
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    mine(author, form, pinned.commit)

    # The project's store is read first. So the read does not fail, and it does not wait for the other store.
    assert file_bytes(replace(pinned, seconds=600), 'result.txt', LIMIT) == b'11.8'


@pytest.mark.parametrize(
    ('before', 'form'),
    [("Verifold's own", 'other bytes'), ("Verifold's own", 'a pipe')]
    + [("the project's", form) for form in ('other bytes', 'a pipe', 'no commit')],
)
async def test_the_next_store_gets_its_turn_when_one_fails_in_any_way(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, before: str, form: str
) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    if before == "Verifold's own":
        # Verifold's own store comes first. It never had the commit, and now it does not answer for it either.
        store = own_repository(project / '.verifold') / 'objects'
    else:
        # The project becomes a repository after the author's folder. Its store comes before the author's and
        # does not give the commit.
        await git('init', '--quiet', cwd=project)
        store = project / '.git' / 'objects'
    if (before, form) == ("Verifold's own", 'a pipe'):
        # Verifold removes a list of other stores from its own store, so the pipe is where the commit's file belongs.
        (store / pinned.commit[:2]).mkdir()
        os.mkfifo(store / pinned.commit[:2] / pinned.commit[2:])
    elif form != 'no commit':
        spoil(store, form, pinned.commit)
    if form == 'a pipe':
        # Git waits in that store for its share of the time, which is a few hundredths of a second here.
        monkeypatch.setattr(objects, 'FIRST_STORE_SHARE', 0.0001)

    # The author's store has the rest of the time, which is long.
    assert file_bytes(replace(pinned, seconds=600), 'result.txt', LIMIT) == b'11.8'


async def test_the_authors_folder_is_looked_at_only_after_the_projects_store_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await committed(tmp_path / 'project')
    pinned = await a_pin(project)
    author = pinned.project / '.verifold' / 'agents' / 'ada'
    looked: list[Path] = []
    store_of = objects._store

    def noting(folder: Path) -> Path | None:
        looked.append(folder)
        return store_of(folder)

    monkeypatch.setattr(objects, '_store', noting)

    # The project's store gives the file, so the read looks at nothing in the author's folder.
    assert file_bytes(pinned, 'result.txt', LIMIT) == b'11.8'
    assert looked == [pinned.project]
    # The project's store lacks a commit, and only then the read looks at the author's folder.
    with pytest.raises(Missing, match='No repository of the lab has the commit deadbeef'):
        file_bytes(replace(pinned, commit='deadbeef' * 5), 'result.txt', LIMIT)
    assert looked == [pinned.project, pinned.project, author]


async def test_the_error_of_stores_that_all_fail_is_the_one_that_says_most(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    pinned = await a_pin(project)
    author = project / '.verifold' / 'agents' / 'ada'
    store = author / '.git' / 'objects'
    blob = await git('rev-parse', f'{pinned.commit}:result.txt', cwd=author)
    await git('init', '--quiet', cwd=project)
    wrong = 'is not the object that its ID names|Git ended before it gave every object'

    # The project's store lacks the commit, and the author's has it with a file that holds other bytes.
    kept = loose(store, blob).read_bytes()
    loose(store, blob).write_bytes(zlib.compress(b'blob 4\x0099.9'))
    with pytest.raises(GitError, match=wrong) as refused:
        file_bytes(pinned, 'result.txt', LIMIT)
    assert not isinstance(refused.value, Missing)
    # The author's store has the commit and lacks the file, and the project's holds other bytes under the commit's ID.
    loose(store, blob).unlink()
    spoil(project / '.git' / 'objects', 'other bytes', pinned.commit)
    with pytest.raises(Missing, match=f'does not have the object {blob}'):
        file_bytes(pinned, 'result.txt', LIMIT)
    # Only the author's store lacks the commit now.
    (store / blob[:2] / blob[2:]).write_bytes(kept)
    loose(store, pinned.commit).unlink()
    with pytest.raises(GitError, match=wrong) as refused:
        file_bytes(pinned, 'result.txt', LIMIT)
    assert not isinstance(refused.value, Missing)
