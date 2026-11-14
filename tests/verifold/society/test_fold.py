import pytest
from builders import START, RecordBuilder

from verifold.protocol.events import LabOpened, TurnEnded, WentQuiet
from verifold.protocol.posts import Message, Result
from verifold.protocol.usage import Usage
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply, fold


def test_the_board_keeps_every_entry_with_its_time(record: RecordBuilder) -> None:
    record.post(Result(id='p-1', thread='t-1', author='ada', text='Beats random on 10 of 10 prompts.'))

    board = record.board()

    assert board.opened.question == 'Does it hold?'
    assert [entry.agent.id for entry in board.agents] == ['ada', 'bo', 'cy']
    entry = board.post('p-1')
    assert entry is not None
    assert entry.at == record.at(entry.seq)
    assert board.seq == len(record.events)


def test_lookups_return_none_for_unknown_ids(record: RecordBuilder) -> None:
    board = record.board()

    assert board.agent('zed') is None
    assert board.thread('t-9') is None
    assert board.post('p-9') is None


def test_a_record_starts_with_lab_opened() -> None:
    with pytest.raises(RejectedEvent, match='starts with lab_opened'):
        fold([])
    with pytest.raises(RejectedEvent, match='starts with lab_opened'):
        fold([LabOpened(seq=2, at=START, question='Late start?')])


def test_events_follow_in_sequence(record: RecordBuilder) -> None:
    board = record.board()
    skipped = Message(id='p-1', thread='t-1', author='ada', text='Hi')

    with pytest.raises(RejectedEvent, match='does not follow'):
        apply(board, record.post(skipped).events[-1].model_copy(update={'seq': board.seq + 2}))


def test_a_lab_opens_once(record: RecordBuilder) -> None:
    board = record.board()

    with pytest.raises(RejectedEvent, match='one lab_opened'):
        apply(board, LabOpened(seq=board.seq + 1, at=START, question='Again?'))


def test_a_turn_belongs_to_an_agent_in_the_lab(record: RecordBuilder) -> None:
    board = record.board()
    turn = TurnEnded(seq=board.seq + 1, at=START, agent='zed', seconds=1, usage=Usage())

    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        apply(board, turn)
    assert apply(board, turn.model_copy(update={'agent': 'ada'})).turns[-1].agent == 'ada'


def test_a_record_from_before_holds_a_quiet_mark_that_changes_nothing(record: RecordBuilder) -> None:
    before = record.board()
    mark = WentQuiet(seq=before.seq + 1, at=START, seconds=180)

    after = fold([*record.events, mark])

    assert after.seq == before.seq + 1
    assert (after.posts, after.agents, after.threads) == (before.posts, before.agents, before.threads)
