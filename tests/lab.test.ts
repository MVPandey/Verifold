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
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { changeWorkspace } from '../src/cli/storage.ts';
import { SessionPool } from '../src/cli/workers.ts';
import { Lab } from '../src/cli/lab.ts';
import { Quota } from '../src/cli/quota.ts';
import { readRecord } from '../src/cli/session.ts';
import { archiveRun, restoreRun } from '../src/cli/archive.ts';
import { terminalInput, type CliIO } from '../src/cli/commands.ts';

/**
 * A fake Claude Code for lab agents. Its folder name (such as d-1-circles)
 * finds its script in `scripts/<folder>.json` and its logs in `logs/<folder>/`,
 * next to the fake. A script is a list of turns: `{ when?, calls }`. Each new
 * request takes the first unused turn whose `when` text it contains, or that
 * has no `when`. A call runs Verifold's tool over the SDK MCP channel. Calls
 * named WRITE write a file, WAIT keep the turn running until a steered message
 * arrives, and EXIT stop the process.
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
const id = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
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
  out({ type: 'control_request', request_id: 'mcp-' + turn + '-' + next, request: { subtype: 'mcp_message', server_name: 'verifold', message: { jsonrpc: '2.0', id: 100 + next, method: 'tools/call', params: { name: entry.name, arguments: entry.arguments, _meta: { 'claudecode/toolUseId': 'toolu-' + process.pid + '-' + turn + '-' + next } } } } });
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
      onTurnEnd: (record) => owned.lab?.turnEnded(record),
      onLimit: (host, signal) => {
        quota.record(host, signal);
        owned.lab?.limited(host, signal);
      },
    });
    const lab = new Lab(root, {
      sessions,
      quota,
      timing,
      ...(options.memory ? { memory: options.memory(sessions) } : {}),
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
    /- p-4 \[objection\] from claude-2 in d-1, reply to p-3: "One seed can be luck\."/,
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
  // The mention reached claude-2 too, as an unread post in its next digest.
  assert.match(
    (await lab.inputs('d-2-beta'))[2] ?? '',
    /write down your bar[\s\S]*look at layer 12/,
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
  await lab.script('d-1-alpha', [
    { calls: [{ name: 'EXIT' }] },
    { calls: [{ name: 'EXIT' }] },
    { calls: [{ name: 'EXIT' }] },
  ]);
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
  assert.equal((await lab.inputs('d-1-alpha')).length, 3);
  assert.equal(lab.lab.view()?.directions[0]?.agent.restarts.length, 3);
  await lab.lab.restartAgent('a-1');
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 4);
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
  await until(async () => (await lab.inputs('d-1-alpha')).length === 2);
  await until(() => lab.lab.view()?.directions[0]?.status === 'idle');
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
  assert.doesNotMatch(again, /Thanks\./);
});

await test('start over parks the lab, a restore brings it back paused, and a new lab never reuses a folder', async (t) => {
  const lab = await fixture(t);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  await lab.lab.suspend();
  const archive = await archiveRun(lab.root);
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
