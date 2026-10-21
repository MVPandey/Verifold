import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { historyIndex, researchRunOnDisk } from '../src/core/history.ts';
import type { ResearchRunner } from '../src/legacy/research-runner.ts';
import type { TaskManager } from '../src/legacy/tasks.ts';
import { RunTeam, researchRunWorks } from '../src/core/team.ts';
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

await test('a research-flow run shows on disk, and a lab project with only its question does not', async (t) => {
  const root = await folder(t);
  await json(join(root, '.verifold', 'workspace.json'), workspace());
  // Every lab project keeps its question as research that needs a plan, with no directions.
  assert.equal(await researchRunOnDisk(root), false);
  const signals: [string, unknown][] = [
    [join('runs', attempt, 'attempt.json'), {}],
    [join('tasks', 'task-1', 'task.json'), {}],
    [join('coordinator', 'state.json'), {}],
    [join('messages', 'm-1.json'), {}],
    ['results-heap.json', {}],
    ['research.lock', {}],
  ];
  for (const [path, value] of signals) {
    await json(join(root, '.verifold', path), value);
    assert.equal(await researchRunOnDisk(root), true, path);
    await rm(join(root, '.verifold', path));
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
  await mkdir(join(root, 'memory'));
  await writeFile(join(root, 'memory', 'README.md'), '# Project memory\n');
  await writeFile(join(root, 'memory', 'findings.md'), 'The heap wins.\n');
  const list = (await reader(root).history()) as HistoryList;
  assert.deepEqual(
    list.memory.map((file) => file.name),
    ['README.md', 'findings.md'],
  );
});

await test("a lab's archived run reads its plan, directions, runs, and posts, with handles", async (t) => {
  const root = await folder(t);
  await json(join(root, '.verifold', 'workspace.json'), workspace());
  await archiveLab(root);
  const run = (await reader(root).historyRun(labArchive)) as HistoryLabRun;
  assert.equal(run.kind, 'lab');
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
    run.coordinator?.actions.map((action) => action.tool),
    ['verifold_task_create'],
  );
  assert.deepEqual(run.tasks, [
    {
      id: 'task-1',
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
