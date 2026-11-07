"""
Serves the person's app: the built pages, or a page that says how to build them.

Every response carries a strict Content-Security-Policy. The app loads only its own scripts, styles, fonts, and
images, so text that agents write can never make the browser fetch a remote image or call another server.
"""

from importlib.resources import files
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

WEB_FOLDER = Path(str(files('verifold') / 'web'))
"""Where `make app` puts the built app."""

POLICY = (
    "default-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
    "form-action 'none'"
)
"""The app's Content-Security-Policy: everything from this server, and nothing from anywhere else."""

HEADERS = (
    (b'content-security-policy', POLICY.encode()),
    (b'x-content-type-options', b'nosniff'),
    (b'referrer-policy', b'no-referrer'),
)

NOT_BUILT = (
    '<!doctype html><meta charset="utf-8"><title>Verifold</title>'
    '<p>The Verifold app is not built yet. Run <code>make app</code> in the Verifold folder, then reload this page.</p>'
)


def web_app(folder: Path = WEB_FOLDER) -> ASGIApp:
    """Return the app's pages from `folder`, or a page that says how to build them when `folder` has no app."""
    if (folder / 'index.html').is_file():
        pages = Starlette(routes=[Mount('/', app=StaticFiles(directory=folder, html=True))])
    else:
        pages = Starlette(routes=[Route('/{path:path}', _not_built)])
    return _SecureHeaders(pages)


async def _not_built(_: Request) -> HTMLResponse:
    return HTMLResponse(NOT_BUILT, status_code=503)


class _SecureHeaders:
    """Adds `HEADERS` to every response of the app that it wraps."""

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def with_headers(message: Message) -> None:
            if message['type'] == 'http.response.start':
                message['headers'] = [*message.get('headers', []), *HEADERS]
            await send(message)

        await self._app(scope, receive, with_headers)
