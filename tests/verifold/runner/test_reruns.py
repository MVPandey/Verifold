import asyncio
import stat
from pathlib import Path

import pytest
from builders import START

from verifold.protocol.events import Posted
from verifold.protocol.posts import Check, FileEvidence, Result
from verifold.runner import reruns
from verifold.runner.folders import agent_folder
from verifold.runner.git import git
from verifold.runner.reruns import Reruns, evidence_repository, own_folder
from verifold.runner.snapshots import pin, snapshot
from verifold.server.errors import EvidenceRejected, NoCleanCopy


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
    """Return every file under a folder with its text, so that a test can see that nothing there changed."""
    return {str(path.relative_to(folder)): path.read_text() for path in sorted(folder.rglob('*')) if path.is_file()}


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_clean_copy_is_plain_files_of_the_pinned_commit_in_the_takers_own_folder(
    tmp_path: Path, *, with_commits: bool
) -> None:
    project = await committed(tmp_path / 'project') if with_commits else tmp_path / 'project'
    claim = await a_claim(project)
    taker = await agent_folder(project, 'bo')
    (taker / 'mine.txt').write_text("The taker's own work.")

    copy = await Reruns(project, 'bo').make(claim)

    # The copy holds exactly what the author's snapshot held at the pinned commit: no later file, and no Git.
    assert copy == taker.resolve() / '.verifold' / 'reruns' / 'p-4'
    expected = {'notes.txt': 'How I got there.', 'result.txt': '11.8'}
    assert everything(copy) == expected | ({'data.csv': 'x,y\n1,2\n'} if with_commits else {})
    assert not (copy / '.git').exists()
    # Verifold's own Git directory for the take is outside every agent's folder, and only the person reads it.
    own = own_folder(project, 'bo', 'p-4')
    assert own == project.resolve() / '.verifold' / 'reruns' / 'bo' / 'p-4'
    assert (own / 'git' / 'HEAD').is_file()
    assert stat.S_IMODE(own.stat().st_mode) == 0o700
    assert stat.S_IMODE((project / '.verifold' / 'reruns').stat().st_mode) == 0o700
    # The taker's own snapshot leaves the copy out.
    mine = await snapshot(taker, 'bo')
    assert 'reruns' not in await git('ls-tree', '-r', '--name-only', mine, cwd=taker)
    # A later call returns the same folder as the agent left it.
    (copy / 'rerun.txt').write_text('11.8')
    assert await Reruns(project, 'bo').make(claim) == copy
    assert (copy / 'rerun.txt').exists()


async def test_a_check_pins_files_of_the_clean_copy_into_verifolds_own_directory_and_the_copy_can_go(
    tmp_path: Path,
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    taker = await agent_folder(project, 'bo')
    made = Reruns(project, 'bo')
    copy = await made.make(claim)
    (copy / 'rerun.txt').write_text('11.8')
    (taker / 'rerun.txt').write_text('A file of the same name in the folder of the agent itself.')

    evidence = await made.pin('p-4', ('rerun.txt',))

    commit = evidence[0].commit
    check = Check(
        id='p-5', thread='t-1', author='bo', text='Holds.', reply_to='p-4', outcome='holds', method='rerun', take=9
    )
    folder, repository = evidence_repository(project, check)
    assert await git(*repository, 'show', f'{commit}:rerun.txt', cwd=folder) == '11.8'
    # The commit holds the copy and nothing of the agent's own folder, and the agent's repository has no ref for it.
    assert (await git(*repository, 'ls-tree', '-r', '--name-only', commit, cwd=folder)).split() == [
        'notes.txt',
        'rerun.txt',
        'result.txt',
    ]
    assert 'rerun' not in await git('for-each-ref', cwd=taker)
    # The files of any other post are read in its author's folder, as before.
    assert evidence_repository(project, claim.post) == (project / '.verifold' / 'agents' / 'ada', ())

    await made.remove('p-4')
    assert not copy.exists()
    assert await git(*repository, 'show', f'{commit}:rerun.txt', cwd=folder) == '11.8'
    with pytest.raises(EvidenceRejected, match=r'The clean copy of post p-4 that Verifold made is gone\. `take_rerun`'):
        await made.pin('p-4', ('rerun.txt',))
    # The copy can be made again from the pinned commit, and another agent can rerun the check's own files.
    assert everything(await made.make(claim)) == {'notes.txt': 'How I got there.', 'result.txt': '11.8'}
    await agent_folder(project, 'cy')
    again = await Reruns(project, 'cy').make(
        Posted(seq=10, at=START, post=check.model_copy(update={'evidence': evidence}))
    )
    assert everything(again)['rerun.txt'] == '11.8'


async def test_a_check_names_plain_files_of_the_clean_copy_only(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    taker = await agent_folder(project, 'bo')
    made = Reruns(project, 'bo')
    secret = tmp_path / 'secret.env'
    secret.write_text('TOKEN=1')

    with pytest.raises(EvidenceRejected, match='that Verifold made is gone'):
        await made.pin('p-4', ('rerun.txt',))

    copy = await made.make(claim)
    (taker / 'mine.txt').write_text('Not in the copy.')
    (copy / 'link.env').symlink_to(secret)
    (copy / 'out').symlink_to(tmp_path)
    for path in ('mine.txt', '../../../mine.txt', 'link.env', 'out/secret.env'):
        with pytest.raises(EvidenceRejected, match='These are not plain files in the clean copy'):
            await made.pin('p-4', (path,))


async def test_a_link_planted_where_a_copy_goes_is_removed_as_a_link_and_nothing_outside_is_touched(
    tmp_path: Path,
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    taker = await agent_folder(project, 'bo')
    outside = tmp_path / 'outside'
    outside.mkdir()
    await git('init', '--quiet', cwd=outside)
    (outside / 'secret.env').write_text('TOKEN=1')
    before = everything(outside)
    slot = taker / '.verifold' / 'reruns'
    slot.mkdir(parents=True)
    (slot / 'p-4').symlink_to(outside)
    made = Reruns(project, 'bo')

    # Before a take, the link is no copy, so nothing is pinned through it.
    with pytest.raises(EvidenceRejected, match='that Verifold made is gone'):
        await made.pin('p-4', ('secret.env',))
    copy = await made.make(claim)

    assert not copy.is_symlink()
    assert everything(copy) == {'notes.txt': 'How I got there.', 'result.txt': '11.8'}
    # The agent swaps the copy for a link again. Verifold pins and removes nothing through it.
    (copy / 'rerun.txt').write_text('11.8')
    copy.rename(slot / 'kept')
    (slot / 'p-4').symlink_to(outside)
    with pytest.raises(EvidenceRejected, match='that Verifold made is gone'):
        await made.pin('p-4', ('secret.env',))
    await made.remove('p-4')
    assert (slot / 'p-4').is_symlink()
    assert everything(outside) == before
    assert await git('for-each-ref', cwd=outside) == ''
    # A folder that the agent planted in the copy's place is no copy either: the next take makes the copy again.
    (slot / 'p-4').unlink()
    (slot / 'p-4').mkdir()
    (slot / 'p-4' / 'result.txt').write_text('99.9')
    assert everything(await made.make(claim)) == {'notes.txt': 'How I got there.', 'result.txt': '11.8'}


@pytest.mark.parametrize('link', ['.verifold', '.verifold/reruns'])
async def test_a_link_on_the_way_to_the_copies_stops_the_copy_and_nothing_behind_it_changes(
    tmp_path: Path, link: str
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    taker = await agent_folder(project, 'bo')
    elsewhere = tmp_path / 'elsewhere'
    (elsewhere / 'reruns' / 'p-4').mkdir(parents=True)
    (elsewhere / 'p-4').mkdir()
    for precious in (elsewhere / 'reruns' / 'p-4' / 'precious', elsewhere / 'p-4' / 'precious'):
        precious.write_text('x')
    before = everything(elsewhere)
    (taker / link).parent.mkdir(exist_ok=True)
    (taker / link).symlink_to(elsewhere)
    made = Reruns(project, 'bo')

    with pytest.raises(NoCleanCopy, match='is a link or a file, so Verifold makes no copy behind it'):
        await made.make(claim)
    with pytest.raises(EvidenceRejected, match='that Verifold made is gone'):
        await made.pin('p-4', ('precious',))
    await made.remove('p-4')

    assert everything(elsewhere) == before


async def test_a_copy_that_fails_leaves_nothing_in_the_takers_folder_and_never_makes_the_authors_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    taker = await agent_folder(project, 'bo')
    made = Reruns(project, 'bo')

    # A commit that no snapshot of the author holds.
    lost = claim.model_copy(
        update={'post': claim.post.model_copy(update={'evidence': (FileEvidence(path='result.txt', commit='f' * 40),)})}
    )
    with pytest.raises(NoCleanCopy, match='Verifold could not make the clean copy of post p-4'):
        await made.make(lost)
    # A snapshot above the limit.
    monkeypatch.setattr(reruns, 'MAX_COPY_FILES', 1)
    with pytest.raises(NoCleanCopy, match=r'has 2 files and 20 bytes\. Verifold copies at most 1 files'):
        await made.make(claim)
    monkeypatch.undo()
    # An author whose folder is gone, or is a link.
    gone = claim.model_copy(update={'post': claim.post.model_copy(update={'author': 'zed'})})
    with pytest.raises(NoCleanCopy, match='is not a folder on this computer'):
        await made.make(gone)
    (project / '.verifold' / 'agents' / 'zed').symlink_to(tmp_path)
    with pytest.raises(NoCleanCopy, match='is a link to another place'):
        await made.make(gone)
    with pytest.raises(NoCleanCopy, match='pins no file'):
        await made.make(claim.model_copy(update={'post': claim.post.model_copy(update={'evidence': ()})}))

    assert not (taker / '.verifold' / 'reruns' / 'p-4').exists()
    assert not any(own_folder(project, 'bo', 'p-4').glob('copy-*'))
    # The copy still works afterwards.
    assert everything(await made.make(claim)) == {'notes.txt': 'How I got there.', 'result.txt': '11.8'}


async def test_takes_at_the_same_time_share_no_folder(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    for agent in ('bo', 'cy'):
        await agent_folder(project, agent)
    bo, cy = Reruns(project, 'bo'), Reruns(project, 'cy')

    copies = await asyncio.gather(bo.make(claim), cy.make(claim), bo.make(claim), cy.make(claim))

    assert copies[0] == copies[2] != copies[1] == copies[3]
    for copy in copies:
        assert everything(copy) == {'notes.txt': 'How I got there.', 'result.txt': '11.8'}
    assert not any(own_folder(project, 'bo', 'p-4').glob('copy-*'))


async def test_git_runs_no_hook_and_no_filter_that_a_copy_or_its_author_names(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    ran = tmp_path / 'ran'
    # The author's tree names a filter, and holds a link.
    (author / '.gitattributes').write_text('* filter=evil\n')
    (author / 'result.txt').write_text('11.8')
    (author / 'link').symlink_to('/etc/hosts')
    claim = await a_claim(project)
    await agent_folder(project, 'bo')
    made = Reruns(project, 'bo')

    copy = await made.make(claim)

    # A link in the tree is a plain file in the copy, with the link's target as its text.
    assert not (copy / 'link').is_symlink()
    assert (copy / 'link').read_text() == '/etc/hosts'
    # The taker plants a repository, hooks, a config with a filter and a watcher, and attributes that name them.
    hooks = copy / '.git' / 'hooks'
    hooks.mkdir(parents=True)
    for hook in ('reference-transaction', 'pre-commit', 'post-index-change'):
        (hooks / hook).write_text(f'#!/bin/sh\ntouch {ran}\n')
        (hooks / hook).chmod(0o755)
    (copy / '.git' / 'config').write_text(
        f'[core]\n\tfsmonitor = touch {ran}\n[filter "evil"]\n\tclean = touch {ran}; cat\n\tsmudge = touch {ran}; cat\n'
    )
    (copy / '.gitattributes').write_text('* filter=evil\n')
    (copy / 'rerun.txt').write_text('11.8')

    evidence = await made.pin('p-4', ('rerun.txt',))

    assert not ran.exists()
    folder, repository = evidence_repository(
        project,
        Check(id='p-5', thread='t-1', author='bo', text='So.', reply_to='p-4', outcome='holds', method='rerun', take=9),
    )
    assert await git(*repository, 'show', f'{evidence[0].commit}:rerun.txt', cwd=folder) == '11.8'
    assert not ran.exists()


async def test_a_pin_that_git_cannot_make_is_an_error_that_the_agent_reads(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    author = await agent_folder(project, 'ada')
    (author / '.gitignore').write_text('*.log\n')
    claim = await a_claim(project)
    taker = await agent_folder(project, 'bo')
    made = Reruns(project, 'bo')
    copy = await made.make(claim)
    (copy / 'run.log').write_text('ignored')

    with pytest.raises(EvidenceRejected, match=r'Git ignores these files, so they cannot be evidence: run\.log'):
        await made.pin('p-4', ('run.log',))
    # Verifold's own directory is broken, as after a disk error.
    (own_folder(project, 'bo', 'p-4') / 'git' / 'HEAD').unlink()
    with pytest.raises(EvidenceRejected, match='Verifold could not commit the clean copy of post p-4'):
        await made.pin('p-4', ('result.txt',))
    # The agent's own folder has the same rule: a folder that is no repository pins nothing, with a reason.
    plain = tmp_path / 'plain'
    plain.mkdir()
    (plain / 'a.txt').write_text('a')
    with pytest.raises(EvidenceRejected, match='Verifold could not commit your folder, so it pinned no file'):
        await pin(plain, 'bo', ('a.txt',))
    # A taker whose whole folder became a link has no copy.
    kept = tmp_path / 'kept'
    taker.rename(kept)
    taker.symlink_to(kept)
    with pytest.raises(EvidenceRejected, match='that Verifold made is gone'):
        await made.pin('p-4', ('result.txt',))
    await made.remove('p-4')
    assert (kept / '.verifold' / 'reruns' / 'p-4' / 'result.txt').exists()


async def test_a_planted_ignore_file_is_replaced_and_a_commit_outside_the_snapshots_is_refused(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    claim = await a_claim(project)
    author = project / '.verifold' / 'agents' / 'ada'
    taker = await agent_folder(project, 'bo')
    outside = tmp_path / 'outside.txt'
    outside.write_text('keep')
    slot = taker / '.verifold' / 'reruns'
    slot.mkdir(parents=True)
    (slot / '.gitignore').symlink_to(outside)

    await Reruns(project, 'bo').make(claim)

    assert (outside.read_text(), (slot / '.gitignore').read_text()) == ('keep', '*\n')
    # A commit of the author's repository that is in no snapshot of Verifold's.
    tree = await git('write-tree', cwd=author)
    stray = await git(
        '-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit-tree', tree, '-m', 'Stray', cwd=author
    )
    other = claim.post.model_copy(update={'id': 'p-6', 'evidence': (FileEvidence(path='result.txt', commit=stray),)})
    with pytest.raises(NoCleanCopy, match='No snapshot of ada holds the commit'):
        await Reruns(project, 'bo').make(claim.model_copy(update={'post': other}))
