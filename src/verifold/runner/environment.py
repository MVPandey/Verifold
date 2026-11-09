"""The environments that Verifold gives the processes it starts."""

import os
from pathlib import Path

from verifold.protocol.ids import AgentId

LAB_VARIABLE = 'VERIFOLD_LAB'
"""Holds the lab's folder in the environment of every process that an agent's harness starts."""

AGENT_VARIABLE = 'VERIFOLD_AGENT'
"""Holds the agent's ID next to `LAB_VARIABLE`."""


def clean_environment() -> dict[str, str]:
    """
    Return this process's environment without any `GIT_` variable.

    A Git hook sets variables such as `GIT_DIR` and `GIT_INDEX_FILE`. A child process that inherits them runs its own
    Git commands against the wrong repository.
    """
    return {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}


def harness_environment(lab: Path, agent: AgentId) -> dict[str, str]:
    """
    Return the environment for an agent's harness: the clean environment, marked with the lab and the agent.

    Every process that the harness starts inherits the marks unless it clears its environment, also one that leaves the
    harness's process group or outlives its parent. Verifold can then find those processes and stop them with the lab.
    """
    return clean_environment() | {LAB_VARIABLE: str(lab), AGENT_VARIABLE: agent}
