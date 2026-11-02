import test from 'node:test';
import assert from 'node:assert/strict';
import type { Post } from '../src/core/board.ts';
import {
  briefTop,
  evidenceLabel,
  evidencePosts,
  plainNumbersMatch,
  quotesOf,
  stateKey,
  strayNumbers,
  type TopRecords,
} from '../src/core/lab/brief.ts';
import { shapePost, type PostContext } from '../src/core/lab/post-rules.ts';
import type { Check } from '../src/core/lab/schema.ts';

const at = '2026-11-01T10:00:00.000Z';

function post(id: string, text: string, more: Partial<Post> = {}): Post {
  return {
    schemaVersion: 1,
    id,
    at,
    author: 'a-1',
    kind: 'result',
    text,
    mentions: [],
    artifacts: [],
    ...more,
  };
}

type Fact = Parameters<typeof evidenceLabel>[1][number];

function check(more: Partial<Check> = {}): Fact {
  return {
    state: 'done',
    objections: [],
    claim: 'p-1',
    result: null,
    queuedAt: at,
    endedAt: at,
    method: 'rerun',
    outcome: 'holds',
    sameHarness: false,
    blind: true,
    ...more,
  };
}

const direction = (
  id: string,
  verdict: TopRecords['directions'][number]['verdict'] = 'open',
  state: TopRecords['directions'][number]['state'] = 'open',
): TopRecords['directions'][number] => ({ id, verdict, state });

const openCall = (direction: string | null): TopRecords['calls'][number] => ({
  id: 'c-1',
  state: 'open',
  by: direction ? 'a-1' : 'verifold',
  direction,
  joined: [],
});

await test('the top line comes from records, each direction once', () => {
  assert.equal(
    briefTop({
      directions: [
        direction('d-1', 'ruled-out', 'closed'),
        direction('d-2'),
        direction('d-3'),
        direction('d-4'),
      ],
      calls: [openCall('d-2')],
      runs: [{ direction: 'd-4', status: 'running' }],
    }),
    'One test failed, one is running, one needs your decision, and one has not run yet.',
  );
  assert.equal(
    briefTop({
      directions: [
        direction('d-1', 'ruled-out'),
        direction('d-2', 'ruled-out'),
        direction('d-3'),
      ],
      calls: [],
      runs: [{ direction: 'd-3', status: 'done' }],
    }),
    'Two tests failed and one has run, with no verdict yet.',
  );
  assert.equal(
    briefTop({
      directions: [
        direction('d-1', 'holds-up'),
        direction('d-2', 'open', 'stopped'),
      ],
      calls: [{ ...openCall('d-2'), state: 'answered' }],
      runs: [],
    }),
    'One test held up and one was stopped.',
  );
  assert.equal(
    briefTop({ directions: [], calls: [openCall(null)], runs: [] }),
    'No test has started yet. The lab also has one decision for you.',
  );
  // A call of a closed direction says nothing of that direction: its verdict does.
  assert.equal(
    briefTop({
      directions: [direction('d-1', 'ruled-out', 'closed')],
      calls: [openCall('d-1')],
      runs: [],
    }),
    'One test failed.',
  );
});

await test('the state key changes with a direction or a thread, and not with anything else', () => {
  const directions = [direction('d-1')];
  const threads = [{ id: 't-1', state: 'open' as const }];
  const key = stateKey(directions, threads);
  assert.equal(stateKey(directions, threads), key);
  assert.notEqual(stateKey([direction('d-1', 'leading')], threads), key);
  assert.notEqual(stateKey(directions, [{ id: 't-1', state: 'decided' }]), key);
});

await test('a quote holds each cited post unchanged, apart from its ID', () => {
  assert.deepEqual(
    quotesOf([
      post('p-1', 'seed 0: 55% vs 15%.'),
      post('p-2', 'It may be noise (p-1).'),
    ]),
    [
      { post: 'p-1', text: 'seed 0: 55% vs 15%.' },
      { post: 'p-2', text: 'It may be noise (p-1).' },
    ],
  );
});

const cited = [post('p-1', 'The model passed 129/200 = 64.5% of its cases.')];

await test('each number of a plain line must be in its posts', () => {
  assert.equal(
    plainNumbersMatch('It passed 64.5% of its 200 cases.', cited),
    true,
  );
  assert.equal(plainNumbersMatch('It passed most cases.', cited), true);
  assert.deepEqual(strayNumbers('It passed 91.5% of cases.', cited), ['91.5%']);
});

await test('percent, decimals, ranges, lists, and comma thousands compare as numbers', () => {
  const source = [
    post(
      'p-1',
      'Trained on 4,218 papers. Harmless cases: 41/55/62%. Estimate 30-45 min. Share 20 to 30%. Loss 0.50, lr 1e-5.',
    ),
  ];
  for (const plain of [
    'It used 4218 papers.',
    'It used 4,218 papers.',
    '41%, 55% and 62% of the harmless cases.',
    'It may take 30 to 45 minutes.',
    'It may take 30–45 minutes.',
    'About 20% to 30% of the share.',
    'The loss was 0.5.',
    'The loss was .50.',
    'A rate of 0.00001.',
  ])
    assert.equal(plainNumbersMatch(plain, source), true, plain);
  // A percent needs a percent: 12 of 60 does not back 20%.
  assert.deepEqual(
    strayNumbers('20% were broken.', [post('p-1', '12 of 60 were broken.')]),
    ['20%'],
  );
  // A plain count can come from a post's percent.
  assert.equal(plainNumbersMatch('41 of them.', source), true);
});

await test('a sign counts, and a hyphen in a range or a word is no sign', () => {
  const source = [
    post('p-1', 'The score fell by -0.5 on seed-2, in 3-5 runs.'),
  ];
  assert.equal(plainNumbersMatch('It fell by −0.5.', source), true);
  assert.deepEqual(strayNumbers('It rose by 0.5.', source), ['0.5']);
  assert.equal(
    plainNumbersMatch('It took 3 to 5 runs on seed 2.', source),
    true,
  );
  assert.deepEqual(
    strayNumbers('It moved by 5%.', [post('p-1', 'It moved by -5%.')]),
    ['5%'],
  );
  assert.deepEqual(
    strayNumbers('It moved by -5%.', [post('p-1', 'It moved by 5%.')]),
    ['-5%'],
  );
});

await test('k and M scale a number, and other letters do not', () => {
  const source = [
    post(
      'p-1',
      'It holds 1,500 cases, 2 million rows, and 120k tokens in a 5km grid.',
    ),
  ];
  assert.equal(plainNumbersMatch('It holds 1.5k cases.', source), true);
  assert.equal(plainNumbersMatch('It holds 1.5K cases.', source), true);
  assert.equal(plainNumbersMatch('It holds 2M rows.', source), true);
  assert.equal(plainNumbersMatch('It holds 2,000,000 rows.', source), true);
  assert.equal(plainNumbersMatch('It holds 120,000 tokens.', source), true);
  assert.deepEqual(strayNumbers('It holds 3M rows.', source), ['3000000']);
  // A lowercase m is minutes or metres, as in 50m.
  assert.deepEqual(strayNumbers('A 5m grid.', source), []);
  assert.deepEqual(strayNumbers('A 7m grid.', source), ['7']);
});

await test('spelled numbers and spelled percent count as numbers', () => {
  const source = [
    post(
      'p-1',
      '35 of 200 failed, 21 passed, 100 waited, 0 ended, and 40% and 5% and 1% and 70 percent held.',
    ),
  ];
  for (const plain of [
    'Thirty-five failed.',
    'Thirty five failed.',
    'Two hundred ran.',
    'A hundred waited.',
    'One hundred waited.',
    'Twenty-one passed.',
    'Zero ended.',
    'Forty percent held.',
    'Five per cent held.',
    'One percent held.',
    'Seventy percent held.',
  ])
    assert.equal(plainNumbersMatch(plain, source), true, plain);
  assert.deepEqual(strayNumbers('Twenty failed.', source), ['20']);
  assert.deepEqual(strayNumbers('Sixty percent held.', source), ['60%']);
  // 35 of 200 is no percent.
  assert.deepEqual(strayNumbers('Thirty-five percent failed.', source), [
    '35%',
  ]);
  const spelledPost = [post('p-1', 'Forty percent of two hundred held.')];
  assert.equal(plainNumbersMatch('40% of 200 held.', spelledPost), true);
});

await test('digits in IDs and agent names are no numbers, in a line or in a post', () => {
  const source = [
    post('p-1', 'Agent 13 reports r-38 in p-90 (lease-4), and r1 + 2 runs.'),
  ];
  // The ID, the name, and the attached digit back nothing.
  assert.deepEqual(strayNumbers('It took 38 runs.', source), ['38']);
  assert.deepEqual(strayNumbers('It took 13 runs.', source), ['13']);
  assert.deepEqual(strayNumbers('It took 1 run.', source), ['1']);
  assert.equal(
    plainNumbersMatch('Agents 1, 2 and 3 saw 2 runs (p-90).', source),
    true,
  );
  assert.equal(plainNumbersMatch('Agent 3.1 saw 2 runs.', source), true);
});

await test('a spelled number counts, a time can be the time of a post, and one stays free', () => {
  const source = [post('p-1', '2 seeds finished, and three did not.')];
  assert.equal(
    plainNumbersMatch('Two seeds finished, and 3 did not.', source),
    true,
  );
  assert.deepEqual(strayNumbers('Twelve seeds finished.', source), ['12']);
  assert.equal(
    plainNumbersMatch('No one saw it, and one seed ended.', source),
    true,
  );
  const written = new Date(2026, 10, 1, 11, 5).toISOString();
  const timed = [post('p-1', 'Agreed.', { at: written })];
  assert.equal(plainNumbersMatch('Agent 1 agreed at 11:05.', timed), true);
  assert.deepEqual(strayNumbers('Agent 1 agreed at 11:09.', timed), ['11:09']);
});

// The shapes of errors that a careful writer made in plain rewrites of real posts.
await test('numbers in the wrong place fail: a figure from another set, a wrong count, a wrong duration', () => {
  assert.deepEqual(
    strayNumbers('It passed 64.5%, and 91.5% in the other set.', cited),
    ['91.5%'],
  );
  assert.deepEqual(
    strayNumbers('All 11 objections changed the work.', [
      post('p-1', '6 of 7 objections drew an accepted change.'),
    ]),
    ['11'],
  );
  assert.deepEqual(
    strayNumbers('2h 14m into the run.', [
      post('p-1', 'The run is 2h 20m in.'),
    ]),
    ['14'],
  );
  assert.deepEqual(
    strayNumbers('About 120 words.', [post('p-1', 'About 180 words.')]),
    ['120'],
  );
  // The number test sees no scope: 9 is in the post. The line check catches this one.
  assert.equal(
    plainNumbersMatch('7 of 7 objections changed the work.', [
      post('p-1', '6 of 7 objections drew an accepted change.'),
    ]),
    true,
  );
});

await test('a label states one result with no check', () => {
  assert.equal(
    evidenceLabel([post('p-1', 'It works.')], []),
    "One agent's result. No check yet.",
  );
  assert.equal(
    evidenceLabel(
      [
        post('p-1', 'It works.'),
        post('p-2', 'So does this.', { author: 'a-2' }),
      ],
      [],
    ),
    "Two agents' results. No check yet.",
  );
  assert.equal(
    evidenceLabel([post('p-1', 'Use this.', { kind: 'proposal' })], []),
    "One agent's post. No check yet.",
  );
  assert.equal(
    evidenceLabel(
      [post('p-1', 'Please look.', { author: 'person', kind: 'question' })],
      [],
    ),
    'Your own words.',
  );
  assert.equal(
    evidenceLabel([post('p-1', 'Noted.', { author: 'verifold' })], []),
    "Verifold's own record.",
  );
  assert.equal(
    evidenceLabel(
      [
        post('p-1', 'Please look.', { author: 'person', kind: 'question' }),
        post('p-2', 'Noted.', { author: 'verifold', kind: 'status' }),
      ],
      [],
    ),
    "Your own words and Verifold's record.",
  );
  assert.equal(evidenceLabel([], []), 'No cited post is on the board.');
});

await test('a code read is no rerun, whatever it found, and each form carries its outcome', () => {
  const claim = post('p-1', 'It breaks the model.');
  const verdict = post('p-2', 'The code does not support this.', {
    author: 'a-9',
    kind: 'rerun',
    replyTo: 'p-1',
  });
  const read = check({ method: 'code-read', outcome: 'fails', result: 'p-2' });
  // The shape of the error: a code check reads as "a rerun overturned the claim".
  assert.equal(
    evidenceLabel([claim, verdict], [read]),
    'Code check failed. No rerun.',
  );
  const ratings = post('p-3', 'Raters scored the answers.', {
    author: 'a-3',
    kind: 'check',
    replyTo: 'p-1',
    outcome: 'fails',
    method: 'ratings',
    raters: 2,
    at: '2026-11-01T11:00:00.000Z',
  });
  assert.equal(
    evidenceLabel([claim, verdict, ratings], [read]),
    'Code check failed, then two AI ratings per answer failed. No rerun.',
  );
  // A check that reports no outcome keeps the bare form.
  const bare = post('p-3', 'Raters scored the answers.', {
    author: 'a-3',
    kind: 'check',
    replyTo: 'p-1',
    method: 'ratings',
    raters: 2,
    at: '2026-11-01T11:00:00.000Z',
  });
  assert.equal(
    evidenceLabel(
      [claim, verdict, bare],
      [check({ method: 'code-read', outcome: null, result: 'p-2' })],
    ),
    'Code check, then two AI ratings per answer. No rerun.',
  );
});

await test('a rerun says how it ended, and says so when it was not blind or on the same harness', () => {
  const claim = post('p-1', 'It works.');
  assert.equal(evidenceLabel([claim], [check()]), 'Rerun held.');
  assert.equal(
    evidenceLabel([claim], [check({ outcome: 'fails' })]),
    'Rerun failed.',
  );
  assert.equal(
    evidenceLabel([claim], [check({ outcome: 'differs' })]),
    'Rerun differed.',
  );
  assert.equal(
    evidenceLabel([claim], [check({ sameHarness: true })]),
    'Rerun on the same harness held.',
  );
  assert.equal(
    evidenceLabel([claim], [check({ blind: false })]),
    'Not-blind rerun held.',
  );
  // An agent's own rerun read the lab, so it is never blind.
  assert.equal(
    evidenceLabel(
      [
        claim,
        post('p-2', 'I ran it again.', {
          kind: 'check',
          replyTo: 'p-1',
          author: 'a-2',
          outcome: 'holds',
          method: 'rerun',
        }),
      ],
      [],
    ),
    'Not-blind rerun held.',
  );
});

await test('a check that did not end counts for nothing, and a check with no method is the weakest form', () => {
  const claim = post('p-1', 'It works.');
  for (const state of ['queued', 'running', 'failed', 'dropped'] as const)
    assert.equal(
      evidenceLabel([claim], [check({ state })]),
      "One agent's result. No check yet.",
    );
  assert.equal(
    evidenceLabel(
      [
        claim,
        post('p-2', 'Looks right.', {
          kind: 'check',
          replyTo: 'p-1',
          author: 'a-2',
          outcome: 'holds',
        }),
      ],
      [],
    ),
    'An agent check held. No rerun.',
  );
});

await test('the label reports the weakest form across the cited results', () => {
  const posts = [post('p-1', 'One.'), post('p-2', 'Two.', { author: 'a-2' })];
  assert.equal(
    evidenceLabel(posts, [check()]),
    'Rerun held on 1 of 2 results. No rerun on the other.',
  );
  // A code check of the other result does not lift the label to a rerun.
  assert.equal(
    evidenceLabel(posts, [
      check(),
      check({ method: 'code-read', claim: 'p-2' }),
    ]),
    'Rerun held on 1 of 2 results. No rerun on the other.',
  );
  assert.equal(
    evidenceLabel([...posts, post('p-3', 'Three.')], [check()]),
    'Rerun held on 1 of 3 results. No rerun on the other 2.',
  );
  assert.equal(
    evidenceLabel(posts, [check({ method: 'code-read' })]),
    'Code check held on 1 of 2 results. 1 has no check yet. No rerun.',
  );
  assert.equal(
    evidenceLabel(posts, [check(), check({ claim: 'p-2' })]),
    'Rerun held.',
  );
});

await test('an open objection shows on the label until the record ends it', () => {
  const claim = post('p-1', 'It works.');
  const objection = post('p-2', 'Seed 2 is missing.', {
    author: 'a-2',
    kind: 'objection',
    replyTo: 'p-1',
  });
  assert.equal(
    evidenceLabel([claim, objection], []),
    "One agent's result. No check yet. Disputed.",
  );
  assert.equal(
    evidenceLabel([claim, objection], [check({ objections: ['p-2'] })]),
    'Rerun held.',
  );
});

await test('a label reads the checks and objections around the cited posts', () => {
  const all = [
    post('p-1', 'It works.'),
    post('p-2', 'Unrelated.', { author: 'a-2' }),
    post('p-3', 'No.', { author: 'a-2', kind: 'objection', replyTo: 'p-1' }),
    post('p-4', 'Fair, I withdraw.', {
      kind: 'answer',
      replyTo: 'p-3',
      accepts: true,
    }),
    post('p-5', 'Audit.', {
      author: 'a-3',
      kind: 'check',
      replyTo: 'p-1',
      outcome: 'fails',
      method: 'code-read',
    }),
  ];
  const [claim, , , answer] = all;
  assert.ok(claim && answer);
  assert.deepEqual(
    evidencePosts([answer], all).map((entry) => entry.id),
    ['p-1', 'p-3', 'p-4', 'p-5'],
  );
  // The accepting answer comes along, so an ended objection shows no dispute.
  assert.equal(
    evidenceLabel(evidencePosts([claim], all), []),
    'Code check failed. No rerun.',
  );
});

await test('a check post says how it checked, in a shape that the record can use', () => {
  const target = post('p-1', 'It works.', { thread: 't-1' });
  const context: PostContext = {
    author: 'a-2',
    kind: 'check',
    mentions: [],
    proof: 1,
    post: (id) => (id === target.id ? target : undefined),
    threads: [
      {
        id: 't-1',
        title: 'Does it work on all seeds?',
        state: 'open',
        why: 'Why.',
        openedBy: 'a-1',
        at,
        followers: [],
        agreed: [],
      },
    ],
    working: ['a-1', 'a-2'],
    name: (author) => author,
  };
  const shaped = (more: Record<string, unknown>) =>
    shapePost({ replyTo: 'p-1', outcome: 'holds', ...more }, context);
  assert.equal(shaped({}).method, undefined);
  assert.equal(shaped({ method: 'code-read' }).method, 'code-read');
  assert.deepEqual(
    (({ method, raters }) => ({ method, raters }))(
      shaped({ method: 'ratings', raters: 2 }),
    ),
    { method: 'ratings', raters: 2 },
  );
  assert.equal(
    shaped({
      method: 'rerun',
      artifacts: [{ type: 'run', run: 'r-1' }],
    }).method,
    'rerun',
  );
  assert.throws(
    () => shaped({ method: 'rerun', artifacts: [{ type: 'file', path: 'a' }] }),
    /A rerun cites its run as proof/,
  );
  assert.throws(() => shaped({ method: 'ratings' }), /Give raters/);
  assert.throws(() => shaped({ method: 'ratings', raters: 12 }), /from 1 to 9/);
  assert.throws(
    () => shaped({ method: 'code-read', raters: 2 }),
    /Only ratings give raters/,
  );
  assert.throws(() => shaped({ method: 'vote' }), /A method is one of/);
  assert.throws(
    () =>
      shapePost(
        { thread: 't-1', method: 'code-read' },
        { ...context, kind: 'result' },
      ),
    /Only a check gives a method/,
  );
});
