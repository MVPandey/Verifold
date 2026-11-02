import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Brief,
  Direction,
  Lab,
  Post,
  Question,
  Snapshot,
} from '../src/protocol/api.ts';
import { Screen } from '../src/app/App.tsx';
import { AgentList } from '../src/app/components/AgentList.tsx';
import {
  Answers,
  NoticeLines,
  PostActs,
  PriorBlock,
} from '../src/app/components/StepInParts.tsx';
import { ControlsContext, labControls } from '../src/app/controls.ts';
import type { Route } from '../src/app/route.ts';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';
import {
  threadedLab,
  ViewContext,
  type ViewMode,
} from '../src/app/view-mode.ts';
import { controls } from './app-controls-fixture.ts';

const now = Date.UTC(2026, 10, 1, 17, 8);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const brief: Brief = { at: ago(1), top: 'One test runs.', lines: [] };

const agent = (number: number, more: Partial<Agent> = {}): Agent => ({
  id: `a-${number}`,
  handle: `agent-${number}`,
  job: `Job ${number}`,
  harness: 'codex',
  model: null,
  direction: `d-${number}`,
  check: null,
  status: 'working',
  until: null,
  live: { state: 'working', text: 'Working', since: ago(1) },
  line: { doing: 'It works', why: 'A reason', next: 'More', at: ago(5) },
  helpers: [],
  lastPostAt: ago(5),
  turns: { turns: [], more: false },
  spendUsd: null,
  ...more,
});

const direction = (number: number): Direction => ({
  id: `d-${number}`,
  title: `Direction ${number}`,
  job: `Job ${number}`,
  team: `Team ${Math.ceil(number / 4)}`,
  bar: null,
  runs: null,
  noise: null,
  buildsOn: [],
  state: 'open',
  verdict: 'open',
  disputed: false,
  evidence: null,
  agent: `a-${number}`,
  openedBy: 'a-1',
  openedAt: ago(200),
  stoppedAt: null,
  head: 'abc',
});

const numbers = (count: number): readonly number[] =>
  Array.from({ length: count }, (_, index) => index + 1);

const lab = (count: number, more: Partial<Lab> = {}): Lab => ({
  question: 'Do months sit on a circle?',
  reading: { papers: 14, lookups: 30, lastPaperAt: ago(60) },
  brief,
  notices: [],
  questions: [],
  startedAt: ago(230),
  agentsHere: true,
  paused: null,
  budget: null,
  money: { plansUsd: 1, gpuUsd: 0, gpuLimitUsd: null },
  needsYou: [],
  answered: [],
  directions: numbers(count).map(direction),
  agents: numbers(count).map((number) => agent(number)),
  planner: 'a-1',
  plan: null,
  board: { posts: [], more: false },
  disputes: [],
  threads: [],
  waits: [],
  runs: [],
  checks: [],
  signoff: null,
  works: [],
  away: null,
  omitted: {},
  ...more,
});

const inView = (shown: Lab, mode: ViewMode, node: ReactNode): string =>
  renderToStaticMarkup(
    <ControlsContext.Provider value={controls}>
      <ViewContext.Provider
        value={{ mode, threaded: threadedLab(shown), setMode: () => {} }}
      >
        {node}
      </ViewContext.Provider>
    </ControlsContext.Provider>,
  );

const screen = (shown: Lab, route: Route): string =>
  inView(
    shown,
    'simple',
    <Screen
      state={{
        snapshot: {
          version: 1,
          epoch: 'a',
          rev: 1,
          at: ago(0),
          project: 'demo',
          lab: shown,
          trimmed: false,
        } as unknown as Snapshot,
        connection: 'live',
        retrying: false,
      }}
      route={route}
      now={now}
      actions={{} as LabActions}
      agentActions={{} as AgentActions}
    />,
  );

await test('up to 6 agents the home keeps its rows, and it links to the two new pages', () => {
  const html = inView(
    lab(6),
    'simple',
    <AgentList lab={lab(6)} now={now} answer="The answer so far" />,
  );
  assert.equal(html.match(/class="agent-row"/g)?.length, 6);
  assert.match(html, /Who is doing what/);
  assert.match(html, /href="#\/team">How they work together</);
  assert.match(html, /<a class="lit" href="#\/ideas">/);
  assert.doesNotMatch(html, /Needs a look/);
});

await test('past 6 agents the home lists trouble by name and folds the rest into teams that open', () => {
  const shown = lab(20, {
    waits: [
      {
        waiter: 'a-13',
        waiterHandle: 'agent-13',
        on: 'a-2',
        onHandle: 'agent-2',
        post: 'p-9',
        reason: 'ask',
        thread: 't-2',
        subject: 'Which seed leaks?',
        text: 'Which seed leaks?',
        since: ago(38),
      },
    ],
  });
  const html = inView(
    shown,
    'simple',
    <AgentList lab={shown} now={now} answer="The answer so far" />,
  );
  assert.match(html, /Needs a look · 1 of 20 agents/);
  assert.match(html, /Agent 13<\/a> waits on Agent 2: Which seed leaks\?/);
  assert.match(html, />38 min</);
  assert.match(html, /Teams · 5/);
  assert.equal(html.match(/<details class="team">/g)?.length, 5);
  assert.match(html, /Team 1 · Agents 1, 2, 3 and 4/);
  assert.equal(html.match(/class="agent-row"/g)?.length, 20);
  assert.match(html, /href="#\/team">How they work together</);
  assert.match(html, /<a class="lit" href="#\/ideas">/);
});

await test('a lab from before threads has neither new page', () => {
  const old = lab(1, { brief: null });
  for (const page of ['team', 'ideas'] as const)
    assert.doesNotMatch(
      screen(old, { page }),
      /How they work together|Idea map/,
    );
  assert.match(screen(lab(1), { page: 'team' }), /How they work together/);
  assert.match(screen(lab(1), { page: 'ideas' }), /Idea map/);
});

const post = (more: Partial<Post> = {}): Post => ({
  id: 'p-3',
  at: ago(40),
  author: 'a-2',
  handle: 'agent-2',
  harness: 'codex',
  kind: 'proposal',
  direction: 'd-2',
  thread: 't-2',
  text: 'Use the old mix.',
  replyTo: null,
  mentions: [],
  proof: [],
  ...more,
});

await test('a post offers Reply, Object, and a check, or says why no check can start', () => {
  const can = inView(
    lab(1),
    'simple',
    <PostActs post={post()} onAct={() => {}} />,
  );
  assert.match(can, />Reply<.*>Object<.*>Ask for a check</s);
  const cannot = inView(
    lab(1),
    'simple',
    <PostActs post={post({ noCheck: 'no-run' })} onAct={() => {}} />,
  );
  assert.match(cannot, /No check: it cites no run/);
  assert.doesNotMatch(cannot, /Ask for a check/);
  const mine = inView(
    lab(1),
    'simple',
    <PostActs post={post({ author: 'person' })} onAct={() => {}} />,
  );
  assert.doesNotMatch(mine, /Object/);
});

await test('prior work shows what the agent wrote under a label from the record', () => {
  const html = inView(
    lab(1),
    'simple',
    <PriorBlock
      post={post({
        prior: { closest: 'One paper.', newHere: 'A direct test.' },
        search: { lookups: 6, at: ago(37), helper: 'agent-1.1' },
      })}
      now={now}
    />,
  );
  assert.match(html, /Helper 1\.1/);
  assert.match(html, /6 lookups/);
  assert.match(html, /Closest.*One paper\./);
  assert.doesNotMatch(html, /Not found/);
  assert.equal(
    inView(lab(1), 'simple', <PriorBlock post={post()} now={now} />),
    '',
  );
  assert.match(
    inView(
      lab(1),
      'simple',
      <PriorBlock
        post={post({ search: { lookups: 2, at: ago(1), helper: null } })}
        now={now}
      />,
    ),
    /wrote no summary/,
  );
});

const question = (more: Partial<Question> = {}): Question => ({
  id: 'q-1',
  at: ago(2),
  text: 'Why did we drop the old model?',
  state: 'answered',
  answer: {
    kind: 'answer',
    at: ago(1),
    plain: 'Agent 3 objected, and Agent 1 agreed.',
    quotes: [{ post: 'p-3', text: 'Use the old mix.' }],
    posts: ['p-3', 'p-4'],
    thread: 't-2',
    evidence: "One agent's result. No check yet.",
    check: { state: 'passed', by: 'codex', sameHarness: false },
  },
  ...more,
});

await test('an answer shows with its source posts, and says that no agent was disturbed', () => {
  const shown = lab(1, { questions: [question()] });
  const simple = inView(shown, 'simple', <Answers lab={shown} now={now} />);
  assert.match(simple, /Answered from the record\. No agent was disturbed\./);
  assert.match(simple, /Why did we drop the old model\?/);
  assert.match(simple, /Agent 3 objected, and Agent 1 agreed\./);
  assert.match(simple, /href="#\/thread\/t-2">2 posts</);
  const technical = inView(
    shown,
    'technical',
    <Answers lab={shown} now={now} />,
  );
  assert.match(technical, /Use the old mix\./);
  const waiting = lab(1, {
    questions: [question({ state: 'waiting', answer: null })],
  });
  assert.match(
    inView(waiting, 'simple', <Answers lab={waiting} now={now} />),
    /Reading the record\. No agent was disturbed\./,
  );
});

await test('a notice for the person links to its thread', () => {
  const shown = lab(3, {
    notices: [
      {
        id: 'n-1',
        at: ago(1),
        kind: 'overlap',
        posts: ['p-1', 'p-2'],
        to: ['a-1', 'a-3'],
        forYou: true,
        thread: 't-2',
      },
    ],
  });
  const html = inView(shown, 'simple', <NoticeLines lab={shown} />);
  assert.match(html, /Agents 1 and 3 may do the same work/);
  assert.match(html, /href="#\/thread\/t-2"/);
  assert.doesNotMatch(
    inView(shown, 'simple', <NoticeLines lab={shown} thread="t-2" />),
    /href=/,
  );
});

await test('the controls of the person send the actions of the lab', async (t) => {
  const seen: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => {
    seen.push({
      url,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    });
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  const real = labControls('token');
  await real.object('p-3', 'No.', 'key');
  await real.writeTo('t-2', 'a-3', 'Look.', 'key');
  await real.writeTo(null, 'all', 'Look.', 'key');
  await real.askCheck('p-3', 'key');
  await real.overturn('t-2', 'key');
  await real.reopenDirection('d-1', 't-2', 'key');
  await real.reopenDirection('d-1', null, 'key');
  await real.askCoordinator('Why?', 'key');
  await real.draw('key');
  await real.stopLongShots('key');
  await real.reach({ thread: 't-2', to: 'a-3', named: '@d-2' });
  await real.collab();
  await real.ideas();
  assert.deepEqual(
    seen.map(({ url }) => url.replace('/api/v1/', '').replace('actions/', '')),
    [
      'lab-post',
      'lab-post',
      'lab-post',
      'lab-check',
      'lab-overturn',
      'lab-direction-reopen',
      'lab-direction-reopen',
      'lab-ask',
      'lab-draw',
      'lab-long-shots-stop',
      'reach?thread=t-2&to=a-3&named=%40d-2',
      'collab',
      'ideas',
    ],
  );
  assert.deepEqual(seen[0]?.body, {
    text: 'No.',
    kind: 'objection',
    replyTo: 'p-3',
    key: 'key',
  });
  assert.deepEqual(seen[2]?.body, { text: 'Look.', to: 'all', key: 'key' });
  assert.deepEqual(seen[6]?.body, { direction: 'd-1', key: 'key' });
});
