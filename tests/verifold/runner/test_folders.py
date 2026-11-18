import asyncio
import errno
import os
import shutil
import signal
import sys
from contextlib import suppress
from pathlib import Path

import psutil
import pytest
from builders import alive, until
from plants import markers, move_clock, plain_git, plant, process_ids, program, stand_in_git

from verifold.runner import folders
from verifold.runner.errors import NoAgentFolder, NoFileManager
from verifold.runner.folders import PARTIAL_CLONE, agent_folder, open_folder, real_folder, tracked_lab_files
from verifold.runner.git import GitCut, GitError, GitTimeout, commit_of, git


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


async def a_project_whose_checkout_never_ends(tmp_path: Path, home: Path) -> tuple[Path, Path]:
    """
    Make a project whose files the person's own filter checks out, and make that filter never end.

    Return the project, and the file that gets the filter's process ID when Git has started the checkout.
    """
    started = tmp_path / 'filter.pid'
    (home / '.gitconfig').write_text(f'[filter "slow"]\n\tsmudge = "echo $$ > {started}; exec sleep 600"\n')
    project = tmp_path / 'project'
    project.mkdir()
    (project / '.gitattributes').write_text('*.csv filter=slow\n')
    (project / 'data.csv').write_text('x,y\n')
    await git('init', '--quiet', '--initial-branch=main', cwd=project)
    await git('add', '.', cwd=project)
    await git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'Start', cwd=project)
    return project, started


@pytest.mark.parametrize('cut', ['by a cancel', 'at the time limit'])
async def test_a_worktree_that_verifold_cut_leaves_nothing_of_its_own_in_the_project(
    tmp_path: Path, home: Path, monkeypatch: pytest.MonkeyPatch, cut: str
) -> None:
    project, started = await a_project_whose_checkout_never_ends(tmp_path, home)
    folder, entries = project / '.verifold' / 'agents' / 'ada', project / '.git' / 'worktrees'
    adding = asyncio.create_task(agent_folder(project, 'ada'))
    await until(lambda: bool(process_ids(started)))
    # Git is in the middle of the checkout: the folder, the worktree's entry, and the branch are there.
    assert (folder.is_dir(), [entry.name for entry in entries.iterdir()]) == (True, ['ada'])
    assert await git('branch', '--list', 'verifold/ada', cwd=project)

    if cut == 'by a cancel':
        adding.cancel()
        with pytest.raises(asyncio.CancelledError):
            await adding
    else:
        # The limit's time comes now, while Git works.
        move_clock(monkeypatch, 1800)
        with pytest.raises(GitTimeout, match=r'worktree add .* did not end in 1800 seconds, so Verifold ended it'):
            await adding

    # Git and the filter that it started are gone. Nothing of the worktree is left, and no lock of Git's.
    await until(lambda: not any(alive(pid) for pid in process_ids(started)))
    assert not folder.exists()
    assert not entries.exists() or list(entries.iterdir()) == []
    assert len((await git('worktree', 'list', cwd=project)).splitlines()) == 1
    assert await git('branch', '--list', 'verifold/ada', cwd=project) == ''
    assert list((project / '.git').rglob('*.lock')) == []
    # The project moves on. A later call makes the folder anew, at the project's last commit of then.
    (home / '.gitconfig').unlink()
    (project / 'later.txt').write_text('later')
    await git('add', '.', cwd=project)
    await git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'More', cwd=project)
    assert await agent_folder(project, 'ada') == folder
    assert ((folder / 'data.csv').read_text(), (folder / 'later.txt').read_text()) == ('x,y\n', 'later')


@pytest.mark.parametrize('with_commits', [True, False])
async def test_a_git_that_goes_on_is_killed_and_the_folder_of_the_call_goes_with_what_git_put_there(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, with_commits: bool
) -> None:
    project = await committed_project(tmp_path / 'project') if with_commits else tmp_path / 'project'
    project.mkdir(exist_ok=True)
    folder, started = project / '.verifold' / 'agents' / 'ada', tmp_path / 'git.pid'
    # A stand-in for Git that is Git itself, but for the command that fills the folder. That one puts a file
    # there and goes on when it is asked to end, so it removes nothing of what it made.
    script = (
        'for word in "$@"; do\n'
        '  if [ "$word" = add ] || [ "$word" = init ]; then\n'
        "    trap '' TERM\n"
        f'    touch "{folder}/half-made"\n'
        f'    echo $$ > "{started}"\n'
        '    while :; do sleep 0.01; done\n'
        '  fi\n'
        'done\n'
        f'exec "{shutil.which("git")}" "$@"'
    )
    stand_in_git(tmp_path, script, monkeypatch)
    monkeypatch.setattr('verifold.runner.git.SETTLE_SECONDS', 0.05)
    adding = asyncio.create_task(agent_folder(project, 'ada'))
    await until(lambda: bool(process_ids(started)))
    assert (folder / 'half-made').exists()

    adding.cancel()
    with pytest.raises(asyncio.CancelledError):
        await adding

    await until(lambda: not any(alive(pid) for pid in process_ids(started)))
    assert not folder.exists()


def _runs(process: psutil.Process, word: str) -> bool:
    # Whether a process runs a command with `word` in it. A child that ended and was not reaped has no command line.
    with suppress(psutil.Error):
        return word in process.cmdline()
    return False


async def test_a_worktree_whose_git_another_program_killed_goes_as_after_a_cut(tmp_path: Path, home: Path) -> None:
    project, started = await a_project_whose_checkout_never_ends(tmp_path, home)
    folder, entries = project / '.verifold' / 'agents' / 'ada', project / '.git' / 'worktrees'
    adding = asyncio.create_task(agent_folder(project, 'ada'))
    await until(lambda: bool(process_ids(started)))
    # The Git that this test's process started is the one that adds the worktree. It is in the checkout. The
    # worker that runs this test can have children of an earlier test that are not gone yet, so the test picks
    # its own Git by its command line.
    (adds,) = (child for child in psutil.Process().children() if _runs(child, 'worktree'))
    assert (folder.is_dir(), [entry.name for entry in entries.iterdir()]) == (True, ['ada'])

    os.kill(adds.pid, signal.SIGKILL)
    with pytest.raises(GitCut, match=r'git worktree add .* was ended by signal 9 before it was done'):
        await adding

    # Git removed nothing, and the filter that it started ran on. Verifold ended that, and removed what the
    # call made: the folder, the worktree's entry, and the branch.
    await until(lambda: not any(alive(pid) for pid in process_ids(started)))
    assert not folder.exists()
    assert not entries.exists() or list(entries.iterdir()) == []
    assert await git('branch', '--list', 'verifold/ada', cwd=project) == ''
    assert list((project / '.git').rglob('*.lock')) == []
    (home / '.gitconfig').unlink()
    assert (await agent_folder(project, 'ada') / 'data.csv').read_text() == 'x,y\n'


@pytest.mark.parametrize('holds', ["the project's last commit", 'nothing', 'another commit'])
async def test_a_cut_worktree_removes_the_lock_that_git_left_at_the_branch_of_the_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, holds: str
) -> None:
    project = await committed_project(tmp_path / 'project')
    head = await git('rev-parse', 'HEAD', cwd=project)
    folder, started = project / '.verifold' / 'agents' / 'ada', tmp_path / 'git.pid'
    lock = project / '.git' / 'refs' / 'heads' / 'verifold' / 'ada.lock'
    # A stand-in for Git that is Git itself, but for the command that adds the worktree. That one writes the
    # lock of the new branch, as Git does, with the branch's commit in it or before it wrote that, and never ends.
    written = {"the project's last commit": head, 'nothing': '', 'another commit': 'f' * 40}[holds]
    script = (
        'for word in "$@"; do\n'
        '  if [ "$word" = add ]; then\n'
        f'    mkdir -p "{lock.parent}"\n'
        f'    printf "{written and written + "\\n"}" > "{lock}"\n'
        f'    echo $$ > "{started}"\n'
        '    exec sleep 600\n'
        '  fi\n'
        'done\n'
        f'exec "{shutil.which("git")}" "$@"'
    )
    with monkeypatch.context() as patched:
        stand_in_git(tmp_path, script, patched)
        adding = asyncio.create_task(agent_folder(project, 'ada'))
        await until(lambda: bool(process_ids(started)))
        assert lock.read_text() == (written and f'{written}\n')

        adding.cancel()
        with pytest.raises(asyncio.CancelledError):
            await adding

    assert not folder.exists()
    if holds == 'another commit':
        # That lock is the one of another command that runs now, so it stays.
        assert lock.read_text() == f'{written}\n'
    else:
        assert not lock.exists()
        # So a later call makes the branch and the folder.
        assert (await agent_folder(project, 'ada') / 'data.csv').read_text() == 'x,y\n1,2\n'
        assert await git('rev-parse', 'verifold/ada', cwd=project) == head


async def test_a_new_folder_that_verifold_cannot_hold_open_does_not_stay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await committed_project(tmp_path / 'project')
    folder = project / '.verifold' / 'agents' / 'ada'
    open_file = os.open

    def full(path: object, *more: object, **options: object) -> int:
        # The process has too many files open at the moment when Verifold opens its new folder.
        if path == folder:
            raise OSError(errno.EMFILE, os.strerror(errno.EMFILE), str(path))
        return open_file(path, *more, **options)  # ty: ignore[invalid-argument-type]

    with monkeypatch.context() as patched:
        patched.setattr(os, 'open', full)
        with pytest.raises(OSError, match=os.strerror(errno.EMFILE)) as refused:
            await agent_folder(project, 'ada')
    assert refused.value.errno == errno.EMFILE

    # No empty folder is left that a later call would take for the agent's own, and that call makes the worktree.
    assert not folder.exists()
    assert (await agent_folder(project, 'ada') / 'data.csv').read_text() == 'x,y\n1,2\n'


async def test_a_cut_worktree_keeps_a_branch_that_was_there_before_the_call(tmp_path: Path, home: Path) -> None:
    project, started = await a_project_whose_checkout_never_ends(tmp_path, home)
    # The agent's branch is from an earlier lab.
    await git('branch', 'verifold/ada', cwd=project)
    adding = asyncio.create_task(agent_folder(project, 'ada'))
    await until(lambda: bool(process_ids(started)))

    adding.cancel()
    with pytest.raises(asyncio.CancelledError):
        await adding

    assert not (project / '.verifold' / 'agents' / 'ada').exists()
    assert await git('rev-parse', 'verifold/ada', cwd=project) == await git('rev-parse', 'HEAD', cwd=project)


@pytest.mark.parametrize(
    'appears',
    [
        'before Verifold makes the folder',
        'in the folder that Verifold made',
        'in the place of the folder that Verifold made',
        'in the place of the folder, and Verifold then ends Git',
    ],
)
async def test_a_folder_with_a_file_that_appears_before_git_starts_is_still_there_after_the_add_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, appears: str
) -> None:
    project = await committed_project(tmp_path / 'project')
    folder = project / '.verifold' / 'agents' / 'ada'
    commit_of_project, run_git = folders.commit_of, folders.git

    def put() -> None:
        # Another program makes the folder, or puts its file into the one that is there.
        if appears.startswith('in the place'):
            folder.rmdir()
        folder.mkdir(exist_ok=True)
        (folder / 'mine.txt').write_text('In no commit.')

    async def look(*args: object) -> str | None:
        if appears == 'before Verifold makes the folder':
            put()
        return await commit_of_project(*args)  # ty: ignore[invalid-argument-type]

    async def run(*args: str, **options: object) -> str:
        if args[:2] == ('worktree', 'add') and appears != 'before Verifold makes the folder':
            put()
            if appears.endswith('ends Git'):
                raise GitTimeout('git worktree add did not end in 1800 seconds, so Verifold ended it.')
        return await run_git(*args, **options)  # ty: ignore[invalid-argument-type]

    monkeypatch.setattr(folders, 'commit_of', look)
    monkeypatch.setattr(folders, 'git', run)
    refused = {
        'before Verifold makes the folder': (OSError, 'Something else made .* at the same moment'),
        'in the folder that Verifold made': (GitError, 'already exists'),
        'in the place of the folder that Verifold made': (GitError, 'already exists'),
        'in the place of the folder, and Verifold then ends Git': (GitTimeout, 'so Verifold ended it'),
    }[appears]

    with pytest.raises(refused[0], match=refused[1]):
        await agent_folder(project, 'ada')

    # The folder and its file are as that program left them, and Git made no worktree.
    assert (folder / 'mine.txt').read_text() == 'In no commit.'
    assert len((await run_git('worktree', 'list', cwd=project)).splitlines()) == 1


async def test_a_look_at_the_folder_that_the_system_refuses_makes_nothing_and_removes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = await committed_project(tmp_path / 'project')
    folder = await agent_folder(project, 'ada')
    (folder / 'work.txt').write_text('In no commit.')
    look = Path.lstat

    def refuse(path: Path) -> os.stat_result:
        # The system does not say whether the folder is there, as without the permission to look.
        if path == folder:
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), str(path))
        return look(path)

    monkeypatch.setattr(Path, 'lstat', refuse)

    with pytest.raises(OSError, match=r'Verifold cannot look at .*ada, so it makes no folder there'):
        await agent_folder(project, 'ada')

    monkeypatch.setattr(Path, 'lstat', look)
    # The worktree is as it was, with the work that is in no commit, and it still has its entry.
    assert (folder / 'work.txt').read_text() == 'In no commit.'
    assert len((await git('worktree', 'list', cwd=project)).splitlines()) == 2
    assert await agent_folder(project, 'ada') == folder


async def test_a_new_repository_that_git_could_not_make_leaves_no_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / 'project'
    project.mkdir()
    # A stand-in for Git that fails, and that makes a part of the new repository before it does.
    made = 'for word in "$@"; do if [ "$word" = init ]; then mkdir .git; echo half > .git/HEAD; fi; done'
    stand_in_git(tmp_path, f'{made}\nexit 1', monkeypatch)

    with pytest.raises(GitError, match='git init --quiet failed'):
        await agent_folder(project, 'ada')

    # The folder is gone with that part, so a later call does not take it for the agent's own.
    assert not (project / '.verifold' / 'agents' / 'ada').exists()


async def test_git_fetches_no_object_that_the_project_lacks_when_it_makes_an_agents_folder(tmp_path: Path) -> None:
    project = await committed_project(tmp_path / 'project')
    blob = await git('rev-parse', 'HEAD:data.csv', cwd=project)
    ran = tmp_path / 'ran'
    # The project's repository names a remote for the objects that it lacks, over a transport that runs a
    # command, and it lost a file of its last commit.
    store = plant(project / '.git', 'plain', ran, tmp_path / 'aside.git')
    (store / blob[:2] / blob[2:]).unlink()
    # Git itself, in a copy of the project, asks the remote for the file when it adds a worktree.
    unguarded = tmp_path / 'unguarded'
    shutil.copytree(project, unguarded)
    with suppress(GitError):
        await plain_git('worktree', 'add', '--quiet', '-b', 'verifold/ada', str(tmp_path / 'out'), cwd=unguarded)
    assert markers(tmp_path) == ['ran']

    with pytest.raises(GitError, match=r'git worktree add .* failed') as refused:
        await agent_folder(project, 'ada')

    # Verifold's Git asked nobody. The error says what to do, and no folder is left.
    assert markers(tmp_path) == []
    assert str(refused.value).endswith(f'\n{PARTIAL_CLONE}')
    assert not (project / '.verifold' / 'agents' / 'ada').exists()


async def test_a_worktree_that_git_refuses_in_an_ordinary_project_gives_gits_own_error_and_leaves_no_folder(
    tmp_path: Path,
) -> None:
    project = await committed_project(tmp_path / 'project')
    # The agent's branch is checked out in another worktree already, so Git refuses a second one.
    await git('worktree', 'add', '--quiet', '-b', 'verifold/ada', str(tmp_path / 'other'), cwd=project)

    with pytest.raises(GitError, match=r'git worktree add .* failed') as refused:
        await agent_folder(project, 'ada')

    assert PARTIAL_CLONE not in str(refused.value)
    assert not (project / '.verifold' / 'agents' / 'ada').exists()
    # The other worktree is as it was.
    assert (tmp_path / 'other' / 'data.csv').read_text() == 'x,y\n1,2\n'
    assert len((await git('worktree', 'list', cwd=project)).splitlines()) == 2


async def test_in_a_partial_clone_the_error_names_commands_that_fetch_what_the_folder_needs(tmp_path: Path) -> None:
    origin = await committed_project(tmp_path / 'origin')
    await git('config', 'uploadpack.allowFilter', 'true', cwd=origin)
    # A clone without the files of its commits, and without a checkout that would have fetched them.
    project = tmp_path / 'project'
    await plain_git(
        'clone', '--quiet', '--filter=blob:none', '--no-checkout', f'file://{origin}', str(project), cwd=tmp_path
    )

    with pytest.raises(GitError) as refused:
        await agent_folder(project, 'ada')
    assert str(refused.value).endswith(PARTIAL_CLONE)
    assert '`git worktree add --detach <a new folder> HEAD`' in PARTIAL_CLONE
    assert '`git worktree remove <that folder>`' in PARTIAL_CLONE
    # The person runs those two commands, which every Git with worktrees has. The folder then gets its files.
    fetched = str(tmp_path / 'fetched')
    await plain_git('worktree', 'add', '--detach', fetched, 'HEAD', cwd=project)
    await plain_git('worktree', 'remove', fetched, cwd=project)
    folder = await agent_folder(project, 'ada')

    assert (folder / 'data.csv').read_text() == 'x,y\n1,2\n'


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
