import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardAgent, Post } from '../src/core/board.ts';
import {
  citedDispute,
  openObjections,
  refutation,
  shapePost,
  wakeList,
  type PostContext,
  type PostShape,
} from '../src/core/lab/post-rules.ts';
import type { Check, Thread } from '../src/core/lab/schema.ts';
import { planThreadRecord } from '../src/core/lab/threads.ts';
import { openWaits } from '../src/core/lab/waits.ts';

const at = '2026-11-01T10:00:00.000Z';

function post(id: string, more: Partial<Post> = {}): Post {
  return {
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
  };
}

const thread = (id: string, more: Partial<Thread> = {}): Thread => ({
  id,
  title: 'Does the control beat chance?',
  state: 'open',
  why: 'The bar rests on it.',
  openedBy: 'a-1',
  at,
  followers: [],
  agreed: [],
  ...more,
});

const board = new Map<string, Post>([
  ['p-1', post('p-1')],
  ['p-2', post('p-2', { kind: 'ask', author: 'a-2', mentions: ['a-1'] })],
  ['p-3', post('p-3', { kind: 'objection', author: 'a-2', replyTo: 'p-1' })],
  ['p-4', post('p-4', { kind: 'question', author: 'person', thread: 't-1' })],
  ['p-5', post('p-5', { thread: 't-3' })],
  ['p-6', post('p-6', { author: 'a-3', thread: 't-2' })],
]);

const context = (more: Partial<PostContext> = {}): PostContext => ({
  author: 'a-2',
  kind: 'result',
  mentions: [],
  proof: 1,
  post: (id) => board.get(id),
  threads: [
    planThreadRecord(at),
    thread('t-2'),
    thread('t-3', { state: 'closed', title: 'An old closed subject' }),
  ],
  working: ['a-1', 'a-2'],
  name: (author) => (author === 'a-3' ? 'agent-3' : author),
  ...more,
});

const shaped = (
  args: Record<string, unknown>,
  more: Partial<PostContext> = {},
): PostShape => shapePost(args, context(more));

await test('a reply always has a legal form: a closed thread opens for a kind that needs its reply, and a lost thread takes a title', () => {
  const closedTarget = { replyTo: 'p-5' };
  for (const kind of ['objection', 'answer', 'check'] as const)
    assert.deepEqual(
      shaped(
        { ...closedTarget, ...(kind === 'check' ? { outcome: 'holds' } : {}) },
        {
          kind,
          post: (id) =>
            id === 'p-5'
              ? post('p-5', { thread: 't-3', kind: 'ask', author: 'a-1' })
              : board.get(id),
        },
      ).thread,
      't-3',
      kind,
    );
  assert.throws(
    () => shaped(closedTarget),
    /t-3 is closed\. Leave replyTo out, open a new thread with title and why, and name p-5/,
  );
  const lost = post('p-7', { thread: 't-8' });
  const lostAt = (id: string): Post | undefined =>
    id === 'p-7' ? lost : board.get(id);
  assert.throws(
    () => shaped({ replyTo: 'p-7' }, { post: lostAt }),
    /t-8 has no record now\. Give title and why/,
  );
  assert.deepEqual(
    shaped(
      {
        replyTo: 'p-7',
        title: 'Does the old result still stand?',
        why: 'Why.',
      },
      { post: lostAt },
    ).thread,
    { title: 'Does the old result still stand?', why: 'Why.' },
  );
  assert.equal(
    shaped({ replyTo: 'p-7', thread: 't-2' }, { post: lostAt }).thread,
    't-2',
  );
});

await test('a post names a thread or opens one, and a reply stays in its target’s thread', () => {
  assert.deepEqual(shaped({ thread: 't-2' }), { thread: 't-2' });
  assert.deepEqual(
    shaped({
      title: 'Does topic imbalance explain the gap?',
      why: 'Controls\nneed it.',
    }),
    {
      thread: {
        title: 'Does topic imbalance explain the gap?',
        why: 'Controls need it.',
      },
    },
  );
  assert.throws(() => shaped({}), /Give thread to post in a thread, or title/);
  assert.throws(() => shaped({ thread: 't-9' }), /No thread t-9 is in the lab/);
  assert.throws(
    () => shaped({ thread: 't-3' }),
    /t-3 is closed\. Open a new thread/,
  );
  assert.deepEqual(shaped({ replyTo: 'p-1' }), { thread: 't-2' });
  assert.throws(
    () => shaped({ replyTo: 'p-1', thread: 't-1' }),
    /A reply stays in its target's thread\. p-1 is in t-2/,
  );
  assert.throws(
    () => shaped({ replyTo: 'p-1', title: 'A new subject for this reply' }),
    /Leave title out/,
  );
  assert.throws(() => shaped({ replyTo: 'p-99' }), /No post p-99 is on/);
});

await test('a title says what the thread is about', () => {
  const title = (value: string): PostShape =>
    shaped({ title: value, why: 'One line.' });
  for (const empty of [
    'Update',
    'Results of d-2',
    'p-12',
    'Status update',
    'Seed 3',
  ])
    assert.throws(() => title(empty), /a specific plain question/, empty);
  assert.throws(
    () => title('Does the CONTROL beat chance?'),
    /t-2 has this title\. Post there/,
  );
  assert.throws(
    () => shaped({ title: 'A real subject' }),
    /Write one line on why it matters/,
  );
  // A closed thread leaves its title free.
  assert.ok(title('An old closed subject'));
});

await test('each kind refuses the wrong shape and says what to change', () => {
  const kind = (
    name: PostContext['kind'],
    args: Record<string, unknown>,
    more: Partial<PostContext> = {},
  ): PostShape => shaped({ thread: 't-2', ...args }, { kind: name, ...more });
  assert.throws(() => kind('result', {}, { proof: 0 }), /A result needs proof/);
  assert.throws(
    () => kind('ruled-out', {}, { proof: 0 }),
    /A ruled-out post needs proof/,
  );

  assert.throws(
    () => kind('check', {}),
    /names the post that it tests\. Give replyTo/,
  );
  assert.throws(
    () => kind('check', { replyTo: 'p-1' }),
    /gives an outcome: holds or fails/,
  );
  assert.throws(
    () => kind('check', { replyTo: 'p-1', outcome: 'fails' }, { proof: 0 }),
    /A check needs proof/,
  );
  assert.throws(
    () => kind('check', { replyTo: 'p-3', outcome: 'holds' }),
    /tests the work of another author/,
  );
  assert.deepEqual(kind('check', { replyTo: 'p-1', outcome: 'fails' }), {
    thread: 't-2',
    outcome: 'fails',
  });
  assert.throws(
    () => kind('result', { outcome: 'fails' }),
    /Only a check gives an outcome/,
  );
  assert.throws(
    () => kind('check', { replyTo: 'p-1', outcome: 'maybe' }),
    /An outcome is holds or fails/,
  );

  assert.throws(() => kind('ask', {}), /An ask names one agent or the person/);
  assert.throws(
    () => kind('ask', {}, { mentions: ['a-1', 'person'] }),
    /exactly one name/,
  );
  assert.throws(
    () => kind('ask', {}, { mentions: ['a-3'] }),
    /agent-3 does not work now/,
  );
  assert.ok(kind('ask', {}, { mentions: ['person'], proof: 0 }));

  assert.throws(() => kind('answer', {}, { proof: 0 }), /Give replyTo/);
  assert.throws(
    () => kind('answer', { replyTo: 'p-1' }, { proof: 0 }),
    /p-1 is a result post, so no answer replies to it\. Use verifold_agree/,
  );
  assert.ok(kind('answer', { replyTo: 'p-2' }, { proof: 0 }));
  assert.ok(
    kind('answer', { replyTo: 'p-4', thread: undefined }, { proof: 0 }),
  );

  assert.throws(() => kind('objection', {}), /names the post that it targets/);
  assert.ok(kind('objection', { replyTo: 'p-1' }, { proof: 0 }));
  assert.ok(kind('proposal', {}, { proof: 0 }));
});

await test('only the author of the target or of the objection accepts it', () => {
  const accept = (author: string, replyTo = 'p-3'): PostShape =>
    shapePost(
      { replyTo, accepts: true },
      context({ author, kind: 'answer', proof: 0 }),
    );
  assert.equal(accept('a-1').accepts, true);
  assert.equal(accept('a-2').accepts, true);
  assert.throws(() => accept('a-3'), /Only the author of p-1 or of p-3/);
  assert.throws(
    () => accept('a-1', 'p-2'),
    /Only an answer to an objection gives accepts/,
  );
  assert.throws(
    () => shaped({ thread: 't-2', accepts: true }),
    /Only an answer to an objection/,
  );
});

const agents: readonly BoardAgent[] = Array.from(
  { length: 20 },
  (_, index) => ({
    id: `a-${index + 1}`,
    direction: `d-${index + 1}`,
  }),
);

const wakes = (
  entry: Post,
  more: { target?: Post; thread?: Thread } = {},
): readonly string[] =>
  wakeList(entry, {
    target: more.target,
    thread: more.thread,
    agents,
  });

await test('at 20 agents a post of an agent wakes at most the one agent that it names', () => {
  const target = post('p-1', { author: 'a-4', direction: 'd-4' });
  const followers = agents.map((agent) => agent.id);
  const inThread = thread('t-2', { followers });
  for (const kind of ['result', 'check', 'proposal', 'ruled-out'] as const)
    assert.deepEqual(
      wakes(post('p-9', { kind, author: 'a-2', mentions: ['a-3'] }), {
        target,
        thread: inThread,
      }),
      [],
      kind,
    );
  assert.deepEqual(
    wakes(post('p-9', { kind: 'objection', author: 'a-2' }), {
      target,
      thread: inThread,
    }),
    ['a-4'],
  );
  assert.deepEqual(
    wakes(post('p-9', { kind: 'ask', author: 'a-2', mentions: ['a-5'] }), {
      thread: inThread,
    }),
    ['a-5'],
  );
  assert.deepEqual(
    wakes(post('p-9', { kind: 'ask', author: 'a-2', mentions: ['person'] })),
    [],
  );
  assert.deepEqual(
    wakes(post('p-9', { kind: 'answer', author: 'a-2' }), {
      target,
      thread: inThread,
    }),
    ['a-4'],
  );
  // An agent's own post never wakes it.
  assert.deepEqual(
    wakes(post('p-9', { kind: 'objection', author: 'a-4' }), { target }),
    [],
  );
  // A checker wrote the target, so the owner of its direction hears the objection.
  assert.deepEqual(
    wakes(post('p-9', { kind: 'objection', author: 'a-2' }), {
      target: post('p-1', { author: 'a-99', direction: 'd-7', kind: 'rerun' }),
    }),
    ['a-7'],
  );
});

await test('a plan, a rerun, and a note of Verifold wake who they mention', () => {
  for (const entry of [
    post('p-9', { kind: 'plan', mentions: ['a-2', 'a-3'] }),
    post('p-9', { kind: 'rerun', author: 'a-99', mentions: ['a-2', 'a-3'] }),
    post('p-9', {
      kind: 'status',
      author: 'verifold',
      mentions: ['a-2', 'a-3'],
    }),
  ])
    assert.deepEqual(wakes(entry), ['a-2', 'a-3']);
});

await test("the person's words wake followers, or who they name, or every agent", () => {
  const person = (more: Partial<Post>): Post =>
    post('p-9', { kind: 'question', author: 'person', ...more });
  const plan = planThreadRecord(at);
  assert.equal(wakes(person({ thread: 't-1' }), { thread: plan }).length, 20);
  assert.equal(
    wakes(person({ thread: 't-2', mentions: ['all'] }), {
      thread: thread('t-2'),
    }).length,
    20,
  );
  assert.deepEqual(
    wakes(person({ thread: 't-1', mentions: ['a-3'] }), { thread: plan }),
    ['a-3'],
  );
  assert.deepEqual(
    wakes(person({ thread: 't-1', direction: 'd-2' }), { thread: plan }),
    ['a-2'],
  );
  // A reply to the plan reaches the planner, not every agent.
  assert.deepEqual(
    wakes(person({ thread: 't-1', replyTo: 'p-1' }), {
      thread: plan,
      target: post('p-1', { author: 'a-1', kind: 'plan' }),
    }),
    ['a-1'],
  );
  const followed = thread('t-2', { followers: ['a-2', 'a-3'] });
  assert.deepEqual(wakes(person({ thread: 't-2' }), { thread: followed }), [
    'a-2',
    'a-3',
  ]);
  assert.deepEqual(
    wakes(person({ thread: 't-2', mentions: ['a-9'] }), { thread: followed }),
    ['a-9'],
  );
  // With no live follower, the words reach every agent that works.
  assert.equal(
    wakes(person({ thread: 't-2' }), {
      thread: thread('t-2', { followers: ['a-77'] }),
    }).length,
    20,
  );
  assert.equal(
    wakes(person({ thread: 't-2', mentions: ['a-77'] }), {
      thread: thread('t-2'),
    }).length,
    20,
  );
});

const objection = post('p-2', {
  kind: 'objection',
  author: 'a-2',
  replyTo: 'p-1',
});

const doneCheck = (objections: readonly string[]): Check =>
  ({ state: 'done', objections }) as unknown as Check;

await test('an objection stands until an answer accepts it, a third agent’s check holds its target, or a check of Verifold ends', () => {
  const target = post('p-1');
  const open = (...more: readonly Post[]): readonly string[] =>
    (openObjections([target, objection, ...more], []).get('p-1') ?? []).map(
      (entry) => entry.id,
    );
  assert.deepEqual(open(), ['p-2']);
  assert.deepEqual(
    open(post('p-3', { kind: 'answer', replyTo: 'p-2' })),
    ['p-2'],
    'An answer that does not accept leaves it.',
  );
  assert.deepEqual(
    open(post('p-3', { kind: 'answer', replyTo: 'p-2', accepts: true })),
    [],
  );
  // A check that fails clears nothing, so the refuted post stays disputed.
  assert.deepEqual(
    open(
      post('p-3', {
        kind: 'check',
        author: 'a-3',
        replyTo: 'p-1',
        outcome: 'fails',
      }),
    ),
    ['p-2'],
  );
  assert.deepEqual(
    open(
      post('p-3', {
        kind: 'check',
        author: 'a-3',
        replyTo: 'p-1',
        outcome: 'holds',
      }),
    ),
    [],
  );
  // The objector, and the target's author, cannot clear it with a check.
  assert.deepEqual(
    open(
      post('p-3', {
        kind: 'check',
        author: 'a-2',
        replyTo: 'p-1',
        outcome: 'holds',
      }),
    ),
    ['p-2'],
  );
  assert.deepEqual(
    open(
      post('p-3', {
        kind: 'check',
        author: 'a-1',
        replyTo: 'p-1',
        outcome: 'holds',
      }),
    ),
    ['p-2'],
  );
  // A check clears only the objections before it, and each objector's own stays.
  assert.deepEqual(
    open(
      post('p-3', {
        kind: 'objection',
        author: 'a-3',
        replyTo: 'p-1',
      }),
      post('p-4', {
        kind: 'check',
        author: 'a-3',
        replyTo: 'p-1',
        outcome: 'holds',
      }),
      post('p-5', { kind: 'objection', author: 'a-4', replyTo: 'p-1' }),
    ),
    ['p-3', 'p-5'],
  );
  assert.equal(
    openObjections([target, objection], [doneCheck(['p-2'])]).size,
    0,
  );
  // Answers to one objection leave the others.
  assert.deepEqual(
    open(
      post('p-3', { kind: 'objection', replyTo: 'p-1' }),
      post('p-4', { kind: 'answer', replyTo: 'p-2', accepts: true }),
    ),
    ['p-3'],
  );
});

await test('a check that failed backs no verdict, and neither does the post that it failed', () => {
  const target = post('p-1');
  const failed = post('p-2', {
    kind: 'check',
    author: 'a-3',
    replyTo: 'p-1',
    outcome: 'fails',
  });
  const held = post('p-3', { kind: 'check', replyTo: 'p-9', outcome: 'holds' });
  assert.match(
    refutation(failed, [target, failed]) ?? '',
    /p-2 is a check that failed/,
  );
  assert.match(
    refutation(target, [target, failed]) ?? '',
    /p-1 failed the check p-2/,
  );
  assert.equal(refutation(target, [target, held]), null);
  assert.equal(refutation(held, [target, held]), null);
});

await test('a post that builds on a disputed post says so', () => {
  const disputed = new Set(['p-1']);
  assert.equal(citedDispute(post('p-5', { replyTo: 'p-1' }), disputed), 'p-1');
  assert.equal(
    citedDispute(post('p-5', { text: 'We reuse p-1 here.' }), disputed),
    'p-1',
  );
  assert.equal(
    citedDispute(post('p-5', { text: 'Not p-12.' }), disputed),
    null,
  );
  assert.equal(citedDispute(objection, disputed), null);
  assert.equal(citedDispute(post('p-1', { text: 'p-1' }), disputed), null);
});

await test('waits come from the record: who waits on whom, for what, since when', () => {
  const ask = post('p-2', {
    kind: 'ask',
    author: 'a-2',
    mentions: ['a-1'],
    at: '2026-11-01T11:00:00.000Z',
  });
  const toPerson = post('p-3', {
    kind: 'ask',
    author: 'a-2',
    thread: 't-3',
    mentions: ['person'],
  });
  const doubt = post('p-4', {
    kind: 'objection',
    author: 'a-3',
    replyTo: 'p-1',
  });
  const posts = [post('p-1'), ask, toPerson, doubt];
  const waits = (...more: readonly Post[]): readonly string[] =>
    openWaits([...posts, ...more], [thread('t-2')]).map(
      (wait) => `${wait.waiter} on ${wait.on}: ${wait.post} ${wait.reason}`,
    );
  assert.deepEqual(openWaits(posts, [])[0], {
    waiter: 'a-2',
    on: 'a-1',
    post: 'p-2',
    reason: 'ask',
    thread: 't-2',
    since: '2026-11-01T11:00:00.000Z',
  });
  assert.deepEqual(waits(), [
    'a-2 on a-1: p-2 ask',
    'a-2 on person: p-3 ask',
    'a-3 on a-1: p-4 objection',
  ]);
  assert.deepEqual(waits(post('p-5', { kind: 'answer', replyTo: 'p-2' })), [
    'a-2 on person: p-3 ask',
    'a-3 on a-1: p-4 objection',
  ]);
  // The person replies with a message, not with an answer.
  assert.deepEqual(
    waits(post('p-5', { kind: 'question', author: 'person', replyTo: 'p-3' })),
    ['a-2 on a-1: p-2 ask', 'a-3 on a-1: p-4 objection'],
  );
  assert.deepEqual(waits(post('p-5', { kind: 'answer', replyTo: 'p-4' })), [
    'a-2 on a-1: p-2 ask',
    'a-2 on person: p-3 ask',
  ]);
  // A check that holds ends the wait on an objection, and one that fails does not.
  assert.deepEqual(
    waits(post('p-5', { kind: 'check', replyTo: 'p-1', outcome: 'holds' })),
    ['a-2 on a-1: p-2 ask', 'a-2 on person: p-3 ask'],
  );
  assert.equal(
    waits(post('p-5', { kind: 'check', replyTo: 'p-1', outcome: 'fails' }))
      .length,
    3,
  );
  assert.deepEqual(
    waits(post('p-5', { kind: 'rerun', replyTo: 'p-1', author: 'a-9' })),
    ['a-2 on a-1: p-2 ask', 'a-2 on person: p-3 ask'],
  );
  // A closed thread ends its waits.
  assert.deepEqual(
    openWaits(posts, [thread('t-3', { state: 'closed' })]).map(
      (wait) => wait.post,
    ),
    ['p-2', 'p-4'],
  );
  // An objection to a note of Verifold, or to one's own post, waits on no one.
  assert.deepEqual(
    openWaits(
      [
        post('p-1', { author: 'verifold', kind: 'status' }),
        post('p-2', { kind: 'objection', replyTo: 'p-1' }),
        post('p-3', { author: 'a-2' }),
        post('p-4', { kind: 'objection', author: 'a-2', replyTo: 'p-3' }),
      ],
      [],
    ),
    [],
  );
});
