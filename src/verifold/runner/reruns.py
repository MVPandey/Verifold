"""
The clean copy of the files that a post pins, for the agents that take its rerun.

For a rerun, Verifold writes nothing, deletes nothing, and runs no Git command inside any agent's folder. An agent
can change its own folder at any moment, so no check of a path there holds until the path is used.

The clean copy is an export in a folder of Verifold's own, `.verifold/reruns/<post>/<commit>/` in the project. It
holds exactly the tree of the commit that the post pins, as the bytes that Git stores: no line ends are converted,
and a link is a plain file with the link's target as its text. Nobody writes the files, and every agent that takes
the rerun of the post gets the same folder. An agent reruns in its own folder, by its own means.

Git reads the commit from a repository of the lab by the commit's ID, with the repository named by `--git-dir`
and the working directory in Verifold's own folder. Git fetches nothing that is missing, runs no hook, no file
watcher, and no command for a transport, and reads no configuration of the person or the system.
"""

import asyncio
import os
import shutil
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from threading import Thread
from typing import IO

from verifold.protocol.events import Posted
from verifold.protocol.ids import AgentId, CommitId, PostId
from verifold.runner.environment import clean_environment
from verifold.runner.folders import LAB_FOLDER, agents_folder
from verifold.runner.git import GitError
from verifold.server.errors import NoCleanCopy

RERUNS = 'reruns'
"""The folder in the lab's folder that holds the clean copies. It is Verifold's own, and no agent's folder holds it."""

MAX_COPY_FILES = 50_000
MAX_COPY_BYTES = 2 * 1024**3
"""The most files and bytes of a snapshot that Verifold exports for a rerun."""

GIT_OPTIONS = (
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.sshCommand=false',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.file.allow=always',
)
"""Options of every Git command for a rerun: no hook, no file watcher, and no transport that runs a command."""

GIT_ENVIRONMENT = {
    'GIT_NO_LAZY_FETCH': '1',
    'GIT_CONFIG_GLOBAL': os.devnull,
    'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_ATTR_NOSYSTEM': '1',
    'GIT_TERMINAL_PROMPT': '0',
}
"""Git fetches no object that a repository lacks, and reads no configuration of the person or the system."""

_FILE_MODES = {b'100644': 0o444, b'100755': 0o555, b'120000': 0o444}
"""The mode of an exported file for each mode of a tree's entry. A link is exported as a plain file."""

_CHUNK = 1024 * 1024


@dataclass(frozen=True, slots=True)
class _Entry:
    """One file of the pinned commit's tree."""

    path: str
    blob: bytes
    size: int
    mode: int


async def clean_copy(project: Path, claim: Posted) -> Path:
    """
    Return the clean copy of the files that a post pins, and make it when it is not there.

    The work on files runs in a thread, so a large snapshot does not hold up the server.

    Raises:
        NoCleanCopy: The post pins no file, no repository of the lab has the pinned commit, the snapshot is too
            large or has a name that is not safe to write, or the copy could not be written.

    """
    post = claim.post
    if not post.evidence:
        raise NoCleanCopy(f'Post {post.id} pins no file, so it has no clean copy.')
    try:
        return await asyncio.to_thread(_export, project.resolve(), post.id, post.author, post.evidence[0].commit)
    except (GitError, OSError) as error:
        raise NoCleanCopy(f'Verifold could not make the clean copy of post {post.id}: {error}') from error


def _export(project: Path, post_id: PostId, author: AgentId, commit: CommitId) -> Path:
    home = _own(project, post_id)
    copy = home / commit[:12]
    if _is_real(copy):
        return copy
    repository = _repository(project, author, commit, home)
    entries = _tree(repository, commit, home)
    total = sum(entry.size for entry in entries)
    if len(entries) > MAX_COPY_FILES or total > MAX_COPY_BYTES:
        raise GitError(
            f'The snapshot that the post pins has {len(entries):,} files and {total:,} bytes. Verifold copies at '
            f'most {MAX_COPY_FILES:,} files and {MAX_COPY_BYTES:,} bytes for a rerun.'
        )
    # The files appear in a folder beside the copy's place, and the copy gets its place when it is whole.
    fresh = Path(tempfile.mkdtemp(dir=home, prefix='.making-'))
    try:
        _write(repository, entries, fresh, home)
        fresh.chmod(0o755)
        try:
            fresh.rename(copy)
        except OSError:
            # Another take of the same post made the copy in the meantime.
            if not _is_real(copy):
                raise
    finally:
        shutil.rmtree(fresh, ignore_errors=True)
    return copy


def _is_real(folder: Path) -> bool:
    # Whether the path is a folder of this user's and no link.
    try:
        found = folder.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(found.st_mode) and found.st_uid == os.getuid()


def _own(project: Path, post_id: PostId) -> Path:
    # Verifold's own folder for the copies of one post. Each folder on the way is a real folder of this user's.
    lab = project / LAB_FOLDER
    if not _is_real(lab):
        raise OSError(f'{lab} is not a folder of yours, so Verifold keeps no copy there.')
    home = lab
    for name in (RERUNS, post_id):
        home = home / name
        home.mkdir(mode=0o700, exist_ok=True)
        if not _is_real(home):
            raise OSError(f'{home} is not a folder of yours, so Verifold keeps no copy there.')
    return home


def _git(repository: Path | None, *args: str, cwd: Path) -> bytes:
    # Run Git with the options for a rerun, on the repository that `--git-dir` names, and return its output.
    where = (f'--git-dir={repository}',) if repository else ()
    done = subprocess.run(
        ['git', *GIT_OPTIONS, *where, *args],
        cwd=cwd,
        env=clean_environment() | GIT_ENVIRONMENT,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
    )
    if done.returncode:
        raise GitError(f'git {" ".join(args)} failed: {done.stderr.decode(errors="replace").strip()}')
    return done.stdout


def _repository(project: Path, author: AgentId, commit: CommitId, home: Path) -> Path:
    """
    Return the Git directory of the lab that has the pinned commit.

    In a project with Git commits, every agent's folder is a worktree of the project, so the project's own Git
    directory has the commit. In any other project, the author's folder is a repository of its own. Verifold names
    that folder's `.git` only when it is a real folder, and follows no file or link that points elsewhere.
    """
    found: list[Path] = []
    try:
        common = _git(None, 'rev-parse', '--path-format=absolute', '--git-common-dir', cwd=project)
        found.append(Path(common.decode().strip()))
    except GitError:
        pass
    folder = agents_folder(project) / author
    if _is_real(folder) and _is_real(folder / '.git'):
        found.append(folder / '.git')
    for repository in found:
        try:
            _git(repository, 'cat-file', '-e', f'{commit}^{{commit}}', cwd=home)
        except GitError:
            continue
        return repository
    raise GitError(f'No repository of the lab has the commit {commit}. Verifold fetches nothing that is missing.')


def _tree(repository: Path, commit: CommitId, home: Path) -> tuple[_Entry, ...]:
    # The files of the commit's tree. A submodule has no files here. Any other kind of entry is refused.
    entries: list[_Entry] = []
    for line in _git(repository, 'ls-tree', '-r', '-z', '-l', commit, cwd=home).split(b'\0'):
        if not line:
            continue
        about, _, name = line.partition(b'\t')
        mode, kind, blob, size = about.split()
        if kind == b'commit':
            continue
        path = name.decode()
        parts = path.split('/')
        unsafe = any(part in ('', '.', '..') or part.casefold() == '.git' or '\\' in part for part in parts)
        if kind != b'blob' or mode not in _FILE_MODES or unsafe:
            raise GitError(f'The snapshot has an entry that Verifold does not write: {path!r}.')
        entries.append(_Entry(path=path, blob=blob, size=int(size), mode=_FILE_MODES[mode]))
    return tuple(entries)


def _write(repository: Path, entries: tuple[_Entry, ...], folder: Path, home: Path) -> None:
    # Write each file as the bytes that Git stores for it. One Git process gives all of them, in order.
    command = ['git', *GIT_OPTIONS, f'--git-dir={repository}', 'cat-file', '--batch']
    with subprocess.Popen(
        command,
        cwd=home,
        env=clean_environment() | GIT_ENVIRONMENT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ) as process:
        if process.stdin is None or process.stdout is None:
            raise GitError('git cat-file gave no pipes.')
        # The names go in from a thread of their own, so that a full pipe on either side blocks nothing.
        feeder = Thread(target=_feed, args=(process.stdin, entries), daemon=True)
        feeder.start()
        try:
            for entry in entries:
                header = process.stdout.readline().split()
                if len(header) != 3 or header[1] != b'blob' or int(header[2]) != entry.size:  # noqa: PLR2004
                    raise GitError(f'The repository does not have {entry.path} as the snapshot names it.')
                target = folder / entry.path
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as file:
                    left = entry.size
                    while left:
                        chunk = process.stdout.read(min(left, _CHUNK))
                        if not chunk:
                            raise GitError(f'Git ended before it gave all of {entry.path}.')
                        file.write(chunk)
                        left -= len(chunk)
                process.stdout.read(1)
                target.chmod(entry.mode)
        finally:
            process.kill()
            feeder.join()


def _feed(pipe: IO[bytes], entries: tuple[_Entry, ...]) -> None:
    try:
        for entry in entries:
            pipe.write(entry.blob + b'\n')
        pipe.close()
    except OSError:
        # The reader stopped and ended the process.
        return
