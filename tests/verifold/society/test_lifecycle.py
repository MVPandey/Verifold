from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.events import AlarmSet
from verifold.protocol.join import News
from verifold.protocol.posts import Answer, Close, Message, Objection, Result, RuledOut
from verifold.society.attention import wakes
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply
from verifold.society.lifecycle import agreed, closing, lab_state, pending_alarm, rings_at
from verifold.society.views import brief


def test_the_lab_closes_when_more_than_half_of_its_agents_stand_behind_a_close(record: RecordBuilder) -> None:
    assert (lab_state(record.board()), closing(record.board())) == ('open', None)

    record.post(Close(id='p-1', thread='t-1', author='ada', text='The answer stands, and nothing is left.'))
    one = record.board()
    assert lab_state(one) == 'closing'
    # Whether the lab is done concerns every agent.
    assert all(wakes(one, agent, one.posts[-1]) for agent in ('bo', 'cy'))

    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    record.post(Answer(id='p-3', thread='t-1', author='bo', text='Agreed, again.', reply_to='p-1', accepts=True))
    closed = record.board()
    done = closing(closed)
    assert done is not None
    assert (lab_state(closed), agreed(closed, done)) == ('closed', ('bo',))
    view = brief(closed, 'cy', News(seq=0))
    assert (view.state, view.close and view.close.id, view.close_agreed) == ('closed', 'p-1', ('bo',))

    # An objection that stands opens the lab again.
    record.post(Objection(id='p-4', thread='t-1', author='cy', text='Line B is not checked.', reply_to='p-1'))
    assert (lab_state(record.board()), closing(record.board())) == ('open', None)


def test_a_close_takes_no_agreement_from_its_author_and_its_author_can_withdraw_it(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    own = Answer(id='p-2', thread='t-1', author='ada', text='I agree with myself.', reply_to='p-1', accepts=True)
    with pytest.raises(RejectedEvent, match='p-1 is your own'):
        record.post(own).board()
    record.events.pop()

    record.post(Message(id='p-2', thread='t-1', author='bo', text='Not sure yet.', reply_to='p-1'))
    assert lab_state(record.board()) == 'closing'
    record.post(RuledOut(id='p-3', thread='t-1', author='ada', text='Not yet: line B is open.', reply_to='p-1'))
    assert lab_state(record.board()) == 'open'


def test_an_alarm_waits_from_the_turn_in_which_the_agent_set_it_until_its_next_turn(record: RecordBuilder) -> None:
    def alarm(minutes: float, *, quiet: bool = False, agent: str = 'bo') -> None:
        seq = len(record.events) + 1
        record.events.append(AlarmSet(seq=seq, at=record.at(seq), agent=agent, minutes=minutes, quiet=quiet))

    alarm(10)
    # The agent is still in its turn, so nothing waits yet.
    assert pending_alarm(record.board(), 'bo') is None
    alarm(20, quiet=True)
    record.turn('bo')
    waiting = pending_alarm(record.board(), 'bo')
    assert waiting is not None
    assert (waiting.minutes, waiting.quiet) == (20, True)
    assert pending_alarm(record.board(), 'ada') is None

    # It rings 20 minutes after the newest post, and a new post moves that.
    assert rings_at(record.board(), waiting) == waiting.at + timedelta(minutes=20)
    record.post(Message(id='p-1', thread='t-1', author='ada', text='Still here.'))
    assert rings_at(record.board(), waiting) == record.board().posts[-1].at + timedelta(minutes=20)

    # The agent's next turn spends the alarm, and zero minutes cancels one.
    record.turn('bo')
    assert pending_alarm(record.board(), 'bo') is None
    alarm(30)
    alarm(0)
    record.turn('bo')
    assert pending_alarm(record.board(), 'bo') is None


def test_a_blind_checker_and_an_unknown_agent_set_no_alarm() -> None:
    record = lab().post(Result(id='p-1', thread='t-1', author='ada', text='Holds.')).join('dee', checks='p-1')
    board = record.board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        apply(board, AlarmSet(seq=board.seq + 1, at=START, agent='zed', minutes=5))
    with pytest.raises(RejectedEvent, match='blind checker posts one check'):
        apply(board, AlarmSet(seq=board.seq + 1, at=START, agent='dee', minutes=5))
