from datetime import timedelta

import pytest
from builders import RecordBuilder, lab

from verifold.protocol.join import MAX_NEWS
from verifold.protocol.posts import Check, FileEvidence, Message, Objection, Post, Proposal, Result
from verifold.society.attention import news, update, wakes, watches_thread
from verifold.society.errors import RejectedEvent

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Beats random on 10 of 10 prompts.')


def started() -> RecordBuilder:
    """The lab from `builders.lab` with ada's result as the first post of t-1, so the next post there is not the first."""
    return lab().post(RESULT)


def woken(record: RecordBuilder, post: Post) -> set[str]:
    board = record.post(post).board()
    entry = board.posts[-1]
    return {joined.agent.id for joined in board.agents if wakes(board, joined.agent.id, entry)}


def test_an_agent_watches_the_threads_that_it_opens_or_posts_in_and_the_persons_threads() -> None:
    record = started().thread('t-2', opened_by='person')
    board = record.post(Message(id='p-2', thread='t-1', author='bo', text='Reading it.')).board()

    assert watches_thread(board, 'ada', 't-1')
    assert watches_thread(board, 'bo', 't-1')
    assert not watches_thread(board, 'cy', 't-1')
    assert all(watches_thread(board, agent, 't-2') for agent in ('ada', 'bo', 'cy'))
    assert not watches_thread(board, 'ada', 't-9')


def test_watches_change_with_watch_events(record: RecordBuilder) -> None:
    board = record.watch('bo', 't-1').watch('ada', 't-1', watching=False).board()

    assert watches_thread(board, 'bo', 't-1')
    assert not watches_thread(board, 'ada', 't-1')


def test_a_watch_needs_an_agent_and_a_thread() -> None:
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        lab().watch('zed', 't-1').board()
    with pytest.raises(RejectedEvent, match='t-9 does not exist'):
        lab().watch('bo', 't-9').board()


def test_a_post_in_a_thread_wakes_its_watchers_but_not_its_author() -> None:
    by_bo = Message(id='p-2', thread='t-1', author='bo', text='Starting.')

    assert woken(started().watch('cy', 't-1'), by_bo) == {'ada', 'cy'}
    assert woken(started(), by_bo.model_copy(update={'author': 'ada'})) == set()


def test_the_first_post_of_a_thread_wakes_every_agent_unless_it_names_somebody() -> None:
    assert woken(lab(), RESULT) == {'bo', 'cy'}
    assert woken(lab(), RESULT.model_copy(update={'mentions': ('person',)})) == set()
    assert woken(lab(), RESULT.model_copy(update={'mentions': ('cy',)})) == {'cy'}


def test_a_proposal_wakes_every_agent() -> None:
    assert woken(started(), Proposal(id='p-2', thread='t-1', author='bo', text='The answer: it holds.')) == {
        'ada',
        'cy',
    }


def test_mentions_and_replies_wake_their_agents() -> None:
    assert woken(started(), Objection(id='p-2', thread='t-1', author='bo', text='Leak.', reply_to='p-1')) == {'ada'}
    assert woken(started(), Message(id='p-2', thread='t-1', author='ada', text='Over to you.', mentions=('cy',))) == {
        'cy'
    }


def test_a_name_in_the_text_wakes_its_agent() -> None:
    in_headline = Message(id='p-2', thread='t-1', author='ada', text='Bo, can you rerun it?')
    in_body = Message(id='p-2', thread='t-1', author='ada', text='A handoff.', body='The data is with cy now.')

    assert woken(started(), in_headline) == {'bo'}
    assert woken(started(), in_body) == {'cy'}


def test_a_name_matches_whole() -> None:
    record = RecordBuilder().join('agent-1').join('agent-12').join('agent-2').thread('t-1', opened_by='agent-2')
    record.post(Message(id='p-1', thread='t-1', author='agent-2', text='Start.', mentions=('person',)))

    assert woken(record, Message(id='p-2', thread='t-1', author='agent-2', text='Agent-12 found it.')) == {'agent-12'}


def test_a_check_wakes_the_author_and_the_agent_that_asked_for_the_rerun() -> None:
    record = lab().post(RESULT.model_copy(update={'evidence': (FileEvidence(path='a.json', commit='c' * 40),)}))
    record.rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')
    check = Check(
        id='p-2', thread='t-1', author='dee', text='Reran it.', reply_to='p-1', outcome='holds', method='rerun'
    )

    assert woken(record, check) == {'ada', 'bo'}


def test_the_persons_words_reach_watchers_or_everyone() -> None:
    to_watchers = Message(id='p-2', thread='t-1', author='person', text='Try the 5090s.')
    own_thread = lab().thread('t-2', opened_by='person')
    own_thread.post(Message(id='p-1', thread='t-2', author='person', text='A new direction.'))

    assert woken(started(), to_watchers) == {'ada'}
    assert woken(started().watch('ada', 't-1', watching=False), to_watchers) == {'ada', 'bo', 'cy'}
    assert woken(started(), to_watchers.model_copy(update={'mentions': ('bo',)})) == {'bo', 'ada'}
    assert woken(own_thread, Message(id='p-2', thread='t-2', author='bo', text='On it.')) == {'ada', 'cy'}


def test_an_update_holds_the_agents_posts_and_lists_the_rest(record: RecordBuilder) -> None:
    seen = record.board().seq
    record.join('dee').thread('t-2', opened_by='cy')
    record.post(Message(id='p-1', thread='t-2', author='cy', text='New idea.', mentions=('ada',)))
    record.post(Message(id='p-2', thread='t-1', author='cy', text='Using your baseline.', mentions=('bo',)))
    record.post(Message(id='p-3', thread='t-1', author='bo', text='Thanks.'))

    latest = update(record.board(), 'bo', after=seen)

    assert latest.seq == record.board().seq
    assert [entry.post.id for entry in latest.posts] == ['p-2']
    assert [(line.id, line.thread, line.author, line.text) for line in latest.others] == [
        ('p-1', 't-2', 'cy', 'New idea.')
    ]
    assert [thread.id for thread in latest.threads] == ['t-2']
    assert [agent.id for agent in latest.agents] == ['dee']
    assert latest.other_posts == 1


def test_an_update_says_when_the_lab_ends(record: RecordBuilder) -> None:
    ends_at = record.at(6) + timedelta(hours=1)

    assert update(record.board(), 'bo', after=0).ends_at is None
    assert update(record.time_set(ends_at).board(), 'bo', after=0).ends_at == ends_at


def test_news_has_one_line_for_each_unseen_post_and_says_which_are_for_the_agent() -> None:
    record = started()
    seen = record.board().seq
    record.post(Objection(id='p-2', thread='t-1', author='bo', text='Leak.', reply_to='p-1'))
    record.post(Message(id='p-3', thread='t-1', author='ada', text='Checking.'))
    record.thread('t-2', opened_by='bo')
    record.post(Message(id='p-4', thread='t-2', author='bo', text='Which seeds?', mentions=('cy',)))

    unseen = news(record.board(), 'ada', after=seen)

    assert [(line.id, line.thread, line.kind, line.reply_to) for line in unseen.for_you] == [
        ('p-2', 't-1', 'objection', 'p-1')
    ]
    assert [(line.id, line.author, line.text) for line in unseen.others] == [('p-4', 'bo', 'Which seeds?')]
    assert unseen.left_out == 0
    assert news(record.board(), 'ada', after=record.board().seq) == news(lab().board(), 'ada', after=0)


def test_news_keeps_the_newest_posts_and_counts_the_ones_that_it_leaves_out() -> None:
    record = started()
    for number in range(2, MAX_NEWS + 4):
        record.post(Message(id=f'p-{number}', thread='t-1', author='bo', text=f'Note {number}.'))

    unseen = news(record.board(), 'cy', after=0)

    assert [line.id for line in unseen.for_you] == ['p-1']
    assert [line.id for line in unseen.others] == [f'p-{number}' for number in range(4, MAX_NEWS + 4)]
    assert unseen.left_out == 2
