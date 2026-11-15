"""
The objects of the commit that a post pins, read from a repository of the lab and checked.

Verifold trusts the record, which holds the commit's ID, and nothing that a repository says. It reads the commit,
its trees, and its files as objects, and computes the ID of each one itself: the commit's must be the ID in the
record, each tree's the ID that its parent names, and each file's the ID that its tree names. It reads the trees
itself. Verifold reads the clean copy for a rerun and the file that the app shows in this way.

Git reads the objects through a Git directory of Verifold's own, `.verifold/snapshots.git`, with the working
directory in Verifold's own folder. So Git reads the configuration that Verifold wrote there, and no configuration
of a repository of the lab. `GIT_OBJECT_DIRECTORY` names the object store that Git reads. Verifold finds the
stores itself, without Git: from the `.git` of the project and of the author's folder, through a `gitdir:` file
and a `commondir` file where they are. It reads the project's store first, and the next store when one fails. An
agent can write the store of its own folder, and can point these files at any other store. Git reads a store's
files as data, and Verifold checks the ID of every object that it takes from one. Git fetches nothing that is
missing, uses no transport, replaces no object, runs no hook and no file watcher, and reads no configuration of
the person or the system. The Git processes of one read end at one time limit, and when the server stops.
"""

import hashlib
import os
import re
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from threading import Lock, Timer
from typing import Protocol

from verifold.protocol.ids import AgentId, CommitId
from verifold.runner.environment import clean_environment
from verifold.runner.folders import LAB_FOLDER, agents_folder
from verifold.runner.git import GIT_ENVIRONMENT, GIT_OPTIONS, GitError, own_repository, small_text

READ_SECONDS = 30.0
"""How long the Git processes that read one file for the app may run before Verifold ends them."""

MAX_TREE_BYTES = 16 * 1024**2
"""The most bytes of one commit or of one folder's listing, which Verifold reads whole."""

MAX_FOLDER_ENTRIES = 50_000
"""The most entries of one folder's listing that Verifold reads on the way to one file. It holds each name once."""

_KINDS = {
    b'40000': 'a folder',
    b'100644': 'a file',
    b'100664': 'a file',
    b'100755': 'a file',
    b'120000': 'a link',
    b'160000': 'a submodule',
}
"""What an entry of a folder's listing is, by its mode."""

_OBJECT_KINDS = frozenset({'commit', 'tree', 'blob', 'tag'})
"""The kinds of object that Git has. An error names a kind only when it is one of these."""

_CHUNK = 1024 * 1024
_HASHES = {40: 'sha1', 64: 'sha256'}
"""The hash of a repository's object IDs, by the length of an ID."""


class _Digest(Protocol):
    """A running hash."""

    def update(self, data: bytes, /) -> None: ...

    def hexdigest(self) -> str: ...


class Missing(GitError):
    """The repositories of the lab that Verifold read lack an object, or the pinned commit has nothing at a path."""


class NoRepository(GitError):
    """Verifold found no repository of the lab that it can read and that has the pinned commit."""


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
    """How long the Git processes of one read may run, all of them together, before Verifold ends them."""
    running: Running


class Objects:
    """One Git process that gives the objects of one object store by their IDs, and that ends at a time limit."""

    def __init__(self, own: Path, store: Path, cwd: Path, seconds: float) -> None:
        """
        Start Git on Verifold's own Git directory `own`, with `store` as the object store that it reads.

        Git takes its configuration from `own` alone: `GIT_COMMON_DIR` keeps it there also when a file in `own`
        names another directory.
        """
        self._process = subprocess.Popen(
            ['git', *GIT_OPTIONS, f'--git-dir={own}', 'cat-file', '--batch'],
            cwd=cwd,
            env={
                **clean_environment(),
                **GIT_ENVIRONMENT,
                'GIT_COMMON_DIR': str(own),
                'GIT_OBJECT_DIRECTORY': str(store),
            },
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        # An object store can hold a pipe where Git expects a file. Git then waits for ever, and this ends it.
        self._limit = Timer(max(seconds, 0), self._process.kill)
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
        kind = said[1].decode(errors='replace')
        if kind not in _OBJECT_KINDS or not said[2].isdigit():
            raise GitError(f'Git gave no kind and size that Verifold knows for the object {name}.')
        return kind, int(said[2])

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


def whole(objects: Objects, name: str, kind: str) -> bytes:
    """
    Read a commit or a folder's listing whole, and check that it is the object that its ID names.

    Raises:
        GitError: The object is of another kind, it has more than `MAX_TREE_BYTES` bytes, or it is not the one
            that its ID names.

    """
    size = _asked(objects, name, kind)
    if size > MAX_TREE_BYTES:
        raise GitError(
            f'The {kind} {name} has {size:,} bytes, and Verifold reads at most {MAX_TREE_BYTES:,} bytes of one.'
        )
    return _checked(objects, name, kind, size)


def _asked(objects: Objects, name: str, kind: str) -> int:
    # Ask for an object of one kind, and return its size.
    found, size = objects.ask(name)
    if found != kind:
        raise GitError(f'The object {name} is a {found}, and Verifold reads a {kind} there.')
    return size


def _checked(objects: Objects, name: str, kind: str, size: int) -> bytes:
    # The bytes of the object that was asked for last, after a check that it is the object that its ID names.
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


def read_pinned[T](pinned: PinnedCommit, take: Callable[[Objects, str], T]) -> T:
    """
    Return what `take` makes of the pinned commit, from an object store that has it.

    `take` gets the store's objects and the ID of the commit's tree. Verifold reads the project's store first and
    the author's after it, each through Verifold's own Git directory. When a store fails in any way, the next one
    gets its turn, and `take` starts again there: the store lacks an object, holds a changed one, or does not
    answer in its share of the read's time limit. So an agent that changes the repository of its own folder takes
    no commit away that the project's repository has. In a project without Git commits, the author's store is the
    only one. Its author can withhold or change an object there, and the read then fails. Nothing can prevent
    that.

    Raises:
        NoRepository: Verifold found no object store, or could not read a file that names one, and every store
            that it read lacks the commit.
        Missing: Every store lacks the commit, or the store that has it lacks an object or the path that `take`
            asks for.
        GitError: What the stores hold is not what the commit names, or Git did not answer in time. Of the
            failures of several stores, this is the one that says most.

    """
    ends = time.monotonic() + pinned.seconds
    commit, lab = pinned.commit, pinned.project / LAB_FOLDER
    stores, unread = _stores(pinned)
    failed: list[tuple[bool, GitError]] = []
    for at, store in enumerate(stores):
        # Each store gets an equal share of the time that is left, so that one that waits leaves time for the next.
        objects = Objects(own_repository(lab), store, lab, (ends - time.monotonic()) / (len(stores) - at))
        pinned.running.add(objects)
        has_commit = False
        try:
            tree = _tree(objects, commit)
            has_commit = True
            return take(objects, tree)
        except GitError as error:
            failed.append((has_commit, error))
        finally:
            pinned.running.remove(objects)
            objects.close()
    # The failure that says most is one of a store that has the commit, and there one of an object that is wrong
    # before one of an object that is not there. Among equals it is the failure of the store that was read first.
    has_commit, most = max(failed, key=lambda one: (one[0], not isinstance(one[1], Missing)), default=(False, None))
    if most is not None and (has_commit or not isinstance(most, Missing)):
        raise most
    if unread or not stores:
        found = f'Verifold found no repository of the lab that it can read and that has the commit {commit}.'
        raise NoRepository(' '.join((found, *unread)))
    raise Missing(f'No repository of the lab has the commit {commit}. Verifold fetches nothing that is missing.')


def _tree(objects: Objects, commit: str) -> str:
    # The ID of a commit's tree, after a check that the commit is the object that its ID names.
    said = re.match(rb'tree ([0-9a-f]+)\n', whole(objects, commit, 'commit'))
    if said is None or len(said[1]) != len(commit):
        raise GitError(f'The commit {commit} names no tree.')
    return said[1].decode()


def _stores(pinned: PinnedCommit) -> tuple[tuple[Path, ...], tuple[str, ...]]:
    """
    Return the object stores that can have the pinned commit, and why Verifold could not read a place for one.

    The project comes first, and then the author's folder. In a project with Git commits, every agent's folder is
    a worktree of the project, so both name the project's store. In any other project, the author's folder is a
    repository of its own.
    """
    project = pinned.project
    # The project can be a folder inside a repository. Then the nearest `.git` above it counts, as it does for Git.
    above = next((folder for folder in (project, *project.parents) if os.path.lexists(folder / '.git')), None)
    stores: dict[Path, None] = {}
    unread: list[str] = []
    for folder in (above, agents_folder(project) / pinned.author):
        try:
            store = _store(folder) if folder else None
        except GitError as error:
            unread.append(str(error))
        else:
            if store:
                stores[store] = None
    return tuple(stores), tuple(unread)


def _store(folder: Path) -> Path | None:
    """
    Return the object store of the repository at a folder, or `None` when the folder has no `.git`.

    `.git` is a Git directory, or a file that names one after `gitdir:`. A `commondir` file in the Git directory
    names the directory that holds the objects, as in a worktree. An agent can point these files at any place.
    That is safe: Git reads a store's files as data and no configuration from there, and Verifold checks the ID of
    every object that it takes from a store.

    An error names `.git` at the folder, which is a path of Verifold's own, and never what a file there holds or
    a path that comes from one. An agent chooses that text, and an error goes to other agents and to the person.

    These lookups have no time limit. A path that an agent names can be on a file system that does not answer,
    and the lookup then holds the read's thread and its place among the reads until the system gives up.

    Raises:
        GitError: A file on the way is no small plain file, or it leads to no object store.

    """
    at = folder / '.git'
    if at.is_dir():
        home = at
    elif (pointer := small_text(at)) is None:
        return None
    elif pointer.startswith('gitdir:'):
        home = folder / pointer.removeprefix('gitdir:').strip()
    else:
        raise GitError(f'{at} names no Git directory.')
    try:
        common = small_text(home / 'commondir')
    except GitError:
        raise GitError(f'{at} leads to a `commondir` file that is no small plain text file.') from None
    store = (home if common is None else home / common.strip()) / 'objects'
    if not store.is_dir():
        raise GitError(f'{at} leads to no folder of Git objects.')
    return store.resolve()


def file_bytes(pinned: PinnedCommit, path: str, limit: int) -> bytes:
    """
    Return the bytes of the file at `path` in the pinned commit, as Git stores them.

    Verifold walks from the commit through each folder of the path to the file, and checks every object on the way
    against its ID. It reads a plain file only: no folder, no link, and no submodule.

    Raises:
        NoRepository: Verifold found no repository of the lab that it can read and that has the commit.
        Missing: The repositories of the lab lack the commit or an object of the path, or the commit has nothing
            at the path.
        TooLarge: The file has more than `limit` bytes.
        GitError: The path names no plain file, a listing on the way is one that Git never makes or is too large,
            an object is not the one that its ID names, or Git did not answer in time.

    """

    def take(objects: Objects, top: str) -> bytes:
        *folders, name = path.split('/')
        tree = top
        for folder in folders:
            tree = _entry(objects, tree, folder, 'a folder', path)
        blob = _entry(objects, tree, name, 'a file', path)
        size = _asked(objects, blob, 'blob')
        if size > limit:
            raise TooLarge(f'{path} has {size:,} bytes, and this read takes at most {limit:,}.')
        return _checked(objects, blob, 'blob', size)

    return read_pinned(pinned, take)


def _entry(objects: Objects, tree: str, name: str, kind: str, path: str) -> str:
    # The ID that a folder's listing gives a name, when the entry there is of the kind that the path needs.
    listing, wanted = whole(objects, tree, 'tree'), name.encode()
    entry: tuple[bytes, str] | None = None
    names: set[bytes] = set()
    try:
        for mode, found, child in entries(listing, len(tree) // 2):
            # Git never lists one name twice. With two, the file that a reader gets would depend on who reads.
            if found in names:
                raise GitError(f'The listing of the folder {tree} has one name twice.')
            if len(names) == MAX_FOLDER_ENTRIES:
                raise GitError(
                    f'The listing of the folder {tree} has more than {MAX_FOLDER_ENTRIES:,} entries, and Verifold '
                    f'reads at most that many on the way to one file.'
                )
            names.add(found)
            if found == wanted:
                entry = mode, child
    except ValueError:
        raise GitError(f'The listing of the folder {tree} ends inside an entry.') from None
    if entry is None:
        raise Missing(f'The pinned commit has no {path}.')
    mode, child = entry
    if len(child) != len(tree):
        raise GitError(f'The listing of the folder {tree} ends inside an entry.')
    if (is_a := _KINDS.get(mode, 'an entry of no kind that Verifold reads')) != kind:
        raise GitError(f'{name} is {is_a} in the pinned commit, so the commit has no file {path} to read.')
    return child
