import pytest
from builders import RecordBuilder, lab

from verifold.protocol.posts import Check, FileEvidence, Message, Objection, Result
from verifold.society.errors import RejectedEvent
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


def test_a_rerun_needs_files_as_evidence_and_at_most_two_requests() -> None:
    no_files = Result(id='p-1', thread='t-1', author='ada', text='Faster.')

    with pytest.raises(RejectedEvent, match='no files as evidence'):
        lab().post(no_files).rerun('bo', 'p-1').board()
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        lab().rerun('bo', 'p-9').board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        lab().post(RESULT).rerun('zed', 'p-1').board()
    with pytest.raises(RejectedEvent, match='2 reruns already'):
        lab().post(RESULT).rerun('bo', 'p-1').rerun('person', 'p-1').rerun('cy', 'p-1').board()


def test_a_blind_checker_posts_only_its_check() -> None:
    record = lab().post(RESULT).join('dee', family='openai', checks='p-1')

    with pytest.raises(RejectedEvent, match='Post one check that replies to p-1'):
        record.post(Message(id='p-2', thread='t-1', author='dee', text='Hi.')).board()


def test_a_checker_needs_an_existing_post() -> None:
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        lab().join('dee', checks='p-9').board()
