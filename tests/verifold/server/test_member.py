import asyncio
from datetime import timedelta

import pytest
from conftest import agent
from fakes import FakeCopies

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.app import Heard
from verifold.protocol.ids import PERSON
from verifold.protocol.join import MAX_LINE, MAX_NEWS, MAX_PERSON_LINE, ManifestLine, PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.server.errors import EvidenceRejected, NoCleanCopy, OutOfTime
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.society.standing import standing
from verifold.store.record_file import RecordFile

EVIDENCE = (FileEvidence(path='bench.json', commit='c' * 40),)


async def a_claim(lab: Lab) -> None:
    """Give the lab ada's result p-2, with a file, in thread t-1."""
    await lab.post(PostRequest(kind='result', text='11.8x.', body='Run `make bench`.', thread='t-1'), 'ada', EVIDENCE)


def rerun_check(files: tuple[str, ...] = ('rerun.json',), method: str = 'rerun') -> PostRequest:
    return PostRequest.model_validate(
        {'kind': 'check', 'text': 'Reran it.', 'reply_to': 'p-2', 'thread': 't-1', 'outcome': 'holds'}
        | {'method': method, 'files': files}
    )


async def test_a_member_posts_reads_and_watches_as_its_agent(lab: Lab) -> None:
    bo = Member(lab, 'bo')

    posted = await bo.post(PostRequest(kind='objection', text='Leak.', thread='t-1', reply_to='p-1'))
    await bo.watch('t-1', watching=True)

    assert (posted.post.author, posted.standing) == ('bo', 'open')
    assert [item.standing for item in bo.thread('t-1').posts] == ['disputed', 'open']
    assert [summary.watching for summary in bo.threads().threads] == [True]


async def test_wait_returns_at_once_when_a_post_for_the_agent_is_there(lab: Lab) -> None:
    ada = Member(lab, 'ada')
    await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('ada',)), 'bo')

    news = await ada.wait(timeout=5)

    assert [entry.post.text for entry in news.posts] == ['Which layer?']
    assert news.seq == lab.board.seq


async def test_wait_sleeps_through_posts_that_do_not_wake_the_agent(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    waiting = asyncio.create_task(bo.wait(timeout=5))
    await lab.post(PostRequest(kind='message', text='Side note.', thread='t-1'), 'ada')
    await asyncio.sleep(0.01)
    assert not waiting.done()

    await lab.post(PostRequest(kind='message', text='Over to you.', thread='t-1', mentions=('bo',)), 'ada')
    news = await waiting

    assert [entry.post.text for entry in news.posts] == ['Over to you.']
    assert (news.other_posts, [line.text for line in news.others]) == (1, ['Side note.'])


async def test_news_gives_each_post_once_and_a_post_that_the_agent_got_does_not_end_a_wait(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
    await lab.post(PostRequest(kind='message', text='Side note.', thread='t-1'), 'ada')

    first = bo.news()
    second = bo.news()
    later = await bo.wait(timeout=0)

    assert first is not None
    assert ([line.text for line in first.for_you], [line.text for line in first.others]) == (
        ['Which layer?'],
        ['Side note.'],
    )
    assert second is not None
    assert (second.for_you, second.others, later.posts, bo.seen) == ((), (), (), lab.board.seq)


async def test_a_rewind_brings_back_the_posts_that_a_failed_turn_lost(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    before = bo.seen
    await lab.post(PostRequest(kind='ask', text='Which layer?', thread='t-1', mentions=('bo',)), 'ada')
    assert bo.news() is not None

    bo.rewind(before)
    again = await bo.wait(timeout=0)
    bo.rewind(lab.board.seq + 5)

    assert [entry.post.text for entry in again.posts] == ['Which layer?']
    assert bo.seen == lab.board.seq


def to_coordinator(text: str, body: str = '') -> PostRequest:
    return PostRequest(kind='message', text=text, body=body, conversation=True)


async def test_a_member_keeps_the_persons_newest_post_in_the_conversation_that_a_result_carried_and_records_nothing(
    lab: Lab, record_file: RecordFile
) -> None:
    await lab.set_coordinator('bo', PERSON)
    bo = Member(lab, 'bo')
    # A post of the person in another thread is not the one that the person's app asks about.
    await lab.post(PostRequest(kind='message', text='Try the small models.', thread='t-1'), PERSON)
    bo.news()
    elsewhere = bo.heard
    # The app makes the first line of the person's message the headline and the rest the body.
    steer = await lab.post(to_coordinator('Hi Bo,', 'Stop the tail line and rerun p-9.'), PERSON)
    recorded = len(record_file.read())
    not_read = bo.heard

    # The line of the news holds the whole post, and the time is the lab's clock at that result.
    carried = bo.news().for_you
    by_news = bo.heard
    # A later post of the person reaches bo in full in `wait`.
    again = await lab.post(to_coordinator('And post a report.'), PERSON)
    await bo.wait(timeout=0)
    by_wait = bo.heard
    # A `thread` that holds a post that bo read already changes nothing, so the time stays the time of the read.
    bo.thread(lab.board.conversation or '')

    assert (elsewhere, not_read) == (None, None)
    assert [(line.text, line.body) for line in carried] == [('Hi Bo,', 'Stop the tail line and rerun p-9.')]
    assert by_news == Heard(seq=steer.seq, at=steer.at + timedelta(seconds=1), whole=True)
    assert by_wait is not None
    assert (by_wait.seq, by_wait.whole, by_wait.at is not None and by_wait.at > again.at) == (again.seq, True, True)
    assert bo.heard == by_wait
    # The place and its time are facts of this server, and no event holds them.
    assert len(record_file.read()) == recorded + 1


async def test_a_member_says_when_a_result_carried_only_the_start_of_the_persons_post(lab: Lab) -> None:
    await lab.set_coordinator('bo', PERSON)
    bo = Member(lab, 'bo')
    long = await lab.post(to_coordinator('Here is the log.', 'x' * (MAX_PERSON_LINE + 1)), PERSON)

    # The line holds the headline whole and the body up to the bound, and the mark says that it was cut.
    line = bo.brief('').news.for_you[0]
    cut = bo.heard
    # The conversation in `thread` holds the post whole, so the agent got all of it then.
    bo.thread(lab.board.conversation or '')

    assert line.text == 'Here is the log.'
    assert (
        line.body
        == f'{"x" * (MAX_PERSON_LINE - 16)}… [cut: {MAX_PERSON_LINE + 1} characters, `thread` shows all of it]'
    )
    assert cut is not None
    assert (cut.seq, cut.whole) == (long.seq, False)
    assert bo.heard is not None
    assert (bo.heard.seq, bo.heard.whole, bo.heard.at is not None and cut.at is not None and bo.heard.at > cut.at) == (
        long.seq,
        True,
        True,
    )


async def test_the_persons_long_posts_last_in_twenty_threads_keep_the_news_under_twenty_lines_and_the_brief_small(
    lab: Lab,
) -> None:
    bo = Member(lab, 'bo')
    # The person opens MAX_NEWS threads, each with a message of MAX_PERSON_LINE characters, which is the last post.
    head, body = 'h' * 1000, 'b' * (MAX_PERSON_LINE - 1000)
    for number in range(MAX_NEWS):
        await lab.post(PostRequest(kind='message', text=head, body=body, new_thread=f'Line {number}'), PERSON)

    first = bo.brief('')
    after = bo.brief('')
    news_size, after_size = len(first.news.model_dump_json()), len(after.model_dump_json())

    # The news is the one place that carries the person's words whole: MAX_NEWS lines for bo, each with at most
    # MAX_PERSON_LINE characters of them and less than 300 of its other fields.
    news_bound = MAX_NEWS * (MAX_PERSON_LINE + 300)
    # Every other line holds at most MAX_LINE characters of a headline and no body. Each of the at most MAX_NEWS
    # summaries takes less than 1,000 more for its cut mark and its other fields, and the rest of this brief less
    # than 5,000. Without that rule, each summary of a thread would hold the person's message.
    brief_bound = MAX_NEWS * (MAX_LINE + 1_000) + 5_000
    assert [len(line.text) + len(line.body) for line in first.news.for_you] == [MAX_PERSON_LINE] * MAX_NEWS
    assert news_size < news_bound
    assert after_size < brief_bound < MAX_NEWS * MAX_PERSON_LINE
    assert 'b' * 100 not in after.model_dump_json()
    assert len(first.model_dump_json()) < news_bound + brief_bound


async def test_a_failed_turn_keeps_what_the_turns_before_it_carried_with_its_time(lab: Lab) -> None:
    await lab.set_coordinator('bo', PERSON)
    bo = Member(lab, 'bo')
    start = bo.seen
    await lab.post(to_coordinator('Where are we?'), PERSON)
    bo.news()
    read = bo.heard
    turn = bo.seen
    await lab.post(to_coordinator('And the tail line?'), PERSON)
    bo.news()

    # The turn that carried the second post failed, so that post counts as not carried. The first one still does.
    bo.rewind(turn)
    kept = bo.heard
    bo.rewind(start)

    assert read is not None
    assert read.at is not None
    assert kept == read
    assert bo.heard is None


async def test_a_seat_that_starts_at_a_place_in_the_record_knows_what_reached_its_agent_and_not_when(lab: Lab) -> None:
    await lab.set_coordinator('bo', PERSON)
    steer = await lab.post(to_coordinator('Try the small models.'), PERSON)
    long = await lab.post(to_coordinator('Here is the log.', 'x' * MAX_PERSON_LINE), PERSON)
    # The person's posts in other threads are not the ones that the app asks about.
    await lab.post(PostRequest(kind='message', text='Keep that one.', thread='t-1'), PERSON)
    await lab.join(agent('cy'))

    # The agent's news brought it every post for it up to its place. A line held the short post whole, and of the
    # long one the seat knows only that its line was cut.
    assert Member(lab, 'bo', seen=steer.seq).heard == Heard(seq=steer.seq, whole=True)
    assert Member(lab, 'bo', seen=lab.board.seq).heard == Heard(seq=long.seq, whole=False)
    assert Member(lab, 'bo', seen=steer.seq - 1).heard is None
    # The conversation is not for ada, and no result carried a post from before the agent joined.
    assert Member(lab, 'ada', seen=lab.board.seq).heard is None
    assert Member(lab, 'cy').heard is None
    assert Member(lab, PERSON).heard is None


async def test_the_first_brief_says_how_the_board_works_and_every_brief_carries_the_news(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    await lab.post(PostRequest(kind='plan', text='I take the small models.', new_thread='Plans'), 'ada')

    first = bo.brief('How the board works.')
    second = bo.brief('How the board works.')

    assert (first.you, first.how, second.how) == ('bo', 'How the board works.', '')
    assert [line.text for line in first.news.for_you] == ['I take the small models.']
    assert second.news.for_you == ()
    assert [(line.id, line.plan.text if line.plan else None) for line in first.agents] == [
        ('ada', 'I take the small models.')
    ]


async def test_wait_returns_the_summary_after_the_timeout_and_moves_on(lab: Lab) -> None:
    bo = Member(lab, 'bo')
    await lab.post(PostRequest(kind='message', text='Side note.', thread='t-1'), 'ada')

    first = await bo.wait(timeout=0.01)
    second = await bo.wait(timeout=0)

    assert (first.posts, first.other_posts) == ((), 1)
    assert second.other_posts == 0


async def test_a_post_with_files_carries_the_pinned_evidence(lab: Lab) -> None:
    pinned: list[tuple[str, ...]] = []

    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        pinned.append(paths)
        return tuple(FileEvidence(path=path, commit='a' * 40) for path in paths)

    bo = Member(lab, 'bo', pin=pin)

    posted = await bo.post(PostRequest(kind='result', text='11.9x faster.', thread='t-1', files=('bench.json',)))

    assert pinned == [('bench.json',)]
    assert [(item.path, item.commit) for item in posted.post.evidence] == [('bench.json', 'a' * 40)]


async def test_a_member_without_a_pin_refuses_files(lab: Lab) -> None:
    with pytest.raises(EvidenceRejected, match='cannot pin files'):
        await Member(lab, 'bo').post(PostRequest(kind='result', text='x', thread='t-1', files=('bench.json',)))


async def test_a_request_for_a_rerun_starts_nothing_and_stays_open(lab: Lab) -> None:
    await a_claim(lab)
    agents, seq = lab.board.agents, lab.board.seq
    bo = Member(lab, 'bo')

    requested = await Member(lab, 'ada').rerun('p-2')

    # The record got the request and nothing else: no agent joined for it.
    assert (requested.by, requested.post, lab.board.seq) == ('ada', 'p-2', seq + 1)
    assert lab.board.agents == agents
    brief = bo.brief('')
    assert [(line.post, line.asked_by, line.taken_by) for line in brief.reruns_wanted] == [('p-2', ('ada',), ())]
    assert [line.post for line in brief.news.reruns] == ['p-2']
    # The author reads the wanted rerun in its brief, and cannot take it.
    assert [line.post for line in Member(lab, 'ada').brief('').reruns_wanted] == ['p-2']


async def test_an_agent_takes_a_rerun_and_gets_the_claim_and_a_clean_copy(lab: Lab) -> None:
    await a_claim(lab)
    await Member(lab, 'ada').rerun('p-2')
    copies = FakeCopies()
    bo = Member(lab, 'bo', copies=copies)

    taken = await bo.take_rerun('p-2')

    assert (taken.post, taken.thread, taken.author, taken.text, taken.body) == (
        'p-2',
        't-1',
        'ada',
        '11.8x.',
        'Run `make bench`.',
    )
    assert (taken.files, taken.commit, taken.folder) == (('bench.json',), 'c' * 40, str(copies.folder / 'p-2'))
    assert copies.made == [('p-2', 'ada')]
    assert [(entry.agent, entry.post, entry.commit) for entry in lab.board.takes] == [('bo', 'p-2', 'c' * 40)]
    assert [line.taken_by for line in Member(lab, 'ada').brief('').reruns_wanted] == [('bo',)]

    # A second call records nothing more and gives the same copy.
    again = await bo.take_rerun('p-2')
    assert (again.folder, len(lab.board.takes)) == (taken.folder, 1)


async def test_the_first_rerun_check_with_files_after_a_take_is_the_check_of_that_take(lab: Lab) -> None:
    pinned: list[tuple[str, ...]] = []

    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        pinned.append(paths)
        return tuple(FileEvidence(path=path, commit=f'{len(pinned):x}' * 40) for path in paths)

    await a_claim(lab)
    await Member(lab, 'ada').rerun('p-2')
    await lab.join(agent('cy').model_copy(update={'model': ModelSpec(family='openai')}))
    # With three agents the lab has one reviewer seat, which a check and a take need.
    await lab.set_reviewer('cy', 'cy', reviewer=True)
    cy = Member(lab, 'cy', pin=pin, copies=FakeCopies())

    # Before the take, a rerun is a check like any other, and it answers no request.
    plain = await cy.post(rerun_check())
    assert plain.post.model_dump()['take'] is None
    assert standing(lab.board, 'p-2') == 'checked'

    await cy.take_rerun('p-2')
    # A check by another method, and a rerun without files, are not the check of the take.
    read = await cy.post(rerun_check(method='code_read'))
    bare = await cy.post(rerun_check(files=()))
    assert (read.post.model_dump()['take'], bare.post.model_dump()['take']) == (None, None)
    checked = await cy.post(rerun_check())

    # Every file came from the agent's own folder by the pin that every post uses, each with its own commit.
    assert pinned == [('rerun.json',)] * 3
    assert [(file.path, file.commit) for file in checked.post.evidence] == [('rerun.json', '3' * 40)]
    assert checked.post.model_dump()['take'] == lab.board.takes[0].seq
    # The check answers the request, and it comes from another model family, so the post is held up.
    assert Member(lab, 'ada').brief('').reruns_wanted == ()
    assert standing(lab.board, 'p-2') == 'held_up'
    # One take is one such check. A later rerun of the same agent is a plain check again, and the files of the
    # take's check stay pinned as they were.
    again = await cy.post(rerun_check())
    assert again.post.model_dump()['take'] is None
    assert [entry.post.evidence[0].commit for entry in lab.board.posts if entry.post.id == checked.post.id] == [
        '3' * 40
    ]


async def test_who_can_take_a_rerun(lab: Lab) -> None:
    await a_claim(lab)

    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        return tuple(FileEvidence(path=path, commit='a' * 40) for path in paths)

    ada, bo = Member(lab, 'ada', copies=FakeCopies()), Member(lab, 'bo', pin=pin, copies=FakeCopies())

    with pytest.raises(RejectedEvent, match='No rerun of post p-2 is wanted now'):
        await bo.take_rerun('p-2')
    with pytest.raises(RejectedEvent, match='Post p-9 does not exist'):
        await bo.take_rerun('p-9')
    await ada.rerun('p-2')
    with pytest.raises(RejectedEvent, match='p-2 is your own'):
        await ada.take_rerun('p-2')
    with pytest.raises(NoCleanCopy, match='cannot make a clean copy'):
        await Member(lab, 'bo').take_rerun('p-2')

    # With a third agent the lab has one reviewer seat. While its holder can take the rerun, no other agent can.
    await lab.join(agent('cy'))
    cy = Member(lab, 'cy', copies=FakeCopies())
    await lab.set_reviewer('cy', 'cy', reviewer=True)
    assert [line.open_to for line in bo.brief('').reruns_wanted] == ['reviewer']
    with pytest.raises(RejectedEvent, match='takes a reviewer seat while an agent in such a seat can take it'):
        await bo.take_rerun('p-2')
    assert lab.board.takes == ()
    # The holder took it, so no agent in a reviewer seat can take it any more, and any other agent can once the
    # holder's lease ends.
    await cy.take_rerun('p-2')
    assert [(line.open_to, line.taken_by) for line in bo.brief('').reruns_wanted] == [('any', ('cy',))]
    with pytest.raises(RejectedEvent, match='cy holds the rerun of post p-2 since'):
        await bo.take_rerun('p-2')
    await cy.take_rerun('p-2', give_up=True)
    assert (await bo.take_rerun('p-2')).post == 'p-2'
    # The one check of that rerun needs no seat of its own. Any other check of bo's does, also a later rerun.
    with pytest.raises(RejectedEvent, match=r'A check on another agent.s post takes a reviewer seat'):
        await bo.post(rerun_check(files=(), method='code_read'))
    checked = await bo.post(rerun_check())
    assert checked.post.model_dump()['take'] == lab.board.takes[1].seq
    with pytest.raises(RejectedEvent, match=r'A check on another agent.s post takes a reviewer seat'):
        await bo.post(rerun_check())


async def test_a_clean_copy_that_fails_records_no_take_and_the_agent_can_take_the_rerun_afterwards(lab: Lab) -> None:
    await a_claim(lab)
    await Member(lab, 'ada').rerun('p-2')
    copies = FakeCopies(fails=True)
    bo = Member(lab, 'bo', copies=copies)
    seq = lab.board.seq

    with pytest.raises(NoCleanCopy, match='Verifold could not make the clean copy of post p-2'):
        await bo.take_rerun('p-2')

    assert (lab.board.takes, lab.board.seq) == ((), seq)
    assert [line.taken_by for line in bo.brief('').reruns_wanted] == [()]
    copies.fails = False
    assert (await bo.take_rerun('p-2')).folder == str(copies.folder / 'p-2')
    assert len(lab.board.takes) == 1


async def test_a_take_returns_the_manifest_of_the_copy_and_the_record_keeps_its_digest(lab: Lab) -> None:
    await a_claim(lab)
    await Member(lab, 'ada').rerun('p-2')
    copies = FakeCopies()
    bo = Member(lab, 'bo', copies=copies)

    taken = await bo.take_rerun('p-2')

    assert [(line.path, line.size, line.sha256) for line in taken.manifest] == [('bench.json', 4, 'ab' * 32)]
    assert (taken.manifest_files, taken.manifest_sha256) == (1, 'cd' * 32)
    assert taken.manifest_file == str(copies.folder / 'p-2.manifest')
    assert lab.board.takes[0].manifest == 'cd' * 32
    # A manifest of very many files is in its file only, and the result says how many it has.
    copies.files = tuple(ManifestLine(path=f'f{number}', size=1, sha256='ab' * 32) for number in range(201))
    await bo.take_rerun('p-2', give_up=True)
    await lab.join(agent('cy'))
    many = await Member(lab, 'cy', copies=copies).take_rerun('p-2')
    assert (many.manifest, many.manifest_files) == ((), 201)
    # bo's renewal makes no export: it gives the folder of its take, the manifest's file, and the record's SHA-256.
    again = await bo.take_rerun('p-2')
    assert (again.folder, again.manifest_file, again.manifest_sha256) == (
        str(copies.folder / 'p-2'),
        str(copies.folder / 'p-2.manifest'),
        'cd' * 32,
    )
    assert (again.manifest, again.manifest_files, copies.made) == ((), 0, [('p-2', 'ada'), ('p-2', 'ada')])


async def test_two_calls_of_one_agent_at_the_same_time_are_one_take_and_one_check_of_it(lab: Lab) -> None:
    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        # The pin takes a moment, so both checks start before either is posted.
        await asyncio.sleep(0.01)
        return tuple(FileEvidence(path=path, commit='a' * 40) for path in paths)

    await a_claim(lab)
    await Member(lab, 'ada').rerun('p-2')
    bo = Member(lab, 'bo', pin=pin, copies=FakeCopies())

    first, second = await asyncio.gather(bo.take_rerun('p-2'), bo.take_rerun('p-2'))

    # The later call renews the lease of the first, so only the end of the lease can differ.
    assert (first.folder, first.commit, first.held_since, len(lab.board.takes)) == (
        second.folder,
        second.commit,
        second.held_since,
        1,
    )
    # The first check is the check of the take. The second posts as a check like any other, and is not refused.
    checks = await asyncio.gather(bo.post(rerun_check()), bo.post(rerun_check()))
    assert [check.post.model_dump()['take'] for check in checks] == [lab.board.takes[0].seq, None]
    # With reviewer seats, the second one follows the seat rule, as any other check does.
    await lab.join(agent('cy'))
    await Member(lab, 'person').rerun('p-2')
    cy = Member(lab, 'cy', pin=pin, copies=FakeCopies())
    await cy.take_rerun('p-2')
    both = await asyncio.gather(cy.post(rerun_check()), cy.post(rerun_check()), return_exceptions=True)
    assert both[0].post.model_dump()['take'] == lab.board.takes[1].seq  # ty: ignore[unresolved-attribute]
    assert isinstance(both[1], RejectedEvent)
    assert 'takes a reviewer seat' in str(both[1])


async def test_a_second_take_of_the_same_post_gives_the_same_copy_and_renews_the_lease(lab: Lab) -> None:
    await a_claim(lab)
    await Member(lab, 'ada').rerun('p-2')
    copies = FakeCopies()
    bo = Member(lab, 'bo', copies=copies)
    first = await bo.take_rerun('p-2')

    again = await bo.take_rerun('p-2')

    assert (again.folder, len(lab.board.takes)) == (first.folder, 1)
    (renewed,) = lab.board.leases
    assert (renewed.agent, renewed.post, renewed.held) == ('bo', 'p-2', True)
    assert (again.held_since, again.held_until) == (first.held_since, renewed.at + timedelta(minutes=10))


async def test_a_request_ends_the_wait_of_an_agent_that_can_take_it(lab: Lab) -> None:
    await a_claim(lab)
    bo = Member(lab, 'bo')
    waiting = asyncio.create_task(bo.wait(30))
    await asyncio.sleep(0)

    await Member(lab, 'ada').rerun('p-2')

    news = await asyncio.wait_for(waiting, 5)
    assert (news.posts, [line.post for line in news.reruns]) == ((), ['p-2'])
    # The agent got the request once.
    assert (await bo.wait(0)).reruns == ()


async def test_the_board_refuses_a_guest_while_the_lab_is_out_of_time_and_never_an_agent_that_verifold_runs(
    lab: Lab,
) -> None:
    await lab.join(Agent(id='guest', name='Guest', harness='guest', model=ModelSpec(family='unknown')))
    guest, bo = Member(lab, 'guest'), Member(lab, 'bo')
    message = PostRequest(kind='message', text='One more.', thread='t-1')
    await guest.post(message)

    # The person stops the lab. The end has passed a moment before the record says that the time ran out.
    await lab.set_time_left(timedelta(0))
    with pytest.raises(OutOfTime, match='The person can give the lab more time'):
        await guest.post(message)
    await lab.run_out_of_time()
    with pytest.raises(OutOfTime):
        await guest.post(message)
    with pytest.raises(OutOfTime):
        await guest.rerun('p-1')
    with pytest.raises(OutOfTime):
        await guest.take_rerun('p-1')
    # Verifold stops the turn of an agent that it started, so the board refuses that agent nothing.
    await bo.post(message)
    await Member(lab, 'person').post(message)

    await lab.set_time_left(timedelta(hours=1))
    await guest.post(message)

    assert [entry.post.author for entry in lab.board.posts[1:]] == ['guest', 'bo', 'person', 'guest']


async def test_a_seat_can_start_from_an_earlier_event_so_that_its_agent_gets_what_came_since(lab: Lab) -> None:
    await lab.post(PostRequest(kind='message', text='For Bo.', thread='t-1', mentions=('bo',)), 'ada')

    now, earlier = Member(lab, 'bo'), Member(lab, 'bo', seen=lab.board.posts[0].seq)

    assert (await now.wait(0)).posts == ()
    assert [entry.post.text for entry in (await earlier.wait(0)).posts] == ['For Bo.']


async def test_a_rerun_of_an_offer_is_asked_for_taken_and_checked_as_for_any_post_with_files(lab: Lab) -> None:
    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        return tuple(FileEvidence(path=path, commit='a' * 40) for path in paths)

    await lab.add_deliverable('A script that runs it again.')
    ada, bo = Member(lab, 'ada', pin=pin), Member(lab, 'bo', pin=pin, copies=FakeCopies())
    offered = await ada.offer('d-1', ('run.py',), 'Runs with one command.')
    offer = offered.post.id

    await Member(lab, 'person').rerun(offer)
    wanted = [(line.post, line.thread, line.asked_by, line.taken_by) for line in bo.brief('').reruns_wanted]
    taken = await bo.take_rerun(offer)
    during = [line.taken_by for line in ada.brief('').reruns_wanted]
    check = PostRequest.model_validate(
        {'kind': 'check', 'text': 'It runs.', 'reply_to': offer, 'thread': offered.post.thread, 'outcome': 'holds'}
        | {'method': 'rerun', 'files': ('rerun.log',)}
    )
    checked = await bo.post(check)

    assert wanted == [(offer, offered.post.thread, ('person',), ())]
    assert (taken.post, taken.files, during) == (offer, ('run.py',), [('bo',)])
    assert checked.post.model_dump()['take'] == lab.board.takes[0].seq
    # The check answers the request and says where the offer's post stands. It decides nothing for the person.
    (line,) = ada.brief('').deliverables
    assert ada.brief('').reruns_wanted == ()
    assert [(item.post, item.standing, item.state) for item in line.offers] == [(offer, 'checked', 'waiting')]
    assert line.state == 'offered'


async def test_the_persons_post_that_waits_for_a_reply_ends_one_wait_of_the_coordinator_and_no_later_one(
    lab: Lab,
) -> None:
    await lab.set_coordinator('ada', PERSON)
    ada = Member(lab, 'ada')
    said = await lab.post(to_coordinator('Status update?'), PERSON)

    first = await ada.wait(timeout=5)
    waiting = asyncio.create_task(ada.wait(timeout=5))
    # The line is no post: it ends no wait.
    await asyncio.sleep(0.05)
    assert not waiting.done()
    await lab.post(PostRequest(kind='message', text='Over to you.', thread='t-1', mentions=('ada',)), 'bo')
    later = await waiting

    assert [item.post.id for item in first.posts] == [said.post.id]
    assert [item.post.text for item in later.posts] == ['Over to you.']
    line = f"The person's post {said.post.id} in the conversation has waited less than a minute for your reply."
    assert (first.no_reply, later.no_reply, ada.news().no_reply) == (line, line, line)
