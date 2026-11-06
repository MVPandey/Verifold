from pathlib import Path

from builders import lab

from verifold.runner.messages import DOORBELL, LAB_TEMPLATE, start_message


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


def test_the_lab_norms_and_the_doorbell_are_short_and_plain() -> None:
    assert LAB_TEMPLATE.startswith('# How this lab works')
    assert DOORBELL == 'New posts for you on the lab board.'
