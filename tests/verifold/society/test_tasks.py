from datetime import datetime, timedelta

import pytest
from builders import START, RecordBuilder, lab
from pydantic import ValidationError

from verifold.protocol.join import ClaimLine, News, PostRequest
from verifold.protocol.posts import Answer, Check, HandBack, Message, Objection, Plan, Result, RuledOut, Task
from verifold.protocol.settings import Settings, TaskSettings
from verifold.society.attention import wakes
from verifold.society.errors import RejectedEvent
from verifold.society.leases import span
from verifold.society.obstacles import obstacles
from verifold.society.tasks import dropped, lapses_due, next_lapse, open_tasks, task_facts
from verifold.society.views import brief, thread_view

LEASE = 5
"""The minutes of a claim's lease in these tests. The builder adds one event a minute."""


def task(post_id: str = 'p-1', author: str = 'ada', mentions: tuple[str, ...] = ()) -> Task:
    return Task(
        id=post_id,
        thread='t-1',
        author=author,
        text='Rerun the tail test on the 2025 data.',
        output='One table with the five runs and their spread.',
        bounds='The 2025 data only, and 20 minutes at most.',
        mentions=mentions,
    )


def back(post_id: str, author: str = 'bo', task_id: str = 'p-1') -> HandBack:
    return HandBack(
        id=post_id,
        thread='t-1',
        author=author,
        reply_to=task_id,
        text='Ran all five. The tail holds in four of them.',
        findings='Run 3 has a gap in March.',
        concerns='Five runs is few.',
        deviations='Used 19 minutes, inside the bounds.',
    )


@pytest.fixture
def tasked() -> RecordBuilder:
    """A lab with a lease of `LEASE` minutes and ada's task p-1 in thread t-1, as event 7 at 12:06."""
    return lab().settings(Settings(tasks=TaskSettings(lease_minutes=LEASE))).post(task())


def idle(record: RecordBuilder, minutes: int) -> RecordBuilder:
    # Events that change nothing about a task, so that the record's clock moves on.
    for _ in range(minutes):
        record.watch('ada', 't-1')
    return record


def now(record: RecordBuilder) -> datetime:
    # The time of the record's last event, which the lab's clock shows at least.
    return record.at(len(record.events))


def facts_at(record: RecordBuilder, task_id: str = 'p-1') -> tuple[str, str | None, datetime | None]:
    # The task's state, its holder, and the end of the holder's lease, at the record's last event.
    board = record.board()
    entry = board.post(task_id)
    assert entry is not None
    facts = task_facts(board, entry, now(record))
    holder = facts.holder
    return facts.state, holder.agent if holder else None, holder.lease.until if holder else None


def test_a_claim_gives_the_task_to_one_agent_and_the_record_refuses_every_other_while_its_lease_stands(
    tasked: RecordBuilder,
) -> None:
    claimed = tasked.claim('bo', 'p-1')

    assert facts_at(claimed) == ('claimed', 'bo', START + timedelta(minutes=7 + LEASE))
    with pytest.raises(RejectedEvent) as refused:
        claimed.copy().claim('cy', 'p-1').board()
    assert str(refused.value) == (
        'bo holds task p-1 since 2026-11-06 12:07 UTC, until 2026-11-06 12:12 UTC. The board takes no claim of it '
        'from you while that lease stands.'
    )
    # At the end of the lease the task is open again, and another agent claims it.
    later = idle(claimed, LEASE - 1)
    assert facts_at(later) == ('claimed', 'bo', now(later) + timedelta(minutes=1))
    assert [claim.agent for claim in later.claim('cy', 'p-1').board().claims] == ['bo', 'cy']


def test_each_post_of_the_holder_starts_its_lease_again_and_the_record_marks_the_lapse_once(
    tasked: RecordBuilder,
) -> None:
    tasked.claim('bo', 'p-1')
    tasked.post(Plan(id='p-2', thread='t-1', author='bo', text='I take the tail test.', reply_to='p-1'))
    tasked.post(Message(id='p-3', thread='t-1', author='bo', text='Run 1 is in.', builds_on=('p-1',)))
    # An agent holds one claim at a time, so a post of the holder in another thread keeps its claim too, as when the
    # work goes to the thread of a deliverable. A post of another agent starts nothing.
    tasked.thread('t-2', opened_by='bo').post(Result(id='p-4', thread='t-2', author='bo', text='Elsewhere.'))
    tasked.post(Message(id='p-5', thread='t-1', author='cy', text='Any news?', reply_to='p-1'))
    until = START + timedelta(minutes=11 + LEASE)

    assert facts_at(tasked) == ('claimed', 'bo', until)
    assert next_lapse(tasked.board(), until - timedelta(minutes=1)) == until
    with pytest.raises(RejectedEvent, match='until 2026-11-06 12:16 UTC'):
        tasked.copy().claim('cy', 'p-1').board()
    # The record marks the lapse once, with the end of the lease, and not before that end.
    with pytest.raises(RejectedEvent, match='No claim of bo on task p-1 has a lease that ended at 2026-11-06 12:16'):
        tasked.copy().lapse('bo', 'p-1', until).board()
    idle(tasked, 3)
    assert [(due.agent, due.task, due.until) for due in lapses_due(tasked.board(), until)] == [('bo', 'p-1', until)]
    lapsed = tasked.lapse('bo', 'p-1', until)
    assert (lapses_due(lapsed.board(), until), facts_at(lapsed)) == ((), ('open', None, None))
    with pytest.raises(RejectedEvent, match='without a mark of its lapse'):
        tasked.copy().lapse('bo', 'p-1', until).board()
    # A post of the old holder after the end starts no lease of its own, so the task stays open.
    tasked.post(Message(id='p-6', thread='t-1', author='bo', text='Still on it.', reply_to='p-1'))
    assert facts_at(tasked) == ('open', None, None)


def test_a_record_from_before_keeps_the_lapse_of_a_lease_that_only_the_holders_posts_on_the_task_kept(
    tasked: RecordBuilder,
) -> None:
    # Before every post of the holder kept its claim, a post elsewhere kept nothing, so Verifold marked the lapse at
    # the end of the claim's own lease. Such a record still loads, and the lapse ends the claim.
    tasked.claim('bo', 'p-1').thread('t-2', opened_by='bo')
    tasked.post(Result(id='p-2', thread='t-2', author='bo', text='The work, in the thread of a deliverable.'))
    claimed_until = START + timedelta(minutes=7 + LEASE)
    idle(tasked, 3)
    assert facts_at(tasked) == ('claimed', 'bo', START + timedelta(minutes=9 + LEASE))
    tasked.lapse('bo', 'p-1', claimed_until)

    assert facts_at(tasked) == ('open', None, None)
    assert lapses_due(tasked.board(), START + timedelta(hours=1)) == ()
    with pytest.raises(RejectedEvent, match='without a mark of its lapse'):
        tasked.copy().lapse('bo', 'p-1', START + timedelta(minutes=9 + LEASE)).board()
    # A lapse that no rule makes due stays refused.
    with pytest.raises(RejectedEvent, match='without a mark of its lapse'):
        tasked.copy().lapse('bo', 'p-1', START + timedelta(minutes=8 + LEASE)).board()


def test_an_agent_holds_one_task_at_a_time_and_its_hand_back_frees_it_for_the_next(tasked: RecordBuilder) -> None:
    tasked.post(task('p-2', author='cy')).claim('bo', 'p-1')

    with pytest.raises(RejectedEvent) as refused:
        tasked.copy().claim('bo', 'p-2').board()
    assert str(refused.value) == (
        'You hold task p-1 since 2026-11-06 12:08 UTC, until 2026-11-06 12:13 UTC. An agent holds one task at a time, '
        'and your `hand_back` or `ruled_out` that replies to p-1 ends that claim.'
    )
    # The holder's claim of its own task again renews the lease.
    renewed = tasked.copy().claim('bo', 'p-1')
    assert facts_at(renewed) == ('claimed', 'bo', START + timedelta(minutes=9 + LEASE))
    tasked.post(back('p-3')).claim('bo', 'p-2')
    assert (facts_at(tasked, 'p-1')[0], facts_at(tasked, 'p-2')[:2]) == ('handed_back', ('claimed', 'bo'))


@pytest.mark.parametrize(
    ('who', 'target', 'refusal'),
    [
        ('ada', 'p-1', 'Task p-1 is your own. Another agent claims it.'),
        ('dee', 'p-1', "The desk is no part of the lab's work, so it claims no task."),
        ('bo', 'p-2', 'Post p-2 is a message, and `claim` takes a task.'),
        ('bo', 'p-9', 'Post p-9 does not exist.'),
        ('eve', 'p-1', 'eve left this lab, so the board takes no claim from it.'),
        ('zed', 'p-1', 'zed is not an agent with a seat in this lab.'),
    ],
)
def test_the_record_takes_a_claim_only_from_an_agent_of_the_lab_for_another_agents_task(
    tasked: RecordBuilder, who: str, target: str, refusal: str
) -> None:
    tasked.desk('dee').join('eve').leave('eve').post(Message(id='p-2', thread='t-1', author='bo', text='A note.'))

    with pytest.raises(RejectedEvent) as refused:
        tasked.claim(who, target).board()

    assert str(refused.value) == refusal


def test_an_invitation_is_no_order_and_another_agent_claims_the_task_that_its_invitee_left(
    tasked: RecordBuilder,
) -> None:
    tasked.on_call('bo').post(task('p-2', mentions=('bo',)))
    board = tasked.board()
    invited = board.post('p-2')
    assert invited is not None

    # The task reaches the agent that it invites, also on call, and no other agent.
    assert (wakes(board, 'bo', invited), wakes(board, 'cy', invited)) == (True, False)
    # Every agent reads it in `brief`, with whom it invites, and the board refuses nobody's claim for that.
    (_, entry) = brief(board, 'cy', News(seq=0)).open_tasks
    assert (entry.id, entry.invites) == ('p-2', ('bo',))
    claimed = tasked.claim('cy', 'p-2')
    assert [line.id for line in brief(claimed.board(), 'bo', News(seq=0), now=now(claimed)).open_tasks] == ['p-1']


def test_the_hand_back_ends_the_claim_reaches_the_author_and_only_the_author_accepts_it(
    tasked: RecordBuilder,
) -> None:
    with pytest.raises(RejectedEvent, match='For task p-1, nobody claimed it'):
        tasked.copy().post(back('p-2')).board()
    tasked.claim('bo', 'p-1')
    with pytest.raises(RejectedEvent) as refused:
        tasked.copy().post(back('p-2', author='cy')).board()
    assert str(refused.value) == (
        'For task p-1, bo claimed it last. The board takes a hand-back from the agent that claimed the task last.'
    )
    noted = tasked.copy().post(Message(id='p-2', thread='t-1', author='ada', text='A note.'))
    with pytest.raises(RejectedEvent, match='Post p-2 is no task, and a `hand_back` replies to a task'):
        noted.post(back('p-3', task_id='p-2')).board()
    # A view of the task says who holds it, since when, and until when.
    claimed = thread_view(tasked.board(), 'cy', 't-1', now=now(tasked)).posts[0].task
    assert claimed is not None
    assert (claimed.state, claimed.held_by and claimed.held_by.agent) == ('claimed', 'bo')

    board = tasked.post(back('p-2')).board()
    handed = board.post('p-2')
    assert handed is not None

    assert facts_at(tasked) == ('handed_back', None, None)
    assert (wakes(board, 'ada', handed), next_lapse(board, handed.at)) == (True, None)
    with pytest.raises(RejectedEvent, match='bo handed task p-1 back with p-2, and the hand-back waits, so the task'):
        tasked.copy().post(back('p-3')).board()
    with pytest.raises(RejectedEvent, match='so the task takes no claim'):
        tasked.copy().claim('cy', 'p-1').board()
    accept = Answer(id='p-3', thread='t-1', author='cy', text='Looks right.', reply_to='p-2', accepts=True)
    with pytest.raises(RejectedEvent, match='Only ada, who wrote task p-1, accepts its hand-back'):
        tasked.copy().post(accept).board()
    done = tasked.post(accept.model_copy(update={'author': 'ada'}))
    assert facts_at(done)[0] == 'done'
    view = thread_view(done.board(), 'cy', 't-1').posts[0].task
    assert view is not None
    assert (view.state, view.held_by, view.hand_back) == ('done', None, 'p-2')


def test_a_check_of_the_hand_back_that_holds_makes_the_task_done_and_a_conceded_hand_back_opens_it_again(
    tasked: RecordBuilder,
) -> None:
    tasked.claim('bo', 'p-1').post(back('p-2'))
    checked = tasked.copy().post(
        Check(id='p-3', thread='t-1', author='cy', text='Same table.', reply_to='p-2', outcome='holds', method='rerun')
    )
    assert facts_at(checked)[0] == 'done'

    tasked.post(Objection(id='p-3', thread='t-1', author='ada', text='Run 3 used 2024 data.', reply_to='p-2'))
    assert facts_at(tasked)[0] == 'handed_back'
    tasked.post(Answer(id='p-4', thread='t-1', author='bo', text='Right.', reply_to='p-3', accepts=True))

    assert facts_at(tasked) == ('open', None, None)
    assert [entry.post.id for entry in open_tasks(tasked.board(), now(tasked))] == ['p-1']
    # The agent that claimed the task last hands it back again, and another agent can claim it meanwhile.
    assert tasked.copy().post(back('p-5')).board().posts[-1].post.id == 'p-5'
    assert tasked.copy().claim('cy', 'p-1').board().claims[-1].agent == 'cy'


def test_a_dropped_task_says_why_as_an_obstacle_and_is_open_again(tasked: RecordBuilder) -> None:
    tasked.claim('bo', 'p-1')
    why = 'The 2025 data has a gap in March, so the tail test cannot run on it.'
    board = tasked.post(RuledOut(id='p-2', thread='t-1', author='bo', text=why, reply_to='p-1')).board()
    entry = board.post('p-1')
    assert entry is not None

    assert facts_at(tasked) == ('open', None, None)
    assert dropped(board, entry) == ('p-2',)
    assert [(found.entry.post.id, found.state) for found in obstacles(board)] == [('p-2', 'open')]
    (line,) = brief(board, 'cy', News(seq=0)).open_tasks
    assert (line.id, line.dropped, line.lapsed) == ('p-1', ('p-2',), 0)
    assert tasked.claim('cy', 'p-1').board().claims[-1].agent == 'cy'


def test_a_withdrawn_task_ends_its_claim_and_takes_no_claim_and_no_hand_back(tasked: RecordBuilder) -> None:
    tasked.claim('bo', 'p-1').post(RuledOut(id='p-2', thread='t-1', author='ada', text='Not needed.', reply_to='p-1'))
    board = tasked.board()

    assert facts_at(tasked)[0] == 'withdrawn'
    # A withdrawal is no obstacle, and the claim that it ended does not lapse.
    assert (obstacles(board), lapses_due(board, board.posts[-1].at + timedelta(hours=1))) == ((), ())
    with pytest.raises(RejectedEvent, match='ada withdrew task p-1 with p-2, so it takes no claim'):
        tasked.copy().claim('cy', 'p-1').board()
    with pytest.raises(RejectedEvent, match='so it takes no hand-back'):
        tasked.copy().post(back('p-3')).board()


def test_the_claim_of_an_agent_that_leaves_ends_and_does_not_lapse(tasked: RecordBuilder) -> None:
    board = tasked.claim('bo', 'p-1').leave('bo').board()

    assert facts_at(tasked) == ('open', None, None)
    assert lapses_due(board, board.posts[-1].at + timedelta(hours=1)) == ()
    assert tasked.claim('cy', 'p-1').board().claims[-1].agent == 'cy'


def test_the_person_posts_no_task_and_a_task_needs_its_whole_brief(tasked: RecordBuilder) -> None:
    with pytest.raises(RejectedEvent, match='A task hands work from one agent to another'):
        tasked.post(task('p-2', author='person')).board()
    with pytest.raises(ValidationError, match='A task needs its brief'):
        PostRequest(kind='task', text='Rerun it.', thread='t-1', output='A table.', bounds='')
    # An empty part means the same as none, so a kind that takes no part takes an empty one.
    plain = PostRequest(kind='plan', text='Next.', thread='t-1', findings='', bounds='')
    assert plain.to_post('p-2', 't-1', 'bo').kind == 'plan'
    asked = PostRequest(kind='task', text='Rerun it.', thread='t-1', output='A table.', bounds='One hour.')
    made = asked.to_post('p-2', 't-1', 'bo')
    assert isinstance(made, Task)
    assert (made.output, made.bounds) == ('A table.', 'One hour.')


def test_a_lease_that_keeps_starts_nothing_and_one_that_starts_does_after_an_end() -> None:
    # The steps of one agent: a keep before any start, a start, a keep while it stands, an end, a keep, a start.
    at = [START + timedelta(minutes=minute) for minute in range(8)]
    steps = ((1, at[0], 'keep'), (2, at[1], 'start'), (3, at[3], 'keep'), (4, at[4], 'end'), (5, at[5], 'keep'))

    assert span(steps, at[7], lambda _: 10) is None
    again = span((*steps, (6, at[6], 'start')), at[7], lambda _: 10)
    assert again is not None
    assert (again.started, again.since, again.until) == (6, at[6], at[6] + timedelta(minutes=10))
    kept = span(steps[:3], at[3], lambda _: 10)
    assert kept is not None
    assert (kept.started, kept.since, kept.until, kept.stands(at[7])) == (2, at[1], at[3] + timedelta(minutes=10), True)


def test_the_brief_lists_the_tasks_that_nobody_holds_and_the_task_that_each_agent_holds_with_its_time_left(
    tasked: RecordBuilder,
) -> None:
    tasked.post(task('p-2', author='cy')).claim('bo', 'p-1')
    board = tasked.board()
    at = now(tasked) + timedelta(minutes=2)
    held = ClaimLine(task='p-1', thread='t-1', until=START + timedelta(minutes=8 + LEASE), minutes_left=LEASE - 2)

    mine, theirs = brief(board, 'bo', News(seq=0), now=at), brief(board, 'ada', News(seq=0), now=at)

    # The holder reads its claim on its own line, and every other agent on the holder's line.
    assert mine.your_line is not None
    assert (mine.your_line.claim, next(agent.claim for agent in theirs.agents if agent.id == 'bo')) == (held, held)
    # The lists hold the tasks that nobody holds, the reader's own among them, and the lease of the lab.
    assert ([entry.id for entry in mine.open_tasks], [entry.id for entry in theirs.open_tasks]) == (['p-2'], ['p-2'])
    assert (mine.task_lease_minutes, brief(board, 'cy', News(seq=0), now=at).open_tasks[0].id) == (LEASE, 'p-2')
    # An agent that holds no task has no `claim` in its line, so the brief spends nothing on it.
    assert all('claim' not in agent.model_dump() for agent in mine.agents)
