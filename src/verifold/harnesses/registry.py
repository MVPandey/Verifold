"""The harnesses that Verifold can start, by name."""

from collections.abc import Callable, Mapping
from types import MappingProxyType

from verifold.harnesses.base import Harness
from verifold.harnesses.claude_code import ClaudeCode
from verifold.harnesses.codex import Codex

HARNESSES: Mapping[str, Callable[[], Harness]] = MappingProxyType({ClaudeCode.name: ClaudeCode, Codex.name: Codex})
"""Each harness's name, and how to make its adapter with the executable on the PATH."""
