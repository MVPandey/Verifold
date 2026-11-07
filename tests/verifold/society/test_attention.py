from datetime import timedelta

import pytest
from builders import RecordBuilder, lab

from verifold.protocol.posts import Message, Objection, Post, Result
from verifold.society.attention import update, wakes, watches_thread
from verifold.society.errors import RejectedEvent

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Beats random on 10 of 10 prompts.')


def woken(record: RecordBuilder, post: Post) -> set[str]:
    board = record.post(post).board()
    entry = board.posts[-1]
    return {joined.agent.id for joined in board.agents if wakes(board, joined.agent.id, entry)}


def test_an_agent_watches_the_threads_it_opens(record: RecordBuilder) -> None:
    board = record.board()

    assert watches_thread(board, 'ada', 't-1')
    assert not watches_thread(board, 'bo', 't-1')


def test_watches_change_with_watch_events(record: RecordBuilder) -> None:
    board = record.watch('bo', 't-1').watch('ada', 't-1', watching=False).board()

    assert watches_thread(board, 'bo', 't-1')
    assert not watches_thread(board, 'ada', 't-1')


def test_a_watch_needs_an_agent_and_a_thread() -> None:
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        lab().watch('zed', 't-1').board()
    with pytest.raises(RejectedEvent, match='t-9 does not exist'):
        lab().watch('bo', 't-9').board()


def test_a_post_wakes_the_thread_watchers_but_not_its_author(record: RecordBuilder) -> None:
    assert woken(record.watch('cy', 't-1'), Message(id='p-1', thread='t-1', author='bo', text='Starting.')) == {
        'ada',
        'cy',
    }
    assert woken(lab(), RESULT) == set()


def test_mentions_and_replies_wake_their_agents(record: RecordBuilder) -> None:
    record.post(RESULT)

    assert woken(record, Objection(id='p-2', thread='t-1', author='bo', text='Leak.', reply_to='p-1')) == {'ada'}
    assert woken(lab(), Message(id='p-1', thread='t-1', author='ada', text='Over to you.', mentions=('cy',))) == {'cy'}


def test_the_persons_words_reach_watchers_or_everyone(record: RecordBuilder) -> None:
    to_watchers = Message(id='p-1', thread='t-1', author='person', text='Try the 5090s.')
    to_everyone = lab().thread('t-2', opened_by='person')

    assert woken(record, to_watchers) == {'ada'}
    assert woken(to_everyone, to_watchers.model_copy(update={'thread': 't-2'})) == {'ada', 'bo', 'cy'}
    assert woken(lab(), to_watchers.model_copy(update={'mentions': ('bo',)})) == {'bo', 'ada'}


def test_an_update_holds_the_agents_posts_and_summarizes_the_rest(record: RecordBuilder) -> None:
    seen = record.board().seq
    record.join('dee').thread('t-2', opened_by='cy')
    record.post(Message(id='p-1', thread='t-2', author='cy', text='New idea.'))
    record.post(Message(id='p-2', thread='t-1', author='cy', text='Using your baseline.', mentions=('bo',)))
    record.post(Message(id='p-3', thread='t-1', author='bo', text='Thanks.'))

    news = update(record.board(), 'bo', after=seen)

    assert news.seq == record.board().seq
    assert [entry.post.id for entry in news.posts] == ['p-2']
    assert [thread.id for thread in news.threads] == ['t-2']
    assert [agent.id for agent in news.agents] == ['dee']
    assert news.other_posts == 1


def test_an_update_says_when_the_lab_ends(record: RecordBuilder) -> None:
    ends_at = record.at(6) + timedelta(hours=1)

    assert update(record.board(), 'bo', after=0).ends_at is None
    assert update(record.time_set(ends_at).board(), 'bo', after=0).ends_at == ends_at
