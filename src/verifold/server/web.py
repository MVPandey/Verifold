"""
Serves the person's app: the built pages, or a page that says how to build them, and the frame of the dashboard.

Every response carries a strict Content-Security-Policy. The app loads only its own scripts, styles, fonts, and
images, so text that agents write can never make the browser fetch a remote image or call another server.

The dashboard is a page that the agents make, and the app shows it in a frame that is sealed from the app. The frame
loads `FRAME_PAGE` from this server, which holds nothing of the lab, and the app posts the agents' page into it as a
message. No address of the frame holds the page or the person's token. The frame's own policy makes it a sandbox
with an origin of its own, so it reads no storage of the app and calls no API of the app, and it allows no request
to any server, no form, no window, and no move of the page that holds the frame. Its one script is Verifold's own: it
puts the agents' page into a frame of its own whose sandbox allows nothing, so no script of the agents' page runs,
in the page or in a frame that the page makes. The app's policy lets a frame load only pages of this server, so the
frame cannot go to another server either.
"""

import base64
import hashlib
from importlib.resources import files
from pathlib import Path

from starlette.responses import HTMLResponse
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

WEB_FOLDER = Path(str(files('verifold') / 'web'))
"""Where `make app` puts the built app."""

POLICY = (
    "default-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'"
)
"""
The app's Content-Security-Policy: everything from this server, and nothing from anywhere else.

`frame-src` holds for each page that a frame of the app loads, also when a page in the frame moves the frame on.
"""

FRAME_PATH = '/frame'
"""Where the frame of the dashboard loads its page."""

FRAME_SCRIPT = """
addEventListener('message', function show(event) {
  if (event.source !== parent || typeof event.data !== 'string') return;
  removeEventListener('message', show);
  var page = document.createElement('iframe');
  page.setAttribute('sandbox', '');
  page.setAttribute('referrerpolicy', 'no-referrer');
  page.setAttribute('title', 'The agents dashboard');
  page.srcdoc = event.data;
  document.body.appendChild(page);
});
"""
"""
The one script that runs in the frame of the dashboard, Verifold's own. It takes the agents' page once, as the text
of a message from the app, and shows it in a frame whose sandbox allows nothing: no script, no form, no window, and
no move of another page. A frame that the agents' page makes has the same sandbox.
"""

FRAME_POLICY = (
    'sandbox allow-scripts; '
    "default-src 'none'; "
    f"script-src 'sha256-{base64.b64encode(hashlib.sha256(FRAME_SCRIPT.encode()).digest()).decode()}'; "
    "style-src 'unsafe-inline'; "
    'img-src data:; '
    'font-src data:; '
    'media-src data:; '
    "form-action 'none'; "
    "base-uri 'none'; "
    "frame-ancestors 'self'"
)
"""
The policy of the frame of the dashboard, which the agents' page inside it keeps too.

`sandbox allow-scripts` gives the frame an origin of its own, with no forms, no windows, no move of the page that
holds it, and no storage of the app, and it runs a script that `script-src` names by its hash: only `FRAME_SCRIPT`.
`default-src 'none'` and the fetch directives after it allow no request to any server: a style, an image, a font, or
a medium comes from the page itself or from a `data:` address, and no page of any server loads in a frame of it.
Only a page of this server holds the frame.
"""

FRAME_PAGE = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard</title>
<style>html, body {{ margin: 0; height: 100%; }} iframe {{ display: block; border: 0; width: 100%; height: 100%; }}</style>
</head>
<body>
<script>{FRAME_SCRIPT}</script>
</body>
</html>
"""
"""The page of the frame of the dashboard. It and its policy stay the same for every lab."""

FRAME_HEADERS = (
    (b'content-security-policy', FRAME_POLICY.encode()),
    (b'x-content-type-options', b'nosniff'),
    (b'referrer-policy', b'no-referrer'),
    (b'cache-control', b'no-store'),
)

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
    """
    Return the app's pages from `folder`, or a page that says how to build them while `folder` has no app.

    The check runs on each request, so a build that finishes while the server runs shows on the next reload.
    """
    pages = StaticFiles(directory=folder, html=True, check_dir=False)

    async def serve(scope: Scope, receive: Receive, send: Send) -> None:
        built = (folder / 'index.html').is_file()
        await (pages if built else HTMLResponse(NOT_BUILT, status_code=503))(scope, receive, send)

    secured = _SecureHeaders(serve)

    async def route(scope: Scope, receive: Receive, send: Send) -> None:
        # The frame's page carries its own policy and no policy of the app, which would refuse its scripts.
        if scope['type'] == 'http' and scope['path'] == FRAME_PATH:
            await _frame(scope, receive, send)
        else:
            await secured(scope, receive, send)

    return route


async def _frame(scope: Scope, receive: Receive, send: Send) -> None:
    response = HTMLResponse(FRAME_PAGE)
    response.raw_headers.extend(FRAME_HEADERS)
    await response(scope, receive, send)


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
