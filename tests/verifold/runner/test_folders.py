import shutil
import sys
from pathlib import Path

import pytest
from plants import markers, plain_git, program

from verifold.runner.errors import NoAgentFolder, NoFileManager
from verifold.runner.folders import agent_folder, open_folder, real_folder, tracked_lab_files
from verifold.runner.git import GitError, commit_of, git


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

    assert await commit_of(project, 'HEAD')
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
    assert await commit_of(project, 'HEAD') is None


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


@pytest.mark.parametrize(
    'hook', ["in the repository's own folder of hooks", 'in a folder that its configuration names']
)
async def test_git_in_the_project_runs_no_hook_and_no_file_watcher_that_its_repository_names(
    tmp_path: Path, hook: str
) -> None:
    project = await committed_project(tmp_path / 'project')
    # The project's repository names a file watcher, and it has a hook that Git runs after a checkout.
    watcher = program(tmp_path / 'watcher', tmp_path / 'ran-fsmonitor')
    named = f'[core]\n\tfsmonitor = {watcher}\n'
    if hook == "in the repository's own folder of hooks":
        program(project / '.git' / 'hooks' / 'post-checkout', tmp_path / 'ran-post-checkout')
    else:
        program(tmp_path / 'hooks' / 'post-checkout', tmp_path / 'ran-post-checkout')
        named += f'[core]\n\thooksPath = {tmp_path / "hooks"}\n'
    config = project / '.git' / 'config'
    config.write_text(config.read_text() + named)
    # Git itself, in a copy of the project, asks the watcher when it lists files, and it runs the hook too when
    # it adds a worktree.
    unguarded = tmp_path / 'unguarded'
    shutil.copytree(project, unguarded)
    await plain_git('ls-files', cwd=unguarded)
    assert markers(tmp_path) == ['ran-fsmonitor']
    await plain_git('worktree', 'add', '--quiet', '-b', 'verifold/ada', str(tmp_path / 'out'), cwd=unguarded)
    assert markers(tmp_path) == ['ran-fsmonitor', 'ran-post-checkout']

    # Verifold's commands at a start and for a new agent run neither.
    assert await tracked_lab_files(project) == ()
    folder = await agent_folder(project, 'ada')

    assert markers(tmp_path) == []
    # The agent's folder is a worktree with the project's files.
    assert (folder / 'data.csv').read_text() == 'x,y\n1,2\n'
    assert await git('branch', '--show-current', cwd=folder) == 'verifold/ada'


async def test_the_persons_own_checkout_filter_still_runs_for_an_agents_worktree(tmp_path: Path, home: Path) -> None:
    # The person's own Git configuration has a filter for a checkout, as Git LFS has, and the project uses it.
    (home / '.gitconfig').write_text('[filter "mine"]\n\tsmudge = tr a-z A-Z\n')
    project = tmp_path / 'project'
    project.mkdir()
    (project / '.gitattributes').write_text('*.csv filter=mine\n')
    (project / 'data.csv').write_text('x,y\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=project)
    await git('add', '.', cwd=project)
    await git(
        '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Start', cwd=project
    )

    folder = await agent_folder(project, 'ada')

    assert (folder / 'data.csv').read_text() == 'X,Y\n'


async def track(project: Path, name: str) -> None:
    # Put a path in the index as written, whatever the file system does with its case.
    blob = await git('hash-object', '-w', '--stdin', cwd=project)
    await git('update-index', '--add', '--cacheinfo', f'100644,{blob},{name}', cwd=project)


async def test_tracked_lab_files_are_found_in_any_case_and_the_settings_file_is_allowed(tmp_path: Path) -> None:
    project = await committed_project(tmp_path / 'project')
    outside = tmp_path / 'outside'
    outside.mkdir()
    assert await tracked_lab_files(project) == ()
    assert await tracked_lab_files(outside) == ()

    await track(project, '.verifold/settings.json')
    await track(project, '.VERIFOLD/Settings.json')
    assert await tracked_lab_files(project) == ()

    # A file system that ignores case checks this out into `.verifold/`, so it counts as a lab file.
    await track(project, '.VERIFOLD/record.jsonl')
    assert await tracked_lab_files(project) == ('.VERIFOLD/record.jsonl',)


def opener(monkeypatch: pytest.MonkeyPatch, command: str) -> None:
    """Make `command` this platform's command that opens a folder."""
    monkeypatch.setattr('verifold.runner.folders.OPENERS', {sys.platform: command})


def test_a_folder_opens_with_the_platforms_command(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # `touch` stands in for the file manager: it changes the folder's time and opens nothing.
    before = tmp_path.stat().st_mtime_ns
    opener(monkeypatch, 'touch')

    open_folder(tmp_path)

    assert tmp_path.stat().st_mtime_ns >= before


def test_a_computer_without_an_opener_or_without_a_desktop_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(NoFileManager, match='no command that opens a folder'):
        open_folder(tmp_path)

    opener(monkeypatch, 'verifold-no-such-opener')
    with pytest.raises(NoFileManager, match='no command that opens a folder'):
        open_folder(tmp_path)

    # `false` fails as an opener does on a computer without a desktop.
    opener(monkeypatch, 'false')
    with pytest.raises(NoFileManager, match='may have no desktop'):
        open_folder(tmp_path)


def test_an_opener_that_does_not_end_in_time_does_not_count_as_opened(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = tmp_path / 'slow-opener'
    script.write_text('#!/bin/sh\nsleep 5\n')
    script.chmod(0o755)
    opener(monkeypatch, str(script))
    monkeypatch.setattr('verifold.runner.folders.OPEN_SECONDS', 0.2)

    with pytest.raises(NoFileManager, match=r'did not end in 0\.2 seconds'):
        open_folder(tmp_path)


def test_only_a_real_folder_of_the_lab_is_safe_to_open(tmp_path: Path) -> None:
    project, elsewhere = tmp_path / 'project', tmp_path / 'Calculator.app'
    agents = project / '.verifold' / 'agents'
    (agents / 'ada').mkdir(parents=True)
    elsewhere.mkdir()
    # An agent replaced its folder with a link to a program, which an opener would start.
    (agents / 'bo').symlink_to(elsewhere, target_is_directory=True)

    assert real_folder(project) == agents.resolve()
    assert real_folder(project, 'ada') == agents.resolve() / 'ada'
    with pytest.raises(NoAgentFolder, match='is a link to another place'):
        real_folder(project, 'bo')
    with pytest.raises(NoAgentFolder, match='is not a folder on this computer'):
        real_folder(project, 'cy')

    # A link on the way to the folder counts too.
    (project / '.verifold').rename(tmp_path / 'moved')
    (project / '.verifold').symlink_to(tmp_path / 'moved', target_is_directory=True)
    with pytest.raises(NoAgentFolder, match='is a link to another place'):
        real_folder(project, 'ada')
    with pytest.raises(NoAgentFolder, match='is a link to another place'):
        real_folder(project)


def test_an_opener_that_cannot_start_says_why(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    script = tmp_path / 'broken-opener'
    script.write_text('#!/no/such/interpreter\n')
    script.chmod(0o755)
    opener(monkeypatch, str(script))

    with pytest.raises(NoFileManager, match='did not start'):
        open_folder(tmp_path)
