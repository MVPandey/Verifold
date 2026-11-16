from dataclasses import replace
from datetime import datetime, timedelta

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.agents import Agent
from verifold.protocol.app import AgentView, LabView, Outcomes
from verifold.protocol.join import AgentLine, Byline, LeftLine, News, ProfileResult
from verifold.protocol.moves import TimeMove
from verifold.protocol.posts import Answer, Ask, Check, Message, Objection, Result
from verifold.protocol.settings import Settings, VoteSettings
from verifold.protocol.votes import MAX_GIVES, MAX_NOTES, MAX_VOTE_LINES, MAX_WHY, NEWEST_VOTES, ProposalLine
from verifold.society.attention import news, update, wakes
from verifold.society.board import Board
from verifold.society.errors import NotFound, RejectedEvent
from verifold.society.fold import fold
from verifold.society.identity import post_line, post_view
from verifold.society.lines import lines_of
from verifold.society.standing import standing
from verifold.society.views import answer, brief, thread_summaries, thread_view
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
from verifold.society.votes import sealed as sealed_for

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
    # cy voted, so it sees every vote on the post.
    line = post_line(board, board.posts[0], 'cy')
    view = post_view(board, board.posts[0], 'cy')

    assert (line.up, line.down, line.badges) == (1, 1, ('promising',))
    assert 'reason' not in line.model_dump_json()
    assert (view.up, view.down) == (1, 1)
    assert [(vote.by, vote.reason) for vote in view.votes] == [('bo', 'It matches my run.'), ('cy', 'One seed only.')]
    assert [(badge.badge, badge.given[0].by, badge.given[0].reason) for badge in view.badges] == [
        ('promising', 'bo', 'Worth a second look.')
    ]
    # A post without votes and badges has a line without them.
    bare = post_line(voted().board(), board.posts[0], 'cy').model_dump()
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
    board = record.post(Result(id='p-2', thread='t-1', author='bo', text='Fails.')).vote('ada', 'p-2').board()
    # A day later no vote is sealed for cy.
    later = START + timedelta(days=1)

    # An agent's thread has the three newest votes of each post, and the counts hold every vote.
    first, second = thread_view(board, 'cy', 't-1', now=later).posts
    assert (first.up, first.down, [vote.by for vote in first.votes]) == (len(voters), 0, voters[-NEWEST_VOTES:])
    assert [vote.by for vote in second.votes] == ['ada']
    # The post that the call names has its newest twenty, and the other posts stay as they are.
    first, second = thread_view(board, 'cy', 't-1', votes_of='p-1', now=later).posts
    assert ([vote.by for vote in first.votes], len(second.votes)) == (voters[3:], 1)
    # The person's thread has the longer list for every post.
    assert len(thread_view(board, 'person', 't-1').posts[0].votes) == MAX_VOTE_LINES
    for missing in ('p-9', 'p-2'):
        other = 't-1' if missing == 'p-9' else 't-2'
        with pytest.raises(NotFound, match=f'Thread {other} has no post with the ID {missing}'):
            thread_view(record.copy().thread('t-2', opened_by='bo').board(), 'cy', other, votes_of=missing)


def test_a_thread_of_three_hundred_posts_with_twenty_voters_each_stays_one_tool_result() -> None:
    record = RecordBuilder()
    for number in range(21):
        record.join(f'a{number}')
    record.thread('t-1', opened_by='a0')
    for number in range(1, 301):
        record.post(Result(id=f'p-{number}', thread='t-1', author='a0', text='x' * 100))
    plain = len(thread_view(record.board(), 'a1', 't-1').model_dump_json())
    for number in range(1, 301):
        for voter in range(1, 21):
            record.vote(f'a{voter}', f'p-{number}', 'up', 'w' * MAX_WHY)
    board = record.board()

    voted_size = len(thread_view(board, 'a1', 't-1').model_dump_json())
    # Twenty reasons on every post would add 1.2 million characters. Three add at most 3 times a reason of 140
    # characters with its voter and time, so the thread grows by less than 700 characters a post.
    assert voted_size - plain < 300 * 700
    assert all((post.up, len(post.votes)) == (20, NEWEST_VOTES) for post in thread_view(board, 'a1', 't-1').posts)
    assert len(thread_view(board, 'a1', 't-1', votes_of='p-7').posts[6].votes) == 20


def sealed() -> RecordBuilder:
    """A lab where ada posted result p-1 at minute 5, bo voted on it, and cy and dan have not."""
    return voted().join('dan').vote('bo', 'p-1', 'up', 'It matches my run.')


def everything(board: Board, reader: str, now: datetime) -> str:
    """Return every result of the board's tools that can carry the post p-1, for a reader at `now`, as JSON."""
    results = (
        brief(board, reader, news(board, reader, 0, now), now=now),
        thread_view(board, reader, 't-1', now=now),
        thread_view(board, reader, 't-1', votes_of='p-1', now=now),
        *thread_summaries(board, reader, now),
        update(board, reader, 0, now),
        post_view(board, board.posts[0], reader, now),
        post_line(board, board.posts[0], reader, now),
    )
    return ''.join(result.model_dump_json() for result in results)


def counts(board: Board, reader: str, now: datetime) -> tuple[int, int, tuple[str, ...]]:
    """Return what a reader sees of the votes on p-1 at `now`: the line's votes up, the view's, and the voters."""
    view = post_view(board, board.posts[0], reader, now)
    return post_line(board, board.posts[0], reader, now).up, view.up, tuple(vote.by for vote in view.votes)


def test_the_votes_on_a_young_post_are_sealed_for_an_agent_that_did_not_write_it_or_vote_on_it() -> None:
    board = sealed().board()
    written = board.posts[0].at
    young, revealed = written + timedelta(minutes=9, seconds=59), written + timedelta(minutes=10)

    # cy neither wrote the post nor voted on it: no result shows it a count, a voter, or a reason.
    assert counts(board, 'cy', young) == (0, 0, ())
    assert 'It matches my run.' not in everything(board, 'cy', young)
    assert '"up":1' not in everything(board, 'cy', young)
    # A line of a sealed post leaves the counts out, as for a post without votes.
    assert not {'up', 'down'} & set(post_line(board, board.posts[0], 'cy', young).model_dump())
    # At the reveal time every agent sees every vote.
    assert counts(board, 'cy', revealed) == (1, 1, ('bo',))
    assert 'It matches my run.' in everything(board, 'cy', revealed)
    # The author, the voter, and the person see them at once.
    for reader in ('ada', 'bo', 'person'):
        assert counts(board, reader, written) == (1, 1, ('bo',)), reader
    # An agent that votes sees every vote from then on, also after it takes its vote back.
    voted_now = sealed().vote('cy', 'p-1', 'down', 'One seed only.')
    assert counts(voted_now.board(), 'cy', young) == (1, 1, ('bo', 'cy'))
    back = voted_now.vote('cy', 'p-1', 'none', '').board()
    assert counts(back, 'cy', young) == (1, 1, ('bo',))
    assert counts(back, 'dan', young) == (0, 0, ())
    # A view without a clock counts from the board's newest post, which is never later than the lab's clock.
    assert post_line(board, board.posts[0], 'cy').up == 0


def test_a_sealed_vote_changes_nothing_else_in_any_result() -> None:
    record = sealed().vote('dan', 'p-1', 'down', 'One seed only.').badge('bo', 'p-1', 'promising')
    board = record.board()
    young = board.posts[0].at + timedelta(minutes=5)
    # The same board without its votes: a sealed vote leaves every result as if it were not there.
    plain = replace(board, votes=(), votes_on={})

    assert everything(board, 'cy', young) == everything(plain, 'cy', young)
    # A badge is never sealed.
    assert post_line(board, board.posts[0], 'cy', young).badges == ('promising',)


def test_a_post_keeps_the_reveal_time_of_its_moment_and_zero_seals_no_vote() -> None:
    zero = Settings(votes=VoteSettings(reveal_minutes=0))
    record = lab().settings(zero).post(RESULT).join('dan').vote('bo', 'p-1', 'up', 'It matches my run.')
    written = record.board().posts[0].at

    assert counts(record.board(), 'cy', written) == (1, 1, ('bo',))
    # A later change holds for the posts after it: p-1 stays open, and p-2 is sealed for its first hour.
    hour = record.settings(Settings(votes=VoteSettings(reveal_minutes=60)))
    later = hour.post(Result(id='p-2', thread='t-1', author='ada', text='Again.')).vote('bo', 'p-2').board()
    assert counts(later, 'cy', written + timedelta(minutes=30)) == (1, 1, ('bo',))
    second = later.posts[1]
    assert sealed_for(later, 'cy', second, second.at + timedelta(minutes=59))
    assert not sealed_for(later, 'cy', second, second.at + timedelta(minutes=60))
    # Raising the reveal time seals no vote again that an agent saw: p-1 of a lab of ten minutes stays revealed.
    raised = sealed().settings(Settings(votes=VoteSettings(reveal_minutes=600))).board()
    assert counts(raised, 'cy', raised.posts[0].at + timedelta(minutes=10)) == (1, 1, ('bo',))
    # A record from before the setting has the default reveal time.
    assert sealed().board().settings.votes.reveal_minutes == 10
    assert fold(sealed().events).settings == Settings()


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


def test_the_news_holds_the_newest_votes_and_badge_changes_and_counts_the_rest() -> None:
    record = voted()
    seq = record.board().seq
    voters = [f'agent-{number}' for number in range(MAX_NOTES + 2)]
    for voter in voters:
        record.join(voter).vote(voter, 'p-1').badge(voter, 'p-1', 'promising')
    mine = news(record.board(), 'ada', seq)

    assert ([note.by for note in mine.votes], mine.votes_left_out) == (voters[2:], 2)
    assert ([note.by for note in mine.badges], mine.badges_left_out) == (voters[2:], 2)
    later = update(record.board(), 'ada', seq)
    assert (later.votes_left_out, later.badges_left_out) == (2, 2)
    assert (news(record.board(), 'bo', seq).votes_left_out, news(record.board(), 'ada', mine.seq).votes) == (0, ())


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


def test_a_confirmed_badge_from_an_agent_names_a_check_of_the_post_that_holds() -> None:
    record = (
        voted()
        .post(Check(id='p-2', thread='t-1', author='bo', text='Same.', reply_to='p-1', outcome='holds', method='rerun'))
        .post(Check(id='p-3', thread='t-1', author='cy', text='No.', reply_to='p-1', outcome='fails', method='rerun'))
        .post(Result(id='p-4', thread='t-1', author='cy', text='On 114 pairs too.', builds_on=('p-1',)))
        .post(Message(id='p-5', thread='t-1', author='bo', text='I agree.', reply_to='p-1'))
        .post(Result(id='p-6', thread='t-1', author='bo', text='Mine.'))
        .post(Check(id='p-7', thread='t-1', author='ada', text='Yes.', reply_to='p-6', outcome='holds', method='rerun'))
    )
    clean = voted().post(
        Check(id='p-2', thread='t-1', author='bo', text='Same.', reply_to='p-1', outcome='holds', method='rerun')
    )

    with pytest.raises(RejectedEvent, match='names in `proof` the post that confirmed it'):
        clean.copy().badge('bo', 'p-1', 'confirmed').board()
    with pytest.raises(RejectedEvent, match='Post p-9 does not exist'):
        clean.copy().badge('bo', 'p-1', 'confirmed', proof='p-9').board()
    # A failed check, a result that builds on the post, a message, the post itself, and a check of another post
    # are no proof. So no agent confirms a post with a result that it wrote for that.
    for wrong in ('p-3', 'p-4', 'p-5', 'p-1', 'p-7'):
        with pytest.raises(RejectedEvent, match=f'Post {wrong} is no check of post p-1 with the outcome `holds`'):
            record.copy().badge('bo', 'p-1', 'confirmed', proof=wrong).board()
    with pytest.raises(RejectedEvent, match='Post p-1 is your own'):
        clean.copy().badge('ada', 'p-1', 'confirmed', proof='p-2').board()
    # The check is another agent's than the post's author. Its own author names it, and so does a third agent.
    for giver in ('bo', 'cy'):
        board = clean.copy().badge(giver, 'p-1', 'confirmed', proof='p-2').board()
        (line,) = badge_lines(board, 'p-1')
        assert (line.badge, line.given[0].by, line.given[0].proof, line.lapsed) == ('confirmed', giver, 'p-2', False)
        assert marks(board, 'p-1')[2] == ('confirmed',)
    # A check that a failed check followed confirms nothing.
    with pytest.raises(RejectedEvent, match='A check of post p-1 failed after post p-2'):
        record.copy().badge('bo', 'p-1', 'confirmed', proof='p-2').board()
    # The person gives it with a check or without one, and with nothing that is no check.
    assert marks(clean.copy().badge('person', 'p-1', 'confirmed').board(), 'p-1')[2] == ('confirmed',)
    assert marks(clean.copy().badge('person', 'p-1', 'confirmed', proof='p-2').board(), 'p-1')[2] == ('confirmed',)
    with pytest.raises(RejectedEvent, match='Post p-4 is no check'):
        record.copy().badge('person', 'p-1', 'confirmed', proof='p-4').board()


def test_two_agents_do_not_confirm_each_other_through_results() -> None:
    record = voted().post(Result(id='p-2', thread='t-1', author='bo', text='Ok.', builds_on=('p-1',)))

    with pytest.raises(RejectedEvent, match='Post p-2 is no check of post p-1'):
        record.copy().badge('bo', 'p-1', 'confirmed', proof='p-2').board()
    mutual = record.post(Result(id='p-3', thread='t-1', author='ada', text='Ok.', builds_on=('p-2',)))
    with pytest.raises(RejectedEvent, match='Post p-3 is no check of post p-2'):
        mutual.badge('ada', 'p-2', 'confirmed', proof='p-3').board()


def test_a_confirmed_badge_shows_only_while_no_later_check_of_the_post_fails() -> None:
    holds = Check(id='p-2', thread='t-1', author='bo', text='Same.', reply_to='p-1', outcome='holds', method='rerun')
    record = voted().post(holds).badge('bo', 'p-1', 'confirmed', proof='p-2').badge('person', 'p-1', 'confirmed')
    fails = Check(id='p-3', thread='t-1', author='cy', text='No.', reply_to='p-1', outcome='fails', method='rerun')
    failed = record.copy().post(fails)
    board = failed.board()

    # The record keeps both givers' words. No view shows the badge, and the thread says why.
    assert marks(board, 'p-1')[2] == ()
    assert post_line(board, board.posts[0], 'person').badges == ()
    (line,) = badge_lines(board, 'p-1')
    assert (line.lapsed, [(given.by, given.proof, given.lapsed) for given in line.given]) == (
        True,
        [('bo', 'p-2', 'later_check_failed'), ('person', None, 'later_check_failed')],
    )
    assert len(board.badges) == 2
    # A failed check that its author conceded counts for nothing, so the badge shows again.
    conceded = (
        failed.copy()
        .post(Objection(id='p-4', thread='t-1', author='bo', text='Wrong seed.', reply_to='p-3'))
        .post(Answer(id='p-5', thread='t-1', author='cy', text='Right.', reply_to='p-4', accepts=True))
        .board()
    )
    assert (marks(conceded, 'p-1')[2], badge_lines(conceded, 'p-1')[0].lapsed) == (('confirmed',), False)
    # The author of the check that confirmed the post concedes an objection to it: that word confirms no longer,
    # and the person's word, which names no check, still does.
    taken = (
        record.copy()
        .post(Objection(id='p-3', thread='t-1', author='cy', text='You ran another file.', reply_to='p-2'))
        .post(Answer(id='p-4', thread='t-1', author='bo', text='I did.', reply_to='p-3', accepts=True))
        .board()
    )
    (line,) = badge_lines(taken, 'p-1')
    assert (line.lapsed, [given.lapsed for given in line.given], marks(taken, 'p-1')[2]) == (
        False,
        ['check_conceded', None],
        ('confirmed',),
    )
    # A failed check from before the check that confirmed the post changes nothing.
    earlier = voted().post(fails.model_copy(update={'id': 'p-2'})).post(holds.model_copy(update={'id': 'p-3'}))
    assert marks(earlier.badge('bo', 'p-1', 'confirmed', proof='p-3').board(), 'p-1')[2] == ('confirmed',)


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
    assert [(wait.post, wait.thread, wait.by) for wait in proposals(board)] == [('p-1', 't-1', 'bo')]

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


SEATED = 'Only the person, and the agent to which the person gave the coordinator seat before the proposal'


def test_only_the_person_and_a_coordinator_that_the_person_seated_before_the_proposal_second() -> None:
    record = voted().coordinator('cy')
    proposed = record.copy().badge('bo', 'p-1', 'breakthrough')

    # The coordinator that the person seated seconds, and the thread names it as the one that can.
    assert badge_lines(proposed.board(), 'p-1')[0].seconder == 'cy'
    assert marks(proposed.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo').board(), 'p-1')[2] == (
        'breakthrough',
    )
    # An agent without the coordinator seat seconds nothing, and nobody seconds for its own post.
    with pytest.raises(RejectedEvent, match=SEATED):
        proposed.copy().join('dee').badge('dee', 'p-1', 'breakthrough', 'second', giver='bo').board()
    with pytest.raises(RejectedEvent, match=SEATED):
        proposed.copy().badge('bo', 'p-1', 'breakthrough', 'second', giver='bo').board()
    with pytest.raises(RejectedEvent, match='Nobody seconds a badge for its own post'):
        proposed.copy().badge('ada', 'p-1', 'breakthrough', 'second', giver='bo').board()
    # The coordinator does not second its own proposal: only the person does.
    own = record.copy().badge('cy', 'p-1', 'breakthrough')
    with pytest.raises(RejectedEvent, match='You proposed the `breakthrough` badge for post p-1'):
        own.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='cy').board()
    assert badge_lines(own.board(), 'p-1')[0].seconder is None
    assert marks(own.copy().badge('person', 'p-1', 'breakthrough', 'second', giver='cy').board(), 'p-1')[2] == (
        'breakthrough',
    )
    # The coordinator does not second for a post that it wrote.
    theirs = (
        record.copy().post(Result(id='p-2', thread='t-1', author='cy', text='Mine.')).badge('bo', 'p-2', 'breakthrough')
    )
    with pytest.raises(RejectedEvent, match='Post p-2 is your own'):
        theirs.copy().badge('cy', 'p-2', 'breakthrough', 'second', giver='bo').board()
    assert badge_lines(theirs.board(), 'p-2')[0].seconder is None
    # In a lab without a coordinator, only the person seconds.
    none = voted().badge('bo', 'p-1', 'breakthrough')
    with pytest.raises(RejectedEvent, match=SEATED):
        none.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo').board()
    assert badge_lines(none.board(), 'p-1')[0].seconder is None
    assert marks(none.badge('person', 'p-1', 'breakthrough', 'second', giver='bo').board(), 'p-1')[2] == (
        'breakthrough',
    )


def test_an_agent_that_took_the_coordinator_seat_itself_seconds_nothing() -> None:
    second = ('cy', 'p-1', 'breakthrough', 'second')
    paths = {
        # The seat is open, and an agent takes it to second.
        'an open seat': voted().badge('bo', 'p-1', 'breakthrough').coordinator('cy', by='cy'),
        # The agent held the seat by its own taking before the proposal.
        'a seat taken before': voted().coordinator('cy', by='cy').badge('bo', 'p-1', 'breakthrough'),
        # The author holds the seat, gives it up, and another agent takes it to second.
        'the author passes the seat': voted()
        .coordinator('ada', by='ada')
        .badge('bo', 'p-1', 'breakthrough')
        .coordinator(None, by='ada')
        .coordinator('cy', by='cy'),
        # The proposer holds the seat, gives it up, and another agent takes it to second.
        'the proposer passes the seat': voted()
        .coordinator('bo', by='bo')
        .badge('bo', 'p-1', 'breakthrough')
        .coordinator(None, by='bo')
        .coordinator('cy', by='cy'),
        # The person seats the agent only after the proposal.
        'seated after the proposal': voted().badge('bo', 'p-1', 'breakthrough').coordinator('cy'),
        # The person seated the agent, the agent gave the seat up and took it again itself.
        'given up and taken again': voted()
        .coordinator('cy')
        .badge('bo', 'p-1', 'breakthrough')
        .coordinator(None, by='cy')
        .coordinator('cy', by='cy'),
    }

    for name, record in paths.items():
        assert badge_lines(record.board(), 'p-1')[0].seconder is None, name
        with pytest.raises(RejectedEvent, match=SEATED):
            record.copy().badge(*second, giver='bo').board()
        # The person's second stands on every path.
        assert marks(record.copy().badge('person', *second[1:], giver='bo').board(), 'p-1')[2] == ('breakthrough',)


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
    # After its own take-back the agent can propose again. After the person's "no", it cannot for that post.
    own = record.copy().badge('bo', 'p-1', 'breakthrough', 'take_back')
    assert proposals(own.badge('bo', 'p-1', 'breakthrough').board())[0].by == 'bo'
    declined = record.copy().badge('person', 'p-1', 'breakthrough', 'take_back', giver='bo')
    with pytest.raises(RejectedEvent, match='The person took back your `breakthrough` badge for post p-1'):
        declined.copy().badge('bo', 'p-1', 'breakthrough').board()
    other = declined.post(Result(id='p-2', thread='t-1', author='ada', text='Next.')).badge('bo', 'p-2', 'breakthrough')
    assert [wait.post for wait in proposals(other.board())] == ['p-2']
    # The person takes back a badge that stands, and so does its proposer. The seconder does not.
    stands = record.copy().badge('cy', 'p-1', 'breakthrough', 'second', giver='bo')
    with pytest.raises(RejectedEvent, match='Only its giver and the person take a badge back'):
        stands.copy().badge('cy', 'p-1', 'breakthrough', 'take_back', giver='bo').board()
    assert marks(stands.copy().badge('person', 'p-1', 'breakthrough', 'take_back', giver='bo').board(), 'p-1')[2] == ()
    assert marks(stands.copy().badge('bo', 'p-1', 'breakthrough', 'take_back').board(), 'p-1')[2] == ()


def test_no_post_of_the_person_takes_a_badge() -> None:
    record = voted().post(Message(id='p-2', thread='t-1', author='person', text='Look at the fees.'))

    for badge in ('promising', 'confirmed', 'breakthrough'):
        with pytest.raises(RejectedEvent, match=r"Post p-2 is the person's\. A badge is about an agent's work"):
            record.copy().badge('bo', 'p-2', badge).board()
    # An agent still votes on a post of the person.
    assert marks(record.vote('bo', 'p-2').board(), 'p-2') == (1, 0, ())


def test_a_request_and_a_decision_take_no_vote_and_no_badge() -> None:
    record = (
        lab()
        .time_set(START + timedelta(hours=9))
        .coordinator('ada')
        .permission('p-1', 'bo')
        .thread('t-2', opened_by='ada', conversation=True)
        .request('p-2', 'ada', TimeMove(minutes=30))
        .deliverable('d-1', 'The answer as one page.', 'p-3')
        .offer('p-4', 'bo', 'd-1', 't-3')
        .decide('d-1', 'accepted', 'p-4', 'p-5', 't-3')
    )
    kinds = {
        'p-1': 'a request of a harness',
        'p-2': 'a request for a move of the person',
        'p-5': "the person's decision about an offer",
    }

    for post, kind in kinds.items():
        with pytest.raises(RejectedEvent, match=f'Post {post} is {kind}, and the board takes no vote on it'):
            record.copy().vote('cy', post).board()
    for post in ('p-1', 'p-2'):
        with pytest.raises(RejectedEvent, match=f'Post {post} is .*, and the board takes no badge on it'):
            record.copy().badge('cy', post).board()
    # An offer of files is an agent's work, and an ask of an agent's own is a post like any other.
    asked = record.post(Ask(id='p-6', thread='t-1', author='bo', text='Which seed?'))
    assert marks(asked.vote('cy', 'p-4').badge('cy', 'p-4').vote('cy', 'p-6').board(), 'p-4') == (1, 0, ('promising',))


def test_a_giver_gives_one_kind_of_badge_to_one_post_three_times_at_most() -> None:
    record = voted()
    for _ in range(MAX_GIVES):
        record.badge('bo', 'p-1').badge('bo', 'p-1', 'promising', 'take_back')

    with pytest.raises(RejectedEvent, match='You gave post p-1 the `promising` badge 3 times and took it back'):
        record.copy().badge('bo', 'p-1').board()
    # The bound is for one giver, one kind, and one post.
    other = record.post(Result(id='p-2', thread='t-1', author='ada', text='Next.'))
    board = other.badge('bo', 'p-2').badge('cy', 'p-1').badge('person', 'p-1').board()
    assert (marks(board, 'p-1')[2], marks(board, 'p-2')[2]) == (('promising',), ('promising',))
    # The board keeps the changes of each post apart, so a rule reads one post's and no scan of the record.
    assert {post: len(changes) for post, changes in board.badges_on.items()} == {'p-1': 8, 'p-2': 1}
    assert {post: list(votes) for post, votes in voted().vote('bo', 'p-1').board().votes_on.items()} == {'p-1': ['bo']}


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
