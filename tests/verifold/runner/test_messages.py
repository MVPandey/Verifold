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
from verifold.society.board import Board

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


def test_the_lab_norms_are_plain_text_for_one_read_and_the_doorbell_is_one_line() -> None:
    assert NORMS_TEMPLATE.startswith("# The lab's norms")
    # A norm uses the person's words for a thing. The board's own instructions name the tools.
    assert '`' not in NORMS_TEMPLATE
    # Each norm has its reason and what it looks like in practice, so the file is longer than a list of rules.
    # An agent still reads it whole at the start of its work.
    assert len(NORMS_TEMPLATE) < 19_000
    assert DOORBELL == 'New posts for you on the lab board.'


def test_the_lab_norms_are_sections_that_each_say_what_the_person_wants_and_why() -> None:
    sections = [line.removeprefix('## ') for line in NORMS_TEMPLATE.splitlines() if line.startswith('## ')]

    assert sections == [
        'The question is a goal',
        'A group with many directions open',
        'Explore first',
        'What stands in the way becomes the way',
        'Chain ideas',
        'Rounds',
        'Strategy and the seats',
        'Votes and badges',
        'Evidence',
        'Helpers',
        'The answer and the person',
    ]
    for how_to_read in (
        'Each section says what the person wants, why, and what that looks like in practice.',
        'An example shows a norm and does not limit it.',
        'When a situation fits no norm, act on the reasons.',
        'When a norm gets in the way of the goal, tell the coordinator, or say so in an ask that names the person.',
    ):
        assert how_to_read in NORMS_TEMPLATE


def test_the_lab_norms_ask_agents_to_plan_together_keep_threads_apart_and_propose_candidates() -> None:
    for norm in (
        "post your plan in the question's thread and read the other agents' plans",
        'Wait a moment for the plans that are not there yet',
        'The direct path to the goal needs an owner too',
        'Give each line of work its own thread',
        'Post each result when you have it',
        # A visible shared draft locks a group of agents in, and selection among candidates beat one draft.
        (
            "The lab's answer comes from candidates. When your line has a result that you can defend, propose it as a "
            'candidate answer: what the answer is, and what it rests on. Any agent can propose one, and several '
            "candidates stand side by side. An agent has one candidate at a time. A candidate is its author's own: "
            'nobody edits it, and its author replaces it with a newer one when the evidence changes. Object to a '
            'candidate when you see a problem in it. A lab with one candidate that nobody questions has usually '
            'stopped looking.'
        ),
        # A post never changes, so the lab's answer is the candidate that the close names, with its files.
        (
            'Before the lab closes, the agents choose among the candidates that stand: by what was rerun and held up, '
            'and by which objections stand. The close names the candidate that it closes on. That candidate, with its '
            "files, is the lab's answer, so its author brings it up to date before the close. When no candidate "
            'reaches the goal, the work goes on from the best one.'
        ),
        "Keep the question's thread for the first plans and the candidate answers",
    ):
        assert norm in NORMS_TEMPLATE
    for gone in (
        'The newest proposal is the answer that the person sees',
        'A proposal is a draft',
        'so it holds the whole answer and not only your part',
        'writes the final answer file from it',
    ):
        assert gone not in NORMS_TEMPLATE


def test_the_lab_norms_hold_the_goal_the_obstacle_the_seats_and_the_name() -> None:
    for norm in (
        'When the question asks for something to be done or made, the person wants it done.',
        'When the question asks whether something is true, the goal is the answer with evidence that holds, and a no is an answer.',
        'Keep working toward the goal while the lab has time.',
        'A result that says "this does not work" is a finding on the way.',
        'When the lab agrees that nothing works while most of its time is left, it has usually looked in too few places.',
        'Take that agreement as a signal to widen the search',
        # The board takes no close without a candidate while one stands, also a close that says nothing is left.
        (
            'An agent that thinks so posts a close, and each other agent agrees or objects. While candidates stand, '
            'the close names the one that the lab got furthest with.'
        ),
        'A line that closed is no reason to end a turn',
        'set an alarm, because a post for you may never come',
        'An agent that the board cannot wake has no alarm, and it waits inside its turn.',
        'name the obstacle exactly and ask what would remove it',
        'Remove the defender, and the capture works.',
        # Two threads of a real lab grew to 266 and 153 posts, and the person could not tell which lines were alive.
        # The board lists each obstacle that no plan or result builds on, and the norm says when to use the list.
        (
            'An idea that fails for one clear reason is one step from working, and that step is to remove the reason.'
            '\n\nThe board keeps the obstacles.'
        ),
        'When a line closes, post what blocked it as ruled out, with the reason in a sentence.',
        'The board lists the obstacles that nobody has taken up.',
        (
            'Read that list before you choose work, and build on an obstacle when you have a way to remove it: a plan '
            'that builds on it takes it up, and a result that builds on it and stands removes it.'
        ),
        'Two things that fail alone can work together.',
        "Do not assume a human's limits.",
        'Revisit what you ruled out as too slow or too much work',
        'Before you rule a method out, search what is published on it',
        "Exploring and testing ideas is everyone's main work.",
        'Checking the work of others is a side activity for a few agents.',
        'A lead gets a champion and a forward test before it gets an audit.',
        'When the lab has reviewer seats, a check that the lab relies on comes from an agent in one.',
        'Take a seat only when checking is the work you want, and give it back when you would rather build.',
        'Ask for one of your own result when a candidate rests on it.',
        'An agent in a reviewer seat can ask for one of any result.',
        "When the lab has a coordinator, it owns the lab's strategy",
        'The coordinator can ask one agent to take the strategy',
        'It wakes a quiet lab with a post for the whole lab.',
        'Each agent still chooses its own work, and says why when it chooses differently.',
        'When no agent holds the coordinator seat and it is open, an agent that wants this work can take it.',
        'An agent on call works only when it is asked.',
        'Choose a name, a picture, and an about line of one or two sentences that says the lens you bring',
        'It is a way to work, not a character to play.',
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


def test_the_lab_norms_say_what_a_chain_is_why_the_lab_wants_one_and_how_an_agent_finds_one() -> None:
    for norm in (
        'To chain is to join things that came up apart into something that none of them gives alone.',
        # A chain is not two results: the links are of any kind and any number.
        'The links can be ideas, approaches, methods, tools, sources, obstacles, and results.',
        'A chain can have any number of links, from any threads and any fields.',
        'The lab wants chains because each agent holds a part',
        "Read the board's overview and the threads near your line with that question",
        'Look for a result to build on, and for a problem that you can help with.',
        "In your post's builds-on field, name every post that the chain joins",
        "post it in that agent's thread, also when it comes from another field",
        'When you are stuck, post an ask that says what you tried.',
    ):
        assert norm in NORMS_TEMPLATE
    assert 'join two results' not in NORMS_TEMPLATE


def test_the_lab_norms_say_when_a_helper_suits_the_work_and_how_its_posts_are_named() -> None:
    for norm in (
        'Your harness can start helpers, such as subagents.',
        'a literature search, a side experiment, a sweep of variants, a tool that you need, or a second look',
        "Have it give its own name in the post's helper field",
        'or post what it finds yourself',
        'You answer for what your helper posts.',
    ):
        assert norm in NORMS_TEMPLATE


def test_the_lab_norms_hold_what_came_out_of_python_and_the_norm_on_reruns() -> None:
    for norm in (
        "post your results before the lab's time ends",
        'When you check a result with a rerun, reproduce it yourself from its files, and do not trust the claim.',
        'Post the check with the files of your own run.',
        'One good run out of several is noise, and agreement between agents is not evidence.',
        'Never invent a result or a source.',
        'offer the files for each one before the lab ends, and say in the offer what is still missing',
        'Ask the person only about money, scope, access, or time, and about a norm in this file that blocks the goal.',
    ):
        assert norm in NORMS_TEMPLATE


def test_the_lab_norms_say_how_the_person_follows_the_lab_how_a_post_reads_and_how_many_reruns_are_enough() -> None:
    for norm in (
        # A real lab's coordinator answered the person after 41 seconds at the median, and once after 12 minutes.
        "brings the person's steer to the board. When the person writes to it, it answers in a sentence or two before other work, and follows up when it has more.",
        # An agent has one alarm, and in a busy lab an alarm for a quiet board never rings, so no report came of it.
        'It keeps an alarm of about half an hour, so that it notices when the lab stopped with time left and when its report is old.',
        # The person asked five times where the lab stood, and no agent posted a report.
        'the work goes on from the best one.\n\nThe person follows the lab through its report.',
        'A report says in plain words where the lab stands: which lines are alive, which closed and why, what looks promising, and what the lab needs from the person.',
        'The coordinator posts one when the picture changes, and about every half hour while the lab works.',
        'In a lab with no coordinator, an agent that sees that the report is old posts one.',
        'The person should not have to ask where the lab stands.',
        'Write plainly, for the person and the other agents. The headline of a post holds the claim, in a sentence or two. The body holds how you know it.',
        'The person reads the body as formatted text, so use short paragraphs, lists, and tables there.',
        # Two to four agents took 8 of 37 wanted reruns at the same time. A lab with one model family has no held up
        # result, so it gets its own stopping point.
        'A result that stands as held up needs no other rerun. In a lab with one model family, one independent rerun is enough. Before you take a wanted rerun, look at who took it already. When you check a result with a rerun',
    ):
        assert norm in NORMS_TEMPLATE
    for gone in (
        'the claim first, then how you know it',
        'One independent rerun of a result is enough.',
        'It keeps an alarm for a quiet board',
        'answers in a line',
    ):
        assert gone not in NORMS_TEMPLATE


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


def test_the_start_message_counts_the_deliverables_that_stand_and_names_none_without_them() -> None:
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE)
    record.deliverable('d-1', 'A one-page answer.').join('ada')
    one = record.board()
    two = record.deliverable('d-2', 'A script.', 'p-1').deliverable('d-3', 'A list.', 'p-2').board()
    removed = record.deliverable('d-3', 'A list.', 'p-3', removed=True).board()
    ada = one.agents[0].agent

    def line(board: Board) -> list[str]:
        return [text for text in start_message(board, ada, Path('LAB.md')).splitlines() if 'deliverable' in text]

    assert line(one) == [
        (
            'The person stated 1 deliverable: what the person wants to hold at the end of the lab. `brief` lists '
            'each one with the files offered for it.'
        )
    ]
    assert line(two)[0].startswith('The person stated 3 deliverables: ')
    assert line(removed)[0].startswith('The person stated 2 deliverables: ')
    assert line(RecordBuilder().join('ada').board()) == []


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
