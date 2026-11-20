from datetime import timedelta

from builders import START, lab

from verifold.protocol.deliverables import MAX_DELIVERABLES
from verifold.protocol.join import MAX_BRIEF, MAX_OVERVIEW_OFFERS
from verifold.protocol.posts import Branch, Dashboard, FileEvidence, HeadlineNumber, Idea, Measure, Reading, Task
from verifold.society.deliverables import deliverable_lines
from verifold.society.overview import overview

FILES = (FileEvidence(path='value.py', commit='c' * 40), FileEvidence(path='value.out', commit='c' * 40))


def test_the_overview_says_whether_a_dashboard_stands_the_headline_number_the_map_and_the_open_tasks() -> None:
    record = lab().desk('dee')
    empty = overview(record.board(), 'dee', START)
    assert (empty.dashboard, empty.headline_number, empty.branches, empty.ideas, empty.unowned_tasks) == (
        None,
        None,
        0,
        0,
        0,
    )
    record.post(
        Reading(
            id='p-1',
            thread='t-1',
            author='ada',
            text='Growth of the account counts.',
            branches=(Branch(id='b-1', title='Prices'), Branch(id='b-2', title='Calendars')),
        )
    )
    test, rules_out = 'Count the rounds.', 'Fewer than 6 of 20.'
    record.post(
        Idea(id='p-2', thread='t-1', author='bo', text='Buy below 0.4.', parent='b-1', test=test, rules_out=rules_out)
    )
    record.post(Idea(id='p-3', thread='t-1', author='cy', text='Sell after a win.', test=test, rules_out=rules_out))
    record.post(Task(id='p-4', thread='t-1', author='ada', text='Fetch the prices.', output='A file.', bounds='1 h.'))
    record.post(
        Measure(
            id='p-5',
            thread='t-1',
            author='bo',
            text='Account value: 119.7695 USD',
            label='Account value',
            value='119.7695',
            unit='USD',
            as_of=record.at(len(record.events) + 1),
            script='value.py',
            output='value.out',
            evidence=FILES,
        )
    )
    record.post(HeadlineNumber(id='p-6', thread='t-1', author='person', text='Named.', label='Account value'))
    record.thread('t-2', opened_by='bo', title='Dashboard')
    page = (FileEvidence(path='board.html', commit='c' * 40),)
    record.post(Dashboard(id='p-7', thread='t-2', author='bo', text='The account.', evidence=page, size=900))
    now = record.at(len(record.events)) + timedelta(minutes=3)

    view = overview(record.board(), 'dee', now)

    assert view.dashboard is not None
    assert (view.dashboard.post, view.dashboard.by, view.dashboard.minutes_ago) == ('p-7', 'bo', 3)
    assert view.headline_number is not None
    assert view.headline_number.measure is not None
    assert (view.headline_number.label, str(view.headline_number.measure.value)) == ('Account value', '119.7695')
    assert view.headline_number.measure.rerun_by == ()
    assert (view.branches, view.ideas, view.ideas_without_branch, view.unowned_tasks) == (2, 2, 1, 1)


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
