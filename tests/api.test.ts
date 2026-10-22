import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { liveOf, stepKind, toolStep, turnsOf } from '../src/core/activity.ts';
import {
  claudeUpdates,
  codexAppUpdates,
  requestUpdate,
  TranscriptLog,
  TranscriptWriter,
  type TranscriptUpdate,
} from '../src/core/transcript.ts';
import {
  ApiFeed,
  ApiReader,
  apiLimits,
  type ApiSources,
  type LabReadSource,
} from '../src/server/api.ts';
import { startDesk } from '../src/server/desk.ts';
import { changeWorkspace, loadWorkspace } from '../src/core/storage.ts';
import { fakePod, key as runpodKey } from './fake-pod.ts';
import { computeDefaults, type ComputeView } from '../src/core/compute.ts';
import { SessionActionError } from '../src/core/session.ts';
import {
  labLimits,
  type AgentRecord,
  type Call,
  type Check,
  type Direction,
  type Lab,
  type FigureRead,
  type LabState,
  type LabView,
} from '../src/core/lab.ts';
import { boardLimits, type Post } from '../src/core/board.ts';
import { figureHeaders, figureName, imageSize } from '../src/server/figure.ts';
import type { RunRecord } from '../src/core/runs.ts';
import type { Lease } from '../src/core/leases.ts';
import type { SessionPool } from '../src/core/workers.ts';
import {
  searchQueryLimit,
  type Away,
  type BoardPage,
  type BringRead,
  type DirectionDiff,
  type PostThread,
  type RunDetail,
  type SearchResult,
  type Snapshot,
  type TurnDetail,
  type TurnPage,
  type Work,
} from '../src/protocol/api.ts';

/** The start of a PNG that declares `width` x `height` pixels: its signature and its header chunk. */
const pngHead = (width: number, height: number): Buffer => {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
};

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
          secrets: ['HF_TOKEN'],
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
    undoneBrings: [],
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
    // A pod's secret names show in the snapshot, never their values.
    secrets: ['HF_TOKEN'],
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
  // One array for every read: the feed compares the works by reference.
  const works = more.works ?? [];
  return () => ({
    root,
    lab: { view },
    compute: undefined,
    session: () => null,
    away: () => Promise.resolve(null),
    ...more,
    works,
  });
}

/** A snapshot's data, as the reader sends it before the feed adds its version, epoch, rev, and time. */
type Data = Omit<Snapshot, 'protocolVersion' | 'epoch' | 'rev' | 'at'>;
const parse = (json: string): Data => JSON.parse(json) as Data;

/** Wait until `check` holds, for at most 5 seconds. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const stop = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > stop)
      throw new Error('The condition did not hold in time.');
    await delay(10);
  }
}

/** The events of a stream as they come: snapshots, their IDs, and heartbeats. */
function listen(response: Response): {
  readonly events: Snapshot[];
  readonly ids: string[];
  readonly pings: () => number;
  readonly stop: () => Promise<void>;
} {
  const body = response.body;
  assert.ok(body);
  const reader = body.getReader();
  const events: Snapshot[] = [];
  const ids: string[] = [];
  let pings = 0;
  let buffer = '';
  const decoder = new TextDecoder();
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
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ids.push(line.slice(4));
          if (line.startsWith('data: '))
            events.push(JSON.parse(line.slice(6)) as Snapshot);
        }
        end = buffer.indexOf('\n\n');
      }
    }
  })();
  return {
    events,
    ids,
    pings: () => pings,
    stop: async () => {
      await reader.cancel();
      await pump;
    },
  };
}

/** The seeded lab with claude-1 on another session, between turns. */
function withSession(session: string): LabView {
  const view = seededView();
  const [first, ...rest] = view.directions;
  assert.ok(first);
  return {
    ...view,
    directions: [
      { ...first, agent: { ...first.agent, session }, status: 'idle' },
      ...rest,
    ],
  };
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
  const json = (await reader.build()).json;
  const data = parse(json);
  const lab = data.lab;
  assert.ok(lab);
  assert.equal(data.trimmed, false);
  assert.equal(lab.question, 'Can cheap training make a CoT faithful?');
  // The person's post limit comes from the board, so the app's box matches it.
  assert.equal(lab.postLimit, boardLimits.personText);
  assert.deepEqual(lab.money, { plansUsd: 2.5, gpuUsd: 4.2, gpuLimitUsd: 25 });
  // Nothing came after at(50), but the lab spent money: the news says so, as the desk's Home does.
  assert.deepEqual(lab.away, {
    since: at(50),
    spentThen: { plansUsd: 1.25, gpuUsd: 0 },
    news: {
      lines: [],
      moreLines: 0,
      counts: '',
      cost: 'Spent since then: ≈$5.45 (Claude Code ≈$1.25, GPU $4.20).',
    },
  });
  // The open call names every asker, and a pod option counts its secrets
  // and the ones this computer does not store yet. Its undo window shows
  // before the person answers.
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
    missing: 1,
    missingNames: ['HF_TOKEN'],
  });
  assert.equal(waiting.undoMinutes, 10);
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
  // Nothing came in from either direction yet, and the sign-off line has its limit.
  assert.deepEqual(
    lab.directions.map((entry) => entry.brought),
    [null, null],
  );
  assert.equal(lab.signoffLimit, labLimits.signoff);
  // Both directions are open with no verdict, so both are still open.
  assert.deepEqual(lab.directionCounts, {
    total: 2,
    holdsUp: 0,
    ruledOut: 0,
    open: 2,
  });
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
  assert.deepEqual(lab.omitted, {});
  // Nothing internal, secret, or outside the project leaves the server.
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

await test("an agent's requested model is its own, else the one that its session asked for, as when Verifold picked Codex's model", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const view = seededView();
  const [first, second] = view.directions;
  assert.ok(first && second);
  const picked: LabView = {
    ...view,
    directions: [first, { ...second, agent: { ...second.agent, model: null } }],
  };
  const reader = new ApiReader(
    sources(root, () => picked, {
      session: (id) =>
        id === sessionOf.a2
          ? ({
              record: { model: 'gpt-6-astra', reportedModel: 'gpt-6.1-sol' },
            } as unknown as ReturnType<ApiSources['session']>)
          : null,
    }),
  );
  const agents = parse((await reader.build()).json).lab?.agents ?? [];
  const codex = agents.find((agent) => agent.id === 'a-2');
  assert.equal(codex?.requestedModel, 'gpt-6-astra');
  assert.equal(codex?.model, 'gpt-6.1-sol');
  // The agent's own model comes first.
  assert.equal(
    agents.find((agent) => agent.id === 'a-1')?.requestedModel,
    'opus[1m]',
  );
});

await test('the snapshot names the planner, the facts and option details of a call, and the version of the plan and what changed', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = seededView();
  const plan = seeded.state.plan;
  assert.ok(plan);
  const view: LabView = {
    ...seeded,
    state: {
      ...seeded.state,
      plan: {
        ...plan,
        // The facts last changed in an earlier plan post.
        factsPost: 'p-0',
        version: 2,
        previous: 'p-0',
        changed: 'Qwen3-4B → Qwen3.5-9B, as the person chose.',
      },
      calls: [
        call({
          kind: 'scope',
          joined: [],
          question: 'Which models should the experiments use?',
          options: [
            {
              label: 'Qwen3.5-9B',
              detail: 'Newest small Qwen, with official SAEs.',
              usd: null,
              minutes: null,
              effect: null,
            },
            { label: 'Both', usd: null, minutes: null, effect: null },
          ],
          facts: [
            {
              claim: 'Qwen3.5-9B has official SAEs',
              source: 'https://huggingface.co/Qwen',
              sourceDate: '2026-04-27',
              checkedAt: at(40),
            },
          ],
        }),
      ],
    },
  };
  const lab = parse(
    (await new ApiReader(sources(root, () => view)).build()).json,
  ).lab;
  assert.ok(lab);
  assert.equal(lab.planner, 'a-1');
  const [question] = lab.needsYou;
  assert.deepEqual(
    question?.options.map((option) => [option.label, option.detail ?? null]),
    [
      ['Qwen3.5-9B', 'Newest small Qwen, with official SAEs.'],
      ['Both', null],
    ],
  );
  assert.deepEqual(question?.facts, [
    {
      claim: 'Qwen3.5-9B has official SAEs',
      source: 'https://huggingface.co/Qwen',
      sourceDate: '2026-04-27',
      listedAt: at(40),
    },
  ]);
  assert.equal(lab.plan?.version, 2);
  // The plan listed no facts, so they come from an earlier plan.
  assert.equal(lab.plan?.factsCarried, true);
  assert.equal(lab.plan?.previous, 'p-0');
  assert.equal(
    lab.plan?.changed,
    'Qwen3-4B → Qwen3.5-9B, as the person chose.',
  );
  // A call without facts and a plan from before versions say nothing of them.
  const older = parse(
    (await new ApiReader(sources(root, seededView)).build()).json,
  ).lab;
  assert.equal(older?.needsYou[0]?.facts, undefined);
  assert.equal(older?.plan?.version, undefined);
  assert.equal(older?.plan?.factsCarried, undefined);
  assert.equal(older?.plan?.previous, null);
  assert.equal(older?.plan?.changed, null);
});

await test('a project without a lab: the snapshot holds its question and why its lab did not start, and a new reason sends a new snapshot', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  let problem: string | null =
    'Verifold found no agent tool that is signed in.';
  const reader = new ApiReader(
    sources(root, () => null, { startProblem: () => problem }),
  );
  // A project without a question has none to start a lab on.
  assert.equal(parse((await reader.build()).json).question, null);
  await changeWorkspace(root, (state) => ({
    ...state!,
    research: {
      topic: 'Do probes see faithfulness?',
      autonomy: 'autonomous',
      phase: 'needs-plan',
    },
  }));
  const data = parse((await reader.build()).json);
  assert.equal(data.lab, null);
  assert.equal(data.question, 'Do probes see faithfulness?');
  assert.equal(
    data.startProblem,
    'Verifold found no agent tool that is signed in.',
  );
  const before = await reader.signal();
  problem = null;
  assert.notDeepEqual(await reader.signal(), before);
  assert.equal(parse((await reader.build()).json).startProblem, null);
  // Without a project, there is neither.
  const none = parse(
    (await new ApiReader(sources('', () => null)).build()).json,
  );
  assert.equal(none.project, '');
  assert.equal('question' in none, false);
  assert.equal('startProblem' in none, false);
});

await test('a pod option names the secrets that this computer lacks, and storing one updates it', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = async (reader: ApiReader): Promise<unknown> => {
    const effect = parse((await reader.build()).json).lab?.needsYou[0]
      ?.options[0]?.effect;
    return effect?.type === 'pod'
      ? { count: effect.missing, names: effect.missingNames }
      : 'no pod';
  };
  // Without Compute, Verifold cannot tell.
  assert.deepEqual(await missing(new ApiReader(sources(root, seededView))), {
    count: null,
    names: undefined,
  });
  let secrets: ComputeView['secrets'] = [];
  const reader = new ApiReader(
    sources(root, seededView, {
      compute: { view: () => ({ ...computeView(), secrets }) },
    }),
  );
  assert.deepEqual(await missing(reader), { count: 1, names: ['HF_TOKEN'] });
  const before = await reader.signal();
  secrets = [
    {
      name: 'HF_TOKEN',
      place: 'keychain',
      last4: 'oken',
      savedAt: at(5),
    },
  ];
  // The stored secret is part of the change signal, so a stream pushes the new count.
  const after = await reader.signal();
  assert.notDeepEqual(after, before);
  assert.deepEqual(await missing(reader), { count: 0, names: [] });
});

await test("the snapshot's pod actions in the background are the newest 20, and a change of them changes the signal", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  let works: readonly Work[] = [];
  const reader = new ApiReader(
    sources(root, () => null, {
      compute: { view: computeView },
      computeWorks: () => works,
    }),
  );
  assert.deepEqual(parse((await reader.build()).json).compute?.works, []);
  const before = await reader.signal();
  works = Array.from({ length: 25 }, (_, index) => ({
    action: 'compute-lease-end',
    label: `Ending the pod: lease-${index + 1}`,
    at: at(index),
    error: 'RunPod did not answer.',
    lease: `lease-${index + 1}`,
  }));
  assert.notDeepEqual(await reader.signal(), before);
  const shown = parse((await reader.build()).json).compute?.works ?? [];
  assert.deepEqual(
    [shown.length, shown[0]?.lease, shown.at(-1)],
    [20, 'lease-6', works.at(-1)],
  );
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
  const json = (await new ApiReader(sources(root, () => view)).build()).json;
  const data = parse(json);
  assert.ok(Buffer.byteLength(json) <= apiLimits.snapshot);
  assert.equal(data.trimmed, true);
  const agent = data.lab?.agents[0];
  assert.ok(agent);
  assert.equal(agent.turns.turns.length, 5);
  assert.equal(agent.turns.more, true);
  assert.equal(agent.turns.turns[0]?.message?.trimmed, true);
});

await test('a cold read takes a transcript past 4 MB to its end before it answers', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  // About 5.5 MB before the last turn: one read step of the file holds 4 MB.
  const big = 'o'.repeat(60 * 1024);
  const updates: TranscriptUpdate[] = [requestUpdate('Start.')];
  for (let index = 0; index < 90; index++)
    updates.push(
      ...claudeUpdates(
        claude.tool(`b${index}`, 'Bash', { command: `python step${index}.py` }),
      ),
      ...claudeUpdates(claude.result(`b${index}`, big)),
    );
  updates.push(
    requestUpdate('Next.'),
    ...claudeUpdates(claude.text('The last turn.')),
  );
  const session = '20261020T090000000Z-cccccc01';
  await writeTranscript(root, session, updates);
  const view = withSession(session);
  // A one-off page read, with no stream open, sees the whole file.
  const page = await new ApiReader(sources(root, () => view)).turnPage('a-1');
  assert.ok(page);
  assert.equal(page.turns.length, 2);
  assert.equal(page.turns[0]?.counts.command, 90);
  assert.equal(page.turns[1]?.message?.text, 'The last turn.');
  // So does a snapshot.
  const data = parse(
    (await new ApiReader(sources(root, () => view)).build()).json,
  );
  assert.equal(
    data.lab?.agents[0]?.turns.turns[1]?.message?.text,
    'The last turn.',
  );
});

await test("a turn's steps page from the newest, within a count and a byte bound", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  // Turn 1: a request and 449 small steps. Turn 2: 100 steps with large input and output.
  const updates: TranscriptUpdate[] = [requestUpdate('Start.')];
  for (let index = 0; index < 449; index++)
    updates.push(
      ...claudeUpdates(
        claude.tool(`r${index}`, 'Read', { file_path: `f${index}.py` }),
      ),
    );
  updates.push(requestUpdate('Wide.'));
  const blob = 'w'.repeat(6000);
  for (let index = 0; index < 100; index++)
    updates.push(
      ...claudeUpdates(claude.tool(`w${index}`, 'Bash', { command: blob })),
      ...claudeUpdates(claude.result(`w${index}`, blob)),
    );
  const session = '20261020T090000000Z-cccccc02';
  await writeTranscript(root, session, updates);
  const reader = new ApiReader(sources(root, () => withSession(session)));
  const turns = await reader.turnPage('a-1');
  const [narrow, broad] = turns?.turns ?? [];
  assert.ok(narrow && broad);
  const read = async (turn: string, before?: number): Promise<TurnDetail> => {
    const json = await reader.turn('a-1', turn, before);
    assert.ok(json);
    return JSON.parse(json) as TurnDetail;
  };
  const newest = await read(narrow.id);
  assert.equal(newest.steps.length, apiLimits.steps);
  assert.deepEqual(
    [newest.steps[0]?.index, newest.steps.at(-1)?.index, newest.more],
    [250, 449, true],
  );
  const middle = await read(narrow.id, 250);
  assert.deepEqual(
    [middle.steps[0]?.index, middle.steps.at(-1)?.index, middle.more],
    [50, 249, true],
  );
  const oldest = await read(narrow.id, 50);
  assert.deepEqual(
    [oldest.steps.length, oldest.steps[0]?.index, oldest.more],
    [50, 0, false],
  );
  assert.equal(oldest.steps[0]?.type, 'request');
  // Large steps: the page stops at its byte bound, and the next page goes on from there.
  const heavy = await read(broad.id);
  assert.ok(heavy.steps.length > 0 && heavy.steps.length < 100);
  assert.equal(heavy.more, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(heavy.steps)) <=
      apiLimits.stepPage + heavy.steps.length,
  );
  const before = heavy.steps[0]?.index;
  assert.ok(before);
  const next = await read(broad.id, before);
  assert.equal(next.steps.at(-1)?.index, before - 1);
  // A step index past the end finds nothing.
  assert.equal(await reader.turn('a-1', narrow.id, 451), null);
});

await test('each start of the feed has its own epoch, and its revs start from 1', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const view = seededView();
  const reader = new ApiReader(sources(root, () => view));
  const before = JSON.parse(
    (await new ApiFeed(reader).current()).text,
  ) as Snapshot;
  // A restart of Verifold makes a new feed.
  const after = JSON.parse(
    (await new ApiFeed(reader).current()).text,
  ) as Snapshot;
  assert.equal(before.protocolVersion, 1);
  assert.equal(before.rev, 1);
  assert.equal(after.rev, 1);
  assert.match(before.epoch, /^[0-9a-f]{16}$/);
  assert.notEqual(before.epoch, after.epoch);
});

await test('a Codex call of a Verifold tool reads in plain words, with or without its server name', () => {
  const started = codexAppUpdates(
    'item/started',
    {
      id: 'v1',
      type: 'mcpToolCall',
      server: 'verifold',
      tool: 'verifold_post',
      arguments: { kind: 'claim', text: 'Gap 34% smaller.' },
    },
    null,
  );
  const turns = turnsOf(logOf([requestUpdate('Go.'), ...started]).list());
  assert.equal(turns[0]?.running?.name, 'verifold.verifold_post');
  assert.equal(turns[0]?.counts.post, 1);
  assert.equal(
    liveOf({
      status: 'working',
      harness: 'codex',
      turn: turns.at(-1) ?? null,
      asked: null,
    }).text,
    'Writing a note',
  );
  assert.equal(toolStep('verifold.verifold_object'), 'Raising an objection');
  assert.equal(toolStep('verifold_post'), 'Writing a note');
  assert.equal(toolStep('mcp__verifold__verifold_post'), 'Writing a note');
  assert.equal(toolStep('File change', 'a.py'), 'Writing a.py');
});

await test('a lab huge in every list stays in bound, counts what it left out, and never fails', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = seededView();
  const plan = base.state.plan;
  assert.ok(plan);
  const directions = Array.from({ length: 300 }, (_, index) => ({
    ...direction(
      `d-${index + 1}`,
      `Direction ${index + 1}`,
      `a-${index + 100}`,
    ),
    buildsOn: Array.from({ length: 50 }, (__, work) => ({
      text: `Work ${work}`,
      known: true,
    })),
  }));
  const rows = directions.map((entry, index) => ({
    direction: entry,
    agent: agentRecord(
      `a-${index + 100}`,
      `claude-${index + 100}`,
      'claude',
      entry.id,
      null,
    ),
    status: 'idle' as const,
    until: null,
  }));
  const posts: Post[] = [];
  const checks: Check[] = [];
  for (let index = 1; index <= 300; index++) {
    posts.push(
      post(`p-${2 * index - 1}`, 'a-1', 'claim', `Claim ${index}.`, {
        artifacts: [{ type: 'run', run: 'r-1' }],
      }),
      post(`p-${2 * index}`, 'a-2', 'objection', `Doubt ${index}.`, {
        replyTo: `p-${2 * index - 1}`,
      }),
    );
    checks.push({
      ...check(),
      id: `k-${index}`,
      claim: `p-${2 * index - 1}`,
      objections: [`p-${2 * index}`],
      agent: `a-${index + 1000}`,
      handle: `codex-${index + 1000}`,
    });
  }
  const facts = Array.from({ length: 200 }, (_, index) => ({
    claim: `Fact ${index}`,
    source: null,
    sourceDate: null,
    checkedAt: at(1),
  }));
  const calls = Array.from({ length: 320 }, (_, index) =>
    call({ id: `c-${index + 1}`, joined: [] }),
  );
  // Every third direction holds up, and the one after it is ruled out.
  const settled = directions.map((entry, index) => ({
    ...entry,
    verdict:
      index % 3 === 0
        ? ('holds-up' as const)
        : index % 3 === 1
          ? ('ruled-out' as const)
          : entry.verdict,
  }));
  const view: LabView = {
    ...base,
    state: {
      ...base.state,
      directions: settled,
      calls,
      checks,
      plan: { ...plan, facts },
    },
    directions: rows,
    posts,
    checks,
  };
  const json = (await new ApiReader(sources(root, () => view)).build()).json;
  assert.ok(Buffer.byteLength(json) <= apiLimits.snapshot);
  const data = parse(json);
  assert.equal(data.trimmed, true);
  const omitted = data.lab?.omitted ?? {};
  for (const list of [
    'needsYou',
    'directions',
    'buildsOn',
    'agents',
    'disputes',
    'facts',
    'checks',
  ] as const)
    assert.ok((omitted[list] ?? 0) > 0, `${list} is not cut`);
  assert.equal((data.lab?.needsYou.length ?? 0) + (omitted.needsYou ?? 0), 320);
  // What notifications follow is not cut with the lists: the newest 300 calls, and every settled direction.
  const notify = data.lab?.notify;
  assert.ok(notify);
  assert.equal(notify.calls.length, 300);
  assert.deepEqual([notify.calls[0], notify.calls.at(-1)], ['c-21', 'c-320']);
  assert.equal(notify.holdsUp.length, 100);
  assert.deepEqual(notify.holdsUp.slice(0, 2), ['d-1', 'd-4']);
  assert.deepEqual(notify.ruledOut.slice(0, 2), ['d-2', 'd-5']);
  // Calls so large that no list fits: the snapshot keeps the money and the question, and says what it left out.
  const heavy: LabView = {
    ...view,
    state: {
      ...view.state,
      calls: Array.from({ length: 20 }, (_, index) =>
        call({
          id: `c-${index + 1}`,
          joined: [],
          question: 'q'.repeat(200_000),
        }),
      ),
    },
  };
  const last = (await new ApiReader(sources(root, () => heavy)).build()).json;
  assert.ok(Buffer.byteLength(last) <= apiLimits.snapshot);
  const lab = parse(last).lab;
  assert.ok(lab);
  assert.equal(lab.needsYou.length, 0);
  assert.equal(lab.omitted.needsYou, 20);
  // At the level that keeps no list, the notify lists are whole.
  assert.equal(lab.notify?.calls.length, 20);
  assert.equal(lab.notify.holdsUp.length, 100);
  assert.equal(lab.plan, null);
  assert.equal(lab.omitted.plan, 1);
  assert.equal(lab.money.plansUsd, 2.5);
});

await test('a snapshot counts every direction, also those it leaves out, and keeps the sign-off at every size', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = seededView();
  const [first, second] = base.state.directions;
  assert.ok(first && second);
  // d-1 holds up but an objection disputes it, d-2 leads, and of 300 more, half were ruled out.
  const directions: Direction[] = [
    { ...first, verdict: 'holds-up' },
    { ...second, verdict: 'leading' },
    ...Array.from({ length: 300 }, (_, index) => ({
      ...direction(
        `d-${index + 3}`,
        `Direction ${index + 3}`,
        `a-${index + 3}`,
      ),
      ...(index % 2
        ? {}
        : { verdict: 'ruled-out' as const, state: 'closed' as const }),
    })),
  ];
  const view: LabView = {
    ...base,
    state: {
      ...base.state,
      directions,
      signoff: {
        at: at(90),
        note: 'Partly yes.',
        directions: directions.map((entry) => ({
          id: entry.id,
          verdict: entry.verdict,
          commit: entry.head,
          check: null,
        })),
      },
    },
    directions: directions.map((entry, index) => ({
      direction: entry,
      agent: agentRecord(
        entry.agent,
        `claude-${index + 1}`,
        'claude',
        entry.id,
        null,
      ),
      status: 'idle' as const,
      until: null,
    })),
  };
  const counts = { total: 302, holdsUp: 1, ruledOut: 150, open: 151 };
  const data = parse(
    (await new ApiReader(sources(root, () => view)).build()).json,
  );
  const lab = data.lab;
  assert.ok(lab);
  assert.equal(data.trimmed, true);
  assert.equal(lab.directions.length, apiLimits.directions);
  assert.equal(lab.omitted.directions, 302 - apiLimits.directions);
  // A leading direction is not still open, and a disputed one is.
  assert.deepEqual(lab.directionCounts, counts);
  // The sign-off stays, with the directions that the snapshot keeps.
  assert.equal(lab.signoff?.note, 'Partly yes.');
  assert.deepEqual(
    lab.signoff?.directions.map((entry) => entry.id),
    lab.directions.map((entry) => entry.id),
  );
  assert.equal(lab.omitted.signoff, undefined);

  // Calls so large that no list fits: the sign-off still says when, and its line.
  const heavy: LabView = {
    ...view,
    state: {
      ...view.state,
      calls: Array.from({ length: 20 }, (_, index) =>
        call({
          id: `c-${index + 1}`,
          joined: [],
          question: 'q'.repeat(200_000),
        }),
      ),
    },
  };
  const json = (await new ApiReader(sources(root, () => heavy)).build()).json;
  assert.ok(Buffer.byteLength(json) <= apiLimits.snapshot);
  const last = parse(json).lab;
  assert.ok(last);
  assert.equal(last.directions.length, 0);
  assert.equal(last.plan, null);
  assert.deepEqual(last.signoff, {
    at: at(90),
    note: 'Partly yes.',
    directions: [],
  });
  assert.equal(last.omitted.signoff, undefined);
  assert.deepEqual(last.directionCounts, counts);
});

await test('a bring-in read names the files that its lists leave out, and keeps the newest bring-ins', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = seededView();
  const commit = 'e'.repeat(40);
  // 25 bring-ins of d-1, the last one of 60 files, and one of d-2.
  const brought = [
    ...Array.from({ length: 24 }, (_, index) => ({
      direction: 'd-1',
      path: `early-${index}.md`,
      commit,
      at: at(100 + index),
    })),
    ...Array.from({ length: 60 }, (_, index) => ({
      direction: 'd-1',
      path: `late-${index}.md`,
      commit,
      at: at(200),
    })),
    { direction: 'd-2', path: 'other.md', commit, at: at(300) },
  ];
  const view: LabView = { ...base, state: { ...base.state, brought } };
  const reader = new ApiReader(
    sources(root, () => view, {
      bring: {
        list: () =>
          Promise.resolve({
            direction: 'd-1',
            from: 'a'.repeat(40),
            commit,
            head: commit,
            working: false,
            newer: false,
            left: Array.from({ length: 2003 }, (_, index) => ({
              path: `big-${index}.bin`,
              why: 'It is larger than 50 MB.',
            })),
            files: [],
          }),
        diff: () => Promise.resolve(null),
      },
    }),
  );
  const read: BringRead | null = await reader.bring('d-1');
  assert.ok(read?.list);
  assert.equal(read.list.branch, 'verifold/d-1');
  assert.equal(read.list.left.length, apiLimits.bringFiles);
  assert.equal(read.list.leftOmitted, 3);
  assert.equal(read.list.omitted, 0);
  // The newest 20 bring-ins, oldest first, each with at most 50 of its files.
  assert.equal(read.history.length, apiLimits.bringGroups);
  assert.equal(read.history[0]?.at, at(105));
  const newest = read.history.at(-1);
  assert.equal(newest?.at, at(200));
  assert.equal(newest?.paths.length, apiLimits.bringPaths);
  assert.equal(newest?.more, 60 - apiLimits.bringPaths);
  assert.ok(!read.history.some((group) => group.paths.includes('other.md')));
});

await test('every checker that the snapshot names has turns to fetch, an old one too', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = seededView();
  const checks: Check[] = [];
  for (let index = 1; index <= 8; index++) {
    const session = `20261020T090000000Z-dddddd0${index}`;
    await writeTranscript(root, session, [
      requestUpdate(`Check ${index}.`),
      ...claudeUpdates(claude.text(`Rerun ${index} holds.`)),
    ]);
    checks.push({
      ...check(),
      id: `k-${index}`,
      agent: `a-${index + 20}`,
      handle: `codex-${index + 20}`,
      state: 'done',
      outcome: 'holds',
      session,
      endedAt: at(60 + index),
    });
  }
  const view: LabView = { ...base, state: { ...base.state, checks }, checks };
  const reader = new ApiReader(sources(root, () => view));
  const data = parse((await reader.build()).json);
  // The agents list shows the five newest ended checkers. The checks list names all eight.
  assert.deepEqual(
    data.lab?.agents
      .filter((agent) => agent.check !== null)
      .map((agent) => agent.id),
    ['a-24', 'a-25', 'a-26', 'a-27', 'a-28'],
  );
  assert.ok(data.lab?.checks.some((entry) => entry.agent === 'a-21'));
  const page = await reader.turnPage('a-21');
  assert.equal(page?.turns[0]?.message?.text, 'Rerun 1 holds.');
  const turn = page?.turns[0]?.id;
  assert.ok(turn);
  assert.ok(await reader.turn('a-21', turn));
});

await test('an idle lab with an open stream builds no snapshot after the first, and a change builds one', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = seededView();
  const feed = new ApiFeed(new ApiReader(sources(root, () => current)), {
    pollMs: 20,
    heartbeatMs: 60_000,
  });
  const server = createServer((request, response) => {
    void feed.open(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    feed.close();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { events, stop } = listen(
    await fetch(`http://127.0.0.1:${address.port}/`),
  );
  await until(() => events.length === 1);
  // About 15 ticks of an idle lab: signals only, no build.
  await delay(300);
  assert.equal(feed.builds, 1);
  assert.equal(events.length, 1);
  current = {
    ...current,
    posts: [...current.posts, post('p-9', 'person', 'question', 'New.')],
  };
  await until(() => events.length === 2);
  assert.equal(feed.builds, 2);
  await delay(200);
  assert.equal(feed.builds, 2);
  // A snapshot request on an idle lab builds nothing either.
  assert.equal((await feed.current()).rev, 2);
  assert.equal(feed.builds, 2);
  await stop();
});

await test('a stream whose write fails closes, and the feed drops it', async (t) => {
  let version = 1;
  const reader = {
    signal: () => Promise.resolve([version]),
    build: () => {
      const data = { project: 'p', lab: null, trimmed: false };
      return Promise.resolve({ data, json: JSON.stringify(data) });
    },
  } as unknown as ApiReader;
  const feed = new ApiFeed(reader, { pollMs: 10, heartbeatMs: 60_000 });
  t.after(() => feed.close());
  let closed = 0;
  // The connection is gone: each write throws.
  const response = Object.assign(new EventEmitter(), {
    writable: true,
    writableLength: 0,
    writeHead: () => {},
    write: () => {
      throw new Error('The connection is gone.');
    },
    destroy: () => {
      closed++;
      response.emit('close');
    },
  });
  const request = { socket: { setTimeout: () => {} } };
  assert.equal(
    await feed.open(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    ),
    true,
  );
  await until(() => closed === 1);
  // Without the stream, the feed reads and builds nothing more.
  const builds = feed.builds;
  version = 2;
  await delay(80);
  assert.equal(feed.builds, builds);
  assert.equal(closed, 1);
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
  await writeFile(join(assets, 'ui', 'token.js'), 'fixture module');
  return pathToFileURL(`${assets}/cli/`);
}

await test('an answer that Verifold accepts and then fails shows why on the call, which is open again', async (t) => {
  const root = await project();
  let current = seededView();
  const change = (fields: Partial<Call>): void => {
    current = {
      ...current,
      state: {
        ...current.state,
        calls: current.state.calls.map((entry) =>
          entry.id === 'c-1' ? { ...entry, ...fields } : entry,
        ),
      },
    };
  };
  let release = (): void => {};
  const lab = {
    runs: true,
    view: () => current,
    // As the lab does: the answer is saved, its pod starts outside the
    // lab's queue, and a failure opens the call again and throws.
    answerCall: async (_id: unknown, option: unknown) => {
      change({
        state: 'answered',
        answer: { option: Number(option), at: at(50) },
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      change({ state: 'open', answer: null });
      throw new Error('RunPod has no H100 free now.');
    },
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
  // Hooks run in order: the folder goes after the desk stops writing to it.
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const snapshot = async (): Promise<Snapshot> =>
    (await (await fetch(`${api}/snapshot`, { headers })).json()) as Snapshot;

  // The pod takes longer than the desk waits: the answer is accepted (202).
  const accepted = await fetch(`${api}/actions/lab-call-answer`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ call: 'c-1', option: 0, key: 'a'.repeat(32) }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, pending: true });
  // Meanwhile the call says that its answer is applied, not that it is done.
  const applying = await snapshot();
  const saved = applying.lab?.answered.find((entry) => entry.id === 'c-1');
  assert.equal(saved?.applying, true);
  assert.equal(saved?.undoUntil, null);

  release();
  let failed: Snapshot | undefined;
  // Each poll waits for its snapshot, so no request is still open when the test closes the desk.
  await until(async () => {
    failed = await snapshot();
    return Boolean(failed.lab?.works.some((work) => work.error));
  });
  const lab2 = failed?.lab;
  assert.ok(lab2);
  // The failure names its call and option, and the call waits again.
  assert.deepEqual(
    lab2.works.find((work) => work.error),
    {
      action: 'lab-call-answer',
      label: 'Applying your answer',
      at: lab2.works.find((work) => work.error)?.at,
      error: 'RunPod has no H100 free now.',
      call: 'c-1',
      option: 0,
    },
  );
  assert.equal(lab2.needsYou[0]?.id, 'c-1');
  assert.equal(lab2.needsYou[0]?.state, 'open');
  assert.equal(lab2.needsYou[0]?.applying, false);
});

await test("a bring-in that fails after Verifold accepted it names its direction, and a new try replaces only that direction's failure", async (t) => {
  const root = await project();
  const current = seededView();
  // Each look or bring-in waits until the test lets it fail.
  const waiting: (() => void)[] = [];
  const failLater = (why: string) => (): Promise<void> =>
    new Promise((_, reject) => {
      waiting.push(() => reject(new Error(why)));
    });
  const lab = {
    runs: true,
    view: () => current,
    lookToBring: failLater('The folder is gone.'),
    bring: failLater('A project file changed.'),
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
  // Hooks run in order: the folder goes after the desk stops writing to it.
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const snapshot = async (): Promise<Snapshot> =>
    (await (await fetch(`${api}/snapshot`, { headers })).json()) as Snapshot;
  const act = (name: string, body: Record<string, unknown>) =>
    fetch(`${api}/actions/${name}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const failures = async (count: number) => {
    let shown: Snapshot | undefined;
    // Each poll waits for its snapshot, so no request is still open when the test closes the desk.
    await until(async () => {
      shown = await snapshot();
      return (
        (shown.lab?.works.filter((work) => work.error).length ?? 0) === count
      );
    });
    return (shown?.lab?.works ?? []).map((work) => [
      work.action,
      work.direction,
      work.error,
    ]);
  };

  // A look at d-1 and a bring-in of d-2 take longer than the desk waits.
  const look = act('lab-bring-look', { direction: 'd-1' });
  await until(() => waiting.length === 1);
  const bring = act('lab-bring', {
    direction: 'd-2',
    commit: 'e'.repeat(40),
    files: ['a.md'],
  });
  await until(() => waiting.length === 2);
  assert.deepEqual([(await look).status, (await bring).status], [202, 202]);
  const running = await snapshot();
  assert.deepEqual(
    running.lab?.works.map((work) => [work.action, work.direction]),
    [
      ['lab-bring-look', 'd-1'],
      ['lab-bring', 'd-2'],
    ],
  );
  for (const fail of waiting.splice(0)) fail();
  assert.deepEqual(await failures(2), [
    ['lab-bring-look', 'd-1', 'The folder is gone.'],
    ['lab-bring', 'd-2', 'A project file changed.'],
  ]);

  // A new look at d-2 leaves the failure of d-1 in place.
  assert.equal((await act('lab-bring-look', { direction: 'd-2' })).status, 202);
  for (const fail of waiting.splice(0)) fail();
  assert.deepEqual(await failures(3), [
    ['lab-bring-look', 'd-1', 'The folder is gone.'],
    ['lab-bring', 'd-2', 'A project file changed.'],
    ['lab-bring-look', 'd-2', 'The folder is gone.'],
  ]);
  // A new look at d-1 replaces its own failure.
  assert.equal((await act('lab-bring-look', { direction: 'd-1' })).status, 202);
  for (const fail of waiting.splice(0)) fail();
  const again = await failures(3);
  assert.deepEqual(
    again.map(([action, direction]) => [action, direction]),
    [
      ['lab-bring', 'd-2'],
      ['lab-bring-look', 'd-2'],
      ['lab-bring-look', 'd-1'],
    ],
  );
});

await test('the API needs the token, pushes one snapshot for a burst of changes, pages the board and turns, and runs desk actions', async (t) => {
  // A long command output: a step sends only its last 4 KB.
  const root = await project('x'.repeat(10_000));
  let current = seededView();
  const words: unknown[] = [];
  const lab = {
    runs: true,
    view: () => current,
    answerCallInWords: (id: unknown, text: unknown) => {
      words.push([id, text]);
      return Promise.resolve();
    },
    answerQuestions: (answers: unknown) => {
      words.push(['questions', answers]);
      return Promise.resolve();
    },
    skipQuestions: () => {
      words.push(['skip']);
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
  // Hooks run in order: the folder goes after the desk stops writing to it.
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };

  assert.equal((await fetch(`${api}/snapshot`)).status, 401);
  const snapshot = (await (
    await fetch(`${api}/snapshot`, { headers })
  ).json()) as Snapshot;
  assert.equal(snapshot.protocolVersion, 1);
  assert.match(snapshot.epoch, /^[0-9a-f]{16}$/);
  assert.equal(snapshot.lab?.agents[0]?.handle, 'claude-1');
  assert.equal((await fetch(`${api}/snapshot?x=1`, { headers })).status, 404);

  // The stream sends the snapshot at once, then one snapshot for five changes in one interval.
  const stream = await fetch(`${api}/events`, { headers });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const { events, ids, pings, stop } = listen(stream);
  await until(() => events.length === 1);
  const first = events[0];
  assert.ok(first);
  assert.equal(ids[0], `${snapshot.epoch}.${first.rev}`);
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
  assert.equal(events[1]?.epoch, snapshot.epoch);
  assert.equal(events[1]?.lab?.board.posts.length, 9);
  assert.ok(pings() > 0);
  await stop();

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
  // A fold's short list: the newest tool calls only, as many as it asks for.
  const turnUrl = `${api}/agents/a-1/turns/${encodeURIComponent(firstTurn.id)}`;
  const short = (await (
    await fetch(`${turnUrl}?limit=2&tools=1`, { headers })
  ).json()) as TurnDetail;
  assert.deepEqual(
    short.steps.map((entry) => entry.type),
    ['tool', 'tool'],
  );
  assert.equal(short.more, true);
  assert.ok(detail.steps.filter((entry) => entry.type === 'tool').length > 2);
  for (const query of ['limit=0', 'limit=201', 'limit=two', 'tools=yes'])
    assert.equal(
      (await fetch(`${turnUrl}?${query}`, { headers })).status,
      400,
      query,
    );
  for (const query of ['x=1', 'limit=2&limit=3'])
    assert.equal(
      (await fetch(`${turnUrl}?${query}`, { headers })).status,
      404,
      query,
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
  // The planner's questions: answers together, and a skip.
  const answers = [
    { call: 'c-1', option: 1 },
    { call: 'c-3', words: 'Both.' },
  ];
  assert.equal((await action('lab-questions-answer', { answers })).status, 200);
  assert.equal((await action('lab-skip-questions', {})).status, 200);
  assert.deepEqual(words.slice(1), [['questions', answers], ['skip']]);
  // A desk with a project takes no project start.
  assert.equal(
    (await action('project-start', { question: 'Another?' })).status,
    404,
  );
  assert.equal((await fetch(`${api}/start`, { headers })).status, 404);
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

await test("a turn's revision grows when a running step ends, with no new tool call", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const running = '20261020T090000000Z-dddddd01';
  const finished = '20261020T090000000Z-dddddd02';
  await writeTranscript(root, running, claudeSession());
  await writeTranscript(root, finished, [
    ...claudeSession(),
    ...claudeUpdates(claude.result('t6', 'gap 0.31\n')),
  ]);
  const newest = async (
    session: string,
  ): Promise<TurnPage['turns'][number]> => {
    const reader = new ApiReader(sources(root, () => withSession(session)));
    const last = (await reader.turnPage('a-1'))?.turns.at(-1);
    assert.ok(last);
    return last;
  };
  const before = await newest(running);
  const after = await newest(finished);
  // The command only ended: the same counts, a higher revision.
  assert.deepEqual(after.counts, before.counts);
  assert.ok(before.rev !== undefined && after.rev !== undefined);
  assert.ok(after.rev > before.rev, `${after.rev} > ${before.rev}`);
});

await test('a turn names the posts and runs that its own tool calls made, and marks a match by time', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = '20261020T090000000Z-dddddd03';
  await writeTranscript(root, session, [
    requestUpdate('Go.'),
    ...claudeUpdates(
      claude.tool('tr', 'mcp__verifold__verifold_run', {
        command: 'python probe.py',
      }),
    ),
    ...claudeUpdates(claude.result('tr', 'Started r-1.')),
    ...claudeUpdates(
      claude.tool('tp', 'mcp__verifold__verifold_post', {
        kind: 'claim',
        text: 'The gap is 34% smaller.',
      }),
    ),
    ...claudeUpdates(claude.result('tp', 'Posted p-2.')),
    ...claudeUpdates(claude.text('Done.')),
    ...claudeUpdates(claude.end),
  ]);
  // A post's key is agent:generation:call, and a run's key generation:call.
  const keyed = (): LabView => {
    const view = withSession(session);
    return {
      ...view,
      posts: view.posts.map((entry) =>
        entry.id === 'p-2' ? { ...entry, key: 'a-1:0a1b2c3d:tp' } : entry,
      ),
      ledger: view.ledger.map((run) => ({ ...run, key: '0a1b2c3d:tr' })),
    };
  };
  const exact = (
    await new ApiReader(sources(root, keyed)).turnPage('a-1')
  )?.turns.at(-1);
  assert.ok(exact);
  assert.deepEqual(
    [exact.runs, exact.posts, exact.proofByTime],
    [['r-1'], ['p-2'], false],
  );
  // No record carries the calls' IDs: the agent's records from while the turn ran fill in, marked as matched by time.
  const during = exact.startedAt;
  const unkeyed = (): LabView => {
    const view = withSession(session);
    return {
      ...view,
      posts: [
        ...view.posts,
        post('p-5', 'a-1', 'claim', 'From the turn.', { at: during }),
      ],
      ledger: view.ledger.map((run) => ({
        ...run,
        key: '0a1b2c3d:another-call',
        queuedAt: during,
      })),
    };
  };
  const timed = (
    await new ApiReader(sources(root, unkeyed)).turnPage('a-1')
  )?.turns.at(-1);
  assert.ok(timed);
  assert.deepEqual(
    [timed.runs, timed.posts, timed.proofByTime],
    [['r-1'], ['p-5'], true],
  );
  // The records' keys never show.
  assert.doesNotMatch(JSON.stringify(timed), /another-call|0a1b2c3d:/);
});

await test('the time away names the first five directions with news, how many more, what came, and what the lab spent', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = seededView();
  // Seven directions, each with a post after the person left, and two runs that ended meanwhile, one failed.
  const directions = Array.from({ length: 7 }, (_, index) =>
    direction(`d-${index + 1}`, `Direction ${index + 1}`, 'a-1'),
  );
  const view: LabView = {
    ...base,
    state: { ...base.state, directions },
    directions: directions.map((entry) => ({
      direction: entry,
      agent: agentRecord('a-1', 'claude-1', 'claude', entry.id, sessionOf.a1),
      status: 'idle',
      until: null,
    })),
    posts: directions.map((entry, index) =>
      post(`p-${60 + index}`, 'a-1', 'claim', `Step ${index}.`, {
        direction: entry.id,
      }),
    ),
    ledger: [
      { ...runRecord('r-1'), endedAt: at(70) },
      { ...runRecord('r-2'), status: 'failed', exitCode: 1, endedAt: at(71) },
    ],
  };
  const reader = new ApiReader(
    sources(root, () => view, {
      away: () =>
        Promise.resolve({ since: at(50), spent: { claude: 2, gpu: 0 } }),
    }),
  );
  const news = parse((await reader.build()).json).lab?.away?.news;
  assert.ok(news);
  assert.equal(news.lines.length, 5);
  assert.equal(news.moreLines, 2);
  assert.deepEqual(news.lines[0], {
    direction: 'd-1',
    title: 'Direction 1',
    mark: 'open',
    said: 'Not settled yet. 1 new post.',
  });
  // The counts name failed runs by ID, as plain text.
  assert.equal(news.counts, '7 posts, 2 runs ended (1 failed: r-2)');
  // No pods here: the cost names Claude Code only.
  assert.equal(news.cost, 'Spent since then: ≈$0.50 (Claude Code ≈$0.50).');
});

await test('search finds posts, runs, and calls as the desk does, the newest first, with marked snippets, and each call with its question and answer', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const reader = new ApiReader(sources(root, seededView));
  const seed = reader.search('SEED');
  assert.ok(seed);
  assert.deepEqual(
    seed.hits.map((hit) => [hit.type, hit.id]),
    [
      ['run', 'r-1'],
      ['post', 'p-3'],
      ['post', 'p-2'],
    ],
  );
  assert.equal(seed.total, 3);
  assert.equal(seed.note, '3 hits, the newest first.');
  const claim = seed.hits[2];
  assert.ok(claim?.type === 'post');
  assert.deepEqual(claim.snippet, [
    { text: 'The gap is 34% smaller on ', mark: false },
    { text: 'seed', mark: true },
    { text: ' 1.', mark: false },
  ]);
  assert.deepEqual(
    [claim.label, claim.author, claim.direction],
    ['Claim', 'claude-1', 'd-1'],
  );
  const run = seed.hits[0];
  assert.ok(run?.type === 'run');
  assert.deepEqual([run.author, run.direction], ['claude-1', 'd-1']);
  // Each word must match.
  assert.deepEqual(
    reader.search('seed probe')?.hits.map((hit) => hit.id),
    ['r-1'],
  );
  // A call: its kind, who asked, where it stands, and its question, so a page without the call can show it.
  const [found] = reader.search('H100')?.hits ?? [];
  assert.ok(found?.type === 'call');
  assert.deepEqual(
    [found.id, found.label, found.author, found.state, found.summary],
    ['c-1', 'Cost call', 'claude-1', 'open', 'waits for you'],
  );
  assert.deepEqual(
    [found.question, found.answer, found.note],
    ['Rent an H100 for the probe reruns?', null, null],
  );
  // An answered call carries the option and when the person chose it.
  const [answered] = reader.search('Continue')?.hits ?? [];
  assert.ok(answered?.type === 'call');
  assert.deepEqual(
    [answered.id, answered.state, answered.summary, answered.answer],
    [
      'c-2',
      'answered',
      'you chose "Continue"',
      { option: 'Continue', at: at(3) },
    ],
  );
  // An answer in the person's own words has no time.
  const words = new ApiReader(
    sources(root, () => {
      const view = seededView();
      return {
        ...view,
        state: {
          ...view.state,
          calls: [call({ state: 'answered', words: 'Use the Mac.' })],
        },
      };
    }),
  ).search('H100')?.hits[0];
  assert.ok(words?.type === 'call');
  assert.deepEqual(words.answer, { words: 'Use the Mac.' });
  // No words: what to type, and no hits.
  assert.deepEqual(reader.search('  '), {
    q: '  ',
    note: 'Type a word, an ID such as p-12 or r-3, or a part of a command.',
    total: 0,
    hits: [],
  });
});

await test("a post's thread: the post and the replies below it at any depth, oldest first, within the page bound", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const reader = new ApiReader(sources(root, seededView));
  const thread = reader.thread('p-2');
  assert.ok(thread);
  assert.deepEqual(
    thread.posts.map((entry) => [entry.id, entry.replyTo, entry.handle]),
    [
      ['p-2', null, 'claude-1'],
      ['p-3', 'p-2', 'codex-1'],
    ],
  );
  assert.equal(thread.more, false);
  // A reply's page starts at the reply. Its own post is one link up.
  assert.deepEqual(
    reader.thread('p-3')?.posts.map((entry) => entry.id),
    ['p-3'],
  );
  assert.equal(reader.thread('p-99'), null);
  // A long thread: replies to replies count, and the page keeps the oldest ones.
  const long = (): LabView => {
    const view = seededView();
    return {
      ...view,
      posts: [
        post('p-1', 'a-1', 'claim', 'A claim.'),
        ...Array.from({ length: 60 }, (_, index) =>
          post(`p-${index + 2}`, 'a-2', 'objection', `Reply ${index + 1}.`, {
            replyTo: `p-${index + 1}`,
          }),
        ),
      ],
    };
  };
  const deep = new ApiReader(sources(root, long)).thread('p-1');
  assert.ok(deep);
  assert.equal(deep.posts.length, apiLimits.posts);
  assert.deepEqual(
    [deep.posts[1]?.id, deep.posts.at(-1)?.id, deep.more],
    ['p-2', 'p-50', true],
  );
});

await test("a look after a time away starts the digest, a dismiss ends it, and search and a post's thread answer over HTTP with the token", async (t) => {
  const root = await project();
  const view = seededView();
  const lab = { runs: true, view: () => view } as unknown as Lab;
  const sessions = {
    view: () => null,
    views: () => [],
  } as unknown as SessionPool;
  // The person last looked two hours ago, when the plans had cost $1.
  const left = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  await mkdir(join(root, '.verifold', 'lab'), { recursive: true });
  await writeFile(
    join(root, '.verifold', 'lab', 'look.json'),
    JSON.stringify({
      schemaVersion: 1,
      lab: view.state.startedAt,
      at: left,
      claude: 1,
      gpu: 0,
      away: null,
    }),
  );
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
  // Hooks run in order: the folder goes after the desk stops writing to it.
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const action = (name: string): Promise<Response> =>
    fetch(`${api}/actions/${name}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
  const away = async (): Promise<Away | null> =>
    ((await (await fetch(`${api}/snapshot`, { headers })).json()) as Snapshot)
      .lab?.away ?? null;
  assert.equal(await away(), null);
  // The app's look, as the desk's own page notes it: the time away starts.
  assert.equal((await action('lab-look')).status, 200);
  const back = await away();
  assert.ok(back);
  assert.equal(back.since, left);
  assert.deepEqual(back.spentThen, { plansUsd: 1, gpuUsd: 0 });
  assert.equal(
    back.news?.cost,
    'Spent since then: ≈$1.50 (Claude Code ≈$1.50).',
  );
  // A look again while the person is here changes nothing.
  assert.equal((await action('lab-look')).status, 200);
  assert.equal((await away())?.since, left);
  assert.equal((await action('lab-away-dismiss')).status, 200);
  assert.equal(await away(), null);
  // Search needs the token, takes only `q`, and as many characters as the search box.
  assert.equal((await fetch(`${api}/search?q=seed`)).status, 401);
  const found = (await (
    await fetch(`${api}/search?q=seed`, { headers })
  ).json()) as SearchResult;
  assert.equal(found.total, 3);
  assert.equal(
    (
      await fetch(`${api}/search?q=${'a'.repeat(searchQueryLimit)}`, {
        headers,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${api}/search?q=${'a'.repeat(searchQueryLimit + 1)}`, {
        headers,
      })
    ).status,
    400,
  );
  assert.equal((await fetch(`${api}/search?q=a&x=1`, { headers })).status, 404);
  // A post's thread needs the token and a post ID, and takes no query.
  assert.equal((await fetch(`${api}/posts/p-2`)).status, 401);
  const thread = (await (
    await fetch(`${api}/posts/p-2`, { headers })
  ).json()) as PostThread;
  assert.deepEqual(
    thread.posts.map((entry) => entry.id),
    ['p-2', 'p-3'],
  );
  assert.equal((await fetch(`${api}/posts/p-99`, { headers })).status, 404);
  assert.equal((await fetch(`${api}/posts/x-2`, { headers })).status, 400);
  assert.equal((await fetch(`${api}/posts/p-2?x=1`, { headers })).status, 404);
});

await test("with a monthly limit, the snapshot's money holds all projects' month", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const month = {
    limitUsd: 100,
    spentUsd: 37.204,
    heldUsd: 2,
    leftUsd: 60.796,
    at: at(1),
  };
  const reader = new ApiReader(
    sources(root, seededView, {
      compute: { view: () => ({ ...computeView(), month }) },
    }),
  );
  assert.deepEqual(parse((await reader.build()).json).lab?.money, {
    plansUsd: 2.5,
    gpuUsd: 4.2,
    gpuLimitUsd: 25,
    month: { spentUsd: 37.2, limitUsd: 100 },
  });
});

await test('a run read holds the run, its kept files within the bound, the end of its log, and whether the person can cancel it', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  let ledger: RunRecord[] = [runRecord('r-1')];
  let here = true;
  let views = 0;
  const asked: [string, number][] = [];
  const reads: LabReadSource = {
    run: (id) => {
      const record = ledger.find((entry) => entry.id === id);
      return record ? { record, handle: 'claude-1', here } : null;
    },
    runLog: (run, bytes) => {
      asked.push([run, bytes]);
      return Promise.resolve({
        text: 'step 900 gap=0.34\n',
        bytes: 900_000,
        partial: true,
      });
    },
    diff: () => Promise.resolve(null),
    figure: () => Promise.resolve({ missing: 'Not in this test.' }),
  };
  // A run read needs no lab view: it reads the run's record alone.
  const reader = new ApiReader(
    sources(
      root,
      () => {
        views++;
        return seededView();
      },
      { reads },
    ),
  );
  const done = await reader.run('r-1');
  assert.equal(views, 0);
  assert.ok(done);
  assert.equal(done.run.id, 'r-1');
  assert.equal(done.run.command, 'python probe_train.py --seed 1');
  assert.equal(done.handle, 'claude-1');
  assert.equal(done.harness, 'claude');
  assert.equal(done.minutes, 60);
  assert.deepEqual(done.outputs, []);
  assert.deepEqual(done.log, {
    text: 'step 900 gap=0.34\n',
    bytes: 900_000,
    partial: true,
  });
  // A run that ended cannot be cancelled. The read asks for the bounded end of the log.
  assert.equal(done.cancelable, false);
  assert.deepEqual(asked, [['r-1', apiLimits.runLog]]);

  // A running run with more kept files than the bound.
  const outputs = Array.from(
    { length: apiLimits.runOutputs + 3 },
    (_, index) => ({
      path: `figures/seed-${index}.png`,
      bytes: 1000 + index,
      sha256: 'f'.repeat(64),
    }),
  );
  ledger = [{ ...runRecord('r-1'), status: 'running', endedAt: null, outputs }];
  const running = await reader.run('r-1');
  assert.ok(running);
  assert.equal(running.cancelable, true);
  assert.equal(running.outputs.length, apiLimits.runOutputs);
  assert.equal(running.moreOutputs, 3);
  assert.deepEqual(running.outputs[0], {
    path: 'figures/seed-0.png',
    bytes: 1000,
  });
  // No internal field leaves the server: the harness call's key, the config hash, or the run's folder.
  assert.doesNotMatch(
    JSON.stringify(running),
    /SECRET|run-1-1a2b3c4d|"sha256"|"key"/,
  );

  // A Verifold that only shows the lab cannot cancel a run.
  here = false;
  assert.equal((await reader.run('r-1'))?.cancelable, false);
  // A run that the lab does not have, and a desk without the lab's reads.
  assert.equal(await reader.run('r-9'), null);
  const bare = new ApiReader(sources(root, () => seededView()));
  assert.equal(await bare.run('r-1'), null);
});

await test("a diff read lists a direction's changed files within the bound, gives one file's diff when asked, and passes a proof on", async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = Array.from({ length: apiLimits.diffFiles + 2 }, (_, index) => ({
    path: `src/file-${index}.py`,
    change: index === 0 ? ('added' as const) : ('modified' as const),
    regular: index !== 1,
  }));
  const asked: unknown[] = [];
  const reads: LabReadSource = {
    run: () => null,
    runLog: () => Promise.resolve(null),
    diff: (direction, file, proof) => {
      asked.push([direction, file, proof]);
      if (direction !== 'd-1') return Promise.resolve(null);
      if (file === 'outside.txt')
        return Promise.reject(
          new SessionActionError('That file is not in this diff.'),
        );
      return Promise.resolve({
        from: 'a'.repeat(40),
        to: 'b'.repeat(40),
        files,
        diff: file ? { text: '@@ -1 +1 @@\n-old\n+new\n', cut: false } : null,
      });
    },
    figure: () => Promise.resolve({ missing: 'Not in this test.' }),
  };
  const reader = new ApiReader(sources(root, () => seededView(), { reads }));
  const list = await reader.directionDiff('d-1');
  assert.ok(list);
  assert.equal(list.files.length, apiLimits.diffFiles);
  assert.equal(list.moreFiles, 2);
  assert.deepEqual(list.files[1], {
    path: 'src/file-1.py',
    change: 'modified',
    regular: false,
  });
  assert.equal(list.diff, null);
  const one = await reader.directionDiff('d-1', 'src/file-0.py', 'p-2.0');
  assert.deepEqual(one?.diff, {
    path: 'src/file-0.py',
    text: '@@ -1 +1 @@\n-old\n+new\n',
    trimmed: false,
  });
  assert.deepEqual(asked, [
    ['d-1', undefined, undefined],
    ['d-1', 'src/file-0.py', 'p-2.0'],
  ]);
  assert.equal(await reader.directionDiff('d-9'), null);
  await assert.rejects(
    reader.directionDiff('d-1', 'outside.txt'),
    /not in this diff/,
  );
});

await test('the run, diff, and figure reads answer over HTTP with the token, and refuse a bad ID, an unknown query, a file outside the diff, and a path for a figure', async (t) => {
  const root = await project();
  const png = pngHead(640, 480);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const lab = {
    runs: true,
    view: () => seededView(),
    runRecord: (id: unknown) =>
      id === 'r-1' ? { record: runRecord('r-1'), handle: 'claude-1' } : null,
    runLog: (id: unknown, bytes: unknown) =>
      Promise.resolve(
        id === 'r-1' && bytes === apiLimits.runLog
          ? { text: 'done\n', bytes: 5, partial: false }
          : null,
      ),
    directionDiff: (id: unknown, path: unknown, proof: unknown) => {
      if (id !== 'd-1') return Promise.resolve(null);
      if (path === 'missing.py')
        return Promise.reject(
          new SessionActionError('That file is not in this diff.'),
        );
      return Promise.resolve({
        from: 'a'.repeat(40),
        to: proof ? 'c'.repeat(40) : 'b'.repeat(40),
        files: [{ path: 'probe.py', change: 'added', regular: true }],
        diff: path === undefined ? null : { text: '+x\n', cut: false },
      });
    },
    // Pinned figures: p-3.0 a PNG, p-3.1 an SVG, p-3.2 a PDF with a space in its name. p-4.0 is
    // larger than the bound, p-5.0 does not match its record, and p-6.0 and p-6.1 declare too many
    // pixels or none that Verifold can read.
    figure: (proof: unknown, bytes: unknown) => {
      const figures: Record<string, FigureRead> = {
        'p-3.0': { path: 'results/fig.png', content: png },
        'p-3.1': { path: 'results/fig.SVG', content: Buffer.from(svg) },
        'p-3.2': {
          path: 'results/report v2.pdf',
          content: Buffer.from('%PDF-1.4\n'),
        },
        'p-4.0': { large: 'This figure has 30000000 bytes.' },
        'p-5.0': { changed: 'fig.png at a3f9c2e does not match p-5.' },
        'p-6.0': { path: 'results/huge.png', content: pngHead(60_000, 60_000) },
        'p-6.1': { path: 'results/broken.png', content: Buffer.from('PNG') },
      };
      return Promise.resolve(
        (bytes === apiLimits.figure &&
          typeof proof === 'string' &&
          figures[proof]) || { missing: `p-9 cites no figure at place 0.` },
      );
    },
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
  // Hooks run in order: the folder goes after the desk stops writing to it.
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const get = (path: string, auth = true): Promise<Response> =>
    fetch(`${api}${path}`, auth ? { headers } : {});

  assert.equal((await get('/runs/r-1', false)).status, 401);
  const run = (await (await get('/runs/r-1')).json()) as RunDetail;
  assert.equal(run.run.id, 'r-1');
  assert.deepEqual(run.log, { text: 'done\n', bytes: 5, partial: false });
  assert.equal((await get('/runs/r-9')).status, 404);
  const bad = await get('/runs/x-1');
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /r-3/);
  assert.equal((await get('/runs/r-1?tail=1')).status, 404);

  assert.equal((await get('/directions/d-1/diff', false)).status, 401);
  const list = (await (
    await get('/directions/d-1/diff')
  ).json()) as DirectionDiff;
  assert.deepEqual(list.files, [
    { path: 'probe.py', change: 'added', regular: true },
  ]);
  assert.equal(list.diff, null);
  const one = (await (
    await get('/directions/d-1/diff?file=probe.py&proof=p-2.0')
  ).json()) as DirectionDiff;
  assert.equal(one.to, 'c'.repeat(40));
  assert.deepEqual(one.diff, {
    path: 'probe.py',
    text: '+x\n',
    trimmed: false,
  });
  // A file outside the diff is refused with the reason, and an unknown direction is not found.
  const outside = await get('/directions/d-1/diff?file=missing.py');
  assert.equal(outside.status, 404);
  assert.match(
    ((await outside.json()) as { error: string }).error,
    /not in this diff/,
  );
  assert.equal((await get('/directions/d-9/diff')).status, 404);
  // A bad proof, a repeated or unknown key, and an empty file are refused before any read.
  for (const query of [
    '?proof=p-2',
    '?proof=x',
    '?file=a.py&file=b.py',
    '?path=a.py',
    '?file=',
  ])
    assert.equal(
      (await get(`/directions/d-1/diff${query}`)).status,
      400,
      query,
    );

  // A pinned figure comes as it is, with its exact type. As a page of its own it gets no
  // script and no origin, and an SVG or a PDF is a download.
  const sandbox =
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  assert.equal((await get('/figures/p-3.0', false)).status, 401);
  const image = await get('/figures/p-3.0');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('content-security-policy'), sandbox);
  assert.equal(
    image.headers.get('content-disposition'),
    'inline; filename="fig.png"',
  );
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const vector = await get('/figures/p-3.1');
  assert.equal(vector.headers.get('content-type'), 'image/svg+xml');
  assert.equal(vector.headers.get('content-security-policy'), sandbox);
  assert.equal(
    vector.headers.get('content-disposition'),
    'attachment; filename="fig.SVG"',
  );
  assert.equal(await vector.text(), svg);
  const pdf = await get('/figures/p-3.2');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(
    pdf.headers.get('content-disposition'),
    'attachment; filename="report_v2.pdf"',
  );
  // Each refusal says why: no such figure (404), bytes that do not match the record (409),
  // and a figure or an image over the bound (413).
  const reason = async (path: string, status: number): Promise<string> => {
    const answer = await get(path);
    assert.equal(answer.status, status, path);
    return ((await answer.json()) as { error: string }).error;
  };
  assert.match(await reason('/figures/p-9.0', 404), /cites no figure/);
  assert.match(await reason('/figures/p-5.0', 409), /does not match/);
  assert.match(await reason('/figures/p-4.0', 413), /30000000 bytes/);
  assert.match(
    await reason('/figures/p-6.0', 413),
    /60000 × 60000 pixels\. Verifold shows images up to 20000 pixels/,
  );
  assert.match(
    await reason('/figures/p-6.1', 413),
    /cannot read the size of this image/,
  );
  // A path or a bad proof never reaches the read, and a query or a longer path finds no figure.
  for (const path of [
    '/figures/results%2Ffig.png',
    '/figures/..%2F..%2Fetc%2Fhosts',
    '/figures/p-3',
    '/figures/p-3.x',
  ])
    assert.equal((await get(path)).status, 400, path);
  assert.equal((await get('/figures/p-3.0?path=results/fig.png')).status, 404);
  assert.equal((await get('/figures/p-3.0/fig.png')).status, 404);
});

await test('an image declares its pixels in its header, a figure gets a name that is safe in a header, and an SVG or a PDF is a download', () => {
  assert.deepEqual(imageSize('image/png', pngHead(640, 480)), {
    width: 640,
    height: 480,
  });
  // A GIF's logical screen.
  const gif = Buffer.alloc(13);
  gif.write('GIF89a', 0, 'latin1');
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(200, 8);
  assert.deepEqual(imageSize('image/gif', gif), { width: 320, height: 200 });
  // A JPEG: an APP0 segment, then a frame that gives its height and width.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11,
    0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
  ]);
  assert.deepEqual(imageSize('image/jpeg', jpeg), { width: 640, height: 480 });
  // Image data before any frame: no size to read.
  assert.equal(
    imageSize(
      'image/jpeg',
      Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0, 0, 0, 0]),
    ),
    null,
  );
  // WebP: an extended, a lossless, and a lossy header.
  const webp = (chunk: string, body: readonly number[]): Buffer => {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'latin1');
    bytes.write('WEBP', 8, 'latin1');
    bytes.write(chunk, 12, 'latin1');
    Buffer.from(body).copy(bytes, 20);
    return bytes;
  };
  const lossless = 639 | (479 << 14);
  for (const [chunk, body] of [
    ['VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]],
    [
      'VP8L',
      [
        0x2f,
        lossless & 0xff,
        (lossless >> 8) & 0xff,
        (lossless >> 16) & 0xff,
        (lossless >> 24) & 0xff,
      ],
    ],
    ['VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]],
  ] as const)
    assert.deepEqual(
      imageSize('image/webp', webp(chunk, body)),
      { width: 640, height: 480 },
      chunk,
    );
  // A header that Verifold cannot read, and a type without a pixel size.
  assert.equal(imageSize('image/png', Buffer.from('PNG')), null);
  assert.equal(imageSize('image/svg+xml', Buffer.from('<svg/>')), null);

  // A file name keeps only safe characters, and a hidden name becomes `figure`.
  assert.equal(figureName('results/report v2.pdf', 'pdf'), 'report_v2.pdf');
  assert.equal(figureName('results/.hidden.png', 'png'), 'figure.png');
  assert.match(figureName('a/"x";\r\n.svg', 'svg'), /^[A-Za-z0-9._-]+$/);
  const raster = figureHeaders('results/gap.png', 'image/png', 9);
  assert.equal(raster['Content-Disposition'], 'inline; filename="gap.png"');
  const vector = figureHeaders('results/gap.svg', 'image/svg+xml', 9);
  assert.equal(vector['Content-Disposition'], 'attachment; filename="gap.svg"');
  assert.match(
    String(vector['Content-Security-Policy']),
    /^sandbox; default-src 'none'.*frame-ancestors 'none'; base-uri 'none'; form-action 'none'$/,
  );
});

await test('a dismiss clears only the background failures that the page names, and every failure without names', async (t) => {
  const root = await project();
  const releases: (() => void)[] = [];
  // Each action waits longer than the desk does, then fails after the desk accepted it (202).
  const slow = (reason: string) => async (): Promise<void> => {
    await new Promise<void>((resolve) => releases.push(resolve));
    throw new Error(reason);
  };
  const lab = {
    runs: true,
    view: () => seededView(),
    pause: slow('An agent did not park in time.'),
    resume: slow('The lab is not paused.'),
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
  // Hooks run in order: the folder goes after the desk stops writing to it.
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const act = (name: string, body: object, key: string): Promise<Response> =>
    fetch(`${api}/actions/${name}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, key }),
    });
  const works = async (): Promise<
    Snapshot['lab'] extends infer L ? L : never
  > =>
    ((await (await fetch(`${api}/snapshot`, { headers })).json()) as Snapshot)
      .lab;
  const [paused, resumed] = await Promise.all([
    act('lab-pause', {}, 'a'.repeat(32)),
    act('lab-resume', {}, 'b'.repeat(32)),
  ]);
  assert.equal(paused.status, 202);
  assert.equal(resumed.status, 202);
  for (const release of releases) release();
  await until(
    async () =>
      ((await works())?.works.filter((work) => work.error).length ?? 0) === 2,
  );
  const failed = (await works())?.works ?? [];
  const pause = failed.find((work) => work.action === 'lab-pause');
  assert.ok(pause);
  // The page names the pause failure only, so the other one stays.
  assert.equal(
    (
      await act(
        'lab-dismiss',
        { works: [{ action: pause.action, at: pause.at }] },
        'c'.repeat(32),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await works())?.works.map((work) => work.action),
    ['lab-resume'],
  );
  // An older page names nothing: every failure goes.
  assert.equal((await act('lab-dismiss', {}, 'd'.repeat(32))).status, 200);
  assert.deepEqual((await works())?.works, []);
});

await test("the settings page reads the project's pods and settings, and changes them through API v1", async (t) => {
  // Hooks run in order: this one, which closes the desk, comes before fakePod's removal of its folder.
  const owner = new AbortController();
  let closed: Promise<unknown> = Promise.resolve();
  t.after(async () => {
    owner.abort();
    await closed;
  });
  const fake = await fakePod(t);
  const root = await realpath(fake.root);
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'R',
      interests: ['Probes'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  const sessions = {
    limit: 3,
    view: () => null,
    views: () => [],
  } as unknown as SessionPool;
  const desk = await startDesk(
    root,
    owner.signal,
    await deskAssets(root),
    sessions,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.compute,
    undefined,
    { api: { pollMs: 40, heartbeatMs: 100 } },
  );
  closed = desk.closed;
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const read = async (): Promise<{ text: string; snapshot: Snapshot }> => {
    const text = await (await fetch(`${api}/snapshot`, { headers })).text();
    return { text, snapshot: JSON.parse(text) as Snapshot };
  };
  const compute = async () => {
    const shown = (await read()).snapshot.compute;
    assert.ok(shown);
    return shown;
  };
  const act = (name: string, body: Record<string, unknown>, auth = headers) =>
    fetch(`${api}/actions/${name}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const refused = async (response: Response): Promise<string> => {
    assert.equal(response.status, 409);
    return ((await response.json()) as { error: string }).error;
  };

  // Without a lab, the project's pods and settings show. The key shows only its last four characters.
  const first = await read();
  assert.equal(first.snapshot.lab, null);
  const shown = await compute();
  assert.deepEqual(shown.keyStored, {
    last4: runpodKey.slice(-4),
    problem: null,
  });
  assert.equal(shown.settings.limitUsd, 10);
  assert.deepEqual(shown.settings.gpuTypes, ['NVIDIA RTX A5000']);
  assert.equal(shown.agentsAtOnce, 3);
  assert.match(shown.settingsVersion, /^[a-f0-9]{16}$/);
  assert.deepEqual(
    [shown.pods, shown.earlier, shown.earlierCount, shown.gpus, shown.works],
    [[], [], 0, null, []],
  );
  assert.doesNotMatch(first.text, new RegExp(runpodKey));

  // RunPod's prices, read on request.
  assert.equal((await act('compute-gpus', {})).status, 200);
  assert.deepEqual((await compute()).gpus?.types, [
    {
      id: 'NVIDIA RTX A5000',
      name: 'RTX A5000',
      memoryGb: 24,
      usdPerHour: 0.27,
      stock: 'high',
      common: false,
    },
  ]);

  // The settings change at once, with the desk's checks and words.
  const settings = {
    limitUsd: 20,
    maxUsdPerHour: 1,
    maxHoursPerLease: 4,
    idleMinutes: 15,
    maxRunningPods: 1,
    gpuTypes: ['NVIDIA RTX A5000'],
    images: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
    diskGb: 50,
    askBeforePod: true,
  };
  assert.equal((await act('compute-settings', settings)).status, 200);
  assert.deepEqual((await compute()).settings, settings);
  assert.match(
    await refused(
      await act('compute-settings', { ...settings, maxUsdPerHour: 0 }),
    ),
    /rate cap in USD per hour/,
  );
  assert.equal((await compute()).settings.maxUsdPerHour, 1);
  // The app sends only the fields that the person changed, with the version that they edited.
  const version = (await compute()).settingsVersion;
  assert.equal(
    (await act('compute-settings', { idleMinutes: 30, base: version })).status,
    200,
  );
  const changed = await compute();
  assert.deepEqual(changed.settings, { ...settings, idleMinutes: 30 });
  assert.notEqual(changed.settingsVersion, version);
  // A form from before that change is refused, and the newer settings stay.
  assert.equal(
    await refused(
      await act('compute-settings', { limitUsd: 5, base: version }),
    ),
    'These settings changed while you edited them. Here is the new version.',
  );
  assert.deepEqual((await compute()).settings, changed.settings);

  // "Agents at once" goes into the project's record and its worker slots.
  assert.equal((await act('compute-agents', { agents: 5 })).status, 200);
  assert.equal((await compute()).agentsAtOnce, 5);
  assert.equal((await loadWorkspace(root)).agents, 5);
  assert.equal(
    await refused(await act('compute-agents', { agents: 9 })),
    'Choose a whole number of agents from 1 to 8.',
  );

  // A pod that waits for the person, then its life: approve, stop, start again, and end.
  await fake.compute.leases.request({
    by: 'agent',
    gpu: 'NVIDIA RTX A5000',
    hours: 2,
    directions: ['d-1'],
    reason: 'Train the probe on 3 seeds.',
  });
  const [waiting] = (await compute()).pods;
  assert.ok(waiting);
  assert.deepEqual(
    [
      waiting.id,
      waiting.state,
      waiting.asker,
      waiting.directions,
      waiting.reason.text,
      waiting.hours,
      waiting.missingSecrets,
    ],
    [
      'lease-1',
      'requested',
      'agent',
      ['d-1'],
      'Train the probe on 3 seeds.',
      2,
      [],
    ],
  );
  assert.ok(waiting.maxUsd > 0.54 && waiting.maxUsd < 0.6);
  const state = async (lease: string) => {
    const now = await compute();
    return [...now.pods, ...now.earlier].find((pod) => pod.id === lease)?.state;
  };
  for (const [action, after] of [
    ['approve', 'starting'],
    ['stop', 'stopped'],
    ['start', 'starting'],
    ['end', 'ended'],
  ] as const) {
    assert.equal(
      (await act(`compute-lease-${action}`, { lease: 'lease-1' })).status,
      200,
    );
    assert.equal(await state('lease-1'), after);
  }
  const ended = await compute();
  assert.deepEqual(
    [ended.pods.length, ended.earlierCount, ended.earlier[0]?.ended?.reason],
    [0, 1, 'you ended it.'],
  );
  // The snapshot holds no pod ID or address.
  const text = (await read()).text;
  assert.doesNotMatch(text, /pod1|podName|podId|"ssh"/);

  // A pod that lacks a secret names it, and cannot start until the secret is stored.
  await fake.compute.leases.request({
    by: 'agent',
    gpu: 'NVIDIA RTX A5000',
    hours: 1,
    directions: ['d-1'],
    reason: 'A gated model.',
    secrets: ['HF_TOKEN'],
  });
  const gated = (await compute()).pods.find((pod) => pod.id === 'lease-2');
  assert.deepEqual(
    [gated?.secrets, gated?.missingSecrets],
    [['HF_TOKEN'], ['HF_TOKEN']],
  );
  assert.match(
    await refused(await act('compute-lease-approve', { lease: 'lease-2' })),
    /Store the secret HF_TOKEN first, with `verifold runpod secret set HF_TOKEN`\. The pod of lease-2 needs it\./,
  );
  // A retry with the same intent key gets the same answer, and runs nothing again.
  const key = 'a'.repeat(32);
  for (let index = 0; index < 2; index++)
    assert.equal(
      (await act('compute-lease-deny', { lease: 'lease-2', key })).status,
      200,
    );
  assert.equal(await state('lease-2'), 'denied');
  assert.equal(
    await refused(
      await act('compute-lease-deny', {
        lease: 'lease-2',
        key: 'b'.repeat(32),
      }),
    ),
    'lease-2 does not wait for approval.',
  );
  assert.equal(
    (await act('compute-lease-dismiss', { lease: 'lease-2' })).status,
    200,
  );
  // Dismiss of the pod actions that failed in the background.
  assert.equal((await act('compute-dismiss', {})).status, 200);
  assert.deepEqual((await compute()).works, []);

  // Without the token, nothing runs. The key and secret actions stay with the desk and the terminal.
  assert.equal(
    (await act('compute-agents', { agents: 2 }, { Authorization: 'Bearer no' }))
      .status,
    401,
  );
  assert.equal((await act('compute-key-save', { key: runpodKey })).status, 404);
  assert.equal(
    (await act('compute-secret-save', { name: 'HF_TOKEN', value: 'x' })).status,
    404,
  );
});
