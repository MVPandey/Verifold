import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { startDesk, openDeskBrowser } from '../src/cli/desk.ts';
import { changeWorkspace } from '../src/cli/storage.ts';
import { readDeskSnapshot, readDeskReport } from '../src/cli/desk-records.ts';

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-desk-'));
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'Researcher',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  return root;
}

async function attempt(
  root: string,
  changes: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const directory = join(root, '.verifold', 'runs', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'attempt.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: id,
      host: 'claude',
      model: null,
      phase: 'needs-plan',
      requestedSessionId: null,
      nativeSessionId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'started',
      ...changes,
    }),
  );
  return id;
}

await test('desk reads preserve state and distinguish recent observations, stale starts, and outcomes', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readFile(join(root, '.verifold', 'workspace.json'));
  assert.deepEqual((await readDeskSnapshot(root)).attempts, []);
  const recent = await attempt(root, { observedAt: new Date().toISOString() });
  const stale = await attempt(root, { observedAt: '2020-01-01T00:00:00.000Z' });
  const old = await attempt(root);
  const success = await attempt(root, {
    status: 'succeeded',
    finishedAt: new Date().toISOString(),
    nativeSessionId: 'native-1',
  });
  const invalid = await attempt(root, { attemptId: 'another-id' });
  const snapshot = await readDeskSnapshot(root);
  const byId = new Map(snapshot.attempts.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(recent)?.activity, 'recent');
  assert.equal(byId.get(stale)?.activity, 'unknown');
  assert.equal(byId.get(old)?.activity, 'unknown');
  assert.equal(byId.get(invalid)?.record, null);
  assert.equal(byId.get(success)?.record?.nativeSessionId, 'native-1');
  assert.equal(byId.get(success)?.activity, 'finished');
  assert.deepEqual(
    await readFile(join(root, '.verifold', 'workspace.json')),
    before,
  );
});

await test('desk rejects redirected workspace, run directories, and report files', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  await mkdir(outside);
  const state = join(root, '.verifold', 'workspace.json');
  await writeFile(join(outside, 'workspace.json'), await readFile(state));
  await rm(state);
  await symlink(join(outside, 'workspace.json'), state);
  await assert.rejects(readDeskSnapshot(root));
  await rm(state);
  await writeFile(state, await readFile(join(outside, 'workspace.json')));
  await symlink(outside, join(root, '.verifold', 'runs'));
  await assert.rejects(readDeskSnapshot(root), /real directories/);
  await rm(join(root, '.verifold', 'runs'));
  const id = await attempt(root);
  await symlink(
    join(outside, 'workspace.json'),
    join(root, '.verifold', 'runs', id, 'report.json'),
  );
  await assert.rejects(readDeskReport(root, id));
  await assert.rejects(
    readDeskReport(root, '../../outside'),
    /Invalid attempt ID/,
  );
  await writeFile(
    join(root, '.verifold', 'runs', id, 'attempt.json'),
    'x'.repeat(4001),
  );
  assert.equal((await readDeskSnapshot(root)).attempts[0]?.record, null);
});

await test('desk history has an explicit scan limit', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(root, '.verifold', 'runs');
  await mkdir(runs);
  const ids = Array.from({ length: 201 }, () => randomUUID());
  for (const id of ids) await mkdir(join(runs, id));
  const snapshot = await readDeskSnapshot(root);
  assert.equal(snapshot.attempts.length, 200);
  assert.equal(snapshot.historyLimited, true);
  const latest = ids.find(
    (id) => !snapshot.attempts.some((entry) => entry.id === id),
  );
  assert.ok(latest);
  await changeWorkspace(root, (state) => ({
    ...state!,
    research: {
      topic: 'Graphs',
      autonomy: 'guided',
      phase: 'needs-plan',
      latestAttempt: latest,
    },
  }));
  const updated = await readDeskSnapshot(root);
  assert.equal(updated.attempts.length, 201);
  assert.ok(updated.attempts.some((entry) => entry.id === latest));
});

await test('desk restricts private reads, serves escaped records, and stops with its owner', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    context: '<script>alert("private")</script>',
  }));
  const assets = join(root, 'assets');
  await mkdir(join(assets, 'cli'), { recursive: true });
  await mkdir(join(assets, 'ui'));
  for (const name of [
    'desk.css',
    'desk-client.js',
    'manrope.ttf',
    'symbol.webp',
  ])
    await writeFile(join(assets, 'cli', name), 'fixture asset');
  await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
  const owner = new AbortController();
  const server = await startDesk(
    root,
    owner.signal,
    pathToFileURL(`${assets}/cli/`),
  );
  t.after(async () => {
    owner.abort();
    await server.closed;
  });
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const api = `${url.origin}/api/view`;
  const before = await readFile(join(root, '.verifold', 'workspace.json'));
  const shell = await fetch(url.origin);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.match(
    shell.headers.get('content-security-policy') ?? '',
    /frame-ancestors 'none'/,
  );
  assert.doesNotMatch(await shell.text(), /alert|Researcher/);
  assert.equal((await fetch(api)).status, 401);
  assert.equal(
    (await fetch(api, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  for (const extra of [
    { Origin: 'https://example.org' },
    { Host: 'example.org' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ])
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        request(api, { headers: { ...headers, ...extra } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
          .on('error', reject)
          .end();
      }),
      403,
    );
  assert.equal((await fetch(api, { method: 'POST', headers })).status, 405);
  for (const query of [
    '?attempt=../../secret',
    '?file=workspace.json',
    `?attempt=${randomUUID()}&attempt=${randomUUID()}`,
  ])
    assert.equal((await fetch(api + query, { headers })).status, 400);
  assert.equal(
    (await fetch(`${api}?attempt=${randomUUID()}`, { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(`${url.origin}/workspace.json`, { headers })).status,
    404,
  );
  const view = await (await fetch(api, { headers })).text();
  assert.match(view, /&lt;script&gt;/);
  assert.doesNotMatch(view, /<script>alert/);
  const id = await attempt(root, { observedAt: new Date().toISOString() });
  assert.match(
    await (await fetch(`${api}?attempt=${id}`, { headers })).text(),
    /Recently active/,
  );
  const recordPath = join(root, '.verifold', 'runs', id, 'attempt.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<
    string,
    unknown
  >;
  for (const [status, label] of [
    ['succeeded', 'Response accepted'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
    ['started', 'Outcome unknown'],
  ] as const) {
    await writeFile(
      recordPath,
      JSON.stringify({
        ...record,
        status,
        observedAt: '2020-01-01T00:00:00.000Z',
        finishedAt: status === 'started' ? null : new Date().toISOString(),
      }),
    );
    const updated = await (
      await fetch(`${api}?attempt=${id}`, { headers })
    ).text();
    assert.ok(updated.includes(label));
    assert.ok(updated.includes(id));
  }
  assert.deepEqual(
    await readFile(join(root, '.verifold', 'workspace.json')),
    before,
  );
  for (const path of [
    '/desk.css',
    '/desk-client.js',
    '/manrope.ttf',
    '/symbol.webp',
    '/ui/dom.js',
  ])
    assert.equal((await fetch(url.origin + path)).status, 200);
  assert.equal(
    await openDeskBrowser(
      server.url,
      owner.signal,
      join(root, 'missing-browser'),
    ),
    false,
  );
  owner.abort();
  await server.closed;
  await assert.rejects(fetch(api, { headers }));
});
