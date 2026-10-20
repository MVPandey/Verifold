import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { changeWorkspace, loadWorkspace } from '../src/cli/storage.ts';
import { SessionPool } from '../src/cli/workers.ts';
import {
  addSpend,
  Lab,
  labLimits,
  startLabOn,
  type Call as LabCall,
  type Check,
  type LabCompute,
  type LabSessions,
  type LabState,
  type LabView,
} from '../src/cli/lab.ts';
import { RunTeam } from '../src/cli/team.ts';
import type {
  PodRuns,
  RunRecord,
  Sandbox,
  SandboxSpec,
} from '../src/cli/runs.ts';
import type { Lease } from '../src/cli/leases.ts';
import type { ComputeView } from '../src/cli/compute.ts';
import { ptyLibrary } from '../src/cli/terminals.ts';
import { TranscriptWriter } from '../src/cli/transcript.ts';
import { secretGuard } from '../src/cli/runpod.ts';
import { ResearchRunner } from '../src/cli/research-runner.ts';
import { boardLimits } from '../src/cli/board.ts';
import { checkToolSpecs } from '../src/cli/lab-tools.ts';
import { Coordinator } from '../src/cli/coordinator.ts';
import { parseFrame, renderDesk } from '../src/cli/desk-view.ts';
import {
  answerPanel,
  costLine,
  labCallNeeds,
  renderLab,
  runPanel,
  searchPanel,
} from '../src/cli/desk-lab.ts';
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
import { ProjectMemory } from '../src/cli/memory.ts';

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
 * With a `strict-tools` file, it calls only the Verifold tools that its
 * launch gave it, and logs NO_SUCH_TOOL as the result of any other. A call
 * named COST sets the cost estimate of its results. Without -p it is the
 * terminal: it prints its arguments, echoes lines, and exits on /exit.
 */
const claudeHost = `if (!process.argv.includes('-p')) {
  process.stdin.setRawMode?.(true);
  process.stdout.write('fake tui ' + process.argv.slice(2).join(' ') + '\\r\\n');
  let typed = '';
  process.stdin.on('data', (chunk) => {
    for (const char of chunk.toString()) {
      if (char !== '\\r' && char !== '\\n') { typed += char; continue; }
      if (typed === '/exit') process.exit(0);
      process.stdout.write('echo ' + typed + '\\r\\n');
      typed = '';
    }
  });
  return;
}
const fs = require('node:fs');
const path = require('node:path');
const base = path.dirname(process.argv[1]);
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const args = process.argv.slice(2);
const name = path.basename(process.cwd());
const log = path.join(base, 'logs', name);
fs.mkdirSync(log, { recursive: true });
// A test reads the arguments while a later launch writes them: a rename gives it the old file or the new one, never a part.
fs.writeFileSync(path.join(log, 'args.json.tmp'), JSON.stringify(args));
fs.renameSync(path.join(log, 'args.json.tmp'), path.join(log, 'args.json'));
fs.writeFileSync(path.join(log, 'env.json'), JSON.stringify(process.env));
fs.appendFileSync(path.join(log, 'launches.jsonl'), JSON.stringify(args.includes('--resume') ? 'resume' : 'start') + '\\n');
if (args.includes('--resume') && fs.existsSync(path.join(base, 'resume-fails'))) process.exit(1);
const id =args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
const usedFile = path.join(log, 'used.json');
let calls = [];
let next = 0;
let running = false;
let turn = 0;
let cost = null;
const take = (text) => {
  let script = [];
  try { script = JSON.parse(fs.readFileSync(path.join(base, 'scripts', name + '.json'), 'utf8')); } catch {}
  const used = fs.existsSync(usedFile) ? JSON.parse(fs.readFileSync(usedFile, 'utf8')) : [];
  const index = script.findIndex((entry, at) => !used.includes(at) && (!entry.when || text.includes(entry.when)));
  if (index < 0) return [];
  fs.writeFileSync(usedFile, JSON.stringify([...used, index]));
  return script[index].calls;
};
const allowed = args.includes('--allowedTools') ? args[args.indexOf('--allowedTools') + 1].split(',') : [];
const call = () => {
  const entry = calls[next];
  if (!entry) { running = false; return out({ type: 'result', subtype: 'success', ...(cost === null ? {} : { total_cost_usd: cost }) }); }
  if (entry.name.startsWith('verifold_') && fs.existsSync(path.join(base, 'strict-tools')) && !allowed.includes('mcp__verifold__' + entry.name)) {
    fs.appendFileSync(path.join(log, 'results.jsonl'), JSON.stringify({ call: entry.name, result: { isError: true, content: [{ type: 'text', text: 'NO_SUCH_TOOL' }] } }) + '\\n');
    next++;
    return call();
  }
  if (entry.name === 'WRITE') {
    fs.mkdirSync(path.dirname(entry.arguments.path), { recursive: true });
    fs.writeFileSync(entry.arguments.path, entry.arguments.text);
    next++;
    return call();
  }
  if (entry.name === 'WAIT') return;
  if (entry.name === 'COST') { cost = entry.arguments.usd; next++; return call(); }
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

/** A lab agent's terminal needs a PTY library. */
const terminals =
  typeof (await ptyLibrary()) === 'string'
    ? 'no PTY library on this platform'
    : false;

const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

/**
 * A fake Codex app-server for lab agents, with the same scripts and logs as
 * the fake Claude Code. A thread keeps the tools that it started with, as in
 * Codex: with a `strict-tools` file, it calls only those. With --remote it
 * is the terminal, as the fake Claude Code is without -p.
 */
const codexHost = `if (process.argv.includes('--remote')) {
  process.stdin.setRawMode?.(true);
  process.stdout.write('fake tui ' + process.argv.slice(2).join(' ') + '\\r\\n');
  process.stdin.on('data', (chunk) => {
    if (chunk.toString().includes('/exit')) process.exit(0);
  });
  return;
}
const fs = require('node:fs');
const path = require('node:path');
const base = path.dirname(process.argv[1]);
const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
const name = path.basename(process.cwd());
const log = path.join(base, 'logs', name);
fs.mkdirSync(log, { recursive: true });
fs.writeFileSync(path.join(log, 'args.json.tmp'), JSON.stringify(process.argv.slice(2)));
fs.renameSync(path.join(log, 'args.json.tmp'), path.join(log, 'args.json'));
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
const threadTools = () => { try { return JSON.parse(fs.readFileSync(path.join(log, 'tools-' + thread + '.json'), 'utf8')); } catch { return []; } };
const call = () => {
  const entry = calls[next];
  if (!entry) return out({ method: 'turn/completed', params: { turn: { id: turn, status: 'completed' } } });
  if (entry.name.startsWith('verifold_') && fs.existsSync(path.join(base, 'strict-tools')) && !threadTools().includes(entry.name)) {
    fs.appendFileSync(path.join(log, 'results.jsonl'), JSON.stringify({ call: entry.name, result: { contentItems: [{ text: 'NO_SUCH_TOOL' }] } }) + '\\n');
    next++;
    return call();
  }
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
    fs.writeFileSync(path.join(log, 'tools-' + thread + '.json'), JSON.stringify((message.params.dynamicTools || []).map((tool) => tool.name)));
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
  /**
   * Close the lab and its sessions, as a stopping owner does, and start a new
   * owner. `between` runs while no owner runs.
   */
  restart(between?: () => Promise<void>): Promise<void>;
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
    /** One minute of a run's or a check's time limit, short in a test. */
    readonly minuteMs?: number;
    /** The project folder's name. */
    readonly folder?: string;
    /** The sandbox of runs. Default: none at all, so a run's command runs as it is. Null: no runs. */
    readonly sandbox?: Sandbox | null;
    readonly compute?: LabCompute;
  } = {},
): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-lab-')));
  const root = join(base, options.folder ?? 'project');
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
      // Runs need no sandbox here: the ledger's own tests check the sandbox.
      sandbox:
        options.sandbox === undefined
          ? (spec) => ({ file: '/bin/sh', args: ['-c', spec.command] })
          : options.sandbox,
      timing: {
        ...timing,
        ...(options.hourMs ? { hourMs: options.hourMs } : {}),
        ...(options.minuteMs ? { minuteMs: options.minuteMs } : {}),
      },
      ...(options.compute ? { compute: options.compute } : {}),
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
    restart: async (between) => {
      await fixture.lab.close();
      await fixture.sessions.close();
      await between?.();
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

/**
 * Open directions while the lab is paused, so their IDs and post numbers are
 * known, then resume. `gpuApproved`: the person approved a GPU pod already,
 * so pod requests follow the Compute limits. `hours`: a time budget.
 */
async function open(
  fixture: Fixture,
  directions: { title: string; harness: 'claude' | 'codex' }[],
  options: { readonly gpuApproved?: boolean; readonly hours?: number } = {},
): Promise<void> {
  await fixture.lab.start(
    'Do LLMs store months on circles?',
    options.hours ? { hours: options.hours } : {},
  );
  await fixture.lab.pause();
  // An answered call that started a pod stands for the person's approval.
  if (options.gpuApproved) {
    const lab = fixture.lab as unknown as { state: LabState | null };
    const at = new Date().toISOString();
    if (lab.state)
      lab.state = {
        ...lab.state,
        calls: [
          {
            id: 'c-1',
            at,
            by: 'verifold',
            direction: null,
            kind: 'cost',
            question: 'A pod?',
            options: [
              {
                label: 'Yes',
                usd: 1,
                minutes: null,
                effect: {
                  type: 'pod',
                  gpuType: 'NVIDIA A40',
                  hours: 1,
                  secrets: [],
                },
              },
              { label: 'No', usd: 0, minutes: null, effect: null },
            ],
            pick: null,
            why: 'Earlier.',
            undoMinutes: 0,
            deadline: null,
            state: 'answered',
            answer: { option: 0, at },
            undoUntil: null,
            applied: { type: 'pod', lease: 'lease-0' },
            note: 'Verifold started lease-0.',
          },
        ],
      };
  }
  for (const direction of directions) await fixture.lab.addDirection(direction);
  await fixture.lab.resume();
}

/** A tool call of a lab agent, as its harness makes it, with the agent's current launch. */
function agentCall(
  lab: Lab,
  agent: string,
  name: string,
  input: unknown,
): Promise<{ ok: boolean; text: string }> {
  const record = lab
    .view()
    ?.directions.find((entry) => entry.agent.id === agent)?.agent;
  return (
    lab as unknown as {
      call(
        id: string,
        generation: string,
        name: string,
        input: unknown,
        callId: string,
      ): Promise<{ ok: boolean; text: string }>;
    }
  ).call(agent, record?.generation ?? '', name, input, `call-${Math.random()}`);
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
    [
      'verifold_board',
      'verifold_post',
      'verifold_read',
      'verifold_direction',
      'verifold_ask_person',
      'verifold_run',
      'verifold_run_status',
      'verifold_cancel_run',
    ],
  );
  assert.match(
    (await lab.inputs('d-1-alpha'))[0] ?? '',
    /Runs on this computer:/,
  );
});

await test('without a sandbox for runs, agents get no run tools and run experiments in their harness', async (t) => {
  const lab = await fixture(t, { sandbox: null });
  await open(lab, [{ title: 'Beta', harness: 'codex' }]);
  await until(async () => (await lab.inputs('d-1-beta')).length >= 1);
  const thread = (
    (await lab.lines('d-1-beta', 'threads.jsonl')) as {
      params: { dynamicTools: { name: string }[] };
    }[]
  )[0]?.params;
  assert.deepEqual(
    thread?.dynamicTools.map((tool) => tool.name),
    [
      'verifold_board',
      'verifold_post',
      'verifold_read',
      'verifold_direction',
      'verifold_ask_person',
    ],
  );
  const first = (await lab.inputs('d-1-beta'))[0] ?? '';
  assert.doesNotMatch(first, /verifold_run|Runs on this computer/);
  assert.match(first, /run experiments that fit on this computer/);
});

await test('with pods, an agent asks for a pod for its own direction, runs on it, and wakes when the lease changes', async (t) => {
  const asked: unknown[] = [];
  const ended: unknown[] = [];
  const lease = (id: string, direction: string): Lease =>
    ({
      id,
      state: 'ready',
      gpu: 'NVIDIA A40',
      tasks: [],
      directions: [direction],
      history: [{ at: new Date().toISOString(), by: 'verifold', text: '' }],
    }) as unknown as Lease;
  const leases = new Map([
    ['lease-1', lease('lease-1', 'd-1')],
    ['lease-2', lease('lease-2', 'd-2')],
    ['lease-3', { ...lease('lease-3', 'd-1'), state: 'requested' as const }],
  ]);
  const runs: PodRuns = {
    pick: (direction) => {
      if (direction !== 'd-1') throw new Error('No pod.');
      return { lease: 'lease-1', gpu: 'NVIDIA A40' };
    },
    send: () => Promise.resolve(),
    start: () => Promise.resolve(),
    state: () =>
      Promise.resolve({ state: 'done', exit: 0, tail: 'METRIC acc=0.9\n' }),
    stop: () => Promise.resolve(),
    log: () =>
      Promise.resolve({ bytes: 15, head: 'METRIC acc=0.9\n', tail: null }),
    metrics: () => Promise.resolve('METRIC acc=0.9\n'),
    fetch: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    guard: () => Promise.resolve(secretGuard({})),
  };
  const compute: LabCompute = {
    describe: () => Promise.resolve('{"podsOn":true}'),
    requestPod: (input) => {
      asked.push(input);
      return Promise.resolve('Started lease-1.');
    },
    podCost: () => Promise.resolve(1),
    startPod: () => Promise.reject(new Error('No pod.')),
    podsOn: () => true,
    leases: {
      list: () => [...leases.values()],
      get: (id) => {
        const found = leases.get(String(id));
        if (!found) throw new Error('No lease.');
        return found;
      },
      end: (id, by, reason) => {
        ended.push({ id, by, reason });
        return Promise.resolve(leases.get(String(id)) as Lease);
      },
    },
    podRuns: () => runs,
  };
  const lab = await fixture(t, { compute });
  await lab.script('d-1-alpha', [
    {
      calls: [
        { name: 'verifold_compute', arguments: {} },
        {
          name: 'verifold_request_pod',
          arguments: { gpuType: 'NVIDIA A40', hours: 2, why: 'Train.' },
        },
        {
          name: 'verifold_end_lease',
          arguments: { lease: 'lease-2', why: 'Not mine.' },
        },
        {
          name: 'verifold_run',
          arguments: {
            command: 'python train.py',
            why: 'Seed 1 on a GPU.',
            where: 'pod',
            minutes: 600,
          },
        },
        {
          name: 'verifold_run',
          arguments: { command: 'true', why: 'Too long.', minutes: 600 },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'codex' }], {
    gpuApproved: true,
  });
  await until(
    async () => (await lab.lines('d-1-alpha', 'results.jsonl')).length >= 5,
  );
  const results = (await lab.lines('d-1-alpha', 'results.jsonl')) as {
    call: string;
    result: { contentItems?: { text: string }[] };
  }[];
  const text = (index: number): string =>
    results[index]?.result.contentItems?.[0]?.text ?? '';
  assert.equal(text(0), '{"podsOn":true}');
  // The lease is for the agent's own direction, with its reason.
  assert.deepEqual(asked, [
    {
      by: 'agent',
      gpu: 'NVIDIA A40',
      hours: 2,
      directions: ['d-1'],
      reason: 'Train.',
    },
  ]);
  assert.match(text(2), /lease-2 is not a lease of d-1\./);
  assert.deepEqual(ended, []);
  assert.match(
    text(3),
    /^Started r-1 at [0-9a-f]{7} \(on lease-1 \(NVIDIA A40\), up to 600 min\)\./,
  );
  assert.match(text(4), /from 1 to 240, or up to 1440 on a pod\./);
  await until(() => lab.lab.view()?.ledger[0]?.status === 'done');
  assert.deepEqual(lab.lab.view()?.ledger[0]?.metrics, { acc: 0.9 });
  // The run's panel says where it ran.
  const panel = runPanel(lab.lab.view()!, 'r-1', (value) => value);
  assert.match(
    panel.body,
    /<dt>Where<\/dt><dd>on lease-1 \(NVIDIA A40\)<\/dd>/,
  );
  // The agent has the pod tools and the pod part of its prompt.
  const thread = (
    (await lab.lines('d-1-alpha', 'threads.jsonl')) as {
      params: { dynamicTools: { name: string }[] };
    }[]
  )[0]?.params;
  assert.deepEqual(thread?.dynamicTools.map((tool) => tool.name).slice(-3), [
    'verifold_compute',
    'verifold_request_pod',
    'verifold_end_lease',
  ]);
  assert.match((await lab.inputs('d-1-alpha'))[0] ?? '', /Runs on a GPU pod:/);
  // A change of the lease that the agent did not make wakes it.
  lab.lab.leaseChanged(
    leases.get('lease-1') as Lease,
    'lease-1: The pod is ready.',
  );
  await until(async () =>
    (await lab.inputs('d-1-alpha')).some((input) =>
      input.includes('[pod] lease-1: The pod is ready.'),
    ),
  );
  // A stopped direction's leases end, so its pod bills no more, and its request is withdrawn. Another direction's lease stays.
  await lab.lab.stopDirection('d-1');
  await until(() => ended.length === 2);
  assert.deepEqual(ended, [
    { id: 'lease-1', by: 'person', reason: 'you stopped d-1.' },
    { id: 'lease-3', by: 'person', reason: 'you stopped d-1.' },
  ]);
});

await test('a paused lab starts no pod', async (t) => {
  const asked: unknown[] = [];
  const compute: LabCompute = {
    describe: () => Promise.resolve('{}'),
    requestPod: (input) => {
      asked.push(input);
      return Promise.resolve('Started lease-1.');
    },
    podCost: () => Promise.resolve(1),
    startPod: () => Promise.reject(new Error('No pod.')),
    podsOn: () => true,
    leases: {
      list: () => [],
      get: () => {
        throw new Error('No lease.');
      },
      end: () => Promise.reject(new Error('No lease.')),
    },
    podRuns: () => ({}) as PodRuns,
  };
  const lab = await fixture(t, { compute });
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  await lab.lab.pause();
  // A call that the agent's session makes while the lab is paused, such as one that was under way.
  const agent = lab.lab.view()?.directions[0]?.agent;
  const result = await (
    lab.lab as unknown as {
      call(
        id: string,
        generation: string,
        name: string,
        input: unknown,
        callId: string,
      ): Promise<{ ok: boolean; text: string }>;
    }
  ).call(
    agent?.id ?? '',
    agent?.generation ?? '',
    'verifold_request_pod',
    { gpuType: 'NVIDIA A40', hours: 1, why: 'Train.' },
    'c-1',
  );
  assert.deepEqual(result, {
    ok: false,
    text: 'The lab is paused, so no pod starts now.',
  });
  assert.deepEqual(asked, []);
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

/** Fixture assets for a desk server. Returns their folder. */
async function deskAssets(base: string): Promise<string> {
  const assets = join(base, 'assets');
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
  return assets;
}

await test('the desk offers the lab, shows posts escaped, and takes lab actions only with its token', async (t) => {
  const lab = await fixture(t);
  const assets = await deskAssets(lab.base);
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
  // The lab's header is its question.
  assert.match(
    view,
    /<h1 id="view-title" tabindex="-1">Do months lie on a circle\?<\/h1>/,
  );
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
  assert.match(
    board,
    /<span class="who who-claude" role="img" aria-label="Claude Code" title="Claude Code">Cl<\/span><span class="row-handle">claude-1<\/span>/,
  );
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
  // A call is answered and undone only with the desk's token.
  assert.match(
    (
      await agentCall(lab.lab, 'a-1', 'verifold_ask_person', {
        kind: 'go',
        question: 'More <i>time</i>?',
        options: [
          { label: 'Two hours', effect: { hours: 2 } },
          { label: 'No' },
        ],
        pick: 0,
        why: 'Seeds.',
      })
    ).text,
    /^Asked the person in c-1\./,
  );
  const needs = await home();
  assert.match(needs, /More &lt;i&gt;time&lt;\/i&gt;\?/);
  const calls =
    needs.match(/<button[^>]*data-action="lab-call-[^"]*"[^>]*>/g) ?? [];
  assert.equal(calls.length, 2);
  for (const control of calls)
    assert.doesNotMatch(
      control,
      / data-(direction|view|panel|task-select|worker|attempt|message-to|dock|diff)=/,
      control,
    );
  assert.equal(
    (
      await post({ action: 'lab-call-answer', call: 'c-1', option: '0' }, false)
    )[0],
    401,
  );
  assert.equal(lab.lab.view()?.state.calls[0]?.state, 'open');
  await slow(
    { action: 'lab-call-answer', call: 'c-1', option: '0' },
    () => lab.lab.view()?.state.calls[0]?.undoUntil !== null,
  );
  assert.match(await home(), /data-action="lab-call-undo" data-call="c-1"/);
  assert.equal(
    (await post({ action: 'lab-call-undo', call: 'c-1' }, false))[0],
    401,
  );
  await slow(
    { action: 'lab-call-undo', call: 'c-1' },
    () => lab.lab.view()?.state.calls[0]?.state === 'open',
  );
  assert.deepEqual(await post({ action: 'lab-call-undo', call: 'c-1' }), [
    409,
    { error: 'c-1 has no answer to undo.' },
  ]);
  assert.equal(
    (await post({ action: 'lab-direction-stop', direction: 'd-1' }))[0],
    200,
  );
  assert.match(await home(), /<span class="row-state">Stopped<\/span>/);
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
  assert.match(
    html,
    /<h1 id="view-title" tabindex="-1">Do LLMs store months on circles\?<\/h1>/,
  );
  // The request is the one thing that needs the person, so the Needs-you line shows it.
  assert.match(
    html,
    /<span class="needs-label">Needs you<\/span><span class="needs-title">Claude Code session asks to use Bash<\/span>/,
  );
  // Home's one box posts to the board. The permission request is answered in its line.
  assert.doesNotMatch(html, /id="message-text"/);
  assert.match(html, /data-action="answer" data-request="R1"/);
  // Each agent's row opens its panel, which holds its transcript.
  assert.match(
    html,
    /data-panel="agent" data-agent="a-1" data-open-pane="summary">What claude-1 did/,
  );
  const session = lab.lab.view()?.directions[0]?.agent.session ?? '';
  const panel = renderDesk(
    await readDeskSnapshot(lab.root),
    undefined,
    null,
    {
      session: null,
      controllable: true,
      lab: lab.lab.view(),
      labAgent: lab.sessions.view(session),
    },
    { view: 'home', panel: 'agent', agent: 'a-1' },
  ).html;
  assert.match(
    panel,
    /<p class="kind">Lab agent<\/p><h2 id="panel-title" tabindex="-1">claude-1<\/h2>/,
  );
  assert.match(
    panel,
    new RegExp(
      `<div class="transcript-slot[^"]*" data-source="session:${session}"`,
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
  const html = renderLab(crashed, (value) => value);
  assert.ok(
    html.indexOf('aria-label="Alpha"') < html.indexOf('aria-label="Beta"'),
  );
  const row = html.slice(
    html.indexOf('<li class="lab-row'),
    html.indexOf('</li>'),
  );
  assert.match(row, /Stopped by itself 3 times in an hour/);
  assert.match(row, /data-action="lab-agent-restart"/);
  assert.match(
    row,
    /data-action="lab-direction-stop" data-lab-direction="d-1"/,
  );
  // Each row has one shape: its verdict, its title and line, its agent, and its state; its controls open under it.
  assert.match(
    row,
    /^<li class="lab-row" id="row-d-1"><details id="row-open-d-1"><summary><span class="verdict v-open"><span aria-hidden="true">○<\/span> Not settled<\/span><span class="row-main"><strong>Alpha<\/strong><\/span><span class="row-who">[\s\S]*<\/span><span class="row-state failed">Stopped by itself 3 times in an hour<\/span><\/summary><div class="row-more">/,
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
    takeAgentTerminal: () => Promise.resolve(),
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
    takeAgentTerminal: () => Promise.resolve(),
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

  // The plan is a post on the board, with each bar under it.
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(
    html,
    /<article class="post" id="post-p-1" tabindex="-1">[\s\S]*<span class="chip kind-plan">Plan of record<\/span>/,
  );
  assert.match(
    html,
    /<th scope="row">Helix<\/th><td>it beats a circle for years · 3 runs · noise ±0\.02<\/td>/,
  );
  assert.match(html, /Engels 2024 <span class="fine">\(known\)<\/span>/);
  assert.match(html, /data-action="lab-reply" data-post="p-1"/);
  assert.match(html, /Reply to change the plan\. A reply wakes claude-1\./);
  assert.match(html, /<p class="lab-facts">Day 1 · Due <strong>/);
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
  // The turn with the new plan has the new bar. A later turn can follow it.
  assert.match(
    (await lab.inputs('d-2-helix')).find((input) =>
      input.includes(`[plan, for you] from claude-1, reply to p-1`),
    ) ?? '',
    /Holds up if: "it beats a circle for years by 0\.05 · 3 runs/,
  );
  // When the plan's author stops, the plan stays as it is, and the desk says so.
  await lab.lab.stopDirection('d-1');
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(html, /claude-1 no longer works, so the plan stays as it is\./);
  assert.doesNotMatch(html, /Reply to change the plan/);
  // The plan's table marks the stopped direction.
  assert.match(
    html,
    /<th scope="row">Circles <span class="fine">\(stopped\)<\/span><\/th>/,
  );
});

await test('when the time budget ends the lab pauses, a go call asks for more time, its answer resumes the lab, and its undo takes the hours back', async (t) => {
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
  // Verifold asks with a go call, with no pick of its own.
  await until(() => lab.lab.view()?.state.calls.length === 1);
  const asked = lab.lab.view()?.state.calls[0];
  assert.equal(asked?.by, 'verifold');
  assert.equal(asked?.kind, 'go');
  assert.equal(asked?.pick, null);
  assert.equal(asked?.deadline, lab.lab.view()?.state.budget?.deadline);
  const desk = async (): Promise<string> =>
    renderDesk(await readDeskSnapshot(lab.root), undefined, null, {
      session: null,
      controllable: true,
      lab: lab.lab.view(),
    }).html;
  let html = await desk();
  assert.match(
    html,
    /The time budget of 1 hour ended\. Continue 4 more hours\?/,
  );
  assert.match(
    html,
    /<button type="button" class="call-option" data-action="lab-call-answer" data-call="c-1" data-option="0"><span class="option-label"><span class="key" aria-hidden="true">1<\/span> Continue 4 more hours<\/span>/,
  );
  assert.match(
    html,
    /Gives the lab 4 more hours\. Undo takes the hours back\./,
  );
  // While the call asks, the notice offers no more time of its own.
  assert.doesNotMatch(html, /data-action="lab-budget"/);
  // A lab that its budget paused offers no plain Resume: more time resumes it.
  assert.doesNotMatch(html, /data-action="lab-resume"/);
  // A tick asks only once for the same deadline.
  await delay(200);
  assert.equal(lab.lab.view()?.state.calls.length, 1);

  // The answer is saved before its hours apply. Ticks meanwhile ask no second time for the same deadline.
  const inside = lab.lab as unknown as {
    apply: (...args: unknown[]) => Promise<unknown>;
    kick(): void;
  };
  const apply = inside.apply.bind(lab.lab);
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  inside.apply = async (...args) => {
    await gate;
    return apply(...args);
  };
  t.after(() => {
    inside.apply = apply;
    release();
  });
  const answering = lab.lab.answerCall('c-1', '0');
  await until(() => lab.lab.view()?.state.calls[0]?.state === 'answered');
  for (let tries = 0; tries < 5; tries++) {
    inside.kick();
    await delay(60);
  }
  assert.equal(lab.lab.view()?.state.calls.length, 1);
  inside.apply = apply;
  release();
  await answering;
  let state = lab.lab.view()?.state;
  assert.equal(state?.pausedAt, null);
  assert.equal(state?.budget?.hours, 5);
  assert.equal(state?.calls[0]?.state, 'answered');
  assert.deepEqual(state?.calls[0]?.applied, {
    type: 'hours',
    hours: 4,
    budget: asked?.deadline ? { hours: 1, deadline: asked.deadline } : null,
    deadline: state?.budget?.deadline,
  });
  await assert.rejects(
    lab.lab.answerCall('c-1', 0),
    /c-1 waits for no answer now\./,
  );
  html = await desk();
  assert.match(
    html,
    /You chose "Continue 4 more hours" on c-1\. <button type="button" class="link" data-action="lab-call-undo" data-call="c-1">Undo<\/button>/,
  );
  // The undo gives back the time budget before the answer: the lab is past
  // its deadline again, pauses, and the same call asks again.
  await lab.lab.undoCall('c-1');
  await assert.rejects(lab.lab.undoCall('c-1'), /c-1 has no answer to undo\./);
  await until(() => lab.lab.view()?.state.pausedFor === 'deadline');
  state = lab.lab.view()?.state;
  assert.deepEqual(state?.budget, { hours: 1, deadline: asked?.deadline });
  assert.equal(state?.calls[0]?.state, 'open');
  await delay(200);
  // A failure names each call, so a slow run says what asked.
  const calls = lab.lab.view()?.state.calls ?? [];
  assert.equal(
    calls.length,
    1,
    JSON.stringify({
      calls: calls.map(({ id, by, state, deadline, note, at }) => ({
        id,
        by,
        state,
        deadline,
        note,
        at,
      })),
      budget: lab.lab.view()?.state.budget,
      now: new Date().toISOString(),
    }),
  );
  assert.ok(
    lab.lab
      .view()
      ?.posts.some(
        (post) =>
          post.text ===
          'The person undid their answer to c-1. The lab has 4 hours less. The call is open again.',
      ),
  );

  // Ten more hours: long enough that the test ends before the next deadline.
  // More time from elsewhere withdraws the call that asks for it.
  await lab.lab.extend('10');
  state = lab.lab.view()?.state;
  assert.equal(state?.pausedAt, null);
  assert.equal(state?.pausedFor, null);
  assert.equal(state?.budget?.hours, 11);
  await until(() => lab.lab.view()?.state.calls[0]?.state === 'withdrawn');
  assert.equal(lab.lab.view()?.state.calls[0]?.note, 'The lab got more time.');
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
  for (const key of [
    'opener',
    'plan',
    'budget',
    'pausedFor',
    'agentStarts',
    'checks',
    'brought',
    'bringing',
    'signoff',
  ])
    delete old[key];
  for (const direction of old.directions)
    for (const key of ['runs', 'noise', 'buildsOn', 'verdict', 'evidence'])
      delete direction[key];
  await writeFile(path, JSON.stringify(old));
  // And every field that verdicts and asks to post added to an agent.
  const agentPath = join(lab.root, '.verifold', 'lab', 'agents', 'a-1.json');
  const agent = JSON.parse(await readFile(agentPath, 'utf8')) as Record<
    string,
    unknown
  >;
  for (const key of ['quietTurns', 'nudged']) delete agent[key];
  await writeFile(agentPath, JSON.stringify(agent));
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
  assert.equal(state?.directions[0]?.verdict, 'open');
  assert.equal(state?.directions[0]?.evidence, null);
  assert.deepEqual(state?.agentStarts, []);
  assert.deepEqual(state?.checks, []);
  assert.deepEqual(state?.brought, []);
  assert.equal(state?.bringing, null);
  assert.equal(state?.signoff, null);
  assert.equal(reloaded.view()?.directions[0]?.agent.quietTurns, 0);
  assert.equal(reloaded.view()?.directions[0]?.agent.nudged, false);
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
  // The go call asks also in a lab that the person paused.
  await until(() => lab.lab.view()?.state.calls[0]?.state === 'open');
  const html = renderDesk(await readDeskSnapshot(lab.root), undefined, null, {
    session: null,
    controllable: true,
    lab: lab.lab.view(),
  }).html;
  assert.match(html, /Its time budget ended too: give it more time first\./);
  assert.match(
    html,
    /data-action="lab-call-answer" data-call="c-1" data-option="0"/,
  );
  assert.doesNotMatch(html, /data-action="lab-resume"/);
  await lab.lab.answerCall('c-1', 0);
  assert.ok(lab.lab.view()?.state.pausedAt);
  await lab.lab.resume();
  assert.equal(lab.lab.view()?.state.pausedAt, null);
});

await test('a run event that waits in an agent record stays there after a restart', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('Do LLMs store months on circles?');
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  await lab.lab.close();
  const path = join(lab.root, '.verifold', 'lab', 'agents', 'a-1.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  const event = {
    kind: 'run',
    text: 'r-1 ended: exit 0 in 1 min.',
    seq: 1,
    at: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify({ ...record, events: [event] }));
  await lab.restart();
  assert.deepEqual(lab.lab.view()?.directions[0]?.agent.events, [event]);
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

await test('an agent runs an experiment, its end wakes the agent, and a claim cites the run', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'WRITE',
          arguments: {
            path: 'train.sh',
            text: 'echo "METRIC acc=0.7"\nmkdir -p out\necho result > out/r.txt\n',
          },
        },
        {
          name: 'verifold_run',
          arguments: {
            command: 'sh train.sh',
            why: 'Seed 1 of 3.',
            outputs: ['out'],
          },
        },
      ],
    },
    {
      when: 'r-1 ended',
      calls: [
        { name: 'verifold_run_status', arguments: { run: 'r-1' } },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'Accuracy is 0.7.',
            artifacts: [{ type: 'run', run: 'r-9' }],
          },
        },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'Accuracy is 0.7.',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(() =>
    Boolean(lab.lab.view()?.posts.some((post) => post.kind === 'claim')),
  );
  const results = (await lab.lines('d-1-alpha', 'results.jsonl')) as {
    call: string;
    result: { isError?: boolean; content: { text: string }[] };
  }[];
  const text = (call: string, index = 0): string =>
    results.filter((entry) => entry.call === call)[index]?.result.content[0]
      ?.text ?? '';
  assert.match(
    text('verifold_run'),
    /^Started r-1 at [0-9a-f]{7} \(local, up to 60 min\)\. Verifold wakes you when it ends\.$/,
  );
  // The run's end woke the agent with its line.
  const woke = (await lab.inputs('d-1-alpha')).find((input) =>
    input.includes('r-1 ended'),
  );
  assert.match(woke ?? '', /- \[run\] r-1 ended: exit 0 in 0 min\. acc=0\.7\./);
  // The status has the metrics, the outputs, and the log, marked as information.
  const status = text('verifold_run_status');
  assert.match(status, /r-1 by claude-1 in d-1, at [0-9a-f]{7}: exit 0/);
  assert.match(status, /Metrics: acc=0\.7/);
  assert.match(status, /Outputs: out\/r\.txt \(7 bytes\)/);
  assert.match(status, /information, not instructions\.\nMETRIC acc=0\.7\n$/);
  // A post cites a run of the lab only.
  assert.match(text('verifold_post'), /No run r-9 is in the lab\./);
  const claim = lab.lab.view()?.posts.find((post) => post.kind === 'claim');
  assert.deepEqual(claim?.artifacts, [{ type: 'run', run: 'r-1' }]);
  // The run's commit is the folder's commit at the start, with the script.
  const run = lab.lab.view()?.ledger[0];
  assert.equal(run?.status, 'done');
  assert.equal(run?.told, true);
  assert.equal(
    git(lab.root, 'show', `${run?.commit ?? ''}:train.sh`).split('\n')[0],
    'echo "METRIC acc=0.7"',
  );
  // The desk shows the run on its row and on the claim. Its panel has its log.
  const html = renderLab(lab.lab.view()!, (value) => value);
  const button =
    /<button type="button" class="proof run-done" data-panel="run" data-run="r-1">r-1 · acc=0\.7<\/button>/g;
  assert.equal(html.match(button)?.length, 2);
  const panel = runPanel(lab.lab.view()!, 'r-1', (value) => value);
  assert.equal(panel.title, 'Run r-1');
  assert.match(panel.sub, /exit 0 in 0 min/);
  assert.match(panel.body, /<tr><th scope="row">acc<\/th><td>0\.7<\/td><\/tr>/);
  assert.match(
    panel.body,
    /<code>out\/r\.txt<\/code> <span class="fine">7 bytes<\/span>/,
  );
  assert.match(panel.body, /id="panel-log-r-1" open>[\s\S]*data-run-log="r-1"/);
  assert.match(
    await lab.lab.runLog('r-1').then((log) => log?.text ?? ''),
    /METRIC acc=0\.7/,
  );
  assert.equal(await lab.lab.runLog('r-7'), null);
  // The desk serves a run's log with its token only, and refuses to cancel a run that ended.
  const stop = new AbortController();
  const desk = await startDesk(
    lab.root,
    stop.signal,
    pathToFileURL(`${await deskAssets(lab.base)}/cli/`),
    lab.sessions,
    undefined,
    undefined,
    undefined,
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
  const log = (query: string, authorized = true): Promise<Response> =>
    fetch(`${url.origin}/api/run-log?${query}`, {
      headers: authorized ? headers : {},
    });
  assert.equal((await log('run=r-1', false)).status, 401);
  assert.equal((await log('run=r-1&x=1')).status, 400);
  assert.equal((await log('run=../r-1')).status, 400);
  assert.equal((await log('run=r-7')).status, 404);
  const served = (await (await log('run=r-1')).json()) as {
    text: string;
    partial: boolean;
  };
  assert.match(served.text, /METRIC acc=0\.7/);
  assert.equal(served.partial, false);
  const cancel = await fetch(`${url.origin}/api/action`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'lab-run-cancel',
      run: 'r-1',
      key: 'c3'.repeat(16),
    }),
  });
  assert.equal(cancel.status, 409);
  assert.match(
    ((await cancel.json()) as { error: string }).error,
    /r-1 already ended: exit 0/,
  );
});

await test('runs stop when the agent or the person cancels them, or the direction stops, and a restart tells the agent of a run that ended meanwhile', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'One.', outputs: ['.'] },
        },
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'One.' },
        },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'evidence',
            text: 'Too early.',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
      ],
    },
    {
      when: 'r-1 ended',
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'Two.' },
        },
        {
          name: 'verifold_cancel_run',
          arguments: { run: 'r-2', why: 'The wrong seed.' },
        },
      ],
    },
    {
      when: 'r-2 ended',
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'Three.' },
        },
      ],
    },
    {
      when: 'r-3 ended',
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'Four.' },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const status = (id: string): string | undefined =>
    lab.lab.view()?.ledger.find((run) => run.id === id)?.status;
  await until(() => status('r-1') === 'running');
  // While its run runs, the agent waits for the run's end instead of its next turn.
  await delay(300);
  assert.equal((await lab.inputs('d-1-alpha')).length, 1);
  const first = (await lab.lines('d-1-alpha', 'results.jsonl')) as {
    result: { isError?: boolean; content: { text: string }[] };
  }[];
  assert.match(first[0]?.result.content[0]?.text ?? '', /not the whole copy/);
  // A run that still runs is no proof yet.
  assert.match(
    first[2]?.result.content[0]?.text ?? '',
    /r-1 still runs\. Cite it once it ends\./,
  );
  await lab.lab.cancelRun('r-1');
  await until(() => status('r-2') === 'cancelled');
  const ledger = lab.lab.view()?.ledger ?? [];
  assert.equal(ledger[0]?.cancelledBy, 'person');
  assert.equal(ledger[1]?.cancelledBy, 'a-1');
  // The owner stops: r-3 ends as interrupted, and the agent hears it after the restart.
  await until(() => status('r-3') === 'running');
  await lab.restart();
  assert.equal(status('r-3'), 'interrupted');
  await until(async () =>
    (await lab.inputs('d-1-alpha')).some((input) =>
      input.includes('r-3 ended: interrupted'),
    ),
  );
  // Stopping the direction cancels its runs.
  await until(() => status('r-4') === 'running');
  await lab.lab.stopDirection('d-1');
  await until(() => status('r-4') === 'cancelled');
  assert.equal(lab.lab.view()?.ledger[3]?.cancelledBy, 'person');
  await assert.rejects(lab.lab.cancelRun('r-4'), /r-4 already ended/);
});

await test('a direction stops also while one of its runs ends', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'Long.' },
        },
        {
          // A process outside the run's group keeps the pipes open, so the run ends for 2 seconds after its exit.
          name: 'verifold_run',
          arguments: {
            command: "perl -MPOSIX -e 'POSIX::setsid(); sleep 4' & sleep 0.5",
            why: 'Short.',
          },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const status = (id: string): string | undefined =>
    lab.lab.view()?.ledger.find((run) => run.id === id)?.status;
  await until(() => status('r-2') === 'running', 10_000);
  // r-2's shell exits after half a second. Its record ends about 2 seconds later.
  await delay(900);
  assert.equal(status('r-1'), 'running');
  assert.equal(status('r-2'), 'running');
  await lab.lab.stopDirection('d-1');
  const view = lab.lab.view();
  assert.equal(view?.state.directions[0]?.state, 'stopped');
  assert.ok(view?.directions[0]?.agent.stoppedAt);
  assert.match(view?.posts.at(-1)?.text ?? '', /The person stopped "Alpha"\./);
  await until(() => status('r-1') === 'cancelled' && status('r-2') === 'done');
  assert.equal(lab.lab.view()?.ledger[1]?.cancelledBy, null);
});

/** The results of an agent's tool calls, as its fake harness logged them. */
async function results(
  lab: Fixture,
  folder: string,
): Promise<{ ok: boolean; text: string }[]> {
  return (
    (await lab.lines(folder, 'results.jsonl')) as {
      result: { isError?: boolean; content: { text: string }[] };
    }[]
  ).map((entry) => ({
    ok: entry.result.isError !== true,
    text: entry.result.content[0]?.text ?? '',
  }));
}

await test('an agent gives its own direction a verdict with proof, and closes it after ruled-out', async (t) => {
  const lab = await fixture(t);
  const direction = (args: Record<string, unknown>): Call => ({
    name: 'verifold_direction',
    arguments: { why: 'Checked.', ...args },
  });
  await lab.script('d-1-alpha', [
    {
      calls: [
        direction({ action: 'update', verdict: 'leading', evidence: '0.78' }),
        { name: 'WRITE', arguments: { path: 'result.txt', text: '0.78\n' } },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'Months lie on a circle.',
            artifacts: [{ type: 'file', path: 'result.txt' }],
          },
        },
        {
          name: 'verifold_post',
          arguments: { kind: 'question', text: 'Is one seed enough?' },
        },
        direction({
          action: 'update',
          verdict: 'leading',
          post: 'p-3',
          evidence: '0.78',
        }),
        direction({
          action: 'update',
          verdict: 'holds-up',
          post: 'p-2',
          evidence: '0.78',
        }),
        direction({ action: 'close' }),
        direction({
          action: 'update',
          verdict: 'leading',
          post: 'p-2',
          evidence: '0.78 on 1 seed',
        }),
        {
          name: 'verifold_post',
          arguments: {
            kind: 'ruled-out',
            text: 'Three seeds disagree.',
            artifacts: [{ type: 'file', path: 'result.txt' }],
          },
        },
        direction({
          action: 'update',
          verdict: 'ruled-out',
          post: 'p-2',
          evidence: 'x',
        }),
        direction({
          action: 'update',
          verdict: 'ruled-out',
          post: 'p-5',
          evidence: '3 seeds spread 0.2',
        }),
        direction({ action: 'close', why: 'Ruled out on 3 seeds.' }),
        { name: 'WRITE', arguments: { path: 'last.txt', text: 'done\n' } },
        {
          name: 'verifold_post',
          arguments: { kind: 'question', text: 'Still here?' },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await results(lab, 'd-1-alpha')).length >= 12);
  const said = await results(lab, 'd-1-alpha');
  assert.deepEqual(
    said.map((entry) => entry.ok),
    [
      false,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
    ],
  );
  assert.match(said[0]?.text ?? '', /Name the post with the proof/);
  assert.match(
    said[3]?.text ?? '',
    /Leading needs a claim, evidence, or rerun post with proof, and p-3 is not one/,
  );
  // Holds up starts a check, and a check needs a run to rerun.
  assert.match(
    said[4]?.text ?? '',
    /Holds up needs a post that cites a run, so the other harness can rerun it, and p-2 cites none\./,
  );
  assert.match(said[5]?.text ?? '', /only after its verdict is ruled-out\./);
  assert.equal(said[6]?.text, 'd-1 is leading now.');
  assert.match(said[8]?.text ?? '', /Ruled out needs a ruled-out post/);
  assert.match(said[10]?.text ?? '', /Closed your direction/);
  // After the close, the agent's tools no longer work for the lab.
  assert.match(said[11]?.text ?? '', /no longer works for the lab/);

  const view = lab.lab.view();
  const state = view?.state.directions[0];
  assert.equal(state?.state, 'closed');
  assert.equal(state?.verdict, 'ruled-out');
  assert.deepEqual(state?.evidence, {
    text: '3 seeds spread 0.2',
    post: 'p-5',
    run: null,
  });
  assert.equal(view?.directions[0]?.status, 'closed');
  assert.equal(view?.directions[0]?.agent.stopReason, 'closed');
  // Each verdict and the close are notes in the direction's thread.
  const texts = view?.posts.map((post) => post.text) ?? [];
  assert.ok(
    texts.includes(
      'claude-1: "Alpha" is leading. Evidence: "0.78 on 1 seed" (p-2). Why: "Checked."',
    ),
  );
  assert.ok(
    texts.includes(
      'claude-1 closed "Alpha": ruled out. Why: "Ruled out on 3 seeds."',
    ),
  );
  // The session ends after the turn that closed the direction. The folder stays.
  const session = view?.directions[0]?.agent.session ?? '';
  await until(() => lab.sessions.view(session)?.record.status === 'ended');
  assert.match(git(lab.root, 'worktree', 'list'), /d-1-alpha/);
  // The branch keeps the work of the turn that closed it.
  await until(() => {
    const head = lab.lab.view()?.state.directions[0]?.head ?? '';
    try {
      return git(lab.root, 'show', `${head}:last.txt`) === 'done\n';
    } catch {
      return false;
    }
  });
  await assert.rejects(
    lab.lab.stopDirection('d-1'),
    /Its agent closed that direction already/,
  );
  // The desk shows the verdict with its evidence, and no Stop.
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(
    html,
    /<span class="verdict v-ruled-out"><span aria-hidden="true">×<\/span> Ruled out<\/span>/,
  );
  assert.match(html, /3 seeds spread 0\.2 · p-5/);
  assert.match(html, /Closed by its agent/);
  assert.doesNotMatch(html, /data-action="lab-direction-stop"/);
  // The project memory lists the direction with its verdict.
  const memory = new ProjectMemory(
    lab.root,
    () => Promise.resolve([]),
    () => lab.lab.progress(),
  );
  await memory.write();
  const progress = await readFile(
    join(lab.root, 'memory', 'progress.md'),
    'utf8',
  );
  assert.match(
    progress,
    /- d-1 Alpha, claude-1 \(Claude Code\): closed by its agent, ruled out\. Evidence: 3 seeds spread 0\.2 \(p-5\)\./,
  );
  assert.match(
    await readFile(join(lab.root, 'memory', 'README.md'), 'utf8'),
    /This run: a lab with 1 direction, 0 open/,
  );
});

await test('an agent opens a direction with its own agent, inside the team and the limits of agent starts', async (t) => {
  // The team is Claude Code only, and one agent works at a time.
  const lab = await fixture(t, { harnesses: ['claude'], agents: 1 });
  const opening = (title: string, harness: string): Call => ({
    name: 'verifold_direction',
    arguments: {
      action: 'open',
      title,
      bar: 'it beats the baseline on 3 seeds',
      harness,
      why: 'No direction tests a helix.',
    },
  });
  await lab.script('d-1-plan-the-lab', [
    {
      calls: [
        opening('Helix', 'codex'),
        {
          ...opening('Helix', 'claude'),
          arguments: {
            ...opening('Helix', 'claude').arguments,
            runs: 3,
            noise: '±0.02',
            buildsOn: [{ text: 'Engels et al.', known: true }],
          },
        },
        opening('Torus', 'claude'),
      ],
    },
  ]);
  await lab.lab.start('Do LLMs store months on circles?');
  await until(async () => (await results(lab, 'd-1-plan-the-lab')).length >= 3);
  const said = await results(lab, 'd-1-plan-the-lab');
  assert.deepEqual(
    said.map((entry) => entry.ok),
    [false, true, false],
  );
  assert.match(said[0]?.text ?? '', /Codex is not in this project's team/);
  // The opener holds the only slot, so the new agent waits for it.
  assert.equal(
    said[1]?.text,
    'Opened d-2 for claude-2 (Claude Code). Every agent slot is in use, so it starts when one is free.',
  );
  // "Agents at once" is 1, so agents start 1 agent in 24 hours.
  assert.match(
    said[2]?.text ?? '',
    /Agents started 1 agent in the last 24 hours/,
  );
  const state = lab.lab.view()?.state;
  assert.equal(state?.agentStarts.length, 1);
  const helix = state?.directions.find((entry) => entry.id === 'd-2');
  assert.equal(helix?.openedBy, 'a-1');
  assert.equal(helix?.bar, 'it beats the baseline on 3 seeds');
  assert.equal(helix?.runs, 3);
  assert.equal(helix?.noise, '±0.02');
  assert.deepEqual(helix?.buildsOn, [{ text: 'Engels et al.', known: true }]);
  // The note is in the new direction's thread, and it wakes no one.
  const note = lab.lab
    .view()
    ?.posts.find((post) => post.direction === 'd-2' && post.kind === 'status');
  assert.equal(
    note?.text,
    'claude-1 opened "Helix" for claude-2 (Claude Code). Why: "No direction tests a helix."',
  );
  // The new agent starts once the opener gives its slot.
  await until(async () => (await lab.inputs('d-2-helix')).length >= 1);
  assert.match(
    (await lab.inputs('d-2-helix'))[0] ?? '',
    /Holds up if: "it beats the baseline on 3 seeds · 3 runs · noise ±0\.02"/,
  );
});

await test('an agent that works without a post is asked once to post', async (t) => {
  const quiet = labLimits.quietTurns;
  labLimits.quietTurns = 3;
  t.after(() => {
    labLimits.quietTurns = quiet;
  });
  const lab = await fixture(t);
  const ask = 'You posted nothing in your last';
  // Each turn changes a file, so no turn waits longer.
  await lab.script(
    'd-1-alpha',
    [1, 2, 3, 4, 5].map((turn) => ({
      calls: [
        {
          name: 'WRITE',
          arguments: { path: `step-${turn}.txt`, text: `${turn}\n` },
        },
      ],
    })),
  );
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 6);
  const inputs = await lab.inputs('d-1-alpha');
  // After 3 quiet turns, the 4th turn asks once. The turns after it do not ask again.
  assert.ok(!inputs.slice(0, 3).some((input) => input.includes(ask)));
  assert.match(inputs[3] ?? '', /You posted nothing in your last 3 turns\./);
  assert.equal(inputs.filter((input) => input.includes(ask)).length, 1);
  const alpha = lab.lab.view()?.directions[0]?.agent;
  assert.equal(alpha?.nudged, true);
  assert.ok((alpha?.quietTurns ?? 0) >= 5);
});

await test('an agent that waits for its run is not asked to post until a turn comes', async (t) => {
  const quiet = labLimits.quietTurns;
  labLimits.quietTurns = 1;
  t.after(() => {
    labLimits.quietTurns = quiet;
  });
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'Long.' },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const status = (): string | undefined => lab.lab.view()?.ledger[0]?.status;
  await until(() => status() === 'running');
  // The turn that started the run was quiet, but the run's end wakes the agent: no ask and no turn meanwhile.
  await until(
    () => (lab.lab.view()?.directions[0]?.agent.quietTurns ?? 0) >= 1,
  );
  await delay(300);
  assert.equal((await lab.inputs('d-1-alpha')).length, 1);
  assert.equal(lab.lab.view()?.directions[0]?.agent.nudged, false);
  await lab.lab.cancelRun('r-1');
  // The digest of the run's end asks, once.
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 3);
  const inputs = await lab.inputs('d-1-alpha');
  assert.match(inputs[1] ?? '', /r-1 ended: cancelled/);
  assert.match(inputs[1] ?? '', /You posted nothing in your last turn\./);
  assert.doesNotMatch(inputs[2] ?? '', /You posted nothing/);
});

await test("a later plan's new directions count as agents that an agent starts", async (t) => {
  // "Agents at once" is 1, so agents start 1 agent in 24 hours.
  const lab = await fixture(t, { harnesses: ['claude'], agents: 1 });
  const plan = {
    reading: 'We read the question as: do months sit on a circle?',
    cost: 'Nothing costs money yet.',
  };
  const direction = (title: string): Record<string, unknown> => ({
    title,
    bar: 'it beats the baseline',
    runs: 3,
    noise: '±0.02',
    harness: 'claude',
  });
  await lab.script('d-1-plan-the-lab', [
    {
      when: 'post the plan of record',
      calls: [
        {
          name: 'verifold_plan',
          arguments: {
            ...plan,
            directions: [direction('Circles'), direction('Helix')],
            mine: 0,
          },
        },
        {
          name: 'verifold_plan',
          arguments: {
            ...plan,
            directions: [
              { id: 'd-1' },
              { id: 'd-2' },
              direction('Torus'),
              direction('Control'),
            ],
          },
        },
      ],
    },
  ]);
  await lab.lab.start('Do LLMs store months on circles?');
  await until(async () => (await results(lab, 'd-1-plan-the-lab')).length >= 2);
  const said = await results(lab, 'd-1-plan-the-lab');
  assert.ok(said[0]?.ok && said[1]?.ok);
  // The first plan opens the lab: its directions do not count.
  assert.match(said[0]?.text ?? '', /Opened d-2/);
  // The change opens one more, then the limit refuses the next.
  assert.match(said[1]?.text ?? '', /Opened d-3/);
  assert.match(
    said[1]?.text ?? '',
    /"Control": Agents started 1 agent in the last 24 hours/,
  );
  assert.equal(lab.lab.view()?.state.agentStarts.length, 1);
});

/** A turn that rules its direction out, closes it, writes one more file, and keeps running. */
const closingTurn: Call[] = [
  { name: 'WRITE', arguments: { path: 'result.txt', text: 'no\n' } },
  {
    name: 'verifold_post',
    arguments: {
      kind: 'ruled-out',
      text: 'It fails on 3 seeds.',
      artifacts: [{ type: 'file', path: 'result.txt' }],
    },
  },
  {
    name: 'verifold_direction',
    arguments: {
      action: 'update',
      verdict: 'ruled-out',
      post: 'p-2',
      evidence: 'fails on 3 seeds',
      why: 'Checked.',
    },
  },
  { name: 'verifold_direction', arguments: { action: 'close', why: 'Done.' } },
  { name: 'WRITE', arguments: { path: 'last.txt', text: 'done\n' } },
  { name: 'WAIT' },
];

/** The newest commit of the first direction has this file with this text. */
function committed(lab: Fixture, path: string, text: string): () => boolean {
  return () => {
    const head = lab.lab.view()?.state.directions[0]?.head ?? '';
    try {
      return git(lab.root, 'show', `${head}:${path}`) === text;
    } catch {
      return false;
    }
  };
}

await test('a pause during the turn that closed a direction ends its session and commits its work', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [{ calls: closingTurn }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await results(lab, 'd-1-alpha')).length >= 3);
  assert.ok((await results(lab, 'd-1-alpha')).every((entry) => entry.ok));
  const session = lab.lab.view()?.directions[0]?.agent.session ?? '';
  await lab.lab.pause();
  await until(() => lab.sessions.view(session)?.record.status === 'ended');
  await until(committed(lab, 'last.txt', 'done\n'));
  await until(() => lab.lab.view()?.directions[0]?.agent.finished === true);
});

await test('a restart during the turn that closed a direction commits its work, and a later start finishes a close that was left', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [{ calls: closingTurn }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await results(lab, 'd-1-alpha')).length >= 3);
  await lab.restart();
  await until(committed(lab, 'last.txt', 'done\n'));
  assert.equal(lab.lab.view()?.directions[0]?.agent.finished, true);
  // As if an owner stopped before the close was done: the next start commits the folder.
  await lab.lab.close();
  const path = join(lab.root, '.verifold', 'lab', 'agents', 'a-1.json');
  await writeFile(
    path,
    JSON.stringify({
      ...(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>),
      finished: false,
    }),
  );
  await writeFile(
    join(lab.root, '.verifold', 'workspaces', 'd-1-alpha', 'later.txt'),
    'done\n',
  );
  const reloaded = new Lab(lab.root, { sessions: lab.sessions, timing });
  await reloaded.load();
  t.after(() => reloaded.close());
  await until(() => {
    const head = reloaded.view()?.state.directions[0]?.head ?? '';
    try {
      return git(lab.root, 'show', `${head}:later.txt`) === 'done\n';
    } catch {
      return false;
    }
  });
  await until(() => reloaded.view()?.directions[0]?.agent.finished === true);
});

await test("a pod that a direction's agent asks for while its direction stops ends at once", async (t) => {
  const ended: { id: unknown; by: unknown }[] = [];
  const leases = new Map<string, Lease>();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = false;
  const compute: LabCompute = {
    describe: () => Promise.resolve('{}'),
    requestPod: async () => {
      asked = true;
      await gate;
      leases.set('lease-1', {
        id: 'lease-1',
        state: 'starting',
        tasks: [],
        directions: ['d-1'],
        history: [{ at: new Date().toISOString(), by: 'agent', text: '' }],
      } as unknown as Lease);
      return 'Started lease-1.';
    },
    podCost: () => Promise.resolve(1),
    startPod: () => Promise.reject(new Error('No pod.')),
    podsOn: () => true,
    leases: {
      list: () => [...leases.values()],
      get: (id) => leases.get(String(id)) as Lease,
      end: (id, by) => {
        ended.push({ id, by });
        return Promise.resolve(leases.get(String(id)) as Lease);
      },
    },
    podRuns: () => ({}) as PodRuns,
  };
  const lab = await fixture(t, { compute });
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_request_pod',
          arguments: { gpuType: 'NVIDIA A40', hours: 1, why: 'Train.' },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }], {
    gpuApproved: true,
  });
  await until(() => asked);
  // The stop ends the direction's leases before the new one exists.
  await lab.lab.stopDirection('d-1');
  assert.deepEqual(ended, []);
  release();
  await until(() => ended.length === 1);
  assert.deepEqual(ended, [{ id: 'lease-1', by: 'person' }]);
});

await test("a person's stop stays a stop when the lab cannot save it", async (t) => {
  const lab = await fixture(t);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(async () => (await lab.inputs('d-1-alpha')).length >= 1);
  const folder = join(lab.root, '.verifold');
  // lab.json cannot be written: the folder takes no new file.
  await chmod(folder, 0o500);
  try {
    await assert.rejects(
      lab.lab.stopDirection('d-1'),
      /Verifold stopped d-1, but could not save the lab/,
    );
    assert.equal(lab.lab.view()?.state.directions[0]?.state, 'stopped');
    const inputs = (await lab.inputs('d-1-alpha')).length;
    await delay(400);
    // No tick starts the agent that the person stopped.
    assert.equal((await lab.inputs('d-1-alpha')).length, inputs);
    assert.equal(lab.lab.view()?.directions[0]?.status, 'stopped');
  } finally {
    await chmod(folder, 0o700);
  }
  // The next save writes the stop.
  await lab.lab.post({ text: 'Noted.' });
  await lab.lab.pause();
  const saved = JSON.parse(
    await readFile(join(folder, 'lab.json'), 'utf8'),
  ) as { directions: { state: string }[] };
  assert.equal(saved.directions[0]?.state, 'stopped');
});

/** The answers of a fake harness's tool calls, from Claude Code or Codex. */
async function answers(
  lab: Fixture,
  folder: string,
): Promise<{ call: string; ok: boolean; text: string }[]> {
  return (
    (await lab.lines(folder, 'results.jsonl')) as {
      call: string;
      result: {
        isError?: boolean;
        success?: boolean;
        content?: { text: string }[];
        contentItems?: { text: string }[];
      };
    }[]
  ).map((entry) => ({
    call: entry.call,
    ok: entry.result.isError !== true && entry.result.success !== false,
    text:
      entry.result.content?.[0]?.text ??
      entry.result.contentItems?.[0]?.text ??
      '',
  }));
}

/**
 * Direction Alpha runs `sh train.sh` as r-1, then posts a question with a
 * marker and a claim that cites r-1. `then` runs after the claim. A lab with
 * a team plans first, so Alpha is d-2 there.
 */
async function claimWithRun(
  lab: Fixture,
  then: Call[] = [],
  folder = 'd-1-alpha',
): Promise<void> {
  await lab.script(folder, [
    {
      calls: [
        {
          name: 'WRITE',
          arguments: { path: 'train.sh', text: 'echo "METRIC acc=0.7"\n' },
        },
        {
          name: 'verifold_run',
          arguments: { command: 'sh train.sh', why: 'AUTHOR_WHY_MARKER' },
        },
      ],
    },
    {
      when: 'r-1 ended',
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'question',
            text: 'AUTHOR_REASONING_MARKER: I think the old mix wins.',
          },
        },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'Accuracy is 0.7.',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
        ...then,
      ],
    },
  ]);
}

/** The claim post of a lab, once it is on the board. */
async function claimPost(lab: Fixture): Promise<string> {
  await until(() =>
    Boolean(lab.lab.view()?.posts.some((post) => post.kind === 'claim')),
  );
  return lab.lab.view()?.posts.find((post) => post.kind === 'claim')?.id ?? '';
}

await test("an objection to a claim with a run starts a fresh checker of the other harness that cannot read the author's reasoning, and its rerun settles the dispute", async (t) => {
  // Without a team option the team has both harnesses, and no agent plans the lab.
  const specs: SandboxSpec[] = [];
  const lab = await fixture(t, {
    sandbox: (spec) => {
      specs.push(spec);
      return { file: '/bin/sh', args: ['-c', spec.command] };
    },
    memory: () => ({
      note: () => Promise.resolve('Noted.'),
      digest: () => Promise.resolve('MEMORY_MARKER: an earlier run.'),
    }),
  });
  await claimWithRun(lab);
  await lab.script('k-1', [
    {
      calls: [
        { name: 'verifold_read', arguments: { path: 'train.sh' } },
        {
          name: 'verifold_run',
          arguments: { command: 'sh train.sh', why: 'Rerun.' },
        },
      ],
    },
    {
      when: 'r-2 ended',
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'rerun',
            text: 'Holds: acc 0.7 on my rerun.',
            outcome: 'holds',
            method: 'rerun',
            artifacts: [{ type: 'run', run: 'r-2' }],
          },
        },
      ],
    },
  ]);
  // The lab plans nothing here: the person opens the direction.
  await lab.lab.start('Does the old mix win?');
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Alpha', harness: 'claude' });
  await lab.lab.resume();
  const claim = await claimPost(lab);
  const objection = await lab.lab.post({
    kind: 'objection',
    replyTo: claim,
    text: 'Is the test set clean?',
  });
  // The check queues, and it is an open dispute on the desk.
  await until(() => (lab.lab.view()?.checks.length ?? 0) === 1);
  const queued = lab.lab.view()?.checks[0];
  assert.equal(queued?.claim, claim);
  assert.deepEqual(queued?.objections, [objection.id]);
  assert.equal(queued?.harness, 'codex');
  assert.equal(queued?.sameHarness, false);
  assert.equal(queued?.run, 'r-1');
  await until(() => lab.lab.view()?.checks[0]?.state === 'done', 15_000);
  const check = lab.lab.view()?.checks[0];
  assert.equal(check?.outcome, 'holds');
  assert.equal(check?.method, 'rerun');

  // The checker's folder holds the claim's commit, with no Git data of the project.
  const folder = join(lab.root, '.verifold', 'checks', 'k-1');
  assert.equal(
    await readFile(join(folder, 'train.sh'), 'utf8'),
    'echo "METRIC acc=0.7"\n',
  );
  const log = git(folder, 'log', '--all', '--format=%s');
  assert.match(log, /Verifold: the start of a check/);
  assert.doesNotMatch(log, /^start$/m);
  // Its prompt has the claim, the command, and the objection, and nothing of the author's reasoning.
  const prompt = (await lab.inputs('k-1'))[0] ?? '';
  assert.match(prompt, /Accuracy is 0\.7\./);
  assert.match(prompt, /"sh train\.sh"/);
  assert.match(prompt, /acc=0\.7/);
  assert.match(prompt, /Is the test set clean\?/);
  assert.doesNotMatch(prompt, /AUTHOR_REASONING_MARKER/);
  assert.doesNotMatch(prompt, /AUTHOR_WHY_MARKER/);
  assert.doesNotMatch(prompt, /MEMORY_MARKER/);
  assert.doesNotMatch(prompt, /Turn 1\./);
  // The author's own prompt had the memory: only the checker goes without it.
  assert.match((await lab.inputs('d-1-alpha'))[0] ?? '', /MEMORY_MARKER/);
  // Codex denies the lab's records, the other folders, and both harnesses' transcripts.
  const threads = (await lab.lines('k-1', 'threads.jsonl')) as {
    params: {
      config: {
        permissions: Record<string, { filesystem: Record<string, string> }>;
      };
      dynamicTools: { name: string }[];
    };
  }[];
  const denied =
    threads[0]?.params.config.permissions['verifold-strict']?.filesystem;
  for (const path of [
    join(lab.root, '.verifold', 'board'),
    join(lab.root, '.verifold', 'lab'),
    join(lab.root, '.verifold', 'sessions'),
    join(lab.root, '.verifold', 'lab.json'),
    // Every direction's folder, also one that opens later, and every run's folder.
    join(lab.root, '.verifold', 'workspaces'),
    join(lab.root, 'memory'),
    join(lab.root, '.git'),
    // A check folder that does not exist yet, of the next numbers.
    join(lab.root, '.verifold', 'checks', 'k-2'),
    join(lab.root, '.verifold', 'checks', 'k-17'),
    // Claude Code's temporary folder of the author's direction.
    join(
      await realpath('/tmp'),
      `claude-${process.getuid?.() ?? 0}`,
      join(lab.root, '.verifold', 'workspaces', 'd-1-alpha').replace(
        /[^A-Za-z0-9]/g,
        '-',
      ),
    ),
    '~/.claude',
    '~/.codex',
    '~/.ssh',
  ])
    assert.equal(denied?.[path], 'deny', path);
  assert.equal(
    denied?.[join(lab.root, '.verifold', 'checks', 'k-18')],
    undefined,
  );
  assert.equal(denied?.[folder], undefined);
  assert.equal(denied?.[join(lab.root, '.verifold', 'checks')], undefined);
  // The checker has its own tools: no board, no plan, no direction.
  assert.deepEqual(
    threads[0]?.params.dynamicTools.map((tool) => tool.name),
    ['verifold_run', 'verifold_run_status', 'verifold_read', 'verifold_post'],
  );
  // The checker's run cannot read the lab's records either. The author's run could.
  // Its sandbox keeps the run's own folder open inside the denied .verifold.
  assert.equal(specs.length, 2);
  assert.ok(!specs[0]?.denied.includes(join(lab.root, '.verifold')));
  for (const path of [
    join(lab.root, '.verifold'),
    join(lab.root, 'memory'),
    join(lab.root, '.git'),
  ])
    assert.ok(specs[1]?.denied.includes(path), path);
  // The checker's read and run worked.
  const said = await answers(lab, 'k-1');
  assert.equal(said[0]?.text, 'echo "METRIC acc=0.7"\n');
  assert.match(said[1]?.text ?? '', /^Started r-2 at [0-9a-f]{7}/);

  // The rerun replies to the claim, mentions the author, and settles the dispute.
  const view = lab.lab.view();
  const rerun = view?.posts.find((post) => post.kind === 'rerun');
  assert.equal(rerun?.author, check?.agent);
  assert.equal(rerun?.replyTo, claim);
  assert.deepEqual(rerun?.mentions, ['a-1']);
  assert.deepEqual(rerun?.artifacts, [{ type: 'run', run: 'r-2' }]);
  assert.equal(view?.handles[check?.agent ?? ''], 'codex-1');
  await until(async () =>
    (await lab.inputs('d-1-alpha')).some((input) =>
      input.includes('Holds: acc 0.7 on my rerun.'),
    ),
  );
  const html = renderLab(view, (value) => value);
  assert.doesNotMatch(html, /Open disputes/);
  assert.match(html, /reran r-2 \(Codex\): acc=0\.7/);
  // The checker's session ended after its post.
  await until(
    () => lab.sessions.view(check?.session ?? '')?.record.status === 'ended',
  );
});

await test('an ask for holds-up starts a check, and the direction holds up when the rerun holds', async (t) => {
  const lab = await fixture(t);
  await claimWithRun(lab, [
    // Without its line of evidence the ask is refused, and no check queues.
    {
      name: 'verifold_direction',
      arguments: {
        action: 'update',
        verdict: 'holds-up',
        post: 'p-3',
        why: 'It meets the bar.',
      },
    },
    {
      name: 'verifold_direction',
      arguments: {
        action: 'update',
        verdict: 'holds-up',
        post: 'p-3',
        evidence: 'acc 0.7',
        why: 'It meets the bar.',
      },
    },
  ]);
  await lab.script('k-1', [
    {
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sh train.sh', why: 'Rerun.' },
        },
      ],
    },
    {
      when: 'r-2 ended',
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'rerun',
            text: 'Holds.',
            outcome: 'holds',
            method: 'rerun',
            artifacts: [{ type: 'run', run: 'r-2' }],
          },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  assert.equal(await claimPost(lab), 'p-3');
  await until(
    async () =>
      (await answers(lab, 'd-1-alpha')).filter(
        (entry) => entry.call === 'verifold_direction',
      ).length >= 2,
  );
  const [refused, asked] = (await answers(lab, 'd-1-alpha')).filter(
    (entry) => entry.call === 'verifold_direction',
  );
  assert.equal(refused?.ok, false);
  assert.match(refused?.text ?? '', /one line of evidence/);
  assert.match(
    asked?.text ?? '',
    /^d-1 is leading now\. (Verifold queued check k-1|Check k-1 runs): codex-1 \(Codex\) reruns p-3 without your reasoning\. When it holds, d-1 holds up\.$/,
  );
  await until(
    () => lab.lab.view()?.state.directions[0]?.verdict === 'holds-up',
    15_000,
  );
  const direction = lab.lab.view()?.state.directions[0];
  assert.deepEqual(direction?.evidence, {
    text: 'acc 0.7',
    post: 'p-3',
    run: 'r-1',
  });
  // The note follows the verdict.
  await until(() =>
    Boolean(
      lab.lab
        .view()
        ?.posts.some((post) =>
          /"Alpha" holds up: codex-1 \(Codex\) reran p-3 in p-\d+\./.test(
            post.text,
          ),
        ),
    ),
  );
  assert.equal(lab.lab.view()?.checks.length, 1);
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(
    html,
    /verdict v-holds-up"><span aria-hidden="true">✓<\/span> Holds up</,
  );
  assert.match(
    html,
    /acc 0\.7 · p-3 · r-1<\/span>[\s\S]*?<span class="row-state">reran r-2 \(Codex\): acc=0\.7<\/span>/,
  );
  // A newer check of the post runs: an ask for holds-up now waits for it, and the mark shows it first.
  await lab.script('k-2', [
    {
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 5', why: 'Another rerun.' },
        },
      ],
    },
  ]);
  await lab.lab.post({ kind: 'objection', replyTo: 'p-3', text: 'Again?' });
  await until(() => lab.lab.view()?.checks[1]?.state === 'running', 15_000);
  const scripted = JSON.parse(
    await readFile(join(lab.base, 'scripts', 'd-1-alpha.json'), 'utf8'),
  ) as { when?: string; calls: Call[] }[];
  await lab.script('d-1-alpha', [
    ...scripted,
    {
      when: 'ASK_AGAIN',
      calls: [
        {
          name: 'verifold_direction',
          arguments: {
            action: 'update',
            verdict: 'holds-up',
            post: 'p-3',
            evidence: 'acc 0.7',
            why: 'Again.',
          },
        },
      ],
    },
  ]);
  const before = (await answers(lab, 'd-1-alpha')).length;
  await lab.lab.post({ text: 'ASK_AGAIN', direction: 'd-1' });
  await until(async () => (await answers(lab, 'd-1-alpha')).length > before);
  const again = (await answers(lab, 'd-1-alpha')).at(-1);
  assert.match(again?.text ?? '', /^d-1 is leading now\. Check k-2 runs/);
  assert.equal(lab.lab.view()?.state.directions[0]?.verdict, 'leading');
  assert.equal(lab.lab.view()?.checks[1]?.holdsUp, true);
  const later = renderLab(lab.lab.view()!, (value) => value);
  assert.match(later, /codex-2 checks it/);
});

await test('a rerun that does not hold takes back the verdict, and the claim can no longer hold up', async (t) => {
  const lab = await fixture(t);
  const update = (verdict: string): Call => ({
    name: 'verifold_direction',
    arguments: {
      action: 'update',
      verdict,
      post: 'p-3',
      evidence: 'acc 0.7',
      why: 'Checked.',
    },
  });
  await claimWithRun(lab, [update('leading')]);
  await lab.script('d-1-alpha', [
    ...(JSON.parse(
      await readFile(join(lab.base, 'scripts', 'd-1-alpha.json'), 'utf8'),
    ) as { when?: string; calls: Call[] }[]),
    { when: 'Leaks.', calls: [update('holds-up'), update('leading')] },
  ]);
  await lab.script('k-1', [
    {
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'echo "METRIC acc=0.5"', why: 'My metric.' },
        },
      ],
    },
    {
      when: 'r-2 ended',
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'rerun',
            text: 'Leaks. My own metric gives 0.5.',
            outcome: 'fails',
            method: 'rerun',
            artifacts: [{ type: 'run', run: 'r-2' }],
          },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  await until(() => lab.lab.view()?.state.directions[0]?.verdict === 'leading');
  // The person's post would go into a turn that still runs, so it waits for the turn's last answer.
  await until(async () =>
    (await answers(lab, 'd-1-alpha')).some(
      (entry) => entry.call === 'verifold_direction',
    ),
  );
  await lab.lab.post({
    kind: 'objection',
    replyTo: claim,
    text: 'The test set leaks.',
  });
  await until(() => lab.lab.view()?.checks[0]?.state === 'done', 15_000);
  assert.equal(lab.lab.view()?.checks[0]?.outcome, 'fails');
  // The verdict rested on the claim, so it goes back to open.
  await until(() => lab.lab.view()?.state.directions[0]?.verdict === 'open');
  assert.equal(lab.lab.view()?.state.directions[0]?.evidence, null);
  // The rerun woke the author, and neither holds-up nor leading takes the claim again.
  await until(
    async () =>
      (await answers(lab, 'd-1-alpha')).filter(
        (entry) => entry.call === 'verifold_direction',
      ).length >= 3,
  );
  const said = (await answers(lab, 'd-1-alpha')).filter(
    (entry) => entry.call === 'verifold_direction',
  );
  for (const entry of said.slice(1)) {
    assert.equal(entry.ok, false);
    assert.match(entry.text, /p-3 did not hold on its check k-1\./);
  }
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(html, /did not hold on r-2 \(Codex\)/);
  assert.doesNotMatch(html, /Open disputes/);
  // The rerun that did not hold is no evidence: not for leading, not for holds-up.
  const rerun =
    lab.lab.view()?.posts.find((post) => post.kind === 'rerun')?.id ?? '';
  const scripted = JSON.parse(
    await readFile(join(lab.base, 'scripts', 'd-1-alpha.json'), 'utf8'),
  ) as { when?: string; calls: Call[] }[];
  await lab.script('d-1-alpha', [
    ...scripted,
    {
      when: 'TRY_THE_RERUN',
      calls: [
        {
          name: 'verifold_direction',
          arguments: {
            action: 'update',
            verdict: 'leading',
            post: rerun,
            evidence: 'acc 0.5',
            why: 'x',
          },
        },
        {
          name: 'verifold_direction',
          arguments: {
            action: 'update',
            verdict: 'holds-up',
            post: rerun,
            evidence: 'acc 0.5',
            why: 'x',
          },
        },
      ],
    },
  ]);
  const before = (await answers(lab, 'd-1-alpha')).length;
  await lab.lab.post({ text: 'TRY_THE_RERUN', direction: 'd-1' });
  await until(
    async () => (await answers(lab, 'd-1-alpha')).length >= before + 2,
  );
  for (const entry of (await answers(lab, 'd-1-alpha')).slice(before)) {
    assert.equal(entry.ok, false);
    assert.match(
      entry.text,
      /is a rerun that did not hold, so it is no evidence/,
    );
  }
  assert.equal(lab.lab.view()?.state.directions[0]?.verdict, 'open');
});

await test('with one harness a fresh session of the same harness checks, and a check that runs out of time fails and keeps the dispute open', async (t) => {
  // With a team, the lab's first agent plans it (claude-1), so Alpha is d-2 (claude-2).
  const lab = await fixture(t, { harnesses: ['claude'], minuteMs: 10 });
  await claimWithRun(lab, [], 'd-2-alpha');
  // The checker never posts: its turn waits until its time ends.
  await lab.script('k-1', [{ calls: [{ name: 'WAIT' }] }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  await lab.lab.post({ kind: 'objection', replyTo: claim, text: 'Doubt.' });
  // The session is known once its start returns.
  await until(
    () =>
      lab.lab.view()?.checks[0]?.state === 'running' &&
      Boolean(lab.lab.view()?.checks[0]?.session),
  );
  const check = lab.lab.view()?.checks[0];
  assert.equal(check?.harness, 'claude');
  assert.equal(check?.sameHarness, true);
  assert.equal(check?.handle, 'claude-3');
  // Claude Code's settings deny the lab's records to the checker, also to its Read tool.
  await until(async () =>
    Boolean(
      await readFile(join(lab.base, 'logs', 'k-1', 'args.json'), 'utf8').catch(
        () => '',
      ),
    ),
  );
  const args = JSON.parse(
    await readFile(join(lab.base, 'logs', 'k-1', 'args.json'), 'utf8'),
  ) as string[];
  const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}') as {
    sandbox: { filesystem: { denyRead: string[] } };
    permissions: { deny: string[] };
  };
  const board = join(lab.root, '.verifold', 'board');
  assert.ok(settings.sandbox.filesystem.denyRead.includes(board));
  assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.claude'));
  assert.ok(settings.permissions.deny.includes(`Read(/${board}/**)`));
  // The desk pins the dispute while the check runs.
  let html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(html, /Open disputes/);
  assert.match(html, /claude-3 \(Claude Code\) checks it now/);
  // 60 short minutes later the check fails, and the dispute stays open.
  await until(() => lab.lab.view()?.checks[0]?.state === 'failed', 15_000);
  assert.match(
    lab.lab.view()?.checks[0]?.note ?? '',
    /claude-3 posted no rerun in 60 minutes\./,
  );
  // The note follows the failed state.
  await until(() =>
    Boolean(
      lab.lab
        .view()
        ?.posts.some((post) =>
          /^Check k-1 of p-\d+ failed: .* The dispute stays open\.$/.test(
            post.text,
          ),
        ),
    ),
  );
  html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(html, /Open disputes/);
  assert.match(html, /Check k-1 failed: claude-3 posted no rerun/);
  await until(
    () => lab.sessions.view(check?.session ?? '')?.record.status === 'ended',
  );
});

await test("a checker posts one rerun only, reads only the claim's commit, and reads only its own runs", async (t) => {
  const lab = await fixture(t);
  await claimWithRun(lab);
  await lab.script('k-1', [
    {
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'x',
            outcome: 'holds',
            method: 'rerun',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
        { name: 'verifold_run_status', arguments: { run: 'r-1' } },
        { name: 'verifold_read', arguments: { path: 'missing.txt' } },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'rerun',
            text: 'Holds, I only ran it.',
            outcome: 'holds',
            method: 'rerun',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'rerun',
            text: 'The code is right.',
            outcome: 'holds',
            method: 'code-read',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'rerun',
            text: 'Again.',
            outcome: 'holds',
            method: 'code-read',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  await lab.lab.post({ kind: 'objection', replyTo: claim, text: 'Doubt.' });
  await until(async () => (await answers(lab, 'k-1')).length >= 6, 15_000);
  const said = await answers(lab, 'k-1');
  assert.deepEqual(
    said.map((entry) => entry.ok),
    [false, false, false, false, true, false],
  );
  assert.match(said[0]?.text ?? '', /posts one rerun post, and nothing else/);
  assert.match(said[1]?.text ?? '', /Name one of your runs/);
  assert.match(said[2]?.text ?? '', /missing\.txt is not a file of the claim/);
  assert.match(said[3]?.text ?? '', /A rerun cites a run that you made/);
  assert.match(said[4]?.text ?? '', /^Posted p-\d+\. Your check is done/);
  assert.match(said[5]?.text ?? '', /no longer works for the lab|already/);
  const check = lab.lab.view()?.checks[0];
  assert.equal(check?.state, 'done');
  assert.equal(check?.method, 'code-read');
  // A code-read settles the dispute, and its mark says how it checked.
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(html, /read the code only \(Codex\)/);
  assert.equal(
    lab.lab.view()?.posts.filter((post) => post.kind === 'rerun').length,
    1,
  );
});

await test('one check runs at a time, a second objection joins the open check, and a claim gets at most two checks', async (t) => {
  const lab = await fixture(t);
  await claimWithRun(lab, [
    {
      name: 'verifold_post',
      arguments: {
        kind: 'evidence',
        text: 'Seed 2 too.',
        artifacts: [{ type: 'run', run: 'r-1' }],
      },
    },
  ]);
  // Each checker ends its turns without a post, so its check fails after 3 turns.
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  await until(() =>
    Boolean(lab.lab.view()?.posts.some((post) => post.kind === 'evidence')),
  );
  const evidence =
    lab.lab.view()?.posts.find((post) => post.kind === 'evidence')?.id ?? '';
  await lab.lab.pause();
  const first = await lab.lab.post({
    kind: 'objection',
    replyTo: claim,
    text: 'One.',
  });
  const second = await lab.lab.post({
    kind: 'objection',
    replyTo: claim,
    text: 'Two.',
  });
  await lab.lab.post({ kind: 'objection', replyTo: evidence, text: 'Three.' });
  let checks = lab.lab.view()?.checks ?? [];
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0]?.objections, [first.id, second.id]);
  assert.equal(checks[1]?.claim, evidence);
  // While paused, no check starts.
  await delay(200);
  assert.ok(checks.every((check) => check.state === 'queued'));
  await lab.lab.resume();
  // One check runs at a time: the second waits while the first runs.
  await until(() =>
    Boolean(lab.lab.view()?.checks.some((check) => check.state !== 'queued')),
  );
  checks = lab.lab.view()?.checks ?? [];
  assert.ok(checks.filter((check) => check.state === 'running').length <= 1);
  await until(
    () =>
      (lab.lab.view()?.checks ?? []).every((check) => check.state === 'failed'),
    15_000,
  );
  assert.match(
    lab.lab.view()?.checks[0]?.note ?? '',
    /posted no rerun in 3 turns\./,
  );
  // A second check of the claim, then no third.
  await lab.lab.post({ kind: 'objection', replyTo: claim, text: 'Four.' });
  await until(() => (lab.lab.view()?.checks.length ?? 0) === 3);
  await until(() => lab.lab.view()?.checks[2]?.state === 'failed', 15_000);
  const fifth = await lab.lab.post({
    kind: 'objection',
    replyTo: claim,
    text: 'Five.',
  });
  assert.equal(lab.lab.view()?.checks.length, 3);
  assert.ok(
    lab.lab
      .view()
      ?.posts.some(
        (post) =>
          post.text ===
          `${claim} had 2 checks already. ${fifth.id} starts no check.`,
      ),
  );
  // The claim had its checks, so its objections stay replies. The evidence can get one more check, so its dispute stays pinned.
  const html = renderLab(lab.lab.view()!, (value) => value);
  const pinned = html.slice(
    html.indexOf('<ul class="lab-pinned"'),
    html.indexOf('</ul>', html.indexOf('<ul class="lab-pinned"')),
  );
  assert.match(pinned, new RegExp(`href="#post-${evidence}"`));
  assert.doesNotMatch(pinned, new RegExp(`href="#post-${claim}"`));
});

await test('a check that ran when Verifold stopped starts again once with a fresh session, and fails after a second stop', async (t) => {
  const lab = await fixture(t, { harnesses: ['claude'] });
  await claimWithRun(lab, [], 'd-2-alpha');
  await lab.script('k-1', [
    { calls: [{ name: 'WAIT' }] },
    { calls: [{ name: 'WAIT' }] },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  await lab.lab.post({ kind: 'objection', replyTo: claim, text: 'Doubt.' });
  await until(
    () =>
      lab.lab.view()?.checks[0]?.session !== null &&
      lab.lab.view()?.checks[0]?.state === 'running',
  );
  await until(async () => (await lab.inputs('k-1')).length === 1);
  const before = lab.lab.view()?.checks[0]?.session;
  await lab.restart();
  // The new owner starts it again with a fresh session.
  await until(
    () =>
      lab.lab.view()?.checks[0]?.state === 'running' &&
      Boolean(lab.lab.view()?.checks[0]?.session) &&
      lab.lab.view()?.checks[0]?.session !== before,
  );
  assert.equal(lab.lab.view()?.checks[0]?.restarts, 1);
  await until(async () => (await lab.inputs('k-1')).length === 2);
  await lab.restart();
  await until(() => lab.lab.view()?.checks[0]?.state === 'failed');
  assert.match(
    lab.lab.view()?.checks[0]?.note ?? '',
    /claude-3 stopped 2 times before it posted\./,
  );
  // The failure is on the board, as for any failed check.
  await until(() =>
    Boolean(
      lab.lab
        .view()
        ?.posts.some((post) =>
          /^Check k-1 of p-\d+ failed: claude-3 stopped 2 times before it posted\./.test(
            post.text,
          ),
        ),
    ),
  );
});

await test('an ask for holds-up that no longer stands drops its check: its runs stop, its agent ID stays its own, and it does not count toward the cap', async (t) => {
  const lab = await fixture(t);
  await claimWithRun(lab, [
    {
      name: 'verifold_direction',
      arguments: {
        action: 'update',
        verdict: 'holds-up',
        post: 'p-3',
        evidence: 'acc 0.7',
        why: 'It meets the bar.',
      },
    },
  ]);
  // The checker starts a long run, then waits in its turn.
  await lab.script('k-1', [
    {
      calls: [
        {
          name: 'verifold_run',
          arguments: { command: 'sleep 30', why: 'A long rerun.' },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(
    () =>
      lab.lab
        .view()
        ?.ledger.some((run) => run.id === 'r-2' && run.status === 'running') ??
      false,
    15_000,
  );
  // A pause ends the checker's session; the check waits, and its run goes on.
  await lab.lab.pause();
  assert.equal(lab.lab.view()?.checks[0]?.state, 'queued');
  await lab.lab.stopDirection('d-1');
  // The check served only the ask: it is dropped, its run stops, and it stays in the record.
  const dropped = lab.lab.view()?.checks[0];
  assert.equal(dropped?.state, 'dropped');
  assert.match(
    dropped?.note ?? '',
    /^d-1 stopped, so its ask for holds-up no longer stands\.$/,
  );
  await until(
    () =>
      lab.lab.view()?.ledger.find((run) => run.id === 'r-2')?.status ===
      'cancelled',
  );
  assert.equal(
    lab.lab.view()?.ledger.find((run) => run.id === 'r-2')?.cancelledBy,
    dropped?.agent,
  );
  assert.ok(
    lab.lab
      .view()
      ?.posts.some(
        (post) =>
          post.text ===
          'Check k-1 of p-3 stopped: d-1 stopped, so its ask for holds-up no longer stands.',
      ),
  );
  // Two more checks of p-3 can start: the dropped one does not count, and its agent ID is not used again.
  await lab.lab.post({ kind: 'objection', replyTo: 'p-3', text: 'One.' });
  const second = lab.lab.view()?.checks[1];
  assert.equal(second?.state, 'queued');
  assert.notEqual(second?.agent, dropped?.agent);
  assert.ok(
    Number(second?.agent.slice(2)) > Number(dropped?.agent.slice(2) ?? 0),
  );
  await lab.lab.resume();
  await until(() => lab.lab.view()?.checks[1]?.state === 'failed', 15_000);
  await lab.lab.post({ kind: 'objection', replyTo: 'p-3', text: 'Two.' });
  assert.equal(lab.lab.view()?.checks.length, 3);
  assert.equal(lab.lab.view()?.checks[2]?.state, 'queued');
});

await test('an objection to a post whose check runs waits for a new check: the running checker never saw it, so it stays open', async (t) => {
  const lab = await fixture(t);
  await claimWithRun(lab);
  await lab.script('k-1', [{ calls: [{ name: 'WAIT' }] }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  const first = await lab.lab.post({
    kind: 'objection',
    replyTo: claim,
    text: 'First.',
  });
  await until(() => lab.lab.view()?.checks[0]?.state === 'running', 15_000);
  const second = await lab.lab.post({
    kind: 'objection',
    replyTo: claim,
    text: 'Second.',
  });
  const checks = lab.lab.view()?.checks ?? [];
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0]?.objections, [first.id]);
  assert.deepEqual(checks[1]?.objections, [second.id]);
  assert.equal(checks[1]?.state, 'queued');
  // Both objections stay open on the desk until a check answers them.
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(html, /Open disputes/);
  assert.match(html, /First\./);
  assert.match(html, /Second\./);
});

await test('in a project whose path has pattern characters, a checker is not blind: its harness gets no project denials, its mark says so, and nothing holds up', async (t) => {
  const lab = await fixture(t, { folder: 'exp [v2] (final)' });
  await claimWithRun(lab, [
    {
      name: 'verifold_direction',
      arguments: {
        action: 'update',
        verdict: 'holds-up',
        post: 'p-3',
        evidence: 'acc 0.7',
        why: 'It meets the bar.',
      },
    },
  ]);
  await lab.script('k-1', [
    {
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'rerun',
            text: 'The code is right.',
            outcome: 'holds',
            method: 'code-read',
            artifacts: [{ type: 'run', run: 'r-1' }],
          },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  await until(async () =>
    (await answers(lab, 'd-1-alpha')).some(
      (entry) => entry.call === 'verifold_direction',
    ),
  );
  const asked = (await answers(lab, 'd-1-alpha')).find(
    (entry) => entry.call === 'verifold_direction',
  );
  assert.equal(asked?.ok, false);
  assert.match(
    asked?.text ?? '',
    /could read the lab's records, and nothing holds up/,
  );
  await lab.lab.post({ kind: 'objection', replyTo: claim, text: 'Doubt.' });
  await until(() => lab.lab.view()?.checks[0]?.state === 'done', 15_000);
  assert.equal(lab.lab.view()?.checks[0]?.blind, false);
  const threads = (await lab.lines('k-1', 'threads.jsonl')) as {
    params: {
      config: {
        permissions: Record<string, { filesystem: Record<string, string> }>;
      };
    };
  }[];
  const denied = Object.keys(
    threads[0]?.params.config.permissions['verifold-strict']?.filesystem ?? {},
  );
  assert.ok(denied.includes('~/.claude'));
  assert.ok(!denied.some((path) => path.includes('exp [v2] (final)')));
  const html = renderLab(lab.lab.view()!, (value) => value);
  assert.match(html, /the checker could read project records/);
});

await test("a checker's prompt says which cited runs its folder holds, and which it must judge by their results only", async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'WRITE',
          arguments: { path: 'a.sh', text: 'echo METRIC acc=0.7\n' },
        },
        { name: 'verifold_run', arguments: { command: 'sh a.sh', why: 'A.' } },
      ],
    },
    {
      when: 'r-1 ended',
      calls: [
        {
          name: 'WRITE',
          arguments: { path: 'b.sh', text: 'echo METRIC acc=0.8\n' },
        },
        { name: 'verifold_run', arguments: { command: 'sh b.sh', why: 'B.' } },
      ],
    },
    {
      when: 'r-2 ended',
      calls: [
        {
          name: 'verifold_post',
          arguments: {
            kind: 'claim',
            text: 'Both hold.',
            artifacts: [
              { type: 'run', run: 'r-1' },
              { type: 'run', run: 'r-2' },
            ],
          },
        },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const claim = await claimPost(lab);
  await lab.lab.post({ kind: 'objection', replyTo: claim, text: 'Doubt.' });
  await until(async () => (await lab.inputs('k-1')).length >= 1, 15_000);
  const prompt = (await lab.inputs('k-1'))[0] ?? '';
  const [here, elsewhere] = prompt.split(
    'The runs that it cites at other commits.',
  );
  assert.match(here ?? '', /- r-1: "sh a\.sh"/);
  assert.doesNotMatch(here ?? '', /- r-2:/);
  assert.match(elsewhere ?? '', /judge them by their results only/);
  assert.match(elsewhere ?? '', /- r-2: "sh b\.sh"/);
  // The folder holds r-1's commit, without b.sh.
  assert.equal(
    existsSync(join(lab.root, '.verifold', 'checks', 'k-1', 'b.sh')),
    false,
  );
});

/** The texts of a Claude Code agent's tool results, in order. */
async function claudeResults(lab: Fixture, folder: string): Promise<string[]> {
  return (
    (await lab.lines(folder, 'results.jsonl')) as {
      result: { content: { text: string }[] };
    }[]
  ).map((entry) => entry.result.content[0]?.text ?? '');
}

/** Home of the desk, with the lab. */
/** Needs you in full: every call of the lab, with its options. Home's line shows the first one. */
async function labNeeds(lab: Fixture): Promise<string> {
  return renderDesk(
    await readDeskSnapshot(lab.root),
    undefined,
    null,
    {
      session: null,
      controllable: true,
      lab: lab.lab.view(),
    },
    { view: 'needs', panel: null },
  ).html;
}

await test('an agent asks the person a call: a technical question, a wrong effect, and a fourth call are refused, and the answer wakes the agent', async (t) => {
  const lab = await fixture(t);
  const ask = (args: Record<string, unknown>): Call => ({
    name: 'verifold_ask_person',
    arguments: args,
  });
  await lab.script('d-1-alpha', [
    {
      calls: [
        ask({
          kind: 'technical',
          question: 'Is the metric right?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          pick: 0,
          why: 'Unsure.',
        }),
        ask({
          kind: 'scope',
          question: 'A pod?',
          options: [
            { label: 'Yes', effect: { pod: { gpuType: 'A40', hours: 1 } } },
            { label: 'No' },
          ],
          pick: 0,
          why: 'Seeds.',
        }),
        ask({
          kind: 'go',
          question: 'More time for <b>3 seeds</b>?',
          options: [
            {
              label: 'Four more hours <b>now</b>',
              usd: 0,
              minutes: 240,
              effect: { hours: 4 },
            },
            { label: 'Stop at the deadline' },
          ],
          pick: 0,
          why: 'The bar needs 3 seeds.',
        }),
        ask({
          kind: 'access',
          question: 'Let me install packages?',
          options: [
            { label: 'Open PyPI', effect: { domains: ['PyPI.org'] } },
            { label: 'No network' },
          ],
          pick: 0,
          why: 'Needs numpy.',
        }),
        ask({
          kind: 'scope',
          question: 'Open a direction for spirals?',
          options: [
            {
              label: 'Open it',
              effect: {
                direction: { open: 'Spirals', harness: 'claude', bar: 'x' },
              },
            },
            { label: 'Not now' },
          ],
          pick: 1,
          why: 'A gap.',
          undoMinutes: 0,
        }),
        ask({
          kind: 'cost',
          question: 'One more?',
          options: [{ label: 'Yes', effect: { hours: 1 } }, { label: 'No' }],
          pick: 0,
          why: 'More.',
        }),
      ],
    },
    {
      when: 'The person chose',
      calls: [],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }], { hours: 1 });
  await until(
    async () => (await lab.lines('d-1-alpha', 'results.jsonl')).length >= 6,
  );
  const results = await claudeResults(lab, 'd-1-alpha');
  assert.equal(
    results[0],
    'Settle this on the board: post an objection, and a check breaks the tie.',
  );
  assert.equal(results[1], 'A pod goes with a cost call, not scope.');
  assert.match(results[2] ?? '', /^Asked the person in c-1\./);
  assert.match(results[3] ?? '', /^Asked the person in c-2\./);
  assert.match(results[4] ?? '', /^Asked the person in c-3\./);
  assert.equal(
    results[5],
    '3 calls wait for the person already. Wait for an answer.',
  );
  const calls = lab.lab.view()?.state.calls ?? [];
  assert.deepEqual(
    calls.map((call) => [call.id, call.kind, call.by, call.direction]),
    [
      ['c-1', 'go', 'a-1', 'd-1'],
      ['c-2', 'access', 'a-1', 'd-1'],
      ['c-3', 'scope', 'a-1', 'd-1'],
    ],
  );
  assert.deepEqual(calls[1]?.options[0]?.effect, {
    type: 'domains',
    domains: ['pypi.org'],
  });
  assert.ok(
    lab.lab
      .view()
      ?.posts.some(
        (post) =>
          post.text ===
          'claude-1 asks the person (c-1): More time for <b>3 seeds</b>?',
      ),
  );
  // Needs you shows each call escaped, with the agents' pick and what each option does.
  const html = await labNeeds(lab);
  assert.match(html, /More time for &lt;b&gt;3 seeds&lt;\/b&gt;\?/);
  assert.doesNotMatch(html, /<b>3 seeds/);
  assert.match(
    html,
    /<button type="button" class="call-option picked" data-action="lab-call-answer" data-call="c-1" data-option="0"><span class="option-label"><span class="key" aria-hidden="true">1<\/span> Four more hours &lt;b&gt;now&lt;\/b&gt;<\/span><span class="option-facts">No cost · 4 h<\/span><span class="pick">The agents' pick<\/span><\/button>/,
  );
  assert.match(html, /Why claude-1 picks it: /);
  assert.match(html, /Lets claude-1&#39;s shell reach pypi\.org\./);
  assert.match(
    html,
    /<button type="button" class="call-option picked" data-action="lab-call-answer" data-call="c-3" data-option="1"><span class="option-label"><span class="key" aria-hidden="true">2<\/span> Not now<\/span>/,
  );
  assert.match(html, /Your answer applies at once, and it has no undo\./);
  // An access call never applies by itself.
  await delay(300);
  assert.equal(lab.lab.view()?.state.calls[1]?.state, 'open');
  assert.doesNotMatch(
    await readFile(join(lab.base, 'logs', 'd-1-alpha', 'args.json'), 'utf8'),
    /allowedDomains/,
  );

  // The answer applies at once, the board says so, and the agent wakes with it.
  await lab.lab.answerCall('c-1', 0);
  assert.equal(lab.lab.view()?.state.budget?.hours, 5);
  await until(async () =>
    (await lab.inputs('d-1-alpha')).some((input) =>
      input.includes(
        '[call] The person chose "Four more hours <b>now</b>" on c-1. The lab has 4 more hours, until',
      ),
    ),
  );
  await assert.rejects(
    lab.lab.answerCall('c-1', 1),
    /c-1 waits for no answer now\./,
  );
  await assert.rejects(
    lab.lab.answerCall('c-2', 5),
    /Choose one of the options\./,
  );
  await assert.rejects(
    lab.lab.answerCall('c-9', 0),
    /Choose a call of the lab/,
  );
  // An option without an effect records the answer only. A call without an undo window has no undo.
  await lab.lab.answerCall('c-3', '1');
  assert.equal(lab.lab.view()?.state.directions.length, 1);
  await assert.rejects(lab.lab.undoCall('c-3'), /c-3 has no answer to undo\./);
  // The undo of the hours gives back the time budget before the answer.
  await lab.lab.undoCall('c-1');
  assert.equal(lab.lab.view()?.state.budget?.hours, 1);
  // The call is open again, so the person can choose another option.
  assert.equal(lab.lab.view()?.state.calls[0]?.state, 'open');
  assert.equal(lab.lab.view()?.state.calls[0]?.answer, null);
  // A checker never gets the tool.
  assert.ok(
    !checkToolSpecs.some((tool) => tool.name === 'verifold_ask_person'),
  );
});

await test("an access answer gives the agent's shell its domains while it stands: undo, a failed save, and an undo during a start", async (t) => {
  const lab = await fixture(t);
  const access = (question: string, domains: string[]): Call => ({
    name: 'verifold_ask_person',
    arguments: {
      kind: 'access',
      question,
      options: [
        { label: 'Open them', effect: { domains } },
        { label: 'No network' },
      ],
      pick: 0,
      why: 'Needs packages.',
    },
  });
  await lab.script('d-1-alpha', [
    {
      calls: [
        access('A?', ['pypi.org']),
        access('B?', ['pypi.org', 'hf.co']),
        {
          name: 'verifold_ask_person',
          arguments: {
            kind: 'go',
            question: 'More time?',
            options: [{ label: 'Yes', effect: { hours: 2 } }, { label: 'No' }],
            pick: 0,
            why: 'Seeds.',
          },
        },
      ],
    },
  ]);
  await lab.script('d-2-beta', [{ calls: [access('C?', ['pypi.org'])] }]);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'codex' },
  ]);
  await until(() => lab.lab.view()?.state.calls.length === 3);
  // A lab without a time budget refuses more hours.
  assert.equal(
    (await claudeResults(lab, 'd-1-alpha'))[2],
    'This lab has no time budget, so more hours change nothing. Give the options without hours.',
  );
  const [a, b] = (lab.lab.view()?.state.calls ?? [])
    .filter((call) => call.by === 'a-1')
    .map((call) => call.id);
  assert.match(
    await labNeeds(lab),
    /Codex: any website\. Codex cannot limit the network to pypi\.org, so codex-1&#39;s shell can reach any website\./,
  );
  const domains = async (): Promise<string[]> => {
    const args = JSON.parse(
      await readFile(join(lab.base, 'logs', 'd-1-alpha', 'args.json'), 'utf8'),
    ) as string[];
    const settings = JSON.parse(
      args[args.indexOf('--settings') + 1] ?? '{}',
    ) as { sandbox?: { network?: { allowedDomains?: string[] } } };
    return settings.sandbox?.network?.allowedDomains ?? [];
  };
  const launches = async (): Promise<number> =>
    (await lab.lines('d-1-alpha', 'launches.jsonl')).length;
  // Each answer that changes the domains restarts the process with them.
  const answered = async (
    change: () => Promise<void>,
    expected: string[],
  ): Promise<void> => {
    const before = await launches();
    await change();
    await until(async () => (await launches()) > before);
    await until(
      async () => JSON.stringify(await domains()) === JSON.stringify(expected),
    );
  };
  assert.deepEqual(await domains(), []);
  await answered(() => lab.lab.answerCall(a, 0), ['pypi.org']);
  assert.equal(
    (await lab.lines('d-1-alpha', 'launches.jsonl')).at(-1),
    'resume',
  );
  await answered(() => lab.lab.answerCall(b, 0), ['hf.co', 'pypi.org']);
  // B still gives pypi.org, so the undo of A changes nothing.
  const steady = await launches();
  await lab.lab.undoCall(a);
  await delay(300);
  assert.equal(await launches(), steady);
  assert.deepEqual(await domains(), ['hf.co', 'pypi.org']);
  // No answer that stands gives a domain any more.
  await answered(() => lab.lab.undoCall(b), []);

  // An answer that the lab cannot save gives no domain.
  const folder = join(lab.root, '.verifold');
  await chmod(folder, 0o500);
  try {
    await assert.rejects(lab.lab.answerCall(a, 0));
  } finally {
    await chmod(folder, 0o700);
  }
  assert.equal(
    lab.lab.view()?.state.calls.find((call) => call.id === a)?.state,
    'open',
  );
  await delay(300);
  assert.deepEqual(await domains(), []);

  // An undo while the process starts reaches the process that started.
  await answered(() => lab.lab.answerCall(a, 0), ['pypi.org']);
  const pool = lab.sessions as unknown as {
    resumeAgent: LabSessions['resumeAgent'];
  };
  const resume = pool.resumeAgent.bind(lab.sessions);
  let reached = (): void => {};
  const starting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const networks: unknown[] = [];
  pool.resumeAgent = async (...args) => {
    networks.push(args[2]);
    reached();
    await gate;
    return resume(...args);
  };
  const session = lab.lab.view()?.directions[0]?.agent.session ?? '';
  await lab.sessions.park(session);
  // The lab can start the agent for its earlier events before this post: the post then waits behind the held start in the lab's queue.
  const posted = lab.lab.post({ text: 'Go on.', direction: 'd-1' });
  await starting;
  // The start runs in the lab's queue, so the undo waits for it.
  const undone = lab.lab.undoCall(a);
  release();
  await posted;
  await undone;
  // The start had pypi.org, so its process ends, and the next start has no domain.
  await until(() => networks.length === 2);
  assert.deepEqual(networks, [['pypi.org'], []]);
  await until(async () => (await domains()).length === 0);
  pool.resumeAgent = resume;
});

await test("the lab's first GPU pod asks the person: the answer starts the lease, its undo ends it and asks again, and later pods follow the limits", async (t) => {
  let quote = 3.2;
  const asked: unknown[] = [];
  const started: unknown[] = [];
  const ended: unknown[] = [];
  const leases = new Map<string, Lease>();
  const compute: LabCompute = {
    describe: () => Promise.resolve('{}'),
    requestPod: (input) => {
      asked.push(input);
      return Promise.resolve('Started lease-2.');
    },
    podCost: () => Promise.resolve(quote),
    startPod: (input) => {
      started.push(input);
      const lease = {
        id: 'lease-1',
        state: 'starting',
        gpu: 'NVIDIA A40',
        tasks: [],
        directions: ['d-1'],
        history: [{ at: new Date().toISOString(), by: 'person', text: '' }],
      } as unknown as Lease;
      leases.set(lease.id, lease);
      return Promise.resolve(lease);
    },
    podsOn: () => true,
    leases: {
      list: () => [...leases.values()],
      get: (id) => {
        const found = leases.get(String(id));
        if (!found) throw new Error('No lease.');
        return found;
      },
      end: (id, by, reason) => {
        ended.push({ id, by, reason });
        return Promise.resolve(leases.get(String(id)) as Lease);
      },
    },
    podRuns: () => ({}) as PodRuns,
  };
  const lab = await fixture(t, { compute });
  const request: Call = {
    name: 'verifold_request_pod',
    arguments: { gpuType: 'NVIDIA A40', hours: 2, why: 'Train 3 seeds.' },
  };
  await lab.script('d-1-alpha', [
    { calls: [request, request] },
    { when: 'The call is open again', calls: [request] },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  await until(
    async () => (await lab.lines('d-1-alpha', 'results.jsonl')).length >= 2,
  );
  const results = await claudeResults(lab, 'd-1-alpha');
  assert.equal(
    results[0],
    "The lab's first GPU pod waits for the person: Verifold asked them in c-1, with the most that it can cost, $3.20. Nothing is billed before they answer. Verifold wakes you with the answer.",
  );
  assert.equal(
    results[1],
    'Your call c-1 waits for the person already. Verifold wakes you with the answer.',
  );
  assert.deepEqual(asked, []);
  const call = lab.lab.view()?.state.calls[0];
  assert.equal(call?.kind, 'cost');
  assert.equal(
    call?.question,
    "The lab's first GPU pod: NVIDIA A40 for 2 hours?",
  );
  assert.equal(call?.options[0]?.usd, 3.2);
  assert.match(
    await labNeeds(lab),
    /Starts a NVIDIA A40 pod for 2 hours for d-1\. Undo ends the pod\. The minutes billed so far stay billed\./,
  );
  // A paused lab starts no pod, also from a call.
  await lab.lab.pause();
  await assert.rejects(
    lab.lab.answerCall('c-1', 0),
    /The lab is paused, so no pod starts now\./,
  );
  assert.equal(lab.lab.view()?.state.calls[0]?.state, 'open');
  await lab.lab.resume();
  await lab.lab.answerCall('c-1', 0);
  assert.deepEqual(started, [
    {
      gpu: 'NVIDIA A40',
      hours: 2,
      directions: ['d-1'],
      reason: 'c-1: Train 3 seeds.',
      secrets: [],
      most: 3.2,
    },
  ]);
  assert.deepEqual(lab.lab.view()?.state.calls[0]?.applied, {
    type: 'pod',
    lease: 'lease-1',
  });
  await lab.lab.undoCall('c-1');
  assert.deepEqual(ended, [
    { id: 'lease-1', by: 'person', reason: 'you undid c-1.' },
  ]);
  // The undo takes the approval back: the call asks again, and a new request waits for it.
  assert.equal(lab.lab.view()?.state.calls[0]?.state, 'open');
  await until(
    async () => (await lab.lines('d-1-alpha', 'results.jsonl')).length >= 3,
  );
  assert.equal(
    (await claudeResults(lab, 'd-1-alpha'))[2],
    'Your call c-1 waits for the person already. Verifold wakes you with the answer.',
  );
  assert.deepEqual(asked, []);
  await lab.lab.answerCall('c-1', 0);
  assert.equal(started.length, 2);
  // After an approved pod, a request follows the Compute limits.
  assert.equal(
    (
      await agentCall(lab.lab, 'a-1', 'verifold_request_pod', {
        gpuType: 'NVIDIA A40',
        hours: 2,
        why: 'Train 3 seeds.',
      })
    ).text,
    'Started lease-2.',
  );
  // A pod that got dearer than the call showed does not start: the call is withdrawn.
  assert.match(
    (
      await agentCall(lab.lab, 'a-1', 'verifold_ask_person', {
        kind: 'cost',
        question: 'A second pod?',
        options: [
          {
            label: 'Rent it',
            effect: {
              pod: { gpuType: 'NVIDIA A40', hours: 2, secrets: ['HF_TOKEN'] },
            },
          },
          { label: 'No' },
        ],
        pick: 0,
        why: 'Seed 3.',
      })
    ).text,
    /^Asked the person in c-2\./,
  );
  // The call says which secret the pod needs before the person answers.
  const needs = (stored: string[]): string =>
    labCallNeeds(lab.lab.view()!, stored)
      .map((need) => need.body)
      .join('');
  assert.match(needs([]), /Needs HF_TOKEN in Compute first\./);
  assert.doesNotMatch(needs(['HF_TOKEN']), /Needs HF_TOKEN/);
  quote = 5.7;
  await assert.rejects(
    lab.lab.answerCall('c-2', 0),
    /Verifold withdrew c-2: The pod can now cost up to \$5\.70, more than the \$3\.20 in the call\. Ask again\./,
  );
  assert.equal(lab.lab.view()?.state.calls[1]?.state, 'withdrawn');
  assert.equal(started.length, 2);
  assert.deepEqual(asked, [
    {
      by: 'agent',
      gpu: 'NVIDIA A40',
      hours: 2,
      directions: ['d-1'],
      reason: 'Train 3 seeds.',
    },
  ]);
});

await test('an agent that started with pods off gets the pod tools once pods are on, and a Codex thread starts again only for new tools', async (t) => {
  let on = false;
  const compute: LabCompute = {
    describe: () => Promise.resolve('{}'),
    requestPod: () => Promise.reject(new Error('Not now.')),
    podCost: () => Promise.resolve(2),
    startPod: () => Promise.reject(new Error('Not now.')),
    podsOn: () => on,
    leases: {
      list: () => [],
      get: () => {
        throw new Error('No lease.');
      },
      end: () => Promise.reject(new Error('No lease.')),
    },
    podRuns: () => ({}) as PodRuns,
  };
  const lab = await fixture(t, { compute });
  // The fakes call only the tools that their launch gave them.
  await writeFile(join(lab.base, 'strict-tools'), '');
  const request: Call = {
    name: 'verifold_request_pod',
    arguments: { gpuType: 'NVIDIA A40', hours: 1, why: 'Train.' },
  };
  const ask: Call = {
    name: 'verifold_ask_person',
    arguments: {
      kind: 'access',
      question: 'Add a RunPod key?',
      options: [{ label: 'I added it' }, { label: 'No GPU' }],
      pick: 0,
      why: 'Seeds need a GPU.',
    },
  };
  for (const folder of ['d-1-alpha', 'd-2-beta'])
    await lab.script(folder, [
      { calls: [request, ask] },
      { when: 'The person chose "I added it"', calls: [request] },
    ]);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'codex' },
  ]);
  await until(() => lab.lab.view()?.state.calls.length === 2);
  // Neither agent has the pod tools yet.
  assert.equal((await claudeResults(lab, 'd-1-alpha'))[0], 'NO_SUCH_TOOL');
  const codex = async (): Promise<string[]> =>
    (
      (await lab.lines('d-2-beta', 'results.jsonl')) as {
        result: { contentItems?: { text: string }[] };
      }[]
    ).map((entry) => entry.result.contentItems?.[0]?.text ?? '');
  assert.equal((await codex())[0], 'NO_SUCH_TOOL');
  const threads = async (): Promise<string[]> =>
    (
      (await lab.lines('d-2-beta', 'threads.jsonl')) as { method: string }[]
    ).map((entry) => entry.method);
  assert.deepEqual(await threads(), ['start']);
  // The person adds a key and a spend limit in Compute, then answers.
  on = true;
  const calls = lab.lab.view()?.state.calls ?? [];
  for (const call of calls) await lab.lab.answerCall(call.id, 0);
  // Each agent's next pod request reaches Verifold: the lab's first pod is a call.
  const first = (text: string): boolean =>
    text.startsWith("The lab's first GPU pod waits for the person");
  await until(async () => (await claudeResults(lab, 'd-1-alpha')).some(first));
  await until(async () => (await codex()).some(first));
  // Claude Code resumed its conversation with the new tools; Codex started a new thread for them.
  assert.equal(
    (await lab.lines('d-1-alpha', 'launches.jsonl')).at(-1),
    'resume',
  );
  assert.deepEqual(await threads(), ['start', 'start']);
  // An answer that changes no tool keeps the Codex thread.
  const pod = lab.lab
    .view()
    ?.state.calls.find((call) => call.by === 'a-2' && call.kind === 'cost');
  await lab.lab.answerCall(pod?.id, 1);
  await delay(400);
  assert.deepEqual(await threads(), ['start', 'start']);
});

await test('a scope call opens or stops a direction, and its undo reverses it', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'verifold_ask_person',
          arguments: {
            kind: 'scope',
            question: 'Open spirals?',
            options: [
              {
                label: 'Open it',
                effect: {
                  direction: {
                    open: 'Spirals',
                    harness: 'claude',
                    bar: 'beats a circle',
                  },
                },
              },
              { label: 'Not now' },
            ],
            pick: 0,
            why: 'A gap.',
          },
        },
        {
          name: 'verifold_ask_person',
          arguments: {
            kind: 'scope',
            question: 'Stop beta?',
            options: [
              { label: 'Stop it', effect: { direction: { stop: 'd-2' } } },
              { label: 'Keep it' },
            ],
            pick: 0,
            why: 'It repeats mine.',
          },
        },
      ],
    },
  ]);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  await until(() => lab.lab.view()?.state.calls.length === 2);
  assert.match(
    await labNeeds(lab),
    /Stops d-2\. Its runs and pods end\. Undo opens it again with its agent\. Runs and pods that ended do not come back\./,
  );
  await lab.lab.answerCall('c-1', 0);
  const opened = lab.lab.view()?.state.directions[2];
  assert.equal(opened?.title, 'Spirals');
  assert.equal(opened?.openedBy, 'person');
  await lab.lab.undoCall('c-1');
  assert.equal(lab.lab.view()?.state.directions[2]?.state, 'stopped');
  await lab.lab.answerCall('c-2', 0);
  assert.equal(lab.lab.view()?.state.directions[1]?.state, 'stopped');
  await lab.lab.undoCall('c-2');
  assert.equal(lab.lab.view()?.state.directions[1]?.state, 'open');
  assert.equal(lab.lab.view()?.directions[1]?.agent.stopReason, null);
  await until(async () =>
    (await lab.inputs('d-2-beta')).some((input) =>
      input.includes('The person undid the stop of your direction (c-2).'),
    ),
  );
});

await test('calls and their undo windows survive a restart, and an undo after its window is refused', async (t) => {
  const lab = await fixture(t);
  const more = (question: string): Call => ({
    name: 'verifold_ask_person',
    arguments: {
      kind: 'go',
      question,
      options: [{ label: 'Yes', effect: { hours: 2 } }, { label: 'No' }],
      pick: 0,
      why: 'Seeds.',
    },
  });
  await lab.script('d-1-alpha', [{ calls: [more('First?'), more('Second?')] }]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }], { hours: 1 });
  await until(() => lab.lab.view()?.state.calls.length === 2);
  await lab.lab.answerCall('c-1', 0);
  await lab.lab.answerCall('c-2', 0);
  // The window of c-2 ended while no owner ran.
  await lab.restart(async () => {
    const file = join(lab.root, '.verifold', 'lab.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      calls: { id: string; undoUntil: string }[];
    };
    for (const call of saved.calls)
      if (call.id === 'c-2')
        call.undoUntil = new Date(Date.now() - 1000).toISOString();
    await writeFile(file, JSON.stringify(saved));
  });
  const calls = lab.lab.view()?.state.calls ?? [];
  assert.deepEqual(
    calls.map((call) => [call.id, call.state, call.applied?.type]),
    [
      ['c-1', 'answered', 'hours'],
      ['c-2', 'answered', 'hours'],
    ],
  );
  assert.equal(lab.lab.view()?.state.budget?.hours, 5);
  await assert.rejects(
    lab.lab.undoCall('c-2'),
    /The time to undo c-2 ended at/,
  );
  // c-2 changed the budget after c-1, so the undo takes c-1's hours off.
  await lab.lab.undoCall('c-1');
  assert.equal(lab.lab.view()?.state.budget?.hours, 3);
  // An answer that Verifold stopped while it applied it has no undo, and the board says so.
  await lab.restart(async () => {
    const file = join(lab.root, '.verifold', 'lab.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      calls: Record<string, unknown>[];
    };
    saved.calls = saved.calls.map((call) =>
      call.id === 'c-2'
        ? { ...call, applied: null, undoUntil: null, note: null }
        : call,
    );
    await writeFile(file, JSON.stringify(saved));
  });
  assert.match(
    lab.lab.view()?.state.calls[1]?.note ?? '',
    /^Verifold stopped while it applied this answer, so it has no undo\./,
  );
  assert.ok(
    lab.lab
      .view()
      ?.posts.some((post) => post.text.startsWith('c-2: Verifold stopped')),
  );
  await assert.rejects(lab.lab.undoCall('c-2'), /c-2 has no answer to undo\./);
});

await test('answers of pods survive the cut of old calls, and a Continue that Verifold did not finish applying asks again', async (t) => {
  const lab = await fixture(t, { hourMs: 300 });
  await lab.lab.start('Do LLMs store months on circles?', { hours: 1 });
  await until(() => lab.lab.view()?.state.calls[0]?.state === 'open', 10_000);
  const deadline = lab.lab.view()?.state.calls[0]?.deadline;
  await lab.restart(async () => {
    const file = join(lab.root, '.verifold', 'lab.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      calls: Record<string, unknown>[];
    };
    const asked = saved.calls[0] ?? {};
    const at = new Date().toISOString();
    const pod = {
      ...asked,
      id: 'c-1',
      kind: 'cost',
      deadline: null,
      options: [
        {
          label: 'Rent it',
          usd: 1,
          minutes: null,
          effect: {
            type: 'pod',
            gpuType: 'NVIDIA A40',
            hours: 1,
            secrets: [],
          },
        },
        { label: 'No', usd: 0, minutes: null, effect: null },
      ],
      state: 'answered',
      answer: { option: 0, at },
      applied: { type: 'pod', lease: 'lease-1' },
      note: 'Verifold started lease-1.',
    };
    const old = Array.from({ length: 500 }, (_, index) => ({
      ...asked,
      id: `c-${index + 2}`,
      state: 'withdrawn',
      note: 'Old.',
    }));
    // The answer to Continue was saved, but not what it changed.
    const continued = {
      ...asked,
      id: 'c-502',
      state: 'answered',
      answer: { option: 0, at },
      applied: null,
      note: null,
    };
    saved.calls = [pod, ...old, continued];
    await writeFile(file, JSON.stringify(saved));
  });
  const calls = lab.lab.view()?.state.calls ?? [];
  assert.equal(calls[0]?.id, 'c-1');
  assert.equal(
    calls.find((call) => call.id === 'c-2'),
    undefined,
  );
  assert.match(
    calls.find((call) => call.id === 'c-502')?.note ?? '',
    /^Verifold stopped while it applied this answer/,
  );
  // That answer does not stand, so the deadline asks again.
  await until(() =>
    Boolean(
      lab.lab
        .view()
        ?.state.calls.some(
          (call) => call.state === 'open' && call.deadline === deadline,
        ),
    ),
  );
});

await test("an agent's cost adds up what each of its sessions spent", () => {
  const record = (id: string, costUsd: number | null) =>
    ({ id, costUsd }) as Parameters<typeof addSpend>[1];
  const first = addSpend(
    undefined,
    record('20261020T100000000Z-aaaaaaaa', 0.5),
  );
  assert.deepEqual(first, {
    usd: 0.5,
    session: '20261020T100000000Z-aaaaaaaa',
    seen: 0.5,
  });
  // Claude Code's estimate covers the whole session: only its growth is new.
  const grown = addSpend(first, record('20261020T100000000Z-aaaaaaaa', 0.8));
  assert.equal(grown?.usd, 0.8);
  // A new session starts from zero.
  const fresh = addSpend(grown, record('20261020T100000000Z-bbbbbbbb', 0.3));
  assert.ok(Math.abs((fresh?.usd ?? 0) - 1.1) < 1e-9);
  // No estimate, or the same one again, changes nothing.
  assert.equal(
    addSpend(fresh, record('20261020T100000000Z-bbbbbbbb', null)),
    fresh,
  );
  assert.equal(
    addSpend(fresh, record('20261020T100000000Z-bbbbbbbb', 0.3)),
    fresh,
  );
});

await test('the lab adds up the cost estimates of its Claude Code agents for the header, across processes', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    { calls: [{ name: 'COST', arguments: { usd: 0.4 } }] },
    // A resumed Claude Code reports the estimate of the whole session.
    { when: 'once more', calls: [{ name: 'COST', arguments: { usd: 1 } }] },
  ]);
  await lab.script('d-2-beta', [
    { calls: [{ name: 'COST', arguments: { usd: 0.25 } }] },
  ]);
  await open(lab, [
    { title: 'Alpha', harness: 'claude' },
    { title: 'Beta', harness: 'claude' },
  ]);
  await until(() => Math.abs((lab.lab.view()?.claudeUsd ?? 0) - 0.65) < 1e-9);
  const view = lab.lab.view()!;
  assert.equal(
    costLine(view, { spent: 1.2, limit: 20 }),
    '≈$1.85 spent (Claude Code ≈$0.65, GPU $1.20 of $20.00) · Codex usage not counted',
  );
  assert.equal(
    costLine(view, null),
    '≈$0.65 spent (Claude Code ≈$0.65) · Codex usage not counted',
  );
  // The estimate lasts across a restart of Verifold, and a resumed process adds only its growth.
  await lab.restart();
  assert.ok(Math.abs((lab.lab.view()?.claudeUsd ?? 0) - 0.65) < 1e-9);
  await lab.lab.post({ text: '@claude-1 once more.' });
  await until(() => Math.abs((lab.lab.view()?.claudeUsd ?? 0) - 1.25) < 1e-9);
  // The agent's spend is saved with it.
  await lab.restart();
  assert.ok(Math.abs((lab.lab.view()?.claudeUsd ?? 0) - 1.25) < 1e-9);
});

await test('the main screen: one header, a Needs-you line in its order, a disputed row, and every agent text escaped', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('Do <b>months</b> lie on a circle?', { hours: 8 });
  await lab.lab.pause();
  await lab.lab.addDirection({
    title: 'Circles <img src=x onerror=alert(1)>',
    harness: 'claude',
    bar: 'it beats <i>the SAE</i>',
  });
  await lab.lab.addDirection({ title: 'Helix', harness: 'codex' });
  // The first @d-N of an open direction puts the person's post in it.
  assert.equal(
    (await lab.lab.post({ text: '@d-9 and @d-2, then @d-1' })).direction,
    'd-2',
  );
  const view = lab.lab.view();
  assert.ok(view);
  const at = new Date().toISOString();
  const commit = 'a'.repeat(40);
  const run: RunRecord = {
    schemaVersion: 1,
    id: 'r-9',
    agent: 'a-1',
    key: 'k',
    direction: 'd-1',
    harness: 'claude',
    commit,
    command: 'python <probe>.py --seed "1"',
    why: 'A seed <for> the bar.',
    status: 'done',
    exitCode: 0,
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    minutes: 10,
    want: [],
    metrics: { '<acc>': 0.7 },
    outputs: [{ path: 'out/<x>.json', bytes: 12, sha256: 'f'.repeat(64) }],
    config: 'c',
    output: null,
    log: { bytes: 0, cut: false },
    process: null,
    cancelledBy: null,
    note: null,
    told: true,
    folder: 'run-9-1a2b3c4d',
    where: 'local',
  };
  const post = (
    id: string,
    author: string,
    kind: 'claim' | 'objection',
    text: string,
    extra: Record<string, unknown> = {},
  ) => ({
    schemaVersion: 1 as const,
    id,
    at,
    author,
    kind,
    text,
    mentions: [],
    artifacts: [],
    direction: 'd-1',
    ...extra,
  });
  const claim = post(
    'p-90',
    'a-1',
    'claim',
    'The probe <script>x</script> wins.',
    {
      artifacts: [
        { type: 'run', run: 'r-9' },
        { type: 'file', path: 'out/<x>.json', commit, direction: 'd-1' },
      ],
    },
  );
  const objection = post('p-91', 'a-2', 'objection', 'One <b>seed</b>.', {
    replyTo: 'p-90',
  });
  const check: Check = {
    id: 'k-1',
    claim: 'p-90',
    objections: ['p-91'],
    holdsUp: false,
    direction: 'd-1',
    run: 'r-9',
    commit,
    harness: 'codex',
    sameHarness: false,
    agent: 'a-3',
    handle: 'codex-2',
    model: null,
    state: 'queued',
    outcome: null,
    method: null,
    result: null,
    note: null,
    queuedAt: at,
    startedAt: null,
    endedAt: null,
    restarts: 0,
    session: null,
    generation: 'g',
    start: null,
    blind: true,
  };
  const call: LabCall = {
    id: 'c-1',
    at,
    by: 'a-2',
    direction: 'd-2',
    kind: 'cost',
    question: 'Rent a <b>GPU</b>?',
    options: [
      { label: 'Rent <i>it</i>', usd: 1.4, minutes: 40, effect: null },
      { label: 'Use this Mac', usd: 0, minutes: 360, effect: null },
    ],
    pick: 0,
    why: 'Seeds <u>now</u>.',
    undoMinutes: 10,
    deadline: null,
    state: 'open',
    answer: null,
    undoUntil: null,
    applied: null,
    note: null,
  };
  const evidence = { text: 'acc <0.7>', post: 'p-90', run: 'r-9' };
  const directions = view.state.directions.map((direction) =>
    direction.id === 'd-1'
      ? { ...direction, verdict: 'leading' as const, evidence }
      : direction,
  );
  const seeded: LabView = {
    ...view,
    claudeUsd: 2.61,
    posts: [...view.posts, claim, objection],
    ledger: [run],
    checks: [check],
    handles: { ...view.handles, 'a-3': 'codex-2' },
    state: { ...view.state, directions, checks: [check], calls: [call] },
    directions: view.directions.map((entry, index) => ({
      ...entry,
      direction: directions[index] ?? entry.direction,
      status: index === 1 ? ('crashed' as const) : entry.status,
    })),
  };
  const lease = (
    id: string,
    secrets: string[],
    more: Record<string, unknown> = {},
  ): Lease =>
    ({
      schemaVersion: 1,
      id,
      state: 'requested',
      requestedBy: 'agent',
      reason: 'Train.',
      tasks: [],
      directions: ['d-1'],
      intervals: [],
      billedUsd: null,
      secrets,
      gpu: 'NVIDIA A40',
      image: 'runpod/pytorch',
      diskGb: 20,
      hours: 1,
      rate: 0.4,
      requestedAt: at,
      history: [],
      notice: null,
      ...more,
    }) as unknown as Lease;
  const compute = {
    key: null,
    keyring: null,
    secrets: [],
    settings: { limitUsd: 20, askBeforePod: true, idleMinutes: 10 },
    gpus: null,
    gpusAt: null,
    // This lab's pods count in its header. A pod of a task does not, nor one of a lab before Start over.
    leases: [
      lease('lease-0', [], {
        state: 'ended',
        billedUsd: 5,
        requestedAt: '2020-01-01T00:00:00.000Z',
      }),
      lease('lease-1', []),
      lease('lease-2', ['HF_TOKEN']),
      lease('lease-3', [], { state: 'ended', billedUsd: 0.65 }),
      lease('lease-4', [], {
        state: 'ended',
        billedUsd: 30,
        directions: undefined,
        tasks: ['task-1'],
      }),
    ],
    budget: { limit: 20, spent: 0.65, reserved: 0, left: 19.35, rate: 0 },
    problem: null,
  } as unknown as ComputeView;
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
      requests: [{ id: 'R1', native: 'n-1', tool: 'Bash', action: 'ls', at }],
    },
  };
  const live = {
    session: worker,
    workers: [worker],
    controllable: true,
    compute,
    lab: seeded,
  } as never;
  const snapshot = await readDeskSnapshot(lab.root);
  const html = renderDesk(snapshot, undefined, null, live).html;
  // One header: the question, the day, the deadline, and the money, which adds up.
  assert.match(
    html,
    /<h1 id="view-title" tabindex="-1">Do &lt;b&gt;months&lt;\/b&gt; lie on a circle\?<\/h1><p class="lab-facts">Day 1 · Due <strong>[^<]+<\/strong> · ≈\$3\.26 spent \(Claude Code ≈\$2\.61, GPU \$0\.65 of \$20\.00\) · Codex usage not counted<\/p>/,
  );
  // The Needs-you line shows the call first, and counts the rest.
  assert.match(
    html,
    /<span class="needs-label">Needs you<\/span><span class="needs-title">Rent a &lt;b&gt;GPU&lt;\/b&gt;\?<\/span>/,
  );
  assert.match(html, /4 more things need you/);
  const needs = renderDesk(snapshot, undefined, null, live, {
    view: 'needs',
    panel: null,
  }).html;
  const order = [...needs.matchAll(/<h3>([^<]*)<\/h3>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(order, [
    'Rent a &lt;b&gt;GPU&lt;/b&gt;?',
    'codex-1 stopped by itself',
    'Add a secret: HF_TOKEN',
    'The agent of d-1 asks for a NVIDIA A40 pod',
    'Claude Code session asks to use Bash',
  ]);
  // The row whose evidence is disputed says so, and the pinned dispute links to it.
  const row = html.slice(
    html.indexOf('<li class="lab-row disputed" id="row-d-1">'),
    html.indexOf('</li>', html.indexOf('id="row-d-1"')),
  );
  assert.match(
    row,
    /<span class="verdict v-disputed"><span aria-hidden="true">⚠<\/span> Disputed<\/span><span class="row-main"><strong>Circles &lt;img src=x onerror=alert\(1\)&gt;<\/strong><span class="row-line">acc &lt;0\.7&gt; · p-90 · r-9<\/span>/,
  );
  assert.match(row, /<span class="row-state">check k-1 waits<\/span>/);
  assert.match(
    html,
    /<ul class="lab-pinned" aria-label="Open disputes"><li>[\s\S]*href="#post-p-90">p-90<\/a> by claude-1, the evidence of <a href="#row-d-1">Circles &lt;img src=x onerror=alert\(1\)&gt;<\/a>: The probe &lt;script&gt;x&lt;\/script&gt; wins\./,
  );
  assert.match(html, /codex-1 objects: One &lt;b&gt;seed&lt;\/b&gt;\./);
  // Proof opens in the panel, and a file names its path.
  assert.match(
    html,
    /<button type="button" class="proof run-done" data-panel="run" data-run="r-9">r-9 · &lt;acc&gt;=0\.7<\/button>/,
  );
  assert.match(
    html,
    /<span class="proof" title="out\/&lt;x&gt;\.json at aaaaaaa in d-1">file · out\/&lt;x&gt;\.json<\/span>/,
  );
  // No agent text reaches the page as markup.
  for (const raw of ['<img', '<script', '<b>', '<i>', '<u>', '<acc>', '<x>'])
    assert.ok(!html.includes(raw), raw);
  // The run's panel escapes its command, metrics, and outputs too.
  const panel = renderDesk(snapshot, undefined, null, live, {
    view: 'home',
    panel: 'run',
    run: 'r-9',
  }).html;
  assert.match(
    panel,
    /<code>python &lt;probe&gt;\.py --seed &quot;1&quot;<\/code>/,
  );
  assert.match(panel, /<th scope="row">&lt;acc&gt;<\/th><td>0\.7<\/td>/);
  for (const raw of ['<probe>', '<acc>', '<x>', '<for>'])
    assert.ok(!panel.includes(raw), raw);
  // The lab's Home is one column: the rail opens from the menu. A project without a lab keeps its Home.
  assert.match(html, /<div class="lab-screen">/);
  const plain = renderDesk(snapshot, undefined, null, {
    session: null,
    controllable: true,
  }).html;
  assert.doesNotMatch(plain, /lab-screen/);
  assert.match(plain, /<h1 id="view-title" tabindex="-1">Home<\/h1>/);
});

await test("the desk serves a lab's depth only with its token: the run and diff panels, a file's diff, and the terminal", async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    {
      calls: [
        {
          name: 'WRITE',
          arguments: { path: 'notes.md', text: '<b>hello</b>\n' },
        },
        { name: 'WRITE', arguments: { path: 'data.md', text: 'data\n' } },
        {
          name: 'verifold_post',
          arguments: {
            kind: 'evidence',
            text: 'Notes.',
            artifacts: [
              { type: 'diff', paths: ['notes.md'] },
              { type: 'diff', paths: ['data.md'] },
            ],
          },
        },
      ],
    },
    {
      calls: [
        { name: 'WRITE', arguments: { path: 'later.md', text: 'later\n' } },
      ],
    },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  // The second turn commits a file after the post's diff.
  await until(() =>
    Boolean(
      lab.lab.view()?.state.directions[0] &&
        git(
          lab.root,
          'show',
          '--name-only',
          '--format=',
          lab.lab.view()?.state.directions[0]?.head ?? '',
        ).includes('later.md'),
    ),
  );
  const evidence =
    lab.lab.view()?.posts.find((post) => post.kind === 'evidence')?.id ?? '';
  assert.match(evidence, /^p-\d+$/);
  // The person's last look at this lab was 2 hours ago.
  const lookFile = join(lab.root, '.verifold', 'lab', 'look.json');
  const left = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await writeFile(
    lookFile,
    JSON.stringify({
      schemaVersion: 1,
      lab: lab.lab.view()?.state.startedAt,
      at: left,
      claude: 0,
      gpu: 0,
      away: null,
    }),
  );
  const stop = new AbortController();
  const desk = await startDesk(
    lab.root,
    stop.signal,
    pathToFileURL(`${await deskAssets(lab.base)}/cli/`),
    lab.sessions,
    undefined,
    undefined,
    undefined,
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
  const get = (path: string, authorized = true): Promise<Response> =>
    fetch(`${url.origin}${path}`, authorized ? { headers } : {});
  // Without the token nothing opens.
  for (const path of [
    '/api/view?panel=run&run=r-1',
    '/api/view?panel=diff&direction=d-1',
    '/api/view?panel=agent&agent=a-1',
    '/api/view?panel=search&q=notes',
    '/api/run-log?run=r-1',
    '/api/lab-diff?direction=d-1&file=notes.md',
  ])
    assert.equal((await get(path, false)).status, 401, path);
  const action = await fetch(`${url.origin}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'lab-terminal-open',
      agent: 'a-1',
      lease: 'c'.repeat(16),
    }),
  });
  assert.equal(action.status, 401);
  // With it, the diff panel lists the changed file, and the file's diff comes as text.
  const panel = (
    (await (await get('/api/view?panel=diff&direction=d-1')).json()) as {
      html: string;
    }
  ).html;
  assert.match(
    panel,
    /data-lab-diff="notes\.md" data-lab-direction="d-1" aria-pressed="false"><code>notes\.md<\/code><\/button> <span class="fine change-added">added<\/span>/,
  );
  const shown = (await (
    await get('/api/lab-diff?direction=d-1&file=notes.md')
  ).json()) as { text: string; cut: boolean };
  assert.match(shown.text, /\+<b>hello<\/b>/);
  assert.equal(shown.cut, false);
  assert.equal(
    (await get('/api/lab-diff?direction=d-1&file=README.md')).status,
    404,
  );
  // A post's proof opens the diff that it cites: its commits and its paths, not the branch's newest work.
  assert.match(panel, /data-lab-diff="later\.md"/);
  const cited = (
    (await (
      await get(`/api/view?panel=diff&direction=d-1&proof=${evidence}.0`)
    ).json()) as { html: string }
  ).html;
  assert.match(cited, new RegExp(`The diff that ${evidence} cites`));
  assert.match(cited, /data-lab-diff="notes\.md"/);
  assert.doesNotMatch(cited, /data-lab-diff="later\.md"/);
  assert.doesNotMatch(cited, /data-lab-diff="data\.md"/);
  // Each diff of a post opens its own.
  const second = (
    (await (
      await get(`/api/view?panel=diff&direction=d-1&proof=${evidence}.1`)
    ).json()) as { html: string }
  ).html;
  assert.match(second, /data-lab-diff="data\.md"/);
  assert.doesNotMatch(second, /data-lab-diff="notes\.md"/);
  assert.equal(
    (await get(`/api/lab-diff?direction=d-1&file=later.md&proof=${evidence}.0`))
      .status,
    404,
  );
  assert.match(
    (
      (await (
        await get(
          `/api/lab-diff?direction=d-1&file=notes.md&proof=${evidence}.0`,
        )
      ).json()) as { text: string }
    ).text,
    /\+<b>hello<\/b>/,
  );
  // Each proof chip names its place in the post, so the page opens that diff.
  const home = ((await (await get('/api/view')).json()) as { html: string })
    .html;
  assert.match(
    home,
    new RegExp(
      `data-panel="diff" data-lab-direction="d-1" data-proof="${evidence}\\.0">diff · notes\\.md<`,
    ),
  );
  assert.match(
    home,
    new RegExp(
      `data-panel="diff" data-lab-direction="d-1" data-proof="${evidence}\\.1">diff · data\\.md<`,
    ),
  );
  for (const path of [
    '/api/lab-diff?direction=x&file=notes.md',
    '/api/lab-diff?direction=d-1',
    '/api/lab-diff?direction=d-1&file=a&file=b',
    '/api/lab-diff?direction=d-1&file=notes.md&more=1',
    '/api/lab-diff?direction=d-1&file=notes.md&proof=x',
    '/api/lab-diff?direction=d-1&file=notes.md&proof=p-1.4',
    '/api/view?panel=diff&direction=d-1&proof=x',
    '/api/view?panel=run&run=x',
    '/api/view?panel=agent&agent=a-1&agent=a-2',
    '/api/view?panel=search&q=a&q=b',
    `/api/view?panel=search&q=${'x'.repeat(101)}`,
    '/api/view?panel=search&q=a%07b',
    '/api/view?look=2',
    '/api/view?look=1&look=1',
  ])
    assert.equal((await get(path)).status, 400, path);
  // A view that the person cannot see changes nothing. The first look after 2 hours lists what changed, until the person dismisses it.
  const viewed = async (look: boolean): Promise<string> =>
    (
      (await (await get(`/api/view${look ? '?look=1' : ''}`)).json()) as {
        html: string;
      }
    ).html;
  assert.doesNotMatch(await viewed(false), /While you were away/);
  assert.match(await viewed(true), /While you were away/);
  assert.match(await viewed(false), /While you were away/);
  await until(async () =>
    (await readFile(lookFile, 'utf8')).includes(`"since":"${left}"`),
  );
  const saved = JSON.parse(await readFile(lookFile, 'utf8')) as {
    at: string;
  };
  assert.ok(Date.now() - Date.parse(saved.at) < 60_000);
  const dismissed = await fetch(`${url.origin}/api/action`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'lab-away-dismiss', key: 'a7'.repeat(16) }),
  });
  assert.equal(dismissed.status, 200);
  assert.doesNotMatch(await viewed(true), /While you were away/);
  // With the token, the search finds the post in the panel.
  const found = (
    (await (await get('/api/view?panel=search&q=NOTES')).json()) as {
      html: string;
    }
  ).html;
  assert.match(
    found,
    new RegExp(
      `data-post-link="${evidence}">${evidence}</a>[\\s\\S]*<mark>Notes</mark>\\.`,
    ),
  );
  // An unknown run or agent opens a panel that says so.
  assert.match(
    (
      (await (await get('/api/view?panel=run&run=r-7')).json()) as {
        html: string;
      }
    ).html,
    /<h2 id="panel-title" tabindex="-1">No such run<\/h2>/,
  );
  // The plain terminal action refuses a lab agent's session: the lab owns its turns.
  const session = lab.lab.view()?.directions[0]?.agent.session ?? '';
  const plain = await fetch(`${url.origin}/api/action`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'terminal-open',
      session,
      lease: 'c'.repeat(16),
    }),
  });
  assert.equal(plain.status, 409);
  assert.match(
    ((await plain.json()) as { error: string }).error,
    /belongs to an agent of the lab/,
  );
});

await test(
  "the person takes a lab agent's terminal between its turns, and the agent's next turn follows",
  { skip: terminals },
  async (t) => {
    const lab = await fixture(t);
    const lease = 'c'.repeat(16);
    await lab.script('d-1-alpha', [
      { calls: [] },
      { when: 'worked in your harness terminal', calls: [] },
    ]);
    await lab.script('d-2-beta', [{ calls: [{ name: 'WAIT' }] }]);
    await lab.script('d-3-gamma', [
      { calls: [] },
      { when: 'worked in your harness terminal', calls: [] },
    ]);
    await open(lab, [
      { title: 'Alpha', harness: 'claude' },
      { title: 'Beta', harness: 'claude' },
      { title: 'Gamma', harness: 'codex' },
    ]);
    await until(async () => (await lab.inputs('d-2-beta')).length === 1);
    const idle = (): boolean => {
      const session = lab.lab.view()?.directions[0]?.agent.session;
      return Boolean(session && lab.sessions.idle(session));
    };
    await until(idle);
    // An agent in its turn, a checker, and an unknown agent have no terminal here.
    await assert.rejects(
      lab.lab.openTerminal('a-2', lease),
      /claude-2 is not between turns/,
    );
    await assert.rejects(
      lab.lab.openTerminal('a-9', lease),
      /Only the agent of an open direction has a terminal here/,
    );
    const session = lab.lab.view()?.directions[0]?.agent.session ?? '';
    const native = lab.sessions.view(session)?.record.nativeSessionId ?? '';
    // The lab settles the turn that ended first, such as its commit.
    await until(() =>
      lab.lab.openTerminal('a-1', lease).then(
        () => true,
        () => false,
      ),
    );
    await until(() => lab.lab.view()?.directions[0]?.status === 'terminal');
    // Needs you says that the person holds the terminal, with a way to return it.
    const needs = renderDesk(
      await readDeskSnapshot(lab.root),
      undefined,
      null,
      {
        session: null,
        controllable: true,
        lab: lab.lab.view(),
      },
    ).html;
    assert.match(needs, /You hold claude-1&#39;s terminal/);
    assert.match(
      needs,
      new RegExp(`data-action="terminal-return" data-session="${session}"`),
    );
    let text = '';
    let next = 0;
    await until(async () => {
      const output = await lab.sessions.terminal(session)?.read(next, 200);
      text += output?.data ?? '';
      next = output?.next ?? next;
      return /fake tui --resume/.test(text);
    });
    assert.match(text, new RegExp(`--resume ${native}`));
    // A post for the agent waits while the person holds its terminal.
    const inputs = (await lab.inputs('d-1-alpha')).length;
    await lab.lab.post({ text: '@claude-1 Look at this.' });
    await delay(300);
    assert.equal((await lab.inputs('d-1-alpha')).length, inputs);
    // When the terminal ends, the agent resumes its conversation and its next turn follows.
    lab.sessions.terminal(session)?.write(lease, '/exit\r');
    await until(async () =>
      (await lab.inputs('d-1-alpha')).some((input) =>
        input.includes('worked in your harness terminal'),
      ),
    );
    const turn = (await lab.inputs('d-1-alpha')).at(-1) ?? '';
    assert.match(turn, /Look at this\./);
    assert.equal(lab.lab.view()?.directions[0]?.agent.session, session);
    // A Codex terminal attaches to the agent's app-server, and the next turn follows its end too.
    const codex = lab.lab.view()?.directions[2]?.agent.session ?? '';
    await until(() =>
      lab.lab.openTerminal('a-3', lease).then(
        () => true,
        () => false,
      ),
    );
    await until(() => lab.lab.view()?.directions[2]?.status === 'terminal');
    lab.sessions.returnFromTerminal(codex);
    await until(async () =>
      (await lab.inputs('d-3-gamma')).some((input) =>
        input.includes('worked in your harness terminal'),
      ),
    );
  },
);

await test('a session that a park ends counts as busy until its record is saved, so the lab resumes its conversation', async (t) => {
  const lab = await fixture(t);
  await lab.script('d-1-alpha', [
    { calls: [] },
    { when: 'Zebrafish', calls: [] },
  ]);
  await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
  const session = (): string =>
    lab.lab.view()?.directions[0]?.agent.session ?? '';
  await until(() => Boolean(session() && lab.sessions.idle(session())));
  const first = session();
  // The park's record waits at a gate, so the saved record is still the one before the park.
  const slot = (
    lab.sessions as unknown as {
      slots: {
        view(): SessionView | null;
        writing: Promise<void> | null;
        save(): void;
      }[];
    }
  ).slots.find((entry) => entry.view()?.record.id === first);
  assert.ok(slot);
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  slot.writing = gate.then(() => {
    slot.writing = null;
    slot.save();
  });
  t.after(release);
  const parked = lab.sessions.park(first);
  await until(() => lab.sessions.view(first)?.live === false);
  assert.equal(lab.sessions.view(first)?.starting, true);
  // A post waits for the agent, so a scheduler that saw no process would start a new conversation.
  await lab.lab.post({ text: '@claude-1 Zebrafish.' });
  const lab_ = lab.lab as unknown as { kick(): void };
  for (let tries = 0; tries < 5; tries++) {
    lab_.kick();
    await delay(80);
  }
  assert.equal(session(), first);
  assert.deepEqual(await lab.lines('d-1-alpha', 'launches.jsonl'), ['start']);
  release();
  await parked;
  await until(async () =>
    (await lab.inputs('d-1-alpha')).some((input) =>
      input.includes('Zebrafish'),
    ),
  );
  assert.equal(session(), first);
  assert.deepEqual(await lab.lines('d-1-alpha', 'launches.jsonl'), [
    'start',
    'resume',
  ]);
});

await test(
  'a Claude Code agent whose process starts again after its terminal keeps one session and one process',
  { skip: terminals },
  async (t) => {
    const lab = await fixture(t);
    const lease = 'c'.repeat(16);
    await lab.script('d-1-alpha', [
      { calls: [] },
      { when: 'worked in your harness terminal', calls: [] },
    ]);
    await open(lab, [{ title: 'Alpha', harness: 'claude' }]);
    const session = (): string =>
      lab.lab.view()?.directions[0]?.agent.session ?? '';
    await until(() => Boolean(session() && lab.sessions.idle(session())));
    const first = session();
    await until(() =>
      lab.lab.openTerminal('a-1', lease).then(
        () => true,
        () => false,
      ),
    );
    await until(() => lab.lab.view()?.directions[0]?.status === 'terminal');
    // A post waits for the agent, so a scheduler that sees no process would start one.
    await lab.lab.post({ text: '@claude-1 Look.' });
    // The start after the terminal waits at its transcript, before its process.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = TranscriptWriter.open.bind(TranscriptWriter);
    TranscriptWriter.open = async (file) => {
      await gate;
      return opening(file);
    };
    t.after(() => {
      TranscriptWriter.open = opening;
      release();
    });
    lab.sessions.terminal(first)?.write(lease, '/exit\r');
    await until(() => lab.sessions.view(first)?.starting === true);
    const lab_ = lab.lab as unknown as { kick(): void };
    for (let tries = 0; tries < 5; tries++) {
      lab_.kick();
      await delay(80);
    }
    assert.equal(session(), first);
    assert.equal(
      lab.sessions.views().filter((view) => view.record.agent === 'a-1').length,
      1,
    );
    assert.deepEqual(await lab.lines('d-1-alpha', 'launches.jsonl'), ['start']);
    TranscriptWriter.open = opening;
    release();
    await until(async () =>
      (await lab.inputs('d-1-alpha')).some((input) =>
        input.includes('worked in your harness terminal'),
      ),
    );
    assert.equal(session(), first);
    assert.deepEqual(await lab.lines('d-1-alpha', 'launches.jsonl'), [
      'start',
      'resume',
    ]);
  },
);

await test(
  'a Codex terminal after a pause starts with no turn of an earlier terminal',
  { skip: terminals },
  async (t) => {
    const lab = await fixture(t);
    const lease = 'c'.repeat(16);
    await lab.script('d-1-gamma', [
      { calls: [] },
      { when: 'worked in your harness terminal', calls: [] },
    ]);
    await open(lab, [{ title: 'Gamma', harness: 'codex' }]);
    const session = (): string =>
      lab.lab.view()?.directions[0]?.agent.session ?? '';
    const take = (): Promise<void> =>
      until(() =>
        lab.lab.openTerminal('a-1', lease).then(
          () => true,
          () => false,
        ),
      );
    await until(() => Boolean(session() && lab.sessions.idle(session())));
    await take();
    // A turn that the person started in the terminal runs when the lab pauses.
    const slot = (
      lab.sessions as unknown as {
        slots: { view(): SessionView | null; nativeTurn: boolean }[];
      }
    ).slots.find((entry) => entry.view()?.record.id === session());
    assert.ok(slot);
    slot.nativeTurn = true;
    // The pause ends the process, so that turn does not carry into a later terminal.
    await lab.lab.pause();
    assert.equal(slot.nativeTurn, false);
    // Nor into a new process of the same slot.
    slot.nativeTurn = true;
    await lab.lab.resume();
    await until(() => Boolean(lab.sessions.idle(session())));
    assert.equal(slot.nativeTurn, false);
    // The next terminal ends with the session ready, and the agent's next turn follows.
    const notes = async (): Promise<number> =>
      (await lab.inputs('d-1-gamma')).filter((input) =>
        input.includes('worked in your harness terminal'),
      ).length;
    await take();
    const before = await notes();
    lab.sessions.returnFromTerminal(session());
    await until(async () => (await notes()) > before);
    await until(() => lab.lab.view()?.directions[0]?.status !== 'terminal');
  },
);

/** A run record for a screen test: done on this computer, with its command and times. */
function screenRun(id: string, more: Partial<RunRecord> = {}): RunRecord {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    agent: 'a-1',
    key: `k-${id}`,
    direction: 'd-1',
    harness: 'claude',
    commit: 'a'.repeat(40),
    command: 'python probe.py',
    why: 'A seed for the bar.',
    status: 'done',
    exitCode: 0,
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    minutes: 10,
    want: [],
    metrics: {},
    outputs: [],
    config: 'c',
    output: null,
    log: { bytes: 0, cut: false },
    process: null,
    cancelledBy: null,
    note: null,
    told: true,
    folder: `run-${id.slice(2)}-1a2b3c4d`,
    where: 'local',
    ...more,
  };
}

/** A post for a screen test, in d-1 unless `more` says otherwise. */
function screenPost(
  id: string,
  author: string,
  kind: 'claim' | 'objection' | 'question' | 'evidence' | 'status',
  text: string,
  at: string,
  more: Record<string, unknown> = {},
): LabView['posts'][number] {
  return {
    schemaVersion: 1,
    id,
    at,
    author,
    kind,
    text,
    mentions: [],
    artifacts: [],
    direction: 'd-1',
    ...more,
  };
}

/** A call for a screen test that waits for the person. */
function screenCall(at: string, more: Partial<LabCall> = {}): LabCall {
  return {
    id: 'c-1',
    at,
    by: 'a-1',
    direction: 'd-1',
    kind: 'cost',
    question: 'Rent a <b>GPU</b> for the probe?',
    options: [
      { label: 'Rent <i>it</i>', usd: 1.4, minutes: 40, effect: null },
      { label: 'Use this Mac', usd: 0, minutes: 360, effect: null },
    ],
    pick: 0,
    why: 'Seeds now.',
    undoMinutes: 10,
    deadline: null,
    state: 'open',
    answer: null,
    undoUntil: null,
    applied: null,
    note: null,
    ...more,
  };
}

await test('search finds posts, runs, and calls in any case, needs each word, marks them, escapes every hit, and shows the newest 50', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('Do months lie on a circle?', { hours: 8 });
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Circles', harness: 'claude' });
  const view = lab.lab.view();
  assert.ok(view);
  const at = (minutes: number): string =>
    new Date(Date.UTC(2026, 9, 20, 9, minutes)).toISOString();
  const clock = (value: string): string => value.slice(11, 16);
  const seeded: LabView = {
    ...view,
    posts: [
      ...view.posts,
      screenPost(
        'p-90',
        'a-1',
        'claim',
        'The PROBE <script>x</script> wins.',
        at(3),
      ),
      screenPost(
        'p-91',
        'person',
        'question',
        'Is the probe <b>fair</b>?',
        at(4),
      ),
    ],
    ledger: [
      screenRun('r-9', {
        command: 'python <probe>.py --seed "1"',
        queuedAt: at(5),
        startedAt: at(5),
      }),
    ],
    state: { ...view.state, calls: [screenCall(at(7))] },
  };
  const panel = searchPanel(seeded, 'probe', clock);
  assert.equal(panel.title, 'Search the lab');
  const hits = [...panel.body.matchAll(/<li class="hit">[\s\S]*?<\/li>/g)].map(
    (match) => match[0],
  );
  // The newest first: the call, the run, then the two posts.
  assert.equal(hits.length, 4);
  assert.match(
    hits[0] ?? '',
    /Cost call<\/span> c-1 · claude-1 · <time[^>]*>09:07<\/time> · waits for you/,
  );
  assert.match(
    hits[0] ?? '',
    /Rent a &lt;b&gt;GPU&lt;\/b&gt; for the <mark>probe<\/mark>\? \(Rent &lt;i&gt;it&lt;\/i&gt;, Use this Mac\)/,
  );
  assert.match(hits[0] ?? '', /data-view="needs">Answer it in Needs you</);
  assert.match(
    hits[1] ?? '',
    /data-panel="run" data-run="r-9">r-9<\/button>[\s\S]*<code>python &lt;<mark>probe<\/mark>&gt;\.py --seed &quot;1&quot;<\/code>/,
  );
  assert.match(
    hits[2] ?? '',
    /<a href="#post-p-91" data-post-link="p-91">p-91<\/a> · You/,
  );
  assert.match(
    hits[2] ?? '',
    /<span class="chip kind-question">Message<\/span>/,
  );
  assert.match(
    hits[3] ?? '',
    /The <mark>PROBE<\/mark> &lt;script&gt;x&lt;\/script&gt; wins\./,
  );
  assert.match(panel.body, /4 hits, the newest first\./);
  for (const raw of ['<script', '<b>', '<i>', '<probe>'])
    assert.ok(!panel.body.includes(raw), raw);
  // Each word must match. An ID finds its run, in any case.
  assert.equal(
    searchPanel(seeded, 'probe  WINS', clock).body.match(/<li class="hit">/g)
      ?.length,
    1,
  );
  assert.match(searchPanel(seeded, 'R-9', clock).body, /data-run="r-9"/);
  // A pattern character is plain text, and the words go back into the field escaped.
  const odd = searchPanel(seeded, '"><b> (.*', clock).body;
  assert.match(odd, /value="&quot;&gt;&lt;b&gt; \(\.\*"/);
  assert.match(odd, /No post, run, or call has these words\./);
  assert.match(searchPanel(seeded, undefined, clock).body, /Type a word/);
  // 130 posts: the newest 50 hits show, and an old post that the board leaves out shows its whole text.
  const long = `needle ${'word '.repeat(60)}end of the old post`;
  const many: LabView = {
    ...seeded,
    ledger: [],
    posts: Array.from({ length: 130 }, (_, index) =>
      screenPost(
        `p-${index + 1}`,
        'a-1',
        'evidence',
        index ? `Seed ${index}` : long,
        new Date(Date.UTC(2026, 9, 20, 9, 0, index)).toISOString(),
      ),
    ),
  };
  const capped = searchPanel(many, 'seed', clock).body;
  assert.equal(capped.match(/<li class="hit">/g)?.length, 50);
  assert.match(
    capped,
    /The newest 50 of 129 hits\. Add a word to find fewer\./,
  );
  const old = searchPanel(many, 'needle', clock).body;
  assert.doesNotMatch(old, /data-post-link/);
  assert.match(
    old,
    /<details id="hit-p-1"><summary>Show the whole post<\/summary><p class="pre">needle [\s\S]*end of the old post<\/p><\/details>/,
  );
  // Only the newest 50 hits render, and whole texts of old posts share a byte budget.
  const aged = (index: number): LabView['posts'][number] =>
    screenPost(
      `p-${index + 1}`,
      'a-1',
      'evidence',
      index < 200 ? `needle ${'<'.repeat(3990)}` : `Other ${index}`,
      new Date(Date.UTC(2026, 9, 20, 8, 0, 0, index)).toISOString(),
    );
  const heavy: LabView = {
    ...seeded,
    ledger: [],
    posts: Array.from({ length: 400 }, (_, index) => aged(index)),
  };
  const budgeted = searchPanel(heavy, 'needle', clock).body;
  assert.equal(budgeted.match(/<li class="hit">/g)?.length, 50);
  assert.ok(Buffer.byteLength(budgeted) < 400_000);
  const whole = budgeted.match(/<details id="hit-/g)?.length ?? 0;
  assert.ok(whole > 0 && whole < 50, String(whole));
  assert.match(
    budgeted,
    /The whole post is on the board, in \.verifold\/board\/p-\d+\.json\./,
  );
  assert.match(budgeted, /The newest 50 of 200 hits\./);
  // A question that no research step took stays in the Ask stage.
  await changeWorkspace(lab.root, (current) => ({
    ...current!,
    research: {
      topic: 'Do months lie on a circle?',
      autonomy: 'autonomous',
      phase: 'needs-plan',
    },
  }));
  assert.equal(
    renderDesk(await readDeskSnapshot(lab.root), undefined, null, {
      session: null,
      controllable: true,
    }).stage,
    'Ask: asked',
  );
  // A search has at most 100 printable characters.
  assert.equal(
    parseFrame(
      'home',
      'search',
      null,
      null,
      null,
      null,
      null,
      null,
      'x'.repeat(100),
    )?.q,
    'x'.repeat(100),
  );
  for (const q of ['x'.repeat(101), 'a\u0007b'])
    assert.equal(
      parseFrame('home', 'search', null, null, null, null, null, null, q),
      null,
    );
});

await test('while you were away: a line for each direction with news, the counts, and costs that add up to the header', async (t) => {
  const lab = await fixture(t);
  await lab.lab.start('Do months lie on a circle?', { hours: 8 });
  await lab.lab.pause();
  await lab.lab.addDirection({ title: 'Circles <i>x</i>', harness: 'claude' });
  await lab.lab.addDirection({ title: 'Helix', harness: 'codex' });
  await lab.lab.addDirection({ title: 'Frequency', harness: 'claude' });
  const view = lab.lab.view();
  assert.ok(view);
  const hours = (count: number): string =>
    new Date(Date.now() - count * 3_600_000).toISOString();
  const left = hours(3);
  const evidence = { text: 'acc 0.7.', post: 'p-90', run: 'r-9' };
  const directions = view.state.directions.map((direction) =>
    direction.id === 'd-1'
      ? {
          ...direction,
          openedAt: hours(5),
          verdict: 'leading' as const,
          evidence,
        }
      : direction.id === 'd-2'
        ? { ...direction, openedAt: hours(1), openedBy: 'person' }
        : {
            ...direction,
            openedAt: hours(5),
            state: 'stopped' as const,
            stoppedAt: hours(1),
          },
  );
  const seeded: LabView = {
    ...view,
    claudeUsd: 2.61,
    posts: [
      screenPost('p-80', 'a-1', 'claim', 'Before you left.', hours(4)),
      screenPost('p-90', 'a-1', 'claim', 'The probe wins.', hours(1)),
      screenPost('p-91', 'a-2', 'objection', 'One seed.', hours(1), {
        replyTo: 'p-90',
      }),
      screenPost('p-92', 'verifold', 'status', 'A note.', hours(1)),
    ],
    ledger: [
      screenRun('r-8', { endedAt: hours(4) }),
      screenRun('r-9', { status: 'failed', exitCode: 1, endedAt: hours(1) }),
    ],
    state: {
      ...view.state,
      startedAt: hours(6),
      directions,
      calls: [screenCall(hours(1))],
    },
    directions: view.directions.map((entry, index) => ({
      ...entry,
      direction: directions[index] ?? entry.direction,
    })),
  };
  const gpu = { spent: 1.5, limit: 20 };
  const clock = (value: string): string => value;
  const html = renderLab(seeded, clock, {
    gpu,
    away: { since: left, spent: { claude: 1.11, gpu: 0.5 } },
  });
  const digest = html.slice(
    html.indexOf('<section class="lab-away"'),
    html.indexOf('</section>', html.indexOf('<section class="lab-away"')),
  );
  assert.match(
    digest,
    /<h2 id="away-title">While you were away<\/h2><button type="button" class="link" data-action="lab-away-dismiss">Dismiss<\/button>/,
  );
  assert.ok(digest.includes(`Since ${left}.`));
  // The most settled first: a verdict, a new direction, then one that ended.
  const lines = [...digest.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(lines, [
    '<span class="away-mark" aria-hidden="true">↗</span><span><a href="#row-d-1">Circles &lt;i&gt;x&lt;/i&gt;</a>: Leading (acc 0.7). 2 new posts.</span>',
    '<span class="away-mark" aria-hidden="true">+</span><span><a href="#row-d-2">Helix</a>: New. You opened it.</span>',
    '<span class="away-mark" aria-hidden="true">○</span><span><a href="#row-d-3">Frequency</a>: Not settled yet. You stopped it.</span>',
  ]);
  assert.match(
    digest,
    /2 posts, 1 run ended \(1 failed: <button type="button" class="link" data-panel="run" data-run="r-9">r-9<\/button>\), 1 call for you\./,
  );
  // The costs since then add up to the header's growth: ≈$4.11 now, ≈$1.61 then.
  assert.match(
    html,
    /≈\$4\.11 spent \(Claude Code ≈\$2\.61, GPU \$1\.50 of \$20\.00\)/,
  );
  assert.match(
    digest,
    /Spent since then: ≈\$2\.50 \(Claude Code ≈\$1\.50, GPU \$1\.00\)\./,
  );
  assert.ok(!digest.includes('<i>'));
  // An open dispute on a row's evidence comes first, with the row's mark, also when its row is second.
  const check: Check = {
    id: 'k-1',
    claim: 'p-90',
    objections: ['p-91'],
    holdsUp: false,
    direction: 'd-2',
    run: 'r-9',
    commit: 'a'.repeat(40),
    harness: 'claude',
    sameHarness: false,
    agent: 'a-9',
    handle: 'claude-9',
    model: null,
    state: 'queued',
    outcome: null,
    method: null,
    result: null,
    note: null,
    queuedAt: hours(1),
    startedAt: null,
    endedAt: null,
    restarts: 0,
    session: null,
    generation: 'g',
    start: null,
    blind: true,
  };
  const contested = directions.map((direction) =>
    direction.id === 'd-1'
      ? {
          ...direction,
          verdict: 'holds-up' as const,
          evidence: { text: 'acc 0.8', post: 'p-80', run: null },
        }
      : direction.id === 'd-2'
        ? { ...direction, verdict: 'leading' as const, evidence }
        : direction,
  );
  const disputedHtml = renderLab(
    {
      ...seeded,
      checks: [check],
      state: { ...seeded.state, directions: contested, checks: [check] },
      directions: seeded.directions.map((entry, index) => ({
        ...entry,
        direction: contested[index] ?? entry.direction,
      })),
    },
    clock,
    { gpu, away: { since: left, spent: { claude: 1.11, gpu: 0.5 } } },
  );
  const disputedLines = [
    ...disputedHtml.matchAll(/<li><span class="away-mark"[\s\S]*?<\/li>/g),
  ].map((match) => match[0]);
  assert.equal(
    disputedLines[0],
    '<li><span class="away-mark" aria-hidden="true">⚠</span><span><a href="#row-d-2">Helix</a>: Disputed (acc 0.7).</span></li>',
  );
  assert.match(
    disputedLines[1] ?? '',
    /✓[\s\S]*Circles[\s\S]*Holds up \(acc 0\.8\)/,
  );
  // A note of Verifold alone, such as a verdict, gives its direction a line.
  const noted = directions.map((direction) =>
    direction.id === 'd-3'
      ? { ...direction, state: 'open' as const, stoppedAt: null }
      : direction,
  );
  assert.match(
    renderLab(
      {
        ...seeded,
        posts: [
          screenPost(
            'p-95',
            'verifold',
            'status',
            'A verdict note.',
            hours(1),
            {
              direction: 'd-3',
            },
          ),
        ],
        state: { ...seeded.state, directions: noted },
        directions: seeded.directions.map((entry, index) => ({
          ...entry,
          direction: noted[index] ?? entry.direction,
        })),
      },
      clock,
      { gpu, away: { since: left, spent: { claude: 1.11, gpu: 0.5 } } },
    ),
    /<a href="#row-d-3">Frequency<\/a>: Not settled yet\.<\/span>/,
  );
  // At most 5 failed runs link to their panel. The rest are counted.
  const failing = renderLab(
    {
      ...seeded,
      ledger: Array.from({ length: 7 }, (_, index) =>
        screenRun(`r-${index + 1}`, {
          status: 'failed',
          exitCode: 1,
          endedAt: hours(1),
        }),
      ),
    },
    clock,
    { gpu, away: { since: left, spent: { claude: 1.11, gpu: 0.5 } } },
  );
  assert.match(
    failing,
    /7 runs ended \(7 failed: (<button type="button" class="link" data-panel="run" data-run="r-\d">r-\d<\/button>, ){5}2 more\)/,
  );
  // Money spent always shows, also when nothing else changed.
  const now = new Date().toISOString();
  const spentOnly = renderLab(seeded, clock, {
    gpu,
    away: { since: now, spent: { claude: 2.61, gpu: 0.5 } },
  });
  assert.match(spentOnly, /<p>No post, run, or call came\.<\/p>/);
  assert.match(
    spentOnly,
    /Spent since then: ≈\$1\.00 \(Claude Code ≈\$0\.00, GPU \$1\.00\)\./,
  );
  // Nothing new and nothing spent: one quiet line.
  const quiet = renderLab(seeded, clock, {
    gpu,
    away: { since: now, spent: { claude: 2.61, gpu: 1.5 } },
  });
  assert.match(quiet, /<p>Nothing changed\.<\/p>/);
  assert.doesNotMatch(quiet, /Spent since then/);
  // Home shows the time away that the lab's owner gives it, and none without.
  const snapshot = await readDeskSnapshot(lab.root);
  const live = (away: unknown) =>
    ({
      session: null,
      controllable: true,
      lab: seeded,
      labAway: away,
    }) as never;
  assert.match(
    renderDesk(
      snapshot,
      undefined,
      null,
      live({ since: left, spent: { claude: 1.11, gpu: 0.5 } }),
    ).html,
    /While you were away/,
  );
  assert.doesNotMatch(
    renderDesk(snapshot, undefined, null, live(null), {
      view: 'home',
      panel: null,
      since: left,
    }).html,
    /While you were away/,
  );
});

/**
 * A lab with its directions open while it is paused, so no agent works. The
 * test writes in the directions' folders itself.
 */
async function bringLab(
  t: test.TestContext,
  titles: readonly string[] = ['Alpha'],
): Promise<Fixture> {
  const lab = await fixture(t);
  await lab.lab.start('Do LLMs store months on circles?');
  await lab.lab.pause();
  for (const title of titles)
    await lab.lab.addDirection({ title, harness: 'claude' });
  return lab;
}

/** The folder of a lab's direction. */
function folderOf(lab: Fixture, id: string): string {
  const direction = lab.lab
    .view()
    ?.state.directions.find((entry) => entry.id === id);
  assert.ok(direction);
  return join(lab.root, direction.workspace.path);
}

/** Take a direction's newest work to bring in, and return its commit. */
async function look(lab: Fixture, id: string): Promise<string> {
  await lab.lab.lookToBring(id);
  const commit = lab.lab.bringCommit(id);
  assert.match(commit ?? '', /^[0-9a-f]{40}$/);
  return commit ?? '';
}

await test('a bring-in copies the ticked files at the commit that the person looked at, and records it', async (t) => {
  const lab = await bringLab(t);
  const folder = folderOf(lab, 'd-1');
  await writeFile(join(folder, 'a.md'), 'a\n');
  await writeFile(join(folder, 'b.md'), 'b\n');
  await mkdir(join(folder, 'memory'));
  await writeFile(join(folder, 'memory', 'note.md'), 'm\n');
  await mkdir(join(folder, 'tmp'));
  await writeFile(join(folder, 'tmp', 'x.txt'), 'x\n');
  // Nothing shows before Verifold took the commit.
  assert.equal(await lab.lab.bringFiles('d-1'), null);
  const commit = await look(lab, 'd-1');
  assert.equal(lab.lab.view()?.state.directions[0]?.head, commit);
  // Project memory and scratch output are not ticked first.
  assert.deepEqual(
    (await lab.lab.bringFiles('d-1'))?.files.map((file) => [
      file.path,
      file.change,
      file.ticked,
      file.out,
    ]),
    [
      ['a.md', 'added', true, null],
      ['b.md', 'added', true, null],
      ['memory/note.md', 'added', false, null],
      ['tmp/x.txt', 'added', false, null],
    ],
  );
  // The agent commits newer work after the person looked: it does not come in.
  await writeFile(join(folder, 'a.md'), 'newer\n');
  await writeFile(join(folder, 'c.md'), 'c\n');
  git(folder, 'add', '--all');
  git(folder, 'commit', '--quiet', '-m', 'later');
  assert.deepEqual(await lab.lab.bring('d-1', commit, ['a.md']), ['a.md']);
  assert.equal(await readFile(join(lab.root, 'a.md'), 'utf8'), 'a\n');
  assert.equal(existsSync(join(lab.root, 'b.md')), false);
  assert.equal(existsSync(join(lab.root, 'c.md')), false);
  const state = lab.lab.view()?.state;
  assert.deepEqual(
    state?.brought.map((entry) => [entry.direction, entry.commit, entry.files]),
    [['d-1', commit, ['a.md']]],
  );
  assert.equal(state?.bringing, null);
  assert.match(
    lab.lab.view()?.posts.at(-1)?.text ?? '',
    /^The person brought 1 file of d-1 into the project folder, at [0-9a-f]{7}: a\.md\.$/,
  );
  // Only the commit that the person looked at, and only files that it changed, come in.
  await assert.rejects(
    lab.lab.bring('d-1', 'f'.repeat(40), ['b.md']),
    /changed since you looked/,
  );
  await assert.rejects(
    lab.lab.bring('d-1', commit, ['README.md']),
    /Tick files that this direction changed/,
  );
  await assert.rejects(lab.lab.bring('d-1', commit, []), /Tick the files/);
  await assert.rejects(
    lab.lab.bring('x', commit, ['b.md']),
    /Choose a direction/,
  );
  // A file ticked off first can still come in, together with others.
  assert.deepEqual(
    await lab.lab.bring('d-1', commit, ['b.md', 'memory/note.md']),
    ['b.md', 'memory/note.md'],
  );
  assert.equal(
    await readFile(join(lab.root, 'memory', 'note.md'), 'utf8'),
    'm\n',
  );
  // The record lasts across a restart.
  await lab.restart();
  assert.deepEqual(
    lab.lab.view()?.state.brought.map((entry) => entry.files),
    [['a.md'], ['b.md', 'memory/note.md']],
  );
});

await test('a bring-in copies nothing when a project file changed since the direction started, also after another direction brought it in', async (t) => {
  const lab = await bringLab(t, ['Alpha', 'Beta']);
  const alpha = folderOf(lab, 'd-1');
  const beta = folderOf(lab, 'd-2');
  await writeFile(join(alpha, 'README.md'), '# Alpha\n');
  await writeFile(join(alpha, 'new.md'), 'new\n');
  await writeFile(join(beta, 'shared.md'), 'beta\n');
  await writeFile(join(alpha, 'shared.md'), 'alpha\n');
  // The person changed the README in the project folder meanwhile.
  await writeFile(join(lab.root, 'README.md'), '# Mine\n');
  const first = await look(lab, 'd-1');
  await assert.rejects(
    lab.lab.bring('d-1', first, ['README.md', 'new.md']),
    /Nothing came in\. This file changed in the project folder since d-1 started: README\.md\. Keep your version, or copy the agent's version yourself from verifold\/d-1-alpha\./,
  );
  assert.equal(await readFile(join(lab.root, 'README.md'), 'utf8'), '# Mine\n');
  assert.equal(existsSync(join(lab.root, 'new.md')), false);
  assert.deepEqual(lab.lab.view()?.state.brought, []);
  assert.equal(lab.lab.view()?.state.bringing, null);
  assert.deepEqual(
    await readdir(lab.root).then((names) =>
      names.filter((name) => /\.[0-9a-f]{8}\.verifold$/.test(name)),
    ),
    [],
  );
  // One direction's file comes in, so the other's change of it is a conflict: directions never merge into each other.
  assert.deepEqual(await lab.lab.bring('d-1', first, ['shared.md']), [
    'shared.md',
  ]);
  const second = await look(lab, 'd-2');
  await assert.rejects(
    lab.lab.bring('d-2', second, ['shared.md']),
    /changed in the project folder since d-2 started: shared\.md/,
  );
  assert.equal(await readFile(join(lab.root, 'shared.md'), 'utf8'), 'alpha\n');
});

await test('a bring-in deletes a file that the direction deleted, and links and Verifold records stay out', async (t) => {
  const lab = await bringLab(t);
  const folder = folderOf(lab, 'd-1');
  await rm(join(folder, 'README.md'));
  await symlink('/etc/hosts', join(folder, 'hosts'));
  // A commit of the direction's branch holds a file under Verifold's own folder, by another case.
  await mkdir(join(folder, '.Verifold'));
  await writeFile(join(folder, '.Verifold', 'lab.json'), '{}\n');
  git(folder, 'add', '--all', '--force');
  git(folder, 'commit', '--quiet', '-m', 'records');
  const commit = await look(lab, 'd-1');
  const files = (await lab.lab.bringFiles('d-1'))?.files ?? [];
  const reason = (path: string): string | null | undefined =>
    files.find((file) => file.path === path)?.out;
  assert.equal(reason('README.md'), null);
  assert.equal(reason('hosts'), 'It is a link or a submodule, not a file.');
  assert.equal(
    files.find((file) => file.path === '.Verifold/lab.json')?.ticked,
    false,
  );
  assert.equal(
    reason('.Verifold/lab.json'),
    "Verifold's own records stay out.",
  );
  await assert.rejects(
    lab.lab.bring('d-1', commit, ['hosts']),
    /hosts cannot come in\. It is a link or a submodule, not a file\./,
  );
  await assert.rejects(
    lab.lab.bring('d-1', commit, ['.Verifold/lab.json']),
    /cannot come in\. Verifold's own records stay out\./,
  );
  assert.equal(existsSync(join(lab.root, 'hosts')), false);
  assert.deepEqual(await lab.lab.bring('d-1', commit, ['README.md']), [
    'README.md',
  ]);
  assert.equal(existsSync(join(lab.root, 'README.md')), false);
});

await test('a bring-in that Verifold stopped in the middle finishes at the next start, and one that it stopped while it checked leaves nothing', async (t) => {
  const lab = await bringLab(t);
  const folder = folderOf(lab, 'd-1');
  await writeFile(join(folder, 'a.md'), 'a\n');
  await writeFile(join(folder, 'b.md'), 'b\n');
  await writeFile(join(folder, 'c.md'), 'c\n');
  const commit = await look(lab, 'd-1');
  const path = join(lab.root, '.verifold', 'lab.json');
  const leave = async (bringing: unknown): Promise<void> => {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(path, JSON.stringify({ ...value, bringing }));
  };
  // Every file passed its check, and the copy stopped after a.md: b.md has only its temporary copy.
  await lab.restart(async () => {
    await leave({
      direction: 'd-1',
      commit,
      files: ['a.md', 'b.md'],
      at: new Date().toISOString(),
      phase: 'copying',
    });
    await writeFile(join(lab.root, 'a.md'), 'a\n');
    await writeFile(join(lab.root, 'b.md.0123abcd.verifold'), 'b\n');
  });
  assert.equal(await readFile(join(lab.root, 'b.md'), 'utf8'), 'b\n');
  assert.equal(existsSync(join(lab.root, 'b.md.0123abcd.verifold')), false);
  let state = lab.lab.view()?.state;
  assert.equal(state?.bringing, null);
  assert.deepEqual(
    state?.brought.map((entry) => entry.files),
    [['a.md', 'b.md']],
  );
  assert.match(
    lab.lab.view()?.posts.at(-1)?.text ?? '',
    /^Verifold stopped while it brought files of d-1 into the project folder, and finished the copy now: 2 of 2 files came in\.$/,
  );
  // A stop while Verifold checked the files: nothing came in, and its temporary copy goes.
  await lab.restart(async () => {
    await leave({
      direction: 'd-1',
      commit,
      files: ['c.md'],
      at: new Date().toISOString(),
      phase: 'checking',
    });
    await writeFile(join(lab.root, 'c.md.89abcdef.verifold'), 'c\n');
  });
  assert.equal(existsSync(join(lab.root, 'c.md')), false);
  assert.equal(existsSync(join(lab.root, 'c.md.89abcdef.verifold')), false);
  state = lab.lab.view()?.state;
  assert.equal(state?.bringing, null);
  assert.equal(state?.brought.length, 1);
  assert.match(
    lab.lab.view()?.posts.at(-1)?.text ?? '',
    /^Verifold stopped while it checked files of d-1 to bring in, so nothing came in\./,
  );
});

await test('a sign-off records each verdict, newest commit, and check, stops no agent, and replaces the last one', async (t) => {
  const lab = await bringLab(t, ['Alpha', 'Beta']);
  await lab.lab.resume();
  const held = lab.lab as unknown as { state: LabState };
  const at = new Date().toISOString();
  const [alpha, beta] = held.state.directions;
  assert.ok(alpha && beta);
  const check: Check = {
    id: 'k-1',
    claim: 'p-9',
    objections: [],
    holdsUp: true,
    direction: 'd-1',
    run: 'r-1',
    commit: alpha.head,
    harness: 'codex',
    sameHarness: false,
    agent: 'a-9',
    handle: 'codex-9',
    model: null,
    state: 'done',
    outcome: 'holds',
    method: 'rerun',
    result: 'p-10',
    note: null,
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    restarts: 0,
    session: null,
    generation: 'g',
    start: null,
    blind: true,
  };
  held.state = {
    ...held.state,
    directions: [
      {
        ...alpha,
        verdict: 'holds-up',
        evidence: { text: '78% right', post: 'p-9', run: 'r-1' },
      },
      beta,
    ],
    checks: [check],
  };
  await assert.rejects(
    lab.lab.signOff('x'.repeat(labLimits.signoff + 1)),
    /up to 280 characters/,
  );
  await lab.lab.signOff('Yes: months <b>lie</b> on circles.');
  const signoff = lab.lab.view()?.state.signoff;
  assert.equal(signoff?.note, 'Yes: months <b>lie</b> on circles.');
  assert.deepEqual(signoff?.directions, [
    { id: 'd-1', verdict: 'holds-up', commit: alpha.head, check: 'k-1' },
    { id: 'd-2', verdict: 'open', commit: beta.head, check: null },
  ]);
  // A sign-off stops no agent.
  assert.equal(lab.lab.view()?.state.pausedAt, null);
  assert.equal(
    lab.lab.view()?.state.directions.every((entry) => entry.state === 'open'),
    true,
  );
  assert.match(
    lab.lab.view()?.posts.at(-1)?.text ?? '',
    /^The person signed off the answer: Yes: months <b>lie<\/b> on circles\.$/,
  );
  // The answer escapes the note and every agent text.
  const panel = answerPanel(lab.lab.view() as LabView, (value) =>
    value.slice(11, 16),
  );
  assert.match(
    panel.body,
    /<p class="answer-line">Yes: months &lt;b&gt;lie&lt;\/b&gt; on circles\.<\/p>/,
  );
  assert.match(panel.body, /<strong>Your calls:<\/strong> none\./);
  // A new sign-off with no note replaces the last one, and it lasts across a restart.
  await lab.lab.signOff('  ');
  await lab.restart();
  assert.equal(lab.lab.view()?.state.signoff?.note, null);
});

await test('the desk brings files in and signs off only with its token, and escapes every file name', async (t) => {
  const lab = await bringLab(t);
  const folder = folderOf(lab, 'd-1');
  await writeFile(join(folder, 'a<b>.md'), '<i>a</i>\n');
  await writeFile(join(folder, 'z.md'), 'z\n');
  const stop = new AbortController();
  const desk = await startDesk(
    lab.root,
    stop.signal,
    pathToFileURL(`${await deskAssets(lab.base)}/cli/`),
    lab.sessions,
    undefined,
    undefined,
    undefined,
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
  const token = url.hash.slice(1);
  const get = (path: string, authorized = true): Promise<Response> =>
    fetch(
      `${url.origin}${path}`,
      authorized ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
  const act = (
    body: Record<string, unknown>,
    authorized = true,
  ): Promise<Response> =>
    fetch(`${url.origin}/api/action`, {
      method: 'POST',
      headers: {
        ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const html = async (path: string): Promise<string> =>
    ((await (await get(path)).json()) as { html: string }).html;
  for (const path of [
    '/api/view?panel=bring&direction=d-1',
    '/api/view?panel=answer',
    `/api/lab-diff?direction=d-1&file=z.md&bring=${'a'.repeat(40)}`,
  ])
    assert.equal((await get(path, false)).status, 401, path);
  for (const body of [
    { action: 'lab-bring-look', direction: 'd-1' },
    {
      action: 'lab-bring',
      direction: 'd-1',
      commit: 'a'.repeat(40),
      files: ['z.md'],
    },
    { action: 'lab-signoff', note: 'No.' },
  ])
    assert.equal((await act(body, false)).status, 401, body.action);
  // Before Verifold took the commit, the panel asks for it.
  assert.match(
    await html('/api/view?panel=bring&direction=d-1'),
    /data-lab-bring-look="d-1"[^]*data-action="lab-bring-look" data-lab-direction="d-1">Show its files</,
  );
  assert.equal(
    (await act({ action: 'lab-bring-look', direction: 'd-1' })).status,
    200,
  );
  const commit = lab.lab.bringCommit('d-1') ?? '';
  const panel = await html('/api/view?panel=bring&direction=d-1');
  assert.match(panel, /data-bring-file="a&lt;b&gt;\.md" checked>/);
  assert.match(panel, /<code>a&lt;b&gt;\.md<\/code>/);
  assert.doesNotMatch(panel, /<b>\.md|<i>a/);
  assert.match(
    panel,
    new RegExp(
      `data-action="lab-bring" data-lab-direction="d-1" data-commit="${commit}"`,
    ),
  );
  // A file's diff comes at that commit only.
  const shown = (await (
    await get(
      `/api/lab-diff?direction=d-1&file=${encodeURIComponent('a<b>.md')}&bring=${commit}`,
    )
  ).json()) as { text: string; to: string };
  assert.match(shown.text, /\+<i>a<\/i>/);
  assert.equal(shown.to, commit);
  assert.equal(
    (await get(`/api/lab-diff?direction=d-1&file=z.md&bring=${'f'.repeat(40)}`))
      .status,
    404,
  );
  for (const path of [
    '/api/lab-diff?direction=d-1&file=z.md&bring=x',
    `/api/lab-diff?direction=d-1&file=z.md&bring=${commit}&proof=p-1.0`,
    `/api/lab-diff?direction=d-1&file=z.md&bring=${commit}&bring=${commit}`,
  ])
    assert.equal((await get(path)).status, 400, path);
  assert.equal(
    (
      await act({
        action: 'lab-bring',
        direction: 'd-1',
        commit,
        files: ['a<b>.md'],
      })
    ).status,
    200,
  );
  assert.equal(await readFile(join(lab.root, 'a<b>.md'), 'utf8'), '<i>a</i>\n');
  // The brought file shows as in the project, and its box is off.
  assert.match(
    await html('/api/view?panel=bring&direction=d-1'),
    /data-bring-file="a&lt;b&gt;\.md" disabled>[^]*In your project folder since/,
  );
  const refused = await act({
    action: 'lab-bring',
    direction: 'd-1',
    commit,
    files: ['a<b>.md'],
  });
  assert.equal(refused.status, 409);
  assert.match(
    ((await refused.json()) as { error: string }).error,
    /Nothing came in/,
  );
  assert.equal(
    (await act({ action: 'lab-signoff', note: 'Yes <b>.' })).status,
    200,
  );
  const answer = await html('/api/view?panel=answer');
  assert.match(answer, /<p class="answer-line">Yes &lt;b&gt;\.<\/p>/);
  assert.match(
    answer,
    /data-panel="bring" data-lab-direction="d-1">Bring in files</,
  );
  assert.match(answer, /1 file brought in, last at/);
  // Home's header opens the answer.
  assert.match(await html('/api/view'), /data-panel="answer">Answer</);
});
