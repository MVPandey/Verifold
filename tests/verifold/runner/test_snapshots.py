from pathlib import Path

import pytest

from verifold.runner.folders import agent_folder
from verifold.runner.git import git
from verifold.runner.snapshots import pin, snapshot, snapshot_ref
from verifold.server.errors import EvidenceRejected


@pytest.fixture
async def folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An agent's worktree in a project with one commit, with no Git identity configured anywhere."""
    monkeypatch.setenv('HOME', str(tmp_path / 'home'))
    project = tmp_path / 'project'
    project.mkdir()
    (project / 'data.csv').write_text('x\n1\n')
    (project / '.gitignore').write_text('*.log\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=project)
    await git('add', '.', cwd=project)
    await git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'Start', cwd=project)
    return await agent_folder(project, 'ada')


async def test_a_snapshot_commits_the_folder_without_touching_its_branch_or_index(folder: Path) -> None:
    (folder / 'result.json').write_text('{"ratio": 11.8}')
    head = await git('rev-parse', 'HEAD', cwd=folder)
    status = await git('status', '--porcelain', cwd=folder)

    commit = await snapshot(folder, 'ada')

    assert await git('show', f'{commit}:result.json', cwd=folder) == '{"ratio": 11.8}'
    assert await git('rev-parse', snapshot_ref('ada'), cwd=folder) == commit
    assert await git('rev-parse', 'HEAD', cwd=folder) == head
    assert await git('status', '--porcelain', cwd=folder) == status


async def test_snapshots_chain_and_leave_ignored_files_out(folder: Path) -> None:
    first = await snapshot(folder, 'ada')
    (folder / 'notes.md').write_text('more')
    (folder / 'run.log').write_text('noise')

    second = await snapshot(folder, 'ada')

    assert await git('rev-parse', f'{second}^', cwd=folder) == first
    files = (await git('ls-tree', '-r', '--name-only', second, cwd=folder)).splitlines()
    assert 'notes.md' in files
    assert 'run.log' not in files


async def test_a_folder_without_commits_can_be_snapshotted(tmp_path: Path) -> None:
    project = tmp_path / 'plain'
    project.mkdir()
    folder = await agent_folder(project, 'bo')
    (folder / 'result.txt').write_text('done')

    commit = await snapshot(folder, 'bo')

    assert await git('show', f'{commit}:result.txt', cwd=folder) == 'done'


async def test_pinned_files_point_at_the_snapshot(folder: Path) -> None:
    (folder / 'results').mkdir()
    (folder / 'results' / 'bench.json').write_text('{}')

    evidence = await pin(folder, 'ada', ('results/bench.json', 'data.csv'))

    assert [item.path for item in evidence] == ['results/bench.json', 'data.csv']
    assert {item.commit for item in evidence} == {await git('rev-parse', snapshot_ref('ada'), cwd=folder)}


async def test_missing_and_ignored_files_cannot_be_evidence(folder: Path) -> None:
    (folder / 'run.log').write_text('noise')

    with pytest.raises(EvidenceRejected, match=r'not in your folder: nope\.txt'):
        await pin(folder, 'ada', ('nope.txt',))
    with pytest.raises(EvidenceRejected, match='Git ignores these files'):
        await pin(folder, 'ada', ('run.log',))
