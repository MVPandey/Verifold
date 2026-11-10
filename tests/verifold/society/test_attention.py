from datetime import timedelta

import pytest
from builders import RecordBuilder, lab

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import AgentJoined
from verifold.protocol.join import MAX_NEWS, News
from verifold.protocol.posts import Ask, Check, FileEvidence, Message, Objection, Post, Proposal, Result
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


def test_an_ask_that_names_nobody_wakes_every_agent_so_a_stuck_agent_reaches_the_whole_lab() -> None:
    stuck = Ask(id='p-2', thread='t-1', author='bo', text='The probe stays at chance. What am I missing?')

    assert woken(started(), stuck) == {'ada', 'cy'}
    assert woken(started(), stuck.model_copy(update={'mentions': ('cy',)})) == {'ada', 'cy'}
    assert woken(started().watch('ada', 't-1', watching=False), stuck.model_copy(update={'mentions': ('cy',)})) == {
        'cy'
    }


def test_an_ask_to_the_person_or_in_reply_to_a_post_is_not_for_every_agent() -> None:
    quiet = started().watch('ada', 't-1', watching=False)
    ask = Ask(id='p-2', thread='t-1', author='bo', text='Rent a GPU?')

    assert woken(quiet, ask.model_copy(update={'mentions': ('person',)})) == set()
    assert woken(started(), ask.model_copy(update={'text': 'Which seed?', 'reply_to': 'p-1'})) == {'ada'}


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


def numbered() -> RecordBuilder:
    """A lab whose agents have the IDs and the display names that Verifold gives: `agent-1` and "Agent 1"."""
    record = RecordBuilder()
    for number in (1, 2, 12):
        agent = Agent(id=f'agent-{number}', name=f'Agent {number}', harness='fake', model=ModelSpec(family='test'))
        record.events.append(AgentJoined(seq=len(record.events) + 1, at=record.at(len(record.events) + 1), agent=agent))
    record.thread('t-1', opened_by='agent-2')
    return record.post(Message(id='p-1', thread='t-1', author='agent-2', text='Start.', mentions=('person',)))


@pytest.mark.parametrize(
    ('text', 'named'),
    [
        ('Agent 12 found it.', {'agent-12'}),
        ('I build on what Agent 1 measured.', {'agent-1'}),
        ('agent-1: please check p-1.', {'agent-1'}),
        ('Agent 1/Agent 12: please rerun.', {'agent-1', 'agent-12'}),
        ('Agent 2 here. The agent 1 run is slow.', set()),
        ('See .verifold/agents/agent-1/out.json and ../agent-12/pack.py.', set()),
        ('No names here.', set()),
    ],
)
def test_a_name_matches_whole_with_its_capitals_and_an_id_matches_outside_a_path(text: str, named: set[str]) -> None:
    assert woken(numbered(), Message(id='p-2', thread='t-1', author='agent-2', text=text)) == named


@pytest.mark.parametrize(
    'text',
    ['Agent 2 result: the sweep is done.', 'This confirms what Agent 1 measured.', 'A new idea.'],
)
def test_a_name_in_the_text_never_keeps_the_first_post_of_a_thread_from_the_other_agents(text: str) -> None:
    opener = Message(id='p-2', thread='t-2', author='agent-2', text=text)
    to_one = opener.model_copy(update={'mentions': ('agent-1',)})

    assert woken(numbered().thread('t-2', opened_by='agent-2'), opener) == {'agent-1', 'agent-12'}
    assert woken(numbered().thread('t-2', opened_by='agent-2'), to_one) == {'agent-1'}


def test_the_persons_words_with_a_name_in_them_still_reach_every_agent_when_nobody_watches() -> None:
    record = numbered().watch('agent-2', 't-1', watching=False)
    stop = Message(id='p-2', thread='t-1', author='person', text='Agent 2 is right. Everybody stop.')

    assert woken(record, stop) == {'agent-1', 'agent-2', 'agent-12'}


def checked() -> RecordBuilder:
    """The lab with ada's result, a rerun that bo asked for, and the blind checker dee."""
    record = lab().post(RESULT.model_copy(update={'evidence': (FileEvidence(path='a.json', commit='c' * 40),)}))
    return record.rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')


@pytest.mark.parametrize(
    'post',
    [
        Proposal(id='p-2', thread='t-1', author='bo', text='The answer: it holds.'),
        Message(id='p-2', thread='t-2', author='cy', text='A new thread that names nobody.'),
        Message(id='p-2', thread='t-1', author='ada', text='Dee, how far are you?', mentions=('dee',)),
        Message(id='p-2', thread='t-2', author='person', text='Stop the sweep.'),
    ],
)
def test_no_post_wakes_a_blind_checker(post: Post) -> None:
    record = checked().thread('t-2', opened_by='person')

    assert 'dee' not in woken(record, post)
    assert update(record.board(), 'dee', after=0).posts == ()


def test_the_persons_words_reach_every_agent_when_only_a_blind_checker_is_in_the_thread() -> None:
    record = checked()
    record.post(
        Check(id='p-2', thread='t-1', author='dee', text='So.', reply_to='p-1', outcome='holds', method='rerun')
    )
    record.watch('ada', 't-1', watching=False)

    assert woken(record, Message(id='p-3', thread='t-1', author='person', text='Try the 5090s.')) == {'ada', 'bo', 'cy'}


def test_a_check_wakes_the_author_and_the_agent_that_asked_for_the_rerun() -> None:
    record = checked()
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
    board = record.board()

    unseen = news(board, 'ada', after=seen)

    assert [(line.id, line.thread, line.kind, line.reply_to) for line in unseen.for_you] == [
        ('p-2', 't-1', 'objection', 'p-1')
    ]
    assert [(line.id, line.author, line.text) for line in unseen.others] == [('p-4', 'bo', 'Which seeds?')]
    assert (unseen.seq, unseen.more, unseen.left_out) == (board.seq, 0, 0)
    assert news(board, 'ada', after=board.seq) == News(seq=board.seq)


def test_news_keeps_the_newest_of_the_other_posts_and_counts_the_ones_that_it_leaves_out() -> None:
    record = started()
    for number in range(2, MAX_NEWS + 4):
        record.post(Message(id=f'p-{number}', thread='t-1', author='bo', text=f'Note {number}.'))

    unseen = news(record.board(), 'cy', after=0)

    assert [line.id for line in unseen.for_you] == ['p-1']
    assert [line.id for line in unseen.others] == [f'p-{number}' for number in range(4, MAX_NEWS + 4)]
    assert (unseen.left_out, unseen.more, unseen.seq) == (2, 0, record.board().seq)


def test_news_never_leaves_out_a_post_for_the_agent_and_brings_the_rest_with_the_next_read() -> None:
    record = started()
    record.post(Ask(id='p-2', thread='t-1', author='bo', text='Which layer?', mentions=('ada',)))
    for number in range(3, MAX_NEWS + 9):
        record.post(Message(id=f'p-{number}', thread='t-1', author='bo', text=f'Note {number}.'))
    board = record.board()

    first = news(board, 'ada', after=0)
    second = news(board, 'ada', after=first.seq)
    waited = update(board, 'ada', after=0)

    assert [line.id for line in first.for_you] == [f'p-{number}' for number in range(2, MAX_NEWS + 2)]
    assert (first.more, first.seq) == (7, board.posts[MAX_NEWS].seq)
    assert [line.id for line in second.for_you] == [f'p-{number}' for number in range(MAX_NEWS + 2, MAX_NEWS + 9)]
    assert (second.more, second.seq) == (0, board.seq)
    assert ([entry.post.id for entry in waited.posts], waited.more, waited.seq) == (
        [line.id for line in first.for_you],
        7,
        first.seq,
    )


def test_an_update_that_stops_early_leaves_the_later_threads_and_agents_for_the_next_one() -> None:
    record = started()
    for number in range(2, MAX_NEWS + 3):
        record.post(Message(id=f'p-{number}', thread='t-1', author='bo', text=f'Note {number}.'))
    board = record.join('dee').thread('t-2', opened_by='cy').board()

    first = update(board, 'ada', after=0)
    second = update(board, 'ada', after=first.seq)

    assert (first.more, [agent.id for agent in first.agents], first.threads) == (1, ['bo', 'cy'], ())
    assert ([agent.id for agent in second.agents], [thread.id for thread in second.threads]) == (['dee'], ['t-2'])
