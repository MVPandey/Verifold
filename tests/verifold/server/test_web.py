from pathlib import Path

import httpx2

from verifold.server.web import web_app


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
