from builders import RecordBuilder
from pydantic import TypeAdapter

from verifold.protocol.events import Event
from verifold.protocol.posts import Answer, Call, Check, Message, Objection, Plan, Result, RuledOut
from verifold.society.fold import fold
from verifold.society.obstacles import obstacles


def _states(record: RecordBuilder) -> list[tuple[str, str, list[str]]]:
    return [
        (found.entry.post.id, found.state, [builder.post.id for builder in found.builders])
        for found in obstacles(record.board())
    ]


def test_an_obstacle_is_open_then_taken_up_by_a_plan_and_removed_by_a_result_that_stands(record: RecordBuilder) -> None:
    record.post(RuledOut(id='p-1', thread='t-1', author='ada', text='The solver times out past 40 nodes.'))
    assert _states(record) == [('p-1', 'open', [])]

    # A message or an objection that names it in `builds_on` takes nothing up: only a plan or a result does.
    record.post(Message(id='p-2', thread='t-1', author='bo', text='Same here.', builds_on=('p-1',)))
    record.post(Plan(id='p-3', thread='t-1', author='bo', text='I split the graph first.', builds_on=('p-1',)))
    assert _states(record) == [('p-1', 'taken_up', ['p-3'])]

    record.post(Result(id='p-4', thread='t-1', author='bo', text='It solves 200 nodes.', builds_on=('p-1',)))
    assert _states(record) == [('p-1', 'removed', ['p-4'])]


def test_a_disputed_result_takes_an_obstacle_up_and_a_conceded_one_builds_on_nothing(record: RecordBuilder) -> None:
    # The rule: a result that is disputed still builds on the obstacle, so the obstacle is taken up and not
    # removed. A result that its author conceded counts for nothing, so the obstacle is open again.
    record.post(RuledOut(id='p-1', thread='t-1', author='ada', text='The solver times out past 40 nodes.'))
    record.post(Result(id='p-2', thread='t-1', author='bo', text='It solves 200 nodes.', builds_on=('p-1',)))
    record.post(Objection(id='p-3', thread='t-1', author='cy', text='Only on trees.', reply_to='p-2'))
    assert _states(record) == [('p-1', 'taken_up', ['p-2'])]

    # A check that holds, from another agent, overrules the objection, and the result stands again.
    held = record.copy()
    held.post(
        Check(
            id='p-4',
            thread='t-1',
            author='ada',
            text='Holds on grids.',
            reply_to='p-2',
            outcome='holds',
            method='rerun',
        )
    )
    assert _states(held) == [('p-1', 'removed', ['p-2'])]

    # The author accepts the objection, so the result is conceded and builds on nothing.
    record.post(Answer(id='p-4', thread='t-1', author='bo', text='Right.', reply_to='p-3', accepts=True))
    assert _states(record) == [('p-1', 'open', [])]

    # A plan still takes it up, and the conceded result is not among the posts that do.
    record.post(Plan(id='p-5', thread='t-1', author='cy', text='I try grids.', builds_on=('p-1',)))
    assert _states(record) == [('p-1', 'taken_up', ['p-5'])]


def test_only_a_ruled_out_post_of_a_line_of_work_is_an_obstacle(record: RecordBuilder) -> None:
    record.post(Call(id='p-1', thread='t-1', author='ada', text='Somebody to fit the curve.'))
    # The caller withdraws its own call. That closes no lead.
    record.post(RuledOut(id='p-2', thread='t-1', author='ada', text='Not needed.', reply_to='p-1'))
    record.thread('t-2', opened_by='ada', between=('ada', 'bo'))
    record.post(RuledOut(id='p-3', thread='t-2', author='bo', text='Not between us.'))
    record.coordinator('ada').thread('t-3', opened_by='ada', conversation=True)
    record.post(RuledOut(id='p-4', thread='t-3', author='ada', text='Not in the conversation.'))
    record.deliverable('d-1', 'One page.', 'p-9').offer('p-5', 'bo', 'd-1', 't-4')
    record.post(RuledOut(id='p-6', thread='t-4', author='bo', text='Not among the offers.'))
    # Another agent's ruled-out post that replies to the call is an obstacle.
    record.post(RuledOut(id='p-7', thread='t-1', author='bo', text='The curve has no fit.', reply_to='p-1'))

    assert _states(record) == [('p-7', 'open', [])]


def test_a_record_from_before_obstacles_has_its_ruled_out_posts_as_obstacles() -> None:
    old = """
{"seq":1,"at":"2026-11-06T12:00:00Z","type":"lab_opened","version":1,"question":"Does it hold?"}
{"seq":2,"at":"2026-11-06T12:01:00Z","type":"agent_joined","agent":{"id":"ada","name":"Ada","harness":"fake","model":{"family":"anthropic"}}}
{"seq":3,"at":"2026-11-06T12:02:00Z","type":"thread_opened","thread":{"id":"t-1","title":"Subject","opened_by":"ada"}}
{"seq":4,"at":"2026-11-06T12:03:00Z","type":"posted","post":{"id":"p-1","thread":"t-1","author":"ada","kind":"ruled_out","text":"No edge after fees."}}
{"seq":5,"at":"2026-11-06T12:04:00Z","type":"posted","post":{"id":"p-2","thread":"t-1","author":"ada","kind":"ruled_out","text":"No edge at night."}}
{"seq":6,"at":"2026-11-06T12:05:00Z","type":"posted","post":{"id":"p-3","thread":"t-1","author":"ada","kind":"plan","text":"Maker side.","builds_on":["p-2"]}}
"""
    board = fold([TypeAdapter(Event).validate_json(line) for line in old.strip().splitlines()])

    assert [(found.entry.post.id, found.state) for found in obstacles(board)] == [('p-1', 'open'), ('p-2', 'taken_up')]
