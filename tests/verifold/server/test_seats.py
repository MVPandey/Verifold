import pytest
from conftest import agent
from mcp import Client

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import CoordinatorSet, OnCallSet, Posted, TurnStarted
from verifold.protocol.join import PostRequest
from verifold.server.join import INSTRUCTIONS, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.attention import _named
from verifold.society.errors import RejectedEvent
from verifold.society.labels import label
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


async def test_a_name_that_an_agent_has_held_is_never_given_to_another_agent(lab: Lab, record_file: RecordFile) -> None:
    await lab.join(named('agent-1', 'Claude Code · default model'), on_call=True)
    await lab.join(named('agent-2', 'Claude Code · default model 2'))
    await lab.join(named('agent-3', 'Claude Code · default model 3'))
    # The two agents that started report their model. The on-call agent that joined first has no turn yet.
    assert await lab.name_by_model('agent-2', 'Claude Code', 'Opus 5.5') == 'Claude Code · Opus 5.5'
    assert await lab.name_by_model('agent-3', 'Claude Code', 'Opus 5.5') == 'Claude Code · Opus 5.5 2'
    side = await lab.post(PostRequest(kind='message', text='Side work.', new_thread='Side work'), 'agent-3')
    thread = side.post.thread
    to_three = await lab.post(
        PostRequest(kind='message', text='Claude Code · Opus 5.5 2: rerun your table please.', thread=thread), 'ada'
    )
    to_two = await lab.post(
        PostRequest(kind='message', text='Claude Code · Opus 5.5 was right about the seed.', thread=thread), 'ada'
    )

    def named_by(entry: Posted) -> set[str]:
        return {agent for agent in ('agent-1', 'agent-2', 'agent-3') if _named(lab.board, agent, entry.post)}

    before = (named_by(to_three), named_by(to_two))
    seq = lab.board.seq
    # The on-call agent is called, and its harness reports the same model late.
    late = await lab.name_by_model('agent-1', 'Claude Code', 'Opus 5.5')

    # Only that agent gets a new name, with a number that no agent has or had. The older posts name the same
    # agents as before, and the numbers are out of the order that the agents joined.
    assert (late, lab.board.seq) == ('Claude Code · Opus 5.5 3', seq + 1)
    assert [joined.agent.name for joined in lab.board.agents[-3:]] == [
        'Claude Code · Opus 5.5 3',
        'Claude Code · Opus 5.5',
        'Claude Code · Opus 5.5 2',
    ]
    assert before == ({'agent-3'}, {'agent-2'}) == (named_by(to_three), named_by(to_two))
    # A later report changes nothing, and a lab that loads the record again has the same names.
    assert await lab.name_by_model('agent-1', 'Claude Code', 'Opus 6') == late
    again = Lab.load(record_file).board
    assert [joined.agent.name for joined in again.agents] == [joined.agent.name for joined in lab.board.agents]
    assert again.names() == lab.board.names()


async def test_a_name_with_the_id_of_a_chosen_model_gets_the_name_that_the_harness_shows(lab: Lab) -> None:
    await lab.join(named('agent-1', 'Claude Code · opus', 'opus'))
    await lab.join(named('agent-2', 'Claude Code · opus 2', 'opus'))
    await lab.join(named('agent-3', 'Claude Code · Opus 5.5', 'opus'))
    await lab.join(named('guest-1', 'Claude Code · Opus 5.5 2', harness='guest'))

    last = await lab.name_by_model('agent-2', 'Claude Code', 'Opus 5.5')
    first = await lab.name_by_model('agent-1', 'Claude Code', 'Opus 5.5')

    # Each takes the next number that no agent has or had: agent 3 has the harness's name from the setup, an
    # invited agent has the number 2, and "Claude Code · opus" is a name that agent 1 had.
    assert (last, first) == ('Claude Code · Opus 5.5 3', 'Claude Code · Opus 5.5 4')
    assert [joined.agent.name for joined in lab.board.agents[-4:]] == [
        'Claude Code · Opus 5.5 4',
        'Claude Code · Opus 5.5 3',
        'Claude Code · Opus 5.5',
        'Claude Code · Opus 5.5 2',
    ]
    # A new agent does not get a name that an agent had before either.
    assert label('Claude Code', 'opus', tuple(name for _, name in lab.board.names())) == ('Claude Code · opus 3')


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
    flat = ' '.join(INSTRUCTIONS.split())
    seats = ' '.join(
        line
        for line in INSTRUCTIONS.splitlines()
        if any(word in line for word in ('on call', 'on-call', 'coordinator', 'reviewer'))
    )

    for fact in (
        "The seat's label is its harness's title and its model's name",
        'it says "default model" until the harness names the model',
        "The label is the agent's name until the agent chooses a name with `profile`",
        'An invited agent that is on call runs by itself',
        'The person can give a seat a role and change it at any time.',
        '`brief` names it in `coordinator`',
        'No post for every agent is for an on-call agent',
        'A name in a `plan`, a `message`, a `result`, or another post that is no `ask` and no `call` is not for it',
        'an `ask` or a `call` that names the agent',
        'the check of a rerun that the agent asked for',
        '`mentions` names an agent by its ID, such as `agent-2`',
        'its name, or the full label of its seat in the text of a post also reaches that agent',
        "A `check` of another agent's post and a `rerun` request take a reviewer seat.",
        'An `objection` takes no seat.',
        'In a lab with zero reviewer seats, a check and a rerun request take none.',
        'The coordinator and the person can mark a post with `to_lab`.',
        'It does not open a closed lab again.',
        '`about` in a profile says what lens the agent brings: its field and how it approaches a problem.',
        'Verifold acts on no text of a profile.',
    ):
        assert fact in flat, fact
    assert "An agent's name holds its harness and its model." not in INSTRUCTIONS
    assert 'Verifold starts an on-call agent' not in flat
    assert 'A post is for it when the post names it' not in flat
    assert not any(word in seats for word in ('should', 'must', 'Use ', 'prefer', 'instead'))
