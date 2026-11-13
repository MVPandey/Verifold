import pytest
from builders import RecordBuilder

from verifold.protocol.join import MAX_NEWS, News, ThreadLink
from verifold.protocol.posts import Answer, Ask, Check, Message, Objection, Plan, Report, Result
from verifold.protocol.threads import QUESTION_TITLE
from verifold.society.errors import NotFound
from verifold.society.views import (
    brief,
    crossings,
    latest_report,
    needs_person,
    question_thread,
    thread_summaries,
    thread_view,
)


def test_a_thread_view_shows_each_post_and_where_it_stands(record: RecordBuilder) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='Beats random.'))
    record.post(Objection(id='p-2', thread='t-1', author='bo', text='Leak.', reply_to='p-1'))

    view = thread_view(record.board(), 'bo', 't-1')

    assert [(item.post.id, item.standing) for item in view.posts] == [('p-1', 'disputed'), ('p-2', 'open')]
    assert view.watching
    assert not thread_view(record.board(), 'cy', 't-1').watching


def test_a_post_view_lists_the_posts_that_build_on_it_from_any_thread(record: RecordBuilder) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='Beats random.'))
    record.thread('t-2', opened_by='bo')
    record.post(Result(id='p-2', thread='t-2', author='bo', text='Also on large models.', builds_on=('p-1',)))
    record.post(Message(id='p-3', thread='t-1', author='cy', text='I reuse both.', builds_on=('p-1', 'p-2')))

    first, last = thread_view(record.board(), 'ada', 't-1').posts
    assert (first.built_on_by, last.built_on_by) == (('p-2', 'p-3'), ())
    assert thread_view(record.board(), 'ada', 't-2').posts[0].built_on_by == ('p-3',)


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


def test_an_ask_to_the_person_waits_for_the_persons_answer_not_an_agents(record: RecordBuilder) -> None:
    record.post(Ask(id='p-1', thread='t-1', author='bo', text='May I install it?', mentions=('person',)))
    record.post(Answer(id='p-2', thread='t-1', author='ada', text='Sure.', reply_to='p-1'))

    assert [view.post.id for view in needs_person(record.board())] == ['p-1']

    record.post(Answer(id='p-3', thread='t-1', author='person', text='Yes.', reply_to='p-1'))
    assert needs_person(record.board()) == ()


def test_a_brief_shows_each_other_agents_plan_and_the_results_that_nobody_checked(record: RecordBuilder) -> None:
    record.post(Plan(id='p-1', thread='t-1', author='bo', text='I take the small models.'))
    record.post(Plan(id='p-2', thread='t-1', author='bo', text='I take the large models instead.'))
    record.post(Result(id='p-3', thread='t-1', author='bo', text='Large models hold.'))
    record.post(Result(id='p-4', thread='t-1', author='cy', text='Small models hold.'))
    record.post(
        Check(id='p-5', thread='t-1', author='ada', text='So.', reply_to='p-4', outcome='holds', method='rerun')
    )
    record.post(Result(id='p-6', thread='t-1', author='ada', text='Mine.'))
    record.join('dee', family='openai', checks='p-3')

    view = brief(record.board(), 'ada', News(seq=0), how='How the board works.')

    assert (view.you, view.how, view.ends_at) == ('ada', 'How the board works.', None)
    assert [(line.id, line.name, line.harness) for line in view.agents] == [('bo', 'Bo', 'fake'), ('cy', 'Cy', 'fake')]
    bo, cy = view.agents
    assert bo.plan is not None
    assert bo.latest is not None
    assert (bo.plan.id, bo.plan.text, bo.latest.id) == ('p-2', 'I take the large models instead.', 'p-3')
    assert (cy.plan, cy.latest and cy.latest.id) == (None, 'p-4')
    assert [line.id for line in view.not_checked] == ['p-3']
    assert view.disputed == ()
    assert ([summary.thread.id for summary in view.threads], view.more_threads) == (['t-1'], 0)


def test_a_brief_lists_the_asks_from_others_that_nobody_answered_but_not_the_ones_for_the_person_alone(
    record: RecordBuilder,
) -> None:
    record.post(Ask(id='p-1', thread='t-1', author='bo', text='The probe stays at chance. What am I missing?'))
    record.post(Ask(id='p-2', thread='t-1', author='cy', text='Rent a GPU?', mentions=('person',)))
    record.post(Ask(id='p-3', thread='t-1', author='cy', text='Which tokenizer?', mentions=('person', 'ada')))
    record.post(Ask(id='p-4', thread='t-1', author='ada', text='Who has the baseline?'))
    record.post(Ask(id='p-5', thread='t-1', author='cy', text='Which layer?'))
    record.post(Answer(id='p-6', thread='t-1', author='bo', text='Layer 6.', reply_to='p-5'))

    assert [line.id for line in brief(record.board(), 'ada', News(seq=0)).open_asks] == ['p-1', 'p-3']
    assert [line.id for line in brief(record.board(), 'bo', News(seq=0)).open_asks] == ['p-3', 'p-4']


def test_a_brief_lists_the_disputed_posts_the_agents_own_among_them(record: RecordBuilder) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='Beats random.'))
    record.post(Objection(id='p-2', thread='t-1', author='bo', text='Leak.', reply_to='p-1'))
    record.post(Result(id='p-3', thread='t-1', author='cy', text='Beats sorted.'))
    record.post(Check(id='p-4', thread='t-1', author='bo', text='No.', reply_to='p-3', outcome='fails', method='rerun'))

    view = brief(record.board(), 'ada', News(seq=0))

    assert [(line.id, line.author) for line in view.disputed] == [('p-1', 'ada'), ('p-3', 'cy')]
    assert view.not_checked == ()


def test_a_brief_lists_the_newest_threads_and_counts_the_rest(record: RecordBuilder) -> None:
    for number in range(2, MAX_NEWS + 3):
        record.thread(f't-{number}', opened_by='bo')

    view = brief(record.board(), 'cy', News(seq=0))

    assert [summary.thread.id for summary in view.threads][:2] == [f't-{MAX_NEWS + 2}', f't-{MAX_NEWS + 1}']
    assert (len(view.threads), view.more_threads) == (MAX_NEWS, 2)
    assert view.agents[0].latest is None


def test_a_brief_shows_an_agents_latest_post_only_when_it_is_not_its_plan(record: RecordBuilder) -> None:
    record.post(Plan(id='p-1', thread='t-1', author='bo', text='I take the small models.'))

    (bo, _) = brief(record.board(), 'ada', News(seq=0)).agents

    assert bo.plan is not None
    assert (bo.plan.id, bo.latest) == ('p-1', None)


def test_the_question_thread_is_the_first_thread_when_the_person_opened_it_as_the_question() -> None:
    def first_thread(opened_by: str, title: str) -> RecordBuilder:
        return RecordBuilder().join('ada').thread('t-1', opened_by=opened_by, title=title)

    assert question_thread(first_thread('person', QUESTION_TITLE).board()) == 't-1'
    assert question_thread(first_thread('person', 'Try the 5090s').board()) is None
    assert question_thread(first_thread('ada', QUESTION_TITLE).board()) is None
    assert question_thread(RecordBuilder().board()) is None


def test_the_latest_report_is_the_newest_one_in_any_thread(record: RecordBuilder) -> None:
    assert latest_report(record.board()) is None

    record.post(Report(id='p-1', thread='t-1', author='bo', text='Two designs are in training.'))
    record.post(Result(id='p-2', thread='t-1', author='ada', text='Loss 0.39.'))
    record.post(Report(id='p-3', thread='t-1', author='ada', text='The curved design leads.', body='Three seeds.'))
    record.post(Report(id='p-4', thread='t-1', author='person', text='My own note.'))

    latest = latest_report(record.board())

    assert latest is not None
    assert (latest.post.id, latest.post.text, latest.post.body) == ('p-3', 'The curved design leads.', 'Three seeds.')


def test_a_summary_shows_where_ideas_crossed_between_agents_and_threads(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='ada').thread('t-3', opened_by='bo')
    record.post(Result(id='p-1', thread='t-2', author='ada', text='Curves help.'))
    record.post(Message(id='p-2', thread='t-2', author='cy', text='A paper on curves.'))
    # Two posts of other agents in t-3 build on t-2. Ada's own post there and a link inside t-2 are no crossing.
    # Naming a post twice counts once, and a link to the person's post is no crossing.
    record.post(Message(id='p-9', thread='t-1', author='person', text='Look at curves.'))
    record.post(Plan(id='p-3', thread='t-3', author='bo', text='Try curves.', builds_on=('p-1', 'p-2', 'p-1', 'p-9')))
    record.post(Result(id='p-4', thread='t-3', author='ada', text='Also here.', builds_on=('p-1',)))
    record.post(Message(id='p-5', thread='t-2', author='bo', text='Agreed.', builds_on=('p-1',)))

    board = record.board()
    by_id = {summary.thread.id: summary for summary in thread_summaries(board, 'person')}

    assert [(source.post.id, built.post.id) for source, built in crossings(board)] == [('p-1', 'p-3'), ('p-2', 'p-3')]
    assert by_id['t-3'].builds_on_threads == (ThreadLink(thread='t-2', agents=('ada', 'cy'), count=2),)
    assert by_id['t-2'].built_on_by_threads == (ThreadLink(thread='t-3', agents=('bo',), count=2),)
    assert (by_id['t-2'].builds_on_threads, by_id['t-3'].built_on_by_threads, by_id['t-1'].crossed) == ((), (), 0)
    assert (by_id['t-3'].crossed, by_id['t-2'].crossed) == (2, 0)
