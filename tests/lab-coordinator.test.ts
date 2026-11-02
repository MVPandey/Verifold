import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { Board, type NewPost, type Post } from '../src/core/board.ts';
import { archiveRun } from '../src/core/archive.ts';
import { Lab, startLabOn } from '../src/core/lab.ts';
import {
  briefLimits,
  labCoordinatorToolSpecs,
  lineCheckToolSpecs,
} from '../src/core/lab-tools.ts';
import { BriefStore } from '../src/core/lab/brief-store.ts';
import {
  coordinatorAgent,
  LabCoordinator,
  type LabCoordinatorHost,
} from '../src/core/lab/coordinator.ts';
import {
  checkedTitle,
  closeRefusal,
  filedTitle,
  moveRefusal,
  noticeFrom,
  openPosts,
  parseChecks,
  retitleRefusal,
} from '../src/core/lab/coordinator-rules.ts';
import type {
  BriefLine,
  Direction,
  LabSessions,
  LabView,
  LineState,
  Thread,
} from '../src/core/lab/schema.ts';
import { SlotSession } from '../src/core/lab/slot-session.ts';
import { ThreadStore } from '../src/core/lab/thread-store.ts';
import { planThread } from '../src/core/lab/threads.ts';
import type { Wait } from '../src/core/lab/waits.ts';
import type { AgentTools } from '../src/core/session-hosts.ts';
import { processStart } from '../src/core/owner.ts';
import {
  loadPaused,
  reconcileSessions,
  type SessionRecord,
  type SessionView,
} from '../src/core/session.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import { PoolFullError, SessionPool } from '../src/core/workers.ts';
import { gitEnvironment } from '../src/core/workspaces.ts';
import type { Lab as WireLab } from '../src/protocol/api.ts';
import { ApiReader } from '../src/server/api.ts';
import { briefItems } from '../src/server/lab-brief.ts';
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

const waitOf = (post: string, on: string, thread = 't-2'): Wait => ({
  waiter: 'a-2',
  on,
  post,
  reason: 'ask',
  thread,
  since: at,
});

await test('a close settles nothing: an objection, a wait, a proposal, or a long shot keeps a thread open', () => {
  const thread = threadOf('t-2');
  const threads = [threadOf(planThread), thread];
  const close = (posts: readonly Post[], waits: readonly Wait[] = []) =>
    closeRefusal(thread, posts, threads, [], waits);
  assert.equal(close([postOf('p-1')]), null);
  assert.match(
    close([
      postOf('p-1'),
      postOf('p-2', { kind: 'objection', replyTo: 'p-1', author: 'a-2' }),
    ]) ?? '',
    /p-1 has an open objection, and you settle no dispute/,
  );
  assert.match(
    close([postOf('p-1', { kind: 'ask' })], [waitOf('p-1', 'a-3')]) ?? '',
    /p-1 waits for an answer/,
  );
  assert.match(
    close([postOf('p-1', { kind: 'proposal' })]) ?? '',
    /p-1 is an open proposal/,
  );
  assert.match(
    close([postOf('p-1', { kind: 'proposal', alien: true })]) ?? '',
    /p-1 is an open proposal/,
  );
  assert.match(
    closeRefusal(threadOf(planThread), [], threads, [], []) ?? '',
    /plan thread stays open/,
  );
  // An objection that a check ended holds nothing open.
  assert.equal(
    closeRefusal(
      thread,
      [
        postOf('p-1'),
        postOf('p-2', { kind: 'objection', replyTo: 'p-1', author: 'a-2' }),
      ],
      threads,
      [{ state: 'done', objections: ['p-2'] }],
      [],
    ),
    null,
  );
});

await test('a move cannot change a decision: a plan, a proposal, an outcome, and a post with an open objection or ask stay', () => {
  const outcome = {
    text: 'Yes.',
    post: 'p-2',
    by: 'a-1',
    at,
  };
  const home = threadOf('t-2', { opening: 'p-1', outcome, state: 'answered' });
  const to = threadOf('t-3');
  const threads = [threadOf(planThread, { opening: 'p-9' }), home, to];
  const none: ReadonlySet<string> = new Set();
  const move = (post: Post, open = none): string | null =>
    moveRefusal(post, to, threads, open);
  assert.match(move(postOf('p-3', { kind: 'plan' })) ?? '', /plan post/);
  assert.match(
    move(postOf('p-3', { kind: 'proposal' })) ?? '',
    /proposal post/,
  );
  assert.match(move(postOf('p-2')) ?? '', /holds the outcome of t-2/);
  assert.match(
    move(postOf('p-3'), new Set(['p-3'])) ?? '',
    /open objection or ask/,
  );
  // The plan thread has no exemption, and a post that opens a thread is a post like any other.
  assert.equal(move(postOf('p-1')), null);
  assert.equal(move(postOf('p-9', { thread: planThread })), null);
  assert.match(
    moveRefusal(postOf('p-3', { thread: 't-3' }), to, threads, none) ?? '',
    /already/,
  );
  assert.match(
    moveRefusal(
      postOf('p-3'),
      threadOf('t-4', { state: 'closed' }),
      threads,
      none,
    ) ?? '',
    /t-4 is closed/,
  );
});

await test('an open ask or objection holds itself and what it replies to', () => {
  const posts = [
    postOf('p-1'),
    postOf('p-2', { kind: 'objection', replyTo: 'p-1', author: 'a-2' }),
    postOf('p-3', { kind: 'ask', replyTo: 'p-4', author: 'a-2' }),
    postOf('p-4'),
    postOf('p-5'),
  ];
  assert.deepEqual([...openPosts(posts, [], [waitOf('p-3', 'a-3')])].sort(), [
    'p-1',
    'p-2',
    'p-3',
    'p-4',
  ]);
  // A check that took the objection ended it.
  assert.deepEqual(
    [...openPosts(posts, [{ state: 'done', objections: ['p-2'] }], [])],
    [],
  );
});

await test('a title for the person holds no number that its thread does not, and ends with the outcome', () => {
  const thread = threadOf('t-2');
  const threads = [threadOf(planThread), thread];
  const posts = [postOf('p-1', { text: 'Seed 2 reached 64.5%.' })];
  assert.equal(
    checkedTitle('Does seed 2 reach 64.5%?', threads, posts),
    'Does seed 2 reach 64.5%?',
  );
  assert.throws(
    () => checkedTitle('Does seed 2 reach 91.5%?', threads, posts),
    /No post of the thread holds these numbers: 91.5%/,
  );
  assert.throws(
    () => checkedTitle('Update', threads, posts),
    /title that a reader understands alone/,
  );
  assert.equal(retitleRefusal(thread), null);
  assert.match(retitleRefusal(threadOf(planThread)) ?? '', /plan thread keeps/);
  assert.match(
    retitleRefusal(
      threadOf('t-2', {
        outcome: { text: 'Yes.', post: 'p-1', by: 'a-1', at },
      }),
    ) ?? '',
    /has its outcome/,
  );
  // A filed thread's title is the person's own words, clipped.
  assert.equal(
    filedTitle(postOf('p-1', { text: 'Look  at\nthe seeds.' })),
    'Look at the seeds.',
  );
  assert.equal(
    filedTitle(postOf('p-1', { text: 'x'.repeat(500) })).length,
    120,
  );
});

await test('Verifold writes a notice from its kind and its posts, and the record names who gets it', () => {
  const name = (author: string): string => `Agent ${author.slice(2)}`;
  const first = postOf('p-1');
  const second = postOf('p-2', { author: 'a-2' });
  const overlap = noticeFrom('overlap', [first, second], [], name);
  assert.deepEqual(overlap.to, ['a-1', 'a-2']);
  assert.equal(
    overlap.text,
    'The Coordinator sees that p-1 of Agent 1, p-2 of Agent 2 may cover the same work.',
  );
  assert.throws(
    () => noticeFrom('overlap', [first], [], name),
    /posts of two or more agents/,
  );
  // A no-search notice states a mark of the record, and suggests no work.
  assert.throws(
    () => noticeFrom('no-search', [first], [], name),
    /p-1 has no "No search yet" mark/,
  );
  const unsearched = noticeFrom(
    'no-search',
    [postOf('p-4', { kind: 'proposal', noSearch: true })],
    [],
    name,
  );
  assert.deepEqual(unsearched.to, ['a-1']);
  assert.equal(
    unsearched.text,
    'The Coordinator sees no search yet for p-4 of Agent 1.',
  );
  const ask = postOf('p-3', { kind: 'ask', author: 'a-2' });
  assert.deepEqual(
    noticeFrom('missing-answer', [ask], [waitOf('p-3', 'a-5')], name).to,
    ['a-5'],
  );
  assert.throws(
    () => noticeFrom('missing-answer', [ask], [], name),
    /p-3 waits for nothing now/,
  );
  // A wait on the person shows in Needs you, so no agent gets it.
  assert.deepEqual(
    noticeFrom('missing-answer', [ask], [waitOf('p-3', 'person')], name).to,
    [],
  );
  assert.throws(
    () => noticeFrom('open-direction', [first], [], name),
    /A notice's kind is one of/,
  );
});

await test('a line passes only when each claim is supported and no caveat dropped out', () => {
  const claim = (verdict: string): Record<string, unknown> => ({
    claim: 'It failed.',
    verdict,
  });
  const checks = parseChecks(
    [
      { id: 'l-1', claims: [claim('supported')], dropped: [] },
      // The shape of the error: a code check reads as a rerun that overturned the claim.
      { id: 'l-2', claims: [claim('raised-certainty')], dropped: [] },
      { id: 'l-3', claims: [claim('added-fact')], dropped: [] },
      { id: 'l-4', claims: [claim('number-out-of-scope')], dropped: [] },
      // The shape of the error: the part that passed is left out.
      {
        id: 'l-5',
        claims: [claim('supported')],
        dropped: ['Part (a) passed in two seeds.'],
      },
    ],
    ['l-1', 'l-2', 'l-3', 'l-4', 'l-5'],
  );
  assert.deepEqual(
    [...checks.values()].map((entry) => entry.state),
    ['passed', 'failed', 'failed', 'failed', 'failed'],
  );
  assert.deepEqual(checks.get('l-5')?.problems, [
    'dropped-caveat: Part (a) passed in two seeds.',
  ]);
  assert.throws(
    () => parseChecks([], ['l-1']),
    /Check each line. These are left: l-1/,
  );
  assert.throws(
    () => parseChecks([{ id: 'l-1', claims: [], dropped: [] }], ['l-1']),
    /Split l-1 into its claims/,
  );
  assert.throws(
    () =>
      parseChecks(
        [{ id: 'l-9', claims: [claim('supported')], dropped: [] }],
        ['l-1'],
      ),
    /Name one of these lines: l-1/,
  );
  assert.throws(
    () =>
      parseChecks(
        [{ id: 'l-1', claims: [claim('fine')], dropped: [] }],
        ['l-1'],
      ),
    /A verdict is one of/,
  );
  // It fails closed: no list of caveats, or a line twice, passes nothing.
  for (const dropped of [undefined, 'none', null])
    assert.throws(
      () =>
        parseChecks(
          [{ id: 'l-1', claims: [claim('supported')], dropped }],
          ['l-1'],
        ),
      /List the dropped caveats of l-1/,
    );
  const passed = { id: 'l-1', claims: [claim('supported')], dropped: [] };
  assert.throws(() => parseChecks([passed, passed], ['l-1']), /Check l-1 once/);
});

await test('the tools reach nothing that assigns, stops, starts, asks, plans, or settles', () => {
  assert.deepEqual(
    labCoordinatorToolSpecs.map((tool) => tool.name),
    [
      'verifold_board',
      'verifold_thread',
      'verifold_brief',
      'verifold_story',
      'verifold_notice',
      'verifold_answer',
    ],
  );
  assert.deepEqual(
    lineCheckToolSpecs.map((tool) => tool.name),
    ['verifold_line_check'],
  );
  const board = labCoordinatorToolSpecs[0]?.inputSchema.properties as {
    readonly view: { readonly enum: readonly string[] };
  };
  // `unread` has a read mark, and the Coordinator keeps none.
  assert.equal(board.view.enum.includes('unread'), false);
});

interface FakeSession {
  readonly id: string;
  readonly input: Parameters<LabSessions['startAgent']>[0];
}

/** One reserved place, as a fake: a start records its input, and no harness runs. */
function fakePlace(): {
  readonly sessions: NonNullable<LabCoordinatorHost['sessions']>;
  readonly started: FakeSession[];
  readonly sent: string[];
  readonly ended: string[];
} {
  const started: FakeSession[] = [];
  const sent: string[] = [];
  const ended: string[] = [];
  const live = new Set<string>();
  return {
    started,
    sent,
    ended,
    sessions: {
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
        ended.push(id);
        live.delete(id);
      },
    },
  };
}

interface Rig extends ReturnType<typeof fakePlace> {
  readonly coordinator: LabCoordinator;
  readonly store: BriefStore;
  readonly board: Board;
  readonly threads: ThreadStore;
  readonly directions: Pick<Direction, 'id' | 'state' | 'verdict'>[];
  readonly held: { readonly agent: string; readonly line: string }[];
  readonly notes: Map<string, string>;
  readonly post: (fields: Partial<NewPost>) => Promise<Post>;
  /** Call a tool of the newest session. */
  readonly call: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ readonly ok: boolean; readonly text: string }>;
  /** The newest session's turn ended. */
  readonly endTurn: (status?: SessionRecord['status']) => Promise<void>;
  readonly tick: () => Promise<void>;
}

const direction = (
  id: string,
  verdict: Direction['verdict'] = 'open',
): Pick<Direction, 'id' | 'state' | 'verdict'> => ({
  id,
  state: 'open',
  verdict,
});

async function rig(
  t: TestContext,
  more: {
    readonly team?: readonly ('claude' | 'codex')[];
    readonly delayMs?: number;
    readonly minuteMs?: number;
    readonly usedUp?: (host: string) => boolean;
    readonly noPlace?: boolean;
    readonly keepsPlain?: boolean;
  } = {},
): Promise<Rig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-brief-')));
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
  const place = fakePlace();
  const directions: Rig['directions'] = [];
  const held: Rig['held'] = [];
  const notes = new Map<string, string>();
  const host: LabCoordinatorHost = {
    root,
    sessions: more.noPlace ? null : place.sessions,
    store,
    threads,
    timing: {
      hourMs: 3_600_000,
      minuteMs: more.minuteMs ?? 60_000,
      briefDelayMs: more.delayMs ?? 0,
    },
    question: () => 'Do months sit on a circle?',
    directions: () => directions,
    summary: () => '- d-1 "A line of work": open.',
    board,
    checks: () => [],
    name: (author) => author,
    team: () => Promise.resolve(more.team ?? ['claude', 'codex']),
    usedUp: (name) => more.usedUp?.(name) ?? false,
    model: () => Promise.resolve('best-model'),
    denied: () => Promise.resolve(['/denied']),
    keepsPlain: () => Promise.resolve(more.keepsPlain ?? true),
    add: (fields) => {
      if (fields.key) notes.set(fields.key, fields.text);
      return board.add(fields);
    },
    read: () => Promise.resolve('the record'),
    notify: (agent, line) => {
      held.push({ agent, line });
      return agent !== 'a-404';
    },
    serial: (work) => Promise.resolve().then(work),
    progress: () => {},
  };
  const coordinator = new LabCoordinator(host);
  t.after(() => coordinator.stop());
  const turn = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  return {
    ...place,
    coordinator,
    store,
    board,
    threads,
    directions,
    held,
    notes,
    tick: () => coordinator.tick(),
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
    call: (name, input) => {
      const session = place.started.at(-1);
      assert.ok(session);
      return session.input.tools.call(name, input, 'call');
    },
    endTurn: async (status = 'idle') => {
      const session = place.started.at(-1);
      assert.ok(session);
      assert.equal(
        coordinator.turnEnded({
          id: session.id,
          agent: coordinatorAgent,
          status,
          costUsd: 0.25,
        } as SessionRecord),
        true,
      );
      await turn();
    },
  };
}

const anyLine = (posts: readonly string[], plain = 'It works.') => ({
  lines: [{ kind: 'open', plain, posts }],
});

await test('a state change starts one update after the delay, and a busy lab does not push it back', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const lab = await rig(t, { delayMs: 180_000 });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  assert.equal(lab.started.length, 0);
  // Changes keep coming, and the delay runs from the first one.
  for (const verdict of ['leading', 'open', 'leading'] as const) {
    t.mock.timers.tick(59_000);
    lab.directions[0] = direction('d-1', verdict);
    await lab.tick();
    assert.equal(lab.started.length, 0);
  }
  t.mock.timers.tick(4_000);
  await lab.tick();
  assert.equal(lab.started.length, 1);
  // One session at a time: a tick while it runs starts nothing.
  await lab.tick();
  assert.equal(lab.started.length, 1);
  const input = lab.started[0]?.input;
  assert.equal(input?.toolsOnly, true);
  assert.equal(input?.agent, coordinatorAgent);
  assert.equal(input?.host, 'claude');
  assert.equal(input?.model, 'best-model');
  assert.deepEqual(input?.denyRead, ['/denied']);
  assert.match(input?.cwd ?? '', /\/\.verifold\/checks\/lab-record$/);
});

await test('updates stay within their hourly limit, and an hour later they run again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const lab = await rig(t, { team: ['claude'] });
  const post = await lab.post({});
  const update = async (turn: number): Promise<void> => {
    lab.directions[0] = direction('d-1', turn % 2 ? 'leading' : 'open');
    await lab.tick();
  };
  for (let turn = 0; turn < briefLimits.updatesPerHour; turn++) {
    await update(turn);
    assert.equal(lab.started.length, turn * 2 + 1);
    assert.equal(
      (await lab.call('verifold_brief', anyLine([post.id]))).ok,
      true,
    );
    await lab.endTurn();
    // A check of the line comes next.
    await lab.tick();
    assert.equal(lab.started.length, turn * 2 + 2);
    await lab.call('verifold_line_check', {
      lines: lab.store.pending().map(({ id }) => ({
        id,
        claims: [{ claim: 'It works.', verdict: 'supported' }],
        dropped: [],
      })),
    });
    await lab.endTurn();
  }
  const count = lab.started.length;
  lab.directions[0] = direction('d-1', 'holds-up');
  await lab.tick();
  assert.equal(lab.started.length, count);
  t.mock.timers.tick(3_600_001);
  await lab.tick();
  assert.equal(lab.started.length, count + 1);
});

await test('each update builds from posts, so no prompt holds earlier plain words', async (t) => {
  const lab = await rig(t);
  const post = await lab.post({ text: 'Seed 0 gives 55% vs 15%.' });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  const plain = 'The first run gave 55% and 15%, in plain words.';
  await lab.call('verifold_brief', anyLine([post.id], plain));
  await lab.endTurn();
  // The line check reads the line: that is its job.
  await lab.tick();
  assert.match(lab.started[1]?.input.prompt ?? '', /in plain words/);
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'It gave 55%.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await lab.endTurn();
  const { id: question } = lab.coordinator.ask('What did the first run give?');
  await lab.tick();
  const asked = lab.started[2];
  assert.ok(asked);
  assert.match(asked.input.prompt, /Seed 0 gives 55% vs 15%/);
  assert.match(asked.input.prompt, /What did the first run give\?/);
  assert.doesNotMatch(asked.input.prompt, /in plain words/);
  const earlier = 'The answer in earlier words.';
  await lab.call('verifold_answer', {
    question,
    plain: earlier,
    posts: [post.id],
  });
  await lab.endTurn();
  // The answer's check comes first, then the next update.
  await lab.tick();
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map(({ id }) => ({
      id,
      claims: [{ claim: 'The answer.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await lab.endTurn();
  lab.directions[0] = direction('d-1', 'leading');
  await lab.tick();
  const next = lab.started.at(-1)?.input;
  assert.ok(next && next.tools.specs.length > 1);
  assert.match(next.prompt, /verifold_brief once/);
  assert.doesNotMatch(next.prompt, /in plain words/);
  assert.doesNotMatch(next.prompt, /earlier words/);
});

await test('a line check runs on the other harness, and its result decides what shows', async (t) => {
  const lab = await rig(t);
  const post = await lab.post({ text: 'It passed 64.5%.' });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  const sent = await lab.call('verifold_brief', {
    lines: [
      { kind: 'open', plain: 'It passed 64.5%.', posts: [post.id] },
      { kind: 'failed', plain: 'It passed 91.5%.', posts: [post.id] },
      { kind: 'new', plain: 'It may pass.', posts: [post.id] },
    ],
  });
  // The number test comes at once, and the writer can fix the line.
  assert.match(sent.text, /No cited post holds these numbers: 91.5%/);
  await lab.endTurn();
  assert.deepEqual(
    lab.store.view().brief?.lines.map((line) => line.check.state),
    ['pending', 'numbers', 'pending'],
  );
  await lab.tick();
  const check = lab.started[1];
  assert.equal(check?.input.host, 'codex');
  assert.equal(check?.input.toolsOnly, true);
  assert.deepEqual(
    check?.input.tools.specs.map((tool) => tool.name),
    ['verifold_line_check'],
  );
  assert.doesNotMatch(check?.input.prompt ?? '', /91\.5/);
  const [first, , third] = lab.store.view().brief?.lines ?? [];
  assert.ok(first && third);
  const refused = await lab.call('verifold_line_check', {
    lines: [
      {
        id: first.id,
        claims: [{ claim: 'It passed.', verdict: 'supported' }],
        dropped: [],
      },
    ],
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /These are left/);
  await lab.call('verifold_line_check', {
    lines: [
      {
        id: first.id,
        claims: [{ claim: 'It passed.', verdict: 'supported' }],
        dropped: [],
      },
      {
        id: third.id,
        claims: [{ claim: 'It may pass.', verdict: 'added-fact' }],
        dropped: [],
      },
    ],
  });
  await lab.endTurn();
  assert.deepEqual(
    lab.store.view().brief?.lines.map((line) => line.check),
    [
      { state: 'passed', problems: [], by: 'codex', sameHarness: false },
      {
        state: 'numbers',
        problems: ['91.5%'],
        by: null,
        sameHarness: false,
      },
      {
        state: 'failed',
        problems: ['added-fact: It may pass.'],
        by: 'codex',
        sameHarness: false,
      },
    ],
  );
  assert.deepEqual(lab.ended, ['session-1', 'session-2']);
});

await test('with one harness, a fresh session of it checks, and the record labels it', async (t) => {
  const lab = await rig(t, { team: ['codex'] });
  const post = await lab.post({});
  lab.directions.push(direction('d-1'));
  await lab.tick();
  await lab.call('verifold_brief', anyLine([post.id]));
  await lab.endTurn();
  await lab.tick();
  assert.equal(lab.started[1]?.input.host, 'codex');
  const [line] = lab.store.view().brief?.lines ?? [];
  assert.ok(line);
  await lab.call('verifold_line_check', {
    lines: [
      {
        id: line.id,
        claims: [{ claim: 'It works.', verdict: 'supported' }],
        dropped: [],
      },
    ],
  });
  assert.deepEqual(lab.store.view().brief?.lines[0]?.check, {
    state: 'passed',
    problems: [],
    by: 'codex',
    sameHarness: true,
  });
});

await test('the other harness out of usage leaves lines pending, and an update still runs', async (t) => {
  const lab = await rig(t, { usedUp: (host) => host === 'codex' });
  const post = await lab.post({});
  lab.directions.push(direction('d-1'));
  await lab.tick();
  await lab.call('verifold_brief', anyLine([post.id]));
  await lab.endTurn();
  await lab.tick();
  assert.equal(lab.started.length, 1);
  assert.equal(lab.store.pending().length, 1);
  lab.directions[0] = direction('d-1', 'leading');
  await lab.tick();
  assert.equal(lab.started.length, 2);
  assert.equal(lab.started[1]?.input.host, 'claude');
});

await test('a session has its turns and its minutes, and work that it owes comes again after a wait', async (t) => {
  const lab = await rig(t, { delayMs: 60_000, minuteMs: 1 });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  assert.equal(lab.started.length, 0);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
  await lab.tick();
  assert.equal(lab.started.length, 1);
  await lab.endTurn();
  await lab.endTurn();
  assert.deepEqual(lab.sent, [
    'Call verifold_brief now with what you have.',
    'Call verifold_brief now with what you have.',
  ]);
  await lab.endTurn();
  assert.deepEqual(lab.ended, ['session-1']);
  // A tool call of the ended session changes nothing.
  const late = await lab.call('verifold_brief', anyLine(['p-1']));
  assert.equal(late.ok, false);
  assert.match(late.text, /no longer works for the lab/);
  // The update is still due, after the wait.
  await lab.tick();
  assert.equal(lab.started.length, 1);
  t.mock.timers.tick(60_001);
  await lab.tick();
  assert.equal(lab.started.length, 2);
  // The time limit ends a session that hangs.
  t.mock.timers.reset();
  await until(() => lab.ended.includes('session-2'));
});

await test('a process that stops ends the session, and the update comes again', async (t) => {
  const lab = await rig(t);
  lab.directions.push(direction('d-1'));
  await lab.tick();
  await lab.endTurn('failed');
  assert.deepEqual(lab.ended, ['session-1']);
  lab.coordinator.ask('Is anyone there?');
  await lab.tick();
  assert.equal(lab.started.length, 2);
});

await test('the person returns: an update comes at once, or none when no post came', async (t) => {
  const lab = await rig(t, { delayMs: 3_600_000 });
  const post = await lab.post({ text: 'A result.' });
  lab.coordinator.personBack('2026-11-01T09:00:00.000Z');
  await lab.tick();
  assert.equal(lab.started.length, 1);
  assert.match(
    lab.started[0]?.input.prompt ?? '',
    /The person left at 2026-11-01T09:00:00.000Z and came back/,
  );
  await lab.call('verifold_brief', anyLine([post.id]));
  await lab.endTurn();
  await lab.call('verifold_brief', anyLine([post.id]));
  // The brief covers the newest post, so another return changes nothing.
  lab.coordinator.personBack('2026-11-01T09:30:00.000Z');
  assert.equal(lab.store.pending().length, 1);
  await lab.tick();
  await lab.endTurn();
  assert.doesNotMatch(lab.started.at(-1)?.input.prompt ?? '', /came back/);
});

await test('the person asks: a session answers from the record with its sources, and the person waits for the running one', async (t) => {
  const lab = await rig(t);
  const post = await lab.post({ text: 'Agent 3 objected at 11:05.' });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  assert.equal(lab.started.length, 1);
  const question = lab.coordinator.ask('Why did we change the plan?');
  // It waits for the session that runs.
  await lab.tick();
  assert.equal(lab.started.length, 1);
  await lab.call('verifold_brief', anyLine([post.id]));
  await lab.endTurn();
  await lab.tick();
  assert.equal(lab.started.length, 2);
  const session = lab.started[1];
  assert.match(session?.input.prompt ?? '', /Why did we change the plan\?/);
  assert.match(session?.input.prompt ?? '', /Give no brief/);
  const brief = await lab.call('verifold_brief', anyLine([post.id]));
  assert.match(brief.text, /This session answers questions/);
  await lab.endTurn();
  assert.deepEqual(
    lab.sent.at(-1),
    `Answer these with verifold_answer now: ${question.id}.`,
  );
  assert.equal(
    (
      await lab.call('verifold_answer', {
        question: question.id,
        plain: 'Agent 3 objected at 11:05.',
        posts: [post.id],
      })
    ).ok,
    true,
  );
  await lab.endTurn();
  const saved = lab.store.view().questions[0];
  assert.equal(saved?.state, 'answered');
  assert.deepEqual(saved?.answer?.posts, [post.id]);
  // An answer gets a line check, as a line does.
  assert.equal(saved?.answer?.check.state, 'pending');
  assert.equal(lab.store.pending().length, 2);
  // No agent heard of it.
  assert.deepEqual(lab.held, []);
  // A session that gave all it owed makes nothing wait: the check comes at the next tick.
  await lab.tick();
  assert.equal(lab.started.at(-1)?.input.tools.specs.length, 1);
});

await test('a question with no answer says so, and the questions stay within their limits', async (t) => {
  const lab = await rig(t);
  const question = lab.coordinator.ask('First?');
  await lab.tick();
  await lab.endTurn('ended');
  assert.equal(lab.store.view().questions[0]?.id, question.id);
  assert.equal(lab.store.view().questions[0]?.state, 'unanswered');
  for (let index = 1; index < briefLimits.questionsPerHour; index++)
    lab.coordinator.ask(`Question ${index}?`);
  assert.throws(
    () => lab.coordinator.ask('One more?'),
    /You asked 6 questions in the last hour/,
  );
  assert.throws(() => lab.coordinator.ask(''), /Write your question/);
  assert.throws(
    () => lab.coordinator.ask('x'.repeat(briefLimits.question + 1)),
    /Write your question/,
  );
  const elsewhere = await rig(t, { noPlace: true });
  assert.throws(() => elsewhere.coordinator.ask('Here?'), /only shows the lab/);
  await elsewhere.tick();
  assert.equal(elsewhere.started.length, 0);
});

await test('a notice joins the next digest of who the record names, once, and within its hourly limit', async (t) => {
  const lab = await rig(t);
  const first = await lab.post({ author: 'a-1' });
  const second = await lab.post({ author: 'a-2' });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  const overlap = { kind: 'overlap', posts: [first.id, second.id] };
  assert.equal((await lab.call('verifold_notice', overlap)).ok, true);
  assert.deepEqual(
    lab.held.map((entry) => entry.agent),
    ['a-1', 'a-2'],
  );
  assert.match(lab.held[0]?.line ?? '', /may cover the same work/);
  const again = await lab.call('verifold_notice', overlap);
  assert.match(again.text, /gave this notice before/);
  assert.equal(lab.held.length, 2);
  assert.equal(lab.store.view().notices.length, 1);
  assert.deepEqual(lab.store.view().notices[0]?.to, ['a-1', 'a-2']);
  const gone = await lab.post({ author: 'a-404', noSearch: true });
  const nobody = await lab.call('verifold_notice', {
    kind: 'no-search',
    posts: [gone.id],
  });
  assert.equal(nobody.ok, false);
  assert.match(nobody.text, /No agent that works now/);
  for (let index = 1; index < briefLimits.noticesPerHour; index++) {
    const post = await lab.post({ author: 'a-1', noSearch: true });
    assert.equal(
      (
        await lab.call('verifold_notice', {
          kind: 'no-search',
          posts: [post.id],
        })
      ).ok,
      true,
    );
  }
  const post = await lab.post({ author: 'a-1', noSearch: true });
  const limited = await lab.call('verifold_notice', {
    kind: 'no-search',
    posts: [post.id],
  });
  assert.match(limited.text, /6 notices in the last hour/);
});

await test('a session changes at most so many threads and notices', async (t) => {
  const lab = await rig(t);
  const post = await lab.post({ text: 'A post to file.', author: 'person' });
  const { id } = await lab.threads.open({
    title: 'Does the control beat chance?',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
  });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  for (let index = 0; index < briefLimits.actions; index++)
    await lab.call('verifold_thread', {
      action: 'move',
      thread: id,
      post: 'p-1',
    });
  const last = await lab.call('verifold_thread', {
    action: 'move',
    thread: id,
    post: post.id,
  });
  assert.equal(last.ok, false);
  assert.match(last.text, /One session makes at most 40 changes/);
});

await test('verifold_thread moves, titles for the person, and closes with a quote, and it changes no decision', async (t) => {
  const lab = await rig(t);
  const asked = await lab.post({
    text: 'Please check the seeds.',
    author: 'person',
    kind: 'question',
  });
  const { id } = await lab.threads.open({
    title: 'Does the control beat chance?',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
  });
  const opening = await lab.post({
    thread: id,
    kind: 'result',
    text: 'It does, 3 of 3.',
    artifacts: [{ type: 'run', run: 'r-1' }],
  });
  const outcome = await lab.post({
    thread: id,
    author: 'a-2',
    kind: 'answer',
    text: 'Agreed: all 3 seeds hold.',
  });
  const open = await lab.post({
    thread: id,
    author: 'a-2',
    kind: 'ask',
    text: 'Which seed comes next?',
    mentions: ['a-3'],
  });
  const proposal = await lab.post({
    thread: id,
    kind: 'proposal',
    text: 'Use all seeds.',
  });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  const prompt = lab.started[0]?.input.prompt ?? '';
  assert.match(
    prompt,
    new RegExp(`The person's posts in the plan thread: ${asked.id}`),
  );
  const move = await lab.call('verifold_thread', {
    action: 'move',
    thread: id,
    post: asked.id,
  });
  assert.equal(move.ok, true, move.text);
  // The post reads in its new thread, under the same ID, and its file stays as it was.
  assert.equal(lab.board.get(asked.id)?.thread, id);
  assert.deepEqual(
    lab.threads
      .posts(lab.threads.get(id) ?? threadOf(id))
      .map((post) => post.id),
    [asked.id, opening.id, outcome.id, open.id, proposal.id],
  );
  for (const [post, reason] of [
    [open.id, /open objection or ask/],
    [proposal.id, /proposal post/],
  ] as const)
    assert.match(
      (
        await lab.call('verifold_thread', {
          action: 'move',
          thread: planThread,
          post,
        })
      ).text,
      reason,
    );
  const title = 'Do all 3 seeds beat chance?';
  assert.equal(
    (await lab.call('verifold_thread', { action: 'title', thread: id, title }))
      .ok,
    true,
  );
  // The person reads the new wording. Agents keep the title that they read.
  const record = lab.threads.get(id);
  assert.equal(record?.plainTitle, title);
  assert.equal(record?.title, 'Does the control beat chance?');
  assert.doesNotMatch(lab.threads.lines().join('\n'), /Do all 3 seeds/);
  assert.match(
    (await lab.call('verifold_thread', { action: 'stop', thread: id })).text,
    /Give an action/,
  );
  assert.match(
    (await lab.call('verifold_thread', { action: 'close', thread: id })).text,
    /p-\d+ waits for an answer|open proposal/,
  );
});

await test('a close names a post only for a thread with no outcome, and an outcome ends retitles', async (t) => {
  const lab = await rig(t);
  const { id } = await lab.threads.open({
    title: 'Does the control beat chance?',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
  });
  await lab.post({ thread: id, text: 'It does, on 3 seeds.' });
  const second = await lab.post({
    thread: id,
    author: 'a-2',
    text: 'All 3 seeds hold.',
  });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  assert.match(
    (await lab.call('verifold_thread', { action: 'close', thread: id })).text,
    /Name the post of t-2 that holds its outcome/,
  );
  const closed = await lab.call('verifold_thread', {
    action: 'close',
    thread: id,
    post: second.id,
  });
  assert.equal(closed.ok, true, closed.text);
  const record = lab.threads.get(id);
  assert.equal(record?.state, 'closed');
  assert.equal(record?.outcome?.text, 'All 3 seeds hold.');
  assert.equal(record?.outcome?.post, second.id);
  assert.equal(record?.outcome?.by, 'a-2');
  assert.match(
    (
      await lab.call('verifold_thread', {
        action: 'title',
        thread: id,
        title: 'A better title for this thread',
      })
    ).text,
    /has its outcome, so it keeps its title/,
  );
  // A decision cannot be replaced by closing again with another post.
  const decided = await lab.threads.open({
    title: 'Which seed comes first?',
    why: 'It sets the order.',
    openedBy: 'a-1',
    at,
  });
  const choice = await lab.post({
    thread: decided.id,
    kind: 'proposal',
    text: 'Seed 2 first.',
  });
  const other = await lab.post({ thread: decided.id, text: 'Seed 3 first.' });
  const settled = lab.threads as unknown as {
    change(
      id: string,
      next: (thread: Thread) => Thread,
    ): Promise<Thread | undefined>;
  };
  await settled.change(decided.id, (thread) => ({
    ...thread,
    state: 'decided',
    outcome: { text: choice.text, post: choice.id, by: 'a-1', at },
  }));
  assert.match(
    (
      await lab.call('verifold_thread', {
        action: 'close',
        thread: decided.id,
        post: other.id,
      })
    ).text,
    /has its outcome, so close it with no post/,
  );
  assert.equal(
    (
      await lab.call('verifold_thread', {
        action: 'close',
        thread: decided.id,
      })
    ).ok,
    true,
  );
  assert.equal(lab.threads.get(decided.id)?.outcome?.post, choice.id);
});

await test("a person's post with no thread gets one, titled in the person's own words", async (t) => {
  const lab = await rig(t);
  const asked = await lab.post({
    text: 'Please compare the two controls.',
    author: 'person',
    kind: 'question',
  });
  const agents = await lab.post({ text: 'A note of an agent.' });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  const filed = await lab.call('verifold_thread', {
    action: 'file',
    post: asked.id,
    title: 'Which control works better?',
  });
  assert.equal(filed.ok, true, filed.text);
  const thread = lab.threads.list().at(-1);
  assert.equal(thread?.title, 'Please compare the two controls.');
  assert.equal(thread?.plainTitle, 'Which control works better?');
  assert.equal(thread?.openedBy, 'verifold');
  assert.equal(lab.board.get(asked.id)?.thread, thread?.id);
  assert.match(
    (await lab.call('verifold_thread', { action: 'file', post: agents.id }))
      .text,
    /Name one of the person's posts in the plan thread/,
  );
});

await test('moves survive a reload, because a record applies them on read', async (t) => {
  const lab = await rig(t);
  const post = await lab.post({
    author: 'person',
    kind: 'question',
    text: 'A note.',
  });
  const { id } = await lab.threads.open({
    title: 'Does the control beat chance?',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
  });
  await lab.threads.move(post, id);
  await lab.threads.flush();
  await lab.board.load();
  assert.equal(lab.board.get(post.id)?.thread, planThread);
  await lab.threads.load(at);
  assert.equal(lab.board.get(post.id)?.thread, id);
  assert.equal(
    lab.board.list().find((entry) => entry.id === post.id)?.thread,
    id,
  );
});

await test('stop ends the session, and the work waits for the next tick', async (t) => {
  const lab = await rig(t);
  lab.directions.push(direction('d-1'));
  const question = lab.coordinator.ask('Still there?');
  await lab.tick();
  assert.equal(lab.started.length, 1);
  lab.coordinator.stop();
  assert.deepEqual(lab.ended, ['session-1']);
  assert.equal(lab.store.view().questions[0]?.state, 'waiting');
  const late = await lab.call('verifold_answer', {
    question: question.id,
    plain: 'Yes.',
    posts: ['p-1'],
  });
  assert.match(late.text, /no longer works for the lab/);
  await lab.tick();
  assert.equal(lab.started.length, 2);
});

await test('the store survives a bad file, keeps no pass that it cannot read, and stays bounded', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-brief-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(root, 'brief.json');
  const line = {
    id: 'l-1',
    kind: 'open',
    at,
    plain: 'It works.',
    posts: ['p-1', 'bad'],
    writer: 'claude',
  };
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      brief: {
        at,
        key: 'k',
        through: 3,
        lines: [
          line,
          { id: 'x' },
          { ...line, id: 'l-2', check: { state: 'yes' } },
        ],
      },
      notices: [{ id: 'n-3', at, kind: 'stop-work', posts: [], to: [] }],
      questions: Array.from(
        { length: briefLimits.questions + 5 },
        (_, index) => ({
          id: `q-${index + 4}`,
          at,
          text: 'Why?',
          state: 'waiting',
          answer: null,
        }),
      ),
      spend: { usd: -1, session: 's', seen: 0 },
    }),
  );
  const store = new BriefStore(path, () => false);
  await store.load(true);
  const view = store.view();
  assert.deepEqual(
    view.brief?.lines.map((entry) => entry.id),
    ['l-1', 'l-2'],
  );
  assert.equal(view.brief?.lines[0]?.check.state, 'pending');
  assert.equal(view.brief?.lines[1]?.check.state, 'pending');
  assert.deepEqual(view.brief?.lines[0]?.posts, ['p-1']);
  assert.deepEqual(view.notices, []);
  assert.equal(view.questions.length, briefLimits.questions);
  assert.equal(view.spend, undefined);
  // New IDs come after the highest saved one.
  assert.equal(store.addQuestion('Next?').id, `q-${briefLimits.questions + 9}`);
  const old = new BriefStore(path, () => false);
  await old.load(false);
  assert.equal(old.view().brief, null);
  // A broken file counts as no record.
  await writeFile(path, '{');
  await store.flush();
  await writeFile(path, '{');
  const broken = new BriefStore(path, () => false);
  await broken.load(true);
  assert.equal(broken.view().brief, null);
});

await test('what a session changes itself counts as seen: a quiet lab gets one update, then none', async (t) => {
  const lab = await rig(t, { team: ['claude'] });
  const { id } = await lab.threads.open({
    title: 'Does the control beat chance?',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
  });
  const post = await lab.post({ thread: id, text: 'It does.' });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  assert.equal(lab.started.length, 1);
  await lab.call('verifold_brief', anyLine([post.id]));
  // A close after the brief changes the state, and the brief covers it.
  await lab.call('verifold_thread', {
    action: 'close',
    thread: id,
    post: post.id,
  });
  await lab.endTurn();
  await lab.tick();
  assert.equal(lab.started.length, 2);
  const [line] = lab.store.pending();
  assert.ok(line);
  await lab.call('verifold_line_check', {
    lines: [
      {
        id: line.id,
        claims: [{ claim: 'It works.', verdict: 'supported' }],
        dropped: [],
      },
    ],
  });
  await lab.endTurn();
  // The close brings the thread's story, and that session gives no brief.
  await lab.tick();
  assert.equal(lab.started.length, 3);
  assert.match(lab.started[2]?.input.prompt ?? '', /Give no brief\./);
  await lab.call('verifold_story', {
    thread: id,
    lines: [{ kind: 'outcome', plain: 'It does.', posts: [post.id] }],
  });
  await lab.endTurn();
  await lab.tick();
  await lab.call('verifold_line_check', {
    lines: lab.store.pending().map((entry) => ({
      id: entry.id,
      claims: [{ claim: 'It does.', verdict: 'supported' }],
      dropped: [],
    })),
  });
  await lab.endTurn();
  for (let turn = 0; turn < 3; turn++) await lab.tick();
  assert.equal(lab.started.length, 4);
  // A restart reads the same state.
  lab.coordinator.loaded();
  await lab.tick();
  assert.equal(lab.started.length, 4);
  // Someone else's change still counts.
  lab.directions[0] = direction('d-1', 'leading');
  await lab.tick();
  assert.equal(lab.started.length, 5);
});

await test('a lab whose paths the deny rules cannot express keeps no plain words: quotes only, with one note', async (t) => {
  const lab = await rig(t, { keepsPlain: false });
  const post = await lab.post({ text: 'It reached 64.5%.' });
  const { id } = await lab.threads.open({
    title: 'Does the control beat chance?',
    why: 'It decides the next step.',
    openedBy: 'a-1',
    at,
  });
  lab.directions.push(direction('d-1'));
  await lab.tick();
  assert.match(
    lab.started[0]?.input.prompt ?? '',
    /This lab keeps no plain words/,
  );
  assert.equal(lab.notes.size, 1);
  assert.match(lab.notes.get('plain-off') ?? '', /quotes only/);
  const brief = await lab.call('verifold_brief', {
    lines: [{ kind: 'open', posts: [post.id] }],
  });
  assert.equal(brief.ok, true, brief.text);
  // Plain words that come anyway stay out of the record.
  await lab.call('verifold_brief', anyLine([post.id], 'Words that must go.'));
  const [line] = lab.store.view().brief?.lines ?? [];
  assert.equal(line?.plain, '');
  assert.equal(line?.check.state, 'withheld');
  assert.deepEqual(lab.store.pending(), []);
  assert.match(
    (
      await lab.call('verifold_thread', {
        action: 'title',
        thread: id,
        title: 'A plain title of this thread',
      })
    ).text,
    /keeps no plain words/,
  );
  await lab.endTurn();
  // A withheld line needs no check, so no session starts for it.
  await lab.tick();
  assert.equal(lab.started.length, 1);
});

await test('the snapshot keeps the first lines of a brief, tests numbers again, and shows plain words only after a pass', () => {
  const posts = [postOf('p-1', { text: 'It reached 64.5%.' })];
  const line = (id: string, plain: string, state: LineState): BriefLine => ({
    id,
    kind: 'open',
    at,
    plain,
    posts: ['p-1'],
    writer: 'claude',
    check: { state, by: null, sameHarness: false, problems: [] },
  });
  const view = {
    state: { directions: [], calls: [] },
    posts,
    ledger: [],
    checks: [],
    brief: {
      brief: {
        at,
        key: 'k',
        through: 1,
        lines: [
          line('l-1', 'It reached 64.5%.', 'passed'),
          // A file that says passed cannot carry a number that no post holds.
          line('l-2', 'It reached 91.5%.', 'passed'),
          line('l-3', 'It may pass.', 'pending'),
          line('l-4', '', 'withheld'),
        ],
      },
      notices: [],
      questions: [],
      sessions: [],
    },
  } as unknown as LabView;
  const cuts: [string, boolean][] = [];
  const { brief } = briefItems(view, (list, name, newest) => {
    cuts.push([name, newest]);
    return [...list];
  });
  assert.deepEqual(cuts, [
    ['briefLines', false],
    ['notices', true],
    ['questions', true],
  ]);
  assert.deepEqual(
    brief?.lines.map((entry) => [entry.plain, entry.check.state]),
    [
      ['It reached 64.5%.', 'passed'],
      [null, 'numbers'],
      [null, 'pending'],
      [null, 'withheld'],
    ],
  );
  assert.equal(brief?.lines[3]?.quote, 'It reached 64.5%. (p-1)');
});

await test('a slot session ends on an exit that leaves it paused, on its limits, and with no call back from end', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-slot-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const place = fakePlace();
  const host = {
    root,
    sessions: place.sessions,
    timing: { minuteMs: 60_000 },
    serial: <T>(work: () => T | Promise<T>): Promise<T> =>
      Promise.resolve().then(work),
  };
  const ends: string[] = [];
  const job = {
    agent: 'a-3',
    host: 'claude' as const,
    folder: 'l-3',
    specs: [],
    turns: 2,
    minutes: 10,
    prompt: () => Promise.resolve('Work.'),
    model: () => Promise.resolve(null),
    denied: () => Promise.resolve([]),
    call: () => 'Done.',
    owed: () => 'Give it now.',
    ended: (how: string) => {
      ends.push(how);
    },
  };
  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  const record = (id: string, status: SessionRecord['status']): SessionRecord =>
    ({ id, status }) as SessionRecord;
  const paused = new SlotSession(host, job);
  t.after(() => paused.end());
  assert.equal(await paused.start(), true);
  paused.turnEnded(record('session-1', 'paused'));
  await settle();
  assert.deepEqual(ends, ['exit']);
  assert.deepEqual(place.ended, ['session-1']);
  const limited = new SlotSession(host, job);
  t.after(() => limited.end());
  assert.equal(await limited.start(), true);
  limited.turnEnded(record('session-2', 'idle'));
  await settle();
  assert.deepEqual(place.sent, ['Give it now.']);
  // A session of another start says nothing of this one.
  limited.turnEnded(record('session-1', 'ended'));
  await settle();
  assert.deepEqual(ends, ['exit']);
  limited.turnEnded(record('session-2', 'idle'));
  await settle();
  assert.deepEqual(ends, ['exit', 'turns']);
  const stopped = new SlotSession(host, job);
  assert.equal(await stopped.start(), true);
  stopped.end();
  assert.deepEqual(ends, ['exit', 'turns']);
  const full = new SlotSession(
    {
      ...host,
      sessions: {
        ...place.sessions,
        startAgent: () => Promise.reject(new PoolFullError('Full.')),
      },
    },
    job,
  );
  assert.equal(await full.start(), false);
  const broken = new SlotSession(
    {
      ...host,
      sessions: {
        ...place.sessions,
        startAgent: () => Promise.reject(new Error('No harness.')),
      },
    },
    job,
  );
  await assert.rejects(broken.start(), /No harness/);
});

function sessionRecord(
  id: string,
  status: SessionRecord['status'],
  launch: { readonly pid: number | null; readonly processStart: string | null },
  more: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    schemaVersion: 2,
    id,
    host: 'claude',
    model: null,
    mode: 'strict',
    reportedMode: null,
    nativeSessionId: randomUUID(),
    status,
    startedAt: at,
    endedAt: null,
    costUsd: null,
    events: [],
    commands: [],
    requests: [],
    launches: [
      {
        id: 'abcd1234',
        startedAt: at,
        endedAt: null,
        ownerId: 'dead-owner',
        ...launch,
      },
    ],
    ...more,
  };
}

const idAt = (seconds: number, suffix: string): string =>
  `20261101T1000${String(seconds).padStart(2, '0')}000Z-${suffix}`;

await test('short side sessions keep out of the recovery window of agents, and recovery still stops their processes', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-window-')),
  );
  const folder = join(root, '.verifold', 'sessions');
  await mkdir(folder, { recursive: true });
  const save = (record: SessionRecord): Promise<void> =>
    writeFile(join(folder, `${record.id}.json`), JSON.stringify(record));
  const side = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  });
  side.unref();
  t.after(async () => {
    try {
      process.kill(-(side.pid ?? 0), 'SIGKILL');
    } catch {
      /* It stopped. */
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await until(async () => (await processStart(side.pid ?? 0)) !== null);
  // An agent's long session, older than every short one.
  const agent = idAt(0, 'aaaaaaaa');
  await save(
    sessionRecord(
      agent,
      'running',
      { pid: null, processStart: null },
      {
        agent: 'a-1',
      },
    ),
  );
  // The person's own paused session, as old.
  const own = idAt(1, 'bbbbbbbb');
  await save(
    sessionRecord(
      own,
      'paused',
      { pid: null, processStart: null },
      {
        mode: 'ask',
        events: [{ at, kind: 'you', text: 'Check the page.' }],
      },
    ),
  );
  // More short sessions than a window holds, each newer than the agent's.
  for (let index = 0; index < 55; index++)
    await save(
      sessionRecord(
        `20261101T1100${String(index).padStart(2, '0')}000Z-s${String(index).padStart(8, '0')}`,
        'ended',
        { pid: null, processStart: null },
        { mode: 'tools', agent: coordinatorAgent },
      ),
    );
  const running = '20261101T120000000Z-s99999999';
  await save(
    sessionRecord(
      running,
      'running',
      {
        pid: side.pid ?? null,
        processStart: await processStart(side.pid ?? 0),
      },
      { mode: 'tools', agent: coordinatorAgent },
    ),
  );
  assert.deepEqual(
    (await loadPaused(root)).map((entry) => entry.id),
    [own],
  );
  const result = await reconcileSessions(root, 'new-owner');
  // Both windows are read: the agent's record and the side session's.
  assert.equal(result.interrupted, 2);
  assert.equal(result.stopped, 1);
  const status = async (id: string): Promise<unknown> =>
    (
      JSON.parse(await readFile(join(folder, `${id}.json`), 'utf8')) as {
        readonly status: unknown;
      }
    ).status;
  assert.equal(await status(agent), 'interrupted');
  assert.equal(await status(running), 'interrupted');
  await until(async () => (await processStart(side.pid ?? 0)) === null);
});

await test('Claude Code spend of the sessions adds up, across sessions', async (t) => {
  const lab = await rig(t);
  const store = lab.store;
  const record = (id: string, costUsd: number): SessionRecord =>
    ({ id, costUsd }) as SessionRecord;
  store.spent(record('one', 0.5));
  store.spent(record('one', 0.75));
  store.spent(record('two', 0.25));
  assert.equal(store.view().spend?.usd, 1);
});

// A whole lab, with fake harnesses.

interface Started {
  readonly id: string;
  readonly host: string;
  readonly agent: string;
  readonly prompt: string;
  readonly tools: AgentTools;
  readonly denyRead: readonly string[];
}

function fakeSlots(limit: number): {
  readonly sessions: LabSessions;
  readonly started: Started[];
  readonly resumed: { readonly id: string; readonly denyRead: unknown }[];
  readonly idle: Set<string>;
  readonly live: Set<string>;
} {
  const started: Started[] = [];
  const resumed: { readonly id: string; readonly denyRead: unknown }[] = [];
  const live = new Set<string>();
  const idle = new Set<string>();
  const sessions: LabSessions = {
    get full(): boolean {
      return live.size >= limit;
    },
    limit,
    view: (id) =>
      live.has(id)
        ? ({
            live: true,
            record: {
              id,
              status: idle.has(id) ? 'idle' : 'running',
              launches: [{ id: `run-${id}` }],
            },
          } as unknown as SessionView)
        : null,
    idle: (id) => idle.has(id),
    startAgent: (input) => {
      const id = `20261101T000000000Z-${String(started.length + 1).padStart(7, '0')}${limit % 10}`;
      started.push({
        id,
        host: input.host,
        agent: input.agent,
        prompt: input.prompt,
        tools: input.tools,
        denyRead: input.denyRead ?? [],
      });
      live.add(id);
      return Promise.resolve(id);
    },
    resumeAgent: (id, _tools, _network, denyRead) => {
      resumed.push({ id, denyRead });
      live.add(id);
      return Promise.resolve();
    },
    takeAgentTerminal: () => Promise.resolve(),
    park: (id) => {
      live.delete(id);
      idle.delete(id);
      return Promise.resolve(true);
    },
    continueTask: () => {},
    steer: () => false,
    endTask: (id) => {
      live.delete(id);
      idle.delete(id);
    },
  };
  return { sessions, started, resumed, idle, live };
}

async function project(t: TestContext, name = 'project'): Promise<string> {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-keeper-')),
  );
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(base, name);
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

let calls = 0;

interface Whole {
  readonly lab: Lab;
  readonly root: string;
  readonly agents: ReturnType<typeof fakeSlots>;
  readonly place: ReturnType<typeof fakeSlots>;
  /** What each run's sandbox denied. */
  readonly denied: string[][];
  readonly view: () => LabView;
  readonly call: (
    started: Started | undefined,
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ readonly ok: boolean; readonly text: string }>;
  readonly endTurn: (started: Started | undefined) => void;
  readonly wire: () => Promise<WireLab>;
}

const entry = (title: string): Record<string, unknown> => ({
  title,
  job: 'Tests',
  team: 'One',
  bar: 'It beats the control.',
  runs: 3,
  noise: '±0.02',
  buildsOn: [],
  harness: 'claude',
});

async function wholeLab(
  t: TestContext,
  limit = 1,
  name?: string,
): Promise<Whole> {
  const root = await project(t, name);
  const agents = fakeSlots(limit);
  const place = fakeSlots(1);
  const denied: string[][] = [];
  const lab = new Lab(root, {
    sessions: agents.sessions,
    reserved: place.sessions,
    sandbox: (spec) => {
      denied.push([...spec.denied]);
      return { file: '/bin/sh', args: ['-c', spec.command] };
    },
    harnesses: () => Promise.resolve(['claude', 'codex']),
    timing: {
      tickMs: 5,
      debounceMs: 5,
      continueMs: 60_000,
      objectionMs: 3_600_000,
      briefDelayMs: 0,
    },
  });
  t.after(() => lab.close());
  const view = (): LabView => {
    const shown = lab.view();
    assert.ok(shown);
    return shown;
  };
  const whole: Whole = {
    lab,
    root,
    agents,
    place,
    denied,
    view,
    call: (started, name, input) => {
      assert.ok(started);
      calls += 1;
      return started.tools.call(name, input, `call-${calls}`);
    },
    endTurn: (started) => {
      assert.ok(started);
      place.idle.add(started.id);
      lab.turnEnded(
        {
          id: started.id,
          agent: started.agent,
          status: 'idle',
          costUsd: 0.25,
        } as SessionRecord,
        'completed',
      );
    },
    wire: async () => {
      const shown = view();
      const reader = new ApiReader(() => ({
        root,
        lab: { view: () => shown },
        compute: undefined,
        session: () => null,
        away: () => Promise.resolve(null),
        works: [],
      }));
      return (JSON.parse((await reader.build()).json) as { lab: WireLab }).lab;
    },
  };
  await lab.start('Do months sit on a circle?', {});
  await until(() => agents.started.length > 0);
  const plan = await whole.call(agents.started[0], 'verifold_plan', {
    reading: 'How I read it.',
    cost: 'Nothing yet.',
    directions: [entry('First line'), entry('Second line')],
  });
  assert.equal(plan.ok, true, plan.text);
  return whole;
}

const isUpdate = (started: Started): boolean =>
  started.tools.specs.some((tool) => tool.name === 'verifold_brief');

await test('the Coordinator runs in its own place while every slot is taken, and nobody waits on it', async (t) => {
  const whole = await wholeLab(t);
  assert.equal(whole.agents.sessions.full, true);
  await until(() => whole.place.started.length > 0);
  const session = whole.place.started[0];
  assert.ok(session);
  assert.ok(isUpdate(session));
  assert.equal(session.agent, coordinatorAgent);
  // It denies what a checker denies, in its own folder: the lab's records, among them the brief.
  assert.ok(
    session.denyRead.some((path) => path.endsWith('/.verifold/lab')),
    session.denyRead.join('\n'),
  );
  assert.ok(
    session.denyRead.some((path) => path.endsWith('/.verifold/sessions')),
  );
  // A session that never answers holds up no agent: the agent works on.
  const agent = whole.agents.started[0];
  const posted = await whole.call(agent, 'verifold_post', {
    kind: 'ask',
    title: 'Which seed comes first in the test?',
    why: 'It sets the order of the work.',
    text: 'Which seed comes first?',
    mentions: ['person'],
  });
  assert.equal(posted.ok, true, posted.text);
});

await test('plain words reach the wire only once they passed, and never an agent', async (t) => {
  const whole = await wholeLab(t);
  await until(() => whole.place.started.length > 0);
  const agent = whole.agents.started[0];
  const posted = await whole.call(agent, 'verifold_post', {
    kind: 'ask',
    title: 'Which seed comes first in the test?',
    why: 'It sets the order of the work.',
    text: 'Seed 2 reached 64.5%. Which seed comes next?',
    mentions: ['person'],
  });
  assert.equal(posted.ok, true, posted.text);
  const id = /p-\d+/.exec(posted.text)?.[0] ?? '';
  const plain = 'A seed reached 64.5% in plain words.';
  const writer = whole.place.started[0];
  const brief = await whole.call(writer, 'verifold_brief', {
    lines: [{ kind: 'open', plain, posts: [id] }],
  });
  assert.equal(brief.ok, true, brief.text);
  let wire = await whole.wire();
  assert.equal(wire.brief?.lines[0]?.plain, null);
  assert.equal(
    wire.brief?.lines[0]?.quote,
    `Seed 2 reached 64.5%. Which seed comes next? (${id})`,
  );
  assert.equal(
    wire.brief?.lines[0]?.evidence,
    "One agent's post. No check yet.",
  );
  assert.equal(wire.brief?.lines[0]?.check.state, 'pending');
  assert.equal(wire.brief?.top, 'Two tests have not run yet.');
  whole.endTurn(writer);
  await until(() => whole.place.started.length > 1);
  const checker = whole.place.started[1];
  assert.equal(checker?.host, 'codex');
  const [line] = whole.view().brief?.brief?.lines ?? [];
  assert.ok(line);
  const checked = await whole.call(checker, 'verifold_line_check', {
    lines: [
      {
        id: line.id,
        claims: [{ claim: 'A seed reached 64.5%.', verdict: 'supported' }],
        dropped: [],
      },
    ],
  });
  assert.equal(checked.ok, true, checked.text);
  wire = await whole.wire();
  assert.equal(wire.brief?.lines[0]?.plain, plain);
  assert.deepEqual(wire.brief?.lines[0]?.check, {
    state: 'passed',
    by: 'codex',
    sameHarness: false,
  });
  assert.ok(wire.brief?.at);
  // Nothing an agent reads holds the plain words.
  const reads = await Promise.all(
    ['threads', 'summary', 'search'].map((view) =>
      whole.call(agent, 'verifold_board', { view, query: 'plain words' }),
    ),
  );
  for (const read of reads) assert.doesNotMatch(read.text, /plain words/);
  // Its harness cannot read them on disk either.
  const started = whole.agents.started[0];
  assert.ok(
    started?.denyRead.some((path) =>
      path.endsWith('/.verifold/lab/brief.json'),
    ),
  );
  assert.ok(
    started?.denyRead.some((path) => path.endsWith('/.verifold/sessions')),
  );
  // The record keeps its spend in the lab's total.
  whole.endTurn(checker);
  await until(() => whole.view().claudeUsd >= 0.25);
});

await test('the label comes from what agents posted, and a check post says how it checked', async (t) => {
  const whole = await wholeLab(t, 3);
  await until(
    () => whole.agents.started.length >= 2 && whole.place.started.length > 0,
  );
  const [first, second] = whole.agents.started;
  const [one, two] = whole.view().directions;
  assert.ok(one && two);
  await writeFile(
    join(whole.root, one.direction.workspace.path, 'out.txt'),
    '0.7\n',
  );
  const result = await whole.call(first, 'verifold_post', {
    kind: 'result',
    title: 'Does the control beat chance on all seeds?',
    why: 'It decides the next step.',
    text: 'Seed 2 reached 64.5%.',
    artifacts: [{ type: 'file', path: 'out.txt' }],
  });
  assert.equal(result.ok, true, result.text);
  const id = /p-\d+/.exec(result.text)?.[0] ?? '';
  await writeFile(
    join(whole.root, two.direction.workspace.path, 'audit.txt'),
    'read\n',
  );
  const audit = await whole.call(second, 'verifold_post', {
    kind: 'check',
    replyTo: id,
    outcome: 'fails',
    method: 'code-read',
    text: 'The code does not support this.',
    artifacts: [{ type: 'file', path: 'audit.txt' }],
  });
  assert.equal(audit.ok, true, audit.text);
  const brief = await whole.call(whole.place.started[0], 'verifold_brief', {
    lines: [
      { kind: 'failed', plain: 'A rerun overturned the 64.5%.', posts: [id] },
    ],
  });
  assert.equal(brief.ok, true, brief.text);
  // The writer said "rerun". The label says what the record holds.
  assert.equal(
    (await whole.wire()).brief?.lines[0]?.evidence,
    'Code check failed. No rerun.',
  );
});

await test('the person asks over the lab, and a pause ends the session and refuses a new question', async (t) => {
  const whole = await wholeLab(t);
  await until(() => whole.place.started.length > 0);
  await whole.lab.askCoordinator('Why this model?');
  assert.equal((await whole.wire()).questions?.[0]?.text, 'Why this model?');
  assert.equal((await whole.wire()).questions?.[0]?.state, 'waiting');
  await whole.lab.pause();
  assert.equal(whole.place.live.size, 0);
  await assert.rejects(
    whole.lab.askCoordinator('And now?'),
    /The lab is paused, so no session starts/,
  );
  await whole.lab.resume();
  // The question that waited gets its session again.
  await until(() => whole.place.started.length > 1);
  assert.match(whole.place.started[1]?.prompt ?? '', /Why this model\?/);
});

await test('Start over ends the session, and the next run has no brief of the last one', async (t) => {
  const whole = await wholeLab(t);
  await until(() => whole.place.started.length > 0);
  await whole.call(whole.place.started[0], 'verifold_brief', {
    lines: [{ kind: 'open', plain: 'It started.', posts: ['p-1'] }],
  });
  await whole.lab.suspend();
  assert.equal(whole.place.live.size, 0);
  const saved = JSON.parse(
    await readFile(join(whole.root, '.verifold', 'lab', 'brief.json'), 'utf8'),
  ) as { readonly brief: { readonly lines: readonly unknown[] } };
  assert.equal(saved.brief.lines.length, 1);
  await archiveRun(whole.root);
  await whole.lab.reload(true);
  assert.equal(whole.lab.view(), null);
  await startLabOn(whole.root, whole.lab, 'A new question?');
  assert.equal(whole.lab.view()?.brief?.brief, null);
});

await test('plain words stay out on a resume and in a run, not only on a fresh start', async (t) => {
  const whole = await wholeLab(t);
  await until(() => whole.place.started.length > 0);
  const agent = whole.agents.started[0];
  assert.ok(agent);
  const brief = join(whole.root, '.verifold', 'lab', 'brief.json');
  // A run that starts before the first brief still denies the file.
  await until(() => readFile(brief, 'utf8').then(Boolean, () => false));
  const run = await whole.call(agent, 'verifold_run', {
    command: 'true',
    why: 'A test of the sandbox.',
  });
  assert.equal(run.ok, true, run.text);
  await until(() => whole.denied.length > 0);
  assert.ok(whole.denied[0]?.includes(brief), whole.denied[0]?.join('\n'));
  await whole.lab.pause();
  await mkdir(join(whole.root, '.verifold', 'sessions'), { recursive: true });
  await writeFile(
    join(whole.root, '.verifold', 'sessions', `${agent.id}.json`),
    JSON.stringify(
      sessionRecord(
        agent.id,
        'paused',
        { pid: null, processStart: null },
        {
          agent: agent.agent,
          reportedMode: 'default',
          cwd: whole.view().directions[0]?.direction.workspace.path ?? '',
        },
      ),
    ),
  );
  await whole.lab.resume();
  await until(() => whole.agents.resumed.length > 0);
  const denied = whole.agents.resumed[0]?.denyRead as readonly string[];
  assert.ok(denied.includes(brief));
  assert.ok(denied.includes(join(whole.root, '.verifold', 'sessions')));
  // A title for the person is plain words too.
  assert.ok(
    denied.includes(join(whole.root, '.verifold', 'lab', 'threads.json')),
  );
});

await test('a move changes the snapshot, and a title for the person stays out of what agents read', async (t) => {
  const whole = await wholeLab(t);
  await until(() => whole.place.started.length > 0);
  const agent = whole.agents.started[0];
  const writer = whole.place.started[0];
  const posted = await whole.call(agent, 'verifold_post', {
    kind: 'ask',
    title: 'Which seed comes first in the test?',
    why: 'It sets the order of the work.',
    text: 'Which seed comes first?',
    mentions: ['person'],
  });
  const thread = /t-\d+/.exec(posted.text)?.[0] ?? '';
  const mine = await whole.lab.post({ text: 'A note on the seeds.' });
  const view = (): LabView => whole.view();
  const reader = new ApiReader(() => ({
    root: whole.root,
    lab: { view },
    compute: undefined,
    session: () => null,
    away: () => Promise.resolve(null),
    works: [],
  }));
  const before = await reader.signal();
  const moved = await whole.call(writer, 'verifold_thread', {
    action: 'move',
    thread,
    post: mine.id,
  });
  assert.equal(moved.ok, true, moved.text);
  const after = await reader.signal();
  assert.ok(after.some((part, index) => part !== before[index]));
  const title = 'Which seed should run first?';
  const retitled = await whole.call(writer, 'verifold_thread', {
    action: 'title',
    thread,
    title,
  });
  assert.equal(retitled.ok, true, retitled.text);
  const wire = await whole.wire();
  assert.equal(
    wire.threads?.find((entry) => entry.id === thread)?.plainTitle,
    title,
  );
  const reads = await Promise.all(
    ['threads', 'summary'].map((name) =>
      whole.call(agent, 'verifold_board', { view: name }),
    ),
  );
  for (const read of reads) assert.ok(!read.text.includes(title), read.text);
  whole.endTurn(writer);
});

await test('a project path that deny rules cannot express keeps no plain words, and says so once', async (t) => {
  const whole = await wholeLab(t, 1, 'pro[ject');
  await until(() => whole.place.started.length > 0);
  const writer = whole.place.started[0];
  assert.match(writer?.prompt ?? '', /This lab keeps no plain words/);
  const notes = whole.view().posts.filter((post) => post.key === 'plain-off');
  assert.equal(notes.length, 1);
  // Nothing plain exists, so no deny rule pretends to close it.
  assert.deepEqual(whole.agents.started[0]?.denyRead, []);
  const brief = await whole.call(writer, 'verifold_brief', {
    lines: [{ kind: 'open', posts: ['p-1'] }],
  });
  assert.equal(brief.ok, true, brief.text);
  const line = (await whole.wire()).brief?.lines[0];
  assert.equal(line?.plain, null);
  assert.equal(line?.check.state, 'withheld');
  assert.ok(line?.quote);
});

await test('the reserved place holds one session, with no built-in tools, in the folder that a session record accepts', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-place-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
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
  const claude = join(root, 'fake-claude');
  await writeFile(
    claude,
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request')
    return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'fake-model', permissionMode: 'default' });
  out({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
});`,
    { mode: 0o700 },
  );
  const ended: SessionRecord[] = [];
  const pool = new SessionPool(root, {
    clientVersion: 'test',
    ownerId: 'test-owner',
    executables: { claude, codex: claude },
    agents: 1,
    onTurnEnd: (record) => ended.push(record),
  });
  t.after(() => pool.close());
  const folder = join(root, '.verifold', 'checks', 'lab-record');
  await mkdir(folder, { recursive: true });
  const start = (): Promise<string> =>
    pool.startAgent({
      host: 'claude',
      prompt: 'Keep the record.',
      cwd: folder,
      agent: coordinatorAgent,
      tools: {
        specs: labCoordinatorToolSpecs,
        call: () => Promise.resolve({ ok: true, text: '' }),
      },
      toolsOnly: true,
      side: true,
    });
  const id = await start();
  assert.match(id, /-s[a-f0-9]{8}$/);
  assert.equal(pool.full, true);
  await assert.rejects(start(), PoolFullError);
  await until(() => ended.some((record) => record.status === 'idle'));
  assert.equal(pool.view(id)?.record.mode, 'tools');
  assert.equal(pool.view(id)?.record.cwd, '.verifold/checks/lab-record');
  await assert.rejects(
    pool.takeAgentTerminal(id, 'lease'),
    /This session has no terminal/,
  );
  const args = JSON.parse(
    await readFile(join(folder, 'args.json'), 'utf8'),
  ) as string[];
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.match(args.join(' '), /mcp__verifold__verifold_brief/);
  // Only agents and checkers get the plugin of added skills, the live web, and a strict sandbox.
  assert.equal(args.includes('--plugin-dir'), false);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
});

await test('a lab from before threads has no Coordinator, no brief, and the deny list that it had', async (t) => {
  const whole = await wholeLab(t);
  await whole.lab.close();
  const path = join(whole.root, '.verifold', 'lab.json');
  const saved = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(path, JSON.stringify({ ...saved, roles: null }));
  const agents = fakeSlots(3);
  const place = fakeSlots(1);
  const lab = new Lab(whole.root, {
    sessions: agents.sessions,
    reserved: place.sessions,
    timing: { tickMs: 5, debounceMs: 5, continueMs: 60_000, briefDelayMs: 0 },
  });
  t.after(() => lab.close());
  await lab.load();
  assert.equal(lab.view()?.brief, undefined);
  await assert.rejects(
    lab.askCoordinator('Hello?'),
    /A lab from before threads has no Coordinator/,
  );
  lab.personBack('2026-11-01T09:00:00.000Z');
  lab.resumeAll();
  await until(() => agents.started.length > 0);
  assert.equal(place.started.length, 0);
  assert.deepEqual(agents.started[0]?.denyRead, []);
});
