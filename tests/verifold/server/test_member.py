import asyncio
from datetime import timedelta

import pytest
from conftest import agent
from fakes import FakeCopies

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.server.errors import EvidenceRejected, NoCleanCopy, OutOfTime
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.society.standing import standing

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


async def test_the_check_of_a_rerun_that_an_agent_took_gets_its_files_from_the_clean_copy(lab: Lab) -> None:
    async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        return tuple(FileEvidence(path=path, commit='a' * 40) for path in paths)

    await a_claim(lab)
    await Member(lab, 'ada').rerun('p-2')
    await lab.join(agent('cy').model_copy(update={'model': ModelSpec(family='openai')}))
    # With three agents the lab has one reviewer seat, which a check and a take need.
    await lab.set_reviewer('cy', 'cy', reviewer=True)
    copies = FakeCopies()
    cy = Member(lab, 'cy', pin=pin, copies=copies)

    # Before the take, a rerun's files come from the agent's own folder, and the check answers no request.
    plain = await cy.post(rerun_check())
    assert (plain.post.evidence[0].commit, copies.pinned, plain.post.model_dump()['take']) == ('a' * 40, [], None)
    assert standing(lab.board, 'p-2') == 'checked'

    await cy.take_rerun('p-2')
    # A check by another method, and a post of another kind, still pin from the agent's own folder.
    read = await cy.post(rerun_check(method='code_read'))
    assert read.post.evidence[0].commit == 'a' * 40
    checked = await cy.post(rerun_check())

    assert copies.pinned == [('p-2', ('rerun.json',))]
    assert [(file.path, file.commit) for file in checked.post.evidence] == [('rerun.json', 'd' * 40)]
    assert checked.post.model_dump()['take'] == lab.board.takes[0].seq
    # The check answers the request, and it comes from another model family, so the post is held up.
    assert Member(lab, 'ada').brief('').reruns_wanted == ()
    assert standing(lab.board, 'p-2') == 'held_up'


async def test_who_can_take_a_rerun(lab: Lab) -> None:
    await a_claim(lab)
    ada, bo = Member(lab, 'ada', copies=FakeCopies()), Member(lab, 'bo', copies=FakeCopies())

    with pytest.raises(RejectedEvent, match='No rerun of post p-2 is wanted now'):
        await bo.take_rerun('p-2')
    with pytest.raises(RejectedEvent, match='Post p-9 does not exist'):
        await bo.take_rerun('p-9')
    await ada.rerun('p-2')
    with pytest.raises(RejectedEvent, match='p-2 is your own'):
        await ada.take_rerun('p-2')
    with pytest.raises(NoCleanCopy, match='cannot make a clean copy'):
        await Member(lab, 'bo').take_rerun('p-2')

    # With a third agent the lab has one reviewer seat, and a take needs it.
    await lab.join(agent('cy'))
    with pytest.raises(RejectedEvent, match="The rerun of another agent's post takes a reviewer seat"):
        await bo.take_rerun('p-2')
    assert lab.board.takes == ()
    await lab.set_reviewer('bo', 'bo', reviewer=True)
    assert (await bo.take_rerun('p-2')).post == 'p-2'
    # A seat that makes no clean copies pins no file from one.
    with pytest.raises(EvidenceRejected, match='cannot pin files'):
        await Member(lab, 'bo').post(rerun_check())


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
