import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, type NewPost, type Post } from '../src/core/board.ts';
import { openDisputes } from '../src/core/disputes.ts';
import { Lab } from '../src/core/lab.ts';
import { labToolSpecs, threadLimits } from '../src/core/lab-tools.ts';
import {
  labLimits,
  type AgentRecord,
  type LabSessions,
  type LabView,
  type Thread,
} from '../src/core/lab/schema.ts';
import { threadDigest } from '../src/core/lab/thread-digest.ts';
import { ThreadStore } from '../src/core/lab/thread-store.ts';
import {
  afterPost,
  agreedWith,
  checkTitle,
  decided,
  dueProposals,
  followed,
  follows,
  overturned,
  parseThread,
  placed,
  planThread,
  planThreadRecord,
} from '../src/core/lab/threads.ts';
import { openWaits } from '../src/core/lab/waits.ts';
import { runActive } from '../src/core/runs.ts';
import type { AgentTools } from '../src/core/session-hosts.ts';
import type { SessionView } from '../src/core/session.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import { gitEnvironment } from '../src/core/workspaces.ts';
import { ApiReader } from '../src/server/api.ts';
import { directionLine } from '../src/ui/lab-lines.ts';
import { until } from './wait.ts';

const at = '2026-11-01T10:00:00.000Z';
const windowMs = 900_000;

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
  readonly sent: string[];
} {
  const started: Started[] = [];
  const sent: string[] = [];
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
    continueTask: (_, text) => {
      sent.push(text);
    },
    steer: () => false,
    endTask: (id) => {
      live.delete(id);
    },
  };
  return { sessions, started, sent };
}

/** A project folder with one commit, removed after the test. */
async function project(t: TestContext): Promise<string> {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-threads-')),
  );
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
  more: {
    readonly limit?: number;
    readonly objectionMs?: number;
    readonly tickMs?: number;
  } = {},
): {
  readonly lab: Lab;
  readonly started: Started[];
  readonly sent: string[];
} {
  const { sessions, started, sent } = fakeSessions(more.limit ?? 4);
  const lab = new Lab(root, {
    sessions,
    sandbox: (spec) => ({ file: '/bin/sh', args: ['-c', spec.command] }),
    harnesses: () => Promise.resolve(['claude', 'codex']),
    timing: {
      tickMs: more.tickMs ?? 5,
      debounceMs: 5,
      continueMs: 60_000,
      objectionMs: more.objectionMs ?? 3_600_000,
    },
  });
  t.after(() => lab.close());
  return { lab, started, sent };
}

const entry = (title: string): Record<string, unknown> => ({
  title,
  bar: 'It beats the control.',
  runs: 3,
  noise: '±0.02',
  buildsOn: [],
  harness: 'claude',
});

/** A lab with three agents of three directions, each started. */
async function threeAgents(
  t: TestContext,
  more: Parameters<typeof newLab>[2] = {},
): Promise<
  ReturnType<typeof newLab> & { readonly root: string; readonly by: By }
> {
  const root = await project(t);
  const built = newLab(t, root, more);
  await built.lab.start('Do months sit on a circle?');
  await until(() => built.started.length > 0);
  const planner = built.started[0];
  assert.ok(planner);
  const plan = await planner.tools.call(
    'verifold_plan',
    {
      reading: 'How I read it.',
      cost: 'Nothing yet.',
      directions: [entry('Alpha'), entry('Beta'), entry('Gamma')],
    },
    'plan-1',
  );
  assert.equal(plan.ok, true, plan.text);
  await until(() => built.started.length >= 3);
  return { ...built, root, by: toolsOf(built.started) };
}

type Call = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ readonly ok: boolean; readonly text: string }>;

type By = (index: number) => Call;

let calls = 0;

/** The tool calls of the agent that started `index`th. */
const toolsOf =
  (started: readonly Started[]): By =>
  (index) =>
  (name, input) => {
    const agent = started[index];
    assert.ok(agent);
    calls += 1;
    return agent.tools.call(name, input, `call-${calls}`);
  };

const viewOf = (lab: Lab): LabView => {
  const view = lab.view();
  assert.ok(view);
  return view;
};

const posted = (text: string): string =>
  /Posted (p-\d+)/.exec(text)?.[1] ?? assert.fail(text);

/** Write a file in the agent's folder, and post a result that cites it. */
async function result(
  lab: Lab,
  call: Call,
  agent: string,
  args: Record<string, unknown>,
): Promise<string> {
  const direction = viewOf(lab).directions.find(
    (row) => row.agent.id === agent,
  )?.direction;
  assert.ok(direction);
  const path = `result-${agent}-${calls}.txt`;
  const root = (lab as unknown as { root: string }).root;
  await writeFile(join(root, direction.workspace.path, path), '0.7\n');
  const reply = await call('verifold_post', {
    kind: 'result',
    text: 'Accuracy is 0.7.',
    artifacts: [{ type: 'file', path }],
    ...args,
  });
  assert.equal(reply.ok, true, reply.text);
  return posted(reply.text);
}

const open = {
  title: 'Does the control beat chance?',
  why: 'The bar rests on it.',
};

const agentOf = (lab: Lab, index: number): AgentRecord => {
  const agent = viewOf(lab).directions[index]?.agent;
  assert.ok(agent);
  return agent;
};

/** The posts that wake events carry for each agent, in the order of the directions. */
const wokenBy = (lab: Lab, post: string): string[] =>
  viewOf(lab)
    .directions.filter(({ agent }) =>
      agent.events.some((event) => event.post === post),
    )
    .map(({ agent }) => agent.handle);

await test('a thread from a file keeps what is valid and drops what is not', () => {
  const good = {
    id: 't-3',
    title: 'Does the control beat chance?',
    state: 'decided',
    why: 'The bar rests on it.',
    direction: 'd-2',
    openedBy: 'a-1',
    at,
    opening: 'p-1',
    outcome: { text: 'Use the old mix.', post: 'p-9', by: 'a-2', at },
    overturned: 'p-4',
    followers: ['a-1', 'a-1', 'a-2', 'nobody', 7],
    agreed: [
      { post: 'p-1', by: 'a-2', at },
      { post: 'bad', by: 'a-2', at },
    ],
  };
  const parsed = parseThread(good);
  assert.deepEqual(parsed?.followers, ['a-1', 'a-2']);
  assert.equal(parsed?.agreed.length, 1);
  assert.equal(parsed?.outcome?.post, 'p-9');
  assert.equal(parsed?.overturned, 'p-4');
  for (const bad of [
    null,
    [],
    { ...good, id: 'x-1' },
    { ...good, state: 'lost' },
    { ...good, title: '' },
    { ...good, title: 'x'.repeat(threadLimits.title + 1) },
    { ...good, why: 'x'.repeat(threadLimits.why + 1) },
    { ...good, openedBy: 'stranger' },
    { ...good, at: 'never' },
  ])
    assert.equal(parseThread(bad), null);
  const loose = parseThread({
    ...good,
    direction: '../..',
    opening: 'p-x',
    outcome: { text: 1 },
    followers: 'a-1',
    agreed: null,
  });
  assert.equal(loose?.direction, undefined);
  assert.equal(loose?.opening, undefined);
  assert.equal(loose?.outcome, undefined);
  assert.deepEqual(loose?.followers, []);
  assert.deepEqual(loose?.agreed, []);
  const crowded = parseThread({
    ...good,
    followers: Array.from(
      { length: threadLimits.followers + 5 },
      (_, index) => `a-${index + 1}`,
    ),
  });
  assert.equal(crowded?.followers.length, threadLimits.followers);
});

const post = (id: string, more: Partial<Post> = {}): Post => ({
  schemaVersion: 1,
  id,
  at,
  author: 'a-1',
  kind: 'result',
  thread: 't-2',
  text: 'Accuracy is 0.7 on seed 1.',
  mentions: [],
  artifacts: [],
  ...more,
});

const thread = (id: string, more: Partial<Thread> = {}): Thread => ({
  id,
  title: `The subject of ${id}`,
  state: 'open',
  why: 'One line.',
  openedBy: 'a-1',
  at,
  followers: [],
  agreed: [],
  ...more,
});

await test('a post finds its thread: a reply joins its target, and the plan and the person go to the plan thread', () => {
  const fields: NewPost = {
    author: 'a-1',
    kind: 'result',
    text: 'A post.',
    mentions: [],
    artifacts: [],
  };
  assert.equal(placed(fields, undefined).thread, undefined);
  assert.equal(placed({ ...fields, thread: 't-4' }, undefined).thread, 't-4');
  assert.equal(placed(fields, post('p-1', { thread: 't-3' })).thread, 't-3');
  assert.equal(
    placed({ ...fields, kind: 'plan' }, undefined).thread,
    planThread,
  );
  assert.equal(
    placed({ ...fields, author: 'person' }, undefined).thread,
    planThread,
  );
  assert.equal(
    placed({ ...fields, author: 'verifold' }, undefined).thread,
    undefined,
  );
});

await test('a thread keeps its followers, its first post, and the answer to the ask that opened it', () => {
  const ask = post('p-1', {
    kind: 'ask',
    author: 'a-1',
    mentions: ['a-2'],
  });
  const opened = afterPost(thread('t-2'), ask, undefined);
  assert.deepEqual(opened.followers, ['a-1', 'a-2']);
  assert.equal(opened.opening, 'p-1');
  const toPerson = afterPost(
    thread('t-2'),
    post('p-1', { kind: 'ask', mentions: ['person'] }),
    undefined,
  );
  assert.deepEqual(toPerson.followers, ['a-1']);
  const answer = post('p-2', { kind: 'answer', author: 'a-2', replyTo: 'p-1' });
  const answered = afterPost(opened, answer, ask);
  assert.equal(answered.state, 'answered');
  assert.deepEqual(answered.outcome, {
    text: answer.text,
    post: 'p-2',
    by: 'a-2',
    at,
  });
  // The person replies with a message, not with an answer.
  assert.equal(
    afterPost(
      opened,
      post('p-2', { kind: 'question', author: 'person', replyTo: 'p-1' }),
      ask,
    ).state,
    'answered',
  );
  // An answer to an ask later in the thread leaves the thread open.
  const later = post('p-3', { kind: 'ask', mentions: ['a-2'] });
  assert.equal(
    afterPost(opened, { ...answer, replyTo: 'p-3' }, later).state,
    'open',
  );
  assert.equal(afterPost(opened, post('p-4'), undefined).opening, 'p-1');
  const person = afterPost(
    thread('t-2'),
    post('p-1', { author: 'person', kind: 'question' }),
    undefined,
  );
  assert.deepEqual(person.followers, []);
  assert.ok(follows(planThreadRecord(at), 'a-9'));
  assert.ok(!follows(thread('t-2'), 'a-9'));
  assert.ok(follows(followed(thread('t-2'), 'a-9'), 'a-9'));
});

await test('a post that changes nothing leaves the same record, so the store writes nothing', () => {
  const opened = afterPost(thread('t-2'), post('p-1'), undefined);
  assert.equal(afterPost(opened, post('p-2'), undefined), opened);
  assert.notEqual(
    afterPost(opened, post('p-3', { author: 'a-2' }), undefined),
    opened,
  );
});

await test('an objection to a decision, and a reply in a closed thread, open the thread again', () => {
  const proposal = post('p-1', { kind: 'proposal' });
  const done = decided(thread('t-2', { opening: 'p-1' }), proposal, at);
  const doubt = post('p-2', {
    kind: 'objection',
    author: 'a-2',
    replyTo: 'p-1',
  });
  const again = afterPost(done, doubt, proposal);
  assert.equal(again.state, 'open');
  assert.equal(again.outcome, undefined);
  // The proposal does not decide again, and an objection to another post changes nothing.
  assert.deepEqual(
    dueProposals(
      [proposal, doubt],
      [again],
      Date.parse(at) + windowMs,
      windowMs,
    ),
    [],
  );
  assert.equal(
    afterPost(done, { ...doubt, replyTo: 'p-9' }, undefined).state,
    'decided',
  );
  const closed = thread('t-2', {
    state: 'closed',
    outcome: { text: 'Done.', post: 'p-1', by: 'a-1', at },
  });
  for (const kind of ['objection', 'answer', 'check'] as const)
    assert.equal(
      afterPost(closed, post('p-3', { kind, replyTo: 'p-1' }), undefined).state,
      'open',
      kind,
    );
  assert.equal(
    afterPost(closed, post('p-3', { kind: 'result' }), undefined).state,
    'closed',
  );
});

await test('an outcome keeps a post-sized text, also from the person’s long reply', () => {
  const ask = post('p-1', { kind: 'ask', mentions: ['person'] });
  const reply = post('p-2', {
    author: 'person',
    kind: 'question',
    replyTo: 'p-1',
    text: 'x'.repeat(4000),
  });
  const answered = afterPost(
    afterPost(thread('t-2'), ask, undefined),
    reply,
    ask,
  );
  assert.equal(answered.outcome?.text.length, 280);
  assert.ok(parseThread(answered)?.outcome);
  assert.equal(
    parseThread(decided(thread('t-2'), reply, at))?.outcome?.post,
    'p-2',
  );
});

await test('a reaction counts once, and its list stays bounded', () => {
  const once = agreedWith(thread('t-2'), 'p-1', 'a-1', at);
  assert.equal(agreedWith(once, 'p-1', 'a-1', at), once);
  assert.equal(agreedWith(once, 'p-1', 'a-2', at).agreed.length, 2);
  let many = once;
  for (let index = 2; index < threadLimits.agreed + 9; index += 1)
    many = agreedWith(many, `p-${index}`, 'a-1', at);
  assert.equal(many.agreed.length, threadLimits.agreed);
});

await test('a proposal becomes a decision when its window ends with no objection, by the clock', () => {
  const start = Date.parse(at);
  const window = windowMs;
  const threads = [thread('t-2'), thread('t-3')];
  const proposal = post('p-1', { kind: 'proposal' });
  const posts = [proposal];
  const due = (
    now: number,
    list: readonly Post[] = posts,
    records: readonly Thread[] = threads,
  ): readonly string[] =>
    dueProposals(list, records, now, window).map((item) => item.proposal.id);
  assert.deepEqual(due(start + window - 1), []);
  assert.deepEqual(due(start + window), ['p-1']);
  assert.deepEqual(due(start + window * 9), ['p-1']);
  const objected = post('p-2', { kind: 'objection', replyTo: 'p-1' });
  assert.deepEqual(due(start + window * 9, [proposal, objected]), []);
  assert.deepEqual(
    due(start + window, posts, [thread('t-2', { state: 'closed' })]),
    [],
  );
  // A decision does not repeat, and a newer proposal replaces it.
  const done = decided(thread('t-2'), proposal, at);
  assert.equal(done.state, 'decided');
  assert.equal(done.outcome?.post, 'p-1');
  assert.deepEqual(due(start + window, posts, [done]), []);
  const newer = post('p-2', { kind: 'proposal' });
  assert.deepEqual(due(start + window, [proposal, newer], [done]), ['p-2']);
  // The person overturned it: it and older proposals stay out, and a newer one counts.
  const undone = overturned(done);
  assert.equal(undone.state, 'open');
  assert.equal(undone.outcome, undefined);
  assert.deepEqual(due(start + window, posts, [undone]), []);
  assert.deepEqual(due(start + window, [proposal, newer], [undone]), ['p-2']);
  assert.throws(() => overturned(thread('t-2')), /t-2 has no decision/);
  // An answered thread can still get a decision, also from a proposal before the answer.
  const answered = thread('t-2', {
    state: 'answered',
    outcome: { text: 'Seed 2.', post: 'p-9', by: 'a-2', at },
  });
  assert.deepEqual(due(start + window, posts, [answered]), ['p-1']);
});

await test('a title needs a subject, and a closed thread frees its title', () => {
  assert.throws(() => checkTitle('Update', []), /a specific plain question/);
  checkTitle('Is seed 2 an outlier?', []);
  checkTitle('Is seed 2 an outlier?', [
    thread('t-2', { title: 'Is seed 2 an outlier?', state: 'closed' }),
  ]);
});

const store = (
  root: string,
  board: Board = new Board(root),
  paused: () => boolean = () => false,
): ThreadStore =>
  new ThreadStore(join(root, 'threads.json'), paused, board, windowMs);

await test('the store seeds the plan thread of a new lab, holds none for an older lab, and survives a bad file', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-thread-store-')),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(root, 'threads.json');
  const fresh = store(root);
  await fresh.load(at);
  assert.deepEqual(
    fresh.list().map((entry) => entry.id),
    [planThread],
  );
  await fresh.load(null);
  assert.deepEqual(fresh.list(), []);

  await writeFile(path, 'not json');
  await fresh.load(at);
  assert.deepEqual(
    fresh.list().map((entry) => entry.id),
    [planThread],
  );

  // A bad record is skipped.
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      threads: [
        thread('t-1'),
        { id: 't-5', title: 3 },
        thread('t-6'),
        thread('t-1000000'),
      ],
    }),
  );
  await fresh.load(at);
  assert.deepEqual(
    fresh.list().map((entry) => entry.id),
    ['t-1', 't-6'],
  );
  const shape = {
    thread: { title: 'Does seed 2 agree?', why: 'One line.' },
    accepts: true,
  } as const;
  assert.deepEqual(await fresh.fields(shape, 'a-1', 'd-1'), {
    accepts: true,
    thread: 't-7',
  });
  assert.equal(fresh.get('t-7')?.direction, 'd-1');
  assert.equal(fresh.get('t-7')?.openedBy, 'a-1');
  await fresh.flush();

  // A link and a file past the size limit are not read.
  const away = join(root, 'away.json');
  await writeFile(
    away,
    JSON.stringify({ threads: [thread('t-1'), thread('t-2')] }),
  );
  await rm(path);
  await symlink(away, path);
  await fresh.load(at);
  assert.deepEqual(
    fresh.list().map((entry) => entry.id),
    [planThread],
  );
  await rm(path);
  await writeFile(
    path,
    JSON.stringify({
      threads: [thread('t-1'), thread('t-2')],
      pad: 'x'.repeat(4_000_001),
    }),
  );
  await fresh.load(at);
  assert.equal(fresh.list().length, 1);

  // At the limit, a new thread is refused.
  await rm(path);
  await writeFile(
    path,
    JSON.stringify({
      threads: Array.from({ length: threadLimits.threads + 3 }, (_, index) =>
        thread(`t-${index + 1}`),
      ),
    }),
  );
  await fresh.load(at);
  assert.equal(fresh.list().length, threadLimits.threads);
  await assert.rejects(
    fresh.fields(shape, 'a-1', 'd-1'),
    /The lab holds 500 threads, the limit/,
  );
});

await test('after a file that Verifold cannot read, the posts keep their threads, no number comes again, and a note says so', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-thread-store-')),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const board = new Board(root);
  await board.add({
    author: 'a-1',
    kind: 'proposal',
    thread: 't-7',
    text: 'Use the old mix.',
    mentions: [],
    artifacts: [],
  });
  await writeFile(join(root, 'threads.json'), 'not json');
  const fresh = store(root, board);
  await fresh.load(at);
  const note = fresh.lostNote();
  assert.match(note?.text ?? '', /could not read the records of 1 threads/);
  assert.match(note?.text ?? '', /t-7/);
  assert.equal(
    (
      await fresh.fields(
        { thread: { title: 'Does seed 2 agree?', why: 'One line.' } },
        'a-1',
        'd-1',
      )
    ).thread,
    't-8',
  );
  // A lab with every record says nothing.
  await board.add({
    author: 'a-1',
    kind: 'proposal',
    thread: 't-1',
    text: 'Use the old mix.',
    mentions: [],
    artifacts: [],
  });
  const clean = store(root, new Board(root));
  await clean.load(at);
  assert.equal(clean.lostNote(), null);
});

await test('the threads file at its stated limits stays under the 4 MB that a read takes', () => {
  // A control character takes 6 bytes in JSON, the most that a character can.
  const wide = (length: number): string => '\u0001'.repeat(length);
  const full: Thread = {
    ...thread('t-999999'),
    title: wide(threadLimits.title),
    why: wide(threadLimits.why),
    direction: 'd-9999',
    opening: 'p-999999',
    overturned: 'p-999999',
    outcome: {
      text: wide(280),
      post: 'p-999999',
      by: 'a-9999',
      at,
    },
    followers: Array.from(
      { length: threadLimits.followers },
      (_, index) => `a-${9000 + index}`,
    ),
    agreed: Array.from({ length: threadLimits.agreed }, () => ({
      post: 'p-999999',
      by: 'a-9999',
      at,
    })),
  };
  assert.ok(parseThread(full));
  const bytes = Buffer.byteLength(
    JSON.stringify(
      {
        schemaVersion: 1,
        threads: Array.from({ length: threadLimits.threads }, () => full),
      },
      null,
      2,
    ),
  );
  assert.ok(bytes < 4_000_000, String(bytes));
});

await test('a store writes nothing while the lab’s records move, and reads back what it wrote', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-thread-store-')),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  let paused = false;
  const first = store(root, new Board(root), () => paused);
  await first.load(at);
  await first.fields(
    { thread: { title: 'Does seed 2 agree?', why: 'One line.' } },
    'a-1',
    'd-1',
  );
  await first.flush();
  const second = store(root);
  await second.load(at);
  assert.deepEqual(second.list(), first.list());
  assert.equal((await stat(join(root, 'threads.json'))).mode & 0o777, 0o600);
  const before = await readFile(join(root, 'threads.json'), 'utf8');
  paused = true;
  await first.follow('a-2', 't-2');
  await first.flush();
  assert.equal(await readFile(join(root, 'threads.json'), 'utf8'), before);
});

await test('a digest carries the threads an agent follows, what is for it, and one line for each new thread', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-thread-digest-')),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const board = new Board(root);
  const add = (fields: Partial<NewPost>): Promise<Post> =>
    board.add({
      author: 'a-2',
      kind: 'proposal',
      text: 'Use the old mix.',
      mentions: [],
      artifacts: [],
      ...fields,
    });
  const mine = await add({ author: 'a-1', thread: 't-2', direction: 'd-1' });
  await add({ thread: 't-2' });
  const planned = await add({ thread: 't-1' });
  const other = await add({ thread: 't-3' });
  const toMe = await add({ thread: 't-3', kind: 'ask', mentions: ['a-1'] });
  const reply = await add({
    thread: 't-4',
    kind: 'objection',
    replyTo: mine.id,
  });
  const direction = await add({ thread: 't-5', direction: 'd-1' });
  const loose = await board.add({
    author: 'verifold',
    kind: 'status',
    text: 'A note for the lab.',
    mentions: [],
    artifacts: [],
  });
  const toAll = await board.add({
    author: 'person',
    kind: 'question',
    thread: 't-4',
    text: 'Everyone, read this.',
    mentions: ['all'],
    artifacts: [],
  });
  const threads = [
    planThreadRecord(at),
    thread('t-2', { followers: ['a-1', 'a-2'], opening: mine.id }),
    thread('t-3', {
      openedBy: 'a-2',
      opening: other.id,
      title: 'The third subject',
    }),
    thread('t-4', { opening: reply.id }),
    thread('t-5', { opening: direction.id, openedBy: 'a-1' }),
  ];
  const agent = { id: 'a-1', direction: 'd-1' };
  const digest = threadDigest(
    board,
    threads,
    agent,
    {
      readThrough: 0,
      seen: [],
    },
    windowMs,
  );
  const shown = digest.shown.map((entry) => entry.id);
  assert.deepEqual(
    [...shown].sort(),
    [
      'p-2',
      planned.id,
      toMe.id,
      reply.id,
      direction.id,
      loose.id,
      toAll.id,
    ].sort(),
  );
  assert.ok(!shown.includes(other.id));
  // What is addressed to the agent comes first.
  assert.deepEqual(shown.slice(0, 3), [toMe.id, reply.id, toAll.id]);
  const text = digest.lines.join('\n');
  assert.match(text, /\[ask, for you\] from a-2 on t-3/);
  assert.match(text, /^- t-2 \[open\] "The subject of t-2"/m);
  assert.match(
    text,
    /\[new thread\] t-3 "The third subject" from a-2: "One line\."/,
  );
  // The agent opened t-5, so it needs no line.
  assert.doesNotMatch(text, /\[new thread\] t-5/);
  // A thread with an outcome says it first.
  const done = threadDigest(
    board,
    [
      thread('t-2', {
        followers: ['a-1'],
        state: 'decided',
        outcome: { text: 'Use the old mix.', post: 'p-2', by: 'a-2', at },
      }),
    ],
    agent,
    { readThrough: 0, seen: [] },
    windowMs,
  );
  assert.match(
    done.lines.find((line) => line.startsWith('- t-2')) ?? '',
    /t-2 \[decided\] "The subject of t-2" Outcome from p-2: "Use the old mix\."/,
  );
  // Every post counts as read, also the ones that it did not show.
  assert.equal(digest.read.readThrough, board.latest());
  assert.deepEqual(
    threadDigest(board, threads, agent, digest.read, windowMs).lines,
    [],
  );
});

await test('a digest stays bounded when many threads open at once', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-thread-digest-')),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const board = new Board(root);
  const records: Thread[] = [];
  for (let index = 2; index < 42; index += 1) {
    const opened = await board.add({
      author: 'a-2',
      kind: 'proposal',
      thread: `t-${index}`,
      text: 'Use the old mix.',
      mentions: [],
      artifacts: [],
    });
    records.push(
      thread(`t-${index}`, {
        opening: opened.id,
        openedBy: 'a-2',
        followers: index < 6 ? ['a-1'] : [],
      }),
    );
  }
  const digest = threadDigest(
    board,
    records,
    { id: 'a-1', direction: 'd-1' },
    { readThrough: 0, seen: [] },
    windowMs,
  );
  const fresh = digest.lines.filter((line) => line.includes('[new thread]'));
  assert.equal(fresh.length, threadLimits.index);
  assert.ok(
    digest.lines.includes(
      `- 26 more new threads. verifold_board with view threads lists them.`,
    ),
  );
  assert.equal(digest.shown.length, 4);
  // The budget holds the posts, and the first always shows.
  const tight = threadDigest(
    board,
    records,
    { id: 'a-1', direction: 'd-1' },
    { readThrough: 0, seen: [] },
    windowMs,
    { budget: 10 },
  );
  assert.equal(tight.shown.length, 1);
  // Each agent hears of each proposal, with the end of its window, also outside its thread.
  const proposals = digest.lines.filter((line) =>
    line.startsWith('- [proposal]'),
  );
  assert.equal(proposals.length, threadLimits.index);
  assert.match(
    proposals[0] ?? '',
    /\[proposal\] p-31 on t-32 "The subject of t-32" from a-2: "Use the old mix\." Its objection window ends at 20/,
  );
  assert.ok(
    digest.lines.includes(
      '- 30 more new proposals. verifold_board with view threads lists their threads.',
    ),
  );
  assert.deepEqual(
    threadDigest(
      board,
      records,
      { id: 'a-2', direction: 'd-2' },
      { readThrough: 0, seen: [] },
      windowMs,
    ).lines.filter((line) => line.startsWith('- [proposal]')),
    [],
  );
});

await test('a digest stays under its limit at the largest inputs', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-thread-digest-')),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const board = new Board(root);
  const wide = (length: number): string => '\u0001'.repeat(length);
  const paths = Array.from(
    { length: 10 },
    (_, index) => `${String(index)}${'x'.repeat(299)}`,
  );
  const records: Thread[] = [];
  for (let index = 2; index < 60; index += 1) {
    const opened = await board.add({
      author: 'a-2',
      kind: 'proposal',
      thread: `t-${index}`,
      direction: 'd-1',
      text: wide(280),
      mentions: [],
      artifacts: Array.from({ length: 4 }, () => ({
        type: 'diff' as const,
        direction: 'd-1',
        from: 'a'.repeat(40),
        to: 'b'.repeat(40),
        paths,
      })),
    });
    records.push(
      thread(`t-${index}`, {
        title: wide(threadLimits.title),
        why: wide(threadLimits.why),
        opening: opened.id,
        openedBy: 'a-2',
        followers: index % 2 ? ['a-1'] : [],
        outcome: { text: wide(280), post: opened.id, by: 'a-2', at },
      }),
    );
  }
  const digest = threadDigest(
    board,
    records,
    { id: 'a-1', direction: 'd-1' },
    { readThrough: 0, seen: [] },
    windowMs,
    { fold: labLimits.digestPost, budget: labLimits.digestText },
  );
  const size = digest.lines.reduce((sum, line) => sum + line.length + 1, 0);
  assert.ok(size <= labLimits.digestText, String(size));
  assert.ok(digest.shown.length > 0);
});

await test('verifold_post in a new lab: a thread is required, kinds are new, and a claim is refused', async (t) => {
  const { lab, by, started } = await threeAgents(t);
  assert.match(
    started[0]?.tools.specs.find((tool) => tool.name === 'verifold_direction')
      ?.description ?? '',
    /a result, check, or rerun post/,
  );
  assert.match(started[0]?.prompt ?? '', /The plan is in the plan thread/);
  const names = started[0]?.tools.specs.map((tool) => tool.name);
  for (const name of ['verifold_status', 'verifold_agree', 'verifold_follow'])
    assert.ok(names?.includes(name), name);
  const call = by(0);
  const claim = await call('verifold_post', {
    kind: 'claim',
    text: 'Old kind.',
  });
  assert.equal(claim.ok, false);
  assert.match(claim.text, /Give a kind: result, check, ask, answer/);
  const none = await call('verifold_post', { kind: 'proposal', text: 'x y' });
  assert.equal(none.ok, false);
  assert.match(none.text, /Give thread to post in a thread, or title and why/);
  const noProof = await call('verifold_post', {
    kind: 'result',
    text: 'It holds.',
    thread: 't-1',
  });
  assert.equal(noProof.ok, false);
  assert.match(noProof.text, /A result needs proof/);
  const proposal = await call('verifold_post', {
    kind: 'proposal',
    text: 'Use the old mix.',
    ...open,
  });
  assert.equal(proposal.ok, true, proposal.text);
  assert.match(proposal.text, /in t-2\./);
  const view = viewOf(lab);
  const opened = view.threads?.find((entry) => entry.id === 't-2');
  assert.equal(opened?.title, open.title);
  assert.equal(opened?.why, open.why);
  assert.equal(opened?.openedBy, agentOf(lab, 0).id);
  assert.equal(opened?.direction, 'd-1');
  assert.equal(opened?.opening, posted(proposal.text));
  assert.deepEqual(opened?.followers, [agentOf(lab, 0).id]);
  const planPost = view.posts.find((entry) => entry.kind === 'plan');
  assert.equal(planPost?.thread, planThread);

  const reply = await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: posted(proposal.text),
    text: 'The old mix leaks.',
  });
  assert.equal(reply.ok, true, reply.text);
  assert.match(reply.text, /in t-2\./);
  assert.equal(
    viewOf(lab).threads?.find((entry) => entry.id === 't-2')?.followers.length,
    2,
  );
  assert.deepEqual(
    (
      JSON.parse(
        await readFile(
          join(
            (lab as unknown as { root: string }).root,
            '.verifold/lab/threads.json',
          ),
          'utf8',
        ).catch(() => '{}'),
      ) as { threads?: readonly Thread[] }
    ).threads?.length,
    2,
  );
});

await test('threads stay through a reload of the lab, and a restart keeps their numbers', async (t) => {
  const { lab, by, root } = await threeAgents(t);
  const first = await by(0)('verifold_post', {
    kind: 'proposal',
    text: 'Use the old mix.',
    ...open,
  });
  assert.equal(first.ok, true, first.text);
  await lab.suspend();
  await lab.reload();
  assert.deepEqual(
    viewOf(lab).threads?.map((entry) => entry.id),
    ['t-1', 't-2'],
  );
  await lab.close();
  const again = newLab(t, root);
  await again.lab.load();
  assert.equal(
    viewOf(again.lab).threads?.find((entry) => entry.id === 't-2')?.title,
    open.title,
  );
});

await test('verifold_status replaces the agent’s line, wakes no one, and survives a restart', async (t) => {
  const { lab, by, root, started } = await threeAgents(t);
  const before = viewOf(lab).posts.length;
  const events = viewOf(lab).directions.map(({ agent }) => agent.events.length);
  const first = await by(1)('verifold_status', {
    doing: 'Refitting seed 2',
    why: 'Seed 1 looks too good.',
    next: 'Compare with the control.',
  });
  assert.equal(first.ok, true, first.text);
  const refused = await by(1)('verifold_status', {
    doing: 'Nothing',
    why: '',
    next: 'x',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Write why you do it/);
  await by(1)('verifold_status', {
    doing: 'Refitting seed 3',
    why: 'Seed 1 looks too good.',
    next: 'Compare with the control.',
  });
  const view = viewOf(lab);
  assert.equal(view.posts.length, before);
  assert.deepEqual(
    view.directions.map(({ agent }) => agent.events.length),
    events,
  );
  const id = started[1]?.agent;
  const line = view.directions.find((row) => row.agent.id === id)?.agent
    .statusLine;
  assert.equal(line?.doing, 'Refitting seed 3');
  assert.equal(line?.next, 'Compare with the control.');
  await lab.close();
  const again = newLab(t, root);
  await again.lab.load();
  assert.equal(
    viewOf(again.lab).directions.find((row) => row.agent.id === id)?.agent
      .statusLine?.doing,
    'Refitting seed 3',
  );
});

await test('a direction’s row shows the agent’s own line while it works, with no time, and its evidence otherwise', () => {
  const now = Date.parse(at);
  const live = (state: 'working' | 'waiting' | 'idle' | 'ended') => ({
    state,
    text: state === 'waiting' ? 'Waiting for you' : 'Running a.py',
    since: new Date(now - 360_000).toISOString(),
  });
  assert.deepEqual(directionLine('Gap 3%', live('working'), now, 'Refit'), {
    working: true,
    text: 'Refit',
  });
  assert.deepEqual(directionLine('Gap 3%', live('idle'), now, 'Refit'), {
    working: false,
    text: 'Gap 3%',
  });
  assert.equal(
    directionLine('Gap 3%', live('waiting'), now, 'Refit').text,
    'Gap 3% · waiting for you',
  );
  assert.equal(
    directionLine('Gap 3%', live('ended'), now, 'Refit').text,
    'Gap 3%',
  );
  // With no line, nothing changes.
  assert.equal(directionLine('Gap 3%', live('idle'), now).text, 'Gap 3%');
  assert.equal(
    directionLine(null, live('working'), now).text,
    'Running a.py · 6 min',
  );
});

await test('a status line resets no quiet counter, and a new verdict clears it', async (t) => {
  const { lab, by, started } = await threeAgents(t);
  const id = started[0]?.agent ?? '';
  const quiet = (lab as unknown as { update: Lab['update'] }).update;
  await quiet.call(lab, id, (agent) => ({
    ...agent,
    quietTurns: 4,
    quietWork: 9,
    nudged: true,
  }));
  await by(0)('verifold_status', {
    doing: 'Refitting seed 2',
    why: 'Seed 1 looks too good.',
    next: 'Compare with the control.',
  });
  const agent = agentOf(lab, 0);
  assert.equal(agent.quietTurns, 4);
  assert.equal(agent.nudged, true);
  assert.equal(agent.statusLine?.doing, 'Refitting seed 2');
  const proof = await result(lab, by(0), id, open);
  const same = await by(0)('verifold_direction', {
    action: 'update',
    verdict: 'open',
    why: 'Nothing changed.',
  });
  assert.equal(same.ok, true, same.text);
  assert.equal(agentOf(lab, 0).statusLine?.doing, 'Refitting seed 2');
  const changed = await by(0)('verifold_direction', {
    action: 'update',
    verdict: 'leading',
    post: proof,
    evidence: 'Accuracy 0.7.',
    why: 'It meets the bar.',
  });
  assert.equal(changed.ok, true, changed.text);
  assert.equal(agentOf(lab, 0).statusLine, undefined);
});

await test('verifold_agree is a reaction: no post, no wake, once for each agent', async (t) => {
  const { lab, by, started } = await threeAgents(t);
  const proposal = await by(0)('verifold_post', {
    kind: 'proposal',
    text: 'Use the old mix.',
    ...open,
  });
  const id = posted(proposal.text);
  const before = viewOf(lab).posts.length;
  const own = await by(0)('verifold_agree', { post: id });
  assert.equal(own.ok, false);
  assert.match(own.text, /another author/);
  const other = await by(1)('verifold_agree', { post: id });
  assert.equal(other.ok, true, other.text);
  await by(1)('verifold_agree', { post: id });
  const missing = await by(1)('verifold_agree', { post: 'p-999' });
  assert.equal(missing.ok, false);
  const view = viewOf(lab);
  assert.equal(view.posts.length, before);
  assert.deepEqual(
    view.threads
      ?.find((entry) => entry.id === 't-2')
      ?.agreed.map((entry) => [entry.post, entry.by]),
    [[id, started[1]?.agent]],
  );
  assert.deepEqual(wokenBy(lab, id), []);
});

await test('verifold_follow adds a thread to an agent’s digests, and verifold_board reads any thread', async (t) => {
  const { lab, by } = await threeAgents(t);
  const proposal = await by(0)('verifold_post', {
    kind: 'proposal',
    text: 'Use the old mix.',
    ...open,
  });
  assert.equal(proposal.ok, true, proposal.text);
  const threads = await by(1)('verifold_board', { view: 'threads' });
  assert.match(threads.text, /t-2 \[open\] "Does the control beat chance\?"/);
  const page = await by(1)('verifold_board', { view: 'thread', thread: 't-2' });
  assert.match(page.text, /t-2 \[open\]/);
  assert.match(page.text, /Use the old mix\./);
  const unknown = await by(1)('verifold_board', {
    view: 'thread',
    thread: 't-9',
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /Name a thread, such as t-3, or a post/);
  const unread = await by(1)('verifold_board', { view: 'unread' });
  assert.doesNotMatch(unread.text, /p-\d+ \[proposal\]/);
  assert.match(unread.text, /\[new thread\] t-2/);
  assert.match(unread.text, /- \[proposal\] p-\d+ on t-2/);
  const follow = await by(1)('verifold_follow', { thread: 't-2' });
  assert.equal(follow.ok, true, follow.text);
  const missing = await by(1)('verifold_follow', { thread: 't-9' });
  assert.equal(missing.ok, false);
  assert.ok(
    viewOf(lab)
      .threads?.find((entry) => entry.id === 't-2')
      ?.followers.includes(agentOf(lab, 1).id),
  );
});

await test('an objection wakes its target’s author and marks the target Disputed until an answer accepts it', async (t) => {
  const { lab, by, started } = await threeAgents(t);
  const target = await result(lab, by(0), started[0]?.agent ?? '', open);
  const objection = await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'Seed 2 leaks.',
  });
  assert.equal(objection.ok, true, objection.text);
  const objectionId = posted(objection.text);
  assert.deepEqual(wokenBy(lab, objectionId), [agentOf(lab, 0).handle]);
  assert.deepEqual(
    openDisputes(viewOf(lab)).map((dispute) => dispute.target.id),
    [target],
  );
  const rebuttal = await by(0)('verifold_post', {
    kind: 'answer',
    replyTo: objectionId,
    text: 'Seed 2 is clean: I read the split.',
  });
  assert.equal(rebuttal.ok, true, rebuttal.text);
  assert.deepEqual(wokenBy(lab, posted(rebuttal.text)), [
    agentOf(lab, 1).handle,
  ]);
  assert.equal(openDisputes(viewOf(lab)).length, 1);
  const accepted = await by(0)('verifold_post', {
    kind: 'answer',
    replyTo: objectionId,
    accepts: true,
    text: 'Agreed: seed 2 leaked, and I removed it.',
  });
  assert.equal(accepted.ok, true, accepted.text);
  assert.equal(openDisputes(viewOf(lab)).length, 0);
});

await test('a post with file proof and no run: a third agent’s check ends a wrong objection, and a check that fails leaves the dispute and refuses the verdict', async (t) => {
  const { lab, by, started } = await threeAgents(t);
  const author = started[0]?.agent ?? '';
  const third = started[2]?.agent ?? '';
  const target = await result(lab, by(0), author, open);
  await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'Seed 2 leaks.',
  });
  // The objector's own check does not end its objection.
  await result(lab, by(1), started[1]?.agent ?? '', {
    kind: 'check',
    replyTo: target,
    outcome: 'holds',
  });
  assert.equal(openDisputes(viewOf(lab)).length, 1);
  const held = await result(lab, by(2), third, {
    kind: 'check',
    replyTo: target,
    outcome: 'holds',
  });
  assert.equal(openDisputes(viewOf(lab)).length, 0);
  assert.deepEqual(wokenBy(lab, held), []);

  const second = await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'Seed 3 leaks too.',
  });
  assert.equal(second.ok, true, second.text);
  const failed = await result(lab, by(2), third, {
    kind: 'check',
    replyTo: target,
    outcome: 'fails',
    direction: viewOf(lab).directions[2]?.direction.id,
  });
  assert.deepEqual(
    openDisputes(viewOf(lab)).map((dispute) => dispute.target.id),
    [target],
  );
  const made = viewOf(lab).posts.find((entry) => entry.id === failed);
  assert.equal(made?.outcome, 'fails');
  assert.equal(made?.thread, 't-2');
  const leading = await by(0)('verifold_direction', {
    action: 'update',
    verdict: 'leading',
    post: target,
    evidence: 'Accuracy 0.7.',
    why: 'It meets the bar.',
  });
  assert.equal(leading.ok, false);
  assert.match(leading.text, /failed the check p-\d+, so it backs no verdict/);
  const onCheck = await by(2)('verifold_direction', {
    action: 'update',
    verdict: 'leading',
    post: failed,
    evidence: 'Accuracy 0.7.',
    why: 'It meets the bar.',
  });
  assert.equal(onCheck.ok, false);
  assert.match(onCheck.text, /is a check that failed, so it backs no verdict/);
});

await test('an objection to a post that cites a run starts a check, and a result counts as its claim', async (t) => {
  const { lab, by } = await threeAgents(t);
  const run = await by(0)('verifold_run', {
    command: 'echo "METRIC acc=0.7"',
    why: 'Seed 1.',
  });
  assert.equal(run.ok, true, run.text);
  await until(() => viewOf(lab).ledger.every((entry) => !runActive(entry)));
  const id = viewOf(lab).ledger[0]?.id;
  const reply = await by(0)('verifold_post', {
    kind: 'result',
    text: 'Accuracy is 0.7.',
    artifacts: [{ type: 'run', run: id }],
    ...open,
  });
  assert.equal(reply.ok, true, reply.text);
  const target = posted(reply.text);
  const objection = await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'One seed is noise.',
  });
  assert.equal(objection.ok, true, objection.text);
  await until(() => viewOf(lab).checks.some((check) => check.claim === target));
  assert.deepEqual(viewOf(lab).checks[0]?.objections, [posted(objection.text)]);
});

await test('an ask wakes who it names and sets a wait until an answer comes', async (t) => {
  const { lab, by, started } = await threeAgents(t);
  const ask = await by(0)('verifold_post', {
    kind: 'ask',
    mentions: [agentOf(lab, 1).handle],
    text: 'Which seed leaks?',
    ...open,
  });
  assert.equal(ask.ok, true, ask.text);
  const id = posted(ask.text);
  assert.deepEqual(wokenBy(lab, id), [agentOf(lab, 1).handle]);
  const view = viewOf(lab);
  assert.deepEqual(
    openWaits(view.posts, view.threads ?? []).map(
      ({ waiter, on, post: asked }) => [waiter, on, asked],
    ),
    [[started[0]?.agent, started[1]?.agent, id]],
  );
  assert.ok(
    view.threads
      ?.find((entry) => entry.id === 't-2')
      ?.followers.includes(started[1]?.agent ?? ''),
  );
  const answer = await by(1)('verifold_post', {
    kind: 'answer',
    replyTo: id,
    text: 'Seed 2.',
  });
  assert.equal(answer.ok, true, answer.text);
  assert.deepEqual(wokenBy(lab, posted(answer.text)), [agentOf(lab, 0).handle]);
  const after = viewOf(lab);
  assert.deepEqual(openWaits(after.posts, after.threads ?? []), []);
  const opened = after.threads?.find((entry) => entry.id === 't-2');
  assert.equal(opened?.state, 'answered');
  assert.equal(opened?.outcome?.text, 'Seed 2.');
});

await test('a result, a proposal, and a mention in them wake no one', async (t) => {
  const { lab, by, started } = await threeAgents(t);
  const target = await result(lab, by(0), started[0]?.agent ?? '', {
    ...open,
    mentions: [agentOf(lab, 1).handle],
  });
  assert.deepEqual(wokenBy(lab, target), []);
  const proposal = await by(0)('verifold_post', {
    kind: 'proposal',
    thread: 't-2',
    text: 'Use the old mix.',
    mentions: [agentOf(lab, 1).handle],
  });
  assert.deepEqual(wokenBy(lab, posted(proposal.text)), []);
});

await test("the person's words wake followers past the hourly turns, and a post to nobody goes to the plan thread and reaches every agent", async (t) => {
  const { lab, by, started } = await threeAgents(t);
  await result(lab, by(0), started[0]?.agent ?? '', open);
  const toLab = await lab.post({ text: 'Stop using seed 2.' });
  assert.equal(toLab.thread, planThread);
  assert.equal(wokenBy(lab, toLab.id).length, 3);
  const inThread = viewOf(lab).posts.find(
    (entry) => entry.thread === 't-2',
  )?.id;
  const reply = await lab.post({ text: 'Why seed 2?', replyTo: inThread });
  assert.equal(reply.thread, 't-2');
  assert.deepEqual(wokenBy(lab, reply.id), [agentOf(lab, 0).handle]);
  const events = agentOf(lab, 0).events.filter(
    (event) => event.post === reply.id,
  );
  assert.equal(events[0]?.kind, 'person');
});

await test("the person's words in a thread with no live follower reach every agent, and each one reads them", async (t) => {
  const { lab, by, started, sent } = await threeAgents(t);
  await result(lab, by(0), started[0]?.agent ?? '', open);
  await lab.stopDirection(viewOf(lab).directions[0]?.direction.id ?? '');
  const inThread = viewOf(lab).posts.find((entry) => entry.thread === 't-2');
  const words = await lab.post({
    text: 'Why this result?',
    replyTo: inThread?.id,
  });
  assert.equal(wokenBy(lab, words.id).length, 2);
  assert.ok(
    viewOf(lab)
      .threads?.find((entry) => entry.id === 't-2')
      ?.followers.includes(started[1]?.agent ?? ''),
  );
  const sessions = (lab as unknown as { options: { sessions: LabSessions } })
    .options.sessions;
  sessions.idle = () => true;
  await until(() => sent.some((text) => text.includes('Why this result?')));
});

await test('a plan change wakes each agent that it changes, not the others', async (t) => {
  const { lab, started } = await threeAgents(t);
  const planner = started[0];
  assert.ok(planner);
  const rows = viewOf(lab).directions;
  const change = await planner.tools.call(
    'verifold_plan',
    {
      reading: 'A changed reading.',
      cost: 'Nothing yet.',
      directions: rows.map(({ direction }, index) => ({
        id: direction.id,
        ...(index === 1 ? { bar: 'It beats the control twice.' } : {}),
        ...(index === 2 ? { job: 'Controls' } : {}),
      })),
    },
    'plan-2',
  );
  assert.equal(change.ok, true, change.text);
  const id = /Posted the plan (p-\d+)/.exec(change.text)?.[1] ?? '';
  assert.deepEqual(wokenBy(lab, id), [agentOf(lab, 1).handle]);
});

await test('a proposal becomes a decision on the tick, its followers read it, and a later objection opens the thread again', async (t) => {
  const { lab, by } = await threeAgents(t, { objectionMs: 30 });
  const proposal = await by(0)('verifold_post', {
    kind: 'proposal',
    text: 'Use the old mix.',
    ...open,
  });
  assert.equal(proposal.ok, true, proposal.text);
  const id = posted(proposal.text);
  const objected = await by(1)('verifold_post', {
    kind: 'proposal',
    title: 'Which seed set do we report?',
    why: 'The paper needs one.',
    text: 'Report seeds 1 to 3.',
  });
  const stopped = await by(2)('verifold_post', {
    kind: 'objection',
    replyTo: posted(objected.text),
    text: 'Seed 2 leaks.',
  });
  assert.equal(stopped.ok, true, stopped.text);
  const threadOf = (name: string): Thread | undefined =>
    viewOf(lab).threads?.find((entry) => entry.id === name);
  await until(() => threadOf('t-2')?.state === 'decided');
  assert.equal(threadOf('t-2')?.outcome?.post, id);
  assert.equal(threadOf('t-3')?.state, 'open');
  const noteOf = (): Post | undefined =>
    viewOf(lab).posts.find(
      (entry) => entry.kind === 'status' && entry.replyTo === id,
    );
  await until(() => noteOf() !== undefined);
  const note = noteOf();
  assert.equal(note?.thread, 't-2');
  assert.match(note?.text ?? '', /is now the decision of t-2/);
  assert.deepEqual(wokenBy(lab, note?.id ?? ''), []);

  // A later objection opens the thread again, and the proposal does not decide it again.
  const late = await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: id,
    text: 'The old mix leaks.',
  });
  assert.equal(late.ok, true, late.text);
  assert.equal(threadOf('t-2')?.state, 'open');
  assert.equal(threadOf('t-2')?.outcome, undefined);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(threadOf('t-2')?.state, 'open');
});

await test('a board after a lost record has a note, once, and a reply there can open a new thread', async (t) => {
  const { lab, by, started, root } = await threeAgents(t);
  const target = await result(lab, by(0), started[0]?.agent ?? '', open);
  await lab.close();
  await writeFile(join(root, '.verifold', 'lab', 'threads.json'), 'not json');
  const again = newLab(t, root);
  await again.lab.load();
  const notes = (): number =>
    viewOf(again.lab).posts.filter((entry) =>
      entry.text.includes('could not read the records'),
    ).length;
  assert.equal(notes(), 1);
  await again.lab.close();
  const third = newLab(t, root);
  await third.lab.load();
  assert.equal(
    viewOf(third.lab).posts.filter((entry) =>
      entry.text.includes('could not read the records'),
    ).length,
    1,
  );
  third.lab.resumeAll();
  await until(() => third.started.length > 0);
  const call = toolsOf(third.started)(0);
  const refused = await call('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'Seed 2 leaks.',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /t-2 has no record now/);
  const reply = await call('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'Seed 2 leaks.',
    title: 'Does seed 2 leak into the test set?',
    why: 'The result rests on it.',
  });
  assert.equal(reply.ok, true, reply.text);
  assert.match(reply.text, /in t-3\./);
});

await test('a digest that goes out holds the thread lines', async (t) => {
  const { lab, by, started, sent } = await threeAgents(t);
  const sessions = (lab as unknown as { options: { sessions: LabSessions } })
    .options.sessions;
  sessions.idle = () => true;
  const target = await result(lab, by(0), started[0]?.agent ?? '', open);
  const objection = await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'Seed 2 leaks.',
  });
  assert.equal(objection.ok, true, objection.text);
  await until(() => sent.some((text) => text.includes('Seed 2 leaks.')));
  const digest = sent.find((text) => text.includes('Seed 2 leaks.')) ?? '';
  assert.match(digest, /- t-2 \[open\] "Does the control beat chance\?"/);
  assert.match(digest, /\[objection, for you\] from agent-2/);
  assert.match(digest, /on t-2, reply to/);
});

/** A lab from before threads: its state has no role counts, as on disk. */
async function oldLab(
  t: TestContext,
  root: string,
): Promise<ReturnType<typeof newLab>> {
  const first = newLab(t, root, { limit: 0 });
  await first.lab.start('Do months sit on a circle?');
  await first.lab.close();
  const path = join(root, '.verifold', 'lab.json');
  const state = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  delete state.roles;
  await writeFile(path, JSON.stringify(state));
  await rm(join(root, '.verifold', 'lab', 'threads.json'), { force: true });
  const built = newLab(t, root);
  await built.lab.load();
  return built;
}

await test('an older lab keeps its kinds, tools, wakes, and prompt, and holds no thread', async (t) => {
  const root = await project(t);
  const { lab, started } = await oldLab(t, root);
  await lab.addDirection({ title: 'Alpha', harness: 'claude' });
  await lab.addDirection({ title: 'Beta', harness: 'codex' });
  lab.resumeAll();
  await until(() => started.length >= 2);
  assert.deepEqual(viewOf(lab).threads, []);
  const first = started[0];
  const second = started[1];
  assert.ok(first && second);
  assert.deepEqual(first.tools.specs.slice(0, 3), labToolSpecs);
  assert.ok(!first.tools.specs.some((tool) => tool.name === 'verifold_status'));
  assert.match(first.prompt, /`claim`: a result of your direction/);
  assert.match(first.prompt, /The person must understand them/);
  assert.match(first.prompt, /A reply to your plan post wakes you\./);
  assert.doesNotMatch(first.prompt, /`t-1`/);
  const direction = first.tools.specs.find(
    (tool) => tool.name === 'verifold_direction',
  );
  assert.match(
    direction?.description ?? '',
    /a claim, evidence, or rerun post/,
  );
  const question = await first.tools.call(
    'verifold_post',
    { kind: 'question', text: 'Which layer?', mentions: ['codex-1'] },
    'old-1',
  );
  assert.equal(question.ok, true, question.text);
  assert.doesNotMatch(question.text, / in t-/);
  const asked = posted(question.text);
  assert.equal(
    viewOf(lab).posts.find((entry) => entry.id === asked)?.thread,
    undefined,
  );
  assert.deepEqual(wokenBy(lab, asked), ['codex-1']);
  const newKind = await first.tools.call(
    'verifold_post',
    { kind: 'proposal', text: 'Use the old mix.' },
    'old-2',
  );
  assert.equal(newKind.ok, false);
  assert.match(newKind.text, /Give a kind: claim, evidence/);
  // A person's post keeps its old reach.
  const words = await lab.post({ text: 'Stop.' });
  assert.equal(words.thread, undefined);
  assert.equal(wokenBy(lab, words.id).length, viewOf(lab).directions.length);
  // An objection that no check took stays a reply here.
  await first.tools.call(
    'verifold_post',
    {
      kind: 'objection',
      replyTo: asked,
      text: 'Seed 2 leaks.',
    },
    'old-3',
  );
  assert.deepEqual(openDisputes(viewOf(lab)), []);
  await lab.close();
  await assert.rejects(
    stat(join(root, '.verifold', 'lab', 'threads.json')),
    /ENOENT/,
  );
});

const reader = (root: string, view: LabView): ApiReader =>
  new ApiReader(() => ({
    root,
    lab: { view: () => view },
    compute: undefined,
    session: () => null,
    away: () => Promise.resolve(null),
    works: [],
  }));

await test('an ask that names the person shows on the wire first, and their reply ends it', async (t) => {
  const { lab, by, root } = await threeAgents(t);
  const doubt = await by(0)('verifold_post', {
    kind: 'ask',
    mentions: [agentOf(lab, 1).handle],
    text: 'Which seed leaks?',
    ...open,
  });
  assert.equal(doubt.ok, true, doubt.text);
  const ask = await by(0)('verifold_post', {
    kind: 'ask',
    mentions: ['person'],
    text: 'Is the budget firm?',
    title: 'Is the money limit firm?',
    why: 'It sets the seeds.',
  });
  assert.equal(ask.ok, true, ask.text);
  const id = posted(ask.text);
  const wire = async (): Promise<import('../src/protocol/api.ts').Lab> =>
    (
      JSON.parse((await reader(root, viewOf(lab)).build()).json) as {
        lab: import('../src/protocol/api.ts').Lab;
      }
    ).lab;
  const waits = (await wire()).waits ?? [];
  assert.deepEqual(waits[0], {
    waiter: agentOf(lab, 0).id,
    waiterHandle: 'agent-1',
    on: 'person',
    onHandle: null,
    post: id,
    reason: 'ask',
    thread: 't-3',
    subject: 'Is the money limit firm?',
    text: 'Is the budget firm?',
    since: viewOf(lab).posts.find((entry) => entry.id === id)?.at,
  });
  assert.equal(waits.length, 2);
  await lab.post({ text: 'Yes, it is firm.', replyTo: id });
  assert.deepEqual(
    ((await wire()).waits ?? []).map((wait) => wait.on),
    [agentOf(lab, 1).id],
  );
  assert.equal(
    viewOf(lab).threads?.find((entry) => entry.id === 't-3')?.state,
    'answered',
  );
});

await test('a snapshot carries threads, an agent’s line, and marks on posts, and a thread reads as a page', async (t) => {
  const { lab, by, root, started } = await threeAgents(t);
  const target = await result(lab, by(0), started[0]?.agent ?? '', open);
  await by(1)('verifold_post', {
    kind: 'objection',
    replyTo: target,
    text: 'Seed 2 leaks.',
  });
  const cited = await result(lab, by(2), started[2]?.agent ?? '', {
    thread: 't-2',
    text: `We reuse ${target} here.`,
  });
  await result(lab, by(2), started[2]?.agent ?? '', {
    kind: 'check',
    replyTo: target,
    outcome: 'fails',
    text: 'The recount differs.',
  });
  await by(1)('verifold_status', {
    doing: 'Refitting seed 2',
    why: 'Seed 1 looks too good.',
    next: 'Compare with the control.',
  });
  await by(1)('verifold_agree', { post: target });
  const view = viewOf(lab);
  const { json } = await reader(root, view).build();
  const { lab: wire } = JSON.parse(json) as {
    lab: import('../src/protocol/api.ts').Lab;
  };
  const shown = new Map(wire.board.posts.map((entry) => [entry.id, entry]));
  assert.equal(shown.get(target)?.disputed, true);
  assert.equal(shown.get(target)?.thread, 't-2');
  assert.deepEqual(shown.get(target)?.recountedBy, [
    { handle: 'agent-3', outcome: 'fails' },
  ]);
  assert.equal(shown.get(cited)?.citesDisputed, target);
  assert.equal(shown.get(cited)?.disputed, undefined);
  const threads = wire.threads ?? [];
  assert.deepEqual(
    threads.map((entry) => entry.id),
    ['t-1', 't-2'],
  );
  assert.equal(threads[1]?.title, open.title);
  assert.equal(threads[1]?.agreed[0]?.post, target);
  assert.equal(threads[1]?.outcome, null);
  assert.equal(
    wire.agents.find((agent) => agent.id === started[1]?.agent)?.line?.doing,
    'Refitting seed 2',
  );
  assert.equal(wire.disputes.length, 1);
  assert.equal(wire.directions[0]?.disputed, true);
  assert.deepEqual(
    wire.waits?.map(({ reason, waiterHandle, onHandle, subject }) => [
      reason,
      waiterHandle,
      onHandle,
      subject,
    ]),
    [['objection', 'agent-2', 'agent-1', open.title]],
  );
  const page = reader(root, view).threadPage('t-2');
  assert.equal(page?.thread.id, 't-2');
  assert.ok(page?.posts.every((entry) => entry.thread === 't-2'));
  assert.equal(page?.more, false);
  assert.equal(page?.posts[0]?.disputed, true);
  assert.equal(reader(root, view).threadPage('t-9'), null);
});
