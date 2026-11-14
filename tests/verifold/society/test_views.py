import pytest
from builders import RecordBuilder

from verifold.protocol.join import MAX_NEWS, News, ThreadLink
from verifold.protocol.posts import (
    Answer,
    Ask,
    Call,
    Check,
    FileEvidence,
    Message,
    Objection,
    Plan,
    Proposal,
    Report,
    Result,
    RuledOut,
)
from verifold.protocol.threads import QUESTION_TITLE
from verifold.society.errors import NotFound
from verifold.society.standing import is_open_call, takers
from verifold.society.views import (
    answer_view,
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
    # An objection is no work in the thread, so its author does not watch it. The agent that opened it does.
    assert not view.watching
    assert thread_view(record.board(), 'ada', 't-1').watching


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
    # A report names its sources and builds nothing on them.
    record.post(Report(id='p-6', thread='t-1', author='cy', text='Curves help.', builds_on=('p-1', 'p-3')))

    board = record.board()
    by_id = {summary.thread.id: summary for summary in thread_summaries(board, 'person')}

    assert [(source.post.id, built.post.id) for source, built in crossings(board)] == [('p-1', 'p-3'), ('p-2', 'p-3')]
    assert by_id['t-3'].builds_on_threads == (ThreadLink(thread='t-2', agents=('ada', 'cy'), count=2),)
    assert by_id['t-2'].built_on_by_threads == (ThreadLink(thread='t-3', agents=('bo',), count=2),)
    assert (by_id['t-2'].builds_on_threads, by_id['t-3'].built_on_by_threads, by_id['t-1'].crossed) == ((), (), 0)
    assert (by_id['t-3'].crossed, by_id['t-2'].crossed) == (2, 0)


def test_a_call_stays_open_until_another_agent_takes_it_with_a_plan(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='ada')
    record.post(Call(id='p-1', thread='t-2', author='ada', text='Who builds the long shot?'))
    record.post(Message(id='p-2', thread='t-2', author='bo', text='Sounds hard.', reply_to='p-1'))
    record.post(Plan(id='p-3', thread='t-2', author='ada', text='I could.', reply_to='p-1'))
    open_board = record.board()

    record.post(Plan(id='p-4', thread='t-2', author='cy', text='I take it.', reply_to='p-1'))
    taken = record.board()

    # A note and the caller's own plan take nothing.
    assert takers(open_board, 'p-1') == ()
    assert [line.id for line in brief(open_board, 'bo', News(seq=0)).open_calls] == ['p-1']
    assert brief(open_board, 'ada', News(seq=0)).open_calls == ()
    assert takers(taken, 'p-1') == ('cy',)
    assert brief(taken, 'bo', News(seq=0)).open_calls == ()
    summaries = {summary.thread.id: summary for summary in thread_summaries(taken, 'person')}
    assert (summaries['t-2'].open_calls, thread_summaries(open_board, 'person')[0].open_calls) == (0, 1)


def test_a_threads_team_is_who_works_in_it_now() -> None:
    record = RecordBuilder().join('ada').join('bo').join('cy').join('di')
    record.thread('t-1', opened_by='person', title=QUESTION_TITLE).thread('t-2', opened_by='ada')
    record.thread('t-3', opened_by='bo').thread('t-4', opened_by='person')
    record.post(Plan(id='p-1', thread='t-1', author='bo', text='I read first.'))
    record.post(Message(id='p-2', thread='t-2', author='bo', text='A note.'))
    record.post(Plan(id='p-3', thread='t-2', author='cy', text='I join.'))
    record.post(Result(id='p-4', thread='t-2', author='di', text='It holds.'))
    before = {summary.thread.id: summary.team for summary in thread_summaries(record.board(), 'person')}

    record.post(Plan(id='p-5', thread='t-3', author='cy', text='I move to the other line.'))
    record.post(Plan(id='p-6', thread='t-3', author='ada', text='So do I.'))
    after = {summary.thread.id: summary.team for summary in thread_summaries(record.board(), 'person')}

    # A note joins no team, a plan in the question's thread moves nobody, and the person is in no team.
    assert before == {'t-1': (), 't-2': ('ada', 'cy', 'di'), 't-3': ('bo',), 't-4': ()}
    # An agent is in the team of the thread where it planned last, also the agent that opened another thread.
    assert after == {'t-1': (), 't-2': ('di',), 't-3': ('ada', 'bo', 'cy'), 't-4': ()}


def test_an_agent_that_opens_a_thread_with_a_call_is_not_in_its_team(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='ada')
    record.post(Call(id='p-1', thread='t-2', author='ada', text='Nobody builds the long shot.'))
    record.post(Plan(id='p-2', thread='t-2', author='cy', text='I take it.', reply_to='p-1'))

    summaries = {summary.thread.id: summary for summary in thread_summaries(record.board(), 'person')}

    assert summaries['t-2'].team == ('cy',)


def test_the_caller_withdraws_a_call_with_a_ruled_out_lead_and_the_person_takes_none(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='ada')
    record.post(Call(id='p-1', thread='t-2', author='ada', text='Who extends this?'))
    record.post(Plan(id='p-2', thread='t-2', author='person', text='I will.', reply_to='p-1'))
    record.post(RuledOut(id='p-3', thread='t-2', author='bo', text='Not worth it.', reply_to='p-1'))
    still_open = record.board()

    record.post(RuledOut(id='p-4', thread='t-2', author='ada', text='I did it myself.', reply_to='p-1'))
    withdrawn = record.board()

    assert (takers(still_open, 'p-1'), is_open_call(still_open, 'p-1')) == ((), True)
    assert (is_open_call(withdrawn, 'p-1'), brief(withdrawn, 'cy', News(seq=0)).open_calls) == (False, ())
    assert thread_summaries(withdrawn, 'person')[0].open_calls == 0


def test_a_brief_lists_where_an_agents_work_is_of_use_before_what_to_check(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='ada').thread('t-3', opened_by='bo').thread('t-4', opened_by='cy')
    record.post(Result(id='p-1', thread='t-2', author='ada', text='Curves help.'))
    record.post(Result(id='p-2', thread='t-3', author='bo', text='Planes lose.'))
    record.post(Plan(id='p-3', thread='t-3', author='cy', text='I join bo.', builds_on=('p-2',)))
    record.post(Result(id='p-4', thread='t-2', author='ada', text='More seeds.', builds_on=('p-1',)))
    record.post(Message(id='p-5', thread='t-4', author='cy', text='A note.'))

    seen = brief(record.board(), 'cy', News(seq=0))

    # Ada works alone in t-2. Bo has cy in t-3, and t-4 holds only a note, so nobody works there.
    assert [(line.id, line.team) for line in seen.one_agent_threads] == [('t-2', ('ada',))]
    # Ada went on from p-1 herself, so only the newest result of her chain waits. Cy built on p-2.
    assert [line.id for line in seen.not_built_on] == ['p-4']
    assert brief(record.board(), 'ada', News(seq=0)).one_agent_threads == ()
    fields = list(type(seen).model_fields)
    assert fields.index('open_calls') < fields.index('one_agent_threads') < fields.index('not_built_on')
    assert fields.index('not_built_on') < fields.index('open_asks') < fields.index('not_checked')


def test_a_report_a_check_and_the_person_build_nothing_and_a_disputed_result_is_not_work_to_build_on(
    record: RecordBuilder,
) -> None:
    record.thread('t-2', opened_by='ada')
    record.post(Result(id='p-1', thread='t-2', author='ada', text='Curves help.'))
    record.post(Report(id='p-2', thread='t-1', author='bo', text='Curves help.', builds_on=('p-1',)))
    record.post(Message(id='p-3', thread='t-1', author='person', text='Nice.', builds_on=('p-1',)))
    record.post(
        Check(
            id='p-4',
            thread='t-2',
            author='bo',
            text='Holds.',
            reply_to='p-1',
            outcome='holds',
            method='code_read',
            builds_on=('p-1',),
        )
    )
    named = record.board()
    record.post(Objection(id='p-5', thread='t-2', author='cy', text='Leak.', reply_to='p-1'))

    assert [line.id for line in brief(named, 'cy', News(seq=0)).not_built_on] == ['p-1']
    assert brief(record.board(), 'bo', News(seq=0)).not_built_on == ()


def test_a_ruled_out_lead_ends_an_agents_work_in_a_thread_but_a_withdrawn_call_ends_none(
    record: RecordBuilder,
) -> None:
    record.thread('t-2', opened_by='ada').thread('t-3', opened_by='ada')
    record.post(Result(id='p-1', thread='t-2', author='ada', text='Curves help.'))
    record.post(Call(id='p-2', thread='t-3', author='ada', text='Who tries planes?'))
    record.post(RuledOut(id='p-3', thread='t-3', author='ada', text='No need.', reply_to='p-2'))
    working = brief(record.board(), 'cy', News(seq=0))

    record.post(RuledOut(id='p-4', thread='t-2', author='ada', text='Curves fail at scale.'))
    ended = brief(record.board(), 'cy', News(seq=0))

    # Withdrawing a call in t-3 leaves ada in t-2. Ruling out the lead in t-2 leaves her nowhere.
    assert [line.id for line in working.one_agent_threads] == ['t-2']
    assert ended.one_agent_threads == ()
    assert {summary.thread.id: summary.team for summary in ended.threads} == {'t-1': (), 't-2': (), 't-3': ()}


def test_the_answer_is_the_newest_proposal_in_the_questions_thread_with_what_it_builds_on() -> None:
    record = RecordBuilder().join('ada').join('bo').join('cy', family='openai')
    record.thread('t-1', opened_by='person', title=QUESTION_TITLE).thread('t-2', opened_by='ada')
    file = (FileEvidence(path='run.json', commit='c' * 40),)
    record.post(Result(id='p-1', thread='t-2', author='ada', text='Held up.', evidence=file))
    record.post(Result(id='p-2', thread='t-2', author='ada', text='Not rerun.', evidence=file))
    record.post(Result(id='p-3', thread='t-2', author='ada', text='A reading, with no files.'))
    record.join('dee', family='openai', checks='p-1')
    record.post(
        Check(id='p-4', thread='t-2', author='dee', text='So.', reply_to='p-1', outcome='holds', method='rerun')
    )
    assert answer_view(record.board()) is None
    assert brief(record.board(), 'bo', News(seq=0)).answer is None

    record.post(Proposal(id='p-5', thread='t-1', author='cy', text='No.'))
    record.post(Proposal(id='p-6', thread='t-2', author='bo', text='A proposal for this line only.'))
    record.post(Proposal(id='p-7', thread='t-1', author='bo', text='Yes.', builds_on=('p-1', 'p-2', 'p-3')))

    view = answer_view(record.board())
    line = brief(record.board(), 'ada', News(seq=0)).answer

    assert view is not None
    assert view.answer.post.id == 'p-7'
    assert [(under.post.id, under.standing) for under in view.builds_on] == [
        ('p-1', 'held_up'),
        ('p-2', 'open'),
        ('p-3', 'open'),
    ]
    assert (view.results, view.no_blind_rerun) == (2, ('p-2',))
    assert line is not None
    assert line.id == 'p-7'

    # A blind rerun that fails, or one from the author's own family, is still a blind rerun.
    record.join('eve', family='anthropic', checks='p-2')
    record.post(
        Check(id='p-8', thread='t-2', author='eve', text='No.', reply_to='p-2', outcome='fails', method='rerun')
    )
    after = answer_view(record.board())
    assert after is not None
    assert after.no_blind_rerun == ()

    # The newest proposal stays the answer when its author concedes it. Where it stands says so.
    record.post(Objection(id='p-9', thread='t-1', author='ada', text='p-2 failed.', reply_to='p-7'))
    record.post(Answer(id='p-10', thread='t-1', author='bo', text='Right.', reply_to='p-9', accepts=True))
    conceded = answer_view(record.board())
    assert conceded is not None
    assert (conceded.answer.post.id, conceded.answer.standing) == ('p-7', 'conceded')
    told = brief(record.board(), 'cy', News(seq=0))
    assert (told.answer and told.answer.id, told.answer_standing) == ('p-7', 'conceded')
