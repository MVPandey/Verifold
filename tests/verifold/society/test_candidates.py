import pytest
from builders import RecordBuilder

from verifold.protocol.join import MAX_CANDIDATES, News
from verifold.protocol.posts import Answer, Close, Entry, FileEvidence, Objection, Proposal, Round
from verifold.protocol.threads import QUESTION_TITLE
from verifold.society.candidates import candidates, check_names_candidate, closes_on
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import lab_state
from verifold.society.views import brief, candidates_view


def asked() -> RecordBuilder:
    """A lab with the question's thread `t-1`, a thread of work `t-2`, and agents `ada`, `bo`, and `cy`."""
    record = RecordBuilder().join('ada').join('bo').join('cy', family='openai')
    return record.thread('t-1', opened_by='person', title=QUESTION_TITLE).thread('t-2', opened_by='ada')


def ids(record: RecordBuilder) -> list[str]:
    return [entry.post.id for entry in candidates(record.board())]


def test_the_candidates_of_two_agents_stand_side_by_side_and_a_newer_one_supersedes_its_authors_older_one() -> None:
    record = asked().post(Proposal(id='p-1', thread='t-1', author='ada', text='Yes, 12x.'))
    record.post(Proposal(id='p-2', thread='t-2', author='bo', text='No: 3x at most.'))
    assert ids(record) == ['p-1', 'p-2']

    record.post(Proposal(id='p-3', thread='t-1', author='ada', text='Yes, 11x on ARM too.'))

    assert ids(record) == ['p-2', 'p-3']


def test_a_candidate_that_its_author_conceded_does_not_stand_and_the_older_one_does_not_come_back() -> None:
    record = asked().post(Proposal(id='p-1', thread='t-1', author='ada', text='Yes, 12x.'))
    record.post(Proposal(id='p-2', thread='t-1', author='ada', text='Yes, 11x.'))
    record.post(Objection(id='p-3', thread='t-1', author='bo', text='The seed leaks.', reply_to='p-2'))
    # A disputed candidate still stands, and where it stands says so.
    assert ids(record) == ['p-2']

    record.post(Answer(id='p-4', thread='t-1', author='ada', text='Right.', reply_to='p-3', accepts=True))

    assert ids(record) == []


def test_the_brief_lists_the_newest_candidates_and_counts_the_ones_that_it_leaves_out() -> None:
    record = asked()
    authors = [f'agent-{number}' for number in range(MAX_CANDIDATES + 2)]
    for number, author in enumerate(authors):
        record.join(author).post(Proposal(id=f'p-{number + 1}', thread='t-1', author=author, text=f'Answer {number}.'))

    view = brief(record.board(), 'ada', News(seq=0))

    assert [line.line.id for line in view.candidates] == [f'p-{number}' for number in range(3, MAX_CANDIDATES + 3)]
    assert view.more_candidates == 2
    # Each line has its age by the lab's clock: one event is one minute.
    assert [line.minutes_ago for line in view.candidates][-2:] == [2, 0]
    assert len(candidates_view(record.board()).standing) == MAX_CANDIDATES + 2


def test_a_close_that_names_a_candidate_closes_on_it_and_the_closed_lab_has_it_as_its_answer() -> None:
    record = asked().post(Proposal(id='p-1', thread='t-1', author='ada', text='Yes, 12x.'))
    record.post(Proposal(id='p-2', thread='t-1', author='bo', text='No: 3x at most.'))
    record.post(Close(id='p-3', thread='t-1', author='cy', text='The 12x holds up.', candidate='p-1'))
    record.post(Answer(id='p-4', thread='t-1', author='bo', text='Agreed.', reply_to='p-3', accepts=True))
    board = record.board()

    view = candidates_view(board)
    told = brief(board, 'bo', News(seq=0))

    assert lab_state(board) == 'closed'
    assert view.closes_on is not None
    assert view.closes_on.candidate.post.id == 'p-1'
    assert [other.candidate.post.id for other in view.standing] == ['p-1', 'p-2']
    assert (told.close and told.close.id, told.closes_on) == ('p-3', 'p-1')


def test_a_close_that_names_a_post_that_is_no_standing_candidate_breaks_the_record() -> None:
    record = asked().post(Proposal(id='p-1', thread='t-1', author='ada', text='Yes, 12x.'))
    record.post(Proposal(id='p-2', thread='t-1', author='ada', text='Yes, 11x.'))

    for named in ('p-1', 'p-9'):
        refused = record.copy().post(Close(id='p-3', thread='t-1', author='bo', text='Done.', candidate=named))
        with pytest.raises(RejectedEvent, match=f'Post {named} is no candidate answer that stands. .*: p-2.'):
            refused.board()
    lonely = asked().post(Close(id='p-1', thread='t-1', author='bo', text='Done.', candidate='p-9'))
    with pytest.raises(RejectedEvent, match=r'No candidate stands, so a close names none\.'):
        lonely.board()


def test_a_new_close_names_a_candidate_while_one_stands_and_none_while_none_stands() -> None:
    record = asked()
    nothing = Close(id='p-2', thread='t-1', author='bo', text='Nothing is left to try.')
    check_names_candidate(record.board(), nothing)
    record.post(Proposal(id='p-1', thread='t-1', author='ada', text='Yes, 12x.'))

    with pytest.raises(RejectedEvent, match=r'A close names the candidate that it closes on.*: p-1\.'):
        check_names_candidate(record.board(), nothing)
    check_names_candidate(record.board(), nothing.model_copy(update={'candidate': 'p-1'}))


def test_a_close_from_before_closes_named_a_candidate_closes_on_what_the_lab_showed_as_its_answer() -> None:
    # A record from before: three proposals, the newest one the answer, and a close that names none.
    record = asked().post(Proposal(id='p-1', thread='t-1', author='ada', text='Yes, 12x.'))
    record.post(Proposal(id='p-2', thread='t-2', author='bo', text='No: 3x at most.'))
    record.post(Proposal(id='p-3', thread='t-1', author='ada', text='Yes, 11x.'))
    record.post(Close(id='p-4', thread='t-1', author='cy', text='It holds.'))
    record.post(Answer(id='p-5', thread='t-1', author='ada', text='Agreed.', reply_to='p-4', accepts=True))
    # A proposal after the close is no answer that the close named.
    record.post(Proposal(id='p-6', thread='t-1', author='cy', text='Maybe 10x.'))
    board = record.board()

    view = candidates_view(board)

    assert lab_state(board) == 'closed'
    assert view.closes_on is not None
    assert view.closes_on.candidate.post.id == 'p-3'
    assert brief(board, 'bo', News(seq=0)).closes_on == 'p-3'
    # A close that came while no candidate stood closes on none, also after a candidate comes.
    nothing = asked().post(Close(id='p-1', thread='t-1', author='cy', text='Nothing is left.'))
    later = nothing.post(Proposal(id='p-2', thread='t-1', author='ada', text='Yes.')).board()
    assert closes_on(later, later.posts[0]) is None
    assert candidates_view(later).closes_on is None


def test_a_proposal_that_builds_on_its_authors_own_entry_holds_that_entry_by_reference() -> None:
    record = asked().post(Round(id='p-1', thread='t-1', author='cy', text='Your best bet?', minutes=3))
    file = (FileEvidence(path='bench.py', commit='c' * 40),)
    record.post(
        Entry(id='p-2', thread='t-1', author='ada', text='12x.', body='The table.', evidence=file, reply_to='p-1')
    )
    record.post(Entry(id='p-3', thread='t-1', author='bo', text='3x.', reply_to='p-1'))
    record.closed('p-1')
    record.post(Proposal(id='p-5', thread='t-1', author='ada', text='My entry p-2.', builds_on=('p-3', 'p-2')))
    record.post(Proposal(id='p-6', thread='t-1', author='cy', text='Bo is right.', builds_on=('p-3',)))

    ada, cy = candidates_view(record.board()).standing

    assert ada.entry is not None
    assert (ada.entry.post.id, ada.entry.post.body, ada.entry.post.evidence) == ('p-2', 'The table.', file)
    # Another agent's entry is a post that the candidate builds on, as any other.
    assert cy.entry is None
    assert [under.post.id for under in cy.builds_on] == ['p-3']
