import pytest
from builders import RecordBuilder, lab

from verifold.protocol.events import TurnStarted
from verifold.protocol.join import News
from verifold.protocol.posts import Answer, Ask, Call, Check, Close, FileEvidence, Message, Plan, Post, Result
from verifold.society.attention import news, wakes, watches_thread
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import close_count, lab_state
from verifold.society.standing import standing
from verifold.society.views import brief

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Beats random on 10 of 10 prompts.')


def woken(record: RecordBuilder, post: Post) -> set[str]:
    board = record.post(post).board()
    return {joined.agent.id for joined in board.agents if wakes(board, joined.agent.id, board.posts[-1])}


def on_call() -> RecordBuilder:
    """The lab from `builders.lab` with ada's result in t-1, and cy on call."""
    return lab().post(RESULT).on_call('cy')


def test_a_record_from_before_seats_has_nobody_on_call_and_no_coordinator_and_keeps_its_names() -> None:
    board = lab().post(RESULT).board()

    assert [joined.agent.name for joined in board.agents] == ['Ada', 'Bo', 'Cy']
    assert [joined.agent.given_role for joined in board.agents] == ['', '', '']
    assert (board.coordinator, board.renames) == (None, ())
    assert not any(board.on_call(agent) for agent in ('ada', 'bo', 'cy'))
    # A turn from before Verifold kept the model has none.
    assert (
        TurnStarted.model_validate(
            {'seq': 2, 'at': '2026-11-06T12:00:00Z', 'agent': 'ada', 'session': 's', 'seen': 1}
        ).model
        is None
    )


def test_no_post_for_every_agent_wakes_an_on_call_agent() -> None:
    first = Message(id='p-2', thread='t-2', author='bo', text='A new line.')
    ask = Ask(id='p-2', thread='t-1', author='bo', text='Who knows the tail?')
    call = Call(id='p-2', thread='t-1', author='bo', text='The tail needs an agent.')
    steer = Message(id='p-2', thread='t-1', author='person', text='Look at the tail.')

    assert woken(on_call().thread('t-2', opened_by='bo'), first) == {'ada'}
    assert woken(on_call(), ask) == {'ada'}
    assert woken(on_call(), call) == {'ada'}
    assert woken(on_call(), steer) == {'ada', 'bo'}
    # Off call again, the agent hears what every agent hears.
    assert woken(on_call().on_call('cy', on_call=False), ask) == {'ada', 'cy'}


def test_an_on_call_agent_hears_a_post_that_names_it_replies_to_it_or_builds_on_its_post() -> None:
    named = Ask(id='p-2', thread='t-1', author='bo', text='A hard one.', mentions=('cy',))
    in_text = Message(id='p-2', thread='t-1', author='bo', text='Cy, is the bound tight?')
    by_person = Message(id='p-2', thread='t-1', author='person', text='What do you think?', mentions=('cy',))
    said = Message(id='p-2', thread='t-1', author='cy', text='The bound is loose.')
    reply = Answer(id='p-3', thread='t-1', author='bo', text='How loose?', reply_to='p-2')
    built = Result(id='p-3', thread='t-1', author='bo', text='A tighter bound.', builds_on=('p-2',))

    # Ada opened the thread, so she hears every post in it.
    assert woken(on_call(), named) == {'ada', 'cy'}
    assert 'cy' in woken(on_call(), in_text)
    assert woken(on_call(), by_person) == {'ada', 'cy'}
    assert 'cy' in woken(on_call().post(said), reply)
    assert 'cy' in woken(on_call().post(said), built)


def test_an_on_call_agent_watches_a_thread_only_by_its_own_word_or_as_a_member_of_a_side_thread() -> None:
    record = on_call().thread('t-2', opened_by='cy')
    record.post(Plan(id='p-2', thread='t-2', author='cy', text='I take the bound.'))
    later = Message(id='p-3', thread='t-2', author='bo', text='Reading your plan.')

    # Its own thread and its own plan do not make every post there wake it.
    assert not watches_thread(record.board(), 'cy', 't-2')
    assert 'cy' not in woken(RecordBuilder(events=list(record.events)), later)
    assert 'cy' in woken(RecordBuilder(events=list(record.events)).watch('cy', 't-2'), later)

    side = on_call().thread('t-2', opened_by='bo', between=('bo', 'cy'))
    assert watches_thread(side.board(), 'cy', 't-2')
    assert woken(side, Message(id='p-2', thread='t-2', author='bo', text='Between us.')) == {'cy'}


def test_an_on_call_agent_counts_for_a_close_and_hears_it_only_once_it_has_posted() -> None:
    close = Close(id='p-2', thread='t-1', author='ada', text='The answer stands.')
    quiet = on_call().post(close).board()
    done = quiet.posts[-1]

    # Two agents decide: the on-call agent never heard a post for every agent, so the lab does not wait for it.
    assert (close_count(quiet, done), wakes(quiet, 'cy', done), wakes(quiet, 'bo', done)) == ((1, 2), False, True)

    spoke = on_call().post(Message(id='p-2', thread='t-1', author='cy', text='The bound is loose.'))
    counted = spoke.post(close.model_copy(update={'id': 'p-3'})).board()
    assert (close_count(counted, counted.posts[-1]), wakes(counted, 'cy', counted.posts[-1])) == ((1, 3), True)
    # A post after the close changes nothing, by the rule for an invited agent.
    late = on_call().post(close).post(Message(id='p-3', thread='t-1', author='cy', text='Late.')).board()
    assert close_count(late, late.posts[0 - 2]) == (1, 2)
    assert lab_state(late) == 'closing'


def test_a_switch_of_a_seat_after_the_close_changes_neither_the_count_nor_whether_the_lab_is_closed() -> None:
    close = Close(id='p-2', thread='t-1', author='ada', text='The answer stands.')
    agreed = Answer(id='p-3', thread='t-1', author='bo', text='Agreed.', reply_to='p-1', accepts=True)

    # Two of three agents stand behind the close, with cy off call at the close. The lab is closed, and it stays
    # closed when the person puts cy on call or takes cy off call again.
    closed = lab().post(RESULT).post(close).post(agreed.model_copy(update={'reply_to': 'p-2'}))
    assert lab_state(closed.board()) == 'closed'
    assert lab_state(closed.on_call('cy').board()) == 'closed'
    assert close_count(closed.board(), closed.board().posts[1]) == (2, 3)

    # One of three agents stands behind the close. The lab is closing, and it does not become closed because the
    # person puts the two other agents on call after the close.
    closing = lab().post(RESULT).post(close)
    assert lab_state(closing.board()) == 'closing'
    assert lab_state(closing.on_call('bo').on_call('cy').board()) == 'closing'
    assert close_count(closing.board(), closing.board().posts[1]) == (1, 3)

    # With cy on call and silent at the close, two agents decide and one stands behind it. A lab that the two closed
    # stays closed when the person takes cy off call after the close.
    two = on_call().post(close).post(agreed.model_copy(update={'reply_to': 'p-2'}))
    assert (lab_state(two.board()), close_count(two.board(), two.board().posts[1])) == ('closed', (2, 2))
    off = two.on_call('cy', on_call=False).board()
    assert (lab_state(off), close_count(off, off.posts[1])) == ('closed', (2, 2))


def test_the_brief_says_who_is_on_call_who_coordinates_and_which_role_the_person_gave() -> None:
    record = on_call().coordinator('bo')
    board = record.board()

    view = brief(board, 'ada', News(seq=0))
    lines = {line.id: line for line in view.agents}

    assert view.coordinator == 'bo'
    assert (lines['cy'].on_call, lines['cy'].coordinator) == (True, False)
    assert (lines['bo'].on_call, lines['bo'].coordinator) == (False, True)
    # An on-call agent that has not posted is still a member that the others can call.
    assert set(lines) == {'bo', 'cy'}
    mine = brief(board, 'cy', News(seq=0)).your_line
    assert mine is not None
    assert (mine.on_call, mine.given_role) == (True, '')


def test_only_the_person_puts_a_seat_on_call_and_only_a_seat_in_the_lab() -> None:
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        lab().on_call('zed').board()
    with pytest.raises(RejectedEvent, match='cy left this lab'):
        lab().leave('cy').on_call('cy').board()
    with pytest.raises(RejectedEvent, match='blind checker has no seat'):
        lab().post(RESULT).join('dee', checks='p-1').on_call('dee').board()


def test_an_agent_takes_the_coordinator_seat_only_when_it_is_free_and_the_persons_choice_wins() -> None:
    taken = lab().coordinator('ada', by='ada')
    assert taken.board().coordinator == 'ada'

    with pytest.raises(RejectedEvent, match='ada is the coordinator of this lab'):
        lab().coordinator('ada', by='ada').coordinator('bo', by='bo').board()
    with pytest.raises(RejectedEvent, match='takes the coordinator seat for itself'):
        lab().coordinator('bo', by='ada').board()
    with pytest.raises(RejectedEvent, match='you have no seat to give up'):
        lab().coordinator('ada', by='ada').coordinator(None, by='bo').board()
    with pytest.raises(RejectedEvent, match='blind checker has no seat'):
        lab().post(RESULT).join('dee', checks='p-1').coordinator('dee').board()
    with pytest.raises(RejectedEvent, match='cy left this lab'):
        lab().leave('cy').coordinator('cy').board()

    # The person gives the seat to another agent, also while one holds it, and clears it.
    assert taken.coordinator('bo').board().coordinator == 'bo'
    assert taken.coordinator(None).board().coordinator is None
    # The holder gives the seat up, and then another agent takes it.
    free = lab().coordinator('ada').coordinator(None, by='ada')
    assert free.board().coordinator is None
    assert free.coordinator('cy', by='cy').board().coordinator == 'cy'


def test_a_coordinator_that_left_by_itself_leaves_the_seat_open_for_another_agent() -> None:
    record = lab().coordinator('ada').leave('ada')
    board = record.board()

    assert (board.coordinator, board.coordinator_open) == (None, True)
    assert record.coordinator('bo', by='bo').board().coordinator == 'bo'


def test_the_persons_clear_of_the_seat_holds_until_the_person_gives_or_opens_it() -> None:
    assert lab().board().coordinator_open
    cleared = lab().coordinator('ada', by='ada').coordinator(None)
    assert not cleared.board().coordinator_open
    assert not brief(cleared.board(), 'bo', News(seq=0)).coordinator_open

    # No agent takes the seat by itself after the person cleared it: not the agent that held it, and no other.
    for agent in ('ada', 'bo'):
        with pytest.raises(RejectedEvent, match='The person closed the coordinator seat'):
            RecordBuilder(events=list(cleared.events)).coordinator(agent, by=agent).board()
    # The person removed the holder, so the seat is closed in the same way.
    removed = lab().coordinator('ada').leave('ada', by='person')
    assert not removed.board().coordinator_open
    with pytest.raises(RejectedEvent, match='The person closed the coordinator seat'):
        removed.coordinator('bo', by='bo').board()

    # The person gives the seat to an agent, or opens it for the agents.
    given = RecordBuilder(events=list(cleared.events)).coordinator('cy')
    assert given.board().coordinator == 'cy'
    assert given.coordinator(None, by='cy').coordinator('bo', by='bo').board().coordinator == 'bo'
    opened = RecordBuilder(events=list(cleared.events)).coordinator(None, free=True)
    assert opened.board().coordinator_open
    assert opened.coordinator('bo', by='bo').board().coordinator == 'bo'


def test_an_agent_gets_the_name_of_its_model_once_known_and_a_post_reaches_it_under_both_names() -> None:
    record = RecordBuilder().join('agent-1', name='Codex · default model').join('agent-2', name='Codex · gpt-6')
    record.thread('t-1', opened_by='agent-2').post(RESULT.model_copy(update={'author': 'agent-2'}))
    old = Message(id='p-2', thread='t-1', author='agent-2', text='Codex · default model, look at this.')
    record.post(old).named('agent-1', 'Codex · gpt-6 2')
    board = record.board()

    assert [joined.agent.name for joined in board.agents] == ['Codex · gpt-6 2', 'Codex · gpt-6']
    assert [(event.name, before) for event, before in board.renames] == [('Codex · gpt-6 2', 'Codex · default model')]
    # The post from before the new name is still for the agent.
    assert [line.id for line in news(board, 'agent-1', 0).for_you] == ['p-1', 'p-2']
    with pytest.raises(RejectedEvent, match='Another agent has the name Codex · GPT-6'):
        RecordBuilder(events=list(record.events)).named('agent-1', 'Codex · GPT-6').board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        record.named('zed', 'Zed').board()


@pytest.mark.parametrize(
    ('text', 'named'),
    [
        ('Codex · gpt-6 2, please rerun.', {'agent-2'}),
        ('Codex · gpt-6, please rerun.', {'agent-1'}),
        ('Ask Codex · gpt-6 and Codex · gpt-6 2.', {'agent-1', 'agent-2'}),
        ('Claude Code · Opus 5.5 found it.', {'agent-3'}),
        ('(Claude Code · Opus 5.5)', {'agent-3'}),
        ('Claude Code · Opus 5.55 is another model.', set()),
        ('claude code · opus 5.5 in small letters is no name.', set()),
        ('Codex and Opus 5.5 are parts of names.', set()),
        ('agent-3 and AGENT-2 by their IDs.', {'agent-2', 'agent-3'}),
        # A name does not end inside a longer model name: a dot, a digit, or a hyphen goes on with the word.
        ('Codex · gpt-6.1-sol is not in this lab.', set()),
        ('Codex · gpt-6-mini and Codex · gpt-65 are other models.', set()),
        ('Claude Code · Opus 5.5.1 would be faster.', set()),
        ('Ask Opus Five · Opus 5.5 instead.', set()),
        ('Ask Opus Five · Opus 5.', {'agent-5'}),
        # The dot that ends a sentence ends a name too.
        ('I asked Codex · gpt-6. It agreed with Claude Code · Opus 5.5.', {'agent-1', 'agent-3'}),
        ('Codex · gpt-6: please rerun (Codex · gpt-6 2, you too).', {'agent-1', 'agent-2'}),
    ],
)
def test_a_full_name_with_spaces_and_a_dot_in_the_text_reaches_its_agent(text: str, named: set[str]) -> None:
    record = RecordBuilder().join('agent-1', name='Codex · gpt-6').join('agent-2', name='Codex · gpt-6 2')
    record.join('agent-3', name='Claude Code · Opus 5.5').join('agent-4', name='Agent 4')
    record.join('agent-5', name='Opus Five · Opus 5')
    record.thread('t-1', opened_by='agent-4').post(RESULT.model_copy(update={'author': 'agent-4'}))

    assert woken(record, Message(id='p-2', thread='t-1', author='agent-4', text=text)) == named


def test_a_rerun_holds_up_the_post_of_an_invited_agent_only_when_the_person_stated_its_family() -> None:
    evidence = (FileEvidence(path='out.json', commit='a' * 40),)

    def checked(family: str) -> str:
        record = lab().join('guest-1', family=family, harness='guest')
        record.post(RESULT.model_copy(update={'author': 'guest-1', 'evidence': evidence})).rerun('bo', 'p-1')
        record.join('dee', family='openai', checks='p-1')
        record.post(
            Check(id='p-2', thread='t-1', author='dee', text='Holds.', reply_to='p-1', outcome='holds', method='rerun')
        )
        return standing(record.board(), 'p-1')

    assert (checked('unknown'), checked('anthropic'), checked('openai')) == ('checked', 'held_up', 'checked')
    # A family is the same whatever its capitals and the spaces around it.
    assert (checked(' OpenAI '), checked('Anthropic')) == ('checked', 'held_up')


def test_a_name_from_before_that_another_agent_has_now_names_only_that_agent() -> None:
    record = (
        RecordBuilder().join('agent-1', name='Codex · default model').join('agent-2', name='Codex · default model 2')
    )
    record.thread('t-1', opened_by='agent-1').post(RESULT.model_copy(update={'author': 'agent-1'}))
    # The second agent's model was known first, and then the first agent took the name without a number.
    record.named('agent-2', 'Codex · gpt-6').named('agent-2', 'Codex · gpt-6 2').named('agent-1', 'Codex · gpt-6')
    record.join('agent-3', name='Agent 3')

    def named(text: str) -> set[str]:
        copy = RecordBuilder(events=list(record.events))
        return woken(copy, Message(id='p-2', thread='t-2', author='agent-3', text=text)) - {'agent-1'}

    record.thread('t-2', opened_by='agent-3').post(Message(id='p-9', thread='t-2', author='agent-3', text='Notes.'))
    assert woken(
        RecordBuilder(events=list(record.events)),
        Message(id='p-2', thread='t-2', author='agent-3', text='Codex · gpt-6?'),
    ) == {'agent-1'}
    assert named('Codex · gpt-6 2?') == {'agent-2'}
    assert named('Codex · default model 2?') == {'agent-2'}


def test_the_brief_says_why_an_agents_harness_failed_last() -> None:
    record = on_call().turn('cy', error='RequestError: The model fable-9 is not available.').turn('bo')
    lines = {line.id: line for line in brief(record.board(), 'ada', News(seq=0)).agents}

    assert (lines['cy'].error, lines['bo'].error) == ('RequestError: The model fable-9 is not available.', None)
