import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  historyIndex,
  ResearchRunWatch,
  researchRunOnDisk,
} from '../src/core/history.ts';
import type { Lab } from '../src/core/lab.ts';
import type { ResearchRunner } from '../src/legacy/research-runner.ts';
import type { TaskManager } from '../src/legacy/tasks.ts';
import { labWorks, RunTeam, researchRunWorks } from '../src/core/team.ts';
import {
  claudeUpdates,
  requestUpdate,
  TranscriptWriter,
} from '../src/core/transcript.ts';
import type { SessionPool } from '../src/core/workers.ts';
import type {
  HistoryLabRun,
  HistoryList,
  HistoryResearchRun,
  HistoryTask,
  HistoryTurns,
  Snapshot,
} from '../src/protocol/api.ts';
import { ApiReader, type ApiSources } from '../src/server/api.ts';
import { startDesk } from '../src/server/desk.ts';

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 20, 9, minute)).toISOString();

/** An archive ID in the shape that Start over gives it. */
const labArchive = '20261020T100000000Z-abcdef';
const attempt = '1a2b3c4d-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

/** A research plan: a research phase past needs-plan needs one. */
const plan = {
  scope: 'Shortest paths on large graphs.',
  personas: [
    { name: 'Reader', task: 'Read the papers.' },
    { name: 'Coder', task: 'Time the code.' },
  ],
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Inside a Git hook, GIT_* variables point at the Verifold repository. They must not leak into fixtures.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      ),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function workspace(more: Record<string, unknown> = {}): unknown {
  return {
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
    research: {
      topic: 'Does a heap beat a scan?',
      autonomy: 'autonomous',
      phase: 'needs-plan',
    },
    ...more,
  };
}

async function folder(t: test.TestContext): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-history-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** An archived lab run: its workspace, lab, one agent, one run, and a plan post. */
async function archiveLab(root: string): Promise<void> {
  const base = join(root, '.verifold', 'archive', labArchive);
  await json(join(base, 'workspace.json'), workspace());
  await json(join(base, 'lab.json'), {
    schemaVersion: 1,
    question: 'Can probes find the CoT gap?',
    startedAt: at(1),
    handles: { claude: 1, codex: 0 },
    directions: [
      {
        id: 'd-1',
        title: 'The probe gap',
        bar: 'The gap shrinks 30%.',
        runs: 3,
        noise: '±0.02',
        buildsOn: [],
        openedBy: 'a-1',
        openedAt: at(1),
        state: 'closed',
        stoppedAt: null,
        verdict: 'holds-up',
        evidence: { text: 'Gap 34% smaller.', post: 'p-1', run: 'r-1' },
        agent: 'a-1',
        workspace: {
          kind: 'git',
          path: '.verifold/workspaces/d-1',
          branch: 'verifold/d-1',
          start: 'a'.repeat(40),
        },
        head: 'b'.repeat(40),
      },
    ],
    opener: 'a-1',
    plan: {
      post: 'p-1',
      at: at(2),
      reading: 'Read the gap with probes.',
      cost: 'Nothing costs money.',
      directions: ['d-1'],
      facts: [
        {
          claim: 'Qwen3.5 SAEs exist.',
          source: 'huggingface.co/Qwen',
          sourceDate: '2026-04-27',
          checkedAt: at(2),
        },
      ],
    },
  });
  await json(join(base, 'lab', 'agents', 'a-1.json'), {
    id: 'a-1',
    handle: 'claude-1',
    host: 'claude',
  });
  await json(join(base, 'lab', 'runs', 'r-1', 'run.json'), {
    schemaVersion: 1,
    id: 'r-1',
    agent: 'a-1',
    key: 'key-1',
    direction: 'd-1',
    harness: 'claude',
    commit: 'c'.repeat(40),
    command: 'python probe.py --seed 1',
    why: 'Seed 1.',
    status: 'done',
    exitCode: 0,
    queuedAt: at(4),
    startedAt: at(4),
    endedAt: at(9),
    minutes: 60,
    want: [],
    metrics: { gap: 0.34 },
    outputs: [],
    config: 'config',
    output: null,
    log: { bytes: 10, cut: false },
    process: null,
    cancelledBy: null,
    note: null,
    told: true,
    folder: 'run-1-1a2b3c4d',
    where: 'local',
  });
  await json(join(base, 'board', 'p-1.json'), {
    schemaVersion: 1,
    id: 'p-1',
    at: at(2),
    author: 'a-1',
    kind: 'plan',
    text: 'The plan of record.',
    mentions: [],
    artifacts: [],
    direction: 'd-1',
  });
}

/**
 * The current run of a project from the research flow: research with its
 * report and transcript, two directions, the coordinator, a task whose
 * version changed a file in Git, a message, results, and a pod.
 */
async function researchProject(root: string): Promise<void> {
  const state = join(root, '.verifold');
  git(root, 'init', '-q');
  await writeFile(join(root, 'a.txt'), 'one\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-q', '-m', 'one');
  const start = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'a.txt'), 'two\n');
  git(root, 'commit', '-q', '-am', 'two');
  const version = git(root, 'rev-parse', 'HEAD');
  const candidates = [
    {
      id: 'heap',
      title: 'Heap Dijkstra',
      recommendation: 'Use a binary heap.',
      gates: ['It beats the scan above 10,000 nodes.'],
      sources: ['https://example.org/heap'],
      kind: 'main',
    },
    {
      id: 'scan',
      title: 'Linear scan',
      recommendation: 'Keep the scan.',
      gates: ['It holds below 1,000 nodes.'],
      sources: ['https://example.org/scan'],
    },
  ];
  await json(
    join(state, 'workspace.json'),
    workspace({
      candidates,
      selectedId: 'heap',
      context: 'A brief about shortest paths.',
      research: {
        topic: 'Does a heap beat a scan?',
        autonomy: 'autonomous',
        phase: 'directions',
        plan,
        latestAttempt: attempt,
      },
    }),
  );
  await json(join(state, 'runs', attempt, 'attempt.json'), {
    schemaVersion: 1,
    attemptId: attempt,
    host: 'claude',
    model: null,
    phase: 'needs-research',
    status: 'succeeded',
    requestedSessionId: null,
    nativeSessionId: null,
    startedAt: at(1),
    finishedAt: at(3),
  });
  await json(join(state, 'runs', attempt, 'report.json'), {
    summary: 'A heap wins on large graphs.',
    delegation: 'Two helpers read papers.',
    sources: [
      { title: 'Heap paper', url: 'https://example.org/heap' },
      { title: 'Scan paper', url: 'https://example.org/scan' },
    ],
    candidates,
  });
  const writer = await TranscriptWriter.open(
    join(state, 'runs', attempt, 'transcript.jsonl'),
  );
  const apply = writer.run();
  for (const update of [
    requestUpdate('Research the question.'),
    ...claudeUpdates({ type: 'system', subtype: 'init', model: 'claude' }),
    ...claudeUpdates({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'A heap wins.' }] },
    }),
    ...claudeUpdates({ type: 'result', duration_ms: 1000 }),
  ])
    apply(update);
  await writer.flushed();
  await json(join(state, 'coordinator', 'state.json'), {
    schemaVersion: 1,
    objective: 'Show that the heap wins.',
    host: 'claude',
    model: null,
    startedAt: at(4),
    stoppedAt: null,
    session: null,
    created: 1,
    planApproved: true,
    cursor: 0,
    wakeups: [],
    events: [],
    actions: [
      {
        key: 'k1',
        at: at(5),
        tool: 'verifold_task_create',
        input: '{}',
        reason: 'The first task.',
        ok: true,
        result: 'Created task-1.',
      },
    ],
  });
  await json(join(state, 'tasks', 'task-1', 'task.json'), {
    schemaVersion: 1,
    id: 'task-1',
    revision: 1,
    state: 'done',
    createdAt: at(5),
    updatedAt: at(8),
    assignment: {
      revision: 1,
      at: at(5),
      reason: 'The coordinator wrote it.',
      title: 'Time the heap',
      objective: 'Time the heap on 10,000 nodes.',
      inputs: [],
      writable: ['a.txt'],
      output: 'a.txt',
      host: 'claude',
      model: null,
      minutes: 30,
      dependencies: [],
    },
    claim: null,
    attempts: [
      {
        number: 1,
        revision: 1,
        claim: 'c1',
        startedAt: at(6),
        endedAt: at(8),
        workspace: {
          kind: 'git',
          path: '.verifold/workspaces/task-1-heap',
          branch: 'verifold/task-1-heap',
          start,
        },
        session: null,
        restrictions: [],
        outcome: 'accepted',
        note: null,
        versions: [
          {
            number: 1,
            commit: version,
            at: at(7),
            turn: 'completed',
            files: [
              {
                path: 'a.txt',
                change: 'modified',
                regular: true,
                inScope: true,
              },
            ],
            skipped: [],
            reply: 'Timed it: 2x faster.',
            decision: { kind: 'accepted', at: at(8) },
          },
        ],
      },
    ],
  });
  await json(join(state, 'messages', 'm-1.json'), {
    schemaVersion: 1,
    id: 'm-1',
    at: at(8),
    from: 'coordinator',
    to: 'person',
    kind: 'note',
    text: 'The heap is 2x faster.',
    delivery: 'board',
  });
  await json(join(state, 'results.json'), {
    schemaVersion: 1,
    direction: 'heap',
    checks: [
      {
        check: 1,
        result: 'passed',
        value: '2x faster',
        evidence: ['a.txt'],
        reason: 'It beats the scan.',
        at: at(9),
      },
    ],
    answer: null,
  });
  await json(join(state, 'compute', 'leases', 'lease-1.json'), {
    schemaVersion: 1,
    id: 'lease-1',
    state: 'ended',
    requestedBy: 'coordinator',
    reason: 'Time it on a GPU.',
    tasks: ['task-1'],
    gpu: 'NVIDIA L40S',
    image: 'runpod/pytorch',
    diskGb: 0,
    hours: 1,
    rate: 1.09,
    requestedAt: at(6),
    decidedAt: at(6),
    podName: 'verifold-x',
    podId: null,
    deadline: null,
    ssh: null,
    intervals: [{ start: at(6), end: at(36), rate: 1.09 }],
    billedUsd: null,
    billedAt: null,
    seen: null,
    activeAt: null,
    notice: null,
    history: [],
  });
}

function reader(root: string): ApiReader {
  const sources: ApiSources = {
    root,
    lab: undefined,
    compute: undefined,
    session: () => null,
    works: [],
    away: () => Promise.resolve(null),
  };
  return new ApiReader(() => sources);
}

await test('a research-flow run shows on disk, and a lab project with only its question, or a stale research lock, does not', async (t) => {
  const root = await folder(t);
  await json(join(root, '.verifold', 'workspace.json'), workspace());
  // Every lab project keeps its question as research that needs a plan, with no directions.
  assert.equal(await researchRunOnDisk(root), false);
  // A research step's lock stands only while the step runs, so one left behind keeps no project flagged.
  await writeFile(join(root, '.verifold', 'research.lock'), '');
  assert.equal(await researchRunOnDisk(root), false);
  // A lab's own check folders keep their Git folders in tasks/git: no sign either.
  await mkdir(join(root, '.verifold', 'tasks', 'git', 'k-1'), {
    recursive: true,
  });
  assert.equal(await researchRunOnDisk(root), false);
  const signals = [
    join('runs', attempt, 'attempt.json'),
    join('tasks', 'task-1', 'task.json'),
    join('coordinator', 'state.json'),
    join('messages', 'm-1.json'),
    'results-heap.json',
  ];
  for (const path of signals) {
    await json(join(root, '.verifold', path), {});
    assert.equal(await researchRunOnDisk(root), true, path);
    await rm(join(root, '.verifold', path), { recursive: true });
    if (path.includes('/'))
      await rm(join(root, '.verifold', path, '..'), { recursive: true });
    assert.equal(await researchRunOnDisk(root), false, path);
  }
  await json(
    join(root, '.verifold', 'workspace.json'),
    workspace({
      candidates: [],
      selectedId: null,
      research: {
        topic: 'Q',
        autonomy: 'autonomous',
        phase: 'directions',
        plan,
      },
    }),
  );
  assert.equal(await researchRunOnDisk(root), true);
  // A lab owns the run, whatever else the folder holds.
  await json(join(root, '.verifold', 'lab.json'), {
    schemaVersion: 1,
    question: 'Q',
    startedAt: at(1),
    directions: [],
  });
  assert.equal(await researchRunOnDisk(root), false);
});

await test('a lab does not start on top of a research-flow run, and says where to start one', async (t) => {
  const root = await folder(t);
  await researchProject(root);
  const team = new RunTeam({
    lab: () => false,
    coordinator: () => Promise.resolve(false),
    researchBusy: () => false,
    root,
  });
  assert.equal(await team.refusal('lab'), researchRunWorks);
  assert.match(researchRunWorks, /History in the app.*Start a lab/);
  // While research runs, the person waits for its step first: Start a lab would wait for it too.
  const busy = new RunTeam({
    lab: () => false,
    coordinator: () => Promise.resolve(true),
    researchBusy: () => true,
    root,
  });
  assert.match((await busy.refusal('lab')) ?? '', /^Research is running/);
  // Research and the coordinator do not work with a lab, and the refusal says where they still do.
  const withLab = new RunTeam({
    lab: () => true,
    coordinator: () => Promise.resolve(false),
    researchBusy: () => false,
  });
  assert.equal(await withLab.refusal('research'), labWorks);
  assert.match(labWorks, /not available.*old desk's Records/);
  await rm(join(root, '.verifold'), { recursive: true, force: true });
  await json(join(root, '.verifold', 'workspace.json'), workspace());
  assert.equal(await team.refusal('lab'), null);
});

await test('History lists the current research-flow run and the archived runs, with their kind and question', async (t) => {
  const root = await folder(t);
  await researchProject(root);
  await archiveLab(root);
  const index = await historyIndex(root);
  assert.equal(index.current?.id, 'current');
  assert.equal(index.current?.kind, 'research');
  assert.equal(index.current?.question, 'Does a heap beat a scan?');
  assert.equal(index.current?.direction, 'Heap Dijkstra');
  assert.equal(index.current?.tasks, 1);
  assert.deepEqual(
    index.runs.map((run) => [run.id, run.kind, run.question]),
    [[labArchive, 'lab', 'Does a heap beat a scan?']],
  );
  assert.equal(index.more, false);
  // Only the list sizes the runs. The current run has no size.
  assert.ok((index.runs[0]?.bytes ?? 0) > 0);
  assert.equal(index.current?.bytes, null);
  await mkdir(join(root, 'memory'));
  await writeFile(join(root, 'memory', 'README.md'), '# Project memory\n');
  await writeFile(join(root, 'memory', 'findings.md'), 'The heap wins.\n');
  // A long memory file shows its start, cut between characters.
  await writeFile(join(root, 'memory', 'notes.md'), 'é'.repeat(40_000));
  await writeFile(join(root, 'memory', 'tool.md'), 'a\0b');
  const list = (await reader(root).history()) as HistoryList;
  assert.deepEqual(
    list.memory.map((file) => [file.name, file.text.trimmed]),
    [
      ['README.md', false],
      ['findings.md', false],
      ['notes.md', true],
    ],
  );
  const notes = list.memory[2]?.text.text ?? '';
  assert.ok(notes.length > 30_000 && Buffer.byteLength(notes) <= 64 * 1024);
  assert.doesNotMatch(notes, /\uFFFD/);
});

await test("a lab's archived run reads its plan, directions, runs, and posts, with handles", async (t) => {
  const root = await folder(t);
  await json(join(root, '.verifold', 'workspace.json'), workspace());
  await archiveLab(root);
  const run = (await reader(root).historyRun(labArchive)) as HistoryLabRun;
  assert.equal(run.kind, 'lab');
  assert.equal(run.readable, true);
  // A run's own read does not size it.
  assert.equal(run.entry.bytes, null);
  assert.equal(run.question, 'Can probes find the CoT gap?');
  assert.equal(run.plan?.reading.text, 'Read the gap with probes.');
  assert.equal(run.plan?.facts[0]?.source, 'huggingface.co/Qwen');
  assert.deepEqual(
    run.directions.map((entry) => [
      entry.id,
      entry.verdict,
      entry.handle,
      entry.evidence,
    ]),
    [['d-1', 'holds-up', 'claude-1', 'Gap 34% smaller.']],
  );
  assert.deepEqual(
    run.runs.map((entry) => [entry.id, entry.status, entry.metrics.gap]),
    [['r-1', 'done', 0.34]],
  );
  assert.deepEqual(
    run.posts.map((post) => [post.id, post.handle, post.kind]),
    [['p-1', 'claude-1', 'plan']],
  );
  assert.equal(run.olderPosts, 0);
  // Nothing that the run records outside its shapes reaches the page.
  assert.doesNotMatch(JSON.stringify(run), /key-1|"config"/);
  assert.equal(
    await reader(root).historyRun('20261020T100000000Z-000000'),
    null,
  );
  assert.equal(await reader(root).historyRun('current'), null);
});

await test('a research-flow run reads its research, directions, coordinator, tasks, messages, results, and pods', async (t) => {
  const root = await folder(t);
  await researchProject(root);
  const api = reader(root);
  const run = (await api.historyRun('current')) as HistoryResearchRun;
  assert.equal(run.kind, 'research');
  assert.equal(run.question, 'Does a heap beat a scan?');
  assert.equal(run.brief?.text, 'A brief about shortest paths.');
  assert.equal(run.attempts[0]?.summary?.text, 'A heap wins on large graphs.');
  assert.deepEqual(
    run.attempts[0]?.sources.map((source) => source.title),
    ['Heap paper', 'Scan paper'],
  );
  assert.equal(run.attempts[0]?.transcript, true);
  assert.deepEqual(
    run.candidates.map((entry) => [entry.id, entry.kind]),
    [
      ['heap', 'main'],
      ['scan', null],
    ],
  );
  assert.equal(run.chosen, 'heap');
  assert.equal(run.coordinator?.objective.text, 'Show that the heap wins.');
  assert.deepEqual(
    run.coordinator?.actions.map((action) => action?.tool),
    ['verifold_task_create'],
  );
  assert.deepEqual(run.tasks, [
    {
      id: 'task-1',
      record: 'read',
      title: 'Time the heap',
      state: 'done',
      harness: 'claude',
      model: null,
      attempts: 1,
      versions: 1,
      outcome: 'accepted',
    },
  ]);
  assert.deepEqual(
    run.messages.map((message) => [message.id, message.text.text]),
    [['m-1', 'The heap is 2x faster.']],
  );
  assert.equal(run.results[0]?.checks[0]?.result, 'passed');
  assert.deepEqual(
    run.pods.map((pod) => [pod.lease, pod.costUsd]),
    [['lease-1', 0.55]],
  );
  // The task in full, its version's diff from Git, and the research transcript as folded turns.
  const task = (await api.historyTask('current', 'task-1')) as HistoryTask;
  assert.equal(task.objective.text, 'Time the heap on 10,000 nodes.');
  assert.deepEqual(
    task.attempts[0]?.versions[0]?.files.map((file) => file.path),
    ['a.txt'],
  );
  assert.equal(task.attempts[0]?.versions[0]?.decision?.by, 'person');
  const diff = await api.historyDiff('current', 'task-1', 1, 'a.txt');
  assert.match(diff?.text ?? '', /-one\n\+two/);
  assert.equal(await api.historyDiff('current', 'task-1', 1, 'b.txt'), null);
  assert.equal(await api.historyDiff('current', 'task-1', 2, 'a.txt'), null);
  const turns = (await api.historyTurns(
    'current',
    `attempt:${attempt}`,
  )) as HistoryTurns;
  assert.equal(turns.turns.length, 1);
  assert.equal(turns.turns[0]?.message?.text, 'A heap wins.');
  assert.equal(await api.historyTurns('current', 'attempt:../x'), null);
  assert.equal(await api.historyTurns('current', 'session:nope'), null);
});

/** Desk assets that the server reads at its start. Tests use placeholders. */
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

await test('History reads need the token and a run of this project, and Start over from the app archives the run and starts no research', async (t) => {
  const root = await folder(t);
  await researchProject(root);
  let researchStarts = 0;
  const research = {
    busy: false,
    clear: () => {},
    start: () => {
      researchStarts++;
      return Promise.resolve();
    },
  } as unknown as ResearchRunner;
  const tasks = {
    list: () => Promise.resolve([]),
    cancel: () => Promise.resolve(),
  } as unknown as TaskManager;
  const sessions = {
    view: () => null,
    views: () => [],
    forget: () => Promise.resolve(),
  } as unknown as SessionPool;
  const owner = new AbortController();
  const desk = await startDesk(
    root,
    owner.signal,
    await deskAssets(root),
    sessions,
    research,
    undefined,
    tasks,
    undefined,
    undefined,
    undefined,
    { api: { pollMs: 40, heartbeatMs: 100 } },
  );
  t.after(async () => {
    owner.abort();
    await desk.closed;
  });
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  assert.equal((await fetch(`${api}/history`)).status, 401);
  assert.equal((await fetch(`${api}/history`, { headers })).status, 200);
  assert.equal(
    (await fetch(`${api}/history/not-a-run`, { headers })).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${api}/history/current/tasks/task-1/diff?version=1`, {
        headers,
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${api}/history/20261020T100000000Z-000000`, { headers }))
      .status,
    404,
  );
  const shot = (await (
    await fetch(`${api}/snapshot`, { headers })
  ).json()) as Snapshot;
  assert.equal(shot.researchRun, true);
  // Start over, with the key of the person's intent, twice: the second gets the first answer.
  const startOver = (): Promise<Response> =>
    fetch(`${api}/actions/start-over`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lab: true, key: 'a'.repeat(32) }),
    });
  assert.equal((await startOver()).status, 200);
  assert.equal((await startOver()).status, 200);
  const archives = await readdir(join(root, '.verifold', 'archive'));
  assert.equal(archives.length, 1);
  assert.equal(researchStarts, 0);
  assert.equal(await researchRunOnDisk(root), false);
  // The snapshot sees the change: the project opens on its question again.
  const after = (await (
    await fetch(`${api}/snapshot`, { headers })
  ).json()) as Snapshot;
  assert.equal(after.researchRun, false);
  const list = (await (
    await fetch(`${api}/history`, { headers })
  ).json()) as HistoryList;
  assert.equal(list.current, null);
  assert.deepEqual(
    list.runs.map((run) => [run.kind, run.question]),
    [['research', 'Does a heap beat a scan?']],
  );
  // The archived run still reads, with its task and the task's diff.
  const id = archives[0] ?? '';
  const run = (await (
    await fetch(`${api}/history/${id}`, { headers })
  ).json()) as HistoryResearchRun;
  assert.equal(run.tasks[0]?.id, 'task-1');
  const diff = (await (
    await fetch(`${api}/history/${id}/tasks/task-1/diff?version=1&file=a.txt`, {
      headers,
    })
  ).json()) as { text: string };
  assert.match(diff.text, /\+two/);
});

await test('the research-flow flag is read again only after the records that it reads change', async (t) => {
  const root = await folder(t);
  await json(join(root, '.verifold', 'workspace.json'), workspace());
  let reads = 0;
  const watch = new ResearchRunWatch((path) => {
    reads++;
    return researchRunOnDisk(path);
  });
  assert.equal(await watch.read(root), false);
  assert.equal(await watch.read(root), false);
  assert.equal(reads, 1);
  await json(join(root, '.verifold', 'messages', 'm-1.json'), {});
  assert.equal(await watch.read(root), true);
  assert.equal(await watch.read(root), true);
  assert.equal(reads, 2);
  await rm(join(root, '.verifold', 'messages', 'm-1.json'));
  assert.equal(await watch.read(root), false);
  assert.equal(reads, 3);
});

/** A valid research attempt record. */
function attemptRecord(id: string, minute: number): unknown {
  return {
    schemaVersion: 1,
    attemptId: id,
    host: 'claude',
    model: null,
    phase: 'needs-research',
    status: 'succeeded',
    requestedSessionId: null,
    nativeSessionId: null,
    startedAt: at(minute),
    finishedAt: at(minute + 1),
  };
}

await test('a run reads only its newest research attempts, by the times of their folders', async (t) => {
  const root = await folder(t);
  await researchProject(root);
  const runs = join(root, '.verifold', 'runs');
  const ids: string[] = [];
  for (let index = 0; index < 22; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    ids.push(id);
    await json(join(runs, id, 'attempt.json'), attemptRecord(id, 10 + index));
    const when = new Date(Date.UTC(2020, 0, 1, 0, index));
    await utimes(join(runs, id), when, when);
  }
  const run = (await reader(root).historyRun('current')) as HistoryResearchRun;
  assert.equal(run.attempts.length, 20);
  assert.equal(run.moreAttempts, 3);
  // The three oldest folders are left out, and the newest step shows first.
  const shown = new Set(run.attempts.map((entry) => entry.id));
  assert.deepEqual(
    ids.filter((id) => !shown.has(id)),
    ids.slice(0, 3),
  );
  assert.equal(run.attempts[0]?.id, ids[21]);
});

await test('a research-flow run with broken records still reads: each bad entry shows as unreadable, and nothing throws', async (t) => {
  const root = await folder(t);
  await researchProject(root);
  const state = join(root, '.verifold');
  const results = {
    schemaVersion: 1,
    direction: 'heap',
    checks: [
      // A value, a reason, and a whole check of the wrong types.
      { check: 1, result: 'passed', value: 7, evidence: [], reason: 'Ok.' },
      { check: 2, result: 'passed', value: 'fast', reason: { not: 'text' } },
      'not a check',
      // A ruling whose reason is not text.
      {
        check: 4,
        result: 'judgement',
        value: 'close',
        evidence: [],
        reason: 'Close.',
        at: at(9),
        ruling: { result: 'passed', reason: 5, at: at(9) },
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        check: index + 5,
        result: 'passed',
        value: 'v',
        evidence: [],
        reason: 'r',
        at: at(9),
      })),
    ],
    answer: {
      statement: 42,
      claims: [
        { text: 9, evidence: [] },
        {
          text: 'A heap wins.',
          evidence: ['a.txt', 3, ...Array.from({ length: 24 }, () => 'b.txt')],
        },
      ],
      at: at(9),
      decision: { kind: 'accepted', at: at(9), note: { x: 1 } },
    },
  };
  await json(join(state, 'results.json'), results);
  // An answer that is not an object.
  await json(join(state, 'results-scan.json'), {
    schemaVersion: 1,
    direction: 'scan',
    checks: [],
    answer: 'yes',
  });
  await writeFile(join(state, 'results-x.json'), '{ not json');
  await json(join(state, 'coordinator', 'state.json'), {
    schemaVersion: 1,
    objective: 'Show that the heap wins.',
    host: 'claude',
    model: 5,
    startedAt: 7,
    stoppedAt: null,
    session: '../x',
    created: 1,
    planApproved: true,
    cursor: 0,
    wakeups: [],
    events: [],
    actions: [
      {
        key: 'k1',
        at: at(5),
        tool: 'verifold_task_create',
        reason: { bad: true },
        ok: true,
        result: 'Created task-1.',
      },
      { key: 'k2', at: at(5), tool: 'x', ok: true, result: 12 },
      { key: 'k3', tool: 'x', ok: true, result: 'r' },
      null,
    ],
  });
  // A message whose status is not text, and one that does not read: only the ones that read count.
  await json(join(state, 'messages', 'm-2.json'), {
    schemaVersion: 1,
    id: 'm-2',
    at: at(8),
    from: 'person',
    to: 'coordinator',
    kind: 'note',
    text: 'Go on.',
    delivery: 'sent',
    status: { open: true },
  });
  await writeFile(join(state, 'messages', 'm-3.json'), '{ not json');
  // A task whose attempt and version hold fields of the wrong types.
  const task = {
    schemaVersion: 1,
    id: 'task-2',
    revision: 1,
    state: 'done',
    createdAt: 5,
    updatedAt: at(8),
    assignment: {
      revision: 1,
      at: at(5),
      reason: 'R.',
      title: 'Time the scan',
      objective: 'Time the scan.',
      inputs: [],
      writable: ['a.txt'],
      output: 'a.txt',
      host: 'codex',
      model: null,
      minutes: 30,
      dependencies: [],
    },
    claim: null,
    attempts: [
      {
        number: 1,
        revision: 1,
        claim: 'c1',
        startedAt: 6,
        endedAt: { x: 1 },
        workspace: null,
        session: '../x',
        restrictions: [],
        outcome: { x: 1 },
        note: 3,
        versions: [
          {
            number: 1,
            commit: 'a'.repeat(40),
            at: 5,
            turn: 9,
            files: [{ path: 'a.txt', change: 7, inScope: 'yes' }],
            skipped: [],
            reply: 4,
            decision: { kind: 'accepted', at: at(8), note: 5 },
          },
        ],
      },
    ],
  };
  await json(join(state, 'tasks', 'task-2', 'task.json'), task);
  // A task too long for a summary: its newest assignment names it. And a task whose record does not read.
  await json(join(state, 'tasks', 'task-3', 'task.json'), {
    ...task,
    id: 'task-3',
    assignment: { ...task.assignment, objective: 'x'.repeat(300_000) },
    attempts: [],
  });
  await json(join(state, 'tasks', 'task-3', 'r2', 'assignment.json'), {
    ...task.assignment,
    revision: 2,
    title: 'Time it again',
  });
  await mkdir(join(state, 'tasks', 'task-4'));
  await writeFile(join(state, 'tasks', 'task-4', 'task.json'), '[');
  // A lease without its intervals, and one whose tasks are not a list.
  const lease = {
    schemaVersion: 1,
    id: 'lease-2',
    state: 'ended',
    tasks: ['task-2'],
    gpu: 'NVIDIA A40',
    requestedAt: at(7),
    intervals: 'none',
  };
  await json(join(state, 'compute', 'leases', 'lease-2.json'), lease);
  await json(join(state, 'compute', 'leases', 'lease-3.json'), {
    ...lease,
    id: 'lease-3',
    tasks: 'task-2',
  });
  // A research step whose record does not read.
  const broken = '00000000-0000-4000-8000-000000000001';
  await json(join(state, 'runs', broken, 'attempt.json'), { status: 5 });
  // The coordinator's own session shows with the coordinator, not under the person's sessions.
  const session = (id: string, mode: string): unknown => ({
    schemaVersion: 2,
    id,
    host: 'claude',
    model: null,
    mode,
    status: 'ended',
    startedAt: at(4),
  });
  await json(
    join(state, 'sessions', '20261020T090400000Z-aaaaaaaa.json'),
    session('20261020T090400000Z-aaaaaaaa', 'coordinator'),
  );
  await json(
    join(state, 'sessions', '20261020T090500000Z-bbbbbbbb.json'),
    session('20261020T090500000Z-bbbbbbbb', 'ask'),
  );

  const api = reader(root);
  const run = (await api.historyRun('current')) as HistoryResearchRun;
  // Results: bad checks and claims are null, a bad ruling or note is left out, and long lists say how many more.
  // The file that does not read is left out.
  assert.deepEqual(
    run.results.map((entry) => entry.direction),
    ['scan', 'heap'],
  );
  const heap = run.results[1];
  assert.deepEqual(heap?.checks.slice(0, 3), [null, null, null]);
  assert.equal(heap?.checks[3]?.ruling, null);
  assert.equal(heap?.checks[3]?.reason.text, 'Close.');
  assert.equal(heap?.checks.length, 50);
  assert.equal(heap?.moreChecks, 14);
  assert.equal(heap?.answer?.statement, null);
  assert.equal(heap?.answer?.claims[0], null);
  assert.equal(heap?.answer?.claims[1]?.evidence.length, 20);
  assert.equal(heap?.answer?.claims[1]?.moreEvidence, 5);
  assert.deepEqual(heap?.answer?.decision, { kind: 'accepted', note: null });
  assert.deepEqual(run.results[0]?.answer, {
    statement: null,
    claims: [],
    moreClaims: 0,
    decision: null,
  });
  // The coordinator: bad fields read as null, and bad actions as null entries.
  assert.equal(run.coordinator?.model, null);
  assert.equal(run.coordinator?.startedAt, null);
  assert.equal(run.coordinator?.session, null);
  assert.equal(run.coordinator?.actions[0]?.reason, null);
  assert.deepEqual(run.coordinator?.actions.slice(1), [null, null, null]);
  // Messages: a bad status is none, and a file that does not read is not counted.
  assert.deepEqual(
    run.messages.map((message) => [message.id, message.status]),
    [
      ['m-1', null],
      ['m-2', null],
    ],
  );
  assert.equal(run.olderMessages, 0);
  // Tasks: a bad outcome is none, a long record shows its newest assignment, and an unreadable one says so.
  assert.deepEqual(
    run.tasks.map((entry) => [entry.id, entry.record, entry.title]),
    [
      ['task-1', 'read', 'Time the heap'],
      ['task-2', 'read', 'Time the scan'],
      ['task-3', 'large', 'Time it again'],
      ['task-4', 'unreadable', null],
    ],
  );
  assert.equal(run.tasks[1]?.outcome, null);
  // Pods: a lease without intervals has no cost, and a lease that does not read is left out.
  assert.deepEqual(
    run.pods.map((pod) => [pod.lease, pod.costUsd]),
    [
      ['lease-1', 0.55],
      ['lease-2', null],
    ],
  );
  // Research: a step whose record does not read shows without its details.
  const unread = run.attempts.find((entry) => entry.id === broken);
  assert.equal(unread?.status, null);
  // Sessions: only the person's.
  assert.deepEqual(
    run.sessions.map((entry) => [entry.id, entry.mode]),
    [['20261020T090500000Z-bbbbbbbb', 'ask']],
  );
  // The task in full: each bad field reads as null.
  const full = (await api.historyTask('current', 'task-2')) as HistoryTask;
  assert.deepEqual(full.attempts[0], {
    number: 1,
    startedAt: null,
    endedAt: null,
    outcome: null,
    note: null,
    session: null,
    versions: [
      {
        number: 1,
        at: null,
        turn: null,
        files: [{ path: 'a.txt', change: null, inScope: false }],
        moreFiles: 0,
        reply: null,
        decision: { kind: 'accepted', note: null, by: 'person' },
      },
    ],
    olderVersions: 0,
  });
  // A long task reads in full when it opens. One that does not read is not there.
  assert.equal(
    ((await api.historyTask('current', 'task-3')) as HistoryTask).title,
    'Time the scan',
  );
  assert.equal(await api.historyTask('current', 'task-4'), null);
});

await test("a lab's archive whose record does not read is still a lab's run, and History follows no link out of a run", async (t) => {
  const root = await folder(t);
  await json(join(root, '.verifold', 'workspace.json'), workspace());
  await archiveLab(root);
  const base = join(root, '.verifold', 'archive', labArchive);
  await writeFile(join(base, 'lab.json'), '{ broken');
  // The board is a link to posts outside the archive.
  const outside = join(root, 'outside');
  await json(join(outside, 'board', 'p-1.json'), {
    schemaVersion: 1,
    id: 'p-1',
    at: at(2),
    author: 'person',
    kind: 'status',
    text: 'Outside the archive.',
    mentions: [],
    artifacts: [],
  });
  await rm(join(base, 'board'), { recursive: true });
  await symlink(join(outside, 'board'), join(base, 'board'));
  // One run lives behind a link as well.
  await json(join(outside, 'r-2', 'run.json'), { id: 'r-2' });
  await symlink(join(outside, 'r-2'), join(base, 'lab', 'runs', 'r-2'));
  const index = await historyIndex(root);
  assert.equal(index.runs[0]?.kind, 'lab');
  const run = (await reader(root).historyRun(labArchive)) as HistoryLabRun;
  assert.equal(run.kind, 'lab');
  assert.equal(run.readable, false);
  assert.equal(run.question, null);
  assert.equal(run.plan, null);
  assert.deepEqual(run.directions, []);
  assert.deepEqual(run.posts, []);
  assert.deepEqual(
    run.runs.map((entry) => entry.id),
    ['r-1'],
  );
  assert.doesNotMatch(JSON.stringify(run), /Outside the archive/);
  // A task folder of the current run that is a link reads as unreadable, and opens as nothing.
  await researchProject(root);
  await json(join(outside, 'task-9', 'task.json'), { id: 'task-9' });
  await symlink(
    join(outside, 'task-9'),
    join(root, '.verifold', 'tasks', 'task-9'),
  );
  const current = (await reader(root).historyRun(
    'current',
  )) as HistoryResearchRun;
  assert.deepEqual(current.tasks.at(-1), {
    id: 'task-9',
    record: 'unreadable',
    title: null,
    state: null,
    harness: null,
    model: null,
    attempts: null,
    versions: null,
    outcome: null,
  });
  assert.equal(await reader(root).historyTask('current', 'task-9'), null);
});

await test('Start a lab moves only a run of the research flow, and its key is its own', async (t) => {
  const root = await folder(t);
  await researchProject(root);
  let posts = 0;
  const lab = {
    runs: true,
    exists: false,
    view: () => null,
    post: () => {
      posts++;
      return Promise.resolve();
    },
    suspend: () => Promise.resolve(false),
    reload: () => Promise.resolve(),
    resume: () => Promise.resolve(),
  };
  const research = {
    busy: false,
    clear: () => {},
    start: () => Promise.resolve(),
  } as unknown as ResearchRunner;
  const tasks = {
    list: () => Promise.resolve([]),
    cancel: () => Promise.resolve(),
  } as unknown as TaskManager;
  const sessions = {
    view: () => null,
    views: () => [],
    forget: () => Promise.resolve(),
  } as unknown as SessionPool;
  const owner = new AbortController();
  const desk = await startDesk(
    root,
    owner.signal,
    await deskAssets(root),
    sessions,
    research,
    undefined,
    tasks,
    undefined,
    undefined,
    undefined,
    { lab: lab as unknown as Lab, api: { pollMs: 40, heartbeatMs: 100 } },
  );
  t.after(async () => {
    owner.abort();
    await desk.closed;
  });
  const url = new URL(desk.url);
  const api = `${url.origin}/api/v1`;
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    'Content-Type': 'application/json',
  };
  const act = (name: string, body: unknown): Promise<Response> =>
    fetch(`${api}/actions/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const archived = async (): Promise<number> =>
    (await readdir(join(root, '.verifold', 'archive')).catch(() => [])).length;
  // A lab action and Start a lab with the same key: each one runs.
  const key = 'b'.repeat(32);
  assert.equal((await act('lab-post', { text: 'Hello.', key })).status, 200);
  assert.equal(posts, 1);
  assert.equal(
    (await act('start-over', { lab: true, expect: 'research', key })).status,
    200,
  );
  assert.equal(await archived(), 1);
  // A lab started since the page read History: Start a lab refuses, and moves nothing.
  await json(join(root, '.verifold', 'lab.json'), {
    schemaVersion: 1,
    question: 'Q',
    startedAt: at(1),
    directions: [],
  });
  lab.exists = true;
  const refused = await act('start-over', {
    lab: true,
    expect: 'research',
    key: 'c'.repeat(32),
  });
  assert.equal(refused.status, 409);
  assert.match(
    JSON.stringify(await refused.json()),
    /This project's run is a lab now\. Reload History\./,
  );
  assert.equal(await archived(), 1);
  // The lab's own Start over, from the answer page, sends no expectation and still works.
  assert.equal(
    (await act('start-over', { lab: true, key: 'd'.repeat(32) })).status,
    200,
  );
  assert.equal(await archived(), 2);
});
