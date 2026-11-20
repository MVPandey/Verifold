from datetime import timedelta

import pytest
from builders import START, RecordBuilder
from pydantic import ValidationError

from verifold.protocol.measures import MAX_PAGE_BYTES
from verifold.protocol.posts import Answer, Dashboard, FileEvidence, Objection, RuledOut
from verifold.protocol.settings import Settings, TaskSettings
from verifold.society.attention import wakes
from verifold.society.dashboards import (
    DASHBOARD_TITLE,
    check_page_held,
    dashboard_line,
    dashboard_thread,
    outside_reference,
    page_holder,
    standing_dashboard,
)
from verifold.society.errors import RejectedEvent
from verifold.society.obstacles import obstacles

PAGE = (FileEvidence(path='dashboard.html', commit='c' * 40),)


def version(post_id: str, author: str = 'ada', thread: str = 't-2', **fields: object) -> Dashboard:
    return Dashboard.model_validate(
        {'id': post_id, 'thread': thread, 'author': author, 'text': 'The account today.', 'evidence': PAGE, 'size': 900}
        | fields
    )


@pytest.fixture
def dashboards(record: RecordBuilder) -> RecordBuilder:
    """The lab of `builders.lab`, with thread t-2 that ada opened with the first version of the dashboard, p-1."""
    return record.thread('t-2', opened_by='ada', title=DASHBOARD_TITLE).post(version('p-1'))


def test_every_version_of_the_dashboard_goes_in_the_thread_of_the_first_and_the_newest_stands(
    dashboards: RecordBuilder,
) -> None:
    with pytest.raises(RejectedEvent, match='goes in its thread, t-2'):
        dashboards.copy().post(version('p-2', thread='t-1')).board()
    with pytest.raises(RejectedEvent, match="the agents' page"):
        dashboards.copy().post(version('p-2', author='person')).board()

    board = dashboards.post(version('p-2', author='bo', size=MAX_PAGE_BYTES)).board()

    assert dashboard_thread(board) == 't-2'
    standing = standing_dashboard(board)
    assert standing is not None
    assert standing.post.id == 'p-2'
    line = dashboard_line(board, board.posts[-1].at)
    assert line is not None
    assert (line.post, line.by, line.thread, line.minutes_ago) == ('p-2', 'bo', 't-2', 0)
    with pytest.raises(ValidationError):
        version('p-3', size=MAX_PAGE_BYTES + 1)
    with pytest.raises(ValidationError):
        version('p-3', evidence=(*PAGE, *PAGE))


def test_the_page_is_its_holders_for_the_lease_of_a_task_and_a_new_version_of_its_own_starts_the_lease_again(
    dashboards: RecordBuilder,
) -> None:
    # Ada's version p-1 came at 12:06, and a task's lease is 30 minutes by default.
    board = dashboards.board()
    early = START + timedelta(minutes=7)

    with pytest.raises(RejectedEvent) as refused:
        check_page_held(board, 'bo', early)
    assert str(refused.value).startswith(
        'ada holds the dashboard since 2026-11-06 12:06 UTC, until 2026-11-06 12:36 UTC. The board takes no version '
        'from another agent while that lease stands.'
    )
    check_page_held(board, 'ada', early)
    line = dashboard_line(board, early)
    assert line is not None
    assert line.held_until == START + timedelta(minutes=36)
    # A lapsed lease frees the page, and nobody holds it then.
    late = START + timedelta(minutes=36)
    check_page_held(board, 'bo', late)
    later = dashboard_line(board, late)
    assert later is not None
    assert later.held_until is None

    renewed = dashboards.post(version('p-2')).board()
    holder = page_holder(renewed, late)
    assert holder is not None
    assert (holder.agent, holder.lease.until) == ('ada', START + timedelta(minutes=37))
    with pytest.raises(RejectedEvent, match='until 2026-11-06 12:37 UTC'):
        check_page_held(renewed, 'bo', late)


def test_the_holder_gives_the_page_up_with_a_ruled_out_lead_on_its_own_version_and_the_next_author_holds_it(
    dashboards: RecordBuilder,
) -> None:
    dashboards.settings(Settings(tasks=TaskSettings(lease_minutes=5)))
    # A ruled-out lead of another agent on the version gives nothing up.
    dashboards.post(RuledOut(id='p-2', thread='t-2', author='cy', text='Not this one.', reply_to='p-1'))
    with pytest.raises(RejectedEvent, match='ada holds the dashboard'):
        check_page_held(dashboards.board(), 'bo', START + timedelta(minutes=9))
    given_up = dashboards.post(RuledOut(id='p-3', thread='t-2', author='ada', text='Bo has it.', reply_to='p-1'))
    board = given_up.board()

    assert page_holder(board, START + timedelta(minutes=10)) is None
    check_page_held(board, 'bo', START + timedelta(minutes=10))
    # Giving the page up closes no lead, so it is no obstacle of the dashboard's thread.
    assert [found.entry.post.id for found in obstacles(board)] == ['p-2']
    taken = given_up.post(version('p-4', author='bo')).board()
    holder = page_holder(taken, START + timedelta(minutes=11))
    assert holder is not None
    assert (holder.agent, holder.lease.until) == ('bo', START + timedelta(minutes=10 + 5))
    with pytest.raises(RejectedEvent, match='bo holds the dashboard'):
        check_page_held(taken, 'ada', START + timedelta(minutes=11))


def test_a_version_whose_author_conceded_an_objection_stands_no_longer(dashboards: RecordBuilder) -> None:
    dashboards.post(version('p-2', author='bo'))
    dashboards.post(Objection(id='p-3', thread='t-2', author='cy', text='The cash is a day old.', reply_to='p-2'))
    disputed = dashboard_line(dashboards.board(), dashboards.at(1))
    assert disputed is not None
    assert (disputed.post, disputed.standing) == ('p-2', 'disputed')

    board = dashboards.post(
        Answer(id='p-4', thread='t-2', author='bo', text='Yes.', reply_to='p-3', accepts=True)
    ).board()

    standing = standing_dashboard(board)
    assert standing is not None
    assert standing.post.id == 'p-1'


def test_the_first_version_reaches_no_agent_by_itself_and_a_later_one_reaches_the_agents_that_watch_the_thread(
    dashboards: RecordBuilder,
) -> None:
    board = dashboards.board()
    assert [wakes(board, agent, board.posts[-1]) for agent in ('bo', 'cy')] == [False, False]

    board = dashboards.post(version('p-2', author='bo')).board()

    assert [wakes(board, agent, board.posts[-1]) for agent in ('ada', 'cy')] == [True, False]


def test_the_first_version_opens_a_thread_for_the_whole_lab(record: RecordBuilder) -> None:
    record.thread('t-2', opened_by='ada', between=('ada', 'bo'))

    with pytest.raises(RejectedEvent, match='thread for the whole lab'):
        record.post(version('p-1')).board()


@pytest.mark.parametrize(
    ('page', 'found'),
    [
        (
            '<script src="https://cdn.example/chart.js"></script>',
            ('`src` of `<script>`', 'https://cdn.example/chart.js'),
        ),
        ('<link rel="stylesheet" href="//fonts.example/a.css">', ('`href` of `<link>`', '//fonts.example/a.css')),
        ('<img srcset="small.png 1x, big.png 2x">', ('`srcset` of `<img>`', 'small.png')),
        (
            '<style>body { background: url("https://x.example/a.png") }</style>',
            ('`<style>`', 'https://x.example/a.png'),
        ),
        ('<style>@import "theme.css";</style>', ('`<style>`', 'theme.css')),
        ('<div style="background:url(http://x.example/b.png)">', ('`style` of `<div>`', 'http://x.example/b.png')),
        (
            '<meta http-equiv="refresh" content="5; url=https://x.example">',
            ('the refresh of `<meta>`', 'https://x.example'),
        ),
        ('<svg><image href="https://x.example/c.png"/></svg>', ('`href` of `<image>`', 'https://x.example/c.png')),
        ('<form action="https://x.example/send"></form>', ('`action` of `<form>`', 'https://x.example/send')),
        ('<a href="#top" ping="https://x.example/p">Top</a>', ('`ping` of `<a>`', 'https://x.example/p')),
        ('<iframe src="page.html"></iframe>', ('`src` of `<iframe>`', 'page.html')),
    ],
)
def test_a_page_that_loads_something_from_a_server_names_where_and_what(page: str, found: tuple[str, str]) -> None:
    assert outside_reference(page) == found


def test_a_page_that_holds_what_it_shows_loads_nothing() -> None:
    page = """<!doctype html><html><head><meta charset="utf-8"><style>
        .g { fill: url(#grad); background: url(data:image/png;base64,AAAA) }</style></head>
        <body><img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>" alt="">
        <svg><use href="#icon"/><use xlink:href="#icon"/></svg>
        <a href="https://exchange.example/market">The market</a> <img src="">
        <script>const data = [1, 2, 3]; fetch('https://x.example')</script></body></html>"""

    # A link is no load, and a script asks the frame's policy, which the scan does not run.
    assert outside_reference(page) is None
