import pytest
from builders import RecordBuilder, lab

from verifold.protocol.posts import Answer, Check, Message, Objection, Post, Result
from verifold.society.errors import RejectedEvent

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Beats random on 10 of 10 prompts.')
OBJECTION = Objection(id='p-2', thread='t-1', author='bo', text='The layer saw the test prompts.', reply_to='p-1')


def rejected(record: RecordBuilder, *posts: Post) -> str:
    for post in posts:
        record.post(post)
    with pytest.raises(RejectedEvent) as error:
        record.board()
    return str(error.value)


def test_a_conversation_across_agents_fits_the_record(record: RecordBuilder) -> None:
    record.post(RESULT).post(OBJECTION)
    record.post(
        Answer(
            id='p-3', thread='t-1', author='ada', text='Right. Held-out prompts added.', reply_to='p-2', accepts=True
        )
    )
    record.post(Message(id='p-4', thread='t-1', author='person', text='Try the 5090s.', mentions=('ada',)))

    assert record.board().seq == len(record.events)


@pytest.mark.parametrize(
    ('agent_id', 'recruiter', 'reason'),
    [('ada', None, 'ada is taken'), ('person', None, 'person is taken'), ('dee', 'zed', 'zed is not an agent')],
)
def test_agents_join_once_with_known_recruiters(agent_id: str, recruiter: str | None, reason: str) -> None:
    with pytest.raises(RejectedEvent, match=reason):
        lab().join(agent_id, recruited_by=recruiter).board()


@pytest.mark.parametrize('recruiter', ['ada', 'person'])
def test_agents_and_the_person_can_recruit_peers(recruiter: str) -> None:
    assert lab().join('dee', recruited_by=recruiter).board().agent('dee') is not None


def test_threads_open_once_by_members() -> None:
    with pytest.raises(RejectedEvent, match='exists already'):
        lab().thread('t-1', opened_by='bo').board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        lab().thread('t-2', opened_by='zed').board()


def test_a_post_needs_a_new_id_a_member_and_a_thread() -> None:
    assert 'exists already' in rejected(lab(), RESULT, RESULT)
    assert 'zed is not an agent' in rejected(lab(), RESULT.model_copy(update={'author': 'zed'}))
    assert 'zed is not an agent' in rejected(lab(), RESULT.model_copy(update={'mentions': ('zed',)}))
    assert 'Open a thread first' in rejected(lab(), RESULT.model_copy(update={'thread': 't-2'}))


def test_a_post_builds_only_on_posts_that_exist_in_any_thread() -> None:
    built = Result(id='p-2', thread='t-2', author='bo', text='Also on large models.', builds_on=('p-1',))
    record = lab().thread('t-2', opened_by='bo').post(RESULT)

    assert record.post(built).board().built_on('p-1')[0].post.id == 'p-2'
    assert 'p-9 does not exist, so no post can build on it' in rejected(
        lab().thread('t-2', opened_by='bo'), RESULT, built.model_copy(update={'builds_on': ('p-1', 'p-9')})
    )


def test_a_reply_needs_an_existing_target_in_the_same_thread() -> None:
    reply = Message(id='p-2', thread='t-2', author='bo', text='Re', reply_to='p-1')

    assert 'p-9 does not exist' in rejected(
        lab(), RESULT, reply.model_copy(update={'thread': 't-1', 'reply_to': 'p-9'})
    )
    assert 'Reply in that thread' in rejected(lab().thread('t-2', opened_by='bo'), RESULT, reply)


@pytest.mark.parametrize(
    'reply',
    [
        OBJECTION.model_copy(update={'author': 'ada'}),
        Check(
            id='p-2', thread='t-1', author='ada', text='Reran mine.', reply_to='p-1', outcome='holds', method='rerun'
        ),
    ],
)
def test_nobody_objects_to_or_checks_their_own_post(reply: Post) -> None:
    assert 'is your own' in rejected(lab(), RESULT, reply)


def test_only_the_objected_author_accepts_an_objection() -> None:
    accept = Answer(id='p-3', thread='t-1', author='cy', text='Agreed.', reply_to='p-2', accepts=True)

    assert 'Only ada' in rejected(lab(), RESULT, OBJECTION, accept)
    assert 'answer to an objection' in rejected(
        lab(), RESULT, OBJECTION, accept.model_copy(update={'reply_to': 'p-1', 'author': 'bo'})
    )
