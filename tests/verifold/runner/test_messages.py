from datetime import timedelta, timezone
from pathlib import Path

from builders import START, RecordBuilder, lab

from verifold.app import NORMS_TEMPLATE
from verifold.protocol.posts import FileEvidence, Result
from verifold.protocol.settings import AtTimeLimit
from verifold.protocol.threads import QUESTION_TITLE
from verifold.runner.messages import DOORBELL, more_time_message, rerun_message, start_message

EVIDENCE = FileEvidence(path='bench.py', commit='c' * 40)
SAME_MOMENT = 'The other agents got this question at the same moment'
BOARD = "The lab's shared board is the MCP server `verifold`. Its `brief` tool says how the board works and shows what is on it."


def test_the_start_message_gives_the_question_the_agent_its_peers_and_the_norms() -> None:
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE)
    board = record.join('ada').join('bo').join('cy').board()
    # An older record gives agent 1 a planner's role. Verifold no longer sends roles.
    ada = board.agents[0].agent.model_copy(update={'role': 'Planner', 'brief': 'Open a plan thread.'})

    message = start_message(board, ada, Path('/lab/.verifold/LAB.md'))

    assert message.splitlines() == [
        'Does it hold?',
        '',
        f'You are Ada (ada) in a Verifold lab. {SAME_MOMENT}: Bo (bo, fake), Cy (cy, fake).',
        BOARD,
        'Thread t-1 on the board holds this question, and every agent watches it.',
        "/lab/.verifold/LAB.md holds the lab's norms, which the person sets.",
    ]


def test_the_start_message_leaves_out_blind_checkers_and_a_question_thread_that_the_lab_does_not_have() -> None:
    record = lab().post(Result(id='p-1', thread='t-1', author='ada', text='x', evidence=(EVIDENCE,)))
    board = record.join('dee', family='openai', checks='p-1').board()
    alone = RecordBuilder().join('ada').board()

    assert start_message(board, board.agents[1].agent, Path('LAB.md')).splitlines()[2:] == [
        f'You are Bo (bo) in a Verifold lab. {SAME_MOMENT}: Ada (ada, fake), Cy (cy, fake).',
        BOARD,
        "LAB.md holds the lab's norms, which the person sets.",
    ]
    assert 'You are Ada (ada) in a Verifold lab. No other agent works here.' in start_message(
        alone, alone.agents[0].agent, Path('LAB.md')
    )


def test_a_lab_with_a_time_limit_tells_each_agent_when_it_ends_in_utc() -> None:
    ends_at = (START + timedelta(hours=2)).astimezone(timezone(timedelta(hours=-5)))
    record = lab()
    board = record.time_set(ends_at).board()

    message = start_message(board, board.agents[1].agent, Path('LAB.md'))

    assert message.splitlines()[-1] == 'The lab ends at 2026-11-06 14:00 UTC, unless the person gives it more time.'
    assert more_time_message(ends_at, AtTimeLimit.FINISH).endswith('The lab now ends at 2026-11-06 14:00 UTC.')
    assert more_time_message(None, AtTimeLimit.FINISH) == (
        'Your last turn stopped when the lab ran out of time. The person gave the lab more time.'
    )


def test_the_lab_norms_and_the_doorbell_are_short_and_plain() -> None:
    assert NORMS_TEMPLATE.startswith("# The lab's norms")
    assert '`' not in NORMS_TEMPLATE
    assert len(NORMS_TEMPLATE) < 2_500
    assert DOORBELL == 'New posts for you on the lab board.'


def test_the_lab_norms_ask_agents_to_plan_together_check_each_other_and_agree_on_one_answer() -> None:
    for norm in (
        "post your plan in the question's thread and read the other agents' plans",
        'Wait a moment for the plans that are not there yet',
        'Give each line of work its own thread',
        'Read the board before each new piece of work',
        'Post each result when you have it',
        'Check the results of other agents',
        "propose the lab's answer in the question's thread",
    ):
        assert norm in NORMS_TEMPLATE


def test_the_lab_norms_ask_agents_to_take_other_sides_say_when_they_are_stuck_and_carry_ideas_across() -> None:
    for norm in (
        'Look at the question from a side that no other plan covers',
        'Change sides when the work calls for it, or start a helper that takes one',
        'Try a long shot beside the safe line',
        'Look for a result to build on, and for a problem that you can help with',
        'When you are stuck, post an ask that says what you tried',
        "post it in that agent's thread, also when it comes from another field",
        'When you build on a post, name it',
        'Use your own helpers and searches as you see fit',
    ):
        assert norm in NORMS_TEMPLATE


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


def test_the_message_after_more_time_says_what_happened_to_the_agents_processes() -> None:
    assert more_time_message(None, AtTimeLimit.PAUSE).endswith(
        'Verifold paused any process that you left running, and it runs again now.'
    )
    assert more_time_message(None, AtTimeLimit.STOP).endswith('Verifold stopped any process that you left running.')
