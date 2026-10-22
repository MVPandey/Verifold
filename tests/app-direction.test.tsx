import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Call,
  Direction,
  Lab,
  Post,
  Run,
  Snapshot,
  Step,
  StepCounts,
  Turn,
} from '../src/protocol/api.ts';
import {
  counted,
  foldQuery,
  refreshKey,
  stepLines,
  stepTotal,
  stepVerb,
  stepWhat,
  turnSummary,
} from '../src/app/activity.ts';
import { isTurnDetail, isTurnPage, load, paths } from '../src/app/api.ts';
import { clock, modelName } from '../src/app/format.ts';
import { href, parseRoute } from '../src/app/route.ts';
import {
  byIndex,
  byStart,
  filled,
  joinTurns,
  meet,
  runPlace,
} from '../src/app/turns.ts';
import { agentActions } from '../src/app/actions.ts';
import { Screen } from '../src/app/App.tsx';
import { runLabel } from '../src/app/components/RunChip.tsx';
import {
  StepGroup,
  StepList,
  StepRow,
} from '../src/app/components/StepList.tsx';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';
import type { LabState } from '../src/app/store.ts';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const none: StepCounts = {
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

function turn(
  id: string,
  started: number,
  ended: number | null,
  counts: Partial<StepCounts>,
  message: string | null,
  fields: Partial<Turn> = {},
): Turn {
  return {
    id,
    startedAt: ago(started),
    endedAt: ended === null ? null : ago(ended),
    rev: 1,
    counts: { ...none, ...counts },
    message: message === null ? null : { text: message, trimmed: false },
    posts: [],
    runs: [],
    proofByTime: false,
    ...fields,
  };
}

function agent(
  id: string,
  handle: string,
  harness: 'claude' | 'codex',
  live: Agent['live'],
  turns: readonly Turn[] = [],
  more = false,
): Agent {
  return {
    id,
    handle,
    harness,
    model: harness === 'claude' ? 'claude-opus-5-5[1m]' : 'gpt-6-astra',
    direction: null,
    check: null,
    status: live.state === 'working' ? 'working' : 'idle',
    until: null,
    live,
    turns: { turns, more },
    spendUsd: null,
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
    runs: null,
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

function post(id: string, author: string, kind: Post['kind']): Post {
  return {
    id,
    at: ago(70),
    author,
    handle: author === 'a-2' ? 'claude-2' : null,
    harness: author === 'a-2' ? 'claude' : null,
    kind,
    direction: 'd-2',
    text: 'After the filter, the gap is 34% smaller on seed 1.',
    replyTo: null,
    mentions: [],
    proof: [{ type: 'run', run: 'r-3' }],
  };
}

function run(id: string, status: Run['status'], exitCode: number | null): Run {
  return {
    id,
    agent: 'a-2',
    direction: 'd-2',
    status,
    command: 'python probe_train.py --seed 1',
    why: 'seed 1',
    where: 'local',
    commit: 'a3f9c2e',
    exitCode,
    queuedAt: ago(88),
    startedAt: ago(88),
    endedAt: null,
    metrics: {},
    note: null,
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
  ],
  byVerifold: false,
  options: [
    {
      label: 'Rent 1 H100 for 3 hours',
      usd: 11.97,
      minutes: 180,
      effect: null,
    },
  ],
  pick: 0,
  state: 'open',
  answer: null,
  words: null,
  undoUntil: null,
  note: null,
  post: 'p-12',
};

const longMessage = `${'The probe reads the answer early on every layer from 12 to 28. '.repeat(8)}That is the gap.`;

/** The story of the v9 canvas's direction artboard: claude-2 on the probe direction, three turns, waiting for the person. */
const turns = [
  turn(
    '0a1b2c3d.t1',
    124,
    118,
    { search: 4, page: 3, edit: 2 },
    'Plan: train linear probes on Qwen3.5-9B, layers 12 to 28.',
  ),
  turn('0a1b2c3d.t2', 91, 67, { command: 9, run: 1, post: 1 }, longMessage, {
    runs: ['r-3', 'r-7'],
    posts: ['p-9', 'p-404'],
  }),
  turn(
    '0a1b2c3d.t3',
    58,
    56,
    { other: 1, post: 1 },
    'codex-2 is right that one seed can be luck.',
    {
      message: {
        text: 'codex-2 is right that one seed can be luck.',
        trimmed: true,
      },
      posts: ['p-11'],
      proofByTime: true,
    },
  ),
];

function story(fields: Partial<Lab> = {}): Snapshot {
  const lab: Lab = {
    question: 'Can cheap training make the CoT faithful?',
    postLimit: 4000,
    startedAt: ago(600),
    agentsHere: true,
    paused: null,
    budget: null,
    money: { plansUsd: 3.1, gpuUsd: 4.2, gpuLimitUsd: 25 },
    needsYou: [call],
    answered: [],
    directions: [
      direction('d-2', 'The CoT matches what probes read inside', 'a-2', {
        disputed: true,
        bar: 'The gap shrinks 30% against a length-matched control.',
        runs: 3,
        noise: '±0.02',
        evidence: {
          text: 'Gap 34% smaller on seed 1',
          post: 'p-9',
          run: 'r-3',
        },
      }),
      direction('d-3', 'The answer follows what the CoT says', 'a-3'),
      direction('d-5', 'An old line of attack', 'a-5', {
        state: 'stopped',
        verdict: 'ruled-out',
      }),
      direction('d-6', 'A direction whose agent this view leaves out', 'a-6'),
    ],
    agents: [
      agent(
        'a-2',
        'claude-2',
        'claude',
        { state: 'waiting', text: 'Waiting for you', since: ago(12) },
        turns,
        true,
      ),
      agent('a-3', 'codex-1', 'codex', {
        state: 'working',
        text: 'Running plant_errors.py',
        since: ago(6),
      }),
      agent('a-5', 'claude-5', 'claude', {
        state: 'ended',
        text: 'Stopped',
        since: ago(300),
      }),
    ],
    plan: null,
    board: {
      posts: [post('p-9', 'a-2', 'claim'), post('p-11', 'a-2', 'status')],
      more: false,
    },
    disputes: [],
    runs: [run('r-3', 'done', 0), run('r-7', 'done', null)],
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
    rev: 3,
    at: ago(0),
    project: 'CoT faithfulness',
    lab,
    trimmed: false,
  };
}

const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
const actions: LabActions = {
  post: ok,
  pause: ok,
  answer: ok,
  words: ok,
  undo: ok,
  skip: ok,
  questions: ok,
};

const agentStub: AgentActions = {
  message: () => Promise.resolve({ ok: true }),
  turns: () => Promise.resolve({ error: 'not in this test' }),
  turn: () => Promise.resolve({ error: 'not in this test' }),
  thread: () => Promise.resolve({ error: 'not in this test' }),
};

function render(
  snapshot: Snapshot,
  hash: string,
  connection: LabState['connection'] = 'live',
): string {
  return renderToStaticMarkup(
    <Screen
      state={{ snapshot, connection, retrying: false }}
      route={parseRoute(hash)}
      now={now}
      actions={actions}
      agentActions={agentStub}
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

function step(index: number, fields: Partial<Step>): Step {
  return {
    index,
    id: `s-${index}`,
    parent: null,
    type: 'tool',
    kind: 'command',
    words: 'Running python probe_train.py',
    title: 'python probe_train.py --layers 12-28 --seed 1',
    status: 'done',
    at: ago(80),
    endedAt: ago(61),
    input: null,
    output: null,
    text: null,
    ...fields,
  };
}

/** Turns T1 to Tn, one minute apart, oldest first. */
function series(from: number, to: number): Turn[] {
  return Array.from({ length: to - from + 1 }, (_, place) => {
    const n = from + place;
    return turn(`0a1b2c3d.t${n}`, 1000 - n, 999 - n, { command: 1 }, null);
  });
}

await test('routes: a direction, one of its turns, and turn IDs that need encoding', () => {
  assert.deepEqual(parseRoute('#/d/d-2'), {
    page: 'direction',
    direction: 'd-2',
  });
  // A turn ID can hold "#" and ":", so links encode it, and the route decodes it.
  const id = '0a1b2c3d.toolu_01#2:x';
  const link = href.turn('d-2', id);
  assert.equal(link, '#/d/d-2/turn/0a1b2c3d.toolu_01%232%3Ax');
  assert.deepEqual(parseRoute(link), {
    page: 'turn',
    direction: 'd-2',
    turn: id,
  });
  // A run opens on its direction's page.
  assert.equal(href.run('d-2', 'r-3'), '#/d/d-2/run/r-3');
  assert.deepEqual(parseRoute('#/d/d-2/run/r-3'), {
    page: 'direction',
    direction: 'd-2',
    run: 'r-3',
  });
  for (const hash of [
    '#/d/d-2/turn/not-a-turn',
    '#/d/d-2/turn/%E0%A4%A',
    '#/d/d-2/turn/',
    '#/d/../turn/0a1b2c3d.t1',
    '#/d/d-2/turns/0a1b2c3d.t1',
    '#/d/d-2/run/p-3',
    '#/d/d-2/run/r-0',
  ])
    assert.deepEqual(parseRoute(hash), { page: 'unknown' }, hash);
});

await test('a turn folds into one line of its work, counted the way the harness apps count it', () => {
  assert.deepEqual(counted(none), []);
  assert.deepEqual(
    counted({ ...none, search: 1, read: 2, command: 9, run: 1 }),
    ['1 search', '2 files read', '9 commands', '1 run'],
  );
  // A tool call of no known kind counts as what it is.
  assert.deepEqual(counted({ ...none, other: 1 }), ['1 other tool call']);
  assert.deepEqual(counted({ ...none, other: 2 }), ['2 other tool calls']);
  const [first, second] = turns;
  assert.ok(first && second);
  assert.equal(
    turnSummary(first, now),
    'Worked 6 min · 4 searches · 3 pages · 2 edits',
  );
  assert.equal(
    turnSummary(second, now),
    'Worked 24 min · 9 commands · 1 run · 1 post',
  );
  assert.equal(stepTotal(second), 11);
  // A turn that still runs counts its time up to now.
  assert.equal(
    turnSummary(turn('0a1b2c3d.t9', 6, null, { command: 3 }, null), now),
    'Working · 6 min · 3 commands',
  );
  assert.equal(
    turnSummary(turn('0a1b2c3d.t8', 2, 1, {}, 'ok'), now),
    'Worked 1 min',
  );
});

await test('a running command that finishes changes the refresh key, with no new tool call', () => {
  const running = turn('0a1b2c3d.t9', 6, null, { command: 3 }, null, {
    rev: 41,
  });
  // The same counts: the command only finished, or its output grew.
  const finished = { ...running, rev: 44 };
  assert.equal(stepTotal(running), stepTotal(finished));
  assert.notEqual(refreshKey(running), refreshKey(finished));
  // The turn ending changes it too.
  assert.notEqual(
    refreshKey(finished),
    refreshKey({ ...finished, endedAt: ago(0) }),
  );
  assert.equal(refreshKey(finished), refreshKey({ ...finished }));
});

await test('from an older server: a turn without a revision or proof, and a lab without a post limit', () => {
  // Fields added after version 1 can be absent (see the protocol's header).
  const old: Turn = {
    id: '0a1b2c3d.t9',
    startedAt: ago(6),
    endedAt: null,
    counts: { ...none, command: 3 },
    message: { text: 'Reading the probe logs.', trimmed: false },
  };
  // Such a server takes no `limit` or `tools`: the fold reads the newest page.
  assert.deepEqual(foldQuery(old), {});
  assert.deepEqual(foldQuery({ ...old, rev: 3 }), { limit: 8, tools: true });
  // Without a revision, a new tool call, new words, or the end move the refresh key.
  assert.equal(refreshKey(old), refreshKey({ ...old }));
  for (const changed of [
    { ...old, counts: { ...none, command: 4 } },
    {
      ...old,
      message: { text: 'Reading the probe logs. Done.', trimmed: false },
    },
    { ...old, endedAt: ago(0) },
  ])
    assert.notEqual(refreshKey(old), refreshKey(changed));
  const snapshot = story({
    agents: [
      agent(
        'a-2',
        'claude-2',
        'claude',
        { state: 'working', text: 'Running probe_train.py', since: ago(2) },
        [old],
      ),
    ],
  });
  assert.ok(snapshot.lab);
  const { postLimit, ...lab } = snapshot.lab;
  assert.equal(postLimit, 4000);
  const html = render({ ...snapshot, lab }, '#/d/d-2');
  assert.match(text(html), /Working · 6 min · 3 commands/);
  assert.doesNotMatch(html, /turn__proof/);
  // The box falls back to the board's usual limit.
  assert.match(html, /maxLength="4000"|maxlength="4000"/);
});

await test('older turns and a moving newest page: a gap is read before anything older shows, so no turn goes missing', () => {
  // The person read T1 to T20, which end before T21, the first of the snapshot's page T21 to T40.
  const older = { turns: series(1, 20), more: false, anchor: '0a1b2c3d.t21' };
  const before = joinTurns(older, series(21, 40));
  assert.equal(before.gap, null);
  assert.deepEqual(
    before.turns.map((entry) => entry.id),
    series(1, 40).map((entry) => entry.id),
  );
  // Two new turns: the page is T23 to T42, so T21 and T22 are in neither list.
  const after = joinTurns(older, series(23, 42));
  assert.equal(after.gap, '0a1b2c3d.t23');
  // Until the gap is read, only the newest page shows: never a list with a hole.
  assert.deepEqual(
    after.turns.map((entry) => entry.id),
    series(23, 42).map((entry) => entry.id),
  );
  // The page before T23 (T3 to T22) reaches the old anchor, so the gap is filled.
  const refilled = filled(older, [series(3, 22)], '0a1b2c3d.t23');
  assert.ok(refilled);
  const joined = joinTurns(refilled, series(23, 42));
  assert.equal(joined.gap, null);
  assert.deepEqual(
    joined.turns.map((entry) => entry.id),
    series(1, 42).map((entry) => entry.id),
  );
  // Pages that never reach the old anchor give the older turns up.
  assert.equal(filled(older, [series(30, 31)], '0a1b2c3d.t32'), null);
  // A turn read twice shows once, with its newest copy.
  const updated = { ...series(5, 5)[0], rev: 9 } as Turn;
  const merged = byStart([series(4, 6), [updated]]);
  assert.deepEqual(
    merged.map((entry) => [entry.id, entry.rev]),
    [
      ['0a1b2c3d.t4', 1],
      ['0a1b2c3d.t5', 9],
      ['0a1b2c3d.t6', 1],
    ],
  );
});

await test('pages of steps merge by index with no repeats, and earlier pages must meet the newest', () => {
  const merged = byIndex([
    [step(3, {}), step(4, {})],
    [step(4, { status: 'failed' }), step(5, {})],
  ]);
  assert.deepEqual(
    merged.map((entry) => [entry.index, entry.status]),
    [
      [3, 'done'],
      [4, 'failed'],
      [5, 'done'],
    ],
  );
  assert.ok(meet([step(1, {}), step(2, {})], [step(3, {})]));
  assert.ok(meet([step(1, {}), step(2, {})], [step(2, {}), step(3, {})]));
  assert.ok(!meet([step(1, {}), step(2, {})], [step(9, {})]));
  assert.ok(meet([], [step(9, {})]));
});

await test('a model shows by name, with its version only when the ID names one', () => {
  assert.equal(modelName('claude-opus-5-5[1m]'), 'Opus 5.5 (1M)');
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-5-5-20260901'), 'Sonnet 5.5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
  // An alias moves to newer models, so it shows no version.
  assert.equal(modelName('opus[1m]'), 'Opus (1M)');
  assert.equal(modelName('opus'), 'Opus');
  assert.equal(modelName('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(modelName('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(modelName('o3-mini'), 'o3-mini');
});

await test('a run chip says how the run ended, and never "exit null"', () => {
  assert.equal(runLabel(run('r-3', 'done', 0)), 'Run r-3');
  assert.equal(runLabel(run('r-3', 'done', 2)), 'Run r-3 · exit 2');
  assert.equal(runLabel(run('r-3', 'done', null)), 'Run r-3 · ended');
  assert.equal(runLabel(run('r-3', 'running', null)), 'Run r-3 · running');
  assert.equal(runLabel(run('r-3', 'timed-out', null)), 'Run r-3 · timed-out');
});

await test('a step reads as a verb and what it acted on: past when done, present while it runs', () => {
  assert.equal(stepVerb(step(0, {})), 'Ran');
  assert.equal(stepVerb(step(0, { status: 'running' })), 'Running');
  assert.equal(stepVerb(step(0, { kind: 'search' })), 'Searched');
  assert.equal(
    stepWhat(step(0, { kind: 'search', title: 'qwen sae' })),
    '"qwen sae"',
  );
  assert.equal(
    stepWhat(step(0, { kind: 'edit', title: 'filter.py' })),
    'filter.py',
  );
  assert.equal(
    stepWhat(step(0, { kind: 'other', title: 'verifold_board' })),
    'a tool: verifold_board',
  );
  assert.equal(
    stepWhat(step(0, { kind: 'read', title: null, words: 'Reading a file' })),
    'Reading a file',
  );
  // Words that are not tool calls show their first line.
  assert.equal(
    stepWhat(
      step(0, {
        type: 'thinking',
        kind: null,
        text: { text: 'First\nsecond', trimmed: false },
      }),
    ),
    'First',
  );
  assert.equal(stepVerb(step(0, { type: 'thinking', kind: null })), 'Thought');
  assert.equal(stepVerb(step(0, { type: 'request', kind: null })), 'Message');
});

await test('the direction page: its head, its turns folded with their messages and proof, the wait, and a box to the agent', () => {
  const html = render(story(), '#/d/d-2');
  const page = text(html);
  assert.match(html, /<a class="back" href="#\/">/);
  assert.match(page, /Disputed The CoT matches what probes read inside/);
  assert.match(
    page,
    /claude-2 · Claude Opus 5\.5 \(1M\) · Holds up if the gap shrinks 30% against a length-matched control\. 3 runs, noise ±0\.02\. Now: Gap 34% smaller on seed 1\./,
  );
  // The model's own ID stays in a title.
  assert.match(
    html,
    /<span title="claude-opus-5-5\[1m\]">Opus 5\.5 \(1M\)<\/span>/,
  );
  // Every turn is folded: one line of its work, a closed fold, and no steps yet.
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length >= 3, true);
  assert.doesNotMatch(html, /class="steps"/);
  assert.match(
    page,
    new RegExp(
      `${clock(turns[1]?.startedAt ?? '')} Worked 24 min · 9 commands · 1 run · 1 post`,
    ),
  );
  assert.match(page, /Plan: train linear probes on Qwen3\.5-9B/);
  // A long message folds, with "Show all". A cut one points to the turn's page once it shows in full.
  assert.match(html, /turn__text turn__text--folded/);
  assert.match(page, /Show all/);
  assert.match(
    html,
    /href="#\/d\/d-2\/turn\/0a1b2c3d\.t3">The rest of this message/,
  );
  // What a turn left behind comes from its own tool calls: runs and posts by ID, a missing one by its ID.
  assert.match(
    page,
    /Run r-3 Run r-7 · ended Claim on the board Post on the board/,
  );
  assert.doesNotMatch(page, /exit null/);
  // Proof matched by time says so.
  assert.match(html, /title="Matched by the time the turn ran/);
  // Older turns can be read on request.
  assert.match(page, /Show older turns/);
  // It waits for the person, with the call to decide.
  assert.match(page, /Waiting for your answer · 12 min/);
  assert.match(html, /href="#\/call\/c-4">Decide/);
  // The box writes to this agent, takes the lab's post limit, and says when the agent reads the message.
  assert.match(html, /aria-label="What claude-2 did"/);
  assert.match(html, /placeholder="Message claude-2"/);
  assert.match(html, /maxLength="4000"|maxlength="4000"/);
  assert.match(
    page,
    /claude-2 reads your message at the start of its next turn\./,
  );
  // The box follows the snapshot's limit.
  assert.match(
    render(story({ postLimit: 1200 }), '#/d/d-2'),
    /maxLength="1200"|maxlength="1200"/,
  );
});

await test('the direction page of a working agent, of one without turns, of a paused lab, of a stopped one, and of one left out', () => {
  const working = text(render(story(), '#/d/d-3'));
  assert.match(working, /Running plant_errors\.py · 6 min/);
  assert.match(working, /codex-1 has no turns yet\./);
  assert.match(working, /Codex GPT-6 Astra/);
  assert.match(
    working,
    /codex-1 is working\. Your message reaches it during this turn, or at the start of its next one\./,
  );
  const paused = text(
    render(story({ paused: { at: ago(5), reason: 'person' } }), '#/d/d-3'),
  );
  assert.match(
    paused,
    /The lab is paused\. codex-1 reads your message after you resume it\./,
  );
  const stopped = render(story(), '#/d/d-5');
  assert.match(text(stopped), /Ruled out An old line of attack/);
  assert.match(
    text(stopped),
    /claude-5 has stopped, so messages no longer reach it\. Write to the lab instead\./,
  );
  assert.doesNotMatch(stopped, /class="composer"/);
  const leftOut = text(render(story(), '#/d/d-6'));
  assert.match(
    leftOut,
    /This view of a large lab leaves out the direction's agent\./,
  );
  // A direction that the lab does not have.
  assert.match(
    text(render(story(), '#/d/d-9')),
    /This direction is not in the lab/,
  );
});

await test('a run link opens its direction with the run marked, says when the page does not show the run, and says when a large lab leaves the direction out', () => {
  // claude-2's second turn started r-3 and r-7.
  const marked = render(story(), href.run('d-2', 'r-3'));
  assert.match(
    marked,
    /<a href="#\/run\/r-3" id="run-r-3" class="proof proof--target">Run r-3<\/a>/,
  );
  assert.match(marked, /<a href="#\/run\/r-7" id="run-r-7" class="proof">/);
  assert.doesNotMatch(text(marked), /is not in/);
  // A run in a turn that the page has not read yet: the page says where to look.
  assert.match(
    text(render(story(), href.run('d-2', 'r-12'))),
    /Run r-12 is not in the turns on this page\. It may be in an older turn\. Show older turns/,
  );
  // An agent with no older turns: the run is not in them.
  assert.match(
    text(render(story(), href.run('d-3', 'r-12'))),
    /Run r-12 is not in codex-1's turns\./,
  );
  assert.equal(runPlace('r-3', turns, false), 'shown');
  assert.equal(runPlace('r-12', turns, true), 'older');
  assert.equal(runPlace('r-12', turns, false), 'absent');
  // A direction that this view of a large lab leaves out says so, with the way back.
  const out = render(
    story({ omitted: { directions: 40 } }),
    href.run('d-40', 'r-3'),
  );
  assert.match(text(out), /This view of a large lab leaves out this direction/);
  assert.match(out, /<a href="#\/">Back to the lab<\/a>/);
  assert.doesNotMatch(text(out), /not in the lab/);
});

await test('the turn page shows the turn from the snapshot while its steps load, with a way back', () => {
  const html = render(story(), href.turn('d-2', '0a1b2c3d.t2'));
  const page = text(html);
  assert.match(html, /<a class="back" href="#\/d\/d-2">/);
  assert.match(page, /claude-2's direction/);
  assert.match(
    page,
    new RegExp(`claude-2 at ${clock(turns[1]?.startedAt ?? '')}`),
  );
  assert.match(page, /Worked 24 min · 9 commands · 1 run · 1 post/);
  assert.match(page, /Reading the steps…/);
  assert.match(page, /That is the gap\./);
});

await test('the turn page of an agent that the snapshot leaves out says so, and still reads the turn', () => {
  const page = text(render(story(), href.turn('d-6', '0a1b2c3d.t1')));
  assert.doesNotMatch(page, /This page does not exist/);
  assert.match(page, /a-6's direction/);
  assert.match(page, /A turn of a-6/);
  assert.match(
    page,
    /This view of a large lab leaves out the direction's agent\./,
  );
  assert.match(page, /Reading the steps…/);
});

await test('an open fold lists the newest tool calls, counts the earlier ones from the turn, and links to every step', () => {
  const steps = Array.from({ length: 8 }, (_, place) =>
    step(place + 3, { title: `python step_${place}.py` }),
  );
  const html = renderToStaticMarkup(
    <StepList
      id="s"
      steps={steps}
      total={11}
      turnHref={href.turn('d-2', '0a1b2c3d.t2')}
    />,
  );
  const page = text(html);
  assert.match(page, /3 earlier steps/);
  assert.match(page, /Ran python step_0\.py/);
  assert.match(page, /Ran python step_7\.py/);
  assert.match(html, /href="#\/d\/d-2\/turn\/0a1b2c3d\.t2">Open every step/);
  assert.doesNotMatch(page, /No tool calls/);
  // "No tool calls" only when the turn's counts say so.
  const quiet = text(
    renderToStaticMarkup(
      <StepList id="s" steps={[]} total={0} turnHref="#/" />,
    ),
  );
  assert.match(quiet, /No tool calls in this turn\./);
  // A page that came back empty, for a turn with tool calls, still says how many there were.
  const empty = text(
    renderToStaticMarkup(
      <StepList id="s" steps={[]} total={2} turnHref="#/" />,
    ),
  );
  assert.match(empty, /2 earlier steps/);
  assert.doesNotMatch(empty, /No tool calls/);
});

/** A command that ended well after 2 seconds. */
function quick(index: number, title: string, fields: Partial<Step> = {}): Step {
  const at = ago(10);
  return step(index, {
    title,
    at,
    endedAt: new Date(Date.parse(at) + 2_000).toISOString(),
    ...fields,
  });
}

await test('short commands in a row fold into one line, with the thoughts between them, and anything else ends the row', () => {
  const thought = (index: number): Step =>
    step(index, { type: 'thinking', kind: null, endedAt: null });
  const shape = (steps: readonly Step[]): string[] =>
    stepLines(steps).map((line) =>
      'step' in line
        ? String(line.step.index)
        : `${line.commands}:${line.steps.map((entry) => entry.index).join(',')}`,
    );
  assert.deepEqual(
    shape([
      thought(0),
      step(1, {}),
      quick(2, 'ls'),
      thought(3),
      quick(4, 'cat gap.json'),
      quick(5, 'head train.log'),
      thought(6),
      step(7, { type: 'text', kind: null, endedAt: null }),
      quick(8, 'ls'),
      quick(9, 'wc -l out.csv'),
    ]),
    // A thought before the row and after it stays out of it; two commands do not fold.
    ['0', '1', '3:2,3,4,5', '6', '7', '8', '9'],
  );
  // A command that failed, still runs, or took 10 seconds or more ends the row.
  for (const breaker of [
    quick(3, 'pytest', { status: 'failed' }),
    quick(3, 'sleep 1', { status: 'running', endedAt: null }),
    quick(3, 'sleep 10', {
      endedAt: new Date(Date.parse(ago(10)) + 10_000).toISOString(),
    }),
    step(3, { kind: 'read', title: 'gap.json' }),
  ])
    assert.deepEqual(
      shape([quick(1, 'ls'), quick(2, 'ls'), breaker, quick(4, 'ls')]),
      ['1', '2', '3', '4'],
      breaker.title ?? '',
    );
  // The fold's list folds them too, and names the long command apart.
  const fold = text(
    renderToStaticMarkup(
      <StepList
        id="s"
        steps={[
          quick(1, 'ls'),
          quick(2, 'cat gap.json'),
          quick(3, 'head train.log'),
          quick(4, 'wc -l out.csv'),
          step(5, { title: 'python filter.py --keep 0.3' }),
        ]}
        total={5}
        turnHref="#/"
      />,
    ),
  );
  assert.match(
    fold,
    /Ran 4 short commands Ran python filter\.py --keep 0\.3 Open every step/,
  );
  // On the turn's page the line opens its rows on Show.
  const row = renderToStaticMarkup(
    <ol>
      <StepGroup
        steps={[quick(1, 'ls'), quick(2, 'cat gap.json'), quick(3, 'ls')]}
        commands={3}
      />
    </ol>,
  );
  assert.match(
    text(row),
    new RegExp(`Ran 3 short commands Show ${clock(ago(10))}`),
  );
  assert.match(row, /aria-expanded="false"/);
  assert.doesNotMatch(row, /cat gap\.json/);
});

await test('a step on the turn page: a command shows the end of its output, other steps open on a button', () => {
  const command = renderToStaticMarkup(
    <StepRow
      step={step(3, {
        output: {
          text: 'layer 20  probe acc 0.93\nsaved results/r-3/gap.json',
          trimmed: true,
        },
      })}
    />,
  );
  assert.match(command, /class="step-row step-row--log"/);
  assert.match(command, /<pre class="log">layer 20 {2}probe acc 0\.93/);
  assert.match(text(command), /Output, the last lines/);
  assert.match(
    text(command),
    /Ran python probe_train\.py --layers 12-28 --seed 1/,
  );
  assert.match(text(command), /19 min/);
  const failed = text(
    renderToStaticMarkup(<StepRow step={step(4, { status: 'failed' })} />),
  );
  assert.match(failed, /failed/);
  const running = renderToStaticMarkup(
    <StepRow step={step(5, { status: 'running', endedAt: null })} />,
  );
  assert.match(running, /step-row__dot/);
  assert.match(text(running), /Running python probe_train\.py/);
  const search = renderToStaticMarkup(
    <StepRow
      step={step(6, {
        kind: 'search',
        title: 'qwen sae',
        input: { text: '{"query":"qwen sae"}', trimmed: false },
        output: { text: '6 results', trimmed: false },
      })}
    />,
  );
  assert.match(search, /aria-expanded="false"/);
  assert.match(text(search), /Show input and output/);
  assert.doesNotMatch(search, /<pre/);
  const thought = renderToStaticMarkup(
    <StepRow
      step={step(7, {
        type: 'thinking',
        kind: null,
        title: null,
        text: { text: 'Check the control length first.', trimmed: false },
      })}
    />,
  );
  // A one-line thought shows in full in its row, so nothing opens.
  assert.match(text(thought), /Thought Check the control length first\./);
  assert.doesNotMatch(text(thought), /Show the words/);
  const long = renderToStaticMarkup(
    <StepRow
      step={step(8, {
        type: 'thinking',
        kind: null,
        title: null,
        text: {
          text: 'Check the control length first.\nThen rerun.',
          trimmed: false,
        },
      })}
    />,
  );
  assert.match(
    text(long),
    /Thought Check the control length first\. .* Show the words/,
  );
});

await test("the agent actions post in the direction without an @handle, and read pages with the token, the query, and the caller's signal", async (t) => {
  const seen: {
    url: string;
    auth: string | null;
    body: unknown;
    signal: AbortSignal | null;
  }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    seen.push({
      url,
      auth: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      signal: init?.signal ?? null,
    });
    return Promise.resolve(
      url.includes('/actions/')
        ? Response.json({ ok: true })
        : Response.json(
            url.includes('/turns/')
              ? { turn: { id: 't' }, steps: [], more: false }
              : { turns: [], more: false },
          ),
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const reads = agentActions('tok');
  assert.deepEqual(await reads.message('d-2', 'try a 4-bit 27B', 'k1'), {
    ok: true,
  });
  assert.equal(seen[0]?.url, '/api/v1/actions/lab-post');
  assert.deepEqual(seen[0]?.body, {
    text: 'try a 4-bit 27B',
    direction: 'd-2',
    key: 'k1',
  });
  const controller = new AbortController();
  assert.ok(
    'value' in
      (await reads.turn(
        'a-2',
        '0a1b2c3d.t#1',
        { limit: 8, tools: true },
        controller.signal,
      )),
  );
  assert.equal(
    seen[1]?.url,
    '/api/v1/agents/a-2/turns/0a1b2c3d.t%231?limit=8&tools=1',
  );
  assert.equal(seen[1]?.auth, 'Bearer tok');
  assert.equal(seen[1]?.signal, controller.signal);
  assert.ok('value' in (await reads.turns('a-2', '0a1b2c3d.t1')));
  assert.equal(seen[2]?.url, '/api/v1/agents/a-2/turns?before=0a1b2c3d.t1');
  // Without a token nothing is sent.
  const signedOut = agentActions(null);
  assert.ok('refused' in (await signedOut.message('d-2', 'x', 'k')));
  assert.ok('error' in (await signedOut.turn('a-2', 't', {})));
  assert.equal(seen.length, 3);
});

await test('detail reads use the token, encode their IDs, and say why when they fail', async (t) => {
  assert.equal(
    paths.turns('a-2', '0a1b2c3d.t#1'),
    '/api/v1/agents/a-2/turns?before=0a1b2c3d.t%231',
  );
  assert.equal(
    paths.turn('a-2', '0a1b2c3d.t#1', { before: 40 }),
    '/api/v1/agents/a-2/turns/0a1b2c3d.t%231?before=40',
  );
  assert.equal(
    paths.turn('a-2', '0a1b2c3d.t1'),
    '/api/v1/agents/a-2/turns/0a1b2c3d.t1',
  );
  const answers: Response[] = [
    Response.json({ turn: { id: 't' }, steps: [], more: false }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 401 }),
    Response.json({ steps: 'no' }),
    new Response(null, { status: 503 }),
  ];
  const seen: { url: string; auth: string | null }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    seen.push({
      url,
      auth: new Headers(init?.headers).get('Authorization'),
    });
    const answer = answers.shift();
    return answer
      ? Promise.resolve(answer)
      : Promise.reject(new TypeError('offline'));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const path = paths.turn('a-2', '0a1b2c3d.t1');
  const ok = await load('tok', path, isTurnDetail);
  assert.ok('value' in ok);
  assert.deepEqual(seen[0], { url: path, auth: 'Bearer tok' });
  assert.deepEqual(await load('tok', path, isTurnDetail), {
    error: 'Verifold no longer has this. The lab may have moved on.',
  });
  assert.deepEqual(await load('tok', path, isTurnDetail), {
    error:
      'This tab has no access key. Open Verifold from your terminal again.',
  });
  assert.deepEqual(await load('tok', path, isTurnDetail), {
    error: 'Verifold sent something this page cannot read. Reload it.',
  });
  assert.deepEqual(await load('tok', path, isTurnPage), {
    error: 'Verifold could not send this. Try again.',
  });
  assert.deepEqual(await load('tok', path, isTurnPage), {
    error: "Can't reach Verifold. Try again.",
  });
  assert.ok(isTurnPage({ turns: [], more: true }));
  assert.ok(!isTurnPage({ turns: [] }));
});
