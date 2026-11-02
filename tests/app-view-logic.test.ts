import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Agent,
  BriefLine,
  Call,
  Direction,
  Lab,
  Post,
  Thread,
  ThreadPage,
  Wait,
} from '../src/protocol/api.ts';
import { agentRows, reachLine } from '../src/app/agent-rows.ts';
import {
  briefFoot,
  briefHead,
  lineHref,
  lineText,
} from '../src/app/brief-view.ts';
import { clock } from '../src/app/format.ts';
import { idParts, withoutIds } from '../src/app/ids.ts';
import { needRows, timeLine, upToCost } from '../src/app/needs.ts';
import { href, parseRoute } from '../src/app/route.ts';
import {
  laterFromRecord,
  openThreads,
  outcomeLabel,
  simplePosts,
  storyParts,
  threadChip,
  threadGroups,
  threadTitle,
  wantsStory,
} from '../src/app/thread-view.ts';
import {
  readViewMode,
  saveViewMode,
  threadedLab,
  threadHome,
} from '../src/app/view-mode.ts';

const now = Date.parse('2026-11-01T17:08:00.000Z');
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const call = (more: Partial<Call> = {}): Call => ({
  id: 'c-4',
  at: ago(17),
  kind: 'cost',
  question: 'Rebuild the test, or stop it?',
  why: '',
  askers: [
    {
      agent: 'a-2',
      handle: 'agent-2',
      job: 'Sorting',
      direction: 'd-2',
      why: '',
    },
  ],
  byVerifold: false,
  options: [
    {
      label: 'Rebuild',
      usd: 3.58,
      minutes: 180,
      effect: { type: 'pod', gpu: 'A100', hours: 2, secrets: 0 },
    },
    { label: 'Stop', usd: 0, minutes: null, effect: null },
  ],
  pick: 0,
  state: 'open',
  answer: null,
  words: null,
  undoUntil: null,
  note: null,
  post: 'p-9',
  ...more,
});

function agent(id: string, more: Partial<Agent> = {}): Agent {
  return {
    id,
    handle: `agent-${id.slice(2)}`,
    job: 'Controls',
    harness: 'codex',
    model: null,
    direction: `d-${id.slice(2)}`,
    check: null,
    status: 'working',
    until: null,
    live: { state: 'working', text: 'Running probe.py', since: ago(1) },
    turns: { turns: [], more: false },
    spendUsd: null,
    ...more,
  };
}

function direction(id: string, more: Partial<Direction> = {}): Direction {
  return {
    id,
    title: `Title of ${id}`,
    bar: null,
    runs: null,
    noise: null,
    buildsOn: [],
    state: 'open',
    verdict: 'open',
    disputed: false,
    evidence: null,
    agent: `a-${id.slice(2)}`,
    openedBy: 'a-1',
    openedAt: ago(200),
    stoppedAt: null,
    head: 'a',
    ...more,
  };
}

const wait = (more: Partial<Wait> = {}): Wait => ({
  waiter: 'a-3',
  waiterHandle: 'agent-3',
  on: 'person',
  onHandle: null,
  post: 'p-20',
  reason: 'ask',
  thread: 't-2',
  subject: 'Which seed comes first?',
  text: 'Which seed comes first?',
  since: ago(5),
  ...more,
});

function lab(more: Partial<Lab> = {}): Lab {
  return {
    question: 'Does it hold?',
    startedAt: ago(230),
    agentsHere: true,
    paused: null,
    budget: { hours: 8, deadline: new Date(now + 251 * 60_000).toISOString() },
    money: { plansUsd: 1, gpuUsd: 1, gpuLimitUsd: 25 },
    needsYou: [],
    answered: [],
    directions: [],
    agents: [],
    plan: null,
    board: { posts: [], more: false },
    disputes: [],
    runs: [],
    checks: [],
    signoff: null,
    works: [],
    away: null,
    omitted: {},
    ...more,
  };
}

function briefLine(more: Partial<BriefLine> = {}): BriefLine {
  return {
    kind: 'open',
    at: ago(19),
    plain: 'It looks open.',
    quote: 'Seed 0 gives 55%. (p-155) Seed 1 gives 60%. (p-156)',
    posts: ['p-155', 'p-156'],
    thread: 't-3',
    evidence: "One agent's result. No check yet.",
    check: { state: 'passed', by: 'codex', sameHarness: false },
    ...more,
  };
}

function thread(more: Partial<Thread> = {}): Thread {
  return {
    id: 't-2',
    title: 'Does it hold on seed 2?',
    state: 'open',
    why: 'It decides the next step.',
    direction: null,
    openedBy: 'a-1',
    at: ago(100),
    outcome: null,
    followers: [],
    agreed: [],
    posts: 2,
    lastAt: ago(10),
    ...more,
  };
}

function post(id: string, more: Partial<Post> = {}): Post {
  return {
    id,
    at: ago(50),
    author: 'a-1',
    handle: 'agent-1',
    harness: 'claude',
    kind: 'result',
    direction: null,
    thread: 't-2',
    text: 'It holds.',
    replyTo: null,
    mentions: [],
    proof: [],
    ...more,
  };
}

await test('Simple is the default, the choice stays in this browser, and a refused storage changes nothing', () => {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  assert.equal(
    readViewMode(() => storage),
    'simple',
  );
  saveViewMode('technical', () => storage);
  assert.equal(
    readViewMode(() => storage),
    'technical',
  );
  kept.set('verifold.view', 'something else');
  assert.equal(
    readViewMode(() => storage),
    'simple',
  );
  const refused = (): typeof storage => {
    throw new Error('No storage.');
  };
  assert.equal(readViewMode(refused), 'simple');
  saveViewMode('technical', refused);
});

await test('one test chooses the screens: a brief means threads, and the new home starts at the plan', () => {
  const plan = {
    post: 'p-1',
    at: ago(1),
    reading: '',
    cost: '',
    directions: [],
    facts: [],
  };
  const brief = { at: null, top: 'No test has started yet.', lines: [] };
  assert.equal(threadedLab(null), false);
  assert.equal(threadedLab(lab({ brief: null })), false);
  assert.equal(threadedLab(lab()), false);
  assert.equal(threadedLab(lab({ brief })), true);
  assert.equal(threadHome(lab({ plan })), false);
  assert.equal(threadHome(lab({ brief })), false);
  assert.equal(threadHome(lab({ brief, plan })), true);
  // A small snapshot leaves the plan and the threads out, and it stays a lab with threads.
  assert.equal(
    threadHome(lab({ brief, threads: [], omitted: { plan: 1, threads: 4 } })),
    true,
  );
});

await test('an ID links to its record, and a word that only holds one stays text', () => {
  assert.deepEqual(idParts('See d-2, r-93 and p-101. Then c-4 on lease-8.'), [
    'See ',
    { id: 'd-2', href: '#/d/d-2' },
    ', ',
    { id: 'r-93', href: '#/run/r-93' },
    ' and ',
    { id: 'p-101', href: '#/post/p-101' },
    '. Then ',
    { id: 'c-4', href: null },
    ' on ',
    { id: 'lease-8', href: '#/settings' },
    '.',
  ]);
  for (const text of [
    'results/d-1/summary.md',
    'top-5',
    'gpt-d-1',
    'p-0',
    'd-1-b',
    'r-x',
  ])
    assert.deepEqual(idParts(text), [text]);
  assert.deepEqual(idParts(''), []);
});

await test('Simple takes out the IDs that Verifold adds, and nothing else', () => {
  assert.equal(
    withoutIds('Seed 0 gives 55%. (p-155) Seed 1. (p-156, p-157)'),
    'Seed 0 gives 55%. Seed 1.',
  );
  assert.equal(
    withoutIds('15 posts, 2 runs ended (1 failed: r-93), 1 call for you'),
    '15 posts, 2 runs ended (1 failed), 1 call for you',
  );
  assert.equal(
    withoutIds('A plain line (with words).'),
    'A plain line (with words).',
  );
});

await test('a row of Needs you shows who asks, the wait, the cost, and the latest time in about words', () => {
  const deadline = new Date(now + 249 * 60_000).toISOString();
  const open = call({ latestAt: new Date(now + 69 * 60_000).toISOString() });
  const [row] = needRows(
    lab({ needsYou: [open], budget: { hours: 8, deadline } }),
    now,
  );
  assert.equal(
    row?.sub,
    `Agent 2 asks · 17 min · Up to $3.58 of GPU · Up to 3 hours. To finish by ${clock(deadline)}, answer by about ${clock(open.latestAt ?? '')}`,
  );
  assert.equal(row?.call, 'c-4');
});

await test('a late call says that it no longer fits, and an unknown cost or time says so', () => {
  const deadline = new Date(now + 60 * 60_000).toISOString();
  assert.match(
    timeLine(
      call({ latestAt: new Date(now - 120 * 60_000).toISOString() }),
      deadline,
      now,
    ),
    /^Up to 3 hours\. That no longer fits before /,
  );
  assert.equal(timeLine(call({ latestAt: null }), null, now), 'Up to 3 hours');
  assert.equal(
    timeLine(
      call({
        options: [
          { label: 'Half', usd: null, minutes: 90, effect: null },
          { label: 'None', usd: null, minutes: null, effect: null },
        ],
      }),
      null,
      now,
    ),
    'Up to 1 hour 30 minutes',
  );
  assert.equal(
    timeLine(
      call({
        options: [{ label: 'A', usd: null, minutes: null, effect: null }],
      }),
      null,
      now,
    ),
    'Time not given',
  );
  assert.equal(
    upToCost(
      call({
        options: [{ label: 'A', usd: null, minutes: null, effect: null }],
      }),
    ),
    'Cost not given',
  );
  assert.equal(
    upToCost(
      call({ options: [{ label: 'A', usd: 0, minutes: null, effect: null }] }),
    ),
    'No cost',
  );
  assert.equal(
    upToCost(
      call({ options: [{ label: 'A', usd: 2, minutes: null, effect: null }] }),
    ),
    'Up to $2',
  );
});

await test('Needs you lists each call, then each ask to the person, and leaves out asks to agents', () => {
  const rows = needRows(
    lab({
      needsYou: [
        call(),
        call({ id: 'c-5', askers: [], byVerifold: true }),
        call({
          id: 'c-6',
          askers: [
            { agent: 'a-1', handle: 'agent-1', direction: null, why: '' },
            { agent: 'a-2', handle: 'agent-2', direction: null, why: '' },
          ],
        }),
      ],
      waits: [wait(), wait({ on: 'a-2', onHandle: 'agent-2', post: 'p-21' })],
    }),
    now,
  );
  assert.deepEqual(
    rows.map((row) => row.key),
    ['c-4', 'c-5', 'c-6', 'p-20'],
  );
  assert.match(rows[1]?.sub ?? '', /^Verifold asks/);
  assert.match(rows[2]?.sub ?? '', /^Agent 1 and Agent 2 ask/);
  assert.equal(rows[3]?.reply, '#/post/p-20');
  assert.match(rows[3]?.sub ?? '', /^Agent 3 asks · 5 min$/);
});

await test('Technical quotes unchanged, and Simple shows plain words, or the quote without Verifold’s IDs', () => {
  const line = briefLine();
  assert.equal(lineText(line, 'technical', false), line.quote);
  assert.equal(lineText(line, 'simple', false), 'It looks open.');
  assert.equal(
    lineText(line, 'simple', true),
    'Seed 0 gives 55%. Seed 1 gives 60%.',
  );
  assert.equal(
    lineText({ ...line, plain: null }, 'simple', false),
    'Seed 0 gives 55%. Seed 1 gives 60%.',
  );
});

await test('a line links to its thread, or to its post in a lab with no thread for it', () => {
  assert.equal(lineHref(briefLine()), '#/thread/t-3');
  assert.equal(lineHref(briefLine({ thread: null })), '#/post/p-155');
  assert.equal(lineHref({ thread: null, posts: [] }), '#/threads');
});

await test('the head says since when only if the brief covers the time away, and it shows the age', () => {
  const brief = { at: ago(1), top: 'Top.', lines: [] };
  const away = { since: ago(152), spentThen: { plansUsd: 0, gpuUsd: 0 } };
  assert.match(
    briefHead({ away, brief }, now),
    /^Since you left at \d\d:\d\d · Coordinator, \d\d:\d\d, 1 min ago$/,
  );
  assert.match(
    briefHead({ away: null, brief }, now),
    /^Coordinator, \d\d:\d\d, 1 min ago$/,
  );
  assert.match(
    briefHead({ away, brief: { ...brief, at: ago(300) } }, now),
    /^Coordinator, \d\d:\d\d, 5 h ago$/,
  );
  assert.match(
    briefHead({ away, brief: { ...brief, at: null } }, now),
    /^Since you left/,
  );
  assert.equal(
    briefHead({ away: null, brief: { ...brief, at: null } }, now),
    'Where the lab stands',
  );
});

await test('the foot says where the words come from, and why a line quotes its posts', () => {
  assert.equal(briefFoot([], 'simple'), null);
  const passed = briefLine();
  assert.equal(
    briefFoot([passed, briefLine({ posts: ['p-155', 'p-200'] })], 'simple'),
    'Plain words from 3 posts, checked by a second agent.',
  );
  assert.equal(
    briefFoot(
      [
        briefLine({
          check: { state: 'passed', by: 'codex', sameHarness: true },
        }),
      ],
      'simple',
    ),
    'Plain words from 2 posts, checked by a second session of the same harness.',
  );
  const line = (state: BriefLine['check']['state']): BriefLine =>
    briefLine({ plain: null, check: { state, by: null, sameHarness: false } });
  assert.equal(
    briefFoot([line('pending')], 'simple'),
    '1 line quotes its posts until a second agent checks it.',
  );
  assert.equal(
    briefFoot([line('failed'), line('numbers')], 'simple'),
    '2 lines failed their checks, so they quote their posts.',
  );
  assert.equal(
    briefFoot([line('withheld')], 'simple'),
    'This lab keeps no plain words.',
  );
  assert.equal(
    briefFoot([passed], 'technical'),
    'The line above quotes its posts unchanged.',
  );
  assert.equal(
    briefFoot([passed, passed], 'technical'),
    'The 2 lines above quote their posts unchanged.',
  );
});

await test('agent rows say what and why, follow the record, and run first', () => {
  const run = (id: string, by: string, status: 'running' | 'queued') =>
    ({
      id,
      agent: by,
      direction: 'd-1',
      status,
      command: 'python x.py',
      why: '',
      where: { pod: 'pod-1', gpu: 'A100' },
      commit: 'abc',
      exitCode: null,
      queuedAt: ago(9),
      startedAt: status === 'running' ? ago(2) : null,
      endedAt: null,
      metrics: {},
      note: null,
    }) as const;
  const rows = agentRows(
    lab({
      directions: [
        direction('d-1', {
          state: 'closed',
          verdict: 'ruled-out',
          stoppedAt: ago(30),
          evidence: { text: 'It failed at p-9.', post: 'p-9', run: null },
        }),
        direction('d-2'),
        direction('d-3'),
        direction('d-4'),
      ],
      agents: [
        agent('a-1', {
          status: 'closed',
          live: { state: 'ended', text: 'Closed by its agent', since: ago(30) },
        }),
        agent('a-2', {
          status: 'idle',
          live: { state: 'waiting', text: 'Waiting for you', since: ago(9) },
          line: {
            doing: 'Asks to rebuild',
            why: 'The prompts are mixed.',
            next: 'Rebuild them',
            at: ago(9),
          },
          helpers: [{ label: 'agent-2.1', title: 'Search', state: 'lost' }],
        }),
        agent('a-3'),
        agent('a-4'),
        agent('a-5', {
          direction: null,
          handle: 'checker-1',
          live: { state: 'ended', text: 'Check done', since: ago(9) },
          status: 'done',
        }),
      ],
      needsYou: [call()],
      runs: [run('r-52', 'a-4', 'running'), run('r-49', 'a-3', 'queued')],
    }),
    now,
  );
  assert.deepEqual(
    rows.map((row) => [row.agent.id, row.chip.label, row.chip.tone]),
    [
      ['a-4', 'Running', 'run'],
      ['a-3', 'Working · GPU test queued', 'wait'],
      ['a-2', 'Waits on you', 'need'],
      ['a-1', 'Closed', 'done'],
    ],
  );
  const [, third, second, first] = rows;
  assert.equal(second?.line, 'Asks to rebuild. The prompts are mixed.');
  assert.equal(second?.next, 'Rebuild them');
  assert.equal(second?.helpers, '1 helper stopped with no result');
  assert.match(third?.run ?? '', /^r-49 queued/);
  // Technical keeps the evidence, and Simple reads the records.
  assert.equal(first?.line, 'It failed at p-9.');
  assert.match(
    first?.ended ?? '',
    /^Closed at \d\d:\d\d after its test failed\. Its code and outputs stay for the others\.$/,
  );
  assert.equal(second?.ended, null);
});

await test('an agent that waits on another shows it, and an agent with no line shows its live step', () => {
  const rows = agentRows(
    lab({
      directions: [direction('d-3')],
      agents: [agent('a-3')],
      waits: [wait({ on: 'a-2', onHandle: 'agent-2' })],
    }),
    now,
  );
  assert.equal(rows[0]?.chip.label, 'Waits on Agent 2');
  assert.equal(rows[0]?.wait, 'Waits on Agent 2: Which seed comes first?');
  assert.match(rows[0]?.line ?? '', /^Running probe\.py/);
});

await test('the reach line says who reads a post to the lab', () => {
  const directions = [
    direction('d-1', { state: 'closed' }),
    direction('d-2'),
    direction('d-3'),
    direction('d-4'),
  ];
  const agents = ['a-1', 'a-2', 'a-3', 'a-4'].map((id) => agent(id));
  assert.equal(
    reachLine(lab({ directions, agents })),
    'Agents 2, 3 and 4 read this after their current steps. Agent 1 ended.',
  );
  assert.equal(
    reachLine(
      lab({
        directions: [direction('d-2')],
        agents,
        paused: { at: ago(1), reason: 'person' },
      }),
    ),
    'Agent 2 reads this after the lab resumes.',
  );
  assert.equal(
    reachLine(lab({ directions: [direction('d-2')], agents })),
    'Agent 2 reads this after its current step.',
  );
  assert.equal(
    reachLine(
      lab({ directions: [direction('d-1', { state: 'stopped' })], agents }),
    ),
    'No agent works now, so no agent reads this. Agent 1 ended.',
  );
  const many = [1, 2, 3, 4, 5, 6].map((number) => `a-${number}`);
  assert.equal(
    reachLine(
      lab({
        directions: many.map((id) => direction(`d-${id.slice(2)}`)),
        agents: many.map((id) => agent(id)),
      }),
    ),
    '6 agents read this after their current steps.',
  );
});

await test('a title and a chip follow the view and the record', () => {
  const plain = thread({ plainTitle: 'Plain title' });
  assert.equal(threadTitle(plain, 'simple'), 'Plain title');
  assert.equal(threadTitle(plain, 'technical'), plain.title);
  assert.equal(threadTitle(thread(), 'simple'), thread().title);
  const running = {
    runs: [{ direction: 'd-1', status: 'running' }],
  } as unknown as Lab;
  assert.deepEqual(threadChip(thread({ direction: 'd-1' }), running), {
    label: 'Running',
    tone: 'run',
  });
  assert.equal(threadChip(thread(), running).label, 'Open');
  for (const [state, label] of [
    ['decided', 'Decided'],
    ['answered', 'Answered'],
    ['closed', 'Closed'],
  ] as const)
    assert.equal(threadChip(thread({ state }), running).label, label);
});

await test('threads group by state with open first, and the newest talk leads', () => {
  const list = [
    thread({ id: 't-1', state: 'closed' }),
    thread({ id: 't-2', lastAt: ago(90) }),
    thread({ id: 't-3', lastAt: ago(10) }),
    thread({ id: 't-4', state: 'decided', lastAt: null }),
  ];
  assert.deepEqual(
    threadGroups(list).map((group) => [
      group.label,
      group.threads.map(({ id }) => id),
    ]),
    [
      ['Open', ['t-3', 't-2']],
      ['Decided', ['t-4']],
      ['Closed', ['t-1']],
    ],
  );
  assert.deepEqual(
    openThreads(list, 1).map(({ id }) => id),
    ['t-3'],
  );
});

await test('an outcome says what it is, when, and who took part', () => {
  const outcome = { text: 'Use it.', post: 'p-3', by: 'a-1', at: ago(50) };
  const decided = thread({ state: 'decided', outcome });
  assert.equal(outcomeLabel(thread(), []), null);
  assert.match(
    outcomeLabel(decided, [
      post('p-1', { author: 'person', handle: null, harness: null }),
      post('p-2', { author: 'a-3', handle: 'agent-3' }),
      post('p-3'),
      post('p-4', { author: 'a-10', handle: 'agent-10' }),
    ]) ?? '',
    /^Decision · \d\d:\d\d · Agents 1, 3 and 10, after your request$/,
  );
  assert.match(
    outcomeLabel({ ...decided, state: 'closed' }, [post('p-3')]) ?? '',
    /^Outcome · \d\d:\d\d · Agent 1$/,
  );
  assert.match(
    outcomeLabel({ ...decided, state: 'answered' }, []) ?? '',
    /^Answer · \d\d:\d\d · Verifold$/,
  );
});

await test('a story splits into its parts, and newer posts stay outside it', () => {
  const line = (kind: BriefLine['kind'], posts: readonly string[]) => ({
    ...briefLine({ kind, posts }),
    author: 'a-1',
    handle: 'agent-1',
    harness: 'claude' as const,
  });
  const page: ThreadPage = {
    thread: thread(),
    posts: [post('p-3'), post('p-4')],
    more: false,
    story: {
      at: ago(1),
      through: 'p-3',
      lines: [
        line('step', ['p-3']),
        line('outcome', ['p-3']),
        line('later', ['p-9']),
      ],
    },
    later: [post('p-9'), post('p-10')],
  };
  const parts = storyParts(page);
  assert.equal(parts.steps.length, 1);
  assert.equal(parts.outcome.length, 1);
  assert.equal(parts.later.length, 1);
  assert.deepEqual(
    parts.newer.map(({ id }) => id),
    ['p-4'],
  );
  // A later line tells p-9, so the record adds only p-10.
  assert.deepEqual(
    laterFromRecord(page).map(({ id }) => id),
    ['p-10'],
  );
  assert.equal(wantsStory(page, 'simple'), true);
  assert.equal(wantsStory(page, 'technical'), false);
  assert.equal(wantsStory({ ...page, posts: [post('p-3')] }, 'simple'), false);
  assert.equal(wantsStory({ ...page, story: null }, 'simple'), true);
  assert.equal(
    wantsStory({ ...page, posts: [], story: null }, 'simple'),
    false,
  );
});

await test('Simple leaves out Verifold’s own lines, which carry IDs', () => {
  assert.deepEqual(
    simplePosts([
      post('p-1'),
      post('p-2', { author: 'verifold', handle: null, kind: 'status' }),
    ]).map(({ id }) => id),
    ['p-1'],
  );
});

await test('the routes of threads parse, and a bad ID is no page', () => {
  assert.deepEqual(parseRoute(href.threads), { page: 'threads' });
  assert.deepEqual(parseRoute(href.thread('t-12')), {
    page: 'thread',
    id: 't-12',
  });
  assert.deepEqual(parseRoute('#/thread/t-0'), { page: 'unknown' });
  assert.deepEqual(parseRoute('#/thread/p-1'), { page: 'unknown' });
  assert.deepEqual(parseRoute('#/post/p-1'), { page: 'post', id: 'p-1' });
});
