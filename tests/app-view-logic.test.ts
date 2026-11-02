import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Agent,
  BriefLine,
  Call,
  Direction,
  Lab,
  Post,
  StoryLine,
  Thread,
  ThreadPage,
  Wait,
} from '../src/protocol/api.ts';
import {
  agentRows,
  readingWords,
  rowAge,
  rowDetail,
  rowMore,
} from '../src/app/agent-rows.ts';
import {
  briefFoot,
  briefHead,
  countsWords,
  decisionCount,
  hasOriginal,
  lineHref,
  lineText,
  quietWords,
  quoteText,
  topLine,
} from '../src/app/brief-view.ts';
import { clock, shortTime } from '../src/app/format.ts';
import { idParts } from '../src/app/ids.ts';
import { needRows, timeLine, upToCost } from '../src/app/needs.ts';
import { href, parseRoute } from '../src/app/route.ts';
import {
  allThreads,
  openThreads,
  outcomeLabel,
  postCount,
  threadChip,
  threadGroups,
  threadLayout,
  threadTitle,
  wantsStory,
} from '../src/app/thread-view.ts';
import {
  readViewMode,
  saveViewMode,
  showsIds,
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
    quotes: [
      { post: 'p-155', text: 'Seed 0 gives 55%.' },
      { post: 'p-156', text: 'Seed 1 gives 60%.' },
    ],
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

await test('Simple drops the run IDs of Verifold’s own counts, and only there', () => {
  const counts =
    '15 posts, 2 runs ended (1 failed: r-93, r-94), 1 call for you';
  assert.equal(
    countsWords(counts, false),
    '15 posts, 2 runs ended (1 failed), 1 call for you',
  );
  assert.equal(countsWords(counts, true), counts);
  assert.equal(countsWords('15 posts', false), '15 posts');
  assert.equal(showsIds({ mode: 'simple', threaded: true }), false);
  assert.equal(showsIds({ mode: 'technical', threaded: true }), true);
  assert.equal(showsIds({ mode: 'simple', threaded: false }), true);
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

await test('a time on another day shows its day, in Needs you too', () => {
  const later = (days: number, minutes = 0): string =>
    new Date(now + days * 86_400_000 + minutes * 60_000).toISOString();
  assert.equal(shortTime(ago(5), now), clock(ago(5)));
  assert.match(shortTime(later(-3), now), /^\d{1,2} [A-Z][a-z]{2} \d\d:\d\d$/);
  const line = timeLine(call({ latestAt: later(2, -180) }), later(2), now);
  assert.match(
    line,
    /^Up to 3 hours\. To finish by \d{1,2} [A-Z][a-z]{2} \d\d:\d\d, answer by about \d{1,2} [A-Z][a-z]{2} \d\d:\d\d$/,
  );
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

await test('Technical quotes unchanged, and Simple shows plain words, or the quote', () => {
  const line = briefLine();
  assert.equal(
    lineText(line, 'technical', false),
    'Seed 0 gives 55%. (p-155) Seed 1 gives 60%. (p-156)',
  );
  assert.equal(lineText(line, 'simple', false), 'It looks open.');
  assert.equal(
    lineText(line, 'simple', true),
    'Seed 0 gives 55%. Seed 1 gives 60%.',
  );
  assert.equal(
    lineText({ ...line, plain: null }, 'simple', false),
    'Seed 0 gives 55%. Seed 1 gives 60%.',
  );
  assert.equal(hasOriginal(line, 'simple'), true);
  assert.equal(hasOriginal(line, 'technical'), false);
  assert.equal(hasOriginal({ plain: null }, 'simple'), false);
});

await test('an agent’s own IDs stay in its words in both views', () => {
  const quotes = [{ post: 'p-9', text: 'This builds on p-1 (p-2) and r-7.' }];
  assert.equal(
    quoteText({ quotes }, 'simple'),
    'This builds on p-1 (p-2) and r-7.',
  );
  assert.equal(
    quoteText({ quotes }, 'technical'),
    'This builds on p-1 (p-2) and r-7. (p-9)',
  );
});

await test('a line links to its thread, or to its post in a lab with no thread for it', () => {
  assert.equal(lineHref(briefLine()), '#/thread/t-3');
  assert.equal(lineHref(briefLine({ thread: null })), '#/post/p-155');
  assert.equal(lineHref({ thread: null, posts: [] }), '#/threads');
});

await test('the top line and the decisions come from the records', () => {
  const brief = { top: 'One test ran.', topIds: 'd-1 ran.' };
  assert.equal(topLine(brief, 'simple'), 'One test ran.');
  assert.equal(topLine(brief, 'technical'), 'd-1 ran.');
  assert.equal(topLine({ top: 'One test ran.' }, 'technical'), 'One test ran.');
  assert.equal(decisionCount(undefined), 0);
  assert.equal(
    decisionCount([
      thread({ state: 'decided' }),
      thread({ state: 'answered' }),
      thread(),
    ]),
    1,
  );
});

await test('quiet words need quiet news, and "Nothing changed." needs no cost either', () => {
  const news = { lines: [], moreLines: 0, counts: '', cost: '' };
  assert.equal(quietWords(news), 'Nothing changed.');
  assert.equal(
    quietWords({ ...news, cost: 'Spent since then: $1.' }),
    'No post, run, or call came.',
  );
  assert.equal(quietWords({ ...news, counts: '2 posts' }), null);
  assert.equal(
    quietWords({
      ...news,
      lines: [{ direction: 'd-1', title: 'A', mark: 'open', said: 'B' }],
    }),
    null,
  );
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
  assert.ok(first && second && third);
  assert.equal(second.line, 'Asks to rebuild. The prompts are mixed.');
  assert.equal(second.next, 'Rebuild them');
  assert.equal(second.helpers, '1 helper stopped with no result');
  assert.match(third.run ?? '', /^r-49 queued/);
  assert.match(rowAge(second, now) ?? '', /^\d\d:\d\d, 9 min ago$/);
  assert.equal(rowAge(first, now), null);
  // An agent that ended reads the same in both views: the record's end, time, and verdict.
  assert.match(
    first.line,
    /^Closed at \d\d:\d\d\. Ruled out\. Its folder stays\.$/,
  );
  assert.equal(first.evidence, 'It failed at p-9.');
  assert.deepEqual(rowMore(first, 'simple'), []);
  assert.deepEqual(rowMore(first, 'technical'), ['It failed at p-9.']);
  assert.deepEqual(rowMore(second, 'simple'), [
    '1 helper stopped with no result',
  ]);
  assert.deepEqual(rowMore(second, 'technical'), [
    'Next: Rebuild them',
    '1 helper stopped with no result',
  ]);
  assert.equal(rowDetail(second, 'simple'), 'Controls · Codex');
  assert.equal(rowDetail(second, 'technical'), 'Controls, d-2 · Codex');
});

await test('an ended line says only what the record says', () => {
  const ended = (more: Partial<Direction>) =>
    agentRows(
      lab({
        directions: [direction('d-1', more)],
        agents: [
          agent('a-1', {
            status: 'stopped',
            live: { state: 'ended', text: 'Stopped', since: null },
            line: { doing: 'Old', why: 'Old', next: 'Old', at: ago(9) },
          }),
        ],
      }),
      now,
    )[0];
  assert.equal(ended({ state: 'stopped' })?.line, 'Stopped. Its folder stays.');
  assert.equal(ended({ state: 'stopped' })?.next, null);
  assert.match(
    ended({ state: 'closed', verdict: 'holds-up', stoppedAt: ago(1) })?.line ??
      '',
    /^Closed at \d\d:\d\d\. Holds up\. Its folder stays\.$/,
  );
});

await test('the reading line says what the record holds', () => {
  assert.deepEqual(
    readingWords({ papers: 1, lookups: 2, lastPaperAt: null }, now),
    { line: 'Reading map: 1 paper. No paper read yet.', age: null },
  );
  const { line, age } = readingWords(
    { papers: 14, lookups: 20, lastPaperAt: ago(143) },
    now,
  );
  assert.match(
    line,
    /^Reading map: 14 papers\. Last paper read at \d\d:\d\d\.$/,
  );
  assert.equal(age, '2 h 23 min ago');
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

await test('an outcome says what it is, when, and who took part, from the whole thread', () => {
  const outcome = { text: 'Use it.', post: 'p-3', by: 'a-1', at: ago(50) };
  const decided = thread({ state: 'decided', outcome });
  const part = { handles: ['agent-1', 'agent-3', 'agent-10'], byPerson: true };
  assert.equal(outcomeLabel(thread(), part, now), null);
  assert.match(
    outcomeLabel(decided, part, now) ?? '',
    /^Decision · \d\d:\d\d · Agents 1, 3 and 10, after your request$/,
  );
  assert.match(
    outcomeLabel(
      { ...decided, state: 'closed' },
      { handles: ['agent-1'], byPerson: false },
      now,
    ) ?? '',
    /^Outcome · \d\d:\d\d · Agent 1$/,
  );
  assert.match(
    outcomeLabel(
      { ...decided, state: 'answered' },
      { handles: [], byPerson: true },
      now,
    ) ?? '',
    /^Answer · \d\d:\d\d · You$/,
  );
  assert.match(outcomeLabel(decided, undefined, now) ?? '', /· Verifold$/);
});

const storyLine = (
  kind: BriefLine['kind'],
  posts: readonly string[],
  plain: string | null = 'A plain line.',
): StoryLine => ({
  ...briefLine({
    kind,
    posts,
    plain,
    quotes: posts.map((post) => ({ post, text: `Words of ${post}.` })),
  }),
  author: 'a-1',
  handle: 'agent-1',
  harness: 'claude',
});

const outcome = { text: 'Use it.', post: 'p-3', by: 'a-1', at: ago(50) };

const storyPage = (more: Partial<ThreadPage> = {}): ThreadPage => ({
  thread: thread({ state: 'decided', outcome, posts: 2 }),
  posts: [post('p-3'), post('p-4')],
  more: false,
  story: {
    at: ago(1),
    posts: ['p-3'],
    outcome: 'p-3',
    lines: [
      storyLine('step', ['p-3']),
      storyLine('outcome', ['p-3']),
      storyLine('later', ['p-8', 'p-9']),
    ],
  },
  later: [post('p-9'), post('p-10')],
  ...more,
});

await test('Simple tells a current story, and posts outside it show after it', () => {
  const page = storyPage();
  const simple = threadLayout(page, page.posts, 'simple', now);
  assert.equal(simple.steps?.length, 1);
  assert.equal(simple.outcome.length, 1);
  assert.equal(simple.note, '1 post is not in this story. It follows.');
  assert.deepEqual(
    simple.posts.map(({ id }) => id),
    ['p-4'],
  );
  assert.equal(
    simple.foot,
    'The thread has 2 posts. Technical shows each one.',
  );
  assert.equal(wantsStory(page, 'simple'), true);
  assert.equal(wantsStory(page, 'technical'), false);
  const covered = storyPage({ posts: [post('p-3')] });
  assert.equal(wantsStory(covered, 'simple'), false);
  assert.equal(threadLayout(covered, covered.posts, 'simple', now).note, null);
  // A post that moved in has an older number, and a story still leaves it out.
  const moved = storyPage({ posts: [post('p-1'), post('p-3')] });
  assert.deepEqual(
    threadLayout(moved, moved.posts, 'simple', now).posts.map(({ id }) => id),
    ['p-1'],
  );
});

await test('Technical shows the real posts and the outcome’s quote with its ID', () => {
  const page = storyPage();
  const technical = threadLayout(page, page.posts, 'technical', now);
  assert.equal(technical.steps, null);
  assert.deepEqual(technical.outcome, []);
  assert.equal(technical.outcomeQuote, 'Use it. (p-3)');
  assert.deepEqual(
    technical.posts.map(({ id }) => id),
    ['p-3', 'p-4'],
  );
  assert.equal(technical.note, null);
  assert.equal(technical.foot, null);
  assert.equal(
    threadLayout(page, page.posts, 'simple', now).outcomeQuote,
    'Use it.',
  );
});

await test('a story of an earlier outcome says so, shows the current quote, and drops its later lines in both views', () => {
  const page = storyPage({
    thread: thread({
      state: 'decided',
      outcome: { ...outcome, post: 'p-7', text: 'Use the other one.' },
    }),
    later: [post('p-9')],
  });
  assert.equal(
    wantsStory(storyPage({ ...page, posts: [post('p-3')] }), 'simple'),
    true,
  );
  const simple = threadLayout(page, [post('p-3')], 'simple', now);
  assert.deepEqual(simple.outcome, []);
  assert.equal(simple.outcomeQuote, 'Use the other one.');
  assert.equal(
    simple.stale,
    "This story is out of date: the thread's outcome changed.",
  );
  assert.equal(simple.note, null);
  assert.equal(simple.steps?.length, 1);
  // The record's later post stays in both views, because no current line tells it.
  for (const mode of ['simple', 'technical'] as const)
    assert.deepEqual(
      threadLayout(page, [post('p-3')], mode, now).later.map(({ key }) => key),
      ['p-9'],
    );
  const reopened = storyPage({ thread: thread({ posts: 2 }), later: [] });
  assert.equal(
    threadLayout(reopened, [post('p-3')], 'simple', now).stale,
    "This story is out of date: the thread's outcome changed.",
  );
  assert.equal(threadLayout(page, [post('p-3')], 'technical', now).stale, null);
});

await test('each later post is its own short item, with its link only in Technical', () => {
  const page = storyPage();
  assert.deepEqual(
    threadLayout(page, page.posts, 'technical', now).later.map(
      ({ key, post: id, line, text }) => [key, id, line, text],
    ),
    [
      ['line-0-p-8', 'p-8', null, 'Words of p-8.'],
      ['line-0-p-9', 'p-9', null, 'Words of p-9.'],
      ['p-10', 'p-10', null, 'It holds.'],
    ],
  );
  const simple = threadLayout(page, page.posts, 'simple', now).later;
  assert.equal(simple.length, 2);
  assert.equal(simple[0]?.line?.kind, 'later');
  assert.equal(simple[0]?.post, null);
  assert.equal(simple[1]?.post, null);
  assert.match(simple[1]?.who ?? '', /^Agent 1, \d\d:\d\d$/);
});

await test('with no story, Simple says so and leaves out Verifold’s own lines, which carry IDs', () => {
  const posts = [
    post('p-1'),
    post('p-2', { author: 'verifold', handle: null, kind: 'status' }),
  ];
  const page = storyPage({ story: null, posts, later: [] });
  const simple = threadLayout(page, posts, 'simple', now);
  assert.equal(simple.steps, null);
  assert.equal(
    simple.note,
    'The story of this thread is not ready yet. Here are its posts.',
  );
  assert.deepEqual(
    simple.posts.map(({ id }) => id),
    ['p-1'],
  );
  assert.equal(threadLayout(page, posts, 'technical', now).posts.length, 2);
  assert.equal(wantsStory(page, 'simple'), true);
  assert.equal(wantsStory({ ...page, posts: [] }, 'simple'), false);
  assert.equal(
    threadLayout({ ...page, posts: [] }, [], 'technical', now).foot,
    'This thread has no posts yet.',
  );
});

await test('the counts of threads and posts', () => {
  assert.equal(postCount({ posts: 1 }), '1 post');
  assert.equal(postCount({ posts: 6 }), '6 posts');
  assert.equal(
    allThreads({ threads: [thread()], omitted: { threads: 13 } }),
    'All 14 threads',
  );
  assert.equal(
    allThreads({ threads: [thread()], omitted: {} }),
    'All 1 thread',
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
