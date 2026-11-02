import test from 'node:test';
import assert from 'node:assert/strict';
import type { Post } from '../src/core/board.ts';
import type { Lease } from '../src/core/leases.ts';
import { collabOf } from '../src/core/lab/collab.ts';
import { noticeStands } from '../src/core/lab/coordinator-rules.ts';
import type { Call, Check, Thread } from '../src/core/lab/schema.ts';
import type { RunRecord } from '../src/core/runs.ts';
import { agentRunStates } from '../src/server/lab-threads.ts';

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 10, 1, 16, minute)).toISOString();

let number = 0;
const post = (more: Partial<Post>): Post => ({
  schemaVersion: 1,
  id: `p-${++number}`,
  at: at(number),
  author: 'a-1',
  kind: 'result',
  text: 'A post.',
  mentions: [],
  artifacts: [],
  thread: 't-2',
  ...more,
});

const check = (more: Partial<Check>): Check =>
  ({
    id: 'k-1',
    claim: 'p-1',
    objections: [],
    state: 'queued',
    ...more,
  }) as Check;

const run = (more: Partial<RunRecord>): RunRecord =>
  ({
    id: 'r-1',
    agent: 'a-1',
    direction: 'd-1',
    status: 'done',
    where: { pod: 'lease-1', gpu: 'A100' },
    queuedAt: at(0),
    startedAt: at(0),
    endedAt: at(5),
    ...more,
  }) as RunRecord;

const records = (
  more: Partial<Parameters<typeof collabOf>[0]>,
): Parameters<typeof collabOf>[0] => ({
  posts: [],
  threads: [],
  checks: [],
  calls: [],
  runs: [],
  leases: [],
  ...more,
});

await test('it counts objections, who raised them, and which led to a change, and no other post', () => {
  const target = post({});
  const first = post({ kind: 'objection', author: 'a-3', replyTo: target.id });
  const second = post({ kind: 'objection', author: 'a-3', replyTo: target.id });
  const third = post({ kind: 'objection', author: 'a-2', replyTo: target.id });
  const taken = post({ kind: 'objection', author: 'a-2', replyTo: target.id });
  const { objections } = collabOf(
    records({
      posts: [
        target,
        first,
        second,
        third,
        taken,
        post({ kind: 'answer', accepts: true, replyTo: first.id }),
        post({ kind: 'answer', replyTo: second.id }),
        post({}),
        post({}),
      ],
      checks: [check({ objections: [taken.id], state: 'running' })],
    }),
  );
  assert.deepEqual(objections, {
    total: 4,
    accepted: 1,
    unanswered: 1,
    by: [
      { author: 'a-3', count: 2 },
      { author: 'a-2', count: 2 },
    ],
  });
});

await test('an open disagreement names its post, its objections, and its newest check', () => {
  const target = post({});
  const objection = post({
    kind: 'objection',
    author: 'a-3',
    replyTo: target.id,
  });
  const settled = post({});
  const ended = post({
    kind: 'objection',
    author: 'a-2',
    replyTo: settled.id,
  });
  const { disagreements } = collabOf(
    records({
      posts: [
        target,
        objection,
        settled,
        ended,
        post({ kind: 'answer', accepts: true, replyTo: ended.id }),
        post({ kind: 'answer', author: target.author, replyTo: objection.id }),
      ],
      checks: [
        check({ id: 'k-1', claim: target.id, state: 'failed' }),
        check({ id: 'k-2', claim: target.id, state: 'running' }),
        check({ id: 'k-3', claim: target.id, state: 'dropped' }),
      ],
    }),
  );
  assert.equal(disagreements.length, 1);
  assert.equal(disagreements[0]?.post.id, target.id);
  assert.deepEqual(
    disagreements[0]?.objections.map(({ id }) => id),
    [objection.id],
  );
  assert.equal(disagreements[0]?.answered, true);
  assert.equal(disagreements[0]?.check?.id, 'k-2');
});

await test('who needs whom says when the one that it needs waits on the person', () => {
  const threads = [{ id: 't-2', state: 'open' }] as Thread[];
  const onThree = post({ kind: 'ask', author: 'a-4', mentions: ['a-3'] });
  const onTwo = post({ kind: 'ask', author: 'a-3', mentions: ['a-2'] });
  const { needs } = collabOf(
    records({
      posts: [onThree, onTwo],
      threads,
      calls: [
        { id: 'c-1', state: 'open', by: 'a-2', joined: [] },
        { id: 'c-2', state: 'answered', by: 'a-3', joined: [] },
      ] as unknown as Call[],
    }),
  );
  assert.deepEqual(
    needs.map(({ waiter, on, blocked }) => [waiter, on, blocked]),
    [
      ['a-4', 'a-3', false],
      ['a-3', 'a-2', true],
    ],
  );
});

await test('the GPU queue holds pod runs and pods, and the newest free stretch', () => {
  const { gpu } = collabOf(
    records({
      runs: [
        run({ id: 'r-1' }),
        run({ id: 'r-2', startedAt: at(8), endedAt: at(9) }),
        run({ id: 'r-3', startedAt: at(30), endedAt: at(40) }),
        run({ id: 'r-4', startedAt: at(45), endedAt: null, status: 'running' }),
        run({
          id: 'r-5',
          agent: 'a-3',
          startedAt: null,
          endedAt: null,
          status: 'queued',
        }),
        run({ id: 'r-6', where: 'local', status: 'queued', startedAt: null }),
      ],
      leases: [
        { id: 'lease-1', state: 'ready' },
        { id: 'lease-2', state: 'requested' },
        { id: 'lease-3', state: 'ended' },
      ] as Lease[],
    }),
  );
  assert.deepEqual(
    gpu.running.map(({ id }) => id),
    ['r-4'],
  );
  assert.deepEqual(
    gpu.queued.map(({ id }) => id),
    ['r-5'],
  );
  assert.deepEqual(
    gpu.requested.map(({ id }) => id),
    ['lease-2'],
  );
  assert.deepEqual(
    gpu.pods.map(({ id }) => id),
    ['lease-1'],
  );
  // 8 minutes after r-1 is the time that a start takes. 21 minutes is not.
  assert.deepEqual(gpu.idle, { from: at(9), to: at(30) });
});

await test('a lab with no records has nothing to say', () => {
  const collab = collabOf(records({}));
  assert.deepEqual(collab.disagreements, []);
  assert.deepEqual(collab.needs, []);
  assert.equal(collab.objections.total, 0);
  assert.equal(collab.gpu.idle, null);
});

await test('a notice stops showing when the record no longer holds it', () => {
  const answered = {
    kind: 'missing-answer',
    posts: ['p-1'],
    to: ['a-1'],
  } as const;
  const works = new Set(['a-1', 'a-2']);
  assert.equal(noticeStands(answered, [{ post: 'p-1' }], works), true);
  assert.equal(noticeStands(answered, [{ post: 'p-9' }], works), false);
  const overlap = {
    kind: 'overlap',
    posts: ['p-1'],
    to: ['a-1', 'a-2'],
  } as const;
  assert.equal(noticeStands(overlap, [], works), true);
  assert.equal(noticeStands(overlap, [], new Set(['a-1'])), false);
  assert.equal(
    noticeStands({ kind: 'no-search', posts: ['p-1'], to: [] }, [], works),
    true,
  );
});

await test('each agent has one run fact from the whole ledger', () => {
  const states = agentRunStates([
    run({ id: 'r-1', agent: 'a-1', endedAt: at(5), status: 'done' }),
    run({ id: 'r-2', agent: 'a-1', endedAt: at(9), status: 'done' }),
    run({ id: 'r-3', agent: 'a-1', endedAt: at(7), status: 'failed' }),
    run({ id: 'r-4', agent: 'a-2', endedAt: null, status: 'running' }),
    run({ id: 'r-5', agent: 'a-3', endedAt: null, status: 'queued' }),
  ]);
  assert.deepEqual(states.get('a-1'), {
    active: false,
    ended: { run: 'r-2', at: at(9) },
  });
  assert.deepEqual(states.get('a-2'), { active: true, ended: null });
  assert.equal(states.get('a-3')?.active, true);
  assert.equal(states.get('a-4'), undefined);
});
