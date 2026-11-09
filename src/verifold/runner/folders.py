"""The folders where agents work."""

from pathlib import Path

from verifold.protocol.ids import AgentId, CommitId
from verifold.runner.git import commit_of, git

LAB_FOLDER = '.verifold'
"""The folder in the project that holds the lab: its record, the agents' folders, and their private files."""


def agents_folder(project: Path) -> Path:
    """Return the folder that holds each agent's folder."""
    return project / LAB_FOLDER / 'agents'


async def agent_folder(project: Path, agent_id: AgentId) -> Path:
    """
    Return the agent's folder, and create it on the first call.

    In a project with Git commits, the folder is a worktree of the project on the branch `verifold/<agent ID>`, and
    the lab folder is excluded from the project's Git status. In any other project, the folder is a new repository,
    so the agent can still commit its work. A later call returns the same folder, so a resumed agent keeps its work.
    """
    folder = agents_folder(project) / agent_id
    if folder.exists():
        return folder
    folder.parent.mkdir(parents=True, exist_ok=True)
    if await commit_of(project, 'HEAD') is None:
        folder.mkdir()
        await git('init', '--quiet', cwd=folder)
        return folder
    await _exclude_lab_folder(project)
    branch = f'verifold/{agent_id}'
    existing = await git('branch', '--list', branch, cwd=project)
    await git(
        'worktree', 'add', '--quiet', *((str(folder), branch) if existing else ('-b', branch, str(folder))), cwd=project
    )
    return folder


async def _exclude_lab_folder(project: Path) -> None:
    exclude = Path(await git('rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', cwd=project))
    rule = f'/{LAB_FOLDER}/'
    lines = exclude.read_text().splitlines() if exclude.exists() else []
    if rule not in lines:
        exclude.parent.mkdir(parents=True, exist_ok=True)
        exclude.write_text('\n'.join([*lines, rule]) + '\n')


async def checker_folder(project: Path, checker_id: AgentId, source: Path, ref: str, commit: CommitId) -> Path:
    """
    Return a blind checker's folder: a new repository with the author's files at the commit that the evidence cites.

    The folder holds only what the author's snapshot holds, fetched from the author's folder. A later call returns the
    same folder.
    """
    folder = agents_folder(project) / checker_id
    if folder.exists():
        return folder
    folder.mkdir(parents=True)
    await git('init', '--quiet', cwd=folder)
    await git('fetch', '--quiet', str(source), ref, cwd=folder)
    await git('checkout', '--quiet', '--detach', commit, cwd=folder)
    return folder
