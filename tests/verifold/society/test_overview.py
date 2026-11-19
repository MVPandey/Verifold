from builders import START, lab

from verifold.protocol.deliverables import MAX_DELIVERABLES
from verifold.protocol.join import MAX_BRIEF, MAX_OVERVIEW_OFFERS
from verifold.society.deliverables import deliverable_lines
from verifold.society.overview import overview


def test_the_overview_holds_the_newest_offers_of_each_deliverable_and_the_accepted_one_and_counts_the_rest() -> None:
    record = lab().desk('dee')
    agents = tuple(f'a{number}' for number in range(30))
    for agent in agents:
        record.join(agent)
    for number in range(1, MAX_DELIVERABLES + 1):
        record.deliverable(f'd-{number}', f'A report of part {number}.', f'p-8{number:03}')
    for number in range(1, MAX_DELIVERABLES + 1):
        for index, agent in enumerate(agents):
            record.offer(f'p-{number}{index:04}', agent, f'd-{number}', f't-{number}0')
    # The person accepted the oldest offer for the first deliverable, so it stays in the overview.
    record.decide('d-1', 'accepted', 'p-10000', 'p-99999', 't-10')
    board = record.board()

    view = overview(board, 'dee', START)
    first, second = view.deliverables[0], view.deliverables[1]

    assert [offer.post for offer in first.offers] == ['p-10000', 'p-10028', 'p-10029']
    assert first.offers[0].state == 'accepted'
    assert [offer.post for offer in second.offers] == ['p-20027', 'p-20028', 'p-20029']
    assert all(len(line.offers) == MAX_OVERVIEW_OFFERS for line in view.deliverables)
    assert [line.more_offers for line in view.deliverables] == [len(agents) - MAX_OVERVIEW_OFFERS] * MAX_DELIVERABLES
    assert (first.thread, second.thread) == ('t-10', 't-20')
    # Every offer of every deliverable would not fit in one tool result, and the overview does.
    whole = view.model_copy(update={'deliverables': deliverable_lines(board)})
    assert len(view.model_dump_json()) < MAX_BRIEF < len(whole.model_dump_json())
    # A deliverable with no more offers than the overview holds counts none, and its JSON has no such field.
    few = overview(
        lab().desk('dee').deliverable('d-1', 'A report.', 'p-1').offer('p-2', 'bo', 'd-1', 't-2').board(), 'dee', START
    )
    assert (len(few.deliverables[0].offers), few.deliverables[0].more_offers) == (1, 0)
    assert 'more_offers' not in few.model_dump_json()
