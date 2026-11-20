from datetime import timedelta

import pytest
from builders import START, RecordBuilder
from pydantic import ValidationError

from verifold.protocol.events import AlarmCondition, AlarmSet
from verifold.protocol.ids import UNSIGNED
from verifold.protocol.join import SEALED_TEXT, News, PostRequest
from verifold.protocol.posts import (
    Answer,
    Branch,
    Check,
    Entry,
    Idea,
    Objection,
    Plan,
    Proposal,
    Reading,
    Result,
    Round,
    RuledOut,
)
from verifold.society.alarms import condition_words, rang_by, rings_at
from verifold.society.attention import news, wakes
from verifold.society.errors import RejectedEvent
from verifold.society.ideas import (
    branch_lines,
    branches,
    check_rests_on,
    ideas_of,
    in_force,
    map_view,
    next_branch,
    unchallenged,
    without_idea,
)
from verifold.society.rounds import for_reader, round_of
from verifold.society.steering import steering_facts
from verifold.society.views import brief, thread_view

RATES = Branch(id='b-1', title='Overnight interest rates')
SPORTS = Branch(id='b-2', title='Sports before the start')
CALENDAR = Branch(id='b-3', title='Events with a fixed calendar')


def split(*added: Branch, retires: tuple[str, ...] = (), post_id: str = 'p-1', author: str = 'ada') -> Reading:
    return Reading(
        id=post_id, thread='t-1', author=author, text='Progress is the verified value.', branches=added, retires=retires
    )


def idea(post_id: str, parent: str | None, author: str = 'ada', **fields: object) -> Idea:
    return Idea.model_validate(
        {
            'id': post_id,
            'thread': 't-1',
            'author': author,
            'text': 'Buy the rate contract after a 4-point fall.',
            'parent': parent,
            'test': 'Count the comparable days with a 4-point fall.',
            'rules_out': 'Fewer than 6 of 20 days.',
        }
        | fields
    )


def mapped() -> RecordBuilder:
    """A lab of ada and bo, whose reading p-1 splits the question into the rates and the sports."""
    return RecordBuilder().join('ada').join('bo').thread('t-1', opened_by='ada').post(split(RATES, SPORTS))


def test_an_idea_needs_its_statement_its_parent_its_test_and_what_rules_it_out() -> None:
    whole = idea('p-2', 'b-1')
    assert (whole.parent, whole.test, whole.rules_out) == (
        'b-1',
        'Count the comparable days with a 4-point fall.',
        'Fewer than 6 of 20 days.',
    )
    with pytest.raises(ValidationError, match='An idea needs its four parts'):
        idea('p-2', None)
    for missing in ('test', 'rules_out'):
        with pytest.raises(ValidationError, match='An idea needs its four parts'):
            idea('p-2', 'b-1', **{missing: ''})
    with pytest.raises(ValidationError):
        idea('p-2', 'b-1', text='')
    request = {
        'kind': 'idea',
        'text': 'Buy low.',
        'thread': 't-1',
        'parent': 'b-1',
        'test': 'Count.',
        'rules_out': 'Few.',
    }
    assert PostRequest.model_validate(request).to_post('p-2', 't-1', 'ada').kind == 'idea'
    for missing in ('parent', 'test', 'rules_out'):
        with pytest.raises(ValidationError, match='An idea needs its four parts'):
            PostRequest.model_validate({key: value for key, value in request.items() if key != missing})
    # No other kind takes the parts of an idea.
    with pytest.raises(ValidationError):
        PostRequest.model_validate({'kind': 'plan', 'text': 'Go.', 'thread': 't-1', 'test': 'Count.'}).to_post(
            'p-2', 't-1', 'ada'
        )


def test_a_post_from_before_ideas_and_branches_keeps_its_json() -> None:
    # A record from before this field holds a reading, a plan, and a ruled-out lead without them.
    old = Reading(id='p-1', thread='t-1', author='ada', text='Read.')
    assert 'branches' not in old.model_dump_json()
    assert 'retires' not in old.model_dump_json()
    for post in (
        Plan(id='p-2', thread='t-1', author='ada', text='Go.'),
        RuledOut(id='p-3', thread='t-1', author='ada', text='No.'),
    ):
        assert '"idea"' not in post.model_dump_json()
    board = RecordBuilder().join('ada').thread('t-1', opened_by='ada').post(old).board()
    assert branches(board) == ()
    assert branch_lines(board, START) == ()
    assert map_view(board, START).branches == ()


def test_a_reading_adds_branches_and_a_newer_one_retires_one_and_keeps_the_others_with_their_ideas() -> None:
    record = mapped().post(idea('p-2', 'b-1')).post(idea('p-3', 'b-2', text='Bet on the home side.'))
    record.post(split(CALENDAR, retires=('b-2',), post_id='p-4'))
    board = record.board()

    assert [
        (held.branch.id, held.added.post.id, held.retired.post.id if held.retired else None) for held in branches(board)
    ] == [
        ('b-1', 'p-1', None),
        ('b-2', 'p-1', 'p-4'),
        ('b-3', 'p-4', None),
    ]
    assert [held.branch.id for held in in_force(board)] == ['b-1', 'b-3']
    assert next_branch(board) == 4
    # The idea on b-1 stays on it under the newer reading, and the retired branch keeps its idea on the map.
    shown = map_view(board, record.at(len(record.events)))
    assert [(branch.id, branch.retired, [view.id for view in branch.idea_list]) for branch in shown.branches] == [
        ('b-1', False, ['p-2']),
        ('b-3', False, []),
        ('b-2', True, ['p-3']),
    ]
    assert shown.branches[2].retired_by == 'p-4'
    # An agent's brief lists the branches in force and counts the retired ones.
    read = brief(board, 'bo', News(seq=0))
    assert ([line.id for line in read.branches], read.retired_branches) == (['b-1', 'b-3'], 1)


@pytest.mark.parametrize(
    ('reading', 'refusal'),
    [
        (split(Branch(id='b-1', title='Again'), post_id='p-2'), 'The lab had branch b-1 already.'),
        (split(Branch(id='b-3', title='overnight INTEREST rates'), post_id='p-2'), 'Branch b-1 has the title'),
        (split(retires=('b-7',), post_id='p-2'), 'Branch b-7 is not in force'),
        (
            split(*(Branch(id=f'b-{number}', title=f'Branch {number}') for number in range(3, 32)), post_id='p-2'),
            'at most 30 branches in force, and this reading would leave 31',
        ),
    ],
)
def test_the_record_refuses_a_branch_that_it_had_one_with_a_title_in_force_and_too_many(
    reading: Reading, refusal: str
) -> None:
    with pytest.raises(RejectedEvent, match=refusal):
        mapped().post(reading).board()


def test_a_reading_can_retire_a_branch_and_add_one_with_its_title_again() -> None:
    board = mapped().post(split(Branch(id='b-3', title=RATES.title), retires=('b-1',), post_id='p-2')).board()
    assert [held.branch.id for held in in_force(board)] == ['b-2', 'b-3']


@pytest.mark.parametrize(
    ('post', 'refusal'),
    [
        (idea('p-2', 'b-9'), 'The lab has no branch b-9'),
        (idea('p-2', 'p-1'), 'Post p-1 is no idea, so no idea hangs on it.'),
        (Plan(id='p-2', thread='t-1', author='bo', text='Go.', idea='p-1'), 'Post p-1 is no idea'),
    ],
)
def test_an_idea_hangs_on_a_branch_or_an_idea_and_a_try_names_an_idea(post: Idea | Plan, refusal: str) -> None:
    with pytest.raises(RejectedEvent, match=refusal):
        mapped().post(post).board()


def test_no_new_idea_hangs_on_a_retired_branch_or_on_its_ideas_and_none_goes_in_the_conversation() -> None:
    record = mapped().post(idea('p-2', 'b-2')).post(split(retires=('b-2',), post_id='p-3'))
    for late in (idea('p-4', 'b-2'), idea('p-4', 'p-2')):
        with pytest.raises(RejectedEvent, match='Branch b-2 was retired by reading p-3'):
            record.copy().post(late).board()
    talk = mapped().coordinator('ada').thread('t-2', opened_by='ada', conversation=True)
    with pytest.raises(RejectedEvent, match='An idea is for the whole lab'):
        talk.post(idea('p-2', 'b-1', thread='t-2')).board()


def test_an_idea_on_an_idea_hangs_on_that_ideas_branch() -> None:
    board = mapped().post(idea('p-2', 'b-1')).post(idea('p-3', 'p-2', author='bo', text='Only on Fridays.')).board()
    assert ideas_of(board).branch == {'p-2': 'b-1', 'p-3': 'b-1'}
    assert branch_lines(board, START)[0].ideas == 2


def challenge(post_id: str, result: str, author: str, outcome: str = 'fails') -> Check:
    return Check.model_validate(
        {
            'id': post_id,
            'thread': 't-1',
            'author': author,
            'text': '5 of 31 days on a wider sample.',
            'reply_to': result,
            'outcome': outcome,
            'method': 'challenge',
            'body': 'I took 31 days in place of 20.',
        }
    )


def test_each_state_of_an_idea_comes_from_the_record() -> None:
    record = mapped().post(idea('p-2', 'b-1'))
    states = [ideas_of(record.board()).states['p-2']]
    record.post(Plan(id='p-3', thread='t-1', author='ada', text='I try my own idea.', idea='p-2'))
    states.append(ideas_of(record.board()).states['p-2'])
    record.post(Result(id='p-4', thread='t-1', author='ada', text='7 of 20 days.', idea='p-2'))
    states.append(ideas_of(record.board()).states['p-2'])
    record.post(challenge('p-5', 'p-4', 'bo'))
    states.append(ideas_of(record.board()).states['p-2'])
    record.post(RuledOut(id='p-6', thread='t-1', author='bo', text='Too few days.', idea='p-2'))
    states.append(ideas_of(record.board()).states['p-2'])

    assert states == ['untried', 'being_tried', 'result_in', 'challenged', 'ruled_out']
    # An objection that stands disputes the ruling, so the idea is challenged again.
    record.post(Objection(id='p-7', thread='t-1', author='ada', text='The sample mixes two regimes.', reply_to='p-6'))
    assert ideas_of(record.board()).states['p-2'] == 'challenged'


def test_a_try_that_its_author_conceded_counts_for_nothing() -> None:
    record = mapped().post(idea('p-2', 'b-1')).post(Plan(id='p-3', thread='t-1', author='bo', text='Go.', idea='p-2'))
    record.post(Objection(id='p-4', thread='t-1', author='ada', text='Wrong data.', reply_to='p-3'))
    record.post(Answer(id='p-6', thread='t-1', author='bo', text='Conceded.', reply_to='p-4', accepts=True))
    assert ideas_of(record.board()).states['p-2'] == 'untried'


def test_the_counts_of_a_branch_and_how_long_a_branch_has_had_no_idea() -> None:
    record = mapped().post(idea('p-2', 'b-1')).post(idea('p-3', 'b-1', author='bo', text='Sell high.'))
    record.post(idea('p-4', 'b-1', text='Wait a week.'))
    record.post(Plan(id='p-5', thread='t-1', author='bo', text='Go.', idea='p-2'))
    record.post(Result(id='p-6', thread='t-1', author='bo', text='Holds.', idea='p-3'))
    record.post(RuledOut(id='p-7', thread='t-1', author='ada', text='No.', idea='p-4'))
    board = record.board()
    now = START + timedelta(hours=4)

    rates, sports = branch_lines(board, now)
    assert rates.model_dump() == {
        'id': 'b-1',
        'title': RATES.title,
        'ideas': 3,
        'being_tried': 1,
        'results': 1,
        'ruled_out': 1,
    }
    # The tries came in the first minutes, so the last three hours hold none of them.
    assert branch_lines(board, START + timedelta(hours=2))[0].recent_tries == 2
    # The reading came at minute 4, so the branch without an idea has had none for 3.9 hours.
    assert sports.model_dump() == {'id': 'b-2', 'title': SPORTS.title, 'no_idea_hours': 3.9}
    assert [held.branch.id for held in without_idea(board)] == ['b-2']
    facts = steering_facts(board, START + timedelta(minutes=30))
    assert (facts.new_ideas, facts.branches_without_idea, facts.no_idea_hours) == (3, 1, 0.4)
    assert steering_facts(record.post(idea('p-8', 'b-2')).board(), now).branches_without_idea == 0


def test_an_alarm_rings_when_a_branch_has_had_no_idea_for_its_hours() -> None:
    record = mapped()
    condition = AlarmCondition(kind='branch_hours', threshold=2)
    seq, at = record._stamp()
    alarm = AlarmSet(seq=seq, at=at, agent='ada', minutes=0, conditions=(condition,))
    record.events.append(alarm)
    board = record.board()

    # The reading came at minute 4, so the alarm rings two hours later.
    assert rings_at(board, alarm, at) == START + timedelta(minutes=4, hours=2)
    assert rang_by(board, alarm, START + timedelta(hours=3)) == condition
    assert condition_words(condition) == 'a branch of the question has had no idea for 2 hours'
    # Once each branch has an idea, the condition sets no time.
    record.post(idea('p-2', 'b-1')).post(idea('p-3', 'b-2'))
    assert rings_at(record.board(), alarm, at) is None
    assert rings_at(RecordBuilder().join('ada').board(), alarm, at) is None


def ideas_round() -> RecordBuilder:
    """A lab of ada, bo, and cy with the reading p-1, the open round p-2, and bo's idea p-3 as its entry."""
    record = RecordBuilder().join('ada').join('bo').join('cy').thread('t-1', opened_by='ada').post(split(RATES, SPORTS))
    record.post(Round(id='p-2', thread='t-1', author='ada', text='One idea each.', minutes=15))
    return record.post(idea('p-3', 'b-2', author='bo', text='Bet on the home side.', reply_to='p-2'))


def test_an_idea_in_an_open_round_hides_its_author_and_its_content_until_the_round_closes() -> None:
    record = ideas_round()
    board = record.board()
    now = record.at(len(record.events))

    seen = for_reader(board, 'cy', now).post('p-3')
    assert seen is not None
    assert isinstance(seen.post, Idea)
    assert (seen.post.author, seen.post.text, seen.post.parent, seen.post.test, seen.post.rules_out) == (
        UNSIGNED,
        SEALED_TEXT,
        None,
        '',
        '',
    )
    view = thread_view(board, 'cy', 't-1', now=now).posts[-1]
    assert (view.sealed, view.by, view.post.author) == (True, None, UNSIGNED)
    # The sealed idea hangs on no branch for cy, so the branch shows no idea, and the map counts it apart.
    for_cy = for_reader(board, 'cy', now)
    assert branch_lines(for_cy, now)[1].ideas == 0
    assert map_view(for_cy, now).sealed == 1
    # Its author and the person see it whole, and it counts on its branch for them.
    assert branch_lines(for_reader(board, 'bo', now), now)[1].ideas == 1
    assert map_view(board, now, whole=True).branches[1].idea_list[0].author == 'bo'
    # It is bo's one entry of the round: the round waits for cy alone, and the brief says so.
    made = brief(board, 'cy', news(board, 'cy', 0, now), now=now)
    assert made.round is not None
    assert (made.round.entered, made.round.not_entered) == (1, 1)
    assert not any(wakes(board, agent, record.board().posts[-1]) for agent in ('ada', 'cy'))
    with pytest.raises(RejectedEvent, match='one entry in a round'):
        record.copy().post(Entry(id='p-4', thread='t-1', author='bo', text='Another.', reply_to='p-2')).board()
    for late in (Plan(id='p-4', thread='t-1', author='cy', text='Go.', idea='p-3'), idea('p-4', 'p-3', author='cy')):
        with pytest.raises(RejectedEvent, match='is an entry of round p-2'):
            record.copy().post(late).board()

    # From the close on, the idea is signed and hangs on its branch for every agent.
    record.post(Entry(id='p-4', thread='t-1', author='cy', text='Mine.', reply_to='p-2')).closed('p-2', why='entered')
    closed = record.board()
    later = record.at(len(record.events))
    shown = for_reader(closed, 'ada', later).post('p-3')
    assert shown is not None
    assert (shown.post.author, shown.post.text) == ('bo', 'Bet on the home side.')
    assert branch_lines(for_reader(closed, 'ada', later), later)[1].ideas == 1


def test_a_post_that_is_no_entry_answers_no_round() -> None:
    board = ideas_round().board()
    assert round_of(board, board.posts[0]) is None
    assert round_of(board, board.posts[-1]) == board.posts[1]


def test_an_idea_replies_to_no_post_or_to_a_round() -> None:
    with pytest.raises(RejectedEvent, match='Post p-1 is no round'):
        mapped().post(idea('p-2', 'b-1', reply_to='p-1')).board()


def test_a_post_that_tries_an_idea_reaches_the_ideas_author() -> None:
    record = mapped().post(idea('p-2', 'b-1')).thread('t-2', opened_by='bo')
    board = record.post(Plan(id='p-3', thread='t-2', author='bo', text='I try it.', idea='p-2')).board()
    assert wakes(board, 'ada', board.posts[-1])


def test_a_proposal_rests_only_on_challenged_results_in_a_lab_of_two_working_agents() -> None:
    record = mapped().post(Result(id='p-2', thread='t-1', author='ada', text='7 of 20.'))
    record.post(Result(id='p-3', thread='t-1', author='ada', text='The fee is 1 cent.'))
    proposal = Proposal(id='p-4', thread='t-1', author='ada', text='Buy it.', builds_on=('p-2', 'p-3', 'p-2', 'p-1'))
    board = record.board()

    assert unchallenged(board, proposal) == ('p-2', 'p-3')
    with pytest.raises(RejectedEvent, match=r'These results that it builds on have none yet: p-2, p-3\.'):
        check_rests_on(board, proposal)
    # A rerun is no challenge, and a challenge that fails is one.
    record.post(
        Check(id='p-5', thread='t-1', author='bo', text='Same.', reply_to='p-2', outcome='holds', method='rerun')
    )
    record.post(challenge('p-6', 'p-3', 'bo'))
    with pytest.raises(RejectedEvent, match=r'have none yet: p-2\.'):
        check_rests_on(record.board(), proposal)
    record.post(challenge('p-7', 'p-2', 'bo', outcome='holds'))
    check_rests_on(record.board(), proposal)
    # The record still takes a proposal that rests on results without a challenge, as an older record holds one.
    assert (
        mapped()
        .post(Result(id='p-2', thread='t-1', author='ada', text='7.'))
        .post(proposal.model_copy(update={'builds_on': ('p-2',)}))
        .board()
    )


def test_a_lab_with_one_working_agent_is_not_held_by_the_rule_on_proposals() -> None:
    found = Result(id='p-1', thread='t-1', author='ada', text='7 of 20.')
    proposal = Proposal(id='p-2', thread='t-1', author='ada', text='Buy it.', builds_on=('p-1',))
    # The desk does no work of the lab, and neither does an agent that left, so ada is the one agent at work.
    for lab in (
        RecordBuilder().join('ada').desk('dee'),
        RecordBuilder().join('ada').join('bo').leave('bo'),
    ):
        check_rests_on(lab.thread('t-1', opened_by='ada').post(found).board(), proposal)
