"""
The objects of the commit that a post pins, read from a repository of the lab and checked.

Verifold trusts the record, which holds the commit's ID, and nothing that a repository says. It reads the commit,
its trees, and its files as objects, and computes the ID of each one itself: the commit's must be the ID in the
record, each tree's the ID that its parent names, and each file's the ID that its tree names. It reads the trees
itself. Verifold reads the clean copy for a rerun and the file that the app shows in this way.

Git reads the objects from a repository of the lab by their IDs, with the repository named by `--git-dir` and
the working directory in Verifold's own folder. Git fetches nothing that is missing, uses no transport, replaces
no object, runs no hook and no file watcher, and reads no configuration of the person or the system. Every Git
process ends at a time limit. Verifold runs no Git command in an agent's folder to read an object.
"""

import hashlib
import os
import re
import stat
import subprocess
from collections.abc import Generator, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from threading import Lock, Timer
from typing import Protocol

from verifold.protocol.ids import AgentId, CommitId
from verifold.runner.environment import clean_environment
from verifold.runner.folders import LAB_FOLDER, agents_folder
from verifold.runner.git import GIT_ENVIRONMENT, GIT_OPTIONS, GitError

READ_SECONDS = 30.0
"""How long the Git process that reads one file may run before Verifold ends it."""

MAX_TREE_BYTES = 16 * 1024**2
"""The most bytes of one commit or of one folder's listing, which Verifold reads whole."""

FETCHES_NOTHING_FROM = (2, 45)
"""The first version of Git that fetches no missing object when `GIT_NO_LAZY_FETCH` says so."""

MAX_CONFIG_BYTES = 1024**2
"""The most bytes of a repository's configuration that Verifold reads itself."""

_KINDS = {
    b'40000': 'a folder',
    b'100644': 'a file',
    b'100664': 'a file',
    b'100755': 'a file',
    b'120000': 'a link',
    b'160000': 'a submodule',
}
"""What an entry of a folder's listing is, by its mode."""

_CHUNK = 1024 * 1024
_HASHES = {40: 'sha1', 64: 'sha256'}
"""The hash of a repository's object IDs, by the length of an ID."""

_SECTION = re.compile(r'\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\](.*)')
_KEY = re.compile(r'([A-Za-z][A-Za-z0-9-]*)\s*(=.*)?')

_RISKS = {
    'unread': 'Verifold cannot read the configuration of the repository {} with confidence.',
    'includes': 'The configuration of the repository {} takes in other configuration.',
    'remote': 'The configuration of the repository {} names a remote for objects that it lacks.',
}


class _Digest(Protocol):
    """A running hash."""

    def update(self, data: bytes, /) -> None: ...

    def hexdigest(self) -> str: ...


class Missing(GitError):
    """No repository of the lab has an object, or the pinned commit has nothing at a path."""


class TooLarge(GitError):
    """An object has more bytes than the limit of its read."""


class Running:
    """The Git processes that read objects now, so that a server that stops can end them."""

    def __init__(self) -> None:
        """Start with no process."""
        self._held = Lock()
        self._processes: set[Objects] = set()
        self._stopped = False

    def add(self, objects: 'Objects') -> None:
        """Add a process. A process that is added after the stop ends at once."""
        with self._held:
            self._processes.add(objects)
            stopped = self._stopped
        if stopped:
            objects.kill()

    def remove(self, objects: 'Objects') -> None:
        """Remove a process whose read ended."""
        with self._held:
            self._processes.discard(objects)

    def stop(self) -> None:
        """End every process, now and from here on."""
        with self._held:
            self._stopped = True
            running = tuple(self._processes)
        for objects in running:
            objects.kill()


@dataclass(frozen=True, slots=True)
class PinnedCommit:
    """The commit that a post pins, where its author's folder is, and the rules for the Git that reads it."""

    project: Path
    author: AgentId
    commit: CommitId
    seconds: float
    """How long one Git process may run before Verifold ends it."""
    fetches_nothing: bool
    """Whether this computer's Git fetches no missing object when Verifold says so, as `fetches_nothing` tells."""
    running: Running


class Objects:
    """One Git process that gives the objects of one repository by their IDs, and that ends at a time limit."""

    def __init__(self, repository: Path, cwd: Path, seconds: float) -> None:
        """Start Git on the Git directory at `repository`, with `cwd` as its working directory."""
        self._process = subprocess.Popen(
            ['git', *GIT_OPTIONS, f'--git-dir={repository}', 'cat-file', '--batch'],
            cwd=cwd,
            env=clean_environment() | GIT_ENVIRONMENT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        # A repository can hold a pipe where Git expects a file. Git then waits for ever, and this ends it.
        self._limit = Timer(seconds, self._process.kill)
        self._limit.daemon = True
        self._limit.start()

    def kill(self) -> None:
        """End the Git process now. Whoever reads from it gets the error of a process that ended."""
        self._process.kill()

    def close(self) -> None:
        """End the Git process, and close its pipes."""
        self._limit.cancel()
        self._process.kill()
        for pipe in (self._process.stdin, self._process.stdout):
            if pipe:
                with suppress(OSError):
                    pipe.close()
        self._process.wait()

    def ask(self, name: str) -> tuple[str, int]:
        """Ask for an object, and return its kind and its size. Its bytes follow in `read`."""
        asked, answers = self._process.stdin, self._process.stdout
        if asked is None or answers is None:
            raise GitError('Git gave no pipes.')
        try:
            asked.write(name.encode() + b'\n')
            asked.flush()
        except OSError as error:
            raise GitError('Git ended before it gave every object, or it did not answer in time.') from error
        said = answers.readline().split()
        if len(said) == 2 and said[1] == b'missing':  # noqa: PLR2004
            raise Missing(f'The repository does not have the object {name}. Verifold fetches nothing that is missing.')
        if len(said) != 3:  # noqa: PLR2004
            raise GitError('Git ended before it gave every object, or it did not answer in time.')
        return said[1].decode(), int(said[2])

    def read(self, size: int) -> Iterator[bytes]:
        """Give the bytes of the object that was asked for last, in pieces."""
        answers = self._process.stdout
        left = size
        while left and answers:
            piece = answers.read(min(left, _CHUNK))
            if not piece:
                raise GitError('Git ended before it gave every object, or it did not answer in time.')
            left -= len(piece)
            yield piece
        if answers:
            answers.read(1)


def object_hash(name: str, kind: str, size: int) -> _Digest:
    """Return the running hash that gives a Git object's ID: of its kind and size, a zero byte, and then its bytes."""
    if len(name) not in _HASHES:
        raise GitError(f'{name!r} is no ID of a Git object.')
    return hashlib.new(_HASHES[len(name)], f'{kind} {size}\0'.encode(), usedforsecurity=False)


def whole(objects: Objects, name: str, kind: str, limit: int = MAX_TREE_BYTES) -> bytes:
    """
    Read an object whole, and check that it is the object that its ID names.

    Raises:
        TooLarge: The object is of this kind, and it has more than `limit` bytes.
        GitError: The object is of another kind, or it is not the one that its ID names.

    """
    found, size = objects.ask(name)
    if found != kind or size > limit:
        refused = TooLarge if found == kind else GitError
        raise refused(f'The object {name} is no {kind} that Verifold reads: it is a {found} of {size:,} bytes.')
    digest = object_hash(name, kind, size)
    data = b''.join(objects.read(size))
    digest.update(data)
    if digest.hexdigest() != name:
        raise GitError(f'The {kind} {name} in the repository is not the object that its ID names.')
    return data


def entries(listing: bytes, id_bytes: int) -> Iterator[tuple[bytes, bytes, str]]:
    """
    Give each entry of a folder's listing as Git stores it: its mode, its name, and the ID that it names.

    The last ID is shorter than `id_bytes` bytes when the listing ends inside it.

    Raises:
        ValueError: The listing ends inside a mode or a name.

    """
    at = 0
    while at < len(listing):
        space = listing.index(b' ', at)
        end = listing.index(b'\0', space)
        yield listing[at:space], listing[space + 1 : end], listing[end + 1 : end + 1 + id_bytes].hex()
        at = end + 1 + id_bytes


@contextmanager
def reading(pinned: PinnedCommit) -> Generator[tuple[Objects, str]]:
    """
    Open the repository of the lab that has the pinned commit, and give it with the ID of the commit's tree.

    In a project with Git commits, every agent's folder is a worktree of the project, so the project's own Git
    directory has the commit. In any other project, the author's folder is a repository of its own. Verifold names
    that folder's `.git` only when it is a real folder, and follows no file or link that points elsewhere.

    Raises:
        Missing: No repository of the lab has the commit.
        GitError: The commit is not the object that its ID names, Git did not answer in time, or this computer's
            Git is an older one and a repository's configuration can make it fetch.

    """
    project, commit, seconds = pinned.project, pinned.commit, pinned.seconds
    lab = project / LAB_FOLDER
    found: list[Path] = []
    with suppress(OSError, subprocess.SubprocessError):
        common = subprocess.run(
            ['git', *GIT_OPTIONS, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            cwd=project,
            env=clean_environment() | GIT_ENVIRONMENT,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=True,
            timeout=seconds,
        )
        found.append(Path(common.stdout.decode().strip()))
    folder = agents_folder(project) / pinned.author
    theirs = folder / '.git'
    if _is_folder(folder) and _is_folder(theirs):
        found.append(theirs)
    for repository in found:
        if not pinned.fetches_nothing and (why := fetch_risk(repository)):
            # An agent of the lab can write its own repository, and the project's own through its worktree.
            version = '.'.join(map(str, FETCHES_NOTHING_FROM))
            raise GitError(
                f'{why} This computer has a Git from before {version}, which can then fetch what the repository '
                f'lacks from a place that the repository names, so Verifold does not read it. Git {version} or '
                f'later fetches nothing when Verifold says so.'
            )
        objects = Objects(repository, lab, seconds)
        pinned.running.add(objects)
        try:
            try:
                said = re.match(rb'tree ([0-9a-f]+)\n', whole(objects, commit, 'commit'))
            except Missing:
                continue
            if said is None or len(said[1]) != len(commit):
                raise GitError(f'The commit {commit} names no tree.')
            yield objects, said[1].decode()
            return
        finally:
            pinned.running.remove(objects)
            objects.close()
    raise Missing(f'No repository of the lab has the commit {commit}. Verifold fetches nothing that is missing.')


def file_bytes(pinned: PinnedCommit, path: str, limit: int) -> bytes:
    """
    Return the bytes of the file at `path` in the pinned commit, as Git stores them.

    Verifold walks from the commit through each folder of the path to the file, and checks every object on the way
    against its ID. It reads a plain file only: no folder, no link, and no submodule.

    Raises:
        Missing: No repository of the lab has the commit or an object of the path, or the commit has nothing at
            the path.
        TooLarge: The file has more than `limit` bytes.
        GitError: The path names no plain file, an object is not the one that its ID names, or Git did not answer
            in time.

    """
    *folders, name = path.split('/')
    with reading(pinned) as (objects, top):
        tree = top
        for folder in folders:
            tree = _entry(objects, tree, folder, 'a folder', path)
        return whole(objects, _entry(objects, tree, name, 'a file', path), 'blob', limit)


def _entry(objects: Objects, tree: str, name: str, kind: str, path: str) -> str:
    # The ID that a folder's listing gives a name, when the entry there is of the kind that the path needs.
    listing, wanted = whole(objects, tree, 'tree'), name.encode()
    try:
        entry = next((entry for entry in entries(listing, len(tree) // 2) if entry[1] == wanted), None)
    except ValueError as error:
        raise GitError(f'The listing of the folder {tree} ends inside an entry.') from error
    if entry is None:
        raise Missing(f'The pinned commit has no {path}.')
    mode, _, child = entry
    if len(child) != len(tree):
        raise GitError(f'The listing of the folder {tree} ends inside an entry.')
    if (is_a := _KINDS.get(mode, 'an entry of no kind that Verifold reads')) != kind:
        raise GitError(f'{name} is {is_a} in the pinned commit, so the commit has no file {path} to read.')
    return child


def fetches_nothing(seconds: float = READ_SECONDS) -> bool:
    """Return whether this computer's Git is new enough to fetch no missing object when Verifold says so."""
    try:
        said = subprocess.run(['git', '--version'], capture_output=True, check=False, timeout=seconds).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    version = re.search(rb'(\d+)\.(\d+)', said)
    return bool(version) and (int(version[1]), int(version[2])) >= FETCHES_NOTHING_FROM


def fetch_risk(repository: Path) -> str | None:
    """
    Return why a repository's configuration can make an older Git fetch, or `None` when it cannot.

    Verifold reads the file itself, with no Git process: `config` in the Git directory, which for a worktree is
    the common directory's. The configuration is a risk when it can pull in other configuration, with an
    `include` or `includeIf` section or with `extensions.worktreeConfig`, and when it names a remote for missing
    objects, with `extensions.partialClone` or a remote's `promisor` or `partialCloneFilter`. A file that Verifold
    cannot read, or cannot read with confidence, is a risk too.
    """
    text = _config_text(repository)
    risk = 'unread' if text is None else _risk(text)
    return _RISKS[risk].format(repository) if risk else None


def _config_text(repository: Path) -> str | None:
    # The text of a repository's own configuration: a plain file of a bounded size, read through no link.
    try:
        file = os.open(repository / 'config', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        found = os.fstat(file)
        if not stat.S_ISREG(found.st_mode) or found.st_size > MAX_CONFIG_BYTES:
            return None
        return os.read(file, MAX_CONFIG_BYTES + 1).decode()
    except (OSError, UnicodeDecodeError):
        return None
    finally:
        os.close(file)


def _risk(text: str) -> str | None:
    section, continued = '', False
    for line in text.splitlines():
        rest, was_continued = line.strip(), continued
        continued = rest.endswith('\\')
        if not rest or rest[0] in '#;' or was_continued:
            # A line that goes on from the one before is part of a value.
            continue
        if header := _SECTION.fullmatch(rest):
            section, rest = header[1].casefold(), header[2].strip()
            if section in ('include', 'includeif'):
                return 'includes'
            if not rest or rest[0] in '#;':
                continue
        key = _KEY.fullmatch(rest)
        if key is None or '\0' in rest:
            return 'unread'
        if risk := _key_risk(section, key[1].casefold()):
            return risk
    return None


def _key_risk(section: str, name: str) -> str | None:
    if section == 'extensions':
        return {'worktreeconfig': 'includes', 'partialclone': 'remote'}.get(name)
    remote = section == 'remote' or section.startswith('remote.')
    return 'remote' if remote and name in ('promisor', 'partialclonefilter') else None


def _is_folder(path: Path) -> bool:
    # Whether the path is a folder and no link.
    try:
        return stat.S_ISDIR(path.lstat().st_mode)
    except OSError:
        return False
