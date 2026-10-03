import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { changeWorkspace } from '../src/cli/storage.ts';
import {
  TaskManager,
  type TaskInputFields,
  type TaskRecord,
} from '../src/cli/tasks.ts';
import { SessionPool, workerLimit } from '../src/cli/workers.ts';
import { ptyLibrary } from '../src/cli/terminals.ts';
import { startDesk } from '../src/cli/desk.ts';
import { terminalInput } from '../src/cli/commands.ts';
import { renderDesk } from '../src/cli/desk-view.ts';
import { ResearchRunner } from '../src/cli/research-runner.ts';
import { loadPaused } from '../src/cli/session.ts';
import { readDeskSnapshot } from '../src/cli/desk-records.ts';

/** The first writable path in a task prompt. Plain sessions write to `out`. */
const writable = `const match = /Writable paths:\\n- (\\S+)/.exec(text); const folder = match ? match[1] : 'out';`;

/** The TUI mode of a fake harness: prints its arguments, echoes lines, writes on WRITE, exits on /exit. */
const fakeTui = `const fs = require('node:fs');
process.stdin.setRawMode?.(true);
process.stdout.write('fake tui ' + process.argv.slice(2).join(' ') + '\\r\\n');
let line = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char !== '\\r' && char !== '\\n') { line += char; continue; }
    if (line === '/exit') process.exit(0);
    if (line === 'WRITE') { fs.mkdirSync('results/tui', { recursive: true }); fs.writeFileSync('results/tui/terminal.md', 'from the terminal\\n'); }
    process.stdout.write('echo ' + line + '\\r\\n');
    line = '';
  }
});`;

/**
 * A fake Claude Code. SLOW waits for an interrupt, BURST sends many text
 * events first, ASK opens a permission request. Each turn writes one file.
 */
const claudeHost = `if (!process.argv.includes('-p')) { ${fakeTui}; return; }
const fs = require('node:fs');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id') + 1] || 'claude-native';
let waiting = null;
let init = null;
let toolFolder = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    init = message.request;
    return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  }
  if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
    clearTimeout(waiting);
    return out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  }
  if (message.type === 'control_response') {
    if (message.response.request_id === 'mcp-1')
      fs.writeFileSync(toolFolder + '/tool.json', JSON.stringify({ reply: message.response.response, args, init }));
    return out({ type: 'result', subtype: 'success' });
  }
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
  if (text.includes('TOOL')) {
    toolFolder = folder;
    return out({ type: 'control_request', request_id: 'mcp-1', request: { subtype: 'mcp_message', server_name: 'verifold', message: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'verifold_post', arguments: { to: 'coordinator', text: 'hello from claude' }, _meta: { 'claudecode/toolUseId': 'toolu_9' } } } } });
  }
  setTimeout(() => out({ type: 'result', subtype: 'success' }), 50);
});`;

/** The fake Codex app-servers listen on a Unix socket, like Codex. */
const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

/** A fake Codex app-server. Each turn writes one file and ends after a short delay. */
const codexHost = `if (process.argv.includes('--remote')) { ${fakeTui}; return; }
const fs = require('node:fs');
const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
let start = null;
let toolFolder = null;
onLine((line) => {
  const message = JSON.parse(line);
  if (message.id === 'tool-1' && !message.method) {
    fs.writeFileSync(toolFolder + '/tool.json', JSON.stringify({ reply: message.result, dynamicTools: start.dynamicTools.map((tool) => tool.name) }));
    out({ method: 'item/completed', params: { item: { type: 'dynamicToolCall', id: 'dyn-1', tool: 'verifold_post', arguments: {}, status: 'completed', success: message.result.success } } });
    return out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  if (message.method === 'config/read') out({ id: message.id, result: { config: {} } });
  if (message.method === 'thread/start') start = message.params;
  if (message.method === 'thread/start') out({ id: message.id, result: { thread: { id: 'codex-thread-' + process.pid }, approvalsReviewer: message.params.approvalsReviewer } });
  if (message.method === 'turn/start') {
    const text = message.params.input[0].text;
    ${writable}
    out({ id: message.id, result: { turn: { id: 'turn-1' } } });
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(folder + '/codex.md', 'from codex\\n');
    if (text.includes('TOOL')) {
      toolFolder = folder;
      out({ method: 'item/started', params: { item: { type: 'dynamicToolCall', id: 'dyn-1', tool: 'verifold_post', arguments: { to: 'coordinator' }, status: 'inProgress' } } });
      return out({ id: 'tool-1', method: 'item/tool/call', params: { threadId: 'codex-thread', turnId: 'turn-1', callId: 'call-1', tool: 'verifold_post', arguments: { to: 'coordinator', text: 'hello from codex' } } });
    }
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

await test('Claude Code and Codex workers reach Verifold tools over their own pipes', async (t) => {
  const { root, sessions, tasks } = await owner(t);
  const a = await tasks.create(
    task('Claude tool', 'claude', 'results/a', 'TOOL post.'),
  );
  const b = await tasks.create(
    task('Codex tool', 'codex', 'results/b', 'TOOL post.'),
  );
  await Promise.all([tasks.start(a), tasks.start(b)]);
  const [first, second] = await Promise.all([
    state(tasks, a, 'review'),
    state(tasks, b, 'review'),
  ]);
  const messages = await tasks.messageList();
  assert.deepEqual(
    messages.map((message) => [message.from, message.to, message.text]).sort(),
    [
      [a, 'coordinator', 'hello from claude'],
      [b, 'coordinator', 'hello from codex'],
    ],
  );
  // Each message keeps the harness's call ID, so a repeated call adds nothing.
  assert.ok(messages.some((message) => message.key?.endsWith(':toolu_9')));
  assert.ok(messages.some((message) => message.key?.endsWith(':call-1')));
  const read = async (
    record: TaskRecord,
    path: string,
  ): Promise<Record<string, unknown>> =>
    JSON.parse(
      await readFile(
        join(root, record.attempts[0]?.workspace?.path ?? '', path),
        'utf8',
      ),
    ) as Record<string, unknown>;
  const names = [
    'verifold_post',
    'verifold_block',
    'verifold_object',
    'verifold_withdraw',
  ];
  const claude = (await read(first, 'results/a/tool.json')) as {
    reply: {
      mcp_response: {
        result: { content: { text: string }[]; isError: boolean };
      };
    };
    args: string[];
    init: { sdkMcpServers: string[] };
  };
  assert.match(
    claude.reply.mcp_response.result.content[0]?.text ?? '',
    /^Recorded m-\d\.$/,
  );
  assert.equal(claude.reply.mcp_response.result.isError, false);
  assert.deepEqual(claude.init.sdkMcpServers, ['verifold']);
  assert.equal(
    claude.args[claude.args.indexOf('--allowedTools') + 1],
    names.map((name) => `mcp__verifold__${name}`).join(','),
  );
  const codex = (await read(second, 'results/b/tool.json')) as {
    reply: { success: boolean; contentItems: { text: string }[] };
    dynamicTools: string[];
  };
  assert.equal(codex.reply.success, true);
  // The Commands record lists the call like any other tool call.
  assert.deepEqual(
    sessions
      .view(second.attempts[0]?.session ?? '')
      ?.record.commands.map((command) => [
        command.tool,
        command.action,
        command.outcome,
      ]),
    [['verifold_post', '{"to":"coordinator"}', 'ok']],
  );
  assert.match(codex.reply.contentItems[0]?.text ?? '', /^Recorded m-\d\.$/);
  assert.deepEqual(codex.dynamicTools, names);
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

const lease = 'c'.repeat(16);

/** Read a terminal until the pattern shows, for at most 10 s. */
async function screen(
  sessions: SessionPool,
  id: string,
  pattern: RegExp,
): Promise<string> {
  let text = '';
  let next = 0;
  const deadline = Date.now() + 10_000;
  while (!pattern.test(text) && Date.now() < deadline) {
    const terminal = sessions.terminal(id);
    if (!terminal) break;
    const output = await terminal.read(next, 200);
    text += output.data;
    next = output.next;
  }
  assert.ok(
    pattern.test(text),
    `The terminal did not show ${String(pattern)}.`,
  );
  return text;
}

async function status(
  sessions: SessionPool,
  id: string,
  wanted: string,
): Promise<void> {
  for (let tries = 0; tries < 250; tries++) {
    if (sessions.view(id)?.record.status === wanted) return;
    await delay(20);
  }
  assert.equal(sessions.view(id)?.record.status, wanted);
}

const terminals =
  typeof (await ptyLibrary()) === 'string'
    ? 'no PTY library on this platform'
    : false;

await test(
  'a Claude Code session moves to its terminal between turns and back to Verifold',
  { skip: terminals },
  async (t) => {
    const { sessions } = await owner(t);
    const id = await sessions.start({
      host: 'claude',
      mode: 'auto',
      prompt: 'Start',
    });
    await status(sessions, id, 'idle');
    const native = sessions.view(id)?.record.nativeSessionId ?? '';
    await sessions.takeTerminal(id, lease);
    await status(sessions, id, 'terminal');
    // No structured process runs, but the worker is live and its slot is busy.
    assert.equal(sessions.view(id)?.live, true);
    const shown = await screen(sessions, id, /fake tui --resume/);
    assert.match(shown, new RegExp(`--resume ${native}`));
    assert.match(shown, /--strict-mcp-config --permission-mode auto/);
    assert.throws(() => sessions.send(id, 'More'), /hold the terminal/);
    await assert.rejects(sessions.takeTerminal(id, lease), /terminal is open/);
    sessions.terminal(id)?.write(lease, 'hello\r');
    await screen(sessions, id, /echo hello/);
    // The terminal's exit returns the session: the structured process starts again on the same conversation.
    sessions.terminal(id)?.write(lease, '/exit\r');
    await status(sessions, id, 'idle');
    const record = sessions.view(id)?.record;
    assert.equal(record?.nativeSessionId, native);
    assert.ok(
      record?.events.some((event) =>
        event.text.includes('records no tool calls'),
      ),
    );
    assert.ok(
      record?.events.some(
        (event) => event.text === 'You returned to Verifold.',
      ),
    );
  },
);

await test(
  'a Codex terminal attaches to the same socket while its events continue',
  { skip: terminals },
  async (t) => {
    const { sessions } = await owner(t);
    const id = await sessions.start({
      host: 'codex',
      mode: 'auto',
      prompt: 'Start',
    });
    await status(sessions, id, 'idle');
    await sessions.takeTerminal(id, lease);
    await status(sessions, id, 'terminal');
    const shown = await screen(sessions, id, /fake tui/);
    assert.match(
      shown,
      /--remote unix:\/\/\S+codex\.sock resume codex-thread-\d+/,
    );
    assert.throws(() => sessions.cancel(id), /hold the terminal/);
    sessions.returnFromTerminal(id);
    await status(sessions, id, 'idle');
  },
);

await test(
  'a task terminal keeps the Strict limits and its end saves a version',
  { skip: terminals },
  async (t) => {
    const { sessions, tasks } = await owner(t);
    const id = await tasks.create(
      task('Terminal task', 'claude', 'results/tui'),
    );
    await tasks.start(id);
    await state(tasks, id, 'review');
    for (let tries = 0; tries < 250; tries++) {
      const session = (await tasks.get(id))?.attempts[0]?.session ?? '';
      if (sessions.idle(session)) break;
      await delay(20);
    }
    await tasks.openTerminal(id, lease);
    const session = (await tasks.get(id))?.attempts[0]?.session ?? '';
    assert.equal((await tasks.get(id))?.state, 'running');
    const shown = await screen(sessions, session, /fake tui/);
    assert.match(
      shown,
      /--strict-mcp-config --permission-mode dontAsk --settings \{"sandbox"/,
    );
    sessions.terminal(session)?.write(lease, 'WRITE\r');
    await screen(sessions, session, /echo WRITE/);
    sessions.terminal(session)?.write(lease, '/exit\r');
    const reviewed = await state(tasks, id, 'review');
    const versions = reviewed.attempts[0]?.versions ?? [];
    assert.equal(versions[0]?.decision?.note, 'You worked in the terminal.');
    assert.equal(versions[1]?.turn, 'terminal');
    assert.ok(
      versions[1]?.files.some(
        (file) => file.path === 'results/tui/terminal.md',
      ),
    );
  },
);

await test(
  'stopping the owner closes an open terminal without starting the session again',
  { skip: terminals },
  async (t) => {
    const { root, sessions } = await owner(t);
    const id = await sessions.start({
      host: 'claude',
      mode: 'auto',
      prompt: 'Start',
    });
    await status(sessions, id, 'idle');
    await sessions.takeTerminal(id, lease);
    await status(sessions, id, 'terminal');
    const terminal = sessions.terminal(id);
    await sessions.close();
    for (let tries = 0; tries < 100 && !terminal?.exited; tries++)
      await delay(20);
    assert.equal(terminal?.exited, true);
    assert.equal(sessions.view(id)?.record.status, 'paused');
    await delay(300);
    assert.equal(sessions.view(id)?.live, false);
    assert.ok(root);
  },
);

await test(
  'the desk opens, streams, and returns a terminal through its routes',
  { skip: terminals },
  async (t) => {
    const { root, sessions } = await owner(t);
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
      'manrope.ttf',
      'symbol.webp',
    ])
      await writeFile(join(assets, 'cli', name), 'fixture asset');
    for (const name of ['purify.js', 'xterm.js', 'xterm.css', 'addon-fit.js'])
      await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
    await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
    const stop = new AbortController();
    const desk = await startDesk(
      root,
      stop.signal,
      pathToFileURL(`${assets}/cli/`),
      sessions,
    );
    t.after(async () => {
      stop.abort();
      await desk.closed;
    });
    const url = new URL(desk.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
    const post = async (
      path: string,
      body: unknown,
    ): Promise<[number, Record<string, unknown>]> => {
      const response = await fetch(`${url.origin}${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return [
        response.status,
        (await response.json()) as Record<string, unknown>,
      ];
    };
    const id = await sessions.start({
      host: 'claude',
      mode: 'auto',
      prompt: 'Start',
    });
    await status(sessions, id, 'idle');
    const page = await fetch(`${url.origin}/`);
    assert.match(
      page.headers.get('content-security-policy') ?? '',
      /frame-src 'self'; frame-ancestors 'none'/,
    );
    assert.equal(
      (
        await post('/api/action', {
          action: 'terminal-open',
          session: id,
          lease: 'bad',
        })
      )[0],
      409,
    );
    assert.equal(
      (
        await post('/api/action', {
          action: 'terminal-open',
          session: id,
          lease,
        })
      )[0],
      200,
    );
    await status(sessions, id, 'terminal');
    const view = (
      (await (
        await fetch(`${url.origin}/api/view?worker=${id}`, { headers })
      ).json()) as { html: string }
    ).html;
    assert.match(view, /data-action="terminal-return"/);
    assert.doesNotMatch(view, /data-action="cancel"/);
    // Only the terminal page allows inline styles, and only the desk can frame it.
    const terminalPage = await fetch(`${url.origin}/terminal?session=${id}`);
    assert.equal(terminalPage.status, 200);
    assert.match(
      terminalPage.headers.get('content-security-policy') ?? '',
      /style-src 'self' 'unsafe-inline'.*frame-ancestors 'self'/,
    );
    assert.equal(terminalPage.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(
      (await fetch(`${url.origin}/terminal?session=../x`)).status,
      400,
    );
    const read = async (after: number): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${url.origin}/api/terminal?session=${id}&after=${after}`, {
          headers,
        })
      ).json()) as Record<string, unknown>;
    assert.equal(
      (await fetch(`${url.origin}/api/terminal?session=${id}&after=0`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${url.origin}/api/terminal?session=${id}&after=-1`, {
          headers,
        })
      ).status,
      400,
    );
    let output = await read(0);
    let text = String(output.data);
    for (let tries = 0; tries < 20 && !text.includes('fake tui'); tries++) {
      output = await read(Number(output.next));
      text += String(output.data);
    }
    assert.match(text, /fake tui --resume/);
    assert.equal(output.owner, lease);
    const other = 'd'.repeat(16);
    assert.deepEqual(
      await post('/api/terminal', { session: id, lease: other, input: 'x\r' }),
      [
        409,
        {
          error:
            'Another view holds input for this terminal. Take input here first.',
        },
      ],
    );
    assert.equal(
      (
        await post('/api/terminal', {
          session: id,
          lease,
          input: 'from the desk\r',
        })
      )[0],
      200,
    );
    for (
      let tries = 0;
      tries < 20 && !text.includes('echo from the desk');
      tries++
    ) {
      output = await read(Number(output.next));
      text += String(output.data);
    }
    assert.match(text, /echo from the desk/);
    assert.equal(
      (
        await post('/api/terminal', {
          session: id,
          lease: other,
          take: true,
          cols: 90,
          rows: 20,
        })
      )[0],
      200,
    );
    assert.equal((await read(Number(output.next))).owner, other);
    assert.equal(
      (
        await post('/api/action', { action: 'terminal-return', session: id })
      )[0],
      200,
    );
    await status(sessions, id, 'idle');
    assert.equal(
      (
        await fetch(`${url.origin}/api/terminal?session=${id}&after=0`, {
          headers,
        })
      ).status,
      404,
    );
  },
);

await test(
  'a Codex worker stops when its owner is killed',
  { skip: process.platform === 'win32' && 'POSIX process groups' },
  async (t) => {
    const { root } = await owner(t);
    const script = join(root, 'owner.mjs');
    await writeFile(
      script,
      `import { SessionPool } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/cli/workers.ts', import.meta.url))).href)};
const sessions = new SessionPool(${JSON.stringify(root)}, { clientVersion: 'test', ownerId: 'doomed', executables: { codex: ${JSON.stringify(join(root, 'fake-codex'))} } });
const id = await sessions.start({ host: 'codex', mode: 'auto', prompt: 'Start' });
for (let tries = 0; tries < 250 && sessions.view(id)?.record.status !== 'idle'; tries++) await new Promise((r) => setTimeout(r, 20));
console.log(sessions.view(id)?.record.launches.at(-1)?.pid);
setInterval(() => {}, 1000);`,
    );
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', script],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    t.after(() => child.kill('SIGKILL'));
    let printed = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      printed += chunk;
    });
    for (let tries = 0; tries < 250 && !/\d+\n/.test(printed); tries++)
      await delay(20);
    const group = Number(printed.trim());
    assert.ok(
      group > 0,
      `The owner did not report its Codex process: ${printed}`,
    );
    const running = (): boolean => {
      try {
        process.kill(-group, 0);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(running(), true);
    child.kill('SIGKILL');
    for (let tries = 0; tries < 250 && running(); tries++) await delay(20);
    assert.equal(running(), false);
  },
);

await test('research and two workers run together, and each stop reaches only its target', async (t) => {
  const { root, sessions } = await owner(t);
  const stop = new AbortController();
  let researched = 0;
  const runner = new ResearchRunner(root, {
    signal: stop.signal,
    io: {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
    },
    // A research step that waits until it is cancelled.
    harness: (request) => {
      researched++;
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled.', 'AbortError')),
          { once: true },
        ),
      );
    },
  });
  const slow = await sessions.start({
    host: 'claude',
    mode: 'auto',
    prompt: 'SLOW work.',
  });
  await status(sessions, slow, 'running');
  await runner.start({ topic: 'Proof search' });
  // A worker starts while research runs.
  const other = await sessions.start({
    host: 'codex',
    mode: 'auto',
    prompt: 'Write the result.',
  });
  await status(sessions, other, 'idle');
  for (let tries = 0; tries < 250 && !researched; tries++) await delay(20);
  assert.equal(runner.running, true);

  // With research and a turn running, the terminal sends the choice to the desk.
  const lines: string[] = [];
  const controls = { host: 'claude', open: () => {}, research: runner };
  const io = {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
    progress: (line: string) => lines.push(line),
  };
  terminalInput(sessions, '/cancel', io, controls);
  assert.match(lines.at(-1) ?? '', /Research and a session run\. Use the desk/);
  assert.equal(runner.running, true);
  assert.equal(sessions.view(slow)?.record.status, 'running');

  sessions.cancel(slow);
  await status(sessions, slow, 'idle');
  assert.equal(runner.running, true);
  runner.cancel();
  await runner.settled();
  assert.match(runner.view().events.at(-1)?.text ?? '', /was cancelled/);
  assert.ok(sessions.view(slow)?.live);
  assert.ok(sessions.view(other)?.live);

  // Stopping the owner stops research and pauses both workers.
  await runner.start({ topic: 'Proof search' });
  for (let tries = 0; tries < 250 && researched < 2; tries++) await delay(20);
  stop.abort();
  await runner.settled();
  await sessions.close();
  assert.match(runner.view().events.at(-1)?.text ?? '', /was cancelled/);
  assert.deepEqual(
    (await loadPaused(root)).map((entry) => entry.id).sort(),
    [slow, other].sort(),
  );
});
