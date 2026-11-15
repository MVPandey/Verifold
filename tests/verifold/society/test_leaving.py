from pathlib import Path

import pytest
from builders import RecordBuilder

from verifold.protocol.events import (
    AgentLeft,
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
from verifold.society.attention import update, wakes
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply
from verifold.society.lifecycle import lab_state, pending_alarm
from verifold.society.lines import lines_of
from verifold.society.standing import agreed, closing, is_answered, is_open_call, takers
from verifold.society.views import brief, thread_summaries

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


def test_an_agreement_counts_no_longer_once_its_agent_left(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    closed = record.board()
    done = closing(closed)
    assert done is not None
    assert (lab_state(closed), agreed(closed, done)) == ('closed', ('bo',))

    # Ada and cy are the lab now, and cy has not agreed.
    record.leave('bo')
    assert (lab_state(record.board()), agreed(record.board(), done)) == ('closing', ())
    record.post(Answer(id='p-3', thread='t-1', author='cy', text='Agreed.', reply_to='p-1', accepts=True))
    assert lab_state(record.board()) == 'closed'


def test_a_close_whose_author_left_stands_but_its_author_is_not_behind_it(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.')).leave('ada', by='person')
    assert (lab_state(record.board()), closing(record.board()) is not None) == ('closing', True)

    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    assert lab_state(record.board()) == 'closing'
    record.post(Answer(id='p-3', thread='t-1', author='cy', text='Agreed.', reply_to='p-1', accepts=True))
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


def test_leaving_resolves_nothing_an_ask_to_the_agent_and_its_plan_and_its_taken_call_stay(
    record: RecordBuilder,
) -> None:
    record.post(Call(id='p-1', thread='t-1', author='ada', text='The tail needs an agent.'))
    record.post(Plan(id='p-2', thread='t-1', author='bo', text='I take the tail.', reply_to='p-1'))
    record.post(Ask(id='p-3', thread='t-1', author='ada', text='Bo, which seed?', mentions=('bo',)))
    record.leave('bo')
    board = record.board()

    assert (takers(board, 'p-1'), is_open_call(board, 'p-1'), is_answered(board, 'p-3')) == (('bo',), False, False)
    assert [line.id for line in brief(board, 'cy', News(seq=board.seq)).open_asks] == ['p-3']
    assert isinstance(board.left[0], AgentLeft)
