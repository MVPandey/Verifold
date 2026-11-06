"""How to start each harness over ACP, and the IDs of the options that Verifold can set."""

from collections.abc import Mapping
from types import MappingProxyType

from pydantic import Field

from verifold.protocol.agents import Label
from verifold.protocol.record import Record


class HarnessEntry(Record):
    """
    One harness: the command that starts its ACP agent, and the IDs of its session options.

    The harness keeps the person's own settings. Verifold sets an option only when the lab asks for it.
    """

    name: Label
    command: tuple[str, ...] = Field(min_length=1)
    family: Label
    """The model family of the harness's default models. Blind checks compare families."""
    model_option: str | None = 'model'
    effort_option: str | None = None
    auto_mode: str | None = None
    """The ID of the harness's own auto mode, set when the person allows auto mode for the lab's agents."""


CATALOG: Mapping[str, HarnessEntry] = MappingProxyType(
    {
        entry.name: entry
        for entry in (
            HarnessEntry(
                name='claude-code',
                command=('npx', '-y', '@agentclientprotocol/claude-agent-acp@0.101.0'),
                family='anthropic',
                effort_option='effort',
                auto_mode='auto',
            ),
            HarnessEntry(
                name='codex',
                command=('npx', '-y', '@agentclientprotocol/codex-acp@2.5.0'),
                family='openai',
                effort_option='reasoning_effort',
                auto_mode='agent',
            ),
        )
    }
)
"""The harnesses that a lab can name, with the adapter versions that Verifold was tested against."""
