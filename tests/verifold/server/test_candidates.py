from builders import RecordBuilder
from mcp import Client

from verifold.protocol.join import Brief
from verifold.protocol.posts import Answer, Close, Proposal
from verifold.protocol.threads import QUESTION_TITLE
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.lifecycle import lab_state
from verifold.society.views import candidates_view
from verifold.store.record_file import RecordFile


async def test_a_close_names_a_candidate_that_stands_while_one_stands(lab: Lab) -> None:
    ada, bo = Member(lab, 'ada'), Member(lab, 'bo')
    done = {'kind': 'close', 'text': 'The lab is done.', 'thread': 't-1'}
    async with Client(join_server(lambda _: bo)) as client:
        await client.call_tool('post', {'kind': 'proposal', 'text': 'Yes, it beats random.', 'thread': 't-1'})
    async with Client(join_server(lambda _: ada)) as client:
        unnamed = await client.call_tool('post', done)
        result = await client.call_tool('post', done | {'candidate': 'p-1'})
        message = await client.call_tool(
            'post', {'kind': 'message', 'text': 'Hi.', 'thread': 't-1', 'candidate': 'p-2'}
        )
        named = await client.call_tool('post', done | {'candidate': 'p-2'})
        brief = Brief.model_validate((await client.call_tool('brief', {})).structured_content)

    assert 'A close names the candidate that it closes on, in `candidate`. The candidates that stand: p-2.' in str(
        unnamed.content
    )
    assert 'Post p-1 is no candidate answer that stands.' in str(result.content)
    assert message.is_error
    assert 'candidate' in str(message.content)
    assert named.structured_content is not None
    assert named.structured_content['post']['candidate'] == 'p-2'
    assert (brief.close and brief.close.id, brief.closes_on) == ('p-3', 'p-2')
    assert [line.line.id for line in brief.candidates] == ['p-2']


async def test_a_close_names_no_candidate_while_none_stands(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        closed = await client.call_tool('post', {'kind': 'close', 'text': 'Nothing is left.', 'thread': 't-1'})

    assert closed.structured_content is not None
    assert closed.structured_content['post'].get('candidate') is None
    assert candidates_view(lab.board).closes_on is None


def test_a_record_from_before_with_several_proposals_and_a_close_loads_with_the_same_answer(
    record_file: RecordFile,
) -> None:
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE).join('ada').join('bo')
    record.post(Proposal(id='p-1', thread='t-1', author='ada', text='Yes, 12x.'))
    record.post(Proposal(id='p-2', thread='t-1', author='bo', text='No: 3x at most.'))
    record.post(Proposal(id='p-3', thread='t-1', author='ada', text='Yes, 11x.'))
    record.post(Close(id='p-4', thread='t-1', author='bo', text='It holds.'))
    record.post(Answer(id='p-5', thread='t-1', author='ada', text='Agreed.', reply_to='p-4', accepts=True))
    record_file.append(*record.events)

    loaded = Lab.load(record_file)
    view = candidates_view(loaded.board)

    # The lab showed the newest proposal as its answer, and its close closes on that one.
    assert lab_state(loaded.board) == 'closed'
    assert view.closes_on is not None
    assert view.closes_on.candidate.post.id == 'p-3'
    assert [other.candidate.post.id for other in view.standing] == ['p-2', 'p-3']
