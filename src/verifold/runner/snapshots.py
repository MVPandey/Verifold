"""
Snapshots of agents' folders, as commits that Verifold owns.

A snapshot commits everything in an agent's folder that Git does not ignore, onto `refs/verifold/agents/<agent ID>`.
It uses a temporary index, so the agent's branch, index, and files stay as they are. Agents cannot always commit from
inside their harness's sandbox, so Verifold commits for them, and evidence always points at a stable commit.
"""

import tempfile
from pathlib import Path, PurePosixPath

from verifold.protocol.ids import AgentId, CommitId
from verifold.protocol.posts import FileEvidence
from verifold.runner.git import GitError, git
from verifold.server.errors import EvidenceRejected

_AUTHOR = {
    'GIT_AUTHOR_NAME': 'Verifold',
    'GIT_AUTHOR_EMAIL': 'verifold@localhost',
    'GIT_COMMITTER_NAME': 'Verifold',
    'GIT_COMMITTER_EMAIL': 'verifold@localhost',
}


def snapshot_ref(agent_id: AgentId) -> str:
    """Return the ref that holds an agent's snapshots."""
    return f'refs/verifold/agents/{agent_id}'


async def snapshot(folder: Path, agent_id: AgentId) -> CommitId:
    """Commit the folder's current files onto the agent's snapshot ref, and return the commit."""
    with tempfile.TemporaryDirectory() as temporary:
        index = {'GIT_INDEX_FILE': str(Path(temporary) / 'index')}
        await git('add', '--all', '.', cwd=folder, env=index)
        tree = await git('write-tree', cwd=folder, env=index)
    ref = snapshot_ref(agent_id)
    parent = await _commit_of(folder, ref)
    commit = await git(
        'commit-tree',
        tree,
        *(('-p', parent) if parent else ()),
        '-m',
        f'Snapshot of {agent_id}',
        cwd=folder,
        env=_AUTHOR,
    )
    await git('update-ref', ref, commit, cwd=folder)
    return commit


async def pin(folder: Path, agent_id: AgentId, paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
    """
    Snapshot the folder and pin each path to the snapshot.

    Raises:
        EvidenceRejected: A path is not a file in the folder, or Git ignores it.

    """
    missing = [path for path in paths if not (folder / PurePosixPath(path)).is_file()]
    if missing:
        raise EvidenceRejected(f'These files are not in your folder: {", ".join(missing)}.')
    commit = await snapshot(folder, agent_id)
    tracked = set((await git('ls-tree', '-r', '--name-only', commit, cwd=folder)).splitlines())
    ignored = [path for path in paths if str(PurePosixPath(path)) not in tracked]
    if ignored:
        raise EvidenceRejected(f'Git ignores these files, so they cannot be evidence: {", ".join(ignored)}.')
    return tuple(FileEvidence(path=path, commit=commit) for path in paths)


async def _commit_of(folder: Path, ref: str) -> str | None:
    try:
        return await git('rev-parse', '--verify', '--quiet', ref, cwd=folder)
    except GitError:
        return None
