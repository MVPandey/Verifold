"""
The lab's dashboard: one page of HTML that an agent makes, so that the person sees where the lab stands.

Each version is a post of its own, so another agent can check it or object to it. The first version opens the
dashboard's thread, and every later version goes there. The newest version that its author did not concede stands.
The page holds its styles inline and loads nothing from another server: the board refuses a page that names another
server where the page would load something, and the person's app shows the page in a frame whose policy allows no
request at all and runs none of the page's scripts.
"""

import re
from datetime import datetime
from html.parser import HTMLParser

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, ThreadId
from verifold.protocol.join import DashboardLine
from verifold.protocol.posts import Dashboard
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.standing import standing

DASHBOARD_TITLE = 'Dashboard'
"""The title of the thread that the first version of the dashboard opens."""


def dashboard_thread(board: Board) -> ThreadId | None:
    """Return the thread of the dashboard's versions, or `None` until the first version opens it."""
    return next((entry.post.thread for entry in board.posts if isinstance(entry.post, Dashboard)), None)


def standing_dashboard(board: Board) -> Posted | None:
    """Return the newest version of the dashboard that its author did not concede, or `None`."""
    return next(
        (
            entry
            for entry in reversed(board.posts)
            if isinstance(entry.post, Dashboard) and standing(board, entry.post.id) != 'conceded'
        ),
        None,
    )


def dashboard_line(board: Board, now: datetime) -> DashboardLine | None:
    """Return the version of the dashboard that stands, with its age at `now`, or `None` while none does."""
    entry = standing_dashboard(board)
    if entry is None:
        return None
    return DashboardLine(
        post=entry.post.id,
        thread=entry.post.thread,
        by=entry.post.author,
        minutes_ago=max(int((now - entry.at).total_seconds() // 60), 0),
        standing=standing(board, entry.post.id),
    )


def check_dashboard_post(board: Board, event: Posted) -> None:
    """
    Check a version of the dashboard: an agent of the lab posts it, and every version is in the dashboard's thread.

    Any other post passes.

    Raises:
        RejectedEvent: The person posts it, or it is in another thread than the dashboard's.

    """
    post = event.post
    if not isinstance(post, Dashboard):
        return
    if post.author == PERSON:
        raise RejectedEvent("The dashboard is the agents' page, from a file of an agent's folder.")
    thread = dashboard_thread(board)
    if thread is not None and post.thread != thread:
        raise RejectedEvent(f'Every version of the dashboard goes in its thread, {thread}.')
    if thread is None and (board.is_side(post.thread) or board.holds_offers(post.thread)):
        raise RejectedEvent('The dashboard is for the whole lab, so its thread is a thread for the whole lab.')


_LOADS = frozenset({'src', 'srcset', 'data', 'poster', 'background', 'action', 'formaction', 'manifest', 'ping'})
"""The attributes with which an element loads or sends something, whatever the element."""

_LINKED = frozenset({'link', 'base', 'script', 'image', 'use', 'feimage'})
"""The elements whose `href` loads something, such as a style sheet, a font, or an image."""

_LOCAL = re.compile(r'^(?:#|(?:data|blob|about|javascript):)', re.IGNORECASE)
"""An address that loads nothing from a server: a place in the page, or data that the address holds."""

_IN_STYLE = re.compile(r"""(?:url\(\s*['"]?|@import\s+['"])([^'")\s]*)""", re.IGNORECASE)
"""An address that a style loads, with `url()` or `@import`."""


class _Scan(HTMLParser):
    # The first address that the page loads from a server, as `(where, address)`.
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found: tuple[str, str] | None = None
        self._in_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._in_style = self._in_style or tag == 'style'
        given = {name: value or '' for name, value in attrs}
        for name, value in given.items():
            if name in _LOADS or (name in {'href', 'xlink:href'} and tag in _LINKED):
                self._note(f'`{name}` of `<{tag}>`', _addresses(name, value))
            elif name == 'style':
                self._note(f'`style` of `<{tag}>`', _IN_STYLE.findall(value))
        if tag == 'meta' and given.get('http-equiv', '').lower() == 'refresh':
            self._note('the refresh of `<meta>`', [given.get('content', '').partition('=')[2]])

    def handle_endtag(self, tag: str) -> None:
        self._in_style = self._in_style and tag != 'style'

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self._note('`<style>`', _IN_STYLE.findall(data))

    def _note(self, where: str, addresses: list[str]) -> None:
        address = next((item.strip() for item in addresses if item.strip() and not _LOCAL.match(item.strip())), None)
        if address and self.found is None:
            self.found = (where, address)


def _addresses(name: str, value: str) -> list[str]:
    # A `srcset` lists addresses with their sizes, and `ping` lists addresses with spaces between them.
    if name == 'srcset':
        return [part.split()[0] for part in value.split(',') if part.split()]
    return value.split() if name == 'ping' else [value]


def outside_reference(html: str) -> tuple[str, str] | None:
    """
    Return where a page loads something from a server, and the address, or `None` when it loads nothing.

    It reads the attributes with which an element loads or sends something, the `href` of the elements that load
    with it, a refresh in a `meta`, and the addresses in the page's styles. A place in the page and an address of
    `data:` or `blob:` load nothing. A plain link to another page is no load. The app's frame runs no script of the
    page, so no script asks for anything.
    """
    scan = _Scan()
    scan.feed(html)
    scan.close()
    return scan.found
