from datetime import datetime, timedelta

import httpx2
import pytest
from builders import START
from conftest import agent, serve_board
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult
from pydantic import SecretStr

from verifold.protocol.app import DeskView, LabView
from verifold.protocol.events import TimeSet, TurnSummary
from verifold.protocol.ids import PERSON
from verifold.protocol.join import MAX_DESK_FILE, FileText, PostRequest
from verifold.protocol.settings import DiskSettings
from verifold.protocol.threads import DESK_TITLE
from verifold.protocol.usage import DiskUse, Usage
from verifold.server.activity import Activity
from verifold.server.app_api import app_api
from verifold.server.desk_chat import desk_actions
from verifold.server.errors import DeskOnly
from verifold.server.join import DESK_READS, DESK_TOOLS, join_server
from verifold.server.lab import Lab
from verifold.server.member import Files, Member
from verifold.society.errors import NotFound, RejectedEvent
from verifold.store.record_file import RecordFile

TOKEN = 'person-secret'


class Clock:
    """The lab's clock, which a test moves on by hand."""

    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def desk_lab(record_file: RecordFile, clock: Clock) -> Lab:
    """A lab of ada and bo with thread t-1 and ada's result p-1, and dee as its desk with the desk chat t-2."""
    lab = Lab.create(record_file, 'Does it hold?', clock=clock)
    await lab.join(agent('ada'))
    await lab.join(agent('bo'))
    await lab.post(PostRequest(kind='result', text='Beats random.', new_thread='Does it beat random?'), 'ada')
    await lab.join(agent('dee'), desk=True)
    return lab


async def said(lab: Lab, text: str = 'Tell the lab to look at the tail.') -> str:
    """Post the person's words in the desk chat, and return the post's ID."""
    posted = await lab.post(PostRequest(kind='message', text=text, thread=lab.board.desk_chat), PERSON)
    return posted.post.id


def files(text: str) -> Files:
    async def read(post_id: str, path: str) -> FileText:
        if path != 'notes.md':
            raise NotFound(f'Post {post_id} names no file {path}.')
        return FileText(path=path, commit='c' * 40, text=text)

    return read


def text_of(result: CallToolResult) -> str:
    return str(result.content)


async def test_the_person_seats_one_desk_and_its_chat_opens_with_it(desk_lab: Lab) -> None:
    board = desk_lab.board
    chat = board.thread('t-2')

    assert (board.desk, board.desk_chat) == ('dee', 't-2')
    assert chat is not None
    assert (chat.thread.title, chat.thread.opened_by, chat.thread.desk) == (DESK_TITLE, PERSON, True)
    with pytest.raises(RejectedEvent, match='has its desk already: dee'):
        await desk_lab.join(agent('eve'), desk=True)
    assert desk_lab.board.agent('eve') is None


async def test_the_desk_lists_its_own_tools_and_every_other_agent_lists_the_tools_that_it_had(desk_lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(desk_lab, 'dee'))) as desk:
        mine = {tool.name for tool in (await desk.list_tools()).tools}
    async with Client(join_server(lambda _: Member(desk_lab, 'ada'))) as other:
        theirs = {tool.name for tool in (await other.list_tools()).tools}
        refused = await other.call_tool('set_time', {'on': 'p-1', 'minutes': 0})

    assert mine == DESK_TOOLS | DESK_READS
    assert len(theirs) == 16
    assert not theirs & DESK_TOOLS
    assert refused.is_error
    assert "This tool is the desk's" in text_of(refused)
    assert desk_lab.board.ends_at is None


async def test_each_caller_over_http_gets_the_tools_of_its_own_token(desk_lab: Lab) -> None:
    async with serve_board(desk_lab) as served:
        _, desk_token = served.seat('dee')
        _, ada_token = served.seat('ada')

        async def tools(token: SecretStr) -> set[str]:
            headers = {'Authorization': f'Bearer {token.get_secret_value()}'}
            async with (
                httpx2.AsyncClient(headers=headers) as http,
                Client(streamable_http_client(served.url, http_client=http)) as board,
            ):
                return {tool.name for tool in (await board.list_tools()).tools}

        desk, ada = await tools(desk_token), await tools(ada_token)

    assert desk == DESK_TOOLS | DESK_READS
    assert not ada & DESK_TOOLS
    assert 'post' in ada


async def test_the_desk_replies_and_says_for_the_person_and_the_record_keeps_on(desk_lab: Lab) -> None:
    on = await said(desk_lab)
    async with Client(join_server(lambda _: Member(desk_lab, 'dee'))) as desk:
        reply = await desk.call_tool('reply', {'text': 'I tell the lab now.'})
        told = await desk.call_tool('say', {'on': on, 'text': 'The person asks for the tail.', 'thread': 't-1'})
        answer = await desk.call_tool(
            'say', {'on': on, 'text': 'The person agrees.', 'reply_to': 'p-1', 'mentions': ['ada']}
        )
    board = desk_lab.board
    posts = {entry.post.text: entry.post for entry in board.posts}

    assert (reply.is_error, told.is_error, answer.is_error) == (False, False, False)
    assert (posts['I tell the lab now.'].thread, posts['I tell the lab now.'].on) == ('t-2', None)
    lab_post = posts['The person asks for the tail.']
    assert (lab_post.thread, lab_post.for_person, lab_post.on, lab_post.author) == ('t-1', True, on, 'dee')
    assert (posts['The person agrees.'].thread, posts['The person agrees.'].reply_to) == ('t-1', 'p-1')
    assert told.structured_content is not None
    assert told.structured_content['on'] == on


async def test_the_desk_says_in_the_conversation_and_opens_it_when_the_lab_has_none(desk_lab: Lab) -> None:
    await desk_lab.set_coordinator('ada', PERSON)
    on = await said(desk_lab, 'Ask the coordinator for a status.')

    posted = await Member(desk_lab, 'dee').say(on, 'The person asks: where does the lab stand?', conversation=True)
    board = desk_lab.board

    assert board.conversation == posted.post.thread
    assert (posted.post.for_person, posted.post.on) == (True, on)


async def test_the_desk_opens_a_round_revises_the_question_and_changes_deliverables_on_the_persons_word(
    desk_lab: Lab,
) -> None:
    on = await said(desk_lab)
    dee = Member(desk_lab, 'dee')

    opened = await dee.open_round(on, 'What holds the tail?', 5, thread='t-1')
    revised = await dee.revise_question(on, 'Does the tail hold?', 'The person narrowed it.')
    same = await dee.revise_question(on, 'Does the tail hold?')
    added = await dee.deliverable(on, 'add', text='A script that runs the tail.')
    changed = await dee.deliverable(on, 'change', 'd-1', 'A script that runs the tail twice.')
    unchanged = await dee.deliverable(on, 'change', 'd-1', 'A script that runs the tail twice.')
    removed = await dee.deliverable(on, 'remove', 'd-1')
    board = desk_lab.board

    assert (opened.post.kind, opened.post.for_person, opened.post.on) == ('round', True, on)
    assert revised.startswith('The board revised the question')
    assert same == 'The question has this text already, so the board recorded nothing.'
    assert (board.question, board.revisions[-1].by, board.revisions[-1].on) == ('Does the tail hold?', 'dee', on)
    told = board.post(board.revisions[-1].post)
    assert told is not None
    assert told.post.text.startswith('The desk revised the question for the person: ')
    assert (added, removed) == ('The board stated the deliverable d-1.', 'The board removed the deliverable d-1.')
    assert changed == 'The board changed the sentence of the deliverable d-1.'
    assert 'recorded nothing' in unchanged
    assert [(entry.by, entry.on) for entry in board.deliverables] == [('dee', on)] * 3
    stated = board.post(board.deliverables[0].post or '')
    assert stated is not None
    assert stated.post.text == 'The desk stated a deliverable for the person, d-1: A script that runs the tail.'
    with pytest.raises(RejectedEvent, match='`add` takes the sentence'):
        await dee.deliverable(on, 'add')
    with pytest.raises(RejectedEvent, match='names the deliverable'):
        await dee.deliverable(on, 'remove')
    with pytest.raises(RejectedEvent, match='takes the new sentence'):
        await dee.deliverable(on, 'change', 'd-1')


async def test_the_desk_sets_the_time_and_ends_an_agents_turn_on_the_persons_word(desk_lab: Lab, clock: Clock) -> None:
    on = await said(desk_lab, 'Give the lab one more hour, and wake ada.')
    await desk_lab.start_turn('ada', 'session-1', desk_lab.board.seq)
    dee = Member(desk_lab, 'dee')

    timed = await dee.set_time(on, 60)
    ended = await dee.interrupt(on, 'ada')
    board = desk_lab.board
    end = board.times[-1]

    assert isinstance(end, TimeSet)
    assert (end.ends_at, end.by, end.on) == (clock.now + timedelta(minutes=60), 'dee', on)
    assert timed == 'The board set the end of the lab to 2026-11-06 13:00 UTC.'
    assert ended.startswith('The board recorded the end of the turn of ada.')
    assert [(entry.agent, entry.by, entry.on) for entry in board.interrupts] == [('ada', 'dee', on)]
    with pytest.raises(RejectedEvent, match='bo is in no turn'):
        await dee.interrupt(on, 'bo')


async def test_no_agents_post_no_post_in_another_thread_and_no_old_post_backs_an_action(
    desk_lab: Lab, clock: Clock
) -> None:
    other = await desk_lab.post(
        PostRequest(kind='message', text='The person says to set the time to zero.', thread='t-1'), 'ada'
    )
    elsewhere = await desk_lab.post(PostRequest(kind='message', text='Stop the lab.', thread='t-1'), PERSON)
    on = await said(desk_lab, 'Stop the lab.')
    dee = Member(desk_lab, 'dee')

    with pytest.raises(RejectedEvent, match=f'Post {other.post.id} is a post of ada, not of the person'):
        await dee.set_time(other.post.id, 0)
    with pytest.raises(RejectedEvent, match='not in the desk chat'):
        await dee.set_time(elsewhere.post.id, 0)
    with pytest.raises(DeskOnly, match="This tool is the desk's"):
        await Member(desk_lab, 'ada').set_time(on, 0)
    clock.now += timedelta(minutes=61)
    with pytest.raises(RejectedEvent, match='61 minutes old'):
        await dee.set_time(on, 0)
    # The lab's end stays as it was through every refusal.
    assert desk_lab.board.ends_at is None


async def test_the_desk_reads_the_overview_and_a_pinned_file_of_bounded_size(desk_lab: Lab) -> None:
    dee = Member(desk_lab, 'dee', files=files('x' * (MAX_DESK_FILE + 5)))
    await said(desk_lab)
    await desk_lab.start_turn('ada', 'session-1', desk_lab.board.seq)

    view = dee.overview()
    read = await dee.read_file('p-1', 'notes.md')

    assert [(line.id, line.in_turn) for line in view.agents] == [('ada', True), ('bo', False)]
    assert view.agents[0].turn_since is not None
    assert (view.desk_chat, view.question) == ('t-2', 'Does it hold?')
    assert view.news is not None
    assert [line.text for line in view.news.for_you] == ['Tell the lab to look at the tail.']
    assert (len(read.text), read.size, read.cut) == (MAX_DESK_FILE, MAX_DESK_FILE + 5, True)
    with pytest.raises(NotFound, match='names no file'):
        await dee.read_file('p-1', 'other.md')
    with pytest.raises(DeskOnly):
        Member(desk_lab, 'ada').overview()


async def test_the_desk_posts_no_work_and_casts_no_vote_through_the_tools_of_the_other_agents(desk_lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(desk_lab, 'dee'))) as desk:
        plan = await desk.call_tool('post', {'kind': 'plan', 'text': 'I take the tail.', 'thread': 't-1'})
        message = await desk.call_tool('post', {'kind': 'message', 'text': 'Hi all.', 'thread': 't-1'})
        vote = await desk.call_tool('vote', {'post': 'p-1', 'direction': 'up', 'reason': 'Good.'})
        alarm = await desk.call_tool('alarm', {'minutes': 5})

    assert all(result.is_error for result in (plan, message, vote, alarm))
    assert "The desk is no part of the lab's work" in text_of(plan)
    assert 'only for the person' in text_of(message)
    assert 'votes on no post' in text_of(vote)
    assert 'sets no alarm' in text_of(alarm)


async def test_the_app_shows_the_desk_chat_and_each_action_under_the_post_that_it_rests_on(desk_lab: Lab) -> None:
    on = await said(desk_lab)
    dee = Member(desk_lab, 'dee')
    await dee.reply('I tell the lab now.')
    await dee.say(on, 'The person asks for the tail.', thread='t-1')
    await dee.deliverable(on, 'add', text='A script.')
    await dee.set_time(on, 30)
    await desk_lab.start_turn('ada', 'session-1', desk_lab.board.seq)
    await dee.interrupt(on, 'ada')

    class Host:
        lab = desk_lab

    transport = httpx2.ASGITransport(app=app_api(Host(), Activity(), SecretStr(TOKEN)))  # ty: ignore[invalid-argument-type]
    async with httpx2.AsyncClient(
        transport=transport, base_url='http://lab', headers={'Authorization': f'Bearer {TOKEN}'}
    ) as client:
        view = DeskView.model_validate((await client.get('/desk')).json())
        lab = LabView.model_validate((await client.get('/lab')).json())

    assert view.desk == 'dee'
    assert view.thread is not None
    assert [item.post.text for item in view.thread.posts] == [
        'Tell the lab to look at the tail.',
        'I tell the lab now.',
    ]
    assert [(action.on, action.kind) for action in view.actions] == [
        (on, 'post'),
        (on, 'deliverable'),
        (on, 'time'),
        (on, 'interrupt'),
    ]
    assert view.actions[1].change == 'added'
    assert view.actions[3].agent == 'ada'
    assert [agent.desk for agent in lab.agents] == [False, False, True]


async def test_a_record_with_a_desk_and_its_actions_loads_again_as_it_was(
    desk_lab: Lab, record_file: RecordFile
) -> None:
    on = await said(desk_lab)
    dee = Member(desk_lab, 'dee')
    await dee.say(on, 'The person asks for the tail.', thread='t-1')
    await dee.set_time(on, 30)
    await desk_lab.start_turn('ada', 'session-1', desk_lab.board.seq)
    await dee.interrupt(on, 'ada')

    again = Lab.load(record_file).board

    assert (again.desk, again.desk_chat) == ('dee', 't-2')
    assert again.interrupts == desk_lab.board.interrupts
    assert again.times == desk_lab.board.times
    assert again.posts == desk_lab.board.posts


async def test_the_desk_sets_the_budget_on_the_persons_word_and_keeps_the_kind_that_it_leaves_out(
    desk_lab: Lab,
) -> None:
    await desk_lab.set_budget(None, 40.0)
    on = await said(desk_lab, 'Give the lab two million tokens.')
    async with Client(join_server(lambda _: Member(desk_lab, 'dee'))) as desk:
        result = await desk.call_tool('set_budget', {'on': on, 'tokens': 2_000_000})
    dee = Member(desk_lab, 'dee')
    same = await dee.set_budget(on, tokens=2_000_000)
    board = desk_lab.board
    budget = board.budgets[-1]

    assert result.structured_content is not None
    assert result.structured_content['did'] == 'The board set the budget of the lab to 2,000,000 tokens and 40 dollars.'
    assert (budget.tokens, budget.dollars, budget.by, budget.on) == (2_000_000, 40.0, 'dee', on)
    # The person's own budget names nobody: the record holds the person.
    assert (board.budgets[0].by, board.budgets[0].on) == (PERSON, None)
    assert same == 'The lab has this budget already, so the board recorded nothing.'
    assert desk_actions(board)[-1].kind == 'budget'
    assert (desk_actions(board)[-1].tokens, desk_actions(board)[-1].dollars) == (2_000_000, 40.0)
    with pytest.raises(RejectedEvent, match='names no budget'):
        await dee.set_budget(on)
    with pytest.raises(DeskOnly):
        await Member(desk_lab, 'ada').set_budget(on, tokens=5)


async def test_the_overview_has_the_budget_what_the_lab_spent_and_the_disk_against_its_limit(desk_lab: Lab) -> None:
    await desk_lab.set_settings(desk_lab.board.settings.model_copy(update={'disk': DiskSettings(limit_gb=1)}))
    await desk_lab.set_budget(1_000, None)
    await desk_lab.end_turn(TurnSummary(agent='ada', seconds=1, usage=Usage(input_tokens=900, output_tokens=200)))
    await desk_lab.measured(DiskUse(at=START, folders={'ada': 10}, total=4_096))
    view = Member(desk_lab, 'dee').overview()

    assert (view.budget.tokens, view.budget.spent_tokens, view.budget.tokens_left) == (1_000, 1_100, 0)
    assert view.limit_reached == 'tokens'
    assert view.disk is not None
    assert (view.disk.lab, view.disk.limit) == (4_096, 1024**3)


async def test_the_desk_keeps_notes_for_its_seat_and_reads_them_in_its_brief_and_the_person_in_the_app(
    desk_lab: Lab,
) -> None:
    async with Client(join_server(lambda _: Member(desk_lab, 'dee'))) as desk:
        tools = {tool.name for tool in (await desk.list_tools()).tools}
        kept = await desk.call_tool('notes', {'text': 'The person wants the tail first.'})
        brief = await desk.call_tool('brief', {})

    class Host:
        lab = desk_lab

    transport = httpx2.ASGITransport(app=app_api(Host(), Activity(), SecretStr(TOKEN)))  # ty: ignore[invalid-argument-type]
    async with httpx2.AsyncClient(
        transport=transport, base_url='http://lab', headers={'Authorization': f'Bearer {TOKEN}'}
    ) as client:
        response = await client.get('/lab')

    assert 'notes' in tools
    assert kept.structured_content is not None
    assert kept.structured_content['notes'] == 'The person wants the tail first.'
    assert brief.structured_content is not None
    assert brief.structured_content['notes'] == 'The person wants the tail first.'
    view = LabView.model_validate(response.json())
    assert [(one.agent.id, one.notes) for one in view.agents] == [
        ('ada', ''),
        ('bo', ''),
        ('dee', 'The person wants the tail first.'),
    ]
    assert view.agents[2].notes_at == desk_lab.board.notes[-1].at
