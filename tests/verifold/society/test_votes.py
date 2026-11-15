import pytest
from builders import RecordBuilder, lab

from verifold.protocol.agents import Agent
from verifold.protocol.app import AgentView, LabView, Outcomes
from verifold.protocol.join import AgentLine, Byline, LeftLine, News, ProfileResult
from verifold.protocol.posts import Check, Message, Result
from verifold.protocol.votes import MAX_NOTES, MAX_VOTE_LINES, MAX_WHY, ProposalLine
from verifold.society.attention import news, update, wakes
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.fold import fold
from verifold.society.identity import post_line, post_view
from verifold.society.lines import lines_of
from verifold.society.standing import standing
from verifold.society.views import answer, brief, thread_summaries
from verifold.society.votes import (
    badge_lines,
    breakthrough_threads,
    marks,
    proposal,
    proposals,
    standing_votes,
    vote_lines,
    vote_of,
)

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Holds.')


def voted() -> RecordBuilder:
    """A lab where ada posted result p-1 and bo and cy can vote on it."""
    return lab().post(RESULT)


def test_a_voter_has_one_vote_on_a_post_and_a_new_one_replaces_it_and_none_takes_it_back() -> None:
    record = voted().vote('bo', 'p-1', 'up', 'It matches my run.').vote('cy', 'p-1', 'down', 'One seed only.')
    board = record.board()

    assert marks(board, 'p-1') == (1, 1, ())
    assert [(vote.by, vote.direction, vote.reason) for vote in vote_lines(board, 'p-1')] == [
        ('bo', 'up', 'It matches my run.'),
        ('cy', 'down', 'One seed only.'),
    ]
    # A new vote of the same voter replaces its earlier one: the post never has two votes of one voter.
    changed = record.copy().vote('bo', 'p-1', 'down', 'The second seed fails.').board()
    assert marks(changed, 'p-1') == (0, 2, ())
    assert [vote.by for vote in standing_votes(changed, 'p-1')] == ['cy', 'bo']
    assert len(changed.votes) == 3
    # `none` takes the vote back, and the record keeps every vote.
    back = record.copy().vote('bo', 'p-1', 'none', '').board()
    assert (marks(back, 'p-1'), vote_of(back, 'bo', 'p-1'), len(back.votes)) == ((0, 1, ()), None, 3)
    # The person votes as any voter does, and every vote counts the same.
    person = record.copy().vote('person', 'p-1', 'up', 'This is what I asked.').board()
    assert marks(person, 'p-1') == (2, 1, ())


def test_nobody_votes_on_its_own_post_and_a_vote_up_or_down_has_a_reason() -> None:
    record = voted().post(Message(id='p-2', thread='t-1', author='person', text='Go on.'))

    with pytest.raises(RejectedEvent, match='Post p-1 is your own'):
        record.copy().vote('ada', 'p-1').board()
    with pytest.raises(RejectedEvent, match='Post p-2 is your own'):
        record.copy().vote('person', 'p-2').board()
    for direction in ('up', 'down'):
        with pytest.raises(RejectedEvent, match=f'A vote {direction} has a reason of one line'):
            record.copy().vote('bo', 'p-1', direction, '  ').board()
    with pytest.raises(RejectedEvent, match='Post p-9 does not exist'):
        record.copy().vote('bo', 'p-9').board()
    with pytest.raises(RejectedEvent, match='You have no vote on post p-1'):
        record.copy().vote('bo', 'p-1', 'none', '').board()
    # An agent votes on a post of the person.
    assert marks(record.copy().vote('bo', 'p-2').board(), 'p-2') == (1, 0, ())


def test_a_reason_is_one_printable_line_of_bounded_length() -> None:
    board = voted().vote('bo', 'p-1', 'up', '  It holds\n\x1b[31m on  my data. ').board()

    assert board.votes[0].reason == 'It holds [31m on my data.'
    with pytest.raises(ValueError, match='at most 140 characters'):
        voted().vote('bo', 'p-1', 'up', 'x' * (MAX_WHY + 1))
    with pytest.raises(ValueError, match='at most 140 characters'):
        voted().badge('bo', 'p-1', reason='x' * (MAX_WHY + 1))


def test_only_an_agent_that_is_in_the_lab_votes_or_gives_a_badge() -> None:
    record = voted().join('checker-1', checks='p-1').join('dee').leave('dee')

    for who, why in (
        ('zed', 'zed is not an agent in this lab'),
        ('dee', 'dee left this lab'),
        ('checker-1', 'A blind checker posts one check'),
    ):
        with pytest.raises(RejectedEvent, match=why):
            record.copy().vote(who, 'p-1').board()
        with pytest.raises(RejectedEvent, match=why):
            record.copy().badge(who, 'p-1').board()
    # An invited agent votes like any agent of the lab.
    guest = record.copy().join('guest-1', harness='guest').vote('guest-1', 'p-1').board()
    assert marks(guest, 'p-1') == (1, 0, ())
    # The vote of an agent that left later stays on the post.
    left = record.copy().vote('bo', 'p-1').leave('bo').board()
    assert marks(left, 'p-1') == (1, 0, ())


def test_a_vote_and_a_badge_wake_nobody_and_change_no_standing_no_list_and_no_answer() -> None:
    record = voted().post(Result(id='p-2', thread='t-1', author='bo', text='Fails.'))
    plain = record.board()
    marked = (
        record.copy()
        .vote('cy', 'p-1', 'down', 'One seed only.')
        .vote('person', 'p-2', 'up', 'This is the one.')
        .badge('cy', 'p-2', 'promising')
        .badge('cy', 'p-2', 'breakthrough')
        .badge('person', 'p-2', 'breakthrough', 'second', giver='cy')
        .board()
    )

    # No post of the board changed, so nothing that wakes an agent did.
    assert marked.posts == plain.posts
    working = lines_of(marked)
    assert [wakes(marked, 'ada', entry, working) for entry in marked.posts] == [
        wakes(plain, 'ada', entry) for entry in plain.posts
    ]
    assert not update(marked, 'ada', plain.seq).posts
    assert [standing(marked, post) for post in ('p-1', 'p-2')] == [standing(plain, post) for post in ('p-1', 'p-2')]
    assert answer(marked) == answer(plain)

    # The lists of a brief hold the same posts in the same order, whatever the votes and the badges say.
    def lists(board: Board) -> list[list[str]]:
        view = brief(board, 'cy', News(seq=0))
        every = (view.disputed, view.not_built_on, view.not_checked, view.open_asks, view.open_calls)
        return [[entry.id for entry in entries] for entries in every]

    assert lists(marked) == lists(plain)
    assert [summary.thread.id for summary in thread_summaries(marked, 'cy')] == [
        summary.thread.id for summary in thread_summaries(plain, 'cy')
    ]
    assert (marked.coordinator, marked.reviewers) == (plain.coordinator, plain.reviewers)


def test_a_line_of_a_post_has_the_counts_and_the_badges_and_the_thread_has_the_reasons() -> None:
    board = (
        voted()
        .vote('bo', 'p-1', 'up', 'It matches my run.')
        .vote('cy', 'p-1', 'down', 'One seed only.')
        .badge('bo', 'p-1', 'promising')
        .board()
    )
    line = post_line(board, board.posts[0])
    view = post_view(board, board.posts[0])

    assert (line.up, line.down, line.badges) == (1, 1, ('promising',))
    assert 'reason' not in line.model_dump_json()
    assert (view.up, view.down) == (1, 1)
    assert [(vote.by, vote.reason) for vote in view.votes] == [('bo', 'It matches my run.'), ('cy', 'One seed only.')]
    assert [(badge.badge, badge.given[0].by, badge.given[0].reason) for badge in view.badges] == [
        ('promising', 'bo', 'Worth a second look.')
    ]
    # A post without votes and badges has a line without them.
    bare = post_line(voted().board(), board.posts[0]).model_dump()
    assert not {'up', 'down', 'badges'} & set(bare)
    # A brief holds the counts in its lines, and no reason.
    seen = brief(board, 'cy', news(board, 'cy', 0))
    assert [(entry.up, entry.down) for entry in seen.news.for_you] == [(1, 1)]
    assert 'One seed only.' not in seen.model_dump_json()


def test_a_thread_lists_the_newest_votes_of_a_post_and_counts_all_of_them() -> None:
    record = voted()
    voters = [f'agent-{number}' for number in range(MAX_VOTE_LINES + 3)]
    for voter in voters:
        record.join(voter).vote(voter, 'p-1', 'up', f'Reason of {voter}.')
    board = record.board()

    view = post_view(board, board.posts[0])
    assert (view.up, view.down, len(view.votes)) == (len(voters), 0, MAX_VOTE_LINES)
    assert [vote.by for vote in view.votes] == voters[3:]


def test_the_author_reads_the_votes_on_its_posts_in_its_next_news_and_no_other_agent_does() -> None:
    record = voted()
    seq = record.board().seq
    board = (
        record.vote('bo', 'p-1', 'up', 'First thought.')
        .vote('bo', 'p-1', 'down', 'One seed only.')
        .vote('person', 'p-1', 'up', 'This is what I asked.')
        .board()
    )

    mine = news(board, 'ada', seq)
    # A voter that voted twice is there once, with its latest vote.
    assert [(note.post, note.by, note.direction, note.reason) for note in mine.votes] == [
        ('p-1', 'bo', 'down', 'One seed only.'),
        ('p-1', 'person', 'up', 'This is what I asked.'),
    ]
    assert (mine.for_you, mine.others) == ((), ())
    assert news(board, 'cy', seq).votes == ()
    assert news(board, 'bo', seq).votes == ()
    assert [note.by for note in update(board, 'ada', seq).votes] == ['bo', 'person']
    # The news has each vote once: the next one starts after it.
    assert news(board, 'ada', mine.seq).votes == ()
    # A vote that its voter took back is news too.
    back = record.vote('bo', 'p-1', 'none', '').board()
    assert [(note.by, note.direction) for note in news(back, 'ada', board.seq).votes] == [('bo', 'none')]


def test_the_news_holds_the_newest_votes_and_badge_changes_up_to_a_limit() -> None:
    record = voted()
    seq = record.board().seq
    voters = [f'agent-{number}' for number in range(MAX_NOTES + 2)]
    for voter in voters:
        record.join(voter).vote(voter, 'p-1').badge(voter, 'p-1', 'promising')
    mine = news(record.board(), 'ada', seq)

    assert [note.by for note in mine.votes] == voters[2:]
    assert [note.by for note in mine.badges] == voters[2:]


def test_a_post_has_promising_from_several_givers_once_and_each_giver_takes_its_own_back() -> None:
    record = voted().badge('bo', 'p-1', reason='Worth the other seeds.').badge('person', 'p-1', reason='Go on here.')
    board = record.board()

    assert marks(board, 'p-1') == (0, 0, ('promising',))
    (line,) = badge_lines(board, 'p-1')
    assert (line.badge, [(given.by, given.reason) for given in line.given], line.waits) == (
        'promising',
        [('bo', 'Worth the other seeds.'), ('person', 'Go on here.')],
        False,
    )
    with pytest.raises(RejectedEvent, match='Post p-1 is your own'):
        record.copy().badge('ada', 'p-1').board()
    with pytest.raises(RejectedEvent, match='A badge has a reason of one line'):
        record.copy().badge('cy', 'p-1', reason='').board()
    with pytest.raises(RejectedEvent, match='You gave post p-1 the `promising` badge already'):
        record.copy().badge('bo', 'p-1').board()
    with pytest.raises(RejectedEvent, match='Only a `confirmed` badge has `proof`'):
        record.copy().badge('cy', 'p-1', proof='p-1').board()
    with pytest.raises(RejectedEvent, match='A `give` has none'):
        record.copy().badge('cy', 'p-1', giver='bo').board()
    # A giver takes back its own, and not another's. The person takes back any.
    with pytest.raises(RejectedEvent, match='Only its giver and the person take a badge back'):
        record.copy().badge('cy', 'p-1', action='take_back', giver='bo').board()
    with pytest.raises(RejectedEvent, match='cy holds no `promising` badge on post p-1'):
        record.copy().badge('cy', 'p-1', action='take_back').board()
    own = record.copy().badge('bo', 'p-1', action='take_back').board()
    assert [given.by for given in badge_lines(own, 'p-1')[0].given] == ['person']
    both = (
        record.copy().badge('person', 'p-1', action='take_back', giver='bo').badge('person', 'p-1', action='take_back')
    )
    assert (marks(both.board(), 'p-1'), badge_lines(both.board(), 'p-1')) == ((0, 0, ()), ())
    # After that, the giver can give it again.
    assert marks(both.badge('bo', 'p-1').board(), 'p-1')[2] == ('promising',)


def test_a_confirmed_badge_from_an_agent_names_a_check_that_holds_or_a_result_that_builds_on_the_post() -> None:
    record = (
        voted()
        .post(Check(id='p-2', thread='t-1', author='bo', text='Same.', reply_to='p-1', outcome='holds', method='rerun'))
        .post(Check(id='p-3', thread='t-1', author='cy', text='No.', reply_to='p-1', outcome='fails', method='rerun'))
        .post(Result(id='p-4', thread='t-1', author='cy', text='On 114 pairs too.', builds_on=('p-1',)))
        .post(Result(id='p-5', thread='t-1', author='ada', text='Again.', builds_on=('p-1',)))
        .post(Message(id='p-6', thread='t-1', author='bo', text='I agree.', reply_to='p-1'))
    )

    with pytest.raises(RejectedEvent, match='names in `proof` the post that confirmed it'):
        record.copy().badge('bo', 'p-1', 'confirmed').board()
    with pytest.raises(RejectedEvent, match='Post p-9 does not exist'):
        record.copy().badge('bo', 'p-1', 'confirmed', proof='p-9').board()
    for wrong in ('p-3', 'p-6', 'p-1'):
        with pytest.raises(RejectedEvent, match=f'Post {wrong} is no check of post p-1 that holds'):
            record.copy().badge('bo', 'p-1', 'confirmed', proof=wrong).board()
    with pytest.raises(RejectedEvent, match='ada wrote both post p-1 and post p-5'):
        record.copy().badge('bo', 'p-1', 'confirmed', proof='p-5').board()
    with pytest.raises(RejectedEvent, match='Post p-1 is your own'):
        record.copy().badge('ada', 'p-1', 'confirmed', proof='p-2').board()
    # The proof is a check that holds or a result that builds on the post. Another agent than its author names it too.
    for giver, proof in (('bo', 'p-2'), ('cy', 'p-4'), ('cy', 'p-2')):
        board = record.copy().badge(giver, 'p-1', 'confirmed', proof=proof).board()
        (line,) = badge_lines(board, 'p-1')
        assert (line.badge, line.given[0].by, line.given[0].proof) == ('confirmed', giver, proof)
    # The person gives it with a post or without one.
    assert marks(record.copy().badge('person', 'p-1', 'confirmed').board(), 'p-1')[2] == ('confirmed',)
    assert marks(record.copy().badge('person', 'p-1', 'confirmed', proof='p-4').board(), 'p-1')[2] == ('confirmed',)
    with pytest.raises(RejectedEvent, match='Post p-6 is no check'):
        record.copy().badge('person', 'p-1', 'confirmed', proof='p-6').board()


def test_a_breakthrough_stands_only_after_the_second_of_the_coordinator_or_the_person() -> None:
    record = voted().coordinator('cy').badge('bo', 'p-1', 'breakthrough', reason='It gives the strategy a size.')
    board = record.board()

    # The proposal is no badge: a line of the post does not have it, and the thread says that it waits.
    assert marks(board, 'p-1') == (0, 0, ())
    (line,) = badge_lines(board, 'p-1')
    assert (line.badge, line.waits, line.second, line.given[0].by) == ('breakthrough', True, None, 'bo')
    waiting = proposal(board, 'p-1')
    assert waiting is not None
    assert (waiting.by, breakthrough_threads(board)) == ('bo', ())
    assert [(wait.post, wait.thread, wait.by, wait.coordinator_can_second) for wait in proposals(board)] == [
        ('p-1', 't-1', 'bo', True)
    ]

    seconded = record.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo', reason='It does.').board()
    (line,) = badge_lines(seconded, 'p-1')
    assert (marks(seconded, 'p-1'), line.waits) == ((0, 0, ('breakthrough',)), False)
    assert line.second is not None
    assert (line.second.by, line.second.reason) == ('cy', 'It does.')
    assert (breakthrough_threads(seconded), proposals(seconded), proposal(seconded, 'p-1')) == (('t-1',), (), None)
    # The person seconds too, with a line or without one.
    by_person = record.copy().badge('person', 'p-1', 'breakthrough', 'second', giver='bo').board()
    assert marks(by_person, 'p-1')[2] == ('breakthrough',)
    # A second stands once, and the badge stays when the seat changes afterwards.
    twice = record.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo')
    with pytest.raises(RejectedEvent, match='has its second already'):
        twice.badge('person', 'p-1', 'breakthrough', 'second', giver='bo').board()
    assert marks(
        record.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo').coordinator(None).board(), 'p-1'
    )[2] == ('breakthrough',)


def test_only_the_coordinator_and_the_person_second_and_never_for_their_own_proposal_or_post() -> None:
    record = voted().coordinator('cy')
    proposed = record.copy().badge('bo', 'p-1', 'breakthrough')

    # An agent without the coordinator seat seconds nothing, the author of the post neither.
    with pytest.raises(RejectedEvent, match='Only the agent that holds the coordinator seat and the person second'):
        proposed.copy().join('dee').badge('dee', 'p-1', 'breakthrough', 'second', giver='bo').board()
    with pytest.raises(RejectedEvent, match='Only the agent that holds the coordinator seat and the person second'):
        proposed.copy().badge('bo', 'p-1', 'breakthrough', 'second', giver='bo').board()
    with pytest.raises(RejectedEvent, match='Nobody seconds a badge for its own post'):
        proposed.copy().badge('ada', 'p-1', 'breakthrough', 'second', giver='bo').board()
    # The coordinator does not second its own proposal: only the person does.
    own = record.copy().badge('cy', 'p-1', 'breakthrough')
    with pytest.raises(RejectedEvent, match='You proposed the `breakthrough` badge for post p-1'):
        own.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='cy').board()
    assert [wait.coordinator_can_second for wait in proposals(own.board())] == [False]
    assert marks(own.copy().badge('person', 'p-1', 'breakthrough', 'second', giver='cy').board(), 'p-1')[2] == (
        'breakthrough',
    )
    # The coordinator does not second for a post that it wrote.
    theirs = (
        record.copy().post(Result(id='p-2', thread='t-1', author='cy', text='Mine.')).badge('bo', 'p-2', 'breakthrough')
    )
    with pytest.raises(RejectedEvent, match='Post p-2 is your own'):
        theirs.copy().badge('cy', 'p-2', 'breakthrough', 'second', giver='bo').board()
    assert [wait.coordinator_can_second for wait in proposals(theirs.board())] == [False]
    # In a lab without a coordinator, only the person seconds.
    none = voted().badge('bo', 'p-1', 'breakthrough')
    with pytest.raises(RejectedEvent, match='Only the agent that holds the coordinator seat and the person second'):
        none.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo').board()
    assert [wait.coordinator_can_second for wait in proposals(none.board())] == [False]
    assert marks(none.badge('person', 'p-1', 'breakthrough', 'second', giver='bo').board(), 'p-1')[2] == (
        'breakthrough',
    )


def test_an_agent_proposes_a_breakthrough_for_another_agents_post_once_at_a_time() -> None:
    record = voted().coordinator('cy').badge('bo', 'p-1', 'breakthrough')

    with pytest.raises(RejectedEvent, match='Post p-1 is your own'):
        voted().badge('ada', 'p-1', 'breakthrough').board()
    with pytest.raises(RejectedEvent, match='An agent proposes a `breakthrough` badge, and the person seconds it'):
        voted().badge('person', 'p-1', 'breakthrough').board()
    with pytest.raises(RejectedEvent, match='bo proposed a `breakthrough` badge for post p-1 already'):
        record.copy().badge('cy', 'p-1', 'breakthrough').board()
    with pytest.raises(RejectedEvent, match='Only a `breakthrough` badge takes a second'):
        record.copy().badge('cy', 'p-1', 'promising', 'second', giver='bo').board()
    with pytest.raises(RejectedEvent, match='No proposal of a `breakthrough` badge for post p-1 waits'):
        voted().badge('person', 'p-1', 'breakthrough', 'second', giver='bo').board()
    with pytest.raises(RejectedEvent, match='No proposal of a `breakthrough` badge for post p-1 waits'):
        record.copy().badge('person', 'p-1', 'breakthrough', 'second').board()
    # The proposer takes its proposal back, and the person declines it. Then another agent can propose.
    for by in ('bo', 'person'):
        back = record.copy().badge(by, 'p-1', 'breakthrough', 'take_back', giver='bo')
        assert (badge_lines(back.board(), 'p-1'), proposals(back.board())) == ((), ())
        assert proposals(back.badge('cy', 'p-1', 'breakthrough').board())[0].by == 'cy'
    # The person takes back a badge that stands, and so does its proposer. The seconder does not.
    stands = record.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo')
    with pytest.raises(RejectedEvent, match='Only its giver and the person take a badge back'):
        stands.copy().badge('cy', 'p-1', 'breakthrough', 'take_back', giver='bo').board()
    assert marks(stands.copy().badge('person', 'p-1', 'breakthrough', 'take_back', giver='bo').board(), 'p-1')[2] == ()
    assert marks(stands.copy().badge('bo', 'p-1', 'breakthrough', 'take_back').board(), 'p-1')[2] == ()


def test_the_author_the_proposer_and_the_coordinator_read_the_changes_to_badges_in_their_news() -> None:
    record = voted().coordinator('cy').join('dee')
    seq = record.board().seq
    board = (
        record.badge('bo', 'p-1', 'breakthrough', reason='It gives the strategy a size.')
        .badge('cy', 'p-1', 'breakthrough', 'second', giver='bo', reason='It does.')
        .badge('dee', 'p-1', 'promising')
        .board()
    )

    def notes(agent: str) -> list[tuple[str, str, str]]:
        return [(note.badge, note.by, note.action) for note in news(board, agent, seq).badges]

    # The author reads every change by another. The coordinator reads the proposal. The proposer reads the second.
    assert notes('ada') == [
        ('breakthrough', 'bo', 'give'),
        ('breakthrough', 'cy', 'second'),
        ('promising', 'dee', 'give'),
    ]
    assert notes('cy') == [('breakthrough', 'bo', 'give')]
    assert notes('bo') == [('breakthrough', 'cy', 'second')]
    assert notes('dee') == []
    assert [note.reason for note in update(board, 'ada', seq).badges][:2] == [
        'It gives the strategy a size.',
        'It does.',
    ]
    assert not update(board, 'cy', seq).posts


def test_a_record_enforces_the_rules_when_it_loads_and_a_record_from_before_votes_loads() -> None:
    old = lab().post(RESULT).board()
    assert (old.votes, old.badges, marks(old, 'p-1'), badge_lines(old, 'p-1')) == ((), (), (0, 0, ()), ())

    # The fold checks every event, so a record that somebody wrote by hand breaks the same rules.
    record = voted().vote('bo', 'p-1').badge('bo', 'p-1', 'breakthrough')
    forged = (
        record.copy().vote('ada', 'p-1', 'up', 'Mine is right.'),
        record.copy().badge('ada', 'p-1', 'promising'),
        record.copy().badge('bo', 'p-1', 'breakthrough', 'second', giver='bo'),
        record.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo'),
    )
    for events in forged:
        with pytest.raises(RejectedEvent):
            fold(events.events)


def test_no_schema_of_the_protocol_holds_a_count_of_votes_or_badges_for_an_agent() -> None:
    # A count is of one post. What the board and the app say about an agent has no field for votes or badges.
    about_an_agent = (AgentLine, Byline, ProfileResult, LeftLine, AgentView, Outcomes, Agent)
    words = ('vote', 'badge', 'up', 'down', 'score', 'rank', 'promising', 'confirmed', 'breakthrough')

    for model in about_an_agent:
        assert not [name for name in model.model_fields if any(word in name.split('_') for word in words)], model
    # The lab view has the proposals that wait and the threads with a breakthrough, and no count.
    assert {name for name in LabView.model_fields if 'vote' in name or 'badge' in name} == set()
    assert LabView.model_fields['proposals'].annotation == tuple[ProposalLine, ...]
