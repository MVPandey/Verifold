import sys
from dataclasses import dataclass, field
from pathlib import Path

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.events import RerunTaken
from verifold.protocol.posts import FileEvidence

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
    """Stands in for the clean copies of one agent: it keeps what a seat asked for, and touches no folder."""

    folder: Path = Path('/lab/.verifold/agents/bo/.verifold/reruns')
    made: list[tuple[str, str]] = field(default_factory=list)
    """The post and the author of each copy that the seat asked for."""
    pinned: list[tuple[str, tuple[str, ...]]] = field(default_factory=list)
    """The post and the paths of each pin from a clean copy."""

    async def make(self, taken: RerunTaken, author: str) -> Path:
        self.made.append((taken.post, author))
        return self.folder / taken.post

    async def pin(self, taken: RerunTaken, paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        self.pinned.append((taken.post, paths))
        return tuple(FileEvidence(path=path, commit='d' * 40) for path in paths)
