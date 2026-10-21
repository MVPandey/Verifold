import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { liveOf, stepKind, turnsOf } from '../src/core/activity.ts';
import {
  claudeUpdates,
  codexAppUpdates,
  requestUpdate,
  TranscriptLog,
  TranscriptWriter,
  type TranscriptUpdate,
} from '../src/core/transcript.ts';
import { ApiReader, apiLimits, type ApiSources } from '../src/server/api.ts';
import { startDesk } from '../src/server/desk.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import { computeDefaults, type ComputeView } from '../src/core/compute.ts';
import { SessionActionError } from '../src/core/session.ts';
import type {
  AgentRecord,
  Call,
  Check,
  Direction,
  Lab,
  LabState,
  LabView,
} from '../src/core/lab.ts';
import type { Post } from '../src/core/board.ts';
import type { RunRecord } from '../src/core/runs.ts';
import type { Lease } from '../src/core/leases.ts';
import type { SessionPool } from '../src/core/workers.ts';
import type {
  BoardPage,
  Snapshot,
  TurnDetail,
  TurnPage,
} from '../src/protocol/api.ts';

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 20, 9, minute)).toISOString();

/** Session IDs in the shape that Verifold gives them. */
const sessionOf = {
  a1: '20261020T090000000Z-aaaaaaa1',
  a2: '20261020T090000000Z-aaaaaaa2',
};

/** Synthetic Claude Code stream events, in the shape that `claude -p --output-format stream-json` writes. */
const claude = {
  init: { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
  text: (text: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }),
  thinking: (thinking: string) => ({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking }] },
  }),
  tool: (id: string, name: string, input: unknown, parent?: string) => ({
    type: 'assistant',
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }),
  result: (id: string, content: string, parent?: string) => ({
    type: 'user',
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  }),
  end: { type: 'result', duration_ms: 64_000 },
};

/** The updates of one Claude Code session: two turns, the second still running a command. */
function claudeSession(output = 'gap 0.34\n'): TranscriptUpdate[] {
  return [
    requestUpdate('Your direction: the CoT matches what probes read inside.'),
    ...claudeUpdates(claude.init),
    ...claudeUpdates(claude.thinking('I check the newest models first.')),
    ...claudeUpdates(
      claude.tool('t1', 'WebSearch', { query: 'Qwen3.5 SAE release' }),
    ),
    ...claudeUpdates(claude.result('t1', '6 results')),
    ...claudeUpdates(
      claude.tool('t2', 'Agent', { prompt: 'Read the SAE card.' }),
    ),
    ...claudeUpdates(
      claude.tool(
        't3',
        'WebFetch',
        { url: 'https://huggingface.co/Qwen' },
        't2',
      ),
    ),
    ...claudeUpdates(claude.result('t3', 'A model card.', 't2')),
    ...claudeUpdates(claude.result('t2', 'The SAE covers layers 0-35.')),
    ...claudeUpdates(
      claude.tool('t4', 'Bash', {
        command: 'cd work && python probe_train.py --seed 1',
      }),
    ),
    ...claudeUpdates(claude.result('t4', output)),
    ...claudeUpdates(
      claude.tool('t5', 'mcp__verifold__verifold_post', {
        kind: 'claim',
        text: 'Gap 34% smaller.',
      }),
    ),
    ...claudeUpdates(claude.result('t5', 'Posted p-2.')),
    ...claudeUpdates(claude.text('Seed 1: the gap is 34% smaller.')),
    ...claudeUpdates(claude.end),
    requestUpdate('New posts: codex-1 objects to p-2.'),
    ...claudeUpdates(
      claude.tool('t6', 'Bash', {
        command: 'python probe_train.py --seed 2',
      }),
    ),
  ];
}

/** The updates of one Codex session: one turn with a command and a message. */
function codexSession(): TranscriptUpdate[] {
  return [
    requestUpdate('Your direction: the answer follows what the CoT says.'),
    ...codexAppUpdates(
      'item/started',
      { id: 'c1', type: 'commandExecution', command: 'python plant.py' },
      null,
    ),
    ...codexAppUpdates(
      'item/completed',
      {
        id: 'c1',
        type: 'commandExecution',
        command: 'python plant.py',
        aggregatedOutput: 'ok\n',
        exitCode: 0,
      },
      null,
    ),
    ...codexAppUpdates(
      'item/completed',
      { id: 's1', type: 'webSearch', query: 'CoT faithfulness 2026' },
      null,
    ),
    ...codexAppUpdates(
      'item/completed',
      { id: 'm1', type: 'agentMessage', text: 'Planted errors move 6%.' },
      null,
    ),
  ];
}

/** A log of updates, as the desk reads it from a transcript file. */
function logOf(updates: readonly TranscriptUpdate[]): TranscriptLog {
  const log = new TranscriptLog();
  const apply = log.run();
  for (const update of updates) apply(update);
  return log;
}

async function writeTranscript(
  root: string,
  session: string,
  updates: readonly TranscriptUpdate[],
): Promise<void> {
  await mkdir(join(root, '.verifold', 'sessions'), { recursive: true });
  const writer = await TranscriptWriter.open(
    join(root, '.verifold', 'sessions', `${session}.transcript.jsonl`),
  );
  const apply = writer.run();
  for (const update of updates) apply(update);
  await writer.flushed();
}

function agentRecord(
  id: string,
  handle: string,
  host: 'claude' | 'codex',
  direction: string,
  session: string | null,
): AgentRecord {
  return {
    schemaVersion: 1,
    id,
    handle,
    host,
    model: host === 'claude' ? 'opus[1m]' : 'gpt-6-astra',
    direction,
    startedAt: at(0),
    stoppedAt: null,
    stopReason: null,
    generation: 'gen-SECRET-1',
    session,
    toolsVersion: 2,
    readThrough: 3,
    seen: [],
    cursor: 7,
    wakeups: ['wake-SECRET'],
    events: [{ kind: 'post', text: 'event-SECRET', seq: 1, at: at(1) }],
    idleStreak: 0,
    quietTurns: 0,
    quietWork: 0,
    nudged: false,
    finished: false,
    folder: null,
    restarts: [],
    actions: [],
    lastRead: { key: 'k', text: 'read-SECRET rpa_FAKEKEY123' },
    held: false,
    pods: false,
  };
}

function direction(id: string, title: string, agent: string): Direction {
  return {
    id,
    title,
    bar: 'The gap shrinks 30% against a length-matched control.',
    runs: 3,
    noise: '±0.02',
    buildsOn: [{ text: "Qwen's SAEs, April 2026", known: true }],
    openedBy: 'a-1',
    openedAt: at(1),
    state: 'open',
    stoppedAt: null,
    verdict: 'open',
    evidence: null,
    agent,
    workspace: {
      kind: 'git',
      path: `.verifold/workspaces/${id}`,
      branch: `verifold/${id}`,
      start: 'a'.repeat(40),
    },
    head: 'b'.repeat(40),
  };
}

function post(
  id: string,
  author: string,
  kind: Post['kind'],
  text: string,
  more: Partial<Post> = {},
): Post {
  return {
    schemaVersion: 1,
    id,
    at: at(Number(id.slice(2))),
    author,
    kind,
    text,
    mentions: [],
    artifacts: [],
    direction: 'd-1',
    ...more,
  };
}

function runRecord(id: string): RunRecord {
  return {
    schemaVersion: 1,
    id,
    agent: 'a-1',
    key: 'key-SECRET',
    direction: 'd-1',
    harness: 'claude',
    commit: 'c'.repeat(40),
    command: 'python probe_train.py --seed 1',
    why: 'Seed 1 of the bar.',
    status: 'done',
    exitCode: 0,
    queuedAt: at(4),
    startedAt: at(4),
    endedAt: at(23),
    minutes: 60,
    want: [],
    metrics: { gap: 0.34 },
    outputs: [],
    config: 'config-SECRET',
    output: null,
    log: { bytes: 10, cut: false },
    process: null,
    cancelledBy: null,
    note: null,
    told: true,
    folder: 'run-1-1a2b3c4d',
    where: 'local',
  };
}

function check(): Check {
  return {
    id: 'k-1',
    claim: 'p-2',
    objections: ['p-3'],
    holdsUp: false,
    direction: 'd-1',
    run: 'r-1',
    commit: 'c'.repeat(40),
    harness: 'codex',
    sameHarness: false,
    agent: 'a-3',
    handle: 'codex-2',
    model: null,
    state: 'running',
    outcome: null,
    method: null,
    result: null,
    note: null,
    queuedAt: at(30),
    startedAt: at(31),
    endedAt: null,
    restarts: 0,
    session: null,
    generation: 'gen-SECRET-k',
    start: null,
    blind: true,
  };
}

function call(more: Partial<Call> = {}): Call {
  return {
    id: 'c-1',
    at: at(40),
    by: 'a-1',
    direction: 'd-1',
    joined: [{ agent: 'a-2', direction: 'd-2', why: 'Seeds for d-2 too.' }],
    kind: 'cost',
    need: null,
    question: 'Rent an H100 for the probe reruns?',
    options: [
      {
        label: 'Rent 1 H100 for 3 hours',
        usd: 11.97,
        minutes: 180,
        effect: {
          type: 'pod',
          gpuType: 'NVIDIA H100 80GB HBM3',
          hours: 3,
          secrets: ['RUNPOD_FAKE_SECRET'],
        },
      },
      { label: 'Use this Mac', usd: 0, minutes: 540, effect: null },
    ],
    pick: 0,
    why: 'One seed can be luck.',
    undoMinutes: 10,
    deadline: null,
    state: 'open',
    answer: null,
    words: null,
    post: 'p-4',
    undoUntil: null,
    applied: null,
    note: null,
    ...more,
  };
}

/** A lab with two directions, a dispute, a running check, an open call, and an answered one. */
function seededView(): LabView {
  const state: LabState = {
    schemaVersion: 1,
    question: 'Can cheap training make a CoT faithful?',
    startedAt: at(0),
    pausedAt: null,
    pausedFor: null,
    handles: { claude: 1, codex: 2 },
    directions: [
      direction('d-1', 'The CoT matches what probes read inside', 'a-1'),
      direction('d-2', 'The answer follows what the CoT says', 'a-2'),
    ],
    opener: 'a-1',
    plan: {
      post: 'p-1',
      at: at(1),
      reading:
        'Can a cheap fine-tune make the CoT name what drives the answer?',
      cost: 'Nothing costs money yet.',
      directions: ['d-1', 'd-2'],
      facts: [
        {
          claim: 'Qwen3.5-9B, February 2026',
          source: 'https://huggingface.co/Qwen',
          sourceDate: '2026-02-28',
          checkedAt: at(1),
        },
        {
          claim: 'H100 $3.99/h',
          source: null,
          sourceDate: null,
          checkedAt: at(1),
        },
      ],
    },
    budget: { hours: 8, deadline: at(480) },
    agentStarts: [],
    checks: [check()],
    calls: [
      call(),
      call({
        id: 'c-2',
        at: at(2),
        by: 'verifold',
        direction: null,
        joined: [],
        kind: 'go',
        question: 'Continue 4 more hours?',
        options: [
          {
            label: 'Continue',
            usd: null,
            minutes: 240,
            effect: { type: 'hours', hours: 4 },
          },
        ],
        pick: null,
        state: 'answered',
        answer: { option: 0, at: at(3) },
        post: null,
      }),
    ],
    brought: [],
    bringing: null,
    signoff: null,
  };
  const [checkRecord] = state.checks;
  const [first, second] = state.directions;
  assert.ok(checkRecord && first && second);
  return {
    state,
    directions: [
      {
        direction: first,
        agent: agentRecord('a-1', 'claude-1', 'claude', 'd-1', sessionOf.a1),
        status: 'working',
        until: null,
      },
      {
        direction: second,
        agent: agentRecord('a-2', 'codex-1', 'codex', 'd-2', sessionOf.a2),
        status: 'idle',
        until: null,
      },
    ],
    posts: [
      post('p-1', 'a-1', 'plan', 'Plan of record.'),
      post('p-2', 'a-1', 'claim', 'The gap is 34% smaller on seed 1.', {
        artifacts: [{ type: 'run', run: 'r-1' }],
        harness: 'claude',
      }),
      post('p-3', 'a-2', 'objection', 'One seed can be luck.', {
        replyTo: 'p-2',
        harness: 'codex',
      }),
      post('p-4', 'verifold', 'status', 'claude-1 asks the person (c-1).'),
    ],
    handles: { 'a-1': 'claude-1', 'a-2': 'codex-1', 'a-3': 'codex-2' },
    runs: true,
    ledger: [runRecord('r-1')],
    checks: [checkRecord],
    claudeUsd: 2.5,
  };
}

function lease(): Lease {
  return {
    schemaVersion: 1,
    id: 'lease-1',
    state: 'ended',
    requestedBy: 'person',
    reason: 'Seeds 2 and 3.',
    tasks: [],
    directions: ['d-1'],
    secrets: ['RUNPOD_FAKE_SECRET'],
    gpu: 'NVIDIA H100 80GB HBM3',
    image: 'runpod/pytorch',
    diskGb: 50,
    hours: 3,
    rate: 3.99,
    requestedAt: at(41),
    decidedAt: at(41),
    podName: 'verifold-pod-SECRET',
    podId: 'pod-SECRET',
    deadline: null,
    ssh: null,
    intervals: [],
    billedUsd: 4.2,
    billedAt: at(90),
    seen: null,
    activeAt: null,
    notice: null,
    history: [],
    end: { at: at(90), by: 'person', reason: 'Done.' },
  };
}

function computeView(): ComputeView {
  return {
    key: null,
    keyring: 'keychain',
    secrets: [],
    settings: { ...computeDefaults, limitUsd: 25 },
    gpus: null,
    gpusAt: null,
    leases: [lease()],
    budget: { limit: 25, spent: 4.2, reserved: 0, left: 20.8, rate: 0 },
    problem: null,
  };
}

async function project(output?: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-api-')));
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'R',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  await writeTranscript(root, sessionOf.a1, claudeSession(output));
  await writeTranscript(root, sessionOf.a2, codexSession());
  return root;
}

function sources(
  root: string,
  view: () => LabView | null,
  more: Partial<ApiSources> = {},
): () => ApiSources {
  return () => ({
    root,
    lab: { view },
    compute: undefined,
    session: () => null,
    works: [],
    away: () => Promise.resolve(null),
    ...more,
  });
}

await test('a Claude Code transcript becomes turns with counts by kind, the last message, and the running step', () => {
  const turns = turnsOf(logOf(claudeSession()).list());
  assert.equal(turns.length, 2);
  const [first, second] = turns;
  assert.ok(first && second);
  // The helper agent's page read counts too, under its own kind.
  assert.deepEqual(first.counts, {
    search: 1,
    page: 1,
    read: 0,
    command: 1,
    edit: 0,
    run: 0,
    post: 1,
    helper: 1,
    other: 0,
  });
  assert.equal(first.message, 'Seed 1: the gap is 34% smaller.');
  assert.equal(first.request?.text?.startsWith('Your direction'), true);
  assert.equal(first.running, null);
  assert.equal(second.running?.name, 'Bash');
  assert.equal(second.counts.command, 1);
  assert.equal(second.message, null);
});

await test('a Codex transcript becomes one turn, and a steer before any work joins it', () => {
  const [turn] = turnsOf(logOf(codexSession()).list());
  assert.ok(turn);
  assert.equal(turn.counts.command, 1);
  assert.equal(turn.counts.search, 1);
  assert.equal(turn.message, 'Planted errors move 6%.');
  // A prompt and a steer before the agent did anything are one turn.
  const steered = turnsOf(
    logOf([
      requestUpdate('Start.'),
      requestUpdate('Also check Gemma.'),
      ...claudeUpdates(claude.tool('x', 'Read', { file_path: 'a.py' })),
    ]).list(),
  );
  assert.equal(steered.length, 1);
  assert.equal(stepKind('mcp__verifold__verifold_run'), 'run');
  assert.equal(stepKind('verifold.verifold_post'), 'post');
  assert.equal(stepKind('constructor'), 'other');
});

await test('the live line comes from harness events, never from the model text', () => {
  const turns = turnsOf(logOf(claudeSession()).list());
  const running = liveOf({
    status: 'working',
    harness: 'claude',
    turn: turns.at(-1) ?? null,
    asked: null,
  });
  assert.equal(running.state, 'working');
  assert.equal(running.text, 'Running python probe_train.py');
  assert.equal(running.since, turns.at(-1)?.running?.at);
  assert.deepEqual(
    liveOf({ status: 'idle', harness: 'codex', turn: null, asked: at(40) }),
    { state: 'waiting', text: 'Waiting for you', since: at(40) },
  );
  assert.equal(
    liveOf({ status: 'usage', harness: 'codex', turn: null, asked: null }).text,
    "Waits for Codex's usage window",
  );
  assert.equal(
    liveOf({ status: 'closed', harness: 'claude', turn: null, asked: null })
      .state,
    'ended',
  );
});

await test('the snapshot holds what the screens show, and no internal field, key, or outside path', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const reader = new ApiReader(
    sources(root, seededView, {
      compute: { view: computeView },
      works: [
        {
          action: 'lab-direction-add',
          label: 'Opening',
          at: at(5),
          error: null,
        },
      ],
      away: () =>
        Promise.resolve({ since: at(50), spent: { claude: 1.25, gpu: 0 } }),
    }),
  );
  const data = await reader.snapshot();
  const lab = data.lab;
  assert.ok(lab);
  assert.equal(data.trimmed, false);
  assert.equal(lab.question, 'Can cheap training make a CoT faithful?');
  assert.deepEqual(lab.money, { plansUsd: 2.5, gpuUsd: 4.2, gpuLimitUsd: 25 });
  assert.deepEqual(lab.away, {
    since: at(50),
    spentThen: { plansUsd: 1.25, gpuUsd: 0 },
  });
  // The open call names every asker, and a pod option counts its secrets.
  const [waiting] = lab.needsYou;
  assert.ok(waiting);
  assert.deepEqual(
    waiting.askers.map((asker) => asker.handle),
    ['claude-1', 'codex-1'],
  );
  assert.deepEqual(waiting.options[0]?.effect, {
    type: 'pod',
    gpu: 'NVIDIA H100 80GB HBM3',
    hours: 3,
    secrets: 1,
  });
  assert.equal(lab.answered[0]?.id, 'c-2');
  assert.equal(lab.answered[0]?.byVerifold, true);
  // The objection to p-2, which a running check takes, makes d-1 disputed.
  assert.deepEqual(
    lab.directions.map((entry) => [entry.id, entry.disputed]),
    [
      ['d-1', true],
      ['d-2', false],
    ],
  );
  assert.deepEqual(lab.disputes, [
    { post: 'p-2', objections: ['p-3'], check: 'k-1' },
  ]);
  // Agents: the Claude agent runs a command, the Codex agent waits for the person, and the checker runs.
  const [claudeAgent, codexAgent, checker] = lab.agents;
  assert.ok(claudeAgent && codexAgent && checker);
  assert.deepEqual(claudeAgent.live.text, 'Running python probe_train.py');
  assert.equal(claudeAgent.model, 'opus[1m]');
  assert.equal(claudeAgent.turns.turns.length, 2);
  assert.equal(claudeAgent.turns.turns[0]?.counts.search, 1);
  assert.equal(
    claudeAgent.turns.turns[0]?.message?.text,
    'Seed 1: the gap is 34% smaller.',
  );
  assert.ok(claudeAgent.turns.turns[0]?.endedAt);
  assert.equal(claudeAgent.turns.turns[1]?.endedAt, null);
  assert.deepEqual(codexAgent.live, {
    state: 'waiting',
    text: 'Waiting for you',
    since: at(40),
  });
  assert.equal(
    codexAgent.turns.turns[0]?.message?.text,
    'Planted errors move 6%.',
  );
  assert.equal(checker.check, 'k-1');
  assert.equal(checker.status, 'running');
  // The plan's facts say when they were listed, and an unsourced one stays unsourced.
  assert.deepEqual(lab.plan?.facts[1], {
    claim: 'H100 $3.99/h',
    source: null,
    sourceDate: null,
    listedAt: at(1),
  });
  assert.deepEqual(
    lab.board.posts.map((entry) => [entry.id, entry.handle]),
    [
      ['p-1', 'claude-1'],
      ['p-2', 'claude-1'],
      ['p-3', 'codex-1'],
      ['p-4', null],
    ],
  );
  assert.deepEqual(lab.board.posts[1]?.proof, [{ type: 'run', run: 'r-1' }]);
  assert.equal(lab.runs[0]?.command, 'python probe_train.py --seed 1');
  assert.equal(lab.works[0]?.action, 'lab-direction-add');
  // Nothing internal, secret, or outside the project leaves the server.
  const json = JSON.stringify(data);
  for (const hidden of [
    '"generation"',
    '"cursor"',
    '"wakeups"',
    '"events"',
    '"lastRead"',
    '"workspace"',
    '"config"',
    '"key"',
    'SECRET',
    'rpa_FAKEKEY123',
    root,
  ])
    assert.equal(json.includes(hidden), false, `the snapshot shows ${hidden}`);
});

await test('a large lab stays inside the snapshot bound and says that it is trimmed', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = seededView();
  const message = 'm'.repeat(3000);
  const directions: LabView['directions'][number][] = [];
  for (let index = 1; index <= 12; index++) {
    const session = `20261020T090000000Z-bbbbbb${String(index).padStart(2, '0')}`;
    const updates: TranscriptUpdate[] = [];
    for (let turn = 0; turn < 30; turn++)
      updates.push(
        requestUpdate(`Turn ${turn}.`),
        ...claudeUpdates(claude.text(message)),
      );
    await writeTranscript(root, session, updates);
    const id = `a-${index + 10}`;
    directions.push({
      direction: direction(`d-${index}`, `Direction ${index}`, id),
      agent: agentRecord(
        id,
        `claude-${index}`,
        'claude',
        `d-${index}`,
        session,
      ),
      status: 'idle',
      until: null,
    });
  }
  const posts: Post[] = [];
  for (let index = 1; index <= 60; index++)
    posts.push(
      post(`p-${index}`, 'person', 'question', 'q'.repeat(4000), {
        direction: 'd-1',
      }),
    );
  const view: LabView = { ...base, directions, posts };
  const data = await new ApiReader(sources(root, () => view)).snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= apiLimits.snapshot);
  assert.equal(data.trimmed, true);
  const agent = data.lab?.agents[0];
  assert.ok(agent);
  assert.equal(agent.turns.turns.length, 5);
  assert.equal(agent.turns.more, true);
  assert.equal(agent.turns.turns[0]?.message?.trimmed, true);
});

/** Fixture assets for a desk server. Returns their folder URL. */
async function deskAssets(root: string): Promise<URL> {
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
  return pathToFileURL(`${assets}/cli/`);
}

await test('the API needs the token, pushes one snapshot for a burst of changes, pages the board and turns, and runs desk actions', async (t) => {
  // A long command output: a step sends only its last 4 KB.
  const root = await project('x'.repeat(10_000));
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = seededView();
  const words: unknown[] = [];
  const lab = {
    runs: true,
    view: () => current,
    answerCallInWords: (id: unknown, text: unknown) => {
      words.push([id, text]);
      return Promise.resolve();
    },
    pause: () =>
      Promise.reject(new SessionActionError('The lab is paused already.')),
  } as unknown as Lab;
  const sessions = {
    view: () => null,
    views: () => [],
  } as unknown as SessionPool;
  const owner = new AbortController();
  const desk = await startDesk(
    root,
    owner.signal,
    await deskAssets(root),
    sessions,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { lab, api: { pollMs: 40, heartbeatMs: 100 } },
  );
  t.after(async () => {
    owner.abort();
    await desk.closed;
  });
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };

  assert.equal((await fetch(`${api}/snapshot`)).status, 401);
  const snapshot = (await (
    await fetch(`${api}/snapshot`, { headers })
  ).json()) as Snapshot;
  assert.equal(snapshot.protocolVersion, 1);
  assert.equal(snapshot.lab?.agents[0]?.handle, 'claude-1');
  assert.equal((await fetch(`${api}/snapshot?x=1`, { headers })).status, 404);

  // The stream sends the snapshot at once, then one snapshot for five changes in one interval.
  const stream = await fetch(`${api}/events`, { headers });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(stream.body);
  const events: Snapshot[] = [];
  let pings = 0;
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(': ping')) pings++;
        const data = block
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as Snapshot);
        end = buffer.indexOf('\n\n');
      }
    }
  })();
  const until = async (check: () => boolean): Promise<void> => {
    const stop = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > stop)
        throw new Error('The condition did not hold in time.');
      await delay(10);
    }
  };
  await until(() => events.length === 1);
  const first = events[0];
  assert.ok(first);
  for (let index = 5; index < 10; index++)
    current = {
      ...current,
      posts: [
        ...current.posts,
        post(`p-${index}`, 'person', 'question', `Change ${index}.`),
      ],
    };
  await until(() => events.length === 2);
  // Several intervals pass with no change: no more snapshots, but heartbeats.
  await delay(300);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.rev, first.rev + 1);
  assert.equal(events[1]?.lab?.board.posts.length, 9);
  assert.ok(pings > 0);
  await reader.cancel();
  await pump;

  // The board pages back from a post.
  const page = (await (
    await fetch(`${api}/board?before=p-3`, { headers })
  ).json()) as BoardPage;
  assert.deepEqual(
    page.posts.map((entry) => entry.id),
    ['p-1', 'p-2'],
  );
  assert.equal(page.more, false);
  assert.equal((await fetch(`${api}/board?before=x`, { headers })).status, 400);

  // An agent's turns, then one turn's steps, with the end of a long output.
  const turns = (await (
    await fetch(`${api}/agents/a-1/turns`, { headers })
  ).json()) as TurnPage;
  assert.equal(turns.turns.length, 2);
  const firstTurn = turns.turns[0];
  assert.ok(firstTurn);
  const older = (await (
    await fetch(
      `${api}/agents/a-1/turns?before=${encodeURIComponent(turns.turns[1]?.id ?? '')}`,
      { headers },
    )
  ).json()) as TurnPage;
  assert.deepEqual(
    older.turns.map((entry) => entry.id),
    [firstTurn.id],
  );
  const detail = (await (
    await fetch(`${api}/agents/a-1/turns/${encodeURIComponent(firstTurn.id)}`, {
      headers,
    })
  ).json()) as TurnDetail;
  const command = detail.steps.find((entry) => entry.title?.includes('seed 1'));
  assert.ok(command);
  assert.equal(command.words, 'Running python probe_train.py');
  assert.equal(command.kind, 'command');
  assert.equal(command.output?.trimmed, true);
  assert.ok(
    Buffer.byteLength(command.output?.text ?? '') <= apiLimits.toolText,
  );
  assert.ok(command.endedAt);
  assert.equal(
    detail.steps.find((entry) => entry.type === 'thinking')?.text?.text,
    'I check the newest models first.',
  );
  assert.equal(
    (await fetch(`${api}/agents/a-9/turns`, { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(`${api}/agents/a-1/turns/not%20an%20id`, { headers })).status,
    400,
  );

  // Actions run the desk's own operations, with its checks.
  const action = (name: string, body: unknown, more: RequestInit = {}) =>
    fetch(`${api}/actions/${name}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...more,
    });
  const answered = await action('lab-call-words', {
    call: 'c-1',
    text: 'Use the A100 for one seed first.',
  });
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { ok: true });
  assert.deepEqual(words, [['c-1', 'Use the A100 for one seed first.']]);
  const refused = await action('lab-pause', {});
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: 'The lab is paused already.',
  });
  assert.equal((await action('stop', {})).status, 404);
  assert.equal((await action('lab-terminal-open', {})).status, 404);
  assert.equal(
    (
      await action(
        'lab-pause',
        {},
        {
          headers: { ...headers, 'Content-Type': 'text/plain' },
        },
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await action(
        'lab-pause',
        {},
        {
          headers: { 'Content-Type': 'application/json' },
        },
      )
    ).status,
    401,
  );
  assert.equal(
    (await fetch(`${api}/actions/lab-pause`, { headers })).status,
    405,
  );
});
