import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, type NewPost, type Post } from '../src/core/board.ts';
import { briefKinds, briefLimits, storyKinds } from '../src/core/lab-tools.ts';
import { briefTop, briefTopIds } from '../src/core/lab/brief.ts';
import { BriefStore, plainPaths } from '../src/core/lab/brief-store.ts';
import {
  coordinatorAgent,
  LabCoordinator,
  type LabCoordinatorHost,
} from '../src/core/lab/coordinator.ts';
import { parseLines } from '../src/core/lab/coordinator-rules.ts';
import { latestAnswer } from '../src/core/lab/latest-answer.ts';
import type {
  BriefLine,
  Call,
  LabSessions,
  LabView,
  Thread,
  ThreadStory,
} from '../src/core/lab/schema.ts';
import {
  laterPosts,
  storiesDue,
  storyJob,
} from '../src/core/lab/thread-story.ts';
import { ThreadStore } from '../src/core/lab/thread-store.ts';
import type { SessionRecord, SessionView } from '../src/core/session.ts';
import { briefItems, storyItem } from '../src/server/lab-brief.ts';
import {
  takingPart,
  threadActivity,
  threadItem,
} from '../src/server/lab-threads.ts';

const at = '2026-11-01T10:00:00.000Z';

function postOf(id: string, more: Partial<Post> = {}): Post {
  return {
    schemaVersion: 1,
    id,
    at,
    author: 'a-1',
    kind: 'result',
    thread: 't-2',
    text: 'It works.',
    mentions: [],
    artifacts: [],
    ...more,
  };
}

function threadOf(id: string, more: Partial<Thread> = {}): Thread {
  return {
    id,
    title: 'Does the control beat chance?',
    state: 'open',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
    followers: [],
    agreed: [],
    ...more,
  };
}

const outcome = (post: string): NonNullable<Thread['outcome']> => ({
  text: 'It holds.',
  post,
  by: 'a-1',
  at,
});

function storyOf(
  thread: string,
  posts: readonly string[],
  post: string | null,
  lines: readonly BriefLine[] = [],
): ThreadStory {
  return { thread, at, posts, outcome: post, lines };
}

await test('a thread gets a story at its outcome, and an open one when the person opens it', () => {
  const posts = [
    postOf('p-1'),
    postOf('p-2'),
    postOf('p-3', { thread: 't-3' }),
  ];
  const decided = threadOf('t-2', {
    state: 'decided',
    outcome: outcome('p-2'),
  });
  const open = threadOf('t-3');
  const empty = threadOf('t-4', { state: 'closed', outcome: outcome('p-9') });
  const due = (
    stories: readonly ThreadStory[],
    asked: readonly string[] = [],
  ): readonly string[] =>
    storiesDue([decided, open, empty], posts, stories, new Set(asked)).map(
      ({ id }) => id,
    );
  assert.deepEqual(due([]), ['t-2']);
  // What the person opened comes first.
  assert.deepEqual(due([], ['t-3']), ['t-3', 't-2']);
  assert.deepEqual(due([storyOf('t-2', ['p-1', 'p-2'], 'p-2')]), []);
  // A new decision needs a new story, and a close that keeps the outcome does not.
  assert.deepEqual(due([storyOf('t-2', ['p-1', 'p-2'], 'p-1')]), ['t-2']);
  // The person opened a thread with a post that its story did not read.
  assert.deepEqual(due([storyOf('t-3', ['p-1'], null)], ['t-3']), [
    't-3',
    't-2',
  ]);
  assert.deepEqual(due([storyOf('t-3', ['p-3'], null)], ['t-3']), ['t-2']);
  // A thread with no post has nothing to tell, even when the person asks.
  assert.deepEqual(due([], ['t-4']), ['t-2']);
});

await test('a story covers what its prompt held, so a post that moved in or came later is outside it, and the list has a bound', () => {
  const thread = threadOf('t-2');
  const many = Array.from({ length: briefLimits.storyPosts + 5 }, (_, index) =>
    postOf(`p-${index + 1}`),
  );
  const job = storyJob(thread, many);
  assert.equal(job.posts.length, briefLimits.storyPosts);
  assert.equal(job.posts.at(-1), `p-${many.length}`);
  assert.equal(job.outcome, null);
  // Posts older than the prompt's bound do not make a story due again and again.
  assert.deepEqual(
    storiesDue(
      [thread],
      many,
      [storyOf('t-2', job.posts, null)],
      new Set(['t-2']),
    ),
    [],
  );
  // A post with an older number that moved into the thread is not covered.
  assert.deepEqual(
    storiesDue(
      [thread],
      [postOf('p-1'), postOf('p-5')],
      [storyOf('t-2', ['p-5'], null)],
      new Set(['t-2']),
    ).map(({ id }) => id),
    ['t-2'],
  );
  // A thread that opened again needs a story that says so, when the person opens it.
  assert.deepEqual(
    storiesDue(
      [thread],
      [postOf('p-5')],
      [storyOf('t-2', ['p-5'], 'p-3')],
      new Set(['t-2']),
    ).map(({ id }) => id),
    ['t-2'],
  );
  assert.deepEqual(
    storiesDue(
      [thread],
      [postOf('p-5')],
      [storyOf('t-2', ['p-5'], 'p-3')],
      new Set(),
    ),
    [],
  );
});

await test('later facts are the posts after an outcome that reply to it or name it', () => {
  const later = '2026-11-01T11:00:00.000Z';
  const thread = { outcome: outcome('p-2') };
  const posts = [
    postOf('p-1', { kind: 'objection', replyTo: 'p-2' }),
    postOf('p-2'),
    postOf('p-3', { at: later, kind: 'objection', replyTo: 'p-2' }),
    postOf('p-4', {
      at: later,
      kind: 'result',
      text: 'It fails p-2 on seed 2.',
    }),
    postOf('p-5', { at: later, kind: 'result', text: 'See p-22 for this.' }),
    postOf('p-6', { at: later, kind: 'status', text: 'p-2 is old.' }),
    postOf('p-7', { at: later, kind: 'ask', replyTo: 'p-2' }),
  ];
  assert.deepEqual(
    laterPosts(thread, posts, 6).map(({ id }) => id),
    ['p-3', 'p-4'],
  );
  assert.deepEqual(
    laterPosts(thread, posts, 1).map(({ id }) => id),
    ['p-4'],
  );
  assert.deepEqual(laterPosts({}, posts, 6), []);
});

await test('plain lines refuse internal IDs, and each list keeps its kinds', () => {
  const post = (id: string): Post => postOf(id);
  const lines = (plain: string, kind = 'step'): unknown => [
    { kind, plain, posts: ['p-1'] },
  ];
  for (const plain of [
    'Agent 3 reads p-12.',
    'The test d-3 failed.',
    'It ran on lease-4.',
  ])
    assert.throws(
      () => parseLines(lines(plain), post, true, storyKinds, 12),
      /Leave out IDs such as p-12 or d-3/,
    );
  assert.equal(
    parseLines(
      lines('Agent 3 kept the top-5 set.'),
      post,
      true,
      storyKinds,
      12,
    )[0]?.kind,
    'step',
  );
  assert.throws(
    () => parseLines(lines('It ran.', 'step'), post, true, briefKinds, 5),
    /A line's kind is one of: decided, failed, held, open, new/,
  );
  assert.equal(
    parseLines(lines('', 'later'), post, false, storyKinds, 12)[0]?.plain,
    '',
  );
});

await test('the latest answer is the deadline minus the longest option, and a move of the deadline does not count', () => {
  const option = (
    minutes: number | null,
    effect: Call['options'][number]['effect'] = null,
  ): Call['options'][number] => ({ label: 'A', usd: null, minutes, effect });
  const deadline = '2026-11-01T21:17:00.000Z';
  assert.equal(
    latestAnswer(
      { options: [option(60), option(180), option(null)] },
      deadline,
    ),
    '2026-11-01T18:17:00.000Z',
  );
  assert.equal(latestAnswer({ options: [option(60)] }, null), null);
  assert.equal(latestAnswer({ options: [option(null)] }, deadline), null);
  assert.equal(latestAnswer({ options: [] }, deadline), null);
  assert.equal(
    latestAnswer(
      { options: [option(240, { type: 'hours', hours: 4 })] },
      deadline,
    ),
    null,
  );
});

await test('both top lines read the records once, also a call of no direction', () => {
  const direction = (
    id: string,
    verdict: 'open' | 'ruled-out' = 'open',
  ): { id: string; state: 'open'; verdict: 'open' | 'ruled-out' } => ({
    id,
    state: 'open',
    verdict,
  });
  const call = (id: string, on: string | null) => ({
    id,
    state: 'open' as const,
    by: on ? 'a-2' : 'verifold',
    direction: on,
    joined: [],
  });
  const records = {
    directions: [
      direction('d-3'),
      direction('d-2'),
      direction('d-1', 'ruled-out'),
      direction('d-4'),
    ],
    calls: [call('c-4', 'd-2')],
    runs: [{ direction: 'd-4', status: 'running' as const }],
  };
  assert.equal(
    briefTop(records),
    'One test failed, one is running, one needs your decision, and one has not run yet.',
  );
  assert.equal(
    briefTopIds(records),
    'd-1 failed. d-4 is running. d-2 waits on c-4. d-3 has not run yet.',
  );
  const loose = { ...records, calls: [...records.calls, call('c-7', null)] };
  assert.match(briefTop(loose), /The lab also has one decision for you\.$/);
  assert.match(briefTopIds(loose), /c-7 waits on you\.$/);
  assert.equal(
    briefTopIds({ directions: [], calls: [], runs: [] }),
    'No test has started yet.',
  );
  assert.equal(
    briefTopIds({ directions: [], calls: [call('c-7', null)], runs: [] }),
    'c-7 waits on you.',
  );
});

const passed: BriefLine['check'] = {
  state: 'passed',
  by: 'codex',
  sameHarness: false,
  problems: [],
};

function storedLine(more: Partial<BriefLine> = {}): BriefLine {
  return {
    id: 'l-5',
    kind: 'step',
    at,
    plain: 'Agent 1 tried it.',
    posts: ['p-1'],
    writer: 'claude',
    check: passed,
    ...more,
  };
}

await test('the store keeps stories, one for each thread, and a file with a bad entry still loads', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-story-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(root, 'brief.json');
  const store = new BriefStore(path, () => false);
  await store.load(true);
  store.setStory(
    storyOf('t-2', ['p-3'], 'p-3', [
      storedLine({ check: { ...passed, state: 'pending' } }),
    ]),
  );
  store.setStory(storyOf('t-3', ['p-4'], null));
  store.setStory(
    storyOf('t-2', ['p-3', 'p-5'], 'p-3', [
      storedLine({ check: { ...passed, state: 'pending' } }),
    ]),
  );
  assert.deepEqual(
    store.view().stories.map(({ thread, posts }) => [thread, posts]),
    [
      ['t-3', ['p-4']],
      ['t-2', ['p-3', 'p-5']],
    ],
  );
  assert.deepEqual(
    store.pending().map(({ id }) => id),
    ['l-5'],
  );
  store.settle(new Map([['l-5', passed]]));
  assert.equal(store.pending().length, 0);
  await store.flush();
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    stories: unknown[];
  };
  await writeFile(
    path,
    JSON.stringify({
      ...saved,
      stories: [
        ...saved.stories,
        { thread: 'nothing', at, posts: [], outcome: null, lines: [] },
        { thread: 't-9', at: 'soon', posts: [], outcome: null, lines: [] },
        { thread: 't-9', at, posts: [], outcome: 'nothing', lines: [] },
      ],
    }),
  );
  const again = new BriefStore(path, () => false);
  await again.load(true);
  assert.deepEqual(
    again.view().stories.map(({ thread }) => thread),
    ['t-3', 't-2'],
  );
  // The next line gets a number past the stories' lines.
  const next = again.line(
    { kind: 'open', plain: 'A line.', writer: 'claude' },
    [postOf('p-1')],
    [],
  );
  assert.equal(next.id, 'l-6');
  // A lab from before threads holds none.
  const old = new BriefStore(path, () => false);
  await old.load(false);
  assert.deepEqual(old.view().stories, []);
  // No harness of a lab agent can read this file.
  assert.ok(
    plainPaths([root]).includes(join(root, '.verifold', 'lab', 'brief.json')),
  );
});

interface Started {
  readonly id: string;
  readonly input: Parameters<LabSessions['startAgent']>[0];
}

/** A Coordinator on real stores, with a fake place: a start records its input, and no harness runs. */
async function rig(
  t: TestContext,
  more: { readonly keepsPlain?: boolean; readonly delayMs?: number } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-story-')));
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
  const started: Started[] = [];
  const live = new Set<string>();
  const sent: string[] = [];
  const sessions: NonNullable<LabCoordinatorHost['sessions']> = {
    get full(): boolean {
      return live.size >= 1;
    },
    view: (id) =>
      live.has(id) ? ({ live: true } as unknown as SessionView) : null,
    startAgent: (input) => {
      const id = `session-${started.length + 1}`;
      started.push({ id, input });
      live.add(id);
      return Promise.resolve(id);
    },
    continueTask: (_, text) => sent.push(text),
    endTask: (id) => {
      live.delete(id);
    },
  };
  const host: LabCoordinatorHost = {
    root,
    sessions,
    store,
    threads,
    timing: {
      hourMs: 3_600_000,
      minuteMs: 60_000,
      briefDelayMs: more.delayMs ?? 0,
    },
    question: () => 'Do months sit on a circle?',
    directions: () => [],
    summary: () => '- d-1 "A line of work": open.',
    board,
    checks: () => [],
    plan: () => null,
    ideas: () => [],
    markTried: () => Promise.resolve(''),
    freePlace: () => {},
    name: (author) => author,
    team: () => Promise.resolve(['claude', 'codex']),
    usedUp: () => false,
    model: () => Promise.resolve('best-model'),
    denied: () => Promise.resolve(['/denied']),
    keepsPlain: () => Promise.resolve(more.keepsPlain ?? true),
    add: (fields) => board.add(fields),
    read: () => Promise.resolve('the record'),
    notify: () => true,
    serial: (work) => Promise.resolve().then(work),
    progress: () => {},
  };
  const coordinator = new LabCoordinator(host);
  t.after(() => coordinator.stop());
  const post = async (fields: Partial<NewPost>): Promise<Post> => {
    const added = await board.add({
      author: 'a-1',
      kind: 'status',
      thread: 't-2',
      text: 'It works at 55%.',
      mentions: [],
      artifacts: [],
      ...fields,
    });
    await threads.posted(added, []);
    return added;
  };
  const { id: thread } = await threads.open({
    title: 'Does the control beat chance?',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
  });
  const newest = (): Started => {
    const session = started.at(-1);
    assert.ok(session);
    return session;
  };
  return {
    board,
    threads,
    store,
    started,
    sent,
    coordinator,
    thread,
    post,
    tick: () => coordinator.tick(),
    call: (name: string, input: Record<string, unknown>) =>
      newest().input.tools.call(name, input, 'call'),
    endTurn: async (status: SessionRecord['status'] = 'idle') => {
      coordinator.turnEnded({
        id: newest().id,
        agent: coordinatorAgent,
        status,
        costUsd: 0.25,
      } as SessionRecord);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

const step = (plain: string, posts: readonly string[], kind = 'step') => ({
  kind,
  plain,
  posts,
});

/** A rig whose first update ran, so no brief is due. */
async function quiet(t: TestContext): Promise<Awaited<ReturnType<typeof rig>>> {
  const lab = await rig(t);
  const first = await lab.post({ thread: 't-1', text: 'The plan is up.' });
  await lab.tick();
  assert.equal(lab.started.length, 1);
  await lab.call('verifold_brief', {
    lines: [step('The plan is up.', [first.id], 'new')],
  });
  await lab.endTurn();
  await lab.tick();
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'It is up.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await lab.endTurn();
  lab.started.length = 0;
  lab.sent.length = 0;
  return lab;
}

await test('the person opens a thread: one session tells it, with no brief, and no agent wakes', async (t) => {
  const lab = await quiet(t);
  const post = await lab.post({ text: 'Seed 0 gives 55% vs 15%.' });
  await lab.tick();
  assert.equal(lab.started.length, 0);
  lab.coordinator.wantStory(lab.thread);
  await lab.tick();
  assert.equal(lab.started.length, 1);
  const { prompt } = lab.started[0]?.input ?? {};
  assert.match(prompt ?? '', /Tell how each of these threads went/);
  assert.match(prompt ?? '', /Seed 0 gives 55% vs 15%/);
  assert.match(prompt ?? '', /Give no brief\./);
  // Its first turn owes the story.
  await lab.endTurn();
  assert.match(
    lab.sent[0] ?? '',
    new RegExp(`verifold_story now for: ${lab.thread}`),
  );
  assert.equal(
    (
      await lab.call('verifold_brief', {
        lines: [step('A line.', [post.id], 'open')],
      })
    ).ok,
    false,
  );
  const refused = await lab.call('verifold_story', {
    thread: 't-1',
    lines: [step('A line.', [post.id])],
  });
  assert.match(refused.text, /Name one of these threads/);
  // A post that comes while the session runs was not in its prompt.
  const mid = await lab.post({ text: 'A post in the middle of it.' });
  const kept = await lab.call('verifold_story', {
    thread: lab.thread,
    lines: [
      step('Agent 1 got 55% and 15%.', [post.id]),
      step('Agent 1 reports 90%.', [post.id], 'later'),
    ],
  });
  assert.equal(kept.ok, true);
  assert.match(kept.text, /No cited post holds these numbers: 90%/);
  const story = lab.store.view().stories[0];
  assert.equal(story?.thread, lab.thread);
  assert.deepEqual(story?.posts, [post.id]);
  assert.equal(story?.posts.includes(mid.id), false);
  assert.equal(story?.outcome, null);
  assert.deepEqual(
    story?.lines.map((line) => [line.kind, line.check.state]),
    [
      ['step', 'pending'],
      ['later', 'numbers'],
    ],
  );
  await lab.endTurn();
  // The line goes to a second session of the other harness.
  await lab.tick();
  assert.equal(lab.started[1]?.input.host, 'codex');
  assert.match(lab.started[1]?.input.prompt ?? '', /Agent 1 got 55% and 15%/);
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'It gave 55%.', verdict: 'added-fact' }],
      dropped: [],
    })),
  });
  assert.equal(lab.store.view().stories[0]?.lines[0]?.check.state, 'failed');
});

await test('a story waits while a brief can come, also when the person asks, and a brief session tells nothing', async (t) => {
  const lab = await rig(t, { delayMs: 3_600_000 });
  await lab.post({ text: 'It works at 55%.' });
  lab.coordinator.wantStory(lab.thread);
  await lab.tick();
  // A change of state waits for its update, so no story takes the place.
  assert.equal(lab.started.length, 0);
  const now = await rig(t);
  const post = await now.post({ text: 'Seed 0 gives 55%.' });
  await now.threads.close(now.thread, post);
  now.coordinator.wantStory(now.thread);
  await now.tick();
  assert.equal(now.started.length, 1);
  const { prompt } = now.started[0]?.input ?? {};
  assert.match(prompt ?? '', /verifold_brief once/);
  assert.doesNotMatch(prompt ?? '', /Tell how each/);
  assert.equal(
    (
      await now.call('verifold_story', {
        thread: now.thread,
        lines: [step('It gave 55%.', [post.id])],
      })
    ).ok,
    false,
  );
  // The check of a brief goes first, then the story.
  await now.call('verifold_brief', {
    lines: [step('The first run is in.', [post.id], 'held')],
  });
  await now.endTurn();
  await now.tick();
  await now.call('verifold_line_check', {
    lines: now.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'It is in.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await now.endTurn();
  await now.tick();
  assert.equal(now.started.length, 3);
  assert.match(now.started[2]?.input.prompt ?? '', /Tell how each/);
  assert.match(now.started[2]?.input.prompt ?? '', /Give no brief\./);
  assert.equal(now.store.count('story', 0), 1);
  assert.equal(now.store.count('update', 0), 1);
});

await test('a decision gets its story, the story records its outcome, and no prompt holds an earlier story', async (t) => {
  const lab = await rig(t);
  const post = await lab.post({ text: 'Seed 0 gives 55%.' });
  await lab.threads.close(lab.thread, post);
  await lab.tick();
  await lab.call('verifold_brief', {
    lines: [step('The first run is in.', [post.id], 'held')],
  });
  await lab.endTurn();
  await lab.tick();
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'It is in.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await lab.endTurn();
  await lab.tick();
  const plain = 'The first run gave 55%, in the story words.';
  await lab.call('verifold_story', {
    thread: lab.thread,
    lines: [step(plain, [post.id], 'outcome')],
  });
  assert.equal(lab.store.view().stories[0]?.outcome, post.id);
  await lab.endTurn();
  await lab.tick();
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'It gave 55%.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await lab.endTurn();
  // The story covers its outcome, so a tick starts nothing.
  const count = lab.started.length;
  await lab.tick();
  assert.equal(lab.started.length, count);
  const { id: next } = await lab.threads.open({
    title: 'Does the second control beat chance?',
    why: 'It decides the step after.',
    openedBy: 'a-1',
    at,
  });
  const second = await lab.post({ thread: next, text: 'Seed 1 gives 60%.' });
  await lab.threads.close(next, second);
  await lab.tick();
  const later = lab.started.at(-1)?.input.prompt ?? '';
  assert.match(later, /Seed 1 gives 60%|verifold_brief once/);
  assert.doesNotMatch(later, /in the story words/);
});

await test('stories have an hourly budget of their own, a session tells a bounded number, and asked threads lead', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const lab = await quiet(t);
  const ids = [lab.thread];
  for (const title of ['one', 'two', 'three'])
    ids.push(
      (
        await lab.threads.open({
          title: `Does the ${title} control hold?`,
          why: 'It decides.',
          openedBy: 'a-1',
          at,
        })
      ).id,
    );
  // New threads are a change of state, so their update comes first.
  await lab.tick();
  await lab.call('verifold_brief', {
    lines: [step('A line.', [(await lab.post({})).id], 'new')],
  });
  await lab.endTurn();
  await lab.tick();
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'A line.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await lab.endTurn();
  lab.started.length = 0;
  for (const id of ids) await lab.post({ thread: id });
  for (const id of [...ids].reverse()) lab.coordinator.wantStory(id);
  await lab.tick();
  assert.equal(lab.started.length, 1);
  const prompt = lab.started[0]?.input.prompt ?? '';
  const told = ids.filter((id) => prompt.includes(`${id} "`));
  assert.equal(told.length, briefLimits.storiesPerSession);
  // Sessions that give nothing use up the hour's stories, and the next one waits for it.
  let count = lab.started.length;
  for (let index = 1; index < briefLimits.storiesPerHour; index++) {
    await lab.endTurn('ended');
    t.mock.timers.tick(1);
    await lab.tick();
    count += 1;
    assert.equal(lab.started.length, count);
  }
  await lab.endTurn('ended');
  t.mock.timers.tick(1);
  await lab.tick();
  assert.equal(lab.started.length, count);
  // The stories used none of the updates.
  assert.equal(lab.store.count('story', 0), briefLimits.storiesPerHour);
  assert.equal(lab.store.count('update', 0), 2);
  t.mock.timers.tick(3_600_001);
  await lab.tick();
  assert.equal(lab.started.length, count + 1);
});

await test('with the hour’s updates gone, stories still run: no brief can come', async (t) => {
  const lab = await rig(t, { delayMs: 3_600_000 });
  const post = await lab.post({});
  for (let index = 0; index < briefLimits.updatesPerHour; index++)
    lab.store.mark('update');
  lab.coordinator.wantStory(lab.thread);
  await lab.tick();
  assert.equal(lab.started.length, 1);
  assert.match(lab.started[0]?.input.prompt ?? '', /Give no brief\./);
  assert.ok(post.id);
});

await test('the check of a story’s lines waits for a brief that is due', async (t) => {
  const lab = await quiet(t);
  const post = await lab.post({});
  lab.store.setStory(
    storyOf(lab.thread, [post.id], null, [
      storedLine({ check: { ...passed, state: 'pending' } }),
    ]),
  );
  lab.coordinator.personBack(at);
  await lab.tick();
  assert.equal(lab.started.length, 1);
  assert.match(lab.started[0]?.input.prompt ?? '', /verifold_brief once/);
});

await test('a filed thread’s why holds no ID', async (t) => {
  const lab = await rig(t);
  const person = await lab.post({
    thread: 't-1',
    author: 'person',
    text: 'Can we look at this from another side?',
  });
  await lab.tick();
  const filed = await lab.call('verifold_thread', {
    action: 'file',
    post: person.id,
  });
  assert.equal(filed.ok, true, filed.text);
  const thread = lab.threads.list().at(-1);
  assert.equal(thread?.why, "Filed from one of the person's posts.");
});

await test('a lab that keeps no plain words writes no story', async (t) => {
  const lab = await rig(t, { keepsPlain: false, delayMs: 3_600_000 });
  await lab.post({});
  lab.coordinator.wantStory(lab.thread);
  await lab.tick();
  assert.equal(lab.started.length, 0);
});

await test('wantStory needs a thread and a working lab', async (t) => {
  const lab = await rig(t);
  assert.throws(() => lab.coordinator.wantStory('t-99'), /Name a thread/);
});

await test('on the wire a story shows plain words only once they passed, what it covers, and who wrote the post', () => {
  const posts = [
    postOf('p-1', { harness: 'codex', text: 'Seed 0 gives 55% (see p-9).' }),
  ];
  const view = {
    posts,
    checks: [],
    handles: { 'a-1': 'agent-1' },
    state: { directions: [], calls: [] },
    ledger: [],
    brief: {
      brief: null,
      notices: [],
      questions: [],
      sessions: [],
      stories: [
        storyOf('t-2', ['p-1'], 'p-1', [
          storedLine(),
          storedLine({ check: { ...passed, state: 'failed' } }),
          storedLine({ check: { ...passed, state: 'pending' } }),
          storedLine({ plain: 'It gave 90%.' }),
        ]),
      ],
    },
  } as unknown as LabView;
  const story = storyItem(view, 't-2');
  assert.deepEqual(story?.posts, ['p-1']);
  assert.equal(story?.outcome, 'p-1');
  assert.deepEqual(
    story?.lines.map((line) => [line.plain, line.check.state]),
    [
      ['Agent 1 tried it.', 'passed'],
      [null, 'failed'],
      [null, 'pending'],
      // The number test runs again on the way out.
      [null, 'numbers'],
    ],
  );
  assert.deepEqual(
    [
      story?.lines[0]?.author,
      story?.lines[0]?.handle,
      story?.lines[0]?.harness,
    ],
    ['a-1', 'agent-1', 'codex'],
  );
  // The quote and its source stay apart, and an agent's own ID stays in its words.
  assert.deepEqual(story?.lines[0]?.quotes, [
    { post: 'p-1', text: 'Seed 0 gives 55% (see p-9).' },
  ]);
  assert.equal(story?.lines[0]?.thread, 't-2');
  assert.equal(storyItem(view, 't-3'), null);
  const items = briefItems(view, (list) => [...list]);
  assert.equal(items.brief?.topIds, 'No test has started yet.');
});

await test('who took part comes from every post of the thread', () => {
  assert.deepEqual(
    takingPart(
      [
        postOf('p-1', { author: 'person' }),
        postOf('p-2', { author: 'a-10' }),
        postOf('p-3', { author: 'a-2' }),
        postOf('p-4', { author: 'a-2' }),
        postOf('p-5', { author: 'verifold' }),
      ],
      { 'a-2': 'agent-2', 'a-10': 'agent-10' },
    ),
    { handles: ['agent-2', 'agent-10'], byPerson: true },
  );
  assert.deepEqual(takingPart([], {}), { handles: [], byPerson: false });
});

await test('a call is written for the person, and Simple shows it as written', async () => {
  const { askPersonToolSpec } = await import('../src/core/lab-tools.ts');
  assert.match(
    askPersonToolSpec.description,
    /for the person, in plain words, with no internal IDs/,
  );
  const prompt = await readFile('src/core/prompts/lab-peer.md', 'utf8');
  assert.match(prompt, /Write each call for the person, in plain words/);
});

await test('a thread on the wire counts its posts', () => {
  const noThread = { ...postOf('p-4'), thread: undefined } as unknown as Post;
  const activity = threadActivity([
    postOf('p-1'),
    postOf('p-2', { at: '2026-11-01T11:00:00.000Z' }),
    postOf('p-3', { thread: 't-3' }),
    noThread,
  ]);
  const item = threadItem(threadOf('t-2'), activity);
  assert.equal(item.posts, 2);
  assert.equal(item.lastAt, '2026-11-01T11:00:00.000Z');
  assert.equal(threadItem(threadOf('t-9'), activity).posts, 0);
  assert.equal(threadItem(threadOf('t-9'), activity).lastAt, null);
});
