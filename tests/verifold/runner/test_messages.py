from datetime import timedelta, timezone
from pathlib import Path

from builders import START, lab

from verifold.protocol.posts import FileEvidence, Result
from verifold.runner.messages import DOORBELL, LAB_TEMPLATE, more_time_message, rerun_message, start_message


def test_the_start_message_gives_the_question_the_agent_its_peers_and_the_norms() -> None:
    board = lab().board()
    ada = board.agents[0].agent.model_copy(update={'role': 'Planner', 'brief': 'Open a plan thread.'})

    message = start_message(board, ada, Path('/lab/.verifold/LAB.md'))

    assert message.splitlines() == [
        'Does it hold?',
        '',
        'You are Ada in a Verifold lab. The other agents: Bo (fake), Cy (fake).',
        "The `verifold` tools are the lab's shared board. /lab/.verifold/LAB.md describes how the lab works.",
        'Your starting role: Planner. Open a plan thread.',
    ]


def test_an_agent_without_a_role_gets_no_role_line() -> None:
    board = lab().board()

    assert 'starting role' not in start_message(board, board.agents[1].agent, Path('LAB.md'))


def test_a_lab_with_a_time_limit_tells_each_agent_when_it_ends_in_utc() -> None:
    ends_at = (START + timedelta(hours=2)).astimezone(timezone(timedelta(hours=-5)))
    record = lab()
    board = record.time_set(ends_at).board()

    message = start_message(board, board.agents[1].agent, Path('LAB.md'))

    assert message.splitlines()[-1] == 'The lab ends at 2026-11-06 14:00 UTC, unless the person gives it more time.'
    assert more_time_message(ends_at).endswith('The lab now ends at 2026-11-06 14:00 UTC.')
    assert more_time_message(None) == (
        'Your last turn stopped when the lab ran out of time. The person gave the lab more time.'
    )


def test_the_lab_norms_and_the_doorbell_are_short_and_plain() -> None:
    assert LAB_TEMPLATE.startswith('# How this lab works')
    assert DOORBELL == 'New posts for you on the lab board.'


def test_a_rerun_message_gives_the_claim_its_files_and_where_to_check_but_not_the_thread() -> None:
    post = Result(
        id='p-4',
        thread='t-2',
        author='ada',
        text='sorted() is 11.8x faster.',
        body='My reasoning: the C implementation avoids interpreter overhead.',
        evidence=(FileEvidence(path='bench.py', commit='c' * 40), FileEvidence(path='out.json', commit='c' * 40)),
    )

    message = rerun_message(post)

    assert '"sorted() is 11.8x faster."' in message
    assert 'bench.py, out.json' in message
    assert 'thread t-2 that replies to p-4' in message
    assert 'reasoning' not in message
