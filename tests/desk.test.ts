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
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { startDesk, openDeskBrowser } from '../src/cli/desk.ts';
import { changeWorkspace } from '../src/cli/storage.ts';
import { readDeskSnapshot, readDeskReport } from '../src/cli/desk-records.ts';
import { renderDesk, type DeskView } from '../src/cli/desk-view.ts';

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
  await mkdir(join(assets, 'cli', 'vendor'), { recursive: true });
  await mkdir(join(assets, 'ui'));
  await writeFile(join(assets, 'cli', 'vendor', 'purify.js'), 'fixture');
  for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js'])
    await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
  for (const name of [
    'desk.css',
    'desk-client.js',
    'desk-transcript.js',
    'desk-terminal.js',
    'desk-terminals.js',
    'desk-lease.js',
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
    '?view=results',
    '?panel=page',
    '?view=home&view=records',
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
  // Research shows the brief, escaped.
  const view = await (await fetch(`${api}?view=research`, { headers })).text();
  assert.match(view, /&lt;script&gt;/);
  assert.doesNotMatch(view, /<script>alert/);
  const id = await attempt(root, { observedAt: new Date().toISOString() });
  // The attempt panel shows one attempt in full, beside the Records view.
  const opened = `${api}?view=records&panel=attempt&attempt=${id}`;
  assert.match(
    await (await fetch(opened, { headers })).text(),
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
    const updated = await (await fetch(opened, { headers })).text();
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
    '/vendor/purify.js',
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

await test('desk renders harness Markdown without active content and explains a busy owner', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    context: [
      '# Research brief',
      '',
      '**Status:** draft with `code`.',
      '',
      '<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [paper](https://example.org/p)',
    ].join('\n'),
  }));
  const snapshot = await readDeskSnapshot(root);
  const live = { session: null, controllable: true };
  const html = renderDesk(snapshot, undefined, null, live, {
    view: 'research',
    panel: 'new-session',
  }).html;
  assert.match(html, /<h3>Research brief<\/h3>/);
  assert.match(html, /<strong>Status:<\/strong> draft with <code>code<\/code>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|javascript:/);
  assert.match(
    html,
    /<a href="https:\/\/example\.org\/p" target="_blank" rel="noopener noreferrer">paper<\/a>/,
  );
  assert.match(html, /data-action="start">Start session/);
  assert.match(
    renderDesk(snapshot, undefined, null, live).html,
    /copy-command/,
  );
});

await test('desk lists paused sessions with a Resume control', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const paused = [
    {
      id: '20261002T120000000Z-abcdef12',
      host: 'codex' as const,
      status: 'paused' as const,
      startedAt: '2026-10-02T12:00:00.000Z',
      request: 'Reproduce <b>the baseline</b>',
      restart: false,
    },
  ];
  const html = renderDesk(snapshot, undefined, null, {
    session: null,
    controllable: true,
    paused,
  }).html;
  assert.match(html, /Paused sessions/);
  assert.match(
    html,
    /data-action="resume" data-session="20261002T120000000Z-abcdef12">Resume/,
  );
  assert.match(html, /Reproduce &lt;b&gt;the baseline&lt;\/b&gt;/);
});

await test('desk shows one research decision for each phase', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const idle = {
    running: false,
    step: null,
    startedAt: null,
    events: [],
  };
  const html = async (
    research: object,
    live = false,
    view: DeskView = 'home',
  ): Promise<string> =>
    renderDesk(
      await readDeskSnapshot(root),
      undefined,
      null,
      {
        session: live
          ? ({
              live: true,
              saveFailed: false,
              record: {
                requests: [],
                events: [],
                commands: [],
                host: 'claude',
                status: 'idle',
                mode: 'ask',
                reportedMode: null,
                model: null,
                costUsd: null,
                nativeSessionId: null,
                id: '20261002T120000000Z-abcdef12',
              },
            } as never)
          : null,
        controllable: true,
        research: { ...idle, ...research },
      },
      { view, panel: null },
    ).html;
  const start = await html({});
  assert.match(start, /Start research/);
  assert.match(start, /id="research-topic"/);
  assert.match(
    await html({
      running: true,
      step: 'Planning research roles and scope',
      startedAt: new Date().toISOString(),
      events: [
        {
          at: new Date().toISOString(),
          kind: 'tool',
          text: 'Claude Code requested <WebSearch>.',
        },
      ],
    }),
    /Research is running[\s\S]*data-action="cancel-research"/,
  );
  await changeWorkspace(root, (state) => ({
    ...state!,
    research: {
      topic: 'Proof search',
      autonomy: 'guided',
      phase: 'awaiting-plan-review',
      plan: {
        scope: 'Scope',
        personas: [
          { name: 'Historian', task: 'Find prior art.' },
          { name: 'Skeptic', task: 'Find counterexamples.' },
        ],
      },
    },
  }));
  const review = await html({});
  assert.match(review, /Review the plan/);
  assert.match(
    review,
    /class="primary" data-action="research" data-research="approve">/,
  );
  // A live worker does not hold research back.
  assert.match(
    await html({}, true),
    /class="primary" data-action="research" data-research="approve">/,
  );
  // Research shows the step, its events, and its transcript.
  const events = await html(
    {
      step: 'Planning research roles and scope',
      events: [
        {
          at: new Date().toISOString(),
          kind: 'tool',
          text: 'Claude Code requested <WebSearch>.',
        },
      ],
    },
    false,
    'research',
  );
  assert.match(events, /Claude Code requested &lt;WebSearch&gt;\./);
  assert.match(events, /data-detail="details"/);
});

await test('desk points to the coordinator after a direction and shows its notes to the person', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    candidates: [
      {
        id: 'proof',
        title: 'Proof search',
        recommendation: 'Try a bounded pilot.',
        gates: ['A checker passes.'],
      },
    ],
    selectedId: 'proof',
  }));
  const snapshot = await readDeskSnapshot(root);
  const at = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    objective: 'Proof search',
    host: 'claude',
    model: null,
    startedAt: at,
    stoppedAt: null,
    session: null,
    created: 1,
    planApproved: false,
    cursor: 0,
    wakeups: [],
    events: [],
    actions: [],
  };
  const note = {
    schemaVersion: 1,
    id: 'm-1',
    at,
    from: 'coordinator',
    to: 'person',
    kind: 'note',
    text: 'The benchmark needs a dataset host.',
    delivery: 'board',
  };
  const pilot = {
    id: 'task-1',
    state: 'open',
    revision: 1,
    attempts: [],
    assignment: {
      by: 'coordinator',
      title: 'Bounded pilot',
      objective: 'Run the pilot.',
      dependencies: [],
    },
  };
  const html = (planApproved: boolean, planned = [pilot]): string =>
    renderDesk(snapshot, undefined, null, {
      session: null,
      controllable: true,
      tasks: { list: planned, selected: null, idle: [], messages: [note] },
      coordinator: {
        state: { ...state, planApproved },
        session: null,
        waiting: 0,
        limitedUntil: null,
      },
    } as never).html;
  const waiting = html(false);
  assert.match(waiting, /The task plan waits for you/);
  assert.match(waiting, /Plan: waits for you/);
  assert.doesNotMatch(waiting, /verifold handoff/);
  assert.match(
    waiting,
    /Notes to you \(1\)[\s\S]*The benchmark needs a dataset host\./,
  );
  // Before the coordinator creates a task, nothing waits for the person.
  const empty = html(false, []);
  assert.match(empty, /No task plan yet/);
  assert.doesNotMatch(empty, /waits for you/);
  assert.match(
    html(true),
    /The coordinator runs the team[\s\S]*Nothing needs you/,
  );
});

await test('desk frame shows one view, the team, and one panel', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const worker = {
    live: true,
    saveFailed: false,
    record: {
      id: '20261002T120000000Z-abcdef12',
      host: 'claude',
      status: 'running',
      mode: 'ask',
      reportedMode: null,
      model: null,
      costUsd: null,
      nativeSessionId: null,
      startedAt: '2026-10-02T12:00:00.000Z',
      events: [],
      commands: [],
      requests: [
        {
          id: 'R1',
          native: 'n-1',
          tool: 'Bash',
          action: 'curl -sI https://example.org',
          at: '2026-10-02T12:00:00.000Z',
        },
      ],
    },
  };
  const live = {
    session: worker,
    workers: [worker],
    controllable: true,
  } as never;
  const home = renderDesk(snapshot, undefined, null, live);
  assert.equal(home.title, basename(root));
  assert.equal(home.stage, 'Question: not asked yet');
  assert.match(home.html, /data-view="home" aria-current="page"/);
  // Without a task owner the rail has no Tasks view.
  assert.doesNotMatch(home.html, /data-view="tasks"/);
  // Home holds the request, and the rail counts it for the person.
  assert.match(home.html, /<h1 id="view-title" tabindex="-1">Home<\/h1>/);
  assert.match(
    home.html,
    /role="img" aria-label="Project stage\. Question: not asked yet\."/,
  );
  assert.match(home.html, /Claude Code session asks to use Bash/);
  assert.match(
    home.html,
    /◆ <\/span>1<span class="visually-hidden"> item waits for you/,
  );
  assert.match(
    home.html,
    /data-worker="20261002T120000000Z-abcdef12" aria-pressed="false"/,
  );
  assert.doesNotMatch(home.html, /id="panel"/);
  // The panel shows one item beside the view, with a way to close it.
  const opened = renderDesk(snapshot, undefined, null, live, {
    view: 'records',
    panel: 'worker',
  }).html;
  assert.match(opened, /data-view="records" aria-current="page"/);
  assert.match(opened, /<h1 id="view-title" tabindex="-1">Records<\/h1>/);
  assert.match(
    opened,
    /<aside class="panel" id="panel" aria-labelledby="panel-title">/,
  );
  assert.match(
    opened,
    /<h2 id="panel-title" tabindex="-1">Claude Code session<\/h2>/,
  );
  assert.match(opened, /data-close-panel aria-label="Close the panel"/);
  assert.match(
    opened,
    /data-worker="20261002T120000000Z-abcdef12" aria-pressed="true"/,
  );
  assert.match(
    opened,
    /data-action="cancel" data-session="20261002T120000000Z-abcdef12"/,
  );
  // New offers a session form. Every slot is in use, so the panel says why no session starts.
  assert.match(opened, /data-panel="new-session"/);
  const full = renderDesk(
    snapshot,
    undefined,
    null,
    { ...(live as object), full: true } as never,
    { view: 'home', panel: 'new-session' },
  ).html;
  assert.match(full, /2 workers run\. End a session/);
  assert.doesNotMatch(full, /data-action="start"/);
});
