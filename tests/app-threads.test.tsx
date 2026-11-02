import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  CheckItem,
  Direction,
  Lab,
  Post,
  Wait,
} from '../src/protocol/api.ts';
import { AskLine } from '../src/app/components/AskLine.tsx';
import { BoardThread } from '../src/app/components/BoardThread.tsx';
import { DirectionRow } from '../src/app/components/DirectionRow.tsx';
import { Disputes } from '../src/app/components/LabControls.tsx';
import { askedOfYou, waitLine } from '../src/app/waits.ts';
import { kindLabel, kindWords } from '../src/core/lab/words.ts';
import { labScreen, parseLabScreen } from '../src/server/screen.ts';
import { rowText } from '../src/cli/lab-view.ts';

const now = Date.UTC(2026, 10, 1, 12, 0);
const at = new Date(now - 60_000).toISOString();

function post(more: Partial<Post>): Post {
  return {
    id: 'p-1',
    at,
    author: 'a-3',
    handle: 'agent-3',
    job: 'Controls',
    harness: 'codex',
    kind: 'result',
    direction: 'd-3',
    thread: 't-2',
    text: 'It holds.',
    replyTo: null,
    mentions: [],
    proof: [],
    ...more,
  };
}

const shown = (entry: Post): string =>
  renderToStaticMarkup(<BoardThread thread={{ root: entry, replies: [] }} />);

await test('each new kind has its chip and its word, and a person’s words keep theirs', () => {
  for (const [kind, word] of [
    ['result', 'Result'],
    ['check', 'Check'],
    ['ask', 'Ask'],
    ['answer', 'Answer'],
    ['proposal', 'Proposal'],
  ] as const) {
    assert.match(shown(post({ kind })), new RegExp(`chip--${kind}">${word}<`));
    assert.equal(kindWords[kind], word);
  }
  assert.equal(
    kindLabel({ author: 'person', kind: 'question' } as Parameters<
      typeof kindLabel
    >[0]),
    'Message',
  );
});

await test('a post shows that it is disputed, what it cites, and who recounted it', () => {
  assert.match(shown(post({ disputed: true })), /chip--disputed">Disputed</);
  assert.match(
    shown(post({ citesDisputed: 'p-9' })),
    /chip--disputed">Cites a disputed post</,
  );
  assert.match(
    shown(
      post({
        recountedBy: [
          { handle: 'agent-2', outcome: 'holds' },
          { handle: 'agent-5', outcome: 'fails' },
        ],
      }),
    ),
    /Recounted by Agent 2: it held\. Recounted by Agent 5: it failed\./,
  );
  assert.match(
    shown(post({ kind: 'check', outcome: 'fails' })),
    /chip--check">Check: failed</,
  );
  assert.match(
    shown(post({ kind: 'check', outcome: 'holds' })),
    /chip--check">Check: held</,
  );
  const plain = shown(post({}));
  assert.doesNotMatch(plain, /Disputed|Recounted by/);
});

const agent: Agent = {
  id: 'a-3',
  handle: 'agent-3',
  harness: 'codex',
  model: null,
  direction: 'd-3',
  check: null,
  status: 'working',
  until: null,
  live: { state: 'working', text: 'Running a.py', since: at },
  line: { doing: 'Refitting seed 2', why: 'Why.', next: 'Next.', at },
  turns: { turns: [], more: false },
  spendUsd: null,
};

const direction: Direction = {
  id: 'd-3',
  title: 'Topic controls',
  bar: null,
  runs: null,
  noise: null,
  buildsOn: [],
  state: 'open',
  verdict: 'open',
  disputed: false,
  evidence: null,
  agent: 'a-3',
  openedBy: 'a-1',
  openedAt: at,
  stoppedAt: null,
  head: 'a'.repeat(40),
};

await test('a direction’s row and the terminal show the agent’s own line', () => {
  const row = renderToStaticMarkup(
    <DirectionRow direction={direction} agent={agent} now={now} />,
  );
  assert.match(row, /Refitting seed 2/);
  assert.doesNotMatch(row, /Running a\.py|· 1 min/);
  const screen = labScreen(
    {
      project: 'project',
      lab: {
        directions: [direction],
        agents: [agent],
        needsYou: [],
        omitted: {},
        money: { plansUsd: 0, gpuUsd: 0, gpuLimitUsd: null },
        budget: null,
        paused: null,
        startedAt: at,
        plan: null,
        planner: null,
      } as unknown as NonNullable<Parameters<typeof labScreen>[0]['lab']>,
    },
    { origin: 'http://127.0.0.1:1', app: true },
  );
  const line = screen?.directions[0];
  assert.equal(line?.doing, 'Refitting seed 2');
  assert.ok(line);
  assert.equal(rowText(line, now), 'Refitting seed 2');
  // The terminal reads the screen back over the control channel.
  assert.equal(parseLabScreen(screen)?.directions[0]?.doing, line.doing);
});

const wait = (more: Partial<Wait>): Wait => ({
  waiter: 'a-3',
  waiterHandle: 'agent-3',
  on: 'a-2',
  onHandle: 'agent-2',
  post: 'p-7',
  reason: 'ask',
  thread: 't-2',
  subject: 'Does seed 2 agree?',
  text: 'Which seed leaks?',
  since: at,
  ...more,
});

await test('an agent’s row says who it waits on, and an ask for the person shows in Needs you', () => {
  const lab = {
    directions: [],
    waits: [
      wait({ on: 'person', onHandle: null, post: 'p-9', text: 'Is it firm?' }),
      wait({ on: 'person', onHandle: null, post: 'p-10' }),
      wait({}),
      wait({
        waiter: 'a-4',
        reason: 'objection',
        on: 'person',
        onHandle: null,
      }),
    ],
  } as unknown as Lab;
  assert.equal(waitLine(lab, 'a-3'), 'Waits on you: Does seed 2 agree?');
  assert.equal(
    waitLine({ directions: [], waits: [wait({})] } as unknown as Lab, 'a-3'),
    'Waits on Agent 2: Does seed 2 agree?',
  );
  assert.equal(waitLine(lab, 'a-9'), null);
  assert.equal(waitLine({ directions: [] } as unknown as Lab, 'a-3'), null);
  assert.deepEqual(
    askedOfYou(lab).map((entry) => entry.post),
    ['p-9', 'p-10'],
  );
  const row = renderToStaticMarkup(
    <DirectionRow
      direction={direction}
      agent={agent}
      now={now}
      wait="Waits on Agent 2: Does seed 2 agree?"
    />,
  );
  assert.match(row, /Waits on Agent 2: Does seed 2 agree\?/);
  const line = renderToStaticMarkup(
    <AskLine ask={wait({ on: 'person', post: 'p-9' })} more={1} now={now} />,
  );
  assert.match(line, /Needs you/);
  assert.match(line, /Which seed leaks\?/);
  assert.match(line, /Agent 3 asks · waiting 1 min · 1 more ask after this/);
  assert.match(line, /href="#\/board\/p-9"/);
});

await test('a dispute says where its check stands, and only a post with a run waits for one', () => {
  const lab = (check: Partial<CheckItem> | null, proof: Post['proof']): Lab =>
    ({
      disputes: [
        { post: 'p-1', objections: ['p-2'], check: check ? 'k-1' : null },
      ],
      board: {
        posts: [
          post({ id: 'p-1', proof }),
          post({ id: 'p-2', kind: 'objection', replyTo: 'p-1' }),
        ],
      },
      checks: check
        ? [
            {
              id: 'k-1',
              handle: 'checker-1',
              harness: 'codex',
              agent: 'a-9',
              state: 'done',
              outcome: 'holds',
              method: 'rerun',
              ...check,
            },
          ]
        : [],
      agents: [],
      directions: [],
    }) as unknown as Lab;
  const run: Post['proof'] = [{ type: 'run', run: 'r-1' }];
  const held = renderToStaticMarkup(<Disputes lab={lab({}, run)} />);
  assert.match(held, /Check k-1 ended before this objection\./);
  assert.doesNotMatch(held, /held/);
  assert.match(
    renderToStaticMarkup(<Disputes lab={lab(null, run)} />),
    /No check yet\./,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(<Disputes lab={lab(null, [])} />),
    /No check yet/,
  );
});
