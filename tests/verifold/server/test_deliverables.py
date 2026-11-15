from datetime import timedelta

import pytest
from builders import START
from conftest import agent
from mcp import Client
from pydantic import ValidationError

from verifold.protocol.agents import Agent, ModelSpec
from verifold.protocol.join import PostRequest
from verifold.protocol.posts import MAX_OFFER_FILES, FileEvidence, FileOffer
from verifold.protocol.threads import MAX_TITLE
from verifold.server.errors import EvidenceRejected, OutOfTime
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.member import Member
from verifold.society.attention import wakes
from verifold.society.deliverables import deliverable_lines
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import lab_state
from verifold.store.record_file import RecordFile

ANSWER = 'A one-page answer that I can read in five minutes.'
SCRIPT = 'A script that runs the best strategy again on paper.'


async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
    return tuple(FileEvidence(path=path, commit='a' * 40) for path in paths)


class Clock:
    """The lab's clock, which a test moves."""

    def __init__(self) -> None:
        self.now = START

    def pass_seconds(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def asked(record_file: RecordFile, clock: Clock) -> Lab:
    """A lab with the question's thread, the deliverable d-1 from the setup, and the agents `ada` and `bo`."""
    lab = Lab.create(record_file, 'Does it hold?', clock=lambda: clock.now)
    await lab.open_question_thread()
    await lab.state_deliverables((ANSWER,))
    await lab.join(agent('ada'))
    await lab.join(agent('bo'))
    return lab


def states(lab: Lab) -> list[tuple[str, str]]:
    return [(line.id, line.state) for line in deliverable_lines(lab.board)]


async def test_the_deliverables_of_the_setup_are_in_the_record_before_the_agents(
    asked: Lab, record_file: RecordFile
) -> None:
    assert [event.type for event in record_file.read()][:5] == [
        'lab_opened',
        'thread_opened',
        'posted',
        'deliverable_set',
        'agent_joined',
    ]
    assert (asked.board.deliverables[0].text, asked.board.deliverables[0].post) == (ANSWER, None)
    # The setup states none: the record gets no event. With agents in the lab, a deliverable needs its post.
    seq = asked.board.seq
    await asked.state_deliverables(())
    assert asked.board.seq == seq
    with pytest.raises(RejectedEvent, match='comes with the post of the person'):
        await asked.state_deliverables((SCRIPT,))


async def test_a_new_deliverable_goes_in_the_questions_thread_as_the_persons_post_and_survives_a_reload(
    asked: Lab, record_file: RecordFile
) -> None:
    added = await asked.add_deliverable(SCRIPT)

    told = asked.board.posts[-1]
    assert (added.deliverable, added.text, added.post) == ('d-2', SCRIPT, told.post.id)
    assert (told.post.thread, told.post.author, told.post.kind) == ('t-1', 'person', 'message')
    assert told.post.text == f'The person stated a deliverable, d-2: {SCRIPT}'
    assert [event.type for event in record_file.read()][-2:] == ['posted', 'deliverable_set']
    assert wakes(asked.board, 'ada', told)
    assert wakes(asked.board, 'bo', told)
    assert Lab.load(record_file).board == asked.board


async def test_the_person_changes_and_removes_a_deliverable_and_the_record_keeps_every_sentence(
    asked: Lab, clock: Clock
) -> None:
    await asked.change_deliverable('d-1', 'A two-page answer.')
    changed = asked.board.posts[-1].post.text
    seq = asked.board.seq
    await asked.change_deliverable('d-1', 'A two-page answer.')
    same = asked.board.seq
    clock.pass_seconds(60)
    await asked.remove_deliverable('d-1')

    assert changed == 'The person changed the sentence of the deliverable d-1 to: A two-page answer.'
    assert same == seq
    assert asked.board.posts[-1].post.text == 'The person removed the deliverable d-1: A two-page answer.'
    assert [(entry.text, entry.removed) for entry in asked.board.deliverables] == [
        (ANSWER, False),
        ('A two-page answer.', False),
        ('A two-page answer.', True),
    ]
    assert states(asked) == []
    for call in (asked.change_deliverable('d-1', ANSWER), asked.remove_deliverable('d-1')):
        with pytest.raises(RejectedEvent, match='The person removed the deliverable d-1'):
            await call
    with pytest.raises(RejectedEvent, match='no deliverable d-7'):
        await asked.remove_deliverable('d-7')


async def test_new_sentences_and_removals_send_one_post_in_a_minute_for_the_whole_list(
    asked: Lab, clock: Clock, record_file: RecordFile
) -> None:
    await asked.add_deliverable(SCRIPT)
    posts = len(asked.board.posts)

    # A post about a new deliverable starts no window: the first new sentence has its post.
    await asked.change_deliverable('d-1', 'A two-page answer.')
    clock.pass_seconds(59)
    await asked.change_deliverable('d-2', 'A short script.')
    await asked.remove_deliverable('d-1')
    told = len(asked.board.posts)
    # A new deliverable has its post at any time.
    await asked.add_deliverable('A list of what was ruled out.')
    clock.pass_seconds(1)
    await asked.change_deliverable('d-2', 'A script.')

    assert (told, len(asked.board.posts)) == (posts + 1, posts + 3)
    assert [
        (entry.deliverable, entry.text, entry.removed, entry.post is not None) for entry in asked.board.deliverables[2:]
    ] == [
        ('d-1', 'A two-page answer.', False, True),
        ('d-2', 'A short script.', False, False),
        ('d-1', 'A two-page answer.', True, False),
        ('d-3', 'A list of what was ruled out.', False, True),
        ('d-2', 'A script.', False, True),
    ]
    # The agents read every change in the brief, also one without a post.
    assert [(line.id, line.text) for line in Member(asked, 'ada').brief('').deliverables] == [
        ('d-2', 'A script.'),
        ('d-3', 'A list of what was ruled out.'),
    ]
    assert Lab.load(record_file).board == asked.board


async def test_a_new_sentence_and_a_removal_send_no_post_and_open_no_lab_while_a_close_stands(asked: Lab) -> None:
    await asked.add_deliverable(SCRIPT)
    close = await asked.post(PostRequest(kind='close', text='Nothing is left.', thread='t-1'), 'ada')
    await asked.post(
        PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to=close.post.id, accepts=True), 'bo'
    )
    posts = len(asked.board.posts)

    await asked.change_deliverable('d-1', 'A two-page answer.')
    await asked.remove_deliverable('d-2')

    assert (lab_state(asked.board), len(asked.board.posts)) == ('closed', posts)
    assert [(entry.text, entry.removed, entry.post) for entry in asked.board.deliverables[-2:]] == [
        ('A two-page answer.', False, None),
        (SCRIPT, True, None),
    ]
    assert states(asked) == [('d-1', 'none')]
    # A new deliverable is new work: its post opens the lab again.
    await asked.add_deliverable('A list of what was ruled out.')
    assert lab_state(asked.board) == 'open'


async def test_a_lab_from_before_the_question_had_a_thread_gets_one_thread_for_its_deliverables(lab: Lab) -> None:
    await lab.add_deliverable(ANSWER)
    await lab.add_deliverable(SCRIPT)

    opened = lab.board.threads[-1].thread
    assert (len(lab.board.threads), opened.title, opened.opened_by) == (2, 'Deliverables', 'person')
    assert [entry.post.thread for entry in lab.board.posts[-2:]] == ['t-2', 't-2']
    assert states(lab) == [('d-1', 'none'), ('d-2', 'none')]


async def test_a_lab_that_is_out_of_time_takes_a_deliverable_and_a_decision(record_file: RecordFile) -> None:
    lab = Lab.create(record_file, 'Does it hold?', time_left=timedelta(0), clock=lambda: START)
    await lab.open_question_thread()
    await lab.state_deliverables((ANSWER,))
    await lab.join(agent('ada'))
    offered = await lab.offer('ada', 'd-1', await pin(('answer.md',)), 'The answer.')
    await lab.run_out_of_time()

    await lab.add_deliverable(SCRIPT)
    await lab.decide('d-1', 'accepted', offered.post.id)

    assert (lab.board.out_of_time, states(lab)) == (True, [('d-1', 'accepted'), ('d-2', 'none')])


async def test_the_first_offer_opens_the_thread_of_its_deliverable_and_later_offers_go_there(asked: Lab) -> None:
    first = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'The answer.', 'Page two is still missing.')
    second = await asked.offer('bo', 'd-1', await pin(('short.md', 'long.md')), 'Two lengths.')
    again = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'With page two.')

    opened = asked.board.thread(first.post.thread)
    assert opened is not None
    assert (opened.thread.title, opened.thread.opened_by, opened.thread.deliverable) == (
        f'Deliverable d-1: {ANSWER}',
        'ada',
        'd-1',
    )
    assert [entry.post.thread for entry in (first, second, again)] == ['t-2', 't-2', 't-2']
    assert isinstance(first.post, FileOffer)
    assert (first.post.kind, first.post.deliverable, first.post.body) == ('offer', 'd-1', 'Page two is still missing.')
    # No offer is for every agent. A later offer is for the agents that watch the thread, as its opener does.
    assert not wakes(asked.board, 'bo', first)
    assert wakes(asked.board, 'ada', second)
    # The title follows the person's new sentence.
    await asked.change_deliverable('d-1', 'A two-page answer.')
    assert asked.board.threads[-1].thread.title == 'Deliverable d-1: A two-page answer.'
    (line,) = deliverable_lines(asked.board)
    assert [(offer.by, offer.files, offer.note, offer.revised) for offer in line.offers] == [
        ('bo', ('short.md', 'long.md'), 'Two lengths.', 0),
        ('ada', ('answer.md',), 'With page two.', 1),
    ]


async def test_the_thread_of_a_long_deliverable_has_a_title_that_fits(asked: Lab) -> None:
    await asked.add_deliverable('A report. ' * 29)

    offered = await asked.offer('ada', 'd-2', await pin(('report.md',)), 'The report.')

    opened = asked.board.thread(offered.post.thread)
    assert opened is not None
    assert (len(opened.thread.title), opened.thread.title[-1]) == (MAX_TITLE, '…')


async def test_the_board_refuses_an_offer_without_a_deliverable_that_stands(asked: Lab) -> None:
    await asked.add_deliverable(SCRIPT)
    await asked.remove_deliverable('d-2')
    threads = len(asked.board.threads)

    with pytest.raises(RejectedEvent, match='no deliverable d-9'):
        await asked.offer('ada', 'd-9', await pin(('answer.md',)), 'The answer.')
    with pytest.raises(RejectedEvent, match='The person removed the deliverable d-2'):
        await asked.offer('ada', 'd-2', await pin(('run.py',)), 'The script.')
    with pytest.raises(ValidationError):
        await asked.offer('ada', 'd-1', (), 'No file.')
    with pytest.raises(RejectedEvent, match='An agent offers files'):
        await asked.offer('person', 'd-1', await pin(('answer.md',)), 'Mine.')

    assert len(asked.board.threads) == threads


async def test_the_persons_decision_is_a_reply_to_the_offer_that_its_author_hears(
    asked: Lab, record_file: RecordFile
) -> None:
    offered = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'The answer.')

    await asked.decide('d-1', 'changes_asked', offered.post.id, 'Shorter, and with the numbers.')
    asked_for = asked.board.posts[-1]
    waits = states(asked)
    await asked.decide('d-1', 'accepted', offered.post.id)
    accepted = asked.board.posts[-1]
    held = states(asked)
    await asked.decide('d-1', 'taken_back', offered.post.id)
    back = asked.board.posts[-1]

    assert (waits, held, states(asked)) == ([('d-1', 'changes_asked')], [('d-1', 'accepted')], [('d-1', 'offered')])
    assert [(told.post.author, told.post.reply_to, told.post.thread) for told in (asked_for, accepted, back)] == [
        ('person', offered.post.id, 't-2')
    ] * 3
    assert asked_for.post.text == 'Shorter, and with the numbers.'
    assert accepted.post.text == 'The person accepted these files for the deliverable d-1.'
    assert back.post.text == 'The person took back the acceptance of these files for the deliverable d-1.'
    assert [wakes(asked.board, 'ada', told) for told in (asked_for, accepted, back)] == [True, True, True]
    assert not wakes(asked.board, 'bo', asked_for)
    assert [event.type for event in record_file.read()][-2:] == ['posted', 'deliverable_decided']
    assert Lab.load(record_file).board == asked.board


async def test_a_decision_that_the_record_refuses_leaves_no_post(asked: Lab) -> None:
    offered = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'The answer.')
    posts = len(asked.board.posts)

    with pytest.raises(ValidationError):
        await asked.decide('d-1', 'changes_asked', offered.post.id, '  ')
    with pytest.raises(RejectedEvent, match='no acceptance to take back'):
        await asked.decide('d-1', 'taken_back', offered.post.id)
    with pytest.raises(RejectedEvent, match='Post p-9 is no offer of files'):
        await asked.decide('d-1', 'accepted', 'p-9')
    with pytest.raises(RejectedEvent, match='no offer of files'):
        await asked.decide('d-1', 'accepted', 'p-1')

    assert len(asked.board.posts) == posts


async def test_a_members_offer_pins_the_files_that_it_names(asked: Lab) -> None:
    pinned: list[tuple[str, ...]] = []

    async def pins(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        pinned.append(paths)
        return await pin(paths)

    ada = Member(asked, 'ada', pin=pins)

    offered = await ada.offer('d-1', ('answer.md', 'data/runs.csv'), 'The answer.')

    assert pinned == [('answer.md', 'data/runs.csv')]
    assert [(item.path, item.commit) for item in offered.post.evidence] == [
        ('answer.md', 'a' * 40),
        ('data/runs.csv', 'a' * 40),
    ]
    assert (offered.post.kind, offered.post.author, offered.standing) == ('offer', 'ada', 'open')
    # An offer that the board cannot take commits nothing in the agent's folder.
    with pytest.raises(RejectedEvent, match='no deliverable d-4'):
        await ada.offer('d-4', ('answer.md',), 'The answer.')
    assert len(pinned) == 1


async def test_a_member_without_a_pin_and_the_person_offer_nothing(asked: Lab) -> None:
    with pytest.raises(EvidenceRejected, match='cannot pin files'):
        await Member(asked, 'bo').offer('d-1', ('answer.md',), 'The answer.')
    with pytest.raises(RejectedEvent, match='An agent offers files'):
        await Member(asked, 'person', pin=pin).offer('d-1', ('answer.md',), 'The answer.')

    assert states(asked) == [('d-1', 'none')]


async def test_an_agent_that_left_and_an_invited_agent_in_a_lab_out_of_time_offer_nothing(
    record_file: RecordFile,
) -> None:
    lab = Lab.create(record_file, 'Does it hold?', time_left=timedelta(0), clock=lambda: START)
    await lab.open_question_thread()
    await lab.state_deliverables((ANSWER,))
    await lab.join(agent('ada'))
    await lab.join(Agent(id='guest', name='Guest', harness='guest', model=ModelSpec(family='unknown')))
    await lab.leave('ada', 'ada')

    with pytest.raises(RejectedEvent, match='ada left this lab'):
        await Member(lab, 'ada', pin=pin).offer('d-1', ('answer.md',), 'The answer.')
    with pytest.raises(OutOfTime, match='takes no post'):
        await Member(lab, 'guest', pin=pin).offer('d-1', ('answer.md',), 'The answer.')


async def test_an_agent_reads_the_deliverables_in_its_brief_and_offers_files_with_the_tool(asked: Lab) -> None:
    ada = Member(asked, 'ada', pin=pin)
    async with Client(join_server(lambda _: ada)) as client:
        before = await client.call_tool('brief', {})
        offered = await client.call_tool(
            'offer', {'deliverable': 'd-1', 'files': ['answer.md'], 'note': 'The answer.', 'body': 'No numbers yet.'}
        )
        after = await client.call_tool('brief', {})
        no_file = await client.call_tool('offer', {'deliverable': 'd-1', 'files': [], 'note': 'Nothing.'})
        many = [f'file-{number}.md' for number in range(MAX_OFFER_FILES + 1)]
        too_many = await client.call_tool('offer', {'deliverable': 'd-1', 'files': many, 'note': 'All of it.'})
        outside = await client.call_tool('offer', {'deliverable': 'd-1', 'files': ['../secret'], 'note': 'This.'})
        unknown = await client.call_tool('offer', {'deliverable': 'd-5', 'files': ['answer.md'], 'note': 'This.'})
        as_post = await client.call_tool('post', {'kind': 'offer', 'text': 'The answer.', 'thread': 't-1'})

    assert before.structured_content is not None
    assert before.structured_content['deliverables'] == [
        {'id': 'd-1', 'text': ANSWER, 'state': 'none', 'decided_at': None, 'thread': None, 'offers': []}
    ]
    assert offered.structured_content is not None
    post = offered.structured_content['post']
    assert (post['kind'], post['deliverable'], post['thread'], post['text']) == ('offer', 'd-1', 't-2', 'The answer.')
    assert post['evidence'] == [{'type': 'file', 'path': 'answer.md', 'commit': 'a' * 40}]
    assert after.structured_content is not None
    (line,) = after.structured_content['deliverables']
    assert (line['state'], line['thread']) == ('offered', 't-2')
    assert [(offer['post'], offer['by'], offer['files'], offer['revised']) for offer in line['offers']] == [
        (post['id'], 'ada', ['answer.md'], 0)
    ]
    assert [result.is_error for result in (no_file, too_many, outside, unknown, as_post)] == [True] * 5
    assert 'goes through the `offer` tool' in str(as_post.content)
    assert 'no deliverable d-5' in str(unknown.content)


async def test_the_acceptance_of_another_offer_takes_the_first_back_and_both_authors_hear_it(asked: Lab) -> None:
    first = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'The answer.')
    second = await asked.offer('bo', 'd-1', await pin(('short.md',)), 'A shorter one.')
    await asked.decide('d-1', 'accepted', first.post.id)

    await asked.decide('d-1', 'accepted', second.post.id)

    back, took = asked.board.posts[-2], asked.board.posts[-1]
    assert (back.post.reply_to, back.post.text) == (
        first.post.id,
        'The person took back the acceptance of these files for the deliverable d-1.',
    )
    assert (took.post.reply_to, wakes(asked.board, 'ada', back), wakes(asked.board, 'bo', took)) == (
        second.post.id,
        True,
        True,
    )
    assert [(entry.decision, entry.offer) for entry in asked.board.decisions] == [
        ('accepted', first.post.id),
        ('taken_back', first.post.id),
        ('accepted', second.post.id),
    ]
    (line,) = deliverable_lines(asked.board)
    assert (line.state, [(offer.by, offer.state) for offer in line.offers]) == (
        'accepted',
        [('ada', 'waiting'), ('bo', 'accepted')],
    )


async def test_a_decision_on_an_offer_that_its_author_replaced_names_the_newer_offer_and_records_nothing(
    asked: Lab,
) -> None:
    old = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'The answer.')
    new = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'With the numbers.')
    seq = asked.board.seq

    for decision in ('accepted', 'changes_asked'):
        with pytest.raises(RejectedEvent, match=f'the offer {new.post.id} replaces it'):
            await asked.decide('d-1', decision, old.post.id, 'Shorter.')

    assert asked.board.seq == seq


async def test_a_request_for_changes_opens_a_closed_lab_again_and_an_acceptance_does_not(asked: Lab) -> None:
    offered = await asked.offer('ada', 'd-1', await pin(('answer.md',)), 'The answer.')
    close = await asked.post(PostRequest(kind='close', text='Nothing is left.', thread='t-1'), 'ada')
    await asked.post(
        PostRequest(kind='answer', text='Agreed.', thread='t-1', reply_to=close.post.id, accepts=True), 'bo'
    )

    await asked.decide('d-1', 'accepted', offered.post.id)
    await asked.decide('d-1', 'taken_back', offered.post.id)
    still = lab_state(asked.board)
    await asked.decide('d-1', 'changes_asked', offered.post.id, 'Add the numbers.')

    assert (still, lab_state(asked.board)) == ('closed', 'open')


async def test_an_offer_takes_each_path_once_and_the_name_of_a_helper(asked: Lab) -> None:
    pinned: list[tuple[str, ...]] = []

    async def pins(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        pinned.append(paths)
        return await pin(paths)

    ada = Member(asked, 'ada', pin=pins)
    async with Client(join_server(lambda _: ada)) as client:
        offered = await client.call_tool(
            'offer',
            {
                'deliverable': 'd-1',
                'files': ['answer.md', 'data.csv', 'answer.md'],
                'note': 'The answer.',
                'helper': ' writer ',
            },
        )

    assert pinned == [('answer.md', 'data.csv')]
    assert offered.structured_content is not None
    post = offered.structured_content['post']
    assert ([file['path'] for file in post['evidence']], post['helper']) == (['answer.md', 'data.csv'], 'writer')
    assert deliverable_lines(asked.board)[0].offers[0].files == ('answer.md', 'data.csv')
