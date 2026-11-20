from collections.abc import Mapping

import pytest
from conftest import agent
from mcp import Client
from mcp.types import CallToolResult

from verifold.protocol.events import ProfileSet, ReviewerSet
from verifold.protocol.join import PostRequest
from verifold.protocol.settings import ReviewerSettings, Settings
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile


def name_of(board: Board, agent_id: str) -> str:
    joined = board.agent(agent_id)
    assert joined is not None
    return joined.agent.name


PICTURE = {'shape': 'hex', 'color': '#f08c3a', 'symbol': 'orbit'}


async def call(lab: Lab, who: str | Member, tool: str, arguments: Mapping[str, object]) -> CallToolResult:
    """Call a board tool as an agent, and return the tool's result."""
    member = who if isinstance(who, Member) else Member(lab, who)
    async with Client(join_server(lambda _: member)) as client:
        return await client.call_tool(tool, dict(arguments))


def error(result: CallToolResult) -> str:
    """Return the text of a tool's error."""
    return str(getattr(result.content[0], 'text', ''))


async def test_an_agent_sets_its_name_about_line_and_picture_with_profile_and_a_repeat_records_nothing(
    lab: Lab, record_file: RecordFile
) -> None:
    profile = {'name': 'Tessel', 'about': 'I run a number twice.', 'role': 'builder', **PICTURE}
    result = await call(lab, 'bo', 'profile', profile)
    seq = lab.board.seq
    same = await call(lab, 'bo', 'profile', profile)
    read = await call(lab, 'bo', 'profile', {})

    assert not result.is_error
    assert result.structured_content is not None
    assert [result.structured_content[key] for key in ('agent', 'name', 'seat', 'about', 'role', 'picture')] == [
        'bo',
        'Tessel',
        'Bo',
        'I run a number twice.',
        'builder',
        PICTURE,
    ]
    assert same.structured_content is not None
    assert read.structured_content is not None
    assert (lab.board.seq, same.structured_content['name'], read.structured_content['name']) == (
        seq,
        'Tessel',
        'Tessel',
    )
    events = [event for event in record_file.read() if isinstance(event, ProfileSet)]
    assert [(event.agent, event.name, event.by) for event in events] == [('bo', 'Tessel', None)]
    # A lab that loads the record again has the same profile.
    again = Lab.load(record_file).board
    assert (name_of(again, 'bo'), again.label('bo'), again.picture('bo')) == (
        'Tessel',
        'Bo',
        lab.board.picture('bo'),
    )


async def test_the_board_refuses_a_name_that_is_taken_or_reserved_and_a_picture_in_parts(lab: Lab) -> None:
    await call(lab, 'bo', 'profile', {'name': 'Tessel'})

    for name, why in (
        ('tessel', 'tessel reads as Tessel, a name that another agent has or had'),
        ('Coordinator', 'is made of the word "coordinator"'),
        ('fake', 'name of a harness or a model in this lab (fake)'),
    ):
        refusal = await call(lab, 'ada', 'profile', {'name': name})
        assert (refusal.is_error, why in error(refusal)) == (True, True), error(refusal)
    refusal = await call(lab, 'ada', 'profile', {'shape': 'hex'})
    assert (refusal.is_error, 'all three or none' in error(refusal)) == (True, True)
    refusal = await call(lab, 'ada', 'profile', {'flag': 'Why.'})
    assert (refusal.is_error, 'are for the profile of another agent' in error(refusal)) == (True, True)
    assert name_of(lab.board, 'ada') == 'Ada'


async def test_the_coordinator_changes_another_agents_profile_and_that_agent_reads_it_in_its_news(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    await call(lab, bo, 'profile', {'name': 'Tessel', 'about': 'I am the best model.'})
    refused = await call(lab, 'ada', 'profile', {'agent': 'bo', 'flag': 'It ranks itself.'})
    await lab.set_coordinator('ada', 'person')
    result = await call(
        lab,
        'ada',
        'profile',
        {
            'agent': 'bo',
            'flag': 'It ranks itself.',
            'about': 'Runs numbers twice.',
            'name': '',
            'given_role': 'builder',
        },
    )
    own = await call(lab, 'ada', 'profile', {'agent': 'bo', 'role': 'theory'})
    named = await call(lab, 'ada', 'profile', {'agent': 'bo', 'name': 'Mine'})
    told = await call(lab, bo, 'threads', {})

    assert (refused.is_error, "Only the person and the lab's coordinator" in error(refused)) == (True, True)
    assert (result.is_error, own.is_error, named.is_error) == (False, True, True)
    assert result.structured_content is not None
    assert [result.structured_content[key] for key in ('agent', 'name', 'about', 'flag', 'given_role', 'given_by')] == [
        'bo',
        'Bo',
        'Runs numbers twice.',
        'It ranks itself.',
        'builder',
        'ada',
    ]
    assert told.structured_content is not None
    assert told.structured_content['news']['profile'] == [
        {
            'by': 'ada',
            'name_taken_back': True,
            'about': 'Runs numbers twice.',
            'picture_taken_back': False,
            'given_role': 'builder',
            'flag': 'It ranks itself.',
        }
    ]
    # The agent gets the note once, and edits its profile again.
    later = await call(lab, bo, 'profile', {'about': 'I run a number twice.'})
    assert later.structured_content is not None
    assert (
        later.structured_content['about'],
        later.structured_content['flag'],
        later.structured_content['news']['profile'],
    ) == ('I run a number twice.', '', [])


async def test_the_person_changes_a_profile_and_a_change_that_changes_nothing_records_nothing(lab: Lab) -> None:
    await lab.set_profile('bo', name='Tessel', about='A lens.')
    await lab.change_profile('bo', 'person', reset_name=True, about='', given_role='driver')
    seq = lab.board.seq
    await lab.change_profile('bo', 'person', reset_name=True, about='', reset_picture=True, given_role='driver')

    assert (lab.board.seq, name_of(lab.board, 'bo'), lab.board.about('bo')) == (seq, 'Bo', '')
    assert lab.board.given_role('bo') == ('driver', 'person')
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        await lab.change_profile('zed', 'person', given_role='driver')


async def test_an_agent_takes_a_reviewer_seat_with_profile_and_the_person_gives_and_takes_one(
    lab: Lab, record_file: RecordFile
) -> None:
    await lab.join(agent('cy'))
    taken = await call(lab, 'bo', 'profile', {'reviewer': True})
    seq = lab.board.seq
    await call(lab, 'bo', 'profile', {'reviewer': True})
    full = await call(lab, 'cy', 'profile', {'reviewer': True})
    none = await call(lab, 'cy', 'profile', {'reviewer': False})

    assert taken.structured_content is not None
    assert (
        taken.is_error,
        taken.structured_content['reviewers'],
        taken.structured_content['reviewer_seats'],
        taken.structured_content['reviewer_seats_free'],
    ) == (False, ['bo'], 1, 0)
    assert (lab.board.seq, full.is_error, none.is_error) == (seq, True, True)
    assert 'No reviewer seat is free. The lab has 1: held by bo; 0 are free.' in error(full)
    await lab.set_reviewer('cy', 'person', reviewer=True)
    await lab.set_reviewer('bo', 'person', reviewer=False)
    assert [
        (event.agent, event.reviewer, event.by) for event in record_file.read() if isinstance(event, ReviewerSet)
    ] == [
        ('bo', True, 'bo'),
        ('cy', True, 'person'),
        ('bo', False, 'person'),
    ]
    brief = await call(lab, 'ada', 'brief', {})
    assert brief.structured_content is not None
    assert (
        brief.structured_content['reviewers'],
        brief.structured_content['reviewer_seats'],
        brief.structured_content['reviewer_seats_free'],
    ) == (['cy'], 1, 0)
    # An agent's line leaves out a seat that the agent does not hold.
    assert [line.get('reviewer') for line in brief.structured_content['agents']] == [None, True]
    assert Lab.load(record_file).board.reviewer('cy')


async def test_a_check_and_a_rerun_request_take_a_reviewer_seat_and_an_objection_takes_none(lab: Lab) -> None:
    await lab.join(agent('cy'))
    check = PostRequest(kind='check', text='Holds.', reply_to='p-1', thread='t-1', outcome='holds', method='code_read')
    fact = (
        "another agent's post takes a reviewer seat. The lab has 1: held by nobody; 1 is free. `profile` with "
        '`reviewer: true` takes a free seat, and the person can give one. An objection needs no seat, and an author '
        'can ask for an independent rerun of its own post.'
    )

    with pytest.raises(RejectedEvent, match=f'A check on {fact}'):
        await lab.post(check, 'bo')
    with pytest.raises(RejectedEvent, match=f'A request for an independent rerun of {fact}'):
        await lab.request_rerun('bo', 'p-1')
    posts = len(lab.board.posts)
    # An objection is open to every agent, and so is a result that builds on the post. Neither opens the gate.
    await lab.post(PostRequest(kind='objection', text='A leak.', reply_to='p-1', thread='t-1'), 'cy')
    await lab.post(PostRequest(kind='result', text='I got the same.', thread='t-1', builds_on=('p-1',)), 'cy')
    with pytest.raises(RejectedEvent, match='takes a reviewer seat'):
        await lab.post(check, 'cy')
    # The person is not limited, and a reviewer checks.
    await lab.post(check, 'person')
    await lab.set_reviewer('bo', 'bo', reviewer=True)
    await lab.post(check, 'bo')
    assert len(lab.board.posts) == posts + 4
    # The refusal names who holds the seats. The author of a post asks for a rerun of it without a seat: the
    # board gets as far as the post's files.
    with pytest.raises(RejectedEvent, match='The lab has 1: held by bo; 0 are free'):
        await lab.post(check, 'cy')
    with pytest.raises(RejectedEvent, match='has no files as evidence'):
        await lab.request_rerun('ada', 'p-1')


async def test_a_lab_of_two_agents_or_with_zero_seats_limits_no_check_and_a_record_from_before_loads(
    lab: Lab, record_file: RecordFile
) -> None:
    check = PostRequest(kind='check', text='Holds.', reply_to='p-1', thread='t-1', outcome='holds', method='code_read')
    # Two agents: the lab has no reviewer seat, so a check takes none.
    await lab.post(check, 'bo')
    await lab.join(agent('cy'))
    await lab.join(agent('dee'))
    await lab.set_settings(Settings(reviewers=ReviewerSettings(seats=0)))
    await lab.post(check, 'cy')
    await lab.set_settings(Settings())
    with pytest.raises(RejectedEvent, match='takes a reviewer seat'):
        await lab.post(check, 'dee')

    # The record holds checks by agents without a seat, as a record from before the seats does, and it loads.
    again = Lab.load(record_file).board
    assert [entry.post.author for entry in again.posts if entry.post.kind == 'check'] == ['bo', 'cy']


async def test_the_coordinator_marks_a_post_for_the_whole_lab_with_the_post_tool(lab: Lab) -> None:
    refused = await call(lab, 'bo', 'post', {'kind': 'message', 'text': 'Hear this.', 'thread': 't-1', 'to_lab': True})
    await lab.set_coordinator('bo', 'person')
    posted = await call(lab, 'bo', 'post', {'kind': 'message', 'text': 'Hear this.', 'thread': 't-1', 'to_lab': True})

    assert (refused.is_error, "Only the lab's coordinator and the person" in error(refused)) == (True, True)
    assert posted.structured_content is not None
    assert (posted.is_error, posted.structured_content['post']['to_lab'], posted.structured_content['by']['marks']) == (
        False,
        True,
        ['coordinator'],
    )


async def test_an_agent_that_chose_a_name_keeps_it_when_its_harness_names_the_model(lab: Lab) -> None:
    await lab.join(agent('agent-3').model_copy(update={'name': 'Codex · default model'}))
    await lab.set_profile('agent-3', name='Tessel')

    shown = await lab.name_by_model('agent-3', 'Codex', 'gpt-6.1-sol')
    again = await lab.name_by_model('agent-3', 'Codex', 'gpt-6.1-sol')

    # The seat's label names the model from now on, and the agent's name is the one that it chose.
    assert (shown, again, lab.board.label('agent-3')) == ('Tessel', 'Tessel', 'Codex · gpt-6.1-sol')
    assert [name for holder, name in lab.board.names() if holder == 'agent-3'] == [
        'Codex · default model',
        'Tessel',
        'Codex · gpt-6.1-sol',
    ]
    # A name that the board refuses changes no seat.
    refused = await call(lab, 'bo', 'profile', {'name': 'Tessel', 'coordinator': True, 'reviewer': True})
    assert (refused.is_error, lab.board.coordinator, lab.board.reviewer('bo')) == (True, None, False)


async def test_the_board_records_a_whole_profile_call_or_nothing(lab: Lab) -> None:
    await lab.join(agent('cy'))
    await lab.set_reviewer('cy', 'cy', reviewer=True)
    await lab.set_coordinator('cy', 'person')
    seq = lab.board.seq

    no_seat = await call(lab, 'bo', 'profile', {'name': 'Quill', 'role': 'builder', 'reviewer': True})
    held = await call(lab, 'bo', 'profile', {'about': 'A lens.', 'coordinator': True})
    none = await call(lab, 'bo', 'profile', {'status': 'Reading.', 'reviewer': False})

    assert (no_seat.is_error, held.is_error, none.is_error) == (True, True, True)
    assert 'No reviewer seat is free' in error(no_seat)
    # The board refused the seat, so it kept nothing of each call: no name, no role, no about line, no status.
    assert (lab.board.seq, name_of(lab.board, 'bo'), lab.board.profile('bo'), lab.board.about('bo')) == (
        seq,
        'Bo',
        ('', ''),
        '',
    )
    # A call whose parts all hold is recorded in one step.
    done = await call(lab, 'cy', 'profile', {'name': 'Quill', 'reviewer': False, 'coordinator': False})
    assert (done.is_error, name_of(lab.board, 'cy'), lab.board.reviewer('cy'), lab.board.coordinator) == (
        False,
        'Quill',
        False,
        None,
    )
