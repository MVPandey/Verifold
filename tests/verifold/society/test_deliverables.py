import pytest
from builders import RecordBuilder
from pydantic import ValidationError

from verifold.protocol.deliverables import MAX_DELIVERABLES, MAX_SENTENCE, DeliverableLine
from verifold.protocol.events import DeliverableDecided, DeliverableSet, Event, Posted, ThreadOpened
from verifold.protocol.join import News
from verifold.protocol.posts import (
    Answer,
    Ask,
    Check,
    Close,
    FileEvidence,
    FileOffer,
    Message,
    Objection,
    Proposal,
    Result,
)
from verifold.protocol.threads import QUESTION_TITLE, Thread
from verifold.society.attention import news, wakes
from verifold.society.deliverables import removed_lines, told_at
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply
from verifold.society.lifecycle import lab_state
from verifold.society.reruns import reruns_wanted
from verifold.society.views import brief, thread_view

ANSWER = 'A one-page answer that I can read in five minutes.'
SCRIPT = 'A script that runs the best strategy again on paper.'


def asked() -> RecordBuilder:
    """A lab with the question's thread `t-1`, one deliverable from the setup, and agents `ada`, `bo`, and `cy`."""
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE)
    record.post(Message(id='p-1', thread='t-1', author='person', text='Does it hold?'))
    return record.deliverable('d-1', ANSWER).join('ada').join('bo').join('cy', family='openai')


def lines(record: RecordBuilder) -> tuple[DeliverableLine, ...]:
    return brief(record.board(), 'ada', News(seq=0)).deliverables


def states(record: RecordBuilder) -> list[str]:
    return [line.state for line in lines(record)]


def refused(record: RecordBuilder, event: Event, match: str) -> None:
    with pytest.raises(RejectedEvent, match=match):
        apply(record.board(), event)


def stated(record: RecordBuilder, deliverable_id: str, text: str, **fields: object) -> DeliverableSet:
    seq = len(record.events) + 1
    return DeliverableSet.model_validate(
        {'seq': seq, 'at': record.at(seq), 'deliverable': deliverable_id, 'text': text} | fields
    )


def offered(record: RecordBuilder, author: str, thread: str, deliverable_id: str = 'd-1') -> Posted:
    seq = len(record.events) + 1
    post = FileOffer(
        id=f'p-{len(record.board().posts) + 1}',
        thread=thread,
        author=author,
        text='The files.',
        deliverable=deliverable_id,
        evidence=(FileEvidence(path='answer.md', commit='c' * 40),),
    )
    return Posted(seq=seq, at=record.at(seq), post=post)


def decided(record: RecordBuilder, decision: str, offer: str, post: str, deliverable_id: str = 'd-1') -> Event:
    seq = len(record.events) + 1
    return DeliverableDecided.model_validate(
        {
            'seq': seq,
            'at': record.at(seq),
            'deliverable': deliverable_id,
            'decision': decision,
            'offer': offer,
            'post': post,
        }
    )


def test_a_record_from_before_deliverables_has_none() -> None:
    board = RecordBuilder().join('ada').thread('t-1', opened_by='ada').board()

    assert (board.deliverables, board.decisions) == ((), ())
    assert brief(board, 'ada', News(seq=0)).deliverables == ()


def test_a_deliverable_is_one_printable_line_of_bounded_length() -> None:
    record = asked()

    assert stated(record, 'd-2', '  A list of\nwhat was\u202e ruled out. ').text == 'A list of what was ruled out.'
    for text in ('', ' \n ', '\u202e', 'x' * (MAX_SENTENCE + 1)):
        with pytest.raises(ValidationError):
            stated(record, 'd-2', text)
    with pytest.raises(ValidationError):
        stated(record, 'deliverable-2', SCRIPT)


def test_the_person_states_deliverables_without_a_post_only_before_the_first_agent_joins() -> None:
    record = asked()

    assert [(line.id, line.text, line.state, line.offers) for line in lines(record)] == [('d-1', ANSWER, 'none', ())]
    refused(record, stated(record, 'd-2', SCRIPT), 'comes with the post of the person')
    # A new sentence and a removal can come without a post: the agents read them in the brief.
    quiet = record.copy()
    quiet.deliverable('d-1', 'A two-page answer.').deliverable('d-1', 'A two-page answer.', removed=True)
    assert [entry.post for entry in quiet.board().deliverables] == [None, None, None]


def test_only_a_post_of_the_person_that_is_the_newest_carries_a_deliverable() -> None:
    record = asked().post(Message(id='p-2', thread='t-1', author='person', text=f'One more: {SCRIPT}'))

    # The post of an agent carries none, and neither does a post of the person that is not the board's newest.
    by_agent = record.copy().post(Message(id='p-3', thread='t-1', author='ada', text=f'One more: {SCRIPT}'))
    refused(by_agent, stated(by_agent, 'd-2', SCRIPT, post='p-3'), 'not the post of the person')
    refused(by_agent, stated(by_agent, 'd-2', SCRIPT, post='p-2'), 'not the post of the person')
    later = record.copy().watch('ada', 't-1')
    refused(later, stated(later, 'd-2', SCRIPT, post='p-2'), 'not the post of the person')
    refused(record, stated(record, 'd-2', SCRIPT, post='p-9'), 'not the post of the person')

    board = apply(record.board(), stated(record, 'd-2', SCRIPT, post='p-2'))
    assert [entry.deliverable for entry in board.deliverables] == ['d-1', 'd-2']


def test_a_new_deliverable_has_the_next_id_and_a_lab_holds_twenty_at_most() -> None:
    record = asked().post(Message(id='p-2', thread='t-1', author='person', text='One more.'))

    refused(record, stated(record, 'd-3', SCRIPT, post='p-2'), 'The next new one is d-2')
    refused(record, stated(record, 'd-2', SCRIPT, post='p-2', removed=True), 'no deliverable d-2')

    full = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE)
    for number in range(1, MAX_DELIVERABLES + 1):
        full.deliverable(f'd-{number}', f'File {number}.')
    refused(full, stated(full, f'd-{MAX_DELIVERABLES + 1}', 'One too many.'), '20 deliverables at most')
    # A removed deliverable does not count.
    full.deliverable('d-1', 'File 1.', removed=True).deliverable(f'd-{MAX_DELIVERABLES + 1}', 'It fits now.')
    assert len(lines(full.join('ada'))) == MAX_DELIVERABLES


def test_the_record_keeps_every_sentence_and_the_board_shows_the_newest() -> None:
    record = asked().deliverable('d-1', 'A two-page answer.', 'p-2').deliverable('d-2', SCRIPT, 'p-3')

    assert [(entry.deliverable, entry.text) for entry in record.board().deliverables] == [
        ('d-1', ANSWER),
        ('d-1', 'A two-page answer.'),
        ('d-2', SCRIPT),
    ]
    assert [(line.id, line.text) for line in lines(record)] == [('d-1', 'A two-page answer.'), ('d-2', SCRIPT)]
    same = record.post(Message(id='p-4', thread='t-1', author='person', text='Again.'))
    refused(same, stated(same, 'd-2', SCRIPT, post='p-4'), 'has this sentence already')


def test_a_removed_deliverable_leaves_the_list_and_does_not_come_back() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').deliverable('d-1', ANSWER, 'p-3', removed=True)

    assert lines(record) == ()
    assert [entry.removed for entry in record.board().deliverables] == [False, True]
    # The offer stays on the board as a post.
    assert record.board().post('p-2') is not None
    again = record.post(Message(id='p-4', thread='t-1', author='person', text='Again.'))
    refused(again, stated(again, 'd-1', ANSWER, post='p-4'), 'was removed')
    refused(again, offered(again, 'bo', 't-2'), 'The person removed the deliverable d-1')


def test_a_change_by_the_person_reaches_every_agent_that_is_not_on_call_once() -> None:
    record = asked().join('dee', family='openai', checks='p-1').join('guest', harness='guest')
    board = record.on_call('bo').leave('cy').deliverable('d-2', SCRIPT, 'p-2').board()
    told = board.posts[-1]

    assert [agent for agent in ('ada', 'bo', 'cy', 'dee', 'guest') if wakes(board, agent, told)] == ['ada', 'guest']
    assert [line.id for line in news(board, 'ada', told.seq - 1).for_you] == ['p-2']
    # The event after the post is no second piece of news.
    assert news(board, 'ada', told.seq).for_you == ()


def test_a_new_deliverable_opens_a_closed_lab_again_and_a_decision_does_not() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2')
    record.post(Close(id='p-3', thread='t-1', author='ada', text='Nothing is left.'))
    record.post(Answer(id='p-4', thread='t-1', author='bo', text='Agreed.', reply_to='p-3', accepts=True))
    assert lab_state(record.board()) == 'closed'

    # The agents closed the lab with a deliverable that has no acceptance: a close does not depend on it.
    assert states(record) == ['offered']
    decided_so = record.copy().decide('d-1', 'accepted', 'p-2', 'p-5', 't-2')
    assert lab_state(decided_so.board()) == 'closed'
    assert lab_state(decided_so.decide('d-1', 'taken_back', 'p-2', 'p-6', 't-2').board()) == 'closed'
    # A request for changes asks an agent for more work, so the lab is open again.
    assert lab_state(record.copy().decide('d-1', 'changes_asked', 'p-2', 'p-5', 't-2').board()) == 'open'
    # A new sentence without a post leaves the lab closed.
    assert lab_state(record.copy().deliverable('d-1', 'A two-page answer.').board()) == 'closed'
    assert lab_state(record.deliverable('d-2', SCRIPT, 'p-5').board()) == 'open'


def test_an_offer_is_a_post_of_an_agent_with_files_for_a_deliverable_that_stands() -> None:
    record = asked().thread('t-2', opened_by='ada', title='Deliverable d-1', deliverable='d-1')

    board = apply(record.board(), offered(record, 'ada', 't-2'))
    assert [line.offers[0].files for line in brief(board, 'bo', News(seq=0)).deliverables] == [('answer.md',)]

    refused(record, offered(record, 'ada', 't-2', 'd-7'), 'no deliverable d-7')
    refused(record, offered(record, 'person', 't-2'), 'An agent offers files')
    with pytest.raises(ValidationError):
        FileOffer(id='p-2', thread='t-2', author='ada', text='Nothing.', deliverable='d-1', evidence=())
    with pytest.raises(ValidationError):
        FileOffer.model_validate(offered(record, 'ada', 't-2').post.model_dump() | {'reply_to': 'p-1'})


def test_a_blind_checker_and_an_agent_that_left_cannot_offer() -> None:
    record = asked().join('dee', family='openai', checks='p-1').leave('cy')
    record.thread('t-2', opened_by='ada', title='Deliverable d-1', deliverable='d-1')

    refused(record, offered(record, 'dee', 't-2'), 'You rerun p-1 blind')
    refused(record, offered(record, 'cy', 't-2'), 'cy left this lab')


def test_the_offers_for_a_deliverable_go_in_its_one_thread_which_an_agent_opens() -> None:
    record = asked()

    refused(record, offered(record, 'ada', 't-1'), 'goes in the thread of that deliverable')
    for fields, match in (
        ({'opened_by': 'person'}, 'An agent offers files'),
        ({'opened_by': 'ada', 'between': ('ada', 'bo')}, 'opens its one thread'),
        ({'opened_by': 'ada', 'deliverable': 'd-7'}, 'no deliverable d-7'),
    ):
        seq = len(record.events) + 1
        thread = Thread.model_validate({'id': 't-2', 'title': 'Offers', 'deliverable': 'd-1'} | fields)
        refused(record, ThreadOpened(seq=seq, at=record.at(seq), thread=thread), match)
    record.offer('p-2', 'ada', 'd-1', 't-2').thread('t-3', opened_by='bo')
    refused(record, offered(record, 'bo', 't-3'), 'goes in the thread of that deliverable')
    second = Thread(id='t-4', title='Offers', opened_by='bo', deliverable='d-1')
    seq = len(record.events) + 1
    refused(record, ThreadOpened(seq=seq, at=record.at(seq), thread=second), 'opens its one thread')

    record.offer('p-3', 'bo', 'd-1', 't-2')
    assert [(line.thread, [offer.by for offer in line.offers]) for line in lines(record)] == [('t-2', ['ada', 'bo'])]
    # The thread is for offers and what the agents say about them. The lab's answer and a close go elsewhere.
    seq = len(record.events) + 1
    for post in (
        Proposal(id='p-4', thread='t-2', author='ada', text='It holds.'),
        Close(id='p-4', thread='t-2', author='ada', text='Done.'),
    ):
        refused(record, Posted(seq=seq, at=record.at(seq), post=post), 'takes no proposal and no close')


def test_the_title_of_the_offers_thread_follows_the_sentence_and_the_record_keeps_the_first() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').deliverable('d-1', 'A two-page answer.', 'p-3')
    board = record.board()
    opened = board.thread('t-2')
    assert opened is not None

    assert opened.thread.title == 'Deliverable d-1: A two-page answer.'
    assert thread_view(board, 'bo', 't-2').thread.title == 'Deliverable d-1: A two-page answer.'
    first = next(event for event in record.events if isinstance(event, ThreadOpened) and event.thread.id == 't-2')
    assert first.thread.title == 'Deliverable d-1'


def test_an_offer_wakes_the_agents_that_watch_its_thread_and_no_other_agent() -> None:
    record = asked().on_call('cy').offer('p-2', 'ada', 'd-1', 't-2')
    board = record.board()

    # The first post of this thread is for no agent: the person reads the offers in the panel.
    assert [agent for agent in ('ada', 'bo', 'cy') if wakes(board, agent, board.posts[-1])] == []
    assert [line.id for line in news(board, 'bo', 0).others][-1:] == ['p-2']
    record.post(Objection(id='p-3', thread='t-2', author='bo', text='Page two is missing.', reply_to='p-2'))
    board = record.board()
    assert wakes(board, 'ada', board.posts[-1])
    # Another agent builds on the offer, and the offer's author hears it.
    record.post(Message(id='p-4', thread='t-1', author='cy', text='I use it.', builds_on=('p-2',)))
    assert wakes(record.board(), 'ada', record.board().posts[-1])
    # An agent that watches the thread hears the next offer.
    record.watch('bo', 't-2').offer('p-5', 'ada', 'd-1', 't-2')
    board = record.board()
    assert [agent for agent in ('bo', 'cy') if wakes(board, agent, board.posts[-1])] == ['bo']


def test_an_agents_newer_offer_replaces_its_earlier_one_and_counts_the_revisions() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').offer('p-3', 'bo', 'd-1', 't-2')
    record.offer('p-4', 'ada', 'd-1', 't-2', ('answer.md', 'notes.md')).offer('p-5', 'ada', 'd-1', 't-2')

    (line,) = lines(record)
    at = {entry.post.id: entry.at for entry in record.board().posts}
    assert [(offer.post, offer.by, offer.revised, offer.at) for offer in line.offers] == [
        ('p-3', 'bo', 0, at['p-3']),
        ('p-5', 'ada', 2, at['p-5']),
    ]
    assert (line.offers[1].note, line.offers[1].state) == ('The files.', 'waiting')


def test_the_state_of_a_deliverable_comes_from_the_record() -> None:
    record = asked()
    assert states(record) == ['none']

    record.offer('p-2', 'ada', 'd-1', 't-2')
    assert states(record) == ['offered']

    record.decide('d-1', 'changes_asked', 'p-2', 'p-3', 't-2')
    (line,) = lines(record)
    assert (line.state, line.decided_at) == ('changes_asked', record.at(len(record.events)))
    # A reply and an objection are no offer, so the state stays.
    record.post(Message(id='p-4', thread='t-2', author='ada', text='On it.', reply_to='p-3'))
    assert states(record) == ['changes_asked']

    record.offer('p-5', 'ada', 'd-1', 't-2')
    (line,) = lines(record)
    assert (line.state, line.decided_at) == ('offered', None)

    record.decide('d-1', 'accepted', 'p-5', 'p-6', 't-2')
    (line,) = lines(record)
    assert (line.state, [offer.state == 'accepted' for offer in line.offers]) == ('accepted', [True])

    record.decide('d-1', 'taken_back', 'p-5', 'p-7', 't-2')
    (line,) = lines(record)
    assert (line.state, line.decided_at, [offer.state == 'accepted' for offer in line.offers]) == (
        'offered',
        None,
        [False],
    )


def test_nothing_that_an_agent_does_changes_an_acceptance() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').decide('d-1', 'accepted', 'p-2', 'p-3', 't-2')

    record.offer('p-4', 'ada', 'd-1', 't-2').offer('p-5', 'bo', 'd-1', 't-2')
    record.post(Objection(id='p-6', thread='t-2', author='bo', text='It is wrong.', reply_to='p-2'))
    record.leave('ada')

    (line,) = lines(record.join('dee'))
    assert line.state == 'accepted'
    # The offer that the person accepted stays in the list beside its author's newer one.
    assert [(offer.post, offer.state == 'accepted', offer.revised) for offer in line.offers] == [
        ('p-2', True, 0),
        ('p-4', False, 1),
        ('p-5', False, 0),
    ]
    # The person changes the sentence, and their acceptance stands until they take it back.
    assert states(record.deliverable('d-1', 'A two-page answer.', 'p-7')) == ['accepted']


def test_a_decision_is_the_persons_reply_to_an_offer_for_that_deliverable() -> None:
    record = asked().deliverable('d-2', SCRIPT, 'p-2').offer('p-3', 'ada', 'd-1', 't-2')
    record.post(Message(id='p-4', thread='t-2', author='bo', text='Take it.', reply_to='p-3'))

    # An agent's reply decides nothing, and a decision names an offer for its own deliverable.
    refused(record, decided(record, 'accepted', 'p-3', 'p-4'), 'not the reply of the person')
    refused(record, decided(record, 'accepted', 'p-4', 'p-4'), 'no offer of files for the deliverable d-1')
    record.post(Message(id='p-5', thread='t-2', author='person', text='Accepted.', reply_to='p-3'))
    refused(record, decided(record, 'accepted', 'p-3', 'p-5', 'd-2'), 'no offer of files for the deliverable d-2')
    refused(record, decided(record, 'accepted', 'p-3', 'p-5', 'd-9'), 'no deliverable d-9')
    refused(record, decided(record, 'taken_back', 'p-3', 'p-5'), 'no acceptance to take back')
    later = record.copy().watch('ada', 't-1')
    refused(later, decided(later, 'accepted', 'p-3', 'p-5'), 'not the reply of the person')
    # The person's post that replies to no offer decides nothing.
    aside = record.copy().post(Message(id='p-6', thread='t-2', author='person', text='Fine.'))
    refused(aside, decided(aside, 'accepted', 'p-3', 'p-6'), 'not the reply of the person')

    board = apply(record.board(), decided(record, 'accepted', 'p-3', 'p-5'))
    assert [entry.decision for entry in board.decisions] == ['accepted']


def test_an_acceptance_stands_once_and_only_its_own_offer_takes_it_back() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').offer('p-3', 'bo', 'd-1', 't-2')
    record.decide('d-1', 'accepted', 'p-2', 'p-4', 't-2')
    record.post(Message(id='p-5', thread='t-2', author='person', text='Again.', reply_to='p-2'))

    refused(record, decided(record, 'accepted', 'p-2', 'p-5'), 'accepted the offer p-2 already')
    other = record.copy().post(Message(id='p-6', thread='t-2', author='person', text='Back.', reply_to='p-3'))
    refused(other, decided(other, 'taken_back', 'p-3', 'p-6'), 'did not accept the offer p-3')
    # A deliverable has one accepted offer: the record takes the next acceptance after the first is taken back.
    refused(other, decided(other, 'accepted', 'p-3', 'p-6'), 'comes after that one is taken back')
    moved = (
        record.copy().decide('d-1', 'taken_back', 'p-2', 'p-6', 't-2').decide('d-1', 'accepted', 'p-3', 'p-7', 't-2')
    )
    assert [(offer.post, offer.state) for offer in lines(moved)[0].offers] == [('p-2', 'waiting'), ('p-3', 'accepted')]

    removed = record.copy().deliverable('d-1', ANSWER, 'p-6', removed=True)
    removed.post(Message(id='p-7', thread='t-2', author='person', text='Back.', reply_to='p-2'))
    refused(removed, decided(removed, 'taken_back', 'p-2', 'p-7'), 'The person removed the deliverable d-1')


def test_a_request_for_changes_reaches_the_author_of_the_offer() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').decide('d-1', 'changes_asked', 'p-2', 'p-3', 't-2')
    board = record.board()
    told = board.post('p-3')
    assert told is not None

    assert [agent for agent in ('ada', 'bo', 'cy') if wakes(board, agent, told)] == ['ada']
    assert [line.id for line in news(board, 'ada', told.seq - 1).for_you] == ['p-3']


def test_a_request_for_changes_to_one_offer_leaves_the_acceptance_of_another() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').offer('p-3', 'bo', 'd-1', 't-2')
    record.decide('d-1', 'accepted', 'p-2', 'p-4', 't-2').decide('d-1', 'changes_asked', 'p-3', 'p-5', 't-2')

    (line,) = lines(record)
    assert (line.state, line.decided_at) == ('accepted', record.at(len(record.events) - 2))
    assert [(offer.post, offer.state) for offer in line.offers] == [('p-2', 'accepted'), ('p-3', 'changes_asked')]
    # The acceptance is still the person's to take back, and it does not take a request for changes.
    record.post(Message(id='p-6', thread='t-2', author='person', text='Change it.', reply_to='p-2'))
    refused(record, decided(record, 'changes_asked', 'p-2', 'p-6'), 'comes after the acceptance is taken back')
    record.events.append(decided(record, 'taken_back', 'p-2', 'p-6'))
    (line,) = lines(record)
    assert (line.state, [offer.state for offer in line.offers]) == ('offered', ['waiting', 'changes_asked'])


def test_a_deliverable_is_offered_while_one_offer_waits_and_changes_are_asked_when_none_does() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').offer('p-3', 'bo', 'd-1', 't-2')

    # The person asks ada for changes while bo's offer waits.
    record.decide('d-1', 'changes_asked', 'p-2', 'p-4', 't-2')
    (line,) = lines(record)
    assert (line.state, line.decided_at) == ('offered', None)
    assert [(offer.by, offer.state, offer.decided_at) for offer in line.offers] == [
        ('ada', 'changes_asked', record.at(len(record.events))),
        ('bo', 'waiting', None),
    ]
    record.decide('d-1', 'changes_asked', 'p-3', 'p-5', 't-2')
    (line,) = lines(record)
    assert (line.state, line.decided_at) == ('changes_asked', record.at(len(record.events)))
    # The request stays with ada's offer when another agent offers, and ends when ada offers again.
    record.offer('p-6', 'cy', 'd-1', 't-2')
    assert [(offer.by, offer.state) for offer in lines(record)[0].offers] == [
        ('ada', 'changes_asked'),
        ('bo', 'changes_asked'),
        ('cy', 'waiting'),
    ]
    record.offer('p-7', 'ada', 'd-1', 't-2')
    assert [(offer.by, offer.state) for offer in lines(record)[0].offers] == [
        ('bo', 'changes_asked'),
        ('cy', 'waiting'),
        ('ada', 'waiting'),
    ]


def test_a_decision_on_an_offer_that_its_author_replaced_is_refused() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').decide('d-1', 'accepted', 'p-2', 'p-3', 't-2')
    record.offer('p-4', 'ada', 'd-1', 't-2')
    record.post(Message(id='p-5', thread='t-2', author='person', text='Decided.', reply_to='p-2'))
    fresh = asked().offer('p-2', 'ada', 'd-1', 't-2').offer('p-3', 'ada', 'd-1', 't-2')
    fresh.post(Message(id='p-4', thread='t-2', author='person', text='Decided.', reply_to='p-2'))

    for decision in ('accepted', 'changes_asked'):
        refused(fresh, decided(fresh, decision, 'p-2', 'p-4'), 'the offer p-3 replaces it. The decision is about p-3')
    assert [(offer.post, offer.state) for offer in lines(fresh)[0].offers] == [('p-3', 'waiting')]
    # The acceptance of an offer that its author replaced later still stands, and the person can take it back.
    assert [(offer.post, offer.state) for offer in lines(record)[0].offers] == [('p-2', 'accepted'), ('p-4', 'waiting')]
    record.events.append(decided(record, 'taken_back', 'p-2', 'p-5'))
    (line,) = lines(record)
    assert (line.state, [(offer.post, offer.state) for offer in line.offers]) == ('offered', [('p-4', 'waiting')])


def test_an_offer_says_where_its_post_stands_and_which_post_disputes_it() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2')
    assert [(offer.standing, offer.disputed_by) for offer in lines(record)[0].offers] == [('open', None)]

    record.post(Objection(id='p-3', thread='t-2', author='bo', text='The numbers are from one day.', reply_to='p-2'))
    assert [(offer.standing, offer.disputed_by) for offer in lines(record)[0].offers] == [('disputed', 'p-3')]
    record.post(
        Check(id='p-4', thread='t-2', author='cy', text='It fails.', reply_to='p-2', outcome='fails', method='rerun')
    )
    assert [(offer.standing, offer.disputed_by) for offer in lines(record)[0].offers] == [('disputed', 'p-4')]


def test_the_board_says_when_a_post_last_told_the_lab_of_a_new_sentence_or_a_removal() -> None:
    record = asked()
    assert told_at(record.board()) is None

    # A post about a new deliverable does not count, and neither does a change without a post.
    record.deliverable('d-2', SCRIPT, 'p-2').deliverable('d-1', 'A two-page answer.')
    assert told_at(record.board()) is None
    record.deliverable('d-2', 'A short script.', 'p-3')
    assert told_at(record.board()) == record.at(len(record.events))
    record.deliverable('d-1', 'A two-page answer.', 'p-4', removed=True)
    assert told_at(record.board()) == record.at(len(record.events))


def test_a_rerun_of_an_offer_is_wanted_and_taken_as_for_any_post_with_files() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').rerun('person', 'p-2')
    assert [(line.post, line.asked_by, line.taken_by) for line in reruns_wanted(record.board())] == [
        ('p-2', ('person',), ())
    ]

    record.take('cy', 'p-2')
    assert [line.taken_by for line in reruns_wanted(record.board())] == [('cy',)]
    take = record.board().takes[-1].seq
    ran = (FileEvidence(path='rerun.log', commit='d' * 40),)

    def check(outcome: str) -> Check:
        return Check.model_validate(
            {
                'id': 'p-3',
                'thread': 't-2',
                'author': 'cy',
                'text': 'I ran it.',
                'reply_to': 'p-2',
                'outcome': outcome,
                'method': 'rerun',
                'take': take,
                'evidence': ran,
            }
        )

    held, failed = record.copy().post(check('holds')), record.copy().post(check('fails'))

    assert reruns_wanted(held.board()) == ()
    assert [(offer.standing, offer.disputed_by) for offer in lines(held)[0].offers] == [('held_up', None)]
    assert [(offer.standing, offer.disputed_by) for offer in lines(failed)[0].offers] == [('disputed', 'p-3')]
    # A check decides nothing for the person: the offer waits as before.
    assert [offer.state for offer in lines(held)[0].offers] == ['waiting']


def test_the_persons_own_post_in_an_offers_thread_is_for_the_agents_that_offered_there_or_watch_it() -> None:
    record = asked().join('dee').on_call('cy').offer('p-2', 'ada', 'd-1', 't-2').offer('p-3', 'cy', 'd-1', 't-2')
    record.watch('bo', 't-2').post(Message(id='p-4', thread='t-2', author='person', text='Which one is newer?'))
    board = record.board()

    # An on-call agent that offered files there hears it too, and an agent that did neither does not.
    assert board.offer_listeners('t-2') == ('ada', 'cy', 'bo')
    assert [agent for agent in ('ada', 'bo', 'cy', 'dee') if wakes(board, agent, board.posts[-1])] == [
        'ada',
        'bo',
        'cy',
    ]
    assert thread_view(board, 'dee', 't-2').person_reaches == ('ada', 'cy', 'bo')
    assert thread_view(board, 'dee', 't-1').person_reaches is None
    # An agent that stopped watching and an agent that left are no listeners.
    record.watch('bo', 't-2', watching=False).leave('cy')
    assert record.board().offer_listeners('t-2') == ('ada',)


def test_the_persons_post_in_an_offers_thread_reaches_the_whole_lab_when_no_listener_is_in_the_lab() -> None:
    record = asked().on_call('cy').offer('p-2', 'ada', 'd-1', 't-2')
    record.post(Close(id='p-3', thread='t-1', author='ada', text='Nothing is left.'))
    record.post(Answer(id='p-4', thread='t-1', author='bo', text='Agreed.', reply_to='p-3', accepts=True))

    # While the agent that offered is in the lab, the person's words are for it, and the lab stays closed.
    heard = record.copy().post(Message(id='p-5', thread='t-2', author='person', text='Is this the last one?'))
    board = heard.board()
    assert [agent for agent in ('ada', 'bo', 'cy') if wakes(board, agent, board.posts[-1])] == ['ada']
    assert lab_state(board) == 'closed'
    # The agent leaves afterwards: the lab stays closed, because the words reached it when they came.
    assert lab_state(heard.leave('ada').board()) == 'closed'

    # After it left, nobody listens there, so the words are for every agent that is not on call and open the lab.
    record.leave('ada')
    named = record.copy().post(
        Message(id='p-5', thread='t-2', author='person', text='Bo, can you redo this?', mentions=('bo',))
    )
    assert lab_state(named.board()) == 'closed'
    record.post(Message(id='p-5', thread='t-2', author='person', text='Anyone, redo this?'))
    board = record.board()
    assert thread_view(board, 'bo', 't-2').person_reaches == ()
    assert [agent for agent in ('ada', 'bo', 'cy') if wakes(board, agent, board.posts[-1])] == ['bo']
    assert lab_state(board) == 'open'


def test_a_request_for_changes_to_an_offer_whose_author_left_is_refused() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2').leave('ada')
    record.post(Message(id='p-3', thread='t-2', author='person', text='Shorter.', reply_to='p-2'))

    refused(
        record, decided(record, 'changes_asked', 'p-2', 'p-3'), 'left the lab, so nobody hears a request for changes'
    )
    # The person can still accept what the agent left.
    record.events.append(decided(record, 'accepted', 'p-2', 'p-3'))
    assert states(record) == ['accepted']


def test_an_offer_names_the_dispute_that_still_stands_and_the_objection_that_its_author_accepted() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2')
    record.post(Objection(id='p-3', thread='t-2', author='cy', text='One day of data.', reply_to='p-2'))
    record.post(Objection(id='p-4', thread='t-2', author='bo', text='The fees are wrong.', reply_to='p-2'))
    # Bo's objection is the newest. Ada objects to it, and bo accepts that: the objection is conceded.
    record.post(Objection(id='p-5', thread='t-2', author='ada', text='The fees are right.', reply_to='p-4'))
    record.post(Answer(id='p-6', thread='t-2', author='bo', text='True.', reply_to='p-5', accepts=True))

    (offer,) = lines(record)[0].offers
    assert (offer.standing, offer.disputed_by, offer.conceded_to) == ('disputed', 'p-3', None)

    # A later check that holds overrules cy's objection, so nothing disputes the offer.
    overruled = record.copy().post(
        Check(
            id='p-7', thread='t-2', author='bo', text='It holds.', reply_to='p-2', outcome='holds', method='code_read'
        )
    )
    (offer,) = lines(overruled)[0].offers
    assert (offer.standing, offer.disputed_by) == ('checked', None)

    # Ada accepts cy's objection: the offer is conceded, and the line names that objection.
    record.post(Answer(id='p-7', thread='t-2', author='ada', text='You are right.', reply_to='p-3', accepts=True))
    (offer,) = lines(record)[0].offers
    assert (offer.standing, offer.disputed_by, offer.conceded_to) == ('conceded', None, 'p-3')


def test_a_deliverable_names_the_other_work_in_its_thread_that_is_open() -> None:
    record = asked().offer('p-2', 'ada', 'd-1', 't-2')
    assert [(line.disputed, line.open_asks) for line in lines(record)] == [((), ())]

    record.post(Objection(id='p-3', thread='t-2', author='bo', text='Page two is missing.', reply_to='p-2'))
    record.offer('p-4', 'ada', 'd-1', 't-2')
    record.post(Ask(id='p-5', thread='t-2', author='bo', text='Which fee table?'))
    record.post(Result(id='p-6', thread='t-2', author='cy', text='A table of fees.'))
    record.post(Objection(id='p-7', thread='t-2', author='bo', text='It is from 2024.', reply_to='p-6'))

    # The earlier offer is not among the offers that show, so its dispute is in this list.
    (line,) = lines(record)
    assert ([offer.post for offer in line.offers], line.disputed, line.open_asks) == (['p-4'], ('p-2', 'p-6'), ('p-5',))
    record.post(Answer(id='p-8', thread='t-2', author='ada', text='The one of November.', reply_to='p-5'))
    assert lines(record)[0].open_asks == ()


def test_a_removed_deliverable_with_offers_keeps_its_thread_and_says_when_a_post_comes_there() -> None:
    record = asked().deliverable('d-2', SCRIPT, 'p-2').offer('p-3', 'ada', 'd-1', 't-2')
    assert removed_lines(record.board()) == ()

    record.deliverable('d-1', ANSWER, 'p-4', removed=True).deliverable('d-2', SCRIPT, removed=True)
    # A removed deliverable without offers has no thread, so the list leaves it out.
    (gone,) = removed_lines(record.board())
    assert (gone.id, gone.text, gone.removed_at, gone.thread, gone.active) == (
        'd-1',
        ANSWER,
        record.at(len(record.events) - 1),
        't-2',
        False,
    )
    record.post(Message(id='p-5', thread='t-2', author='bo', text='I still use this file.'))
    assert [line.active for line in removed_lines(record.board())] == [True]
