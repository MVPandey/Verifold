import json

from builders import RecordBuilder
from pydantic import TypeAdapter

from verifold.protocol.events import Event
from verifold.protocol.join import News, RestsOn
from verifold.protocol.posts import Answer, Check, CheckMethod, Message, Objection, Outcome, Proposal, Result
from verifold.society.fold import fold
from verifold.society.standing import standing
from verifold.society.tested import how_tested, rests_on, support
from verifold.society.views import brief, thread_summaries

RESULT = Result(id='p-1', thread='t-1', author='ada', text='The strategy beats the index on 2022 to 2024.')


def check(post_id: str, author: str, method: CheckMethod, outcome: Outcome, target: str = 'p-1') -> Check:
    body = 'On 2015 to 2019, without the cut that was chosen after 2023.' if method == 'challenge' else ''
    return Check(
        id=post_id,
        thread='t-1',
        author=author,
        text='Tested it.',
        reply_to=target,
        outcome=outcome,
        method=method,
        body=body,
    )


def test_a_rerun_that_holds_marks_a_result_as_reproduced_and_nothing_more(record: RecordBuilder) -> None:
    record.post(RESULT).post(check('p-2', 'bo', 'rerun', 'holds'))
    board = record.board()

    assert how_tested(board, 'p-1') == ('reproduced',)
    assert (standing(board, 'p-1'), support(board, 'p-1')) == ('checked', 'reproduced_only')


def test_a_challenge_that_holds_marks_a_result_as_challenged_and_makes_it_no_held_up(record: RecordBuilder) -> None:
    # A challenge from another family holds. Only a rerun makes a result stand as held up.
    record.post(RESULT).post(check('p-2', 'cy', 'challenge', 'holds'))
    board = record.board()

    assert how_tested(board, 'p-1') == ('challenged',)
    assert (standing(board, 'p-1'), support(board, 'p-1')) == ('checked', 'challenged')


def test_a_result_can_be_reproduced_and_challenged_and_the_marks_keep_their_order(record: RecordBuilder) -> None:
    record.post(RESULT).post(check('p-2', 'cy', 'challenge', 'holds')).post(check('p-3', 'bo', 'rerun', 'holds'))
    board = record.board()

    assert how_tested(board, 'p-1') == ('reproduced', 'challenged')
    assert support(board, 'p-1') == 'challenged'


def test_a_challenge_that_fails_disputes_the_result_as_a_failed_check_does(record: RecordBuilder) -> None:
    record.post(RESULT).post(check('p-2', 'bo', 'rerun', 'holds')).post(check('p-3', 'cy', 'challenge', 'fails'))
    board = record.board()

    assert how_tested(board, 'p-1') == ('reproduced', 'challenge_failed')
    assert (standing(board, 'p-1'), support(board, 'p-1')) == ('disputed', 'disputed')
    # Its author concedes an objection to the challenge, so it counts for nothing, and the result stands again.
    record.post(Objection(id='p-4', thread='t-1', author='ada', text='It ran on 2014.', reply_to='p-3'))
    record.post(Answer(id='p-5', thread='t-1', author='cy', text='Right.', reply_to='p-4', accepts=True))
    after = record.board()
    assert how_tested(after, 'p-1') == ('reproduced',)
    assert support(after, 'p-1') == 'reproduced_only'


def test_only_a_result_has_marks_and_other_checks_mark_nothing(record: RecordBuilder) -> None:
    proposal = Proposal(id='p-2', thread='t-1', author='bo', text='The answer is yes.')
    record.post(RESULT).post(proposal).post(check('p-3', 'cy', 'code_read', 'holds'))
    record.post(check('p-4', 'ada', 'challenge', 'holds', target='p-2'))
    board = record.board()

    assert (how_tested(board, 'p-1'), support(board, 'p-1')) == ((), 'checked_otherwise')
    assert how_tested(board, 'p-2') == ()
    assert how_tested(board, 'p-99') == ()


def test_a_candidate_rests_on_the_results_that_it_builds_on_counted_by_how_each_stands(record: RecordBuilder) -> None:
    results = (
        RESULT,
        *(Result(id=f'p-{number}', thread='t-1', author='ada', text=f'Finding {number}.') for number in range(2, 8)),
    )
    for result in results:
        record.post(result)
    record.post(check('p-10', 'cy', 'challenge', 'holds', target='p-1'))
    record.post(check('p-11', 'bo', 'rerun', 'holds', target='p-2'))
    record.post(check('p-12', 'bo', 'ratings', 'holds', target='p-3'))
    record.post(Objection(id='p-13', thread='t-1', author='bo', text='It leaks.', reply_to='p-5'))
    record.post(Objection(id='p-14', thread='t-1', author='bo', text='Wrong sign.', reply_to='p-6'))
    record.post(Answer(id='p-15', thread='t-1', author='ada', text='Right.', reply_to='p-14', accepts=True))
    record.post(Message(id='p-16', thread='t-1', author='bo', text='A note.'))
    # The proposal names a result twice and a message, which is no result.
    builds = ('p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-1', 'p-16')
    candidate = record.post(Proposal(id='p-17', thread='t-1', author='bo', text='Yes.', builds_on=builds)).board()

    entry = candidate.post('p-17')
    assert entry is not None
    assert rests_on(candidate, entry) == RestsOn(
        challenged=1, reproduced_only=1, checked_otherwise=1, not_checked=1, disputed=1, conceded=1
    )
    # A zero says nothing, so the line holds only the counts that are there.
    assert RestsOn(not_checked=2).model_dump() == {'not_checked': 2}


def test_a_candidate_that_builds_on_no_result_rests_on_none(record: RecordBuilder) -> None:
    record.post(Message(id='p-1', thread='t-1', author='ada', text='A note.'))
    board = record.post(Proposal(id='p-2', thread='t-1', author='bo', text='Yes.', builds_on=('p-1',))).board()
    alone = record.post(Proposal(id='p-3', thread='t-1', author='ada', text='No.')).board()

    built, bare = board.post('p-2'), alone.post('p-3')
    assert built is not None
    assert bare is not None
    assert (rests_on(board, built), rests_on(alone, bare)) == (None, None)


def test_a_record_from_before_challenges_loads_and_its_reruns_mark_its_results() -> None:
    # Events as an older Verifold wrote them: no take on a check, no question_seen on a proposal, and no carries.
    def agent(agent_id: str, family: str) -> dict[str, object]:
        model = {'family': family, 'name': None, 'effort': None}
        return {'type': 'agent_joined', 'agent': {'id': agent_id, 'name': agent_id, 'harness': 'fake', 'model': model}}

    def posted(**post: object) -> dict[str, object]:
        return {'type': 'posted', 'post': {'thread': 't-1', **post}}

    events = (
        {'type': 'lab_opened', 'version': 1, 'question': 'Q?', 'auto_mode': True},
        agent('ada', 'anthropic'),
        agent('cy', 'openai'),
        {'type': 'thread_opened', 'thread': {'id': 't-1', 'title': 'T', 'opened_by': 'ada'}},
        posted(id='p-1', author='ada', text='Holds.', kind='result'),
        posted(id='p-2', author='cy', text='So.', reply_to='p-1', kind='check', outcome='holds', method='rerun'),
        posted(id='p-3', author='cy', text='Yes.', builds_on=['p-1'], kind='proposal'),
    )
    lines = (
        json.dumps({'seq': seq, 'at': f'2026-10-01T12:0{seq}:00Z', **event}) for seq, event in enumerate(events, 1)
    )
    board = fold(TypeAdapter(Event).validate_json(line) for line in lines)
    (summary,) = thread_summaries(board, 'ada')
    (candidate,) = brief(board, 'ada', News(seq=0)).candidates

    assert how_tested(board, 'p-1') == ('reproduced',)
    assert (summary.challenged, summary.reproduced_only) == (0, 1)
    assert candidate.rests_on == RestsOn(reproduced_only=1)
