import asyncio
import errno
from datetime import UTC, timedelta
from pathlib import Path
from typing import IO

import pytest
from builders import START
from builders import lab as record_lab

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_HEADLINE, Check, FileEvidence, Result
from verifold.server.errors import LabExists
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.attention import wakes
from verifold.society.errors import RejectedEvent
from verifold.society.standing import standing
from verifold.society.views import answer_view
from verifold.store import record_file as record_file_module
from verifold.store.errors import CorruptRecord, RecordChanged
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


async def test_a_post_opens_a_side_thread_between_its_author_and_the_agents_that_it_names(
    lab: Lab, record_file: RecordFile
) -> None:
    request = PostRequest(kind='message', text='Can you fetch it?', new_thread='Scoreboard', between=('ada', 'bo'))
    posted = await lab.post(request, 'bo')

    # The author comes first, whether it names itself or not, and the post itself holds no `between`.
    assert lab.board.threads[-1].thread.between == ('bo', 'ada')
    assert lab.board.members(posted.post.thread) == ('bo', 'ada')
    assert 'between' not in posted.post.model_dump()
    with pytest.raises(RejectedEvent, match='at least one other agent'):
        await lab.post(request.model_copy(update={'between': ('bo',)}), 'bo')
    with pytest.raises(RejectedEvent, match='at least one other agent'):
        await lab.post(request, 'person')
    # A lab that loads the record again has the same side thread.
    assert Lab.load(record_file).board.members('t-2') == ('bo', 'ada')
    assert len(lab.board.threads) == 2


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
    question = f'{"Why " * 300}?\nUse the GPU.'
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
    with pytest.raises(RejectedEvent, match='You asked for an independent rerun of p-2 already'):
        await lab.request_rerun('bo', 'p-2')

    assert ([entry.by for entry in lab.board.reruns], lab.board.seq) == (['bo', 'person'], before + 2)


def an_old_record(record_file: RecordFile) -> Lab:
    """
    Load a lab from before agents took reruns.

    Verifold started the checker dee of another family for bo's request, and its check of ada's result p-1 holds.
    It started the checker eve for cy's request for ada's result p-3, and eve stopped without a check.
    """
    files = (FileEvidence(path='bench.json', commit='c' * 40),)
    record = record_lab().post(Result(id='p-1', thread='t-1', author='ada', text='11.8x.', evidence=files))
    record.rerun('bo', 'p-1').join('dee', family='openai', checks='p-1', name='Checker 7')
    record.post(
        Check(id='p-2', thread='t-1', author='dee', text='Holds.', reply_to='p-1', outcome='holds', method='rerun')
    )
    record.post(Result(id='p-3', thread='t-1', author='ada', text='12.1x.', evidence=files))
    record.rerun('cy', 'p-3').join('eve', family='openai', checks='p-3', name='Checker 12')
    record.turn('eve', error='The checker stopped without a check.', rerun_failed=True)
    record_file.append(*record.events)
    return Lab.load(record_file)


async def test_an_old_record_with_checkers_loads_and_its_posts_stand_as_they_did(record_file: RecordFile) -> None:
    lab = an_old_record(record_file)
    board = lab.board

    # The checkers are in the record with their old names, and the check holds the post up as before.
    assert [entry.agent.name for entry in board.agents if entry.agent.checks] == ['Checker 7', 'Checker 12']
    assert (standing(board, 'p-1'), standing(board, 'p-3')) == ('held_up', 'open')
    checked = Member(lab, 'ada').thread('t-1').posts[1]
    assert (checked.post.author, checked.by and checked.by.name) == ('dee', 'Checker 7')
    # A checker is no agent of the lab: it holds no seat, and no agent reads it as a peer.
    assert [line.id for line in Member(lab, 'ada').brief('').agents] == ['bo', 'cy']
    # Nothing is wanted: one request has its check, and the other ended with its checker.
    assert Member(lab, 'ada').brief('').reruns_wanted == ()


async def test_a_lab_from_an_old_record_goes_on_with_reruns_that_agents_take(record_file: RecordFile) -> None:
    lab = an_old_record(record_file)
    await lab.set_reviewer('cy', 'cy', reviewer=True)

    # A member can ask again after its checker failed, and now an agent of the lab takes the rerun.
    again = await lab.request_rerun('cy', 'p-3')
    taken = await lab.take_rerun('cy', 'p-3')

    assert (again.by, taken.agent, taken.commit) == ('cy', 'cy', 'c' * 40)
    assert [line.post for line in Member(lab, 'ada').brief('').reruns_wanted] == ['p-3']


async def test_no_agent_joins_as_the_checker_of_one_post(lab: Lab) -> None:
    checker = Agent(id='dee', name='Dee', harness='fake', model=ModelSpec(family='openai'), checks='p-1')

    with pytest.raises(RejectedEvent, match='No agent joins a lab as the checker of one post'):
        await lab.join(checker)

    assert lab.board.agent('dee') is None


async def test_a_grant_is_recorded_once_and_survives_a_reload(lab: Lab, record_file: RecordFile) -> None:
    await lab.grant('./gpu')
    await lab.grant('make')
    await lab.grant('./gpu')

    assert lab.board.grants == ('./gpu', 'make')
    assert Lab.load(record_file).board.grants == ('./gpu', 'make')


async def test_a_revision_goes_in_the_questions_thread_as_the_persons_post_and_survives_a_reload(
    record_file: RecordFile,
) -> None:
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: START)
    await lab.open_question_thread()
    await lab.join(Agent(id='ada', name='Ada', harness='fake', model=ModelSpec(family='anthropic')))

    revised = await lab.revise_question('Does it hold on ARM?', 'x86 only so far.')
    same = await lab.revise_question('Does it hold on ARM?', 'Another reason.')

    assert revised is not None
    assert same is None
    assert [event.type for event in record_file.read()][-2:] == ['posted', 'question_revised']
    told = lab.board.posts[-1]
    assert (told.post.id, told.post.thread, told.post.author, told.post.kind) == ('p-2', 't-1', 'person', 'message')
    assert told.post.text == 'The person revised the question: Does it hold on ARM?'
    assert told.post.body == 'Why: x86 only so far.'
    assert (revised.post, revised.note, lab.board.question) == ('p-2', 'x86 only so far.', 'Does it hold on ARM?')
    assert wakes(lab.board, 'ada', told)
    assert Lab.load(record_file).board == lab.board


async def test_a_long_revision_keeps_all_of_its_text_in_the_body_of_its_post(record_file: RecordFile) -> None:
    lab = Lab.create(record_file, 'Does it hold?')
    await lab.open_question_thread()
    question = f'{"Why " * 300}?\nUse the GPU.'

    await lab.revise_question(question)

    post = lab.board.posts[-1].post
    assert (len(post.text), post.text[-1], post.body) == (MAX_HEADLINE, '…', question)


async def test_a_lab_that_is_out_of_time_takes_a_revision(record_file: RecordFile) -> None:
    lab = Lab.create(record_file, 'Does it hold?', time_left=timedelta(0), clock=lambda: START)
    await lab.open_question_thread()
    await lab.run_out_of_time()

    await lab.revise_question('Does it hold on ARM?')

    assert (lab.board.out_of_time, lab.board.question) == (True, 'Does it hold on ARM?')


async def test_the_same_text_with_spaces_around_it_is_no_revision(lab: Lab) -> None:
    seq = lab.board.seq

    assert await lab.revise_question('  Does it hold? ') is None
    assert lab.board.seq == seq


async def test_a_lab_from_before_the_question_had_a_thread_gets_one_thread_for_its_revisions(lab: Lab) -> None:
    await lab.revise_question('Does it hold on x86?')
    assert lab.board.posts[-1].post.thread == 't-2'
    await lab.revise_question('Does it hold on ARM?')
    assert len(lab.board.threads) == 2

    opened, told = lab.board.threads[-1].thread, lab.board.posts[-1]
    assert (opened.id, opened.title, opened.opened_by, opened.between) == ('t-2', 'The question, revised', 'person', ())
    assert (told.post.thread, lab.board.revisions[-1].post) == ('t-2', told.post.id)
    assert wakes(lab.board, 'bo', told)


async def test_a_proposal_from_an_agent_that_had_not_seen_the_revision_answers_the_earlier_version(
    record_file: RecordFile,
) -> None:
    lab = Lab.create(record_file, 'Does it hold?')
    await lab.open_question_thread()
    await lab.join(Agent(id='ada', name='Ada', harness='fake', model=ModelSpec(family='anthropic')))
    ada = Member(lab, 'ada')
    proposal = PostRequest(kind='proposal', text='It holds.', thread='t-1')

    # Ada works on the first question, the person revises it, and Ada posts the answer that it wrote before.
    await lab.revise_question('Does it hold on ARM?')
    late = await ada.post(proposal)
    raced = answer_view(lab.board)
    # The result of that post showed Ada the revision, so its next proposal is to the current question.
    news = ada.news()
    assert news is not None
    assert [line.id for line in news.for_you] == ['p-2']
    read = await ada.post(proposal)
    current = answer_view(lab.board)

    assert (late.post.kind, late.seq > lab.board.revisions[-1].seq) == ('proposal', True)
    assert raced is not None
    assert current is not None
    assert (raced.answer.post.id, raced.to_earlier_question) == ('p-3', True)
    assert (current.answer.post.id, current.to_earlier_question) == ('p-4', False)
    assert [getattr(entry.post, 'question_seen', None) for entry in lab.board.posts] == [None, None, 0, 1]
    assert read.post.id == 'p-4'
    assert Lab.load(record_file).board == lab.board


def said(caplog: pytest.LogCaptureFixture) -> list[str]:
    """Return what the lab itself logged. Another library's warning is not its word."""
    return [entry.getMessage() for entry in caplog.records if entry.name == 'verifold.server.lab']


async def test_the_lab_says_what_the_record_moved_out_of_its_file_and_goes_on(
    lab: Lab, record_file: RecordFile, caplog: pytest.LogCaptureFixture
) -> None:
    with record_file.path.open('ab') as other:
        other.write(b'not an event\n')
    await lab.post(message('Still here.'), 'bo')
    with record_file.path.open('ab') as other:
        other.write(b'\n')
    await lab.post(message('And here.'), 'bo')

    assert said(caplog) == [
        f'Verifold moved {size} that another program added to the end of the record to {record_file.foreign}.'
        for size in ('13 bytes', '1 byte')
    ]
    assert record_file.foreign.read_bytes() == b'not an event\n\n'
    assert Lab.load(record_file).board == lab.board


async def test_the_lab_says_what_the_record_moved_also_when_its_own_write_then_fails(
    lab: Lab, record_file: RecordFile, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    board, sync, synced = lab.board, record_file_module._sync, []

    def full_disk_after_the_move(file: IO[bytes]) -> None:
        # The side file comes first, and then the record.
        synced.append(file)
        if len(synced) > 1:
            raise OSError(errno.ENOSPC, 'No space left on device')
        sync(file)

    with record_file.path.open('ab') as other:
        other.write(b'not an event\n')
    monkeypatch.setattr(record_file_module, '_sync', full_disk_after_the_move)

    with pytest.raises(OSError, match='No space'):
        await lab.post(message('Still here.'), 'bo')

    assert said(caplog) == [
        f'Verifold moved 13 bytes that another program added to the end of the record to {record_file.foreign}.'
    ]
    assert lab.board == Lab.load(record_file).board == board
    assert record_file.foreign.read_bytes() == b'not an event\n'


async def test_a_write_that_finds_the_record_changed_tells_what_stops_the_server_and_its_caller(
    record_file: RecordFile,
) -> None:
    heard: list[RecordChanged] = []
    lab = Lab.create(record_file, 'Does it hold?', stops=heard.append)
    await lab.join(Agent(id='ada', name='Ada', harness='fake', model=ModelSpec(family='anthropic')))
    board = lab.board
    record_file.path.unlink()

    with pytest.raises(RecordChanged, match='replaced or removed the record') as refused:
        await lab.open_question_thread()

    assert heard == [refused.value]
    assert lab.board == board
    assert len(record_file.path.with_name('record.kept.jsonl').read_bytes().splitlines()) == board.seq == 2


def test_a_new_lab_tells_what_stops_the_server_when_its_first_write_finds_the_record_changed(
    record_file: RecordFile,
) -> None:
    heard: list[RecordChanged] = []
    record_file.path.unlink()

    with pytest.raises(RecordChanged, match='replaced or removed the record'):
        Lab.create(record_file, 'Does it hold?', stops=heard.append)

    assert [str(error) for error in heard] == [
        f'Another program replaced or removed the record {record_file.path}, so Verifold stops.'
    ]


def test_a_record_that_does_not_add_up_to_a_lab_names_the_line_of_the_first_event_that_does_not_fit(
    tmp_path: Path,
) -> None:
    events = record_lab().events
    with RecordFile(tmp_path / 'twice.jsonl') as twice, RecordFile(tmp_path / 'headless.jsonl') as headless:
        twice.append(*events, events[-1])
        headless.append(*events[1:])

        with pytest.raises(CorruptRecord, match=r'twice\.jsonl .* at line 6: Event 5 does not follow event 5\.$'):
            Lab.load(twice)
        with pytest.raises(CorruptRecord, match=r'headless\.jsonl .* at line 1: A record starts with lab_opened'):
            Lab.load(headless)
