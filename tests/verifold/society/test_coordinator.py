from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab
from pydantic import TypeAdapter, ValidationError

from verifold.protocol.agents import Power
from verifold.protocol.events import AgentJoined, AgentLeft, Event, QuestionRevised, SettingsSet, TimeSet
from verifold.protocol.join import News
from verifold.protocol.moves import (
    AddMove,
    AddSeat,
    LabSetting,
    Move,
    PermissionMove,
    QuestionMove,
    RemoveMove,
    SettingMove,
    TimeMove,
)
from verifold.protocol.posts import Answer, Ask, Close, Message, Plan, Post, Proposal, Result
from verifold.protocol.settings import Settings
from verifold.protocol.threads import Thread
from verifold.society.attention import left_line, news, update, wakes, watches_thread
from verifold.society.coordinator import (
    joined_by,
    no_reply_line,
    permission_choice,
    time_given,
    undo_of,
    waiting_for_reply,
)
from verifold.society.errors import RejectedEvent
from verifold.society.fold import fold
from verifold.society.labels import awaits_model
from verifold.society.lifecycle import lab_state
from verifold.society.lines import lines_of
from verifold.society.names import model_words
from verifold.society.standing import waits_for_person
from verifold.society.views import brief, needs_person, post_view, thread_summaries, versions

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

    # The mark says whose wish the post is. Who hears the post is the business of the mark for the whole lab.
    assert woken(started().on_call('cy'), steer) == set()
    assert woken(started().on_call('cy'), steer.model_copy(update={'to_lab': True})) == {'bo'}
    assert woken(started(), steer.model_copy(update={'mentions': ('bo',)})) == {'bo'}
    wide = Message(id='p-1', thread='t-2', author='person', text='To everyone.', to_lab=True)
    refused(talk().post(wide), 'is the conversation with the person, and a post with `to_lab` is for the whole lab')
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

    view = post_view(board, board.posts[-1], 'person')
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
    assert not post_view(no, no.posts[-1], 'person').waits
    assert needs_person(no) == ()
    refused(RecordBuilder(events=list(asked.events)).answered('p-1').answered('p-1'), 'has its answer already')
    refused(RecordBuilder(events=list(asked.events)).answered('p-9'), 'p-9 is no request for a move')
    refused(RecordBuilder(events=list(asked.events)).answered('p-1', by='ada'), 'The person answers a request')
    refused(RecordBuilder(events=list(asked.events)).answered('p-1', by='bo'), 'The person answers a request')
    refused(RecordBuilder(events=list(asked.events)).answered('p-1', yes=False, minutes=5), 'names minutes')
    other = talk().request('p-1', 'ada', RemoveMove(agent='bo')).answered('p-1', minutes=5)
    refused(other, 'names minutes')


def test_a_request_ends_for_good_when_the_seat_changes_also_when_its_author_gets_the_seat_again() -> None:
    asked = talk().request('p-1', 'ada', MORE).coordinator('bo')

    board = asked.board()

    assert (post_view(board, board.posts[-1], 'person').waits, post_view(board, board.posts[-1], 'person').ended) == (
        False,
        'seat',
    )
    assert needs_person(board) == ()
    ended = 'The coordinator seat changed after ada asked, so its request p-1 ended'
    refused(RecordBuilder(events=list(asked.events)).answered('p-1'), ended)
    # An ended request takes no answer at all: a "no" is refused with the same sentence.
    refused(RecordBuilder(events=list(asked.events)).answered('p-1', yes=False), ended)
    # The seat comes back to ada. Her request from before stays ended, also for her power.
    back = RecordBuilder(events=list(asked.events)).coordinator('ada').power('time', 'ada')
    again = back.board()
    assert (post_view(again, again.posts[-1], 'person').waits, post_view(again, again.posts[-1], 'person').ended) == (
        False,
        'seat',
    )
    assert needs_person(again) == ()
    refused(RecordBuilder(events=list(back.events)).answered('p-1'), ended)
    refused(RecordBuilder(events=list(back.events)).answered('p-1', by='ada'), ended)
    # A request from the present holding of the seat waits.
    fresh = back.request('p-2', 'ada', MORE).board()
    assert [item.post.id for item in needs_person(fresh)] == ['p-2']


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


OVER = "The lab's time ran out or the person stopped the lab, so only the person makes a move now"


@pytest.mark.parametrize(
    ('power', 'move'),
    [
        ('time', MORE),
        ('agents', RemoveMove(agent='bo')),
        ('agents', AddMove(seat=AddSeat(harness='fake'))),
        ('settings', SettingMove(key='jobs.at_time_limit', value='stop')),
        ('question', QuestionMove(question='Is it stable?')),
        ('permissions', PermissionMove(ask='p-1', option='once')),
    ],
)
def test_no_power_covers_a_move_after_the_labs_time_ran_out_or_the_person_stopped_it(power: Power, move: Move) -> None:
    record = lab().time_set(START + timedelta(minutes=9)).coordinator('ada').permission('p-1', 'bo')
    record.thread('t-2', opened_by='ada', conversation=True).power(power, 'ada').request('p-2', 'ada', move)
    # The request came at minute 10, after the end, and the record does not say yet that the time ran out.
    past = RecordBuilder(events=list(record.events))
    out = RecordBuilder(events=list(record.events)).ran_out()

    refused(past.answered('p-2', by='ada'), OVER)
    refused(out.answered('p-2', by='ada'), OVER)
    # The request is on the board, and the person can still say yes to it.
    assert [item.post.id for item in needs_person(record.board())][-1] == 'p-2'
    assert record.answered('p-2').board().answers[-1].by == 'person'


def test_a_lab_that_the_person_stopped_takes_no_move_under_a_power() -> None:
    record = talk().power('settings', 'ada').power('time', 'ada')
    # The person stops the lab: its end is now.
    record.time_set(record.at(len(record.events) + 1))
    record.request('p-1', 'ada', SettingMove(key='jobs.at_time_limit', value='stop')).request('p-2', 'ada', MORE)

    refused(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), OVER)
    refused(RecordBuilder(events=list(record.events)).answered('p-2', by='ada'), OVER)


@pytest.mark.parametrize(('key', 'value'), [('jobs.at_time_limit', 'finish'), ('jobs.at_exit', 'keep')])
def test_the_settings_power_sets_no_value_that_lets_processes_run_on_after_a_stop(key: LabSetting, value: str) -> None:
    record = talk().power('settings', 'ada').request('p-1', 'ada', SettingMove(key=key, value=value))
    strict = talk().power('settings', 'ada').request('p-1', 'ada', SettingMove(key='jobs.at_time_limit', value='stop'))

    refused(RecordBuilder(events=list(record.events)).answered('p-1', by='ada'), "only the person's yes sets it")
    assert record.answered('p-1').board().answers[-1].by == 'person'
    assert strict.answered('p-1', by='ada').board().answers[-1].by == 'ada'


def carried(by: str, request: str = 'p-2', choice: str = 'Allow once') -> Answer:
    return Answer(id='p-3', thread='t-1', author=by, text=choice, reply_to='p-1', choice=choice, for_request=request)


def test_only_the_yes_to_a_request_decides_another_agents_permission_request() -> None:
    asked = talk().permission('p-1', 'bo').request('p-2', 'ada', PermissionMove(ask='p-1', option='once'))

    yes = RecordBuilder(events=list(asked.events)).answered('p-2').post(carried('person')).board()

    assert not waits_for_person(yes, 'p-1')
    assert permission_choice(asked.board(), PermissionMove(ask='p-1', option='no'), 'ada')[1] == 'Reject'
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


def removed(record: RecordBuilder, left: AgentLeft) -> RecordBuilder:
    seq, at = record._stamp()
    record.events.append(left.model_copy(update={'seq': seq, 'at': at}))
    return record


def test_a_removal_names_a_request_only_as_the_move_of_that_request_and_never_holds_the_coordinators_words() -> None:
    record = talk().power('agents', 'ada').request('p-1', 'ada', RemoveMove(agent='bo'))
    through = AgentLeft(seq=1, at=START, agent='bo', by='person', through='ada', request='p-1')
    approved = through.model_copy(update={'through': None})

    def after(*, by: str = 'ada', yes: bool = True) -> RecordBuilder:
        return RecordBuilder(events=list(record.events)).answered('p-1', by=by, yes=yes)

    powered = removed(after(), through).board()
    yes = removed(after(by='person'), approved).board()

    assert (powered.left[-1].through, powered.left[-1].request, powered.left[-1].reason) == ('ada', 'p-1', '')
    assert (yes.left[-1].through, yes.left[-1].request, yes.left[-1].by) == (None, 'p-1', 'person')
    line = left_line(yes, yes.left[-1])
    assert (line.by, line.through, line.request, line.reason) == ('person', None, 'p-1', '')
    why = 'A removal of bo names a request of the coordinator only as the move of that request'
    refused(removed(RecordBuilder(events=list(record.events)), through), why)
    refused(removed(talk().power('agents', 'ada'), through), why)
    # With the person's yes, the removal names no coordinator, and with the coordinator's own yes it names it.
    refused(removed(after(by='person'), through), why)
    refused(removed(after(), approved), why)
    refused(removed(after(yes=False, by='person'), approved), why)
    refused(removed(after(), through.model_copy(update={'request': None})), why)
    refused(removed(after(), through.model_copy(update={'agent': 'cy'})), 'A removal of cy names a request')
    refused(removed(after(), through.model_copy(update={'by': 'bo'})), why)
    # The coordinator's reason is in the request, so the removal carries none as the person's.
    worded = approved.model_copy(update={'reason': 'Bo repeats the same run.'})
    refused(removed(after(by='person'), worded), 'the removal has no reason of its own')


def revision(
    record: RecordBuilder,
    by: str,
    question: str = 'Is it stable?',
    *,
    marked: bool = True,
    request: str | None = 'p-1',
    note: str = '',
) -> RecordBuilder:
    told = Message(id='p-2', thread='t-1', author=by, text=f'Revised: {question}', for_person=marked and by != 'person')
    record.post(told)
    seq, at = record._stamp()
    record.events.append(
        QuestionRevised(seq=seq, at=at, question=question, post='p-2', by=by, request=request, note=note)
    )
    return record


def test_a_revision_names_a_request_only_as_the_move_of_that_request() -> None:
    record = (
        talk().power('question', 'ada').request('p-1', 'ada', QuestionMove(question='Is it stable?', note='Why not.'))
    )

    def after(*, by: str = 'ada', yes: bool = True) -> RecordBuilder:
        return RecordBuilder(events=list(record.events)).answered('p-1', by=by, yes=yes)

    powered = revision(after(), 'ada', note='Why not.').board()
    approved = revision(after(by='person'), 'person').board()

    assert (powered.question, powered.revisions[-1].by, powered.revisions[-1].request) == (
        'Is it stable?',
        'ada',
        'p-1',
    )
    assert (approved.revisions[-1].by, approved.revisions[-1].request, approved.revisions[-1].note) == (
        'person',
        'p-1',
        '',
    )
    # The views say who made each revision, and which request it came from.
    assert [(version.by, version.request) for version in versions(approved)] == [('person', None), ('person', 'p-1')]
    line = brief(powered, 'bo', News(seq=powered.seq)).revisions[-1]
    assert (line.by, line.request) == ('ada', 'p-1')
    why = 'A revision of the question names a request of the coordinator only as the move of that request'
    refused(revision(RecordBuilder(events=list(record.events)), 'ada'), why)
    refused(revision(after(by='person'), 'ada'), why)
    refused(revision(after(), 'person'), why)
    refused(revision(after(yes=False, by='person'), 'person'), why)
    refused(revision(talk().power('question', 'ada'), 'ada'), why)
    refused(revision(after(), 'ada', 'Is it fast?'), why)
    refused(revision(after(), 'ada', marked=False), why)
    refused(revision(after(), 'ada', request=None), why)
    # The person's revision at the coordinator's request carries no note: the reason is the coordinator's.
    refused(revision(after(by='person'), 'person', note='Why not.'), why)
    late = after().watch('bo', 't-1').watch('cy', 't-1')
    refused(revision(late, 'ada'), why)
    # Another agent's post never tells the lab of a revision.
    forged = after()
    forged.post(Message(id='p-2', thread='t-1', author='bo', text='Revised.'))
    seq, at = forged._stamp()
    forged.events.append(QuestionRevised(seq=seq, at=at, question='Is it stable?', post='p-2', by='ada', request='p-1'))
    refused(forged, 'is not the post of the person that tells the lab')


def test_the_agents_own_words_are_never_marked_as_the_persons() -> None:
    proposal = Proposal(id='p-1', thread='t-1', author='ada', text='The answer.', for_person=True)
    close = Close(id='p-1', thread='t-1', author='ada', text='Done.', for_person=True)

    refused(talk().post(proposal), "A proposal is the agents' own word")
    refused(talk().post(close), "A close is the agents' own word")
    # Every reader of the board can tell the coordinator's post on the person's behalf from the person's own.
    board = talk().post(Message(id='p-1', thread='t-1', author='ada', text='Size first.', for_person=True)).board()
    unseen = news(board, 'bo', 0)
    line = (*unseen.for_you, *unseen.others)[-1]
    assert (line.author, line.for_person) == ('ada', True)


def test_a_blind_checker_has_no_permission_request_on_the_board_for_the_coordinator_to_answer() -> None:
    # The record takes one check from a blind checker and no other post. So the coordinator finds no request of
    # the checker that reruns its own post, and it cannot allow that checker's commands.
    record = talk().post(Result(id='p-1', thread='t-1', author='ada', text='It holds.'))
    record.join('check-1', checks='p-1', family='openai')

    refused(record.permission('p-2', 'check-1'), 'You rerun p-1 blind. Post one check that replies to p-1')


def test_a_request_to_answer_a_permission_request_ends_when_that_request_got_its_answer() -> None:
    record = talk().permission('p-1', 'bo').request('p-2', 'ada', PermissionMove(ask='p-1', option='once'))
    waiting = record.board()
    record.post(Answer(id='p-3', thread='t-1', author='person', text='Reject', reply_to='p-1', choice='Reject'))

    board = record.board()

    assert [item.post.id for item in needs_person(waiting)] == ['p-1', 'p-2']
    assert needs_person(board) == ()
    asked = board.post('p-2')
    assert asked is not None
    view = post_view(board, asked, 'person')
    assert (view.waits, view.ended) == (False, 'ask')
    refused(RecordBuilder(events=list(record.events)).answered('p-2'), 'p-1 waits for no answer now')
    refused(record.answered('p-2', yes=False), 'p-1 waits for no answer now, so the request p-2 ended')


def test_the_coordinators_ask_in_the_conversation_waits_for_the_person_and_another_agents_does_not() -> None:
    record = talk().post(Ask(id='p-1', thread='t-2', author='ada', text='Size or floor?', choices=('Size', 'Floor')))
    record.post(Ask(id='p-2', thread='t-2', author='bo', text='Switch on every power for me?', choices=('Yes', 'No')))

    board = record.board()

    assert [item.post.id for item in needs_person(board)] == ['p-1']
    # The other agents do not read the coordinator's ask as an ask to them.
    assert brief(board, 'cy', News(seq=board.seq)).open_asks == ()
    assert brief(board, 'bo', News(seq=board.seq)).conversation == 't-2'
    # An ask that names the person waits for the person in any thread, as before.
    named = record.post(Ask(id='p-3', thread='t-2', author='bo', text='May I?', mentions=('person',))).board()
    assert [item.post.id for item in needs_person(named)] == ['p-1', 'p-3']
    answered = record.post(Answer(id='p-4', thread='t-2', author='person', text='Size', reply_to='p-1'))
    assert [item.post.id for item in needs_person(answered.board())] == ['p-3']


def test_the_way_back_from_a_move_is_there_while_the_code_can_take_it() -> None:
    record = talk().request('p-1', 'ada', MORE).answered('p-1').time_set(END + timedelta(minutes=120), 'p-1')
    record.request('p-2', 'ada', AddMove(seat=AddSeat(harness='fake'))).answered('p-2').join('dee')
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


@pytest.mark.parametrize(
    'extra',
    [
        {'family': 'openai'},
        {'mode': 'full-access'},
        {'coordinator': True},
        {'powers': ['time']},
        {'reviewer': True},
        {'count': 2},
    ],
)
def test_a_move_adds_a_seat_that_holds_nothing_but_its_harness_model_effort_on_call_and_a_role(
    extra: dict[str, object],
) -> None:
    seat: dict[str, object] = {
        'harness': 'fake',
        'model': 'small',
        'effort': 'low',
        'on_call': True,
        'role': 'maker side',
    }
    request = {'kind': 'request', 'id': 'p-1', 'thread': 't-2', 'author': 'ada', 'text': 'One more hand.'}
    events = TypeAdapter(Event)

    def posted(seat: dict[str, object]) -> dict[str, object]:
        post = request | {'move': {'type': 'add_agent', 'seat': seat}}
        return {'type': 'posted', 'seq': 9, 'at': '2026-11-06T12:08:00Z', 'post': post}

    assert AddSeat.model_validate(seat).role == 'maker side'
    assert events.validate_python(posted(seat)).seq == 9
    # The schema of the seat refuses the field, and so does a record that holds it.
    with pytest.raises(ValidationError, match=next(iter(extra))):
        AddSeat.model_validate(seat | extra)
    with pytest.raises(ValidationError, match=next(iter(extra))):
        events.validate_python(posted(seat | extra))


def test_a_new_end_or_new_settings_name_a_request_only_as_the_move_of_that_request() -> None:
    record = talk().request('p-1', 'ada', MORE).request('p-2', 'ada', SettingMove(key='jobs.at_exit', value='keep'))
    later = END + timedelta(minutes=120)

    def settings(record: RecordBuilder, request: str) -> RecordBuilder:
        seq, at = record._stamp()
        record.events.append(SettingsSet(seq=seq, at=at, settings=Settings(), request=request))
        return record

    given = RecordBuilder(events=list(record.events)).answered('p-1').time_set(later, 'p-1').board()
    changed = settings(RecordBuilder(events=list(record.events)).answered('p-2'), 'p-2').board()

    assert given.times[-1].request == 'p-1'  # ty: ignore[unresolved-attribute]
    assert changed.seq == len(record.events) + 2
    why = 'just after its yes, names that request'
    refused(RecordBuilder(events=list(record.events)).time_set(later, 'p-1'), why)
    refused(RecordBuilder(events=list(record.events)).answered('p-1', yes=False).time_set(later, 'p-1'), why)
    refused(RecordBuilder(events=list(record.events)).answered('p-2').time_set(later, 'p-2'), why)
    refused(RecordBuilder(events=list(record.events)).answered('p-1').watch('bo', 't-1').time_set(later, 'p-1'), why)
    refused(settings(RecordBuilder(events=list(record.events)), 'p-2'), why)
    refused(settings(RecordBuilder(events=list(record.events)).answered('p-1'), 'p-1'), why)
    # An event from before this field names no request, and it loads as it is.
    old = TimeSet.model_validate({'seq': 2, 'at': '2026-11-06T12:00:00Z', 'ends_at': '2026-11-06T13:00:00Z'})
    assert old.request is None


def test_a_former_coordinators_ask_to_the_person_stays_when_the_seat_changes() -> None:
    record = talk().post(Ask(id='p-1', thread='t-2', author='ada', text='Size or floor?')).coordinator('bo')

    board = record.board()

    assert [item.post.id for item in needs_person(board)] == ['p-1']
    assert board.coordinator_at(board.posts[-1].seq) == 'ada'
    # An ask of the new holder waits too, and an ask of an agent that never held the seat does not.
    record.post(Ask(id='p-2', thread='t-2', author='bo', text='How long?'))
    record.post(Ask(id='p-3', thread='t-2', author='cy', text='May I?'))
    assert [item.post.id for item in needs_person(record.board())] == ['p-1', 'p-2']


def test_an_unlisted_model_of_a_seat_that_a_move_added_reserves_no_name() -> None:
    record = talk().join('dee', name='Fake · model not listed')
    joined = record.events[-1]
    assert isinstance(joined, AgentJoined)
    spec = joined.agent.model.model_copy(update={'name': 'person'})
    unlisted = joined.agent.model_copy(update={'model': spec, 'model_listed': False})
    record.events[-1] = joined.model_copy(update={'agent': unlisted})
    listed = RecordBuilder(
        events=[
            *record.events[:-1],
            joined.model_copy(update={'agent': unlisted.model_copy(update={'model_listed': True})}),
        ]
    )

    assert 'person' not in model_words(record.board()).values()
    assert 'person' in model_words(listed.board()).values()
    assert awaits_model('Fake · model not listed', 'Fake')
    assert awaits_model('Fake · model not listed 2', 'Fake')


STATUS = Message(id='p-1', thread='t-2', author='person', text='Status update?', body='Where is the depth run?')
"""The person's message in the conversation of `talk`. It is event 9, at 12:08."""


def waiting(record: RecordBuilder) -> list[str]:
    return [entry.post.id for entry in waiting_for_reply(record.board())]


def test_the_persons_post_in_the_conversation_waits_for_a_reply_and_only_the_coordinators_brief_shows_it() -> None:
    board = talk().post(STATUS).board()
    now = board.posts[-1].at + timedelta(minutes=14, seconds=50)

    shown = brief(board, 'ada', news(board, 'ada', 0, now), now=now)
    waits = shown.person_waits

    assert [entry.post.id for entry in waiting_for_reply(board)] == ['p-1']
    assert waits is not None
    # The entry is short: the headline and no body. The news of the same brief holds the whole post.
    assert (waits.line.id, waits.line.text, waits.line.body, waits.minutes, waits.more) == (
        'p-1',
        'Status update?',
        '',
        14,
        0,
    )
    assert [line.body for line in shown.news.for_you] == ['Where is the depth run?']
    # The brief says it once: its news has no line of its own.
    assert shown.news.no_reply == ''
    assert shown.model_dump_json().count('for your reply') == 0
    line = "The person's post p-1 in the conversation has waited 14 minutes for your reply."
    assert news(board, 'ada', 0, now).no_reply == line
    assert update(board, 'ada', 0, now).no_reply == line
    assert news(board, 'ada', board.seq, now).no_reply == line
    # No other agent gets it, in its brief or in its news.
    for other in ('bo', 'cy'):
        assert brief(board, other, news(board, other, 0, now), now=now).person_waits is None
        assert (news(board, other, 0, now).no_reply, update(board, other, 0, now).no_reply) == ('', '')
    # Time counts from the newest post without a clock, and the line says so in words.
    assert no_reply_line(board, 'ada') == (
        "The person's post p-1 in the conversation has waited less than a minute for your reply."
    )
    assert no_reply_line(board, 'ada', board.posts[-1].at + timedelta(seconds=90)) == (
        "The person's post p-1 in the conversation has waited 1 minute for your reply."
    )


def test_any_post_of_the_coordinator_in_the_conversation_after_it_is_the_reply_and_no_other_post_is() -> None:
    said = talk().post(STATUS)

    # A post of the coordinator in another thread, or of another agent in the conversation, is no reply.
    assert waiting(said.copy().post(Message(id='p-2', thread='t-1', author='ada', text='Two lines are alive.'))) == [
        'p-1'
    ]
    assert waiting(said.copy().post(Message(id='p-2', thread='t-2', author='bo', text='I can answer that.'))) == ['p-1']
    # Any kind of post of the coordinator there is the reply: a message, an ask, or a request for a move.
    for reply in (
        Message(id='p-2', thread='t-2', author='ada', text='Two lines are alive.'),
        Ask(id='p-2', thread='t-2', author='ada', text='Depth or width first?'),
    ):
        replied = said.copy().post(reply)
        board = replied.board()
        assert waiting(replied) == []
        assert brief(board, 'ada', News(seq=board.seq)).person_waits is None
        assert news(board, 'ada', 0).no_reply == ''
    assert waiting(said.copy().request('p-2', 'ada', MORE)) == []
    # A reply comes after the post. The coordinator's post before it answers nothing.
    early = talk().post(Message(id='p-1', thread='t-2', author='ada', text='I hold the seat.'))
    assert waiting(early.post(STATUS.model_copy(update={'id': 'p-2'}))) == ['p-2']


def test_the_oldest_post_that_waits_comes_first_with_a_count_of_the_later_ones_and_one_reply_answers_all() -> None:
    record = talk().post(STATUS).post(Message(id='p-2', thread='t-2', author='person', text='Hello?'))
    board = record.board()
    now = board.posts[0].at + timedelta(minutes=20)

    waits = brief(board, 'ada', News(seq=board.seq), now=now).person_waits

    assert waits is not None
    assert (waits.line.id, waits.minutes, waits.more) == ('p-1', 20, 1)
    assert news(board, 'ada', board.seq, now).no_reply == (
        "The person's post p-1 in the conversation has waited 20 minutes for your reply. 1 later post of the "
        'person there waits too.'
    )
    record.post(Message(id='p-3', thread='t-2', author='person', text='Anyone?'))
    assert no_reply_line(record.board(), 'ada', now).endswith(' 2 later posts of the person there wait too.')
    record.post(Message(id='p-4', thread='t-2', author='ada', text='Two lines are alive.'))
    assert waiting(record) == []
    # A post of the person after the reply waits again, by itself.
    record.post(Message(id='p-5', thread='t-2', author='person', text='Which two?'))
    assert waiting(record) == ['p-5']


def test_the_reply_is_from_the_agent_that_holds_the_seat_when_it_posts_and_a_new_holder_reads_what_waits() -> None:
    reply = Message(id='p-2', thread='t-2', author='ada', text='Two lines are alive.')

    # The agent that held the seat answered before it gave the seat up.
    assert waiting(talk().post(STATUS).post(reply).coordinator('bo')) == []
    # Without a reply, the post waits for the new holder, and only its brief shows it.
    passed = talk().post(STATUS).coordinator('bo')
    board = passed.board()
    held = brief(board, 'bo', News(seq=board.seq)).person_waits
    assert held is not None
    assert held.line.id == 'p-1'
    assert brief(board, 'ada', News(seq=board.seq)).person_waits is None
    assert (news(board, 'bo', 0).no_reply != '', news(board, 'ada', 0).no_reply) == (True, '')
    # A post of the former holder after the change is no reply.
    assert waiting(passed.post(reply)) == ['p-1']


def test_a_lab_without_a_coordinator_or_a_conversation_shows_no_post_that_waits_and_an_old_record_loads() -> None:
    plain = lab().coordinator('ada').board()
    assert waiting_for_reply(plain) == ()
    assert brief(plain, 'ada', News(seq=plain.seq)).person_waits is None
    assert news(plain, 'ada', 0).no_reply == ''
    # The post waits while nobody holds the seat, and no agent reads it then: nobody is there to reply.
    for nobody in (talk().post(STATUS).coordinator(None), talk().post(STATUS).leave('ada')):
        board = nobody.board()
        assert waiting(nobody) == ['p-1']
        assert board.coordinator is None
        for agent in ('ada', 'bo', 'cy'):
            assert brief(board, agent, News(seq=board.seq)).person_waits is None
            assert news(board, agent, 0).no_reply == ''
    # A record from before keeps its events as they were: the fact comes from the posts, and no event holds it.
    old = TypeAdapter(Event).validate_json(
        '{"seq": 9, "at": "2026-11-06T12:08:00Z", "type": "posted", '
        '"post": {"kind": "message", "id": "p-1", "thread": "t-2", "author": "person", "text": "Status update?"}}'
    )
    record = talk()
    record.events.append(old)
    assert waiting(record) == ['p-1']
    # The news of a result from before this field reads as one without a post that waits.
    assert News.model_validate({'seq': 9}).no_reply == ''
