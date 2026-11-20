import asyncio
import errno
import gc
import hashlib
import os
import shutil
import stat
import threading
import time
import zlib
from collections.abc import Sequence
from datetime import timedelta
from pathlib import Path

import pytest
from builders import START, until
from conftest import agent
from plants import BEFORE, FORMS, SENTENCE, fires, mine, no_fetch_switch, old_pin, old_snapshot, plain_git, plant

from verifold.protocol.agents import ModelSpec
from verifold.protocol.events import Posted
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence, Result
from verifold.protocol.settings import ReviewerSettings, Settings
from verifold.runner import reruns
from verifold.runner.folders import agent_folder
from verifold.runner.git import GitError, git, own_git
from verifold.runner.reruns import LEFTOVER_SECONDS, CleanCopies
from verifold.runner.snapshots import pin, snapshot
from verifold.server.errors import NoCleanCopy
from verifold.server.lab import Lab
from verifold.store.record_file import RecordFile

FILES = {'notes.txt': 'How I got there.', 'result.txt': '11.8'}


async def committed(path: Path) -> Path:
    path.mkdir()
    (path / 'data.csv').write_text('x,y\n1,2\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=path)
    await git('add', '.', cwd=path)
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Start', cwd=path)
    return path


async def a_claim(project: Path, post_id: str = 'p-4', *, own: bool = False) -> Posted:
    """
    Give ada a result file that a post pins, with later work after it, and return the post.

    The post is one from before Verifold kept the snapshots in its own Git directory, so the pinned commit is in
    the project's repository or in the author's own. With `own`, Verifold pins the file as it does now.
    """
    project.mkdir(exist_ok=True)
    author = await agent_folder(project, 'ada')
    (author / 'result.txt').write_text('11.8')
    (author / 'notes.txt').write_text('How I got there.')
    pinned = await (pin(project, 'ada', ('result.txt',)) if own else old_pin(author, 'ada', ('result.txt',)))
    (author / 'result.txt').write_text('changed later')
    (author / 'later.txt').write_text('Work from after the post.')
    await (snapshot(project, 'ada') if own else old_snapshot(author, 'ada'))
    return Posted(seq=7, at=START, post=Result(id=post_id, thread='t-1', author='ada', text='11.8x.', evidence=pinned))


async def clean_copy(project: Path, claim: Posted) -> Path:
    """Return the folder of the clean copy of a post, as the lab makes it and checks it."""
    return (await CleanCopies(project)(claim)).folder


def everything(folder: Path) -> dict[str, str]:
    """Return every file and link under a folder with its text or target, to see that nothing there changed."""
    found: dict[str, str] = {}
    for path in sorted(folder.rglob('*')):
        name = str(path.relative_to(folder))
        if path.is_symlink():
            found[name] = f'-> {path.readlink()}'
        elif path.is_file():
            found[name] = path.read_bytes().decode(errors='replace')
        elif not path.is_dir():
            found[name] = 'special'
    return found


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_clean_copy_is_an_export_of_the_pinned_commit_in_verifolds_own_folder(
    tmp_path: Path, *, with_commits: bool
) -> None:
    project = await committed(tmp_path / 'project') if with_commits else tmp_path / 'project'
    claim = await a_claim(project)
    agents = project / '.verifold' / 'agents'
    await agent_folder(project, 'bo')
    before = everything(agents)

    copy = await clean_copy(project, claim)

    # The copy is in Verifold's own folder, under the post and the pinned commit, and in no agent's folder.
    commit = claim.post.evidence[0].commit
    assert copy == project.resolve() / '.verifold' / 'reruns' / 'p-4' / commit[:12]
    # It holds exactly what the author's snapshot held at the pinned commit: no later file, and no Git.
    assert everything(copy) == FILES | ({'data.csv': 'x,y\n1,2\n'} if with_commits else {})
    # Nobody writes its files, and only this user opens the folders that hold it.
    assert stat.S_IMODE((copy / 'result.txt').stat().st_mode) == 0o444
    assert [stat.S_IMODE(folder.stat().st_mode) for folder in (copy.parent, copy.parent.parent)] == [0o700, 0o700]
    # Making it changed nothing in any agent's folder.
    assert everything(agents) == before
    # A later call returns the same folder, also for another taker.
    assert await clean_copy(project, claim) == copy


async def test_a_later_call_finds_the_copy_by_its_folder_and_its_manifest_file_and_reads_nothing_else(
    tmp_path: Path,
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project, own=True)
    copies = CleanCopies(project)
    made = await copies(claim)

    kept = await copies.kept(claim, made.digest)

    assert kept is not None
    assert (kept.folder, kept.listing, kept.digest, kept.files) == (made.folder, made.listing, made.digest, ())
    # Another SHA-256, a changed manifest, a missing folder, and a link in the folder's place: no copy is there.
    assert await copies.kept(claim, 'ab' * 32) is None
    listing = made.listing.read_bytes()
    made.listing.chmod(0o644)
    made.listing.write_bytes(listing + b'x')
    assert await copies.kept(claim, made.digest) is None
    made.listing.write_bytes(listing)
    assert await copies.kept(claim, made.digest) is not None
    folder = made.folder
    folder.rename(folder.with_name('moved'))
    assert await copies.kept(claim, made.digest) is None
    folder.symlink_to(folder.with_name('moved'))
    assert await copies.kept(claim, made.digest) is None
    # A post without files has no copy.
    bare = claim.model_copy(update={'post': claim.post.model_copy(update={'evidence': ()})})
    assert await copies.kept(bare, made.digest) is None


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_post_that_verifold_pinned_in_its_own_directory_exports_after_the_author_deleted_the_whole_folder(
    tmp_path: Path, *, with_commits: bool
) -> None:
    project = await committed(tmp_path / 'project') if with_commits else tmp_path / 'project'
    claim = await a_claim(project, own=True)
    author = project / '.verifold' / 'agents' / 'ada'
    # No repository of the lab has the commit: Git itself, in the author's folder, does not find it.
    with pytest.raises(GitError):
        await plain_git('cat-file', '-e', claim.post.evidence[0].commit, cwd=author)
    shutil.rmtree(author)

    copy = await clean_copy(project, claim)

    assert everything(copy) == FILES | ({'data.csv': 'x,y\n1,2\n'} if with_commits else {})


async def test_the_copy_holds_the_bytes_that_git_stores_and_a_link_as_a_plain_file(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    # The author's tree asks Git to convert line ends, to expand an ID, and to run a filter. It holds a link, a
    # program, and a folder.
    (author / '.gitattributes').write_text('* text eol=crlf ident filter=evil\n')
    (author / 'lines.txt').write_bytes(b'one\ntwo\n$Id$\n')
    (author / 'link').symlink_to('/etc/hosts')
    (author / 'run.sh').write_text('#!/bin/sh\n')
    (author / 'run.sh').chmod(0o755)
    (author / 'out').mkdir()
    (author / 'out' / 'a.json').write_text('{}')
    pinned = await pin(project, 'ada', ('lines.txt',))
    claim = Posted(seq=7, at=START, post=Result(id='p-4', thread='t-1', author='ada', text='So.', evidence=pinned))

    copy = await clean_copy(project, claim)

    assert (copy / 'lines.txt').read_bytes() == b'one\ntwo\n$Id$\n'
    assert not (copy / 'link').is_symlink()
    assert (copy / 'link').read_text() == '/etc/hosts'
    assert stat.S_IMODE((copy / 'run.sh').stat().st_mode) == 0o555
    assert (copy / 'out' / 'a.json').read_text() == '{}'


async def test_taking_a_rerun_writes_nothing_and_runs_nothing_in_any_agents_folder(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    # The author's files ask Git for a filter, which the author's repository names below.
    (author / '.gitattributes').write_text('* filter=evil\n')
    claim = await a_claim(project)
    commit = claim.post.evidence[0].commit
    taker = await agent_folder(project, 'bo')
    ran = tmp_path / 'ran'
    outside = tmp_path / 'outside'
    (outside / 'p-4').mkdir(parents=True)
    (outside / 'p-4' / 'precious').write_text('x')
    (outside / 'file').write_text('keep')
    # The author's repository names a command where Git runs one at a checkout: hooks, a file watcher, and a filter.
    hooks = author / '.git' / 'hooks'
    hooks.mkdir(exist_ok=True)
    for hook in ('reference-transaction', 'post-index-change', 'post-checkout'):
        (hooks / hook).write_text(f'#!/bin/sh\ntouch {ran}-{hook}\n')
        (hooks / hook).chmod(0o755)
    config = author / '.git' / 'config'
    config.write_text(
        config.read_text()
        + f'[core]\n\tfsmonitor = touch {ran}-fsmonitor\n'
        + f'[filter "evil"]\n\tsmudge = touch {ran}-smudge; cat\n'
    )
    # Git itself runs each of them when it checks the commit out of a copy of that repository.
    shutil.copytree(author, tmp_path / 'unguarded', symlinks=True)
    out = str(tmp_path / 'checked-out')
    await plain_git('worktree', 'add', '--detach', out, commit, cwd=tmp_path / 'unguarded')
    assert sorted(path.name for path in tmp_path.glob('ran*')) == [
        'ran-fsmonitor',
        'ran-post-checkout',
        'ran-post-index-change',
        'ran-reference-transaction',
        'ran-smudge',
    ]
    for marker in tmp_path.glob('ran*'):
        marker.unlink()
    # The taker's folder holds what took Verifold outside before: links, a pipe, and a hard link where the
    # copies were, and a repository with hooks of its own.
    theirs = taker / '.verifold'
    theirs.mkdir()
    (theirs / 'reruns').symlink_to(outside)
    os.mkfifo(theirs / 'pipe')
    os.link(outside / 'file', theirs / 'hard')
    (taker / '.git' / 'hooks').mkdir(exist_ok=True)
    (taker / '.git' / 'hooks' / 'reference-transaction').write_text(f'#!/bin/sh\ntouch {ran}-taker\n')
    (taker / '.git' / 'hooks' / 'reference-transaction').chmod(0o755)
    agents = project / '.verifold' / 'agents'
    before, beyond = everything(agents), everything(outside)

    copy = await clean_copy(project, claim)

    assert everything(copy) == FILES | {'.gitattributes': '* filter=evil\n'}
    assert copy.is_relative_to(project.resolve() / '.verifold' / 'reruns')
    # Nothing in any agent's folder and nothing outside the lab changed, and no command of a repository ran.
    assert everything(agents) == before
    assert everything(outside) == beyond
    assert sorted(path.name for path in tmp_path.glob('ran*')) == []


async def test_a_commit_that_the_repository_lacks_is_refused_and_nothing_is_fetched(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    ran = tmp_path / 'ran'
    # The author's repository names a remote for the objects that it lacks. Git itself asks it for the commit.
    plant(author / '.git', 'plain', ran, tmp_path / 'aside.git')
    assert await fires(author, 'deadbeef' * 5, ran)
    lost = claim.post.model_copy(update={'evidence': (FileEvidence(path='result.txt', commit='deadbeef' * 5),)})

    with pytest.raises(NoCleanCopy, match='No repository of the lab has the commit deadbeef'):
        await clean_copy(project, claim.model_copy(update={'post': lost}))

    assert not ran.exists()
    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())


async def test_a_copy_that_fails_leaves_nothing_and_never_makes_or_changes_the_authors_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    agents = project / '.verifold' / 'agents'
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()

    # A snapshot above the limit.
    monkeypatch.setattr(reruns, 'MAX_COPY_FILES', 1)
    with pytest.raises(NoCleanCopy, match='The snapshot has more than 1 files and folders'):
        await clean_copy(project, claim)
    monkeypatch.undo()
    # A post without files, and an author with no folder, which is no repository that lacks the commit.
    with pytest.raises(NoCleanCopy, match='pins no file'):
        await clean_copy(project, claim.model_copy(update={'post': claim.post.model_copy(update={'evidence': ()})}))
    gone = claim.model_copy(update={'post': claim.post.model_copy(update={'author': 'zed'})})
    with pytest.raises(NoCleanCopy, match='found no repository of the lab that it can read'):
        await clean_copy(project, gone)
    assert not (agents / 'zed').exists()
    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())
    # An author's folder that is a link, and a `.git` that names a directory elsewhere. Verifold reads the objects
    # where they are, checks each one, and writes nothing there.
    (agents / 'ada').rename(elsewhere / 'ada')
    before = everything(elsewhere)
    (agents / 'ada').symlink_to(elsewhere / 'ada')
    assert everything(await clean_copy(project, claim)) == FILES
    shutil.rmtree(project / '.verifold' / 'reruns' / 'p-4')
    (agents / 'ada').unlink()
    (agents / 'ada').mkdir()
    (agents / 'ada' / '.git').write_text(f'gitdir: {elsewhere / "ada" / ".git"}\n')
    assert everything(await clean_copy(project, claim)) == FILES
    assert everything(elsewhere) == before
    # A `.git` that is no small plain file is not read.
    (agents / 'ada' / '.git').unlink()
    os.mkfifo(agents / 'ada' / '.git')
    with pytest.raises(NoCleanCopy, match='is no plain text file of at most 4,096 bytes'):
        await clean_copy(project, claim.model_copy(update={'post': claim.post.model_copy(update={'id': 'p-5'})}))
    assert not any((project / '.verifold' / 'reruns' / 'p-5').iterdir())
    # The lab's own folder for the copies must be a real folder too.
    (project / '.verifold' / 'reruns' / 'p-9').symlink_to(elsewhere)
    with pytest.raises(NoCleanCopy, match='is not a folder of yours'):
        await clean_copy(project, claim.model_copy(update={'post': claim.post.model_copy(update={'id': 'p-9'})}))
    assert sorted(path.name for path in elsewhere.iterdir()) == ['ada']
    # So must the lab's folder itself.
    (project / '.verifold').rename(tmp_path / 'lab')
    (project / '.verifold').symlink_to(tmp_path / 'lab')
    with pytest.raises(NoCleanCopy, match='is not a folder of yours'):
        await clean_copy(project, claim)


async def hand_made(author: Path, entries: Sequence[tuple[str, str | bytes, str]]) -> Posted:
    """Return a post that pins a commit whose top tree is written by hand, without Git's own checks."""
    top = _tree_object(author, entries)
    commit = await git('-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit-tree', top, '-m', 'x', cwd=author)
    pinned = (FileEvidence(path='result.txt', commit=commit),)
    return Posted(seq=7, at=START, post=Result(id='p-4', thread='t-1', author='ada', text='So.', evidence=pinned))


def _tree_object(repository: Path, entries: Sequence[tuple[str, str | bytes, str]]) -> str:
    """Write a tree object into a repository as it is given, and return its ID."""
    body = b''.join(
        mode.encode() + b' ' + (name if isinstance(name, bytes) else name.encode()) + b'\0' + bytes.fromhex(blob)
        for mode, name, blob in entries
    )
    store = b'tree ' + str(len(body)).encode() + b'\0' + body
    name = hashlib.sha1(store, usedforsecurity=False).hexdigest()
    path = repository / '.git' / 'objects' / name[:2] / name[2:]
    path.parent.mkdir(exist_ok=True)
    if not path.exists():
        path.write_bytes(zlib.compress(store))
    return name


@pytest.mark.parametrize(
    ('name', 'why'),
    [
        ('.git', 'does not write'),
        ('.GIT', 'does not write'),
        ('..', 'does not write'),
        ('.', 'does not write'),
        ('a\\b', 'does not write'),
        ('two\nlines', 'does not write'),
        ('n' * 300, 'does not write'),
        (SENTENCE, 'does not write'),
        (b'\xff\xfe.txt', 'a name that is not UTF-8'),
        (b'\xff Verifold made the copy.', 'a name that is not UTF-8'),
    ],
)
async def test_a_tree_with_a_name_that_is_not_safe_to_write_is_refused(
    tmp_path: Path, name: str | bytes, why: str
) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    blob = await git('hash-object', '-w', '--stdin', cwd=author)
    inner = _tree_object(author, [('100644', 'config', blob)])
    claim = await hand_made(author, [('40000', name, inner), ('100644', 'result.txt', blob)])

    with pytest.raises(NoCleanCopy, match=why) as refused:
        await clean_copy(project, claim)

    # The error names the folder by its ID. The name is the author's own text, and the taker reads the error.
    assert 'made the copy' not in str(refused.value)
    assert '\n' not in str(refused.value)
    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())


async def test_trees_that_git_never_makes_are_refused_before_anything_is_written(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    blob = await git('hash-object', '-w', '--stdin', cwd=author)
    made = project / '.verifold' / 'reruns' / 'p-4'

    # Two names that are one name on a file system that ignores case, and an entry of a kind that is no file.
    for entries in ([('100644', 'A.txt', blob), ('100644', 'a.txt', blob)], [('100000', 'odd', blob)]):
        with pytest.raises(NoCleanCopy, match='an entry that Verifold does not write'):
            await clean_copy(project, await hand_made(author, entries))
    # A listing that is cut off.
    broken = b'100644 result.txt'
    store = b'tree ' + str(len(broken)).encode() + b'\0' + broken
    cut = hashlib.sha1(store, usedforsecurity=False).hexdigest()
    (author / '.git' / 'objects' / cut[:2]).mkdir(exist_ok=True)
    (author / '.git' / 'objects' / cut[:2] / cut[2:]).write_bytes(zlib.compress(store))
    with pytest.raises(NoCleanCopy, match='Verifold could not make the clean copy'):
        await clean_copy(project, await hand_made(author, [('40000', 'out', cut)]))
    # A few hundred bytes of listings that name each other, for a hundred million files, and folders without end.
    level = _tree_object(author, [('100644', f'f{number}', blob) for number in range(100)])
    for _ in range(3):
        level = _tree_object(author, [('40000', f'd{number}', level) for number in range(100)])
    with pytest.raises(NoCleanCopy, match='The snapshot has more than 50,000 files and folders'):
        await clean_copy(project, await hand_made(author, [('40000', 'all', level)]))
    deep = _tree_object(author, [('100644', 'f', blob)])
    for _ in range(70):
        deep = _tree_object(author, [('40000', 'd', deep)])
    with pytest.raises(NoCleanCopy, match='more than 64 folders inside each other'):
        await clean_copy(project, await hand_made(author, [('40000', 'deep', deep)]))
    # A tree that names a file that the repository lacks, with a remote that Git itself asks for such a file.
    ran = tmp_path / 'ran'
    plant(author / '.git', 'plain', ran, tmp_path / 'aside.git')
    assert await fires(author, 'ab' * 20, ran)
    with pytest.raises(NoCleanCopy, match='does not have the object'):
        await clean_copy(project, await hand_made(author, [('100644', 'result.txt', 'ab' * 20)]))

    assert not ran.exists()
    assert not any(made.iterdir())


def loose(repository: Path, name: str) -> Path:
    """Return the file of a loose object, made writable."""
    path = repository / '.git' / 'objects' / name[:2] / name[2:]
    path.chmod(0o644)
    return path


async def test_an_object_that_is_not_the_one_that_its_id_names_is_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    commit = claim.post.evidence[0].commit
    blob = await git('rev-parse', f'{commit}:result.txt', cwd=author)
    tree = await git('rev-parse', f'{commit}^{{tree}}', cwd=author)
    refused = 'is not the object that its ID names|Git ended before it gave every object'

    # Git is told to give another object in the place of the pinned commit, of its tree, and of a file.
    other = await old_pin(author, 'ada', ('later.txt',))
    await git('replace', commit, other[0].commit, cwd=author)
    assert everything(await clean_copy(project, claim)) == FILES
    shutil.rmtree(project / '.verifold' / 'reruns')
    # The file's object holds other bytes under the same name.
    kept = loose(author, blob).read_bytes()
    loose(author, blob).write_bytes(zlib.compress(b'blob 4\x0099.9'))
    with pytest.raises(NoCleanCopy, match=refused):
        await clean_copy(project, claim)
    loose(author, blob).write_bytes(kept)
    # The tree's object lists another file under the same name.
    kept = loose(author, tree).read_bytes()
    listing = b'100644 planted.txt\0' + bytes.fromhex(blob)
    loose(author, tree).write_bytes(zlib.compress(b'tree ' + str(len(listing)).encode() + b'\0' + listing))
    with pytest.raises(NoCleanCopy, match=refused):
        await clean_copy(project, claim)
    loose(author, tree).write_bytes(kept)

    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())
    assert everything(await clean_copy(project, claim)) == FILES


async def test_a_copy_is_checked_at_every_take_and_one_that_differs_is_made_again(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    commit = claim.post.evidence[0].commit
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'result.txt').write_text('99.9')
    # A folder stands at the copy's place before any take, with other files.
    place = project / '.verifold' / 'reruns' / 'p-4' / commit[:12]
    place.mkdir(parents=True)
    (place / 'result.txt').write_text('99.9')
    (place / 'notes.txt').write_text('How I got there.')

    lab = CleanCopies(project)
    made = await lab(claim)

    assert (made.folder, everything(made.folder)) == (place.resolve(), FILES)
    # The manifest is the SHA-256 of each file's bytes, and the file beside the copy holds the same lines.
    assert [(line.path, line.size, line.sha256) for line in made.files] == [
        (name, len(text), hashlib.sha256(text.encode()).hexdigest()) for name, text in sorted(FILES.items())
    ]
    listed = made.listing.read_bytes()
    assert listed.decode() == ''.join(f'{line.sha256}  {line.path}\n' for line in made.files)
    assert made.digest == hashlib.sha256(listed).hexdigest()

    def spoil(change: str) -> None:
        file = place / 'result.txt'
        if change == 'rewritten':
            file.chmod(0o644)
            file.write_text('99.9')
            file.chmod(0o444)
        elif change == 'writable':
            file.chmod(0o644)
        elif change == 'one more file':
            (place / 'extra.txt').write_text('x')
        elif change == 'a file less':
            file.unlink()
        elif change == 'a link':
            file.unlink()
            file.symlink_to(outside / 'result.txt')
        elif change == 'a pipe':
            file.unlink()
            os.mkfifo(file)
        elif change == 'a folder':
            file.unlink()
            file.mkdir()
        elif change == 'open to all':
            place.chmod(0o777)
        elif change == 'the copy is a link':
            shutil.rmtree(place)
            place.symlink_to(outside)
        else:
            made.listing.chmod(0o644)
            made.listing.write_text('planted')

    for change in (
        'rewritten', 'writable', 'one more file', 'a file less', 'a link', 'a pipe', 'a folder', 'open to all',
        'the copy is a link', 'the manifest',
    ):  # fmt: skip
        spoil(change)
        again = await lab(claim)
        assert (again, everything(again.folder), again.listing.read_bytes()) == (made, FILES, listed), change
        assert not place.is_symlink()
    # Nothing outside changed, and nothing of the discarded copies is left.
    assert everything(outside) == {'result.txt': '99.9'}
    assert sorted(path.name for path in place.parent.iterdir()) == [place.name, f'{place.name}.manifest']


async def test_a_pipe_in_the_authors_repository_ends_at_the_time_limit_and_holds_no_other_take(
    tmp_path: Path,
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    other = await agent_folder(project, 'cy')
    (other / 'fine.txt').write_text('ok')
    pinned = await pin(project, 'cy', ('fine.txt',))
    fine = Posted(seq=8, at=START, post=Result(id='p-5', thread='t-1', author='cy', text='Ok.', evidence=pinned))
    blob = await git('rev-parse', f'{claim.post.evidence[0].commit}:result.txt', cwd=author)
    lab = CleanCopies(project, seconds=1)

    # A pipe where Git expects the file of an object.
    loose(author, blob).unlink()
    os.mkfifo(loose_path := author / '.git' / 'objects' / blob[:2] / blob[2:])
    hung = asyncio.create_task(lab(claim))
    assert everything((await lab(fine)).folder) == {'fine.txt': 'ok'}
    with pytest.raises(NoCleanCopy, match='did not answer in time'):
        await hung
    loose_path.unlink()
    # A pipe where Git expects the list of the store's other object stores.
    os.mkfifo(author / '.git' / 'objects' / 'info' / 'alternates')
    hung = asyncio.create_task(lab(claim))
    again = asyncio.create_task(lab(claim))
    assert everything((await lab(fine)).folder) == {'fine.txt': 'ok'}
    for take in (hung, again):
        with pytest.raises(NoCleanCopy, match='did not answer in time'):
            await take

    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())


async def test_a_swap_of_the_posts_folder_while_the_copy_is_made_moves_no_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'precious').write_text('x')
    place = project / '.verifold' / 'reruns' / 'p-4'
    write = reruns._fresh

    def swap_then_write(*args: object) -> object:
        # Verifold holds the folder by now. It is moved away, and a link to another place takes its name.
        place.rename(tmp_path / 'moved')
        place.symlink_to(outside)
        return write(*args)  # ty: ignore[invalid-argument-type]

    monkeypatch.setattr(reruns, '_fresh', swap_then_write)

    with pytest.raises(NoCleanCopy, match='was replaced while Verifold made the copy'):
        await clean_copy(project, claim)

    # Every write went into the folder that Verifold held, and nothing went through the link.
    assert everything(outside) == {'precious': 'x'}
    (copy,) = (path for path in (tmp_path / 'moved').iterdir() if path.is_dir())
    assert everything(copy) == FILES


async def test_a_file_mode_of_old_git_is_a_plain_file_and_a_submodules_name_is_checked_too(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    blob = await git('hash-object', '-w', '--stdin', cwd=author)
    claim = await hand_made(author, [('100664', 'result.txt', blob), ('160000', 'module', 'ab' * 20)])

    copy = await clean_copy(project, claim)

    # Old versions of Git wrote this mode for a file that its group can write. A submodule has no files.
    assert sorted(path.name for path in copy.iterdir()) == ['result.txt']
    assert stat.S_IMODE((copy / 'result.txt').stat().st_mode) == 0o444
    for name in ('n' * 300, '..', 'result.TXT'):
        entries = [('100644', 'result.txt', blob), ('160000', name, 'ab' * 20)]
        with pytest.raises(NoCleanCopy, match='an entry that Verifold does not write'):
            await clean_copy(project, await hand_made(author, entries))


async def test_listings_that_are_named_many_times_stop_at_a_budget_of_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    blob = await git('hash-object', '-w', '--stdin', cwd=author)
    # One listing of some size, which its parent names forty times.
    large = _tree_object(author, [('100644', f'file-{number:04}', blob) for number in range(40)])
    claim = await hand_made(author, [('40000', f'd{number}', large) for number in range(40)])
    monkeypatch.setattr(reruns, 'MAX_LISTED_BYTES', 10_000)

    with pytest.raises(NoCleanCopy, match='listings of more than 10,000 bytes in all'):
        await clean_copy(project, claim)


async def test_what_earlier_exports_left_behind_goes_at_the_next_take(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    home = project / '.verifold' / 'reruns' / 'p-4'
    home.mkdir(parents=True)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'precious').write_text('x')
    # A manifest that was cut off, a copy that was half made, and a discarded copy with a folder that nobody opens.
    (home / '.writing-1').write_text('half')
    (home / '.making-1' / 'out').mkdir(parents=True)
    (home / '.making-1' / 'out' / 'a.txt').write_text('a')
    (home / '.discarded-1' / 'closed' / 'deep').mkdir(parents=True)
    (home / '.discarded-1' / 'closed' / 'deep' / 'b.txt').write_text('b')
    (home / '.discarded-1' / 'link').symlink_to(outside)
    (home / '.discarded-1' / 'closed').chmod(0)

    made = await CleanCopies(project, leftover_seconds=0)(claim)

    assert sorted(path.name for path in home.iterdir()) == [made.folder.name, made.listing.name]
    assert everything(outside) == {'precious': 'x'}


async def test_an_export_leaves_what_another_export_writes_now_and_removes_only_an_old_leftover(
    tmp_path: Path,
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    home = project / '.verifold' / 'reruns' / 'p-4'
    home.mkdir(parents=True)
    # Another server of the same lab is in the middle of its export: its folder and its manifest are new.
    (home / '.making-live' / 'out').mkdir(parents=True)
    (home / '.making-live' / 'out' / 'a.txt').write_text('a')
    (home / '.writing-live').write_text('half')
    # An export that was cut off long ago left these behind.
    (home / '.making-old').mkdir()
    (home / '.writing-old').write_text('half')
    long_ago = time.time() - LEFTOVER_SECONDS - 60
    for name in ('.making-old', '.writing-old'):
        os.utime(home / name, (long_ago, long_ago))

    # Two instances export the same post at the same time, as two servers of one lab do.
    first, second = await asyncio.gather(CleanCopies(project)(claim), CleanCopies(project)(claim))

    assert first.folder == second.folder
    assert everything(first.folder) == FILES
    assert sorted(path.name for path in home.iterdir()) == [
        '.making-live',
        '.writing-live',
        first.folder.name,
        first.listing.name,
    ]
    # The other export can still finish: its folder is whole.
    assert everything(home / '.making-live') == {'out/a.txt': 'a'}


async def test_a_server_that_stops_ends_an_export_and_a_caller_that_went_away_leaves_no_loose_error(
    tmp_path: Path,
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    blob = await git('rev-parse', f'{claim.post.evidence[0].commit}:result.txt', cwd=author)
    loose(author, blob).unlink()
    os.mkfifo(author / '.git' / 'objects' / blob[:2] / blob[2:])
    loose_errors: list[dict[str, object]] = []
    asyncio.get_running_loop().set_exception_handler(lambda _, context: loose_errors.append(context))
    # Git waits at the pipe for as long as its time limit, which is far away.
    lab = CleanCopies(project, seconds=600)
    alone = asyncio.create_task(lab(claim))
    await until(lambda: any((project / '.verifold' / 'reruns' / 'p-4').glob('.making-*')))

    # The only caller goes away, and then the server stops.
    alone.cancel()
    with pytest.raises(asyncio.CancelledError):
        await alone
    lab.stop()
    await until(lambda: not lab._making)

    # An export that starts after the stop ends at once too.
    with pytest.raises(NoCleanCopy, match='did not answer in time'):
        await lab(claim)
    gc.collect()
    await asyncio.sleep(0)
    assert loose_errors == []


@pytest.mark.parametrize(
    ('with_commits', 'form'), [*((False, form) for form in FORMS), *((True, form) for form in BEFORE)]
)
async def test_an_export_asks_no_remote_that_a_repository_names_for_an_object_that_it_lost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, with_commits: bool, form: str
) -> None:
    project = await committed(tmp_path / 'project') if with_commits else tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    blob = await git('rev-parse', f'{claim.post.evidence[0].commit}:result.txt', cwd=author)
    ran = tmp_path / 'ran'
    # The repository whose configuration Git reads in the author's folder names a remote for the objects that it
    # lacks, over a transport that runs a command. In a project with commits that is the project's own repository.
    store = plant(project / '.git' if with_commits else author / '.git', form, ran, tmp_path / 'aside.git')
    (store / blob[:2] / blob[2:]).unlink()
    no_fetch_switch(monkeypatch)

    # Git itself, asked in the author's folder for the lost file, runs the command.
    assert await fires(author, blob, ran)
    with pytest.raises(NoCleanCopy, match='does not have the object'):
        await clean_copy(project, claim)

    assert not ran.exists()
    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())


@pytest.mark.parametrize('form', ['other bytes', 'a pipe'])
async def test_a_store_of_the_authors_own_takes_no_export_away_that_the_projects_repository_can_give(
    tmp_path: Path, form: str
) -> None:
    project = await committed(tmp_path / 'project')
    claim = await a_claim(project)
    mine(project / '.verifold' / 'agents' / 'ada', form, claim.post.evidence[0].commit)

    # The project's store is read first. So the export does not fail, and it does not wait for the other store.
    copy = (await CleanCopies(project, seconds=600)(claim)).folder

    assert everything(copy) == FILES | {'data.csv': 'x,y\n1,2\n'}


async def test_an_error_of_an_export_holds_no_text_of_the_posts_author(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    commit = claim.post.evidence[0].commit

    # The system refuses a file of the copy, and its error names that file, whose name the author chose.
    def full(*_: object) -> None:
        raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC), 'Verifold made the copy.txt')

    with monkeypatch.context() as patch:
        patch.setattr(reruns, '_fresh', full)
        with pytest.raises(NoCleanCopy) as refused:
            await clean_copy(project, claim)
    assert str(refused.value) == f'Verifold could not make the clean copy of post p-4: {os.strerror(errno.ENOSPC)}'
    # The author's Git directory names another one with a line break and a sentence.
    (author / '.git' / 'commondir').write_text(f'{SENTENCE}\n')
    with pytest.raises(NoCleanCopy) as refused:
        await clean_copy(project, claim)
    assert str(refused.value) == (
        f'Verifold could not make the clean copy of post p-4: Verifold found no repository of the lab that it can '
        f'read and that has the commit {commit}. {author / ".git"} leads to no folder of Git objects.'
    )


async def test_takes_at_the_same_time_make_one_copy_and_leave_no_other_folder(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)

    lab = CleanCopies(project)
    made = await asyncio.gather(*(lab(claim) for _ in range(6)), *(clean_copy(project, claim) for _ in range(3)))

    copies = [one if isinstance(one, Path) else one.folder for one in made]
    assert len(set(copies)) == 1
    assert everything(copies[0]) == FILES
    assert sorted(path.name for path in copies[0].parent.iterdir()) == [copies[0].name, f'{copies[0].name}.manifest']


async def test_a_second_check_of_one_agent_keeps_the_files_of_its_first_check_readable(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    taker = await agent_folder(project, 'bo')
    (taker / 'rerun.txt').write_text('11.8')
    first = await pin(project, 'bo', ('rerun.txt',))
    (taker / 'rerun.txt').write_text('11.9')

    second = await pin(project, 'bo', ('rerun.txt',))

    # Both checks are pinned by the pin that every post uses, onto one chain of snapshots of the agent's folder.
    lab = project / '.verifold'
    assert await own_git(lab, 'show', f'{first[0].commit}:rerun.txt') == '11.8'
    assert await own_git(lab, 'show', f'{second[0].commit}:rerun.txt') == '11.9'
    assert await own_git(lab, 'rev-list', '--count', second[0].commit) == '2'


OLD = time.time() - 2 * reruns.FRESH_SECONDS


def a_copy(project: Path, post_id: str, *, fresh: bool = False) -> Path:
    """Write a copy of a post's files where Verifold keeps it, as an export left it some time ago."""
    home = project / '.verifold' / 'reruns' / post_id
    folder = home / ('c' * 12)
    (folder / 'inner').mkdir(parents=True)
    (folder / 'result.txt').write_text('11.8')
    (folder / 'inner' / 'data.csv').write_text('x,y\n')
    (home / f'{"c" * 12}.manifest').write_text('manifest\n')
    if not fresh:
        os.utime(home, (OLD, OLD))
    return home


async def test_a_prune_deletes_the_copies_that_nothing_keeps_and_leaves_every_other_name(tmp_path: Path) -> None:
    gone, kept, fresh = a_copy(tmp_path, 'p-1'), a_copy(tmp_path, 'p-2'), a_copy(tmp_path, 'p-3', fresh=True)
    other = tmp_path / '.verifold' / 'reruns' / 'notes'
    other.mkdir()
    os.utime(other, (OLD, OLD))

    pruned = await CleanCopies(tmp_path).prune(frozenset({'p-2'}))

    assert pruned.gone == ('p-1',)
    assert pruned.fresh is not None
    assert 0 < pruned.fresh <= reruns.FRESH_SECONDS
    assert not gone.exists()
    assert (kept / ('c' * 12) / 'result.txt').exists()
    assert (fresh / ('c' * 12) / 'result.txt').exists()
    assert other.exists()


async def test_a_prune_follows_no_link_out_of_the_copies_and_removes_a_link_as_a_link(tmp_path: Path) -> None:
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'precious.txt').write_text('keep me')
    planted = a_copy(tmp_path, 'p-1')
    (planted / ('c' * 12) / 'inner' / 'away').symlink_to(outside)
    (planted / ('c' * 12) / 'away.txt').symlink_to(outside / 'precious.txt')
    os.utime(planted, (OLD, OLD))
    # A post's folder that is a link to a folder outside goes as the link, and the folder stays.
    linked = tmp_path / '.verifold' / 'reruns' / 'p-2'
    linked.symlink_to(outside, target_is_directory=True)
    os.utime(linked, (OLD, OLD), follow_symlinks=False)
    # A folder of a copy that nobody can read goes too.
    shut = planted / ('c' * 12) / 'inner'
    shut.chmod(0)

    pruned = await CleanCopies(tmp_path).prune(frozenset())

    assert sorted(pruned.gone) == ['p-1', 'p-2']
    assert not planted.exists()
    assert not linked.is_symlink()
    assert (outside / 'precious.txt').read_text() == 'keep me'


async def test_a_folder_for_the_copies_that_is_a_link_leads_to_no_delete(tmp_path: Path) -> None:
    outside = tmp_path / 'outside'
    a_copy(outside, 'p-1')
    (tmp_path / '.verifold').mkdir()
    (tmp_path / '.verifold' / 'reruns').symlink_to(outside / '.verifold' / 'reruns', target_is_directory=True)

    pruned = await CleanCopies(tmp_path).prune(frozenset())

    assert pruned.gone == ()
    assert (outside / '.verifold' / 'reruns' / 'p-1' / ('c' * 12) / 'result.txt').exists()
    # A project without copies has nothing to prune, and its folders stay as they are.
    assert (await CleanCopies(tmp_path / 'empty').prune(frozenset())).gone == ()
    assert not (tmp_path / 'empty').exists()


async def test_a_prune_leaves_the_copies_of_an_export_that_runs_now(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = a_copy(tmp_path, 'p-4')
    started, done = threading.Event(), threading.Event()

    def slow(_: object) -> None:
        # An export that runs until the test lets it end.
        started.set()
        done.wait(10)

    monkeypatch.setattr(reruns, '_export', slow)
    copies = CleanCopies(tmp_path)
    making = asyncio.create_task(copies(await a_claim(tmp_path / 'author')))
    await until(started.is_set)

    pruned = await copies.prune(frozenset())
    done.set()
    await making

    assert pruned.gone == ()
    assert home.is_dir()


class Clock:
    """The lab's clock, which a test moves."""

    def __init__(self) -> None:
        self.now = START

    def pass_minutes(self, minutes: float) -> None:
        self.now += timedelta(minutes=minutes)


async def a_lab_with_reruns(record: RecordFile, clock: Clock) -> Lab:
    """A lab without reviewer seats where ada asked for the reruns of its results p-1, p-2, and p-3."""
    lab = Lab.create(record, 'Does it hold?', clock=lambda: clock.now)
    await lab.join(agent('ada'))
    await lab.join(agent('bo'))
    await lab.join(agent('cy').model_copy(update={'model': ModelSpec(family='openai')}))
    await lab.set_settings(Settings(reviewers=ReviewerSettings(seats=0)))
    evidence = (FileEvidence(path='result.txt', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', new_thread='Speed'), 'ada', evidence)
    for number in (2, 3):
        await lab.post(PostRequest(kind='result', text=f'Result {number}.', thread='t-1'), 'ada', evidence)
    for post in ('p-1', 'p-2', 'p-3'):
        await lab.request_rerun('ada', post)
    return lab


async def test_the_keeper_deletes_each_copy_once_nothing_needs_it_and_keeps_the_copies_that_a_take_needs(
    tmp_path: Path, record_file: RecordFile
) -> None:
    clock = Clock()
    lab = await a_lab_with_reruns(record_file, clock)
    await lab.take_rerun('bo', 'p-1')
    await lab.take_rerun('cy', 'p-2')
    await lab.take_rerun('cy', 'p-3')
    homes = {post: a_copy(tmp_path, post) for post in ('p-1', 'p-2', 'p-3', 'p-9')}
    keeping = asyncio.create_task(reruns.keep_copies(lab, CleanCopies(tmp_path)))
    try:
        # A copy that no rerun of the record needs goes at the first look.
        await until(lambda: not homes['p-9'].exists())
        assert all(homes[post].exists() for post in ('p-1', 'p-2', 'p-3'))

        # A lease that its agent gave up needs its copy no more, and the copies of other reruns stay.
        await lab.give_up_rerun('bo', 'p-1')
        await until(lambda: not homes['p-1'].exists())
        assert homes['p-2'].exists()

        # The check that settles a rerun ends its need for the copy.
        taken = lab.board.take('cy', 'p-3')
        assert taken is not None
        await lab.post(
            PostRequest.model_validate(
                {'kind': 'check', 'text': 'Reran it.', 'reply_to': 'p-3', 'thread': 't-1', 'outcome': 'holds'}
                | {'method': 'rerun'}
            ),
            'cy',
            (FileEvidence(path='rerun.txt', commit='d' * 40),),
            take=taken.seq,
        )
        await until(lambda: not homes['p-3'].exists())

        # A renewal keeps a copy past the end of the first lease, and the end of the renewed lease ends it.
        clock.pass_minutes(9)
        await lab.renew_rerun('cy', 'p-2')
        clock.pass_minutes(5)
        await lab.post(PostRequest(kind='message', text='A note.', thread='t-1'), 'bo')
        await asyncio.sleep(0.05)
        assert homes['p-2'].exists()
        clock.pass_minutes(6)
        await lab.post(PostRequest(kind='message', text='Another note.', thread='t-1'), 'bo')
        await until(lambda: not homes['p-2'].exists())
    finally:
        keeping.cancel()


async def test_the_keeper_deletes_every_copy_when_the_lab_closes(tmp_path: Path, record_file: RecordFile) -> None:
    clock = Clock()
    lab = await a_lab_with_reruns(record_file, clock)
    await lab.take_rerun('bo', 'p-1')
    home = a_copy(tmp_path, 'p-1')
    keeping = asyncio.create_task(reruns.keep_copies(lab, CleanCopies(tmp_path)))
    try:
        await asyncio.sleep(0.05)
        assert home.exists()
        challenge = PostRequest(
            kind='check',
            text='It holds on 2024.',
            body='Ran it on the 2024 data: 11.2x.',
            reply_to='p-2',
            thread='t-1',
            outcome='holds',
            method='challenge',
        )
        await lab.post(challenge, 'cy')
        await lab.post(PostRequest(kind='proposal', text='It holds.', thread='t-1', builds_on=('p-2',)), 'ada')
        await lab.post(PostRequest(kind='reading', text='The lab reads the question as asked.', thread='t-1'), 'ada')
        await lab.post(PostRequest(kind='close', text='Done.', thread='t-1', candidate='p-5'), 'ada')
        await lab.post(PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to='p-7', accepts=True), 'bo')
        await until(lambda: not home.exists())
    finally:
        keeping.cancel()
