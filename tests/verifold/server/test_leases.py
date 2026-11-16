from datetime import timedelta

import pytest
from builders import START
from conftest import agent
from fakes import FakeCopies
from mcp import Client

from verifold.protocol.agents import ModelSpec
from verifold.protocol.events import RerunLeaseSet, RerunTaken
from verifold.protocol.ids import PERSON
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import FileEvidence
from verifold.protocol.settings import ReviewerSettings, Settings
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.store.record_file import RecordFile

EVIDENCE = (FileEvidence(path='bench.json', commit='c' * 40),)


class Clock:
    """The lab's clock, which a test moves."""

    def __init__(self) -> None:
        self.now = START

    def pass_minutes(self, minutes: float) -> None:
        self.now += timedelta(minutes=minutes)


async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
    return tuple(FileEvidence(path=path, commit='a' * 40) for path in paths)


def check() -> PostRequest:
    """The check of a take of the rerun of p-1, with a file of the checker's own."""
    return PostRequest.model_validate(
        {'kind': 'check', 'text': 'Reran it.', 'reply_to': 'p-1', 'thread': 't-1', 'outcome': 'holds'}
        | {'method': 'rerun', 'files': ('rerun.json',)}
    )


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def wanted(record_file: RecordFile, clock: Clock) -> Lab:
    """
    A lab without reviewer seats, with ada's result p-1 and ada's request for its rerun.

    ada, bo, and dee have one model family, and cy has another.
    """
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: clock.now)
    for name in ('ada', 'bo', 'dee'):
        await lab.join(agent(name))
    await lab.join(agent('cy').model_copy(update={'model': ModelSpec(family='openai')}))
    await lab.set_settings(Settings(reviewers=ReviewerSettings(seats=0)))
    await lab.post(PostRequest(kind='result', text='11.8x.', new_thread='Speed'), 'ada', EVIDENCE)
    await lab.request_rerun('ada', 'p-1')
    return lab


async def test_a_take_is_refused_to_another_agent_while_the_lease_stands_and_the_refused_call_makes_no_copy(
    wanted: Lab, clock: Clock
) -> None:
    bo_copies, dee_copies = FakeCopies(), FakeCopies()
    bo, dee = Member(wanted, 'bo', copies=bo_copies), Member(wanted, 'dee', copies=dee_copies)
    taken = await bo.take_rerun('p-1')
    clock.pass_minutes(4)
    seq = wanted.board.seq

    with pytest.raises(RejectedEvent) as refused:
        await dee.take_rerun('p-1')

    assert str(refused.value) == (
        'bo holds the rerun of post p-1 since 2026-11-06 12:00 UTC, until 2026-11-06 12:10 UTC. The board takes no '
        'take of the rerun from you while that lease stands.'
    )
    assert (taken.held_since, taken.held_until) == (START, START + timedelta(minutes=10))
    # The refused call made no copy and recorded nothing.
    assert (dee_copies.made, wanted.board.seq) == ([], seq)
    # The brief of every agent shows who holds the rerun and until when.
    (line,) = dee.brief('').reruns_wanted
    assert [(lease.agent, lease.since, lease.until) for lease in line.held_by] == [
        ('bo', START, START + timedelta(minutes=10))
    ]
    # At its time the lease ends, and another agent takes the rerun.
    clock.pass_minutes(6)
    assert dee.brief('').reruns_wanted[0].held_by == ()
    assert (await dee.take_rerun('p-1')).held_until == START + timedelta(minutes=20)
    assert [entry.agent for entry in wanted.board.takes] == ['bo', 'dee']
    # bo's take stays, and the board refuses bo's renewal while dee holds the rerun.
    with pytest.raises(RejectedEvent, match='dee holds the rerun of post p-1 since 2026-11-06 12:10 UTC'):
        await bo.take_rerun('p-1')
    assert bo_copies.made == [('p-1', 'ada')]


async def test_the_holder_renews_its_lease_and_another_agent_takes_the_rerun_after_its_give_up(
    wanted: Lab, clock: Clock
) -> None:
    bo, dee = Member(wanted, 'bo', copies=FakeCopies()), Member(wanted, 'dee', copies=FakeCopies())
    await bo.take_rerun('p-1')
    clock.pass_minutes(8)
    renewed = await bo.take_rerun('p-1')
    clock.pass_minutes(8)

    with pytest.raises(RejectedEvent, match='since 2026-11-06 12:00 UTC, until 2026-11-06 12:18 UTC'):
        await dee.take_rerun('p-1')
    given = await bo.take_rerun('p-1', give_up=True)
    taken = await dee.take_rerun('p-1')

    assert (renewed.held_since, renewed.held_until) == (START, START + timedelta(minutes=18))
    # A give-up returns the claim without a copy and without a lease.
    assert (given.post, given.folder, given.manifest, given.held_since, given.held_until) == ('p-1', '', (), None, None)
    assert taken.held_since == START + timedelta(minutes=16)
    leases = [event for event in wanted.board.leases if isinstance(event, RerunLeaseSet)]
    assert [(event.agent, event.held) for event in leases] == [('bo', True), ('bo', False)]
    with pytest.raises(RejectedEvent, match='You hold no lease on the rerun of post p-1'):
        await bo.take_rerun('p-1', give_up=True)
    with pytest.raises(RejectedEvent, match='You did not take the rerun of post p-1'):
        await Member(wanted, 'cy').take_rerun('p-1', give_up=True)


async def test_the_lease_ends_at_the_check_of_the_take_and_when_the_holder_leaves(wanted: Lab) -> None:
    bo = Member(wanted, 'bo', pin=pin, copies=FakeCopies())
    dee = Member(wanted, 'dee', pin=pin, copies=FakeCopies())
    await bo.take_rerun('p-1')
    await bo.post(check())
    # The check answered the request. A new one makes the rerun wanted again, and bo's lease ended with its check.
    await wanted.request_rerun(PERSON, 'p-1')
    assert (await bo.take_rerun('p-1')).held_until is None
    taken = await dee.take_rerun('p-1')
    assert taken.held_until is not None
    # dee leaves, and its lease ends with it. eve has the post's family, as dee has.
    await wanted.join(agent('eve'))
    eve = Member(wanted, 'eve', copies=FakeCopies())
    with pytest.raises(RejectedEvent, match='dee holds the rerun'):
        await eve.take_rerun('p-1')
    await dee.leave()
    assert (await eve.take_rerun('p-1')).held_until is not None


async def test_an_agent_of_another_family_can_take_a_rerun_that_an_agent_of_the_posts_family_holds(
    wanted: Lab,
) -> None:
    bo, cy = Member(wanted, 'bo', copies=FakeCopies()), Member(wanted, 'cy', copies=FakeCopies())
    await bo.take_rerun('p-1')

    await cy.take_rerun('p-1')

    assert [lease.agent for lease in bo.brief('').reruns_wanted[0].held_by] == ['bo', 'cy']
    # cy's check can make the post stand as held up, so its lease keeps out every other agent.
    with pytest.raises(RejectedEvent, match=r'bo holds the rerun of post p-1 .* cy holds the rerun of post p-1'):
        await Member(wanted, 'dee', copies=FakeCopies()).take_rerun('p-1')
    assert [type(event) for event in wanted.board.takes] == [RerunTaken, RerunTaken]


async def test_agents_take_renew_and_give_up_a_rerun_through_the_mcp_tool(wanted: Lab, clock: Clock) -> None:
    bo, dee = Member(wanted, 'bo', copies=FakeCopies()), Member(wanted, 'dee', copies=FakeCopies())
    async with Client(join_server(lambda _: bo)) as client:
        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
        taken = await client.call_tool('take_rerun', {'post': 'p-1'})
    clock.pass_minutes(1)
    async with Client(join_server(lambda _: dee)) as client:
        refused = await client.call_tool('take_rerun', {'post': 'p-1'})
        brief = await client.call_tool('brief', {})
    async with Client(join_server(lambda _: bo)) as client:
        given = await client.call_tool('take_rerun', {'post': 'p-1', 'give_up': True})

    assert 'give_up' in tools['take_rerun'].input_schema['properties']
    assert taken.structured_content is not None
    assert taken.structured_content['held_until'] == '2026-11-06T12:10:00Z'
    assert refused.is_error
    assert 'bo holds the rerun of post p-1 since 2026-11-06 12:00 UTC, until 2026-11-06 12:10 UTC' in str(
        refused.content
    )
    assert brief.structured_content is not None
    (line,) = brief.structured_content['reruns_wanted']
    assert line['held_by'] == [{'agent': 'bo', 'since': '2026-11-06T12:00:00Z', 'until': '2026-11-06T12:10:00Z'}]
    assert (brief.structured_content['vote_reveal_minutes'], brief.structured_content['rerun_lease_minutes']) == (
        10,
        10,
    )
    assert given.structured_content is not None
    assert (given.structured_content['held_until'], given.structured_content['folder']) == (None, '')
