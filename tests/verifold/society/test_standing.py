from datetime import timedelta

import pytest
from builders import RecordBuilder

from verifold.protocol.posts import Answer, Ask, Check, Objection, Proposal, Result
from verifold.society.errors import NotFound
from verifold.society.standing import decision, is_answered, standing

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Beats random on 10 of 10 prompts.')
OBJECTION = Objection(id='p-2', thread='t-1', author='bo', text='The layer saw the test prompts.', reply_to='p-1')


def check(post_id: str, author: str, outcome: str, target: str = 'p-1') -> Check:
    return Check.model_validate(
        {
            'id': post_id,
            'thread': 't-1',
            'author': author,
            'text': 'Reran it blind.',
            'reply_to': target,
            'outcome': outcome,
            'method': 'rerun',
        }
    )


def test_a_new_post_is_open(record: RecordBuilder) -> None:
    assert standing(record.post(RESULT).board(), 'p-1') == 'open'


def test_an_objection_disputes_its_target(record: RecordBuilder) -> None:
    assert standing(record.post(RESULT).post(OBJECTION).board(), 'p-1') == 'disputed'


def test_an_accepted_objection_concedes_the_post(record: RecordBuilder) -> None:
    record.post(RESULT).post(OBJECTION)
    record.post(Answer(id='p-3', thread='t-1', author='ada', text='Right.', reply_to='p-2', accepts=True))

    assert standing(record.board(), 'p-1') == 'conceded'


def test_an_answer_that_argues_back_leaves_the_dispute(record: RecordBuilder) -> None:
    record.post(RESULT).post(OBJECTION)
    record.post(Answer(id='p-3', thread='t-1', author='ada', text='The split was fixed first.', reply_to='p-2'))

    assert standing(record.board(), 'p-1') == 'disputed'


def test_a_later_check_by_a_third_agent_overrules_the_objection(record: RecordBuilder) -> None:
    record.post(RESULT).post(OBJECTION).post(check('p-3', 'cy', 'holds'))

    assert standing(record.board(), 'p-1') == 'checked'


def test_the_objector_cannot_overrule_their_own_objection(record: RecordBuilder) -> None:
    record.post(RESULT).post(OBJECTION).post(check('p-3', 'bo', 'holds'))

    assert standing(record.board(), 'p-1') == 'disputed'


def test_a_check_before_the_objection_does_not_overrule_it(record: RecordBuilder) -> None:
    record.post(RESULT).post(check('p-2', 'cy', 'holds'))
    record.post(OBJECTION.model_copy(update={'id': 'p-3'}))

    assert standing(record.board(), 'p-1') == 'disputed'


def test_a_failed_check_disputes_even_a_checked_post(record: RecordBuilder) -> None:
    record.post(RESULT).post(check('p-2', 'cy', 'holds')).post(check('p-3', 'bo', 'fails'))

    assert standing(record.board(), 'p-1') == 'disputed'


def test_an_ask_is_open_until_an_answer_replies(record: RecordBuilder) -> None:
    record.post(Ask(id='p-1', thread='t-1', author='bo', text='Which layer?', mentions=('ada',)))
    assert not is_answered(record.board(), 'p-1')

    record.post(Answer(id='p-2', thread='t-1', author='ada', text='Layer 12.', reply_to='p-1'))
    assert is_answered(record.board(), 'p-1')


class TestDecision:
    WINDOW = timedelta(minutes=15)
    PROPOSAL = Proposal(id='p-1', thread='t-1', author='ada', text='Use layer 12 for every edit.')

    def test_it_is_decided_after_the_window(self, record: RecordBuilder) -> None:
        board = record.post(self.PROPOSAL).board()
        posted = record.at(board.seq)

        assert decision(board, 'p-1', posted + self.WINDOW - timedelta(seconds=1), self.WINDOW) == 'open'
        assert decision(board, 'p-1', posted + self.WINDOW, self.WINDOW) == 'decided'

    def test_a_late_objection_disputes_the_decision(self, record: RecordBuilder) -> None:
        board = record.post(self.PROPOSAL).post(OBJECTION).board()

        assert decision(board, 'p-1', record.at(board.seq) + timedelta(days=1), self.WINDOW) == 'disputed'

    def test_a_conceded_proposal_is_withdrawn(self, record: RecordBuilder) -> None:
        record.post(self.PROPOSAL).post(OBJECTION)
        record.post(Answer(id='p-3', thread='t-1', author='ada', text='Fair.', reply_to='p-2', accepts=True))

        assert decision(record.board(), 'p-1', record.at(1), self.WINDOW) == 'withdrawn'

    @pytest.mark.parametrize('post_id', ['p-1', 'p-9'])
    def test_it_needs_a_proposal(self, record: RecordBuilder, post_id: str) -> None:
        with pytest.raises(NotFound, match=post_id):
            decision(record.post(RESULT).board(), post_id, record.at(1), self.WINDOW)
