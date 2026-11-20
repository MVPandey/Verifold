from collections.abc import AsyncIterator
from decimal import Decimal
from pathlib import Path

import pytest
from conftest import agent
from mcp import Client

from verifold.protocol.ids import PERSON
from verifold.protocol.join import MeasureRequest, PostRequest
from verifold.protocol.posts import Dashboard, FileEvidence, HeadlineNumber, Measure
from verifold.server.conversation import conversation_view
from verifold.server.errors import EvidenceRejected
from verifold.server.join import join_server
from verifold.server.lab import Lab
from verifold.server.measures import dashboard_meta, headline_view, measure_labels
from verifold.server.member import Member
from verifold.society.errors import RejectedEvent
from verifold.society.measures import headline_label
from verifold.society.steering import moves
from verifold.store.record_file import RecordFile

PAGE = b'<!doctype html><title>Account</title><b>382.24</b>'


async def pin(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
    return tuple(FileEvidence(path=path.removeprefix('./'), commit='a' * 40) for path in paths)


def seat(lab: Lab, agent_id: str, data: bytes = PAGE, read: list[FileEvidence] | None = None) -> Member:
    async def pages(page: FileEvidence) -> bytes:
        if read is not None:
            read.append(page)
        return data

    return Member(lab, agent_id, pin=pin, pages=pages)


@pytest.fixture
async def asked(tmp_path: Path) -> AsyncIterator[Lab]:
    """A lab whose question's thread is t-1, with `ada` and `bo`, and thread t-2 that ada opened with post p-2."""
    with RecordFile(tmp_path / 'asked.jsonl') as record_file:
        yield await _asked(record_file)


async def _asked(record_file: RecordFile) -> Lab:
    lab = Lab.create(record_file, 'Does it hold?')
    await lab.open_question_thread()
    for name in ('ada', 'bo'):
        await lab.join(agent(name))
    await lab.post(PostRequest(kind='result', text='Beats random.', new_thread='Does it beat random?'), 'ada')
    return lab


def request(**fields: object) -> MeasureRequest:
    given = {'label': 'Account value', 'value': '382.24', 'unit': 'USD', 'script': './value.py', 'output': 'value.out'}
    return MeasureRequest.model_validate(given | fields)


async def test_a_measure_goes_in_the_questions_thread_or_its_own_and_holds_for_the_time_of_its_post(
    asked: Lab, lab: Lab
) -> None:
    posted = await seat(asked, 'ada').measure(request())
    other = await seat(asked, 'bo').measure(request(thread='t-2', value='-0.5', unit='', label='Drawdown'))

    measured = posted.post
    assert isinstance(measured, Measure)
    assert (measured.thread, measured.text, measured.script, measured.as_of) == (
        't-1',
        'Account value: 382.24 USD',
        'value.py',
        posted.at,
    )
    assert (other.post.thread, other.post.text) == ('t-2', 'Drawdown: -0.5')
    assert measure_labels(asked.board) == ('Account value', 'Drawdown')
    with pytest.raises(EvidenceRejected, match='name one file'):
        await seat(asked, 'ada').measure(request(script='value.out'))
    # A lab from before the question had a thread takes a measure in the thread that it names.
    with pytest.raises(RejectedEvent, match='names its thread in `thread`'):
        await seat(lab, 'ada').measure(request())


async def test_the_desk_reports_no_measure_and_offers_no_dashboard_before_its_folder_gets_a_commit(lab: Lab) -> None:
    await lab.join(agent('dee'), desk=True)
    pinned: list[tuple[str, ...]] = []

    async def pins(paths: tuple[str, ...]) -> tuple[FileEvidence, ...]:
        pinned.append(paths)
        return await pin(paths)

    desk = Member(lab, 'dee', pin=pins)
    with pytest.raises(RejectedEvent, match='no measure from it'):
        await desk.measure(request(thread='t-1'))
    with pytest.raises(RejectedEvent, match='no dashboard from it'):
        await desk.dashboard('board.html', 'The account.')
    assert pinned == []


async def test_each_version_of_the_dashboard_is_a_post_in_one_thread_and_the_newest_stands(lab: Lab) -> None:
    read: list[FileEvidence] = []
    first = await seat(lab, 'ada', read=read).dashboard('./board.html', 'The account today.')
    second = await seat(lab, 'bo', data=PAGE * 2).dashboard('mine.html', 'With the orders.', builds_on=('p-1',))

    page = first.post
    assert isinstance(page, Dashboard)
    assert [item.path for item in read] == ['board.html']
    opened = lab.board.thread('t-2')
    assert opened is not None
    assert (page.thread, page.size, opened.thread.title) == ('t-2', len(PAGE), 'Dashboard')
    assert (second.post.thread, second.post.builds_on) == ('t-2', ('p-1',))
    meta = dashboard_meta(lab.board)
    assert meta is not None
    assert (meta.post, meta.by, meta.path, meta.size, meta.versions) == (
        second.post.id,
        'bo',
        'mine.html',
        2 * len(PAGE),
        2,
    )
    with pytest.raises(EvidenceRejected, match='cannot pin files'):
        await Member(lab, 'ada', pin=pin).dashboard('board.html', 'No reader.')


async def test_a_page_that_loads_from_a_server_or_is_no_text_is_refused_with_what_it_needs(lab: Lab) -> None:
    outside = seat(lab, 'ada', data=b'<link rel="stylesheet" href="https://fonts.example/a.css">')
    with pytest.raises(EvidenceRejected, match=r'loads https://fonts.example/a.css with `href` of `<link>`'):
        await outside.dashboard('board.html', 'The account.')
    with pytest.raises(EvidenceRejected, match='no UTF-8 text'):
        await seat(lab, 'ada', data=b'\xff\xfe').dashboard('board.html', 'The account.')

    assert dashboard_meta(lab.board) is None


async def test_the_coordinator_names_the_headline_number_with_its_tool_as_a_move_and_the_person_overrules_it(
    asked: Lab,
) -> None:
    lab = asked
    await seat(lab, 'ada').measure(request(value='382.24'))
    await lab.set_coordinator('bo', PERSON)

    async with Client(join_server(lambda _: Member(lab, 'ada'))) as client:
        refused = await client.call_tool('headline_number', {'label': 'Account value', 'why': 'It is the goal.'})
    async with Client(join_server(lambda _: Member(lab, 'bo'))) as client:
        named = await client.call_tool(
            'headline_number', {'label': 'Account value', 'why': 'The person asked for the account.'}
        )
        again = await client.call_tool('headline_number', {'label': 'account value', 'why': 'Still the goal.'})

    assert refused.is_error
    assert "Only the person and the lab's coordinator" in str(refused.content)
    assert named.structured_content is not None
    assert again.structured_content is not None
    assert (named.structured_content['label'], again.structured_content.get('post')) == ('Account value', None)
    view = headline_view(lab.board)
    assert view is not None
    assert view.measure is not None
    assert (view.named_by, view.why, view.measure.value) == (
        'bo',
        'The person asked for the account.',
        Decimal('382.24'),
    )
    logged = moves(lab.board)[0]
    assert (logged.kind, logged.by, logged.why) == ('headline_number', 'bo', 'The person asked for the account.')
    assert conversation_view(lab.board).moves[0].kind == 'headline_number'

    await lab.name_headline_number('Cash', PERSON)
    with pytest.raises(RejectedEvent, match='only the person changes it'):
        await Member(lab, 'bo').name_headline_number('Account value', 'Back to the account.')

    assert headline_label(lab.board) == 'Cash'
    told = lab.board.posts[-1].post
    assert isinstance(told, HeadlineNumber)
    assert (told.thread, told.text, told.why) == ('t-1', 'The person named "Cash" as the lab\'s headline number.', None)
    # The person's naming is no move of the coordinator.
    assert moves(lab.board)[0].entry.post.id == named.structured_content['post']
    await lab.name_headline_number('', PERSON)
    assert (headline_view(lab.board), lab.board.posts[-1].post.text) == (
        None,
        "The person took back the lab's headline number.",
    )
