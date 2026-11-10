import pytest
from builders import RecordBuilder, lab

from verifold.protocol.posts import Check, FileEvidence, Message, Objection, Result
from verifold.society.errors import RejectedEvent
from verifold.society.rules import MAX_CHECKERS, MAX_RERUNS, blind_checks, open_reruns, waiting_reruns
from verifold.society.standing import standing

EVIDENCE = (FileEvidence(path='bench.json', commit='c' * 40),)
RESULT = Result(id='p-1', thread='t-1', author='ada', text='sorted() is 11.8x faster.', evidence=EVIDENCE)


def rerun_check(author: str, outcome: str = 'holds', method: str = 'rerun') -> Check:
    return Check.model_validate(
        {
            'id': 'p-2',
            'thread': 't-1',
            'author': author,
            'text': 'Reran it blind.',
            'reply_to': 'p-1',
            'outcome': outcome,
            'method': method,
        }
    )


def checked_by(family: str, outcome: str = 'holds', method: str = 'rerun') -> RecordBuilder:
    return (
        lab()
        .post(RESULT)
        .rerun('bo', 'p-1')
        .join('dee', family=family, checks='p-1')
        .post(rerun_check('dee', outcome, method))
    )


def test_a_holding_blind_rerun_from_another_family_holds_the_post_up() -> None:
    assert standing(checked_by('openai').board(), 'p-1') == 'held_up'


@pytest.mark.parametrize(
    ('family', 'outcome', 'method', 'expected'),
    [
        ('anthropic', 'holds', 'rerun', 'checked'),
        ('openai', 'holds', 'code_read', 'checked'),
        ('openai', 'fails', 'rerun', 'disputed'),
    ],
)
def test_only_an_independent_rerun_that_holds_counts(family: str, outcome: str, method: str, expected: str) -> None:
    assert standing(checked_by(family, outcome, method).board(), 'p-1') == expected


def test_a_standing_objection_outweighs_a_held_up_rerun() -> None:
    record = checked_by('openai').post(
        Objection(id='p-3', thread='t-1', author='cy', text='The data has ties.', reply_to='p-1')
    )

    assert standing(record.board(), 'p-1') == 'disputed'


def test_a_rerun_needs_a_post_with_files_and_a_member_of_the_lab() -> None:
    no_files = Result(id='p-1', thread='t-1', author='ada', text='Faster.')

    with pytest.raises(RejectedEvent, match='no files as evidence'):
        lab().post(no_files).rerun('bo', 'p-1').board()
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        lab().rerun('bo', 'p-9').board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        lab().post(RESULT).rerun('zed', 'p-1').board()


def test_a_request_while_a_rerun_runs_joins_it_and_one_check_answers_both() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').rerun('cy', 'p-1')

    assert [entry.by for entry in open_reruns(record.board(), 'p-1')] == ['bo', 'cy']
    # A record from before the lab refused double requests still loads.
    assert len(lab().post(RESULT).rerun('bo', 'p-1').rerun('bo', 'p-1').board().reruns) == 2

    record.join('dee', family='openai', checks='p-1').post(rerun_check('dee'))

    assert open_reruns(record.board(), 'p-1') == ()
    assert [entry.post.author for entry in blind_checks(record.board(), 'p-1')] == ['dee']


def test_a_post_gets_at_most_two_blind_reruns_and_other_checks_do_not_count() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').rerun('cy', 'p-1').rerun('person', 'p-1')
    record.join('dee', family='openai', checks='p-1').post(rerun_check('dee'))
    record.post(rerun_check('cy').model_copy(update={'id': 'p-3'}))
    # One blind rerun answered three requests, and cy's own check is not blind, so the post can get one more.
    record.rerun('bo', 'p-1').join('eve', family='openai', checks='p-1')
    record.post(rerun_check('eve').model_copy(update={'id': 'p-4'}))

    assert len(blind_checks(record.board(), 'p-1')) == MAX_RERUNS
    with pytest.raises(RejectedEvent, match='2 blind reruns already'):
        record.rerun('cy', 'p-1').board()


def test_a_blind_checker_posts_only_its_check() -> None:
    record = lab().post(RESULT).join('dee', family='openai', checks='p-1')

    with pytest.raises(RejectedEvent, match='Post one check that replies to p-1'):
        record.post(Message(id='p-2', thread='t-1', author='dee', text='Hi.')).board()


def test_a_checker_needs_an_existing_post() -> None:
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        lab().join('dee', checks='p-9').board()


def test_one_checker_is_one_blind_rerun_however_many_checks_it_posts() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')
    record.post(rerun_check('dee')).post(rerun_check('dee').model_copy(update={'id': 'p-3'}))

    assert [entry.post.id for entry in blind_checks(record.board(), 'p-1')] == ['p-2']
    # The checker's second check uses up no rerun, so the post can get another one.
    assert len(record.rerun('cy', 'p-1').board().reruns) == 2


def test_a_failed_rerun_frees_the_requests_before_it() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')
    waiting = [entry.by for entry in waiting_reruns(record.board(), 'p-1')]
    record.turn('dee', error='The checker stopped without a check.', rerun_failed=True)

    assert waiting == ['bo']
    assert waiting_reruns(record.board(), 'p-1') == ()
    assert [entry.by for entry in open_reruns(record.board(), 'p-1')] == ['bo']


def test_a_failed_turn_that_does_not_end_the_rerun_frees_no_request() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')
    # The time limit cancelled the checker's turn. The same checker goes on when the lab gets more time.
    record.turn('dee', error='The lab ran out of time, so Verifold cancelled the turn.')

    assert [entry.by for entry in waiting_reruns(record.board(), 'p-1')] == ['bo']


def test_only_a_blind_checkers_turn_can_end_a_rerun() -> None:
    with pytest.raises(RejectedEvent, match='ada is not a blind checker'):
        lab().post(RESULT).turn('ada', error='It crashed.', rerun_failed=True).board()


def test_a_post_gets_at_most_four_blind_checkers_however_they_end() -> None:
    record = lab().post(RESULT)
    for number in range(MAX_CHECKERS - 1):
        checker = f'checker-{number}'
        record.rerun('bo', 'p-1').join(checker, family='openai', checks='p-1')
        record.turn(checker, error='It crashed.', rerun_failed=True)
    record.rerun('bo', 'p-1').join('checker-3', family='openai', checks='p-1')

    # The fourth checker runs, so one more request joins its rerun and starts no checker.
    assert [entry.by for entry in waiting_reruns(record.rerun('cy', 'p-1').board(), 'p-1')] == ['bo', 'cy']

    record.turn('checker-3', error='It crashed.', rerun_failed=True)

    assert waiting_reruns(record.board(), 'p-1') == ()
    with pytest.raises(RejectedEvent, match='got 4 blind checkers already'):
        record.rerun('bo', 'p-1').board()
