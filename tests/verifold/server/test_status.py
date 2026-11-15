from conftest import agent

from verifold.protocol.agents import Picture
from verifold.protocol.app import NEEDS, AgentActivity, Need
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import PermissionShown, QuestionShown
from verifold.server.lab import Lab
from verifold.server.status import (
    APPROVAL_COMMAND,
    APPROVAL_OTHER,
    HARNESS_QUESTION,
    agent_need,
    in_turn,
    outcomes,
    profile_edits,
    thread_needs,
    waits,
)

IDLE = AgentActivity(state='idle')
WORKING = AgentActivity(state='working')


def ask(text: str, thread: str | None = 't-1', **fields: object) -> PostRequest:
    return PostRequest.model_validate({'kind': 'ask', 'text': text, 'mentions': ('person',), 'thread': thread} | fields)


async def test_what_waits_for_the_person_is_the_approvals_then_the_answers_in_verifolds_own_words(lab: Lab) -> None:
    await lab.post(ask('May we read the archive?'), 'bo')
    command = PermissionShown(command='rm -rf /tmp/x')
    await lab.post(
        ask('Permission needed: rm -rf', None, new_thread='Permission requests from Ada'), 'ada', mark=command
    )
    await lab.post(ask('Permission needed: fetch', 't-2'), 'ada', mark=PermissionShown(title='Fetch a page'))
    await lab.post(
        ask('The harness asks', None, new_thread='Questions from Bo'), 'bo', mark=QuestionShown(message='Which?')
    )
    await lab.post(PostRequest(kind='ask', text='Who knows the tail?', thread='t-1'), 'bo')

    found = waits(lab.board)

    # No text of a harness stands in a wait: a tracked ask has Verifold's words, and an agent's own ask its headline.
    assert [(wait.kind, wait.agent, wait.what, wait.post, wait.thread) for wait in found] == [
        ('approval', 'ada', APPROVAL_COMMAND, 'p-3', 't-2'),
        ('approval', 'ada', APPROVAL_OTHER, 'p-4', 't-2'),
        ('answer', 'bo', 'May we read the archive?', 'p-2', 't-1'),
        ('answer', 'bo', HARNESS_QUESTION, 'p-5', 't-3'),
    ]
    asked = lab.board.post('p-3')
    assert asked is not None
    assert found[0].since == asked.at
    # The person's answer ends the wait, and an agent that left waits for nothing.
    await lab.post(PostRequest(kind='answer', text='Yes.', thread='t-1', reply_to='p-2'), 'person')
    await lab.leave('ada', 'person')
    assert [wait.post for wait in waits(lab.board)] == ['p-5']


async def test_an_agent_has_the_first_status_that_applies_in_the_order_of_who_needs_the_person(lab: Lab) -> None:
    for name in ('cy', 'dee', 'eve', 'fay', 'gus'):  # hal joins and leaves below
        await lab.join(agent(name))
    await lab.post(
        ask('Permission needed: ls', None, new_thread='Permission requests'), 'ada', mark=PermissionShown(command='ls')
    )
    await lab.post(ask('May we?'), 'bo')
    await lab.post(PostRequest(kind='ask', text='Dee, do you know?', thread='t-1', mentions=('dee',)), 'eve')
    await lab.post(PostRequest(kind='ask', text='Anybody?', thread='t-1'), 'fay')
    await lab.join(agent('hal'))
    await lab.leave('hal', 'hal')
    waiting = waits(lab.board)

    def need(name: str, state: str) -> str:
        return agent_need(lab.board, AgentActivity.model_validate({'state': state}), name, waiting)

    # A wait for the person comes before a turn that runs, and a turn before a wait for another agent.
    assert (need('ada', 'working'), need('ada', 'waiting'), need('bo', 'idle'), need('bo', 'stopped')) == (
        'approval',
        'approval',
        'answer',
        'answer',
    )
    # A harness that starts is about to run a turn, so it does not show as idle.
    assert [need('cy', state) for state in ('working', 'waiting', 'idle', 'starting', 'stopped', 'void')] == [
        'working',
        'working',
        'idle',
        'working',
        'stopped',
        'stopped',
    ]
    # An agent that waits for more time, or for a process that it left running, is in no turn.
    for waits_for, expected in (('person', 'working'), ('time', 'idle'), ('process', 'idle'), (None, 'working')):
        activity = AgentActivity(state='waiting', waits_for=waits_for)
        assert (agent_need(lab.board, activity, 'cy', waiting), in_turn(activity)) == (expected, expected == 'working')
    assert (
        need('eve', 'waiting'),
        agent_need(lab.board, AgentActivity(state='waiting', waits_for='time'), 'eve', waiting),
    ) == (
        'working',
        'waiting',
    )
    # A harness that starts counts as in a turn, so that the list, the cards, the count, and the band agree.
    assert [in_turn(AgentActivity.model_validate({'state': state})) for state in ('working', 'starting', 'idle')] == [
        True,
        True,
        False,
    ]
    # An ask that names an agent waits on that agent, an ask for every agent does not, and an open `wait` call does.
    assert (need('eve', 'idle'), need('eve', 'working'), need('eve', 'stopped')) == ('waiting', 'working', 'stopped')
    assert (need('fay', 'idle'), need('fay', 'listening'), need('fay', 'here'), need('fay', 'invited')) == (
        'idle',
        'waiting',
        'idle',
        'idle',
    )
    assert (need('hal', 'working'), need('hal', 'idle')) == ('left', 'left')
    # The wait ends when the named agent replies to the ask or builds on it, whatever the kind of its post.
    await lab.post(PostRequest(kind='answer', text='No.', thread='t-1', reply_to='p-4'), 'dee')
    assert need('eve', 'idle') == 'idle'
    for fields in ({'kind': 'answer'}, {'kind': 'message'}, {'kind': 'result', 'builds': True}):
        await lab.post(PostRequest(kind='ask', text='Dee, and this?', thread='t-1', mentions=('dee',)), 'eve')
        asked = lab.board.posts[-1].post.id
        assert need('eve', 'idle') == 'waiting'
        link = {'builds_on': (asked,)} if fields.get('builds') else {'reply_to': asked}
        reply = PostRequest.model_validate({'kind': fields['kind'], 'text': 'It is 3.', 'thread': 't-1'} | link)
        await lab.post(reply, 'dee')
        assert need('eve', 'idle') == 'idle'
    # The asker's own answer to its ask ends the wait too.
    await lab.post(PostRequest(kind='ask', text='Again?', thread='t-1', mentions=('dee',)), 'eve')
    own = PostRequest(kind='answer', text='Never mind.', thread='t-1', reply_to=lab.board.posts[-1].post.id)
    await lab.post(own, 'eve')
    assert need('eve', 'idle') == 'idle'
    # Another agent's reply ends nothing, the asker's own answer does, and so does the leaving of every named agent.
    await lab.post(PostRequest(kind='ask', text='Cy or dee?', thread='t-1', mentions=('cy', 'dee')), 'fay')
    await lab.post(
        PostRequest(kind='message', text='Not me.', thread='t-1', reply_to=lab.board.posts[-1].post.id), 'bo'
    )
    assert need('fay', 'idle') == 'waiting'
    # An answer from anybody ends the wait, as it ends the ask.
    await lab.post(PostRequest(kind='ask', text='Dee?', thread='t-1', mentions=('dee',)), 'gus')
    assert need('gus', 'idle') == 'waiting'
    await lab.post(
        PostRequest(kind='answer', text='It is 3.', thread='t-1', reply_to=lab.board.posts[-1].post.id), 'bo'
    )
    assert need('gus', 'idle') == 'idle'
    await lab.leave('cy', 'person')
    assert need('fay', 'idle') == 'waiting'
    await lab.leave('dee', 'dee')
    assert need('fay', 'idle') == 'idle'
    assert NEEDS == ('approval', 'answer', 'working', 'waiting', 'idle', 'stopped', 'left')


async def test_a_thread_has_the_first_status_of_its_asks_to_the_person_and_of_its_team(lab: Lab) -> None:
    await lab.join(agent('cy'))
    await lab.post(PostRequest(kind='plan', text='I take the tail.', new_thread='The tail'), 'bo')
    await lab.post(PostRequest(kind='plan', text='With bo.', thread='t-2'), 'cy')
    await lab.post(PostRequest(kind='message', text='A note.', new_thread='Notes', between=('bo',)), 'cy')
    await lab.post(
        ask('Permission needed: ls', None, new_thread='Permission requests'), 'cy', mark=PermissionShown(command='ls')
    )
    waiting = waits(lab.board)

    def needs(**states: str) -> dict[str, Need]:
        each = {
            name: agent_need(lab.board, AgentActivity.model_validate({'state': state}), name, waiting)
            for name, state in states.items()
        }
        return thread_needs(lab.board, each, waiting)

    # Ada works in t-1, and bo and cy in t-2. Cy's request makes its thread, and the thread of its work, need the person.
    assert needs(ada='working', bo='idle', cy='idle') == {
        't-1': 'working',
        't-2': 'approval',
        't-3': 'idle',
        't-4': 'approval',
    }
    await lab.post(PostRequest(kind='answer', text='Allow', thread='t-4', reply_to='p-5'), 'person')
    waiting = waits(lab.board)
    assert needs(ada='idle', bo='stopped', cy='working') == {
        't-1': 'idle',
        't-2': 'working',
        't-3': 'idle',
        't-4': 'idle',
    }
    assert needs(ada='stopped', bo='stopped', cy='listening')['t-2'] == 'waiting'
    # A thread whose whole team stopped or left says so, and a thread without a team is idle.
    await lab.leave('cy', 'person')
    assert needs(ada='stopped', bo='stopped', cy='idle') == {
        't-1': 'stopped',
        't-2': 'stopped',
        't-3': 'idle',
        't-4': 'idle',
    }


async def test_what_became_of_an_agents_posts_is_lists_of_posts_and_no_score(lab: Lab) -> None:
    await lab.join(agent('cy'))
    await lab.set_reviewer('bo', 'bo', reviewer=True)
    await lab.post(PostRequest(kind='result', text='Second.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='result', text='Third.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='result', text='On top.', thread='t-1', builds_on=('p-1',)), 'bo')
    await lab.post(
        PostRequest(kind='check', text='Holds.', thread='t-1', reply_to='p-1', outcome='holds', method='code_read'),
        'bo',
    )
    await lab.post(PostRequest(kind='objection', text='A leak.', thread='t-1', reply_to='p-2'), 'cy')
    await lab.post(PostRequest(kind='ruled_out', text='The tail is a dead end.', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='ask', text='Who knows?', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='ask', text='And this?', thread='t-1'), 'ada')
    await lab.post(PostRequest(kind='answer', text='I do.', thread='t-1', reply_to='p-9'), 'bo')
    # A report names a post and builds nothing on it, and the author's own later result does not count either.
    await lab.post(PostRequest(kind='report', text='Where we are.', thread='t-1', builds_on=('p-3',)), 'bo')
    await lab.post(PostRequest(kind='result', text='Fourth.', thread='t-1', builds_on=('p-3',)), 'ada')

    found = outcomes(lab.board, 'ada')

    assert [
        [(ref.id, ref.thread) for ref in refs] for refs in (found.built_on, found.held, found.refuted, found.open_asks)
    ] == [
        [('p-1', 't-1')],
        [('p-1', 't-1')],
        [('p-2', 't-1'), ('p-7', 't-1')],
        [('p-8', 't-1')],
    ]
    assert outcomes(lab.board, 'cy') == outcomes(lab.board, 'nobody')


async def test_the_changes_that_others_made_to_a_profile_keep_the_text_from_before(lab: Lab) -> None:
    await lab.join(agent('cy').model_copy(update={'given_role': 'driver'}))
    await lab.set_coordinator('ada', 'person')
    await lab.set_profile(
        'cy', name='Tessel', about='I am the best.', picture=Picture(shape='hex', color='#f08c3a', symbol='orbit')
    )
    await lab.change_profile('cy', 'ada', about='Runs numbers twice.', flag='It ranks itself.')
    await lab.set_profile('cy', about='I run a number twice.')
    await lab.change_profile('cy', 'person', reset_name=True, reset_picture=True, given_role='scout')

    edits = profile_edits(lab.board, 'cy')

    assert [(edit.by, edit.part, edit.before, edit.after) for edit in edits] == [
        ('ada', 'about', 'I am the best.', 'Runs numbers twice.'),
        ('ada', 'flag', '', 'It ranks itself.'),
        ('person', 'name', 'Tessel', ''),
        ('person', 'picture', 'hex, #f08c3a, orbit', ''),
        ('person', 'role', 'driver', 'scout'),
    ]
    assert edits[0].at == lab.board.profiles[1].at
    assert profile_edits(lab.board, 'bo') == ()
