from datetime import datetime, timedelta

import pytest
from builders import START, RecordBuilder, lab
from pydantic import ValidationError

from verifold.protocol.events import Posted, RoundEnd
from verifold.protocol.ids import PERSON
from verifold.protocol.join import MAX_ENTRIES, SEALED_TEXT
from verifold.protocol.posts import Entry, FileEvidence, Message, Objection, Result, Round, RuledOut
from verifold.society.attention import news, update, wakes
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.fold import fold
from verifold.society.identity import post_line, post_view
from verifold.society.lines import lines_of
from verifold.society.obstacles import obstacles
from verifold.society.rounds import close_due, closes_at, for_reader, open_round, sealed, waits_for
from verifold.society.views import brief, thread_summaries, thread_view

QUESTION = 'What is your best bet now?'
FILE = FileEvidence(path='claim.py', commit='c' * 40)
CLAIM = Result(id='p-1', thread='t-1', author='ada', text='Beats random.', evidence=(FILE,))
ROUND = Round(id='p-2', thread='t-1', author='ada', text=QUESTION, minutes=10)
SECRET = Entry(
    id='p-3',
    thread='t-1',
    author='bo',
    helper='scout',
    text='Bet on the tail of the cache.',
    body='The second seed fails without it.',
    reply_to='p-2',
    mentions=('ada',),
    builds_on=('p-1',),
    evidence=(FileEvidence(path='tail.py', commit='d' * 40),),
)
CONTENT = ('Bet on the tail of the cache.', 'The second seed fails without it.', 'scout', 'tail.py', 'd' * 40)
DURING = START + timedelta(minutes=12)
"""A moment while the round of `opened` is open."""
CLOSES = START + timedelta(minutes=18)
"""When the round of `opened` closes: ten minutes after it opened, at minute 8."""
UNTIL = 'Post p-3 is an entry of round p-2, which is open until 2026-11-06 12:18 UTC. Until the round closes,'


def opened() -> RecordBuilder:
    """A lab where ada posted result p-1 and opened round p-2 at minute 8. dan is on call."""
    return lab().join('dan').on_call('dan').post(CLAIM).post(ROUND)


def entered() -> RecordBuilder:
    """The round of `opened`, with bo's entry p-3, which names ada, builds on p-1, and has a helper and files."""
    return opened().post(SECRET)


def entry(post_id: str, author: str, text: str = 'My bet.') -> Entry:
    return Entry(id=post_id, thread='t-1', author=author, text=text, reply_to='p-2')


def at(record: RecordBuilder, moment: datetime) -> RecordBuilder:
    """Move the time of the last event of `record` to `moment`."""
    record.events[-1] = record.events[-1].model_copy(update={'at': moment})
    return record


def closed(record: RecordBuilder, why: RoundEnd = 'time') -> RecordBuilder:
    """Add Verifold's record of the close of round p-2, at its time for `time`."""
    record.closed('p-2', why)
    return at(record, CLOSES) if why == 'time' else record


def refusal(record: RecordBuilder) -> str:
    """Return why the board refuses the last event that `record` holds."""
    with pytest.raises(RejectedEvent) as refused:
        fold(record.events)
    return str(refused.value)


def everything(board: Board, reader: str, now: datetime) -> str:
    """Return every result of the board's tools that can carry the entry p-3, for a reader at `now`, as JSON."""
    claim, answer = board.posts[0], board.posts[2]
    results = (
        brief(board, reader, news(board, reader, 0, now), now=now),
        thread_view(board, reader, 't-1', now=now),
        thread_view(board, reader, 't-1', votes_of='p-3', now=now),
        *thread_summaries(board, reader, now),
        update(board, reader, 0, now),
        post_view(board, answer, reader, now),
        post_line(board, answer, reader, now),
        post_line(board, answer, reader, now, news=True),
        post_view(board, claim, reader, now),
    )
    return ''.join(result.model_dump_json() for result in results)


def test_a_round_is_a_post_for_every_agent_that_is_not_on_call_and_an_entry_wakes_nobody() -> None:
    board = entered().board()
    question, answer = board.posts[1], board.posts[2]

    assert [agent for agent in ('ada', 'bo', 'cy', 'dan') if wakes(board, agent, question)] == ['bo', 'cy']
    # The entry names ada, replies to ada's round, and builds on ada's result, and it wakes nobody.
    assert not any(wakes(board, agent, answer) for agent in ('ada', 'bo', 'cy', 'dan'))
    assert closes_at(question) == CLOSES
    assert open_round(board) is question


def test_a_lab_has_one_open_round_at_a_time_in_a_thread_for_the_whole_lab() -> None:
    second = Round(id='p-3', thread='t-1', author='cy', text='Another question?', minutes=5)

    assert refusal(opened().post(second)) == (
        'Round p-2 is open until 2026-11-06 12:18 UTC. A lab has one open round at a time.'
    )
    # At its time the round is closed, also before Verifold records the close, and another round can open.
    late = at(opened().post(second), CLOSES).board()
    assert [question.post.id for question in late.rounds] == ['p-2', 'p-3']
    assert open_round(late, CLOSES) is late.rounds[-1]
    # A round is for the whole lab and names nobody.
    side = lab().thread('t-2', 'ada', between=('ada', 'bo')).post(ROUND.model_copy(update={'thread': 't-2'}))
    assert refusal(side) == (
        'A round is for the whole lab, so it is in a thread for the whole lab: not a side thread, the '
        'conversation, or a thread of offers.'
    )
    named = lab().post(ROUND.model_copy(update={'mentions': ('bo',)}))
    assert refusal(named) == 'A round is for every agent that is not on call, so it names nobody in `mentions`.'
    for minutes in (0, 16):
        with pytest.raises(ValidationError):
            Round(id='p-2', thread='t-1', author='ada', text=QUESTION, minutes=minutes)
    with pytest.raises(ValidationError):
        Round.model_validate(ROUND.model_dump() | {'reply_to': 'p-1'})


def test_an_agent_enters_an_open_round_once_and_the_opener_and_an_agent_on_call_can_enter() -> None:
    record = entered().post(entry('p-4', 'ada')).post(entry('p-5', 'dan'))

    assert [answer.post.author for answer in record.board().posts[2:]] == ['bo', 'ada', 'dan']
    assert refusal(record.copy().post(entry('p-6', 'bo', 'A better bet.'))) == (
        'You entered round p-2 with post p-3. An agent has one entry in a round, and the board changes no entry.'
    )
    assert refusal(record.copy().post(entry('p-6', PERSON))) == (
        'An entry is the word of an agent. The person sees every entry and enters none.'
    )
    assert refusal(record.copy().post(entry('p-6', 'cy').model_copy(update={'reply_to': 'p-1'}))) == (
        'An entry replies to a round, and post p-1 is no round.'
    )
    # At its time, and after its recorded close, the round takes no entry.
    assert refusal(at(record.copy().post(entry('p-6', 'cy')), CLOSES)) == 'Round p-2 is closed, so it takes no entry.'
    withdrawn = record.copy().post(RuledOut(id='p-6', thread='t-1', author='ada', text='Enough.', reply_to='p-2'))
    assert refusal(closed(withdrawn, 'opener').post(entry('p-7', 'cy'))) == 'Round p-2 is closed, so it takes no entry.'


def test_a_sealed_entry_shows_nothing_of_its_content_in_any_result_for_an_agent_that_did_not_write_it() -> None:
    board = entered().board()
    # The same board with another content in the entry: no result for cy depends on what the entry says.
    other = entered()
    other.events[-1] = Posted(seq=other.events[-1].seq, at=other.events[-1].at, post=entry('p-3', 'bo', 'Other.'))
    plain = other.board()

    for reader in ('ada', 'cy', 'dan'):
        seen = everything(board, reader, DURING)
        assert seen == everything(plain, reader, DURING), reader
        assert not any(part in seen for part in CONTENT), reader
        assert SEALED_TEXT in seen
    # A sealed line says that the entry exists, who wrote it, and which round it answers, and nothing else.
    line = post_line(board, board.posts[2], 'cy', DURING).model_dump()
    assert {key: line[key] for key in ('id', 'author', 'kind', 'reply_to', 'text', 'sealed')} == {
        'id': 'p-3',
        'author': 'bo',
        'kind': 'entry',
        'reply_to': 'p-2',
        'text': SEALED_TEXT,
        'sealed': True,
    }
    assert not {'helper', 'builds_on', 'body'} & set(line)
    # Its author and the person read it whole, and the result that it builds on shows them the link.
    for reader in ('bo', PERSON):
        view = post_view(board, board.posts[2], reader, DURING)
        assert (view.sealed, view.post) == (False, SECRET)
        assert post_view(board, board.posts[0], reader, DURING).built_on_by == ('p-3',)
    assert post_view(board, board.posts[0], 'cy', DURING).built_on_by == ()
    assert all(part in everything(board, 'bo', DURING) for part in CONTENT)
    # At the round's time every agent reads every entry, before Verifold records the close and after it.
    assert all(part in everything(board, 'cy', CLOSES) for part in CONTENT)
    assert all(part in everything(closed(entered()).board(), 'cy', DURING) for part in CONTENT)
    # A view without a clock counts from the board's newest post, so it keeps the entry sealed.
    assert sealed(board, 'cy', board.posts[2])
    assert post_line(board, board.posts[2], 'cy').text == SEALED_TEXT


def test_the_board_for_a_reader_is_the_same_board_when_nothing_is_sealed_and_comes_back_as_it_is() -> None:
    board = entered().board()
    sealed_board = for_reader(board, 'cy', DURING)

    assert sealed_board is not board
    assert for_reader(board, 'cy', DURING) is sealed_board
    assert for_reader(sealed_board, 'cy', DURING) is sealed_board
    for reader in ('bo', PERSON):
        assert for_reader(board, reader, DURING) is board
    assert for_reader(board, 'cy', CLOSES) is board
    without = opened().board()
    assert for_reader(without, 'cy', DURING) is without


def test_a_sealed_entry_takes_no_reply_vote_badge_rerun_request_or_link_until_its_round_closes() -> None:
    cases = (
        (Objection(id='p-4', thread='t-1', author='cy', text='No.', reply_to='p-3'), 'reply'),
        (Message(id='p-4', thread='t-1', author='bo', text='Also.', reply_to='p-3'), 'reply'),
        (Result(id='p-4', thread='t-1', author='cy', text='So.', builds_on=('p-3',)), 'post that builds on it'),
    )
    for post, what in cases:
        assert refusal(entered().post(post)) == f'{UNTIL} the entry takes no {what}.'
        assert closed(entered()).post(post).board().posts[-1].post == post
    marks = (
        (lambda record: record.vote('cy', 'p-3', 'up', 'Good bet.'), 'vote'),
        (lambda record: record.vote(PERSON, 'p-3', 'up', 'Good bet.'), 'vote'),
        (lambda record: record.badge('cy', 'p-3'), 'badge'),
        (lambda record: record.rerun('cy', 'p-3'), 'rerun request'),
    )
    for add, what in marks:
        assert refusal(add(entered())) == f'{UNTIL} the entry takes no {what}.'
        # From the close on, the entry is a post like any other.
        after = closed(entered())
        assert add(after.copy()).board().seq == after.board().seq + 1


def test_a_round_closes_at_its_time_when_every_agent_entered_or_when_its_opener_withdraws_it() -> None:
    record = entered()
    board = record.board()

    assert close_due(board, DURING) is None
    assert close_due(board, CLOSES) == ('p-2', 'time')
    # The round waits for the agents that are not on call and have not left: ada and cy, not dan.
    assert waits_for(board, board.posts[1]) == ('ada', 'cy')
    almost = record.copy().post(entry('p-4', 'ada')).post(entry('p-5', 'dan'))
    assert close_due(almost.board(), DURING) is None
    assert close_due(almost.copy().post(entry('p-6', 'cy')).board(), DURING) == ('p-2', 'entered')
    # An agent that leaves, or goes on call, is waited for no longer.
    assert close_due(almost.copy().leave('cy').board(), DURING) == ('p-2', 'entered')
    assert close_due(almost.copy().on_call('cy').board(), DURING) == ('p-2', 'entered')
    # The opener's ruled-out lead that replies to the round closes it. Another agent's does not.
    others = record.copy().post(RuledOut(id='p-4', thread='t-1', author='cy', text='Pass.', reply_to='p-2'))
    assert close_due(others.board(), DURING) is None
    withdrawn = record.copy().post(RuledOut(id='p-4', thread='t-1', author='ada', text='Enough.', reply_to='p-2'))
    assert close_due(withdrawn.board(), DURING) == ('p-2', 'opener')
    # The withdrawal is no obstacle and moves the opener's work nowhere.
    assert obstacles(withdrawn.board()) == ()
    assert lines_of(withdrawn.board()) == lines_of(board)
    # The record's rules check each reason, and a round closes once.
    assert refusal(record.copy().closed('p-2', 'time')) == 'Round p-2 does not close for the reason `time` now.'
    assert refusal(almost.copy().closed('p-2', 'entered')) == 'Round p-2 does not close for the reason `entered` now.'
    twice = closed(withdrawn.copy(), 'opener')
    assert twice.board().round_closes[-1].why == 'opener'
    assert close_due(twice.board(), CLOSES) is None
    assert refusal(twice.closed('p-2', 'opener')) == 'Round p-2 closed already.'
    assert refusal(record.copy().closed('p-1', 'time')) == 'Post p-1 is no round.'
    # A round with no entry runs to its time, also in a lab whose agents are all on call.
    quiet = RecordBuilder().join('ada').on_call('ada').thread('t-1', opened_by='person')
    question = quiet.post(ROUND.model_copy(update={'author': PERSON})).board()
    assert waits_for(question, question.posts[0]) == ()
    assert close_due(question, DURING) is None


def test_the_close_brings_every_entry_to_the_agents_that_the_round_was_for_that_entered_or_that_opened_it() -> None:
    record = entered().post(entry('p-4', 'cy', 'Drop the cache line.'))
    before = record.board().seq
    withdrawn = record.post(RuledOut(id='p-5', thread='t-1', author='ada', text='Enough.', reply_to='p-2'))
    board = closed(withdrawn, 'opener').board()

    for agent in ('ada', 'bo', 'cy'):
        (note,) = news(board, agent, before).rounds
        assert (note.round.id, note.why, note.left_out) == ('p-2', 'opener', 0)
        assert [(line.id, line.text, line.sealed) for line in note.entries] == [
            ('p-3', 'Bet on the tail of the cache.', False),
            ('p-4', 'Drop the cache line.', False),
        ]
        assert update(board, agent, before).rounds == news(board, agent, before).rounds
    # dan is on call and did not enter, so the close is no news for it. Once it enters, it is.
    assert news(board, 'dan', before).rounds == ()
    with_dan = entered().post(entry('p-4', 'dan'))
    with_dan.post(RuledOut(id='p-5', thread='t-1', author='ada', text='Enough.', reply_to='p-2'))
    assert len(news(closed(with_dan, 'opener').board(), 'dan', before).rounds) == 1
    # A close that the agent read already is no news again, and an agent that left hears nothing.
    assert news(board, 'bo', board.seq).rounds == ()
    assert news(withdrawn.copy().leave('cy').board(), 'cy', before).rounds == ()


def test_the_news_of_a_close_holds_the_lines_of_twenty_entries_and_counts_the_others() -> None:
    names = [f'agent-{number}' for number in range(MAX_ENTRIES + 5)]
    record = lab()
    for name in names:
        record.join(name)
    record.post(ROUND)
    # Every entry comes a minute after the round opened.
    soon = record.events[-1].at + timedelta(minutes=1)
    for number, name in enumerate(names):
        at(record.post(entry(f'p-{number + 3}', name)), soon)
    board = at(record.closed('p-2', 'time'), START + timedelta(hours=2)).board()

    (note,) = news(board, 'bo', 0).rounds
    assert (len(note.entries), note.left_out) == (MAX_ENTRIES, 5)
    assert note.entries[0].author == 'agent-0'


def test_brief_has_the_open_round_with_its_end_its_count_and_the_readers_entry() -> None:
    board = entered().board()

    for reader, yours in (('bo', 'p-3'), ('cy', None)):
        line = brief(board, reader, news(board, reader, board.seq, DURING), now=DURING).round
        assert line is not None
        assert (line.round.id, line.round.text, line.closes_at, line.entered, line.not_entered, line.yours) == (
            'p-2',
            QUESTION,
            CLOSES,
            1,
            2,
            yours,
        )
    # A line leaves out what holds nothing.
    shown = brief(board, 'cy', news(board, 'cy', board.seq, DURING), now=DURING).model_dump(mode='json')['round']
    assert 'yours' not in shown
    assert brief(board, 'cy', news(board, 'cy', board.seq, CLOSES), now=CLOSES).round is None


def test_a_record_from_before_rounds_folds_unchanged_and_shows_no_round() -> None:
    record = lab().post(CLAIM).vote('bo', 'p-1', 'up', 'It holds.')
    record.post(Message(id='p-2', thread='t-1', author='cy', text='Noted.', reply_to='p-1'))
    board = record.board()

    assert (board.rounds, board.round_closes) == ((), ())
    assert brief(board, 'cy', news(board, 'cy', 0)).round is None
    assert news(board, 'cy', 0).rounds == ()
    assert for_reader(board, 'cy') is board
