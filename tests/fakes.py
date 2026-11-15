import sys
from dataclasses import dataclass, field
from pathlib import Path

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.events import Posted
from verifold.server.errors import NoCleanCopy

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

    async def __call__(self, claim: Posted) -> Path:
        if self.fails:
            raise NoCleanCopy(f'Verifold could not make the clean copy of post {claim.post.id}: no space left.')
        self.made.append((claim.post.id, claim.post.author))
        return self.folder / claim.post.id
