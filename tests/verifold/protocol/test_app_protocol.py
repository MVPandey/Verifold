import pytest
from pydantic import ValidationError

from verifold.protocol.app import AgentChoice

BEDROCK_MODEL = 'amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0'
"""A cloud provider's model ID, longer than a label."""


def test_a_choice_takes_the_long_values_that_harnesses_offer() -> None:
    choice = AgentChoice(harness='claude-code', model=BEDROCK_MODEL, effort='x' * 200, mode='plan')

    assert choice.model == BEDROCK_MODEL


def test_a_choice_refuses_an_empty_or_huge_value() -> None:
    with pytest.raises(ValidationError):
        AgentChoice(harness='claude-code', model='')
    with pytest.raises(ValidationError):
        AgentChoice(harness='claude-code', model='x' * 201)
