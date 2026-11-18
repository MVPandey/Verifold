import pytest
from builders import RecordBuilder, lab

from verifold.protocol.events import BudgetSet, LimitReached, TurnEnded
from verifold.protocol.settings import DiskSettings, Settings
from verifold.protocol.usage import Usage
from verifold.society.budget import GB, budget_line, reached
from verifold.society.errors import RejectedEvent


def turn(record: RecordBuilder, agent: str, tokens: tuple[int, int], cost: float | None) -> RecordBuilder:
    seq, at = record._stamp()
    usage = Usage(input_tokens=tokens[0], cached_input_tokens=tokens[0] // 2, output_tokens=tokens[1])
    record.events.append(TurnEnded(seq=seq, at=at, agent=agent, seconds=1, usage=usage, cost_usd=cost))
    return record


def budget(record: RecordBuilder, tokens: int | None = None, dollars: float | None = None) -> RecordBuilder:
    seq, at = record._stamp()
    record.events.append(BudgetSet(seq=seq, at=at, tokens=tokens, dollars=dollars))
    return record


def limit(record: RecordBuilder, what: str, disk_bytes: int | None = None) -> RecordBuilder:
    seq, at = record._stamp()
    record.events.append(LimitReached.model_validate({'seq': seq, 'at': at, 'limit': what, 'disk_bytes': disk_bytes}))
    return record


def mixed() -> RecordBuilder:
    # ada's harness reports a cost and cy's reports tokens only. The cached input tokens are among the input ones.
    record = lab()
    turn(record, 'ada', (1_000, 200), 0.5)
    turn(record, 'cy', (3_000, 400), None)
    return turn(record, 'ada', (500, 100), 0.25)


def test_spent_is_the_sum_over_the_record_and_a_harness_without_a_cost_adds_no_dollars() -> None:
    board = budget(mixed(), tokens=10_000, dollars=1).board()

    line = budget_line(board)

    assert (line.spent_tokens, line.spent_dollars) == (5_200, 0.75)
    assert (line.tokens_left, line.dollars_left) == (4_800, 0.25)
    assert reached(board) is None


def test_a_record_from_before_budgets_loads_with_no_budget_and_no_limit() -> None:
    board = mixed().board()

    assert (board.budget, board.at_limit, board.halted) == (None, None, None)
    assert budget_line(board).model_dump() == {
        'tokens': None,
        'dollars': None,
        'spent_tokens': 5_200,
        'spent_dollars': 0.75,
        'tokens_left': None,
        'dollars_left': None,
    }


def test_the_record_takes_a_limit_only_once_it_is_reached_and_a_new_budget_lifts_it() -> None:
    record = budget(mixed(), tokens=5_000)

    board = limit(record.copy(), 'tokens').board()
    with pytest.raises(RejectedEvent, match='has not reached its budget in dollars'):
        limit(record.copy(), 'dollars').board()
    with pytest.raises(RejectedEvent, match='stands at its budget in tokens already'):
        limit(limit(record.copy(), 'tokens'), 'tokens').board()

    assert (board.at_limit, board.halted, budget_line(board).tokens_left) == ('tokens', 'tokens', 0)
    raised = budget(limit(record.copy(), 'tokens'), tokens=20_000).board()
    assert (raised.at_limit, raised.halted) == (None, None)


def test_the_dollars_of_the_harnesses_that_report_a_cost_reach_a_budget_in_dollars() -> None:
    board = limit(budget(mixed(), dollars=0.75), 'dollars').board()

    assert board.halted == 'dollars'
    assert budget_line(board).dollars_left == 0


def test_the_disk_limit_needs_the_measured_bytes_and_a_change_of_the_limit_lifts_it() -> None:
    record = lab().settings(Settings(disk=DiskSettings(limit_gb=2)))

    with pytest.raises(RejectedEvent, match='has not reached its disk limit'):
        limit(record.copy(), 'disk', GB).board()
    with pytest.raises(RejectedEvent, match='has not reached its disk limit'):
        limit(record.copy(), 'disk').board()
    board = limit(record.copy(), 'disk', 3 * GB).board()
    assert board.halted == 'disk'
    assert reached(board, 3 * GB) == 'disk'
    # A new budget leaves the disk limit as it stood, and a new disk limit lifts it.
    assert budget(limit(record.copy(), 'disk', 3 * GB), tokens=10).board().at_limit == 'disk'
    lifted = limit(record.copy(), 'disk', 3 * GB).settings(Settings(disk=DiskSettings(limit_gb=5))).board()
    assert lifted.at_limit is None
    # Other settings that change leave it as it stood.
    same = limit(record.copy(), 'disk', 3 * GB).settings(Settings(disk=DiskSettings(limit_gb=2))).board()
    assert same.at_limit == 'disk'


def test_no_disk_limit_and_no_measure_reach_nothing() -> None:
    board = lab().settings(Settings(disk=DiskSettings(limit_gb=0))).board()

    assert reached(board, 10**15) is None
    assert reached(lab().board()) is None


def test_the_time_limit_comes_first_when_both_stand_and_more_time_leaves_the_budget_reached() -> None:
    record = limit(budget(mixed(), tokens=100), 'tokens')
    record.time_set(record.at(len(record.events) + 1)).ran_out()

    assert record.board().halted == 'time'
    later = record.time_set(record.at(len(record.events) + 100)).board()
    assert (later.out_of_time, later.halted) == (False, 'tokens')
