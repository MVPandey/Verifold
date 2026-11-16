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
from verifold.protocol.settings import RerunSettings, ReviewerSettings, Settings
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.society.reruns import kept_until
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
    # bo's take stays. bo's call gets the folder of its take, and no renewal while dee holds the rerun.
    seq = wanted.board.seq
    again = await bo.take_rerun('p-1')
    assert (again.folder, again.held_until, wanted.board.seq) == ('/lab/.verifold/reruns/p-1', None, seq)
    assert again.not_renewed.startswith('dee holds the rerun of post p-1 since 2026-11-06 12:10 UTC')
    assert 'The board renews no lease of yours on the rerun while that lease stands.' in again.not_renewed
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
    clock.pass_minutes(5)
    async with Client(join_server(lambda _: bo)) as client:
        renewed = await client.call_tool('take_rerun', {'post': 'p-1'})
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
    # The renewal moves the end of the lease and returns the folder of the take without a new copy.
    assert renewed.structured_content is not None
    assert [renewed.structured_content[key] for key in ('held_since', 'held_until', 'not_renewed', 'manifest')] == [
        '2026-11-06T12:00:00Z',
        '2026-11-06T12:16:00Z',
        '',
        [],
    ]
    assert renewed.structured_content['folder'] == taken.structured_content['folder']
    assert given.structured_content is not None
    assert (given.structured_content['held_until'], given.structured_content['folder']) == (None, '')


async def test_two_reviewers_of_the_posts_family_leave_the_rerun_to_another_family_while_one_holds_it(
    record_file: RecordFile, clock: Clock
) -> None:
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: clock.now)
    for name in ('ada', 'bo', 'dee'):
        await lab.join(agent(name))
    await lab.join(agent('cy').model_copy(update={'model': ModelSpec(family='openai')}))
    await lab.set_settings(Settings(reviewers=ReviewerSettings(seats=2)))
    await lab.set_reviewer('bo', PERSON, reviewer=True)
    await lab.set_reviewer('dee', PERSON, reviewer=True)
    await lab.post(PostRequest(kind='result', text='11.8x.', new_thread='Speed'), 'ada', EVIDENCE)
    await lab.request_rerun('ada', 'p-1')
    bo, dee, cy = (Member(lab, name, copies=FakeCopies()) for name in ('bo', 'dee', 'cy'))
    # Before any take, the rerun is for the reviewer seats, and cy has none.
    with pytest.raises(RejectedEvent, match='takes a reviewer seat while an agent in such a seat can take it'):
        await cy.take_rerun('p-1')

    await bo.take_rerun('p-1')

    # bo's lease keeps dee out, so no agent in a reviewer seat can take the rerun, and cy of another family can.
    assert [line.open_to for line in cy.brief('').reruns_wanted] == ['any']
    with pytest.raises(RejectedEvent, match='bo holds the rerun of post p-1'):
        await dee.take_rerun('p-1')
    assert (await cy.take_rerun('p-1')).held_until == START + timedelta(minutes=10)


async def test_a_takers_own_call_while_another_agent_holds_the_rerun_returns_its_folder_and_renews_nothing(
    wanted: Lab, clock: Clock
) -> None:
    bo, cy = Member(wanted, 'bo', copies=FakeCopies()), Member(wanted, 'cy', copies=FakeCopies())
    await bo.take_rerun('p-1')
    clock.pass_minutes(1)
    await cy.take_rerun('p-1')
    clock.pass_minutes(1)
    seq = wanted.board.seq

    # cy's check can make the post stand as held up, so its lease keeps bo from renewing. bo's lease stands.
    again = await bo.take_rerun('p-1')

    assert (again.folder, again.held_since, again.held_until, wanted.board.seq) == (
        '/lab/.verifold/reruns/p-1',
        START,
        START + timedelta(minutes=10),
        seq,
    )
    assert again.not_renewed.startswith('cy holds the rerun of post p-1 since 2026-11-06 12:01 UTC')
    # After cy's lease and bo's both end, bo renews and holds the rerun again.
    clock.pass_minutes(10)
    renewed = await bo.take_rerun('p-1')
    assert (renewed.not_renewed, renewed.held_since) == ('', START + timedelta(minutes=12))


async def test_a_change_of_the_lease_after_a_lease_ended_brings_no_lease_back(wanted: Lab, clock: Clock) -> None:
    bo, dee = Member(wanted, 'bo', copies=FakeCopies()), Member(wanted, 'dee', copies=FakeCopies())
    await bo.take_rerun('p-1')
    clock.pass_minutes(30)
    await dee.take_rerun('p-1')
    clock.pass_minutes(15)

    await wanted.set_settings(Settings(reviewers=ReviewerSettings(seats=0), reruns=RerunSettings(lease_minutes=600)))

    assert bo.brief('').reruns_wanted[0].held_by == ()
    # A renewal after the change holds the new minutes, and it keeps dee from renewing.
    renewed = await bo.take_rerun('p-1')
    assert renewed.held_until == START + timedelta(minutes=45, hours=10)
    assert (await dee.take_rerun('p-1')).not_renewed.startswith('bo holds the rerun of post p-1')


async def test_the_author_of_a_post_gets_the_reason_of_its_own_post_also_while_a_lease_stands(wanted: Lab) -> None:
    await Member(wanted, 'bo', copies=FakeCopies()).take_rerun('p-1')

    with pytest.raises(RejectedEvent, match=r'Post p-1 is your own\. Another agent takes its rerun\.'):
        await Member(wanted, 'ada', copies=FakeCopies()).take_rerun('p-1')


async def test_a_renewal_and_a_call_after_the_check_make_no_export(wanted: Lab) -> None:
    copies = FakeCopies()
    bo = Member(wanted, 'bo', pin=pin, copies=copies)
    await bo.take_rerun('p-1')
    renewed = await bo.take_rerun('p-1')
    await bo.post(check())
    after = await bo.take_rerun('p-1')

    assert copies.made == [('p-1', 'ada')]
    assert renewed.manifest_sha256 == 'cd' * 32
    # The check settled the rerun, so bo holds no lease, and the result says why.
    assert (after.held_since, after.held_until) == (None, None)
    assert after.not_renewed == 'No rerun of post p-1 is wanted now, so no lease on it stands.'


async def test_an_agent_told_of_a_rerun_is_told_nothing_more_when_later_leases_end(wanted: Lab, clock: Clock) -> None:
    dee = Member(wanted, 'dee')
    clock.pass_minutes(0.5)
    assert [line.post for line in dee.news().reruns] == ['p-1']
    # bo takes the rerun, dee reads while bo's lease keeps it out, and the lease ends at its time.
    clock.pass_minutes(0.5)
    await Member(wanted, 'bo', copies=FakeCopies()).take_rerun('p-1')
    clock.pass_minutes(1)
    dee.news()
    clock.pass_minutes(10)
    assert dee.news().reruns == ()
    assert kept_until(wanted.board, 'dee', wanted.now(), dee.told) is None
    # cy of another family takes it in its turn, and its lease ends too. dee was told, so it hears nothing.
    clock.pass_minutes(1)
    await Member(wanted, 'cy', copies=FakeCopies()).take_rerun('p-1')
    clock.pass_minutes(1)
    dee.news()
    clock.pass_minutes(10)
    assert dee.news().reruns == ()
    assert (await dee.wait(0)).reruns == ()


async def test_a_seat_that_starts_again_hears_once_more_of_a_rerun_that_a_lease_kept_out_and_never_misses_it(
    wanted: Lab, clock: Clock
) -> None:
    await Member(wanted, 'bo', copies=FakeCopies()).take_rerun('p-1')
    dee = Member(wanted, 'dee')
    clock.pass_minutes(1)
    assert dee.news().reruns == ()

    # Verifold restarts: the seat starts again at dee's place, and it knows nothing of what it told.
    again = Member(wanted, 'dee', seen=dee.seen)

    assert kept_until(wanted.board, 'dee', wanted.now(), again.told) == START + timedelta(minutes=10)
    clock.pass_minutes(14)
    assert [line.post for line in again.news().reruns] == ['p-1']
    assert again.news().reruns == ()


async def test_a_later_call_makes_the_copy_again_when_it_is_gone_or_changed(wanted: Lab) -> None:
    copies = FakeCopies()
    bo = Member(wanted, 'bo', copies=copies)
    await bo.take_rerun('p-1')

    kept = await bo.take_rerun('p-1')
    copies.lost = True
    remade = await bo.take_rerun('p-1')

    assert copies.made == [('p-1', 'ada'), ('p-1', 'ada')]
    assert (kept.manifest, remade.manifest_files, remade.folder) == ((), 1, kept.folder)
    assert [line.path for line in remade.manifest] == ['bench.json']
