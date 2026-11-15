from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab
from pydantic import TypeAdapter

from verifold.protocol.events import AgentLeft, Event, QuestionRevised
from verifold.protocol.join import News
from verifold.protocol.moves import (
    AddMove,
    Move,
    PermissionMove,
    QuestionMove,
    RemoveMove,
    SettingMove,
    TimeMove,
)
from verifold.protocol.posts import Answer, Ask, Close, Message, Plan, Post, Proposal
from verifold.protocol.threads import Thread
from verifold.society.attention import wakes, watches_thread
from verifold.society.coordinator import joined_by, permission_choice, time_given, undo_of
from verifold.society.errors import RejectedEvent
from verifold.society.fold import fold
from verifold.society.lifecycle import lab_state
from verifold.society.lines import lines_of
from verifold.society.standing import waits_for_person
from verifold.society.views import brief, needs_person, post_view, thread_summaries

MORE = TimeMove(minutes=120)
END = START + timedelta(hours=8)


def talk() -> RecordBuilder:
    """The lab from `builders.lab` with a time limit, ada as its coordinator, and the conversation as t-2."""
    record = lab().time_set(END).coordinator('ada')
    return record.thread('t-2', opened_by='person', title='The person and the coordinator', conversation=True)


def woken(record: RecordBuilder, post: Post) -> set[str]:
    board = record.post(post).board()
    return {joined.agent.id for joined in board.agents if wakes(board, joined.agent.id, board.posts[-1])}


def refused(record: RecordBuilder, match: str) -> None:
    with pytest.raises(RejectedEvent, match=match):
        record.board()


def test_a_record_from_before_the_conversation_loads_and_has_no_conversation_and_no_power() -> None:
    board = lab().coordinator('ada').board()

    assert (board.conversation, board.powers, board.answers, board.power_sets) == (None, frozenset(), (), ())
    # The records of that time hold none of the new fields.
    old = Thread.model_validate({'id': 't-1', 'title': 'Subject', 'opened_by': 'ada'})
    assert (old.conversation, old.for_person) == (False, False)
    message = Message.model_validate({'id': 'p-1', 'thread': 't-1', 'author': 'ada', 'text': 'Hi'})
    assert not message.for_person
    left = AgentLeft.model_validate({'seq': 2, 'at': '2026-11-06T12:00:00Z', 'agent': 'ada', 'by': 'person'})
    assert left.through is None
    revised = QuestionRevised.model_validate(
        {'seq': 2, 'at': '2026-11-06T12:00:00Z', 'question': 'Is it stable?', 'post': 'p-2'}
    )
    assert revised.by == 'person'
    brief_of = brief(board, 'bo', News(seq=board.seq))
    assert (brief_of.conversation, brief_of.powers) == (None, ())


def test_a_lab_has_one_conversation_which_the_person_or_the_coordinator_opens() -> None:
    assert talk().board().conversation == 't-2'
    by_holder = lab().coordinator('ada').thread('t-2', opened_by='ada', conversation=True)
    assert by_holder.board().conversation == 't-2'

    refused(talk().thread('t-3', opened_by='ada', conversation=True), 'has its conversation with the person already')
    refused(lab().thread('t-2', opened_by='person', conversation=True), 'open their conversation')
    refused(lab().coordinator('ada').thread('t-2', opened_by='bo', conversation=True), 'open their conversation')
    side = lab().coordinator('ada').thread('t-2', opened_by='ada', between=('ada', 'bo'), conversation=True)
    refused(side, 'is no side thread')


def test_the_persons_words_in_the_conversation_are_for_the_coordinator_and_for_nobody_else() -> None:
    said = Message(id='p-1', thread='t-2', author='person', text='Where are we?')
    reply = Message(id='p-2', thread='t-2', author='ada', text='Two lines are alive.')
    names = Message(id='p-2', thread='t-2', author='ada', text='I asked Bo for the depth run.')

    assert woken(talk(), said) == {'ada'}
    # On call, the coordinator still hears the person there.
    assert woken(talk().on_call('ada'), said) == {'ada'}
    assert woken(talk().post(said), reply) == set()
    # A name reaches its agent as in any thread.
    assert woken(talk().post(said), names) == {'bo'}
    board = talk().post(said).board()
    assert watches_thread(board, 'ada', 't-2')
    assert not watches_thread(board, 'bo', 't-2')
    # An agent that says so with `watch` hears the thread.
    assert woken(talk().watch('cy', 't-2'), said) == {'ada', 'cy'}


def test_the_conversation_goes_on_with_the_agent_that_holds_the_seat_now() -> None:
    said = Message(id='p-1', thread='t-2', author='person', text='Where are we?')

    assert woken(talk().coordinator('bo'), said) == {'bo'}
    assert woken(talk().coordinator(None), said) == set()
    assert woken(talk().leave('ada'), said) == set()


def test_the_conversation_is_talk_beside_the_work_and_opens_no_closed_lab() -> None:
    record = talk()
    record.post(Close(id='p-1', thread='t-1', author='ada', text='It holds.'))
    record.post(Answer(id='p-2', thread='t-1', author='bo', text='Yes.', reply_to='p-1', accepts=True))
    record.post(Message(id='p-3', thread='t-2', author='person', text='Thanks.'))
    record.post(Plan(id='p-4', thread='t-2', author='ada', text='I write the report.'))

    board = record.board()

    assert lab_state(board) == 'closed'
    assert lines_of(board) == {}
    summary = next(one for one in thread_summaries(board, 'bo') if one.thread.id == 't-2')
    assert summary.team == ()
    refused(talk().post(Proposal(id='p-1', thread='t-2', author='ada', text='The answer.')), 'is the conversation')
    refused(talk().post(Close(id='p-1', thread='t-2', author='ada', text='Done.')), 'is the conversation')


def test_only_the_coordinator_marks_a_post_or_a_thread_as_one_for_the_person() -> None:
    def started() -> RecordBuilder:
        return talk().post(Message(id='p-1', thread='t-1', author='ada', text='The first post of the thread.'))

    steer = Message(id='p-2', thread='t-1', author='ada', text='The person cares about size.', for_person=True)
    forged = steer.model_copy(update={'author': 'bo'})

    # It reaches every agent that is not on call, as the person's own post does.
    assert woken(started().on_call('cy'), steer) == {'bo'}
    assert woken(started().on_call('cy'), steer.model_copy(update={'for_person': False})) == set()
    assert woken(started(), steer.model_copy(update={'mentions': ('bo',)})) == {'bo'}
    refused(started().post(forged), 'Only the agent that holds the coordinator seat marks a post')
    refused(started().coordinator('bo').post(steer), 'Only the agent that holds the coordinator seat marks a post')
    refused(lab().post(forged.model_copy(update={'id': 'p-1'})), 'Only the agent that holds the coordinator seat')

    opened = talk().thread('t-3', opened_by='ada', for_person=True).board()
    assert opened.threads[-1].thread.for_person
    refused(talk().thread('t-3', opened_by='bo', for_person=True), 'opens a thread for the person')
    refused(lab().thread('t-2', opened_by='ada', for_person=True), 'opens a thread for the person')


def test_a_post_for_the_person_does_not_open_a_closed_lab_again() -> None:
    record = talk()
    record.post(Close(id='p-1', thread='t-1', author='bo', text='It holds.'))
    record.post(Answer(id='p-2', thread='t-1', author='cy', text='Yes.', reply_to='p-1', accepts=True))
    record.post(Message(id='p-3', thread='t-1', author='ada', text='One more look.', for_person=True))

    assert lab_state(record.board()) == 'closed'


def test_only_the_coordinator_asks_for_a_move_and_only_in_the_conversation() -> None:
    board = talk().request('p-1', 'ada', MORE).board()

    view = post_view(board, board.posts[-1])
    assert (view.waits, view.decision) == (True, None)
    assert [item.post.id for item in needs_person(board)] == ['p-1']
    refused(talk().request('p-1', 'bo', MORE), 'Only the agent that holds the coordinator seat asks')
    refused(talk().request('p-1', 'ada', MORE, thread_id='t-1'), 'is a post in the conversation')
    refused(talk().coordinator(None).request('p-1', 'ada', MORE), 'Only the agent that holds the coordinator seat')


@pytest.mark.parametrize(
    ('move', 'why'),
    [
        (RemoveMove(agent='ada'), '`leave` removes the agent that calls it'),
        (RemoveMove(agent='zed'), 'zed is not an agent with a seat'),
        (RemoveMove(agent='dee'), 'dee is not an agent with a seat'),
        (RemoveMove(agent='cy'), 'cy left this lab already'),
        (PermissionMove(ask='p-9', option='once'), 'p-9 is no permission request'),
        (PermissionMove(ask='p-1', option='once'), 'Only the person answers the request'),
        (
            PermissionMove(ask='p-2', option='maybe'),
            'no answer with the ID `maybe`. Its answers: `once`, `always`, `no`',
        ),
        (PermissionMove(ask='p-2', option='always'), 'only the person picks it'),
        (PermissionMove(ask='p-3', option='once'), 'waits for no answer now'),
    ],
)
def test_a_request_names_a_move_that_the_board_can_take(move: Move, why: str) -> None:
    record = talk().leave('cy').permission('p-1', 'ada').permission('p-2', 'bo').permission('p-3', 'bo')
    record.post(Answer(id='p-4', thread='t-1', author='person', text='Reject', reply_to='p-3', choice='Reject'))
    record.join('dee', checks='p-1')

    refused(record.request('p-5', 'ada', move), why)


def test_a_lab_without_a_time_limit_takes_no_request_for_more_time() -> None:
    record = lab().coordinator('ada').thread('t-2', opened_by='ada', conversation=True)

    refused(record.request('p-1', 'ada', MORE), 'has no time limit')


def test_the_person_answers_a_request_once_and_nobody_else_does_without_a_power() -> None:
    asked = talk().request('p-1', 'ada', MORE)

    yes = RecordBuilder(events=list(asked.events)).answered('p-1', minutes=90).board()
    no = RecordBuilder(events=list(asked.events)).answered('p-1', yes=False).board()

    assert (yes.answer_to('p-1'), no.answer_to('p-1')) == (yes.answers[-1], no.answers[-1])
    assert not post_view(no, no.posts[-1]).waits
    assert needs_person(no) == ()
    refused(RecordBuilder(events=list(asked.events)).answered('p-1').answered('p-1'), 'has its answer already')
    refused(RecordBuilder(events=list(asked.events)).answered('p-9'), 'p-9 is no request for a move')
    refused(RecordBuilder(events=list(asked.events)).answered('p-1', by='ada'), 'The person answers a request')
    refused(RecordBuilder(events=list(asked.events)).answered('p-1', by='bo'), 'The person answers a request')
    refused(RecordBuilder(events=list(asked.events)).answered('p-1', yes=False, minutes=5), 'names minutes')
    other = talk().request('p-1', 'ada', RemoveMove(agent='bo')).answered('p-1', minutes=5)
    refused(other, 'names minutes')


def test_a_request_ends_when_its_author_holds_the_seat_no_longer() -> None:
    asked = talk().request('p-1', 'ada', MORE).coordinator('bo')

    board = asked.board()

    assert not post_view(board, board.posts[-1]).waits
    assert needs_person(board) == ()
    refused(RecordBuilder(events=list(asked.events)).answered('p-1'), 'ada holds the coordinator seat no longer')
    # The person can still say no to it.
    assert RecordBuilder(events=list(asked.events)).answered('p-1', yes=False).board().answers


def test_a_yes_needs_a_move_that_the_board_can_still_take() -> None:
    asked = talk().request('p-1', 'ada', RemoveMove(agent='bo')).leave('bo')

    refused(asked.answered('p-1'), 'bo left this lab already')


def test_a_power_is_the_persons_switch_for_the_agent_that_holds_the_seat() -> None:
    record = talk().power('time', 'ada').power('agents', 'ada').power('agents', 'ada', on=False)

    board = record.board()

    assert board.powers == frozenset({'time'})
    assert brief(board, 'bo', News(seq=board.seq)).powers == ('time',)
    refused(talk().power('time', 'bo'), 'A power is for the agent that holds the coordinator seat')
    refused(lab().power('time', 'ada'), 'A power is for the agent that holds the coordinator seat')


@pytest.mark.parametrize('change', ['given', 'cleared', 'given up', 'left', 'removed'])
def test_every_power_is_off_when_the_seat_changes(change: str) -> None:
    record = talk().power('time', 'ada')
    match change:
        case 'given':
            record.coordinator('bo')
        case 'cleared':
            record.coordinator(None)
        case 'given up':
            record.coordinator(None, by='ada')
        case 'left':
            record.leave('ada')
        case _:
            record.leave('ada', by='person')

    assert record.board().powers == frozenset()
    if change in ('given up', 'left'):
        # An agent that takes the free seat by itself gets no power with it, and the old holder's stay off.
        taken = record.coordinator('bo', by='bo').board()
        assert (taken.coordinator, taken.powers) == ('bo', frozenset())
    if change == 'given':
        # The seat comes back to the first holder without the power that it had.
        assert record.coordinator('ada').board().powers == frozenset()


def test_with_a_power_the_coordinators_own_yes_makes_the_move_and_no_other_agents_does() -> None:
    record = talk().power('time', 'ada').request('p-1', 'ada', MORE)

    board = RecordBuilder(events=list(record.events)).answered('p-1', by='ada').board()

    assert (board.answers[-1].by, board.answers[-1].yes) == ('ada', True)
    refused(RecordBuilder(events=list(record.events)).answered('p-1', by='bo'), 'The person answers a request')
    refused(RecordBuilder(events=list(record.events)).answered('p-1', by='ada', yes=False), 'only with a yes')
    # The power covers its own kind of move only.
    other = talk().power('time', 'ada').request('p-1', 'ada', RemoveMove(agent='bo'))
    refused(other.answered('p-1', by='ada'), 'The person answers a request')
    # A power that the person switched off covers nothing.
    off = talk().power('time', 'ada').power('time', 'ada', on=False).request('p-1', 'ada', MORE)
    refused(off.answered('p-1', by='ada'), 'The person answers a request')
    # A new holder does not use the power of the holder before it.
    taken = talk().power('time', 'ada').coordinator('bo').request('p-1', 'bo', MORE)
    refused(taken.answered('p-1', by='bo'), 'The person answers a request')


def test_a_power_gives_no_time_to_a_lab_whose_time_ran_out() -> None:
    record = lab().time_set(START + timedelta(minutes=7)).coordinator('ada')
    record.thread('t-2', opened_by='ada', conversation=True).power('time', 'ada').request('p-1', 'ada', MORE)
    # The request came at minute 8, after the end, and the record does not say yet that the time ran out.
    past = RecordBuilder(events=list(record.events))
    out = RecordBuilder(events=list(record.events)).ran_out()

    refused(past.answered('p-1', by='ada'), "The lab's time ran out, so only the person gives it more time")
    refused(out.answered('p-1', by='ada'), "The lab's time ran out, so only the person gives it more time")
    assert record.answered('p-1').board().answers[-1].by == 'person'


def carried(by: str, request: str = 'p-2', choice: str = 'Allow once') -> Answer:
    return Answer(id='p-3', thread='t-1', author=by, text=choice, reply_to='p-1', choice=choice, for_request=request)


def test_only_the_yes_to_a_request_decides_another_agents_permission_request() -> None:
    asked = talk().permission('p-1', 'bo').request('p-2', 'ada', PermissionMove(ask='p-1', option='once'))

    yes = RecordBuilder(events=list(asked.events)).answered('p-2').post(carried('person')).board()

    assert not waits_for_person(yes, 'p-1')
    assert permission_choice(asked.board(), PermissionMove(ask='p-1', option='no'), 'ada') == 'Reject'
    # No agent decides the request with an answer of its own: not without a yes, and not after another yes.
    forge = 'Only the yes to a request for a move decides a permission request'
    refused(RecordBuilder(events=list(asked.events)).post(carried('ada')), forge)
    refused(RecordBuilder(events=list(asked.events)).post(carried('bo')), forge)
    refused(RecordBuilder(events=list(asked.events)).answered('p-2').post(carried('ada')), forge)
    refused(RecordBuilder(events=list(asked.events)).answered('p-2', yes=False).post(carried('person')), forge)
    late = RecordBuilder(events=list(asked.events)).answered('p-2').watch('bo', 't-1').post(carried('person'))
    refused(late, forge)
    wrong = RecordBuilder(events=list(asked.events)).answered('p-2').post(carried('person', choice='Reject'))
    refused(wrong, 'p-2 picks another answer')
    # An agent's plain answer decides nothing, as before.
    plain = Answer(id='p-3', thread='t-1', author='ada', text='Allow once', reply_to='p-1', choice='Allow once')
    assert waits_for_person(RecordBuilder(events=list(asked.events)).post(plain).board(), 'p-1')


def test_with_the_power_the_coordinators_answer_decides_a_permission_request_and_shows_who_answered() -> None:
    record = talk().power('permissions', 'ada').permission('p-1', 'bo')
    record.request('p-2', 'ada', PermissionMove(ask='p-1', option='once')).answered('p-2', by='ada')

    board = record.post(carried('ada')).board()

    assert not waits_for_person(board, 'p-1')
    answer = board.posts[-1].post
    assert isinstance(answer, Answer)
    assert (answer.author, answer.for_request) == ('ada', 'p-2')


def test_only_the_coordinators_own_yes_removes_an_agent_through_the_coordinator() -> None:
    record = talk().power('agents', 'ada').request('p-1', 'ada', RemoveMove(agent='bo'))
    through = AgentLeft(seq=1, at=START, agent='bo', by='person', through='ada')

    def removed(record: RecordBuilder, left: AgentLeft) -> RecordBuilder:
        seq, at = record._stamp()
        record.events.append(left.model_copy(update={'seq': seq, 'at': at}))
        return record

    board = removed(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), through).board()

    assert (board.left[-1].through, board.gone('bo')) == ('ada', board.left[-1])
    why = 'ada removes bo only with its own request'
    refused(removed(RecordBuilder(events=list(record.events)), through), why)
    refused(removed(RecordBuilder(events=list(record.events)).answered('p-1'), through), why)
    refused(removed(talk().power('agents', 'ada'), through), why)
    other = through.model_copy(update={'agent': 'cy'})
    refused(removed(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), other), 'ada removes cy only')
    own = through.model_copy(update={'by': 'bo'})
    refused(removed(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), own), why)


def revision(record: RecordBuilder, by: str, question: str = 'Is it stable?', *, marked: bool = True) -> RecordBuilder:
    record.post(Message(id='p-2', thread='t-1', author=by, text=f'Revised: {question}', for_person=marked))
    seq, at = record._stamp()
    record.events.append(QuestionRevised(seq=seq, at=at, question=question, post='p-2', by=by))
    return record


def test_only_the_coordinators_own_yes_revises_the_question_for_the_person() -> None:
    record = talk().power('question', 'ada').request('p-1', 'ada', QuestionMove(question='Is it stable?'))

    board = revision(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), 'ada').board()

    assert (board.question, board.revisions[-1].by) == ('Is it stable?', 'ada')
    why = 'ada revises the question only with its own request'
    refused(revision(RecordBuilder(events=list(record.events)), 'ada'), why)
    refused(revision(RecordBuilder(events=list(record.events)).answered('p-1'), 'ada'), why)
    refused(revision(talk().power('question', 'ada'), 'ada'), why)
    other = revision(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), 'ada', 'Is it fast?')
    refused(other, why)
    plain = revision(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), 'ada', marked=False)
    refused(plain, why)
    late = RecordBuilder(events=list(record.events)).answered('p-1', by='ada').watch('bo', 't-1').watch('cy', 't-1')
    refused(revision(late, 'ada'), why)
    # Another agent's post never tells the lab of a revision.
    forged = RecordBuilder(events=list(record.events)).answered('p-1', by='ada')
    forged.post(Message(id='p-2', thread='t-1', author='bo', text='Revised.'))
    seq, at = forged._stamp()
    forged.events.append(QuestionRevised(seq=seq, at=at, question='Is it stable?', post='p-2', by='ada'))
    refused(forged, 'is not the post of the person that tells the lab')


def test_an_ask_of_an_agent_in_the_conversation_waits_for_the_person() -> None:
    record = talk().post(Ask(id='p-1', thread='t-2', author='ada', text='Size or floor?', choices=('Size', 'Floor')))

    board = record.board()

    assert [item.post.id for item in needs_person(board)] == ['p-1']
    # The other agents do not read it as an ask to them.
    assert brief(board, 'bo', News(seq=board.seq)).open_asks == ()
    assert brief(board, 'bo', News(seq=board.seq)).conversation == 't-2'
    answered = record.post(Answer(id='p-2', thread='t-2', author='person', text='Size', reply_to='p-1'))
    assert needs_person(answered.board()) == ()


def test_the_way_back_from_a_move_is_there_while_the_code_can_take_it() -> None:
    record = talk().request('p-1', 'ada', MORE).answered('p-1').time_set(END + timedelta(minutes=120))
    record.request('p-2', 'ada', AddMove(seat={'harness': 'fake'})).answered('p-2').join('dee')
    record.request('p-3', 'ada', SettingMove(key='jobs.at_exit', value='keep')).answered('p-3')

    board = record.board()
    time, add, setting = board.answers

    assert time_given(board, time) == board.times[-1]
    assert (undo_of(board, time), undo_of(board, add), undo_of(board, setting)) == (
        'take_minutes',
        'remove_agent',
        None,
    )
    assert (joined_by(board, add), joined_by(board, time)) == ('dee', None)
    # A later change of the lab's time, and the leaving of the agent, take the way back away.
    later = record.time_set(END).leave('dee').board()
    assert (undo_of(later, time), undo_of(later, add)) == (None, None)


def test_the_record_replays_to_the_same_board() -> None:
    record = talk().power('permissions', 'ada').power('agents', 'ada').permission('p-1', 'bo')
    record.request('p-2', 'ada', PermissionMove(ask='p-1', option='once')).answered('p-2', by='ada')
    record.post(carried('ada'))
    record.post(Message(id='p-4', thread='t-1', author='ada', text='The person wants size.', for_person=True))
    record.request('p-5', 'ada', MORE).answered('p-5', yes=False)
    events = TypeAdapter(list[Event])

    again = events.validate_json(events.dump_json(record.events))

    assert again == record.events
    assert fold(again) == record.board()
