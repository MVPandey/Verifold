from builders import START

from verifold.protocol.events import TurnSummary
from verifold.protocol.settings import DiskSettings
from verifold.protocol.usage import DiskUse, Usage
from verifold.server.lab import Lab
from verifold.society.budget import GB
from verifold.store.record_file import RecordFile


def spent(agent: str, tokens: int, cost: float | None = None) -> TurnSummary:
    return TurnSummary(agent=agent, seconds=1, usage=Usage(input_tokens=tokens), cost_usd=cost)


def disk(total: int) -> DiskUse:
    return DiskUse(at=START, folders={'ada': total}, total=total)


def types(record: RecordFile, after: int) -> list[str]:
    return [event.type for event in record.read() if event.seq > after]


async def test_the_turn_that_reaches_the_budget_stops_the_lab_in_its_step_and_a_new_budget_lets_it_go_on(
    lab: Lab, record_file: RecordFile
) -> None:
    await lab.set_budget(1_000, None)
    await lab.end_turn(spent('ada', 600))
    assert lab.board.halted is None

    seq = lab.board.seq
    await lab.end_turn(spent('bo', 500))
    assert types(record_file, seq) == ['turn_ended', 'limit_reached']
    assert (lab.board.halted, lab.board.limits[-1].limit) == ('tokens', 'tokens')

    await lab.set_budget(5_000, None)
    assert lab.board.halted is None
    seq = lab.board.seq
    await lab.set_budget(5_000, None)
    assert lab.board.seq == seq


async def test_a_budget_that_the_lab_spent_already_stops_it_at_once_and_no_budget_lets_it_go_on(
    lab: Lab, record_file: RecordFile
) -> None:
    await lab.end_turn(spent('ada', 10, cost=2.5))
    seq = lab.board.seq

    await lab.set_budget(None, 2.0)

    assert types(record_file, seq) == ['budget_set', 'limit_reached']
    assert lab.board.halted == 'dollars'
    await lab.set_budget(None, None)
    assert lab.board.halted is None


async def test_a_measure_above_the_disk_limit_stops_the_lab_and_only_a_higher_limit_lets_it_go_on(
    lab: Lab, record_file: RecordFile
) -> None:
    settings = lab.board.settings
    await lab.set_settings(settings.model_copy(update={'disk': DiskSettings(limit_gb=2)}))
    await lab.measured(disk(GB))
    assert lab.board.halted is None
    assert lab.disk == disk(GB)

    await lab.measured(disk(3 * GB))
    assert (lab.board.halted, lab.board.limits[-1].disk_bytes) == ('disk', 3 * GB)

    # A limit that the files still reach records the stop again in its step.
    seq = lab.board.seq
    await lab.set_settings(settings.model_copy(update={'disk': DiskSettings(limit_gb=3)}))
    assert types(record_file, seq) == ['settings_set', 'limit_reached']
    await lab.set_settings(settings.model_copy(update={'disk': DiskSettings(limit_gb=4)}))
    assert lab.board.halted is None


async def test_a_record_with_budgets_and_limits_loads_as_it_was(lab: Lab, record_file: RecordFile) -> None:
    await lab.set_budget(100, None)
    await lab.end_turn(spent('ada', 200))

    again = Lab.load(record_file)

    assert again.board.halted == 'tokens'
    assert (again.board.spent_tokens, again.board.budget) == (200, lab.board.budget)
