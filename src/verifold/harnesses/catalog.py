"""The harnesses that a lab can start over ACP: the ones that Verifold knows, and the ones in the person's settings."""

import shutil
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType

from pydantic import Field

from verifold.protocol.agents import Label
from verifold.protocol.record import Record
from verifold.protocol.settings import HarnessSettings


class HarnessEntry(Record):
    """
    One harness: the command that starts its ACP agent, and what Verifold needs to know about it.

    The harness keeps the person's own settings. Verifold sets a model, an effort, or the auto mode only when the lab
    asks for it, and it finds the model and effort options by their ACP category.
    """

    name: Label
    title: Label
    """The name that people know the harness by."""
    executable: str
    """The harness's own command. It must be on the PATH."""
    command: tuple[str, ...] = Field(min_length=1)
    family: Label
    """The model family of the harness's default models. Blind checks compare families."""
    auto_mode: str | None = None
    """The ID of the harness's own auto mode, set when the person allows auto mode for the lab's agents."""
    names_mcp_server: bool = False
    """
    Whether the harness itself writes the MCP server's name into a tool call's input, as `server`, beside `tool`.

    Verifold then knows a call to the lab's own board and allows it. Where the model writes the input, the name
    proves nothing, so the default is off.
    """


NPX_PROJECT = Path.home() / '.verifold' / 'npx'
"""
The folder that the built-in adapters' `npx` takes as its project. Verifold starts an adapter in the project or in an
agent's worktree, and `npx` would run a package from that folder's `node_modules` and read its `.npmrc`. This folder
holds neither, so `npx` runs the pinned adapter from its own cache.
"""


def _adapter(package: str) -> tuple[str, ...]:
    return ('npx', '--prefix', str(NPX_PROJECT), '-y', package)


CATALOG: Mapping[str, HarnessEntry] = MappingProxyType(
    {
        entry.name: entry
        for entry in (
            HarnessEntry(
                name='claude-code',
                title='Claude Code',
                executable='claude',
                command=_adapter('@agentclientprotocol/claude-agent-acp@0.101.0'),
                family='anthropic',
                auto_mode='auto',
            ),
            HarnessEntry(
                name='codex',
                title='Codex',
                executable='codex',
                command=_adapter('@agentclientprotocol/codex-acp@2.5.0'),
                family='openai',
                # Not the mode `agent`: there the harness's own reviewer decides, and a refusal never reaches the
                # person. In this mode each request comes to Verifold, which follows the person's grants.
                auto_mode='workspace-write',
                names_mcp_server=True,
            ),
        )
    }
)
"""The harnesses that Verifold knows, with the adapter versions that it was tested against."""


def catalog_with(
    harnesses: Mapping[str, HarnessSettings], base: Mapping[str, HarnessEntry] = CATALOG
) -> Mapping[str, HarnessEntry]:
    """Return `base` with the person's harnesses added. An entry with the name of a harness in `base` replaces it."""
    added = {
        name: HarnessEntry(
            name=name,
            title=entry.title or name,
            executable=entry.executable or entry.command[0],
            command=entry.command,
            family=entry.family,
            auto_mode=entry.auto_mode,
        )
        for name, entry in harnesses.items()
    }
    return MappingProxyType({**base, **added})


def available(entry: HarnessEntry) -> bool:
    """Return whether this computer has the harness and the command that starts its ACP agent."""
    return shutil.which(entry.executable) is not None and shutil.which(entry.command[0]) is not None
