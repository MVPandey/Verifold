import sys
from pathlib import Path

from verifold.harnesses.catalog import HarnessEntry

FAKE_HARNESS = HarnessEntry(
    name='fake',
    title='Fake',
    executable=sys.executable,
    command=(sys.executable, str(Path(__file__).parent / 'agents' / 'fake_acp_agent.py')),
    family='test',
    auto_mode='auto',
)
"""A harness whose ACP agent is `agents/fake_acp_agent.py`."""
