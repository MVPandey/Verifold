import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Direction, Post } from '../src/protocol/api.ts';
import { BoardThread } from '../src/app/components/BoardThread.tsx';
import { DirectionRow } from '../src/app/components/DirectionRow.tsx';
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
    shown(post({ recountedBy: ['agent-3', 'agent-3', 'agent-5'] })),
    /Recounted by Agent 3, Agent 5\./,
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
  assert.match(row, /Refitting seed 2 · 1 min/);
  assert.doesNotMatch(row, /Running a\.py/);
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
  assert.equal(rowText(line, now), 'Refitting seed 2 · 1 min');
  // The terminal reads the screen back over the control channel.
  assert.equal(parseLabScreen(screen)?.directions[0]?.doing, line.doing);
});
