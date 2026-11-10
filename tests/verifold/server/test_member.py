import asyncio

import pytest

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.server.errors import BlindCheck, EvidenceRejected
from verifold.server.lab import Lab
from verifold.server.member import Member


async def test_a_member_posts_reads_and_watches_as_its_agent(lab: Lab) -> None:
    bo = Member(lab, 'bo')

    posted = await bo.post(PostRequest(kind='objection', text='Leak.', thread='t-1', reply_to='p-1'))
    await bo.watch('t-1', watching=True)

    assert (posted.post.author, posted.standing) == ('bo', 'open')
    assert [item.standing for item in bo.thread('t-1').posts] == ['disputed', 'open']
    assert [summary.watching for summary in bo.threads()] == [True]


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


async def test_a_blind_checker_cannot_read_the_board_but_others_can_ask_for_reruns(lab: Lab) -> None:
    evidence = (FileEvidence(path='bench.json', commit='c' * 40),)
    await lab.post(PostRequest(kind='result', text='11.8x.', thread='t-1'), 'ada', evidence)
    requested = await Member(lab, 'bo').rerun('p-2')
    await lab.join(Agent(id='dee', name='Dee', harness='fake', model=ModelSpec(family='openai'), checks='p-2'))
    dee = Member(lab, 'dee')

    assert (requested.by, requested.post) == ('bo', 'p-2')
    for read in (dee.threads, lambda: dee.thread('t-1'), lambda: dee.brief('How the board works.')):
        with pytest.raises(BlindCheck, match='rerun p-2 blind'):
            read()
    assert dee.news() is None
    with pytest.raises(BlindCheck):
        await dee.wait(timeout=0)
