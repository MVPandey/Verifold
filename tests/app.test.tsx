import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Call,
  Direction,
  Lab,
  Post,
  Snapshot,
} from '../src/protocol/api.ts';
import { act, parseEvents, takeToken } from '../src/app/api.ts';
import { threads } from '../src/app/board.ts';
import { asked, due, span, usd } from '../src/app/format.ts';
import { afterSend, intentFor, unansweredAfter } from '../src/app/intent.ts';
import { parseRoute } from '../src/app/route.ts';
import { LabStore, newer, type LabState } from '../src/app/store.ts';
import { Screen } from '../src/app/App.tsx';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';
import { runCli, terminalInput } from '../src/cli/commands.ts';
import { startDesk } from '../src/server/desk.ts';
import type { SessionPool } from '../src/core/workers.ts';
import { exchangeLaunch, readFragment, storedToken } from '../src/ui/token.ts';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

function agent(
  id: string,
  handle: string,
  harness: 'claude' | 'codex',
  direction: string,
  live: Agent['live'],
): Agent {
  return {
    id,
    handle,
    harness,
    model: harness === 'claude' ? 'opus[1m]' : 'gpt-6-astra',
    direction,
    check: null,
    status: live.state === 'working' ? 'working' : 'idle',
    until: null,
    live,
    turns: { turns: [], more: false },
    spendUsd: harness === 'claude' ? 0.8 : null,
  };
}

function direction(
  id: string,
  title: string,
  agentId: string,
  fields: Partial<Direction> = {},
): Direction {
  return {
    id,
    title,
    bar: null,
    runs: 3,
    noise: null,
    buildsOn: [],
    state: 'open',
    verdict: 'open',
    disputed: false,
    evidence: null,
    agent: agentId,
    openedBy: 'a-0',
    openedAt: ago(180),
    stoppedAt: null,
    head: 'a3f9c2e',
    ...fields,
  };
}

function post(
  id: string,
  author: string,
  kind: Post['kind'],
  text: string,
  fields: Partial<Post> = {},
): Post {
  const handles: Record<string, [string, 'claude' | 'codex']> = {
    'a-1': ['claude-1', 'claude'],
    'a-2': ['claude-2', 'claude'],
    'a-4': ['codex-2', 'codex'],
  };
  const known = handles[author];
  return {
    id,
    at: ago(30),
    author,
    handle: known?.[0] ?? null,
    harness: known?.[1] ?? null,
    kind,
    direction: null,
    text,
    replyTo: null,
    mentions: [],
    proof: [],
    ...fields,
  };
}

const call: Call = {
  id: 'c-4',
  at: ago(12),
  kind: 'cost',
  question: 'Rent an H100 for the probe reruns?',
  why: 'Seeds 2 and 3 need a GPU.',
  askers: [
    {
      agent: 'a-2',
      handle: 'claude-2',
      direction: 'd-2',
      why: 'Seeds 2 and 3.',
    },
    { agent: 'a-4', handle: 'codex-2', direction: 'd-4', why: 'The same run.' },
  ],
  byVerifold: false,
  options: [
    {
      label: 'Rent 1 H100 for 3 hours',
      usd: 11.97,
      minutes: 180,
      effect: {
        type: 'pod',
        gpu: 'H100 SXM',
        hours: 3,
        secrets: 0,
        missing: 0,
      },
    },
    { label: 'Use this Mac', usd: 0, minutes: 540, effect: null },
  ],
  pick: 0,
  undoMinutes: 10,
  state: 'open',
  answer: null,
  words: null,
  undoUntil: null,
  note: null,
  post: 'p-12',
};

/** The story of the v9 canvas's lab artboard. */
function story(fields: Partial<Lab> = {}): Snapshot {
  const lab: Lab = {
    question:
      "Can cheap training methods make a model's chain of thought match its internal reasoning?",
    postLimit: 4000,
    startedAt: ago(600),
    agentsHere: true,
    paused: null,
    budget: {
      hours: 72,
      deadline: new Date(Date.UTC(2026, 9, 24, 1, 0)).toISOString(),
    },
    money: { plansUsd: 3.1, gpuUsd: 4.2, gpuLimitUsd: 25 },
    needsYou: [call],
    answered: [],
    directions: [
      direction('d-1', 'The CoT names what drives the answer', 'a-1', {
        verdict: 'holds-up',
        evidence: {
          text: 'Cue named 64% vs 41% for the control · 3 of 3 seeds · Codex reran it',
          post: 'p-5',
          run: 'r-6',
        },
      }),
      direction('d-2', 'The CoT matches what probes read inside', 'a-2', {
        disputed: true,
        evidence: {
          text: 'Gap 34% smaller on seed 1',
          post: 'p-9',
          run: 'r-3',
        },
      }),
      direction('d-3', 'The answer follows what the CoT says', 'a-3'),
      direction('d-4', 'Gains survive pressure from a monitor', 'a-4'),
    ],
    agents: [
      agent('a-1', 'claude-1', 'claude', 'd-1', {
        state: 'idle',
        text: 'Between turns',
        since: ago(20),
      }),
      agent('a-2', 'claude-2', 'claude', 'd-2', {
        state: 'waiting',
        text: 'Waiting for you',
        since: ago(12),
      }),
      agent('a-3', 'codex-1', 'codex', 'd-3', {
        state: 'working',
        text: 'Running plant_errors.py',
        since: ago(6),
      }),
      agent('a-4', 'codex-2', 'codex', 'd-4', {
        state: 'working',
        text: 'Searching the web',
        since: ago(1),
      }),
    ],
    plan: null,
    board: {
      posts: [
        post(
          'p-9',
          'a-2',
          'claim',
          'After the filter, the gap between "the probe knows" and "the CoT says it" is 34% smaller on seed 1.',
          {
            direction: 'd-2',
            proof: [
              { type: 'run', run: 'r-3' },
              {
                type: 'figure',
                direction: 'd-2',
                path: 'figures/gap.png',
                commit: 'a3f9c2e',
                bytes: 2048,
              },
            ],
          },
        ),
        post(
          'p-10',
          'a-4',
          'objection',
          'One seed can be luck, and the control CoTs were shorter. Rerun with a length-matched control.',
          { replyTo: 'p-9' },
        ),
        post(
          'p-11',
          'a-2',
          'status',
          'Agreed. Seeds 2 and 3 need a GPU, so I asked you.',
          {
            replyTo: 'p-10',
          },
        ),
        post(
          'p-13',
          'person',
          'question',
          'If budget is left, try Gemma as a second model family.',
        ),
        post(
          'p-14',
          'a-1',
          'status',
          'Added it to the plan after checking the newest Gemma release.',
          { replyTo: 'p-13' },
        ),
      ],
      more: false,
    },
    disputes: [],
    runs: [],
    checks: [],
    signoff: null,
    works: [],
    away: null,
    omitted: {},
    ...fields,
  };
  return {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 7,
    at: ago(0),
    project: 'CoT faithfulness',
    lab,
    trimmed: false,
  };
}

const actions: LabActions = {
  post: () => Promise.resolve({ ok: true }),
  pause: () => Promise.resolve({ ok: true }),
  answer: () => Promise.resolve({ ok: true }),
  words: () => Promise.resolve({ ok: true }),
  undo: () => Promise.resolve({ ok: true }),
  skip: () => Promise.resolve({ ok: true }),
  questions: () => Promise.resolve({ ok: true }),
};

const agentActions: AgentActions = {
  message: () => Promise.resolve({ ok: true }),
  turns: () => Promise.resolve({ error: 'not in this test' }),
  turn: () => Promise.resolve({ error: 'not in this test' }),
  thread: () => Promise.resolve({ error: 'not in this test' }),
};

function render(
  snapshot: Snapshot | null,
  connection: LabState['connection'] = 'live',
  hash = '#/',
  retrying = false,
): string {
  return renderToStaticMarkup(
    <Screen
      state={{ snapshot, connection, retrying }}
      route={parseRoute(hash)}
      now={now}
      actions={actions}
      agentActions={agentActions}
    />,
  );
}

/** Visible text, with tags removed and entities decoded, so assertions read as the page reads. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Wait until `done()` holds, for at most two seconds. */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !done(); tries++) await delay(10);
  assert.ok(done(), 'the condition never held');
}

/** A stream response with one snapshot event. It closes when `close`, else when `signal` aborts. */
function stream(
  snapshot: object,
  signal: AbortSignal | null | undefined,
  close = false,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
        ),
      );
      if (close) controller.close();
      else
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError')),
        );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** The globals that each test replaced, as they were before its first change. */
const originals = new WeakMap<
  test.TestContext,
  Map<string, PropertyDescriptor | undefined>
>();

/** Replace a global for one test. A second replacement keeps the first original, which comes back after the test. */
function stub(t: test.TestContext, name: string, value: unknown): void {
  let saved = originals.get(t);
  if (!saved) {
    saved = new Map();
    originals.set(t, saved);
  }
  if (!saved.has(name)) {
    const had = Object.getOwnPropertyDescriptor(globalThis, name);
    saved.set(name, had);
    t.after(() => {
      if (had) Object.defineProperty(globalThis, name, had);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

await test('format helpers write money, spans, deadlines and askers plainly', () => {
  assert.equal(usd(25), '$25');
  assert.equal(usd(4.2), '$4.20');
  assert.equal(span(40_000), '40 s');
  assert.equal(span(6 * 60_000), '6 min');
  assert.equal(span(80 * 60_000), '1 h 20 min');
  assert.equal(span(50 * 3_600_000), '2 days');
  assert.equal(asked([]), 'Verifold asks');
  assert.equal(asked(call.askers), 'claude-2 and codex-2 asked');
  assert.equal(
    asked([
      ...call.askers,
      { agent: 'a-3', handle: 'codex-1', direction: 'd-3', why: '' },
    ]),
    'claude-2, codex-2 and codex-1 asked',
  );
});

await test('a deadline names its weekday within six days, and its date further out, in the past, or a week ahead', () => {
  // Local times, so the test holds in any time zone. Tuesday 20 Oct 2026, 22:00.
  const tuesday = new Date(2026, 9, 20, 22, 0).getTime();
  const local = (month: number, day: number, hour: number): string =>
    new Date(2026, month, day, hour, 0).toISOString();
  assert.equal(due(local(9, 23, 18), tuesday), 'Fri 18:00');
  assert.equal(due(local(9, 26, 7), tuesday), 'Mon 07:00');
  // Six days or more: the date as well.
  assert.equal(due(local(9, 27, 7), tuesday), 'Tue 27 Oct, 07:00');
  assert.equal(due(local(10, 2, 7), tuesday), 'Mon 2 Nov, 07:00');
  // Today's weekday next week, even under six days from late tonight.
  const lateTuesday = new Date(2026, 9, 20, 23, 30).getTime();
  assert.equal(due(local(9, 27, 0), lateTuesday), 'Tue 27 Oct, 00:00');
  // A deadline that passed.
  assert.equal(due(local(9, 19, 9), tuesday), 'Mon 19 Oct, 09:00');
});

await test('the event parser keeps whole events, skips heartbeats, and leaves the unfinished rest', () => {
  const { events, rest } = parseEvents(
    'id: e1.1\nevent: snapshot\ndata: {"a":1}\n\n: ping\n\nevent: snapshot\ndata: {"b":\ndata: 2}\n\nid: e1.3\nevent: snap',
  );
  assert.deepEqual(events, [
    { event: 'snapshot', data: '{"a":1}' },
    { event: 'snapshot', data: '{"b":\n2}' },
  ]);
  assert.equal(rest, 'id: e1.3\nevent: snap');
  assert.deepEqual(parseEvents('event: snapshot\r\ndata: x\r\n\r\n').events, [
    { event: 'snapshot', data: 'x' },
  ]);
});

await test('a snapshot replaces the shown one only when it is newer, and a new epoch always is', () => {
  const shown = story();
  assert.ok(newer(null, shown));
  assert.ok(!newer(shown, { ...shown, rev: 7 }));
  assert.ok(!newer(shown, { ...shown, rev: 3 }));
  assert.ok(newer(shown, { ...shown, rev: 8 }));
  // Verifold started again: rev 1 of a new epoch replaces rev 7.
  assert.ok(newer(shown, { ...shown, epoch: 'e2', rev: 1 }));
  const store = new LabStore();
  let changes = 0;
  store.subscribe(() => changes++);
  store.accept(shown);
  store.accept({ ...shown, rev: 6 });
  assert.equal(store.get().snapshot?.rev, 7);
  assert.equal(store.get().connection, 'live');
  assert.equal(changes, 1);
});

await test('before the first snapshot, a refusal or another protocol stops the stream, and only network failures retry', async (t) => {
  const token = 'f'.repeat(64);
  for (const status of [403, 503]) {
    let calls = 0;
    stub(t, 'fetch', () => {
      calls++;
      return Promise.resolve(new Response('', { status }));
    });
    const store = new LabStore(5);
    await store.follow(token, new AbortController().signal);
    assert.deepEqual(
      [store.get().connection, store.get().retrying],
      ['unreachable', false],
      String(status),
    );
    await delay(30);
    assert.equal(calls, 1, `${status} is not retried`);
    assert.match(
      text(render(null, 'unreachable', '#/', false)),
      /Can't reach Verifold\. Is it running\? Verifold refused the connection\. Reload this page to try again\./,
    );
  }

  let outdatedCalls = 0;
  stub(t, 'fetch', (_url: string, init?: RequestInit) => {
    outdatedCalls++;
    return Promise.resolve(
      stream({ ...story(), protocolVersion: 2 }, init?.signal),
    );
  });
  const outdated = new LabStore(5);
  await outdated.follow(token, new AbortController().signal);
  assert.equal(outdated.get().connection, 'outdated');
  assert.equal(outdatedCalls, 1);
  assert.match(
    text(render(null, 'outdated')),
    /This page is older than Verifold\. Reload it\./,
  );

  stub(t, 'fetch', () => Promise.resolve(new Response('', { status: 401 })));
  const refused = new LabStore(5);
  await refused.follow(token, new AbortController().signal);
  assert.equal(refused.get().connection, 'signed-out');

  // Network failures: the notice shows after the first one, and the page keeps trying.
  let calls = 0;
  stub(t, 'fetch', (_url: string, init?: RequestInit) => {
    calls++;
    return calls < 3
      ? Promise.reject(new TypeError('fetch failed'))
      : Promise.resolve(stream(story(), init?.signal));
  });
  const store = new LabStore(5);
  const owner = new AbortController();
  t.after(() => owner.abort());
  void store.follow(token, owner.signal);
  await until(() => store.get().connection === 'unreachable');
  assert.equal(store.get().retrying, true);
  assert.match(
    text(render(null, 'unreachable', '#/', true)),
    /Can't reach Verifold\. Is it running\? This page keeps trying/,
  );
  await until(() => store.get().connection === 'live');
  assert.equal(calls, 3);
  assert.equal(store.get().snapshot?.rev, 7);
});

await test('after a snapshot, a dropped stream reconnects with the last one shown, and a refusal stops with it shown', async (t) => {
  const token = 'f'.repeat(64);
  let calls = 0;
  stub(t, 'fetch', (_url: string, init?: RequestInit) => {
    calls++;
    if (calls === 1)
      return Promise.resolve(stream(story(), init?.signal, true));
    if (calls === 2) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response('', { status: 503 }));
  });
  const store = new LabStore(5);
  const seen: string[] = [];
  store.subscribe(() => seen.push(store.get().connection));
  await store.follow(token, new AbortController().signal);
  assert.deepEqual(seen.slice(0, 3), ['live', 'reconnecting', 'reconnecting']);
  assert.equal(store.get().connection, 'unreachable');
  assert.equal(store.get().snapshot?.rev, 7);
  assert.match(
    text(render(story(), 'reconnecting')),
    /Reconnecting to Verifold\. This shows the lab as of \d\d:\d\d\./,
  );
  assert.match(
    text(render(story(), 'unreachable')),
    /Can't reach Verifold\. Is it running\? This shows the lab as of \d\d:\d\d\. Reload the page to try again\./,
  );
});

await test('the store marks a tab without a token as signed out', async () => {
  const store = new LabStore();
  await store.follow(null, new AbortController().signal);
  assert.equal(store.get().connection, 'signed-out');
});

await test('a send keeps text typed while it was in flight, and a retry after a lost answer keeps its key', async (t) => {
  // The box empties only if it still holds what was sent.
  assert.equal(afterSend('Try Gemma', 'Try Gemma'), '');
  assert.equal(
    afterSend('Try Gemma, then Llama', 'Try Gemma'),
    'Try Gemma, then Llama',
  );
  let made = 0;
  const make = (): string => `key-${++made}`;
  const first = intentFor<string>(null, 'Try Gemma', make);
  assert.deepEqual(first, { value: 'Try Gemma', key: 'key-1' });
  // The answer was lost: the same text keeps the key, other text gets a new one.
  const kept = unansweredAfter(first, { lost: 'no answer' });
  assert.equal(intentFor(kept, 'Try Gemma', make).key, 'key-1');
  assert.equal(intentFor(kept, 'Try Llama', make).key, 'key-2');
  // Verifold answered, even with a refusal: the next attempt is a new intent.
  assert.equal(unansweredAfter(first, { refused: 'paused' }), null);
  assert.equal(unansweredAfter(first, { ok: true }), null);

  // act sends the caller's key, and tells a lost answer from a refusal.
  const bodies: unknown[] = [];
  let answer: () => Promise<Response> = () =>
    Promise.reject(new TypeError('fetch failed'));
  stub(t, 'fetch', (_url: string, init?: RequestInit) => {
    bodies.push(
      JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
    );
    return answer();
  });
  assert.deepEqual(await act('t', 'lab-post', { text: 'Hi' }, 'k1'), {
    lost: 'Verifold did not answer. Send again to retry.',
  });
  answer = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'The lab is paused.' }), {
        status: 409,
      }),
    );
  assert.deepEqual(await act('t', 'lab-post', { text: 'Hi' }, 'k1'), {
    refused: 'The lab is paused.',
  });
  // A slow action that goes on in the background says so.
  answer = () =>
    Promise.resolve(
      new Response('{"ok":true,"pending":true}', { status: 202 }),
    );
  assert.deepEqual(await act('t', 'lab-post', { text: 'Hi' }, 'k1'), {
    ok: true,
    pending: true,
  });
  answer = () => Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  assert.deepEqual(await act('t', 'lab-post', { text: 'Hi' }, 'k1'), {
    ok: true,
  });
  assert.deepEqual(bodies, [
    { text: 'Hi', key: 'k1' },
    { text: 'Hi', key: 'k1' },
    { text: 'Hi', key: 'k1' },
    { text: 'Hi', key: 'k1' },
  ]);
});

await test('the shared token module keeps a token, exchanges a launch code, and a cut-off answer signs the tab out', async (t) => {
  const kept = new Map<string, string>();
  const replaced: string[] = [];
  stub(t, 'sessionStorage', {
    getItem: (name: string) => kept.get(name) ?? null,
    setItem: (name: string, value: string) => kept.set(name, value),
  });
  stub(t, 'history', {
    replaceState: (_state: unknown, _title: string, url: string) =>
      replaced.push(url),
  });
  const at = (hash: string): void =>
    stub(t, 'location', { hash, pathname: '/app/' });
  at(`#${'a'.repeat(64)}`);
  assert.deepEqual(readFragment('#/'), { token: 'a'.repeat(64), launch: '' });
  assert.deepEqual(replaced, ['/app/#/']);
  at('#/');
  assert.deepEqual(readFragment('#/'), { token: 'a'.repeat(64), launch: '' });
  assert.equal(replaced.length, 1);
  at('#launch-c0de');
  assert.deepEqual(readFragment(''), { token: 'a'.repeat(64), launch: 'c0de' });
  assert.equal(replaced.at(-1), '/app/');
  // The terminal opens a call: the page after the code becomes the fragment.
  at('#launch-c0de/call/c-3');
  assert.deepEqual(readFragment('#/'), {
    token: 'a'.repeat(64),
    launch: 'c0de',
  });
  assert.equal(replaced.at(-1), '/app/#/call/c-3');

  // A cut-off answer to the launch exchange: no token, and the app shows the signed-out notice.
  kept.clear();
  stub(t, 'fetch', () =>
    Promise.resolve(new Response('{"tok', { status: 200 })),
  );
  assert.equal(await exchangeLaunch('c0de'), null);
  at('#launch-c0de');
  assert.equal(await takeToken(), null);
  const store = new LabStore();
  await store.follow(null, new AbortController().signal);
  assert.match(
    text(render(null, store.get().connection)),
    /Open Verifold from your terminal/,
  );

  stub(t, 'fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ token: 'b'.repeat(64) }), { status: 200 }),
    ),
  );
  assert.equal(await exchangeLaunch('c0de'), 'b'.repeat(64));
  assert.equal(storedToken(), 'b'.repeat(64));
});

await test('posts group into threads by the post they answer', () => {
  const groups = threads(story().lab?.board.posts ?? []);
  assert.deepEqual(
    groups.map((group) => [
      group.root.id,
      group.replies.map((reply) => reply.id),
    ]),
    [
      ['p-9', ['p-10', 'p-11']],
      ['p-13', ['p-14']],
    ],
  );
  // A reply to a post outside the page starts its own thread.
  assert.deepEqual(
    threads([post('p-20', 'a-1', 'claim', 'x', { replyTo: 'p-2' })]).map(
      (group) => group.root.id,
    ),
    ['p-20'],
  );
});

await test('routes: the first run, and pages that do not exist', () => {
  assert.deepEqual(parseRoute(''), { page: 'lab' });
  assert.deepEqual(parseRoute('#/'), { page: 'lab' });
  assert.deepEqual(parseRoute('#/d/d-2'), {
    page: 'direction',
    direction: 'd-2',
  });
  assert.deepEqual(parseRoute('#/call/c-4'), { page: 'call', id: 'c-4' });
  assert.deepEqual(parseRoute('#/post/p-12'), { page: 'post', id: 'p-12' });
  assert.deepEqual(parseRoute('#/board/p-12'), { page: 'lab', post: 'p-12' });
  assert.deepEqual(parseRoute('#/answer'), { page: 'answer' });
  assert.deepEqual(parseRoute('#/setup'), { page: 'setup', step: null });
  for (const step of ['agents', 'about', 'skills', 'money', 'done'])
    assert.deepEqual(parseRoute(`#/setup/${step}`), { page: 'setup', step });
  for (const hash of [
    '#/first-run',
    '#/setup/other',
    '#/setup/',
    '#/d/../x',
    '#/search',
    '#/projects',
    '#/post/p-0',
    '#/post/c-1',
    '#/board/p-0',
    '#/board/',
    '#/nope',
  ])
    assert.deepEqual(parseRoute(hash), { page: 'unknown' }, hash);
  // A direction has its own page now (#295).
  assert.match(
    text(render(story(), 'live', '#/d/d-2')),
    /The CoT matches what probes read inside/,
  );
  // The first run opens over a lab too, to change the profile, with a way back.
  const setup = text(render(story(), 'live', '#/setup/agents'));
  assert.match(setup, /Reading your profile/);
  assert.match(setup, /Back to the lab/);
  const missing = text(render(story(), 'live', '#/search'));
  assert.match(missing, /This page does not exist/);
});

await test('the lab home shows the call, the directions with live lines, and the board threads', () => {
  const html = render(story());
  const page = text(html);
  // The header: the project as plain text, the money line, and pause. No search or switcher yet.
  assert.match(html, /<span class="header__project">CoT faithfulness<\/span>/);
  assert.match(
    page,
    /Due [A-Z][a-z]{2} \d\d:\d\d · ≈\$3\.10 plans · \$4\.20 of \$25 GPU/,
  );
  assert.match(html, /<button type="button" class="button">Pause<\/button>/);
  assert.doesNotMatch(html, />Search</);
  assert.doesNotMatch(page, /⌘K/);
  assert.doesNotMatch(html, /<kbd|switch project/i);
  // The needs-you line: question with the pick's price, askers, waiting time, Decide.
  assert.match(page, /Needs you Rent an H100 for the probe reruns\? \$11\.97/);
  assert.match(page, /claude-2 and codex-2 asked · waiting 12 min/);
  assert.match(html, /href="#\/call\/c-4"[^>]*>Decide</);
  // Directions: verdicts, titles, evidence, a wait, and live steps with their time.
  assert.match(
    page,
    /Holds up The CoT names what drives the answer Cue named 64%/,
  );
  assert.match(
    page,
    /Disputed The CoT matches what probes read inside Gap 34% smaller on seed 1 · waiting for you/,
  );
  assert.match(
    page,
    /Not settled The answer follows what the CoT says Running plant_errors\.py · 6 min/,
  );
  assert.match(page, /Searching the web · 1 min/);
  assert.match(html, /class="row row--disputed" href="#\/d\/d-2"/);
  assert.match(html, /role="img" aria-label="Codex, codex-1"/);
  // The board: a run chip opens the run's page, and a figure its direction's page.
  assert.match(page, /claude-2 Claim After the filter/);
  assert.match(html, /<a class="proof" href="#\/run\/r-3">Run r-3<\/a>/);
  assert.match(html, /<a class="proof" href="#\/d\/d-2">Figure<\/a>/);
  assert.match(page, /codex-2 Objection One seed can be luck/);
  assert.match(page, /You If budget is left, try Gemma/);
  assert.doesNotMatch(page, /You Question/);
  // An agent's reply to the person's post is a quiet line under it, with no rail.
  assert.match(page, /claude-1 Added it to the plan/);
  assert.match(
    html,
    /class="ack"><span class="avatar avatar--xs avatar--claude" aria-hidden="true">Cl<\/span>/,
  );
  // The composer.
  assert.match(html, /placeholder="Reply, or @mention an agent"/);
  // No inline styles, so the desk's CSP holds.
  assert.doesNotMatch(html, /style="/);
});

await test('a run chip opens the run without a direction, and a file chip without one is not a link', () => {
  const lab = story().lab;
  assert.ok(lab);
  const html = render(
    story({
      board: {
        posts: [
          post('p-30', 'a-1', 'evidence', 'A rerun.', {
            direction: null,
            proof: [
              { type: 'run', run: 'r-9' },
              {
                type: 'file',
                direction: null,
                path: 'results/gap.csv',
                commit: 'a3f9c2e',
                bytes: 120,
              },
            ],
          }),
        ],
        more: false,
      },
    }),
  );
  assert.match(html, /<a class="proof" href="#\/run\/r-9">Run r-9<\/a>/);
  assert.match(html, /<span class="proof">gap\.csv<\/span>/);
});

await test('the lab home says when nothing needs the person, when it is paused, and when items are left out', () => {
  assert.match(text(render(story({ needsYou: [] }))), /Nothing needs you\./);
  assert.match(
    text(
      render(
        story({ needsYou: [], paused: { at: ago(5), reason: 'deadline' } }),
      ),
    ),
    /The time budget ended, so the lab is paused\./,
  );
  assert.match(
    text(render(story({ needsYou: [call, { ...call, id: 'c-5' }] }))),
    /1 more call after this/,
  );
  const trimmed = { ...story({ omitted: { directions: 3 } }), trimmed: true };
  const page = text(render(trimmed));
  assert.match(page, /3 more not shown/);
  assert.match(
    page,
    /This lab is large, so this page leaves out some older items\./,
  );
  assert.match(
    text(
      render(
        story({
          directions: [],
          board: { posts: [], more: false },
          needsYou: [],
        }),
      ),
    ),
    /The planner is reading\. Directions show here when the plan is ready\./,
  );
});

await test('the app explains a missing token, the first connection, and a project with no lab', () => {
  assert.match(
    text(render(null, 'signed-out')),
    /Open Verifold from your terminal/,
  );
  assert.match(text(render(null, 'connecting')), /Connecting to Verifold/);
  assert.match(
    text(render({ ...story(), lab: null })),
    /CoT faithfulness has no lab yet/,
  );
  // Without a project, the app is the first run, at any page of the lab.
  for (const hash of ['#/', '#/d/d-2', '#/answer']) {
    const first = text(
      render({ ...story(), project: '', lab: null }, 'live', hash),
    );
    assert.match(first, /Set up once\. Every project starts from it\./, hash);
    assert.doesNotMatch(first, /Back to the lab/, hash);
  }
});

await test('the desk serves the app build under /app/: its page with no-store, hashed files kept for a year, and token.js', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, 'assets');
  await mkdir(join(assets, 'cli', 'vendor'), { recursive: true });
  await mkdir(join(assets, 'ui'));
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
  for (const name of [
    'purify.js',
    'idiomorph.js',
    'xterm.js',
    'xterm.css',
    'addon-fit.js',
  ])
    await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
  await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
  await writeFile(join(assets, 'ui', 'token.js'), 'fixture module');
  const build = async (
    name: string,
    files: readonly string[],
  ): Promise<URL> => {
    const folder = join(root, name);
    await mkdir(join(folder, 'assets'), { recursive: true });
    await writeFile(
      join(folder, 'index.html'),
      '<!doctype html><div id="root"></div>',
    );
    for (const file of files)
      await writeFile(join(folder, 'assets', file), 'x');
    return pathToFileURL(`${folder}/`);
  };
  const start = async (appRoot: URL) => {
    const owner = new AbortController();
    const desk = await startDesk(
      null,
      owner.signal,
      pathToFileURL(`${assets}/cli/`),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { appRoot },
    );
    t.after(async () => {
      owner.abort();
      await desk.closed;
    });
    return desk;
  };
  const desk = await start(
    await build('app', [
      'index-abc.js',
      'index-abc.css',
      'manrope-variable-abc.ttf',
    ]),
  );
  const origin = new URL(desk.url).origin;
  for (const path of ['/app/', '/app']) {
    const page = await fetch(origin + path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(
      page.headers.get('content-security-policy') ?? '',
      /script-src 'self'; style-src 'self'/,
    );
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  }
  for (const [file, type] of [
    ['index-abc.js', /text\/javascript/],
    ['index-abc.css', /text\/css/],
    ['manrope-variable-abc.ttf', /font\/ttf/],
  ] as const) {
    const asset = await fetch(`${origin}/app/assets/${file}`);
    assert.equal(asset.status, 200, file);
    assert.match(asset.headers.get('content-type') ?? '', type);
    assert.equal(
      asset.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );
  }
  assert.equal((await fetch(`${origin}/app/assets/missing.js`)).status, 404);
  const shared = await fetch(`${origin}/ui/token.js`);
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get('content-type') ?? '', /text\/javascript/);
  assert.equal(
    desk.appUrl,
    `${origin}/app/#${new URL(desk.url).hash.slice(1)}`,
  );
  assert.match(desk.launchUrl('/app/'), /\/app\/#launch-[0-9a-f]{48}$/);
  assert.match(desk.launchUrl(), /:\d+\/#launch-[0-9a-f]{48}$/);

  // A file of a type that the desk does not know stops the desk, loudly.
  await assert.rejects(
    start(await build('odd', ['index-abc.js', 'notes.txt'])),
    /no content type for notes\.txt/,
  );

  // A package without the app build serves no app, and its launch falls back to the desk.
  const bare = await start(pathToFileURL(`${root}/missing/`));
  const bareOrigin = new URL(bare.url).origin;
  assert.equal((await fetch(`${bareOrigin}/app/`)).status, 404);
  assert.equal(bare.appUrl, null);
  assert.match(bare.launchUrl('/app/'), /:\d+\/#launch-/);
});

await test('/app in the terminal opens the app, and --app is refused where it does nothing', async (t) => {
  const messages: string[] = [];
  const io = {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
    progress: (value: string) => messages.push(value),
  };
  const sessions = { views: () => [] } as unknown as SessionPool;
  let opened = 0;
  const controls = {
    host: 'claude',
    open: () => {},
    openApp: () => {
      opened++;
    },
  };
  terminalInput(sessions, '/app', io, controls);
  assert.equal(opened, 1);
  terminalInput(sessions, '/help', io, controls);
  assert.match(messages.at(-1) ?? '', /`\/app`: open the new app/);
  const root = await mkdtemp(join(tmpdir(), 'verifold-app-flag-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runCli(['init', '--app'], root, { ...io, interactive: false }),
    /--app is not valid for init/,
  );
});
