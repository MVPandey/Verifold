import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { maxAgents, validAgents } from '../src/core/contracts.ts';
import { maxPodsAtOnce } from '../src/core/pod-limits.ts';
import { Lab } from '../src/core/lab.ts';
import {
  askPersonToolSpec,
  callLimits,
  checksAtOnce,
  directionLimits,
  directionToolSpec,
  handlePattern,
  labToolSpecs,
  planLimits,
  planToolSpec,
} from '../src/core/lab-tools.ts';
import {
  agentLine,
  mentionPattern,
  nextHandle,
} from '../src/core/lab/names.ts';
import {
  callEffect,
  labLimits,
  parseState,
  type Call,
  type Check,
  type LabCompute,
  type LabSessions,
  type LabState,
  type LabView,
} from '../src/core/lab/schema.ts';
import { choiceLine, firstPlanMost, noSetting } from '../src/core/lab/words.ts';
import { loadPrompt } from '../src/core/prompts.ts';
import { labRunLimit } from '../src/core/runs.ts';
import type { AgentTools } from '../src/core/session-hosts.ts';
import type { Away } from '../src/core/away.ts';
import type { SessionView } from '../src/core/session.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import { gitEnvironment } from '../src/core/workspaces.ts';
import { ApiReader, apiLimits } from '../src/server/api.ts';
import { keptAgents, keptDirections } from '../src/server/lab-lists.ts';
import {
  agentsAtOnceMost,
  podsAtOnceMost,
  type Lab as Lab_,
  type Snapshot,
} from '../src/protocol/api.ts';
import {
  claudeUpdates,
  requestUpdate,
  TranscriptWriter,
} from '../src/core/transcript.ts';
import { fakePod } from './fake-pod.ts';
import { until } from './wait.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args],
    {
      cwd,
      stdio: 'ignore',
      // Inside a Git hook, GIT_* variables point at the Verifold repository. They must not reach a fixture.
      env: gitEnvironment(),
    },
  );
}

interface Started {
  readonly agent: string;
  readonly prompt: string;
  readonly tools: AgentTools;
}

/** Fake worker slots: a start records its prompt and tools, and no harness runs. */
function fakeSessions(limit: number): {
  readonly sessions: LabSessions;
  readonly started: Started[];
} {
  const started: Started[] = [];
  const live = new Set<string>();
  const sessions: LabSessions = {
    get full(): boolean {
      return live.size >= limit;
    },
    limit,
    view: (id) =>
      live.has(id)
        ? ({ live: true, record: { status: 'running' } } as SessionView)
        : null,
    idle: () => false,
    startAgent: (input) => {
      const id = `20261101T000000000Z-${String(started.length + 1).padStart(8, '0')}`;
      started.push({
        agent: input.agent,
        prompt: input.prompt,
        tools: input.tools,
      });
      live.add(id);
      return Promise.resolve(id);
    },
    resumeAgent: () => Promise.resolve(),
    takeAgentTerminal: () => Promise.resolve(),
    park: (id) => Promise.resolve(live.delete(id)),
    continueTask: () => {},
    steer: () => false,
    endTask: (id) => {
      live.delete(id);
    },
  };
  return { sessions, started };
}

/** A project folder with one commit, removed after the test. */
async function project(t: TestContext): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-names-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(base, 'project');
  await mkdir(root);
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'README.md'), '# Project\n');
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
  return root;
}

function newLab(
  t: TestContext,
  root: string,
  limit: number,
  compute?: LabCompute,
): { readonly lab: Lab; readonly started: Started[] } {
  const { sessions, started } = fakeSessions(limit);
  const lab = new Lab(root, {
    sessions,
    sandbox: null,
    harnesses: () => Promise.resolve(['claude', 'codex']),
    timing: { tickMs: 5, debounceMs: 5, continueMs: 60_000 },
    ...(compute ? { compute } : {}),
  });
  t.after(() => lab.close());
  return { lab, started };
}

const entry = (
  title: string,
  more: Record<string, unknown> = {},
): Record<string, unknown> => ({
  title,
  bar: 'It beats the control.',
  runs: 3,
  noise: '±0.02',
  buildsOn: [],
  harness: 'claude',
  ...more,
});

/** Post the first plan as the planner. Throws when Verifold refuses it. */
async function postPlan(
  planner: Started,
  directions: readonly Record<string, unknown>[],
): Promise<void> {
  const result = await planner.tools.call(
    'verifold_plan',
    { reading: 'How I read it.', cost: 'Nothing yet.', directions },
    'plan-1',
  );
  assert.equal(result.ok, true, result.text);
}

const firstStart = async (started: readonly Started[]): Promise<Started> => {
  await until(() => started.length > 0);
  const planner = started[0];
  assert.ok(planner);
  return planner;
};

const statesOf = (lab: Lab): LabView => {
  const view = lab.view();
  assert.ok(view);
  return view;
};

const agentHandles = (lab: Lab): string[] =>
  statesOf(lab).directions.map(({ agent }) => agent.handle);

await test('a handle comes from the role in a new lab, and from the harness in an old one', () => {
  const roles = {
    handles: { claude: 0, codex: 0 },
    roles: { agents: 2, checkers: 0 },
  };
  assert.deepEqual(nextHandle(roles, 'agents', 'codex'), {
    handle: 'agent-3',
    counts: { roles: { agents: 3, checkers: 0 } },
  });
  assert.deepEqual(nextHandle(roles, 'checkers', 'claude'), {
    handle: 'checker-1',
    counts: { roles: { agents: 2, checkers: 1 } },
  });
  const old = { handles: { claude: 1, codex: 4 }, roles: null };
  assert.deepEqual(nextHandle(old, 'agents', 'codex'), {
    handle: 'codex-5',
    counts: { handles: { claude: 1, codex: 5 } },
  });
  // A checker of an old lab counts with its harness, as it did.
  assert.equal(nextHandle(old, 'checkers', 'claude')?.handle, 'claude-2');
  assert.equal(
    nextHandle(
      { handles: old.handles, roles: { agents: 9999, checkers: 0 } },
      'agents',
      'claude',
    ),
    null,
  );
});

await test('the handle pattern accepts both schemes and keeps coordinator', () => {
  const whole = new RegExp(`^${handlePattern}$`);
  for (const handle of [
    'agent-3',
    'checker-1',
    'coordinator',
    'claude-2',
    'codex-14',
  ])
    assert.ok(whole.test(handle), handle);
  for (const handle of ['agent-0', 'agent', 'helper-1', 'claude', 'Agent-3'])
    assert.ok(!whole.test(handle), handle);
  const post = labToolSpecs.find((tool) => tool.name === 'verifold_post');
  const schema = post?.inputSchema as {
    properties: { mentions: { items: { pattern: string } } };
  };
  const mention = new RegExp(schema.properties.mentions.items.pattern);
  for (const handle of ['agent-3', 'claude-2', 'person'])
    assert.ok(mention.test(handle), handle);
});

await test("a person's mention follows the lab's own scheme", () => {
  const person = (state: Pick<LabState, 'roles'>): RegExp =>
    new RegExp(`^${mentionPattern(state)}$`);
  const roles = person({ roles: { agents: 1, checkers: 0 } });
  const old = person({ roles: null });
  assert.ok(roles.test('agent-3') && roles.test('checker-1'));
  assert.ok(!roles.test('claude-3') && !roles.test('coordinator'));
  assert.ok(old.test('claude-3') && old.test('codex-1'));
  assert.ok(!old.test('agent-3') && !old.test('coordinator'));
});

await test('a state from before role names has no roles and parses', () => {
  const state = {
    schemaVersion: 1,
    question: 'Q?',
    startedAt: '2026-10-01T00:00:00.000Z',
    pausedAt: null,
    handles: { claude: 2, codex: 1 },
    directions: [],
  };
  const old = parseState(state);
  assert.equal(old?.roles, null);
  assert.deepEqual(old?.handles, { claude: 2, codex: 1 });
  assert.deepEqual(
    parseState({ ...state, roles: { agents: 3, checkers: 1 } })?.roles,
    { agents: 3, checkers: 1 },
  );
});

await test('a new lab numbers its agents in the order they open, whatever the harness, and each agent sees the harness of its peers', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 4);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  assert.match(planner.prompt, /You are agent-1 \(Claude Code\)\./);
  assert.match(planner.prompt, /Your first plan can have 2 to 4 directions\./);
  await postPlan(planner, [
    entry('Circles', { job: 'Circles', team: 'Geometry' }),
    entry('Controls', { job: 'Controls', team: 'Evidence', harness: 'codex' }),
    entry('Helix', { job: 'Helix', team: 'Geometry' }),
  ]);
  assert.deepEqual(agentHandles(lab), ['agent-1', 'agent-2', 'agent-3']);
  const state = statesOf(lab).state;
  assert.deepEqual(state.roles, { agents: 3, checkers: 0 });
  assert.deepEqual(state.handles, { claude: 0, codex: 0 });
  await until(() => started.length === 3);
  const helix = started.find((start) =>
    start.prompt.includes('Your direction: d-3 "Helix"'),
  );
  assert.ok(helix);
  assert.match(
    helix.prompt,
    /- agent-2 \(Codex\), job "Controls", team "Evidence" on d-2 "Controls"/,
  );
  assert.match(
    helix.prompt,
    /You are agent-3 \(Claude Code\), job "Helix", team "Geometry"\./,
  );
  // A mention by the new handle reaches the agent.
  const post = await lab.post({ text: '@agent-2 look at this.' });
  assert.deepEqual(post.mentions, [
    statesOf(lab).directions[1]?.agent.id ?? '',
  ]);
  await assert.rejects(
    lab.post({ text: '@agent-9 look.' }),
    /No agent of the lab has the handle agent-9/,
  );
  // The other scheme, and the name that no session has yet, stay plain text.
  for (const text of ['@claude-1 look.', '@coordinator look.'])
    assert.deepEqual((await lab.post({ text })).mentions, []);
  assert.equal(lab.roleNames, true);
});

await test('an old lab keeps its handles, and its next agent and check count by harness', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 4);
  await lab.start('Do months sit on a circle?');
  await firstStart(started);
  await lab.close();
  // The same lab as an earlier build wrote it: harness handles and no roles.
  const file = join(root, '.verifold', 'lab.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<
    string,
    unknown
  >;
  delete saved.roles;
  await writeFile(
    file,
    JSON.stringify({ ...saved, handles: { claude: 1, codex: 0 } }),
  );
  const agentFile = join(root, '.verifold', 'lab', 'agents', 'a-1.json');
  const agent = JSON.parse(await readFile(agentFile, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(agentFile, JSON.stringify({ ...agent, handle: 'claude-1' }));
  const later = newLab(t, root, 4);
  await later.lab.load();
  assert.equal(statesOf(later.lab).state.roles, null);
  await later.lab.addDirection({ title: 'Second', harness: 'codex' });
  await later.lab.addDirection({ title: 'Third', harness: 'claude' });
  assert.deepEqual(agentHandles(later.lab), [
    'claude-1',
    'codex-1',
    'claude-2',
  ]);
  const post = await later.lab.post({ text: '@claude-2 hello.' });
  assert.equal(post.mentions.length, 1);
  // The new scheme stays plain text here, and a handle of the lab's scheme still needs an agent.
  const plain = await later.lab.post({ text: '@agent-1 hello.' });
  assert.deepEqual(plain.mentions, []);
  await assert.rejects(
    later.lab.post({ text: '@claude-9 hello.' }),
    /No agent of the lab has the handle claude-9/,
  );
  assert.equal(later.lab.roleNames, false);
});

await test('a plan and a new direction set a job and a team, and a later plan keeps them', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 6);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  const long = 'x'.repeat(planLimits.job + 1);
  const refused = await planner.tools.call(
    'verifold_plan',
    {
      reading: 'R',
      cost: 'None.',
      directions: [entry('A', { job: long }), entry('B')],
    },
    'long',
  );
  assert.equal(refused.ok, false);
  assert.match(refused.text, /job/);
  await postPlan(planner, [
    entry('Circles', { job: 'Circles', team: 'Geometry' }),
    entry('Controls', { job: 'Controls' }),
  ]);
  const jobs = (): (readonly [string | null, string | null])[] =>
    statesOf(lab).state.directions.map(
      (direction) => [direction.job, direction.team] as const,
    );
  assert.deepEqual(jobs(), [
    ['Circles', 'Geometry'],
    ['Controls', null],
  ]);
  const opened = await planner.tools.call(
    'verifold_direction',
    {
      action: 'open',
      title: 'Helix',
      job: 'Helix',
      team: 'Geometry',
      bar: 'It beats a circle.',
      harness: 'codex',
      why: 'A new line of attack.',
    },
    'open-1',
  );
  assert.equal(opened.ok, true, opened.text);
  assert.deepEqual(jobs()[2], ['Helix', 'Geometry']);
  // A later plan lists the open directions by ID: what it leaves out stays, and a new label replaces.
  const ids = statesOf(lab).state.directions.map(({ id }) => ({ id }));
  const changed = await planner.tools.call(
    'verifold_plan',
    {
      reading: 'R',
      cost: 'None.',
      directions: [ids[0], { ...ids[1], team: 'Evidence' }, ids[2]],
      changed: 'Controls joined a team.',
    },
    'plan-2',
  );
  assert.equal(changed.ok, true, changed.text);
  assert.deepEqual(jobs(), [
    ['Circles', 'Geometry'],
    ['Controls', 'Evidence'],
    ['Helix', 'Geometry'],
  ]);
  assert.match(
    agentLine(
      { handle: 'agent-3', host: 'codex' },
      { job: 'He said "go"', team: null },
    ),
    /^agent-3 \(Codex\), job "He said \\"go\\""$/,
  );
});

await test('a direction from before jobs has none', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 4);
  await lab.start('Do months sit on a circle?');
  await firstStart(started);
  await lab.close();
  const file = join(root, '.verifold', 'lab.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as {
    directions: Record<string, unknown>[];
  };
  for (const direction of saved.directions) {
    delete direction.job;
    delete direction.team;
  }
  await writeFile(file, JSON.stringify(saved));
  const later = newLab(t, root, 4);
  await later.lab.load();
  const direction = statesOf(later.lab).state.directions[0];
  assert.equal(direction?.job, null);
  assert.equal(direction?.team, null);
});

await test('20 is reachable: the limits agree, and "Agents at once" takes 20', () => {
  assert.equal(planLimits.directions, 20);
  assert.equal(labLimits.directions, 20);
  assert.equal(directionLimits.starts, 20);
  assert.equal(labLimits.firstPlan.max, 20);
  assert.equal(maxAgents, 20);
  assert.equal(agentsAtOnceMost, maxAgents);
  assert.ok(validAgents(20));
  assert.ok(!validAgents(21));
  const schema = planToolSpec.inputSchema as {
    properties: { directions: { maxItems: number } };
  };
  assert.equal(schema.properties.directions.maxItems, 20);
  assert.match(directionToolSpec.description, /at most 20 open directions/);
  assert.match(directionToolSpec.description, /at most 20 agents in 24 hours/);
});

await test('a first plan grows with "Agents at once", and lists at least what is open', () => {
  assert.equal(firstPlanMost(undefined, 1), 4);
  assert.equal(firstPlanMost(3, 1), 4);
  assert.equal(firstPlanMost(8, 1), 8);
  assert.equal(firstPlanMost(20, 1), 20);
  assert.equal(firstPlanMost(3, 6), 6);
});

await test('runs follow "Agents at once" with a floor, and checks run one per 5', () => {
  assert.equal(labRunLimit(undefined), 3);
  assert.equal(labRunLimit(1), 3);
  assert.equal(labRunLimit(3), 3);
  assert.equal(labRunLimit(20), 20);
  assert.deepEqual(
    [undefined, 1, 4, 5, 9, 10, 19, 20].map((slots) => checksAtOnce(slots)),
    [1, 1, 1, 2, 2, 2, 3, 4],
  );
  assert.equal(callLimits.open, 6);
  assert.match(askPersonToolSpec.description, /At most 6 calls wait/);
});

await test('a first plan of 20 opens every agent, and agents without a slot wait for one', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 20);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  assert.match(planner.prompt, /Your first plan can have 2 to 20 directions\./);
  const twenty = Array.from({ length: 20 }, (_, index) =>
    entry(`Line ${index + 1}`, { job: `Job ${index + 1}`, team: 'One' }),
  );
  await postPlan(planner, twenty);
  assert.equal(agentHandles(lab).length, 20);
  assert.equal(agentHandles(lab).at(-1), 'agent-20');
  await until(() => started.length === 20, 20_000);
});

await test('with few slots a first plan stays small, and a waiting agent shows it waits', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 2);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  const tooMany = await planner.tools.call(
    'verifold_plan',
    {
      reading: 'R',
      cost: 'None.',
      directions: Array.from({ length: 5 }, (_, index) =>
        entry(`Line ${index + 1}`),
      ),
    },
    'many',
  );
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.text, /2 to 4 directions/);
  await postPlan(planner, [
    entry('One'),
    entry('Two'),
    entry('Three'),
    entry('Four'),
  ]);
  await until(() => started.length === 2);
  await until(
    () =>
      statesOf(lab).directions.filter(({ status }) => status === 'slot')
        .length === 2,
  );
  assert.equal(started.length, 2);
});

/**
 * A lab of `count` agents on a busy day: each agent has written `turns` turns
 * of a long message to its transcript. The first `ended` directions are closed.
 */
async function busyLab(
  root: string,
  turns: number,
  count = 20,
  ended = 0,
): Promise<LabView> {
  const at = '2026-11-01T10:00:00.000Z';
  const session = (index: number): string =>
    `20261101T100000000Z-${String(index + 1).padStart(8, '0')}`;
  const directions = Array.from(
    { length: count },
    (_, index): LabState['directions'][number] => ({
      id: `d-${index + 1}`,
      title: 'x'.repeat(planLimits.title),
      job: `Job ${index + 1}`,
      team: 'One',
      longShot: false,
      bar: 'b'.repeat(planLimits.bar),
      runs: 3,
      noise: '±0.02',
      buildsOn: [],
      openedBy: 'a-1',
      openedAt: at,
      state: index < ended ? 'closed' : 'open',
      stoppedAt: null,
      verdict: 'open',
      evidence: null,
      agent: `a-${index + 1}`,
      workspace: {} as LabState['directions'][number]['workspace'],
      head: 'a'.repeat(40),
    }),
  );
  await mkdir(join(root, '.verifold', 'sessions'), { recursive: true });
  for (const index of directions.keys()) {
    const writer = await TranscriptWriter.open(
      join(root, '.verifold', 'sessions', `${session(index)}.transcript.jsonl`),
    );
    const apply = writer.run();
    for (let turn = 0; turn < turns; turn++) {
      apply(requestUpdate(`Turn ${turn}.`));
      for (const update of claudeUpdates({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'm'.repeat(2000) }] },
      }))
        apply(update);
      for (const update of claudeUpdates({
        type: 'result',
        duration_ms: 1000,
      }))
        apply(update);
    }
    await writer.flushed();
  }
  const state = parseState({
    schemaVersion: 1,
    question: 'Q?',
    startedAt: at,
    pausedAt: null,
    directions: [],
  });
  assert.ok(state);
  return {
    state: { ...state, directions, roles: { agents: count, checkers: 0 } },
    posts: [],
    handles: Object.fromEntries(
      directions.map((entry, index) => [entry.agent, `agent-${index + 1}`]),
    ),
    runs: false,
    ledger: [],
    checks: [],
    claudeUsd: 0,
    directions: directions.map((entry, index) => ({
      direction: entry,
      agent: {
        id: entry.agent,
        handle: `agent-${index + 1}`,
        host: index % 2 ? 'codex' : 'claude',
        model: null,
        session: session(index),
      } as LabView['directions'][number]['agent'],
      status: 'slot',
      until: null,
    })),
  };
}

const reader = (root: string, view: LabView, away: Away | null): ApiReader =>
  new ApiReader(() => ({
    root,
    lab: { view: () => view },
    compute: undefined,
    session: () => null,
    away: () => Promise.resolve(away),
    works: [],
  }));

/** The lab of a snapshot, as the server sends it, and the snapshot's size in bytes. */
async function wireLab(
  root: string,
  view: LabView,
  away: Away | null = null,
): Promise<{ readonly lab: Lab_; readonly bytes: number; trimmed: boolean }> {
  const { json } = await reader(root, view, away).build();
  const data = JSON.parse(json) as Pick<Snapshot, 'lab' | 'trimmed'>;
  assert.ok(data.lab);
  return {
    lab: data.lab,
    bytes: Buffer.byteLength(json),
    trimmed: data.trimmed,
  };
}

await test('a snapshot of 20 busy agents fits its bound, leaves out no direction, and carries each job', async (t) => {
  const root = await project(t);
  const { lab, bytes, trimmed } = await wireLab(root, await busyLab(root, 20));
  assert.ok(bytes <= apiLimits.snapshot, `${bytes} bytes`);
  // 20 turns of 20 agents do not fit, so the snapshot keeps fewer turns of each.
  assert.equal(trimmed, true);
  assert.ok((lab.agents[0]?.turns.turns.length ?? 0) < 20);
  assert.equal(lab.directions.length, 20);
  assert.equal(lab.agents.length, 20);
  assert.equal(lab.omitted.directions, undefined);
  assert.equal(lab.omitted.agents, undefined);
  assert.equal(lab.directions[2]?.job, 'Job 3');
  assert.equal(lab.directions[2]?.team, 'One');
  assert.equal(lab.agents[2]?.job, 'Job 3');
});

await test('a cut list keeps open directions first, then the newest, and each kept row keeps its agent', async (t) => {
  const row = (id: string, state: string): { id: string; state: string } => ({
    id,
    state,
  });
  const list = [
    row('d-1', 'open'),
    row('d-2', 'closed'),
    row('d-3', 'stopped'),
    row('d-4', 'closed'),
    row('d-5', 'open'),
  ];
  const ids = (max: number): string[] =>
    keptDirections(list, max).map((entry) => entry.id);
  assert.deepEqual(ids(5), ['d-1', 'd-2', 'd-3', 'd-4', 'd-5']);
  assert.deepEqual(ids(3), ['d-1', 'd-4', 'd-5']);
  assert.deepEqual(ids(2), ['d-1', 'd-5']);
  assert.deepEqual(ids(1), ['d-5']);
  assert.deepEqual(ids(0), []);
  const agent = (
    id: string,
    direction: string | null,
    status: string,
  ): { id: string; direction: string | null; status: string } => ({
    id,
    direction,
    status,
  });
  const agents = [
    agent('a-1', 'd-1', 'idle'),
    agent('a-2', 'd-2', 'closed'),
    agent('c-1', null, 'done'),
    agent('c-2', null, 'running'),
    agent('c-3', null, 'queued'),
  ];
  const kept = (max: number): string[] =>
    keptAgents(agents, new Set(['d-1']), max).map((entry) => entry.id);
  assert.deepEqual(kept(3), ['a-1', 'c-2', 'c-3']);
  // A kept row and a running checker stay past the limit. The smallest snapshot keeps none.
  assert.deepEqual(kept(1), ['a-1', 'c-2']);
  assert.deepEqual(kept(0), []);

  const root = await project(t);
  const busy = await busyLab(root, 0, 115, 110);
  const at = '2026-11-01T10:00:00.000Z';
  const check: Check = {
    id: 'k-1',
    claim: 'p-1',
    objections: [],
    holdsUp: false,
    direction: 'd-1',
    run: 'r-1',
    commit: 'a'.repeat(40),
    harness: 'codex',
    sameHarness: false,
    agent: 'a-900',
    handle: 'checker-1',
    model: null,
    state: 'running',
    outcome: null,
    method: null,
    result: null,
    note: null,
    queuedAt: at,
    startedAt: at,
    endedAt: null,
    restarts: 0,
    session: null,
    generation: 'g',
    start: null,
    blind: true,
  };
  const { lab } = await wireLab(root, {
    ...busy,
    checks: [check],
    handles: { ...busy.handles, 'a-900': 'checker-1' },
  });
  assert.equal(lab.directions.length, apiLimits.directions);
  assert.equal(lab.omitted.directions, 115 - apiLimits.directions);
  // The 5 open directions stay. The ended ones are the newest, so d-1 to d-15 go.
  assert.deepEqual(lab.directions[0]?.id, 'd-16');
  assert.equal(lab.directions.at(-1)?.id, 'd-115');
  assert.equal(
    lab.directions.filter((entry) => entry.state === 'open').length,
    5,
  );
  const shown = new Set(lab.agents.map((entry) => entry.id));
  for (const direction of lab.directions)
    assert.ok(shown.has(direction.agent), `${direction.id} lost its agent`);
  assert.ok(shown.has('a-900'), 'the running checker stays');
});

await test('a later plan wakes each agent whose direction changed, past the limit of mentions, and a new label wakes none', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 8);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  await postPlan(
    planner,
    Array.from({ length: 8 }, (_, index) => entry(`Line ${index + 1}`)),
  );
  await until(() => started.length === 8);
  const ids = statesOf(lab).state.directions.map(({ id }) => id);
  const plan = async (
    key: string,
    change: Record<string, unknown>,
  ): Promise<string> => {
    const result = await planner.tools.call(
      'verifold_plan',
      {
        reading: 'R',
        cost: 'None.',
        directions: ids.map((id) => ({ id, ...change })),
        changed: `Change ${key}.`,
      },
      key,
    );
    assert.equal(result.ok, true, result.text);
    return statesOf(lab).state.plan?.post ?? '';
  };
  const told = (post: string): number =>
    statesOf(lab)
      .directions.slice(1)
      .filter(({ agent }) => agent.events.some((event) => event.post === post))
      .length;
  // A new label changes the plan's card and wakes no one.
  const labels = await plan('labels', { job: 'New', team: 'Other' });
  assert.equal(
    statesOf(lab).state.directions[1]?.job,
    'New',
    'the plan keeps the label',
  );
  await delay(50);
  assert.equal(told(labels), 0);
  const bars = await plan('bars', { bar: 'A new bar.' });
  assert.equal(statesOf(lab).posts.at(-1)?.mentions.length, 5);
  await until(() => told(bars) === 7);
});

await test('a post, an away line, and a search hit name an agent with its job', async (t) => {
  const root = await project(t);
  const busy = await busyLab(root, 0);
  const view: LabView = {
    ...busy,
    runs: true,
    posts: [
      {
        schemaVersion: 1,
        id: 'p-1',
        at: '2026-11-01T10:00:00.000Z',
        author: 'a-2',
        kind: 'claim',
        text: 'needle',
        mentions: [],
        artifacts: [],
      },
    ],
  };
  const { lab } = await wireLab(root, view, {
    since: '2026-11-01T09:00:00.000Z',
    spent: { claude: 0, gpu: 0 },
  });
  assert.equal(lab.board.posts[0]?.handle, 'agent-2');
  assert.equal(lab.board.posts[0]?.job, 'Job 2');
  assert.equal(
    lab.away?.news?.lines[0]?.said,
    'New. Agent 1 · Job 1 opened it.',
  );
  const hit = reader(root, view, null).search('needle')?.hits[0];
  assert.equal(hit?.author, 'Agent 2 · Job 2');
});

await test('the prompts leave the agent free to work, and state the rules', async () => {
  const peer = await loadPrompt('lab-peer');
  assert.doesNotMatch(peer, /Stay in your direction/);
  assert.doesNotMatch(peer, /real gap/);
  assert.doesNotMatch(peer, /only a few agents a day/);
  assert.match(
    peer,
    /You can search, launch your harness's subagents, and start long runs without asking anyone\./,
  );
  assert.match(peer, /You decide how to work\./);
  assert.match(peer, /Search the literature when a new idea comes up/);
  assert.match(peer, /Post what the other agents or the person must read\./);
  assert.match(peer, /Keep proof of each result\./);
  assert.match(peer, /Stay inside the money limits\./);
  assert.match(peer, /When you find a new line of attack, you can open it\./);
  const opener = await loadPrompt('lab-opener');
  assert.match(opener, /teams of 3 to 5/);
  assert.match(opener, /a job: what its agent does/);
  assert.match(opener, /a team: /);
});

await test('pods at once is an effect of a cost call, inside the limit of Settings', () => {
  assert.equal(callLimits.podsAtOnce, maxPodsAtOnce);
  assert.equal(maxPodsAtOnce, 8);
  assert.equal(podsAtOnceMost, maxPodsAtOnce);
  assert.deepEqual(callEffect({ podsAtOnce: 2 }, 'cost'), {
    type: 'podsAtOnce',
    pods: 2,
  });
  assert.throws(
    () => callEffect({ podsAtOnce: maxPodsAtOnce + 1 }, 'cost'),
    /pods at once as a whole number from 1 to 8/,
  );
  assert.throws(
    () => callEffect({ podsAtOnce: 2 }, 'scope'),
    /Pods at once goes with a cost call/,
  );
  assert.match(askPersonToolSpec.description, /podsAtOnce with cost/);
  assert.match(
    askPersonToolSpec.description,
    /An option without an effect changes no setting/,
  );
});

const option = (
  label: string,
  effect: Call['options'][number]['effect'] = null,
): Call['options'][number] => ({ label, usd: null, minutes: null, effect });

await test("an option with no effect says so on a call that a setting serves, and never on Verifold's own", () => {
  const call = {
    id: 'c-1',
    by: 'a-1',
    kind: 'cost' as const,
    need: null,
    options: [
      option('Raise it'),
      option('More hours', { type: 'hours', hours: 2 }),
    ],
  };
  assert.equal(noSetting(call, option('Raise it')), true);
  assert.equal(
    noSetting(call, option('Hours', { type: 'hours', hours: 2 })),
    false,
  );
  assert.equal(
    choiceLine(call, 0, ''),
    'The person chose "Raise it" on c-1. This choice changes no setting by itself.',
  );
  assert.equal(
    choiceLine(call, 1, 'The lab has 2 more hours.'),
    'The person chose "More hours" on c-1. The lab has 2 more hours.',
  );
  // "Stop here" on Verifold's deadline call ends the lab, so it does not say so.
  const deadline = { ...call, by: 'verifold' };
  assert.equal(noSetting(deadline, option('Stop here')), false);
  for (const kind of ['cost', 'access', 'go'] as const)
    assert.equal(noSetting({ ...call, kind }, option('A')), true, kind);
  // A scope call shapes the plan, and a need call asks the person to act themselves.
  assert.equal(noSetting({ ...call, kind: 'scope' }, option('A')), false);
  assert.equal(
    noSetting({ ...call, kind: 'access', need: 'pods' }, option('I set it')),
    false,
  );
  assert.equal(
    choiceLine(deadline, 0, ''),
    'The person chose "Raise it" on c-1.',
  );
});

/** Fake pods: only the limit of pods at once works. */
function fakeCompute(): LabCompute & { pods: number } {
  const compute = {
    pods: 1,
    podsOn: () => true,
    keySaved: () => true,
    podsAtOnce: () => compute.pods,
    setPodsAtOnce: (pods: number, only?: number) => {
      const before = compute.pods;
      const changed = only === undefined || before === only;
      if (changed) compute.pods = pods;
      return Promise.resolve({ before, changed });
    },
    podRuns: () => ({}),
  };
  return compute as unknown as LabCompute & { pods: number };
}

const ask = (podsAtOnce: number): Record<string, unknown> => ({
  kind: 'cost',
  question: 'Raise pods at once?',
  options: [
    { label: 'Raise it', usd: 1, effect: { podsAtOnce } },
    { label: 'Leave it', usd: 0 },
  ],
  pick: 0,
  why: 'Two runs wait for one GPU.',
});

await test('a call sets pods at once, tells the agent, and undo sets it back', async (t) => {
  const root = await project(t);
  const compute = fakeCompute();
  const { lab, started } = newLab(t, root, 4, compute);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  await postPlan(planner, [entry('One'), entry('Two')]);
  const same = await planner.tools.call('verifold_ask_person', ask(1), 'same');
  assert.equal(same.ok, false);
  assert.match(same.text, /Pods at once is 1 already/);
  const asked = await planner.tools.call(
    'verifold_ask_person',
    ask(2),
    'raise',
  );
  assert.equal(asked.ok, true, asked.text);
  await lab.answerCall('c-1', 0);
  assert.equal(compute.pods, 2);
  const view = statesOf(lab);
  const line = view.posts.at(-1)?.text ?? '';
  assert.match(
    line,
    /The person chose "Raise it" on c-1\. Pods at once is 2 now\./,
  );
  assert.deepEqual(view.state.calls[0]?.applied, {
    type: 'podsAtOnce',
    pods: 2,
    before: 1,
  });
  await lab.undoCall('c-1');
  assert.equal(compute.pods, 1);
  assert.match(
    statesOf(lab).posts.at(-1)?.text ?? '',
    /Pods at once is 1 again\./,
  );
  assert.equal(statesOf(lab).state.calls[0]?.state, 'open');
  // An answer of the record survives a reload.
  await lab.answerCall('c-1', 0);
  const saved = JSON.parse(
    await readFile(join(root, '.verifold', 'lab.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(parseState(saved)?.calls[0]?.applied, {
    type: 'podsAtOnce',
    pods: 2,
    before: 1,
  });
  // A change in Settings after the answer stands.
  compute.pods = 1;
  await lab.undoCall('c-1');
  assert.equal(compute.pods, 1);
  assert.match(
    statesOf(lab).posts.at(-1)?.text ?? '',
    /Pods at once stays 1: it changed after the answer\./,
  );
});

await test('a pick that sets the limit that the project has now is withdrawn, so it says nothing changed and has no undo', async (t) => {
  const root = await project(t);
  const compute = fakeCompute();
  const { lab, started } = newLab(t, root, 4, compute);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  await postPlan(planner, [entry('One'), entry('Two')]);
  const asked = await planner.tools.call('verifold_ask_person', ask(2), 'ask');
  assert.equal(asked.ok, true, asked.text);
  // The person set it in Settings while the call waited.
  compute.pods = 2;
  await assert.rejects(
    lab.answerCall('c-1', 0),
    /Pods at once is 2 already, so nothing changed\./,
  );
  const call = statesOf(lab).state.calls[0];
  assert.equal(call?.state, 'withdrawn');
  assert.equal(call?.undoUntil, null);
  assert.equal(compute.pods, 2);
});

await test('Compute changes pods at once in its queue: an undo sets the limit only while it is the value of the answer', async (t) => {
  const { compute } = await fakePod(t);
  assert.deepEqual(await compute.setPodsAtOnce(8), {
    before: 1,
    changed: true,
  });
  assert.equal(compute.podsAtOnce(), 8);
  assert.equal(compute.view().settings.maxRunningPods, 8);
  // A compare that does not hold changes nothing.
  assert.deepEqual(await compute.setPodsAtOnce(1, 3), {
    before: 8,
    changed: false,
  });
  assert.equal(compute.podsAtOnce(), 8);
  // Two at once take turns: the second sees the value of the first.
  const both = await Promise.all([
    compute.setPodsAtOnce(2, 8),
    compute.setPodsAtOnce(3, 8),
  ]);
  assert.deepEqual(
    both.map(({ changed }) => changed),
    [true, false],
  );
  assert.equal(compute.podsAtOnce(), 2);
  await assert.rejects(
    compute.setPodsAtOnce(maxPodsAtOnce + 1),
    /number of pods as a whole number from 1 to 8/,
  );
});

await test('at 8 pods at once, each pod still holds its whole cost against the spend limit', async (t) => {
  const { compute } = await fakePod(t);
  await compute.setPodsAtOnce(8);
  const pod = {
    gpu: 'NVIDIA RTX A5000',
    hours: 4,
    directions: ['d-1'],
    reason: 'Train the small model.',
  };
  const cost = await compute.podCost(pod);
  // The limit fits two pods and most of a third. Pods at once would allow all three.
  await compute.changeSettings(
    { limitUsd: Number((cost * 2.5).toFixed(2)) },
    undefined,
  );
  const started = await Promise.allSettled([
    compute.startPod(pod),
    compute.startPod(pod),
    compute.startPod(pod),
  ]);
  assert.equal(
    started.filter((result) => result.status === 'fulfilled').length,
    2,
  );
  const refused = started.find((result) => result.status === 'rejected');
  assert.match(String(refused?.reason), /of (the|your) limit is left/);
  const { left, reserved } = compute.view().budget;
  assert.ok(left !== null && left >= 0, `left: ${left}`);
  assert.ok(reserved <= cost * 2 + 0.01);
});

await test('the lab tools load no pod code', async () => {
  const tools = await readFile(
    new URL('../src/core/lab-tools.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(tools, /from '\.\/compute\.ts'/);
  const leaf = await readFile(
    new URL('../src/core/pod-limits.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(leaf, /^import /m);
});

await test('the pick of an option with no effect reaches the post and the agent, and says it changes no setting', async (t) => {
  const root = await project(t);
  const { lab, started } = newLab(t, root, 4);
  await lab.start('Do months sit on a circle?');
  const planner = await firstStart(started);
  await postPlan(planner, [entry('One'), entry('Two')]);
  const asked = await planner.tools.call(
    'verifold_ask_person',
    {
      kind: 'cost',
      question: 'Raise to 3 pods at once?',
      options: [{ label: 'Raise to 3' }, { label: 'Leave it' }],
      pick: 0,
      why: 'Runs wait.',
    },
    'no-effect',
  );
  assert.equal(asked.ok, true, asked.text);
  await lab.answerCall('c-1', 0);
  const line = statesOf(lab).posts.at(-1)?.text ?? '';
  assert.equal(
    line,
    'The person chose "Raise to 3" on c-1. This choice changes no setting by itself.',
  );
  await until(() =>
    Boolean(
      statesOf(lab).directions[0]?.agent.events.some(
        (event) => event.text === line,
      ),
    ),
  );
  const { lab: wire } = await wireLab(root, statesOf(lab));
  const options = wire.answered[0]?.options;
  assert.equal(options?.[0]?.noSetting, true);
  assert.equal(wire.answered[0]?.askers[0]?.handle, 'agent-1');
});
