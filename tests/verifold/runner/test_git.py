import asyncio
import os
import shutil
import signal
import stat
import sys
from pathlib import Path

import psutil
import pytest
from builders import alive, until
from plants import process_ids, stand_in_git

from verifold.runner.git import MAX_SMALL_FILE, GitError, GitTimeout, git, own_repository, small_text

CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'


def test_verifolds_own_git_directory_is_a_bare_repository_that_verifold_writes_by_hand(tmp_path: Path) -> None:
    own = own_repository(tmp_path)

    assert own == tmp_path / 'snapshots.git'
    assert stat.S_IMODE(own.stat().st_mode) == 0o700
    assert sorted(path.name for path in own.iterdir()) == ['HEAD', 'config', 'objects', 'refs']
    assert ((own / 'HEAD').read_text(), (own / 'config').read_text()) == ('ref: refs/heads/main\n', CONFIG)
    # A later call returns the same directory and changes nothing.
    before = [(own / name).stat().st_mtime_ns for name in ('HEAD', 'config')]
    assert own_repository(tmp_path) == own
    assert [(own / name).stat().st_mtime_ns for name in ('HEAD', 'config')] == before


async def test_git_takes_the_own_directory_as_a_repository(tmp_path: Path) -> None:
    own = own_repository(tmp_path)

    assert await git(f'--git-dir={own}', 'rev-parse', '--is-bare-repository', cwd=tmp_path) == 'true'


def test_a_file_of_the_own_directory_that_somebody_changed_is_written_again(tmp_path: Path) -> None:
    own = own_repository(tmp_path)
    outside = tmp_path / 'outside'
    outside.write_text('[core]\n\tfsmonitor = true\n')
    (own / 'HEAD').write_text('ref: refs/heads/other\n')

    # The configuration has another text, is gone, is a link, and is a pipe.
    for change in ('rewritten', 'gone', 'a link', 'a pipe'):
        (own / 'config').unlink()
        if change == 'rewritten':
            (own / 'config').write_text(CONFIG + '[core]\n\tfsmonitor = true\n')
        elif change == 'a link':
            (own / 'config').symlink_to(outside)
        elif change == 'a pipe':
            os.mkfifo(own / 'config')
        own_repository(tmp_path)
        assert not (own / 'config').is_symlink(), change
        assert ((own / 'HEAD').read_text(), (own / 'config').read_text()) == ('ref: refs/heads/main\n', CONFIG), change
    # Nothing went through the link, and no unfinished file is left.
    assert outside.read_text() == '[core]\n\tfsmonitor = true\n'
    assert sorted(path.name for path in own.iterdir()) == ['HEAD', 'config', 'objects', 'refs']
    # A file that names another directory for the refs is removed.
    (own / 'commondir').write_text(f'{tmp_path}\n')
    own_repository(tmp_path)
    assert sorted(path.name for path in own.iterdir()) == ['HEAD', 'config', 'objects', 'refs']
    # A folder where the configuration belongs cannot be replaced, and the directory is then not used.
    (own / 'config').unlink()
    (own / 'config').mkdir()
    with pytest.raises(GitError, match='Verifold cannot write its own Git directory'):
        own_repository(tmp_path)
    assert sorted(path.name for path in own.iterdir()) == ['HEAD', 'config', 'objects', 'refs']


def test_the_own_directory_keeps_no_file_that_git_would_read_and_that_verifold_never_writes(tmp_path: Path) -> None:
    own = own_repository(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    for name in ('exclude', 'attributes', 'alternates'):
        (outside / name).write_text('x\n')
    planted = [own / 'commondir', own / 'info' / 'exclude', own / 'info' / 'attributes']
    planted.append(own / 'objects' / 'info' / 'alternates')

    # Somebody writes a list of ignored files, attributes, and the names of another directory and another store.
    (own / 'info').mkdir()
    (own / 'objects' / 'info').mkdir()
    for file in planted:
        file.write_text(f'{outside}\n')
    own_repository(tmp_path)
    assert [file.exists() for file in planted] == [False] * 4
    # A link stands where a folder of such a file belongs. The link goes, and nothing behind it.
    for folder in (own / 'info', own / 'objects' / 'info'):
        folder.rmdir()
        folder.symlink_to(outside, target_is_directory=True)
    own_repository(tmp_path)
    assert not (own / 'info').is_symlink()
    assert not (own / 'objects' / 'info').is_symlink()
    assert sorted(path.name for path in outside.iterdir()) == ['alternates', 'attributes', 'exclude']
    # A folder where such a file belongs cannot be removed, and the directory is then not used.
    (own / 'info').mkdir()
    (own / 'info' / 'exclude').mkdir()
    with pytest.raises(GitError, match='Verifold cannot write its own Git directory'):
        own_repository(tmp_path)


@pytest.mark.parametrize('name', ['objects', 'refs'])
def test_a_link_where_the_objects_or_the_refs_of_the_own_directory_belong_is_refused(tmp_path: Path, name: str) -> None:
    own = own_repository(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    shutil.rmtree(own / name)
    (own / name).symlink_to(outside, target_is_directory=True)

    with pytest.raises(GitError, match=f'{name} is no folder, so Verifold does not use'):
        own_repository(tmp_path)

    assert list(outside.iterdir()) == []


def a_git_with_a_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """
    Put a stand-in for Git on the path that starts a program and then waits for it, for ten minutes.

    The program holds the stand-in's output open. Return the files that get the process IDs of the two.
    """
    itself, child = tmp_path / 'git.pid', tmp_path / 'child.pid'
    stand_in_git(tmp_path, f'echo $$ > "{itself}"\nsleep 600 &\necho $! > "{child}"\nwait', monkeypatch)
    return itself, child


async def test_a_git_that_does_not_end_is_ended_at_the_time_limit_with_what_it_started(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = a_git_with_a_child(tmp_path, monkeypatch)
    monkeypatch.setattr('verifold.runner.git.GIT_SECONDS', 0.05)

    with pytest.raises(GitTimeout, match=r'git status did not end in 0\.05 seconds, so Verifold ended it'):
        await git('status', cwd=tmp_path)
    # A caller can name another limit.
    with pytest.raises(GitTimeout, match=r'did not end in 0\.02 seconds'):
        await git('status', cwd=tmp_path, seconds=0.02)

    # The error came at the limit, and not when the program that the stand-in started closed its output. The
    # stand-in is gone, and so is that program when the stand-in got as far as its start.
    assert not [one for one in psutil.Process().children(recursive=True) if 'bin/git' in ' '.join(one.cmdline())]
    await until(lambda: not any(alive(pid) for pid in process_ids(*started)))


async def test_a_cancel_ends_git_and_what_it_started(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    itself, child = a_git_with_a_child(tmp_path, monkeypatch)
    running = asyncio.create_task(git('status', cwd=tmp_path))
    await until(lambda: len(process_ids(itself, child)) == 2)
    both = process_ids(itself, child)
    assert all(alive(pid) for pid in both)

    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running

    await until(lambda: not any(alive(pid) for pid in both))


async def test_git_does_not_wait_for_a_program_that_holds_its_output_after_it_ended(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A stand-in for Git that starts a program, writes a line, and ends. The program leaves the stand-in's
    # process group, keeps the stand-in's output open, and runs for ten minutes.
    child = tmp_path / 'child.pid'
    leaves = 'import os, sys, time; os.setsid(); open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(600)'
    script = f'"{sys.executable}" -c \'{leaves}\' "{child}" &\nwhile [ ! -s "{child}" ]; do sleep 0.01; done\necho done'
    stand_in_git(tmp_path, script, monkeypatch)
    monkeypatch.setattr('verifold.runner.git.SETTLE_SECONDS', 0.05)

    try:
        assert await git('status', cwd=tmp_path) == 'done'
        # Git ended by itself, so Verifold ended nothing: the program still runs.
        assert [alive(pid) for pid in process_ids(child)] == [True]
    finally:
        for pid in process_ids(child):
            os.kill(pid, signal.SIGKILL)


def test_a_link_or_a_file_where_the_own_directory_belongs_is_refused(tmp_path: Path) -> None:
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    own = tmp_path / 'lab' / 'snapshots.git'
    own.parent.mkdir()

    own.symlink_to(elsewhere)
    with pytest.raises(GitError, match='is not a folder of yours'):
        own_repository(own.parent)
    own.unlink()
    own.write_text('x')
    with pytest.raises(GitError, match='is not a folder of yours'):
        own_repository(own.parent)
    with pytest.raises(GitError, match='is not a folder of yours'):
        own_repository(tmp_path / 'no lab')

    assert list(elsewhere.iterdir()) == []
    assert own.read_text() == 'x'


def test_only_a_small_plain_text_file_is_read(tmp_path: Path) -> None:
    plain = tmp_path / 'plain'
    plain.write_text('gitdir: /x\n')

    assert small_text(plain) == 'gitdir: /x\n'
    assert small_text(tmp_path / 'none') is None
    assert small_text(plain / 'under a file') is None
    # The longest file that is read, and one byte more.
    plain.write_bytes(b'x' * MAX_SMALL_FILE)
    assert small_text(plain) == 'x' * MAX_SMALL_FILE
    shapes = {
        'large': lambda path: path.write_bytes(b'x' * (MAX_SMALL_FILE + 1)),
        'a link': lambda path: path.symlink_to(plain),
        'a pipe': os.mkfifo,
        'a folder': Path.mkdir,
        'no text': lambda path: path.write_bytes(b'\xff\xfe'),
        'a zero byte': lambda path: path.write_bytes(b'gitdir: /x\0/y'),
    }
    for name, make in shapes.items():
        make(tmp_path / name)
        with pytest.raises(GitError, match='is no plain text file of at most 4,096 bytes'):
            small_text(tmp_path / name)
