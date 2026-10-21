import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { defuse, startPageServer } from '../src/legacy/pages.ts';

await test('every link and meta tag becomes inert, in any case, with any separator or prefix', () => {
  const page = [
    '<link rel="prerender" href="http://x/a">',
    '<LINK REL=preconnect HREF=http://x>',
    '<link\nrel=prerender href=http://x/b>',
    '<link/rel=prerender href=http://x/c>',
    '<meta http-equiv="x-dns-prefetch-control" content="on">',
    '<svg:link rel=prerender>',
    '<é:link rel=prerender>',
    '</link>',
    '<linkx> <a href="#">a</a> <p>é ✓</p>',
  ].join('');
  const out = defuse(Buffer.from(page)).toString('utf8');
  assert.doesNotMatch(out, /<\/?([^\s<>/:]+:)?(link|meta)[\s/>]/i);
  assert.match(out, /<x-link rel="prerender"/);
  assert.match(out, /<x-LINK REL=preconnect/);
  assert.match(out, /<svg:x-link/);
  assert.match(out, /<é:x-link/);
  assert.match(out, /<\/x-link>/);
  // Other tags and the UTF-8 text stay as they are.
  assert.match(out, /<linkx> <a href="#">a<\/a> <p>é ✓<\/p>$/);
});

await test('the page server serves only granted files of known types, with a sandbox and no scripts', async (t) => {
  const files: Record<string, string | Buffer> = {
    'results/report.html':
      '<!doctype html><link rel=prerender href=http://x><style>@import "style.css";</style><img src="../figures/a.png">',
    'results/style.css': 'body { color: #222 }',
    'figures/a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'results/run.js': 'fetch("http://x")',
    'results/wide.html': Buffer.from([0xff, 0xfe, 0x3c, 0x00]),
  };
  const asked: string[] = [];
  const stop = new AbortController();
  t.after(() => stop.abort());
  const desk = 'http://127.0.0.1:1';
  const pages = await startPageServer(
    desk,
    (task, version, path) => {
      asked.push(`${task} ${version} ${path}`);
      const file = task === 'task-1' && version === 2 ? files[path] : undefined;
      return Promise.resolve(file === undefined ? null : Buffer.from(file));
    },
    stop.signal,
  );
  const url = pages.grant('task-1', 2, 'results/report.html');
  assert.match(
    url,
    /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/results\/report\.html$/,
  );
  // One version keeps one key. Another version gets its own.
  assert.equal(
    pages.grant('task-1', 2, 'results/style.css'),
    url.replace('report.html', 'style.css'),
  );
  assert.notEqual(
    new URL(pages.grant('task-1', 1, 'a.html')).pathname.split('/')[1],
    new URL(url).pathname.split('/')[1],
  );

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const policy = page.headers.get('content-security-policy') ?? '';
  for (const rule of [
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${desk}`,
    'sandbox allow-popups allow-popups-to-escape-sandbox',
  ])
    assert.ok(policy.includes(rule), rule);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-dns-prefetch-control'), 'off');
  assert.match(await page.text(), /<x-link rel=prerender/);

  const base = url.slice(0, -'results/report.html'.length);
  const image = await fetch(`${base}figures/a.png`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal((await image.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(`${base}results/style.css`)).status, 200);
  // Scripts, unknown keys, missing files, and paths out of the folder are not found.
  for (const path of [
    'results/run.js',
    'results/missing.html',
    '%2e%2e/secret.html',
    'results/%2e%2e/%2e%2e/secret.html',
    'results//report.html',
  ])
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  assert.equal(
    (
      await fetch(
        `${new URL(url).origin}/${'0'.repeat(64)}/results/report.html`,
      )
    ).status,
    404,
  );
  // The browser would decode a UTF-16 page past the rewrite.
  assert.equal((await fetch(`${base}results/wide.html`)).status, 415);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  // Another Host name is refused, so DNS rebinding cannot reach the files.
  const status = await new Promise<number>((resolve, reject) => {
    const target = new URL(url);
    request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { Host: `evil.test:${target.port}` },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    )
      .on('error', reject)
      .end();
  });
  assert.equal(status, 403);
  assert.ok(!asked.some((entry) => entry.includes('..')));
  stop.abort();
  await assert.rejects(fetch(url));
});
