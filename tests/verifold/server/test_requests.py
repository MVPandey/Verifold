import asyncio
from datetime import timedelta
from pathlib import Path

import httpx2
import pytest
from conftest import agent
from mcp import Client
from pydantic import SecretStr, ValidationError

from verifold.protocol.agents import Agent, AgentChoice, ModelSpec
from verifold.protocol.events import AgentJoined, AgentLeft, Posted, PowerSet, ProfileSet, RequestAnswered, TimeSet
from verifold.protocol.join import MoveForm, PostRequest
from verifold.protocol.moves import (
    AddMove,
    AddSeat,
    PermissionMove,
    QuestionMove,
    RemoveMove,
    SettingMove,
    TimeMove,
)
from verifold.protocol.posts import Answer, Message, MoveRequest
from verifold.protocol.settings import AtExit, AtTimeLimit
from verifold.runner.messages import start_message
from verifold.runner.permissions import ask_the_person
from verifold.runner.session import PermissionChoice, PermissionRequest
from verifold.server.activity import Activity
from verifold.server.app_api import app_api
from verifold.server.errors import HasLeft, OutOfTime, SetupRejected
from verifold.server.join import join_server
from verifold.server.lab import Build, Lab
from verifold.server.member import Member
from verifold.society.attention import update
from verifold.society.errors import RejectedEvent
from verifold.society.views import needs_person
from verifold.store.record_file import RecordFile

MORE = TimeMove(minutes=120)
HOUR = timedelta(hours=1)
COMMAND = PermissionRequest(
    title='./gpu train',
    command='./gpu train | tail',
    choices=(
        PermissionChoice(id='once', name='Allow once', kind='allow_once'),
        PermissionChoice(id='always', name='Allow always', kind='allow_always'),
        PermissionChoice(id='no', name='Reject', kind='reject_once'),
    ),
)


@pytest.fixture
async def led(lab: Lab) -> Lab:
    """The `lab` fixture with one hour of time and ada as its coordinator."""
    await lab.set_time_left(HOUR)
    await lab.set_coordinator('ada', 'person')
    return lab


def kinds(lab: Lab, record_file: RecordFile, since: int) -> list[type]:
    assert Lab.load(record_file).board == lab.board
    return [type(event) for event in record_file.read()[since:]]


async def test_the_first_post_in_the_conversation_opens_it_and_later_posts_go_there(led: Lab) -> None:
    first = await led.post(PostRequest(kind='message', text='Where are we?', conversation=True), 'person')
    reply = await led.post(PostRequest(kind='message', text='Two lines are alive.', conversation=True), 'ada')

    talk = led.board.conversation
    opened = led.board.thread(talk or '')
    assert opened is not None
    assert (first.post.thread, reply.post.thread) == (talk, talk)
    assert (opened.thread.conversation, opened.thread.opened_by, opened.thread.title) == (
        True,
        'person',
        'The person and the coordinator',
    )
    # The person's words reached the coordinator, and its reply reached no agent.
    assert [entry.post.id for entry in update(led.board, 'ada', first.seq - 1).posts] == [first.post.id]
    assert update(led.board, 'bo', first.seq - 1).posts == ()
    with pytest.raises(ValidationError, match='`conversation` stands alone'):
        PostRequest(kind='message', text='Hi', conversation=True, thread='t-1')
    with pytest.raises(ValidationError, match='goes through the `request` tool'):
        PostRequest(kind='request', text='More time.', conversation=True)


async def test_a_lab_without_a_coordinator_has_no_conversation(lab: Lab) -> None:
    with pytest.raises(RejectedEvent, match='open their conversation'):
        await lab.post(PostRequest(kind='message', text='Anyone?', conversation=True), 'person')
    assert lab.board.conversation is None


async def test_the_coordinator_posts_and_opens_a_thread_for_the_person_and_no_other_agent_does(led: Lab) -> None:
    opened = await led.post(
        PostRequest(kind='call', text='How much size can the pairs take?', new_thread='Size', for_person=True), 'ada'
    )

    thread = led.board.thread(opened.post.thread)
    assert thread is not None
    assert (thread.thread.for_person, opened.post.for_person, opened.post.to_lab) == (True, True, True)
    # Where a post for the whole lab can stand, a post for the person is one, so it reaches every agent.
    steer = await led.post(PostRequest(kind='message', text='Size first.', thread='t-1', for_person=True), 'ada')
    named = await led.post(
        PostRequest(kind='message', text='Bo, size first.', thread='t-1', for_person=True, mentions=('bo',)), 'ada'
    )
    assert (steer.post.to_lab, named.post.to_lab) == (True, False)
    assert steer.post.id in [entry.post.id for entry in update(led.board, 'bo', opened.seq).posts]
    with pytest.raises(RejectedEvent, match='Only the agent that holds the coordinator seat'):
        await led.post(PostRequest(kind='message', text='The person wants it.', thread='t-1', for_person=True), 'bo')
    with pytest.raises(RejectedEvent, match='Only the agent that holds the coordinator seat'):
        await led.post(PostRequest(kind='message', text='For the person.', new_thread='Mine', for_person=True), 'bo')


async def test_a_request_changes_nothing_until_the_person_says_yes(led: Lab, record_file: RecordFile) -> None:
    ends_at = led.board.ends_at
    assert ends_at is not None
    seq = led.board.seq

    asked = await led.request(MORE, 'The depth run needs 90 minutes.', 'The lab has 34 left.', 'ada')

    assert kinds(led, record_file, seq) == [type(led.board.threads[-1]), Posted]
    assert (led.board.ends_at, led.board.answers) == (ends_at, ())
    assert [item.post.id for item in needs_person(led.board)] == [asked.post.id]
    seen = led.board.seq

    answered = await led.answer_request(asked.post.id, yes=True, minutes=90)

    assert (answered.yes, answered.by, answered.minutes) == (True, 'person', 90)
    assert kinds(led, record_file, seen) == [Posted, RequestAnswered, TimeSet]
    assert led.board.ends_at == ends_at + timedelta(minutes=90)
    assert needs_person(led.board) == ()
    # The person's answer is a post that replies to the request, so the coordinator hears it.
    reply = update(led.board, 'ada', seen).posts[0].post
    assert (reply.author, reply.text, reply.reply_to) == ('person', 'Yes', asked.post.id)
    with pytest.raises(RejectedEvent, match='has its answer already'):
        await led.answer_request(asked.post.id, yes=False)


async def test_a_no_is_recorded_and_makes_no_move(led: Lab, record_file: RecordFile) -> None:
    ends_at = led.board.ends_at
    asked = await led.request(MORE, 'More time.', '', 'ada')
    seen = led.board.seq

    answered = await led.answer_request(asked.post.id, yes=False)

    assert (answered.yes, led.board.ends_at) == (False, ends_at)
    assert kinds(led, record_file, seen) == [Posted, RequestAnswered]
    assert update(led.board, 'ada', seen).posts[0].post.text == 'Not now'
    with pytest.raises(RejectedEvent, match='p-9 is no request for a move'):
        await led.answer_request('p-9', yes=True)


async def test_with_a_power_the_move_takes_effect_with_the_request_and_without_it_does_not(
    led: Lab, record_file: RecordFile
) -> None:
    ends_at = led.board.ends_at
    assert ends_at is not None
    await led.set_power('time', on=True)
    seq = led.board.seq
    # The same switch again records nothing.
    await led.set_power('time', on=True)
    assert led.board.seq == seq

    asked = await led.request(MORE, 'The depth run needs it.', '', 'ada')

    answered = led.board.answer_to(asked.post.id)
    assert answered is not None
    assert (answered.by, answered.yes) == ('ada', True)
    assert kinds(led, record_file, seq)[1:] == [Posted, RequestAnswered, TimeSet]
    assert led.board.ends_at == ends_at + timedelta(minutes=120)
    assert needs_person(led.board) == ()

    await led.set_power('time', on=False)
    waiting = await led.request(MORE, 'Once more.', '', 'ada')
    assert (led.board.answer_to(waiting.post.id), led.board.ends_at) == (None, ends_at + timedelta(minutes=120))
    assert isinstance(record_file.read()[-2], PowerSet)


async def test_no_other_agent_asks_for_a_move_or_uses_a_power(led: Lab) -> None:
    await led.set_power('time', on=True)
    seq = led.board.seq

    with pytest.raises(RejectedEvent, match='Only the agent that holds the coordinator seat asks'):
        await led.request(MORE, 'I want time.', '', 'bo')
    with pytest.raises(RejectedEvent, match='Only the agent that holds the coordinator seat asks'):
        await Member(led, 'bo').request(MORE, 'I want time.')

    assert led.board.seq == seq
    # The powers go off with the seat, and the new holder's request waits for the person.
    await led.set_coordinator('bo', 'person')
    asked = await led.request(MORE, 'I want time.', '', 'bo')
    assert (led.board.powers, led.board.answer_to(asked.post.id)) == (frozenset(), None)
    await led.set_coordinator(None, 'person')
    with pytest.raises(RejectedEvent, match='A power is for the agent that holds the coordinator seat, and nobody'):
        await led.set_power('time', on=True)


async def test_a_seat_can_start_with_powers_and_a_plain_seat_has_none(lab: Lab) -> None:
    await lab.join(agent('cy'), coordinator=True, powers=('time', 'agents'))

    assert lab.board.powers == frozenset({'time', 'agents'})
    assert AgentChoice(harness='fake', coordinator=True, powers=('time',)).powers == ('time',)
    with pytest.raises(ValidationError, match='Only the seat of the coordinator has powers'):
        AgentChoice(harness='fake', powers=('time',))


async def test_a_yes_removes_an_agent_as_the_person_and_a_power_names_the_coordinator(led: Lab) -> None:
    await led.join(agent('cy'))
    asked = await led.request(RemoveMove(agent='bo'), 'Bo repeats the same run.', '', 'ada')
    await led.answer_request(asked.post.id, yes=True)

    left = led.board.gone('bo')
    assert left is not None
    # The coordinator's words stay in its request, which the removal names. They are no reason of the person.
    assert (left.by, left.through, left.reason, left.request) == ('person', None, '', asked.post.id)

    await led.set_power('agents', on=True)
    await led.request(RemoveMove(agent='cy'), 'Cy has no line.', '', 'ada')

    gone = led.board.gone('cy')
    assert isinstance(gone, AgentLeft)
    assert (gone.by, gone.through, gone.reason) == ('person', 'ada', '')
    with pytest.raises(HasLeft, match='ada, the coordinator, removed you from this lab with a power'):
        Member(led, 'cy').check_here()
    with pytest.raises(
        HasLeft, match=f"The person removed you from this lab, with a yes to the coordinator's request {asked.post.id}"
    ):
        Member(led, 'bo').check_here()


async def test_a_move_changes_a_setting_of_the_lab_and_never_the_permission_settings(led: Lab) -> None:
    asked = await led.request(SettingMove(key='jobs.at_exit', value='keep'), 'The run goes on.', '', 'ada')
    await led.answer_request(asked.post.id, yes=True)

    assert led.board.settings.jobs.at_exit is AtExit.KEEP
    with pytest.raises(ValidationError):
        SettingMove.model_validate({'key': 'permissions.while_you_decide', 'value': 'wait'})
    with pytest.raises(ValidationError):
        SettingMove(key='jobs.at_exit', value='later')


async def test_a_move_revises_the_question_as_the_person_or_under_the_power_as_the_coordinator(led: Lab) -> None:
    await led.open_question_thread()
    asked = await led.request(QuestionMove(question='Does it hold at size?', note='Size matters.'), 'Size.', '', 'ada')
    await led.answer_request(asked.post.id, yes=True)

    told = led.board.post(led.board.revisions[-1].post)
    assert told is not None
    assert (led.board.question, led.board.revisions[-1].by, told.post.author) == (
        'Does it hold at size?',
        'person',
        'person',
    )
    same = await led.request(QuestionMove(question='Does it hold at size?'), 'Again.', '', 'ada')
    with pytest.raises(RejectedEvent, match='The question has this text already'):
        await led.answer_request(same.post.id, yes=True)

    await led.set_power('question', on=True)
    await led.request(QuestionMove(question='Does it hold at any size?'), 'Wider.', '', 'ada')

    revised = led.board.revisions[-1]
    post = led.board.post(revised.post)
    assert post is not None
    assert (led.board.question, revised.by, post.post.author, post.post.for_person) == (
        'Does it hold at any size?',
        'ada',
        'ada',
        True,
    )
    assert post.post.text == 'The coordinator revised the question for the person: Does it hold at any size?'
    # The person's own revision goes on as before.
    assert await led.revise_question('Does it hold?') is not None
    assert await led.revise_question(' Does it hold? ') is None


async def test_the_coordinators_move_decides_another_agents_permission_request(led: Lab) -> None:
    await led.set_power('permissions', on=True)
    seq = led.board.seq
    deciding = asyncio.create_task(ask_the_person(Member(led, 'bo'), COMMAND))
    await led.wait_for_change(seq)
    ask = led.board.posts[-1].post

    with pytest.raises(RejectedEvent, match='only the person picks it'):
        await led.request(PermissionMove(ask=ask.id, option='always'), 'Bo needs it.', '', 'ada')
    await led.request(PermissionMove(ask=ask.id, option='once'), 'It only reads.', '', 'ada')

    assert await deciding == 'once'
    answer = led.board.posts[-1].post
    assert isinstance(answer, Answer)
    assert (answer.author, answer.choice, answer.reply_to, answer.for_request) == ('ada', 'Allow once', ask.id, 'p-3')
    assert needs_person(led.board) == ()
    # The answer replies to the agent's ask, so the agent hears who decided it.
    assert answer.id in [entry.post.id for entry in update(led.board, 'bo', seq).posts]


async def test_the_persons_yes_to_a_request_decides_the_permission_request_with_the_persons_answer(led: Lab) -> None:
    seq = led.board.seq
    deciding = asyncio.create_task(ask_the_person(Member(led, 'bo'), COMMAND))
    await led.wait_for_change(seq)
    ask = led.board.posts[-1].post
    asked = await led.request(PermissionMove(ask=ask.id, option='no'), 'It writes outside its folder.', '', 'ada')
    assert not deciding.done()

    await led.answer_request(asked.post.id, yes=True)

    assert await deciding == 'no'
    answer = next(entry.post for entry in led.board.posts if isinstance(entry.post, Answer) and entry.post.for_request)
    assert (answer.author, answer.choice) == ('person', 'Reject')
    # The coordinator's own harness asks the person, never the coordinator.
    own = asyncio.create_task(ask_the_person(Member(led, 'ada'), COMMAND))
    await led.wait_for_change(led.board.seq)
    with pytest.raises(RejectedEvent, match='Only the person answers the request'):
        await led.request(PermissionMove(ask=led.board.posts[-1].post.id, option='once'), 'Mine.', '', 'ada')
    own.cancel()


async def test_a_move_adds_an_agent_in_one_step_with_its_yes(led: Lab, record_file: RecordFile) -> None:
    added: list[tuple[AddSeat, str]] = []

    async def adds(seat: AddSeat, first: tuple[Build, ...], asked_by: str) -> None:
        added.append((seat, asked_by))
        joined = Agent(
            id=f'agent-{len(added)}', name=f'Agent {len(added)}', harness='fake', model=ModelSpec(family='x')
        )
        await led.join(joined, first=first, given=(seat.role, asked_by) if seat.role else None)

    seat = AddSeat(harness='fake', role='maker side')
    asked = await led.request(AddMove(seat=seat), 'The maker side has one agent.', '', 'ada', adds)
    assert added == []
    seen = led.board.seq
    with pytest.raises(SetupRejected, match='cannot start an agent from here'):
        await led.answer_request(asked.post.id, yes=True)
    assert led.board.seq == seen

    await led.answer_request(asked.post.id, yes=True, adds=adds)

    assert added == [(seat, 'ada')]
    assert kinds(led, record_file, seen) == [Posted, RequestAnswered, AgentJoined, ProfileSet]
    # The role is the coordinator's word for the seat, also after the person's yes. It never reads as the person's.
    joined = led.board.agent('agent-1')
    assert joined is not None
    assert (joined.agent.given_role, led.board.given_role('agent-1')) == ('', ('maker side', 'ada'))
    assert 'ada, as the coordinator of the lab, gave your seat this role: maker side' in start_message(
        led.board, joined.agent, Path('LAB.md')
    )

    await led.set_power('agents', on=True)
    seen = led.board.seq
    with pytest.raises(SetupRejected, match='cannot start an agent from here'):
        await led.request(AddMove(seat=seat), 'One more.', '', 'ada')
    assert led.board.seq == seen
    again = await led.request(AddMove(seat=AddSeat(harness='fake')), 'One more.', '', 'ada', adds)
    assert kinds(led, record_file, seen) == [Posted, RequestAnswered, AgentJoined]
    answered = led.board.answer_to(again.post.id)
    assert answered is not None
    assert (answered.by, len(added)) == ('ada', 2)


async def test_no_power_makes_a_move_after_the_person_stopped_the_lab_and_the_request_waits(led: Lab) -> None:
    for power in ('agents', 'settings', 'question', 'time'):
        await led.set_power(power, on=True)
    await led.set_time_left(timedelta(0))
    settings, question, ends_at = led.board.settings, led.board.question, led.board.ends_at

    asked = [
        await led.request(move, 'It helps.', '', 'ada')
        for move in (
            SettingMove(key='jobs.at_time_limit', value='stop'),
            QuestionMove(question='Something else entirely'),
            RemoveMove(agent='bo'),
            AddMove(seat=AddSeat(harness='fake')),
            MORE,
        )
    ]

    # Each request is on the board for the person, and nothing else changed.
    assert [item.post.id for item in needs_person(led.board)] == [entry.post.id for entry in asked]
    assert (led.board.answers, led.board.gone('bo')) == ((), None)
    assert (led.board.settings, led.board.question, led.board.ends_at) == (settings, question, ends_at)
    # The person's own yes still makes a move.
    await led.answer_request(asked[-1].post.id, yes=True)
    assert led.board.ends_at is not None
    assert ends_at is not None
    assert led.board.ends_at > ends_at


async def test_the_settings_power_sets_no_value_that_outlasts_a_stop(led: Lab) -> None:
    await led.set_power('settings', on=True)

    strict = await led.request(SettingMove(key='jobs.at_time_limit', value='stop'), 'Free the GPU.', '', 'ada')
    loose = await led.request(SettingMove(key='jobs.at_time_limit', value='finish'), 'Let it run.', '', 'ada')
    kept = await led.request(SettingMove(key='jobs.at_exit', value='keep'), 'Let it run.', '', 'ada')

    assert led.board.answer_to(strict.post.id) is not None
    assert led.board.settings.jobs.at_time_limit is AtTimeLimit.STOP
    assert [item.post.id for item in needs_person(led.board)] == [loose.post.id, kept.post.id]


async def test_a_request_from_an_earlier_holding_of_the_seat_never_comes_back(led: Lab) -> None:
    asked = await led.request(MORE, 'More.', '', 'ada')
    await led.set_coordinator('bo', 'person')
    assert needs_person(led.board) == ()

    await led.set_coordinator('ada', 'person')

    assert needs_person(led.board) == ()
    with pytest.raises(RejectedEvent, match='The coordinator seat changed after ada asked'):
        await led.answer_request(asked.post.id, yes=True)


async def test_the_question_of_a_lab_without_a_question_thread_has_one_thread_for_every_revision(led: Lab) -> None:
    await led.set_power('question', on=True)

    await led.request(QuestionMove(question='Is it stable?'), 'Stability first.', '', 'ada')
    await led.request(QuestionMove(question='Is it stable at size?'), 'And size.', '', 'ada')
    await led.revise_question('Is it stable at any size?')

    threads = {told.post.thread for revision in led.board.revisions if (told := led.board.post(revision.post))}
    assert len(threads) == 1
    opened = led.board.thread(next(iter(threads)))
    assert opened is not None
    assert (opened.thread.title, opened.thread.opened_by) == ('The question, revised', 'ada')
    assert [(revision.by, revision.request is not None) for revision in led.board.revisions] == [
        ('ada', True),
        ('ada', True),
        ('person', False),
    ]


async def test_the_person_takes_the_minutes_of_a_request_back_while_nothing_else_changed_the_time(led: Lab) -> None:
    ends_at = led.board.ends_at
    asked = await led.request(MORE, 'More time.', '', 'ada')
    with pytest.raises(RejectedEvent, match='gave the lab no minutes'):
        await led.take_minutes_back(asked.post.id)
    await led.answer_request(asked.post.id, yes=True, minutes=30)

    await led.take_minutes_back(asked.post.id)

    assert led.board.ends_at == ends_at
    with pytest.raises(RejectedEvent, match="the lab's time changed since"):
        await led.take_minutes_back(asked.post.id)
    # Minutes that hold the lab open do not come back: that would stop the lab.
    await led.set_time_left(timedelta(seconds=2))
    last = await led.request(TimeMove(minutes=1), 'A little more.', '', 'ada')
    await led.answer_request(last.post.id, yes=True)
    with pytest.raises(RejectedEvent, match='Without these minutes the lab ends now'):
        await led.take_minutes_back(last.post.id)


async def test_an_invited_coordinator_asks_for_nothing_while_the_lab_is_out_of_time(lab: Lab) -> None:
    await lab.join(Agent(id='guest', name='Guest', harness='guest', model=ModelSpec(family='unknown')))
    await lab.set_coordinator('guest', 'person')
    await lab.set_power('time', on=True)
    await lab.set_time_left(timedelta(0))

    with pytest.raises(OutOfTime):
        await Member(lab, 'guest').request(MORE, 'Go on.')


def test_a_move_form_takes_the_fields_of_its_kind_and_refuses_the_rest() -> None:
    seat = MoveForm(move='add_agent', harness='fake', model='mini', role='maker side', on_call=True).to_move()
    assert 'family' not in MoveForm.model_fields
    setting = MoveForm(move='setting', setting='jobs.at_time_limit', value='finish').to_move()

    assert seat == AddMove(seat=AddSeat(harness='fake', model='mini', role='maker side', on_call=True))
    assert setting == SettingMove(key='jobs.at_time_limit', value='finish')
    assert MoveForm(move='time', minutes=30).to_move() == TimeMove(minutes=30)
    assert MoveForm(move='remove_agent', agent='bo').to_move() == RemoveMove(agent='bo')
    assert MoveForm(move='question', question=' Is it stable? ', note='Why not.').to_move() == QuestionMove(
        question='Is it stable?', note='Why not.'
    )
    for wrong in (
        MoveForm(move='time'),
        MoveForm(move='time', minutes=0),
        MoveForm(move='time', minutes=30, agent='bo'),
        MoveForm(move='permission', ask='p-1'),
        MoveForm(move='remove_agent', harness='fake'),
    ):
        with pytest.raises(ValidationError):
            wrong.to_move()


async def test_the_coordinator_asks_through_its_tool_and_the_board_refuses_every_other_agent(led: Lab) -> None:
    async with Client(join_server(lambda _: Member(led, 'ada'))) as client:
        said = await client.call_tool('post', {'kind': 'message', 'text': 'Two lines are alive.', 'conversation': True})
        asked = await client.call_tool('request', {'move': 'time', 'text': 'The depth run needs it.', 'minutes': 120})
        brief = await client.call_tool('brief', {})
        no_amount = await client.call_tool('request', {'move': 'time', 'text': 'No amount.'})
        seat = {'move': 'add_agent', 'text': 'One more.', 'harness': 'fake'}
        refused_fields = [
            await client.call_tool('request', seat | extra)
            for extra in ({'family': 'openai'}, {'mode': 'full-access'}, {'coordinator': True}, {'count': 2})
        ]
    async with Client(join_server(lambda _: Member(led, 'bo'))) as client:
        other = await client.call_tool('request', {'move': 'time', 'text': 'I want time.', 'minutes': 5})
        forged = await client.call_tool(
            'post',
            {'kind': 'message', 'text': 'The person says so.', 'thread': 't-1', 'for_person': True},
        )

    assert no_amount.is_error
    # The tool has no argument for what a move's seat never holds. Such an argument reaches no record.
    assert len(refused_fields) == 4
    moves = [entry.post.move for entry in led.board.posts if isinstance(entry.post, MoveRequest)]
    seats = [move.seat for move in moves if isinstance(move, AddMove)]
    assert seats == [AddSeat(harness='fake')] * 4
    assert 'minutes' in str(no_amount.content)
    assert 'Only the agent that holds the coordinator seat asks' in str(other.content)
    assert 'Only the agent that holds the coordinator seat marks' in str(forged.content)

    talk = led.board.conversation
    assert said.structured_content is not None
    assert asked.structured_content is not None
    assert brief.structured_content is not None
    assert said.structured_content['post']['thread'] == talk
    request = asked.structured_content
    assert (request['post']['kind'], request['post']['move'], request['waits'], request['decision']) == (
        'request',
        {'type': 'time', 'minutes': 120},
        True,
        None,
    )
    assert (brief.structured_content['conversation'], brief.structured_content['powers']) == (talk, [])
    posts = [entry.post for entry in led.board.posts if entry.post.thread == talk]
    assert [type(post) for post in posts] == [Message, *[MoveRequest] * 5]


class Host:
    """A stand-in for the process that runs the lab. It adds an agent to the record and starts nothing."""

    def __init__(self, lab: Lab) -> None:
        self.lab = lab

    async def add_seat(self, seat: AddSeat, first: tuple[Build, ...], asked_by: str) -> None:
        if seat.harness != 'fake':
            raise SetupRejected(f'Unknown harness {seat.harness}.')
        await self.lab.join(agent('dee'), first=first, given=(seat.role, asked_by) if seat.role else None)


async def test_the_person_reads_the_conversation_switches_powers_and_answers_requests(led: Lab) -> None:
    # The stand-in has only what these routes use.
    api = app_api(Host(led), Activity(), SecretStr('secret'))  # ty: ignore[invalid-argument-type]
    headers = {'Authorization': 'Bearer secret'}
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=api), base_url='http://lab', headers=headers
    ) as client:
        empty = (await client.get('/conversation')).json()
        said = await client.post('/posts', json={'kind': 'message', 'text': 'Where are we?', 'conversation': True})
        time = await led.request(MORE, 'The depth run needs it.', '', 'ada')
        seat = await led.request(AddMove(seat=AddSeat(harness='fake')), 'One more hand.', '', 'ada')
        wrong = await led.request(AddMove(seat=AddSeat(harness='nope')), 'Another harness.', '', 'ada')
        waiting = (await client.get('/conversation')).json()
        lab_view = (await client.get('/lab')).json()
        yes = await client.post(f'/requests/{time.post.id}', json={'yes': True, 'minutes': 45})
        added = await client.post(f'/requests/{seat.post.id}', json={'yes': True})
        refused = await client.post(f'/requests/{wrong.post.id}', json={'yes': True})
        no = await client.post(f'/requests/{wrong.post.id}', json={'yes': False})
        again = await client.post(f'/requests/{time.post.id}', json={'yes': True})
        on = (await client.post('/powers', json={'power': 'agents', 'on': True})).json()
        used = await led.request(RemoveMove(agent='bo'), 'Bo is done.', '', 'ada')
        back = await client.post(f'/requests/{time.post.id}/minutes')
        twice = await client.post(f'/requests/{time.post.id}/minutes')
        done = (await client.get('/conversation')).json()

    assert (empty['coordinator'], empty['thread'], empty['waits'], empty['deeds']) == ('ada', None, [], [])
    assert [power['on'] for power in empty['powers']] == [False] * 5
    assert said.status_code == 200
    assert waiting['waits'] == [time.post.id, seat.post.id, wrong.post.id]
    assert waiting['thread']['thread']['conversation'] is True
    assert lab_view['needs_you'] == 3
    assert [(wait['kind'], wait['what']) for wait in lab_view['waits']] == [
        ('approval', 'Asks for more time for the lab'),
        ('approval', 'Asks to add an agent'),
        ('approval', 'Asks to add an agent'),
    ]
    assert (yes.status_code, added.status_code, no.status_code) == (200, 200, 200)
    assert (refused.status_code, refused.json()['detail']) == (400, 'Unknown harness nope.')
    assert (again.status_code, again.json()['detail']) == (400, f'The request {time.post.id} has its answer already.')
    assert [(power['power'], power['on']) for power in on['powers'] if power['on']] == [('agents', True)]
    assert (back.status_code, twice.status_code) == (200, 400)
    assert done['waits'] == []
    deeds = [(deed['request']['post']['id'], deed['agent'], deed['undo']) for deed in done['deeds']]
    assert deeds == [(used.post.id, None, None), (seat.post.id, 'dee', 'remove_agent'), (time.post.id, None, None)]
    assert done['deeds'][0]['request']['decision']['by'] == 'ada'
    power = next(power for power in done['powers'] if power['power'] == 'agents')
    assert (power['on'], power['used'], power['since'] is not None) == (True, 1, True)


async def test_the_conversation_names_the_permission_requests_that_its_requests_decide(led: Lab) -> None:
    seq = led.board.seq
    deciding = asyncio.create_task(ask_the_person(Member(led, 'bo'), COMMAND))
    await led.wait_for_change(seq)
    ask = led.board.posts[-1].post
    await led.request(PermissionMove(ask=ask.id, option='once'), 'It only reads.', '', 'ada')
    api = app_api(Host(led), Activity(), SecretStr('secret'))  # ty: ignore[invalid-argument-type]
    headers = {'Authorization': 'Bearer secret'}
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=api), base_url='http://lab', headers=headers
    ) as client:
        view = (await client.get('/conversation')).json()

    assert [item['post']['id'] for item in view['asks']] == [ask.id]
    # Another agent's ask to the person in the conversation waits on the Needs you page, and not in the panel.
    other = await led.post(
        PostRequest(kind='ask', text='Switch on every power?', conversation=True, mentions=('person',)), 'bo'
    )
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=api), base_url='http://lab', headers=headers
    ) as client:
        panel = (await client.get('/conversation')).json()
        needs = (await client.get('/needs')).json()
    assert other.post.id not in panel['waits']
    assert other.post.id in [item['post']['id'] for item in needs]
    assert view['asks'][0]['post']['shown']['command'] == './gpu train | tail'
    deciding.cancel()
