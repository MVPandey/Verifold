"""
What the lab's files take on disk: each agent's folder, the clean copies for reruns, and the snapshots.

Verifold measures at the end of a turn: the folder of the agent whose turn ended, and the two stores that every
agent's work fills. The other folders keep their last measure. A turn that ends less than `MEASURE_EVERY` after the
last measure adds its agent's folder to the next measure instead, so the stores are walked about once a minute at
most. A new disk limit measures every folder at once. A measure counts the blocks that each file takes, counts a
file with several names once, and follows no link.
"""

import asyncio
import os
import stat
from collections.abc import Iterable
from datetime import datetime, timedelta
from pathlib import Path

from verifold.protocol.ids import AgentId
from verifold.protocol.usage import DiskUse
from verifold.runner.folders import LAB_FOLDER, agents_folder
from verifold.runner.git import OWN_REPOSITORY
from verifold.runner.reruns import RERUNS
from verifold.server.lab import Lab

MEASURE_EVERY = timedelta(seconds=60)
"""How long after a measure the end of a turn measures nothing, by the lab's clock."""


class DiskMeter:
    """Measures the lab's files and tells the lab. One measure runs at a time."""

    def __init__(self, project: Path, lab: Lab) -> None:
        """Measure the files of the lab in `project`, and tell `lab`."""
        self._project = project
        self._lab = lab
        self._folders: dict[AgentId, int] = {}
        self._lock = asyncio.Lock()
        self._last: datetime | None = None
        """When the last measure started, by the lab's clock."""
        self._due: tuple[AgentId, ...] = ()
        """The agents whose turns ended since that measure, whose folders the next measure takes too."""

    async def turn_ended(self, agent_id: AgentId) -> DiskUse | None:
        """
        Measure at the end of an agent's turn, and return what the lab's files take now.

        Within `MEASURE_EVERY` of the last measure, it measures nothing and returns `None`. The next measure then
        takes this agent's folder too.
        """
        if self._last is not None and self._lab.now() - self._last < MEASURE_EVERY:
            self._due = (*self._due, agent_id)
            return None
        return await self.measure(agent_id)

    async def measure(self, agent_id: AgentId | None = None) -> DiskUse:
        """
        Measure one agent's folder, or every agent's folder without `agent_id`, and both stores, and tell the lab.

        A measure of one folder also takes the folders of the turns that ended since the last measure. Return what
        the lab's files take now.
        """
        async with self._lock:
            self._last = self._lab.now()
            agents = tuple(dict.fromkeys((*self._due, agent_id))) if agent_id else _agents(self._project)
            self._due = ()
            folders, reruns, snapshots = await asyncio.to_thread(_measure, self._project, agents)
            self._folders = {**self._folders, **folders}
            total = sum(self._folders.values()) + reruns + snapshots
            disk = DiskUse(at=self._lab.now(), folders=self._folders, reruns=reruns, snapshots=snapshots, total=total)
            await self._lab.measured(disk)
            return disk


def _agents(project: Path) -> tuple[AgentId, ...]:
    every = agents_folder(project)
    try:
        return tuple(sorted(entry.name for entry in os.scandir(every) if entry.is_dir(follow_symlinks=False)))
    except OSError:
        return ()


def _measure(project: Path, agents: Iterable[AgentId]) -> tuple[dict[AgentId, int], int, int]:
    lab = project / LAB_FOLDER
    folders = {agent: size(agents_folder(project) / agent) for agent in agents}
    return folders, size(lab / RERUNS), size(lab / OWN_REPOSITORY)


def size(path: Path) -> int:
    """
    Return the bytes that a file or a folder with all that it holds takes on disk. A missing path takes none.

    A link counts as itself, and a file with several names counts once. What Verifold cannot read counts as nothing.
    """
    seen: set[tuple[int, int]] = set()
    try:
        top = path.lstat()
    except OSError:
        return 0
    total = _blocks(top)
    folders = [path] if stat.S_ISDIR(top.st_mode) else []
    while folders:
        folder = folders.pop()
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    found = entry.stat(follow_symlinks=False)
                    if found.st_nlink > 1 and not stat.S_ISDIR(found.st_mode):
                        if (found.st_dev, found.st_ino) in seen:
                            continue
                        seen.add((found.st_dev, found.st_ino))
                    total += _blocks(found)
                    if stat.S_ISDIR(found.st_mode):
                        folders.append(Path(entry.path))
        except OSError:
            continue
    return total


def _blocks(found: os.stat_result) -> int:
    # The bytes of the blocks that the file takes, where the system says, and else its size.
    blocks = getattr(found, 'st_blocks', None)
    return blocks * 512 if blocks is not None else found.st_size
