from pathlib import Path

import httpx2

from verifold.server.web import FRAME_PAGE, FRAME_POLICY, web_app


def client_of(folder: Path) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=web_app(folder)), base_url='http://lab')


async def test_the_built_app_is_served_with_a_strict_content_security_policy(tmp_path: Path) -> None:
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'index.html').write_text('<!doctype html><title>Verifold</title>')
    (tmp_path / 'assets' / 'app.js').write_text('console.log(1)')

    async with client_of(tmp_path) as client:
        page = await client.get('/')
        script = await client.get('/assets/app.js')

    assert (page.status_code, page.text) == (200, '<!doctype html><title>Verifold</title>')
    assert script.status_code == 200
    policy = page.headers['content-security-policy']
    assert "img-src 'self'" in policy
    assert "connect-src 'self'" in policy
    assert page.headers['x-content-type-options'] == 'nosniff'


async def test_without_a_build_every_page_says_how_to_build_the_app_until_the_build_is_there(tmp_path: Path) -> None:
    folder = tmp_path / 'web'
    async with client_of(folder) as client:
        before = await client.get('/thread/t-1')
        folder.mkdir()
        (folder / 'index.html').write_text('<!doctype html><title>Verifold</title>')
        after = await client.get('/')

    assert before.status_code == 503
    assert 'make app' in before.text
    assert "default-src 'self'" in before.headers['content-security-policy']
    assert after.status_code == 200


def directives(policy: str) -> dict[str, set[str]]:
    """Return a Content-Security-Policy as each directive with its values."""
    parts = (part.split() for part in policy.split(';') if part.strip())
    return {name: set(values) for name, *values in parts}


FETCHES = ('connect-src', 'img-src', 'font-src', 'media-src', 'style-src', 'script-src', 'frame-src', 'object-src')
"""The directives with which a page fetches something. The frame allows none of them from any server."""


async def test_the_frame_of_the_dashboard_is_a_sandbox_with_an_origin_of_its_own_and_no_request_to_any_server(
    tmp_path: Path,
) -> None:
    (tmp_path / 'index.html').write_text('<!doctype html><title>Verifold</title>')
    async with client_of(tmp_path) as client:
        frame = await client.get('/frame')
        again = await client.get('/frame?token=secret')

    assert frame.status_code == 200
    # One policy, the frame's own: the app's policy would refuse the agents' inline scripts.
    assert frame.headers.get_list('content-security-policy') == [FRAME_POLICY]
    policy = directives(frame.headers['content-security-policy'])
    # The sandbox lets scripts run, and nothing else: no origin of the app, so no storage and no token of it, no
    # form, no window, no move of the page that holds the frame, and no download.
    assert policy['sandbox'] == {'allow-scripts'}
    # No request to any server: every fetch falls back to none, or takes the page's own text or data in it.
    assert policy['default-src'] == {"'none'"}
    allowed = {"'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:'}
    for name in FETCHES:
        assert policy.get(name, {"'none'"}) <= allowed | {"'none'"}, name
    assert 'connect-src' not in policy
    assert policy['form-action'] == {"'none'"}
    assert policy['base-uri'] == {"'none'"}
    assert policy['frame-ancestors'] == {"'self'"}
    assert frame.headers['referrer-policy'] == 'no-referrer'
    # The page holds nothing of the lab and is the same for every request: the app posts the agents' page into it.
    assert frame.text == again.text == FRAME_PAGE
    assert 'token' not in FRAME_PAGE
    assert "addEventListener('message'" in FRAME_PAGE
    assert 'event.source !== parent' in FRAME_PAGE


async def test_a_frame_of_the_app_loads_only_pages_of_its_own_server(tmp_path: Path) -> None:
    (tmp_path / 'index.html').write_text('<!doctype html><title>Verifold</title>')
    async with client_of(tmp_path) as client:
        page = await client.get('/')

    policy = directives(page.headers['content-security-policy'])
    # A page in a frame of the app that moves the frame on goes only to a page of this server, and the app's own
    # pages refuse to be framed.
    assert policy['frame-src'] == {"'self'"}
    assert policy['frame-ancestors'] == {"'none'"}
    assert policy['connect-src'] == {"'self'"}
