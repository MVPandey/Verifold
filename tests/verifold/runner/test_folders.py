from pathlib import Path

import pytest

from verifold.runner.folders import agent_folder
from verifold.runner.git import GitError, git, has_commits


async def committed_project(path: Path) -> Path:
    path.mkdir()
    (path / 'data.csv').write_text('x,y\n1,2\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=path)
    await git('add', '.', cwd=path)
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Start', cwd=path)
    return path


async def test_git_ignores_variables_that_a_hook_sets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('GIT_DIR', str(tmp_path / 'elsewhere.git'))
    project = await committed_project(tmp_path / 'project')

    assert await has_commits(project)
    assert not (tmp_path / 'elsewhere.git').exists()


async def test_a_failed_git_command_raises_with_its_error(tmp_path: Path) -> None:
    with pytest.raises(GitError, match='not-a-command'):
        await git('not-a-command', cwd=tmp_path)


async def test_a_project_without_commits_gets_a_new_repository_per_agent(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    project.mkdir()

    folder = await agent_folder(project, 'ada')

    assert folder == project / '.verifold' / 'agents' / 'ada'
    assert (folder / '.git').is_dir()
    assert not await has_commits(project)


async def test_a_git_project_gives_each_agent_a_worktree_on_its_own_branch(tmp_path: Path) -> None:
    project = await committed_project(tmp_path / 'project')

    folder = await agent_folder(project, 'ada')

    assert (folder / 'data.csv').read_text() == 'x,y\n1,2\n'
    assert await git('branch', '--show-current', cwd=folder) == 'verifold/ada'
    assert await git('status', '--porcelain', cwd=project) == ''
    assert await agent_folder(project, 'ada') == folder


async def test_an_existing_agent_branch_is_reused(tmp_path: Path) -> None:
    project = await committed_project(tmp_path / 'project')
    await git('branch', 'verifold/bo', cwd=project)
    await agent_folder(project, 'ada')

    folder = await agent_folder(project, 'bo')

    assert await git('branch', '--show-current', cwd=folder) == 'verifold/bo'
    exclude = Path(await git('rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', cwd=project))
    assert exclude.read_text().count('/.verifold/') == 1
