import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Agent,
  Call,
  Direction,
  Lab,
  Live,
  Snapshot,
} from '../src/protocol/api.ts';
import {
  labScreen,
  parseLabScreen,
  screenLimits,
  type LabScreen,
} from '../src/server/screen.ts';
import { enterLine, plainLines, viewLines } from '../src/cli/lab-view.ts';
import { LabTerminal, toColumn } from '../src/cli/terminal-view.ts';
import { visibleWidth } from '../src/cli/terminal-layout.ts';
import { terminalInput, type CliIO } from '../src/cli/commands.ts';
import type { SessionPool } from '../src/core/workers.ts';
import {
  connectControl,
  newControl,
  removeSocket,
  serveControl,
  type FromOwner,
} from '../src/server/control.ts';
import { ApiFeed, type ApiReader } from '../src/server/api.ts';
import { startDesk } from '../src/server/desk.ts';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await wait(10);
  }
  assert.fail('The condition did not come true in 2 s.');
}

/** Tuesday 2026-10-20, 19:00 in the computer's own time zone, so "Due Fri 18:00" reads the same everywhere. */
const now = new Date(2026, 9, 20, 19, 0).getTime();
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

function direction(
  id: string,
  title: string,
  agent: string,
  fields: Partial<Direction> = {},
): Direction {
  return {
    id,
    title,
    bar: null,
    runs: null,
    noise: null,
    buildsOn: [],
    state: 'open',
    verdict: 'open',
    disputed: false,
    evidence: null,
    agent,
    openedBy: 'a-1',
    openedAt: ago(500),
    stoppedAt: null,
    head: 'a3f9c2e',
    ...fields,
  };
}

function agent(
  id: string,
  handle: string,
  harness: 'claude' | 'codex',
  live: Live,
): Agent {
  return {
    id,
    handle,
    harness,
    model: null,
    direction: null,
    check: null,
    status: 'working',
    until: null,
    live,
    turns: { turns: [], more: false },
    spendUsd: null,
  };
}

const call: Call = {
  id: 'c-4',
  at: ago(12),
  kind: 'cost',
  question: 'Rent an H100 for the probe reruns?',
  why: 'Seeds 2 and 3 need a GPU.',
  askers: [],
  byVerifold: false,
  options: [
    {
      label: 'Rent 1 H100 for 3 hours',
      usd: 11.97,
      minutes: 180,
      effect: null,
    },
    { label: 'Use this Mac', usd: 0, minutes: 540, effect: null },
  ],
  pick: 0,
  state: 'open',
  answer: null,
  words: null,
  undoUntil: null,
  note: null,
  post: null,
};

/** The lab of the v9 canvas's terminal artboard. */
function story(fields: Partial<Lab> = {}): Snapshot {
  const lab: Lab = {
    question: "Can cheap training make a model's chain of thought faithful?",
    startedAt: ago(600),
    agentsHere: true,
    paused: null,
    budget: {
      hours: 72,
      deadline: new Date(2026, 9, 23, 18, 0).toISOString(),
    },
    money: { plansUsd: 3.1, gpuUsd: 4.2, gpuLimitUsd: 25 },
    needsYou: [call],
    answered: [],
    directions: [
      direction('d-1', 'The CoT names what drives the answer', 'a-1', {
        verdict: 'holds-up',
        evidence: {
          text: 'Cue named 64% vs 41% · Codex reran it',
          post: 'p-5',
          run: 'r-6',
        },
      }),
      direction('d-2', 'The CoT matches what probes read inside', 'a-2', {
        disputed: true,
        evidence: { text: 'Gap 34% smaller', post: 'p-9', run: 'r-3' },
      }),
      direction('d-3', 'The answer follows what the CoT says', 'a-3'),
      direction('d-4', 'Gains survive pressure from a monitor', 'a-4'),
    ],
    agents: [
      agent('a-1', 'claude-1', 'claude', {
        state: 'idle',
        text: 'Between turns',
        since: ago(20),
      }),
      agent('a-2', 'claude-2', 'claude', {
        state: 'waiting',
        text: 'Waiting for you',
        since: ago(12),
      }),
      agent('a-3', 'codex-1', 'codex', {
        state: 'working',
        text: 'Running plant_errors.py',
        since: ago(6),
      }),
      agent('a-4', 'codex-2', 'codex', {
        state: 'working',
        text: 'Searching the web',
        since: ago(1),
      }),
    ],
    plan: null,
    board: { posts: [], more: false },
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
    project: 'cot-faithfulness',
    lab,
    trimmed: false,
  };
}

const desk = { origin: 'http://127.0.0.1:56933', app: true };

function screenOf(snapshot: Snapshot = story()): LabScreen {
  const screen = labScreen(snapshot, desk);
  assert.ok(screen);
  return screen;
}

await test('the view shows the lab as the terminal artboard does, at 80 and 120 columns', () => {
  const screen = screenOf();
  assert.deepEqual(
    viewLines(screen, {
      columns: 120,
      rows: 24,
      color: false,
      now,
      detaches: true,
    }),
    [
      '',
      '  verifold  cot-faithfulness  · http://127.0.0.1:56933',
      '  Due Fri 18:00 · ≈$3.10 plans · $4.20 of $25 GPU',
      '',
      '  ✓  The CoT names what drives the answer     claude-1  Holds up · Cue named 64% vs 41% · Codex reran it',
      '  !  The CoT matches what probes read inside  claude-2  Disputed · Gap 34% smaller · waiting for you',
      '  ●  The answer follows what the CoT says     codex-1   Running plant_errors.py · 6 min',
      '  ●  Gains survive pressure from a monitor    codex-2   Searching the web · 1 min',
      '',
      '  Needs you  Rent an H100 for the probe reruns? $11.97   enter: open it',
      '',
      '  /help: commands · ctrl+c: close this window (the lab keeps working)',
    ],
  );
  for (const columns of [80, 120]) {
    const plain = viewLines(screen, {
      columns,
      rows: 24,
      color: false,
      now,
      detaches: true,
    });
    const styled = viewLines(screen, {
      columns,
      rows: 24,
      color: true,
      now,
      detaches: true,
    });
    // Color changes no text, and no line reaches the last column.
    assert.deepEqual(styled.map(stripVTControlCharacters), plain);
    assert.ok(styled.some((line) => line.includes('\u001b[38;2;')));
    for (const line of plain)
      assert.ok(visibleWidth(line) < columns, `${columns}: ${line}`);
  }
  const narrow = viewLines(screen, {
    columns: 80,
    rows: 24,
    color: false,
    now,
    detaches: true,
  });
  assert.equal(
    narrow[4],
    '  ✓  The CoT names what drives the…   claude-1  Holds up · Cue named 64% vs 41…',
  );
  assert.equal(
    narrow[6],
    '  ●  The answer follows what the Co…  codex-1   Running plant_errors.py · 6 min',
  );
  // Verifold's newest message shows under the view.
  assert.ok(
    viewLines(screen, {
      columns: 80,
      rows: 24,
      color: false,
      now,
      detaches: true,
      notice: 'Your message is on the board.',
    }).includes('  Your message is on the board.'),
  );
});

await test('a short terminal keeps the directions that need a look, in the lab order, and says how many more', () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    direction(
      `d-${index + 1}`,
      `Direction ${index + 1} with a title long enough to need cutting at eighty columns`,
      index === 20 ? 'a-2' : index === 25 ? 'a-3' : 'a-1',
      index < 20 ? { verdict: 'ruled-out' } : {},
    ),
  );
  const screen = screenOf(story({ directions: many }));
  // The owner sends at most 24, and the ones that need a look come first.
  assert.equal(screen.directions.length, screenLimits.directions);
  assert.equal(screen.more, 6);
  assert.ok(screen.directions.some((entry) => entry.id === 'd-21'));
  assert.ok(screen.directions.some((entry) => entry.id === 'd-26'));
  const lines = viewLines(screen, {
    columns: 80,
    rows: 20,
    color: false,
    now,
    detaches: true,
  });
  assert.ok(
    lines.length <= 20 - 2,
    'the view leaves a free row and the message line',
  );
  const rows = lines.filter(
    (line) =>
      line.startsWith('  ✗') ||
      line.startsWith('  ○') ||
      line.startsWith('  !') ||
      line.startsWith('  ●'),
  );
  // The waiting and the working directions stay, in the lab's order.
  assert.match(
    rows.find((line) => line.includes('claude-2')) ?? '',
    /^ {2}! {2}Direction 21 with/,
  );
  assert.match(
    rows.find((line) => line.includes('codex-1')) ?? '',
    /^ {2}● {2}Direction 26 with/,
  );
  assert.equal(
    lines.filter((line) => line === `  and ${30 - rows.length} more`).length,
    1,
  );
  for (const row of rows) assert.ok(row.includes('…'), row);
});

await test('the needs-you line, a lab without a call, and Enter on an empty line', () => {
  const second: Call = { ...call, id: 'c-5', question: 'More time?' };
  const both = screenOf(story({ needsYou: [call, second] }));
  assert.ok(
    viewLines(both, {
      columns: 100,
      rows: 24,
      color: false,
      now,
      detaches: true,
    }).includes(
      '  Needs you  Rent an H100 for the probe reruns? $11.97 · 1 more call   enter: open it',
    ),
  );
  assert.equal(enterLine(both), '/app c-4');
  const calm = screenOf(story({ needsYou: [] }));
  assert.ok(
    viewLines(calm, {
      columns: 80,
      rows: 24,
      color: false,
      now,
      detaches: true,
    }).includes('  Nothing needs you.   enter: open the lab'),
  );
  assert.equal(enterLine(calm), '/app');
  assert.equal(enterLine({ ...calm, app: false }), '/open');
  const ended = screenOf(
    story({ needsYou: [], paused: { at: ago(1), reason: 'deadline' } }),
  );
  assert.ok(
    viewLines(ended, {
      columns: 80,
      rows: 24,
      color: false,
      now,
      detaches: true,
    }).includes(
      '  The time budget ended, so the lab is paused.   enter: open the lab',
    ),
  );
  const planning = screenOf(story({ directions: [], needsYou: [] }));
  assert.ok(
    viewLines(planning, {
      columns: 80,
      rows: 24,
      color: false,
      now,
      detaches: true,
    }).includes(
      '  The planner is reading. Directions show here when the plan is ready.',
    ),
  );
});

await test('plain lines print one line per change, and no live step of an agent', () => {
  const first = screenOf();
  assert.deepEqual(plainLines(null, first, now), [
    'The CoT names what drives the answer (claude-1): Holds up · Cue named 64% vs 41% · Codex reran it',
    'The CoT matches what probes read inside (claude-2): Disputed · Gap 34% smaller · waiting for you',
    'The answer follows what the CoT says (codex-1): Not settled',
    'Gains survive pressure from a monitor (codex-2): Not settled',
    'Needs you: Rent an H100 for the probe reruns? $11.97. Press Enter on an empty line to open it.',
  ]);
  // A new step of an agent is a harness event: it prints nothing.
  const busy = screenOf(
    story({
      agents: story().lab!.agents.map((entry) =>
        entry.id === 'a-3'
          ? { ...entry, live: { ...entry.live, text: 'Reading probe.py' } }
          : entry,
      ),
    }),
  );
  assert.deepEqual(plainLines(first, busy, now), []);
  const settled = screenOf(
    story({
      needsYou: [],
      directions: story().lab!.directions.map((entry) =>
        entry.id === 'd-3'
          ? {
              ...entry,
              verdict: 'ruled-out',
              evidence: { text: 'No effect', post: 'p-20', run: null },
            }
          : entry,
      ),
    }),
  );
  assert.deepEqual(plainLines(busy, settled, now), [
    'The answer follows what the CoT says (codex-1): Ruled out',
  ]);
});

await test('a screen is a small part of the snapshot, and a terminal reads only a valid one', () => {
  assert.equal(labScreen({ ...story(), lab: null }, desk), null);
  const long = 'x'.repeat(5000);
  const screen = screenOf(
    story({
      directions: Array.from({ length: 100 }, (_, index) =>
        direction(`d-${index + 1}`, long, 'a-1', {
          evidence: { text: long, post: 'p-1', run: null },
        }),
      ),
      needsYou: [{ ...call, question: long }],
    }),
  );
  // One message stays far under the control channel's 64 KB line.
  assert.ok(JSON.stringify(screen).length < 32 * 1024);
  assert.equal(screen.more, 100 - screenLimits.directions);
  assert.deepEqual(parseLabScreen(JSON.parse(JSON.stringify(screen))), screen);
  const good = screenOf();
  for (const bad of [
    { ...good, origin: 'http://evil.example' },
    { ...good, directions: Array(25).fill(good.directions[0]) },
    { ...good, call: { id: 'x', question: 'q', usd: 1 } },
    { ...good, money: { ...good.money, gpuUsd: -1 } },
    {
      ...good,
      directions: [
        {
          ...good.directions[0],
          live: { state: 'odd', text: '', since: null },
        },
      ],
    },
    { ...good, more: 1.5 },
    'not a screen',
  ])
    assert.equal(parseLabScreen(bad), null);
});

await test('the control channel carries screens to terminals and counts them', async (t) => {
  const control = await newControl();
  t.after(() => removeSocket(control));
  const server = await serveControl(control, {
    attached: () => {},
    message: () => {},
  });
  t.after(() => server.close());
  assert.equal(server.terminals(), 0);
  const shown: FromOwner[] = [];
  const terminal = await connectControl(control, (message) =>
    shown.push(message),
  );
  t.after(() => terminal.close());
  await until(() => server.terminals() === 1);
  const screen = screenOf();
  server.send({ screen });
  // A screen that does not read right is left out.
  server.send({ screen: { ...screen, origin: 'http://evil.example' } });
  server.send({ screen: null });
  await until(() => shown.length === 2);
  await wait(30);
  assert.deepEqual(shown, [{ screen }, { screen: null }]);
});

await test('the feed gives a watcher each new snapshot, and builds none while nobody wants one', async () => {
  let version = 1;
  let wanted = false;
  const reader = {
    signal: () => Promise.resolve([version]),
    snapshot: () =>
      Promise.resolve(
        JSON.stringify({ project: `v${version}`, lab: null, trimmed: false }),
      ),
  } as unknown as ApiReader;
  const feed = new ApiFeed(reader, { pollMs: 10, heartbeatMs: 1000 });
  const seen: number[] = [];
  const stop = feed.watch(
    (latest) => seen.push(latest.rev),
    () => wanted,
  );
  await wait(60);
  assert.equal(feed.builds, 0);
  wanted = true;
  await until(() => seen.length === 1);
  version = 2;
  await until(() => seen.length === 2);
  assert.deepEqual(seen, [1, 2]);
  // Without a change, the watcher gets nothing again.
  await wait(50);
  assert.equal(seen.length, 2);
  stop();
  version = 3;
  await wait(50);
  assert.deepEqual(seen, [1, 2]);
  feed.close();
});

/** A fake terminal: input that the test types into, and the output that the view writes. */
function fakeTerminal(columns = 80): {
  input: PassThrough;
  output: Writable & { columns: number; rows: number; text: () => string };
} {
  let written = '';
  const output = Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        written += chunk.toString();
        done();
      },
    }),
    { columns, rows: 24, text: () => written },
  );
  return { input: new PassThrough(), output };
}

await test('the terminal draws the view, keeps a message line, and opens the call on Enter', async (t) => {
  const { input, output } = fakeTerminal();
  const lines: string[] = [];
  const printed: string[] = [];
  let cancelled = 0;
  const view = new LabTerminal({
    streams: { input, output },
    color: false,
    draws: true,
    cancel: () => cancelled++,
    print: (text) => printed.push(text),
    now: () => now,
  });
  const stop = new AbortController();
  t.after(() => stop.abort());
  view.show(screenOf(), true);
  view.listen((line) => lines.push(line), stop.signal);
  assert.equal(view.viewing, true);
  const first = output.text();
  assert.match(first, /verifold {2}cot-faithfulness/);
  assert.match(first, / {2}› write to the lab, or @mention an agent/);
  // A message goes to the handler. Enter on an empty line opens the call that waits.
  input.write('hi @claude-2\r');
  input.write('\r');
  await until(() => lines.length === 2);
  assert.deepEqual(lines, ['hi @claude-2', '/app c-4']);
  // Verifold's newest message becomes the line under the view.
  view.progress('Your message is on the board.');
  await until(
    () =>
      output.text().endsWith('\u001b[?2026l') &&
      output.text().includes('  Your message is on the board.'),
  );
  // A reply with more lines, such as the help, prints above the view.
  view.progress('Commands in this terminal:\n- /open: open the desk.');
  assert.match(
    output.text(),
    / {2}Commands in this terminal:\n {2}• \/open: open the desk\.\n\n {2}verifold/,
  );
  // Redraws come at most five times a second.
  const before = output.text().split('\u001b[?2026h').length;
  for (let index = 0; index < 10; index++)
    view.show(
      screenOf(
        story({ money: { plansUsd: index, gpuUsd: 0, gpuLimitUsd: null } }),
      ),
      true,
    );
  await wait(150);
  assert.ok(output.text().split('\u001b[?2026h').length - before <= 1);
  input.write('\u0003');
  await until(() => cancelled === 1);
  assert.deepEqual(printed, []);
  stop.abort();
  assert.equal(view.viewing, false);
  // After the view, messages print line by line again.
  view.progress('Detached.');
  assert.deepEqual(printed, ['Detached.']);
});

await test('a narrow terminal, NO_COLOR, and a project without a lab get plain lines', async (t) => {
  const { input, output } = fakeTerminal();
  const lines: string[] = [];
  const printed: string[] = [];
  const view = new LabTerminal({
    streams: { input, output },
    color: true,
    draws: true,
    cancel: () => {},
    print: (text) => printed.push(text),
    now: () => now,
  });
  const stop = new AbortController();
  t.after(() => stop.abort());
  view.listen((line) => lines.push(line), stop.signal);
  // No lab: no view, and lines as the shell gives them.
  view.show(null, true);
  assert.equal(view.viewing, false);
  input.write('hello\n');
  await until(() => lines.length === 1);
  view.show(screenOf(), true);
  assert.equal(view.viewing, true);
  output.columns = 50;
  output.emit('resize');
  assert.equal(view.viewing, false);
  // The lab as it is, line by line, then a line for each change.
  assert.match(printed[0] ?? '', /too small for the live view/);
  assert.deepEqual(printed.slice(1), plainLines(null, screenOf(), now));
  // Enter on an empty line still opens the call.
  input.write('\n');
  await until(() => lines.length === 2);
  assert.deepEqual(lines, ['hello', '/app c-4']);
  const count = printed.length;
  view.show(screenOf(story({ needsYou: [] })), true);
  assert.equal(printed.length, count);
  output.columns = 80;
  output.emit('resize');
  assert.equal(view.viewing, true);

  // NO_COLOR: the terminal never draws, and writes no cursor movement.
  const plain = fakeTerminal();
  const said: string[] = [];
  const quiet = new LabTerminal({
    streams: { input: plain.input, output: plain.output },
    color: false,
    draws: false,
    cancel: () => {},
    print: (text) => said.push(text),
    now: () => now,
  });
  quiet.listen(() => {}, stop.signal);
  quiet.show(screenOf(), true);
  assert.equal(quiet.viewing, false);
  assert.equal(plain.output.text(), '');
  assert.equal(said.length, 5);
  assert.match(said[4] ?? '', /^Needs you: Rent an H100/);
});

await test('terminal input: text goes to the lab board, and /app with a call ID opens that call', async () => {
  const messages: string[] = [];
  const io: CliIO = {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
    progress: (value) => messages.push(value),
  };
  const sessions = { views: () => [] } as unknown as SessionPool;
  const posted: unknown[] = [];
  const opened: (string | undefined)[] = [];
  const controls = {
    host: 'claude',
    open: () => {},
    openApp: (callId?: string) => opened.push(callId),
    lab: {
      exists: true,
      post: (input: { readonly text: unknown }) => {
        posted.push(input.text);
        return input.text === 'x'.repeat(5)
          ? Promise.reject(new Error('refused'))
          : Promise.resolve({} as never);
      },
    },
  };
  terminalInput(sessions, 'Try Gemma too @claude-2', io, controls);
  await until(() => messages.length === 1);
  assert.deepEqual(posted, ['Try Gemma too @claude-2']);
  assert.equal(messages[0], 'Your message is on the board.');
  terminalInput(sessions, '/app c-3', io, controls);
  terminalInput(sessions, '/app', io, controls);
  assert.deepEqual(opened, ['c-3', undefined]);
  terminalInput(sessions, '/app d-2', io, controls);
  assert.match(messages.at(-1) ?? '', /^Write \/app and the ID of a call/);
  // Without a lab, the text goes nowhere, as before, and the terminal says so.
  terminalInput(sessions, 'hello', io, {
    ...controls,
    lab: { ...controls.lab, exists: false },
  });
  assert.match(messages.at(-1) ?? '', /^No session is running/);
  assert.equal(posted.length, 1);
});

await test('a launch URL can open a page of the app after its one-time code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-launch-route-'));
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
  const app = join(root, 'app');
  await mkdir(join(app, 'assets'), { recursive: true });
  await writeFile(
    join(app, 'index.html'),
    '<!doctype html><div id="root"></div>',
  );
  await writeFile(join(app, 'assets', 'index-abc.js'), 'x');
  const owner = new AbortController();
  const server = await startDesk(
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
    { appRoot: pathToFileURL(`${app}/`) },
  );
  t.after(async () => {
    owner.abort();
    await server.closed;
  });
  assert.match(
    server.launchUrl('/app/', '/call/c-3'),
    /\/app\/#launch-[0-9a-f]{48}\/call\/c-3$/,
  );
  // The desk takes no page, and an odd page is left out.
  assert.match(
    server.launchUrl('/', '/call/c-3'),
    /:\d+\/#launch-[0-9a-f]{48}$/,
  );
  assert.match(
    server.launchUrl('/app/', 'javascript:alert(1)'),
    /\/app\/#launch-[0-9a-f]{48}$/,
  );
});

await test('every line fits at 60 to 64 columns, with a long price and 12 calls', () => {
  const many: Call[] = Array.from({ length: 12 }, (_, index) => ({
    ...call,
    id: `c-${index + 1}`,
    question: 'Rent four H100s for a week of probe reruns on every seed?',
    options: [{ ...call.options[0]!, usd: 12345.67 }],
  }));
  const screen = screenOf(story({ needsYou: many }));
  for (let columns = 60; columns <= 64; columns++) {
    const lines = viewLines(screen, {
      columns,
      rows: 24,
      color: false,
      now,
      detaches: true,
      notice: 'Your message is on the board.',
    });
    for (const line of lines)
      assert.ok(visibleWidth(line) < columns, `${columns}: ${line}`);
    // The frame and the message line leave the free row.
    assert.ok(lines.length + 1 <= 24 - 1);
    const needs = lines.find((line) => line.startsWith('  Needs you'));
    assert.match(needs ?? '', /\$12345\.67/);
  }
  // At 60 columns the keys go first, and the count of the other calls stays.
  assert.ok(
    viewLines(screen, {
      columns: 60,
      rows: 24,
      color: false,
      now,
      detaches: true,
    }).includes('  Needs you  Rent four H100s for… $12345.67 · 11 more calls'),
  );
});

await test('the keys line says what Ctrl+C does: detach from the owner, or stop Verifold', () => {
  const screen = screenOf();
  const keys = (detaches: boolean): string | undefined =>
    viewLines(screen, {
      columns: 100,
      rows: 24,
      color: false,
      now,
      detaches,
    }).at(-1);
  assert.equal(
    keys(true),
    '  /help: commands · ctrl+c: close this window (the lab keeps working)',
  );
  assert.equal(keys(false), '  /help: commands · ctrl+c: stop Verifold');
});

await test('calls that the smallest snapshot only counts still show, and Enter opens the lab', () => {
  // A large lab's smallest snapshot keeps no call, only how many it left out.
  const hidden = screenOf(story({ needsYou: [], omitted: { needsYou: 3 } }));
  assert.equal(hidden.call, null);
  assert.equal(hidden.calls, 3);
  assert.ok(
    viewLines(hidden, {
      columns: 80,
      rows: 24,
      color: false,
      now,
      detaches: true,
    }).includes('  3 calls need you.   enter: open the lab'),
  );
  assert.equal(enterLine(hidden), '/app');
  const shown = screenOf();
  assert.deepEqual(plainLines(shown, hidden, now), [
    '3 calls need you. Press Enter on an empty line to open the lab.',
  ]);
  // The same count says nothing again. A new count says it.
  assert.deepEqual(plainLines(hidden, hidden, now), []);
  const one = screenOf(story({ needsYou: [], omitted: { needsYou: 1 } }));
  assert.deepEqual(plainLines(hidden, one, now), [
    '1 call needs you. Press Enter on an empty line to open the lab.',
  ]);
});

await test('a line of the session of the person, and a long message, stay in the scrollback above the view', async (t) => {
  const { input, output } = fakeTerminal();
  const view = new LabTerminal({
    streams: { input, output },
    color: false,
    draws: true,
    cancel: () => {},
    print: () => {},
    now: () => now,
  });
  const stop = new AbortController();
  t.after(() => stop.abort());
  view.show(screenOf(), true);
  view.listen(() => {}, stop.signal);
  const reply = `14:05  Claude Code · agent says: ${'All three seeds ran. '.repeat(20)}`;
  view.progress(reply, true);
  view.progress('Your message is on the board.');
  await until(() => output.text().includes('  Your message is on the board.'));
  const after = output.text();
  // The session's line printed above the view, whole, and the next draw keeps it.
  const above = after.lastIndexOf('agent says:');
  assert.ok(above > 0 && above < after.lastIndexOf('  verifold  '));
  assert.equal(
    stripVTControlCharacters(after)
      .replace(/\s+/g, ' ')
      .includes(reply.replace(/\s+/g, ' ').trim()),
    true,
  );
  // A message wider than the notice row goes above too. A short one stays in the row.
  const long = `Verifold could not save the answer to c-4: ${'x'.repeat(120)}`;
  view.progress(long);
  const frame = output.text().slice(output.text().lastIndexOf('\u001b[?2026h'));
  assert.ok(
    frame.indexOf('Verifold could not save') < frame.indexOf('  verifold  '),
  );
  assert.ok(frame.includes('  Your message is on the board.'));
});

await test('the control channel marks session lines, and a line that is not an object is left out', async (t) => {
  const control = await newControl();
  t.after(() => removeSocket(control));
  // An owner that sends odd lines first: the terminal keeps reading after them.
  const owner = createServer((socket) => {
    socket.write('5\n"text"\nnull\n[1]\ntrue\n');
    socket.end(
      `${JSON.stringify({ progress: 'line', feed: true })}\n${JSON.stringify({ progress: 'notice' })}\n`,
    );
  });
  await new Promise<void>((resolve) => owner.listen(control.socket, resolve));
  const shown: FromOwner[] = [];
  const terminal = await connectControl(control, (message) =>
    shown.push(message),
  );
  t.after(() => {
    terminal.close();
    owner.close();
  });
  await until(() => shown.length === 2);
  assert.deepEqual(shown, [
    { progress: 'line', feed: true },
    { progress: 'notice' },
  ]);
});

await test('a terminal that its own desk serves stops its watch when it closes, and the feed stops', async () => {
  let reads = 0;
  const reader = {
    signal: () => {
      reads++;
      return Promise.resolve([reads]);
    },
    snapshot: () =>
      Promise.resolve(
        JSON.stringify({ project: 'p', lab: null, trimmed: false }),
      ),
  } as unknown as ApiReader;
  const feed = new ApiFeed(reader, { pollMs: 10, heartbeatMs: 1000 });
  const { input, output } = fakeTerminal();
  const view = new LabTerminal({
    streams: { input, output },
    color: false,
    draws: true,
    cancel: () => {},
    print: () => {},
    now: () => now,
  });
  view.serve((show) => feed.watch(() => show(screenOf())));
  const stop = new AbortController();
  view.listen(() => {}, stop.signal);
  await until(() => view.viewing && reads > 2);
  stop.abort();
  const count = reads;
  await wait(80);
  // No tick reads the lab after the terminal closed.
  assert.ok(reads <= count + 1, `${reads - count} reads after the close`);
  const settled = reads;
  await wait(80);
  assert.equal(reads, settled);
  feed.close();
});

await test('a move to column 0 is a carriage return alone', () => {
  assert.equal(toColumn(0), '\r');
  assert.equal(toColumn(4), '\r\u001b[4C');
});
