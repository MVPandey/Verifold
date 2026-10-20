import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { changeWorkspace, loadWorkspace } from '../src/cli/storage.ts';
import { SessionPool } from '../src/cli/workers.ts';
import {
  Lab,
  labLimits,
  startLabOn,
  type LabSessions,
} from '../src/cli/lab.ts';
import { RunTeam } from '../src/cli/team.ts';
import { ResearchRunner } from '../src/cli/research-runner.ts';
import { boardLimits } from '../src/cli/board.ts';
import { Coordinator } from '../src/cli/coordinator.ts';
import { renderDesk } from '../src/cli/desk-view.ts';
import { renderLab } from '../src/cli/desk-lab.ts';
import { readDeskSnapshot } from '../src/cli/desk-records.ts';
import { Quota } from '../src/cli/quota.ts';
import {
  readRecord,
  SessionManager,
  type SessionView,
} from '../src/cli/session.ts';
import { archiveRun, restoreRun } from '../src/cli/archive.ts';
import { runCli, terminalInput, type CliIO } from '../src/cli/commands.ts';
import { startDesk } from '../src/cli/desk.ts';
import { TaskManager } from '../src/cli/tasks.ts';

/**
 * A fake Claude Code for lab agents. Its folder name (such as d-1-circles)
 * finds its script in `scripts/<folder>.json` and its logs in `logs/<folder>/`,
 * next to the fake. A script is a list of turns: `{ when?, calls }`. Each new
 * request takes the first unused turn whose `when` text it contains, or that
 * has no `when`. A call runs Verifold's tool over the SDK MCP channel. Calls
 * named WRITE write a file, WAIT keep the turn running until a steered message
 * arrives, EXIT stop the process, and FAIL end the turn as failed. A call with
 * an `id` uses it as its tool-use ID. With a `resume-fails` file next to the
 * fake, a resume stops at once, as when the harness lost the conversation.
 */
const claudeHost = `const fs = require('node:fs');
const path = require('node:path');
const base = path.dirname(process.argv[1]);
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const args = process.argv.slice(2);
const name = path.basename(process.cwd());
const log = path.join(base, 'logs', name);
fs.mkdirSync(log, { recursive: true });
fs.writeFileSync(path.join(log, 'args.json'), JSON.stringify(args));
fs.writeFileSync(path.join(log, 'env.json'), JSON.stringify(process.env));
fs.appendFileSync(path.join(log, 'launches.jsonl'), JSON.stringify(args.includes('--resume') ? 'resume' : 'start') + '\\n');
if (args.includes('--resume') && fs.existsSync(path.join(base, 'resume-fails'))) process.exit(1);
const id =args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
const usedFile = path.join(log, 'used.json');
let calls = [];
let next = 0;
let running = false;
let turn = 0;
const take = (text) => {
  let script = [];
  try { script = JSON.parse(fs.readFileSync(path.join(base, 'scripts', name + '.json'), 'utf8')); } catch {}
  const used = fs.existsSync(usedFile) ? JSON.parse(fs.readFileSync(usedFile, 'utf8')) : [];
  const index = script.findIndex((entry, at) => !used.includes(at) && (!entry.when || text.includes(entry.when)));
  if (index < 0) return [];
  fs.writeFileSync(usedFile, JSON.stringify([...used, index]));
  return script[index].calls;
};
const call = () => {
  const entry = calls[next];
  if (!entry) { running = false; return out({ type: 'result', subtype: 'success' }); }
  if (entry.name === 'WRITE') {
    fs.mkdirSync(path.dirname(entry.arguments.path), { recursive: true });
    fs.writeFileSync(entry.arguments.path, entry.arguments.text);
    next++;
    return call();
  }
  if (entry.name === 'WAIT') return;
  if (entry.name === 'EXIT') process.exit(1);
  if (entry.name === 'FAIL') { running = false; return out({ type: 'result', subtype: 'error_during_execution', is_error: true }); }
  out({ type: 'control_request', request_id: 'mcp-' + turn + '-' + next, request: { subtype: 'mcp_message', server_name: 'verifold', message: { jsonrpc: '2.0', id: 100 + next, method: 'tools/call', params: { name: entry.name, arguments: entry.arguments, _meta: { 'claudecode/toolUseId': entry.id ?? ('toolu-' + process.pid + '-' + turn + '-' + next) } } } } });
};
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize')
    return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
    running = false;
    return out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  }
  if (message.type === 'control_response') {
    fs.appendFileSync(path.join(log, 'results.jsonl'), JSON.stringify({ call: calls[next].name, result: message.response.response.mcp_response.result }) + '\\n');
    next++;
    return call();
  }
  if (message.type !== 'user') return;
  const text = String(message.message.content);
  if (message.uuid && running) {
    fs.appendFileSync(path.join(log, 'steers.jsonl'), JSON.stringify(text) + '\\n');
    out({ type: 'user', isReplay: true, uuid: message.uuid, message: message.message });
    next++;
    return call();
  }
  fs.appendFileSync(path.join(log, 'inputs.jsonl'), JSON.stringify(text) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: id, permissionMode: 'dontAsk' });
  calls = take(text);
  next = 0;
  turn++;
  running = true;
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Turn ' + turn + '.' }] } });
  call();
});`;

const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

/** A fake Codex app-server for lab agents, with the same scripts and logs as the fake Claude Code. */
const codexHost = `const fs = require('node:fs');
const path = require('node:path');
const base = path.dirname(process.argv[1]);
const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
const name = path.basename(process.cwd());
const log = path.join(base, 'logs', name);
fs.mkdirSync(log, { recursive: true });
fs.writeFileSync(path.join(log, 'args.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(log, 'env.json'), JSON.stringify(process.env));
const usedFile = path.join(log, 'used.json');
let calls = [];
let next = 0;
let turn = null;
let thread = null;
let seq = 0;
const take = (text) => {
  let script = [];
  try { script = JSON.parse(fs.readFileSync(path.join(base, 'scripts', name + '.json'), 'utf8')); } catch {}
  const used = fs.existsSync(usedFile) ? JSON.parse(fs.readFileSync(usedFile, 'utf8')) : [];
  const index = script.findIndex((entry, at) => !used.includes(at) && (!entry.when || text.includes(entry.when)));
  if (index < 0) return [];
  fs.writeFileSync(usedFile, JSON.stringify([...used, index]));
  return script[index].calls;
};
const call = () => {
  const entry = calls[next];
  if (!entry) return out({ method: 'turn/completed', params: { turn: { id: turn, status: 'completed' } } });
  if (entry.name === 'WRITE') {
    fs.mkdirSync(path.dirname(entry.arguments.path), { recursive: true });
    fs.writeFileSync(entry.arguments.path, entry.arguments.text);
    next++;
    return call();
  }
  seq++;
  out({ id: 'tool-' + seq, method: 'item/tool/call', params: { threadId: thread, turnId: turn, callId: 'call-' + process.pid + '-' + seq, tool: entry.name, arguments: entry.arguments } });
};
onLine((line) => {
  const message = JSON.parse(line);
  if (typeof message.id === 'string' && message.id.startsWith('tool-') && !message.method) {
    fs.appendFileSync(path.join(log, 'results.jsonl'), JSON.stringify({ call: calls[next].name, result: message.result }) + '\\n');
    next++;
    return call();
  }
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  if (message.method === 'config/read') out({ id: message.id, result: { config: {} } });
  if (message.method === 'thread/start') {
    fs.appendFileSync(path.join(log, 'threads.jsonl'), JSON.stringify({ method: 'start', params: message.params }) + '\\n');
    thread = 'codex-thread-' + process.pid;
    out({ id: message.id, result: { thread: { id: thread } } });
  }
  if (message.method === 'thread/resume') {
    fs.appendFileSync(path.join(log, 'threads.jsonl'), JSON.stringify({ method: 'resume' }) + '\\n');
    thread = message.params.threadId;
    out({ id: message.id, result: { thread: { id: thread } } });
  }
  if (message.method === 'turn/start') {
    const text = message.params.input[0].text;
    fs.appendFileSync(path.join(log, 'inputs.jsonl'), JSON.stringify(text) + '\\n');
    turn = 'turn-' + process.pid + '-' + seq;
    out({ id: message.id, result: { turn: { id: turn } } });
    calls = take(text);
    next = 0;
    setTimeout(call, 10);
  }
  if (message.method === 'turn/steer') {
    fs.appendFileSync(path.join(log, 'steers.jsonl'), JSON.stringify(message.params.input[0].text) + '\\n');
    out({ id: message.id, result: {} });
  }
  if (message.method === 'turn/interrupt') out({ method: 'turn/completed', params: { turn: { id: turn, status: 'interrupted' } } });
});`;

interface Call {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
  /** The tool-use ID, when a test needs the same one in two processes. */
  readonly id?: string;
}

interface Fixture {
  readonly base: string;
  readonly root: string;
  lab: Lab;
  sessions: SessionPool;
  readonly quota: Quota;
  script(
    folder: string,
    turns: { when?: string; calls: Call[] }[],
  ): Promise<void>;
  inputs(folder: string): Promise<string[]>;
  lines(folder: string, file: string): Promise<unknown[]>;
  /** Close the lab and its sessions, as a stopping owner does, and start a new owner. */
  restart(): Promise<void>;
}

const timing = {
  debounceMs: 30,
  continueMs: 50,
  tickMs: 40,
  backoffMs: [60_000, 60_000, 60_000],
  retryMs: 300,
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
  });
}

async function fixture(
  t: test.TestContext,
  options: {
    readonly agents?: number;
    /** The project's memory. Its digest runs while an agent's first prompt is made. */
    readonly memory?: (sessions: SessionPool) => {
      note(who: string, text: unknown): Promise<string>;
      digest(): Promise<string>;
    };
    readonly gitignore?: string;
    /** The project's team, the main harness first: the lab's first agent plans it. */
    readonly harnesses?: readonly ('claude' | 'codex')[];
    /** One hour of a time budget, short in a test. */
    readonly hourMs?: number;
  } = {},
): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-lab-')));
  const root = join(base, 'project');
  await mkdir(root);
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'README.md'), '# Project\n');
  if (options.gitignore)
    await writeFile(join(root, '.gitignore'), options.gitignore);
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
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'start');
  await writeFile(
    join(base, 'fake-claude'),
    `#!${process.execPath}\n${claudeHost}`,
    { mode: 0o700 },
  );
  await writeFile(
    join(base, 'fake-codex'),
    `#!${process.execPath}\n${codexHost}`,
    { mode: 0o700 },
  );
  await mkdir(join(base, 'scripts'));
  const quota = new Quota(root, { graceMs: 0 });
  const owned: { lab?: Lab } = {};
  const build = (): { sessions: SessionPool; lab: Lab } => {
    const sessions = new SessionPool(root, {
      clientVersion: 'test',
      ownerId: `owner-${Math.random()}`,
      agents: options.agents ?? 3,
      executables: {
        claude: join(base, 'fake-claude'),
        codex: join(base, 'fake-codex'),
      },
      onTurnEnd: (record, outcome) => owned.lab?.turnEnded(record, outcome),
      onLimit: (host, signal) => {
        quota.record(host, signal);
        owned.lab?.limited(host, signal);
      },
      makeRoom: () => owned.lab?.yieldSlot() ?? Promise.resolve(false),
    });
    const team = options.harnesses;
    const lab = new Lab(root, {
      sessions,
      quota,
      timing: options.hourMs ? { ...timing, hourMs: options.hourMs } : timing,
      ...(options.memory ? { memory: options.memory(sessions) } : {}),
      ...(team ? { harnesses: () => Promise.resolve(team) } : {}),
    });
    owned.lab = lab;
    return { sessions, lab };
  };
  const built = build();
  const fixture: Fixture = {
    base,
    root,
    lab: built.lab,
    sessions: built.sessions,
    quota,
    script: (folder, turns) =>
      writeFile(join(base, 'scripts', `${folder}.json`), JSON.stringify(turns)),
    lines: async (folder, file) =>
      (await readFile(join(base, 'logs', folder, file), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    inputs: async (folder) =>
      (await fixture.lines(folder, 'inputs.jsonl')) as string[],
    restart: async () => {
      await fixture.lab.close();
      await fixture.sessions.close();
      const next = build();
      fixture.lab = next.lab;
      fixture.sessions = next.sessions;
      await fixture.sessions.load();
      await fixture.lab.load();
      fixture.lab.resumeAll();
    },
  };
  t.after(async () => {
    await fixture.lab.close();
    await fixture.sessions.close();
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
  });
  return fixture;
}

/** Wait until `check` holds, for at most `ms`. */
async function until(
  check: () => Promise<boolean> | boolean,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error('The condition did not hold in time.');
    await delay(20);
  }
}

/** Open directions while the lab is paused, so their IDs and post numbers are known, then resume. */
async function open(
  fixture: Fixture,
  directions: { title: string; harness: 'claude' | 'codex' }[],
): Promise<void> {
  await fixture.lab.start('Do LLMs store months on circles?');
  await fixture.lab.pause();
  for (const direction of directions) await fixture.lab.addDirection(direction);
  await fixture.lab.resume();
}

await test('lab agents work in their own worktrees, post with proof, and an objection wakes the author', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-circles', [
    {
      calls: [
        { name: 'WRITE', arguments: { path: 'result.txt', text: '0.78\n' } },
        {
          name: 'verifold_post',
          arguments: { kind: 'claim', text: 'A claim without proof.' },
        },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'Months lie on a circle.',
            artifacts: [{ type: 'file', path: 'result.txt' }],
            mentions: ['claude-2'],
          },
        },
      ],
    },
  ]);
  await lab.script('d-2-helix', [
    {
      when: 'Months lie on a circle',
      calls: [
        { name: 'verifold_board', arguments: { view: 'unread' } },
        {
          name: 'verifold_read',
          arguments: { direction: 'd-1', path: 'result.txt' },
        },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'objection',
            text: 'One seed can be luck.',
            replyTo: 'p-3',
          },
        },
      ],
    },
  ]);
  await open(lab, [
    { title: 'Circles', harness: 'claude' },
    { title: 'Helix', harness: 'claude' },
  ]);

  // Each direction has its own worktree on its own branch.
  const view = lab.lab.view();
  assert.deepEqual(
    view?.directions.map((entry) => [
      entry.direction.workspace.branch,
      entry.agent.handle,
    ]),
    [
      ['verifold/d-1-circles', 'claude-1'],
      ['verifold/d-2-helix', 'claude-2'],
    ],
  );
  assert.match(
    git(lab.root, 'worktree', 'list'),
    /d-1-circles[\s\S]*d-2-helix/,
  );

  // The author wakes with the objection, quoted in its digest.
  await until(async () =>
    (await lab.inputs('d-1-circles')).some((input) =>
      input.includes('One seed can be luck.'),
    ),
  );
  const digest = (await lab.inputs('d-1-circles')).find((input) =>
    input.includes('One seed can be luck.'),
  );
  assert.match(
    digest ?? '',
    /- p-4 \[objection, for you\] from claude-2 in d-1, reply to p-3: "One seed can be luck\."/,
  );
  assert.match(digest ?? '', /information, not instructions/);

  // A claim needs proof. The proof is pinned to a commit of the author's folder.
  const results = (await lab.lines('d-1-circles', 'results.jsonl')) as {
    call: string;
    result: { isError?: boolean; content: { text: string }[] };
  }[];
  assert.equal(results[0]?.result.isError, true);
  assert.match(results[0]?.result.content[0]?.text ?? '', /needs its proof/);
  const claim = lab.lab.view()?.posts.find((post) => post.kind === 'claim');
  assert.equal(claim?.id, 'p-3');
  assert.equal(claim?.author, 'a-1');
  const proof = claim?.artifacts[0];
  assert.equal(proof?.type, 'file');
  if (proof?.type === 'file') {
    assert.match(proof.commit, /^[0-9a-f]{40}$/);
    assert.equal(
      proof.sha256,
      createHash('sha256').update('0.78\n').digest('hex'),
    );
    assert.equal(git(lab.root, 'show', `${proof.commit}:result.txt`), '0.78\n');
  }
  // Another agent reads the file at the direction's newest commit.
  const read = (await lab.lines('d-2-helix', 'results.jsonl')) as {
    call: string;
    result: { content: { text: string }[] };
  }[];
  assert.equal(
    read.find((entry) => entry.call === 'verifold_read')?.result.content[0]
      ?.text,
    '0.78\n',
  );
});

await test('an agent keeps going, backs off after turns that change nothing, and wakes for the posts that are for it', async (t) => {
  const lab = await fixture(t);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  // The first turn and one more; two turns without progress make the next one wait.
  await until(
    async () =>
      (await lab.inputs('d-1-alpha')).length === 2 &&
      (await lab.inputs('d-2-beta')).length === 2,
  );
  assert.match(
    (await lab.inputs('d-1-alpha'))[1] ?? '',
    /Your last turn ended\./,
  );
  await delay(300);
  assert.equal((await lab.inputs('d-1-alpha')).length, 2);
  assert.equal(lab.lab.view()?.directions[0]?.agent.idleStreak, 2);

  // A mention wakes that agent only.
  await lab.lab.post({ text: '@claude-1 look at layer 12.' });
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 3);
  assert.match(
    (await lab.inputs('d-1-alpha'))[2] ?? '',
    /from the person: "@claude-1 look at layer 12\."/,
  );
  await delay(300);
  assert.equal((await lab.inputs('d-2-beta')).length, 2);

  // A post from the person to nobody in particular wakes every agent.
  await lab.lab.post({ text: 'Everyone: write down your bar.' });
  await until(
    async () =>
      (await lab.inputs('d-1-alpha')).length >= 4 &&
      (await lab.inputs('d-2-beta')).length >= 3,
  );
  // The mention reached claude-2 too, as an unread post in its next digest, after the post that woke it.
  assert.match(
    (await lab.inputs('d-2-beta'))[2] ?? '',
    /\[question, for you\] from the person: "Everyone: write down your bar[\s\S]*look at layer 12/,
  );
});

await test('the person steers a running turn, and the post does not come again in the next digest', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [{ calls: [{ name: 'WAIT' }] }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length === 1);
  await lab.lab.post({ text: 'Use 3 seeds.' });
  await until(
    async () => (await lab.lines('d-1-alpha', 'steers.jsonl')).length === 1,
  );
  assert.match(
    String((await lab.lines('d-1-alpha', 'steers.jsonl'))[0]),
    /from the person: "Use 3 seeds\."/,
  );
  await until(async () => (await lab.inputs('d-1-alpha')).length === 2);
  assert.doesNotMatch((await lab.inputs('d-1-alpha'))[1] ?? '', /Use 3 seeds/);
});

await test('with no free slot, an idle agent parks for a new one, and resumes when a post wakes it', async (t) => {
  const lab = await fixture(t, { agents: 2 });
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
    { title: 'Gamma', harness: 'claude' },
  ]);
  // Two agents run, and the third waits for a slot until an idle agent parks.
  await until(async () => (await lab.inputs('d-3-gamma')).length === 2);
  const parked = await Promise.all(
    (lab.lab.view()?.directions ?? []).map(async (entry) =>
      entry.agent.session
        ? (await readRecord(lab.root, entry.agent.session))?.status
        : null,
    ),
  );
  assert.ok(parked.includes('paused'), `statuses: ${parked.join(', ')}`);
  const sleeper = (lab.lab.view()?.directions ?? []).find(
    (entry, index) => parked[index] === 'paused',
  );
  assert.ok(sleeper);
  const folder = sleeper.direction.workspace.path.split('/').at(-1) ?? '';
  const before = (await lab.inputs(folder)).length;
  assert.equal(before, 2);
  // A mention wakes the parked agent. It resumes its conversation and reads the post.
  await lab.lab.post({ text: `@${sleeper.agent.handle} wake up.` });
  await until(async () => (await lab.inputs(folder)).length === before + 1);
  assert.match((await lab.inputs(folder)).at(-1) ?? '', /wake up\./);
  assert.ok(
    ((await lab.lines(folder, 'launches.jsonl')) as string[]).includes(
      'resume',
    ),
  );
  // It resumed in the slot that held its record, so no session shows twice.
  const ids = lab.sessions.views().map((view) => view.record.id);
  assert.equal(new Set(ids).size, ids.length);
});

await test('after a restart each agent resumes its session with a digest, and no post comes twice', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'question',
            text: 'Which layer?',
            mentions: ['codex-1'],
          },
        },
      ],
    },
  ]);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'codex' },
  ]);
  await until(async () =>
    (await lab.inputs('d-2-beta')).some((input) =>
      input.includes('Which layer?'),
    ),
  );
  await until(async () => (await lab.inputs('d-2-beta')).length >= 2);
  await delay(200);
  await lab.restart();
  const restarted = async (folder: string): Promise<string | undefined> =>
    (await lab.inputs(folder)).find((input) =>
      input.includes('Verifold restarted'),
    );
  await until(
    async () =>
      (await restarted('d-1-alpha')) !== undefined &&
      (await restarted('d-2-beta')) !== undefined,
  );
  assert.ok(
    ((await lab.lines('d-1-alpha', 'launches.jsonl')) as string[]).includes(
      'resume',
    ),
  );
  assert.deepEqual(
    (
      (await lab.lines('d-2-beta', 'threads.jsonl')) as { method: string }[]
    ).map((entry) => entry.method),
    ['start', 'resume'],
  );
  assert.doesNotMatch((await restarted('d-2-beta')) ?? '', /Which layer\?/);
});

await test('a used-up usage window parks that harness only, and its agents resume after the reset', async (t) => {
  const lab = await fixture(t);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'codex' },
  ]);
  await until(
    async () =>
      (await lab.inputs('d-1-alpha')).length === 2 &&
      (await lab.inputs('d-2-beta')).length === 2,
  );
  lab.quota.record('claude', {
    exhausted: true,
    resetsAt: new Date(Date.now() + 1500).toISOString(),
    usedPercent: 100,
    window: 'five_hour',
  });
  await until(() => lab.lab.view()?.directions[0]?.status === 'usage');
  await lab.lab.post({ text: 'News for everyone.' });
  // The post reaches the Codex agent, in a new turn or in the running one.
  await until(async () =>
    [
      ...(await lab.inputs('d-2-beta')),
      ...((await lab.lines('d-2-beta', 'steers.jsonl')) as string[]),
    ].some((input) => input.includes('News for everyone.')),
  );
  assert.equal((await lab.inputs('d-1-alpha')).length, 2);
  // After the reset, the Claude Code agent resumes and reads what it missed.
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 3, 8000);
  assert.match(
    (await lab.inputs('d-1-alpha'))[2] ?? '',
    /usage window reset[\s\S]*News for everyone/,
  );
});

await test('an agent whose process stops by itself starts again, twice an hour at most', async (t) => {
  const lab = await fixture(t);
  // Each stop of a new conversation counts. A resumed one that stops before
  // its first turn ends does not count: the next start is new.
  await lab.script(
    'd-1-alpha',
    Array.from({ length: 5 }, () => ({ calls: [{ name: 'EXIT' }] })),
  );
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length === 1);
  const first = Date.now();
  // A restart waits first: 300 ms in the tests, doubled after each stop.
  await until(async () => (await lab.inputs('d-1-alpha')).length === 2);
  assert.ok(
    Date.now() - first >= 250,
    `restarted after ${Date.now() - first} ms`,
  );
  await until(() => lab.lab.view()?.directions[0]?.status === 'crashed');
  assert.equal((await lab.inputs('d-1-alpha')).length, 5);
  assert.equal(lab.lab.view()?.directions[0]?.agent.restarts.length, 3);
  assert.deepEqual(await lab.lines('d-1-alpha', 'launches.jsonl'), [
    'start',
    'resume',
    'start',
    'resume',
    'start',
  ]);
  // Start again begins a new conversation.
  await lab.lab.restartAgent('a-1');
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 6);
  assert.equal(
    (await lab.lines('d-1-alpha', 'launches.jsonl')).at(-1),
    'start',
  );
  assert.match((await lab.inputs('d-1-alpha'))[5] ?? '', /The question:/);
});

await test('a conversation that the harness cannot resume starts new at once, and its stop does not count', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [{ calls: [{ name: 'EXIT' }] }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  // The first turn's process stops. From now on a resume stops at once.
  await until(
    () => (lab.lab.view()?.directions[0]?.agent.restarts.length ?? 0) === 1,
  );
  await writeFile(join(lab.base, 'resume-fails'), '');
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 2, 8000);
  assert.deepEqual(await lab.lines('d-1-alpha', 'launches.jsonl'), [
    'start',
    'resume',
    'start',
  ]);
  assert.match((await lab.inputs('d-1-alpha'))[1] ?? '', /The question:/);
  assert.equal(lab.lab.view()?.directions[0]?.agent.restarts.length, 1);
  assert.notEqual(lab.lab.view()?.directions[0]?.status, 'crashed');
});

await test('lab agents run with the strict limits and without RunPod or pod secret variables', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'verifold-home-')));
  await mkdir(join(home, '.verifold', 'credentials'), { recursive: true });
  await writeFile(
    join(home, '.verifold', 'credentials', 'secret-HF_TOKEN.json'),
    '{}',
  );
  const saved = {
    HOME: process.env.HOME,
    HF_TOKEN: process.env.HF_TOKEN,
    RUNPOD_API_KEY: process.env.RUNPOD_API_KEY,
  };
  t.after(async () => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await rm(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.HF_TOKEN = 'hf-secret-value';
  process.env.RUNPOD_API_KEY = 'runpod-secret-value';
  const lab = await fixture(t);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'codex' },
  ]);
  await until(
    async () =>
      (await lab.inputs('d-1-alpha')).length >= 1 &&
      (await lab.inputs('d-2-beta')).length >= 1,
  );
  for (const folder of ['d-1-alpha', 'd-2-beta']) {
    const env = JSON.parse(
      await readFile(join(lab.base, 'logs', folder, 'env.json'), 'utf8'),
    ) as Record<string, string>;
    assert.equal(env.HF_TOKEN, undefined, folder);
    assert.equal(env.RUNPOD_API_KEY, undefined, folder);
  }
  const args = JSON.parse(
    await readFile(join(lab.base, 'logs', 'd-1-alpha', 'args.json'), 'utf8'),
  ) as string[];
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}') as {
    sandbox: { filesystem: { denyRead: string[] } };
  };
  assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.ssh'));
  const thread = (
    (await lab.lines('d-2-beta', 'threads.jsonl')) as {
      params: {
        cwd: string;
        approvalPolicy: string;
        config: {
          default_permissions: string;
          permissions: Record<string, { filesystem: Record<string, string> }>;
        };
        dynamicTools: { name: string }[];
      };
    }[]
  )[0]?.params;
  assert.equal(thread?.approvalPolicy, 'never');
  assert.equal(thread?.config.default_permissions, 'verifold-strict');
  assert.equal(
    thread?.config.permissions['verifold-strict']?.filesystem['~/.ssh'],
    'deny',
  );
  assert.equal(thread?.cwd, join(lab.root, '.verifold/workspaces/d-2-beta'));
  assert.deepEqual(
    thread?.dynamicTools.map((tool) => tool.name),
    ['verifold_board', 'verifold_post', 'verifold_read'],
  );
});

await test('start over moves the lab and its board into the archive', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('A question.');
  await lab.lab.post({ text: 'A first post.' });
  await lab.lab.close();
  assert.ok(await archiveRun(lab.root));
  const left = await readdir(join(lab.root, '.verifold'));
  for (const part of ['lab.json', 'lab', 'board'])
    assert.ok(!left.includes(part), part);
  const reloaded = new Lab(lab.root, { sessions: lab.sessions, timing });
  await reloaded.load();
  assert.equal(reloaded.exists, false);
});

await test('the person cannot open more directions than the limit, or post as an agent', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('A question.');
  await lab.lab.pause();
  for (let index = 0; index < 6; index++)
    await lab.lab.addDirection({ title: `Line ${index}`, harness: 'claude' });
  await assert.rejects(
    lab.lab.addDirection({ title: 'One more', harness: 'claude' }),
    /6 directions are open/,
  );
  await assert.rejects(
    lab.lab.post({ text: 'A claim.', kind: 'claim' }),
    /message or an objection/,
  );
  await assert.rejects(
    lab.lab.post({ text: '@codex-9 hello' }),
    /No agent of the lab has the handle codex-9/,
  );
});

await test('the desk offers the lab, shows posts escaped, and takes lab actions only with its token', async (t) => {
  const lab = await fixture(t);
  const assets = join(lab.base, 'assets');
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
  const tasks = new TaskManager(lab.root, {
    ownerId: 'owner-1',
    sessions: lab.sessions,
  });
  const stop = new AbortController();
  const desk = await startDesk(
    lab.root,
    stop.signal,
    pathToFileURL(`${assets}/cli/`),
    lab.sessions,
    undefined,
    undefined,
    tasks,
    undefined,
    undefined,
    undefined,
    { lab: lab.lab },
  );
  t.after(async () => {
    stop.abort();
    await desk.closed;
  });
  const url = new URL(desk.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const post = async (
    body: unknown,
    authorized = true,
  ): Promise<[number, Record<string, unknown>]> => {
    const response = await fetch(`${url.origin}/api/action`, {
      method: 'POST',
      headers: {
        ...(authorized ? headers : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return [
      response.status,
      (await response.json().catch(() => ({}))) as Record<string, unknown>,
    ];
  };
  const home = async (): Promise<string> =>
    (
      (await (
        await fetch(`${url.origin}/api/view?view=home`, { headers })
      ).json()) as { html: string }
    ).html;

  // A slow lab action answers at once or goes on in the background, so the
  // test waits for its result, not for one answer.
  const slow = async (
    body: Record<string, unknown>,
    done: () => boolean,
  ): Promise<void> => {
    const [status, reply] = await post(body);
    if (status === 202) assert.deepEqual(reply, { ok: true, pending: true });
    else assert.equal(status, 200);
    await until(done);
  };
  // A project with no team at work offers the lab on Home.
  assert.match(await home(), /data-action="lab-start"/);
  // A desk that runs one session never offers the lab: it could not start one.
  const viewer = new Lab(lab.root, {
    sessions: lab.sessions,
    timing,
    runs: false,
  });
  await viewer.load();
  const quietStop = new AbortController();
  const quiet = await startDesk(
    lab.root,
    quietStop.signal,
    pathToFileURL(`${assets}/cli/`),
    lab.sessions,
    undefined,
    undefined,
    tasks,
    undefined,
    undefined,
    undefined,
    { lab: viewer },
  );
  t.after(async () => {
    quietStop.abort();
    await quiet.closed;
    await viewer.close();
  });
  const quietUrl = new URL(quiet.url);
  const quietHome = (
    (await (
      await fetch(`${quietUrl.origin}/api/view?view=home`, {
        headers: { Authorization: `Bearer ${quietUrl.hash.slice(1)}` },
      })
    ).json()) as { html: string }
  ).html;
  assert.doesNotMatch(quietHome, /data-action="lab-start"/);
  assert.equal(
    (await post({ action: 'lab-start', question: 'Q?' }, false))[0],
    401,
  );
  await slow(
    { action: 'lab-start', question: 'Do months lie on a circle?' },
    () => lab.lab.exists,
  );
  assert.deepEqual(await post({ action: 'lab-start', question: 'Again' }), [
    409,
    { error: 'The lab already runs.' },
  ]);
  const view = await home();
  assert.match(view, /<h1 id="view-title" tabindex="-1">Lab<\/h1>/);
  // A lab run offers no research step, no coordinator, and no new task.
  const page = async (name: string): Promise<string> =>
    (
      (await (
        await fetch(`${url.origin}/api/view?view=${name}`, { headers })
      ).json()) as { html: string }
    ).html;
  const plan = await page('research');
  assert.match(plan, /A lab works on this run/);
  assert.doesNotMatch(plan, /data-action="research"/);
  assert.doesNotMatch(await page('tasks'), /Open the coordinator/);
  assert.match(view, /Do months lie on a circle\?/);
  // In a lab, Home's one box posts to the board: no Research or coordinator recipient.
  assert.doesNotMatch(view, /id="message-text"/);
  assert.match(view, /id="lab-text"/);

  // Agent and person text is escaped. A mention of an unknown handle is refused.
  await lab.lab.pause();
  await slow(
    { action: 'lab-direction-add', title: 'Circles', harness: 'claude' },
    () => lab.lab.view()?.directions.length === 1,
  );
  assert.equal(
    (
      await post({
        action: 'lab-post',
        text: '<img src=x onerror=alert(1)> @claude-1 look here',
      })
    )[0],
    200,
  );
  assert.deepEqual(lab.lab.view()?.posts.at(-1)?.mentions, ['a-1']);
  assert.equal(
    (await post({ action: 'lab-post', text: '@codex-4 hello' }))[0],
    409,
  );
  const board = await home();
  assert.match(board, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(board, /<img/);
  assert.match(board, /claude-1 <span class="fine">Claude Code<\/span>/);
  assert.match(
    board,
    /data-action="lab-direction-stop" data-lab-direction="d-1"/,
  );
  // The page opens an item on a click of these attributes before it sends an
  // action, so no lab control may carry one.
  const controls =
    board.match(/<button[^>]*data-action="lab-[^"]*"[^>]*>/g) ?? [];
  assert.ok(controls.length >= 4);
  for (const control of controls)
    assert.doesNotMatch(
      control,
      / data-(direction|view|panel|task-select|worker|attempt|message-to|dock|diff)=/,
      control,
    );
  // A request that comes again with its key runs once.
  const before = lab.lab.view()?.posts.length ?? 0;
  const key = 'a1'.repeat(16);
  assert.equal(
    (await post({ action: 'lab-post', text: 'Once.', key }))[0],
    200,
  );
  assert.equal(
    (await post({ action: 'lab-post', text: 'Once.', key }))[0],
    200,
  );
  assert.equal(lab.lab.view()?.posts.length, before + 1);
  // A refused action keeps no answer under its key.
  const refused = 'b2'.repeat(16);
  for (let index = 0; index < 2; index++)
    assert.equal(
      (await post({ action: 'lab-post', text: '@codex-4 x', key: refused }))[0],
      409,
    );
  // Each desk keeps its own keys: the same key on another desk is a new action.
  const other = await startDesk(
    lab.root,
    stop.signal,
    pathToFileURL(`${assets}/cli/`),
    lab.sessions,
    undefined,
    undefined,
    tasks,
    undefined,
    undefined,
    undefined,
    { lab: lab.lab },
  );
  t.after(async () => {
    stop.abort();
    await other.closed;
  });
  const second = new URL(other.url);
  assert.equal(
    (
      await fetch(`${second.origin}/api/action`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${second.hash.slice(1)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'lab-post', text: 'Once.', key }),
      })
    ).status,
    200,
  );
  assert.equal(lab.lab.view()?.posts.length, before + 2);
  // The person's objection keeps its kind and wakes the direction's agent.
  assert.equal(
    (
      await post({
        action: 'lab-post',
        text: 'Not convinced.',
        kind: 'objection',
        direction: 'd-1',
      })
    )[0],
    200,
  );
  assert.equal(lab.lab.view()?.posts.at(-1)?.kind, 'objection');
  // The reply line, with its control to stop replying, waits hidden until a Reply.
  assert.match(
    await home(),
    /<p class="lab-replying" id="lab-replying" hidden>[\s\S]*data-action="lab-reply-clear"/,
  );
  assert.equal(
    (await post({ action: 'lab-direction-stop', direction: 'd-1' }))[0],
    200,
  );
  assert.match(await home(), /<span class="status">Stopped<\/span>/);
});

await test('one run has one team: research, the coordinator, tasks, and a lab keep apart', async (t) => {
  const lab = await fixture(t);
  let busy = false;
  // The guard keeps no state: it asks the owners each time.
  const owned: { lab?: Lab; coordinator?: Coordinator; tasks?: TaskManager } =
    {};
  const team = new RunTeam({
    lab: () => owned.lab?.exists ?? false,
    coordinator: async () =>
      Boolean(
        owned.coordinator?.view()?.state || (await owned.tasks?.list())?.length,
      ),
    researchBusy: () => busy,
  });
  // A research step that runs keeps the lab out, and the lab never cancels it.
  busy = true;
  assert.match((await team.refusal('lab')) ?? '', /Research is running/);
  busy = false;
  const tasks = new TaskManager(lab.root, {
    ownerId: 'owner-1',
    sessions: lab.sessions,
    team,
  });
  const coordinator = new Coordinator(lab.root, {
    tasks,
    sessions: new SessionManager(lab.root, {
      clientVersion: 'test',
      ownerId: 'owner-1',
      executables: { claude: join(lab.base, 'fake-claude') },
    }),
    team,
  });
  const shared = new Lab(lab.root, { sessions: lab.sessions, timing, team });
  Object.assign(owned, { lab: shared, coordinator, tasks });
  t.after(() => shared.close());
  // A lab start that fails its own check leaves the run free.
  await assert.rejects(shared.start(''), /Write the question/);
  assert.equal(await team.refusal('lab'), null);
  assert.equal(await team.refusal('coordinator'), null);
  // The lab and the coordinator start at the same time: the first one under the lock wins, and the other is refused.
  const [started, led] = await Promise.allSettled([
    shared.start('A question.'),
    coordinator.start({ objective: 'Go.', host: 'claude', guided: true }),
  ]);
  assert.equal(started.status, 'fulfilled');
  assert.equal(led.status, 'rejected');
  assert.match(
    String(led.status === 'rejected' ? led.reason : ''),
    /A lab works on this run/,
  );
  assert.equal(await team.refusal('lab'), 'The lab already runs.');
  // No task, research step, or research message works on a lab's run.
  await assert.rejects(
    tasks.create({
      title: 'A task',
      objective: 'Do it.',
      writable: ['notes'],
      output: 'notes/out.md',
      host: 'claude',
    }),
    /A lab works on this run/,
  );
  const research = new ResearchRunner(lab.root, {
    signal: new AbortController().signal,
    io: {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
    },
    team,
    inbox: {
      post: () => Promise.reject(new Error('A message was saved.')),
      take: () => Promise.resolve([]),
    },
  });
  await assert.rejects(research.start({ topic: 'More.' }), /A lab works/);
  await assert.rejects(research.select('idea-1'), /A lab works/);
  await assert.rejects(research.message('Hello.'), /A lab works/);
  assert.equal(research.busy, false);
  // A run that the coordinator's team owns keeps the lab out.
  const other = new RunTeam({
    lab: () => false,
    coordinator: () => Promise.resolve(true),
    researchBusy: () => false,
  });
  assert.match((await other.refusal('lab')) ?? '', /coordinator's team/);
  // Only a lab start reads the coordinator's records: the others need only the lab's.
  let reads = 0;
  const counted = new RunTeam({
    lab: () => false,
    coordinator: () => {
      reads += 1;
      return Promise.resolve(false);
    },
    researchBusy: () => false,
  });
  await counted.refusal('coordinator');
  await counted.refusal('research');
  assert.equal(reads, 0);
  await counted.refusal('lab');
  assert.equal(reads, 1);
});

await test('a lab start that failed in the background shows on Home, and a running open marks itself for the page', async (t) => {
  const lab = await fixture(t);
  const at = new Date().toISOString();
  const snapshot = await readDeskSnapshot(lab.root);
  // The offer can be gone, for example when research took the run meanwhile: the failure still shows.
  const home = renderDesk(snapshot, undefined, null, {
    session: null,
    controllable: true,
    labCanStart: false,
    labWorks: [
      {
        action: 'lab-start',
        label: 'Starting the lab',
        at,
        error: 'Research is running.',
      },
    ],
  }).html;
  assert.match(
    home,
    /data-lab-failed="lab-start">Starting the lab did not finish: Research is running\./,
  );
  assert.doesNotMatch(home, /data-action="lab-start"/);
  // The page clears the open form once this mark is gone and no failure shows.
  await lab.lab.start('A question.');
  const opening = renderDesk(snapshot, undefined, null, {
    session: null,
    controllable: true,
    lab: lab.lab.view(),
    labWorks: [
      {
        action: 'lab-direction-add',
        label: 'Opening "Alpha"',
        at,
        error: null,
      },
    ],
  }).html;
  assert.match(
    opening,
    /data-lab-work="lab-direction-add">Opening (&quot;|")Alpha/,
  );
});

await test('two research messages at once start one step, and neither is refused', async (t) => {
  const lab = await fixture(t);
  await changeWorkspace(lab.root, (current) => ({
    ...current!,
    research: { topic: 'Q?', autonomy: 'guided', phase: 'needs-plan' },
  }));
  const posted: unknown[] = [];
  let starts = 0;
  const research: ResearchRunner = new ResearchRunner(lab.root, {
    signal: new AbortController().signal,
    io: {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
    },
    team: new RunTeam({
      lab: () => false,
      coordinator: () => Promise.resolve(false),
      researchBusy: () => research.busy,
    }),
    // The step fails at once: this test needs only how it starts.
    harness: () => {
      starts += 1;
      return Promise.reject(new Error('No harness in this test.'));
    },
    inbox: {
      post: (text) => {
        posted.push(text);
        return Promise.resolve();
      },
      take: () => Promise.resolve([]),
    },
  });
  await Promise.all([research.message('First.'), research.message('Second.')]);
  await research.settled();
  // Both messages wait for research, in whichever order they arrived.
  assert.deepEqual([...posted].sort(), ['First.', 'Second.']);
  assert.ok(starts <= 1, `${starts} steps started`);
});

await test('Home in a lab still shows what needs the person, and the transcript of each agent', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [{ calls: [{ name: 'WAIT' }] }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length === 1);
  const at = new Date().toISOString();
  const worker = {
    live: true,
    saveFailed: false,
    record: {
      id: '20261002T120000000Z-abcdef12',
      host: 'claude',
      status: 'running',
      mode: 'ask',
      reportedMode: null,
      model: null,
      costUsd: null,
      nativeSessionId: null,
      startedAt: at,
      events: [],
      commands: [],
      requests: [
        {
          id: 'R1',
          native: 'n-1',
          tool: 'Bash',
          action: 'curl -sI https://example.org',
          at,
        },
      ],
    },
  };
  const html = renderDesk(await readDeskSnapshot(lab.root), undefined, null, {
    session: worker,
    workers: [worker],
    controllable: true,
    lab: lab.lab.view(),
  } as never).html;
  assert.match(html, /<h1 id="view-title" tabindex="-1">Lab<\/h1>/);
  assert.match(html, /Claude Code session asks to use Bash/);
  // Home's one box posts to the board. The permission request is answered in its card.
  assert.doesNotMatch(html, /id="message-text"/);
  assert.match(html, /data-action="answer" data-request="R1"/);
  const session = lab.lab.view()?.directions[0]?.agent.session ?? '';
  assert.match(
    html,
    new RegExp(
      `<summary>What claude-1 did</summary><div class="transcript-slot" data-source="session:${session}"`,
    ),
  );
});

await test('proof in a folder that the project ignores is pinned, and a turn that changes nothing adds no commit', async (t) => {
  const lab = await fixture(t, { gitignore: 'results/\n' });
  await lab.script('d-1-circles', [
    {
      calls: [
        { name: 'WRITE', arguments: { path: 'results/fig.png', text: 'PNG' } },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'Months lie on a circle.',
            artifacts: [{ type: 'figure', path: 'results/fig.png' }],
          },
        },
      ],
    },
  ]);
  await open(lab, [
    { title: 'Circles', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  await until(
    () => lab.lab.view()?.posts.some((post) => post.kind === 'claim') ?? false,
  );
  const proof = lab.lab.view()?.posts.find((post) => post.kind === 'claim')
    ?.artifacts[0];
  assert.equal(proof?.type, 'figure');
  if (proof?.type === 'figure')
    assert.equal(
      git(lab.root, 'show', `${proof.commit}:results/fig.png`),
      'PNG',
    );
  // Beta changes nothing in two turns, so its branch keeps its start commit.
  await until(() => lab.lab.view()?.directions[1]?.agent.idleStreak === 2);
  const beta = lab.lab.view()?.directions[1]?.direction;
  assert.equal(
    git(lab.root, 'rev-parse', beta?.workspace.branch ?? '').trim(),
    beta?.workspace.start,
  );
  assert.equal(beta?.head, beta?.workspace.start);
});

await test('a post whose turn ran into a used-up usage window comes again after the reset', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    { calls: [] },
    { when: 'check layer 12', calls: [{ name: 'WAIT' }] },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  // Two turns without progress: the next one waits, so only the post wakes the agent.
  await until(
    () =>
      lab.lab.view()?.directions[0]?.agent.idleStreak === 2 &&
      lab.lab.view()?.directions[0]?.status === 'idle',
  );
  await lab.lab.post({ text: '@claude-1 check layer 12.' });
  await until(async () => (await lab.inputs('d-1-alpha')).length === 3);
  const signal = {
    exhausted: true,
    resetsAt: new Date(Date.now() + 1200).toISOString(),
    usedPercent: 100,
    window: 'five_hour',
  };
  lab.quota.record('claude', signal);
  lab.lab.limited('claude', signal);
  // A second post goes into the waiting turn, which then ends.
  await lab.lab.post({ text: 'Thanks.' });
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 4, 8000);
  const again = (await lab.inputs('d-1-alpha'))[3] ?? '';
  assert.match(again, /check layer 12/);
  assert.match(again, /usage window ran out/);
  // The turn did no work, so the post steered into it comes again too.
  assert.match(again, /Thanks\./);
});

await test('start over parks the lab, a restore brings it back paused, and a new lab never reuses a folder', async (t) => {
  const lab = await fixture(t);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  await lab.lab.suspend();
  // A suspended lab takes no change, so nothing lands in the files that move.
  await assert.rejects(lab.lab.post({ text: 'Late.' }), /moving the lab/);
  const archive = await archiveRun(lab.root);
  await delay(200);
  const left = await readdir(join(lab.root, '.verifold'));
  for (const part of ['lab.json', 'lab', 'board'])
    assert.ok(!left.includes(part), part);
  await lab.lab.reload();
  await lab.sessions.forget();
  assert.equal(lab.lab.exists, false);
  // A new lab opens Alpha again. Its folder and branch get a new number.
  await lab.lab.start('Another question.');
  assert.equal(
    await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' }),
    'd-2',
  );
  await until(async () => (await lab.inputs('d-2-alpha')).length >= 1);
  // Restore the first run: it comes back paused, and resumes when the person resumes it.
  await lab.lab.suspend();
  await restoreRun(lab.root, archive);
  await lab.lab.reload();
  await lab.sessions.forget();
  assert.equal(
    lab.lab.view()?.state.question,
    'Do LLMs store months on circles?',
  );
  assert.ok(lab.lab.view()?.state.pausedAt);
  assert.equal(lab.lab.view()?.directions[0]?.agent.direction, 'd-1');
  const before = (await lab.inputs('d-1-alpha')).length;
  await lab.lab.resume();
  await until(
    async () =>
      (await lab.inputs('d-1-alpha'))
        .slice(before)
        .some((input) => input.includes('The person resumed the lab')),
    20_000,
  );
});

await test('an agent whose start finds the pool full waits for a slot, and no failure counts', async (t) => {
  let person: string | undefined;
  const lab = await fixture(t, {
    agents: 1,
    // The person's session takes the only slot while the agent's first prompt is made.
    memory: (sessions) => ({
      note: () => Promise.resolve('Noted.'),
      digest: async () => {
        person ??= await sessions.start({
          host: 'claude',
          mode: 'ask',
          prompt: 'Hello.',
        });
        return '';
      },
    }),
  });
  await lab.lab.start('A question.');
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  await until(() => person !== undefined);
  await delay(400);
  const waiting = lab.lab.view()?.directions[0];
  assert.equal(waiting?.status, 'slot');
  assert.deepEqual(waiting?.agent.restarts, []);
  assert.equal((await lab.inputs('d-1-alpha')).length, 0);
  lab.sessions.end(person);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
});

await test('an agent cannot mention all, and the terminal and cancel leave lab agents alone', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_post',
          arguments: { kind: 'question', text: 'Anyone?', mentions: ['all'] },
        },
        { name: 'WAIT' },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(
    async () => (await lab.lines('d-1-alpha', 'results.jsonl')).length === 1,
  );
  const [result] = (await lab.lines('d-1-alpha', 'results.jsonl')) as {
    result: { isError?: boolean; content: { text: string }[] };
  }[];
  assert.equal(result?.result.isError, true);
  assert.match(
    result?.result.content[0]?.text ?? '',
    /Mention agents by handle/,
  );
  const session = lab.lab.view()?.directions[0]?.agent.session ?? '';
  assert.throws(() => lab.sessions.cancel(session), /agent of the lab/);
  const lines: string[] = [];
  const io = {
    interactive: true,
    out: () => {},
    progress: (line: string) => lines.push(line),
  } as unknown as CliIO;
  terminalInput(lab.sessions, '/cancel', io, {
    open: () => {},
    host: 'claude',
  });
  terminalInput(lab.sessions, 'Hello?', io, { open: () => {}, host: 'claude' });
  assert.deepEqual(lines, [
    'Nothing is running.',
    'No session is running, so this text went nowhere. Type /start and a request, or type /open and start a session in the desk.',
  ]);
  assert.equal(lab.lab.view()?.directions[0]?.status, 'working');
});

await test('the lab view puts the newest activity first, and a crashed agent can be stopped', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('A question.');
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  await lab.lab.addDirection({ title: 'Beta', harness: 'claude' });
  const first = await lab.lab.post({ text: 'Old point.', direction: 'd-1' });
  await lab.lab.post({ text: 'Newer point.', direction: 'd-2' });
  // A reply to the old point is the newest activity, so Alpha comes first.
  await lab.lab.post({ text: 'A reply.', replyTo: first.id });
  const view = lab.lab.view();
  assert.ok(view);
  const crashed = {
    ...view,
    directions: view.directions.map((entry, index) =>
      index === 0 ? { ...entry, status: 'crashed' as const } : entry,
    ),
  };
  const html = renderLab(
    crashed,
    (value) => value,
    () => '',
  );
  assert.ok(
    html.indexOf('aria-label="Alpha"') < html.indexOf('aria-label="Beta"'),
  );
  const row = html.slice(
    html.indexOf('<li class="lab-direction">'),
    html.indexOf('</li>'),
  );
  assert.match(row, /Stopped by itself 3 times in an hour/);
  assert.match(row, /data-action="lab-agent-restart"/);
  assert.match(
    row,
    /data-action="lab-direction-stop" data-lab-direction="d-1"/,
  );
  // Each row has one shape: its text, agent, state, controls, then its transcript.
  assert.match(
    row,
    /^<li class="lab-direction"><div class="lab-direction-text">[\s\S]*<\/div><span class="lab-agent">[\s\S]*<\/span><span class="status[^"]*">[^<]*<\/span><span class="lab-controls">/,
  );
  // The hourly turns come from the lab's limit.
  const hourly = labLimits.wakeupsPerHour;
  labLimits.wakeupsPerHour = 7;
  t.after(() => {
    labLimits.wakeupsPerHour = hourly;
  });
  const waiting = renderLab(
    {
      ...view,
      directions: view.directions.map((entry) => ({
        ...entry,
        status: 'turns' as const,
        until: '10:00',
      })),
    },
    (value) => value,
    () => '',
  );
  assert.match(waiting, /Waits until 10:00: 7 turns an hour/);
});

/** The lab's tool calls and its newest-commit rule, which these tests reach past `private`. */
interface LabInside {
  call(
    id: string,
    generation: string,
    name: string,
    input: unknown,
    callId: string,
  ): Promise<{ readonly ok: boolean; readonly text: string }>;
  setHead(
    direction: unknown,
    made: { readonly commit: string; readonly order: number },
  ): Promise<boolean>;
  update(
    id: string,
    change: (agent: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
  begin(id: string, read: null): void;
  rt(id: string): {
    turning: boolean;
    turn: number;
    launch: {
      readonly at: number;
      turns: number;
      readonly resumed: boolean;
    } | null;
  };
}

await test('directions take turns when they outnumber the slots, and an agent at its hourly turns gives its slot', async (t) => {
  const hourly = labLimits.wakeupsPerHour;
  labLimits.wakeupsPerHour = 1;
  t.after(() => {
    labLimits.wakeupsPerHour = hourly;
  });
  const lab = await fixture(t, { agents: 1 });
  // Each turn changes a file, so neither agent waits after turns without progress.
  const work = (name: string): { calls: Call[] }[] =>
    [1, 2, 3].map((turn) => ({
      calls: [
        {
          name: 'WRITE',
          arguments: { path: `${name}-${turn}.txt`, text: `${turn}\n` },
        },
      ],
    }));
  await lab.script('d-1-alpha', work('alpha'));
  await lab.script('d-2-beta', work('beta'));
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  // Both directions get their first prompt and one digest with one slot,
  // although each agent changes a file in every turn.
  await until(
    async () =>
      (await lab.inputs('d-1-alpha')).length >= 2 &&
      (await lab.inputs('d-2-beta')).length >= 2,
  );
  // One digest an hour: each agent waits for its turns and does not start again.
  await until(
    () =>
      lab.lab.view()?.directions.some((entry) => entry.status === 'turns') ??
      false,
  );
  const counts = async (): Promise<number[]> => [
    (await lab.inputs('d-1-alpha')).length,
    (await lab.inputs('d-2-beta')).length,
  ];
  const before = await counts();
  await delay(500);
  assert.deepEqual(await counts(), before);
});

await test('a turn whose process stops brings its posts again, and the resumed conversation reads them', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    { calls: [] },
    { when: 'check layer 12', calls: [{ name: 'EXIT' }] },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  // Two turns without progress: the next one waits, so only the post wakes the agent.
  await until(
    () =>
      lab.lab.view()?.directions[0]?.agent.idleStreak === 2 &&
      lab.lab.view()?.directions[0]?.status === 'idle',
  );
  await lab.lab.post({ text: '@claude-1 check layer 12.' });
  // The turn with the post stops. The harness keeps the conversation, so the
  // agent resumes it, and its next digest carries the post again.
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 4, 8000);
  const inputs = await lab.inputs('d-1-alpha');
  assert.match(inputs[2] ?? '', /check layer 12/);
  assert.match(inputs[3] ?? '', /check layer 12/);
  assert.match(inputs[3] ?? '', /started it again with your conversation/);
  assert.doesNotMatch(inputs.join('\n'), /The question:[\s\S]*The question:/);
  assert.deepEqual((await lab.lines('d-1-alpha', 'launches.jsonl')).slice(-1), [
    'resume',
  ]);
});

await test('a conversation that cannot resume starts new, without the notes about the earlier one', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [{ calls: [{ name: 'EXIT' }] }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  // The process stops. Before the lab starts it again, its session record goes, so nothing can resume.
  await until(
    () => (lab.lab.view()?.directions[0]?.agent.restarts.length ?? 0) === 1,
  );
  await delay(50);
  await rm(
    join(
      lab.root,
      '.verifold',
      'sessions',
      `${lab.lab.view()?.directions[0]?.agent.session}.json`,
    ),
  );
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 3, 8000);
  const inputs = await lab.inputs('d-1-alpha');
  assert.match(inputs[1] ?? '', /The question:/);
  assert.doesNotMatch(inputs.join('\n'), /started it again/);
});

await test('a refused read brings no digest again, and a repeated unread read gets its first answer', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    { calls: [] },
    {
      when: 'check layer 12',
      calls: [
        {
          name: 'verifold_read',
          arguments: { direction: 'd-1', path: 'missing.txt' },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  // Two turns without progress: the next one waits, so only the post wakes the agent.
  await until(
    () =>
      lab.lab.view()?.directions[0]?.agent.idleStreak === 2 &&
      lab.lab.view()?.directions[0]?.status === 'idle',
  );
  await lab.lab.post({ text: '@claude-1 check layer 12.' });
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 4);
  const [result] = (await lab.lines('d-1-alpha', 'results.jsonl')) as {
    result: { isError?: boolean; content: { text: string }[] };
  }[];
  assert.equal(result?.result.isError, true);
  assert.doesNotMatch((await lab.inputs('d-1-alpha'))[3] ?? '', /layer 12/);

  // A repeated call ID gets the same unread posts, and a new one reads none.
  await lab.lab.pause();
  await lab.lab.post({ text: 'First news.' });
  await lab.lab.post({ text: 'Second news.' });
  const agent = lab.lab.view()?.directions[0]?.agent;
  assert.ok(agent);
  const inside = lab.lab as unknown as LabInside;
  const read = (key: string): ReturnType<LabInside['call']> =>
    inside.call(
      agent.id,
      agent.generation,
      'verifold_board',
      { view: 'unread' },
      key,
    );
  const first = await read('k-1');
  assert.match(first.text, /First news[\s\S]*Second news/);
  assert.deepEqual(await read('k-1'), first);
  assert.equal((await read('k-2')).text, 'No unread posts.');
});

await test('an older commit never becomes the newest, and a full board does not stop a stop', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('A question.');
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  const direction = lab.lab.view()?.directions[0]?.direction;
  assert.ok(direction);
  const inside = lab.lab as unknown as LabInside;
  const newer = 'b'.repeat(40);
  assert.equal(
    await inside.setHead(direction, { commit: newer, order: 2 }),
    true,
  );
  assert.equal(
    await inside.setHead(direction, { commit: 'a'.repeat(40), order: 1 }),
    false,
  );
  assert.equal(lab.lab.view()?.directions[0]?.direction.head, newer);

  const posts = boardLimits.posts;
  boardLimits.posts = lab.lab.view()?.posts.length ?? 0;
  t.after(() => {
    boardLimits.posts = posts;
  });
  await lab.lab.stopDirection('d-1');
  assert.equal(lab.lab.view()?.directions[0]?.direction.state, 'stopped');
  assert.equal(lab.lab.view()?.directions[0]?.agent.stopReason, 'person');
});

await test('a direction whose record cannot be saved is not open, and agent handles grow past 99', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('A question.');
  await lab.lab.pause();
  // lab.json cannot be written: a folder with a file stands in its place.
  const file = join(lab.root, '.verifold', 'lab.json');
  const saved = await readFile(file, 'utf8');
  await rm(file);
  await mkdir(join(file, 'blocked'), { recursive: true });
  await assert.rejects(
    lab.lab.addDirection({ title: 'Alpha', harness: 'claude' }),
  );
  assert.deepEqual(lab.lab.view()?.directions, []);
  assert.deepEqual(
    await readdir(join(lab.root, '.verifold', 'lab', 'agents')),
    [],
  );
  await rm(file, { recursive: true });

  // After claude-99 comes claude-100, which reads back and can be mentioned.
  const state = JSON.parse(saved) as { handles: Record<string, number> };
  await writeFile(
    file,
    JSON.stringify({ ...state, handles: { ...state.handles, claude: 99 } }),
  );
  await lab.lab.reload();
  await lab.lab.addDirection({ title: 'Beta', harness: 'claude' });
  await lab.lab.reload();
  assert.equal(lab.lab.view()?.directions[0]?.agent.handle, 'claude-100');
  const post = await lab.lab.post({ text: '@claude-100 hello.' });
  assert.deepEqual(post.mentions, [lab.lab.view()?.directions[0]?.agent.id]);
});

await test('a lab agent resumes only through the lab, and a full pool parks an agent that had its turn for the person', async (t) => {
  const lab = await fixture(t, { agents: 1 });
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  // Two turns without progress: the agent waits a minute before its next one.
  await until(
    () =>
      lab.lab.view()?.directions[0]?.agent.idleStreak === 2 &&
      lab.lab.view()?.directions[0]?.status === 'idle',
  );
  // The commit after its turn ends too.
  await delay(200);
  // The desk shows the person's Resume and Start again: the agent can give its slot.
  assert.equal(lab.sessions.full, true);
  assert.equal(lab.lab.canYield(), true);
  // The person's session needs the only slot: the agent parks and keeps its conversation.
  const person = await lab.sessions.start({
    host: 'claude',
    mode: 'ask',
    prompt: 'Hello.',
  });
  assert.ok(person);
  const agent = lab.lab.view()?.directions[0]?.agent;
  assert.equal(
    (await readRecord(lab.root, agent?.session ?? ''))?.status,
    'paused',
  );
  lab.sessions.end(person);
  await until(() => !lab.sessions.full);
  // The desk cannot resume the agent's session: only the lab gives it its tools.
  await assert.rejects(lab.sessions.resume(agent?.session), /agent of the lab/);
});

await test('a suspended lab does not start, and a process for one session runs no agent', async (t) => {
  const lab = await fixture(t);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  await lab.lab.close();
  await lab.sessions.close();
  const launches = (
    (await lab.lines('d-1-alpha', 'launches.jsonl')) as string[]
  ).length;
  // A process that runs one session of the person shows the lab and resumes no agent.
  const quiet = new Lab(lab.root, {
    sessions: lab.sessions,
    timing,
    runs: false,
  });
  await quiet.load();
  quiet.resumeAll();
  await quiet.pause();
  await quiet.resume();
  await delay(300);
  assert.equal(
    ((await lab.lines('d-1-alpha', 'launches.jsonl')) as string[]).length,
    launches,
  );
  // Suspend pauses the running lab and says so. A suspended lab takes no new start.
  assert.equal(await quiet.suspend(), true);
  await assert.rejects(quiet.start('Another question.'), /moving the lab/);
  await assert.rejects(quiet.restartAgent('a-1'), /moving the lab/);
  await quiet.close();
});

await test('a pause that stops a turn brings its posts again, and posts the turn read itself do not come again', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    { calls: [] },
    {
      when: 'check layer 12',
      calls: [
        { name: 'verifold_board', arguments: { view: 'unread' } },
        { name: 'WAIT' },
      ],
    },
    { when: 'resumed', calls: [] },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(
    () =>
      lab.lab.view()?.directions[0]?.agent.idleStreak === 2 &&
      lab.lab.view()?.directions[0]?.status === 'idle',
  );
  await lab.lab.post({ text: '@claude-1 check layer 12.' });
  await until(async () => (await lab.inputs('d-1-alpha')).length === 3);
  // The person pauses while the turn waits: the turn did not finish, so what it read is not kept.
  await until(
    async () => (await lab.lines('d-1-alpha', 'results.jsonl')).length > 0,
  );
  await lab.lab.pause();
  const before = lab.lab.view()?.directions[0]?.agent;
  assert.equal(before?.readThrough, 1);
  await lab.lab.resume();
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 4, 8000);
  const again = (await lab.inputs('d-1-alpha'))[3] ?? '';
  assert.match(again, /The person resumed the lab/);
  assert.match(again, /check layer 12/);
  // That turn ends cleanly, so its posts count as read and the next digest does not repeat them.
  await until(
    () => (lab.lab.view()?.directions[0]?.agent.readThrough ?? 0) >= 2,
  );
});

await test('a direction folder leaves large new files in the project, and a peer reads ignored output as it is now', async (t) => {
  const lab = await fixture(t, { gitignore: 'results/\n' });
  await writeFile(join(lab.root, 'small.csv'), 'a,b\n');
  await writeFile(join(lab.root, 'large.bin'), Buffer.alloc(2 * 1024 * 1024));
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'WRITE',
          arguments: { path: 'results/table.csv', text: 'x,y\n1,2\n' },
        },
      ],
    },
  ]);
  await lab.script('d-2-beta', [
    {
      when: 'Your last turn ended',
      calls: [
        {
          name: 'verifold_read',
          arguments: { direction: 'd-1', path: 'results/table.csv' },
        },
      ],
    },
  ]);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  const folder = join(lab.root, '.verifold', 'workspaces', 'd-1-alpha');
  assert.equal(await readFile(join(folder, 'small.csv'), 'utf8'), 'a,b\n');
  await assert.rejects(readFile(join(folder, 'large.bin')));
  await until(async () =>
    (
      (await lab.lines('d-2-beta', 'results.jsonl')) as {
        result: { content: { text: string }[] };
      }[]
    ).some((entry) => entry.result.content[0]?.text === 'x,y\n1,2\n'),
  );
  // Writing an ignored file is progress, so the first turn does not count
  // toward the backoff: two more turns pass before the agent waits.
  await until(() => lab.lab.view()?.directions[0]?.agent.idleStreak === 2);
  await delay(200);
  assert.equal((await lab.inputs('d-1-alpha')).length, 3);
});

await test('proof names the folder that holds its commit, and a reply in another direction can be read there', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-2-beta', [
    {
      calls: [
        { name: 'WRITE', arguments: { path: 'rerun.txt', text: '0.70' } },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'evidence',
            direction: 'd-1',
            text: 'Rerun gives 0.70.',
            artifacts: [{ type: 'file', path: 'rerun.txt' }],
          },
        },
      ],
    },
  ]);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  await until(
    () =>
      lab.lab.view()?.posts.some((post) => post.kind === 'evidence') ?? false,
  );
  const post = lab.lab.view()?.posts.find((entry) => entry.kind === 'evidence');
  assert.equal(post?.direction, 'd-1');
  const proof = post?.artifacts[0];
  assert.equal(proof?.type === 'file' ? proof.direction : null, 'd-2');
});

await test('the person cannot resume or restart a lab agent, and a refused start parks no agent', async (t) => {
  const lab = await fixture(t, { agents: 1 });
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(
    () =>
      lab.lab.view()?.directions[0]?.agent.idleStreak === 2 &&
      lab.lab.view()?.directions[0]?.status === 'idle',
  );
  await delay(200);
  const agent = lab.lab.view()?.directions[0]?.agent;
  // A full pool: these starts are refused before the agent gives its slot.
  await assert.rejects(
    lab.sessions.resume('20260101T000000000Z-deadbeef'),
    /cannot resume/,
  );
  await assert.rejects(
    lab.sessions.restart(agent?.session),
    /agent of the lab/,
  );
  await assert.rejects(
    lab.sessions.start({ host: 'claude', mode: 'never', prompt: 'Hi.' }),
    /Ask me or Auto/,
  );
  assert.equal(lab.sessions.view(agent?.session ?? '')?.live, true);
});

await test('a lab that only shows offers no controls, long posts fold, and research from the CLI refuses a lab run', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('A question.');
  await lab.lab.pause();
  await lab.lab.post({ text: `${'Long log line. '.repeat(250)}The end.` });
  const viewer = new Lab(lab.root, {
    sessions: lab.sessions,
    timing,
    runs: false,
  });
  await viewer.load();
  t.after(() => viewer.close());
  const html = renderDesk(await readDeskSnapshot(lab.root), undefined, null, {
    session: null,
    controllable: true,
    lab: viewer.view(),
  }).html;
  assert.match(html, /This desk runs one session, so it only shows the lab/);
  assert.doesNotMatch(html, /data-action="lab-/);
  assert.match(html, /<summary>Show the whole post<\/summary>/);
  assert.match(html, /The end\./);
  await assert.rejects(
    runCli(['research', '--topic', 'Another question.'], lab.root, {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
    }),
    /A lab works on this run/,
  );
});

await test('a failed turn keeps nothing that it read, so its post comes again, once', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    { calls: [] },
    { when: 'Check layer 12', calls: [{ name: 'FAIL' }] },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  await lab.lab.post({ text: '@claude-1 Check layer 12.' });
  const shown = async (): Promise<number> =>
    (await lab.inputs('d-1-alpha')).filter((input) =>
      input.includes('Check layer 12'),
    ).length;
  // Only a completed turn keeps what it read: the post comes in the next digest again.
  await until(async () => (await shown()) === 2);
  // The turn after it completes and keeps the post, so it does not come a third time.
  await delay(400);
  assert.equal(await shown(), 2);
});

await test('a call from a new process is new, even when the harness gives it an ID used before', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_post',
          id: 'toolu-same',
          arguments: { kind: 'question', text: 'First.' },
        },
        { name: 'EXIT' },
      ],
    },
    {
      when: 'started it again',
      calls: [
        {
          name: 'verifold_post',
          id: 'toolu-same',
          arguments: { kind: 'question', text: 'Second.' },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(
    () =>
      lab.lab.view()?.posts.some((post) => post.text === 'Second.') ?? false,
  );
  assert.ok(lab.lab.view()?.posts.some((post) => post.text === 'First.'));
});

await test('an agent whose first prompt fails waits, and the agent after it starts meanwhile', async (t) => {
  let calls = 0;
  const lab = await fixture(t, {
    memory: () => ({
      note: () => Promise.resolve('Noted.'),
      digest: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('The memory folder is unreadable.'))
          : Promise.resolve('');
      },
    }),
  });
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  await until(async () => (await lab.inputs('d-2-beta')).length >= 1);
  assert.equal((await lab.inputs('d-1-alpha')).length, 0);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
});

await test('a commit that fails is not a turn without change: the agent hears why, and its turns go on', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('Do LLMs store months on circles?');
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  // Git cannot take the folder's index, so each commit after a turn fails.
  const lock = join(lab.root, '.git', 'worktrees', 'd-1-alpha', 'index.lock');
  await writeFile(lock, '');
  await lab.lab.resume();
  // Turns that change nothing would wait a minute after the second one. These do not count.
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 4, 8000);
  assert.match(
    (await lab.inputs('d-1-alpha'))[1] ?? '',
    /could not commit your folder after your last turn/,
  );
  assert.equal(lab.lab.view()?.directions[0]?.agent.idleStreak, 0);
  await rm(lock);
});

await test('a digest of long posts stays within what a turn takes: long posts are cut and say where the rest is', async (t) => {
  const lab = await fixture(t);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  await lab.lab.pause();
  // Each quote doubles in the digest's JSON quoting: 20 such posts would pass 100,000 characters.
  const long = '"'.repeat(boardLimits.personText);
  for (let index = 0; index < 20; index += 1)
    await lab.lab.post({ text: long });
  await lab.lab.resume();
  await until(
    async () =>
      (await lab.inputs('d-1-alpha')).some((input) =>
        input.includes('cut: verifold_board with view thread'),
      ),
    8000,
  );
  for (const input of await lab.inputs('d-1-alpha'))
    assert.ok(input.length < 100_000, `A turn of ${input.length} characters.`);
});

await test('a park that ends after a resume and a new turn leaves that turn alone, and Start over waits for the parks', async (t) => {
  const fx = await fixture(t);
  let parks = 0;
  let release: () => void = () => {};
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sessions: LabSessions = {
    full: false,
    view: () =>
      ({ live: true, record: { status: 'running' } }) as unknown as SessionView,
    idle: () => false,
    startAgent: () => Promise.reject(new Error('Not in this test.')),
    resumeAgent: () => Promise.resolve(),
    park: async () => {
      parks += 1;
      await gate;
      return true;
    },
    continueTask: () => {},
    steer: () => false,
    endTask: () => {},
  };
  const lab = new Lab(fx.root, { sessions, timing, runs: false });
  t.after(() => lab.close());
  await lab.start('A question.');
  await lab.addDirection({ title: 'Alpha', harness: 'claude' });
  const inside = lab as unknown as LabInside;
  await inside.update('a-1', (agent) => ({
    ...agent,
    session: '20260101T000000000Z-deadbeef',
  }));
  inside.begin('a-1', null);
  inside.rt('a-1').launch = { at: Date.now(), turns: 0, resumed: false };
  // The park of turn 1 waits. Meanwhile the person resumes, and turn 2 starts.
  const pausing = lab.pause();
  await until(() => parks === 1);
  await lab.resume();
  inside.begin('a-1', null);
  release();
  await pausing;
  assert.equal(inside.rt('a-1').turning, true);
  assert.equal(inside.rt('a-1').turn, 2);
  // A park of the turn that still runs stops it: its digest comes again.
  gate = Promise.resolve();
  await lab.pause();
  assert.equal(inside.rt('a-1').turning, false);
  // Start over waits for the parks of a pause that still runs.
  await lab.resume();
  inside.begin('a-1', null);
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  parks = 0;
  const second = lab.pause();
  await until(() => parks === 1);
  let suspended = false;
  const suspending = lab.suspend().then(() => {
    suspended = true;
  });
  await delay(100);
  assert.equal(suspended, false);
  release();
  await second;
  await suspending;
  assert.equal(suspended, true);
});

await test('while Start over parks the agents, a resume, a post, or a new direction waits for the move', async (t) => {
  const fx = await fixture(t);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let parks = 0;
  const sessions: LabSessions = {
    full: false,
    view: () =>
      ({ live: true, record: { status: 'running' } }) as unknown as SessionView,
    idle: () => false,
    startAgent: () => Promise.reject(new Error('Not in this test.')),
    resumeAgent: () => Promise.resolve(),
    park: async () => {
      parks += 1;
      await gate;
      return true;
    },
    continueTask: () => {},
    steer: () => false,
    endTask: () => {},
  };
  const lab = new Lab(fx.root, { sessions, timing, runs: false });
  t.after(() => lab.close());
  await lab.start('A question.');
  await lab.addDirection({ title: 'Alpha', harness: 'claude' });
  const inside = lab as unknown as LabInside;
  await inside.update('a-1', (agent) => ({
    ...agent,
    session: '20260101T000000000Z-deadbeef',
  }));
  // Start over pauses the running lab, and the park waits.
  const suspending = lab.suspend();
  await until(() => parks === 1);
  await assert.rejects(lab.resume(), /moving the lab/);
  await assert.rejects(lab.post({ text: 'Hello.' }), /moving the lab/);
  await assert.rejects(
    lab.addDirection({ title: 'Beta', harness: 'claude' }),
    /moving the lab/,
  );
  release();
  assert.equal(await suspending, true);
  // After the move, the lab reads its records again and resumes as before.
  await lab.reload();
  await lab.resume();
  assert.equal(lab.view()?.state.pausedAt, null);
});

await test('the question becomes the research topic only when the lab starts', async (t) => {
  const fx = await fixture(t);
  // A refused start leaves the project as it was.
  await assert.rejects(startLabOn(fx.root, fx.lab, '   '), /question/);
  assert.equal((await loadWorkspace(fx.root)).research, undefined);
  await startLabOn(fx.root, fx.lab, 'Do LLMs store months on circles?');
  assert.equal(
    (await loadWorkspace(fx.root)).research?.topic,
    'Do LLMs store months on circles?',
  );
  // A second start is refused and keeps the first question.
  await assert.rejects(
    startLabOn(fx.root, fx.lab, 'Another question?'),
    /already runs/,
  );
  assert.equal(
    (await loadWorkspace(fx.root)).research?.topic,
    'Do LLMs store months on circles?',
  );
});

/** The plan of the first agent: three directions, its own first. */
const firstPlan = {
  reading:
    'We read the question as: do cyclic words sit on curves that an SAE misses?',
  directions: [
    {
      title: 'Circles',
      bar: 'a probe places 60% of months right, beating the SAE',
      runs: 3,
      noise: '±0.02',
      buildsOn: [
        { text: 'Engels 2024', known: true },
        { text: 'The SAE test', known: false },
      ],
      harness: 'claude',
    },
    {
      title: 'Helix',
      bar: 'it beats a circle for years',
      runs: 3,
      noise: '±0.02',
      harness: 'codex',
    },
    {
      title: 'Control',
      bar: 'shuffled data still shows a circle',
      runs: 2,
      noise: '±0.05',
      harness: 'claude',
    },
  ],
  mine: 0,
  cost: 'Nothing costs money yet.',
};

await test('the first agent posts the plan of record, and the lab opens its directions without a gate', async (t) => {
  const lab = await fixture(t, { harnesses: ['claude', 'codex'] });
  await lab.script('d-1-plan-the-lab', [
    {
      when: 'post the plan of record',
      calls: [
        // One direction is not a plan.
        {
          name: 'verifold_plan',
          arguments: { ...firstPlan, directions: [firstPlan.directions[0]] },
        },
        // Your own direction has no bar yet: the first plan gives it all.
        {
          name: 'verifold_plan',
          arguments: {
            ...firstPlan,
            directions: [
              { harness: 'claude' },
              ...firstPlan.directions.slice(1),
            ],
          },
        },
        // Five are too many for a first plan.
        {
          name: 'verifold_plan',
          arguments: {
            ...firstPlan,
            directions: [
              ...firstPlan.directions,
              { ...firstPlan.directions[1], title: 'Four' },
              { ...firstPlan.directions[1], title: 'Five' },
            ],
          },
        },
        { name: 'verifold_plan', arguments: firstPlan },
      ],
    },
  ]);
  // Another agent cannot change the plan.
  await lab.script('d-3-control', [
    {
      calls: [{ name: 'verifold_plan', arguments: firstPlan }],
    },
  ]);
  await lab.lab.start('Do LLMs store months on circles?', { hours: 8 });

  // The first agent works at once. No person action opens a direction.
  await until(() => (lab.lab.view()?.directions.length ?? 0) === 3, 20_000);
  await until(() => lab.lab.view()?.state.plan !== null);
  const view = lab.lab.view();
  assert.equal(view?.state.opener, 'a-1');
  assert.equal(view?.state.budget?.hours, 8);
  const plan = view?.state.plan;
  assert.equal(plan?.post, 'p-1');
  assert.deepEqual(plan?.directions, ['d-1', 'd-2', 'd-3']);
  assert.equal(plan?.cost, 'Nothing costs money yet.');
  const post = view?.posts.find((entry) => entry.id === 'p-1');
  assert.equal(post?.kind, 'plan');
  assert.equal(post?.author, 'a-1');
  // The first agent keeps its folder: its direction becomes the first of the plan.
  assert.deepEqual(
    view?.directions.map((entry) => [
      entry.direction.id,
      entry.direction.title,
      entry.direction.runs,
      entry.direction.noise,
      entry.agent.host,
      entry.direction.workspace.path.split('/').at(-1),
    ]),
    [
      ['d-1', 'Circles', 3, '±0.02', 'claude', 'd-1-plan-the-lab'],
      ['d-2', 'Helix', 3, '±0.02', 'codex', 'd-2-helix'],
      ['d-3', 'Control', 2, '±0.05', 'claude', 'd-3-control'],
    ],
  );
  assert.deepEqual(view?.directions[0]?.direction.buildsOn, [
    { text: 'Engels 2024', known: true },
    { text: 'The SAE test', known: false },
  ]);
  // The plan is kept before the harness gets its answer.
  await until(
    async () =>
      (await lab.lines('d-1-plan-the-lab', 'results.jsonl')).length >= 4,
  );
  const results = (await lab.lines('d-1-plan-the-lab', 'results.jsonl')) as {
    result: { isError?: boolean; content: { text: string }[] };
  }[];
  assert.match(results[0]?.result.content[0]?.text ?? '', /2 to 4 directions/);
  assert.match(
    results[1]?.result.content[0]?.text ?? '',
    /Write a short title for each direction/,
  );
  assert.match(results[2]?.result.content[0]?.text ?? '', /2 to 4 directions/);
  assert.match(
    results[3]?.result.content[0]?.text ?? '',
    /Posted the plan p-1\. Your direction is d-1\. Opened d-2, d-3/,
  );

  // The new agents start with the plan in their first prompt, Codex too.
  await until(
    async () =>
      (await lab.inputs('d-2-helix')).length > 0 &&
      (await lab.inputs('d-3-control')).length > 0,
  );
  const helix = (await lab.inputs('d-2-helix'))[0] ?? '';
  assert.match(helix, /The plan of record \(p-1\), from claude-1:/);
  assert.match(
    helix,
    /Holds up if: "it beats a circle for years · 3 runs · noise ±0\.02"/,
  );
  assert.match(helix, /"Engels 2024" \(known\), "The SAE test" \(new\)/);
  // The plan's opener prompt goes to the first agent only.
  assert.match(
    (await lab.inputs('d-1-plan-the-lab'))[0] ?? '',
    /You also open the lab/,
  );
  assert.doesNotMatch(helix, /You also open the lab/);
  await until(
    async () => (await lab.lines('d-3-control', 'results.jsonl')).length > 0,
  );
  const refused = (await lab.lines('d-3-control', 'results.jsonl')) as {
    result: { isError?: boolean; content: { text: string }[] };
  }[];
  assert.equal(refused[0]?.result.isError, true);
  assert.match(
    refused[0]?.result.content[0]?.text ?? '',
    /Only the agent that opened the lab changes its plan/,
  );

  // The desk shows the plan first, with each bar.
  const html = renderLab(
    lab.lab.view()!,
    (value) => value,
    () => '',
  );
  assert.match(html, /<h2 id="plan-title">Plan of record<\/h2>/);
  assert.match(
    html,
    /<th scope="row">Helix<\/th><td>it beats a circle for years · 3 runs · noise ±0\.02<\/td>/,
  );
  assert.match(html, /Engels 2024 <span class="fine">\(known\)<\/span>/);
  assert.match(html, /data-action="lab-reply" data-post="p-1"/);
  assert.match(html, /<p class="fine lab-time">Due .* left<\/p>/);
  assert.ok(
    html.indexOf('id="plan-title"') < html.indexOf('id="directions-title"'),
  );
});

await test('a reply to the plan wakes its author, and a change of the plan wakes the agents whose directions it changed', async (t) => {
  const lab = await fixture(t, { harnesses: ['claude', 'codex'] });
  const amended = {
    ...firstPlan,
    reading: 'Years need their own bar.',
    directions: [
      { ...firstPlan.directions[0], id: 'd-1' },
      {
        ...firstPlan.directions[1],
        id: 'd-2',
        bar: 'it beats a circle for years by 0.05',
      },
      { ...firstPlan.directions[2], id: 'd-3' },
    ],
  };
  await lab.script('d-1-plan-the-lab', [
    {
      when: 'post the plan of record',
      calls: [{ name: 'verifold_plan', arguments: firstPlan }],
    },
    {
      when: 'Tighten the helix bar',
      calls: [
        // A change that leaves out an open direction is refused: only the person stops one.
        {
          name: 'verifold_plan',
          arguments: {
            ...amended,
            directions: amended.directions.slice(0, 2),
          },
        },
        // A direction keeps its harness.
        {
          name: 'verifold_plan',
          arguments: {
            ...amended,
            directions: [
              amended.directions[0],
              { ...amended.directions[1], harness: 'claude' },
              amended.directions[2],
            ],
          },
        },
        { name: 'verifold_plan', arguments: amended },
      ],
    },
  ]);
  await lab.lab.start('Do LLMs store months on circles?');
  await until(() => lab.lab.view()?.state.plan !== null, 20_000);
  // The first agent's turns end; then the person replies to the plan.
  await until(async () => (await lab.inputs('d-1-plan-the-lab')).length >= 3);
  await lab.lab.post({ text: 'Tighten the helix bar.', replyTo: 'p-1' });
  await until(() => lab.lab.view()?.state.plan?.post !== 'p-1');
  const view = lab.lab.view();
  const plan = view?.state.plan;
  const post = view?.posts.find((entry) => entry.id === plan?.post);
  assert.equal(post?.kind, 'plan');
  assert.equal(post?.replyTo, 'p-1');
  assert.equal(post?.text, 'Years need their own bar.');
  assert.deepEqual(post?.mentions, ['a-2']);
  assert.equal(
    view?.directions[1]?.direction.bar,
    'it beats a circle for years by 0.05',
  );
  const results = (await lab.lines('d-1-plan-the-lab', 'results.jsonl')) as {
    result: { content: { text: string }[] };
  }[];
  assert.match(
    results[1]?.result.content[0]?.text ?? '',
    /List every open direction with its id: d-3/,
  );
  assert.match(
    results[2]?.result.content[0]?.text ?? '',
    /d-2 runs on Codex\. A direction keeps its harness/,
  );
  // The changed direction's agent wakes with the new plan.
  await until(async () =>
    (await lab.inputs('d-2-helix')).some((input) =>
      input.includes(`[plan, for you] from claude-1, reply to p-1`),
    ),
  );
  assert.match(
    (await lab.inputs('d-2-helix')).at(-1) ?? '',
    /Holds up if: "it beats a circle for years by 0\.05 · 3 runs/,
  );
  // When the plan's author stops, the plan stays as it is, and the desk says so.
  await lab.lab.stopDirection('d-1');
  const html = renderLab(
    lab.lab.view()!,
    (value) => value,
    () => '',
  );
  assert.match(html, /claude-1 no longer works, so the plan stays as it is\./);
  assert.doesNotMatch(html, /Reply to the plan/);
  // The plan's table marks the stopped direction.
  assert.match(
    html,
    /<th scope="row">Circles <span class="fine">\(stopped\)<\/span><\/th>/,
  );
});

await test('when the time budget ends the lab pauses, Needs you asks for more time, and more time resumes it', async (t) => {
  const lab = await fixture(t, { hourMs: 4000 });
  await lab.lab.start('Do LLMs store months on circles?', { hours: 1 });
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  await until(() => lab.lab.view()?.state.pausedFor === 'deadline', 10_000);
  // No continuation starts after the deadline.
  const count = (await lab.inputs('d-1-alpha')).length;
  await delay(300);
  assert.equal((await lab.inputs('d-1-alpha')).length, count);
  await until(
    () =>
      lab.lab
        .view()
        ?.posts.some((post) =>
          /The time budget of 1 hour ended, so the lab paused\./.test(
            post.text,
          ),
        ) ?? false,
  );
  await assert.rejects(lab.lab.resume(), /The time budget ended/);
  for (const bad of ['0', '0x10', '1e2', '2.5'])
    await assert.rejects(lab.lab.extend(bad), /whole hours, from 1 to 168/);
  const html = renderDesk(await readDeskSnapshot(lab.root), undefined, null, {
    session: null,
    controllable: true,
    lab: lab.lab.view(),
  }).html;
  assert.match(html, /The time budget ended/);
  assert.match(html, /data-action="lab-budget" data-hours="2"/);
  // A lab that its budget paused offers no plain Resume: more time resumes it.
  assert.doesNotMatch(html, /data-action="lab-resume"/);

  // Ten more hours: long enough that the test ends before the next deadline.
  await lab.lab.extend('10');
  const state = lab.lab.view()?.state;
  assert.equal(state?.pausedAt, null);
  assert.equal(state?.pausedFor, null);
  assert.equal(state?.budget?.hours, 11);
  assert.ok(Date.parse(state?.budget?.deadline ?? '') > Date.now());
  await until(async () =>
    (await lab.inputs('d-1-alpha')).some((input) =>
      input.includes('The person gave the lab 10 more hours.'),
    ),
  );
  // More time before the deadline wakes no one.
  await lab.lab.extend('1');
  await delay(300);
  assert.ok(
    !(await lab.inputs('d-1-alpha')).some((input) =>
      input.includes('The person gave the lab 1 more hour.'),
    ),
  );
});

await test('a lab from before plans and time budgets still loads', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('Do LLMs store months on circles?');
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude', bar: 'x' });
  await lab.lab.close();
  // Leave out every field that plans and time budgets added.
  const path = join(lab.root, '.verifold', 'lab.json');
  const old = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  > & { directions: Record<string, unknown>[] };
  for (const key of ['opener', 'plan', 'budget', 'pausedFor']) delete old[key];
  for (const direction of old.directions)
    for (const key of ['runs', 'noise', 'buildsOn']) delete direction[key];
  await writeFile(path, JSON.stringify(old));
  const reloaded = new Lab(lab.root, { sessions: lab.sessions, timing });
  await reloaded.load();
  t.after(() => reloaded.close());
  const state = reloaded.view()?.state;
  assert.equal(state?.plan, null);
  assert.equal(state?.opener, null);
  assert.equal(state?.budget, null);
  // A paused lab from before was paused by the person.
  assert.equal(state?.pausedFor, 'person');
  assert.equal(state?.directions[0]?.bar, 'x');
  assert.equal(state?.directions[0]?.runs, null);
  assert.deepEqual(state?.directions[0]?.buildsOn, []);
  await reloaded.resume();
  assert.equal(reloaded.view()?.state.pausedAt, null);
});

await test('a plan keeps the directions that the person opened, also many and outside the team, and counts toward the post limit', async (t) => {
  const posts = labLimits.postsPerHour;
  labLimits.postsPerHour = 2;
  t.after(() => {
    labLimits.postsPerHour = posts;
  });
  // The project's team is Claude Code only.
  const lab = await fixture(t, { harnesses: ['claude'], agents: 6 });
  const all = ['d-2', 'd-3', 'd-4', 'd-5'].map((id) => ({ id }));
  const again = { ...firstPlan, directions: [{ id: 'd-1' }, ...all] };
  await lab.script('d-1-plan-the-lab', [
    {
      when: 'Plan now',
      calls: [
        // Five open directions: the first plan lists them all. The person's keep what the plan leaves out.
        {
          name: 'verifold_plan',
          arguments: {
            ...firstPlan,
            directions: [{ ...firstPlan.directions[0] }, ...all],
          },
        },
        // A new direction needs a harness of the team.
        {
          name: 'verifold_plan',
          arguments: {
            ...again,
            directions: [
              ...again.directions,
              { ...firstPlan.directions[1], harness: 'codex' },
            ],
          },
        },
        { name: 'verifold_plan', arguments: again },
        // A plan is a post: the hourly limit counts it.
        { name: 'verifold_plan', arguments: again },
      ],
    },
  ]);
  await lab.lab.start('Do LLMs store months on circles?');
  await until(() => lab.lab.view()?.state.opener === 'a-1');
  for (const [title, harness] of [
    ['Two', 'codex'],
    ['Three', 'claude'],
    ['Four', 'claude'],
    ['Five', 'claude'],
  ] as const)
    await lab.lab.addDirection({ title, harness, bar: `${title} holds` });
  await lab.lab.post({ text: '@claude-1 Plan now.' });
  await until(
    async () =>
      (await lab.lines('d-1-plan-the-lab', 'results.jsonl')).length >= 4,
    20_000,
  );
  const results = (
    (await lab.lines('d-1-plan-the-lab', 'results.jsonl')) as {
      result: { content: { text: string }[] };
    }[]
  ).map((entry) => entry.result.content[0]?.text ?? '');
  assert.match(results[0] ?? '', /Posted the plan/);
  assert.match(
    results[1] ?? '',
    /Codex is not in this project's team\. Use Claude Code/,
  );
  assert.match(results[2] ?? '', /Posted the plan/);
  assert.match(
    results[3] ?? '',
    /You posted 2 times in the last hour, the limit/,
  );
  const view = lab.lab.view();
  assert.deepEqual(view?.state.plan?.directions, [
    'd-1',
    'd-2',
    'd-3',
    'd-4',
    'd-5',
  ]);
  // The person's Codex direction keeps its harness, title, and bar.
  const two = view?.directions.find((entry) => entry.direction.id === 'd-2');
  assert.equal(two?.agent.host, 'codex');
  assert.equal(two?.direction.title, 'Two');
  assert.equal(two?.direction.bar, 'Two holds');
  assert.equal(two?.direction.runs, null);
});

await test('when the time budget ends while the person paused the lab, more time keeps it paused', async (t) => {
  const lab = await fixture(t, { hourMs: 1500 });
  await lab.lab.start('Do LLMs store months on circles?', { hours: 1 });
  await lab.lab.pause();
  await delay(1800);
  // The person's pause stays the person's.
  assert.equal(lab.lab.view()?.state.pausedFor, 'person');
  await assert.rejects(lab.lab.resume(), /The time budget ended/);
  const html = renderDesk(await readDeskSnapshot(lab.root), undefined, null, {
    session: null,
    controllable: true,
    lab: lab.lab.view(),
  }).html;
  assert.match(html, /You paused the lab, and its time budget ended too/);
  assert.match(html, /data-action="lab-budget" data-hours="2"/);
  assert.doesNotMatch(html, /data-action="lab-resume"/);
  await lab.lab.extend(100);
  assert.ok(lab.lab.view()?.state.pausedAt);
  await lab.lab.resume();
  assert.equal(lab.lab.view()?.state.pausedAt, null);
});

await test('an agent whose plan Verifold stopped before it was kept starts after a restart, and the board says why', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('Do LLMs store months on circles?');
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  await lab.lab.close();
  // As if the owner stopped while a plan opened this direction.
  const path = join(lab.root, '.verifold', 'lab', 'agents', 'a-1.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(path, JSON.stringify({ ...record, held: true }));
  await lab.restart();
  const view = lab.lab.view();
  assert.equal(view?.directions[0]?.agent.held, false);
  assert.match(
    view?.posts.at(-1)?.text ?? '',
    /The person opened "Alpha" for claude-1 \(Claude Code\) in a plan that was not kept\./,
  );
});
