"""The clean copies in which an agent reruns the posts that it took, and the files that it pins from them."""

from pathlib import Path

from verifold.protocol.events import RerunTaken
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.posts import FileEvidence
from verifold.runner.folders import agent_folder, clean_copy, clean_copy_folder
from verifold.runner.git import GitError, git
from verifold.runner.snapshots import pin
from verifold.server.errors import EvidenceRejected, NoCleanCopy


def rerun_ref(agent_id: AgentId, post_id: PostId) -> str:
    """Return the ref that holds the commits of an agent's rerun of a post."""
    return f'refs/verifold/reruns/{agent_id}/{post_id}'


class Reruns:
    """
    Makes the clean copies for the reruns that one agent takes, inside that agent's own folder.

    Verifold starts nothing here. It copies the files of a post's author at the pinned commit, and how the agent
    runs them is the agent's business.
    """

    def __init__(self, project: Path, agent_id: AgentId) -> None:
        """Prepare the clean copies of one agent of the lab in `project`."""
        self._project = project
        self._agent_id = agent_id

    async def make(self, taken: RerunTaken, author: AgentId) -> Path:
        """
        Return the clean copy for a take, and make it on the first call.

        Raises:
            NoCleanCopy: Git could not make the copy, such as when the author's folder is gone.

        """
        try:
            folder = await agent_folder(self._project, self._agent_id)
            source = await agent_folder(self._project, author)
            return await clean_copy(folder, taken.post, source, taken.commit)
        except (GitError, OSError) as error:
            raise NoCleanCopy(f'Verifold could not make the clean copy of post {taken.post}: {error}') from error

    async def pin(self, taken: RerunTaken, paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        """
        Commit the clean copy of a take, and return each named file of it pinned to that commit.

        The agent's own repository gets the commit too, so the files of the check are read where the agent's other
        files are.

        Raises:
            EvidenceRejected: The clean copy is gone, a path is not a file in it, or Git ignores it.

        """
        folder = await agent_folder(self._project, self._agent_id)
        copy = clean_copy_folder(folder, taken.post)
        if not copy.is_dir():
            raise EvidenceRejected(f'The clean copy {copy} is gone. `take_rerun` makes it again.')
        ref = rerun_ref(self._agent_id, taken.post)
        evidence = await pin(copy, self._agent_id, paths, ref)
        await git('fetch', '--quiet', str(copy), f'+{ref}:{ref}', cwd=folder)
        return evidence
