import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Call,
  Direction,
  Lab,
  Post,
  Snapshot,
  StepCounts,
} from '../src/protocol/api.ts';
import { parseEvents } from '../src/app/api.ts';
import { threads } from '../src/app/board.ts';
import { asked, due, span, usd, worked } from '../src/app/format.ts';
import { parseRoute } from '../src/app/route.ts';
import { LabStore, newer } from '../src/app/store.ts';
import { Screen } from '../src/app/App.tsx';
import { ActivityFold } from '../src/app/components/ActivityFold.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';
import { runCli, terminalInput } from '../src/cli/commands.ts';
import { startDesk } from '../src/server/desk.ts';
import type { SessionPool } from '../src/core/workers.ts';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const zero: StepCounts = {
  search: 0,
  page: 0,
  read: 0,
  command: 0,
  edit: 0,
  run: 0,
  post: 0,
  helper: 0,
  other: 0,
};

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
      effect: { type: 'pod', gpu: 'H100 SXM', hours: 3, secrets: 0 },
    },
    { label: 'Use this Mac', usd: 0, minutes: 540, effect: null },
  ],
  pick: 0,
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
  post: () => Promise.resolve(null),
  pause: () => Promise.resolve(null),
};

function render(
  snapshot: Snapshot | null,
  connection: 'connecting' | 'live' | 'reconnecting' | 'signed-out' = 'live',
  hash = '#/',
): string {
  return renderToStaticMarkup(
    <Screen
      state={{ snapshot, connection }}
      route={parseRoute(hash)}
      now={now}
      actions={actions}
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

await test('format helpers write money, spans, deadlines, askers, and folded turns plainly', () => {
  assert.equal(usd(25), '$25');
  assert.equal(usd(4.2), '$4.20');
  assert.equal(span(40_000), '40 s');
  assert.equal(span(6 * 60_000), '6 min');
  assert.equal(span(80 * 60_000), '1 h 20 min');
  assert.equal(span(50 * 3_600_000), '2 days');
  assert.match(
    due(new Date(Date.UTC(2026, 9, 24, 1, 0)).toISOString(), now),
    /^[A-Z][a-z]{2} \d\d:\d\d$/,
  );
  assert.match(
    due(new Date(Date.UTC(2026, 10, 30, 1, 0)).toISOString(), now),
    /^[A-Z][a-z]{2} \d{1,2} \d\d:\d\d$/,
  );
  assert.equal(asked([]), 'Verifold asks');
  assert.equal(asked(call.askers), 'claude-2 and codex-2 asked');
  assert.equal(
    asked([
      ...call.askers,
      { agent: 'a-3', handle: 'codex-1', direction: 'd-3', why: '' },
    ]),
    'claude-2, codex-2 and codex-1 asked',
  );
  assert.equal(
    worked({ ...zero, search: 4, page: 3, edit: 1 }, ago(30), ago(24), now),
    'Worked 6 min · 4 searches · 3 pages · 1 edit',
  );
  assert.equal(
    worked({ ...zero, command: 2 }, ago(2), null, now),
    'Working for 2 min · 2 commands',
  );
});

await test('the event parser keeps whole events, skips heartbeats, and leaves the unfinished rest', () => {
  const { events, rest } = parseEvents(
    'id: e1.1\nevent: snapshot\ndata: {"a":1}\n\n: ping\n\nevent: snapshot\ndata: {"b":\ndata: 2}\n\nid: e1.3\nevent: snap',
  );
  assert.deepEqual(events, [
    { event: 'snapshot', data: '{"a":1}', id: 'e1.1' },
    { event: 'snapshot', data: '{"b":\n2}', id: null },
  ]);
  assert.equal(rest, 'id: e1.3\nevent: snap');
  assert.deepEqual(parseEvents('event: snapshot\r\ndata: x\r\n\r\n').events, [
    { event: 'snapshot', data: 'x', id: null },
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

await test('the store marks a tab without a token as signed out', async () => {
  const store = new LabStore();
  await store.follow(null, new AbortController().signal);
  assert.equal(store.get().connection, 'signed-out');
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

await test('routes come from the fragment, and unknown ones are named', () => {
  assert.deepEqual(parseRoute(''), { page: 'lab' });
  assert.deepEqual(parseRoute('#/'), { page: 'lab' });
  assert.deepEqual(parseRoute('#/d/d-2'), { page: 'direction', id: 'd-2' });
  assert.deepEqual(parseRoute('#/call/c-4'), { page: 'call', id: 'c-4' });
  assert.deepEqual(parseRoute('#/answer'), { page: 'answer' });
  assert.deepEqual(parseRoute('#/d/../x'), { page: 'unknown' });
});

await test('the lab home shows the call, the directions with live lines, and the board threads', () => {
  const html = render(story());
  const page = text(html);
  // The header: project, money line, search, pause.
  assert.match(page, /CoT faithfulness/);
  assert.match(
    page,
    /Due [A-Z][a-z]{2} \d\d:\d\d · ≈\$3\.10 plans · \$4\.20 of \$25 GPU/,
  );
  assert.match(page, /Search ⌘K/);
  assert.match(html, /<button type="button" class="button">Pause<\/button>/);
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
  // The board: a claim with its proof, an objection and a reply on its rail, the person's post.
  assert.match(page, /claude-2 Claim After the filter/);
  assert.match(html, /href="#\/run\/r-3">Run r-3</);
  assert.match(html, />Figure</);
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

await test('the app explains a dropped connection, a missing token, a project with no lab, and later pages', () => {
  assert.match(
    text(render(story(), 'reconnecting')),
    /Reconnecting to Verifold\. This shows the lab as of \d\d:\d\d\./,
  );
  assert.match(
    text(render(null, 'signed-out')),
    /Open Verifold from your terminal/,
  );
  assert.match(text(render(null, 'connecting')), /Connecting to Verifold/);
  assert.match(
    text(render({ ...story(), lab: null })),
    /CoT faithfulness has no lab yet/,
  );
  const later = render(story(), 'live', '#/d/d-2');
  assert.match(text(later), /A direction comes in a later step/);
  assert.match(later, /href="#\/"/);
});

await test('a folded turn is one line, closed by default', () => {
  const html = renderToStaticMarkup(
    <ActivityFold
      turn={{
        id: 't-3',
        startedAt: ago(30),
        endedAt: ago(6),
        counts: { ...zero, command: 9, run: 1 },
        message: null,
      }}
      now={now}
    >
      <p>steps</p>
    </ActivityFold>,
  );
  assert.match(html, /aria-expanded="false"/);
  assert.match(text(html), /Worked 24 min · 9 commands · 1 run/);
  assert.doesNotMatch(html, /steps/);
});

await test('the desk serves the app build under /app/ with its headers, and opens it with a launch code', async (t) => {
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
  const app = join(root, 'app');
  await mkdir(join(app, 'assets'), { recursive: true });
  await writeFile(
    join(app, 'index.html'),
    '<!doctype html><div id="root"></div>',
  );
  await writeFile(join(app, 'assets', 'index-abc.js'), 'export {};');
  await writeFile(join(app, 'assets', 'index-abc.css'), 'body{}');
  await writeFile(join(app, 'assets', 'notes.txt'), 'not served');

  const start = async (appRoot: URL | undefined) => {
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
      appRoot ? { appRoot } : { appRoot: pathToFileURL(`${root}/missing/`) },
    );
    t.after(async () => {
      owner.abort();
      await desk.closed;
    });
    return desk;
  };
  const desk = await start(pathToFileURL(`${app}/`));
  const origin = new URL(desk.url).origin;
  for (const path of ['/app/', '/app']) {
    const page = await fetch(origin + path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(
      page.headers.get('content-security-policy') ?? '',
      /script-src 'self'; style-src 'self'/,
    );
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  }
  const script = await fetch(`${origin}/app/assets/index-abc.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /text\/javascript/);
  assert.equal((await fetch(`${origin}/app/assets/index-abc.css`)).status, 200);
  assert.equal((await fetch(`${origin}/app/assets/notes.txt`)).status, 404);
  assert.equal(
    desk.appUrl,
    `${origin}/app/#${new URL(desk.url).hash.slice(1)}`,
  );
  assert.match(desk.launchUrl('/app/'), /\/app\/#launch-[0-9a-f]{48}$/);
  assert.match(desk.launchUrl(), /:\d+\/#launch-[0-9a-f]{48}$/);

  // A package without the app build serves no app, and its launch falls back to the desk.
  const bare = await start(undefined);
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
  terminalInput(sessions, '/app', io, {
    host: 'claude',
    open: () => {},
    openApp: () => {
      opened++;
    },
  });
  assert.equal(opened, 1);
  terminalInput(sessions, '/app', io, { host: 'claude', open: () => {} });
  assert.match(messages.at(-1) ?? '', /not available here/);
  terminalInput(sessions, '/help', io, { host: 'claude', open: () => {} });
  assert.match(messages.at(-1) ?? '', /`\/app`: open the new app/);
  const root = await mkdtemp(join(tmpdir(), 'verifold-app-flag-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runCli(['init', '--app'], root, { ...io, interactive: false }),
    /--app is not valid for init/,
  );
});
