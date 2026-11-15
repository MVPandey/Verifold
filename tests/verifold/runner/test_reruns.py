import asyncio
import gc
import hashlib
import os
import shutil
import stat
import time
import zlib
from collections.abc import Sequence
from pathlib import Path

import pytest
from builders import START, until

from verifold.protocol.events import Posted
from verifold.protocol.posts import FileEvidence, Result
from verifold.runner import reruns
from verifold.runner.folders import agent_folder
from verifold.runner.git import git
from verifold.runner.reruns import LEFTOVER_SECONDS, CleanCopies, fetches_nothing
from verifold.runner.snapshots import pin, snapshot
from verifold.server.errors import EvidenceRejected, NoCleanCopy

FILES = {'notes.txt': 'How I got there.', 'result.txt': '11.8'}


async def committed(path: Path) -> Path:
    path.mkdir()
    (path / 'data.csv').write_text('x,y\n1,2\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=path)
    await git('add', '.', cwd=path)
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Start', cwd=path)
    return path


async def a_claim(project: Path, post_id: str = 'p-4') -> Posted:
    """Give ada a result file that a post pins, with later work after it, and return the post."""
    project.mkdir(exist_ok=True)
    author = await agent_folder(project, 'ada')
    (author / 'result.txt').write_text('11.8')
    (author / 'notes.txt').write_text('How I got there.')
    pinned = await pin(author, 'ada', ('result.txt',))
    (author / 'result.txt').write_text('changed later')
    (author / 'later.txt').write_text('Work from after the post.')
    await snapshot(author, 'ada')
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
    pinned = await pin(author, 'ada', ('lines.txt',))
    claim = Posted(seq=7, at=START, post=Result(id='p-4', thread='t-1', author='ada', text='So.', evidence=pinned))

    copy = await clean_copy(project, claim)

    assert (copy / 'lines.txt').read_bytes() == b'one\ntwo\n$Id$\n'
    assert not (copy / 'link').is_symlink()
    assert (copy / 'link').read_text() == '/etc/hosts'
    assert stat.S_IMODE((copy / 'run.sh').stat().st_mode) == 0o555
    assert (copy / 'out' / 'a.json').read_text() == '{}'


async def test_taking_a_rerun_writes_nothing_and_runs_nothing_in_any_agents_folder(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    taker = await agent_folder(project, 'bo')
    ran = tmp_path / 'ran'
    outside = tmp_path / 'outside'
    (outside / 'p-4').mkdir(parents=True)
    (outside / 'p-4' / 'precious').write_text('x')
    (outside / 'file').write_text('keep')
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
        + f'[remote "evil"]\n\turl = ext::sh -c "touch {ran}-ext"\n\tpromisor = true\n\tpartialclonefilter = blob:none\n'
        + '[protocol "ext"]\n\tallow = always\n'
    )
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

    assert everything(copy) == FILES
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
    config = author / '.git' / 'config'
    config.write_text(
        config.read_text()
        + '[extensions]\n\tpartialClone = evil\n'
        + f'[remote "evil"]\n\turl = ssh://localhost/x\n\tpromisor = true\n[core]\n\tsshCommand = touch {ran}; false\n'
    )
    lost = claim.post.model_copy(update={'evidence': (FileEvidence(path='result.txt', commit='deadbeef' * 5),)})

    with pytest.raises(NoCleanCopy, match='No repository of the lab has the commit deadbeef'):
        await clean_copy(project, claim.model_copy(update={'post': lost}))

    assert not ran.exists()
    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())


async def test_a_copy_that_fails_leaves_nothing_and_never_makes_or_follows_the_authors_folder(
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
    # An author with no folder, with a folder that is a link, and with a `.git` that points elsewhere.
    with pytest.raises(NoCleanCopy, match='pins no file'):
        await clean_copy(project, claim.model_copy(update={'post': claim.post.model_copy(update={'evidence': ()})}))
    gone = claim.model_copy(update={'post': claim.post.model_copy(update={'author': 'zed'})})
    with pytest.raises(NoCleanCopy, match='No repository of the lab has the commit'):
        await clean_copy(project, gone)
    assert not (agents / 'zed').exists()
    (agents / 'ada').rename(elsewhere / 'ada')
    (agents / 'ada').symlink_to(elsewhere / 'ada')
    with pytest.raises(NoCleanCopy, match='No repository of the lab has the commit'):
        await clean_copy(project, claim)
    (agents / 'ada').unlink()
    (agents / 'ada').mkdir()
    (agents / 'ada' / '.git').write_text(f'gitdir: {elsewhere / "ada" / ".git"}\n')
    with pytest.raises(NoCleanCopy, match='No repository of the lab has the commit'):
        await clean_copy(project, claim)

    assert not any((project / '.verifold' / 'reruns' / 'p-4').iterdir())
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
        (b'\xff\xfe.txt', 'a name that is not UTF-8'),
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

    with pytest.raises(NoCleanCopy, match=why):
        await clean_copy(project, claim)

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
    # A tree that names a file that the repository lacks, with a remote that would run a command to fetch it.
    ran = tmp_path / 'ran'
    config = author / '.git' / 'config'
    config.write_text(
        config.read_text()
        + '[extensions]\n\tpartialClone = evil\n'
        + f'[remote "evil"]\n\turl = file://{tmp_path}/none\n\tpromisor = true\n\tuploadpack = touch {ran}; false\n'
        + '[protocol "file"]\n\tallow = always\n'
    )
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
    other = await pin(author, 'ada', ('later.txt',))
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
    pinned = await pin(other, 'cy', ('fine.txt',))
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
    # A pipe where Git expects the repository's configuration.
    (author / '.git' / 'config').unlink()
    os.mkfifo(author / '.git' / 'config')
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


async def test_an_older_git_reads_only_a_repository_whose_configuration_cannot_make_it_fetch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    risky = {
        '[include]\n\tpath = /tmp/other\n': 'takes in other configuration',
        '[INCLUDEIF "gitdir:/x/"] path = /tmp/other\n': 'takes in other configuration',
        '[extensions]\n\tworktreeConfig = true\n': 'takes in other configuration',
        '[Extensions]\n\tPartialClone = evil\n': 'names a remote for objects that it lacks',
        '[extensions] partialclone = evil\n': 'names a remote for objects that it lacks',
        '[remote "evil"]\n\turl = /x\n\tPROMISOR = true\n': 'names a remote for objects that it lacks',
        '[remote.evil]\n\tpartialCloneFilter = blob:none\n': 'names a remote for objects that it lacks',
        'not a line of a configuration\n': 'cannot read the configuration',
        '[core]\n\tname = \xff\n': 'cannot read the configuration',
    }
    plain = tmp_path / 'plain'
    claim = await a_claim(plain)
    project = await committed(tmp_path / 'project')
    in_project = await a_claim(project)
    configs = {plain: plain / '.verifold' / 'agents' / 'ada' / '.git' / 'config', project: project / '.git' / 'config'}
    kept = {folder: config.read_bytes() for folder, config in configs.items()}

    # A Git of today fetches nothing when told so, and Verifold does not look at the configuration.
    assert fetches_nothing()
    configs[plain].write_bytes(kept[plain] + b'[include]\n\tpath = /tmp/other\n')
    assert everything(await clean_copy(plain, claim)) == FILES
    configs[plain].write_bytes(kept[plain])

    monkeypatch.setattr(reruns, 'FETCHES_NOTHING_FROM', (99, 0))
    assert not fetches_nothing()
    # An older Git with an ordinary configuration makes the copy: in a project without Git commits and with them.
    assert everything(await clean_copy(plain, claim)) == FILES
    assert everything(await clean_copy(project, in_project))['result.txt'] == '11.8'
    # A value that goes on over lines, comments, and a remote of the usual kind are ordinary too.
    usual = b'# note\n[remote "origin"]\n\turl = /x\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[alias]\n\tx = a \\\n[include]\n'
    configs[plain].write_bytes(kept[plain] + usual)
    assert everything(await clean_copy(plain, claim)) == FILES
    # Each shape that can make it fetch, or that Verifold cannot read with confidence, refuses the copy.
    for folder, post in ((plain, claim), (project, in_project)):
        for added, why in risky.items():
            configs[folder].write_bytes(kept[folder] + added.encode('latin-1'))
            # Git itself cannot read some of these files, and Verifold then does not find the project's repository.
            unread = folder == project and why.startswith('cannot read')
            expected = f'{why}|No repository of the lab has the commit' if unread else why
            with pytest.raises(NoCleanCopy, match=expected) as refused:
                await clean_copy(folder, post)
            assert 'No repository' in str(refused.value) or 'Git 99.0 or later fetches nothing' in str(refused.value)
        configs[folder].write_bytes(kept[folder])
    # So does a configuration that is a link, a pipe, too large, or gone.
    outside = tmp_path / 'config'
    outside.write_bytes(kept[plain])
    for shape in ('link', 'pipe', 'large', 'gone'):
        configs[plain].unlink()
        if shape == 'link':
            configs[plain].symlink_to(outside)
        elif shape == 'pipe':
            os.mkfifo(configs[plain])
        elif shape == 'large':
            configs[plain].write_bytes(kept[plain] + b'#' * (reruns.MAX_CONFIG_BYTES + 1))
        with pytest.raises(NoCleanCopy, match='cannot read the configuration'):
            await clean_copy(plain, claim)
        if shape != 'gone':
            configs[plain].unlink()
        configs[plain].write_bytes(kept[plain])
    # A computer without Git reads none.
    monkeypatch.setenv('PATH', str(tmp_path))
    assert not fetches_nothing()


async def test_takes_at_the_same_time_make_one_copy_and_leave_no_other_folder(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)

    lab = CleanCopies(project)
    made = await asyncio.gather(*(lab(claim) for _ in range(6)), *(clean_copy(project, claim) for _ in range(3)))

    copies = [one if isinstance(one, Path) else one.folder for one in made]
    assert len(set(copies)) == 1
    assert everything(copies[0]) == FILES
    assert sorted(path.name for path in copies[0].parent.iterdir()) == [copies[0].name, f'{copies[0].name}.manifest']


async def test_a_pin_that_git_cannot_make_is_an_error_that_the_agent_reads(tmp_path: Path) -> None:
    plain = tmp_path / 'plain'
    plain.mkdir()
    (plain / 'a.txt').write_text('a')

    with pytest.raises(EvidenceRejected, match='Verifold could not commit your folder, so it pinned no file'):
        await pin(plain, 'bo', ('a.txt',))


async def test_a_second_check_of_one_agent_keeps_the_files_of_its_first_check_readable(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    taker = await agent_folder(project, 'bo')
    (taker / 'rerun.txt').write_text('11.8')
    first = await pin(taker, 'bo', ('rerun.txt',))
    (taker / 'rerun.txt').write_text('11.9')

    second = await pin(taker, 'bo', ('rerun.txt',))

    # Both checks are pinned by the pin that every post uses, onto one chain of snapshots in the agent's folder.
    assert await git('show', f'{first[0].commit}:rerun.txt', cwd=taker) == '11.8'
    assert await git('show', f'{second[0].commit}:rerun.txt', cwd=taker) == '11.9'
    assert await git('rev-list', '--count', second[0].commit, cwd=taker) == '2'
