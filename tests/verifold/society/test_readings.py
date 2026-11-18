from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.ids import PERSON
from verifold.protocol.join import News
from verifold.protocol.posts import Message, Objection, Plan, Reading, Result
from verifold.society.attention import news, wakes
from verifold.society.candidates import NO_READING_CLOSE, check_read, has_reading
from verifold.society.errors import RejectedEvent
from verifold.society.fold import fold
from verifold.society.identity import post_line
from verifold.society.overview import overview
from verifold.society.views import brief, latest_reading, standing_reading

TEXT = 'An answer is a sort that is 12x faster on random input. A verdict that none is fails the question.'
DETAIL = 'We assume input of a million keys, and we leave out sorted input.'


def reading(post_id: str, author: str, thread: str = 't-1', text: str = TEXT, **fields: object) -> Reading:
    return Reading.model_validate({'id': post_id, 'thread': thread, 'author': author, 'text': text, **fields})


def refusal(record: RecordBuilder) -> str:
    """Return why the board refuses the last event that `record` holds."""
    with pytest.raises(RejectedEvent) as refused:
        fold(record.events)
    return str(refused.value)


def test_the_coordinator_posts_a_newer_reading_and_every_other_agent_is_refused_while_it_holds_the_seat() -> None:
    board = lab().coordinator('ada').post(reading('p-1', 'ada', body=DETAIL)).board()
    first = lab().coordinator('ada').post(reading('p-1', 'ada'))
    newer = (
        'The lab has its reading, and ada holds the coordinator seat, so only ada posts a newer reading of the '
        'question.'
    )

    assert standing_reading(board) is board.posts[-1]
    assert refusal(first.copy().post(reading('p-2', 'bo'))) == newer
    assert refusal(first.copy().on_call('bo').post(reading('p-2', 'bo'))) == newer
    newest = standing_reading(first.copy().post(reading('p-2', 'ada')).board())
    assert newest is not None
    assert newest.post.id == 'p-2'
    # A coordinator whose seat is on call still posts it.
    assert standing_reading(lab().coordinator('ada').on_call('ada').post(reading('p-1', 'ada')).board())
    # The seat of an agent that left is free again, and any agent that works posts the reading.
    assert standing_reading(lab().coordinator('ada').leave('ada').post(reading('p-1', 'bo')).board())


def test_the_first_reading_comes_from_any_agent_so_that_no_seat_keeps_the_lab_from_its_reading_and_its_close() -> None:
    # A coordinator that never posts a reading, or that is on call, keeps no lab without one.
    held = lab().coordinator('ada').on_call('ada')
    by_another = held.copy().post(reading('p-1', 'bo')).board()
    on_call = held.copy().on_call('cy').post(reading('p-1', 'cy')).board()
    alone = lab().on_call('cy').post(reading('p-1', 'cy')).board()

    assert [standing_reading(board) is board.posts[-1] for board in (by_another, on_call, alone)] == [True] * 3
    assert has_reading(by_another)
    assert not has_reading(held.board())
    check_read(by_another)
    with pytest.raises(RejectedEvent) as refused:
        check_read(held.board())
    assert str(refused.value) == NO_READING_CLOSE
    # The first reading stands, so the coordinator's rule holds for a newer one.
    assert refusal(held.copy().post(reading('p-1', 'bo')).post(reading('p-2', 'cy'))).startswith(
        'The lab has its reading, and ada holds the coordinator seat'
    )


def test_without_a_coordinator_any_agent_that_works_posts_a_newer_reading_and_neither_the_person_nor_one_on_call() -> (
    None
):
    assert standing_reading(lab().post(reading('p-1', 'cy')).board())
    assert standing_reading(lab().post(reading('p-1', 'cy')).post(reading('p-2', 'bo')).board())
    assert refusal(lab().on_call('cy').post(reading('p-1', 'ada')).post(reading('p-2', 'cy'))) == (
        'The lab has its reading, and your seat is on call, so you post no newer one. In a lab where nobody holds '
        'the coordinator seat, an agent that is not on call posts a newer reading.'
    )
    assert refusal(lab().post(reading('p-1', PERSON))) == (
        "A reading is the lab's word on how it reads your question. A reply to it tells the lab where it reads the "
        'question wrong.'
    )
    assert refusal(lab().coordinator('ada').post(reading('p-1', PERSON))).startswith("A reading is the lab's word")


def test_a_reading_stands_in_a_thread_for_the_whole_lab() -> None:
    where = (
        'A reading is for the whole lab, so it is in a thread for the whole lab: not a side thread, the '
        'conversation, the desk chat, or a thread of offers.'
    )
    side = lab().thread('t-2', 'ada', between=('ada', 'bo'))
    talk = lab().coordinator('ada').thread('t-2', 'person', conversation=True)
    offers = lab().deliverable('d-1', 'A report.', 'p-1').offer('p-2', 'bo', 'd-1', 't-2')

    assert refusal(side.post(reading('p-1', 'ada', 't-2'))) == where
    assert refusal(talk.post(reading('p-1', 'ada', 't-2'))) == where
    assert refusal(offers.post(reading('p-3', 'ada', 't-2'))) == where
    # Any other thread for the whole lab takes it, also as a reply to the person's correction.
    other = lab().thread('t-2', 'bo').post(Message(id='p-1', thread='t-2', author='person', text='Not that.'))
    assert standing_reading(other.post(reading('p-2', 'ada', 't-2', reply_to='p-1')).board())


def test_the_newest_reading_stands_whoever_posted_it_and_in_whatever_thread_it_is() -> None:
    record = lab().thread('t-2', 'bo').post(reading('p-1', 'ada', text='Any speedup counts.'))
    record.post(Message(id='p-2', thread='t-1', author='person', text='No: 12x on random input.'))
    record.post(reading('p-3', 'bo', 't-2'))
    record.post(Result(id='p-4', thread='t-2', author='cy', text='9x.'))
    board = record.board()

    stands = standing_reading(board)
    shown = latest_reading(board)

    assert stands is not None
    assert stands.post.id == 'p-3'
    assert shown is not None
    assert (shown.post.id, shown.post.kind, shown.post.text) == ('p-3', 'reading', TEXT)
    # A record from before readings holds none.
    assert (standing_reading(lab().board()), latest_reading(lab().board())) == (None, None)


def test_a_reading_is_news_for_every_agent_that_works_once_whatever_it_names() -> None:
    record = lab().join('dan').on_call('dan').coordinator('ada')
    record.post(Plan(id='p-1', thread='t-1', author='bo', text='I time sorted().'))
    record.thread('t-2', 'cy').post(Plan(id='p-2', thread='t-2', author='cy', text='I time merge sort.'))
    record.post(reading('p-3', 'ada', mentions=('bo',)))
    board = record.board()
    posted = board.posts[-1]

    # A reading changes what counts as an answer, so it is for every agent that is not on call, as a post for the
    # whole lab is. cy works in another thread, and the reading names only bo.
    assert [agent for agent in ('ada', 'bo', 'cy', 'dan') if wakes(board, agent, posted)] == ['bo', 'cy']
    for agent in ('bo', 'cy'):
        first = news(board, agent, 0)
        assert [line.id for line in first.for_you if line.kind == 'reading'] == ['p-3']
        assert news(board, agent, first.seq).for_you == ()
    assert 'p-3' not in [line.id for line in news(board, 'dan', 0).for_you]


def test_a_brief_has_the_reading_with_its_age_and_without_one_says_so_with_the_minutes_since_the_lab_opened() -> None:
    record = lab().coordinator('ada')
    none = brief(record.board(), 'bo', News(seq=0), now=START + timedelta(minutes=4, seconds=50))
    just = brief(record.board(), 'bo', News(seq=0), now=START + timedelta(seconds=30))
    record.post(reading('p-1', 'ada', text='Any speedup counts.'))
    record.post(reading('p-2', 'ada', body=DETAIL))
    board = record.board()
    posted = board.posts[-1].at

    view = brief(board, 'bo', News(seq=0), now=posted + timedelta(minutes=31, seconds=50))

    assert (none.reading, none.reading_minutes_ago) == (None, None)
    # A record from before readings loads with the same line.
    assert none.no_reading == 'No `reading` yet. The lab opened 4 minutes ago.'
    assert just.no_reading == 'No `reading` yet. The lab opened less than a minute ago.'
    # The line has the form of every line of a post: the headline, who wrote it, and no body.
    assert view.reading == post_line(board, board.posts[-1], 'bo')
    assert view.reading is not None
    assert (view.reading.id, view.reading.author, view.reading.text, view.reading.body) == ('p-2', 'ada', TEXT, '')
    assert (view.reading_minutes_ago, view.no_reading) == (31, None)
    assert DETAIL not in view.model_dump_json()
    # A reading that somebody disputes is in the list of disputed posts by its ID alone, because the brief holds its
    # line.
    record.post(Objection(id='p-3', thread='t-1', author='bo', text='12x is the goal, not a bound.', reply_to='p-2'))
    disputed = brief(record.board(), 'cy', News(seq=0)).disputed
    assert [(entry.id, entry.line) for entry in disputed] == [('p-2', None)]


def test_a_reading_builds_nothing_on_the_results_that_it_names() -> None:
    record = lab().thread('t-2', 'bo').post(Result(id='p-1', thread='t-2', author='bo', text='9x.'))
    board = record.post(reading('p-2', 'ada', builds_on=('p-1',))).board()

    view = brief(board, 'cy', News(seq=0))

    assert [entry.id for entry in view.not_built_on] == ['p-1']
    assert all(summary.crossed == 0 for summary in view.threads)


def test_the_desk_posts_no_reading_hears_none_and_reads_it_in_its_overview() -> None:
    record = lab().desk('dee')

    assert refusal(record.copy().post(reading('p-1', 'dee'))) == (
        "The desk is no part of the lab's work, so the board takes no reading from it. Outside the desk chat, the "
        'desk posts for the person a `message` or a `round`.'
    )
    assert refusal(record.copy().post(reading('p-1', 'ada', 't-9'))).startswith('A reading is for the whole lab')
    board = record.post(reading('p-1', 'ada', body=DETAIL)).board()
    posted = board.posts[-1]
    seen = overview(board, 'dee', posted.at + timedelta(minutes=3))
    empty = overview(lab().desk('dee').board(), 'dee', START)

    # The desk is no part of the lab's work, so the reading is news for every other agent and not for the desk.
    assert [agent for agent in ('ada', 'bo', 'cy', 'dee') if wakes(board, agent, posted)] == ['bo', 'cy']
    assert seen.reading == post_line(board, posted, 'dee')
    assert seen.reading_minutes_ago == 3
    assert (empty.reading, empty.reading_minutes_ago) == (None, None)
