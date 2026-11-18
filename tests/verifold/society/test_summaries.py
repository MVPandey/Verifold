import pytest
from builders import RecordBuilder, lab

from verifold.protocol.ids import PERSON
from verifold.protocol.posts import (
    Answer,
    Ask,
    Call,
    Check,
    FileEvidence,
    Message,
    Objection,
    Plan,
    Result,
    RuledOut,
    Summary,
)
from verifold.society.attention import news
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.fold import fold
from verifold.society.summaries import standing_summary
from verifold.society.views import brief, thread_summaries, thread_view

TEXT = 'Tail filters fail out of sample; the 2025 loader drops a day; open: the volume rule.'
DETAIL = 'Tried: three tail filters. Holds: none beyond 2024. Failed: the loader. Open: volume.'
FILES = (FileEvidence(path='run.py', commit='c' * 40),)


def summary(post_id: str, author: str, thread: str = 't-1', **fields: object) -> Summary:
    return Summary.model_validate({'id': post_id, 'thread': thread, 'author': author, 'text': TEXT, **fields})


def plan(post_id: str, author: str, thread: str = 't-1') -> Plan:
    return Plan(id=post_id, thread=thread, author=author, text='Test the tail filter.')


def refusal(record: RecordBuilder) -> str:
    """Return why the board refuses the last event that `record` holds."""
    with pytest.raises(RejectedEvent) as refused:
        fold(record.events)
    return str(refused.value)


def worked() -> RecordBuilder:
    """A lab where ada and bo posted in t-1, and cy did not."""
    return lab().post(plan('p-1', 'ada')).post(Result(id='p-2', thread='t-1', author='bo', text='9x.'))


def test_an_agent_that_posted_in_the_thread_or_the_coordinator_posts_its_summary() -> None:
    assert standing_summary(worked().post(summary('p-3', 'bo', body=DETAIL)).board(), 't-1')
    assert refusal(worked().post(summary('p-3', 'cy'))) == (
        'You have not posted in thread t-1. An agent that posted there, or the agent that holds the coordinator '
        'seat, posts its summary.'
    )
    # The coordinator reads across the threads, so it summarizes a thread that it never posted in.
    assert standing_summary(worked().coordinator('cy').post(summary('p-3', 'cy')).board(), 't-1')


def test_neither_the_person_nor_the_desk_posts_a_summary_and_an_empty_thread_has_none() -> None:
    assert refusal(worked().post(summary('p-3', PERSON))) == (
        "A summary is the agents' word on what a thread has established. A reply to it tells them where it is wrong."
    )
    desk = worked().desk('dee').post(summary('p-3', 'dee'))
    assert 'so the board takes no summary from it' in refusal(desk)
    empty = worked().coordinator('ada').thread('t-2', 'ada').post(summary('p-3', 'ada', 't-2'))
    assert refusal(empty) == 'Thread t-2 has no post yet, so it has nothing to summarize.'


def test_a_summary_is_for_a_line_of_work_or_a_side_thread_that_its_author_is_a_member_of() -> None:
    talk = worked().coordinator('ada').thread('t-2', PERSON, conversation=True)
    talk.post(Message(id='p-3', thread='t-2', author='ada', text='On it.'))
    offers = worked().deliverable('d-1', 'A report.', 'p-3').offer('p-4', 'bo', 'd-1', 't-2')
    side = worked().thread('t-2', 'ada', between=('ada', 'bo'))
    side.post(Message(id='p-3', thread='t-2', author='ada', text='Can you fetch it?'))

    assert refusal(talk.copy().post(summary('p-4', 'ada', 't-2'))).startswith('Thread t-2 is no line of work')
    assert refusal(offers.copy().post(summary('p-5', 'bo', 't-2'))).startswith('Thread t-2 is no line of work')
    assert standing_summary(side.copy().post(summary('p-4', 'ada', 't-2')).board(), 't-2')
    # The coordinator is no member of the side thread, so it posts no summary there.
    assert refusal(side.coordinator('cy').post(summary('p-4', 'cy', 't-2'))) == (
        'Thread t-2 is a side thread, and you are no member of it, so you post no summary of it.'
    )


def test_the_newest_summary_stands_and_a_disputed_or_conceded_one_leaves_the_thread_without_one() -> None:
    record = worked().post(summary('p-3', 'ada')).post(summary('p-4', 'bo'))
    newest = record.board()
    record.post(Objection(id='p-5', thread='t-1', author='ada', text='The loader holds.', reply_to='p-4'))
    disputed = record.board()
    conceded = record.copy().post(
        Answer(id='p-6', thread='t-1', author='bo', text='Right.', reply_to='p-5', accepts=True)
    )
    again = record.copy().post(summary('p-6', 'ada'))

    assert (summary_id(newest), summary_id(disputed), summary_id(conceded.board())) == ('p-4', None, None)
    assert summary_id(again.board()) == 'p-6'
    # A summary is a post as any other: a check of it can hold, and then it stands.
    checked = worked().post(summary('p-3', 'ada'))
    checked.post(
        Check(id='p-4', thread='t-1', author='cy', text='Matches.', reply_to='p-3', outcome='holds', method='code_read')
    )
    assert summary_id(checked.board()) == 'p-3'


def summary_id(board: Board) -> str | None:
    found = standing_summary(board, 't-1')
    return found.post.id if found else None


def long_thread() -> RecordBuilder:
    """Thread t-1 with ten plain posts before ada's summary p-12 and two after it."""
    record = worked()
    for number in range(3, 12):
        record.post(Message(id=f'p-{number}', thread='t-1', author='ada' if number % 2 else 'bo', text='Notes.'))
    return record.post(summary('p-12', 'ada', body=DETAIL)).post(plan('p-13', 'bo')).post(plan('p-14', 'cy'))


def ids(record: RecordBuilder, reader: str = 'cy', *, read: int = 0, votes_of: str | None = None) -> list[str]:
    view = thread_view(record.board(), reader, 't-1', votes_of, fold=True, read=read)
    return [item.post.id for item in view.posts]


def test_a_read_of_the_thread_starts_at_its_summary_and_says_how_many_posts_it_leaves_out() -> None:
    board = long_thread().board()

    folded = thread_view(board, 'cy', 't-1', fold=True)
    whole = thread_view(board, 'cy', 't-1')

    assert [item.post.id for item in folded.posts] == ['p-12', 'p-13', 'p-14']
    assert folded.summary == 'p-12'
    assert folded.earlier == (
        'This view starts at the summary p-12. It leaves out 11 of the 11 posts before it, and `thread` with '
        '`whole: true` shows every post.'
    )
    assert [item.post.id for item in whole.posts] == [f'p-{number}' for number in range(1, 15)]
    assert (whole.summary, whole.earlier) == ('p-12', None)
    # The summary's body is in the view whole.
    assert folded.posts[0].post.body == DETAIL


def test_the_posts_before_a_summary_that_still_ask_something_stay_in_sight() -> None:
    record = worked()
    # bo's result p-2 has an objection that stands, and a failed check: both wait for bo.
    record.post(Objection(id='p-3', thread='t-1', author='cy', text='Leaks.', reply_to='p-2'))
    record.post(Result(id='p-4', thread='t-1', author='ada', text='12x.', evidence=FILES)).rerun('cy', 'p-4')
    record.post(Ask(id='p-6', thread='t-1', author='cy', text='Which loader, bo?', mentions=('bo',)))
    record.post(Answer(id='p-7', thread='t-1', author='ada', text='The 2025 one.', reply_to='p-6'))
    record.post(Ask(id='p-8', thread='t-1', author='bo', text='Who has the 2024 data?'))
    record.post(Call(id='p-9', thread='t-1', author='ada', text='The volume rule needs hands.'))
    record.post(RuledOut(id='p-10', thread='t-1', author='bo', text='Tail filters fail out of sample.'))
    record.post(Message(id='p-11', thread='t-1', author=PERSON, text='Keep the 2025 data out.'))
    record.post(Message(id='p-12', thread='t-1', author='ada', text='Noted.'))
    record.post(summary('p-13', 'ada'))

    # For bo: the objection to its result, the ask that names it and that it has not answered, the ask and the
    # call that are open, the open obstacle, the result whose rerun is wanted, and the person's post.
    assert ids(record, 'bo') == ['p-3', 'p-4', 'p-6', 'p-8', 'p-9', 'p-10', 'p-11', 'p-13']
    # cy wrote the objection and the ask that ada answered, so neither waits for it.
    assert ids(record, 'cy') == ['p-4', 'p-8', 'p-9', 'p-10', 'p-11', 'p-13']
    # The person's post stays only after the reader's last read of the thread, and `votes_of` keeps its post.
    assert ids(record, 'cy', read=record.events[-1].seq) == ['p-4', 'p-8', 'p-9', 'p-10', 'p-13']
    assert ids(record, 'cy', read=record.events[-1].seq, votes_of='p-1') == [
        'p-1',
        'p-4',
        'p-8',
        'p-9',
        'p-10',
        'p-13',
    ]
    view = thread_view(record.board(), 'cy', 't-1', fold=True)
    assert view.earlier is not None
    assert 'It leaves out 6 of the 11 posts before it' in view.earlier


def test_a_disputed_summary_folds_nothing_and_shows_as_disputed() -> None:
    record = long_thread().post(Objection(id='p-15', thread='t-1', author='cy', text='Volume holds.', reply_to='p-12'))

    view = thread_view(record.board(), 'bo', 't-1', fold=True)

    assert len(view.posts) == 15
    assert (view.summary, view.earlier) == (None, None)
    assert next(item.standing for item in view.posts if item.post.id == 'p-12') == 'disputed'
    # Its line is in the brief's list of disputed posts, and no thread's line carries it.
    board = record.board()
    seen = brief(board, 'bo', news(board, 'bo', board.seq))
    assert 'p-12' in {entry.id for entry in seen.disputed}
    assert all(line.summary is None for line in seen.threads)


def test_brief_and_threads_carry_the_summary_on_the_threads_line() -> None:
    board = long_thread().board()

    (listed,) = (line for line in thread_summaries(board, 'cy') if line.thread.id == 't-1')
    seen = brief(board, 'cy', news(board, 'cy', board.seq))
    (line,) = (line for line in seen.threads if line.thread.id == 't-1')

    assert listed.summary is not None
    assert (listed.summary.id, listed.summary.text, listed.summary.body) == ('p-12', TEXT, '')
    assert listed.summary.by is not None
    # The brief's list of agents says who ada is, so the line there names no author, as a thread's latest line.
    assert line.summary is not None
    assert (line.summary.id, line.summary.by) == ('p-12', None)
    # A summary names its sources and builds nothing on them: the result that it names waits to be built on.
    built = worked().post(summary('p-3', 'ada', builds_on=('p-2',))).board()
    assert 'p-2' in {entry.id for entry in brief(built, 'cy', news(built, 'cy', built.seq)).not_built_on}


def test_a_record_from_before_summaries_reads_as_before() -> None:
    board = worked().board()

    view = thread_view(board, 'cy', 't-1', fold=True)
    (line,) = thread_summaries(board, 'cy')

    assert [item.post.id for item in view.posts] == ['p-1', 'p-2']
    assert '"summary"' not in view.model_dump_json()
    assert '"earlier"' not in view.model_dump_json()
    assert '"summary"' not in line.model_dump_json()
