"""
The clean copies in which an agent reruns the posts that it took, and the files that Verifold pins from them.

A clean copy is plain files inside the taker's own folder: the tree of the commit that the post pins, and nothing
else. It has no Git repository, so no later work of the author and no object store reaches the taker.

The taker can write its own folder, so Verifold trusts nothing there. It keeps a Git directory of its own for each
take in `.verifold/reruns/<agent>/<post>/`, outside every agent's folder, and every Git command for a copy names
that directory. Git then reads no configuration, no hook, and no filter from a place that the taker writes.
Verifold follows no link on the way to a copy, and it uses only a copy that it made itself: a marker beside its Git
directory holds the commit and the folder's identity on the file system.
"""

import asyncio
import os
import shutil
import tempfile
from pathlib import Path, PurePosixPath

from verifold.protocol.events import Posted
from verifold.protocol.ids import AgentId, CommitId, PostId
from verifold.protocol.posts import Check, FileEvidence, Post
from verifold.runner.errors import NoAgentFolder
from verifold.runner.folders import LAB_FOLDER, agents_folder, real_folder
from verifold.runner.git import GitError, git
from verifold.server.errors import EvidenceRejected, NoCleanCopy

RERUNS = 'reruns'
"""The name of the folder for reruns: Verifold's own in the lab's folder, and the copies' in a taker's folder."""

REF = 'refs/verifold/rerun'
"""The ref in a take's Git directory that holds the commits of the taker's check."""

MAX_COPY_FILES = 50_000
MAX_COPY_BYTES = 2 * 1024**3
"""The most files and bytes of a snapshot that Verifold copies for a rerun."""

_SAFE = ('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false')
"""Options for every Git command on a copy: no hook runs, and no program watches the files."""

_NO_CONFIG = {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_ATTR_NOSYSTEM': '1'}
"""
Git reads no configuration but the one of the repository that a command names. For a copy that is Verifold's own
directory, so no filter has a command, and a `.gitattributes` file in a copy can name none.
"""

_AUTHOR = {
    'GIT_AUTHOR_NAME': 'Verifold',
    'GIT_AUTHOR_EMAIL': 'verifold@localhost',
    'GIT_COMMITTER_NAME': 'Verifold',
    'GIT_COMMITTER_EMAIL': 'verifold@localhost',
}


def own_folder(project: Path, agent_id: AgentId, post_id: PostId) -> Path:
    """Return Verifold's own folder for an agent's rerun of a post, which is in no agent's folder."""
    return project.resolve() / LAB_FOLDER / RERUNS / agent_id / post_id


def evidence_repository(project: Path, post: Post) -> tuple[Path, tuple[str, ...]]:
    """
    Return where Git reads the files that a post pins: the folder to run in, and the options that name the repository.

    The files of a check from a clean copy are in Verifold's own Git directory for that take. The files of any other
    post are in the repository of its author's folder.
    """
    if isinstance(post, Check) and post.take is not None:
        own = own_folder(project, post.author, post.reply_to)
        return own, (*_SAFE, f'--git-dir={own / "git"}')
    return agents_folder(project) / post.author, ()


class Reruns:
    """
    Makes the clean copies for the reruns that one agent takes, inside that agent's own folder.

    Verifold starts nothing here. It copies the files of a post at the pinned commit, and how the agent runs them
    is the agent's business.
    """

    def __init__(self, project: Path, agent_id: AgentId) -> None:
        """Prepare the clean copies of one agent of the lab in `project`."""
        self._project = project
        self._agent_id = agent_id
        self._busy = asyncio.Lock()
        """Held while a copy is made, pinned, or removed, so that two calls of one agent never share a folder."""

    async def make(self, claim: Posted) -> Path:
        """
        Return the clean copy for the agent's rerun of a post, and make it when Verifold's own copy is not there.

        A folder or a link that Verifold did not make is not used: Verifold removes it, a link as a link, and makes
        the copy again from the pinned commit.

        Raises:
            NoCleanCopy: The post pins no file, a folder on the way is missing or a link, the snapshot is too
                large, or Git could not make the copy. Nothing of a failed copy stays in the agent's folder.

        """
        post = claim.post
        if not post.evidence:
            raise NoCleanCopy(f'Post {post.id} pins no file, so it has no clean copy.')
        async with self._busy:
            try:
                return await self._make(post, post.evidence[0].commit)
            except (GitError, OSError, NoAgentFolder) as error:
                raise NoCleanCopy(f'Verifold could not make the clean copy of post {post.id}: {error}') from error

    async def _make(self, post: Post, commit: CommitId) -> Path:
        own = own_folder(self._project, self._agent_id, post.id)
        copy = self._slot() / post.id
        if _is_made(own, copy, commit):
            return copy
        await self._fetch(own, post, commit)
        await _check_size(own, post.id, commit)
        # The files appear in Verifold's own folder first, and the copy gets its place when it is whole.
        fresh = Path(tempfile.mkdtemp(dir=own, prefix='copy-'))
        index = own / f'{fresh.name}.index'
        try:
            export = {'GIT_INDEX_FILE': str(index)}
            await _own(own, 'read-tree', commit, env=export)
            # A link in the author's tree becomes a plain file with the link's target as its text.
            await _own(own, '-c', 'core.symlinks=false', 'checkout-index', '--all', env=export, work_tree=fresh)
            _clear(copy)
            fresh.rename(copy)
        finally:
            index.unlink(missing_ok=True)
            shutil.rmtree(fresh, ignore_errors=True)
        made = copy.lstat()
        (own / 'made').write_text(f'{commit} {made.st_dev} {made.st_ino}\n')
        return copy

    def _slot(self) -> Path:
        # The folder in the agent's own folder that holds its copies, with no link on the way to it. Git leaves
        # everything in it out of the agent's own snapshots.
        slot = real_folder(self._project, self._agent_id)
        for name in (LAB_FOLDER, RERUNS):
            slot = slot / name
            if not slot.is_symlink():
                slot.mkdir(exist_ok=True)
            if slot.is_symlink() or not slot.is_dir():
                raise NoAgentFolder(f'{slot} is a link or a file, so Verifold makes no copy behind it.')
        ignore = slot / '.gitignore'
        if ignore.is_symlink():
            ignore.unlink()
        ignore.write_text('*\n')
        return slot

    async def _fetch(self, own: Path, post: Post, commit: CommitId) -> None:
        # Bring the pinned commit into Verifold's own Git directory for this take.
        (self._project.resolve() / LAB_FOLDER / RERUNS).mkdir(parents=True, exist_ok=True, mode=0o700)
        own.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not (own / 'git').exists():
            await git(*_SAFE, 'init', '--quiet', '--bare', str(own / 'git'), cwd=own, env=_NO_CONFIG)
        if isinstance(post, Check) and post.take is not None:
            # The files of a check from a clean copy are in Verifold's own directory for that take.
            source, ref = own_folder(self._project, post.author, post.reply_to) / 'git', REF
        else:
            # The author's folder is looked up as it is, and never made here.
            source = real_folder(self._project, post.author)
            listed = ('for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/verifold')
            refs = (await git(*_SAFE, *listed, cwd=source, env=_NO_CONFIG)).split()
            if not refs:
                raise GitError(f'No snapshot of {post.author} holds the commit {commit}.')
            ref = refs[0]
        await _own(own, 'fetch', '--quiet', str(source), ref)
        await _own(own, 'cat-file', '-e', f'{commit}^{{commit}}')

    async def pin(self, post_id: PostId, paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        """
        Commit the clean copy of a rerun into Verifold's own Git directory, and return each named file pinned to it.

        Raises:
            EvidenceRejected: The copy that Verifold made is gone, a path is no plain file inside it, Git ignores
                it, or Git could not commit the copy.

        """
        own = own_folder(self._project, self._agent_id, post_id)
        async with self._busy:
            copy = self._made(own, post_id)
            if copy is None:
                raise EvidenceRejected(
                    f'The clean copy of post {post_id} that Verifold made is gone. `take_rerun` makes it again.'
                )
            paths = tuple(str(PurePosixPath(path)) for path in paths)
            outside = [path for path in paths if not _plain_file(copy, path)]
            if outside:
                raise EvidenceRejected(f'These are not plain files in the clean copy: {", ".join(outside)}.')
            try:
                commit = await _commit(own, copy)
                tracked = set((await _own(own, 'ls-tree', '-r', '--name-only', commit)).splitlines())
            except (GitError, OSError) as error:
                raise EvidenceRejected(
                    f'Verifold could not commit the clean copy of post {post_id}: {error}'
                ) from error
        ignored = [path for path in paths if path not in tracked]
        if ignored:
            raise EvidenceRejected(f'Git ignores these files, so they cannot be evidence: {", ".join(ignored)}.')
        return tuple(FileEvidence(path=path, commit=commit) for path in paths)

    async def remove(self, post_id: PostId) -> None:
        """Remove the clean copy of a rerun that Verifold made. The files that a check pinned stay in Verifold's own directory."""
        own = own_folder(self._project, self._agent_id, post_id)
        async with self._busy:
            copy = self._made(own, post_id)
            if copy is not None:
                shutil.rmtree(copy, ignore_errors=True)
                (own / 'made').unlink(missing_ok=True)

    def _made(self, own: Path, post_id: PostId) -> Path | None:
        # The copy for a post when it is the one that Verifold made, with no link on the way to it.
        try:
            folder = real_folder(self._project, self._agent_id)
        except NoAgentFolder:
            return None
        slot = folder / LAB_FOLDER / RERUNS
        real = not (folder / LAB_FOLDER).is_symlink() and not slot.is_symlink()
        return slot / post_id if real and _is_made(own, slot / post_id) else None


def _is_made(own: Path, copy: Path, commit: CommitId | None = None) -> bool:
    # Whether the folder is the one that Verifold made for this take, and with `commit`, from that commit.
    marker = own / 'made'
    if copy.is_symlink() or not copy.is_dir() or not marker.is_file():
        return False
    was = marker.read_text().split()
    now = copy.lstat()
    return was[1:] == [str(now.st_dev), str(now.st_ino)] and commit in (None, was[0])


def _clear(copy: Path) -> None:
    # Remove what stands where the copy goes. A link is removed as a link, and nothing behind it is touched.
    if copy.is_symlink() or copy.is_file():
        copy.unlink()
    elif copy.exists():
        shutil.rmtree(copy)


def _plain_file(copy: Path, path: str) -> bool:
    # Whether the path is a file of the copy itself: no link, and no link on the way to it.
    file = copy / PurePosixPath(path)
    return file.is_file() and not file.is_symlink() and file.resolve().is_relative_to(copy.resolve())


async def _own(own: Path, *args: str, env: dict[str, str] | None = None, work_tree: Path | None = None) -> str:
    # Run Git on Verifold's own directory for a take. With `work_tree`, the files are the ones of the copy.
    where = (f'--git-dir={own / "git"}', *((f'--work-tree={work_tree}',) if work_tree else ()))
    return await git(*_SAFE, *where, *args, cwd=work_tree or own, env=_NO_CONFIG | (env or {}))


async def _check_size(own: Path, post_id: PostId, commit: CommitId) -> None:
    sizes = [line.split(maxsplit=4)[3] for line in (await _own(own, 'ls-tree', '-r', '-l', commit)).splitlines()]
    total = sum(int(size) for size in sizes if size.isdigit())
    if len(sizes) > MAX_COPY_FILES or total > MAX_COPY_BYTES:
        raise GitError(
            f'The snapshot that post {post_id} pins has {len(sizes):,} files and {total:,} bytes. Verifold copies '
            f'at most {MAX_COPY_FILES:,} files and {MAX_COPY_BYTES:,} bytes for a rerun.'
        )


async def _commit(own: Path, copy: Path) -> CommitId:
    # Commit the copy's files into Verifold's own directory, with an index of its own, and return the commit.
    index = own / 'pin.index'
    try:
        staged = {'GIT_INDEX_FILE': str(index)}
        await _own(own, 'add', '--all', '.', env=staged, work_tree=copy)
        tree = await _own(own, 'write-tree', env=staged)
    finally:
        index.unlink(missing_ok=True)
    commit = await _own(own, 'commit-tree', tree, '-m', f'Rerun in {copy.name}', env=_AUTHOR)
    await _own(own, 'update-ref', REF, commit)
    return commit
