import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Brief,
  BriefLine,
  Direction,
  Lab,
  Post,
  Snapshot,
  StoryLine,
  Thread,
  ThreadPage,
} from '../src/protocol/api.ts';
import { Screen } from '../src/app/App.tsx';
import { labControls } from '../src/app/controls.ts';
import { AwayDigest } from '../src/app/components/AwayDigest.tsx';
import { BoardThread } from '../src/app/components/BoardThread.tsx';
import { IdText } from '../src/app/components/IdText.tsx';
import { Disputes } from '../src/app/components/LabControls.tsx';
import { StepInBox } from '../src/app/components/StepInBox.tsx';
import { ThreadBody } from '../src/app/screens/ThreadPage.tsx';
import type { Route } from '../src/app/route.ts';
import type { BoxAct } from '../src/app/step-in.ts';
import type { LabActions } from '../src/app/screens/LabHome.tsx';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
import {
  threadedLab,
  ViewContext,
  type ViewMode,
} from '../src/app/view-mode.ts';

const now = Date.UTC(2026, 10, 1, 17, 8);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const actions = {} as LabActions;
const agentActions = {} as AgentActions;

const post = (id: string, more: Partial<Post> = {}): Post => ({
  id,
  at: ago(40),
  author: 'a-2',
  handle: 'agent-2',
  job: 'Controls',
  harness: 'codex',
  kind: 'result',
  direction: 'd-2',
  thread: 't-2',
  text: `Seed 1 gives 55% in ${id}, and d-2 holds.`,
  replyTo: null,
  mentions: [],
  proof: [{ type: 'run', run: 'r-7' }],
  ...more,
});

const line = (more: Partial<BriefLine> = {}): BriefLine => ({
  kind: 'open',
  at: ago(20),
  plain: 'The first run gave 55%, in plain words.',
  quotes: [{ post: 'p-3', text: 'Seed 1 gives 55%.' }],
  posts: ['p-3'],
  thread: 't-2',
  evidence: "One agent's result. No check yet.",
  check: { state: 'passed', by: 'codex', sameHarness: false },
  ...more,
});

const brief: Brief = {
  at: ago(1),
  top: 'One test is running.',
  topIds: 'd-2 is running.',
  lines: [line()],
};

const agent: Agent = {
  id: 'a-2',
  handle: 'agent-2',
  job: 'Controls',
  harness: 'codex',
  model: null,
  direction: 'd-2',
  check: null,
  status: 'working',
  until: null,
  live: { state: 'working', text: 'Running probe.py', since: ago(1) },
  line: {
    doing: 'Tests the control',
    why: 'You asked for one',
    next: 'Read the result',
    at: ago(5),
  },
  turns: { turns: [], more: false },
  spendUsd: null,
};

const direction: Direction = {
  id: 'd-2',
  title: 'A long title of the line of work',
  job: 'Controls',
  bar: null,
  runs: null,
  noise: null,
  buildsOn: [],
  state: 'open',
  verdict: 'open',
  disputed: false,
  evidence: null,
  agent: 'a-2',
  openedBy: 'a-1',
  openedAt: ago(200),
  stoppedAt: null,
  head: 'a',
};

const thread = (more: Partial<Thread> = {}): Thread => ({
  id: 't-2',
  title: 'Does the agents’ title hold?',
  plainTitle: 'Does the person’s title hold?',
  state: 'open',
  why: 'It decides the next step.',
  direction: null,
  openedBy: 'a-1',
  at: ago(100),
  outcome: null,
  followers: [],
  agreed: [],
  posts: 2,
  lastAt: ago(20),
  ...more,
});

const plan = {
  post: 'p-1',
  at: ago(150),
  reading: 'How the planner reads it.',
  cost: 'No cost.',
  directions: ['d-2'],
  facts: [],
};

function lab(more: Partial<Lab> = {}): Lab {
  return {
    question: 'Does the control beat chance?',
    startedAt: ago(230),
    agentsHere: true,
    paused: null,
    budget: null,
    money: { plansUsd: 1, gpuUsd: 1, gpuLimitUsd: 25 },
    reading: { papers: 14, lookups: 20, lastPaperAt: ago(143) },
    brief,
    needsYou: [],
    answered: [],
    directions: [direction],
    agents: [agent],
    plan,
    board: { posts: [], more: false },
    disputes: [],
    threads: [thread()],
    waits: [],
    runs: [],
    checks: [],
    signoff: null,
    works: [],
    away: null,
    omitted: {},
    ...more,
  };
}

/** A page as the app gives it: the view follows the lab, and Technical needs a lab with threads. */
function inView(shown: Lab, mode: ViewMode, children: ReactNode): string {
  const threaded = threadedLab(shown);
  return renderToStaticMarkup(
    <ViewContext.Provider
      value={{
        mode: threaded ? mode : 'simple',
        threaded,
        setMode: () => {},
      }}
    >
      {children}
    </ViewContext.Provider>,
  );
}

function page(shown: Lab, route: Route, mode: ViewMode = 'simple'): string {
  const snapshot = {
    project: 'lab',
    at: ago(0),
    lab: shown,
    trimmed: false,
  } as unknown as Snapshot;
  return inView(
    shown,
    mode,
    <Screen
      state={{ snapshot, connection: 'live', retrying: false }}
      route={route}
      now={now}
      actions={actions}
      agentActions={agentActions}
    />,
  );
}

const home = (more: Partial<Lab> = {}, mode: ViewMode = 'simple'): string =>
  page(lab(more), { page: 'lab' }, mode);

const olderOf = (posts: readonly Post[], more = false) => ({
  posts,
  more,
  gap: false,
  busy: false,
  problem: null,
  show: () => Promise.resolve(),
});

const storyLine = (
  kind: BriefLine['kind'],
  plain: string | null,
  posts: readonly string[] = ['p-3'],
): StoryLine => ({
  ...line({ kind, plain, posts }),
  author: 'a-2',
  handle: 'agent-2',
  harness: 'codex',
});

const threadPage = (more: Partial<ThreadPage> = {}): ThreadPage => ({
  thread: thread({
    state: 'decided',
    outcome: {
      text: 'Use the first set.',
      post: 'p-3',
      by: 'a-2',
      at: ago(40),
    },
  }),
  posts: [post('p-2'), post('p-3')],
  more: false,
  story: null,
  later: [],
  takingPart: { handles: ['agent-2'], byPerson: false },
  ...more,
});

const body = (
  shown: ThreadPage,
  mode: ViewMode,
  more: { readonly onAct?: (act: BoxAct) => void } = {},
): string =>
  inView(
    lab(),
    mode,
    <ThreadBody
      page={shown}
      lab={lab()}
      older={olderOf(shown.posts, shown.more)}
      now={now}
      {...more}
    />,
  );

await test('a lab with threads gets the new home, top to bottom', () => {
  const html = home();
  const order = [
    'lab-question',
    'Nothing needs you.',
    'One test is running.',
    'Who is doing what',
    'Reading map: 14 papers.',
    'Open threads',
    'Write to the lab, or ask the Coordinator',
  ].map((text) => html.indexOf(text));
  assert.ok(order.every((at) => at >= 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.doesNotMatch(html, /section--board|class="row"/);
});

await test('an old lab keeps its home, with no switch, whatever the browser chose', () => {
  for (const mode of ['simple', 'technical'] as const) {
    const html = home({ brief: null, threads: [] }, mode);
    assert.match(html, />Directions</);
    assert.doesNotMatch(html, /class="switch"|lab-question|Who is doing what/);
  }
  const shown = lab({ brief: null, threads: [] });
  const plain = inView(
    shown,
    'technical',
    <BoardThread thread={{ root: post('p-3'), replies: [] }} />,
  );
  assert.match(plain, /Run r-7/);
  assert.match(plain, /and d-2 holds/);
  assert.doesNotMatch(plain, /class="id"|post__time/);
  assert.match(page(shown, { page: 'threads' }), /This page does not exist/);
});

await test('a lab before its plan keeps the planner’s home', () => {
  const html = home({ plan: null });
  assert.doesNotMatch(html, /lab-question/);
});

await test('every lab page has one switch, and it says which view is on', () => {
  for (const route of [
    { page: 'lab' },
    { page: 'threads' },
    { page: 'thread', id: 't-2' },
  ] as const) {
    const html = page(lab(), route, 'technical');
    assert.equal(html.match(/class="switch"/g)?.length, 1);
    assert.match(html, /aria-pressed="false"[^>]*>Simple</);
    assert.match(html, /aria-pressed="true"[^>]*>Technical</);
  }
});

await test('Simple shows plain words and a way to the quote, and Technical quotes with linked IDs', () => {
  const simple = home();
  assert.match(simple, /The first run gave 55%, in plain words\./);
  assert.match(simple, />Original posts</);
  assert.doesNotMatch(simple, /Seed 1 gives 55%/);
  assert.match(simple, /One test is running\./);
  assert.match(simple, /href="#\/thread\/t-2">Thread</);
  const technical = home({}, 'technical');
  assert.match(
    technical,
    /Seed 1 gives 55%\. \(<a class="id" href="#\/post\/p-3">p-3</,
  );
  assert.match(
    technical,
    /<a class="id" href="#\/d\/d-2">d-2<\/a> is running\./,
  );
  assert.doesNotMatch(technical, /in plain words|Original posts/);
  assert.match(technical, /The line above quotes its posts unchanged\./);
  assert.match(technical, /Next: Read the result/);
  assert.match(technical, /Controls, <a class="id"[^>]*>d-2<\/a> · Codex/);
});

await test('a line with no plain words shows its quote, without Verifold’s IDs, and with no toggle', () => {
  for (const state of ['pending', 'failed', 'numbers', 'withheld'] as const) {
    const html = home({
      brief: {
        ...brief,
        lines: [
          line({
            plain: null,
            check: { state, by: null, sameHarness: false },
          }),
        ],
      },
    });
    assert.match(html, /Seed 1 gives 55%\./);
    assert.doesNotMatch(html, /\(p-3\)|Original posts/);
  }
});

await test('no brief yet shows the records’ top line and a short honest line', () => {
  const html = home({
    brief: { at: null, top: 'One test is running.', lines: [] },
  });
  assert.match(html, /The Coordinator has no lines yet\./);
  assert.doesNotMatch(html, /brief__line|Plain words from/);
  assert.match(html, /One test is running\./);
});

await test('since you left shows the direction lines and the numbers, with no ID of Verifold’s in Simple', () => {
  const news = {
    lines: [
      {
        direction: 'd-2',
        title: 'The control beats chance',
        mark: 'open' as const,
        said: 'Not settled yet. 4 new posts.',
      },
    ],
    moreLines: 2,
    counts: '15 posts, 2 runs ended (1 failed: r-93)',
    cost: 'Spent since then: $1.',
  };
  const away = { since: ago(152), spentThen: { plansUsd: 0, gpuUsd: 0 }, news };
  const simple = home({ away });
  assert.match(simple, /Since you left at/);
  assert.match(simple, /href="#\/d\/d-2">The control beats chance</);
  assert.match(simple, /Not settled yet\. 4 new posts\./);
  assert.match(simple, /2 more directions changed too\./);
  assert.match(simple, /2 runs ended \(1 failed\)\./);
  assert.match(simple, /Spent since then: \$1\./);
  assert.doesNotMatch(simple, /Nothing changed/);
  assert.match(home({ away }, 'technical'), /1 failed: r-93/);
});

await test('the time away says "Nothing changed." only when its news is quiet', () => {
  const away = (news?: NonNullable<Lab['away']>['news']): Lab['away'] => ({
    since: ago(152),
    spentThen: { plansUsd: 0, gpuUsd: 0 },
    ...(news ? { news } : {}),
  });
  const news = { lines: [], moreLines: 0, counts: '', cost: '' };
  assert.match(home({ away: away(news) }), /Nothing changed\./);
  assert.match(
    home({ away: away({ ...news, cost: 'Spent since then: $1.' }) }),
    /No post, run, or call came\./,
  );
  // A server from before these words sends only the time away.
  assert.doesNotMatch(
    home({ away: away() }),
    /Nothing changed|No post, run, or call/,
  );
});

await test('an old lab’s digest reads as it did, with its run IDs', () => {
  const shown = lab({ brief: null, threads: [] });
  const html = inView(
    shown,
    'technical',
    <AwayDigest
      away={{
        since: ago(40),
        spentThen: { plansUsd: 0, gpuUsd: 0 },
        news: {
          lines: [],
          moreLines: 0,
          counts: '2 runs ended (1 failed: r-93)',
          cost: '',
        },
      }}
      now={now}
      onDismiss={null}
    />,
  );
  assert.match(html, /While you were away/);
  assert.match(html, /1 failed: r-93/);
});

await test('agent rows show the job, the harness, the chip, and the agent’s own words in both views', () => {
  for (const mode of ['simple', 'technical'] as const) {
    const html = home({}, mode);
    assert.match(html, /href="#\/d\/d-2">Agent 2</);
    assert.match(html, /Tests the control\. You asked for one\./);
    assert.match(html, /state--run">Working</);
  }
  assert.match(home(), /Controls · Codex/);
});

await test('open threads show the title of the view, the state, the count, and a link', () => {
  const html = home();
  assert.match(html, /href="#\/thread\/t-2"/);
  assert.match(html, /Does the person’s title hold\?/);
  assert.match(html, /state--open">Open</);
  assert.match(html, /2 posts/);
  assert.match(html, /All 1 thread</);
  assert.match(home({}, 'technical'), /Does the agents’ title hold\?/);
  // The answer stays one link away, and a page that links nowhere stays out.
  assert.match(html, /href="#\/answer"/);
  assert.match(html, /How they work together/);
});

await test('all threads go by state, open first', () => {
  const html = page(
    lab({
      threads: [
        thread({ id: 't-3', state: 'closed', title: 'A closed one here' }),
        thread(),
      ],
      omitted: { threads: 2 },
    }),
    { page: 'threads' },
  );
  assert.ok(html.indexOf('>Open<') < html.indexOf('>Closed<'));
  assert.match(html, /2 older threads not shown\./);
});

await test('Simple tells the story under the outcome, and Technical shows the real posts', () => {
  const story = {
    at: ago(30),
    posts: ['p-2', 'p-3'],
    outcome: 'p-3',
    lines: [
      storyLine('step', 'Agent 2 tried the first set.'),
      storyLine('outcome', 'The lab uses the first set.'),
      storyLine('later', 'Agent 3 got another number later.', ['p-9']),
    ],
  };
  const simple = body(threadPage({ story }), 'simple');
  assert.match(simple, /Does the person’s title hold\?/);
  assert.match(simple, /state--ok">Decided</);
  assert.match(simple, /Why this thread: It decides the next step\./);
  assert.match(simple, /Decision · \d\d:\d\d · Agent 2/);
  assert.match(simple, /The lab uses the first set\./);
  assert.doesNotMatch(simple, /Use the first set\./);
  assert.match(simple, /Later: Agent 3 got another number later\./);
  assert.match(simple, /class="story"/);
  assert.match(simple, /Agent 2 tried the first set\./);
  assert.doesNotMatch(simple, /Seed 1 gives 55% in p-2/);
  assert.match(simple, /The thread has 2 posts\. Technical shows each one\./);
  assert.ok(simple.indexOf('outcome__label') < simple.indexOf('class="story"'));
  const technical = body(threadPage({ story }), 'technical');
  assert.match(technical, /Does the agents’ title hold\?/);
  assert.match(
    technical,
    /Use the first set\. \(<a class="id" href="#\/post\/p-3">/,
  );
  assert.doesNotMatch(technical, /class="story"|Agent 2 tried/);
  assert.match(technical, /Seed 1 gives 55% in <a class="id"/);
  assert.match(technical, /chip--result">Result</);
  assert.match(technical, /post__time/);
  assert.match(technical, /Run r-7/);
  assert.match(technical, /Controls · Codex/);
});

await test('with no story, Simple shows the outcome and the posts, and says that the story is not ready', () => {
  const html = body(threadPage(), 'simple');
  assert.match(html, /The story of this thread is not ready yet\./);
  assert.match(html, /Use the first set\./);
  assert.match(html, /Seed 1 gives 55% in p-2/);
  assert.match(html, />Run</);
  assert.doesNotMatch(html, />Run r-7</);
  assert.doesNotMatch(body(threadPage(), 'technical'), /not ready yet/);
});

await test('a line of a story that failed its check shows its quote', () => {
  const story = {
    at: ago(30),
    posts: ['p-2', 'p-3'],
    outcome: 'p-3',
    lines: [storyLine('step', null)],
  };
  const html = body(threadPage({ story }), 'simple');
  assert.match(html, /Seed 1 gives 55%\./);
  assert.doesNotMatch(html, /\(p-3\)|Original posts/);
});

await test('posts newer than a story show after it, and later posts of the record show under the outcome', () => {
  const story = {
    at: ago(30),
    posts: ['p-2'],
    outcome: 'p-3',
    lines: [storyLine('step', 'Agent 2 tried the first set.')],
  };
  const html = body(
    threadPage({
      story,
      later: [post('p-9', { text: 'It failed on seed 2.', thread: 't-5' })],
    }),
    'simple',
  );
  assert.match(html, /1 post is not in this story\. It follows\./);
  assert.match(html, /Seed 1 gives 55% in p-3/);
  assert.match(html, /Later: Agent 2, \d\d:\d\d: It failed on seed 2\./);
});

await test('in a lab with threads, each post shows its time and job, and IDs follow the view', () => {
  const shown = lab();
  const thread = { root: post('p-3'), replies: [] };
  const simple = inView(shown, 'simple', <BoardThread thread={thread} />);
  assert.match(simple, /post__time/);
  assert.match(simple, /Controls · Codex/);
  assert.match(simple, />Run</);
  assert.doesNotMatch(simple, /class="id"/);
  const technical = inView(shown, 'technical', <BoardThread thread={thread} />);
  assert.match(technical, /<a class="id" href="#\/d\/d-2">d-2<\/a>/);
  assert.match(technical, /Run r-7/);
  assert.match(
    inView(shown, 'technical', <IdText text="See c-4." />),
    /<a class="id" href="#\/call\/c-4">c-4<\/a>/,
  );
});

await test('a dispute in Simple shows no ID of Verifold’s', () => {
  const shown = lab({
    board: { posts: [post('p-3')], more: false },
    disputes: [{ post: 'p-3', objections: [], check: 'k-1' }],
    checks: [
      {
        id: 'k-1',
        post: 'p-3',
        direction: 'd-2',
        run: 'r-7',
        harness: 'claude',
        agent: 'a-5',
        handle: 'checker-1',
        sameHarness: false,
        blind: true,
        state: 'queued',
        outcome: null,
        method: null,
        result: null,
        note: null,
        queuedAt: ago(1),
        startedAt: null,
        endedAt: null,
      },
    ] as unknown as Lab['checks'],
  });
  const simple = inView(shown, 'simple', <Disputes lab={shown} />);
  assert.match(simple, />A post</);
  assert.match(simple, /Its check waits for/);
  assert.doesNotMatch(simple, /k-1/);
  const technical = inView(shown, 'technical', <Disputes lab={shown} />);
  assert.match(technical, />p-3</);
  assert.match(technical, /Check k-1 waits for/);
});

await test('each post of a thread has Reply, and a thread has a box that writes to it', () => {
  const html = body(threadPage(), 'technical', { onAct: () => {} });
  assert.equal(html.match(/>Reply</g)?.length, 2);
  assert.doesNotMatch(body(threadPage(), 'technical'), />Reply</);
  const open = thread();
  const box = inView(
    lab(),
    'simple',
    <StepInBox
      lab={lab()}
      thread={open}
      posts={[]}
      act={null}
      tick="now"
      now={now}
    />,
  );
  assert.match(box, /This thread/);
  const replying = inView(
    lab(),
    'simple',
    <StepInBox
      lab={lab()}
      thread={open}
      posts={[]}
      act={{ kind: 'reply', post: post('p-3') }}
      tick="now"
      now={now}
    />,
  );
  assert.match(replying, /Agent 2 · Controls/);
});

await test('the box writes to its thread, and a read of a thread can ask for posts before one', async (t) => {
  const seen: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => {
    seen.push({
      url,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    });
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  const controls = labControls('token');
  await controls.writeThread('t-2', 'Hello', 'key-1');
  assert.equal(seen[0]?.url, '/api/v1/actions/lab-post');
  assert.deepEqual(seen[0]?.body, {
    text: 'Hello',
    thread: 't-2',
    key: 'key-1',
  });
  await controls.threadPage('t-2', 'p-9');
  assert.equal(seen[1]?.url, '/api/v1/threads/t-2?before=p-9');
});

await test('a failed read and a gap show on the thread', () => {
  const html = inView(
    lab(),
    'technical',
    <ThreadBody
      page={threadPage()}
      lab={lab()}
      older={{
        ...olderOf(threadPage().posts),
        gap: true,
        problem: 'The read failed.',
      }}
      now={now}
    />,
  );
  assert.match(html, /Reading the posts in between/);
  assert.match(html, /role="alert"[^>]*>The read failed\./);
});

await test('Simple’s agent rows, thread rows, and top line show no ID of Verifold’s', () => {
  const ended: Agent = {
    ...agent,
    id: 'a-1',
    handle: 'agent-1',
    direction: 'd-1',
    status: 'closed',
    line: null,
    live: { state: 'ended', text: 'Closed by its agent', since: ago(30) },
  };
  const html = home({
    agents: [agent, ended],
    directions: [
      direction,
      {
        ...direction,
        id: 'd-1',
        agent: 'a-1',
        state: 'closed',
        verdict: 'ruled-out',
        evidence: { text: 'It failed at p-9.', post: 'p-9', run: 'r-1' },
      },
    ],
    runs: [
      {
        id: 'r-52',
        agent: 'a-2',
        direction: 'd-2',
        status: 'running',
        command: 'python x.py',
        why: '',
        where: 'local',
        commit: 'a',
        exitCode: null,
        queuedAt: ago(9),
        startedAt: ago(2),
        endedAt: null,
        metrics: {},
        note: null,
      },
    ],
  });
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /\b(?:[dprck]|lease)-\d+\b/);
  assert.match(text, /Closed at \d\d:\d\d\. Ruled out\. Its folder stays\./);
  assert.doesNotMatch(text, /after its test failed/);
});
