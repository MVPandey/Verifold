import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  TaskManager,
  type TaskRecord,
  type TaskSessions,
} from '../src/cli/tasks.ts';
import { SessionPool } from '../src/cli/workers.ts';
import { startDesk } from '../src/cli/desk.ts';
import { changeWorkspace } from '../src/cli/storage.ts';

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
  });
}

async function write(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
}

/** A Git project with one commit, uncommitted work, and Verifold state. */
async function project(
  t: test.TestContext,
  gitProject = true,
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-tasks-')));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  await write(root, 'src/bench.py', 'print("bench")\n');
  await write(root, 'results/old.md', 'old\n');
  if (gitProject) {
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
  }
  await write(root, 'notes.md', 'uncommitted notes\n');
  return root;
}

/** A session owner that runs no harness. The test plays the agent. */
class FakeSessions implements TaskSessions {
  full = false;
  blockedReason: string | null = null;
  /** Sessions that wait for a follow-up. */
  waiting = new Set<string>();
  started: {
    cwd: string;
    prompt: string;
    task: { id: string; claim: string };
  }[] = [];
  sent: string[] = [];
  ended = 0;
  cancelled = 0;
  failStart = false;

  startTask(input: {
    cwd: string;
    prompt: string;
    task: { id: string; claim: string };
  }): Promise<string> {
    if (this.failStart)
      return Promise.reject(new Error('claude is not installed'));
    this.started.push(input);
    return Promise.resolve(`S${this.started.length}`);
  }
  idle(session: string): boolean {
    return this.waiting.has(session);
  }
  continueTask(session: string, text: string): void {
    this.sent.push(text);
    this.waiting.delete(session);
  }
  cancel(): void {
    this.cancelled++;
  }
  endTask(session: string): void {
    this.ended++;
    this.waiting.delete(session);
  }
}

/** Play one agent turn in the task folder, then end the turn. */
async function turn(
  tasks: TaskManager,
  sessions: FakeSessions,
  files: Record<string, string>,
): Promise<void> {
  const started = sessions.started.at(-1);
  assert.ok(started);
  for (const [path, text] of Object.entries(files))
    await write(started.cwd, path, text);
  sessions.waiting.add(`S${sessions.started.length}`);
  await tasks.turnEnded(started.task, 'completed');
}

const fields = {
  title: 'Reproduce the baseline',
  objective: 'Time the 4x4 kernel and write the result.',
  inputs: 'src/bench.py',
  writable: 'results',
  output: 'results/baseline.md with the median time',
  host: 'claude',
  model: 'sonnet',
  minutes: '20',
};

await test('task fields are checked, and inputs are copied with their hash', async (t) => {
  const root = await project(t);
  const tasks = new TaskManager(root, {
    ownerId: 'owner-1',
    sessions: new FakeSessions(),
  });
  for (const [change, error] of [
    [{ title: ' ' }, /title/],
    [{ writable: '' }, /at least one path/],
    [{ writable: '../outside' }, /inside the project/],
    [{ writable: '.verifold/state' }, /Git or Verifold data/],
    [{ inputs: 'missing.txt' }, /not a regular file/],
    [{ host: 'gemini' }, /Claude Code or Codex/],
    [{ minutes: '0' }, /1 to 240 minutes/],
    [{ dependencies: ['task-9'] }, /does not exist/],
  ] as const)
    await assert.rejects(tasks.create({ ...fields, ...change }), error);
  // A failed create leaves no folder behind, so numbers start at task-1.
  const id = await tasks.create(fields);
  assert.equal(id, 'task-1');
  const task = await tasks.get(id);
  assert.equal(task?.state, 'open');
  assert.deepEqual(task?.assignment.writable, ['results']);
  assert.equal(task?.assignment.inputs[0]?.path, 'src/bench.py');
  assert.match(task?.assignment.inputs[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(
    await readFile(
      join(root, '.verifold/tasks/task-1/r1/inputs/src/bench.py'),
      'utf8',
    ),
    'print("bench")\n',
  );
  // A dependency cycle fails on edit.
  const second = await tasks.create({
    ...fields,
    title: 'Second',
    dependencies: ['task-1'],
  });
  await assert.rejects(
    tasks.edit(id, {
      ...fields,
      dependencies: [second],
      reason: 'Wait for the second',
    }),
    /cycle/,
  );
  await tasks.edit(id, {
    ...fields,
    objective: 'A sharper objective.',
    reason: 'Clearer goal',
  });
  assert.equal((await tasks.get(id))?.revision, 2);
  // Revision 1 stays as it was.
  assert.match(
    await readFile(
      join(root, '.verifold/tasks/task-1/r1/assignment.json'),
      'utf8',
    ),
    /Time the 4x4 kernel/,
  );
});

await test('a task runs in its own workspace, versions each turn, and accepts selected files', async (t) => {
  const root = await project(t);
  const sessions = new FakeSessions();
  const lines: string[] = [];
  const tasks = new TaskManager(root, {
    ownerId: 'owner-1',
    sessions,
    progress: (line) => lines.push(line),
  });
  const id = await tasks.create(fields);
  sessions.full = true;
  await assert.rejects(tasks.start(id), /Every worker is busy/);
  sessions.full = false;
  await tasks.start(id);
  let task = (await tasks.get(id)) as TaskRecord;
  assert.equal(task.state, 'running');
  const attempt = task.attempts[0];
  assert.equal(attempt?.workspace?.kind, 'git');
  assert.ok(attempt?.restrictions.some((entry) => entry.includes('sandbox')));
  const started = sessions.started[0];
  assert.match(started?.prompt ?? '', /Writable paths:\n- results/);
  assert.match(started?.prompt ?? '', /Do not commit/);
  assert.equal(started?.cwd, join(root, attempt?.workspace?.path ?? ''));
  assert.equal(
    await readFile(join(started?.cwd ?? '', 'src/bench.py'), 'utf8'),
    'print("bench")\n',
  );

  // Version 1 has a file outside the writable paths. Ask for changes.
  await turn(tasks, sessions, {
    'results/baseline.md': '# Baseline\n\n1.9 ms\n',
    'src/bench.py': 'print("changed")\n',
  });
  task = (await tasks.get(id)) as TaskRecord;
  assert.equal(task.state, 'review');
  const first = task.attempts[0]?.versions[0];
  assert.deepEqual(
    first?.files.map((file) => [file.path, file.inScope]),
    [
      ['results/baseline.md', true],
      ['src/bench.py', false],
    ],
  );
  assert.ok(lines.some((line) => line.includes('version 1 is ready')));
  await assert.rejects(
    tasks.accept(id, 1, ['src/bench.py']),
    /inside the writable paths/,
  );
  await tasks.askForChanges(id, 'Report the median of 5 runs.');
  assert.match(sessions.sent[0] ?? '', /median of 5 runs/);
  assert.equal((await tasks.get(id))?.state, 'running');

  // Version 2 is accepted. Unrelated work in the project stays.
  await turn(tasks, sessions, {
    'results/baseline.md': '# Baseline\n\nMedian of 5: 1.82 ms\n',
  });
  await assert.rejects(
    tasks.accept(id, 1, ['results/baseline.md']),
    /latest version/,
  );
  const result = await tasks.accept(id, 2, ['results/baseline.md']);
  assert.deepEqual(result, { applied: ['results/baseline.md'] });
  task = (await tasks.get(id)) as TaskRecord;
  assert.equal(task.state, 'done');
  assert.equal(task.claim, null);
  assert.equal(task.attempts[0]?.outcome, 'accepted');
  assert.equal(task.attempts[0]?.versions[0]?.decision?.kind, 'changes');
  assert.deepEqual(task.attempts[0]?.versions[1]?.decision?.files, [
    'results/baseline.md',
  ]);
  assert.equal(sessions.ended, 1);
  assert.equal(existsSync(started?.cwd ?? ''), false);
  assert.match(
    await readFile(join(root, 'results/baseline.md'), 'utf8'),
    /1\.82 ms/,
  );
  assert.equal(
    await readFile(join(root, 'src/bench.py'), 'utf8'),
    'print("bench")\n',
  );
  assert.equal(
    await readFile(join(root, 'notes.md'), 'utf8'),
    'uncommitted notes\n',
  );
  // The branch keeps both versions.
  assert.match(
    git(root, 'branch', '--list', 'verifold/*'),
    /verifold\/task-1-r1-a1-/,
  );
});

await test('stale claims, dependencies, overlapping paths, and conflicts are refused', async (t) => {
  const root = await project(t, false);
  const sessions = new FakeSessions();
  const tasks = new TaskManager(root, { ownerId: 'owner-1', sessions });
  const first = await tasks.create(fields);
  const second = await tasks.create({
    ...fields,
    title: 'Then',
    dependencies: [first],
  });
  const overlapping = await tasks.create({
    ...fields,
    title: 'Overlap',
    writable: 'results/sub',
  });
  await assert.rejects(tasks.start(second), /waits for task-1/);
  await tasks.start(first);
  const binding = sessions.started[0]?.task;
  assert.ok(binding);
  // A result for another claim does not add a version.
  await tasks.turnEnded({ id: first, claim: '0000000000000000' }, 'completed');
  assert.equal((await tasks.get(first))?.state, 'running');
  await turn(tasks, sessions, { 'results/baseline.md': 'v1\n' });
  await assert.rejects(tasks.start(overlapping), /same paths/);
  // The project file changed after the start, so nothing is copied.
  await write(root, 'results/baseline.md', 'written by the person\n');
  assert.deepEqual(await tasks.accept(first, 1, ['results/baseline.md']), {
    conflicts: ['results/baseline.md'],
  });
  let task = (await tasks.get(first)) as TaskRecord;
  assert.equal(task.state, 'review');
  assert.deepEqual(task.attempts[0]?.versions[0]?.conflicts, [
    'results/baseline.md',
  ]);
  assert.equal(
    await readFile(join(root, 'results/baseline.md'), 'utf8'),
    'written by the person\n',
  );
  // Reject opens the task again. A new attempt starts from the project as it is now.
  await tasks.reject(first, 1);
  task = (await tasks.get(first)) as TaskRecord;
  assert.equal(task.state, 'open');
  assert.equal(task.attempts[0]?.outcome, 'rejected');
  await tasks.start(first);
  assert.equal(
    await readFile(
      join(sessions.started[1]?.cwd ?? '', 'results/baseline.md'),
      'utf8',
    ),
    'written by the person\n',
  );
  await turn(tasks, sessions, { 'results/baseline.md': 'v2\n' });
  // Version numbers continue across attempts.
  assert.deepEqual(await tasks.accept(first, 2, ['results/baseline.md']), {
    applied: ['results/baseline.md'],
  });
  await tasks.start(second);
  assert.equal((await tasks.get(second))?.state, 'running');
});

await test('failed allocation and failed starts keep evidence and release the claim', async (t) => {
  const root = await project(t, false);
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-outside-')),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'linked'));
  const sessions = new FakeSessions();
  const tasks = new TaskManager(root, { ownerId: 'owner-1', sessions });
  const linked = await tasks.create({
    ...fields,
    inputs: '',
    writable: 'linked',
  });
  await assert.rejects(
    tasks.start(linked),
    /could not prepare the task folder/,
  );
  let task = (await tasks.get(linked)) as TaskRecord;
  assert.equal(task.state, 'open');
  assert.equal(task.claim, null);
  assert.equal(task.attempts[0]?.outcome, 'allocation-failed');
  assert.match(task.attempts[0]?.note ?? '', /outside the project/);

  const id = await tasks.create(fields);
  sessions.failStart = true;
  await assert.rejects(
    tasks.start(id),
    /harness did not start: claude is not installed/,
  );
  task = (await tasks.get(id)) as TaskRecord;
  assert.equal(task.state, 'open');
  assert.equal(task.attempts[0]?.outcome, 'start-failed');
  assert.equal(
    existsSync(join(root, task.attempts[0]?.workspace?.path ?? 'x')),
    false,
  );

  // A restart while a turn runs keeps the work as a stopped version.
  sessions.failStart = false;
  await tasks.start(id);
  await write(
    sessions.started[0]?.cwd ?? '',
    'results/partial.md',
    'half done\n',
  );
  const later = new TaskManager(root, {
    ownerId: 'owner-2',
    sessions: new FakeSessions(),
  });
  assert.equal(await later.settle(), 1);
  task = (await later.get(id)) as TaskRecord;
  assert.equal(task.state, 'review');
  assert.equal(task.attempts[1]?.versions[0]?.turn, 'stopped');
  assert.deepEqual(
    task.attempts[1]?.versions[0]?.files.map((file) => file.path),
    ['results/partial.md'],
  );
  await assert.rejects(
    later.askForChanges(id, 'Finish it'),
    /session of this task ended/,
  );
  await later.cancel(id);
  assert.equal((await later.get(id))?.state, 'cancelled');
});

await test('a task session runs Claude Code strictly in the task folder and reports its turns', async (t) => {
  const root = await project(t, false);
  const claude = join(root, 'fake-claude');
  // Records its arguments and folder, writes one file, and ends the turn.
  await writeFile(
    claude,
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: 'native-1', permissionMode: 'dontAsk' });
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync('results/baseline.md', 'from the fake harness\\n');
  out({ type: 'result', subtype: 'success' });
});`,
    { mode: 0o700 },
  );
  process.env.ARGS_FILE = join(root, 'args.json');
  t.after(() => delete process.env.ARGS_FILE);
  // The session owner reports task turns to the task manager, which needs the session owner.
  const owner: { tasks?: TaskManager } = {};
  const sessions = new SessionPool(root, {
    clientVersion: 'test',
    ownerId: 'owner-1',
    executables: { claude },
    onTaskTurn: (task, turn, detail) =>
      void owner.tasks?.turnEnded(task, turn, detail),
  });
  const tasks = new TaskManager(root, { ownerId: 'owner-1', sessions });
  owner.tasks = tasks;
  t.after(() => sessions.close());
  const id = await tasks.create({ ...fields, inputs: '' });
  await tasks.start(id);
  let task: TaskRecord | null = null;
  for (let tries = 0; tries < 200 && task?.state !== 'review'; tries++) {
    await delay(20);
    task = await tasks.get(id);
  }
  assert.equal(task?.state, 'review');
  const { args, cwd } = JSON.parse(
    await readFile(join(root, 'args.json'), 'utf8'),
  ) as {
    args: string[];
    cwd: string;
  };
  assert.equal(
    await realpath(cwd),
    join(root, task?.attempts[0]?.workspace?.path ?? ''),
  );
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}') as {
    sandbox: { enabled: boolean };
    permissions: { allow: string[] };
  };
  assert.equal(settings.sandbox.enabled, true);
  assert.ok(settings.permissions.allow.includes('Edit(./**)'));
  assert.deepEqual(
    task?.attempts[0]?.versions[0]?.files.map((file) => file.path),
    ['results/baseline.md'],
  );
  const record = sessions.views()[0]?.record;
  assert.equal(record?.mode, 'strict');
  assert.equal(record?.task?.id, id);
  // The session controls of the desk and the terminal cannot bypass the task.
  assert.throws(() => sessions.send(record?.id, 'More'), /belongs to a task/);
  assert.throws(() => sessions.end(record?.id), /belongs to a task/);
  // A task session does not join the paused list when the owner stops.
  await sessions.close();
  await sessions.load();
  assert.deepEqual(sessions.paused(), []);
});

await test('the desk creates, reviews, and accepts a task through the same operations', async (t) => {
  const root = await project(t, false);
  const assets = join(root, 'assets');
  await mkdir(join(assets, 'cli', 'vendor'), { recursive: true });
  await mkdir(join(assets, 'ui'));
  for (const name of [
    'desk.css',
    'desk-client.js',
    'desk-transcript.js',
    'manrope.ttf',
    'symbol.webp',
  ])
    await writeFile(join(assets, 'cli', name), 'fixture asset');
  await writeFile(join(assets, 'cli', 'vendor', 'purify.js'), 'fixture');
  await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
  const fake = new FakeSessions();
  const tasks = new TaskManager(root, { ownerId: 'owner-1', sessions: fake });
  const sessions = new SessionPool(root, {
    clientVersion: 'test',
    ownerId: 'owner-1',
  });
  const owner = new AbortController();
  const desk = await startDesk(
    root,
    owner.signal,
    pathToFileURL(`${assets}/cli/`),
    sessions,
    undefined,
    undefined,
    tasks,
  );
  t.after(async () => {
    owner.abort();
    await desk.closed;
  });
  const url = new URL(desk.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const post = async (
    body: unknown,
  ): Promise<[number, Record<string, unknown>]> => {
    const response = await fetch(`${url.origin}/api/action`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return [
      response.status,
      (await response.json()) as Record<string, unknown>,
    ];
  };
  const view = async (query = ''): Promise<string> =>
    (
      (await (
        await fetch(`${url.origin}/api/view${query}`, { headers })
      ).json()) as { html: string }
    ).html;
  assert.match(await view(), /<details id="task-new" open>/);
  const [badStatus, bad] = await post({
    action: 'task-create',
    ...fields,
    writable: '../x',
  });
  assert.equal(badStatus, 409);
  assert.match(String(bad.error), /inside the project/);
  assert.equal((await post({ action: 'task-create', ...fields }))[0], 200);
  let html = await view();
  assert.match(html, /data-task-select="task-1" aria-pressed="true"/);
  assert.match(html, /data-action="task-start" data-task="task-1"/);
  assert.equal((await post({ action: 'task-start', task: 'task-1' }))[0], 200);
  assert.match(await view(), /The harness works in the task folder/);
  await turn(tasks, fake, { 'results/baseline.md': '# Baseline\n\n1.82 ms\n' });
  html = await view('?task=task-1');
  assert.match(html, /Version 1 · the turn ended/);
  assert.match(
    html,
    /data-action="task-accept" data-task="task-1" data-version="1"/,
  );
  assert.match(html, /What the harness enforces/);
  // The fake owner has no idle session, so Ask for changes is off, with the reason.
  assert.match(html, /harness session of this task ended/);
  assert.equal(
    (await fetch(`${url.origin}/api/view?task=task-9`, { headers })).status,
    404,
  );
  const diff = await fetch(
    `${url.origin}/api/task-diff?task=task-1&version=1&file=results%2Fbaseline.md`,
    { headers },
  );
  assert.match(((await diff.json()) as { text: string }).text, /^\+1\.82 ms$/m);
  assert.equal(
    (
      await fetch(
        `${url.origin}/api/task-diff?task=task-1&version=1&file=results%2Fbaseline.md`,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(
        `${url.origin}/api/task-diff?task=task-1&version=1&file=src%2Fbench.py`,
        { headers },
      )
    ).status,
    404,
  );
  await write(root, 'results/baseline.md', 'the person wrote this first\n');
  const [conflictStatus, conflict] = await post({
    action: 'task-accept',
    task: 'task-1',
    version: 1,
    files: ['results/baseline.md'],
  });
  assert.equal(conflictStatus, 409);
  assert.match(
    String(conflict.error),
    /changed in your project after the task started/,
  );
  await rm(join(root, 'results/baseline.md'));
  assert.equal(
    (
      await post({
        action: 'task-accept',
        task: 'task-1',
        version: 1,
        files: ['results/baseline.md'],
      })
    )[0],
    200,
  );
  assert.match(await view(), /Done\. You accepted results\/baseline\.md/);
});
