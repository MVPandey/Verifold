from datetime import timedelta, timezone
from pathlib import Path

from builders import START, RecordBuilder, lab

from verifold.app import NORMS_TEMPLATE
from verifold.protocol.posts import FileEvidence, Result
from verifold.protocol.settings import AtTimeLimit
from verifold.protocol.threads import QUESTION_TITLE
from verifold.runner.messages import (
    DOORBELL,
    ON_CALL,
    RESTARTED,
    back_message,
    invitation,
    more_time_message,
    start_message,
)

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
        'Thread t-1 on the board holds this question.',
        "/lab/.verifold/LAB.md holds the lab's norms, which the person sets and can change while the lab runs.",
    ]


def test_the_start_message_states_the_role_that_the_person_gave_and_the_seat_as_facts() -> None:
    record = RecordBuilder().join('ada').join('bo', name='Codex · gpt-6').on_call('ada').coordinator('ada')
    board = record.board()
    ada = board.agents[0].agent.model_copy(update={'given_role': 'direction creator'})

    message = start_message(board, ada, Path('LAB.md'))
    plain = start_message(board, board.agents[1].agent, Path('LAB.md'))

    assert message.splitlines()[2:7] == [
        f'You are Ada (ada) in a Verifold lab. {SAME_MOMENT}: Codex · gpt-6 (bo, fake).',
        BOARD,
        'The person gave your seat this role: direction creator',
        "You hold the lab's coordinator seat.",
        ON_CALL,
    ]
    # The sentence holds for an invited agent too, which Verifold never starts.
    assert 'Verifold starts you' not in ON_CALL
    assert all(
        part in ON_CALL
        for part in (
            'names you',
            'replies to you',
            'builds on your post',
            'a thread that you watch',
            'side thread',
            'close',
        )
    )
    # An agent with no role from the person and a plain seat reads nothing about either.
    assert plain.splitlines()[2:] == [
        f'You are Codex · gpt-6 (bo) in a Verifold lab. {SAME_MOMENT}: Ada (ada, fake).',
        BOARD,
        "LAB.md holds the lab's norms, which the person sets and can change while the lab runs.",
    ]


def test_the_start_message_leaves_out_blind_checkers_and_a_question_thread_that_the_lab_does_not_have() -> None:
    record = lab().post(Result(id='p-1', thread='t-1', author='ada', text='x', evidence=(EVIDENCE,)))
    board = record.join('dee', family='openai', checks='p-1').board()
    alone = RecordBuilder().join('ada').board()

    assert start_message(board, board.agents[1].agent, Path('LAB.md')).splitlines()[2:] == [
        f'You are Bo (bo) in a Verifold lab. {SAME_MOMENT}: Ada (ada, fake), Cy (cy, fake).',
        BOARD,
        "LAB.md holds the lab's norms, which the person sets and can change while the lab runs.",
    ]
    assert 'You are Ada (ada) in a Verifold lab. No other agent works here.' in start_message(
        alone, alone.agents[0].agent, Path('LAB.md')
    )


def test_a_lab_with_a_time_limit_tells_each_agent_when_it_ends_in_utc() -> None:
    ends_at = (START + timedelta(hours=2)).astimezone(timezone(timedelta(hours=-5)))
    record = lab()
    board = record.time_set(ends_at).board()

    message = start_message(board, board.agents[1].agent, Path('LAB.md'))

    assert message.splitlines()[-1] == 'The lab ends at 2026-11-06 14:00 UTC, unless it gets more time.'
    assert more_time_message(ends_at, AtTimeLimit.FINISH).endswith('The lab now ends at 2026-11-06 14:00 UTC.')
    assert more_time_message(None, AtTimeLimit.FINISH) == (
        'Your last turn stopped when the lab ran out of time. The person gave the lab more time.'
    )


def test_the_lab_norms_and_the_doorbell_are_short_and_plain() -> None:
    assert NORMS_TEMPLATE.startswith("# The lab's norms")
    assert '`' not in NORMS_TEMPLATE
    # The limit was 2,800. It grew by 300 for the two norms that came out of Python and the norm on checks by rerun,
    # by 1,200 for the norms on the goal, on obstacles, on a human's limits, on reviewer seats, on the
    # coordinator's strategy, and on a name, and by 300 for the close, the open coordinator seat, and the helpers.
    assert len(NORMS_TEMPLATE) < 4_600
    assert DOORBELL == 'New posts for you on the lab board.'


def test_the_lab_norms_ask_agents_to_plan_together_check_each_other_and_agree_on_one_answer() -> None:
    for norm in (
        "post your plan in the question's thread and read the other agents' plans",
        'Wait a moment for the plans that are not there yet',
        'Give each line of work its own thread',
        'Read the board before each new piece of work',
        'Post each result when you have it',
        "propose the lab's answer. Another agent can propose a different one; the newest proposal is the answer that shows",
        'Object to the proposal when you see a problem in it.',
        'Chain the work',
    ):
        assert norm in NORMS_TEMPLATE


def test_the_lab_norms_hold_the_goal_the_obstacle_the_reviewer_seats_and_the_name() -> None:
    for norm in (
        'The question is a goal. Keep working toward it while the lab has time.',
        'A result that says "this does not work" is a finding on the way, and the next attempt starts from it.',
        'What stands in the way becomes the way.',
        'name the obstacle and ask what would remove it. Two things that fail alone can work together.',
        "Do not assume a human's limits.",
        'Revisit what you ruled out as too slow or too much work.',
        'Before you rule a method out, search what is published on it.',
        "Exploring and testing is everyone's main work. Before you build on a result, look at it yourself",
        'When the lab has reviewer seats, a check that the lab relies on comes from an agent in one.',
        'Take a seat only when checking is the work you want; leave it free when you would rather build.',
        "Ask for one of your own result when the lab's answer rests on it",
        'an agent in a reviewer seat can ask for one of any result',
        'When the agents agree that nothing useful is left to try, one of them posts a close.',
        'When no agent holds the seat and it is open, an agent that wants this work can take it.',
        'A lead gets a champion and a forward test before it gets an audit.',
        "When the lab has a coordinator, it owns the lab's strategy: which bets are open, which are missing, and what to try next.",
        'It can ask one agent to take the strategy. Whoever has it looks across fields',
        'looks across fields, chains results from different threads, and opens the next line when one closes',
        'Choose a name, and say in one line the lens you bring.',
    ):
        assert norm in NORMS_TEMPLATE
    # A live lab showed seven agents that opened with the same doubt, and rival answers are allowed.
    for gone in (
        'or a doubt',
        'Do not post an answer of your own beside it',
        'Do this before you check',
        'Check the proposal',
        'Agree on one answer',
    ):
        assert gone not in NORMS_TEMPLATE


def test_the_lab_norms_ask_agents_to_take_other_sides_say_when_they_are_stuck_and_carry_ideas_across() -> None:
    for norm in (
        'Look at the question from a side that no other plan covers',
        'Change sides when the work calls for it.',
        'Open a line that nobody has, join one that is short of hands, or try a long shot',
        'Look for a result to build on, and for a problem that you can help with',
        'When you are stuck, post an ask that says what you tried',
        "post it in that agent's thread, also when it comes from another field",
        'When you build on a post, name it',
        "Use your harness's own helpers for work that can run beside yours, such as a literature search, a side experiment or a second look.",
        "A helper posts with your token; have it give its own name in the post's helper field, or post what it finds",
    ):
        assert norm in NORMS_TEMPLATE


def test_the_lab_norms_hold_what_came_out_of_python_and_the_norm_on_reruns() -> None:
    for norm in (
        "Post your results before the lab's time ends",
        "have it give its own name in the post's helper field",
        'When you check a result with a rerun, reproduce it yourself from its files, and do not trust the claim',
        'Post the check with the files of your own run',
        'an agent in a reviewer seat can ask for one of any result, and takes a rerun that is wanted',
    ):
        assert norm in NORMS_TEMPLATE


def test_the_message_after_more_time_says_what_happened_to_the_agents_processes() -> None:
    assert more_time_message(None, AtTimeLimit.PAUSE).endswith(
        'Verifold paused any process that you left running, and it runs again now.'
    )
    assert more_time_message(None, AtTimeLimit.STOP).endswith('Verifold stopped any process that you left running.')


def test_the_start_message_names_the_file_that_says_how_the_lab_writes_its_answer() -> None:
    board = lab().board()
    message = start_message(board, board.agents[0].agent, Path('LAB.md'), Path('/lab/.verifold/WRITING.md'))

    assert message.splitlines()[-1] == '/lab/.verifold/WRITING.md says how the lab writes its answer for the person.'


def test_an_agent_that_joins_a_lab_under_way_reads_that_and_agents_that_start_together_read_the_same() -> None:
    record = lab().turn('ada')
    board = record.board()
    bo = board.agents[1].agent

    joined = start_message(board, bo, Path('LAB.md'), under_way=True)
    together = start_message(board, bo, Path('LAB.md'))

    assert 'The lab is under way, and these agents work in it: Ada (ada, fake), Cy (cy, fake).' in joined
    # A turn that ended while the lab's first agents were seated changes nothing for the ones seated after it.
    assert 'The other agents got this question at the same moment: Ada (ada, fake), Cy (cy, fake).' in together


def test_an_invitation_gives_the_address_the_token_the_folder_and_the_facts_and_no_role() -> None:
    text = invitation('Does it hold?\n\nYou are Agent 3.', 'http://127.0.0.1:8123/mcp', 'the-token', Path('/lab/a3'))

    lines = text.splitlines()
    assert lines[0].startswith('This is an invitation for one agent to a Verifold lab')
    assert 'Verifold did not start you, so it cannot wake you or stop you.' in lines[1]
    assert lines[3:8] == [
        "The lab's board is an MCP server. Its name in the text below is `verifold`.",
        'Transport: streamable HTTP',
        'URL: http://127.0.0.1:8123/mcp',
        'Header: Authorization: Bearer the-token',
        lines[7],
    ]
    assert 'whoever has it posts as you' in lines[7]
    assert 'After a restart, `brief` shows what the board got while you were not connected.' in lines[7]
    assert lines[9] == 'Your folder: /lab/a3'
    assert lines[11] == (
        'Verifold commits the whole folder when a post names files, and an agent that takes a rerun of such a post '
        'gets a copy of that commit. So a token or MCP settings in this folder reach those commits and each such '
        'agent.'
    )
    assert lines[13].startswith('`brief` gives the board as it is now.')
    assert lines[-3:] == ['Does it hold?', '', 'You are Agent 3.']
    assert text.count('the-token') == 1
    assert 'role' not in text.lower()


def test_the_message_for_an_agent_that_comes_back_holds_facts_and_names_the_tool_that_gives_the_board() -> None:
    folder = Path('/lab/.verifold/agents/agent-1')

    kept = back_message(RESTARTED, 'Start.', folder, kept=True, cut_off=True, jobs_stopped=True)
    new = back_message(RESTARTED, 'Start.', folder, kept=False)

    # A harness can load a conversation that holds nothing, so the facts of the start come with every message.
    assert kept.splitlines() == [
        'Verifold restarted. You worked in this lab before the restart.',
        'Your harness reported that it loaded your conversation from before.',
        'The record has no end for your last turn, so Verifold may have stopped while it ran.',
        'Verifold stopped any program that you had left running in the background.',
        'Your folder is /lab/.verifold/agents/agent-1.',
        (
            '`brief` on the lab board gives the board as it is now, with your own role, status, and plan in '
            '`your_line`, and the posts that you have not seen.'
        ),
        '',
        'The rest of this text is what every agent of the lab gets when it starts.',
        '',
        'Start.',
    ]
    assert (
        new.splitlines()[1] == 'Your harness did not load your conversation from before, so this conversation is new.'
    )
    assert 'no end for your last turn' not in new
    assert 'any program' not in new
    assert new.splitlines()[-1] == 'Start.'


def test_an_agent_that_starts_after_a_revision_gets_the_current_question() -> None:
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE).join('ada')
    record.post(Result(id='p-1', thread='t-1', author='ada', text='It holds.', evidence=(EVIDENCE,)))
    board = record.revise('Does it hold on ARM?', 'p-2').board()

    lines = start_message(board, board.agents[0].agent, Path('LAB.md')).splitlines()

    assert lines[0] == 'Does it hold on ARM?'
    assert lines[4:6] == [
        'Thread t-1 on the board holds this question.',
        (
            'The question was revised, last at 2026-11-06 12:05 UTC. The text above is the current one, and '
            '`brief` lists the posts that hold the revisions.'
        ),
    ]
