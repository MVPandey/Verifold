import asyncio
from datetime import UTC, timedelta

import pytest
from builders import START

from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_HEADLINE, FileEvidence
from verifold.server.errors import LabExists
from verifold.server.lab import Lab
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile


def message(text: str, thread: str = 't-1') -> PostRequest:
    return PostRequest(kind='message', text=text, thread=thread)


async def test_a_post_can_open_its_thread_in_one_step(lab: Lab) -> None:
    posted = await lab.post(PostRequest(kind='ask', text='Which layer?', new_thread='Which layer?'), 'bo')
    board = lab.board

    assert (posted.post.id, posted.post.thread) == ('p-2', 't-2')
    assert board.threads[-1].thread.opened_by == 'bo'
    assert board.threads[-1].at == posted.at == START + timedelta(seconds=4)
    assert posted.seq == board.seq == 7


async def test_a_rejected_post_leaves_no_trace(lab: Lab, record_file: RecordFile) -> None:
    before = lab.board.seq

    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        await lab.post(PostRequest(kind='objection', text='Flawed.', thread='t-1', reply_to='p-9'), 'bo')
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        await lab.post(PostRequest(kind='message', text='Hi.', new_thread='New subject', mentions=('zed',)), 'bo')

    assert len(record_file.read()) == lab.board.seq == before
    assert len(lab.board.threads) == 1


async def test_posts_at_the_same_time_get_their_own_ids(lab: Lab) -> None:
    posted = await asyncio.gather(*(lab.post(message(f'Note {n}.'), 'bo') for n in range(20)))

    assert sorted(entry.post.id for entry in posted) == sorted(f'p-{n}' for n in range(2, 22))


async def test_watches_are_recorded(lab: Lab) -> None:
    watch = await lab.watch('bo', 't-1', watching=True)

    assert lab.board.watches == (watch,)


async def test_a_reloaded_lab_has_the_same_board(lab: Lab, record_file: RecordFile) -> None:
    await lab.post(message('Starting.'), 'ada')

    assert Lab.load(record_file).board == lab.board


async def test_a_waiter_wakes_on_the_next_event(lab: Lab) -> None:
    seen = lab.board.seq
    waiter = asyncio.create_task(lab.wait_for_change(seen, timeout=5))
    await asyncio.sleep(0)
    assert not waiter.done()

    await lab.post(message('Ready.'), 'bo')

    async with asyncio.timeout(1):
        await waiter
    assert lab.board.seq == seen + 1


async def test_a_wait_returns_at_once_when_the_board_moved_on(lab: Lab) -> None:
    async with asyncio.timeout(1):
        await lab.wait_for_change(1, timeout=60)


async def test_a_wait_times_out_with_no_change(lab: Lab) -> None:
    seen = lab.board.seq

    await lab.wait_for_change(seen, timeout=0.01)

    assert lab.board.seq == seen


async def test_a_new_lab_needs_an_empty_record(lab: Lab, record_file: RecordFile) -> None:
    with pytest.raises(LabExists, match='holds a lab already'):
        Lab.create(record_file, 'Another question?')

    assert Lab.load(record_file).board == lab.board


def test_the_default_clock_is_utc(record_file: RecordFile) -> None:
    assert Lab.create(record_file, 'Does it hold?').board.opened.at.tzinfo is UTC


async def test_a_lab_with_a_time_limit_ends_that_long_after_it_opens(record_file: RecordFile) -> None:
    lab = Lab.create(record_file, 'Does it hold?', time_left=timedelta(minutes=30), clock=lambda: START)

    assert lab.board.ends_at == START + timedelta(minutes=30)
    assert lab.now() == START
    with pytest.raises(RejectedEvent, match='runs out of time once'):
        await lab.run_out_of_time()

    await lab.set_time_left(timedelta(0))
    await lab.run_out_of_time()

    assert lab.board.out_of_time
    assert [event.type for event in record_file.read()][-2:] == ['time_set', 'time_ran_out']


async def test_a_lab_opens_the_question_thread_with_the_question_as_the_persons_first_post(
    record_file: RecordFile,
) -> None:
    lab = Lab.create(record_file, 'Does it hold?')

    posted = await lab.open_question_thread()

    opened = lab.board.threads[0].thread
    assert (opened.id, opened.title, opened.opened_by) == ('t-1', 'The question', 'person')
    assert (posted.post.id, posted.post.author, posted.post.kind) == ('p-1', 'person', 'message')
    assert (posted.post.text, posted.post.body) == ('Does it hold?', '')


async def test_a_long_question_keeps_its_first_line_as_the_headline_and_all_of_it_as_the_body(
    record_file: RecordFile,
) -> None:
    question = f'{"Why " * 100}?\nUse the GPU.'
    lab = Lab.create(record_file, question)

    post = (await lab.open_question_thread()).post

    assert len(post.text) == MAX_HEADLINE
    assert post.text.endswith('…')
    assert post.body == question


@pytest.mark.parametrize(('question', 'headline'), [('\x1cDoes it hold?', 'Does it hold?'), ('\x1c', 'The question')])
async def test_a_question_that_starts_with_a_line_separator_still_gets_a_headline(
    record_file: RecordFile, question: str, headline: str
) -> None:
    lab = Lab.create(record_file, question)

    assert (await lab.open_question_thread()).post.text == headline


async def test_a_member_cannot_ask_twice_for_a_rerun_while_its_request_is_open(lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)
    before = lab.board.seq

    await lab.request_rerun('bo', 'p-2')
    await lab.request_rerun('person', 'p-2')
    with pytest.raises(RejectedEvent, match='You asked for a blind rerun of p-2 already'):
        await lab.request_rerun('bo', 'p-2')

    assert ([entry.by for entry in lab.board.reruns], lab.board.seq) == (['bo', 'person'], before + 2)
