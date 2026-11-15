import pytest
from pydantic import TypeAdapter, ValidationError

from verifold.protocol.agents import MAX_AGENTS, Agent, AgentChoice, ModelSpec
from verifold.protocol.app import InviteRequest, StartRequest
from verifold.protocol.events import Event, Posted, ProfileSet, SettingsSet
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


def test_names_roles_families_and_typed_ids_are_one_printable_line() -> None:
    seat = AgentChoice(harness='codex', role='dri\u202ever\u200b\n now', family=' Other\tVendor ')
    agent = Agent(id='agent-1', name=' Codex ·\x1b[31m gpt-6\n', harness='codex', model=ModelSpec(family='openai'))

    # A role, a family, and a name lose what does not print, as the role that an agent gives itself does.
    assert (seat.role, seat.family, agent.name) == ('dri ver now', 'Other Vendor', 'Codex · [31m gpt-6')
    # A typed ID goes to the harness as it is, so one that is not a printable line is refused, not changed.
    for field in ('model', 'effort', 'mode'):
        for value in ('gpt\u202e-6', 'gpt 6\n', ' gpt-6', 'gpt\x00-6', 'gpt\u200b-6'):
            with pytest.raises(ValidationError, match='is not one printable line'):
                AgentChoice.model_validate({'harness': 'codex', field: value})
    assert AgentChoice(harness='codex', model='us.vendor.gpt-6.1-sol:2026 preview').model is not None
    with pytest.raises(ValidationError, match='is not one printable line'):
        SettingsFile.model_validate({'setup': {'agents': [{'harness': 'codex', 'model': 'a\nb'}]}})
    with pytest.raises(ValidationError):
        Agent(id='agent-1', name='\u200b', harness='codex', model=ModelSpec(family='openai'))


def test_a_stated_family_is_never_the_word_for_a_family_that_nobody_stated() -> None:
    for family in ('unknown', ' Unknown ', 'UNKNOWN'):
        with pytest.raises(ValidationError, match='is how Verifold records a family that nobody stated'):
            InviteRequest(family=family)
        with pytest.raises(ValidationError, match='Leave the family out'):
            AgentChoice(harness='codex', family=family)
    assert InviteRequest(family='unknown-labs').family == 'unknown-labs'


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


def test_a_record_and_a_settings_file_from_before_profiles_and_reviewer_seats_still_load() -> None:
    events: TypeAdapter[Event] = TypeAdapter(Event)
    at = '2026-11-06T12:00:00Z'
    said = events.validate_python({'type': 'profile_set', 'seq': 4, 'at': at, 'agent': 'ada', 'role': 'theory'})
    posted = events.validate_python(
        {
            'type': 'posted',
            'seq': 5,
            'at': at,
            'post': {'kind': 'message', 'id': 'p-1', 'thread': 't-1', 'author': 'ada', 'text': 'Hello.'},
        }
    )
    settings = {'version': 1, 'jobs': {'at_exit': 'keep'}, 'permissions': {'while_you_decide': 'wait'}}
    recorded = events.validate_python({'type': 'settings_set', 'seq': 2, 'at': at, 'settings': settings})

    assert isinstance(said, ProfileSet)
    assert (said.role, said.name, said.about, said.picture, said.by, said.given_role, said.flag) == (
        'theory',
        None,
        None,
        None,
        None,
        None,
        None,
    )
    assert isinstance(posted, Posted)
    assert posted.post.to_lab is False
    assert isinstance(recorded, SettingsSet)
    assert recorded.settings.reviewers.seats is None
    # A saved file without the new setting follows the size of the lab, and one with it keeps its number.
    assert SettingsFile.model_validate(settings).lab_settings().reviewers.seats is None
    assert SettingsFile.model_validate(settings | {'reviewers': {'seats': 2}}).lab_settings().reviewers.seats == 2
    for seats in (-1, 21, 1.5):
        with pytest.raises(ValidationError):
            SettingsFile.model_validate({'reviewers': {'seats': seats}})
