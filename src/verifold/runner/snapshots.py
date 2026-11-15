"""
Snapshots of agents' folders, as commits in a Git directory of Verifold's own.

A snapshot commits the files in an agent's folder that Git does not ignore, onto `refs/verifold/agents/<agent ID>`
in `.verifold/snapshots.git`. Agents cannot always commit from inside their harness's sandbox, so Verifold commits
for them, and evidence always points at a stable commit.

Every Git command for a snapshot names that directory and starts in Verifold's own folder. The one that reads the
agent's files, `git add`, names the agent's folder as its work tree and works there. So Git finds no repository
from the agent's folder, and it uses no configuration, hook, or filter of the folder's own repository or of the
project's. Nothing in the folder can name a program that runs. Git reads the agent's files, and its `.gitignore`
and `.gitattributes` files, as data: an attribute can ask for a filter, and no configuration that Git reads names
a program for one. An attribute can also ask Git to store other bytes than the file's: other line ends, another
encoding, or a short `$Id$` line. Git records a repository inside the folder as that repository's one commit,
without its files. For that it reads the repository's HEAD and its format settings, also through a `.git` file
there that names another Git directory. Git reads no configuration of the person or the system either, so the
person's filters and signing do not run. A snapshot writes nothing in the agent's folder, and nothing in a
repository of the lab.
"""

import asyncio
import tempfile
from pathlib import Path, PurePosixPath

from verifold.protocol.ids import AgentId, CommitId
from verifold.protocol.posts import FileEvidence
from verifold.runner.errors import RunnerError
from verifold.runner.folders import LAB_FOLDER, real_folder
from verifold.runner.git import GitCut, GitError, git, own_git, own_repository, unlock
from verifold.server.errors import EvidenceRejected

_AUTHOR = {
    'GIT_AUTHOR_NAME': 'Verifold',
    'GIT_AUTHOR_EMAIL': 'verifold@localhost',
    'GIT_COMMITTER_NAME': 'Verifold',
    'GIT_COMMITTER_EMAIL': 'verifold@localhost',
}


def snapshot_ref(agent_id: AgentId) -> str:
    """Return the ref in Verifold's own Git directory that holds an agent's snapshots."""
    return f'refs/verifold/agents/{agent_id}'


async def snapshot(project: Path, agent_id: AgentId) -> CommitId:
    """
    Commit the current files of an agent's folder onto the agent's snapshot ref, and return the commit.

    The folder is the one that Verifold made for the agent in the lab of `project`. Verifold first checks that it
    is a real folder at its own place in the lab's folder, so a link there makes Verifold commit no other folder.

    When a Git command of the snapshot is cut, at its time limit, because the caller was cancelled, or by a
    signal, the snapshot leaves nothing that stops a later one: its index goes, and so does the lock that Git
    left at the ref.

    Raises:
        NoAgentFolder: The agent's folder is not there, or it is a link or lies behind one.
        GitError: Verifold's own Git directory is not a folder of this user's, or Git failed or did not end in time.

    """
    folder = real_folder(project, agent_id)
    lab = project.resolve() / LAB_FOLDER
    ignored = await _ignore_list(lab)
    # The index is a new one in Verifold's own directory, so no index of the agent's is read or written. The
    # folder that holds it goes when this block ends, in whatever way.
    own = own_repository(lab)
    with tempfile.TemporaryDirectory(dir=own, prefix='index-') as temporary:
        index = {'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        await own_git(lab, *ignored, f'--work-tree={folder}', 'add', '--all', env=index)
        tree = await own_git(lab, 'write-tree', env=index)
    ref = snapshot_ref(agent_id)
    try:
        # A ref whose commit is gone gives no parent, so the snapshots go on from a new first one.
        parent = await own_git(lab, 'rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}')
    except GitError:
        parent = ''
    commit = await own_git(
        lab, 'commit-tree', tree, *(('-p', parent) if parent else ()), '-m', f'Snapshot of {agent_id}', env=_AUTHOR
    )
    try:
        await own_git(lab, 'update-ref', ref, commit)
    except (GitCut, asyncio.CancelledError):
        # With Git's lock left at the ref, no later snapshot could move the ref.
        unlock(own / f'{ref}.lock', commit)
        raise
    return commit


async def _ignore_list(lab: Path) -> tuple[str, ...]:
    """
    Return the option that names the person's own list of ignored files, when their Git configuration names one.

    Git reads no configuration of the person for a snapshot. Without this list, a file that only it excludes, such
    as `.DS_Store`, would enter each snapshot and each clean copy. So Verifold asks Git for this one value and
    passes it on, and Git reads the file that it names as a list of patterns. When the configuration names no
    file, Git reads the default list by itself: `git/ignore` in `$XDG_CONFIG_HOME`, or in `~/.config`.
    """
    own = own_repository(lab)
    try:
        named = await git(f'--git-dir={own}', 'config', '--global', '--includes', '--get', 'core.excludesFile', cwd=lab)
    except GitError:
        return ()
    return ('-c', f'core.excludesFile={named}') if named else ()


async def pin(project: Path, agent_id: AgentId, paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
    """
    Snapshot an agent's folder and pin each path to the snapshot.

    Raises:
        EvidenceRejected: A path is no UTF-8 text or is not a file in the folder, the file is in a repository
            inside the folder, Git ignores it, or Verifold could not commit the folder: the folder is a link or
            is gone, or Git failed.

    """
    # Git names a file by its plain path, so `out/./a.md` is pinned as `out/a.md`.
    paths = tuple(str(PurePosixPath(path)) for path in paths)
    # The record and the board hold UTF-8 text, and a name with other bytes arrives here as a surrogate.
    not_text = [path for path in paths if any('\ud800' <= sign <= '\udfff' for sign in path)]
    if not_text:
        shown = ', '.join(path.encode(errors='backslashreplace').decode() for path in not_text)
        raise EvidenceRejected(f'These file names are not UTF-8, so the files cannot be evidence: {shown}.')
    try:
        folder = real_folder(project, agent_id)
        missing = [path for path in paths if not (folder / PurePosixPath(path)).is_file()]
        if missing:
            raise EvidenceRejected(f'These files are not in your folder: {", ".join(missing)}.')
        commit = await snapshot(project, agent_id)
        # Each entry ends with a zero byte, so Git writes each name as it is, also one that is not ASCII.
        listed = await own_git(project.resolve() / LAB_FOLDER, 'ls-tree', '-r', '-z', commit)
    except RunnerError as error:
        # The agent reads this, so the failure comes back as one that the board's tools pass on.
        raise EvidenceRejected(f'Verifold could not commit your folder, so it pinned no file: {error}') from error
    entries = [entry.partition('\t') for entry in listed.split('\0') if entry]
    # Git records a repository inside the folder as one entry with that repository's commit.
    repositories = {name for about, _, name in entries if about.startswith('160000 ')}
    held = {name for _, _, name in entries} - repositories
    inside = [path for path in paths if any(str(above) in repositories for above in PurePosixPath(path).parents)]
    if inside:
        raise EvidenceRejected(
            'These files are in a repository inside your folder. A snapshot records such a repository as its one '
            f'commit, without its files, so they cannot be evidence: {", ".join(inside)}.'
        )
    ignored = [path for path in paths if path not in held]
    if ignored:
        raise EvidenceRejected(f'Git ignores these files, so they cannot be evidence: {", ".join(ignored)}.')
    return tuple(FileEvidence(path=path, commit=commit) for path in paths)
