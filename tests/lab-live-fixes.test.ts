import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
import {
  closeRefusal,
  openPosts,
  parseChecks,
  triedPost,
} from '../src/core/lab/coordinator-rules.ts';
import { parseIdea, type Idea } from '../src/core/lab/ideas.ts';
import { LiteratureStore } from '../src/core/lab/literature-store.ts';
import { heldUp } from '../src/core/lab/post-rules.ts';
import { recordFacts, strayInRecord } from '../src/core/lab/record-facts.ts';
import type {
  BriefLine,
  Check,
  Direction,
  LabSessions,
  LabView,
  PlanOfRecord,
  Thread,
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
  readonly path: string;
  readonly board: Board;
  readonly store: BriefStore;
  readonly started: { readonly prompt: string; readonly tools: Tools }[];
  readonly directions: ReturnType<typeof directionOf>[];
  readonly ideas: Idea[];
  readonly marked: string[];
  readonly coordinator: LabCoordinator;
  /** How often a session asked a long shot to give the place. */
  readonly freed: { count: number };
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
  const freed = { count: 0 };
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
    freePlace: () => {
      freed.count += 1;
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
    path: join(root, 'brief.json'),
    board,
    store,
    started,
    directions,
    ideas,
    marked,
    coordinator,
    freed,
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
    new RegExp(`Ask ${asks.id} of a-2: no answer ended it yet`),
  );
  assert.match(check, /a-1 on d-1: open, no verdict yet\. Its posts: 1 plan/);
  // A whole list can say that what it leaves out does not exist.
  assert.match(check, /A cited post with no wait and no check below has none/);
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

const factsOf = (
  more: Partial<Parameters<typeof recordFacts>[1]>,
): Parameters<typeof recordFacts>[1] => ({
  posts: [],
  directions: [],
  threads: [],
  waits: [],
  checks: [],
  name: (author) => author.replace('a-', 'Agent '),
  ...more,
});

await test('the record facts put the cited posts first, open or closed, then the lab', () => {
  const posts = [
    postOf('p-1', { kind: 'plan' }),
    postOf('p-2'),
    postOf('p-3'),
    postOf('p-4', { author: 'a-2', kind: 'status' }),
    postOf('p-5', { thread: 't-9' }),
    postOf('p-6', { kind: 'ask', author: 'a-2', replyTo: 'p-2' }),
    postOf('p-7', { kind: 'ask', author: 'a-2', replyTo: 'p-2' }),
    postOf('p-8', { kind: 'objection', author: 'a-2', replyTo: 'p-2' }),
    postOf('p-9', { kind: 'objection', author: 'a-2', replyTo: 'p-3' }),
    postOf('p-10', {
      kind: 'check',
      author: 'a-2',
      replyTo: 'p-3',
      method: 'rerun',
      outcome: 'holds',
    }),
    postOf('p-11', { kind: 'objection', replyTo: 'p-5' }),
  ];
  const { lines, cut } = recordFacts(
    [posts[1], posts[2]].flatMap((post) => post ?? []),
    factsOf({
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
          waiter: 'a-2',
          on: 'a-1',
          post: 'p-6',
          reason: 'ask',
          thread: 't-2',
          since: at,
        },
      ],
      checks: [
        checkOf({
          claim: 'p-2',
          state: 'running',
          outcome: null,
          method: null,
        }),
        checkOf({ claim: 'p-3', outcome: 'fails', blind: false }),
        checkOf({ claim: 'p-3', state: 'dropped' }),
        checkOf({ claim: 'p-5' }),
      ],
    }),
  );
  assert.deepEqual(lines, [
    '- Ask p-6 of Agent 2 on p-2: no answer ended it yet.',
    '- Ask p-7 of Agent 2 on p-2: it ended.',
    // A closed agent's objection still stands.
    '- Objection p-8 of Agent 2 on p-2: it stands.',
    '- Objection p-9 of Agent 2 on p-3: it stands.',
    "- An agent's own check post p-10 of Agent 2 on p-3: rerun, not blind, holds.",
    "- Verifold's check of p-2: no method yet, blind, waits or runs.",
    "- Verifold's check of p-3: rerun, not blind, ended: fails.",
    '- t-2: open.',
    '- The lab has 2 directions: 1 open, 1 ended.',
    '- Agent 1 on d-1: open, leading. Its posts: 1 plan, 3 result, 1 objection.',
    '- Agent 2 on d-2: closed by its agent, ruled out. Its posts: 2 ask, 2 objection, 1 check.',
  ]);
  assert.equal(cut, false);
});

await test('a cut list says so, so that absence never reads as proof', async (t) => {
  const many = Array.from({ length: briefLimits.recordFacts + 5 }, (_, index) =>
    directionOf(`d-${index + 1}`),
  );
  const facts = recordFacts([postOf('p-1')], factsOf({ directions: many }));
  assert.equal(facts.lines.length, briefLimits.recordFacts);
  assert.equal(facts.cut, true);
  // The cited posts come first, so a cut takes the lab's lines.
  const cited = [postOf('p-1')];
  const posts = [
    ...cited,
    postOf('p-2', { kind: 'objection', author: 'a-2', replyTo: 'p-1' }),
  ];
  assert.match(
    recordFacts(cited, factsOf({ posts, directions: many })).lines[0] ?? '',
    /Objection p-2/,
  );
  const lab = await rig(t);
  const post = await lab.post({});
  lab.directions.push(...many);
  await lab.coordinator.tick();
  await lab.call('verifold_brief', {
    lines: [{ kind: 'new', plain: 'It works.', posts: [post.id] }],
  });
  await lab.end();
  await lab.coordinator.tick();
  const check = lab.started.at(-1)?.prompt ?? '';
  assert.match(check, /verifold_line_check/);
  assert.doesNotMatch(check, /has none/);
});

await test('a true count of the record passes the number test, and a stray number still fails', () => {
  const posts = [postOf('p-1', { text: 'It reached 64.5%.' })];
  const records = (): Parameters<typeof recordFacts>[1] =>
    factsOf({
      posts,
      directions: [directionOf('d-1'), directionOf('d-2')],
    });
  assert.deepEqual(strayNumbers('2 of the 2 lines have no verdict.', posts), [
    '2',
    '2',
  ]);
  assert.deepEqual(
    strayInRecord('2 of the 2 lines have no verdict.', posts, records),
    [],
  );
  assert.deepEqual(strayInRecord('It reached 91.5%.', posts, records), [
    '91.5%',
  ]);
  // The records are read only for a number that the posts do not hold.
  assert.deepEqual(
    strayInRecord('It reached 64.5%.', posts, () => assert.fail('read')),
    [],
  );
});

await test('the check prompt keeps results strict, and lets a definition and the record pass', async () => {
  const prompt = await loadPrompt('lab-line-check');
  // What stays strict.
  for (const rule of [
    /`added-fact`: .*a cause, a reason, a comparison, or a result/,
    /`raised-certainty`/,
    /`number-out-of-scope`/,
    /It cannot add a result, a cause, or certainty/,
    /When you are in doubt, do not write `supported`\./,
  ])
    assert.match(prompt, rule);
  // What no longer fails a true line.
  assert.match(prompt, /Only two exceptions exist/);
  assert.match(prompt, /A plain definition/);
  assert.match(prompt, /judge it against the record's facts/);
  assert.match(prompt, /would conclude something else/);
  assert.match(prompt, /A plain line can leave out detail/);
  // A caveat on the evidence is never detail.
  assert.match(prompt, /"one AI rater", "not a rerun", or "same harness"/);
  assert.doesNotMatch(prompt, /how a method works/);
  assert.match(
    prompt,
    /In a claim about a result, it is `number-out-of-scope`/,
  );
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

await test('"Held up" needs a blind rerun of Verifold that held, and no check that failed', () => {
  const one = [postOf('p-1')];
  const two = [postOf('p-1'), postOf('p-2')];
  const later = '2026-11-01T12:05:00.000Z';
  assert.equal(shownKind('held', one, []), 'result');
  assert.equal(shownKind('held', one, [checkOf()]), 'held');
  // A check that did not end, a code read, a failed rerun, or a rerun that was not blind holds nothing up.
  for (const more of [
    { state: 'running' },
    { method: 'code-read' },
    { outcome: 'fails' },
    { blind: false },
  ] as const)
    assert.equal(shownKind('held', one, [checkOf(more)]), 'result');
  // A failed check of any form takes it back, before or after the rerun.
  for (const form of ['rerun', 'code-read'] as const)
    assert.equal(
      shownKind('held', one, [
        checkOf(),
        checkOf({ endedAt: later, outcome: 'fails', method: form }),
      ]),
      'result',
    );
  assert.equal(
    shownKind('held', one, [
      checkOf({ outcome: 'differs', endedAt: '2026-11-01T11:00:00.000Z' }),
      checkOf(),
    ]),
    'result',
  );
  // Each result needs its own.
  assert.equal(shownKind('held', two, [checkOf()]), 'result');
  assert.equal(
    shownKind('held', two, [checkOf(), checkOf({ claim: 'p-2' })]),
    'held',
  );
  // No line of another kind changes.
  for (const kind of ['decided', 'failed', 'open', 'new', 'answer'] as const)
    assert.equal(shownKind(kind, one, []), kind);
});

await test("an agent's own check post never holds a post up, whatever its method", () => {
  const one = postOf('p-1');
  const reran = postOf('p-2', {
    kind: 'check',
    author: 'a-2',
    replyTo: 'p-1',
    method: 'rerun',
    outcome: 'holds',
  });
  assert.equal(
    shownKind('held', evidencePosts([one], [one, reran]), []),
    'result',
  );
  assert.equal(heldUp(one, [one, reran], []), false);
});

await test('a check that failed keeps a post from holding up, even when a later rerun held, as a verdict refuses', () => {
  const claim = postOf('p-1');
  const held = checkOf({ endedAt: '2026-11-01T12:10:00.000Z' });
  const failed = checkOf({
    outcome: 'fails',
    endedAt: '2026-11-01T12:00:00.000Z',
  });
  assert.equal(heldUp(claim, [claim], [held]), true);
  assert.equal(heldUp(claim, [claim], [failed, held]), false);
  assert.equal(shownKind('held', [claim], [failed, held]), 'result');
});

await test('a held rerun stops holding after a refutation, an accepted objection, or a dispute', () => {
  const claim = postOf('p-1');
  const rerun = postOf('p-2', { kind: 'rerun', replyTo: 'p-1', author: 'a-5' });
  const check = checkOf({ result: 'p-2' });
  const later = '2026-11-01T12:05:00.000Z';
  const held = (...more: readonly Post[]): boolean =>
    heldUp(claim, [claim, rerun, ...more], [check]);
  assert.equal(held(), true);
  // A check post that fails the rerun refutes it.
  assert.equal(
    held(
      postOf('p-3', {
        kind: 'check',
        author: 'a-3',
        replyTo: 'p-2',
        outcome: 'fails',
      }),
    ),
    false,
  );
  // An objection stands, against the claim or against its rerun.
  const doubt = (target: string): Post =>
    postOf('p-3', {
      kind: 'objection',
      author: 'a-3',
      replyTo: target,
      at: later,
    });
  assert.equal(held(doubt('p-1')), false);
  assert.equal(held(doubt('p-2')), false);
  // An objection that the author accepts after the rerun ends the dispute and the rerun's standing.
  const accepted = postOf('p-4', {
    kind: 'answer',
    accepts: true,
    replyTo: 'p-3',
    at: later,
  });
  assert.equal(held(doubt('p-1'), accepted), false);
  // An objection accepted before the rerun changes nothing.
  assert.equal(
    held(
      { ...doubt('p-1'), at: '2026-11-01T11:00:00.000Z' },
      { ...accepted, at: '2026-11-01T11:01:00.000Z' },
    ),
    true,
  );
  // A later check of the claim by an agent that fails it takes it back.
  assert.equal(
    held(
      postOf('p-5', {
        kind: 'check',
        author: 'a-3',
        replyTo: 'p-1',
        outcome: 'fails',
        at: later,
      }),
    ),
    false,
  );
});

await test('an answer goes out as written at each state of its check, with what the check found', () => {
  const posts = [postOf('p-1', { text: 'It reached 64.5%.' })];
  const asked = (answer: BriefLine): LabView =>
    viewWith({
      posts,
      handles: {},
      brief: {
        brief: null,
        notices: [],
        questions: [{ id: 'q-1', at, text: 'Why?', state: 'answered', answer }],
        stories: [],
        sessions: [],
      },
    });
  const shown = (answer: BriefLine) =>
    briefItems(asked(answer), (list) => [...list]).questions[0]?.answer;
  const plain = 'It reached 64.5% on one seed.';
  const check = (
    state: BriefLine['check']['state'],
    problems: BriefLine['check']['problems'] = [],
  ): BriefLine['check'] => ({ state, by: null, sameHarness: false, problems });
  const answerOf = (more: Partial<BriefLine>): BriefLine =>
    lineOf('l-1', plain, { kind: 'answer', ...more });
  const pending = shown(answerOf({ check: check('pending') }));
  assert.equal(pending?.plain, plain);
  assert.equal(pending?.check.failure, undefined);
  const failed = shown(
    answerOf({
      check: check('failed', [
        { kind: 'added-fact', claim: 'The rerun held.' },
        { kind: 'dropped-caveat', claim: 'One seed only.' },
      ]),
    }),
  );
  assert.equal(failed?.plain, plain);
  assert.deepEqual(failed?.check.failure, {
    first: { kind: 'added-fact', claim: 'The rerun held.' },
    count: 2,
  });
  const numbers = shown(
    answerOf({
      plain: 'It reached 91.5%.',
      check: check('numbers', [{ kind: 'stray-number', claim: '91.5%' }]),
    }),
  );
  assert.equal(numbers?.plain, 'It reached 91.5%.');
  assert.equal(numbers?.check.failure?.first?.claim, '91.5%');
  // A file that says passed still shows what no post holds.
  const edited = shown(
    answerOf({ plain: 'It reached 91.5%.', check: check('passed') }),
  );
  assert.equal(edited?.check.state, 'numbers');
  assert.equal(edited?.check.failure?.first?.claim, '91.5%');
  const long = shown(
    answerOf({
      check: check('failed', [
        { kind: 'added-fact', claim: 'long '.repeat(100) },
      ]),
    }),
  );
  assert.ok((long?.check.failure?.first?.claim.length ?? 0) <= 160);
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
            lineOf('l-2', plain, {
              check: check('failed', [{ kind: 'added-fact', claim: 'X' }]),
            }),
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
  assert.equal(brief?.lines[0]?.check.failure, undefined);
});

await test('a check stores what it found by kind, and a record of an earlier version keeps its state', async (t) => {
  assert.deepEqual(
    parseChecks(
      [
        {
          id: 'l-1',
          claims: [{ claim: 'It held.', verdict: 'raised-certainty' }],
          dropped: ['One seed only.'],
        },
      ],
      ['l-1'],
    ).get('l-1')?.problems,
    [
      { kind: 'raised-certainty', claim: 'It held.' },
      { kind: 'dropped-caveat', claim: 'One seed only.' },
    ],
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-line-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(root, 'brief.json');
  await writeFile(
    path,
    JSON.stringify({
      brief: {
        at,
        key: 'k',
        through: 1,
        lines: [
          lineOf('l-1', 'A line.', {
            check: {
              state: 'failed',
              by: 'codex',
              sameHarness: false,
              problems: [
                'added-fact: an earlier form' as unknown as BriefLine['check']['problems'][number],
                { kind: 'dropped-caveat', claim: 'A caveat.' },
                {
                  kind: 'unknown',
                  claim: 'No.',
                } as unknown as BriefLine['check']['problems'][number],
              ],
            },
          }),
        ],
      },
    }),
  );
  const store = new BriefStore(path, () => false);
  await store.load(true);
  const [line] = store.view().brief?.lines ?? [];
  assert.equal(line?.check.state, 'failed');
  assert.deepEqual(line?.check.problems, [
    { kind: 'dropped-caveat', claim: 'A caveat.' },
  ]);
});

await test('no update starts until the board has a post, and the first post lets it run', async (t) => {
  const lab = await rig(t);
  await lab.coordinator.tick();
  assert.equal(lab.started.length, 0);
  await lab.post({});
  await lab.coordinator.tick();
  assert.equal(lab.started.length, 1);
});

await test('a question before the first post gets its answer at once, from what exists', async (t) => {
  const lab = await rig(t);
  const question = lab.coordinator.ask('What is new?');
  await lab.coordinator.tick();
  assert.equal(lab.started.length, 1);
  assert.match(lab.started[0]?.prompt ?? '', /The board has no post yet/);
  const answer = await lab.call('verifold_answer', {
    question: question.id,
    plain: 'The lab has no post yet.',
    posts: [],
  });
  assert.equal(answer.ok, true, answer.text);
  const stored = lab.store.view().questions[0]?.answer;
  assert.deepEqual(stored?.posts, []);
  assert.equal(stored?.check.state, 'pending');
  await lab.end();
  // Its line check runs with the record's facts alone.
  await lab.coordinator.tick();
  const prompt = lab.started.at(-1)?.prompt ?? '';
  assert.match(prompt, /verifold_line_check/);
  await lab.call('verifold_line_check', {
    lines: [
      {
        id: /l-\d+/.exec(prompt)?.[0],
        claims: [{ claim: 'The lab has no post.', verdict: 'supported' }],
        dropped: [],
      },
    ],
  });
  await lab.end();
  // The record keeps an answer with no post.
  await lab.store.flush();
  const again = new BriefStore(lab.path, () => false);
  await again.load(true);
  assert.deepEqual(again.view().questions[0]?.answer?.posts, []);
  // With a post on the board, an answer cites it.
  await lab.post({});
  const next = lab.coordinator.ask('And now?');
  await lab.coordinator.tick();
  const refused = await lab.call('verifold_answer', {
    question: next.id,
    plain: 'It works.',
    posts: [],
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Cite 1 to 6 posts/);
});

await test('the Coordinator asks for the place for a question, an update, or a line check, and not for a story', async (t) => {
  const lab = await rig(t);
  await lab.post({});
  assert.equal(await lab.coordinator.idle(), true);
  lab.coordinator.ask('What is new?');
  assert.equal(await lab.coordinator.idle(), false);
  await lab.coordinator.tick();
  assert.equal(lab.freed.count, 1);
  assert.equal(await lab.coordinator.idle(), false);
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

await test('a closed agent leaves Working together, the record keeps its wait, and a reopen brings it back', () => {
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
  const needs = (directions: typeof open): readonly string[] =>
    collabOf({
      posts,
      threads: [],
      directions,
      checks: [],
      calls: [],
      runs: [],
      leases: [],
    }).needs.map((need) => need.post);
  assert.deepEqual(needs(open), ['p-2', 'p-3']);
  // Agent 1 still waits on the agent that ended, and that agent waits on no one.
  for (const state of ['closed', 'stopped'] as const)
    assert.deepEqual(
      needs([directionOf('d-1'), directionOf('d-2', { state })]),
      ['p-3'],
    );
  // The record keeps the wait, so a move or a close still sees the open ask.
  assert.deepEqual(
    openWaits(posts, []).map((wait) => wait.post),
    ['p-2', 'p-3'],
  );
  assert.equal(openPosts(posts, [], openWaits(posts, [])).has('p-2'), true);
  assert.match(
    closeRefusal(
      { id: 't-2', state: 'open' } as Thread,
      posts,
      [],
      [],
      openWaits(posts, []),
    ) ?? '',
    /p-2 waits for an answer/,
  );
  // A reopen: the direction is open again, and the wait is back.
  assert.deepEqual(needs(open), ['p-2', 'p-3']);
  const view = viewWith({
    state: { directions: open, calls: [], plan: null },
    posts,
    handles: { 'a-1': 'agent-1', 'a-2': 'agent-2' },
    threads: [{ id: 't-2', title: 'A subject', state: 'open' }],
  });
  assert.deepEqual(
    waitItems(view).map((wait) => wait.waiter),
    ['a-2', 'a-1'],
  );
});

await test('the reserved place holds at most 26 sessions in an hour, as the guide says', () => {
  assert.equal(
    briefLimits.updatesPerHour +
      briefLimits.storiesPerHour +
      briefLimits.checksPerHour +
      briefLimits.questionsPerHour +
      longShotLimits.sessionsPerHour,
    26,
  );
});
