import pytest
from builders import START, RecordBuilder

from verifold.protocol.events import QuestionRevised
from verifold.protocol.join import News
from verifold.protocol.posts import Answer, Close, Message, Proposal, Result
from verifold.protocol.threads import QUESTION_TITLE
from verifold.society.attention import news, wakes
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply
from verifold.society.lifecycle import lab_state
from verifold.society.views import answer_view, brief, thread_view, versions


def asked() -> RecordBuilder:
    """A lab with the question's thread `t-1`, and agents `ada`, `bo`, and `cy`."""
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE)
    record.post(Message(id='p-1', thread='t-1', author='person', text='Does it hold?'))
    return record.join('ada').join('bo').join('cy', family='openai')


def test_a_record_with_no_revision_keeps_the_question_that_the_lab_opened_with() -> None:
    board = asked().board()

    assert (board.question, board.revisions) == ('Does it hold?', ())
    assert [(version.question, version.at, version.post) for version in versions(board)] == [
        ('Does it hold?', START, None)
    ]
    view = brief(board, 'ada', News(seq=0))
    assert (view.question, view.revisions, view.answer_to_earlier_question) == ('Does it hold?', (), False)


def test_the_board_has_the_newest_question_and_keeps_every_version_with_its_time_and_note() -> None:
    record = asked().revise('Does it hold on ARM?', 'p-2', note='The first runs were on x86 only.')
    board = record.revise('Does it hold on ARM, and why?', 'p-3').board()

    assert board.question == 'Does it hold on ARM, and why?'
    assert board.opened.question == 'Does it hold?'
    assert [(version.question, version.at, version.note, version.post) for version in versions(board)] == [
        ('Does it hold?', START, '', None),
        ('Does it hold on ARM?', record.at(8), 'The first runs were on x86 only.', 'p-2'),
        ('Does it hold on ARM, and why?', record.at(10), '', 'p-3'),
    ]


def test_a_revision_reaches_every_agent_of_the_lab_once_and_no_checker_guest_or_agent_that_left() -> None:
    record = asked().post(Result(id='p-2', thread='t-1', author='ada', text='It holds.'))
    record.join('dee', family='openai', checks='p-2').join('guest', harness='guest').leave('cy')
    board = record.revise('Does it hold on ARM?', 'p-3').board()
    told = board.posts[-1]

    assert [agent for agent in ('ada', 'bo', 'cy', 'dee', 'guest') if wakes(board, agent, told)] == [
        'ada',
        'bo',
        'guest',
    ]
    # The post is the one thing that an agent hears, so it hears the revision once.
    assert [line.id for line in news(board, 'bo', told.seq - 1).for_you] == ['p-3']
    assert [entry.post.id for entry in thread_view(board, 'bo', 't-1').posts] == ['p-1', 'p-2', 'p-3']


def test_a_revision_opens_a_closed_lab_again() -> None:
    record = asked().post(Close(id='p-2', thread='t-1', author='ada', text='Nothing is left.'))
    record.post(Answer(id='p-3', thread='t-1', author='bo', text='Agreed.', reply_to='p-2', accepts=True))
    assert lab_state(record.board()) == 'closed'

    assert lab_state(record.revise('Does it hold on ARM?', 'p-4').board()) == 'open'


def test_an_answer_from_before_a_revision_is_marked_until_a_newer_proposal_comes() -> None:
    record = asked().post(Proposal(id='p-2', thread='t-1', author='ada', text='It holds.'))
    before = record.board()
    record.revise('Does it hold on ARM?', 'p-3')
    marked = record.board()
    after = record.post(Proposal(id='p-4', thread='t-1', author='bo', text='It holds on ARM too.')).board()

    def marks(board: Board) -> tuple[bool, bool]:
        view, lab_answer = brief(board, 'cy', News(seq=0)), answer_view(board)
        assert lab_answer is not None
        return view.answer_to_earlier_question, lab_answer.to_earlier_question

    assert [marks(board) for board in (before, marked, after)] == [(False, False), (True, True), (False, False)]
    # The earlier answer stays as it was: nothing withdrew or conceded it.
    kept = answer_view(marked)
    assert kept is not None
    assert (kept.answer.post.id, kept.answer.standing) == ('p-2', 'open')


def test_the_brief_gives_the_current_question_and_one_line_for_each_revision() -> None:
    record = asked().revise('Does it hold on ARM?', 'p-2', note='x86 only so far.')

    view = brief(record.board(), 'ada', News(seq=0))

    assert view.question == 'Does it hold on ARM?'
    assert [(line.at, line.note, line.post) for line in view.revisions] == [(record.at(8), 'x86 only so far.', 'p-2')]


def test_a_revision_needs_the_persons_post_that_tells_the_lab_just_before_it() -> None:
    record = asked().post(Message(id='p-2', thread='t-1', author='ada', text='A note.'))
    board = record.board()

    def revision(post: str) -> QuestionRevised:
        return QuestionRevised(seq=board.seq + 1, at=record.at(board.seq + 1), question='Why?', post=post)

    for post in ('p-2', 'p-1', 'p-9'):
        with pytest.raises(RejectedEvent, match=f'Post {post} is not the post of the person'):
            apply(board, revision(post))
    # A board with no post takes no revision.
    with pytest.raises(RejectedEvent, match='Post p-1 is not the post of the person'):
        apply(RecordBuilder().board(), QuestionRevised(seq=2, at=record.at(2), question='Why?', post='p-1'))


def test_a_proposal_that_says_what_its_author_had_seen_goes_by_that_and_an_older_one_by_its_place() -> None:
    record = asked().revise('Does it hold on ARM?', 'p-2')
    # Both come after the revision. The first is from a record that does not say what its author had seen.
    old = record.post(Proposal(id='p-3', thread='t-1', author='ada', text='It holds.')).board()
    unseen = record.post(Proposal(id='p-4', thread='t-1', author='bo', text='It holds.', question_seen=0)).board()
    seen = record.post(Proposal(id='p-5', thread='t-1', author='bo', text='It holds.', question_seen=1)).board()

    assert [brief(board, 'cy', News(seq=0)).answer_to_earlier_question for board in (old, unseen, seen)] == [
        False,
        True,
        False,
    ]


def test_an_answer_to_a_text_that_the_question_has_again_is_still_to_an_earlier_version() -> None:
    record = asked().post(Proposal(id='p-2', thread='t-1', author='ada', text='It holds.', question_seen=0))
    board = record.revise('Does it hold on ARM?', 'p-3').revise('Does it hold?', 'p-4').board()

    view = answer_view(board)

    assert view is not None
    assert (board.question, view.to_earlier_question) == (board.opened.question, True)


def test_the_brief_lists_the_newest_ten_revisions() -> None:
    record = asked()
    for number in range(12):
        record.revise(f'Does it hold on chip {number}?', f'p-{number + 2}')

    view = brief(record.board(), 'ada', News(seq=0))

    assert [line.post for line in view.revisions] == [f'p-{number}' for number in range(4, 14)]
    assert view.question == 'Does it hold on chip 11?'
