from datetime import datetime, timedelta
from decimal import Decimal
from functools import partial

import pytest
from builders import RecordBuilder, lab
from pydantic import TypeAdapter

from verifold.protocol.events import MAX_SEAT_NOTES, AlarmSet, BudgetSet, LimitReached, NotesSet, Posted, TurnEnded
from verifold.protocol.join import (
    MAX_BRIEF,
    MAX_CANDIDATES,
    MAX_LINE,
    MAX_NEWS,
    MAX_OBSTACLES,
    MAX_PERSON_LINE,
    QUIET_MINUTES,
    Brief,
    CandidatesView,
    News,
    PostLine,
    RestsOn,
    ThreadLine,
    ThreadLink,
    ThreadSummary,
)
from verifold.protocol.measures import MAX_LABEL, MAX_PAGE_BYTES
from verifold.protocol.posts import (
    MAX_BODY,
    MAX_HEADLINE,
    MAX_PART,
    MAX_ROUND_MINUTES,
    Answer,
    Ask,
    Call,
    Check,
    CheckMethod,
    Dashboard,
    FileEvidence,
    HeadlineNumber,
    Measure,
    Message,
    Objection,
    Outcome,
    Plan,
    Post,
    Proposal,
    Reading,
    Report,
    Result,
    RuledOut,
    Summary,
)
from verifold.protocol.threads import QUESTION_TITLE
from verifold.protocol.usage import DiskUse, Usage
from verifold.protocol.votes import BADGES, MAX_NOTES, MAX_WHY, BadgeNote, VoteNote
from verifold.server.join import INSTRUCTIONS
from verifold.society import views
from verifold.society.attention import news
from verifold.society.dashboards import DASHBOARD_TITLE
from verifold.society.errors import NotFound
from verifold.society.fit import CUTS, fit
from verifold.society.identity import post_line
from verifold.society.standing import is_open_call, takers
from verifold.society.views import (
    brief,
    candidates_view,
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


def test_a_summary_counts_the_results_that_stand_and_were_challenged_or_only_reproduced(record: RecordBuilder) -> None:
    def check(post_id: str, target: str, method: CheckMethod, outcome: Outcome) -> Check:
        body = 'On the 2015 to 2019 data.' if method == 'challenge' else ''
        return Check(
            id=post_id,
            thread='t-1',
            author='cy',
            text='So.',
            reply_to=target,
            outcome=outcome,
            method=method,
            body=body,
        )

    for number in range(1, 6):
        record.post(Result(id=f'p-{number}', thread='t-1', author='ada', text=f'Finding {number}.'))
    record.post(check('p-6', 'p-1', 'rerun', 'holds')).post(check('p-7', 'p-2', 'rerun', 'holds'))
    record.post(check('p-8', 'p-2', 'challenge', 'holds')).post(check('p-9', 'p-3', 'challenge', 'holds'))
    # A challenge that fails disputes its result, so the result stands no more and counts for neither.
    record.post(check('p-10', 'p-4', 'rerun', 'holds')).post(check('p-11', 'p-4', 'challenge', 'fails'))
    plain = thread_summaries(RecordBuilder().join('ada').thread('t-1', opened_by='ada').board(), 'ada')

    (summary,) = thread_summaries(record.board(), 'bo')
    view = brief(record.board(), 'bo', News(seq=0))

    assert (summary.challenged, summary.reproduced_only, summary.disputed, summary.not_checked) == (2, 1, 1, 1)
    assert (view.threads[0].challenged, view.threads[0].reproduced_only) == (2, 1)
    assert [(line.id, line.line.tested if line.line else None) for line in view.disputed] == [
        ('p-4', ('reproduced', 'challenge_failed'))
    ]
    # A count of zero says nothing, so a thread without such results is as long as before.
    assert 'challenged' not in plain[0].model_dump_json()
    assert 'reproduced_only' not in plain[0].model_dump_json()
    assert '"challenged":2,"reproduced_only":1' in summary.model_dump_json()


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

    assert [entry.id for entry in view.disputed] == ['p-1', 'p-3']
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


def test_a_brief_lists_the_threads_with_one_agent_and_the_results_that_nobody_built_on(record: RecordBuilder) -> None:
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


def test_each_candidate_shows_the_person_what_it_builds_on_and_the_brief_lists_it() -> None:
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
    assert candidates_view(record.board()) == CandidatesView()
    assert brief(record.board(), 'bo', News(seq=0)).candidates == ()

    record.post(Proposal(id='p-5', thread='t-1', author='cy', text='No.'))
    # An agent proposes where it was asked, so a proposal in any thread for the whole lab is a candidate.
    record.post(Proposal(id='p-6', thread='t-2', author='bo', text='Not yet: the tail is open.'))
    assert [view.candidate.post.id for view in candidates_view(record.board()).standing] == ['p-5', 'p-6']
    record.post(Proposal(id='p-7', thread='t-1', author='bo', text='Yes.', builds_on=('p-1', 'p-2', 'p-3')))

    cy, bo = candidates_view(record.board()).standing
    lines = brief(record.board(), 'ada', News(seq=0)).candidates

    assert (cy.candidate.post.id, bo.candidate.post.id) == ('p-5', 'p-7')
    assert [(under.post.id, under.standing) for under in bo.builds_on] == [
        ('p-1', 'held_up'),
        ('p-2', 'open'),
        ('p-3', 'open'),
    ]
    assert (bo.results, bo.no_blind_rerun, bo.entry) == (2, ('p-2',), None)
    # The candidate rests on three results: the blind rerun reproduced one, and nobody checked the other two. bo's
    # earlier proposal, which this one replaced, builds on nothing and is no candidate any more.
    rested = RestsOn(reproduced_only=1, not_checked=2)
    assert (bo.rests_on, cy.rests_on) == (rested, None)
    assert [(under.post.id, under.tested) for under in bo.builds_on] == [
        ('p-1', ('reproduced',)),
        ('p-2', ()),
        ('p-3', ()),
    ]
    # The brief's list of agents says who wrote each one, so a line has no byline of its own.
    assert [(line.line.id, line.line.by, line.standing, line.rests_on) for line in lines] == [
        ('p-5', None, 'open', None),
        ('p-7', None, 'open', rested),
    ]
    assert '"rests_on":{"reproduced_only":1,"not_checked":2}' in lines[1].model_dump_json()
    assert 'rests_on' not in lines[0].model_dump_json()

    # A blind rerun that fails, or one from the author's own family, is still a blind rerun.
    record.join('eve', family='anthropic', checks='p-2')
    record.post(
        Check(id='p-8', thread='t-2', author='eve', text='No.', reply_to='p-2', outcome='fails', method='rerun')
    )
    assert candidates_view(record.board()).standing[-1].no_blind_rerun == ()

    # A candidate that its author conceded does not stand, and the author's older one does not come back.
    record.post(Objection(id='p-9', thread='t-1', author='ada', text='p-2 failed.', reply_to='p-7'))
    disputed = brief(record.board(), 'cy', News(seq=0)).candidates
    assert [(line.line.id, line.standing) for line in disputed] == [('p-5', 'open'), ('p-7', 'disputed')]
    record.post(Answer(id='p-10', thread='t-1', author='bo', text='Right.', reply_to='p-9', accepts=True))
    assert [view.candidate.post.id for view in candidates_view(record.board()).standing] == ['p-5']
    assert [line.line.id for line in brief(record.board(), 'cy', News(seq=0)).candidates] == ['p-5']


def test_the_brief_gives_an_agent_its_own_line(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='bo', title='Line B')
    record.post(Plan(id='p-1', thread='t-2', author='bo', text='I measure line B.'))
    record.post(Message(id='p-2', thread='t-2', author='bo', text='The first run is in.'))

    mine = brief(record.board(), 'bo', News(seq=0)).your_line

    assert mine is not None
    assert (mine.id, mine.thread, mine.plan and mine.plan.id, mine.latest and mine.latest.id) == (
        'bo',
        't-2',
        'p-1',
        'p-2',
    )
    assert all(line.id != 'bo' for line in brief(record.board(), 'bo', News(seq=0)).agents)
    assert brief(record.board(), 'person', News(seq=0)).your_line is None


def test_a_brief_shows_the_labs_time_its_turns_its_alarms_and_its_quiet_threads() -> None:
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE)
    record.join('ada').join('bo').join('cy').join('guest', harness='guest')
    record.thread('t-2', opened_by='ada').post(Plan(id='p-1', thread='t-2', author='ada', text='I take the bound.'))
    record.thread('t-3', opened_by='bo').post(Plan(id='p-2', thread='t-3', author='bo', text='I take the data.'))
    # Ada and Bo are in a turn. Cy ended its turn, and set an alarm before that.
    record.start('ada', seen=0).start('bo', seen=0).start('cy', seen=0)
    seq = len(record.events) + 1
    record.events.append(AlarmSet(seq=seq, at=record.at(seq), agent='cy', minutes=30, stays=True))
    record.turn('cy', seen=seq)
    ends_at = record.at(len(record.events) + 1) + timedelta(hours=3)
    board = record.time_set(ends_at).board()
    now = board.posts[-1].at + timedelta(minutes=QUIET_MINUTES)

    view = brief(board, 'ada', News(seq=0), now=now)

    assert (view.state, view.ends_at, view.in_turn, view.alarms_waiting) == ('open', ends_at, 2, 1)
    assert view.minutes_left == (ends_at - now).total_seconds() / 60
    # Bo's thread got its last post an hour ago, and Ada's a minute earlier. The thread that went quiet last comes
    # first, and the question's thread is not listed.
    assert view.quiet_threads == (
        ThreadLine(id='t-3', title='Subject', team=('bo',), last_at=board.posts[1].at),
        ThreadLine(id='t-2', title='Subject', team=('ada',), last_at=board.posts[0].at),
    )
    assert view.more_quiet_threads == 0
    # A minute earlier only Ada's thread is that quiet, and without a clock the time counts from the newest post.
    assert [line.id for line in brief(board, 'ada', News(seq=0), now=now - timedelta(minutes=1)).quiet_threads] == [
        't-2'
    ]
    assert brief(board, 'ada', News(seq=0)).quiet_threads == ()
    assert brief(board, 'ada', News(seq=0)).minutes_left == (ends_at - board.posts[-1].at).total_seconds() / 60

    # A lab without a time limit has no time left to state, and a lab that is out of time has none left.
    assert brief(RecordBuilder().join('ada').board(), 'ada', News(seq=0)).minutes_left is None
    out = record.time_set(record.at(len(record.events) + 1)).ran_out().board()
    assert brief(out, 'ada', News(seq=0)).minutes_left == 0


def test_a_brief_has_the_newest_report_of_any_agent_with_its_age_in_minutes_and_none_in_a_lab_without_one(
    record: RecordBuilder,
) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='Beats random.'))
    none = brief(record.board(), 'bo', News(seq=0))
    record.post(Report(id='p-2', thread='t-1', author='bo', text='Nothing trained yet.'))
    record.post(Report(id='p-3', thread='t-1', author='ada', text='The baseline is in.', body='Loss 0.39.'))
    # A report of the person is no report of the lab.
    record.post(Report(id='p-4', thread='t-1', author='person', text='I think it holds.'))
    board = record.board()
    posted = board.posts[2].at

    view = brief(board, 'bo', News(seq=0), now=posted + timedelta(minutes=31, seconds=50))
    own = brief(board, 'ada', News(seq=0), now=posted + timedelta(seconds=59))

    assert (none.report, none.report_minutes_ago) == (None, None)
    # The line has the form of every line of a post: the headline, who wrote it, and no body.
    assert view.report == post_line(board, board.posts[2], 'ada')
    assert (view.report.id, view.report.kind, view.report.text) == ('p-3', 'report', 'The baseline is in.')
    assert view.report_minutes_ago == 31
    # The reader's own report is the lab's newest too, and under a minute is zero.
    assert (own.report.id if own.report else None, own.report_minutes_ago) == ('p-3', 0)
    # Without a clock, time counts from the board's newest post, which came a minute after the report.
    assert brief(board, 'bo', News(seq=0)).report_minutes_ago == 1
    # A report that somebody disputes is in the list of disputed posts by its ID alone, because the brief holds its line.
    record.post(Objection(id='p-5', thread='t-1', author='bo', text='The loss is 0.41.', reply_to='p-3'))
    disputed = brief(record.board(), 'cy', News(seq=0)).disputed
    assert [(entry.id, entry.line) for entry in disputed] == [('p-3', None)]


def test_a_line_of_work_says_how_long_ago_its_newest_result_and_plan_came_its_open_obstacles_and_its_badges() -> None:
    record = lab().thread('t-2', opened_by='ada', between=('ada', 'bo'))
    record.post(Plan(id='p-1', thread='t-1', author='ada', text='I fit the curve.'))
    record.post(Result(id='p-2', thread='t-1', author='ada', text='It fits.'))
    record.post(RuledOut(id='p-3', thread='t-1', author='bo', text='No fit past 40 points.'))
    record.post(RuledOut(id='p-4', thread='t-1', author='cy', text='No fit on the log scale.'))
    record.post(Plan(id='p-5', thread='t-1', author='cy', text='I rescale it.', builds_on=('p-4',)))
    record.post(Result(id='p-6', thread='t-2', author='bo', text='A side result.'))
    record.post(RuledOut(id='p-7', thread='t-2', author='bo', text='Not between us.'))
    record.badge('bo', 'p-2', 'promising').badge('cy', 'p-2', 'promising').badge('cy', 'p-1', 'promising')
    record.badge('cy', 'p-6', 'promising')
    board = record.board()
    result_at = board.posts[1].at

    def facts(summary: ThreadSummary) -> tuple[int | None, int | None, int, dict[str, int]]:
        return summary.result_minutes_ago, summary.plan_minutes_ago, summary.open_obstacles, dict(summary.badges)

    def summaries(now: datetime | None = None) -> dict[str, ThreadSummary]:
        return {summary.thread.id: summary for summary in thread_summaries(board, 'bo', now)}

    # The clock is twelve and a half minutes past the result, and Cy's plan came three minutes after the result. That
    # plan takes Cy's obstacle up, and two posts have a badge that stands. A side thread is no line of work.
    now = result_at + timedelta(minutes=12, seconds=30)
    assert facts(summaries(now)['t-1']) == (12, 9, 1, {'promising': 2})
    assert facts(summaries(now)['t-2']) == (None, None, 0, {})
    # The clock moves, and so do the minutes. Without a clock, time counts from the board's newest post.
    assert facts(summaries(now + timedelta(hours=1))['t-1'])[:2] == (72, 69)
    assert facts(summaries()['t-1'])[:2] == (5, 2)
    # The brief has the same facts in its threads.
    (line,) = brief(board, 'bo', News(seq=0), now=now).threads
    assert facts(line) == (12, 9, 1, {'promising': 2})
    # A line of work without a result or a plan has none of them.
    empty = lab().board()
    assert facts(thread_summaries(empty, 'bo')[0]) == (None, None, 0, {})


def test_a_brief_lists_the_newest_open_obstacles_with_their_standing_and_counts_the_others() -> None:
    record = lab()
    for number in range(1, 9):
        record.post(RuledOut(id=f'p-{number}', thread='t-1', author='bo', text=f'Dead end {number}.'))
    record.post(Plan(id='p-9', thread='t-1', author='cy', text='I take dead end 1.', builds_on=('p-1',)))
    record.post(Result(id='p-10', thread='t-1', author='cy', text='Dead end 2 is gone.', builds_on=('p-2',)))
    record.post(Objection(id='p-11', thread='t-1', author='ada', text='Dead end 7 is open.', reply_to='p-7'))
    board = record.board()

    obstacles = brief(board, 'cy', News(seq=board.seq)).obstacles

    # The newest open ones come first, at most five, with the counts of the others.
    assert [entry.id for entry in obstacles.open] == ['p-8', 'p-7', 'p-6', 'p-5', 'p-4']
    assert (obstacles.more_open, obstacles.taken_up, obstacles.removed) == (1, 1, 1)
    # An obstacle is a post, so one that an objection disputes says so. Bo's latest post is in the list of agents
    # and the disputed post is in `disputed`, so each is its ID alone. The others have their lines.
    assert [(entry.id, entry.standing, entry.line.text if entry.line else None) for entry in obstacles.open] == [
        ('p-8', 'open', None),
        ('p-7', 'disputed', None),
        ('p-6', 'open', 'Dead end 6.'),
        ('p-5', 'open', 'Dead end 5.'),
        ('p-4', 'open', 'Dead end 4.'),
    ]
    # An entry leaves its standing out while it is open, and a lab without obstacles leaves out every part.
    assert ('standing' in obstacles.open[1].model_dump(), 'standing' in obstacles.open[2].model_dump()) == (True, False)
    assert brief(lab().board(), 'ada', News(seq=0)).obstacles.model_dump() == {}
    # The news holds every post, so every obstacle is its ID alone.
    assert all(entry.line is None for entry in brief(board, 'cy', news(board, 'cy', 0)).obstacles.open)


def test_a_brief_names_the_author_of_a_threads_latest_post_only_when_its_list_of_agents_does_not(
    record: RecordBuilder,
) -> None:
    record.post(Result(id='p-1', thread='t-1', author='bo', text='Beats random.'))
    board = record.board()

    (line,) = brief(board, 'ada', News(seq=0)).threads
    (summary,) = thread_summaries(board, 'ada')

    # The brief's list of agents says who Bo is. `threads` has no such list, so its line says it.
    assert (line.latest and line.latest.by, summary.latest and summary.latest.by and summary.latest.by.name) == (
        None,
        'Bo',
    )


def test_a_brief_orders_its_lists_by_what_they_are_and_not_by_what_to_do_first() -> None:
    fields = list(Brief.model_fields)
    names = {'open_calls', 'open_asks', 'open_tasks', 'not_built_on', 'not_checked', 'disputed', 'obstacles'}
    lists = [name for name in fields if name in names]

    # The lists of posts come in the order of the alphabet, after the threads, so the order ranks nothing.
    assert lists == sorted(lists)
    assert fields.index('quiet_threads') < fields.index(lists[0])
    assert 'in this order' not in (Brief.__doc__ or '')
    assert 'ranks nothing' in (Brief.__doc__ or '')


def test_a_brief_counts_the_quiet_threads_that_its_list_leaves_out_and_lists_no_side_thread() -> None:
    record = RecordBuilder().join('ada').join('bo')
    for number in range(1, 14):
        record.thread(f't-{number}', opened_by='ada', between=('ada', 'bo') if number == 13 else ())
        record.post(Message(id=f'p-{number}', thread=f't-{number}', author='ada', text='A note.'))
    board = record.board()

    view = brief(board, 'bo', News(seq=0), now=board.posts[-1].at + timedelta(minutes=QUIET_MINUTES))

    assert [line.id for line in view.quiet_threads] == [f't-{number}' for number in range(12, 2, -1)]
    assert view.more_quiet_threads == 2


def test_a_line_cuts_a_long_headline_and_says_so_and_the_thread_keeps_all_of_it(record: RecordBuilder) -> None:
    long = 'x' * 1000
    record.post(Result(id='p-1', thread='t-1', author='ada', text=long))
    record.post(Result(id='p-2', thread='t-1', author='ada', text='y' * MAX_LINE))
    board = record.board()

    view = brief(board, 'bo', News(seq=0))
    cut, whole = view.not_built_on

    assert cut.line is not None
    assert cut.line.text == f'{"x" * MAX_LINE}… [cut: 1000 characters, `thread` shows all of it]'
    # The brief holds the line of ada's latest post already, in its list of agents.
    assert (whole.id, whole.line, view.agents[0].latest.text if view.agents[0].latest else '') == (
        'p-2',
        None,
        'y' * MAX_LINE,
    )
    assert news(board, 'bo', 0).for_you[0].text == cut.line.text
    assert thread_view(board, 'bo', 't-1').posts[0].post.text == long


def test_a_brief_holds_the_line_of_a_post_once_and_then_its_id_alone() -> None:
    record = lab().post(Result(id='p-1', thread='t-1', author='ada', text='First.'))
    record.post(Result(id='p-2', thread='t-1', author='ada', text='Second.'))
    record.post(Objection(id='p-3', thread='t-1', author='cy', text='No.', reply_to='p-1'))
    record.post(Ask(id='p-4', thread='t-1', author='cy', text='Which seed?'))
    board = record.board()

    seen = brief(board, 'bo', news(board, 'bo', 0))
    # The news holds every post, so each list has IDs alone.
    assert sorted(line.id for line in (*seen.news.for_you, *seen.news.others)) == ['p-1', 'p-2', 'p-3', 'p-4']
    lists = (seen.disputed, seen.not_built_on, seen.not_checked, seen.open_asks)
    assert [[(entry.id, entry.line) for entry in entries] for entries in lists] == [
        [('p-1', None)],
        [('p-2', None)],
        [('p-2', None)],
        [('p-4', None)],
    ]
    # Without news, a post has its line in the first list that names it, and its ID alone after that. The line of
    # an agent's latest post is in the list of agents.
    later = brief(board, 'bo', News(seq=board.seq))
    assert [entry.line.text if entry.line else None for entry in later.disputed] == ['First.']
    assert [(entry.id, entry.line is None) for entry in later.not_built_on] == [('p-2', True)]
    assert [(entry.id, entry.line is None) for entry in later.not_checked] == [('p-2', True)]
    assert [(entry.id, entry.line is None) for entry in later.open_asks] == [('p-4', True)]


ONE_TOOL_RESULT = 126_000
"""
The most characters of JSON in one tool result that a harness takes: before votes, the largest brief that the board
gave had 126,005 characters. The board cuts every brief to `MAX_BRIEF`, a few thousand characters below it, and the
briefs of the largest labs below are not larger than that.
"""


def _largest(*, full: bool = False, round_close: bool = True) -> RecordBuilder:
    # Twenty agents with the longest name, about line, role, and status, a long label, and every seat mark, in
    # twenty threads with every list full and headlines of 1,000 characters. With `full`, every post also has
    # the longest helper name and builds on ten posts, so that no line has an empty field to leave out. No post
    # builds on an obstacle, so that every obstacle stays open. With `round_close`, the reader's news holds the
    # close of a round with an entry of every other agent.
    record = RecordBuilder()
    for number in range(20):
        record.join(f'a{number}', name=f'Claude Code · {"m" * 40} {number + 2}')
    record.reviewer_seats(20).thread('t-1', opened_by='a0')
    ids: list[str] = []
    built: list[str] = []
    long = 'x' * 1000

    def post(kind: str, thread: str, author: str, reply_to: str | None = None, **extra: object) -> str:
        more = {'helper': 'h' * 40, 'builds_on': tuple(built[-10:])} if full else {}
        ids.append(f'p-{len(ids) + 1}')
        # No post builds on an entry while its round is open. No post builds on the reader's round either, so that
        # the posts for the reader are the same as in the lab without it.
        if kind not in {'ruled_out', 'entry', 'round'}:
            built.append(ids[-1])
        fields = {'kind': kind, 'id': ids[-1], 'thread': thread, 'author': author, 'text': long, 'reply_to': reply_to}
        record.post(TypeAdapter(Post).validate_python(fields | more | extra))
        return ids[-1]

    for number in range(1, 20):
        thread, author, other = f't-{number + 1}', f'a{number}', f'a{number % 19 + 1}'
        record.thread(thread, opened_by=author)
        post('plan', thread, author)
        post('result', thread, author)
        disputed = post('result', thread, author)
        post('objection', thread, other, disputed)
        # The obstacle's author posts later in its own thread, so the brief has the obstacle's line.
        post('ruled_out', thread, other)
        post('ask', thread, author)
        post('call', thread, author)
        if number == 2 and round_close:
            # Every entry comes while the round is open, and the close comes at the round's time.
            opened = post('round', 't-1', 'a0', minutes=MAX_ROUND_MINUTES)
            start = record.events[-1].at
            for entrant in range(1, 20):
                post('entry', 't-1', f'a{entrant}', opened)
                record.events[-1] = record.events[-1].model_copy(update={'at': start})
            record.closed(opened)
    # More agents propose than the brief lists, so the brief has every candidate line that it can hold.
    for number in range(1, MAX_CANDIDATES + 2):
        post('proposal', 't-1', f'a{number}')
    for number in range(20):
        agent = f'a{number}'
        record.profile(agent, name=f'{"N" * 21}{number:03d}', about='a' * 240, role='r' * 40, status='s' * 140)
        record.reviewer(agent, by='person')
        if number:
            record.on_call(agent)
    return record.coordinator('a1')


def test_the_largest_brief_without_votes_is_one_tool_result() -> None:
    board = _largest().board()

    unseen = news(board, 'a0', 0)
    view = brief(board, 'a0', unseen)
    (note,) = unseen.rounds

    assert (len(unseen.for_you), len(view.agents), len(view.threads)) == (20, 19, 20)
    # The lines of the round's note count in the 20 lines of the other posts: the round and its 19 entries fill them.
    assert (len(note.entries), note.left_out, len(unseen.others)) == (19, 0, 0)
    assert [len(entries) for entries in (view.disputed, view.not_built_on, view.not_checked)] == [19, 10, 19]
    assert [len(entries) for entries in (view.open_asks, view.open_calls)] == [19, 19]
    assert (len(view.obstacles.open), view.obstacles.more_open) == (MAX_OBSTACLES, 19 - MAX_OBSTACLES)
    assert sum(entry.line is not None for entry in view.obstacles.open) >= MAX_OBSTACLES - 1
    assert (len(view.candidates), len(view.older_candidates)) == (MAX_CANDIDATES, 1)
    assert len(view.model_dump_json()) < ONE_TOOL_RESULT
    assert len(unseen.model_dump_json()) < 28_000
    # Each author's name, seat, seat marks, and role stand once in the brief: in its list of agents. A line of
    # the news in any other result has them.
    entered = tuple(line for item in (unseen, view.news) for line in item.rounds[0].entries)
    assert all(line.by is not None and line.by.marks for line in (*unseen.for_you, *entered[:19]))
    assert all(line.by is None for line in (*view.news.for_you, *view.news.others, *entered[19:]))
    assert all(agent.plan is not None and agent.plan.by is None for agent in view.agents)
    # A line has its place in the record and no time.
    assert 'at' not in PostLine.model_fields


def test_the_largest_brief_with_every_result_reproduced_challenged_or_both_is_one_tool_result() -> None:
    # Each result has a rerun that holds. One in three also has a challenge that holds, and one in three a challenge
    # that holds and one that fails, so every line of a result carries marks, and the threads count them.
    record = _largest()
    results = tuple(event.post for event in record.events if isinstance(event, Posted) and event.post.kind == 'result')
    tests = (('rerun', 'holds'), ('challenge', 'holds'), ('challenge', 'fails'))
    for number, result in enumerate(results):
        checker = 'a1' if result.author != 'a1' else 'a2'
        for method, outcome in tests[: number % 3 + 1]:
            check = Check(
                id=f'p-{len(record.events) + 1}',
                thread=result.thread,
                author=checker,
                text='x' * 1000,
                body='On other dates.',
                reply_to=result.id,
                outcome=outcome,
                method=method,
            )
            record.post(check)
    board = record.board()

    view = brief(board, 'a0', news(board, 'a0', 0))
    lines = (*view.news.for_you, *view.news.others, *(entry.line for entry in view.disputed if entry.line))
    marked = tuple(line for line in lines if line.kind == 'result')

    assert marked
    assert all(line.tested for line in marked)
    assert ('reproduced', 'challenged', 'challenge_failed') in {line.tested for line in marked}
    assert sum(summary.challenged for summary in view.threads) > 0
    assert sum(summary.reproduced_only for summary in view.threads) > 0
    assert len(view.model_dump_json()) < ONE_TOOL_RESULT


def test_the_largest_brief_with_a_budget_that_the_lab_reached_and_its_disk_use_is_one_tool_result() -> None:
    plain = _largest().board()
    record = _largest()
    seq, at = record._stamp()
    record.events.append(BudgetSet(seq=seq, at=at, tokens=10**12 - 1, dollars=999_999.99))
    seq, at = record._stamp()
    usage = Usage(input_tokens=10**12, output_tokens=10**9)
    record.events.append(TurnEnded(seq=seq, at=at, agent='a1', seconds=1, usage=usage, cost_usd=999_999.999_999))
    seq, at = record._stamp()
    record.events.append(LimitReached(seq=seq, at=at, limit='tokens'))
    board = record.board()
    folders = {f'a{number}': 10**15 + number for number in range(20)}
    disk = DiskUse(at=at, folders=folders, reruns=10**15, snapshots=10**15, total=10**16)

    view = brief(board, 'a0', news(board, 'a0', 0), disk=disk)

    assert view.limit_reached == 'tokens'
    assert (view.budget.tokens_left, view.budget.dollars_left) == (0, 0)
    assert view.disk is not None
    assert (view.disk.folder, view.disk.lab, view.disk.limit) == (10**15, 10**16, 100 * 1024**3)
    # The budget and the disk add a few numbers, and the folders of the other agents stay out of the brief.
    assert len(view.model_dump_json()) - len(brief(plain, 'a0', news(plain, 'a0', 0)).model_dump_json()) < 400
    assert len(view.model_dump_json()) < ONE_TOOL_RESULT


def test_the_largest_brief_of_a_coordinator_with_the_persons_longest_posts_that_wait_is_one_tool_result() -> None:
    plain = _largest().board()
    record = _largest().coordinator('a0').thread('t-99', opened_by='person', conversation=True)
    for number in range(3):
        long = Message(id=f'p-90{number}', thread='t-99', author='person', text='h' * MAX_HEADLINE, body='b' * MAX_BODY)
        record.post(long)
    board = record.board()

    view = brief(board, 'a0', news(board, 'a0', 0))
    waits = view.person_waits

    assert waits is not None
    assert (waits.line.id, waits.line.body, waits.more) == ('p-900', '', 2)
    assert len(waits.line.text) < MAX_LINE + 100
    # The entry adds one line of a post, cut as the brief's other lines are, and no body.
    assert len(view.model_dump_json()) - len(brief(plain, 'a0', news(plain, 'a0', 0)).model_dump_json()) < 1_000
    assert len(view.model_dump_json()) < ONE_TOOL_RESULT
    assert 'b' * 100 not in view.model_dump_json()


def test_the_largest_brief_with_the_longest_reading_of_the_question_is_one_tool_result() -> None:
    plain = _largest().board()
    record = _largest().post(
        Reading(id='p-900', thread='t-1', author='a1', text='r' * MAX_HEADLINE, body='b' * MAX_BODY)
    )
    board = record.board()

    view = brief(board, 'a0', news(board, 'a0', 0))

    assert view.reading is not None
    assert (view.reading.id, view.reading.body, view.no_reading) == ('p-900', '', None)
    assert len(view.reading.text) < MAX_LINE + 100
    # The reading adds one line of a post, cut as the brief's other lines are, and no body.
    assert len(view.model_dump_json()) - len(brief(plain, 'a0', news(plain, 'a0', 0)).model_dump_json()) < 1_000
    assert len(view.model_dump_json()) < ONE_TOOL_RESULT
    assert 'b' * 100 not in view.model_dump_json()


def test_the_largest_brief_with_the_longest_summary_in_every_thread_is_one_tool_result() -> None:
    plain = _largest().board()
    record = _largest()
    for number in range(1, 20):
        thread, author = f't-{number + 1}', f'a{number}'
        record.post(
            Summary(id=f'p-9{number:02d}', thread=thread, author=author, text='s' * MAX_HEADLINE, body='b' * MAX_BODY)
        )
    board = record.board()

    view = brief(board, 'a0', news(board, 'a0', 0))
    whole = len(brief(plain, 'a0', news(plain, 'a0', 0)).model_dump_json())
    lines = tuple(summary.summary for summary in view.threads if summary.summary)

    # Each thread's line carries its summary's headline, cut as the brief's other lines are, and no body.
    assert {line.id for line in lines} <= {f'p-9{number:02d}' for number in range(1, 20)}
    assert lines
    assert all(len(line.text) < MAX_LINE + 100 and not line.body for line in lines)
    assert whole < len(view.model_dump_json()) <= MAX_BRIEF
    assert 'b' * 100 not in view.model_dump_json()
    # The summaries go with the threads' lines: the brief cuts no part that it must keep for them.
    assert all(not line.startswith('`news` leaves out') for line in view.cut)


def test_the_largest_brief_with_every_field_of_a_line_full_and_votes_on_every_post_is_one_tool_result() -> None:
    # Every post has the longest helper name and builds on ten posts. Every other agent and the person voted on
    # every post with the longest reason, and every post of an agent has all three badges. The board cuts this
    # brief to fit: `cut` says what it left out.
    record = _largest(full=True, round_close=False)
    plain = len(brief(record.board(), 'a0', news(record.board(), 'a0', 0)).model_dump_json())
    why = 'w' * MAX_WHY
    voters = (*(f'a{number}' for number in range(20)), 'person')
    for post in tuple(event.post for event in record.events if isinstance(event, Posted)):
        for number, voter in enumerate(voter for voter in voters if voter != post.author):
            record.vote(voter, post.id, 'up' if number % 2 else 'down', why)
        proposer = 'a2' if post.author == 'a0' else 'a0'
        record.badge('person', post.id, 'promising', reason=why).badge('person', post.id, 'confirmed', reason=why)
        record.badge(proposer, post.id, 'breakthrough', reason=why)
        record.badge('person', post.id, 'breakthrough', 'second', giver=proposer, reason=why)
    board = record.board()

    unseen = news(board, 'a0', 0)
    view = brief(board, 'a0', unseen)
    lines = (*unseen.for_you, *unseen.others)

    assert len(lines) == 40
    assert all((line.up, line.down, line.badges) == (10, 10, BADGES) for line in lines)
    assert all(line.helper for line in lines)
    assert sum(len(line.builds_on) == 10 for line in lines) >= 30
    # The news of this brief stops at its last post, before the votes. So the largest notes that a news can hold
    # count on top: the newest votes on the reader's posts and the newest changes to badges, with the longest
    # reason, and the counts of the ones left out.
    votes = tuple(VoteNote(post='p-115', by='a19', direction='down', reason=why) for _ in range(MAX_NOTES))
    badges = tuple(
        BadgeNote(post='p-115', badge='breakthrough', by='person', action='take_back', reason=why)
        for _ in range(MAX_NOTES)
    )
    notes = News(seq=1, votes=votes, votes_left_out=99, badges=badges, badges_left_out=99).model_dump_json()
    assert plain < len(view.model_dump_json())
    assert len(view.model_dump_json()) + len(notes) < ONE_TOOL_RESULT
    assert view.cut
    # No reason of a vote or a badge is in the brief's lines.
    assert why not in view.model_dump_json()


def _far_larger() -> tuple[RecordBuilder, int]:
    # A lab far larger than the largest one above. Twenty agents with the longest profiles work in sixty threads,
    # five more agents left, and two agents talk in ten side threads. Each thread has every kind of post, each with
    # the longest headline and helper name and ten posts in `builds_on`, and its results have files, a rerun that
    # holds, a challenge, and a request of the person for an independent rerun. Every post has votes with the
    # longest reason and a badge, every agent but the reader proposes, three deliverables have offers of ten agents,
    # and the coordinator has the longest notes and reading and the person's longest posts wait for its reply.
    # Then a round closes with an entry of every other agent, more of the person's longest posts for every agent
    # come than a news holds, and a second round opens. It returns the record and the event before the round that
    # closes, where the reader's news starts.
    record = RecordBuilder()
    for number in range(25):
        record.join(f'a{number}', name=f'Claude Code · {"m" * 40} {number + 2}')
    for number in range(20, 25):
        record.leave(f'a{number}', reason='r' * 200)
    record.reviewer_seats(20).thread('t-1', opened_by='a0').coordinator('a0')
    record.thread('t-99', opened_by='person', conversation=True)
    built: list[str] = []
    long = 'x' * 1000
    files = (FileEvidence(path='run.py', commit='c' * 40),)

    def post(kind: str, thread: str, author: str, reply_to: str | None = None, **extra: object) -> str:
        post_id = f'p-{len(record.events) + 1}'
        fields = {'kind': kind, 'id': post_id, 'thread': thread, 'author': author, 'text': long, 'reply_to': reply_to}
        more = {'helper': 'h' * 40, 'builds_on': tuple(built[-10:])} if kind not in {'entry', 'round'} else {}
        record.post(TypeAdapter(Post).validate_python(fields | more | extra))
        if kind not in {'ruled_out', 'entry', 'round'}:
            built.append(post_id)
        return post_id

    for number in range(1, 61):
        thread, author, other = f't-{number + 1}', f'a{number % 19 + 1}', f'a{(number + 1) % 19 + 1}'
        record.thread(thread, opened_by=author)
        post('plan', thread, author)
        results = (post('result', thread, author, evidence=files), post('result', thread, author, evidence=files))
        for result in results:
            post('check', thread, other, result, outcome='holds', method='rerun')
            post('check', thread, other, result, outcome='holds', method='challenge', body='On other dates.')
        record.rerun('person', results[0])
        post('objection', thread, other, results[1])
        post('ruled_out', thread, other)
        post('ask', thread, author)
        post('call', thread, author)
        post('task', thread, author, mentions=(other,), output='o' * MAX_PART, bounds='b' * MAX_PART)
        post('summary', thread, author, text='s' * MAX_HEADLINE, body='b' * MAX_BODY)
    for number in range(10):
        record.thread(f't-{number + 70}', opened_by='a1', between=('a1', 'a2'))
        post('message', f't-{number + 70}', 'a1')
    for number in range(1, 4):
        record.deliverable(f'd-{number}', 's' * 300, f'p-{len(record.events) + 1}')
        for offerer in range(1, 11):
            record.offer(f'p-{len(record.events) + 1}', f'a{offerer}', f'd-{number}', f't-{number + 80}')
    for number in range(1, 20):
        post('proposal', 't-1', f'a{number}')
    post('reading', 't-1', 'a0', text='r' * MAX_HEADLINE, body='b' * MAX_BODY)
    # The lab's headline number has the longest label, value, unit, and why, and the dashboard stands.
    source = (FileEvidence(path='v.py', commit='c' * 40), FileEvidence(path='v.out', commit='c' * 40))
    label, value = 'L' * MAX_LABEL, '1234567890123456.123456789012'
    post(
        'measure',
        't-1',
        'a1',
        label=label,
        value=value,
        unit='u' * 20,
        as_of=record.at(1),
        script='v.py',
        output='v.out',
        evidence=source,
    )
    post('headline_number', 't-1', 'a0', label=label, why='w' * 200)
    record.thread('t-98', opened_by='a3', title=DASHBOARD_TITLE)
    post('dashboard', 't-98', 'a3', evidence=files, size=MAX_PAGE_BYTES)
    why = 'w' * MAX_WHY
    for entry in tuple(event for event in record.events if isinstance(event, Posted) and event.post.author != 'person'):
        for number, voter in enumerate(f'a{number}' for number in range(10) if f'a{number}' != entry.post.author):
            record.vote(voter, entry.post.id, 'up' if number % 2 else 'down', why)
        record.badge('person', entry.post.id, 'promising', reason=why)
    for number in range(20):
        agent = f'a{number}'
        record.profile(agent, name=f'{"N" * 21}{number:03d}', about='a' * 240, role='r' * 40, status='s' * 140)
        record.reviewer(agent, by='person')
    notes = ('Doing "the tail".\n' * 400)[:MAX_SEAT_NOTES]
    seq, at = record._stamp()
    record.events.append(NotesSet(seq=seq, at=at, agent='a0', text=notes))
    for number in range(3):
        record.post(Message(id=f'p-9990{number}', thread='t-99', author='person', text='h' * 1000, body='b' * MAX_BODY))
    after = record.events[-1].seq
    opened = post('round', 't-1', 'a1', minutes=MAX_ROUND_MINUTES)
    start = record.events[-1].at
    for entrant in range(2, 20):
        post('entry', 't-1', f'a{entrant}', opened)
        record.events[-1] = record.events[-1].model_copy(update={'at': start})
    record.closed(opened)
    for number in range(MAX_NEWS + 5):
        record.post(
            Message(id=f'p-9995{number:02d}', thread='t-1', author='person', text='h' * 1000, body='b' * MAX_BODY)
        )
    post('round', 't-1', 'a2', minutes=MAX_ROUND_MINUTES)
    return record, after


def test_the_brief_of_a_lab_far_larger_than_the_largest_fits_one_tool_result_and_cuts_nothing_that_it_must_keep(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record, after = _far_larger()
    board = record.board()
    now = board.posts[-1].at

    def page(most: int) -> News:
        return news(board, 'a0', after, now, most=most)

    first = brief(board, 'a0', page(MAX_NEWS), INSTRUCTIONS, now=now, page=page)
    later = brief(board, 'a5', news(board, 'a5', 0, now), now=now)
    # The same briefs with room for all: the parts that are never cut are the same in both.
    monkeypatch.setattr(views, 'fit', partial(fit, budget=10**9))
    whole = brief(board, 'a0', page(MAX_NEWS), INSTRUCTIONS, now=now, page=page)

    assert len(whole.model_dump_json()) > ONE_TOOL_RESULT + 100_000
    for view in (first, later):
        # A few thousand characters of headroom stay for the next field.
        assert len(view.model_dump_json()) <= MAX_BRIEF <= ONE_TOOL_RESULT - 5_000
    never_cut = (
        'how',
        'you',
        'your_line',
        'notes',
        'notes_minutes_ago',
        'question',
        'revisions',
        'state',
        'ends_at',
        'minutes_left',
        'budget',
        'limit_reached',
        'person_waits',
        'reading',
        'reading_minutes_ago',
        'round',
        'report',
        'close',
        'coordinator',
        'reviewers',
        'powers',
    )
    assert {name: getattr(first, name) for name in never_cut} == {name: getattr(whole, name) for name in never_cut}
    assert first.notes is not None
    assert len(first.notes) == MAX_SEAT_NOTES
    assert (first.how, first.round is not None, first.person_waits is not None) == (INSTRUCTIONS, True, True)
    assert first.reading is not None
    # The posts for the reader are whole lines, the person's with their bodies, and none is lost: the news ends
    # earlier, and `more` counts the posts that the next result brings.
    held = len(first.news.for_you)
    assert 0 < held < MAX_NEWS
    assert first.news.for_you == whole.news.for_you[:held]
    persons = tuple(line for line in first.news.for_you if line.author == 'person')
    assert persons
    assert all(line.body.startswith('b' * (MAX_PERSON_LINE - 1000)) for line in persons)
    assert first.news.more == whole.news.more + MAX_NEWS - held
    assert first.news.seq == first.news.for_you[-1].seq
    assert (first.news.votes, first.news.badges) == (whole.news.votes, whole.news.badges)
    # Each agent stays in the list, the candidates stay by their IDs, and each list of posts keeps its IDs.
    assert [agent.id for agent in first.agents] == [agent.id for agent in whole.agents]
    assert {ref.id for ref in first.older_candidates} | {line.line.id for line in first.candidates} == {
        ref.id for ref in whole.older_candidates
    } | {line.line.id for line in whole.candidates}
    for name in ('disputed', 'not_built_on', 'not_checked', 'open_asks', 'open_calls', 'open_tasks'):
        assert [entry.id for entry in getattr(first, name)] == [entry.id for entry in getattr(whole, name)]
    assert len(whole.open_tasks) == MAX_NEWS
    assert {entry.invites for entry in first.open_tasks} == {entry.invites for entry in whole.open_tasks}
    # The brief says what it cut, part by part, in the order of the cuts, and which tool shows it.
    assert whole.cut == ()
    assert first.cut[0] == f'`quiet_threads` leaves out {len(whole.quiet_threads)} lines. `threads` shows every thread.'
    assert any(line.startswith('`news` leaves out') for line in first.cut)
    shows = ('`thread` show', '`threads` show', '`steering` show', '`take_rerun` takes', 'result has them')
    assert all(any(way in line for way in shows) for line in first.cut)
    names = {'reruns': 'news.reruns', 'others': 'news.others', 'rounds': 'news.rounds', 'deliverables': 'offers'}
    parts = [names.get(word, word) for line in first.cut if (word := line.split('`')[1]) != 'news'] + ['news.for_you']
    assert parts == sorted(parts, key=CUTS.index)
    assert {'side_threads', 'reruns_wanted', 'news.reruns', 'left', 'news.rounds', 'offers', 'agents'} < set(parts)
    # The headline number and the dashboard are cut whole, before the candidates and the agents' lines.
    assert (whole.headline_number is not None, whole.dashboard is not None) == (True, True)
    assert (first.headline_number, first.dashboard) == (None, None)
    assert {'headline_number', 'dashboard'} < set(parts)
    assert first.quiet_threads == first.one_agent_threads == first.side_threads == ()
    # Every line of work has a summary, and a thread's line that the brief keeps keeps it.
    works = {f't-{number + 1}' for number in range(1, 61)}
    kept = tuple(summary for summary in (*first.threads, *whole.threads) if summary.thread.id in works)
    assert kept
    assert all(summary.summary is not None for summary in kept)
    assert later.cut
    assert later.notes is None


def test_a_seat_with_a_fresh_view_reads_no_candidate_and_no_report_until_its_first_plan() -> None:
    record = lab().post(Reading(id='p-1', thread='t-1', author='ada', text='An answer is a sort that holds.'))
    record.post(Proposal(id='p-2', thread='t-1', author='ada', text='Use the radix sort.'))
    record.post(Report(id='p-3', thread='t-1', author='bo', text='The radix sort leads.'))
    page = (FileEvidence(path='board.html', commit='c' * 40),)
    record.thread('t-2', opened_by='bo', title=DASHBOARD_TITLE)
    record.post(Dashboard(id='p-9', thread='t-2', author='bo', text='The race so far.', evidence=page, size=10))
    record.join('dee', fresh=True)
    board = record.board()

    fresh = brief(board, 'dee', News(seq=0))
    assert (fresh.fresh, fresh.candidates, fresh.older_candidates, fresh.report) == (True, (), (), None)
    # The dashboard says where the lab stands, as the report does.
    assert (fresh.dashboard, brief(board, 'cy', News(seq=0)).dashboard is not None) == (None, True)
    # The reading and the question stay, and another agent's brief holds the candidate.
    assert (fresh.reading and fresh.reading.id, fresh.question) == ('p-1', board.question)
    assert [line.line.id for line in brief(board, 'cy', News(seq=0)).candidates] == ['p-2']

    planned = record.post(Plan(id='p-4', thread='t-1', author='dee', text='I try a merge of runs.')).board()
    after = brief(planned, 'dee', News(seq=0))
    assert (after.fresh, [line.line.id for line in after.candidates], after.report and after.report.id) == (
        False,
        ['p-2'],
        'p-3',
    )
    assert after.dashboard is not None


def test_the_largest_brief_with_the_headline_number_and_the_dashboard_is_one_tool_result() -> None:
    record = _largest()
    source = (FileEvidence(path='v.py', commit='c' * 40), FileEvidence(path='v.out', commit='c' * 40))
    label = 'L' * MAX_LABEL
    measured = Measure(
        id=f'p-{len(record.events) + 1}',
        thread='t-1',
        author='a1',
        text='x' * 140,
        label=label,
        value=Decimal('-1234567890123456.123456789012'),
        unit='u' * 20,
        as_of=record.at(1),
        script='v.py',
        output='v.out',
        evidence=source,
    )
    record.post(measured).coordinator('a2')
    record.post(
        HeadlineNumber(
            id=f'p-{len(record.events) + 1}', thread='t-1', author='a2', text='x' * 80, label=label, why='w' * 200
        )
    )
    record.thread('t-98', opened_by='a3', title=DASHBOARD_TITLE)
    page = Dashboard(
        id=f'p-{len(record.events) + 1}',
        thread='t-98',
        author='a3',
        text='x' * 200,
        evidence=(FileEvidence(path='d.html', commit='c' * 40),),
        size=MAX_PAGE_BYTES,
    )
    board = record.post(page).board()

    view = brief(board, 'a0', news(board, 'a0', 0))

    assert len(view.model_dump_json()) <= MAX_BRIEF
    kept = (view.headline_number is not None, view.dashboard is not None)
    cut = tuple(line.split('`')[1] for line in view.cut)
    assert all(shown or part in cut for shown, part in zip(kept, ('headline_number', 'dashboard'), strict=True))
    whole = brief(board, 'a5', News(seq=board.seq))
    assert whole.headline_number is not None
    assert whole.headline_number.measure is not None
    assert (whole.headline_number.named_by, whole.dashboard and whole.dashboard.by) == ('a2', 'a3')
