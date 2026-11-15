"""
The rule for every text that Verifold itself sends to an agent.

Such a text is protocol documentation or a fact about the board. A sentence that tells an agent what to do with its
work, in what order, or how to behave is a norm, and norms live in the lab's `LAB.md` and `WRITING.md`, which the
person reads and edits. These tests collect the texts that reach an agent and fail on a sentence that opens like an
order.
"""

import re
from datetime import timedelta
from pathlib import Path

import pytest
from builders import START, RecordBuilder
from mcp import Client

from verifold.app import NORMS_CHANGED, NORMS_TEMPLATE
from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.events import AlarmSet
from verifold.protocol.posts import Close, FileEvidence, Result
from verifold.protocol.settings import AtTimeLimit
from verifold.protocol.threads import QUESTION_TITLE
from verifold.runner.messages import (
    CLOSED,
    DEPARTURE,
    DOORBELL,
    HARNESS_FAILED,
    IN_TURN,
    JOBS_ENDED,
    OUT_OF_TIME,
    RESTARTED,
    STARTED_AGAIN,
    alarm_message,
    back_message,
    cut_short_message,
    invitation,
    more_time_message,
    rerun_message,
    start_message,
)
from verifold.server.join import INSTRUCTIONS, join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.lifecycle import no_alarm_line

OPENER = re.compile(
    r"Add|Agree|Always|Answer|Ask|Avoid|Back|Be|Build|Call|Change|Check|Choose|Consider|Do|Don't|End|Ensure|First"
    r'|Follow|Get|Give|Go|Have|Join|Keep|Last|Leave|Let|List|Look|Make|Name|Never|Next|Note|Object|Open|Please'
    r'|Post|Prefer|Propose|Put|Read|Remember|Reply|Report|Reproduce|Rerun|Return|Run|Say|Search|Send|Set|Sleep'
    r'|Start|Stop|Take|Tell|Then|Trust|Try|Use|Wait|Wake|Watch|Withdraw|Write',
    re.IGNORECASE,
)
"""
The words that open an order, or that rank work: a verb in its base form, or "First", "Then", "Next", "Last".

A fact about a tool opens with the tool's name in backticks or with a verb in the third person, such as "Returns",
so none of these words opens a fact. The list has no exceptions: when a fact needs one of these words first, the
sentence gets another shape.
"""

INSIDE = re.compile(
    r"\b(?:you should|you must|you need to|you have to|make sure|be sure|remember to|please|do not|don't)\b"
    r'|\b(?:so|then) (?:ask|call|check|give|go|keep|open|post|put|read|run|try|use|wait)\b'
    r'|, (?:and |or |then )?(?:ask|call|give|go|keep|post|put|read|run|try|use|wait)\b'
    r'|\b(?:reply to it with|name them in)\b',
    re.IGNORECASE,
)
"""
An order inside a sentence: after "so" or "then", such as "so post your results before then", or after a comma,
such as "when your harness refuses a command, run it plain". A word in backticks is a tool's name and never matches.
The two phrases at the end are orders that the board once gave after a clause, which no general pattern finds
without also finding facts such as "the posts that name you, reply to you, or are in a thread that you watch".
"""

CLAIM = Result(
    id='p-4',
    thread='t-2',
    author='ada',
    text='The sort is 11.8x faster.',
    evidence=(FileEvidence(path='bench.py', commit='c' * 40),),
)
CHECKER = Agent(id='checker-7', name='Checker 7', harness='fake', model=ModelSpec(family='openai'), checks='p-4')
FOLDER = Path('/lab/.verifold/agents/agent-1')
NORMS = Path('/lab/.verifold/LAB.md')


def orders(text: str) -> list[str]:
    """Return the sentences of a text that open like an order, or that hold one."""
    # A blank line or a list item starts a sentence. Any other line break only wraps one.
    flat = re.sub(r'\n\s*(?:\n|- )', '. ', text).replace('\n', ' ')
    sentences = (part.strip(' -"\'(') for part in re.split(r'(?<=[.:!?])\s+', flat))
    return [
        sentence
        for sentence in sentences
        if sentence and (OPENER.fullmatch(sentence.split(maxsplit=1)[0].rstrip(',:.')) or INSIDE.search(sentence))
    ]


def messages() -> dict[str, str]:
    """Return every message that Verifold sends to an agent, with every clause that a message can have."""
    record = RecordBuilder().thread('t-1', opened_by='person', title=QUESTION_TITLE).join('ada').join('bo')
    record.post(Close(id='p-1', thread='t-1', author='ada', text='It holds.'))
    board = record.time_set(START + timedelta(hours=2)).revise('Is it stable?', 'p-2').board()
    ada = board.agents[0].agent
    start = start_message(board, ada, NORMS, Path('/lab/.verifold/WRITING.md'), under_way=True)
    alarm = AlarmSet(seq=9, at=START, agent='ada', minutes=20, quiet=True, stays=True)
    closing = RecordBuilder().join('ada').join('bo').thread('t-1', opened_by='ada')
    closing.post(Close(id='p-1', thread='t-1', author='ada', text='It holds.'))
    return {
        'doorbell': DOORBELL,
        'departure': DEPARTURE,
        'jobs ended': JOBS_ENDED,
        'alarm': alarm_message(alarm),
        'timed alarm': alarm_message(alarm.model_copy(update={'quiet': False})),
        **{f'late alarm {late}': alarm_message(alarm, late) for late in (IN_TURN, OUT_OF_TIME, CLOSED)},
        'cut short': cut_short_message('The harness stopped: max_tokens.'),
        'start': start,
        'start alone': start_message(RecordBuilder().join('ada').board(), ada, NORMS),
        **{
            f'back {why}': back_message(why, start, FOLDER, kept=kept, cut_off=True, jobs_stopped=True)
            for why, kept in ((RESTARTED, True), (STARTED_AGAIN, False), (HARNESS_FAILED, False))
        },
        'invitation': invitation(start, 'http://127.0.0.1:8123/mcp', 'the-token', FOLDER),
        **{f'more time {jobs}': more_time_message(START, jobs) for jobs in AtTimeLimit},
        'rerun': rerun_message(CLAIM, CHECKER, FOLDER, NORMS),
        **{f'norms changed {name}': text.format(path=NORMS) for name, text in NORMS_CHANGED.items()},
        'no alarm': no_alarm_line(board, 'ada', START),
        'no alarm, a close stands': no_alarm_line(closing.board(), 'bo'),
        'no alarm, no time': no_alarm_line(
            closing.time_set(closing.at(len(closing.events) + 1)).ran_out().board(), 'bo'
        ),
    }


def _descriptions(schema: object) -> list[str]:
    # Every `description` in a JSON schema: a tool's result carries the docstring of each of its models.
    if isinstance(schema, dict):
        own = [schema['description']] if isinstance(schema.get('description'), str) else []
        return own + [text for value in schema.values() for text in _descriptions(value)]
    if isinstance(schema, list):
        return [text for value in schema for text in _descriptions(value)]
    return []


def test_the_check_finds_the_orders_that_the_board_once_gave() -> None:
    # Sentences that Verifold sent to agents before this rule, which the check must find.
    for order in (
        'You are one agent in a Verifold lab. Call `brief` first.',
        'Back a result with `files` from your folder.',
        'First come the calls that nobody has taken. Then the results that no other agent has built on.',
        'At that time Verifold stops the turn of every agent that it started, so post your results before then.',
        'Its posts carry your name, so ask it to give its own name in `helper`.',
        'Reproduce the result yourself, and do not trust the claim.',
        'Then post one `check` in thread t-2 that replies to p-4.',
        'Keep the token and your MCP settings outside this folder.',
        'When your harness refuses a command that needs a permission, run it plain, on its own.',
        'If it is still refused, the person has an ask for the grant, so go on with other work.',
        'To take a call, reply to it with a `plan`.',
        'When your post builds on other posts, in any thread, name them in `builds_on`.',
        'After `timeout_seconds` with nothing for you, it returns without `posts`: call wait again to keep waiting.',
        '- `call`: work that needs an agent. To take a call, reply to it with a `plan`, and then post your result.',
    ):
        assert orders(order), order
    # A fact about a tool, a limit, or the board's state passes.
    for fact in (
        '`brief` gives the board as it is now.',
        'Returns the lab in one read: your own line, the other agents, and the threads.',
        'A `plan` that replies to a call takes it.',
        'Verifold never acts on them.',
        'You can read a side thread that you are not a member of.',
        'A finding that other agents can object to or check.',
        'The other agents can still reply to them, build on them, and check them.',
        'No alarm is set for you. After your turn ends, your next turn starts only when a post for you arrives.',
    ):
        assert not orders(fact), fact


def test_the_instructions_of_the_board_hold_no_order() -> None:
    assert orders(INSTRUCTIONS) == []


async def test_no_tool_of_the_board_describes_itself_or_its_result_with_an_order(lab: Lab) -> None:
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        tools = (await client.list_tools()).tools

    assert len(tools) == 10
    for tool in tools:
        assert tool.description, tool.name
        assert orders(tool.description) == [], tool.name
        for text in (*_descriptions(tool.input_schema), *_descriptions(tool.output_schema)):
            assert orders(text) == [], (tool.name, text)


@pytest.mark.parametrize(('name', 'text'), messages().items())
def test_no_message_from_verifold_to_an_agent_holds_an_order(name: str, text: str) -> None:
    assert text, name
    # The question is the person's own text, and the claim is an agent's. Verifold wrote every other line.
    own = text.replace('Is it stable?', '').replace(CLAIM.text, '')
    assert orders(own) == [], name


def test_the_norms_file_is_where_the_orders_are() -> None:
    # The check is not blind: the person's norms are orders, and it finds them there.
    assert len(orders(NORMS_TEMPLATE)) > 20
