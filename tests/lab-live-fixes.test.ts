import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, clip, type NewPost, type Post } from '../src/core/board.ts';
import {
  briefLimits,
  labCoordinatorToolSpecs,
  lineCheckToolSpecs,
  longShotLimits,
} from '../src/core/lab-tools.ts';
import { loadPrompt } from '../src/core/prompts.ts';
import {
  checkReason,
  evidencePosts,
  shownKind,
  strayNumbers,
  wholePost,
} from '../src/core/lab/brief.ts';
import { BriefStore } from '../src/core/lab/brief-store.ts';
import { collabOf } from '../src/core/lab/collab.ts';
import {
  coordinatorAgent,
  LabCoordinator,
  type LabCoordinatorHost,
} from '../src/core/lab/coordinator.ts';
import { parseChecks, triedPost } from '../src/core/lab/coordinator-rules.ts';
import { parseIdea, type Idea } from '../src/core/lab/ideas.ts';
import { LiteratureStore } from '../src/core/lab/literature-store.ts';
import { recordFacts } from '../src/core/lab/record-facts.ts';
import type {
  BriefLine,
  Check,
  Direction,
  LabSessions,
  LabView,
  PlanOfRecord,
} from '../src/core/lab/schema.ts';
import { ThreadStore } from '../src/core/lab/thread-store.ts';
import { openWaits } from '../src/core/lab/waits.ts';
import type { SessionRecord, SessionView } from '../src/core/session.ts';
import { briefItems } from '../src/server/lab-brief.ts';
import { waitItems } from '../src/server/lab-threads.ts';

const at = '2026-11-01T12:00:00.000Z';

function postOf(id: string, more: Partial<Post> = {}): Post {
  return {
    schemaVersion: 1,
    id,
    at,
    author: 'a-1',
    harness: 'claude',
    kind: 'result',
    thread: 't-2',
    text: 'One agent reports a result.',
    mentions: [],
    artifacts: [],
    ...more,
  };
}

const reading =
  'The lab reads the question in two ways, and tests both on the same data, because one reading alone would hide the other. A first probe suggests that the first group fits far better than chance and that the second group fails. The lab must explain both, and say how far each depends on the stopping point, with 412 samples or more.';

/** The board clips a plan post in a word, and the plan of record keeps the rest. */
const clipped = clip(reading, 280);

function checkOf(more: Partial<Check> = {}): Check {
  return {
    claim: 'p-1',
    state: 'done',
    outcome: 'holds',
    method: 'rerun',
    result: null,
    endedAt: at,
    queuedAt: at,
    sameHarness: false,
    blind: true,
    objections: [],
    ...more,
  } as Check;
}

const directionOf = (
  id: string,
  more: Partial<Direction> = {},
): Pick<Direction, 'id' | 'agent' | 'state' | 'verdict'> => ({
  id,
  agent: id.replace('d-', 'a-'),
  state: 'open',
  verdict: 'open',
  ...more,
});

interface Rig {
  readonly board: Board;
  readonly store: BriefStore;
  readonly started: { readonly prompt: string; readonly tools: Tools }[];
  readonly directions: ReturnType<typeof directionOf>[];
  readonly ideas: Idea[];
  readonly marked: string[];
  readonly coordinator: LabCoordinator;
  plan: Pick<PlanOfRecord, 'post' | 'reading'> | null;
  readonly post: (fields: Partial<NewPost>) => Promise<Post>;
  readonly call: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ readonly ok: boolean; readonly text: string }>;
  readonly end: () => Promise<void>;
}

type Tools = Parameters<LabSessions['startAgent']>[0]['tools'];

/** A Coordinator on a fake reserved place: a start records its input, and no harness runs. */
async function rig(t: TestContext): Promise<Rig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-fixes-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const board = new Board(root);
  await board.load();
  const threads = new ThreadStore(
    join(root, 'threads.json'),
    () => false,
    board,
    3_600_000,
  );
  await threads.load(at);
  const store = new BriefStore(join(root, 'brief.json'), () => false);
  await store.load(true);
  t.after(() => store.flush());
  const started: Rig['started'] = [];
  const live = new Set<string>();
  const ideas: Idea[] = [];
  const marked: string[] = [];
  const directions: Rig['directions'] = [];
  const state: { plan: Rig['plan'] } = { plan: null };
  const host: LabCoordinatorHost = {
    root,
    sessions: {
      get full(): boolean {
        return live.size >= 1;
      },
      view: (id) =>
        live.has(id) ? ({ live: true } as unknown as SessionView) : null,
      startAgent: (input) => {
        const id = `session-${started.length + 1}`;
        started.push({ prompt: input.prompt, tools: input.tools });
        live.add(id);
        return Promise.resolve(id);
      },
      continueTask: () => {},
      endTask: (id) => {
        live.delete(id);
      },
    },
    store,
    threads,
    timing: { hourMs: 3_600_000, minuteMs: 60_000, briefDelayMs: 0 },
    question: () => 'Does the pattern hold?',
    directions: () => directions,
    summary: () => '- d-1 "A line of work": open.',
    board,
    checks: () => [],
    plan: () => state.plan,
    ideas: () => ideas,
    markTried: (idea, post) => {
      marked.push(`${String(idea)} ${post}`);
      return Promise.resolve('Kept.');
    },
    name: (author) => author,
    team: () => Promise.resolve(['claude', 'codex']),
    usedUp: () => false,
    model: () => Promise.resolve('best-model'),
    denied: () => Promise.resolve([]),
    keepsPlain: () => Promise.resolve(true),
    add: (fields) => board.add(fields),
    read: () => Promise.resolve('the record'),
    notify: () => true,
    serial: (work) => Promise.resolve().then(work),
    progress: () => {},
  };
  const coordinator = new LabCoordinator(host);
  t.after(() => coordinator.stop());
  directions.push(directionOf('d-1'));
  const built: Rig = {
    board,
    store,
    started,
    directions,
    ideas,
    marked,
    coordinator,
    get plan() {
      return state.plan;
    },
    set plan(value) {
      state.plan = value;
    },
    post: async (fields) => {
      const post = await board.add({
        author: 'a-1',
        kind: 'status',
        thread: 't-1',
        text: 'It works.',
        mentions: [],
        artifacts: [],
        ...fields,
      });
      await threads.posted(post, []);
      return post;
    },
    call: async (name, input) => {
      const newest = started.at(-1);
      assert.ok(newest);
      return newest.tools.call(name, input, 'call-1');
    },
    end: async () => {
      coordinator.turnEnded({
        id: `session-${started.length}`,
        agent: coordinatorAgent,
        status: 'idle',
        launches: [],
      } as unknown as SessionRecord);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
  };
  return built;
}

const lineOf = (
  id: string,
  plain: string,
  more: Partial<BriefLine> = {},
): BriefLine => ({
  id,
  kind: 'open',
  at,
  plain,
  posts: ['p-1'],
  writer: 'claude',
  check: { state: 'passed', by: 'codex', sameHarness: false, problems: [] },
  ...more,
});

const viewWith = (more: Record<string, unknown>): LabView =>
  ({
    state: { directions: [], calls: [], plan: null },
    posts: [],
    ledger: [],
    checks: [],
    brief: {
      brief: null,
      notices: [],
      questions: [],
      stories: [],
      sessions: [],
    },
    ...more,
  }) as unknown as LabView;

await test('a plan post reads with its whole text, and any other post keeps its own', () => {
  assert.match(clipped, /…$/);
  const plan = { post: 'p-1', reading };
  assert.equal(
    wholePost(postOf('p-1', { kind: 'plan', text: clipped }), plan).text,
    reading,
  );
  const other = postOf('p-2');
  assert.equal(wholePost(other, plan), other);
  assert.equal(
    wholePost(postOf('p-1', { kind: 'plan', text: clipped }), null).text,
    clipped,
  );
});

await test('a quote of the plan never ends in a clipped word, and a number past the clip passes', () => {
  const posts = [postOf('p-1', { kind: 'plan', text: clipped })];
  assert.deepEqual(strayNumbers('It needs 412 samples.', posts), ['412']);
  const line = lineOf('l-1', 'It needs 412 samples or more.');
  const view = viewWith({
    state: {
      directions: [],
      calls: [],
      plan: { post: 'p-1', reading },
    },
    posts,
    brief: {
      brief: { at, key: 'k', through: 1, lines: [line] },
      notices: [],
      questions: [],
      stories: [],
      sessions: [],
    },
  });
  const { brief } = briefItems(view, (list) => [...list]);
  assert.deepEqual(brief?.lines[0]?.quotes, [{ post: 'p-1', text: reading }]);
  // The clip would have failed the number test on the way out.
  assert.equal(brief?.lines[0]?.plain, 'It needs 412 samples or more.');
  assert.equal(brief?.lines[0]?.check.state, 'passed');
});

await test('the line check reads the whole plan and the record, and the number test does too', async (t) => {
  const lab = await rig(t);
  const plan = await lab.post({ kind: 'plan', text: clipped });
  lab.plan = { post: plan.id, reading };
  const asks = await lab.post({
    kind: 'ask',
    author: 'a-2',
    mentions: ['a-1'],
    text: 'Please check my counts.',
  });
  await lab.coordinator.tick();
  assert.equal(lab.started.length, 1);
  // Its own first prompt holds the whole plan too.
  assert.ok(lab.started[0]?.prompt.includes(reading));
  const brief = await lab.call('verifold_brief', {
    lines: [
      { kind: 'open', plain: 'The lab needs 412 samples.', posts: [plan.id] },
      {
        kind: 'open',
        plain: 'That ask has no answer yet.',
        posts: [asks.id],
      },
    ],
  });
  assert.equal(brief.ok, true, brief.text);
  assert.match(brief.text, /End your turn/);
  await lab.end();
  await lab.coordinator.tick();
  const check = lab.started.at(-1)?.prompt ?? '';
  assert.match(check, /verifold_line_check/);
  assert.ok(check.includes(JSON.stringify(reading)));
  assert.ok(!check.includes(clipped));
  assert.match(
    check,
    new RegExp(`${asks.id} of a-2 waits on a-1\\. No answer ended this ask`),
  );
  assert.match(check, /a-1 on d-1: open, no verdict yet\. Its posts: 1 plan/);
});

await test('a line check keeps the whole of a long post', async (t) => {
  const lab = await rig(t);
  const long = 'The person wrote at length. '.repeat(100).trim();
  const post = await lab.post({
    author: 'person',
    kind: 'question',
    text: long,
  });
  await lab.coordinator.tick();
  await lab.call('verifold_brief', {
    lines: [{ kind: 'new', plain: 'The person wrote.', posts: [post.id] }],
  });
  await lab.end();
  await lab.coordinator.tick();
  assert.ok(
    lab.started.at(-1)?.prompt.includes(JSON.stringify(long).slice(1, -1)),
  );
});

await test('the record facts hold each direction, wait, thread, and check of the cited posts', () => {
  const posts = [
    postOf('p-1', { kind: 'plan' }),
    postOf('p-2'),
    postOf('p-3'),
    postOf('p-4', { author: 'a-2', kind: 'status' }),
    postOf('p-5', { thread: 't-9' }),
  ];
  const facts = recordFacts({
    cited: [posts[1], posts[2]].flatMap((post) => post ?? []),
    posts,
    directions: [
      directionOf('d-1', { verdict: 'leading' }),
      directionOf('d-2', { state: 'closed', verdict: 'ruled-out' }),
    ],
    threads: [
      { id: 't-2', state: 'open' },
      { id: 't-9', state: 'closed' },
    ],
    waits: [
      {
        waiter: 'a-1',
        on: 'person',
        post: 'p-2',
        reason: 'ask',
        thread: 't-2',
        since: at,
      },
      {
        waiter: 'a-1',
        on: 'a-2',
        post: 'p-5',
        reason: 'ask',
        thread: 't-9',
        since: at,
      },
    ],
    checks: [
      { claim: 'p-2', state: 'running', outcome: null },
      { claim: 'p-3', state: 'done', outcome: 'fails' },
      { claim: 'p-3', state: 'dropped', outcome: null },
      { claim: 'p-5', state: 'done', outcome: 'holds' },
    ],
    name: (author) => author.replace('a-', 'Agent '),
  });
  assert.deepEqual(facts, [
    '- Agent 1 on d-1: open, leading. Its posts: 1 plan, 3 result.',
    '- Agent 2 on d-2: closed by its agent, ruled out. Its posts: none.',
    '- p-2 of Agent 1 waits on the person. No answer ended this ask yet.',
    '- t-2: open.',
    '- A check of p-2 waits or runs.',
    '- A check of p-3 ended: fails.',
  ]);
});

await test('the record facts stay within their limit', () => {
  const facts = recordFacts({
    cited: [],
    posts: [],
    directions: Array.from(
      { length: briefLimits.recordFacts + 5 },
      (_, index) => directionOf(`d-${index + 1}`),
    ),
    threads: [],
    waits: [],
    checks: [],
    name: (author) => author,
  });
  assert.equal(facts.length, briefLimits.recordFacts);
});

await test('the check prompt keeps results strict, and lets a definition and the record pass', async () => {
  const prompt = await loadPrompt('lab-line-check');
  // What stays strict.
  for (const rule of [
    /`added-fact`: .*a cause, a reason, a comparison, or a result/,
    /`raised-certainty`/,
    /`number-out-of-scope`/,
    /It cannot add a result, a cause, or certainty/,
    /When you are in doubt about a claim of a result, do not write `supported`/,
  ])
    assert.match(prompt, rule);
  // What no longer fails a true line.
  assert.match(prompt, /A plain definition/);
  assert.match(prompt, /judge it against the record's facts/);
  assert.match(prompt, /would conclude something else/);
  assert.match(prompt, /A plain line can leave out detail/);
  const [spec] = lineCheckToolSpecs;
  assert.match(spec?.description ?? '', /record facts/);
});

await test('each kind of finding still fails a line', () => {
  for (const verdict of [
    'added-fact',
    'raised-certainty',
    'number-out-of-scope',
  ])
    assert.equal(
      parseChecks(
        [
          {
            id: 'l-1',
            claims: [{ claim: 'The second group passed.', verdict }],
            dropped: [],
          },
        ],
        ['l-1'],
      ).get('l-1')?.state,
      'failed',
    );
  assert.equal(
    parseChecks(
      [
        {
          id: 'l-1',
          claims: [{ claim: 'It ran.', verdict: 'supported' }],
          dropped: ['It holds for one seed only.'],
        },
      ],
      ['l-1'],
    ).get('l-1')?.state,
    'failed',
  );
});

await test('a brief has at most 5 lines, and a later brief replaces the last one', async (t) => {
  const lab = await rig(t);
  const post = await lab.post({});
  await lab.coordinator.tick();
  const line = { kind: 'new', plain: 'It works.', posts: [post.id] };
  const tooMany = await lab.call('verifold_brief', {
    lines: Array.from({ length: briefLimits.briefLines + 1 }, () => line),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.text, /Give 1 to 5 lines, the most important first/);
  assert.equal(lab.store.view().brief, null);
  const five = await lab.call('verifold_brief', {
    lines: Array.from({ length: briefLimits.briefLines }, () => line),
  });
  assert.equal(five.ok, true, five.text);
  assert.equal(lab.store.view().brief?.lines.length, 5);
  await lab.call('verifold_brief', { lines: [line] });
  assert.equal(lab.store.view().brief?.lines.length, 1);
  const spec = labCoordinatorToolSpecs.find(
    (tool) => tool.name === 'verifold_brief',
  );
  assert.equal(briefLimits.briefLines, 5);
  assert.match(JSON.stringify(spec), /"maxItems":5/);
  assert.match(
    await loadPrompt('lab-coordinator'),
    /at most 5 lines, the most important first/,
  );
});

await test('"Held up" needs a rerun that held on each result, and any other held line is a Result', () => {
  const one = [postOf('p-1')];
  const two = [postOf('p-1'), postOf('p-2')];
  assert.equal(shownKind('held', one, []), 'result');
  assert.equal(shownKind('held', one, [checkOf()]), 'held');
  // A check that did not end, a code read, or a failed rerun holds nothing up.
  assert.equal(
    shownKind('held', one, [checkOf({ state: 'running' })]),
    'result',
  );
  assert.equal(
    shownKind('held', one, [checkOf({ method: 'code-read' })]),
    'result',
  );
  assert.equal(
    shownKind('held', one, [checkOf({ outcome: 'fails' })]),
    'result',
  );
  // The newest rerun decides.
  assert.equal(
    shownKind('held', one, [
      checkOf({ endedAt: '2026-11-01T12:01:00.000Z' }),
      checkOf({ endedAt: '2026-11-01T12:02:00.000Z', outcome: 'fails' }),
    ]),
    'result',
  );
  // Each result needs its own.
  assert.equal(shownKind('held', two, [checkOf()]), 'result');
  assert.equal(
    shownKind('held', two, [checkOf(), checkOf({ claim: 'p-2' })]),
    'held',
  );
  // A check post of another agent counts when it reran the result.
  const reran = postOf('p-2', {
    kind: 'check',
    author: 'a-2',
    replyTo: 'p-1',
    method: 'rerun',
    outcome: 'holds',
  });
  assert.equal(
    shownKind('held', evidencePosts([one[0] as Post], [...one, reran]), []),
    'held',
  );
  // An open objection takes it back.
  const doubt = postOf('p-3', {
    kind: 'objection',
    author: 'a-2',
    replyTo: 'p-1',
  });
  assert.equal(
    shownKind('held', evidencePosts(one, [...one, doubt]), [checkOf()]),
    'result',
  );
  // No line of another kind changes.
  for (const kind of ['decided', 'failed', 'open', 'new', 'answer'] as const)
    assert.equal(shownKind(kind, one, []), kind);
});

await test('an answer goes out as written at each state of its check, with the reason when it failed', () => {
  const posts = [postOf('p-1', { text: 'It reached 64.5%.' })];
  const asked = (answer: BriefLine, state = 'answered'): LabView =>
    viewWith({
      posts,
      brief: {
        brief: null,
        notices: [],
        questions: [{ id: 'q-1', at, text: 'Why?', state, answer }],
        stories: [],
        sessions: [],
      },
    });
  const shown = (answer: BriefLine) =>
    briefItems(asked(answer), (list) => [...list]).questions[0]?.answer;
  const plain = 'It reached 64.5% on one seed.';
  const check = (
    state: BriefLine['check']['state'],
    problems: readonly string[] = [],
  ): BriefLine['check'] => ({ state, by: null, sameHarness: false, problems });
  const answerOf = (more: Partial<BriefLine>): BriefLine =>
    lineOf('l-1', plain, { kind: 'answer', ...more });
  assert.equal(shown(answerOf({ check: check('pending') }))?.plain, plain);
  const failed = shown(
    answerOf({
      check: check('failed', [
        'added-fact: The rerun held.',
        'dropped-caveat: One seed only.',
      ]),
    }),
  );
  assert.equal(failed?.plain, plain);
  assert.equal(
    failed?.check.reason,
    'Failed its check, with 2 problems. Its posts do not say: The rerun held.',
  );
  const numbers = shown(
    answerOf({
      plain: 'It reached 91.5%.',
      check: check('numbers', ['91.5%']),
    }),
  );
  assert.equal(numbers?.plain, 'It reached 91.5%.');
  assert.equal(
    numbers?.check.reason,
    'Failed its check. No cited post holds 91.5%.',
  );
  // A lab that keeps no plain words has only its quotes.
  assert.equal(
    shown(answerOf({ plain: '', check: check('withheld') }))?.plain,
    null,
  );
  // A line of the brief stays behind its check.
  const brief = briefItems(
    viewWith({
      posts,
      brief: {
        brief: {
          at,
          key: 'k',
          through: 1,
          lines: [
            lineOf('l-2', plain, { check: check('failed', ['added-fact: X']) }),
          ],
        },
        notices: [],
        questions: [],
        stories: [],
        sessions: [],
      },
    }),
    (list) => [...list],
  ).brief;
  assert.equal(brief?.lines[0]?.plain, null);
  assert.equal(brief?.lines[0]?.check.reason, undefined);
});

await test('the reason of a failed check reads as one plain line', () => {
  assert.equal(checkReason('passed', []), null);
  assert.equal(checkReason('pending', []), null);
  assert.equal(
    checkReason('failed', ['raised-certainty: It failed.']),
    'Failed its check. It is more certain than its posts: It failed.',
  );
  assert.equal(
    checkReason('failed', ['number-out-of-scope: 4 of 5 seeds.']),
    'Failed its check. A number counts something else: 4 of 5 seeds.',
  );
  assert.equal(
    checkReason('failed', ['dropped-caveat: One seed only.']),
    'Failed its check. It leaves out a caveat: One seed only.',
  );
  // A hand-edited file holds no reason to show.
  assert.equal(checkReason('failed', ['odd']), 'Failed its check.');
  assert.equal(checkReason('failed', []), 'Failed its check.');
  assert.equal(
    checkReason('numbers', []),
    'Failed its check. A number is not in its cited posts.',
  );
  assert.ok(
    (checkReason('failed', [`added-fact: ${'long '.repeat(100)}`]) ?? '')
      .length < 220,
  );
});

await test('no session starts until the board has a post, and the first post lets the update run', async (t) => {
  const lab = await rig(t);
  await lab.coordinator.tick();
  assert.equal(lab.started.length, 0);
  // A question waits for it too: an answer must cite a post.
  lab.coordinator.ask('What is new?');
  await lab.coordinator.tick();
  assert.equal(lab.started.length, 0);
  await lab.post({});
  await lab.coordinator.tick();
  assert.equal(lab.started.length, 1);
});

await test('the Coordinator marks an idea tried with the post that tried it, and that is all the tool does', async (t) => {
  const lab = await rig(t);
  const run = {
    type: 'file',
    path: 'out.txt',
    commit: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    bytes: 1,
  } as const;
  const result = await lab.post({ kind: 'result', artifacts: [run] });
  const plan = await lab.post({ kind: 'plan', text: 'A plan.' });
  lab.ideas.push(
    {
      id: 'i-1',
      text: 'An untried idea',
      sources: [],
      tried: false,
      by: 'a-1',
      at,
    },
    {
      id: 'i-2',
      text: 'A tried idea',
      sources: [],
      tried: true,
      by: 'a-1',
      at,
    },
  );
  await lab.coordinator.tick();
  const prompt = lab.started[0]?.prompt ?? '';
  assert.match(prompt, /i-1: "An untried idea"/);
  assert.doesNotMatch(prompt, /A tried idea/);
  assert.match(prompt, /mark the ideas that posts tried/);
  assert.match(
    await loadPrompt('lab-coordinator'),
    /`verifold_tried` marks an idea/,
  );
  const refused = await lab.call('verifold_tried', {
    idea: 'i-1',
    post: plan.id,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Cite a result, check, rerun, or ruled-out post/);
  assert.equal(
    (await lab.call('verifold_tried', { idea: 'i-1', post: 'p-99' })).ok,
    false,
  );
  const marked = await lab.call('verifold_tried', {
    idea: 'i-1',
    post: result.id,
  });
  assert.equal(marked.ok, true, marked.text);
  assert.deepEqual(lab.marked, [`i-1 ${result.id}`]);
  // It holds no plain words, so no line waits for a check.
  assert.equal(lab.store.pending().length, 0);
});

await test('a tried mark lasts, cites its post, and refuses an idea off the map', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-ideas-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(root, 'literature.json');
  const store = new LiteratureStore(path, () => false);
  await store.load(true);
  await store.addIdea('a-1', { text: 'An idea', tried: false });
  await assert.rejects(
    store.markTried('i-9', 'p-1'),
    /Name an idea of the map/,
  );
  assert.match(await store.markTried('i-1', 'p-3'), /i-1 is marked tried/);
  assert.match(await store.markTried('i-1', 'p-4'), /already/);
  await store.flush();
  const next = new LiteratureStore(path, () => false);
  await next.load(true);
  assert.deepEqual(
    next.ideas().map(({ tried, post }) => [tried, post]),
    [[true, 'p-3']],
  );
  assert.match(next.ideaLines(5), /\[tried in p-3\]/);
  assert.equal(
    parseIdea({ id: 'i-1', text: 'x', by: 'a-1', at, post: '../etc' })?.post,
    undefined,
  );
});

await test('a post that tried an idea says what a run or a check did', () => {
  for (const kind of ['result', 'check', 'rerun', 'ruled-out'] as const)
    assert.equal(triedPost(postOf('p-1', { kind })).kind, kind);
  for (const kind of ['plan', 'ask', 'answer', 'proposal', 'status'] as const)
    assert.throws(() => triedPost(postOf('p-1', { kind })), /Cite a result/);
  assert.throws(() => triedPost(undefined), /Cite a result/);
});

await test('a closed agent waits on no one, on every screen, and a reopen brings its wait back', () => {
  const ask = postOf('p-2', {
    kind: 'ask',
    author: 'a-2',
    mentions: ['a-1'],
    thread: 't-2',
  });
  const onClosed = postOf('p-3', {
    kind: 'ask',
    author: 'a-1',
    mentions: ['a-2'],
    thread: 't-2',
  });
  const posts = [ask, onClosed];
  const open = [directionOf('d-1'), directionOf('d-2')];
  const closed = [
    directionOf('d-1'),
    directionOf('d-2', { state: 'closed', verdict: 'ruled-out' }),
  ];
  assert.deepEqual(
    openWaits(posts, [], open).map((wait) => wait.post),
    ['p-2', 'p-3'],
  );
  // Agent 1 still waits on the closed agent, and the closed agent waits on no one.
  assert.deepEqual(
    openWaits(posts, [], closed).map((wait) => wait.post),
    ['p-3'],
  );
  const stopped = [
    directionOf('d-1'),
    directionOf('d-2', { state: 'stopped' }),
  ];
  assert.deepEqual(
    openWaits(posts, [], stopped).map((wait) => wait.post),
    ['p-3'],
  );
  const needs = collabOf({
    posts,
    threads: [],
    directions: closed,
    checks: [],
    calls: [],
    runs: [],
    leases: [],
  }).needs;
  assert.deepEqual(
    needs.map((need) => need.post),
    ['p-3'],
  );
  const view = viewWith({
    state: { directions: closed, calls: [], plan: null },
    posts,
    handles: { 'a-1': 'agent-1', 'a-2': 'agent-2' },
    threads: [{ id: 't-2', title: 'A subject', state: 'open' }],
  });
  assert.deepEqual(
    waitItems(view).map((wait) => wait.waiter),
    ['a-1'],
  );
});

await test('the reserved place holds at most 23 sessions in an hour, as the guide says', () => {
  assert.equal(
    briefLimits.updatesPerHour +
      briefLimits.storiesPerHour +
      briefLimits.checksPerHour +
      briefLimits.questionsPerHour +
      longShotLimits.perHour,
    23,
  );
});
