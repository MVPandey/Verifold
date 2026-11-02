import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Agent,
  CollabPage,
  Direction,
  IdeaPage,
  Lab,
  Need,
  Notice,
  Post,
  Question,
  Reach,
  Shot,
} from '../src/protocol/api.ts';
import {
  disagreementRows,
  gpuRows,
  needCollabRows,
  objectionRow,
} from '../src/app/collab-view.ts';
import {
  drawEmpty,
  drawHead,
  drawState,
  ideaGroups,
  ideaHead,
  shareLine,
  shotLine,
  shotTag,
} from '../src/app/idea-view.ts';
import { parseRoute, href } from '../src/app/route.ts';
import {
  answerHead,
  askWords,
  atNames,
  boxAgents,
  boxLevels,
  boxQuery,
  newestQuestions,
  noticesForYou,
  objectWords,
  postActs,
  priorLabel,
  reachWords,
  sourceWords,
  threadActs,
  workNote,
  type BoxAct,
} from '../src/app/step-in.ts';
import { threadLayout } from '../src/app/thread-view.ts';

const now = Date.UTC(2026, 10, 1, 17, 8);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const reader = (
  number: number,
  when: Reach['readers'][number]['when'] = 'step',
  until: string | null = null,
): Reach['readers'][number] => ({ handle: `agent-${number}`, when, until });

const words = (reach: Partial<Reach>): string =>
  reachWords({ readers: [], missed: [], ...reach }, now);

await test('the reach line says who reads and when, and who will not', () => {
  assert.equal(
    words({
      readers: [reader(3)],
      missed: [{ handle: 'agent-1', why: 'closed' }],
    }),
    "Agent 3 reads this after its current step. Agent 1 is closed, so it won't.",
  );
  assert.equal(
    words({ readers: [reader(2), reader(3), reader(4)] }),
    'Agents 2, 3 and 4 read this after their current steps.',
  );
  assert.equal(
    words({
      readers: [reader(2, 'now'), reader(3, 'slot'), reader(4, 'resume')],
    }),
    'Agent 2 reads this now. Agent 3 reads this when a slot is free. Agent 4 reads this after you resume the lab.',
  );
});

await test('a parked, a paused, and a crashed agent each read differently in words', () => {
  const at = ago(-30);
  assert.match(
    words({ readers: [reader(1, 'usage', at)] }),
    /^Agent 1 reads this when its usage window resets at \d\d:\d\d\.$/,
  );
  assert.equal(
    words({ readers: [reader(1, 'more-time')] }),
    'Agent 1 reads this after you give the lab more time.',
  );
  assert.equal(
    words({ readers: [reader(1, 'terminal')] }),
    'Agent 1 reads this after you give back its terminal.',
  );
  assert.equal(
    words({ missed: [{ handle: 'agent-1', why: 'crashed' }] }),
    "No agent works now, so no agent reads this. Agent 1 stopped by itself, so it won't until you start it again.",
  );
  assert.equal(
    words({
      readers: [reader(2)],
      missed: [
        { handle: 'agent-1', why: 'stopped' },
        { handle: 'agent-3', why: 'stopped' },
      ],
    }),
    "Agent 2 reads this after its current step. Agents 1 and 3 are stopped, so they won't.",
  );
});

await test('a line past 5 names counts, as 20 agents need', () => {
  const readers = Array.from({ length: 17 }, (_, index) => reader(index + 1));
  const missed = [18, 19, 20].map((number) => ({
    handle: `agent-${number}`,
    why: 'closed' as const,
  }));
  assert.equal(
    words({ readers, missed: [...missed, ...missed, ...missed] }),
    "17 agents read this after their current steps. 9 agents are closed, so they won't.",
  );
});

await test('the line of an objection says what an objection does', () => {
  assert.equal(
    objectWords('Agent 3 reads this now.'),
    'Agent 3 reads this now. An objection marks the post Disputed until a check or an answer settles it.',
  );
});

await test('asking the Coordinator wakes no agent, and a pause says why it waits', () => {
  assert.equal(
    askWords({ paused: null }),
    'The Coordinator answers from the record. No agent wakes.',
  );
  assert.match(
    askWords({ paused: { at: ago(1), reason: 'person' } }),
    /paused, so the Coordinator can't answer/,
  );
});

const agent = (number: number, more: Partial<Agent> = {}): Agent =>
  ({
    id: `a-${number}`,
    handle: `agent-${number}`,
    job: null,
    direction: `d-${number}`,
    status: 'working',
    ...more,
  }) as Agent;

await test('the box lists agents that work, those of the thread first', () => {
  const lab = {
    agents: [
      agent(1, { status: 'closed' }),
      agent(2),
      agent(3),
      agent(4),
      agent(9, { direction: null }),
    ],
  };
  assert.deepEqual(
    boxAgents(lab, { followers: ['a-4'] }, [
      { author: 'a-2' },
      { author: 'a-3' },
    ]).map(({ id }) => id),
    ['a-3', 'a-2', 'a-4'],
  );
});

await test('the box has four levels on a thread, and two on the home', () => {
  const levels = (
    lab: Pick<Lab, 'agentsHere'>,
    thread: unknown,
    who: Agent | null,
  ): readonly string[] => boxLevels(lab, thread, who).map(({ label }) => label);
  assert.deepEqual(levels({ agentsHere: true }, 't-3', agent(3)), [
    'Ask the Coordinator',
    'This thread',
    'Agent 3',
    'Everyone',
  ]);
  assert.deepEqual(levels({ agentsHere: true }, null, agent(3)), [
    'Ask the Coordinator',
    'Everyone',
  ]);
  assert.deepEqual(levels({ agentsHere: false }, 't-3', null), [
    'This thread',
    'Everyone',
  ]);
});

await test('the reach asks what the send does, so a name on the home narrows it', () => {
  const act: BoxAct = { kind: 'object', post: { id: 'p-3' } as Post };
  assert.deepEqual(boxQuery(undefined, null, 'lab', undefined, '@agent-3'), {
    thread: undefined,
    named: '@agent-3',
  });
  assert.deepEqual(boxQuery('t-2', null, 'lab', undefined, ''), {
    thread: 't-2',
    named: '',
    to: 'all',
  });
  assert.deepEqual(boxQuery('t-2', null, 'thread', 'a-3', ''), {
    thread: 't-2',
    named: '',
  });
  assert.deepEqual(boxQuery('t-2', null, 'agent', 'a-3', '@agent-4'), {
    thread: 't-2',
    named: '@agent-4',
    to: 'a-3',
  });
  assert.deepEqual(boxQuery('t-2', act, 'lab', 'a-3', ''), {
    thread: 't-2',
    named: '',
    replyTo: 'p-3',
  });
});

await test('the box sends the @ names of its text for the reach', () => {
  assert.equal(atNames('@agent-3 look at @d-2, mail@agent-4'), '@agent-3 @d-2');
  assert.equal(atNames('no names'), '');
});

await test('a post offers Object and a check, and the control says why not', () => {
  assert.deepEqual(postActs({ author: 'a-3' }), {
    object: true,
    canCheck: true,
    why: null,
  });
  assert.deepEqual(postActs({ author: 'a-3', noCheck: 'no-run' }), {
    object: true,
    canCheck: false,
    why: 'No check: it cites no run',
  });
  assert.equal(
    postActs({ author: 'a-3', noCheck: 'run-active' }).why,
    'No check yet: its run has not ended',
  );
  assert.equal(
    postActs({ author: 'a-3', noCheck: 'going' }).why,
    'A check waits or runs now',
  );
  assert.deepEqual(postActs({ author: 'person' }), {
    object: false,
    canCheck: false,
    why: null,
  });
});

const direction = (number: number, state: Direction['state']): Direction =>
  ({
    id: `d-${number}`,
    agent: `a-${number}`,
    state,
    longShot: false,
  }) as Direction;

await test('a thread offers Stop for an open agent and Reopen for an ended one', () => {
  const lab = {
    agents: [agent(1), agent(2), agent(3), agent(4)],
    directions: [
      direction(1, 'closed'),
      direction(2, 'open'),
      direction(3, 'stopped'),
      direction(4, 'open'),
    ],
  };
  const acts = threadActs(
    { direction: 'd-4', followers: ['a-1', 'a-2'] },
    [],
    lab,
  );
  assert.deepEqual(
    acts.stop.map(({ name }) => name),
    ['Agent 2', 'Agent 4'],
  );
  assert.deepEqual(
    acts.reopen.map(({ name }) => name),
    ['Agent 1'],
  );
  assert.match(workNote(acts), /^Stop asks you to confirm.*Reopen brings/);
  assert.doesNotMatch(workNote({ stop: [], reopen: acts.reopen }), /Stop/);
  assert.doesNotMatch(workNote({ stop: acts.stop, reopen: [] }), /Reopen/);
});

await test('an answer shows its sources, and each form says that no agent woke', () => {
  for (const state of ['waiting', 'answered', 'unanswered'] as const)
    assert.match(
      answerHead({ at: ago(1), state }, now),
      /No agent was disturbed\.$/,
    );
  assert.match(
    answerHead({ at: ago(1), state: 'answered' }, now),
    /Answered from the record/,
  );
  assert.equal(sourceWords(['p-1', 'p-2']), '2 posts');
  assert.equal(sourceWords(['p-1']), '1 post');
  const questions = ['q-1', 'q-2', 'q-3'].map(
    (id) => ({ id }) as unknown as Question,
  );
  assert.deepEqual(
    newestQuestions({ questions }).map(({ id }) => id),
    ['q-2', 'q-3'],
  );
});

const notice = (more: Partial<Notice>): Notice => ({
  id: 'n-1',
  at: ago(1),
  kind: 'overlap',
  posts: ['p-1', 'p-2'],
  to: ['a-1', 'a-3'],
  forYou: true,
  thread: 't-2',
  ...more,
});

await test('the person sees the notices that they can act on', () => {
  const lab = {
    agents: [agent(1), agent(3)],
    notices: [
      notice({}),
      notice({ id: 'n-2', kind: 'no-search', forYou: false }),
      notice({ id: 'n-3', kind: 'missing-answer', thread: 't-5' }),
    ],
  };
  assert.deepEqual(noticesForYou(lab, 'simple'), [
    {
      id: 'n-1',
      text: 'The Coordinator sees that Agents 1 and 3 may do the same work.',
      thread: 't-2',
    },
    {
      id: 'n-3',
      text: 'The Coordinator sees no answer yet to your message.',
      thread: 't-5',
    },
  ]);
  assert.match(noticesForYou(lab, 'technical')[0]?.text ?? '', /\(p-1, p-2\)/);
  assert.equal(noticesForYou(lab, 'simple', 't-5').length, 1);
});

await test('the label of prior work comes from the record', () => {
  assert.match(
    priorLabel(
      { search: { lookups: 6, at: ago(37), helper: 'agent-1.1' } },
      now,
    ),
    /^Prior work · Helper 1\.1 · \d\d:\d\d · 6 lookups$/,
  );
  assert.match(
    priorLabel({ search: { lookups: 1, at: ago(1), helper: null } }, now),
    /^Prior work · \d\d:\d\d · 1 lookup$/,
  );
  assert.equal(priorLabel({}, now), 'Prior work · No lookups on record');
});

const disagreement = (
  more: Partial<CollabPage['disagreements'][number]>,
): CollabPage['disagreements'][number] => ({
  post: 'p-32',
  author: 'a-1',
  handle: 'agent-1',
  thread: {
    id: 't-2',
    title: 'Which model?',
    plainTitle: 'Plain',
    state: 'open',
  },
  text: 'A post.',
  objections: [{ post: 'p-36', author: 'a-3', handle: 'agent-3' }],
  answered: false,
  check: null,
  ...more,
});

await test('a disagreement reads from the record in both views', () => {
  const rows = (entry: CollabPage['disagreements'][number]) => ({
    simple: disagreementRows({ disagreements: [entry] }, 'simple')[0],
    technical: disagreementRows({ disagreements: [entry] }, 'technical')[0],
  });
  const plain = rows(disagreement({}));
  assert.equal(plain.simple?.title, 'Plain');
  assert.equal(plain.technical?.title, 'Which model?');
  assert.equal(
    plain.simple?.sub,
    "Agent 3 objects to Agent 1's post. No check yet.",
  );
  assert.equal(
    plain.technical?.sub,
    'p-36 objects to p-32 by Agent 1. No check.',
  );
  assert.equal(plain.simple?.to, href.thread('t-2'));
  const checked = rows(
    disagreement({
      check: {
        id: 'k-1',
        state: 'done',
        outcome: 'fails',
        method: 'code-read',
      },
      answered: true,
    }),
  );
  assert.equal(
    checked.simple?.sub,
    "Agent 3 objects to Agent 1's post. Agent 1 answered and did not accept. A code check did not hold. No verdict yet.",
  );
  assert.match(checked.technical?.sub ?? '', /k-1 \(code-read\) fails/);
  assert.equal(
    rows(
      disagreement({
        objections: [{ post: 'p-36', author: 'person', handle: null }],
        author: 'person',
        handle: null,
        thread: null,
      }),
    ).simple?.sub,
    'You object to your post. No check yet.',
  );
});

const objections = (
  more: Partial<CollabPage['objections']>,
): CollabPage['objections'] => ({
  total: 9,
  accepted: 8,
  unanswered: 1,
  by: [
    { author: 'a-3', handle: 'agent-3', count: 7 },
    { author: 'a-2', handle: 'agent-2', count: 2 },
  ],
  ...more,
});

await test('the count says who raised objections and who raised none, and no message count', () => {
  const row = objectionRow({
    objections: objections({}),
    handles: ['agent-1', 'agent-2', 'agent-3', 'agent-4'],
  });
  assert.equal(row.title, '9 objections so far');
  assert.equal(row.chip?.label, '8 accepted');
  assert.equal(
    row.sub,
    'Agent 3 raised 7 and Agent 2 raised 2. 1 got no reply. Agents 1 and 4 raised none.',
  );
  assert.doesNotMatch(`${row.title} ${row.sub}`, /message|post/i);
  assert.equal(
    objectionRow({
      objections: objections({ total: 0, accepted: 0, unanswered: 0, by: [] }),
      handles: [],
    }).chip,
    null,
  );
});

const need = (more: Partial<Need>): Need => ({
  waiter: 'a-3',
  waiterHandle: 'agent-3',
  on: 'a-2',
  onHandle: 'agent-2',
  post: 'p-180',
  reason: 'ask',
  thread: 't-6',
  subject: 'Rebuild d-2?',
  text: 'Please send the manifest.',
  since: ago(7),
  blocked: false,
  onEnded: null,
  plainSubject: 'Rebuild the test?',
  ...more,
});

await test('who needs whom folds a pair into one row, and says what holds it', () => {
  const rows = needCollabRows(
    {
      needs: [
        need({ post: 'p-1', since: ago(60) }),
        need({ blocked: true }),
        need({
          post: 'p-9',
          on: 'a-1',
          onHandle: 'agent-1',
          reason: 'objection',
          onEnded: 'closed',
        }),
        need({
          post: 'p-10',
          waiter: 'a-4',
          waiterHandle: 'agent-4',
          on: 'person',
          onHandle: null,
        }),
      ],
    },
    'simple',
    now,
  );
  assert.deepEqual(
    rows.map(({ title, chip }) => [title, chip?.label]),
    [
      ['Agent 3 needs Agent 2', 'Waits on you'],
      ['Agent 4 needs you', 'Waits on you'],
      ['Agent 3 needs Agent 1', 'Closed'],
    ],
  );
  assert.equal(
    rows[0]?.sub,
    "Asked 7 min ago: Rebuild the test? 1 more stands. It can't move until you decide.",
  );
  assert.match(rows[2]?.sub ?? '', /Objected .* until the agent works again/);
  assert.match(
    needCollabRows({ needs: [need({})] }, 'technical', now)[0]?.sub ?? '',
    /p-180.*Please send the manifest/,
  );
});

const gpu = (more: Partial<CollabPage['gpu']>): CollabPage['gpu'] => ({
  atOnce: 1,
  running: [],
  queued: [],
  requested: [],
  pods: [],
  idle: null,
  ...more,
});

await test('the GPU queue names who waits behind whom, and what the record says of free time', () => {
  const running = { run: 'r-52', handle: 'agent-4', since: ago(2) };
  const queued = { run: 'r-49', handle: 'agent-3', since: ago(8) };
  const shown = gpu({
    running: [running],
    queued: [queued],
    pods: ['lease-4'],
    idle: { from: ago(30), to: ago(9) },
  });
  const [simple] = gpuRows({ gpu: shown }, 'simple');
  assert.equal(simple?.title, 'Agent 3 needs the GPU');
  assert.equal(simple?.chip?.label, 'Behind Agent 4');
  assert.match(simple?.sub ?? '', /^1 GPU at a time\. No GPU run from /);
  assert.doesNotMatch(simple?.sub ?? '', /lease|r-49/);
  const [technical] = gpuRows({ gpu: shown }, 'technical');
  assert.match(
    technical?.sub ?? '',
    /^r-49 queued .* Pods at once: 1\. lease-4 active\./,
  );
  assert.equal(
    gpuRows(
      { gpu: gpu({ requested: [{ lease: 'lease-5', at: ago(1) }] }) },
      'simple',
    )[0]?.title,
    'A pod waits for you',
  );
  assert.equal(
    gpuRows({ gpu: gpu({ running: [running] }) }, 'simple')[0]?.chip?.label,
    'Agent 4 runs',
  );
  assert.deepEqual(gpuRows({ gpu: gpu({ atOnce: null }) }, 'simple'), []);
});

const idea = (text: string, tried: boolean): IdeaPage['ideas'][number] => ({
  id: text,
  text,
  tried,
  sources: 0,
});

const shot: Shot = {
  thread: 't-9',
  post: 'p-9',
  question: 'Does it work?',
  ideas: ['One', 'Two', 'Three'],
  harness: 'codex',
  sense: 4,
  test: 'Run it on one seed.',
  cost: 'About 2 hours of GPU',
  prior: 0,
  closest: 'none found',
};

await test('the idea map splits ideas, and each candidate reads from the record', () => {
  const ideas = [idea('Old', true), idea('New', false)];
  assert.deepEqual(
    ideaGroups({ ideas }).tried.map(({ text }) => text),
    ['Old'],
  );
  assert.equal(ideaHead({ ideas, ideaCount: 2 }), "2 of the lab's ideas");
  assert.equal(ideaHead({ ideas, ideaCount: 9 }), "2 of the lab's 9 ideas");
  assert.equal(shotTag('simple'), 'Long shot');
  assert.equal(shotTag('technical'), 'Alien');
  assert.equal(
    shotLine(shot),
    'One + Two + Three. Judge (Codex): 4 of 5 for sense. Test: Run it on one seed. Cost: About 2 hours of GPU. Search: no paper combines these ideas. Closest: none found.',
  );
  assert.match(shotLine({ ...shot, prior: 1 }), /1 paper combines these ideas/);
  assert.match(drawHead({ at: ago(1), by: 'ruled-out' }, now), /a failed line/);
  assert.match(drawHead({ at: ago(1), by: 'person' }, now), /your Draw again/);
  assert.match(
    drawEmpty({ judged: false, shots: [] }) ?? '',
    /No judgment came/,
  );
  assert.equal(drawEmpty({ judged: true, shots: [shot] }), null);
});

await test('the page says who works on long shots, and what draws do now', () => {
  const directions = [
    { state: 'open', longShot: true },
    { state: 'open', longShot: false },
    { state: 'closed', longShot: true },
  ] as Direction[];
  assert.match(
    shareLine({ directions, share: 'far' }),
    /^1 of 2 agents work on long shots.*You chose Far when you asked\.$/,
  );
  assert.match(shareLine({ directions, share: null }), /no share/);
  assert.match(
    drawState({ stopped: false, drawing: 'waiting' }) ?? '',
    /may never run/,
  );
  assert.match(
    drawState({ stopped: true, drawing: null }) ?? '',
    /You stopped long shots/,
  );
  assert.equal(drawState({ stopped: false, drawing: null }), null);
});

await test('two new pages have their own addresses', () => {
  assert.deepEqual(parseRoute(href.team), { page: 'team' });
  assert.deepEqual(parseRoute(href.ideas), { page: 'ideas' });
});

await test("Simple can open a story's posts in place, to act on one of them", () => {
  const post = { id: 'p-2', author: 'a-2' } as Post;
  const page = {
    thread: { id: 't-2', posts: 1, outcome: null },
    posts: [post],
    more: false,
    story: { at: ago(1), posts: ['p-2'], outcome: null, lines: [] },
  } as unknown as Parameters<typeof threadLayout>[0];
  const closed = threadLayout(page, [post], 'simple', now);
  assert.deepEqual(closed.posts, []);
  assert.equal(closed.showPosts, 'Show the post here');
  const open = threadLayout(page, [post], 'simple', now, true);
  assert.deepEqual(open.posts, [post]);
  assert.equal(open.showPosts, null);
  assert.equal(threadLayout(page, [post], 'technical', now).showPosts, null);
});
