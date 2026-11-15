import os
import stat
import sys
from pathlib import Path

import psutil
import pytest

from verifold.runner.git import MAX_SMALL_FILE, GitError, git, own_repository, small_text

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


async def test_a_git_that_does_not_end_is_stopped_at_the_time_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A stand-in for Git that runs for ten minutes.
    stand_in = tmp_path / 'bin' / 'git'
    stand_in.parent.mkdir()
    stand_in.write_text(f'#!{sys.executable}\nimport time\n\ntime.sleep(600)\n')
    stand_in.chmod(0o755)
    monkeypatch.setenv('PATH', f'{stand_in.parent}{os.pathsep}{os.environ["PATH"]}')
    monkeypatch.setattr('verifold.runner.git.GIT_SECONDS', 0.05)

    with pytest.raises(GitError, match=r'git status did not end in 0\.05 seconds, so Verifold ended it'):
        await git('status', cwd=tmp_path)

    # The process is gone: no child of this test runs the stand-in.
    assert not [child for child in psutil.Process().children(recursive=True) if str(stand_in) in child.cmdline()]


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
