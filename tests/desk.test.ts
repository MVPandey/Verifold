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
import {
  parseFrame,
  renderDesk,
  type DeskPanel,
  type DeskView,
} from '../src/cli/desk-view.ts';

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
  await writeFile(join(assets, 'cli', 'vendor', 'idiomorph.js'), 'fixture');
  for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js'])
    await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
  for (const name of [
    'desk.css',
    'desk-client.js',
    'desk-transcript.js',
    'desk-terminal.js',
    'desk-terminals.js',
    'desk-lease.js',
    'desk-map.js',
    'desk-motion.js',
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
  // The page draws its tab icon as a blob image. Other images come from the desk.
  assert.match(
    shell.headers.get('content-security-policy') ?? '',
    /img-src 'self' blob:;/,
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
    '?view=unknown',
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
    '/desk-motion.js',
    '/vendor/idiomorph.js',
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
    panel: null,
  }).html;
  assert.match(html, /<h3>Research brief<\/h3>/);
  assert.match(html, /<strong>Status:<\/strong> draft with <code>code<\/code>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|javascript:/);
  assert.match(
    html,
    /<a href="https:\/\/example\.org\/p" target="_blank" rel="noopener noreferrer">paper<\/a>/,
  );
  // A desk that controls sessions offers a new agent in the message box. As the only choice, it shows its defaults.
  assert.match(
    html,
    /<option value="new-agent" data-hint="Write the first request for a new agent">A new agent<\/option>/,
  );
  assert.match(
    html,
    /<div class="dock-new" data-for="new-agent"><label for="agent-host">Harness <select id="agent-host">[\s\S]*<select id="agent-mode"><option value="ask">Ask me first<\/option><option value="auto">Auto<\/option><\/select><\/label><span>In this project folder<\/span><\/div>/,
  );
  assert.doesNotMatch(html, /new-menu|new-session/);
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
      step: 'Planning the research',
      events: [
        {
          at: new Date().toISOString(),
          kind: 'tool',
          text: 'Claude Code requested WebSearch.',
        },
      ],
    },
    false,
    'research',
  );
  // The step shows in plain words. The harness event stays in the transcript.
  assert.match(events, /Now: Searching the web\./);
  assert.doesNotMatch(events, /requested WebSearch/);
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
      reason: 'Created by the coordinator: a first pass.',
      title: 'Bounded pilot',
      objective: 'Run the pilot.',
      dependencies: [],
    },
  };
  const html = (
    planApproved: boolean,
    planned = [pilot],
    panel: 'coordinator' | null = null,
  ): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list: planned, selected: null, idle: [], messages: [note] },
        coordinator: {
          state: { ...state, planApproved },
          session: null,
          waiting: 0,
          limitedUntil: null,
        },
      } as never,
      { view: 'home', panel },
    ).html;
  const waiting = html(false);
  assert.match(waiting, /The plan waits for you/);
  assert.match(waiting, /Plan: waits for you/);
  assert.doesNotMatch(waiting, /verifold handoff/);
  // The message box shows the coordinator's latest note as its reading. Its panel lists every note.
  assert.match(
    waiting,
    /data-thread="coordinator"><li class="dock-note">[\s\S]*Its reading[\s\S]*The benchmark needs a dataset host\./,
  );
  assert.match(
    html(false, [pilot], 'coordinator'),
    /Notes to you \(1\)[\s\S]*The benchmark needs a dataset host\./,
  );
  // Before the coordinator creates a task, nothing waits for the person.
  const empty = html(false, []);
  assert.match(empty, /The coordinator drafts the plan/);
  assert.doesNotMatch(empty, /waits for you/);
  // After the person starts the work, the Now line says what happens, and nothing waits.
  assert.match(
    html(true),
    /Now<\/span> The coordinator watches the work\.[\s\S]*0 of 1 tasks done\./,
  );
  assert.doesNotMatch(html(true), /Needs you<\/h2>/);
});

await test('the rail lists each task, also after its worker slot goes to another task', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-04T12:00:00.000Z';
  const task = (id: string, state: string, session: string, title: string) => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    attempts: [
      {
        number: 1,
        startedAt: at,
        session,
        outcome: null,
        note: null,
        restrictions: [],
        versions: [],
      },
    ],
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title,
      objective: 'Run.',
      inputs: [],
      writable: ['results'],
      output: 'A report.',
      host: 'claude',
      model: null,
      minutes: 30,
      dependencies: [],
    },
  });
  // Task 3 runs in the slot that task 1's worker held, so task 1 has no worker now.
  const worker = {
    live: true,
    saveFailed: false,
    record: {
      id: 'S3',
      host: 'claude',
      status: 'running',
      mode: 'strict',
      reportedMode: null,
      model: null,
      costUsd: null,
      nativeSessionId: null,
      startedAt: at,
      events: [],
      commands: [],
      requests: [],
      task: { id: 'task-3', claim: 'c-3' },
    },
  };
  const html = renderDesk(snapshot, undefined, null, {
    session: null,
    workers: [worker],
    controllable: true,
    tasks: {
      list: [
        task('task-1', 'done', 'S1', 'Implementation A'),
        task('task-2', 'cancelled', 'S2', 'Dropped idea'),
        task('task-3', 'running', 'S3', 'Compare'),
      ],
      selected: null,
      idle: [],
      messages: [],
    },
  } as never).html;
  const rail = html.slice(
    html.indexOf('<div class="rail-team">'),
    html.indexOf('<div class="rail-foot">'),
  );
  assert.match(
    rail,
    /data-task-select="task-1" aria-pressed="false">[\s\S]*?Implementation A[\s\S]*?Done/,
  );
  assert.match(rail, /data-worker="S3"[\s\S]*?Compare/);
  assert.doesNotMatch(rail, /Dropped idea/);
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
  assert.equal(home.stage, 'Ask: no question yet');
  assert.match(home.html, /data-view="home" aria-current="page"/);
  // Without a task owner the rail has no Tasks view.
  assert.doesNotMatch(home.html, /data-view="tasks"/);
  // Home holds the request, and the rail counts it for the person.
  assert.match(home.html, /<h1 id="view-title" tabindex="-1">Home<\/h1>/);
  assert.match(
    home.html,
    /role="img" aria-label="Project stage\. Ask: no question yet\."/,
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
  // The panel of a running session points the message box at it.
  assert.match(
    opened,
    /class="primary" data-message-to="session:20261002T120000000Z-abcdef12">Write to it/,
  );
  // The running session is in To on Home, by its harness and the start of its request.
  assert.match(
    home.html,
    /<option value="session:20261002T120000000Z-abcdef12" data-hint="Write to Claude Code[^"]*">Claude Code[^<]*<\/option><option value="new-agent"/,
  );
});

await test('desk lists in Needs you only the decisions that are the person’s', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const at = '2026-10-04T12:00:00.000Z';
  const idle = { running: false, step: null, startedAt: null, events: [] };
  const research = async (
    phase: string,
  ): Promise<ReturnType<typeof renderDesk>> => {
    await changeWorkspace(
      root,
      (state) =>
        ({
          ...state!,
          research: {
            topic: 'Graphs',
            autonomy: 'guided',
            phase,
            plan: {
              scope: 'Scope.',
              personas: [
                { name: 'Historian', task: 'Prior art.' },
                { name: 'Skeptic', task: 'Counterexamples.' },
              ],
            },
          },
        }) as never,
    );
    return renderDesk(await readDeskSnapshot(root), undefined, null, {
      session: null,
      controllable: true,
      research: idle,
    });
  };
  const plan = await research('awaiting-plan-review');
  assert.deepEqual(plan.needs, [
    { key: 'research-plan:', title: 'Review the plan' },
  ]);
  assert.match(
    plan.html,
    /Needs you[\s\S]*Guided research stops at its plan[\s\S]*data-research="approve">Approve the plan/,
  );
  // The rail counts the item on the view that holds it. The top bar names the stage.
  assert.match(plan.html, /<span>Plan<\/span><span class="n">/);
  assert.equal(plan.stage, 'Plan: waits for you');
  assert.equal(
    (await research('directions')).needs[0]?.title,
    'Choose a direction',
  );
  assert.match(
    (await research('needs-research')).html,
    /Research stopped before its step ended[\s\S]*data-research="continue">Continue research/,
  );

  // After a direction, the coordinator settles what it can.
  await changeWorkspace(root, (state) => ({
    ...state!,
    candidates: [
      {
        id: 'proof',
        title: 'Proof search',
        recommendation: 'Pilot.',
        gates: ['A check.'],
      },
    ],
    selectedId: 'proof',
  }));
  const snapshot = await readDeskSnapshot(root);
  const task = (id: string, state: string, extra: object = {}): object => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    attempts: [],
    assignment: {
      by: 'coordinator',
      reason: 'Created by the coordinator: The plan needs it.',
      title: `Title of ${id}`,
      objective: 'Work.',
      inputs: [],
      writable: ['results'],
      output: 'A report.',
      host: 'claude',
      model: null,
      minutes: 30,
      dependencies: [],
    },
    ...extra,
  });
  const review = task('task-2', 'review', {
    attempts: [
      {
        number: 1,
        session: null,
        outcome: null,
        note: null,
        restrictions: [],
        versions: [
          {
            number: 1,
            at,
            turn: 'completed',
            files: [],
            skipped: [],
            decision: null,
          },
        ],
      },
    ],
  });
  const objection = (id: string, status: string, text: string): object => ({
    schemaVersion: 1,
    id,
    at,
    from: 'task-3',
    to: 'coordinator',
    kind: 'objection',
    status,
    text,
    delivery: 'board',
    about: { task: 'task-2', version: 1 },
  });
  const overruled = (id: string, closes: string): object => ({
    schemaVersion: 1,
    id,
    at,
    from: 'coordinator',
    to: 'task-3',
    kind: 'decision',
    text: 'Overruled.',
    delivery: 'delivered',
    closes,
  });
  const messages = [
    objection('m-1', 'overruled', 'First.'),
    overruled('m-2', 'm-1'),
    objection('m-3', 'overruled', 'Second.'),
    overruled('m-4', 'm-3'),
    objection('m-5', 'open', 'The benchmark has no negative control.'),
    {
      schemaVersion: 1,
      id: 'm-6',
      at,
      from: 'task-2',
      to: 'coordinator',
      kind: 'blocker',
      status: 'open',
      text: 'The data host is down.',
      delivery: 'board',
    },
  ];
  const coordinator = (
    status: string,
    stoppedAt: string | null = null,
  ): object => ({
    state: {
      objective: 'Proof search',
      host: 'claude',
      model: null,
      startedAt: at,
      stoppedAt,
      session: 'C1',
      created: 3,
      planApproved: true,
      cursor: 0,
      wakeups: [],
      events: [],
      actions: [],
    },
    session: {
      live: true,
      saveFailed: false,
      record: { id: 'C1', status, host: 'claude' },
    },
    waiting: 0,
    limitedUntil: null,
  });
  const desk = (
    live: object,
    view: DeskView = 'home',
    panel: DeskPanel | null = null,
  ): ReturnType<typeof renderDesk> =>
    renderDesk(
      snapshot,
      undefined,
      null,
      { session: null, controllable: true, ...live },
      { view, panel },
    );
  const tasks = {
    list: [task('task-1', 'done'), review, task('task-3', 'open')],
    selected: review,
    idle: [],
    messages,
  };
  // With a running coordinator: only the objection after two overrules is the person's.
  const team = desk({ tasks, coordinator: coordinator('idle') });
  assert.deepEqual(
    team.needs.map((item) => item.key),
    ['message:m-5'],
  );
  assert.match(
    team.html,
    /The coordinator overruled two objections from this task, so this one goes to you/,
  );
  assert.match(team.html, /<section class="card now-card" aria-label="Now">/);
  // The blocker stays with the coordinator. Its task page still lets the person settle it first.
  const panel = desk({ tasks, coordinator: coordinator('idle') }, 'task').html;
  assert.match(
    panel,
    /The coordinator settles this one\. You can settle it first\.[\s\S]*data-message="m-6" data-decision="resolved"/,
  );
  assert.equal(panel.match(/id="decide-m-5"/g)?.length, undefined);
  // A paused coordinator is the person's to resume.
  assert.deepEqual(
    desk({ tasks, coordinator: coordinator('paused') }).needs.map(
      (item) => item.key,
    ),
    ['coordinator-paused:C1', 'message:m-5'],
  );
  // Without a running coordinator, the person settles messages and reviews versions.
  const alone = desk({ tasks, coordinator: coordinator('idle', at) });
  assert.deepEqual(
    alone.needs.map((item) => item.key),
    ['message:m-5', 'message:m-6', 'review:task-2:1:1'],
  );
  assert.match(
    alone.html,
    /No coordinator runs, so only you can accept or reject it\./,
  );
  assert.match(alone.html, /<span>Work<\/span><span class="n">/);
  // Needs you lists the same items, and says when nothing waits.
  assert.match(
    desk({ tasks, coordinator: coordinator('idle', at) }, 'needs').html,
    /<h1 id="view-title" tabindex="-1">Needs you<\/h1><p>3 items wait for you/,
  );
  assert.match(
    desk(
      { tasks: { ...tasks, messages: [] }, coordinator: coordinator('idle') },
      'needs',
    ).html,
    /Nothing needs you\./,
  );
});

await test('desk Home lists what changed since the person left, the team feed, and the talk with the coordinator', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    candidates: [
      {
        id: 'proof',
        title: 'Proof search',
        recommendation: 'Pilot.',
        gates: ['A check.'],
      },
    ],
    selectedId: 'proof',
  }));
  const snapshot = await readDeskSnapshot(root);
  const left = '2026-10-04T12:00:00.000Z';
  const before = '2026-10-04T11:00:00.000Z';
  const later = (minutes: number): string =>
    new Date(Date.parse(left) + minutes * 60_000).toISOString();
  const task = {
    id: 'task-1',
    state: 'done',
    revision: 1,
    createdAt: before,
    attempts: [
      {
        number: 1,
        startedAt: later(5),
        session: null,
        outcome: 'accepted',
        note: null,
        restrictions: [],
        versions: [
          {
            number: 1,
            at: later(20),
            turn: 'completed',
            files: [],
            skipped: [],
            decision: { kind: 'accepted', at: later(25), by: 'coordinator' },
          },
        ],
      },
    ],
    assignment: {
      by: 'coordinator',
      reason: 'Created by the coordinator: a first pass.',
      title: 'Bounded pilot',
      objective: 'Run.',
      inputs: [],
      writable: ['results'],
      output: 'A report.',
      host: 'claude',
      model: null,
      minutes: 30,
      dependencies: [],
    },
  };
  const message = (
    id: string,
    from: string,
    to: string,
    text: string,
    at: string,
    extra: object = {},
  ): object => ({
    schemaVersion: 1,
    id,
    at,
    from,
    to,
    kind: 'note',
    text,
    delivery: 'board',
    ...extra,
  });
  const messages = [
    message(
      'm-1',
      'person',
      'coordinator',
      'Why is the data synthetic?',
      before,
      {
        delivery: 'delivered',
        deliveredAt: before,
        answer: {
          at: later(1),
          text: 'The brief allows a synthetic graph for a first pass.',
        },
      },
    ),
    message(
      'm-2',
      'coordinator',
      'person',
      'The brief allows a synthetic graph for a first pass.',
      later(1),
    ),
    message('m-3', 'task-1', 'coordinator', 'The pilot is done.', later(21), {
      delivery: 'delivered',
    }),
    message(
      'm-4',
      'person',
      'coordinator',
      'Can we add a real graph next?',
      later(30),
      { delivery: 'queued' },
    ),
  ];
  const coordinator = {
    state: {
      objective: 'Proof search',
      host: 'claude',
      model: null,
      startedAt: before,
      stoppedAt: null,
      session: 'C1',
      created: 1,
      planApproved: true,
      cursor: 0,
      wakeups: [],
      events: [],
      actions: [
        {
          at: later(25),
          tool: 'verifold_accept',
          ok: true,
          reason: 'The checks pass.',
          result: 'Accepted.',
        },
      ],
    },
    session: {
      live: true,
      saveFailed: false,
      record: { id: 'C1', status: 'idle', host: 'claude' },
    },
    waiting: 0,
    limitedUntil: null,
  };
  const home = (since?: string): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list: [task], selected: null, idle: [], messages },
        coordinator,
      } as never,
      { view: 'home', panel: null, ...(since ? { since } : {}) },
    ).html;
  const away = home(left);
  // Facts from the records, newest first.
  assert.match(away, /Since you left at /);
  assert.match(
    away,
    /The coordinator accepted version 1 of Bounded pilot[\s\S]*Bounded pilot made version 1[\s\S]*Bounded pilot started/,
  );
  assert.match(
    away,
    /The coordinator acted 1 time\. Its reasons are in its panel\./,
  );
  assert.match(away, /1 message in the team feed\./);
  assert.doesNotMatch(home(), /Since you left/);
  // The feed holds what the agents write, never the person's messages.
  const feed =
    /<h2 id="feed-title">Team feed<\/h2>[\s\S]*?<\/section>/.exec(away)?.[0] ??
    '';
  assert.match(feed, /Bounded pilot[\s\S]*The pilot is done\./);
  assert.doesNotMatch(feed, /synthetic/);
  // The message box writes to the coordinator. Its thread shows each message with its state, and
  // the answer under it. The note that answered a message does not show a second time.
  const dock = /<section class="dock"[\s\S]*<\/section>/.exec(away)?.[0] ?? '';
  assert.match(
    dock,
    /<strong>You<\/strong>[\s\S]*Answered[\s\S]*Why is the data synthetic\?[\s\S]*dock-answer[\s\S]*Its reading[\s\S]*The brief allows a synthetic graph for a first pass\.[\s\S]*Waits for the coordinator[\s\S]*Can we add a real graph next\?/,
  );
  assert.equal(dock.split('The brief allows').length, 2);
  assert.match(
    dock,
    /<option value="coordinator" data-hint="Write to the coordinator">Coordinator, leads now<\/option>/,
  );
  assert.match(
    dock,
    /id="message-text"[^>]*placeholder="Write to the coordinator"/,
  );
  assert.doesNotMatch(away, /id="coordinator-message"/);
  // The coordinator's actions and controls are in its panel, which the rail opens.
  assert.match(away, /data-panel="coordinator" aria-pressed="false"/);
  assert.doesNotMatch(away, /What it did/);
});

await test('desk shows long text as its lead with Show all, and short text in full', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-04T12:00:00.000Z';
  const long = `The benchmark ran on 3 graphs. ${'Each stratum has 200 queries and a negative control. '.repeat(6)}`;
  const messages = [
    {
      schemaVersion: 1,
      id: 'm-1',
      at,
      from: 'task-1',
      to: 'coordinator',
      kind: 'note',
      text: long,
      delivery: 'delivered',
    },
    {
      schemaVersion: 1,
      id: 'm-2',
      at,
      from: 'coordinator',
      to: 'task-1',
      kind: 'objection',
      status: 'open',
      text: 'Short and clear.',
      delivery: 'delivered',
    },
  ];
  const worker = {
    live: true,
    saveFailed: false,
    record: {
      id: '20261004T120000000Z-abcdef12',
      host: 'claude',
      status: 'idle',
      mode: 'ask',
      reportedMode: null,
      model: null,
      costUsd: null,
      nativeSessionId: null,
      startedAt: at,
      requests: [],
      commands: [],
      events: [
        { at, kind: 'you', text: 'Run it.' },
        {
          at,
          kind: 'agent',
          text: `**Done.** ${'The *settled* nodes fell by 41 percent. '.repeat(8)}`,
        },
      ],
    },
  };
  const { html } = renderDesk(
    snapshot,
    undefined,
    null,
    {
      session: worker,
      workers: [worker],
      controllable: true,
      tasks: { list: [], selected: null, idle: [], messages },
    } as never,
    { view: 'home', panel: 'worker' },
  );
  // The feed folds the long note at its first sentence. The short objection shows in full.
  assert.match(
    html,
    /<details class="more" id="feed-m-1"><summary><span class="lead">The benchmark ran on 3 graphs\.<\/span> <span class="more-hint"><span class="closed">Show all<\/span>/,
  );
  assert.doesNotMatch(html, /id="feed-m-2"/);
  assert.match(html, /<span class="chip objection">Objection, open<\/span>/);
  // An agent's Markdown reply folds with a plain lead and renders in full behind Show all.
  assert.match(
    html,
    /<details class="more" id="event-20261004T120000000Z-abcdef12-1"><summary><span class="lead">Done\.<\/span>[\s\S]*<strong>Done\.<\/strong>/,
  );
  assert.doesNotMatch(html, /id="event-20261004T120000000Z-abcdef12-0"/);
});

await test('Records lists the commands of all agents as an audit, and the rail counts none', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const minute = (offset: number): string =>
    new Date(Date.UTC(2026, 9, 12, 12, 0) + offset * 60_000).toISOString();
  const command = (
    id: string,
    at: string,
    action: string,
    risk: string[] = [],
    reviewedAt?: string,
  ) => ({
    id,
    at,
    tool: 'Bash',
    action,
    risk,
    auto: true,
    outcome: 'ok',
    ...(reviewedAt ? { reviewedAt } : {}),
  });
  const worker = (
    id: string,
    host: string,
    commands: object[],
    task?: string,
  ) => ({
    live: true,
    saveFailed: false,
    record: {
      id,
      host,
      ...(task ? { task: { id: task, revision: 1 } } : {}),
      status: 'idle',
      mode: 'auto',
      reportedMode: null,
      model: null,
      costUsd: null,
      nativeSessionId: null,
      startedAt: minute(-300),
      requests: [],
      commands,
      events: [],
    },
  });
  // An old tagged command, then 205 newer ones without a tag.
  const claude = worker('20261012T090000000Z-aaaaaaaa', 'claude', [
    command('c-old', minute(-240), 'rm -rf build', ['Deletes files']),
    ...Array.from({ length: 205 }, (_, index) =>
      command(`c-${index}`, minute(-200 + index), `ls ${index}`),
    ),
  ]);
  const codex = worker(
    '20261012T090000000Z-bbbbbbbb',
    'codex',
    [
      command(
        'x-1',
        minute(10),
        'curl https://example.com',
        ['Network'],
        minute(11),
      ),
    ],
    'task-1',
  );
  const desk = (panel: string | null) =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: claude,
        workers: [claude, codex],
        controllable: true,
        tasks: {
          list: [
            {
              id: 'task-1',
              state: 'running',
              revision: 1,
              createdAt: minute(-300),
              attempts: [],
              assignment: {
                by: 'coordinator',
                reason: 'Part of the plan.',
                title: 'Fetch the road graphs',
                objective: 'Fetch.',
                host: 'codex',
                dependencies: [],
              },
            },
          ],
          selected: null,
          idle: [],
          messages: [],
        },
      } as never,
      { view: 'records', panel } as never,
    ).html;
  const html = desk(null);
  // The rail shows no command counts. Amber stays for Needs you.
  assert.doesNotMatch(html, /need review|needs review/);
  // One table for all agents, newest first, with the agent and its harness.
  assert.equal(html.match(/<table class="audit">/g)?.length, 1);
  assert.match(
    html,
    /<div class="seg" role="group" aria-label="Commands to show"><button type="button" data-records="all">All commands<\/button><button type="button" data-records="tagged">Tagged only<\/button><\/div><span class="count">207 recorded, 2 tagged<\/span>/,
  );
  assert.match(
    html,
    /The table shows the latest 200 commands and every tagged command\./,
  );
  const rows = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
  assert.equal(rows.match(/<tr/g)?.length, 201);
  assert.match(
    rows,
    /^<tr class="tagged"><td>[^<]*<\/td><td>Fetch the road graphs<span class="fine">Codex<\/span><\/td><td><span class="audit-tool">Bash<\/span><code>curl https:\/\/example\.com<\/code><\/td>[\s\S]*?<span class="risk">Network<\/span>[\s\S]*?<td>Reviewed<\/td><\/tr>/,
  );
  // A plain session already names its harness.
  assert.match(rows, /<td>Claude Code session<\/td>/);
  // The old tagged command stays in the audit, last, with Mark reviewed.
  assert.match(
    rows,
    /<tr class="tagged">(?:(?!<tr)[\s\S])*rm -rf build(?:(?!<tr)[\s\S])*data-action="review" data-command="c-old">Mark reviewed<\/button><\/td><\/tr>$/,
  );
  assert.doesNotMatch(rows, /ls 0</);
  // The panel of an agent shows its own commands in a Commands tab, without the agent column.
  const panel = desk('worker');
  assert.match(
    panel,
    /<button type="button" data-pane="commands">Commands<\/button>/,
  );
  const pane =
    /<div class="pane-commands">([\s\S]*?)<\/table>/.exec(panel)?.[1] ?? '';
  assert.match(pane, /206 recorded, 1 tagged/);
  assert.doesNotMatch(pane, /<th scope="col">Agent/);
});

await test('desk maps the tasks with what each agent does now and why', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    candidates: [
      {
        id: 'proof',
        title: 'Proof search',
        recommendation: 'Pilot.',
        gates: ['A check.'],
      },
    ],
    selectedId: 'proof',
  }));
  const snapshot = await readDeskSnapshot(root);
  const recent = new Date(Date.now() - 60_000).toISOString();
  const quiet = new Date(Date.now() - 20 * 60_000).toISOString();
  const task = (
    id: string,
    state: string,
    dependencies: string[],
    reason: string,
    extra: object = {},
  ): object => ({
    id,
    state,
    revision: 1,
    createdAt: recent,
    attempts: [],
    assignment: {
      by: 'coordinator',
      reason,
      title: `Title ${id}`,
      objective: 'Work on it. Then report.',
      inputs: [],
      writable: ['results'],
      output: 'A report.',
      host: 'claude',
      model: null,
      minutes: 30,
      dependencies,
    },
    ...extra,
  });
  const worker = (at: string): object => ({
    live: true,
    saveFailed: false,
    record: {
      id: '20261004T120000000Z-abcdef12',
      host: 'claude',
      status: 'running',
      mode: 'strict',
      reportedMode: null,
      model: null,
      costUsd: null,
      nativeSessionId: null,
      startedAt: recent,
      task: { id: 'task-2', claim: 'c' },
      requests: [],
      commands: [],
      events: [{ at, kind: 'tool', text: 'Bash: python bench.py --size 4' }],
    },
  });
  const list = [
    task(
      'task-1',
      'done',
      [],
      'Created by the coordinator: A baseline comes first.',
    ),
    task(
      'task-2',
      'running',
      ['task-1'],
      'Created by the coordinator: The checks need timings.',
      {
        attempts: [
          {
            number: 1,
            session: '20261004T120000000Z-abcdef12',
            startedAt: recent,
            versions: [],
            restrictions: [],
            outcome: null,
            note: null,
          },
        ],
      },
    ),
    task('task-3', 'open', ['task-2'], 'Created'),
  ];
  const desk = (at: string, view: DeskView): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: worker(at),
        workers: [worker(at)],
        controllable: true,
        tasks: { list, selected: null, idle: [], messages: [] },
      } as never,
      { view, panel: null },
    ).html;
  const map = desk(recent, 'tasks');
  // The objective starts the map. Each task sits in the column of its depth, with the arrow source named.
  assert.match(
    map,
    /data-node="objective"><span class="map-label">Objective<\/span><span class="map-title">Proof search<\/span>/,
  );
  assert.match(
    map,
    /data-node="task-1" data-state="done" data-host="claude" data-from="objective"[\s\S]*<\/div><div class="map-col">[\s\S]*data-node="task-2" data-state="running" data-host="claude" data-from="task-1"[\s\S]*<\/div><div class="map-col">[\s\S]*data-node="task-3" data-state="open" data-host="claude" data-from="task-2"/,
  );
  // A compact box says whose turn it is and for how long its agent runs. The Now strip says what the agent does.
  assert.match(
    map,
    /Agent&#39;s turn<\/span><span class="map-meta">For (under a minute|\d+ min)<\/span><\/button>/,
  );
  assert.match(map, /Waits for Title task-2<\/span><\/button>/);
  assert.doesNotMatch(map, /map-why|map-now|Each box is a task/);
  assert.match(
    map,
    /<h2 id="now-title">Now<\/h2><span class="count">1 agent works<\/span>[\s\S]*data-task-select="task-2">Title task-2<\/button><span class="now-meta">Claude Code, (under a minute|\d+ min)<\/span>[\s\S]*Running python bench\.py<\/p><\/div><button type="button" data-message-to="task-2">Message<\/button>/,
  );
  // A quiet agent keeps its latest step, with the time since it.
  assert.match(
    desk(quiet, 'tasks'),
    /Running python bench\.py <span class="now-quiet">Last update 20 min ago<\/span>/,
  );
  assert.doesNotMatch(desk(quiet, 'tasks'), /No update in/);
  // Home says in its Now line which task runs, and on which harness.
  assert.match(desk(recent, 'home'), /Now<\/span> Title task-2 runs on /);
});

await test('desk shows one plan: the direction, its checks, and the drafted tasks, with one approval', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    research: {
      topic: 'Road graphs',
      autonomy: 'autonomous',
      phase: 'directions',
      plan: {
        scope: 'Scope',
        personas: [
          { name: 'Historian', task: 'Find prior art.' },
          { name: 'Skeptic', task: 'Find counterexamples.' },
        ],
      },
    },
    candidates: [
      {
        id: 'heap',
        title: 'Heap Dijkstra',
        recommendation: 'Compare a binary heap with a scan.',
        gates: ['Same paths on small graphs.', 'Faster on large graphs.'],
        kind: 'main',
      },
      {
        id: 'alt',
        title: 'ALT with landmarks',
        recommendation: 'Precompute landmarks.',
        gates: ['Distances match.'],
        kind: 'alternative',
      },
    ],
    selectedId: 'heap',
  }));
  const snapshot = await readDeskSnapshot(root);
  const at = new Date().toISOString();
  const task = (id: string, title: string, dependencies: string[]) => ({
    id,
    state: 'open',
    revision: 1,
    createdAt: at,
    attempts: [],
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title,
      objective: 'Run.',
      host: id === 'task-1' ? 'codex' : 'claude',
      dependencies,
    },
  });
  const desk = (
    status: string,
    view: 'home' | 'research',
    approved = false,
  ): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        research: { running: false, step: null, events: [], startedAt: null },
        tasks: {
          list: [
            task('task-1', 'Implement', []),
            task('task-2', 'Benchmark', ['task-1']),
            {
              ...task('task-3', 'Sparse graphs', ['task-1']),
              assignment: {
                ...task('task-3', 'Sparse graphs', ['task-1']).assignment,
                extra: true,
              },
            },
          ],
          selected: null,
          idle: [],
          messages: [],
        },
        coordinator: {
          state: {
            schemaVersion: 1,
            objective: 'Heap Dijkstra',
            host: 'claude',
            model: null,
            startedAt: at,
            stoppedAt: null,
            session: 'C1',
            created: 2,
            planApproved: approved,
            cursor: 0,
            wakeups: [],
            events: [],
            actions: [],
          },
          session: {
            live: true,
            saveFailed: false,
            record: {
              id: 'C1',
              status,
              events: [
                {
                  at,
                  kind: 'agent',
                  text: 'Two tasks, about 30 minutes. Codex writes the code, so Claude Code tests code from another model.',
                },
              ],
            },
          },
          waiting: 0,
          limitedUntil: null,
        },
      } as never,
      approved
        ? { view, panel: 'direction', direction: 'alt' }
        : { view, panel: null },
    ).html;
  // Home opens the plan where it can be read. It does not approve it.
  const home = desk('idle', 'home');
  assert.match(
    home,
    /The plan waits for you[\s\S]*data-view="research" data-focus="plan-card-title">Read the plan/,
  );
  assert.doesNotMatch(home, /Choose a direction/);
  // The plan: the direction, its checks, the drafted tasks with their harness, and one approval.
  const plan = desk('idle', 'research');
  assert.match(
    plan,
    /<h2 id="plan-card-title" tabindex="-1">The plan<\/h2><span class="status muted">Waits for you[\s\S]*<strong>Heap Dijkstra<\/strong>[\s\S]*<li>Same paths on small graphs\.<\/li><li>Faster on large graphs\.<\/li>[\s\S]*<strong>Implement<\/strong> <span class="fine">Codex<\/span>[\s\S]*<strong>Benchmark<\/strong> <span class="fine">Claude Code, after Implement<\/span>/,
  );
  assert.match(plan, /data-action="coordinator-approve">Start the work/);
  // Extras are add-ons with a checkbox, not ticked. The coordinator's summary is its reading.
  assert.match(
    plan,
    /<h3>Extras<\/h3>[\s\S]*<input type="checkbox" data-extra="task-3"> <strong>Sparse graphs<\/strong>/,
  );
  assert.doesNotMatch(
    plan,
    /<ol class="plan-tasks">((?!<\/ol>)[\s\S])*Sparse graphs/,
  );
  assert.match(
    plan,
    /The coordinator's summary<\/strong><span class="tag reading">Its reading<\/span>[\s\S]*about 30 minutes/,
  );
  // Another direction replaces the draft before the work starts.
  assert.match(
    plan,
    /ALT with landmarks<\/strong> <span class="tag">Alternative<\/span>[\s\S]*data-action="redraft" data-idea="alt"/,
  );
  assert.match(plan, /<span class="selected-label">In the plan<\/span>/);
  // While the coordinator drafts, the plan cannot start.
  // After the work started, the plan card goes, and another direction offers a change.
  const started = desk('idle', 'research', true);
  assert.doesNotMatch(started, /plan-card-title/);
  assert.match(
    started,
    /data-action="change-direction" data-idea="alt" data-confirm="Click again to stop the work and change the direction">Change to this direction/,
  );
  assert.doesNotMatch(started, /data-action="redraft"/);
  const drafting = desk('running', 'research');
  assert.match(drafting, /The coordinator drafts it/);
  assert.match(
    drafting,
    /data-action="coordinator-approve" disabled>Start the work/,
  );
});

await test('Home shows the work live, the checks, and the answer under the question', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    research: {
      topic: 'Is the heap version faster?',
      autonomy: 'autonomous',
      phase: 'directions',
      plan: {
        scope: 'Scope',
        personas: [
          { name: 'Historian', task: 'Find prior art.' },
          { name: 'Skeptic', task: 'Find counterexamples.' },
        ],
      },
    },
    candidates: [
      {
        id: 'heap',
        title: 'Heap Dijkstra',
        recommendation: 'Compare a heap with a scan.',
        gates: ['Same paths on small graphs.', 'Faster on large graphs.'],
        kind: 'main',
      },
    ],
    selectedId: 'heap',
  }));
  const snapshot = await readDeskSnapshot(root);
  const at = new Date().toISOString();
  const task = (id: string, title: string, host: string, state: string) => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    attempts: [],
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title,
      objective: 'Run.',
      host,
      dependencies: [],
    },
  });
  const home = (answer: object | null): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        research: { running: false, step: null, events: [], startedAt: null },
        tasks: {
          list: [
            task('task-1', 'Implement', 'codex', 'done'),
            task('task-2', 'Benchmark', 'claude', 'running'),
          ],
          selected: null,
          idle: [],
          messages: [],
        },
        coordinator: {
          state: {
            schemaVersion: 1,
            objective: 'Heap Dijkstra',
            host: 'claude',
            model: null,
            helper: 'codex',
            startedAt: at,
            stoppedAt: null,
            session: null,
            created: 2,
            planApproved: true,
            cursor: 0,
            wakeups: [],
            events: [],
            actions: [],
          },
          results: {
            schemaVersion: 1,
            direction: 'heap',
            checks: [
              {
                check: 1,
                result: 'passed',
                value: '0 differences',
                reason: 'Both agree.',
                evidence: ['results/a.txt'],
                at,
              },
            ],
            answer,
          },
          session: null,
          waiting: 0,
          limitedUntil: null,
        },
      } as never,
      { view: 'home', panel: null },
    ).html;
  const working = home(null);
  // The Now line names the running task and its harness, and how far the work is.
  assert.match(
    working,
    /Now<\/span> Benchmark runs on Claude Code\.<\/p><p class="fine">1 of 2 tasks done\./,
  );
  // The map is on Home, with the mark of the helper harness.
  assert.match(
    working,
    /The work<\/h2>[\s\S]*Implement<span class="host-chip">Codex<\/span>/,
  );
  // The checks, each with its result.
  assert.match(
    working,
    /<li data-result="passed"><span class="check-result">Passed<\/span> Same paths on small graphs\.<\/li><li data-result="none"><span class="check-result">Not yet<\/span> Faster on large graphs\.<\/li>/,
  );
  assert.doesNotMatch(working, /home-answer-title/);
  // The proposed answer shows under the question. Reading it in full comes before the decision.
  const proposed = home({
    statement: 'Yes, above 100,000 nodes.',
    claims: [],
    at,
  });
  assert.match(
    proposed,
    /The answer<\/h2>[\s\S]*Yes, above 100,000 nodes\.[\s\S]*data-view="results" data-focus="answer-title">Read the answer/,
  );
  assert.match(proposed, /Now<\/span> The answer waits for you\./);
  // After the person accepts it, the answer stays on Home.
  const accepted = home({
    statement: 'Yes, above 100,000 nodes.',
    claims: [],
    at,
    decision: { kind: 'accepted', at },
  });
  assert.match(
    accepted,
    /Yes, above 100,000 nodes\.[\s\S]*You accepted the answer/,
  );
  assert.doesNotMatch(accepted, /Read the answer/);
});

await test('the map names the harness of each task and what a done task hands over', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    candidates: [
      {
        id: 'heap',
        title: 'Heap Dijkstra',
        recommendation: 'Compare a heap with a scan.',
        gates: ['Same paths on small graphs.'],
        kind: 'main',
      },
    ],
    selectedId: 'heap',
  }));
  const snapshot = await readDeskSnapshot(root);
  const at = new Date().toISOString();
  const files = (...paths: string[]) => [
    {
      version: 1,
      revision: 1,
      at,
      files: paths.map((path) => ({ path, bytes: 1, sha256: 'a'.repeat(64) })),
    },
  ];
  const task = (
    id: string,
    host: string,
    state: string,
    dependencies: string[],
    artifacts: object[] = [],
  ) => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    attempts: [],
    artifacts,
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title: `Title of ${id}`,
      objective: 'Run.',
      host,
      dependencies,
    },
  });
  const desk = (list: object[], planApproved = true) =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list, selected: null, idle: [], messages: [] },
        coordinator: {
          state: {
            schemaVersion: 1,
            objective: 'Heap Dijkstra',
            host: 'claude',
            model: null,
            helper: 'codex',
            startedAt: at,
            stoppedAt: null,
            session: null,
            created: list.length,
            planApproved,
            cursor: 0,
            wakeups: [],
            events: [],
            actions: [],
          },
          results: null,
          session: null,
          waiting: 0,
          limitedUntil: null,
        },
      } as never,
      { view: 'tasks', panel: null },
    );
  const mixed = desk([
    task(
      'task-1',
      'codex',
      'done',
      [],
      files('src/heap.py', 'results/bench.json'),
    ),
    task('task-2', 'claude', 'running', ['task-1']),
    task('task-3', 'claude', 'done', [], files('notes/plan.md')),
    task('task-4', 'claude', 'open', ['task-2', 'task-3']),
  ]);
  // Each box names its harness, for the color of its pulse. A done box names what it hands over.
  assert.match(
    mixed.html,
    /data-node="task-1" data-state="done" data-host="codex" data-gives="code and results" data-from="objective"/,
  );
  assert.match(
    mixed.html,
    /data-node="task-2" data-state="running" data-host="claude" data-from="task-1"/,
  );
  assert.match(mixed.html, /data-node="task-3"[^>]*data-gives="notes"/);
  // A legend names the colors, the lead harness first.
  assert.match(
    mixed.html,
    /<p class="map-legend" aria-hidden="true"><span class="map-key" data-host="claude">Claude Code<\/span><span class="map-key" data-host="codex">Codex<\/span><\/p><div class="map" data-map>/,
  );
  // The tab icon gets the part of the planned tasks that is done.
  assert.deepEqual(mixed.work, { done: 2, total: 4 });
  // One harness needs no legend. Before the plan is approved, the tab icon has no work to show.
  const single = desk([task('task-1', 'claude', 'open', [])], false);
  assert.doesNotMatch(single.html, /map-legend/);
  assert.equal(single.work, null);
});

await test('desk compares the directions in a table and lists sources as they arrive', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    research: {
      topic: 'Graphs',
      autonomy: 'guided',
      phase: 'directions',
      plan: {
        scope: 'Scope.',
        personas: [
          { name: 'Historian', task: 'Prior art.' },
          { name: 'Skeptic', task: 'Counterexamples.' },
        ],
      },
    },
    candidates: [
      {
        id: 'bidir',
        title: 'Bidirectional Dijkstra',
        recommendation:
          '**Replication.** Feasibility is high. It needs no preprocessing.',
        gates: ['Distances match.', 'Settled nodes fall by 30 percent.'],
        sources: ['https://example.org/papers/bidir'],
      },
      {
        id: 'alt',
        title: 'ALT with few landmarks',
        recommendation: 'Moderate feasibility.',
        gates: ['Preprocessing pays off.'],
      },
    ],
  }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-05T12:00:00.000Z';
  const research = (running: boolean): object => ({
    running,
    step: 'Searching sources and comparing directions',
    startedAt: at,
    events: [],
    sources: [
      { at, kind: 'search', text: 'bidirectional dijkstra stopping rule' },
      { at, kind: 'read', text: 'https://example.org/papers/bidir' },
      { at, kind: 'read', text: 'javascript:alert(1)' },
    ],
  });
  const desk = (running: boolean, panel: DeskPanel | null): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        research: research(running),
      } as never,
      { view: 'research', panel, ...(panel ? { direction: 'bidir' } : {}) },
    ).html;
  const view = desk(true, null);
  // Each search and page of the step, newest first. Only a web address becomes a link.
  assert.match(
    view,
    /Sources so far<\/h2><span class="count">1 search, 2 pages read/,
  );
  assert.match(
    view,
    /<a href="https:\/\/example\.org\/papers\/bidir" target="_blank" rel="noopener noreferrer">example\.org\/papers\/bidir<\/a>/,
  );
  assert.match(view, /<span>javascript:alert\(1\)<\/span>/);
  assert.doesNotMatch(view, /href="javascript:/);
  // One row for each direction, with its lead, its checks, and its sources.
  assert.match(
    view,
    /data-direction="bidir" aria-pressed="false">Bidirectional Dijkstra<\/button><span class="selected-label">Proposed<\/span><\/th><td data-label="Its case">Replication\.<\/td><td data-label="Checks">2<\/td><td data-label="Sources">1<\/td>/,
  );
  assert.match(
    view,
    /data-direction="alt" aria-pressed="false">ALT with few landmarks[\s\S]*<td data-label="Sources">0<\/td>/,
  );
  // The panel of a direction holds its case, its checks, its sources, and the choice.
  const panel = desk(false, 'direction');
  assert.match(panel, /data-direction="bidir" aria-pressed="true"/);
  assert.match(
    panel,
    /<h2 id="panel-title" tabindex="-1">Bidirectional Dijkstra<\/h2>/,
  );
  assert.match(
    panel,
    /Its checks<\/h3><ul class="checks-list"><li>Distances match\.<\/li>/,
  );
  assert.match(
    panel,
    /data-action="select" data-idea="bidir">Choose this direction<\/button><\/div><p class="fine">The coordinator then drafts the plan for it\./,
  );
  // While a step runs, a direction cannot be chosen.
  assert.doesNotMatch(desk(true, 'direction'), /data-action="select"/);
});

await test('desk leads Answer with the answer and its sign-off, then the checks', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    candidates: [
      {
        id: 'bidir',
        title: 'Bidirectional search',
        recommendation: 'A pilot.',
        gates: [
          'Distances match.',
          'Settled nodes fall by 30 percent.',
          'The gain survives a control.',
        ],
      },
    ],
    selectedId: 'bidir',
  }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-05T12:00:00.000Z';
  const results = (decision?: object): object => ({
    schemaVersion: 1,
    direction: 'bidir',
    checks: [
      {
        check: 1,
        result: 'passed',
        value: '0 mismatches in 1,800 queries',
        evidence: ['results/summary.json'],
        reason: 'Every query matches.',
        at,
      },
      {
        check: 2,
        result: 'judgement',
        value: '7 of 9 groups gain 30 percent',
        evidence: ['results/summary.json'],
        reason: 'The check does not say whether every group must gain.',
        question: 'Does a gain in 7 of 9 groups count as a pass?',
        at,
      },
    ],
    answer: {
      statement: 'Bidirectional search settles fewer nodes in most groups.',
      claims: [
        {
          text: 'Distances match.',
          evidence: [
            'results/summary.json',
            'https://arxiv.org/abs/1504.05140',
          ],
        },
      ],
      at,
      ...(decision ? { decision } : {}),
    },
  });
  const desk = (
    view: DeskView,
    decision?: object,
  ): ReturnType<typeof renderDesk> =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list: [], selected: null, idle: [], messages: [] },
        coordinator: {
          state: {
            objective: 'Pilot.',
            host: 'claude',
            model: null,
            startedAt: at,
            stoppedAt: null,
            session: 'C1',
            created: 0,
            planApproved: true,
            cursor: 0,
            wakeups: [],
            events: [],
            actions: [],
          },
          session: {
            live: true,
            saveFailed: false,
            record: { id: 'C1', status: 'idle', host: 'claude' },
          },
          waiting: 0,
          limitedUntil: null,
          results: results(decision),
        },
      } as never,
      { view, panel: null },
    );
  const view = desk('results');
  // The answer leads. The checks follow, each with its result. A check without a report says so.
  assert.match(
    view.html,
    /<h1 id="view-title" tabindex="-1">Answer<\/h1>[\s\S]*id="answer-title"[\s\S]*id="checks-title"/,
  );
  assert.match(view.html, /2 of 3 reported/);
  assert.match(
    view.html,
    /data-result="passed"[\s\S]*Distances match\.[\s\S]*0 mismatches in 1,800 queries[\s\S]*<code>results\/summary\.json<\/code>[\s\S]*<span class="check-result">Passed<\/span>/,
  );
  assert.match(
    view.html,
    /data-result="judgement"[\s\S]*Does a gain in 7 of 9 groups count as a pass\?[\s\S]*data-action="coordinator-rule" data-check="2" data-result="partial">It partly passed/,
  );
  assert.match(
    view.html,
    /data-result="none"[\s\S]*The gain survives a control\.[\s\S]*Not reported yet/,
  );
  // The answer cannot be accepted while a judgement is open.
  assert.match(
    view.html,
    /The answer<\/h2><span class="tag reading">The coordinator's reading<\/span>/,
  );
  assert.match(view.html, /<a href="https:\/\/arxiv\.org\/abs\/1504\.05140"/);
  assert.match(view.html, /Settle the 1 open judgement below first\./);
  assert.match(
    view.html,
    /data-action="coordinator-answer" data-decision="accepted" disabled>Accept the answer/,
  );
  // Needs you lists the judgement and the sign-off. The rail counts them on Answer. The arc waits at the answer.
  assert.deepEqual(
    view.needs.map((item) => item.title),
    [
      'Check 2: Does a gain in 7 of 9 groups count as a pass?',
      'The answer waits for your sign-off',
    ],
  );
  assert.match(
    view.html,
    /<span>Answer<\/span><span class="n"><span aria-hidden="true">◆ <\/span>2/,
  );
  assert.equal(view.stage, 'Answer: waits for you');
  // After the sign-off the answer stays, marked with its time.
  const accepted = desk('results', { kind: 'accepted', at });
  assert.match(accepted.html, /You accepted the answer at/);
  assert.equal(accepted.stage, 'Answer: accepted');
});

await test('the message box writes to the agent that leads, or to a task agent, and says how far each message got', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-12T14:00:00.000Z';
  const message = (
    id: string,
    to: string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    id,
    at,
    from: 'person',
    to,
    kind: 'note',
    text,
    delivery: 'queued',
    ...extra,
  });
  const task = (id: string, state: string, session: string | null) => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    claim: null,
    artifacts: [],
    attempts: session
      ? [{ number: 1, revision: 1, startedAt: at, session, versions: [] }]
      : [],
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title: id === 'task-1' ? 'Profile the heap' : 'Write up',
      objective: 'Run.',
      host: 'claude',
      dependencies: [],
      inputs: [],
      writable: ['results'],
      output: 'results/x.md',
      minutes: 20,
    },
  });
  const render = (
    view: DeskView,
    live: Record<string, unknown>,
    messages: readonly Record<string, unknown>[],
  ): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list: [], selected: null, idle: [], messages },
        ...live,
      } as never,
      { view, panel: null },
    ).html;
  const dock = (html: string): string =>
    /<section class="dock"[\s\S]*<\/section>/.exec(html)?.[0] ?? '';
  // Before a direction, research leads. Its messages wait for its next step.
  const research = {
    research: { running: true, step: 'Searching', events: [], startedAt: at },
  };
  const early = dock(
    render('research', research, [
      message('m-1', 'research', 'Compare against the textbook heap.', {
        delivery: 'delivered',
        deliveredAt: at,
      }),
      message('m-2', 'research', 'Also look at contraction hierarchies.'),
    ]),
  );
  assert.match(
    early,
    /<option value="research" data-hint="Write to research">Research, leads now<\/option>/,
  );
  assert.match(
    early,
    /Delivered with a research step[\s\S]*Waits for the next research step/,
  );
  // The coordinator leads after it starts. Running and reviewed task agents are in To; open tasks are not.
  const coordinator = {
    coordinator: {
      state: {
        objective: 'Heap',
        host: 'claude',
        stoppedAt: null,
        planApproved: true,
        wakeups: [],
        events: [],
        actions: [],
      },
      session: {
        live: true,
        saveFailed: false,
        record: { id: 'C1', status: 'running', host: 'claude', events: [] },
      },
      waiting: 1,
      limitedUntil: null,
    },
  };
  const tasks = (messages: readonly Record<string, unknown>[]) => ({
    tasks: {
      list: [task('task-1', 'running', 'S1'), task('task-2', 'open', null)],
      selected: null,
      idle: [],
      messages,
    },
  });
  const work = dock(
    render(
      'tasks',
      {
        ...coordinator,
        ...tasks([
          message('m-3', 'coordinator', 'Use 5 runs.'),
          message('m-4', 'task-1', 'Skip the USA graph.', {
            delivery: 'sent',
            via: 'turn',
          }),
          message('m-5', 'task-1', 'Profile Florida too.', {
            delivery: 'delivered',
            via: 'turn',
            answer: { at, text: 'Understood. I add Florida.' },
          }),
        ]),
      },
      [],
    ),
  );
  assert.match(
    work,
    /<option value="coordinator"[^>]*>Coordinator, leads now<\/option><option value="task-1" data-hint="Write to Profile the heap">Profile the heap<\/option><option value="new-agent"[^>]*>A new agent<\/option><\/select>/,
  );
  assert.match(
    work,
    /data-thread="coordinator">[\s\S]*Waits for its current turn to end/,
  );
  assert.match(
    work,
    /data-thread="task-1" hidden>[\s\S]*Sent, it arrives at its next step[\s\S]*Answered[\s\S]*Profile Florida too\.[\s\S]*dock-answer[\s\S]*Understood\. I add Florida\./,
  );
  // The box is on Home, Plan, and Work only.
  assert.match(render('home', coordinator, []), /id="message-text"/);
  assert.doesNotMatch(render('records', coordinator, []), /id="message-text"/);
  // A desk that controls sessions can always start a new agent. A desk that only reads has no box.
  assert.match(render('home', {}, []), /id="message-text"/);
  assert.doesNotMatch(
    render('home', { controllable: false }, []),
    /id="message-text"/,
  );
});

await test('a draft task waits for the person in the message box, on the map, in the rail, and in Needs you', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-12T14:25:00.000Z';
  const draft = {
    id: 'task-4',
    state: 'open',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    claim: null,
    artifacts: [],
    attempts: [],
    assignment: {
      by: 'coordinator',
      draft: true,
      reason: 'Created by the coordinator: the person asked for it.',
      title: 'Time the scan on 3 more graphs',
      objective: 'Time the scan on Colorado, Florida, and the Northwest.',
      host: 'codex',
      hostReason: 'The scan came from Codex',
      dependencies: [],
      inputs: [],
      writable: ['results/scan-extra.csv'],
      output: 'results/scan-extra.csv',
      minutes: 20,
    },
  };
  const coordinator = (stoppedAt: string | null) => ({
    state: {
      objective: 'Heap',
      host: 'claude',
      stoppedAt,
      planApproved: true,
      wakeups: [],
      events: [],
      actions: [],
    },
    session: {
      live: true,
      saveFailed: false,
      record: { id: 'C1', status: 'idle', host: 'claude', events: [] },
    },
    waiting: 0,
    limitedUntil: null,
  });
  const render = (
    view: DeskView,
    lead: unknown,
    panel: DeskPanel | null = null,
  ): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list: [draft], selected: draft, idle: [], messages: [] },
        coordinator: lead,
      } as never,
      { view, panel },
    ).html;
  const work = render('tasks', coordinator(null));
  const page = render('task', coordinator(null));
  const dock = /<section class="dock"[\s\S]*<\/section>/.exec(work)?.[0] ?? '';
  assert.match(
    dock,
    /data-thread="coordinator">[\s\S]*The coordinator drafted a task[\s\S]*Time the scan on 3 more graphs[\s\S]*Codex: The scan came from Codex\. Writes results\/scan-extra\.csv\. Up to 20 min for each turn\.[\s\S]*data-action="task-start" data-task="task-4">Start it[\s\S]*data-message-to="coordinator" data-about="Time the scan on 3 more graphs">Change it[\s\S]*data-task-select="task-4">Write the task yourself/,
  );
  assert.match(
    work,
    /class="map-box"[^>]*data-state="open" data-draft[\s\S]*?Draft, waits for you/,
  );
  assert.match(work, /◆ Draft, waits for you/);
  // Write the task yourself opens the task with its form, and the page offers Change it too.
  assert.match(page, /<details id="task-edit" open>/);
  assert.match(
    page,
    /The coordinator drafted this task for you[\s\S]*data-action="task-start" data-task="task-4">Start task[\s\S]*data-message-to="coordinator" data-about="Time the scan on 3 more graphs">Change it/,
  );
  const needs = render('needs', coordinator(null));
  assert.match(
    needs,
    /Draft task[\s\S]*Time the scan on 3 more graphs[\s\S]*You asked the coordinator for new work/,
  );
  // The Needs view has the message box, so Change it works there. The draft shows once: Needs you lists it.
  assert.match(needs, /id="message-text"/);
  assert.equal(needs.split('The coordinator drafted').length, 1);
  assert.equal(
    needs.split('data-action="task-start" data-task="task-4"').length,
    2,
  );
  // Without a running coordinator, the box offers a new one.
  for (const lead of [null, coordinator(at)])
    assert.match(
      render('home', lead),
      /<option value="new-coordinator" data-hint="Write the objective for a new coordinator">A new coordinator, leads now<\/option>/,
    );
});

await test('Work starts with who works now, folds a long strip, and ends with the finished work', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-12T14:00:00.000Z';
  const task = (id: string, state: string, extra: object = {}) => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    claim: null,
    artifacts: [],
    attempts: [
      {
        number: 1,
        revision: 1,
        startedAt: at,
        session: `S-${id}`,
        versions:
          state === 'review'
            ? [{ number: 1, at, decision: null, files: [] }]
            : [],
      },
    ],
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title: `Title ${id}`,
      objective: 'Run.',
      host: 'codex',
      dependencies: [],
      inputs: [],
      writable: ['results'],
      output: 'results/x.md',
      minutes: 20,
    },
    ...extra,
  });
  const list = [
    task('task-1', 'review'),
    ...['task-2', 'task-3', 'task-4', 'task-5'].map((id) =>
      task(id, 'running'),
    ),
    task('task-6', 'done', {
      artifacts: [
        {
          version: 2,
          revision: 1,
          at: '2026-10-12T14:12:00.000Z',
          files: [{ path: 'results/bench.csv' }],
        },
      ],
    }),
    task('task-7', 'done', {
      artifacts: [
        {
          version: 1,
          revision: 1,
          at: '2026-10-12T14:40:00.000Z',
          files: [{ path: 'src/heap.py' }],
        },
      ],
    }),
  ];
  const work = (coordinator: unknown): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list, selected: null, idle: [], messages: [] },
        coordinator,
      } as never,
      { view: 'tasks', panel: null },
    ).html;
  const alone = work(null);
  // Running agents come first. Four rows show, and the rest fold.
  assert.match(
    alone,
    /<span class="count">4 agents work, 1 version waits for review<\/span>/,
  );
  const strip =
    /<section class="card now-strip"[\s\S]*?<\/section>/.exec(alone)?.[0] ?? '';
  assert.equal(strip.split('class="now-row"').length - 1, 5);
  assert.match(
    strip,
    /<details id="now-more"><summary>1 more<\/summary>[\s\S]*Title task-1/,
  );
  assert.match(strip, /Codex, \d+ h( \d+ min)?<\/span>/);
  // Without a coordinator, the review is the person's.
  assert.match(
    strip,
    /now-step yours">Version 1 waits for your review<\/p><\/div><button type="button" class="primary" data-task-select="task-1">Review<\/button>/,
  );
  // With a coordinator, the coordinator reviews.
  assert.match(
    work({
      state: {
        objective: 'Heap',
        host: 'claude',
        stoppedAt: null,
        planApproved: true,
        wakeups: [],
        events: [],
        actions: [],
      },
      session: null,
      waiting: 0,
      limitedUntil: null,
    }),
    /now-step">The coordinator reviews version 1<\/p><\/div><button type="button" data-task-select="task-1">Review<\/button>/,
  );
  // The finished work follows the map, newest first.
  assert.match(
    alone,
    /<h2 id="map-title">The map<\/h2><span class="count">7 tasks, 2 done<\/span>[\s\S]*<h2 id="finished-title">Finished<\/h2>[\s\S]*Title task-7[\s\S]*Version 1 accepted at [\s\S]*src\/heap\.py[\s\S]*Title task-6[\s\S]*results\/bench\.csv/,
  );
  assert.doesNotMatch(alone, /A task runs your harness in its own copy/);
});

await test('a task opens as its own page: the decision first, the rest folded, and titles instead of IDs', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-12T14:00:00.000Z';
  const task = (id: string, state: string, extra: object = {}) => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    claim: null,
    artifacts: [],
    attempts: [],
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title:
        id === 'task-1'
          ? 'Implement the heap version'
          : 'Benchmark both versions',
      objective: 'Time both versions on 9 road graphs.',
      host: 'claude',
      model: null,
      dependencies: id === 'task-1' ? [] : ['task-1'],
      inputs: [],
      writable: ['results'],
      output: 'results/bench.csv',
      minutes: 20,
    },
    ...extra,
  });
  const attempt = (versions: object[]) => ({
    number: 1,
    revision: 1,
    startedAt: at,
    session: 'S2',
    restrictions: [],
    outcome: null,
    note: null,
    consumed: [{ task: 'task-1', version: 1 }],
    versions,
  });
  const version = {
    number: 1,
    commit: 'c',
    at,
    turn: 'completed',
    decision: null,
    skipped: [],
    reply: 'The heap version is faster on every graph above 100,000 nodes.',
    files: [
      {
        path: 'results/bench.csv',
        change: 'added',
        inScope: true,
        regular: true,
      },
    ],
  };
  const page = (shown: object, first = task('task-1', 'open')): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: {
          list: [first, shown],
          selected: shown,
          idle: ['S2'],
          messages: [],
        },
      } as never,
      { view: 'task', panel: null },
    ).html;
  const text = (html: string): string =>
    (/<main id="view"[\s\S]*<\/main>/.exec(html)?.[0] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
  // Open and waiting: the dependency by title, and Start task off.
  const open = page(task('task-2', 'open'));
  assert.match(
    open,
    /<button type="button" class="quiet back" data-view="tasks">← Back to the map<\/button>/,
  );
  assert.match(
    open,
    /<h1 id="view-title" tabindex="-1">Benchmark both versions<\/h1>/,
  );
  assert.match(
    open,
    /This task waits for Implement the heap version\.[\s\S]*data-action="task-start" data-task="task-2" disabled/,
  );
  assert.match(open, /<details id="task-edit">/);
  // Work is the current view in the rail.
  assert.match(open, /data-view="tasks" aria-current="page"/);
  // In review: the version and what the agent says come before the files and the details.
  const review = page(
    task('task-2', 'review', { attempts: [attempt([version])] }),
    task('task-1', 'done'),
  );
  assert.match(
    review,
    /Claude Code made version 1 at [^.]+\. It received files from Implement the heap version\.[\s\S]*Version 1: the turn ended[\s\S]*The agent says[\s\S]*<p class="pre">The heap version is faster on every graph above 100,000 nodes\.<\/p>[\s\S]*data-action="task-accept" data-task="task-2" data-version="1">Accept 1 file[\s\S]*data-message-to="task-2">Ask for changes[\s\S]*data-action="task-reject"[\s\S]*<details id="task-files"><summary><h2>1 file changed<\/h2>[\s\S]*<details id="task-details">[\s\S]*<dt>Received<\/dt><dd>Implement the heap version version 1<\/dd>[\s\S]*<details id="task-activity">[\s\S]*data-source="session:S2"/,
  );
  assert.doesNotMatch(text(review), /task-\d/);
  assert.doesNotMatch(review, /The coordinator reviews this version/);
  // The box writes to the agent of the page.
  assert.match(
    review,
    /<option value="task-2" data-hint="Write to Benchmark both versions" selected>/,
  );
  // Running: its latest step, Message, and Stop the turn.
  const running = page(
    task('task-2', 'running', { attempts: [attempt([])] }),
    task('task-1', 'done'),
  );
  assert.match(
    running,
    /<h2>The agent works<\/h2>[\s\S]*class="primary" data-message-to="task-2">Message[\s\S]*data-action="task-stop" data-task="task-2">Stop the turn/,
  );
  // Done and cancelled.
  assert.match(
    page(
      task('task-2', 'done', {
        artifacts: [
          {
            version: 1,
            revision: 1,
            at,
            files: [{ path: 'results/bench.csv' }],
          },
        ],
      }),
    ),
    /<h2>Done<\/h2><p>Version 1 was accepted: results\/bench\.csv\.[\s\S]*Revise the task/,
  );
  assert.match(page(task('task-2', 'cancelled')), /<h2>Cancelled<\/h2>/);
});

await test('a session that the person started shows in the Now strip and in To', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-12T14:00:00.000Z';
  const session = (status: string) => ({
    live: true,
    saveFailed: false,
    record: {
      schemaVersion: 2,
      id: '20261012T140000000Z-abcdef12',
      host: 'codex',
      model: null,
      mode: 'auto',
      reportedMode: 'auto_review',
      nativeSessionId: 'thread-1',
      status,
      startedAt: at,
      endedAt: null,
      costUsd: null,
      commands: [],
      requests: [],
      launches: [],
      events: [
        {
          at,
          kind: 'you',
          text: 'Read src/heap.py and suggest a faster decrease-key.',
        },
        { at, kind: 'tool', text: 'Command: cat src/heap.py' },
      ],
    },
  });
  const work = (status: string): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        workers: [session(status)],
        controllable: true,
        tasks: { list: [], selected: null, idle: [], messages: [] },
      } as never,
      { view: 'tasks', panel: null },
    ).html;
  // Work has no task yet, so the strip shows only with tasks. Home's box lists the session.
  const busy = renderDesk(snapshot, undefined, null, {
    session: null,
    workers: [session('running')],
    controllable: true,
    tasks: { list: [], selected: null, idle: [], messages: [] },
  } as never).html;
  assert.match(
    busy,
    /<option value="session:20261012T140000000Z-abcdef12" data-hint="Write to Codex: Read src\/heap\.py and suggest a faster[^"]*">Codex: Read src\/heap\.py[^<]*<\/option><option value="new-agent"/,
  );
  // The session's thread is its exchange.
  assert.match(
    busy,
    /data-thread="session:20261012T140000000Z-abcdef12"><li class="dock-msg">[\s\S]*Read src\/heap\.py and suggest a faster decrease-key\./,
  );
  // Work lists it in the Now strip, with Message, also before any task exists.
  assert.match(
    work('running'),
    /<span class="count">1 agent works<\/span>[\s\S]*data-worker="20261012T140000000Z-abcdef12">Codex: Read src\/heap\.py[^<]*<\/button><span class="now-meta">Auto \(Codex reviewer\), \d+ (min|h)[^<]*<\/span>[\s\S]*Running cat[\s\S]*data-message-to="session:20261012T140000000Z-abcdef12">Message/,
  );
  assert.match(work('idle'), /Waits for your next message/);
  assert.match(work('idle'), /No tasks yet/);
});

await test('Clear finished takes done and cancelled tasks off the map and the rail', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-12T14:00:00.000Z';
  const task = (id: string, state: string, dependencies: string[] = []) => ({
    id,
    state,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    claim: null,
    artifacts: [],
    attempts: [],
    assignment: {
      by: 'coordinator',
      reason: 'Part of the plan.',
      title: `Title ${id}`,
      objective: 'Run.',
      host: 'claude',
      dependencies,
      inputs: [],
      writable: ['results'],
      output: 'results/x.md',
      minutes: 20,
    },
  });
  const list = [
    task('task-1', 'done'),
    task('task-2', 'cancelled'),
    task('task-3', 'open', ['task-1']),
  ];
  const work = (hidden: boolean): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        tasks: { list, selected: null, idle: [], messages: [] },
      } as never,
      parseFrame('tasks', null, null, null, hidden ? 'hidden' : null) ?? {
        view: 'tasks',
        panel: null,
      },
    ).html;
  const shown = work(false);
  assert.match(shown, /data-finished="hidden">Clear finished/);
  assert.match(shown, /data-node="task-1"/);
  assert.match(shown, /data-node="task-3"[^>]*data-from="task-1"/);
  const cleared = work(true);
  assert.match(cleared, /data-finished="shown">Show finished \(2\)/);
  assert.doesNotMatch(cleared, /data-node="task-1"|data-node="task-2"/);
  // The arrow of a cleared task goes; the open task hangs from the objective.
  assert.match(cleared, /data-node="task-3"[^>]*data-from="objective"/);
  assert.match(cleared, /2 finished tasks are not on the map/);
  // The rail leaves them out too. Finished still lists the done task.
  const rail = /<nav class="rail"[\s\S]*?<\/nav>/.exec(cleared)?.[0] ?? '';
  assert.doesNotMatch(rail, /Title task-1/);
  assert.match(rail, /Title task-3/);
  assert.match(
    cleared,
    /<h2 id="finished-title">Finished<\/h2>[\s\S]*Title task-1/,
  );
  assert.equal(parseFrame('tasks', null, null, null, 'all'), null);
});

await test('the review pass: the page says who reviews, the Plan says the direction is chosen, and a step names its script', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, (state) => ({
    ...state!,
    candidates: [
      {
        id: 'heap',
        title: 'Heap',
        recommendation: 'Compare.',
        gates: ['Same paths.'],
        kind: 'main',
      },
    ],
    selectedId: 'heap',
  }));
  const snapshot = await readDeskSnapshot(root);
  const at = '2026-10-12T14:00:00.000Z';
  const task = {
    id: 'task-1',
    state: 'review',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    claim: null,
    artifacts: [],
    attempts: [
      {
        number: 1,
        revision: 1,
        startedAt: at,
        session: 'S1',
        restrictions: [],
        consumed: [],
        versions: [
          {
            number: 1,
            commit: 'c',
            at,
            turn: 'completed',
            decision: null,
            skipped: [],
            files: [],
          },
        ],
      },
    ],
    assignment: {
      by: 'coordinator',
      reason: 'Plan.',
      title: 'Benchmark',
      objective: 'Run.',
      host: 'claude',
      model: null,
      dependencies: [],
      inputs: [],
      writable: ['results'],
      output: 'x',
      minutes: 20,
    },
  };
  const coordinator = {
    state: {
      objective: 'Heap',
      host: 'claude',
      stoppedAt: null,
      planApproved: true,
      wakeups: [],
      events: [],
      actions: [],
    },
    session: null,
    waiting: 0,
    limitedUntil: null,
  };
  const render = (view: DeskView, extra: object = {}): string =>
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: null,
        controllable: true,
        coordinator,
        tasks: { list: [task], selected: task, idle: ['S1'], messages: [] },
        ...extra,
      } as never,
      { view, panel: null },
    ).html;
  assert.match(
    render('task'),
    /The coordinator reviews this version\. You can decide first\./,
  );
  assert.match(
    render('research'),
    /<h1 id="view-title" tabindex="-1">Plan<\/h1><p>Direction chosen<\/p>/,
  );
  // A running agent's step names the script, also after options.
  const running = {
    ...task,
    state: 'running',
    attempts: [{ ...task.attempts[0], versions: [] }],
  };
  const worker = {
    live: true,
    saveFailed: false,
    record: {
      id: 'S1',
      host: 'claude',
      status: 'running',
      mode: 'strict',
      task: { id: 'task-1', claim: 'c' },
      requests: [],
      commands: [],
      startedAt: at,
      events: [
        {
          at: new Date().toISOString(),
          kind: 'tool',
          text: 'Bash: python -m cProfile -o out.prof bench.py --graph california',
        },
      ],
    },
  };
  assert.match(
    renderDesk(
      snapshot,
      undefined,
      null,
      {
        session: worker,
        workers: [worker],
        controllable: true,
        coordinator,
        tasks: { list: [running], selected: null, idle: [], messages: [] },
      } as never,
      { view: 'tasks', panel: null },
    ).html,
    /now-step">Running python bench\.py</,
  );
  // Records leads with what ran. Its runs come last, with what moves and stays folded.
  const records = render('records', {
    archives: [
      {
        id: '20261012T101500000Z-a1b2c3',
        at,
        bytes: 2048,
        tasks: 3,
        direction: 'Heap against a scan',
      },
    ],
  });
  assert.match(
    records,
    /<h2 id="commands-title">Commands[\s\S]*Research attempts[\s\S]*<h2 id="runs-title">Runs<\/h2>[\s\S]*<details id="run-parts"><summary>What moves and what stays<\/summary>[\s\S]*Heap against a scan <span class="fine">3 tasks, 2 KB<\/span>[\s\S]*<h2 id="memory-title">Project memory<\/h2>/,
  );
});
