import pytest
from builders import RecordBuilder, lab
from pydantic import TypeAdapter

from verifold.protocol.events import Event, ThreadOpened
from verifold.protocol.posts import Ask, Call, Check, Close, FileEvidence, Message, Plan, Post, Proposal, Result
from verifold.society.attention import news, wakes, watches_thread
from verifold.society.errors import RejectedEvent
from verifold.society.fold import fold
from verifold.society.lines import lines_of
from verifold.society.views import brief, side_lines, thread_summaries, thread_view, work_threads

FIRST = Message(id='p-1', thread='t-2', author='ada', text='Bo, can you fetch the scoreboard for me?')


def side() -> RecordBuilder:
    """The lab from `builders.lab` with `dee`, and side thread t-2 between ada and bo with ada's first post."""
    return lab().join('dee').thread('t-2', opened_by='ada', title='Scoreboard', between=('ada', 'bo')).post(FIRST)


def woken(record: RecordBuilder, post: Post) -> set[str]:
    board = record.post(post).board()
    entry = board.posts[-1]
    return {joined.agent.id for joined in board.agents if wakes(board, joined.agent.id, entry)}


def test_the_first_post_of_a_side_thread_reaches_its_members_and_no_other_agent() -> None:
    opened = lab().join('dee').thread('t-2', opened_by='ada', between=('ada', 'bo'))

    assert woken(opened, FIRST) == {'bo'}
    assert opened.board().members('t-2') == ('ada', 'bo')
    # The same post as the first of any other thread is for every agent.
    assert woken(lab().join('dee').thread('t-2', opened_by='ada'), FIRST) == {'bo', 'cy', 'dee'}


@pytest.mark.parametrize(
    'post',
    [
        Message(id='p-2', thread='t-2', author='bo', text='Here it is.'),
        Ask(id='p-2', thread='t-2', author='bo', text='Which round do you need?'),
        Call(id='p-2', thread='t-2', author='bo', text='Somebody must own the account.'),
    ],
)
def test_no_post_in_a_side_thread_is_for_every_agent_whatever_its_kind(post: Post) -> None:
    assert woken(side(), post) == {'ada'}


def test_a_post_in_a_side_thread_also_reaches_the_agents_that_it_names_answers_or_builds_on() -> None:
    record = side().post(Result(id='p-2', thread='t-1', author='cy', text='The baseline holds.'))

    assert woken(record, Message(id='p-3', thread='t-2', author='bo', text='Ask cy.', mentions=('cy',))) == {
        'ada',
        'cy',
    }
    assert woken(side(), Message(id='p-2', thread='t-2', author='bo', text='Dee has the account.')) == {'ada', 'dee'}
    built = Message(id='p-3', thread='t-2', author='bo', text='I start from the baseline.', builds_on=('p-2',))
    assert woken(side().post(Result(id='p-2', thread='t-1', author='cy', text='The baseline holds.')), built) == {
        'ada',
        'cy',
    }
    # A name reaches an agent once. It does not make the agent a member.
    assert record.board().members('t-2') == ('ada', 'bo')


def test_the_persons_post_in_a_side_thread_reaches_its_members_only() -> None:
    by_person = Message(id='p-2', thread='t-2', author='person', text='Use the public scoreboard.')

    assert woken(side(), by_person) == {'ada', 'bo'}
    # It reaches a member that stopped watching too, as the person's words do in any thread.
    assert woken(side().watch('bo', 't-2', watching=False), by_person) == {'ada', 'bo'}
    assert woken(side(), by_person.model_copy(update={'mentions': ('cy',)})) == {'ada', 'bo', 'cy'}
    assert side().post(by_person).board().members('t-2') == ('ada', 'bo')


def test_an_agent_that_posts_in_a_side_thread_or_watches_it_is_a_member_from_then_on() -> None:
    record = side().post(Message(id='p-2', thread='t-2', author='cy', text='I have that scoreboard too.'))
    assert record.board().members('t-2') == ('ada', 'bo', 'cy')
    assert woken(record, Message(id='p-3', thread='t-2', author='bo', text='Thanks, both.')) == {'ada', 'cy'}

    record.watch('dee', 't-2')
    board = record.board()
    assert board.members('t-2') == ('ada', 'bo', 'cy', 'dee')
    assert watches_thread(board, 'dee', 't-2')
    assert woken(record, Message(id='p-4', thread='t-2', author='bo', text='Thanks, all.')) == {'ada', 'cy', 'dee'}


def test_nobody_leaves_the_members_of_a_side_thread_and_a_member_can_stop_watching() -> None:
    record = side().watch('cy', 't-2').watch('cy', 't-2', watching=False).watch('bo', 't-2', watching=False)
    board = record.leave('ada').board()

    assert board.members('t-2') == ('ada', 'bo', 'cy')
    assert not watches_thread(board, 'bo', 't-2')
    assert woken(record, Message(id='p-2', thread='t-2', author='dee', text='Is this still open?')) == set()
    # A watch that only ever stopped makes no member.
    assert side().watch('dee', 't-2', watching=False).board().members('t-2') == ('ada', 'bo')


def test_every_agent_reads_a_side_thread_and_sees_its_posts_in_its_news() -> None:
    board = side().board()

    view = thread_view(board, 'cy', 't-2')
    assert (view.members, view.watching, [item.post.id for item in view.posts]) == (('ada', 'bo'), False, ['p-1'])
    assert thread_view(board, 'person', 't-2').members == ('ada', 'bo')
    assert thread_view(board, 'cy', 't-1').members == ()
    unseen = news(board, 'cy', 0)
    assert ([line.id for line in unseen.for_you], [line.id for line in unseen.others]) == ([], ['p-1'])
    assert [line.id for line in news(board, 'bo', 0).for_you] == ['p-1']


@pytest.mark.parametrize(
    'post',
    [
        Proposal(id='p-2', thread='t-2', author='bo', text='The answer is 42.'),
        Close(id='p-2', thread='t-2', author='bo', text='The lab is done.'),
    ],
)
def test_a_side_thread_takes_no_proposal_and_no_close(post: Post) -> None:
    with pytest.raises(RejectedEvent, match=f'side thread, and a {post.kind} is for the whole lab'):
        side().post(post).board()
    # Any other thread takes both.
    assert lab().post(post.model_copy(update={'thread': 't-1'})).board().posts[-1].post.kind == post.kind


def test_agents_work_in_a_side_thread_and_it_counts_as_their_line() -> None:
    record = side().post(Plan(id='p-2', thread='t-2', author='bo', text='I fetch every round.'))
    record.post(Plan(id='p-5', thread='t-1', author='ada', text='I score the rounds.'))
    evidence = (FileEvidence(path='rounds.json', commit='a' * 40),)
    record.post(Result(id='p-3', thread='t-2', author='bo', text='All 12 rounds are in.', evidence=evidence))
    record.post(
        Check(
            id='p-4',
            thread='t-2',
            author='ada',
            text='I counted 12.',
            reply_to='p-3',
            outcome='holds',
            method='code_read',
        )
    )
    board = record.board()

    assert lines_of(board) == {'bo': 't-2', 'ada': 't-1'}
    summary = next(summary for summary in thread_summaries(board, 'cy') if summary.thread.id == 't-2')
    assert (summary.team, summary.checked, summary.members) == (('bo',), 1, ('ada', 'bo'))
    assert {line.id for line in brief(board, 'cy', news(board, 'cy', 0)).one_agent_threads} == {'t-1', 't-2'}


def test_a_blind_checker_posts_in_a_side_thread_and_is_no_member() -> None:
    evidence = (FileEvidence(path='rounds.json', commit='a' * 40),)
    record = side().post(Result(id='p-2', thread='t-2', author='bo', text='All 12 rounds are in.', evidence=evidence))
    record.rerun('cy', 'p-2').join('checker', family='openai', checks='p-2')
    check = Check(id='p-3', thread='t-2', author='checker', text='12.', reply_to='p-2', outcome='holds', method='rerun')

    # The check reaches the members, and the agent that asked for the rerun.
    assert woken(record, check) == {'ada', 'bo', 'cy'}
    assert record.board().members('t-2') == ('ada', 'bo')


def test_the_lists_show_side_threads_apart_one_line_each_and_an_agents_own_first() -> None:
    record = side().thread('t-3', opened_by='cy', title='Who owns the account?', between=('cy', 'dee'))
    record.post(Message(id='p-2', thread='t-3', author='cy', text='Dee, is it yours?'))
    record.post(Message(id='p-3', thread='t-1', author='cy', text='A note.'))
    board = record.board()
    every = thread_summaries(board, 'bo')

    assert [summary.thread.id for summary in work_threads(every)] == ['t-1']
    mine = side_lines(every, 'bo')
    assert [(line.id, line.title, line.members, line.posts) for line in mine] == [
        ('t-2', 'Scoreboard', ('ada', 'bo'), 1),
        ('t-3', 'Who owns the account?', ('cy', 'dee'), 1),
    ]
    assert mine[1].last_at == record.at(len(record.events) - 1)
    # An agent in neither sees the most recently active first, and so does the person.
    assert [line.id for line in side_lines(thread_summaries(board, 'person'), 'person')] == ['t-3', 't-2']
    assert [line.id for line in side_lines(every, 'dee')] == ['t-3', 't-2']

    read = brief(board, 'bo', news(board, 'bo', 0))
    assert [summary.thread.id for summary in read.threads] == ['t-1']
    assert ([line.id for line in read.side_threads], read.more_side_threads) == (['t-2', 't-3'], 0)


def test_a_brief_lists_the_asks_and_calls_of_a_side_thread_for_its_members_only() -> None:
    record = side().post(Ask(id='p-2', thread='t-2', author='ada', text='Which round is the last?'))
    board = record.post(
        Call(id='p-3', thread='t-2', author='ada', text='The fetch needs a second pair of hands.')
    ).board()

    for_bo, for_cy = brief(board, 'bo', news(board, 'bo', 0)), brief(board, 'cy', news(board, 'cy', 0))
    assert ([line.id for line in for_bo.open_asks], [line.id for line in for_bo.open_calls]) == (['p-2'], ['p-3'])
    assert (for_cy.open_asks, for_cy.open_calls) == ((), ())


def test_a_side_thread_is_between_its_opener_and_other_agents_that_can_hear_it() -> None:
    record = lab().join('gone').leave('gone')
    record.post(Result(id='p-1', thread='t-1', author='ada', text='It holds.'))
    record.join('blind', family='openai', checks='p-1')

    for between, message in (
        (('ada',), 'at least one other agent'),
        (('bo', 'ada'), 'at least one other agent'),
        (('ada', 'zed'), 'zed is not an agent in this lab'),
        (('ada', 'person'), 'person is not an agent in this lab'),
        (('ada', 'blind'), 'blind is a blind checker'),
        (('ada', 'gone'), 'gone left this lab'),
    ):
        with pytest.raises(RejectedEvent, match=message):
            RecordBuilder(list(record.events)).thread('t-2', opened_by='ada', between=between).board()
    with pytest.raises(RejectedEvent, match='at least one other agent'):
        RecordBuilder(list(record.events)).thread('t-2', opened_by='person', between=('person', 'bo')).board()


def test_a_record_from_before_side_threads_loads_unchanged() -> None:
    old = """
{"seq":1,"at":"2026-11-06T12:00:00Z","type":"lab_opened","version":1,"question":"Does it hold?"}
{"seq":2,"at":"2026-11-06T12:01:00Z","type":"agent_joined","agent":{"id":"ada","name":"Ada","harness":"fake","model":{"family":"anthropic"}}}
{"seq":3,"at":"2026-11-06T12:02:00Z","type":"agent_joined","agent":{"id":"bo","name":"Bo","harness":"fake","model":{"family":"anthropic"}}}
{"seq":4,"at":"2026-11-06T12:03:00Z","type":"thread_opened","thread":{"id":"t-1","title":"Subject","opened_by":"ada"}}
{"seq":5,"at":"2026-11-06T12:04:00Z","type":"posted","post":{"id":"p-1","thread":"t-1","author":"ada","kind":"proposal","text":"The answer is 42."}}
"""
    events = [TypeAdapter(Event).validate_json(line) for line in old.strip().splitlines()]
    board = fold(events)

    opened = events[3]
    assert isinstance(opened, ThreadOpened)
    assert opened.thread.between == ()
    assert board.members('t-1') == ()
    # Its threads are ordinary ones: the first post is for every agent, and the thread takes a proposal.
    assert wakes(board, 'bo', board.posts[0])
    assert side_lines(thread_summaries(board, 'bo'), 'bo') == ()
    assert [summary.members for summary in work_threads(thread_summaries(board, 'bo'))] == [()]
