import os
import shutil
from pathlib import Path

import pytest
from plants import markers, old_snapshot, plain_git, program

from verifold.runner.errors import NoAgentFolder
from verifold.runner.folders import agent_folder
from verifold.runner.git import GitError, git, own_git
from verifold.runner.snapshots import pin, snapshot, snapshot_ref
from verifold.server.errors import EvidenceRejected


async def committed(path: Path) -> Path:
    """Make a project with one commit, whose `.gitignore` leaves log files out."""
    path.mkdir()
    (path / 'data.csv').write_text('x\n1\n')
    (path / '.gitignore').write_text('*.log\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=path)
    await git('add', '.', cwd=path)
    await git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'Start', cwd=path)
    return path


async def a_project(path: Path, *, with_commits: bool) -> Path:
    """Make a project in one of the two layouts, and give ada her folder: a worktree, or a repository of its own."""
    project = await committed(path) if with_commits else path
    project.mkdir(exist_ok=True)
    await agent_folder(project, 'ada')
    return project


@pytest.fixture
async def project(tmp_path: Path) -> Path:
    """A project with one commit, in which ada's folder is a worktree."""
    return await a_project(tmp_path / 'project', with_commits=True)


def folder_of(project: Path) -> Path:
    return project / '.verifold' / 'agents' / 'ada'


async def files_of(project: Path, commit: str) -> list[str]:
    """Return the path of every file that a snapshot holds."""
    return sorted((await own_git(project / '.verifold', 'ls-tree', '-r', '--name-only', commit)).splitlines())


def on_disk(folder: Path) -> list[str]:
    """Return the path of every file in a folder, but for the `.git` at its top."""
    paths = (path.relative_to(folder) for path in folder.rglob('*') if path.is_file())
    return sorted(str(path) for path in paths if path.parts[0] != '.git')


def everything(root: Path, but: Path | None = None) -> dict[str, bytes]:
    """Return every file under a folder with its bytes, but for the ones in the folder `but`."""
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob('*'))
        if path.is_file() and but not in path.parents
    }


async def test_a_snapshot_is_a_commit_in_verifolds_own_directory_and_touches_no_branch_or_index_of_the_agent(
    project: Path,
) -> None:
    folder, lab = folder_of(project), project / '.verifold'
    (folder / 'result.json').write_text('{"ratio": 11.8}')
    head = await git('rev-parse', 'HEAD', cwd=folder)
    status = await git('status', '--porcelain', cwd=folder)

    commit = await snapshot(project, 'ada')

    assert await own_git(lab, 'show', f'{commit}:result.json') == '{"ratio": 11.8}'
    assert await own_git(lab, 'rev-parse', snapshot_ref('ada')) == commit
    assert await git('rev-parse', 'HEAD', cwd=folder) == head
    assert await git('status', '--porcelain', cwd=folder) == status
    # The project's repository has neither the commit nor a ref for it.
    with pytest.raises(GitError):
        await git('cat-file', '-e', commit, cwd=project)
    assert await git('for-each-ref', 'refs/verifold', cwd=project) == ''
    # The index of the snapshot was in Verifold's own directory, and it is gone.
    assert sorted(path.name for path in (lab / 'snapshots.git').iterdir()) == ['HEAD', 'config', 'objects', 'refs']


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_snapshot_and_a_pin_change_nothing_in_the_agents_folder_or_in_a_repository_of_the_lab(
    tmp_path: Path, *, with_commits: bool
) -> None:
    project = await a_project(tmp_path / 'project', with_commits=with_commits)
    (folder_of(project) / 'result.txt').write_text('11.8')
    own = project / '.verifold' / 'snapshots.git'
    # Every file of the project: its repository, the agent's folder, and the `.git` of that folder.
    before = everything(project, own)

    await snapshot(project, 'ada')
    await pin(project, 'ada', ('result.txt',))

    assert everything(project, own) == before


async def test_snapshots_chain_and_leave_ignored_files_out(project: Path) -> None:
    folder = folder_of(project)
    first = await snapshot(project, 'ada')
    (folder / 'notes.md').write_text('more')
    (folder / 'run.log').write_text('noise')

    second = await snapshot(project, 'ada')

    lab = project / '.verifold'
    assert await own_git(lab, 'rev-parse', f'{second}^') == first
    # The `.gitignore` in the agent's folder is the project's, which leaves log files out.
    assert await files_of(project, second) == ['.gitignore', 'data.csv', 'notes.md']
    # Verifold's own directory loses its objects, and the ref then names a commit that is gone. The next
    # snapshot is a first one again.
    shutil.rmtree(lab / 'snapshots.git' / 'objects')
    third = await snapshot(project, 'ada')
    assert await own_git(lab, 'rev-list', '--count', third) == '1'
    assert await files_of(project, third) == ['.gitignore', 'data.csv', 'notes.md']


async def test_a_folder_without_commits_can_be_snapshotted(tmp_path: Path) -> None:
    project = await a_project(tmp_path / 'plain', with_commits=False)
    (folder_of(project) / 'result.txt').write_text('done')

    commit = await snapshot(project, 'ada')

    assert await own_git(project / '.verifold', 'show', f'{commit}:result.txt') == 'done'
    assert await files_of(project, commit) == ['result.txt']


async def test_pinned_files_point_at_the_snapshot(project: Path) -> None:
    folder = folder_of(project)
    (folder / 'results').mkdir()
    (folder / 'results' / 'bench.json').write_text('{}')

    evidence = await pin(project, 'ada', ('results/bench.json', 'data.csv'))

    assert [item.path for item in evidence] == ['results/bench.json', 'data.csv']
    assert {item.commit for item in evidence} == {
        await own_git(project / '.verifold', 'rev-parse', snapshot_ref('ada'))
    }


async def test_missing_and_ignored_files_cannot_be_evidence(project: Path) -> None:
    (folder_of(project) / 'run.log').write_text('noise')

    with pytest.raises(EvidenceRejected, match=r'not in your folder: nope\.txt'):
        await pin(project, 'ada', ('nope.txt',))
    with pytest.raises(EvidenceRejected, match='Git ignores these files'):
        await pin(project, 'ada', ('run.log',))


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_snapshot_runs_nothing_that_the_repository_of_the_agents_folder_names(
    tmp_path: Path, *, with_commits: bool
) -> None:
    project = await a_project(tmp_path / 'project', with_commits=with_commits)
    folder = folder_of(project)
    (folder / 'result.txt').write_text('11.8')
    # The agent's files ask Git for a filter, which the repository names below.
    (folder / '.gitattributes').write_text('* filter=evil\n')
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    (elsewhere / 'secret.txt').write_text('No file of the agent.')
    # The repository that Git finds from the agent's folder is the project's, or the folder's own. It names a
    # command where Git runs one at a commit: two hooks, a file watcher, and a filter.
    repository = project / '.git' if with_commits else folder / '.git'
    for hook in ('reference-transaction', 'post-index-change'):
        program(repository / 'hooks' / hook, tmp_path / f'ran-{hook}')
    watcher = program(tmp_path / 'watcher', tmp_path / 'ran-fsmonitor')
    config = repository / 'config'
    config.write_text(
        config.read_text()
        + f'[core]\n\tfsmonitor = {watcher}\n'
        + f'[filter "evil"]\n\tclean = "touch {tmp_path}/ran-clean; cat"\n'
    )
    # Git itself, run in the agent's folder as Verifold ran it before, runs each of them.
    await old_snapshot(folder, 'ada')
    assert markers(tmp_path) == ['ran-clean', 'ran-fsmonitor', 'ran-post-index-change', 'ran-reference-transaction']
    # The repository also names another folder as the one whose files Git commits. A worktree takes that
    # setting from a file of its own.
    if with_commits:
        config.write_text(config.read_text() + '[extensions]\n\tworktreeConfig = true\n')
        config = repository / 'worktrees' / 'ada' / 'config.worktree'
        config.touch()
    config.write_text(config.read_text() + f'[core]\n\tworktree = {elsewhere}\n')
    moved = await old_snapshot(folder, 'ada')
    assert await plain_git('ls-tree', '-r', '--name-only', moved, cwd=folder) == 'secret.txt'
    markers(tmp_path)
    files = on_disk(folder)

    commit = await snapshot(project, 'ada')
    evidence = await pin(project, 'ada', ('result.txt',))

    # No command ran, and each commit holds exactly the files of the agent's folder.
    assert markers(tmp_path) == []
    assert files == ['.gitattributes', *(('.gitignore', 'data.csv') if with_commits else ()), 'result.txt']
    assert [await files_of(project, one) for one in (commit, evidence[0].commit)] == [files, files]
    assert await own_git(project / '.verifold', 'show', f'{commit}:result.txt') == '11.8'


@pytest.mark.parametrize('shape', ['a file that names a Git directory of the agent', 'a bare repository'])
async def test_a_git_directory_that_the_agent_made_in_its_folder_is_files_and_no_more(
    tmp_path: Path, shape: str
) -> None:
    project = await a_project(tmp_path / 'project', with_commits=False)
    folder = folder_of(project)
    (folder / 'result.txt').write_text('11.8')
    if shape == 'a bare repository':
        # The folder has no `.git`, and it is itself shaped like a Git directory.
        shutil.rmtree(folder / '.git')
        made = folder
    else:
        (folder / '.git').rename(folder / 'first.git')
        (folder / '.git').write_text('gitdir: mine.git\n')
        made = folder / 'mine.git'
    await plain_git('init', '--quiet', '--bare', str(made), cwd=folder)
    watcher = program(tmp_path / 'watcher', tmp_path / 'ran-fsmonitor')
    program(made / 'hooks' / 'reference-transaction', tmp_path / 'ran-reference-transaction')
    config = made / 'config'
    config.write_text(config.read_text() + f'[core]\n\tbare = false\n\tworktree = {folder}\n\tfsmonitor = {watcher}\n')
    # Git itself finds that directory from the agent's folder, and runs what it names.
    await old_snapshot(folder, 'ada')
    assert markers(tmp_path) == ['ran-fsmonitor', 'ran-reference-transaction']
    files = on_disk(folder)

    commit = await snapshot(project, 'ada')

    # The snapshot holds the directory's files like any other file of the folder.
    assert markers(tmp_path) == []
    assert await files_of(project, commit) == files
    assert {'result.txt', str((made / 'config').relative_to(folder))} <= set(files)


async def test_a_repository_inside_the_folder_is_a_link_in_the_snapshot_and_runs_nothing(tmp_path: Path) -> None:
    project = await a_project(tmp_path / 'project', with_commits=False)
    inner = await committed(folder_of(project) / 'module')
    watcher = program(tmp_path / 'watcher', tmp_path / 'ran-fsmonitor')
    config = inner / '.git' / 'config'
    config.write_text(config.read_text() + f'[core]\n\tfsmonitor = {watcher}\n')
    # Git itself, run in that repository, asks the file watcher.
    await plain_git('status', cwd=inner)
    assert markers(tmp_path) == ['ran-fsmonitor']

    commit = await snapshot(project, 'ada')

    # The snapshot names the repository's commit, as for a submodule, and holds none of its files.
    assert markers(tmp_path) == []
    listed = await own_git(project / '.verifold', 'ls-tree', '-r', commit)
    assert listed == f'160000 commit {await git("rev-parse", "HEAD", cwd=inner)}\tmodule'


async def test_a_folder_that_is_a_link_or_is_gone_is_refused_and_nothing_is_written(
    project: Path, tmp_path: Path
) -> None:
    folder, elsewhere = folder_of(project), tmp_path / 'elsewhere'
    (folder / 'result.txt').write_text('11.8')
    # The agent's folder is moved away, and a link to it takes its place.
    folder.rename(elsewhere)
    before = everything(elsewhere)
    folder.symlink_to(elsewhere, target_is_directory=True)

    with pytest.raises(NoAgentFolder, match='is a link to another place'):
        await snapshot(project, 'ada')
    refused = 'Verifold could not commit your folder, so it pinned no file: .* is a link to another place'
    with pytest.raises(EvidenceRejected, match=refused):
        await pin(project, 'ada', ('result.txt',))
    # An agent without a folder has no snapshot either.
    with pytest.raises(NoAgentFolder, match='is not a folder on this computer'):
        await snapshot(project, 'zed')

    assert everything(elsewhere) == before
    assert not (project / '.verifold' / 'snapshots.git').exists()


async def test_a_folder_that_git_cannot_commit_is_an_error_that_the_agent_reads(project: Path) -> None:
    folder = folder_of(project)
    (folder / 'a.txt').write_text('a')
    # Git adds a repository inside the folder as a link to its commit, and this one has no commit.
    await git('init', '--quiet', str(folder / 'empty'), cwd=folder)

    with pytest.raises(EvidenceRejected, match='Verifold could not commit your folder, so it pinned no file: git '):
        await pin(project, 'ada', ('a.txt',))


async def test_a_git_that_waits_for_ever_in_the_agents_folder_ends_at_the_time_limit(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = folder_of(project)
    # A pipe where Git expects the list of ignored files. Git waits there for a writer that never comes.
    (folder / '.gitignore').unlink()
    os.mkfifo(folder / '.gitignore')
    monkeypatch.setattr('verifold.runner.git.GIT_SECONDS', 0.05)

    with pytest.raises(GitError, match=r'add --all did not end in 0\.05 seconds, so Verifold ended it'):
        await snapshot(project, 'ada')

    assert sorted(path.name for path in (project / '.verifold' / 'snapshots.git').glob('index-*')) == []


@pytest.mark.parametrize('named', ['in the configuration', 'in a file that the configuration includes', 'by default'])
async def test_the_persons_list_of_ignored_files_applies_and_no_filter_of_the_person_runs(
    project: Path, home: Path, tmp_path: Path, named: str
) -> None:
    folder = folder_of(project)
    for name in ('result.txt', '.DS_Store', 'run.log'):
        (folder / name).write_text('x')
    (folder / '.gitattributes').write_text('* filter=mine\n')
    # The person's own Git configuration has a filter, and it names their list of ignored files in one of three ways.
    config = f'[filter "mine"]\n\tclean = "touch {tmp_path}/ran-clean; cat"\n'
    if named == 'by default':
        (home / '.config' / 'git').mkdir(parents=True)
        (home / '.config' / 'git' / 'ignore').write_text('.DS_Store\n')
    else:
        (home / '.ignored').write_text('.DS_Store\n')
        (home / '.more').write_text('[core]\n\texcludesFile = ~/.ignored\n')
        config += (home / '.more').read_text() if named == 'in the configuration' else '[include]\n\tpath = ~/.more\n'
    (home / '.gitconfig').write_text(config)
    # Git itself, run in the agent's folder, leaves the file out and runs the person's filter.
    plain = await old_snapshot(folder, 'ada')
    assert markers(tmp_path) == ['ran-clean']
    assert '.DS_Store' not in await plain_git('ls-tree', '-r', '--name-only', plain, cwd=folder)

    commit = await snapshot(project, 'ada')

    # The snapshot leaves out what the person's list excludes and what the `.gitignore` in the folder excludes.
    assert markers(tmp_path) == []
    assert await files_of(project, commit) == ['.gitattributes', '.gitignore', 'data.csv', 'result.txt']


async def test_a_file_in_verifolds_own_directory_that_names_another_directory_moves_no_snapshot(
    project: Path, tmp_path: Path
) -> None:
    folder, lab = folder_of(project), project / '.verifold'
    (folder / 'result.txt').write_text('11.8')
    first = await snapshot(project, 'ada')
    own, aside = lab / 'snapshots.git', tmp_path / 'aside.git'
    # Somebody makes the own directory name another one for its configuration, its objects, and its refs, and
    # that one has a file watcher.
    shutil.copytree(own, aside)
    watcher = program(tmp_path / 'watcher', tmp_path / 'ran-fsmonitor')
    (aside / 'config').write_text((aside / 'config').read_text() + f'[core]\n\tfsmonitor = {watcher}\n')
    (own / 'commondir').write_text(f'{aside}\n')
    # Git itself then reads that configuration for a commit of the agent's folder.
    index = {'GIT_INDEX_FILE': str(tmp_path / 'index')}
    await plain_git(f'--git-dir={own}', f'--work-tree={folder}', 'add', '--all', cwd=lab, env=index)
    assert markers(tmp_path) == ['ran-fsmonitor']
    kept = everything(aside)
    (folder / 'result.txt').write_text('11.9')

    second = await snapshot(project, 'ada')

    # Nothing ran, nothing went into the other directory, and the commit is in Verifold's own with its parent.
    assert markers(tmp_path) == []
    assert everything(aside) == kept
    assert not (own / 'commondir').exists()
    assert (own / 'objects' / second[:2] / second[2:]).is_file()
    assert await own_git(lab, 'rev-parse', f'{second}^') == first
