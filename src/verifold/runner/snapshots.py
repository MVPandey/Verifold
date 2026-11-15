"""
Snapshots of agents' folders, as commits in a Git directory of Verifold's own.

A snapshot commits everything in an agent's folder that Git does not ignore, onto `refs/verifold/agents/<agent ID>`
in `.verifold/snapshots.git`. Agents cannot always commit from inside their harness's sandbox, so Verifold commits
for them, and evidence always points at a stable commit.

Every Git command for a snapshot names that directory, names the agent's folder as the work tree, and runs from
Verifold's own folder. So Git finds no repository from the agent's folder, and it reads no configuration, hook,
filter, or ref of the agent's repository or of the project's. It reads the agent's files, and its `.gitignore` and
`.gitattributes` files, as data: an attribute can name a filter, and no configuration that Git reads has one. Git
reads no configuration of the person or the system either, so the person's filters and signing do not run. A
snapshot writes nothing in the agent's folder, and nothing in a repository of the lab.
"""

import tempfile
from pathlib import Path, PurePosixPath

from verifold.protocol.ids import AgentId, CommitId
from verifold.protocol.posts import FileEvidence
from verifold.runner.errors import RunnerError
from verifold.runner.folders import LAB_FOLDER, real_folder
from verifold.runner.git import GitError, git, own_git, own_repository
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

    Raises:
        NoAgentFolder: The agent's folder is not there, or it is a link or lies behind one.
        GitError: Verifold's own Git directory is not a folder of this user's, or Git failed or did not end in time.

    """
    folder = real_folder(project, agent_id)
    lab = project.resolve() / LAB_FOLDER
    ignored = await _ignore_list(lab)
    # The index is a new one in Verifold's own directory, so no index of the agent's is read or written.
    with tempfile.TemporaryDirectory(dir=own_repository(lab), prefix='index-') as temporary:
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
    await own_git(lab, 'update-ref', ref, commit)
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
        EvidenceRejected: A path is not a file in the folder, Git ignores it, or Verifold could not commit the
            folder: the folder is a link or is gone, or Git failed.

    """
    # Git names a file by its plain path, so `out/./a.md` is pinned as `out/a.md`.
    paths = tuple(str(PurePosixPath(path)) for path in paths)
    try:
        folder = real_folder(project, agent_id)
        missing = [path for path in paths if not (folder / PurePosixPath(path)).is_file()]
        if missing:
            raise EvidenceRejected(f'These files are not in your folder: {", ".join(missing)}.')
        commit = await snapshot(project, agent_id)
        listed = await own_git(project.resolve() / LAB_FOLDER, 'ls-tree', '-r', '--name-only', commit)
    except RunnerError as error:
        # The agent reads this, so the failure comes back as one that the board's tools pass on.
        raise EvidenceRejected(f'Verifold could not commit your folder, so it pinned no file: {error}') from error
    tracked = set(listed.splitlines())
    ignored = [path for path in paths if path not in tracked]
    if ignored:
        raise EvidenceRejected(f'Git ignores these files, so they cannot be evidence: {", ".join(ignored)}.')
    return tuple(FileEvidence(path=path, commit=commit) for path in paths)
