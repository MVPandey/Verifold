import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { changeWorkspace } from '../src/cli/storage.ts';
import {
  TaskManager,
  type TaskInputFields,
  type TaskRecord,
} from '../src/cli/tasks.ts';
import { SessionPool, workerLimit } from '../src/cli/workers.ts';
import { terminalInput } from '../src/cli/commands.ts';
import { renderDesk } from '../src/cli/desk-view.ts';
import { readDeskSnapshot } from '../src/cli/desk-records.ts';

/** The first writable path in a task prompt. Plain sessions write to `out`. */
const writable = `const match = /Writable paths:\\n- (\\S+)/.exec(text); const folder = match ? match[1] : 'out';`;

/**
 * A fake Claude Code. SLOW waits for an interrupt, BURST sends many text
 * events first, ASK opens a permission request. Each turn writes one file.
 */
const claudeHost = `const fs = require('node:fs');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id') + 1] || 'claude-native';
let waiting = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize')
    return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
    clearTimeout(waiting);
    return out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  }
  if (message.type === 'control_response') return out({ type: 'result', subtype: 'success' });
  if (message.type !== 'user') return;
  const text = String(message.message.content);
  ${writable}
  out({ type: 'system', subtype: 'init', session_id: id, permissionMode: args[args.indexOf('--permission-mode') + 1] });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(folder + '/claude.md', 'from claude\\n');
  if (text.includes('BURST'))
    for (let index = 0; index < 3000; index++) out({ type: 'assistant', message: { content: [{ type: 'text', text: 'burst ' + index }] } });
  if (text.includes('ASK'))
    return out({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-ask', input: { command: 'echo ask' } } });
  if (text.includes('SLOW')) { waiting = setTimeout(() => {}, 60000); return; }
  setTimeout(() => out({ type: 'result', subtype: 'success' }), 50);
});`;

/** The fake Codex app-servers listen on a Unix socket, like Codex. */
const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

/** A fake Codex app-server. Each turn writes one file and ends after a short delay. */
const codexHost = `const fs = require('node:fs');
const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
onLine((line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  if (message.method === 'thread/start') out({ id: message.id, result: { thread: { id: 'codex-thread-' + process.pid }, approvalsReviewer: message.params.approvalsReviewer } });
  if (message.method === 'turn/start') {
    const text = message.params.input[0].text;
    ${writable}
    out({ id: message.id, result: { turn: { id: 'turn-1' } } });
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(folder + '/codex.md', 'from codex\\n');
    setTimeout(() => out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }), 50);
  }
  if (message.method === 'turn/interrupt') out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted' } } });
});`;

async function owner(
  t: test.TestContext,
  executables: { claude?: string; codex?: string } = {},
): Promise<{ root: string; sessions: SessionPool; tasks: TaskManager }> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-workers-')),
  );
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
  await writeFile(
    join(root, 'fake-claude'),
    `#!${process.execPath}\n${claudeHost}`,
    { mode: 0o700 },
  );
  await writeFile(
    join(root, 'fake-codex'),
    `#!${process.execPath}\n${codexHost}`,
    { mode: 0o700 },
  );
  const owned: { tasks?: TaskManager } = {};
  const sessions = new SessionPool(root, {
    clientVersion: 'test',
    ownerId: 'owner-1',
    executables: {
      claude: join(root, 'fake-claude'),
      codex: join(root, 'fake-codex'),
      ...executables,
    },
    onTaskTurn: (task, turn, detail) =>
      void owned.tasks?.turnEnded(task, turn, detail),
  });
  const tasks = new TaskManager(root, { ownerId: 'owner-1', sessions });
  owned.tasks = tasks;
  t.after(async () => {
    await sessions.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessions, tasks };
}

function task(
  title: string,
  host: 'claude' | 'codex',
  path: string,
  objective = 'Write the result.',
): TaskInputFields {
  return {
    title,
    objective,
    writable: path,
    output: `${path}/${host}.md`,
    host,
  };
}

async function state(
  tasks: TaskManager,
  id: string,
  wanted: TaskRecord['state'],
): Promise<TaskRecord> {
  for (let tries = 0; tries < 250; tries++) {
    const record = await tasks.get(id);
    if (record?.state === wanted) return record;
    await delay(20);
  }
  throw new Error(
    `${id} did not reach ${wanted}: ${(await tasks.get(id))?.state}`,
  );
}

await test('two workers run tasks at the same time, each with its own identity and result', async (t) => {
  const { sessions, tasks } = await owner(t);
  assert.equal(workerLimit, 2);
  const a = await tasks.create(task('Baseline', 'claude', 'results/a'));
  const b = await tasks.create(task('Variant', 'codex', 'results/b'));
  const c = await tasks.create(task('Third', 'claude', 'results/c'));
  await tasks.create(task('Overlap', 'codex', 'results/a/deeper'));
  await Promise.all([tasks.start(a), tasks.start(b)]);
  // The limit holds before launch, and overlapping outputs are refused.
  await assert.rejects(tasks.start(c), /Every worker is busy/);
  const [first, second] = await Promise.all([
    state(tasks, a, 'review'),
    state(tasks, b, 'review'),
  ]);
  const views = sessions.views();
  assert.equal(views.length, 2);
  const ids = new Set(views.map((view) => view.record.id));
  assert.equal(ids.size, 2);
  const natives = new Set(views.map((view) => view.record.nativeSessionId));
  assert.equal(natives.size, 2);
  for (const [record, file] of [
    [first, 'results/a/claude.md'],
    [second, 'results/b/codex.md'],
  ] as const) {
    const attempt = record.attempts[0];
    const view = views.find((entry) => entry.record.id === attempt?.session);
    assert.equal(view?.record.task?.id, record.id);
    assert.equal(view?.record.task?.claim, record.claim?.id);
    assert.deepEqual(
      attempt?.versions[0]?.files.map((entry) => entry.path),
      [file],
    );
  }
  assert.ok(
    (await tasks.get(a))?.attempts[0]?.workspace?.path !==
      (await tasks.get(b))?.attempts[0]?.workspace?.path,
  );
});

await test('a stop, an output burst, or a failure in one worker leaves the other alone', async (t) => {
  const { sessions, tasks } = await owner(t, { codex: '/missing/codex' });
  const slow = await tasks.create(
    task('Slow', 'claude', 'results/slow', 'SLOW work.'),
  );
  const missing = await tasks.create(task('Missing', 'codex', 'results/x'));
  await tasks.start(slow);
  await tasks.start(missing);
  // The harness that cannot start ends its turn with the reason.
  const failed = await state(tasks, missing, 'review');
  const version = failed.attempts[0]?.versions[0];
  assert.equal(version?.turn, 'exited');
  assert.match(version?.note ?? '', /Could not start Codex/);
  assert.equal((await tasks.get(slow))?.state, 'running');
  // Stopping the slow worker does not touch the failed one's version.
  await tasks.stop(slow);
  const stopped = await state(tasks, slow, 'review');
  assert.equal(stopped.attempts[0]?.versions[0]?.turn, 'interrupted');
  assert.deepEqual(
    (await tasks.get(missing))?.attempts[0]?.versions,
    failed.attempts[0]?.versions,
  );
  await tasks.reject(missing, 1);
  // A burst of events in one worker does not stop another.
  const burst = await tasks.create(
    task('Burst', 'claude', 'results/burst', 'BURST output.'),
  );
  const steady = await tasks.create(task('Steady', 'claude', 'results/steady'));
  await tasks.reject(slow, 1);
  await Promise.all([tasks.start(burst), tasks.start(steady)]);
  const [loud, quiet] = await Promise.all([
    state(tasks, burst, 'review'),
    state(tasks, steady, 'review'),
  ]);
  assert.equal(loud.attempts[0]?.versions[0]?.turn, 'completed');
  assert.equal(quiet.attempts[0]?.versions[0]?.turn, 'completed');
  // Each worker keeps its own bounded record. The burst stays in its own session.
  const records = sessions.views().map((view) => view.record);
  const noisy = records.find((record) => record.task?.id === burst);
  const calm = records.find((record) => record.task?.id === steady);
  assert.ok((noisy?.events.length ?? 0) <= 400);
  assert.ok(noisy?.events.some((event) => event.text === 'burst 2999'));
  assert.ok(!calm?.events.some((event) => event.text.startsWith('burst')));
});

await test('the terminal names the worker, routes answers by request ID, and sends ambiguous actions to the desk', async (t) => {
  const { root, sessions } = await owner(t);
  const messages: string[] = [];
  const io = {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
    progress: (value: string) => messages.push(value),
  };
  const controls = { host: 'claude', open: () => {} };
  const first = await sessions.start({
    host: 'claude',
    mode: 'ask',
    prompt: 'ASK first',
  });
  const second = await sessions.start({
    host: 'claude',
    mode: 'ask',
    prompt: 'ASK second',
  });
  await assert.rejects(
    sessions.start({ host: 'codex', mode: 'auto', prompt: 'Third' }),
    /2 workers are running/,
  );
  let requests: string[] = [];
  for (let tries = 0; tries < 250 && requests.length < 2; tries++) {
    await delay(20);
    requests = sessions
      .views()
      .flatMap((view) => view.record.requests.map((request) => request.id));
  }
  assert.deepEqual([...requests].sort(), ['R1', 'R2']);
  // The desk shows both workers and the selected one in full. No slot is free.
  const html = renderDesk(await readDeskSnapshot(root), undefined, null, {
    workers: sessions.views(),
    session: sessions.view(second),
    full: sessions.full,
    controllable: true,
  }).html;
  assert.equal(html.match(/data-worker="/g)?.length, 2);
  assert.match(html, new RegExp(`data-worker="${second}" aria-pressed="true"`));
  assert.match(html, /2 of 2 running/);
  assert.match(html, /1 request waits for you/);
  assert.doesNotMatch(html, /data-action="start"/);
  // Without an ID, two open requests are ambiguous.
  terminalInput(sessions, 'a', io, controls);
  assert.match(messages.at(-1) ?? '', /2 requests are open/);
  const secondRequest = sessions.view(second)?.record.requests[0]?.id ?? '';
  terminalInput(sessions, `a ${secondRequest}`, io, controls);
  for (
    let tries = 0;
    tries < 250 && sessions.view(second)?.record.status !== 'idle';
    tries++
  )
    await delay(20);
  assert.equal(sessions.view(second)?.record.status, 'idle');
  assert.equal(sessions.view(first)?.record.requests.length, 1);
  terminalInput(sessions, 'd', io, controls);
  for (
    let tries = 0;
    tries < 250 && sessions.view(first)?.record.status !== 'idle';
    tries++
  )
    await delay(20);
  // Two idle sessions: a follow-up goes to the desk.
  terminalInput(sessions, 'Continue', io, controls);
  assert.match(messages.at(-1) ?? '', /2 sessions match. Use the desk/);
  terminalInput(sessions, '/end', io, controls);
  assert.match(messages.at(-1) ?? '', /2 sessions match/);
  sessions.end(first);
  terminalInput(sessions, '/end', io, controls);
  assert.equal(sessions.view(second)?.live, false);
});
