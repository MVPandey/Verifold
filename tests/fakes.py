import sys
from dataclasses import dataclass, field
from pathlib import Path

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.events import Posted
from verifold.protocol.join import ManifestLine
from verifold.server.errors import NoCleanCopy
from verifold.server.member import MadeCopy

FAKE_HARNESS = HarnessEntry(
    name='fake',
    title='Fake',
    executable=sys.executable,
    command=(sys.executable, str(Path(__file__).parent / 'agents' / 'fake_acp_agent.py')),
    family='test',
    auto_mode='auto',
)
"""A harness whose ACP agent is `agents/fake_acp_agent.py`."""


@dataclass
class FakeCopies:
    """Stands in for the clean copies of a lab: it keeps what a seat asked for, and touches no folder."""

    folder: Path = Path('/lab/.verifold/reruns')
    made: list[tuple[str, str]] = field(default_factory=list)
    """The post and the author of each copy that a seat asked for."""
    fails: bool = False
    """Whether no copy can be made."""
    files: tuple[ManifestLine, ...] = (ManifestLine(path='bench.json', size=4, sha256='ab' * 32),)

    lost: bool = False
    """Whether a copy that a take made is gone, so that a later call makes it again."""

    async def __call__(self, claim: Posted) -> MadeCopy:
        if self.fails:
            raise NoCleanCopy(f'Verifold could not make the clean copy of post {claim.post.id}: no space left.')
        self.made.append((claim.post.id, claim.post.author))
        self.lost = False
        copy = self.folder / claim.post.id
        return MadeCopy(folder=copy, files=self.files, listing=copy.with_suffix('.manifest'), digest='cd' * 32)

    async def kept(self, claim: Posted, digest: str) -> MadeCopy | None:
        copy = self.folder / claim.post.id
        if self.lost or digest != 'cd' * 32:
            return None
        return MadeCopy(folder=copy, files=(), listing=copy.with_suffix('.manifest'), digest=digest)
