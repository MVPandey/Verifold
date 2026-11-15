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

Git reads the objects from a repository of the lab by their IDs, with the repository named by `--git-dir` and
the working directory in Verifold's own folder. Git fetches nothing that is missing, uses no transport, replaces
no object, runs no hook and no file watcher, and reads no configuration of the person or the system. Every Git
process ends at a time limit. Verifold reaches its own folders through directory handles that follow no link.
"""

import asyncio
import hashlib
import os
import re
import secrets
import stat
import subprocess
from collections.abc import Generator, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from threading import Lock, Timer
from typing import Protocol

from verifold.protocol.events import Posted
from verifold.protocol.ids import AgentId, CommitId, PostId
from verifold.protocol.join import ManifestLine
from verifold.runner.environment import clean_environment
from verifold.runner.folders import LAB_FOLDER, agents_folder
from verifold.runner.git import GitError
from verifold.server.errors import NoCleanCopy
from verifold.server.member import MadeCopy

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
MAX_TREE_BYTES = 16 * 1024**2
"""The most bytes of one commit or of one folder's listing, which Verifold reads whole."""
MAX_LISTED_BYTES = 256 * 1024**2
"""The most bytes of all the folders' listings that Verifold reads for one export, each as often as it is named."""

EXPORT_SECONDS = 300.0
"""How long one Git process for an export may run before Verifold ends it."""
EXPORTS_AT_ONCE = 2
"""How many exports run at the same time. The others wait, so slow ones cannot use up the server's threads."""

FETCHES_NOTHING_FROM = (2, 45)
"""The first version of Git that fetches no missing object when `GIT_NO_LAZY_FETCH` says so."""

GIT_OPTIONS = ('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=false', '-c', 'protocol.allow=never')  # fmt: skip
"""
Options of every Git command for a rerun: no hook, no file watcher, and no transport. A repository's own
`protocol.<name>.allow` overrides `protocol.allow`, so that option alone stops no fetch from a repository that an
agent can write. `GIT_NO_LAZY_FETCH` does. With a Git that does not know it, Verifold reads a repository's
configuration itself first, and reads no repository whose configuration can make Git fetch.
"""

GIT_ENVIRONMENT = {
    'GIT_NO_LAZY_FETCH': '1',
    'GIT_NO_REPLACE_OBJECTS': '1',
    'GIT_CONFIG_GLOBAL': os.devnull,
    'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_ATTR_NOSYSTEM': '1',
    'GIT_TERMINAL_PROMPT': '0',
}
"""Git fetches no object that a repository lacks, replaces none, and reads no configuration of the person or the system."""

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
_HASHES = {40: 'sha1', 64: 'sha256'}
"""The hash of a repository's object IDs, by the length of an ID."""


@dataclass(frozen=True, slots=True)
class _File:
    """One file of the pinned commit's tree: the ID of its bytes, and the mode of the exported file."""

    blob: str
    mode: int


type _Tree = dict[str, '_File | _Tree']
"""A folder of the pinned commit's tree: each name with its file or its folder."""


@dataclass(frozen=True, slots=True)
class _Job:
    """One export: the post's pinned commit, where its author's folder is, and the rules for Git."""

    project: Path
    post_id: PostId
    author: AgentId
    commit: CommitId
    seconds: float
    fetches_nothing: bool
    running: '_Running'


class _Running:
    """The Git processes of the exports that run now, so that a server that stops can end them."""

    def __init__(self) -> None:
        self._held = Lock()
        self._processes: set[_Objects] = set()
        self._stopped = False

    def add(self, objects: '_Objects') -> None:
        with self._held:
            self._processes.add(objects)
            stopped = self._stopped
        if stopped:
            objects.kill()

    def remove(self, objects: '_Objects') -> None:
        with self._held:
            self._processes.discard(objects)

    def stop(self) -> None:
        with self._held:
            self._stopped = True
            running = tuple(self._processes)
        for objects in running:
            objects.kill()


class _Digest(Protocol):
    """A running hash."""

    def update(self, data: bytes, /) -> None: ...

    def hexdigest(self) -> str: ...


class _Missing(GitError):
    """A repository does not have an object."""


class _Differs(Exception):
    """A copy that exists is not the pinned commit's files."""


class CleanCopies:
    """
    Gives the clean copy of the files that a post pins, verified at each call.

    A few exports run at the same time, and a call for a copy that is being made waits for that one.
    """

    def __init__(self, project: Path, *, seconds: float = EXPORT_SECONDS, at_once: int = EXPORTS_AT_ONCE) -> None:
        """Prepare the clean copies of the lab in `project`. Each Git process for one may run for `seconds`."""
        self._project = project
        self._seconds = seconds
        self._free = asyncio.Semaphore(at_once)
        self._making: dict[tuple[PostId, CommitId], asyncio.Task[MadeCopy]] = {}
        self._fetches_nothing: bool | None = None
        """Whether this computer's Git fetches no missing object when told so. Asked once."""
        self._running = _Running()

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
            NoCleanCopy: The post pins no file, no repository of the lab has the pinned commit, an object is not
                the one that its ID names, the snapshot is too large or has a name that is not safe to write, Git
                did not answer in time, or the copy could not be written.

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
            raise NoCleanCopy(f'Verifold could not make the clean copy of post {post.id}: {error}') from error

    async def _make(self, post_id: PostId, author: AgentId, commit: CommitId) -> MadeCopy:
        async with self._free:
            if self._fetches_nothing is None:
                self._fetches_nothing = await asyncio.to_thread(fetches_nothing, self._seconds)
            job = _Job(
                self._project.resolve(), post_id, author, commit, self._seconds, self._fetches_nothing, self._running
            )
            return await asyncio.to_thread(_export, job)


def fetches_nothing(seconds: float = EXPORT_SECONDS) -> bool:
    """Return whether this computer's Git is new enough to fetch no missing object when Verifold says so."""
    try:
        said = subprocess.run(['git', '--version'], capture_output=True, check=False, timeout=seconds).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    version = re.search(rb'(\d+)\.(\d+)', said)
    return bool(version) and (int(version[1]), int(version[2])) >= FETCHES_NOTHING_FROM


def _export(job: _Job) -> MadeCopy:
    project, post_id, name = job.project, job.post_id, job.commit[:12]
    with _own(project, post_id) as home:
        _sweep(home)
        objects, tree = _pinned(job)
        try:
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
        finally:
            job.running.remove(objects)
            objects.close()
        lines = tuple(sorted(lines, key=lambda line: line.path))
        listed = ''.join(f'{line.sha256}  {line.path}\n' for line in lines).encode()
        _replace_file(home, f'{name}.manifest', listed)
        # The path that the taker gets must be the folder that Verifold holds, and no link that took its place.
        place = project / LAB_FOLDER / RERUNS / post_id
        held, there = os.fstat(home), place.lstat()
        if not stat.S_ISDIR(there.st_mode) or (there.st_dev, there.st_ino) != (held.st_dev, held.st_ino):
            raise GitError(f'{place} was replaced while Verifold made the copy.')
    return MadeCopy(
        folder=place / name,
        files=lines,
        listing=place / f'{name}.manifest',
        digest=hashlib.sha256(listed).hexdigest(),
    )


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


class _Objects:
    """One Git process that gives the objects of one repository by their IDs, and that ends at a time limit."""

    def __init__(self, repository: Path, cwd: Path, seconds: float) -> None:
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
            raise _Missing(f'The repository does not have the object {name}. Verifold fetches nothing that is missing.')
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


def _object_hash(name: str, kind: str, size: int) -> _Digest:
    # The hash that gives a Git object's ID: the object's kind and size, a zero byte, and its bytes.
    if len(name) not in _HASHES:
        raise GitError(f'{name!r} is no ID of a Git object.')
    return hashlib.new(_HASHES[len(name)], f'{kind} {size}\0'.encode(), usedforsecurity=False)


def _whole(objects: _Objects, name: str, kind: str) -> bytes:
    # Read a commit or a tree whole, and check that it is the object that its ID names.
    found, size = objects.ask(name)
    if found != kind or size > MAX_TREE_BYTES:
        raise GitError(f'The object {name} is no {kind} that Verifold reads: it is a {found} of {size:,} bytes.')
    digest = _object_hash(name, kind, size)
    data = b''.join(objects.read(size))
    digest.update(data)
    if digest.hexdigest() != name:
        raise GitError(f'The {kind} {name} in the repository is not the object that its ID names.')
    return data


def _pinned(job: _Job) -> tuple[_Objects, str]:
    """
    Open the repository of the lab that has the pinned commit, and return it with the ID of the commit's tree.

    In a project with Git commits, every agent's folder is a worktree of the project, so the project's own Git
    directory has the commit. In any other project, the author's folder is a repository of its own. Verifold names
    that folder's `.git` only when it is a real folder, and follows no file or link that points elsewhere.
    """
    project, author, commit, seconds = job.project, job.author, job.commit, job.seconds
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
    folder = agents_folder(project) / author
    theirs = folder / '.git'
    if _is_folder(folder) and _is_folder(theirs):
        found.append(theirs)
    for repository in found:
        if not job.fetches_nothing and (why := fetch_risk(repository)):
            # An agent of the lab can write its own repository, and the project's own through its worktree.
            version = '.'.join(map(str, FETCHES_NOTHING_FROM))
            raise GitError(
                f'{why} This computer has a Git from before {version}, which can then fetch what the repository '
                f'lacks from a place that the repository names, so Verifold does not read it. Git {version} or '
                f'later fetches nothing when Verifold says so, and makes the copy.'
            )
        objects = _Objects(repository, lab, seconds)
        job.running.add(objects)
        try:
            said = re.match(rb'tree ([0-9a-f]+)\n', _whole(objects, commit, 'commit'))
            if said is None or len(said[1]) != len(commit):
                raise GitError(f'The commit {commit} names no tree.')
        except _Missing:
            job.running.remove(objects)
            objects.close()
            continue
        except BaseException:
            job.running.remove(objects)
            objects.close()
            raise
        return objects, said[1].decode()
    raise GitError(f'No repository of the lab has the commit {commit}. Verifold fetches nothing that is missing.')


MAX_CONFIG_BYTES = 1024**2
"""The most bytes of a repository's configuration that Verifold reads itself."""

_SECTION = re.compile(r'\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\](.*)')
_KEY = re.compile(r'([A-Za-z][A-Za-z0-9-]*)\s*(=.*)?')


_RISKS = {
    'unread': 'Verifold cannot read the configuration of the repository {} with confidence.',
    'includes': 'The configuration of the repository {} takes in other configuration.',
    'remote': 'The configuration of the repository {} names a remote for objects that it lacks.',
}


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


def _walk(objects: _Objects, tree: str, depth: int, seen: list[int]) -> _Tree:
    # Read a folder's listing as Git stores it, and each folder inside it. `seen` counts every entry so far and
    # the bytes of every listing so far, so a few listings that name each other many times stop at a limit.
    if depth > MAX_DEPTH:
        raise GitError(f'The snapshot has more than {MAX_DEPTH} folders inside each other.')
    data = _whole(objects, tree, 'tree')
    seen[1] += len(data)
    if seen[1] > MAX_LISTED_BYTES:
        raise GitError(f"The snapshot's folders have listings of more than {MAX_LISTED_BYTES:,} bytes in all.")
    raw = len(tree) // 2
    folder: _Tree = {}
    names: set[str] = set()
    at = 0
    while at < len(data):
        space = data.index(b' ', at)
        end = data.index(b'\0', space)
        mode, name, child = data[at:space], data[space + 1 : end], data[end + 1 : end + 1 + raw].hex()
        at = end + 1 + raw
        seen[0] += 1
        if seen[0] > MAX_COPY_FILES:
            raise GitError(f'The snapshot has more than {MAX_COPY_FILES:,} files and folders.')
        text = _safe_name(name)
        if len(child) != len(tree) or text.casefold() in names:
            raise GitError(f'The snapshot has an entry that Verifold does not write: {text!r}.')
        names.add(text.casefold())
        if mode == b'160000':
            # A submodule has no files here.
            continue
        if mode == b'40000':
            folder[text] = _walk(objects, child, depth + 1, seen)
        elif mode in _FILE_MODES:
            folder[text] = _File(blob=child, mode=_FILE_MODES[mode])
        else:
            raise GitError(f'The snapshot has an entry that Verifold does not write: {text!r}.')
    return folder


def _safe_name(name: bytes) -> str:
    try:
        text = name.decode()
    except UnicodeDecodeError as error:
        raise GitError(f'The snapshot has a name that is not UTF-8: {name!r}.') from error
    unsafe = (
        text in ('', '.', '..')
        or text.casefold() == '.git'
        or len(name) > MAX_NAME_BYTES
        or any(sign in '/\\' or not sign.isprintable() for sign in text)
    )
    if unsafe:
        raise GitError(f'The snapshot has an entry that Verifold does not write: {text[:80]!r}.')
    return text


def _fresh(home: int, name: str, folder: _Tree, objects: _Objects) -> list[ManifestLine]:
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


def _write(handle: int, folder: _Tree, prefix: str, objects: _Objects, total: list[int]) -> Iterator[ManifestLine]:
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
                f'{prefix}{name} is no file that Verifold copies: it is a {kind}, or the snapshot has more than '
                f'{MAX_COPY_BYTES:,} bytes.'
            )
        named, plain = _object_hash(entry.blob, 'blob', size), hashlib.sha256()
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
            raise GitError(f'The file {prefix}{name} in the repository is not the object that its ID names.')
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
            named, plain = _object_hash(entry.blob, 'blob', found.st_size), hashlib.sha256()
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


def _sweep(home: int) -> None:
    # Remove what earlier exports of this post left behind. No such name is ever a copy that a taker gets.
    for name in os.listdir(home):
        if name.startswith(_LEFT_OVER):
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
