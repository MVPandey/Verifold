import pytest
from builders import RecordBuilder

from verifold.protocol.posts import Ask, Check, Message, Objection, Result
from verifold.society.errors import NotFound
from verifold.society.views import thread_summaries, thread_view


def test_a_thread_view_shows_each_post_and_where_it_stands(record: RecordBuilder) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='Beats random.'))
    record.post(Objection(id='p-2', thread='t-1', author='bo', text='Leak.', reply_to='p-1'))

    view = thread_view(record.board(), 'bo', 't-1')

    assert [(item.post.id, item.standing) for item in view.posts] == [('p-1', 'disputed'), ('p-2', 'open')]
    assert not view.watching


def test_an_unknown_thread_is_not_found(record: RecordBuilder) -> None:
    with pytest.raises(NotFound, match='t-9'):
        thread_view(record.board(), 'ada', 't-9')


def test_summaries_put_the_most_recent_activity_first(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='bo').post(Message(id='p-1', thread='t-1', author='ada', text='Later.'))
    record.thread('t-3', opened_by='cy')

    summaries = thread_summaries(record.board(), 'ada')

    assert [(summary.thread.id, summary.posts, summary.watching) for summary in summaries] == [
        ('t-3', 0, False),
        ('t-1', 1, True),
        ('t-2', 0, False),
    ]


def test_a_summary_shows_the_latest_post_and_how_results_and_asks_stand(record: RecordBuilder) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='Beats random.'))
    record.post(Result(id='p-2', thread='t-1', author='ada', text='Beats sorted.'))
    record.post(Result(id='p-3', thread='t-1', author='ada', text='Beats reversed.'))
    record.post(Objection(id='p-4', thread='t-1', author='bo', text='Leak.', reply_to='p-1'))
    record.post(
        Check(id='p-5', thread='t-1', author='cy', text='Holds.', reply_to='p-2', outcome='holds', method='rerun')
    )
    record.post(Ask(id='p-6', thread='t-1', author='bo', text='Which seed?', choices=('1', '2')))

    (summary,) = thread_summaries(record.board(), 'person')

    assert summary.latest is not None
    assert (summary.latest.author, summary.latest.kind, summary.latest.text) == ('bo', 'ask', 'Which seed?')
    assert (summary.disputed, summary.checked, summary.not_checked, summary.open_asks) == (1, 1, 1, 1)
