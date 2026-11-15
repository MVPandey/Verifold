import asyncio
import hashlib
import os
import stat
import zlib
from pathlib import Path

import pytest
from builders import START

from verifold.protocol.events import Posted
from verifold.protocol.posts import FileEvidence, Result
from verifold.runner import reruns
from verifold.runner.folders import agent_folder
from verifold.runner.git import git
from verifold.runner.reruns import clean_copy
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
    assert list((project / '.verifold' / 'reruns' / 'p-4').iterdir()) == []


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
    with pytest.raises(NoCleanCopy, match=r'has 2 files and 20 bytes\. Verifold copies at most 1 files'):
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

    assert list((project / '.verifold' / 'reruns' / 'p-4').iterdir()) == []
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


@pytest.mark.parametrize('name', ['.git', '.GIT', '..', '.'])
async def test_a_tree_with_a_name_that_is_not_safe_to_write_is_refused(tmp_path: Path, name: str) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    outside = everything(tmp_path / 'project' / '.verifold' / 'agents')
    # A tree that Git itself never makes from a folder, written as an object by hand: a folder with this name.
    blob = await git('hash-object', '-w', '--stdin', cwd=author)
    inner = _tree_object(author, [('100644', 'config', blob)])
    top = _tree_object(author, [('40000', name, inner), ('100644', 'result.txt', blob)])
    commit = await git('-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit-tree', top, '-m', 'x', cwd=author)
    post = Result(
        id='p-4', thread='t-1', author='ada', text='So.', evidence=(FileEvidence(path='result.txt', commit=commit),)
    )

    with pytest.raises(NoCleanCopy, match='an entry that Verifold does not write'):
        await clean_copy(project, Posted(seq=7, at=START, post=post))

    assert list((project / '.verifold' / 'reruns' / 'p-4').iterdir()) == []
    assert {
        path: text for path, text in everything(project / '.verifold' / 'agents').items() if '/objects/' not in path
    } == {path: text for path, text in outside.items() if '/objects/' not in path}


def _tree_object(repository: Path, entries: list[tuple[str, str, str]]) -> str:
    """Write a tree object into a repository as it is given, without Git's own checks of names."""
    body = b''.join(f'{mode} {name}'.encode() + b'\0' + bytes.fromhex(blob) for mode, name, blob in entries)
    store = b'tree ' + str(len(body)).encode() + b'\0' + body
    name = hashlib.sha1(store).hexdigest()
    path = repository / '.git' / 'objects' / name[:2] / name[2:]
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(zlib.compress(store))
    return name


async def test_takes_at_the_same_time_make_one_copy_and_leave_no_other_folder(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)

    copies = await asyncio.gather(*(clean_copy(project, claim) for _ in range(6)))

    assert len(set(copies)) == 1
    assert everything(copies[0]) == FILES
    assert [path.name for path in copies[0].parent.iterdir()] == [copies[0].name]


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
