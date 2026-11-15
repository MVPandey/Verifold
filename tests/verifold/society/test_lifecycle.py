from datetime import timedelta
from pathlib import Path

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.events import AlarmSet
from verifold.protocol.join import AlarmLine, News
from verifold.protocol.posts import Answer, Close, Message, Objection, Result, RuledOut
from verifold.runner.messages import start_message
from verifold.society.attention import news, update, wakes
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply
from verifold.society.lifecycle import alarm_line, lab_state, pending_alarm, rings_at
from verifold.society.lines import lines_of
from verifold.society.standing import agreed, closing
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


def set_alarm(
    record: RecordBuilder, minutes: float, *, quiet: bool = False, agent: str = 'bo', stays: bool = True
) -> AlarmSet:
    seq = len(record.events) + 1
    alarm = AlarmSet(seq=seq, at=record.at(seq), agent=agent, minutes=minutes, quiet=quiet, stays=stays)
    record.events.append(alarm)
    return alarm


def test_an_alarm_stays_until_it_rings_or_its_agent_replaces_or_cancels_it(record: RecordBuilder) -> None:
    assert (pending_alarm(record.board(), 'bo'), alarm_line(record.board(), 'bo')) == (None, None)
    first = set_alarm(record, 10)
    # It waits from the moment that the agent set it, in its turn too, so the agent can read it back.
    assert pending_alarm(record.board(), 'bo') == first
    assert pending_alarm(record.board(), 'ada') is None

    # A turn that starts and ends for another reason, such as a doorbell, does not spend it.
    record.turn('bo').start('bo', seen=0).turn('bo')
    board = record.board()
    assert pending_alarm(board, 'bo') == first
    assert alarm_line(board, 'bo') == AlarmLine(minutes=10, rings_at=first.at + timedelta(minutes=10))

    # A new alarm replaces it.
    second = set_alarm(record, 20, quiet=True)
    assert pending_alarm(record.board(), 'bo') == second

    # It rings 20 minutes after the newest post, and a new post moves that.
    assert rings_at(record.board(), second) == second.at + timedelta(minutes=20)
    record.post(Message(id='p-1', thread='t-1', author='ada', text='Still here.'))
    quiet_until = record.board().posts[-1].at + timedelta(minutes=20)
    assert rings_at(record.board(), second) == quiet_until
    assert alarm_line(record.board(), 'bo') == AlarmLine(minutes=20, quiet=True, rings_at=quiet_until)

    # The turn that starts with its ring spends it. The ring of an earlier alarm does not.
    record.start('bo', seen=0, rang=first.seq)
    assert pending_alarm(record.board(), 'bo') == second
    record.turn('bo').start('bo', seen=0, rang=second.seq)
    assert pending_alarm(record.board(), 'bo') is None

    # Zero minutes cancels one.
    set_alarm(record, 30)
    set_alarm(record, 0)
    assert (pending_alarm(record.board(), 'bo'), alarm_line(record.board(), 'bo')) == (None, None)


def test_an_agent_reads_its_alarm_in_its_brief_and_in_every_news(record: RecordBuilder) -> None:
    alarm = set_alarm(record, 15)
    board = record.board()
    line = AlarmLine(minutes=15, rings_at=alarm.at + timedelta(minutes=15))

    assert (news(board, 'bo', 0).alarm, update(board, 'bo', 0).alarm) == (line, line)
    assert (news(board, 'ada', 0).alarm, update(board, 'ada', 0).alarm) == (None, None)
    assert (brief(board, 'bo', News(seq=0)).your_alarm, brief(board, 'ada', News(seq=0)).your_alarm) == (line, None)

    # No alarm rings in a closed lab, so the alarm waits and has no time.
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    assert news(record.board(), 'bo', 0).alarm == AlarmLine(minutes=15, rings_at=None)


def test_an_alarm_has_no_time_while_the_lab_is_out_of_time(record: RecordBuilder) -> None:
    alarm = set_alarm(record, 15)
    record.time_set(record.at(len(record.events) + 1)).ran_out()
    assert record.board().out_of_time
    assert alarm_line(record.board(), 'bo') == AlarmLine(minutes=15, rings_at=None)

    # With more time, it has its time again.
    record.time_set(alarm.at + timedelta(hours=2))
    assert alarm_line(record.board(), 'bo') == AlarmLine(minutes=15, rings_at=alarm.at + timedelta(minutes=15))


def test_a_turn_starts_with_the_ring_of_an_alarm_of_its_own_agent_only(record: RecordBuilder) -> None:
    alarm = set_alarm(record, 15, agent='ada')
    for agent, rang in (('bo', alarm.seq), ('ada', 1), ('ada', alarm.seq + 5)):
        with pytest.raises(RejectedEvent, match=f'Event {rang} is no alarm of {agent}'):
            record.start(agent, seen=0, rang=rang).board()
        record.events.pop()
    assert record.start('ada', seen=0, rang=alarm.seq).board().starts[-1].rang == alarm.seq


def test_an_alarm_from_an_older_record_keeps_the_rule_of_its_time(record: RecordBuilder) -> None:
    # A record from before Verifold kept alarms across turns says of no alarm that it stays.
    old = AlarmSet.model_validate({'type': 'alarm_set', 'seq': 6, 'at': START, 'agent': 'bo', 'minutes': 10})
    assert not old.stays

    set_alarm(record, 10, stays=False)
    # The agent is still in its turn, so nothing waits yet.
    assert pending_alarm(record.board(), 'bo') is None
    set_alarm(record, 20, quiet=True, stays=False)
    record.turn('bo')
    waiting = pending_alarm(record.board(), 'bo')
    assert waiting is not None
    assert (waiting.minutes, waiting.quiet) == (20, True)

    # The start of the agent's next turn spends it, and so does that turn's end in a record without turn starts.
    assert pending_alarm(record.start('bo', seen=0).board(), 'bo') is None
    record.events.pop()
    assert pending_alarm(record.turn('bo').board(), 'bo') is None
    set_alarm(record, 30, stays=False)
    set_alarm(record, 0, stays=False)
    record.turn('bo')
    assert pending_alarm(record.board(), 'bo') is None


def test_a_blind_checker_and_an_unknown_agent_set_no_alarm() -> None:
    record = lab().post(Result(id='p-1', thread='t-1', author='ada', text='Holds.')).join('dee', checks='p-1')
    board = record.board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        apply(board, AlarmSet(seq=board.seq + 1, at=START, agent='zed', minutes=5))
    with pytest.raises(RejectedEvent, match='blind checker posts one check'):
        apply(board, AlarmSet(seq=board.seq + 1, at=START, agent='dee', minutes=5))


def test_only_an_agent_closes_the_lab_and_a_second_agent_agrees_instead_of_closing_again(record: RecordBuilder) -> None:
    with pytest.raises(RejectedEvent, match="agents' word"):
        record.post(Close(id='p-1', thread='t-1', author='person', text='Done.')).board()
    record.events.pop()

    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    with pytest.raises(RejectedEvent, match='ada says in p-1 that the lab is done'):
        record.post(Close(id='p-2', thread='t-1', author='bo', text='Done, I think.')).board()
    record.events.pop()
    # Its author can post a newer close, and the person's agreement counts for nothing.
    record.post(Answer(id='p-2', thread='t-1', author='person', text='Fine.', reply_to='p-1', accepts=True))
    record.post(Close(id='p-3', thread='t-1', author='ada', text='Done, with the open line named.'))
    done = closing(record.board())
    assert done is not None
    assert (done.post.id, agreed(record.board(), done), lab_state(record.board())) == ('p-3', (), 'closing')


def test_an_agent_takes_its_agreement_back_and_the_persons_words_open_the_lab_again(record: RecordBuilder) -> None:
    record.post(Close(id='p-1', thread='t-1', author='ada', text='Done.'))
    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True))
    assert lab_state(record.board()) == 'closed'

    record.post(Objection(id='p-3', thread='t-1', author='cy', text='You have not read line B.', reply_to='p-2'))
    record.post(Answer(id='p-4', thread='t-1', author='bo', text='True.', reply_to='p-3', accepts=True))
    assert lab_state(record.board()) == 'closing'

    record.post(Answer(id='p-5', thread='t-1', author='cy', text='Agreed after all.', reply_to='p-1', accepts=True))
    assert lab_state(record.board()) == 'closed'
    # A reply from the person changes nothing, and new words to the lab open it.
    record.post(Message(id='p-6', thread='t-1', author='person', text='Thanks.', reply_to='p-1'))
    assert lab_state(record.board()) == 'closed'
    record.post(Message(id='p-7', thread='t-1', author='person', text='Now try the weighted form.'))
    assert lab_state(record.board()) == 'open'


def test_a_close_is_no_work_in_a_thread_and_builds_on_nothing(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='bo')
    record.post(Result(id='p-1', thread='t-2', author='ada', text='Holds.'))
    record.post(Close(id='p-2', thread='t-2', author='ada', text='Done.', builds_on=('p-1',)))
    record.post(RuledOut(id='p-3', thread='t-2', author='ada', text='Not yet.', reply_to='p-2'))
    board = record.board()

    assert lines_of(board) == {'ada': 't-2'}
    assert [line.id for line in brief(board, 'cy', News(seq=0)).not_built_on] == ['p-1']


def test_an_invited_agent_counts_toward_a_close_only_when_it_posted_before_the_close() -> None:
    # Two agents, an invited agent that posted, and an invitation that nobody used yet.
    record = RecordBuilder().join('ada').join('bo').thread('t-1', opened_by='ada')
    record.join('guest', family='unknown', harness='guest').join('late', family='unknown', harness='guest')
    record.post(Message(id='p-1', thread='t-1', author='guest', text='I read the thread.'))
    record.post(Close(id='p-2', thread='t-1', author='ada', text='The answer stands.'))
    # One of three is not more than half. The unused invitation does not count.
    assert lab_state(record.board()) == 'closing'

    record.post(Answer(id='p-3', thread='t-1', author='bo', text='Agreed.', reply_to='p-2', accepts=True))
    assert lab_state(record.board()) == 'closed'

    # The first post of an invited agent after the close does not open a closed lab again.
    record.post(Message(id='p-4', thread='t-1', author='late', text='I am here now.'))
    assert lab_state(record.board()) == 'closed'

    # It counts for a later close: two of four is not more than half, and three of four is.
    record.post(Close(id='p-5', thread='t-1', author='ada', text='Done, again.'))
    record.post(Answer(id='p-6', thread='t-1', author='bo', text='Agreed.', reply_to='p-5', accepts=True))
    assert lab_state(record.board()) == 'closing'
    record.post(Answer(id='p-7', thread='t-1', author='late', text='Agreed.', reply_to='p-5', accepts=True))
    closed = record.board()
    done = closing(closed)
    assert done is not None
    assert (lab_state(closed), agreed(closed, done)) == ('closed', ('bo', 'late'))


def test_an_invited_agent_that_has_not_posted_is_no_peer_in_a_brief_an_update_or_a_start_message() -> None:
    record = RecordBuilder().join('ada').join('bo').thread('t-1', opened_by='ada')
    record.join('guest', family='unknown', harness='guest')
    unused = record.board()
    ada = unused.agents[0].agent

    assert [line.id for line in brief(unused, 'ada', News(seq=0)).agents] == ['bo']
    assert [agent.id for agent in update(unused, 'ada', 0).agents] == ['bo']
    assert 'Bo (bo, fake).' in start_message(unused, ada, Path('LAB.md'))
    assert 'guest' not in start_message(unused, ada, Path('LAB.md')).lower()

    came = record.post(Message(id='p-1', thread='t-1', author='guest', text='I am here.')).board()

    assert [line.id for line in brief(came, 'ada', News(seq=0)).agents] == ['bo', 'guest']
    assert [agent.id for agent in update(came, 'ada', 0).agents] == ['bo', 'guest']
    assert 'Bo (bo, fake), Guest (guest, guest).' in start_message(came, ada, Path('LAB.md'))
