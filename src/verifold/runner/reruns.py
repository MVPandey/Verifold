"""
The clean copy of the files that a post pins, for the agents that take its rerun.

For a rerun, Verifold writes nothing, deletes nothing, and runs no Git command inside any agent's folder. An agent
can change its own folder at any moment, so no check of a path there holds until the path is used.

The clean copy is an export in a folder of Verifold's own, `.verifold/reruns/<post>/<commit>/` in the project. It
holds exactly the tree of the commit that the post pins, as the bytes that Git stores: no line ends are converted,
and a link is a plain file with the link's target as its text. Every agent that takes the rerun of the post gets
the same folder. An agent reruns in its own folder, by its own means.

Verifold trusts the record, which holds the commit's ID, and nothing that a repository says. It reads the commit,
its trees, and its files as objects, and computes the ID of each one itself: the commit's must be the ID in the
record, each tree's the ID that its parent names, and each file's the ID that its tree names. It reads the trees
itself. A copy that exists already is checked in the same way, file for file, on every take, and one that differs
is thrown away and made again. Each take gets a manifest with the SHA-256 of every file, so the taker can check
what it reads.

Git reads the objects through a Git directory of Verifold's own, with the working directory in Verifold's own
folder, so it reads no configuration of a repository of the lab. Git fetches nothing that is missing, uses no
transport, replaces no object, runs no hook and no file watcher, and reads no configuration of the person or the
system. The Git processes of one export end at one time limit. The `objects` module holds this reader. Verifold
reaches its own folders through directory handles that follow no link.
"""

import asyncio
import hashlib
import os
import re
import secrets
import stat
import time
from collections.abc import Generator, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from functools import partial
from pathlib import Path

from verifold.protocol.events import Posted
from verifold.protocol.ids import AgentId, CommitId, PostId
from verifold.protocol.join import ManifestLine
from verifold.runner.folders import LAB_FOLDER
from verifold.runner.git import GitError
from verifold.runner.objects import Objects, PinnedCommit, Running, entries, object_hash, read_pinned, whole
from verifold.server.errors import NoCleanCopy
from verifold.server.lab import Lab
from verifold.server.member import MadeCopy
from verifold.society.reruns import copy_kept_until

RERUNS = 'reruns'
"""The folder in the lab's folder that holds the clean copies. It is Verifold's own, and no agent's folder holds it."""

MAX_COPY_FILES = 50_000
"""The most entries of a snapshot, files and folders, that Verifold exports for a rerun."""
MAX_COPY_BYTES = 2 * 1024**3
"""The most bytes of a snapshot's files."""
MAX_DEPTH = 64
"""The most folders inside each other."""
MAX_NAME_BYTES = 255
"""The most bytes of one name in a folder."""
MAX_LISTED_BYTES = 256 * 1024**2
"""The most bytes of all the folders' listings that Verifold reads for one export, each as often as it is named."""

EXPORT_SECONDS = 300.0
"""How long the Git processes of one export may run before Verifold ends them."""
LEFTOVER_SECONDS = 600.0
"""
How old a leftover of an export is before another export removes it. An export that runs now can belong to another
server of the same lab, and its unfinished folder is no leftover. No export runs for this long.
"""
EXPORTS_AT_ONCE = 2
"""How many exports run at the same time. The others wait, so slow ones cannot use up the server's threads."""

FRESH_SECONDS = 60.0
"""
How long after an export a post's copies stay, also when the record does not need them yet. The take that an export
is for comes into the record a moment after the copy.
"""

_POST_FOLDER = re.compile(r'p-[1-9][0-9]*')
"""The name of the folder that holds a post's copies: the post's ID. Verifold deletes no folder of another name."""

_FILE_MODES = {b'100644': 0o444, b'100664': 0o444, b'100755': 0o555, b'120000': 0o444}
"""
The mode of an exported file for each mode of a tree's entry. A link is exported as a plain file, and so is a
file with the mode that old versions of Git wrote for a file that its group can write.
"""

_FOLDER_MODE = 0o755
"""The mode of every folder of a copy."""

_FOLDER = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
"""How Verifold opens a folder of its own: as a folder, and never through a link."""

_CHUNK = 1024 * 1024


@dataclass(frozen=True, slots=True)
class _File:
    """One file of the pinned commit's tree: the ID of its bytes, and the mode of the exported file."""

    blob: str
    mode: int


type _Tree = dict[str, '_File | _Tree']
"""A folder of the pinned commit's tree: each name with its file or its folder."""


@dataclass(frozen=True, slots=True)
class _Job(PinnedCommit):
    """One export: the post's pinned commit, where its author's folder is, and the rules for Git."""

    post_id: PostId
    leftover: float = LEFTOVER_SECONDS
    """How old an unfinished folder or file of an export is before this export removes it."""


@dataclass(frozen=True, slots=True)
class Pruned:
    """What a prune of the clean copies did."""

    gone: tuple[PostId, ...] = ()
    """The posts whose copies it deleted."""
    fresh: float | None = None
    """The seconds until the copies that it left because their export was fresh may go, or `None` when it left none."""


class _Differs(Exception):
    """A copy that exists is not the pinned commit's files."""


class CleanCopies:
    """
    Gives the clean copy of the files that a post pins, verified at each call.

    A few exports run at the same time, and a call for a copy that is being made waits for that one.
    """

    def __init__(
        self,
        project: Path,
        *,
        seconds: float = EXPORT_SECONDS,
        at_once: int = EXPORTS_AT_ONCE,
        leftover_seconds: float = LEFTOVER_SECONDS,
    ) -> None:
        """
        Prepare the clean copies of the lab in `project`. The Git processes of one export may run for `seconds`.

        An export removes what an earlier export left behind once that is `leftover_seconds` old.
        """
        self._project = project
        self._seconds = seconds
        self._leftover = leftover_seconds
        self._free = asyncio.Semaphore(at_once)
        self._making: dict[tuple[PostId, CommitId], asyncio.Task[MadeCopy]] = {}
        self._running = Running()

    def stop(self) -> None:
        """
        End the Git process of every export that runs, now and from here on.

        A server that stops calls it, so that no export holds it until Git's time limit. The takes of those
        exports fail.
        """
        self._running.stop()

    async def __call__(self, claim: Posted) -> MadeCopy:
        """
        Return the clean copy of the files that a post pins, with its manifest, after Verifold verified it.

        Raises:
            NoCleanCopy: The post pins no file, Verifold found no repository of the lab that has the pinned
                commit, an object is not the one that its ID names, the snapshot is too large or has a name that
                is not safe to write, Git did not answer in time, or the copy could not be written.

        """
        post = claim.post
        if not post.evidence:
            raise NoCleanCopy(f'Post {post.id} pins no file, so it has no clean copy.')
        key = (post.id, post.evidence[0].commit)
        making = self._making.get(key)
        if making is None:
            making = asyncio.create_task(self._make(post.id, post.author, key[1]))
            self._making[key] = making
            making.add_done_callback(lambda _: self._making.pop(key, None))
            # An export whose only caller went away fails with nobody to tell, so its error is taken here.
            making.add_done_callback(lambda done: done.cancelled() or done.exception())
        try:
            # A caller that goes away leaves the export to the others that wait for it.
            return await asyncio.shield(making)
        except (GitError, OSError, ValueError, IndexError, RecursionError) as error:
            # The system's own error names the file that it was about, and the post's author chose that name.
            why = error.strerror if isinstance(error, OSError) and error.strerror else error
            raise NoCleanCopy(f'Verifold could not make the clean copy of post {post.id}: {why}') from error

    async def posts(self) -> frozenset[PostId]:
        """Return the posts whose copies are in Verifold's own folder for reruns: each folder with a post's ID."""
        return await asyncio.to_thread(_posts, self._project.resolve())

    async def prune(self, keep: frozenset[PostId]) -> Pruned:
        """
        Delete the clean copies of every post but those in `keep`, and return what went.

        A post's copies are the folder with the post's ID in Verifold's own folder for reruns, and only such a
        folder goes, by its name and never through a link: a link there goes as a link, and so does a link inside
        a copy. The copies that this server makes now stay, and so do the copies of an export less than
        `FRESH_SECONDS` ago.
        """
        busy = frozenset(post for post, _ in self._making)
        return await asyncio.to_thread(_prune, self._project.resolve(), keep | busy)

    async def kept(self, claim: Posted, digest: str) -> MadeCopy | None:
        """
        Return the clean copy of a post's files as a take left it, or `None` when it is not there as it was.

        It is there when its folder is and its manifest file has the SHA-256 `digest`. The check reads that one
        file through Verifold's own folder, and the copy that it returns has no lines of the manifest.
        """
        post = claim.post
        if not post.evidence:
            return None
        return await asyncio.to_thread(_kept, self._project.resolve(), post.id, post.evidence[0].commit, digest)

    async def _make(self, post_id: PostId, author: AgentId, commit: CommitId) -> MadeCopy:
        async with self._free:
            job = _Job(
                project=self._project.resolve(),
                author=author,
                commit=commit,
                seconds=self._seconds,
                running=self._running,
                post_id=post_id,
                leftover=self._leftover,
            )
            return await asyncio.to_thread(_export, job)


async def keep_copies(lab: Lab, copies: CleanCopies) -> None:
    """
    Delete each clean copy once nothing needs it, as `copy_kept_until` says, and every copy when the lab closes.

    It looks when the board changes, when the time that a copy is kept for passes, and when a copy that it left
    because its export was fresh is fresh no more. Run it while the lab runs. The first look also deletes the copies
    that an earlier run of Verifold left and that nothing needs.
    """
    while True:
        # Only the copies that are there count, so a look costs as much as the copies on disk, whatever the record.
        present = await copies.posts()
        board, now = lab.board, lab.now()
        kept = {post: until for post in present if (until := copy_kept_until(board, post, now))}
        pruned = await copies.prune(frozenset(kept))
        due = min(kept.values(), default=None)
        waits = [wait for wait in ((due - now).total_seconds() if due else None, pruned.fresh) if wait is not None]
        await lab.wait_for_change(board.seq, min(waits, default=None))


@contextmanager
def _copies_folder(project: Path) -> Generator[int]:
    """
    Open Verifold's own folder for the copies as `_own` does, and give its handle. It makes no folder.

    Raises:
        OSError: The folder is not there, or it is not a folder of this user's, or it lies behind a link.

    """
    held: list[int] = []
    try:
        held.append(_folder(project / LAB_FOLDER, str(project / LAB_FOLDER), None))
        held.append(_folder(project / LAB_FOLDER / RERUNS, RERUNS, held[-1]))
        yield held[-1]
    finally:
        for handle in held:
            os.close(handle)


def _posts(project: Path) -> frozenset[PostId]:
    try:
        with _copies_folder(project) as home:
            return frozenset(name for name in os.listdir(home) if _POST_FOLDER.fullmatch(name))  # noqa: PTH208
    except OSError:
        return frozenset()


def _prune(project: Path, keep: frozenset[PostId]) -> Pruned:
    # A folder that is not there, or not a folder of this user's, holds no copy to delete.
    gone: list[PostId] = []
    fresh: list[float] = []
    try:
        with _copies_folder(project) as home:
            _prune_in(home, keep, gone, fresh)
    except OSError:
        return Pruned(gone=tuple(gone))
    return Pruned(gone=tuple(gone), fresh=min(fresh, default=None))


def _prune_in(home: int, keep: frozenset[PostId], gone: list[PostId], fresh: list[float]) -> None:
    now = time.time()
    for name in os.listdir(home):
        if not _POST_FOLDER.fullmatch(name) or name in keep:
            continue
        with suppress(OSError):
            age = now - os.lstat(name, dir_fd=home).st_mtime
            if 0 <= age < FRESH_SECONDS:
                fresh.append(FRESH_SECONDS - age)
                continue
            _remove(home, name)
            gone.append(name)


def _export(job: _Job) -> MadeCopy:
    project, post_id, name = job.project, job.post_id, job.commit[:12]
    with _own(project, post_id) as home:
        _sweep(home, job.leftover)
        lines = tuple(sorted(read_pinned(job, partial(_copied, home, name)), key=lambda line: line.path))
        listed = ''.join(f'{line.sha256}  {line.path}\n' for line in lines).encode()
        _replace_file(home, f'{name}.manifest', listed)
        # The path that the taker gets must be the folder that Verifold holds, and no link that took its place.
        place = project / LAB_FOLDER / RERUNS / post_id
        held, there = os.fstat(home), place.lstat()
        if not stat.S_ISDIR(there.st_mode) or (there.st_dev, there.st_ino) != (held.st_dev, held.st_ino):
            raise GitError(f'{place} was replaced while Verifold made the copy.')
    folder, listing = _place(project, post_id, job.commit)
    return MadeCopy(folder=folder, files=lines, listing=listing, digest=hashlib.sha256(listed).hexdigest())


def _kept(project: Path, post_id: PostId, commit: str, digest: str) -> MadeCopy | None:
    # The copy and its manifest's file, read through the folders that Verifold holds, and never through a link.
    name = commit[:12]
    try:
        with _own(project, post_id) as home:
            if not stat.S_ISDIR(os.stat(name, dir_fd=home, follow_symlinks=False).st_mode):
                return None
            with os.fdopen(os.open(f'{name}.manifest', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=home), 'rb') as file:
                listed = file.read()
    except OSError:
        return None
    if hashlib.sha256(listed).hexdigest() != digest:
        return None
    folder, listing = _place(project, post_id, commit)
    return MadeCopy(folder=folder, files=(), listing=listing, digest=digest)


def _place(project: Path, post_id: PostId, commit: str) -> tuple[Path, Path]:
    # The folder of a post's copy at a commit, and the file of its manifest beside it.
    name = commit[:12]
    return project / LAB_FOLDER / RERUNS / post_id / name, project / LAB_FOLDER / RERUNS / post_id / f'{name}.manifest'


def _copied(home: int, name: str, objects: Objects, tree: str) -> list[ManifestLine]:
    # The manifest of the copy of a tree, from the objects of one store: of the copy that stands at its place when
    # it is exactly that tree's files, and else of a new one.
    folder = _walk(objects, tree, 0, [0, 0])
    lines = _verified(home, name, folder)
    if lines is None:
        try:
            lines = _fresh(home, name, folder, objects)
        except OSError:
            # Another server of the same lab can have made the copy in the meantime. It counts only when
            # it passes the same check.
            lines = _verified(home, name, folder)
            if lines is None:
                raise
    return lines


@contextmanager
def _own(project: Path, post_id: PostId) -> Generator[int]:
    """
    Open Verifold's own folder for the copies of one post, and give its handle.

    Each folder from the lab's folder down is opened as a folder through the handle of the one above, and never
    through a link, and it is this user's. So nothing that is swapped on the way later moves a write.
    """
    held: list[int] = []
    try:
        at = project / LAB_FOLDER
        held.append(_folder(at, str(at), None))
        for name in (RERUNS, post_id):
            at = at / name
            with suppress(FileExistsError):
                os.mkdir(name, 0o700, dir_fd=held[-1])
            held.append(_folder(at, name, held[-1]))
        yield held[-1]
    finally:
        for handle in held:
            os.close(handle)


def _folder(path: Path, name: str, inside: int | None) -> int:
    try:
        handle = os.open(name, _FOLDER, dir_fd=inside)
    except OSError as error:
        raise OSError(f'{path} is not a folder of yours, so Verifold keeps no copy there.') from error
    if os.fstat(handle).st_uid != os.getuid():
        os.close(handle)
        raise OSError(f'{path} is not a folder of yours, so Verifold keeps no copy there.')
    return handle


def _walk(objects: Objects, tree: str, depth: int, seen: list[int]) -> _Tree:
    # Read a folder's listing as Git stores it, and each folder inside it. `seen` counts every entry so far and
    # the bytes of every listing so far, so a few listings that name each other many times stop at a limit.
    # An error names a folder by its ID and never an entry by its name: the post's author chose the names, and
    # the error goes to the agent that takes the rerun.
    if depth > MAX_DEPTH:
        raise GitError(f'The snapshot has more than {MAX_DEPTH} folders inside each other.')
    data = whole(objects, tree, 'tree')
    seen[1] += len(data)
    if seen[1] > MAX_LISTED_BYTES:
        raise GitError(f"The snapshot's folders have listings of more than {MAX_LISTED_BYTES:,} bytes in all.")
    folder: _Tree = {}
    names: set[str] = set()
    for mode, name, child in entries(data, len(tree) // 2):
        seen[0] += 1
        if seen[0] > MAX_COPY_FILES:
            raise GitError(f'The snapshot has more than {MAX_COPY_FILES:,} files and folders.')
        text = _safe_name(name, tree)
        if len(child) != len(tree) or text.casefold() in names:
            raise GitError(
                f'The folder {tree} of the snapshot has an entry that Verifold does not write: the folder has its '
                f'name twice, also when the capitals differ, or the listing ends inside it.'
            )
        names.add(text.casefold())
        if mode == b'160000':
            # A submodule has no files here.
            continue
        if mode == b'40000':
            folder[text] = _walk(objects, child, depth + 1, seen)
        elif mode in _FILE_MODES:
            folder[text] = _File(blob=child, mode=_FILE_MODES[mode])
        else:
            raise GitError(
                f'The folder {tree} of the snapshot has an entry that Verifold does not write: it is no file, '
                f'folder, link, or submodule.'
            )
    return folder


def _safe_name(name: bytes, tree: str) -> str:
    try:
        text = name.decode()
    except UnicodeDecodeError:
        raise GitError(f'The folder {tree} of the snapshot has a name that is not UTF-8.') from None
    unsafe = (
        text in ('', '.', '..')
        or text.casefold() == '.git'
        or len(name) > MAX_NAME_BYTES
        or any(sign in '/\\' or not sign.isprintable() for sign in text)
    )
    if unsafe:
        raise GitError(
            f'The folder {tree} of the snapshot has an entry that Verifold does not write: its name is empty, '
            f'`.`, `..`, or `.git`, has more than {MAX_NAME_BYTES} bytes, or has a slash, a backslash, or a sign '
            f'that does not print.'
        )
    return text


def _fresh(home: int, name: str, folder: _Tree, objects: Objects) -> list[ManifestLine]:
    # Write the copy into a new folder beside its place, and give it its place when it is whole.
    making = f'.making-{secrets.token_hex(8)}'
    os.mkdir(making, _FOLDER_MODE, dir_fd=home)
    try:
        handle = os.open(making, _FOLDER, dir_fd=home)
        try:
            os.fchmod(handle, _FOLDER_MODE)
            lines = list(_write(handle, folder, '', objects, [0]))
        finally:
            os.close(handle)
        os.rename(making, name, src_dir_fd=home, dst_dir_fd=home)
    except BaseException:
        _remove(home, making)
        raise
    return lines


def _write(handle: int, folder: _Tree, prefix: str, objects: Objects, total: list[int]) -> Iterator[ManifestLine]:
    # Write each file as the bytes that Git stores for it, after a check of those bytes against the file's ID.
    for name, entry in folder.items():
        if isinstance(entry, dict):
            os.mkdir(name, _FOLDER_MODE, dir_fd=handle)
            inner = os.open(name, _FOLDER, dir_fd=handle)
            try:
                os.fchmod(inner, _FOLDER_MODE)
                yield from _write(inner, entry, f'{prefix}{name}/', objects, total)
            finally:
                os.close(inner)
            continue
        kind, size = objects.ask(entry.blob)
        total[0] += size
        if kind != 'blob' or total[0] > MAX_COPY_BYTES:
            raise GitError(
                f'The object {entry.blob} is no file that Verifold copies: it is a {kind}, or the snapshot has '
                f'more than {MAX_COPY_BYTES:,} bytes.'
            )
        named, plain = object_hash(entry.blob, 'blob', size), hashlib.sha256()
        file = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, entry.mode, dir_fd=handle)
        try:
            for piece in objects.read(size):
                named.update(piece)
                plain.update(piece)
                _write_all(file, piece)
            os.fchmod(file, entry.mode)
        finally:
            os.close(file)
        if named.hexdigest() != entry.blob:
            raise GitError(f'The file {entry.blob} in the repository is not the object that its ID names.')
        yield ManifestLine(path=f'{prefix}{name}', size=size, sha256=plain.hexdigest())


def _verified(home: int, name: str, folder: _Tree) -> list[ManifestLine] | None:
    """
    Return the manifest of the copy that stands at its place, when it is exactly the pinned commit's files.

    A copy that differs in any way is moved aside inside Verifold's own folder and removed, and `None` says that a
    new one is due. So is anything else at that place, such as a link.
    """
    try:
        handle = os.open(name, _FOLDER, dir_fd=home)
    except FileNotFoundError:
        return None
    except OSError:
        _discard(home, name)
        return None
    try:
        return list(_check(handle, folder, '', [0]))
    except (_Differs, OSError):
        _discard(home, name)
        return None
    finally:
        os.close(handle)


def _check(handle: int, folder: _Tree, prefix: str, total: list[int]) -> Iterator[ManifestLine]:
    if stat.S_IMODE(os.fstat(handle).st_mode) != _FOLDER_MODE or set(os.listdir(handle)) != set(folder):
        raise _Differs
    for name, entry in folder.items():
        if isinstance(entry, dict):
            inner = os.open(name, _FOLDER, dir_fd=handle)
            try:
                yield from _check(inner, entry, f'{prefix}{name}/', total)
            finally:
                os.close(inner)
            continue
        # A pipe at a file's place must not hold the reader, so the file is opened without waiting.
        file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=handle)
        try:
            found = os.fstat(file)
            total[0] += found.st_size
            if not stat.S_ISREG(found.st_mode) or stat.S_IMODE(found.st_mode) != entry.mode:
                raise _Differs
            if total[0] > MAX_COPY_BYTES:
                raise _Differs
            named, plain = object_hash(entry.blob, 'blob', found.st_size), hashlib.sha256()
            # The file is read as far as its size and one byte more, so one that grows meanwhile is not read on.
            left = found.st_size + 1
            while left and (piece := os.read(file, min(left, _CHUNK))):
                named.update(piece)
                plain.update(piece)
                left -= len(piece)
            if not left:
                raise _Differs
        finally:
            os.close(file)
        if named.hexdigest() != entry.blob:
            raise _Differs
        yield ManifestLine(path=f'{prefix}{name}', size=found.st_size, sha256=plain.hexdigest())


def _discard(home: int, name: str) -> None:
    # Move what stands at a copy's place aside, inside Verifold's own folder, and remove it. A link goes as a link.
    aside = f'.discarded-{secrets.token_hex(8)}'
    os.rename(name, aside, src_dir_fd=home, dst_dir_fd=home)
    _remove(home, aside)


_LEFT_OVER = ('.making-', '.discarded-', '.writing-')
"""How the names start of what an export that was cut off, or a removal that failed, can leave behind."""


def _sweep(home: int, older_than: float = LEFTOVER_SECONDS) -> None:
    # Remove what earlier exports of this post left behind. No such name is ever a copy that a taker gets. An
    # export of another server can write such a name at this moment, so only an old one goes: its age is its own
    # modification time, read through the folder that Verifold holds.
    now = time.time()
    for name in os.listdir(home):
        if not name.startswith(_LEFT_OVER):
            continue
        with suppress(OSError):
            if now - os.lstat(name, dir_fd=home).st_mtime >= older_than:
                _remove(home, name)


def _remove(inside: int, name: str) -> None:
    """
    Remove a file, a link, or a folder with all that it holds, by its name in a folder that Verifold holds.

    A link is removed as a link. A folder that its mode closes gets a mode that opens it for its owner first, so a
    planted copy with a folder that nobody can read goes too. What cannot be removed stays under its name, which
    is no copy's name.
    """
    try:
        if not stat.S_ISDIR(os.lstat(name, dir_fd=inside).st_mode):
            os.unlink(name, dir_fd=inside)
            return
    except OSError:
        return
    # Where the system can, the mode changes on the name itself and never on what a link there names.
    on_name = {'follow_symlinks': False} if os.chmod in os.supports_follow_symlinks else {}
    for opened in (False, True):
        try:
            handle = os.open(name, _FOLDER | os.O_NONBLOCK, dir_fd=inside)
        except OSError:
            if opened:
                return
            with suppress(OSError, NotImplementedError):
                os.chmod(name, 0o700, dir_fd=inside, **on_name)
            continue
        try:
            for inner in os.listdir(handle):  # noqa: PTH208
                _remove(handle, inner)
        finally:
            os.close(handle)
        with suppress(OSError):
            os.rmdir(name, dir_fd=inside)
        return


def _replace_file(home: int, name: str, data: bytes) -> None:
    # Write a file of Verifold's own anew: under another name first, and then in the place of what stood there.
    # A link there is replaced as a link.
    with suppress(OSError):
        if stat.S_ISDIR(os.lstat(name, dir_fd=home).st_mode):
            _remove(home, name)
    fresh = f'.writing-{secrets.token_hex(8)}'
    file = os.open(fresh, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444, dir_fd=home)
    try:
        _write_all(file, data)
        os.rename(fresh, name, src_dir_fd=home, dst_dir_fd=home)
    except BaseException:
        _remove(home, fresh)
        raise
    finally:
        os.close(file)


def _write_all(file: int, data: bytes) -> None:
    left = memoryview(data)
    while left:
        left = left[os.write(file, left) :]
