import pytest
from conftest import agent
from mcp import Client

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import CoordinatorSet, OnCallSet, TurnStarted
from verifold.protocol.join import PostRequest
from verifold.server.join import INSTRUCTIONS, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile


async def test_an_agent_joins_with_the_facts_that_the_person_gave_its_seat_in_one_step(
    lab: Lab, record_file: RecordFile
) -> None:
    seq = lab.board.seq
    joined = await lab.join(agent('cy').model_copy(update={'given_role': 'driver'}), on_call=True, coordinator=True)

    assert (joined.agent.id, joined.seq, lab.board.seq) == ('cy', seq + 1, seq + 3)
    assert (lab.board.on_call('cy'), lab.board.coordinator, joined.agent.given_role) == (True, 'cy', 'driver')
    kinds = [type(event) for event in record_file.read()[-2:]]
    assert kinds == [OnCallSet, CoordinatorSet]
    # A lab that loads the record again has the same seats.
    again = Lab.load(record_file).board
    assert (again.on_call('cy'), again.coordinator) == (True, 'cy')


async def test_the_person_switches_a_seat_and_the_same_answer_again_records_nothing(lab: Lab) -> None:
    await lab.set_on_call('bo', on_call=True)
    seq = lab.board.seq
    await lab.set_on_call('bo', on_call=True)
    await lab.set_on_call('ada', on_call=False)
    assert (lab.board.seq, lab.board.on_call('bo'), lab.board.on_call('ada')) == (seq, True, False)

    await lab.set_on_call('bo', on_call=False)
    assert (lab.board.seq, lab.board.on_call('bo')) == (seq + 1, False)
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        await lab.set_on_call('zed', on_call=False)


async def test_the_coordinator_seat_changes_by_the_person_or_by_the_agent_that_takes_or_leaves_it(lab: Lab) -> None:
    assert await lab.set_coordinator('ada', 'ada') == 'ada'
    seq = lab.board.seq
    # The holder that takes the seat again, and the person who gives it to the holder, change nothing.
    assert await lab.set_coordinator('ada', 'ada') == 'ada'
    assert await lab.set_coordinator('ada', 'person') == 'ada'
    assert lab.board.seq == seq

    with pytest.raises(RejectedEvent, match='ada is the coordinator of this lab'):
        await lab.set_coordinator('bo', 'bo')
    with pytest.raises(RejectedEvent, match='you have no seat to give up'):
        await lab.set_coordinator(None, 'bo')
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        await lab.set_coordinator('zed', 'person')
    assert await lab.set_coordinator('bo', 'person') == 'bo'
    assert await lab.set_coordinator(None, 'bo') is None
    assert [(entry.agent, entry.by) for entry in lab.board.coordinators] == [
        ('ada', 'ada'),
        ('bo', 'person'),
        (None, 'bo'),
    ]


async def test_a_seat_that_the_person_cleared_is_closed_to_the_agents_until_the_person_opens_it(lab: Lab) -> None:
    await lab.set_coordinator('ada', 'ada')
    assert await lab.set_coordinator(None, 'person') is None
    seq = lab.board.seq

    assert not lab.board.coordinator_open
    with pytest.raises(RejectedEvent, match='The person closed the coordinator seat'):
        await lab.set_coordinator('ada', 'ada')
    # The same answer again records nothing.
    assert await lab.set_coordinator(None, 'person') is None
    assert lab.board.seq == seq

    assert await lab.set_coordinator(None, 'person', free=True) is None
    assert (lab.board.seq, lab.board.coordinator_open, lab.board.coordinators[-1].open) == (seq + 1, True, True)
    assert await lab.set_coordinator('bo', 'bo') == 'bo'
    # A seat that its holder gave up is open, and the person can close it without a holder.
    await lab.set_coordinator(None, 'bo')
    assert lab.board.coordinator_open
    await lab.set_coordinator(None, 'person')
    assert not lab.board.coordinator_open
    # The person's gift opens nothing by itself: the seat has a holder.
    assert await lab.set_coordinator('ada', 'person') == 'ada'
    assert not lab.board.coordinator_open


def named(agent_id: str, name: str, model: str | None = None, harness: str = 'fake') -> Agent:
    return Agent(id=agent_id, name=name, harness=harness, model=ModelSpec(family='test', name=model))


async def test_a_name_that_waits_for_its_model_gets_it_and_the_agent_that_joined_first_has_no_number(lab: Lab) -> None:
    await lab.join(named('agent-1', 'Codex · default model'))
    await lab.join(named('agent-2', 'Codex · default model 2'))
    seq = lab.board.seq

    # The second agent's harness reports its model first, and then the first agent's does.
    second = await lab.name_by_model('agent-2', 'Codex', 'gpt-6')
    first = await lab.name_by_model('agent-1', 'Codex', 'gpt-6')

    assert (second, first) == ('Codex · gpt-6', 'Codex · gpt-6')
    assert [joined.agent.name for joined in lab.board.agents[-2:]] == ['Codex · gpt-6', 'Codex · gpt-6 2']
    # One step renamed both agents: the later one moved up first, so no two agents had one name at any event.
    assert [(event.agent, event.name) for event, _ in lab.board.renames] == [
        ('agent-2', 'Codex · gpt-6'),
        ('agent-2', 'Codex · gpt-6 2'),
        ('agent-1', 'Codex · gpt-6'),
    ]
    assert lab.board.seq == seq + 3
    # A later report changes nothing, whatever model it names.
    assert await lab.name_by_model('agent-1', 'Codex', 'gpt-7') == 'Codex · gpt-6'
    assert lab.board.seq == seq + 3


async def test_a_name_with_the_id_of_a_chosen_model_gets_the_name_that_the_harness_shows(lab: Lab) -> None:
    await lab.join(named('agent-1', 'Claude Code · opus', 'opus'))
    await lab.join(named('agent-2', 'Claude Code · opus 2', 'opus'))
    await lab.join(named('agent-3', 'Claude Code · Opus 5.5', 'opus'))
    await lab.join(named('guest-1', 'Claude Code · Opus 5.5 2', harness='guest'))

    last = await lab.name_by_model('agent-2', 'Claude Code', 'Opus 5.5')
    first = await lab.name_by_model('agent-1', 'Claude Code', 'Opus 5.5')

    # Agent 3 has the harness's name from the setup. The numbers follow the order that the agents joined, and the
    # number that an invited agent has is not free.
    assert (last, first) == ('Claude Code · Opus 5.5', 'Claude Code · Opus 5.5')
    assert [joined.agent.name for joined in lab.board.agents[-4:]] == [
        'Claude Code · Opus 5.5',
        'Claude Code · Opus 5.5 3',
        'Claude Code · Opus 5.5 4',
        'Claude Code · Opus 5.5 2',
    ]


async def test_only_a_name_that_verifold_built_before_the_model_was_known_changes(lab: Lab) -> None:
    await lab.join(named('agent-1', 'Codex · gpt-6', 'gpt-6'))
    await lab.join(named('agent-2', 'Agent 2'))
    await lab.join(named('agent-3', 'Codex · default model 3'))
    seq = lab.board.seq

    kept = [
        # The harness shows the ID that the person chose, a name from before these names, and an agent that is none.
        await lab.name_by_model('agent-1', 'Codex', 'gpt-6'),
        await lab.name_by_model('agent-2', 'Codex', 'gpt-6'),
        await lab.name_by_model('ada', 'Fake', 'gpt-6'),
        await lab.name_by_model('zed', 'Fake', 'gpt-6'),
        # A model's name that is blank or only marks that do not print names nothing.
        await lab.name_by_model('agent-3', 'Codex', ' \u200b\n'),
    ]

    assert kept == ['Codex · gpt-6', 'Agent 2', 'Ada', 'zed', 'Codex · default model 3']
    assert lab.board.seq == seq


async def test_a_turn_keeps_the_model_that_the_harness_reported(lab: Lab, record_file: RecordFile) -> None:
    with_model = await lab.start_turn('ada', 'session-1', 3, model='opus-5-5', model_name='Opus 5.5')
    without = await lab.start_turn('bo', 'session-2', 3)

    assert (with_model.model, with_model.model_name, without.model, without.model_name) == (
        'opus-5-5',
        'Opus 5.5',
        None,
        None,
    )
    starts = [event for event in record_file.read() if isinstance(event, TurnStarted)]
    assert [start.model for start in starts] == ['opus-5-5', None]


async def test_an_agent_takes_and_gives_up_the_coordinator_seat_with_profile_and_sees_the_role_that_the_person_gave(
    lab: Lab,
) -> None:
    await lab.join(agent('cy').model_copy(update={'given_role': 'driver'}), on_call=True)
    async with Client(join_server(lambda _: Member(lab, 'cy'))) as client:
        taken = await client.call_tool('profile', {'coordinator': True, 'role': 'theory'})
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        refused = await client.call_tool('profile', {'coordinator': True})
        not_mine = await client.call_tool('profile', {'coordinator': False})
        brief = await client.call_tool('brief', {})
    async with Client(join_server(lambda _: Member(lab, 'cy'))) as client:
        given_up = await client.call_tool('profile', {'coordinator': False})
        mine = await client.call_tool('brief', {})

    assert taken.structured_content is not None
    # The agent's own role stands beside the role that the person gave, and replaces nothing.
    assert [taken.structured_content[key] for key in ('role', 'given_role', 'coordinator')] == [
        'theory',
        'driver',
        'cy',
    ]
    assert (refused.is_error, not_mine.is_error) == (True, True)
    assert 'cy is the coordinator of this lab' in str(refused.content)
    assert brief.structured_content is not None
    assert brief.structured_content['coordinator'] == 'cy'
    line = next(line for line in brief.structured_content['agents'] if line['id'] == 'cy')
    assert [line[key] for key in ('role', 'given_role', 'on_call', 'coordinator')] == ['theory', 'driver', True, True]
    assert given_up.structured_content is not None
    assert given_up.structured_content['coordinator'] is None
    assert mine.structured_content is not None
    assert [mine.structured_content['your_line'][key] for key in ('given_role', 'on_call', 'coordinator')] == [
        'driver',
        True,
        False,
    ]
    assert mine.structured_content['coordinator'] is None


async def test_a_blind_checker_takes_no_seat(lab: Lab) -> None:
    await lab.join(agent('dee').model_copy(update={'checks': 'p-1'}))
    async with Client(join_server(lambda _: Member(lab, 'dee'))) as client:
        refused = await client.call_tool('profile', {'coordinator': True})

    assert refused.is_error
    assert lab.board.coordinator is None


async def test_an_on_call_agent_gets_only_the_posts_for_it_from_wait_and_news(lab: Lab) -> None:
    await lab.join(agent('cy'), on_call=True)
    cy = Member(lab, 'cy')
    await lab.post(PostRequest(kind='ask', text='Who knows the tail?', new_thread='The tail'), 'bo')
    quiet = await cy.wait(0)
    await lab.post(PostRequest(kind='ask', text='A hard one.', thread='t-2', mentions=('cy',)), 'bo')
    called = await cy.wait(0)

    assert (quiet.posts, quiet.other_posts) == ((), 1)
    assert [entry.post.text for entry in called.posts] == ['A hard one.']


def test_the_instructions_state_the_seats_as_facts_and_tell_no_agent_how_to_act_in_a_role() -> None:
    seats = ' '.join(
        line
        for line in INSTRUCTIONS.splitlines()
        if any(word in line for word in ('on call', 'on-call', 'coordinator'))
    )

    assert 'For an agent that Verifold started, the name is built from' in INSTRUCTIONS
    assert "An agent's name holds its harness and its model." not in INSTRUCTIONS
    assert 'Verifold starts an\n  on-call agent' not in INSTRUCTIONS
    assert 'An invited agent that is on\n  call runs by itself' in INSTRUCTIONS
    assert 'The person can give a seat a role.' in INSTRUCTIONS
    assert '`brief` names it in `coordinator`' in INSTRUCTIONS
    assert 'No post for every agent is for\n  an on-call agent' in INSTRUCTIONS
    assert 'put its ID, such as `agent-2`, in `mentions`' in INSTRUCTIONS
    assert not any(word in seats for word in ('should', 'must', 'Use ', 'prefer', 'instead'))
