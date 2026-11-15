import pytest
from pydantic import ValidationError

from verifold.protocol.agents import MAX_AGENTS, Agent, AgentChoice
from verifold.protocol.app import InviteRequest, StartRequest
from verifold.protocol.settings import SettingsFile, SetupDefaults


def test_a_lab_takes_several_seats_of_one_harness_each_with_its_own_model_and_facts() -> None:
    seats = (
        AgentChoice(harness='claude-code', model='opus', role=' driver ', count=2),
        AgentChoice(harness='claude-code', model='fable', role='direction\ncreator', on_call=True, coordinator=True),
        AgentChoice(harness='codex', family='other-vendor'),
    )

    start = StartRequest(question='Does it hold?', agents=seats)
    saved = SetupDefaults(agents=seats)

    assert [seat.harness for seat in start.agents] == ['claude-code', 'claude-code', 'codex']
    # A role is one line, with the limits of the role that an agent gives itself.
    assert [seat.role for seat in saved.agents or ()] == ['driver', 'direction creator', '']
    assert [seat.family for seat in start.agents] == [None, None, 'other-vendor']
    with pytest.raises(ValidationError, match='at most 40'):
        AgentChoice(harness='codex', role='r' * 41)


def test_a_lab_has_one_coordinator_in_a_seat_of_one_agent() -> None:
    one = AgentChoice(harness='codex', coordinator=True)

    with pytest.raises(ValidationError, match='the seat of the coordinator has one agent'):
        AgentChoice(harness='codex', coordinator=True, count=2)
    with pytest.raises(ValidationError, match='A lab has one coordinator'):
        StartRequest(question='Does it hold?', agents=(one, one))
    with pytest.raises(ValidationError, match=f'at most {MAX_AGENTS} agents'):
        SetupDefaults(agents=(AgentChoice(harness='codex', count=MAX_AGENTS), one))


def test_saved_choices_and_records_from_before_seats_still_load() -> None:
    old = {'setup': {'agents': [{'harness': 'claude-code', 'count': 2, 'model': 'opus'}], 'auto_mode': False}}
    record = {'id': 'agent-1', 'name': 'Agent 1', 'harness': 'codex', 'model': {'family': 'openai'}, 'role': 'Planner'}

    seats = SettingsFile.model_validate(old).setup.agents
    assert seats is not None
    seat = seats[0]
    agent = Agent.model_validate(record)

    assert (seat.role, seat.on_call, seat.coordinator, seat.family) == ('', False, False, None)
    assert (agent.name, agent.given_role, agent.role) == ('Agent 1', '', 'Planner')


def test_an_invitation_takes_the_facts_of_the_seat() -> None:
    request = InviteRequest(name=' Reader ', role='lit review', family='openai', on_call=True)

    assert (request.name, request.role, request.family, request.on_call, request.coordinator) == (
        'Reader',
        'lit review',
        'openai',
        True,
        False,
    )
    assert InviteRequest() == InviteRequest(name=None, role='', family=None)
