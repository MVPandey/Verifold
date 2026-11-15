from pathlib import Path

import pytest
from builders import RecordBuilder

from verifold.protocol.events import (
    AlarmSet,
    Event,
    Posted,
    ProfileSet,
    RerunRequested,
    ThreadOpened,
    WatchSet,
)
from verifold.protocol.join import LeftLine, News
from verifold.protocol.posts import Answer, Ask, Call, Close, FileEvidence, Message, Plan, Result
from verifold.protocol.threads import Thread
from verifold.runner.messages import start_message
from verifold.society.attention import gone_named, news, update, wakes
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply
from verifold.society.lifecycle import close_count, lab_state, pending_alarm
from verifold.society.lines import lines_of
from verifold.society.standing import agreed, closing, is_answered, is_open_call, takers
from verifold.society.views import brief, needs_person, thread_summaries

FILES = (FileEvidence(path='bench.json', commit='c' * 40),)


def test_the_board_knows_who_left_who_caused_it_and_why(record: RecordBuilder) -> None:
    record.leave('bo', reason='  My line is\nruled out. ').leave('cy', by='person')
    board = record.board()

    bo, cy = board.left
    assert (bo.agent, bo.by, bo.reason) == ('bo', 'bo', 'My line is ruled out.')
    assert (cy.agent, cy.by, cy.reason) == ('cy', 'person', '')
    assert (board.gone('bo'), board.gone('cy'), board.gone('ada')) == (bo, cy, None)
    assert [board.here(joined) for joined in board.agents] == [True, False, False]


@pytest.mark.parametrize(
    ('agent_id', 'by', 'reason'),
    [
        ('zed', 'zed', 'zed is not an agent in this lab'),
        ('bo', 'bo', 'bo left this lab'),
        ('dee', 'person', 'A blind checker is gone after its one check'),
        ('cy', 'ada', 'Only cy itself or the person'),
    ],
)
def test_only_an_agent_of_the_lab_leaves_once_by_its_own_word_or_the_persons(
    record: RecordBuilder, agent_id: str, by: str, reason: str
) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='11.8x.', evidence=FILES))
    record.join('dee', family='google', checks='p-1').leave('bo')

    with pytest.raises(RejectedEvent, match=reason):
        record.leave(agent_id, by=by).board()


def test_the_record_takes_nothing_more_from_an_agent_that_left_but_the_others_still_answer_it(
    record: RecordBuilder,
) -> None:
    record.post(Result(id='p-1', thread='t-1', author='bo', text='11.8x.', evidence=FILES)).leave('bo')
    board = record.board()
    seq, at = board.seq + 1, record.at(board.seq + 1)
    writes: tuple[Event, ...] = (
        Posted(seq=seq, at=at, post=Message(id='p-2', thread='t-1', author='bo', text='One more thing.')),
        ThreadOpened(seq=seq, at=at, thread=Thread(id='t-2', title='A new line', opened_by='bo')),
        WatchSet(seq=seq, at=at, agent='bo', thread='t-1', watching=True),
        AlarmSet(seq=seq, at=at, agent='bo', minutes=5),
        ProfileSet(seq=seq, at=at, agent='bo', status='Back.'),
        RerunRequested(seq=seq, at=at, by='bo', post='p-1'),
    )

    for write in writes:
        with pytest.raises(RejectedEvent, match='bo left this lab, so the board takes no post and no other change'):
            apply(board, write)
    # Its posts stay. Another agent can name it, reply to its post, and ask for a rerun, and its last turn ends.
    record.post(Message(id='p-2', thread='t-1', author='ada', text='Thanks, bo.', reply_to='p-1', mentions=('bo',)))
    record.rerun('ada', 'p-1').turn('bo')
    assert record.board().post('p-1') is not None


def test_no_post_wakes_an_agent_that_left_and_its_alarm_never_rings(record: RecordBuilder) -> None:
    seq = len(record.events) + 1
    record.events.append(AlarmSet(seq=seq, at=record.at(seq), agent='bo', minutes=10))
    record.turn('bo')
    assert pending_alarm(record.board(), 'bo') is not None

    record.leave('bo', by='person')
    record.post(Ask(id='p-1', thread='t-1', author='ada', text='Bo, which layer?', mentions=('bo',)))
    record.post(Ask(id='p-2', thread='t-1', author='ada', text='Does anybody know the seed?'))
    board = record.board()

    assert pending_alarm(board, 'bo') is None
    assert [wakes(board, 'bo', entry) for entry in board.posts] == [False, False]
    assert [wakes(board, 'cy', entry) for entry in board.posts] == [False, True]
    assert update(board, 'bo', 0).posts == ()


def test_a_lab_whose_remaining_agents_stand_behind_a_close_is_closed(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    assert lab_state(record.board()) == 'closing'

    # Cy never agreed. Without it, one of two agents stands behind the close, which is not more than half.
    record.leave('cy')
    assert lab_state(record.board()) == 'closing'
    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    assert lab_state(record.board()) == 'closed'


def test_the_last_agent_of_a_lab_closes_it_alone(record: RecordBuilder) -> None:
    record.leave('bo').leave('cy', by='person')
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))

    assert lab_state(record.board()) == 'closed'


def test_a_closed_lab_stays_closed_while_the_agents_behind_the_close_leave(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    closed = record.board()
    done = closing(closed)
    assert done is not None
    assert (lab_state(closed), close_count(closed, done)) == ('closed', (2, 3))

    # Each agent that stood behind the close keeps its word when it leaves, so two of three still stand behind it.
    for agent in ('bo', 'ada'):
        record.leave(agent)
        board = record.board()
        assert (lab_state(board), agreed(board, done), close_count(board, done)) == ('closed', ('bo',), (2, 3))

    # Cy never stood behind it. When it leaves too, nobody is in the lab, and the close has every word that counts.
    record.leave('cy', by='person')
    assert (lab_state(record.board()), close_count(record.board(), done)) == ('closed', (2, 2))


def test_a_close_that_every_agent_left_is_closed_whoever_stood_behind_it(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    record.leave('bo').leave('cy')
    assert lab_state(record.board()) == 'closed'

    record.leave('ada')
    board = record.board()
    done = closing(board)
    assert done is not None
    assert (lab_state(board), close_count(board, done)) == ('closed', (1, 1))


def test_a_close_whose_author_left_stands_and_another_agent_replaces_it_with_its_own(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.')).leave('ada', by='person')
    # The author's word is kept: one of three stands behind the close.
    assert (lab_state(record.board()), closing(record.board()) is not None) == ('closing', True)

    record.post(Close(id='p-2', thread='t-1', author='bo', text='Done, and the tail is in.'))
    board = record.board()
    done = closing(board)
    assert done is not None
    # Ada did not stand behind the new close, so it counts on neither side of it.
    assert (done.post.id, lab_state(board), close_count(board, done)) == ('p-2', 'closing', (1, 2))
    record.post(Answer(id='p-3', thread='t-1', author='cy', text='Agreed.', reply_to='p-2', accepts=True))
    assert lab_state(record.board()) == 'closed'


def test_a_close_stays_with_its_author_while_the_author_is_in_the_lab_and_a_closed_lab_takes_no_other_close(
    record: RecordBuilder,
) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    with pytest.raises(RejectedEvent, match='ada says in p-1 that the lab is done'):
        record.post(Close(id='p-2', thread='t-1', author='bo', text='Done.')).board()
    record.events.pop()

    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    record.leave('ada')
    with pytest.raises(RejectedEvent) as refused:
        record.post(Close(id='p-3', thread='t-1', author='cy', text='Done.')).board()
    record.events.pop()

    # The text names no agent that is gone, and the lab stays closed.
    assert str(refused.value) == (
        'The lab is closed already: more than half of its agents stood behind p-1. It takes no other close.'
    )
    assert lab_state(record.board()) == 'closed'


def test_a_brief_and_a_start_message_leave_out_an_agent_that_left_and_the_brief_says_who_left(
    record: RecordBuilder,
) -> None:
    record.thread('t-2', opened_by='bo').post(Plan(id='p-1', thread='t-2', author='bo', text='Sweep the layers.'))
    before = record.board()
    assert (lines_of(before), thread_summaries(before, 'ada')[0].team) == ({'bo': 't-2'}, ('bo',))

    record.leave('bo', reason='Out of budget.')
    board = record.board()
    view = brief(board, 'ada', News(seq=board.seq))
    cy = board.agents[2].agent

    assert [line.id for line in view.agents] == ['cy']
    assert view.left == (LeftLine(id='bo', name='Bo', by='bo', reason='Out of budget.'),)
    # It works nowhere now, so its thread has no team.
    assert (lines_of(board), thread_summaries(board, 'ada')[0].team) == ({}, ())
    assert 'these agents work in it: Ada (ada, fake).' in start_message(board, cy, Path('LAB.md'), under_way=True)


def test_an_update_does_not_announce_an_agent_that_left_already(record: RecordBuilder) -> None:
    joined = record.board().seq
    record.join('dee').join('eve').leave('dee')

    assert [agent.id for agent in update(record.board(), 'ada', joined).agents] == ['eve']


def test_an_ask_to_an_agent_that_left_stays_open_but_a_call_that_only_it_took_needs_an_agent_again(
    record: RecordBuilder,
) -> None:
    record.post(Call(id='p-1', thread='t-1', author='ada', text='The tail needs an agent.'))
    record.post(Plan(id='p-2', thread='t-1', author='bo', text='I take the tail.', reply_to='p-1'))
    record.post(Ask(id='p-3', thread='t-1', author='ada', text='Bo, which seed?', mentions=('bo',)))
    assert (takers(record.board(), 'p-1'), is_open_call(record.board(), 'p-1')) == (('bo',), False)

    record.leave('bo')
    board = record.board()
    view = brief(board, 'cy', News(seq=board.seq))

    assert (takers(board, 'p-1'), is_open_call(board, 'p-1'), is_answered(board, 'p-3')) == ((), True, False)
    assert ([line.id for line in view.open_calls], [line.id for line in view.open_asks]) == (['p-1'], ['p-3'])
    # Its plan stays on the board as it is.
    assert board.post('p-2') is not None

    # A second agent's plan keeps the call taken when the first leaves.
    record.post(Plan(id='p-4', thread='t-1', author='cy', text='I take it.', reply_to='p-1'))
    assert takers(record.board(), 'p-1') == ('cy',)


def test_nobody_waits_for_the_answer_to_an_ask_whose_author_left(record: RecordBuilder) -> None:
    record.post(Ask(id='p-1', thread='t-1', author='bo', text='May I use the GPU?', mentions=('person',)))
    record.post(Ask(id='p-2', thread='t-1', author='bo', text='Does anybody know the seed?'))
    record.post(Ask(id='p-3', thread='t-1', author='ada', text='Which layer?'))
    before = record.board()
    assert [view.post.id for view in needs_person(before)] == ['p-1']
    assert thread_summaries(before, 'cy')[0].open_asks == 3

    record.leave('bo', by='person')
    board = record.board()

    assert needs_person(board) == ()
    assert [line.id for line in brief(board, 'cy', News(seq=board.seq)).open_asks] == ['p-3']
    assert thread_summaries(board, 'cy')[0].open_asks == 1


def test_an_agent_that_left_is_news_for_the_agents_that_wrote_to_it(record: RecordBuilder) -> None:
    record.join('dee').join('eve')
    record.post(Result(id='p-1', thread='t-1', author='bo', text='11.8x.'))
    record.post(Ask(id='p-2', thread='t-1', author='ada', text='Which seed?', mentions=('bo',)))
    record.post(Message(id='p-3', thread='t-1', author='cy', text='I see 11.2x.', reply_to='p-1'))
    record.post(Message(id='p-4', thread='t-1', author='dee', text='Bo ran this on the old data.'))
    seen = record.board().seq
    record.leave('bo', reason='Out of budget.')
    board = record.board()
    line = LeftLine(id='bo', name='Bo', by='bo', reason='Out of budget.')

    # Ada named it, cy replied to it, and dee wrote its name. Eve wrote nothing to it.
    assert [update(board, agent, seen).left for agent in ('ada', 'cy', 'dee', 'eve')] == [(line,), (line,), (line,), ()]
    assert [news(board, agent, seen).left for agent in ('ada', 'eve', 'bo')] == [(line,), (), ()]
    # Each agent gets it once: a read from the departure on holds it no longer.
    assert update(board, 'ada', board.seq).left == ()
    # A post after it left still goes on the board, and its result can say that the agent is gone.
    record.post(Ask(id='p-5', thread='t-1', author='eve', text='Bo, are you there?', mentions=('bo', 'cy')))
    record.post(Message(id='p-6', thread='t-1', author='eve', text='Thanks.', reply_to='p-1'))
    after = record.board()
    assert [gone_named(after, entry.post) for entry in after.posts[-2:]] == [(line,), (line,)]
    assert gone_named(after, after.posts[1].post) == (line,)
    assert gone_named(after, after.posts[2].post.model_copy(update={'reply_to': None})) == ()
    assert update(after, 'eve', seen).left == ()
