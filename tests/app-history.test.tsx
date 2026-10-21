import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  HistoryLabRun,
  HistoryResearchRun,
  Snapshot,
} from '../src/protocol/api.ts';
import { Screen } from '../src/app/App.tsx';
import { HistoryContext, historyTools, kindName } from '../src/app/history.ts';
import { parseRoute } from '../src/app/route.ts';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
import { LabRun, ResearchRun } from '../src/app/screens/History.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';

const now = Date.UTC(2026, 9, 21, 14, 0);
const at = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const actions: LabActions = {
  post: () => Promise.resolve({ ok: true }),
  pause: () => Promise.resolve({ ok: true }),
  answer: () => Promise.resolve({ ok: true }),
  words: () => Promise.resolve({ ok: true }),
  undo: () => Promise.resolve({ ok: true }),
  skip: () => Promise.resolve({ ok: true }),
  questions: () => Promise.resolve({ ok: true }),
};

const agentActions: AgentActions = {
  message: () => Promise.resolve({ ok: true }),
  turns: () => Promise.resolve({ error: 'not in this test' }),
  turn: () => Promise.resolve({ error: 'not in this test' }),
  thread: () => Promise.resolve({ error: 'not in this test' }),
};

function snapshot(more: Partial<Snapshot> = {}): Snapshot {
  return {
    protocolVersion: 1,
    epoch: 'e',
    rev: 1,
    at: at(0),
    project: 'graphs',
    lab: null,
    trimmed: false,
    ...more,
  };
}

/** Visible text, with tags removed and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function render(shown: Snapshot, hash: string, signedIn = true): string {
  return renderToStaticMarkup(
    <HistoryContext.Provider value={historyTools(signedIn ? 'token' : null)}>
      <Screen
        state={{ snapshot: shown, connection: 'live', retrying: false }}
        route={parseRoute(hash)}
        now={now}
        actions={actions}
        agentActions={agentActions}
      />
    </HistoryContext.Provider>,
  );
}

const research: HistoryResearchRun = {
  kind: 'research',
  entry: {
    id: '20261020T100000000Z-abcdef',
    kind: 'research',
    at: at(600),
    question: 'Does a heap beat a scan?',
    direction: 'Heap Dijkstra',
    bytes: 2_400_000,
    tasks: 1,
  },
  question: 'Does a heap beat a scan?',
  brief: { text: 'A brief.', trimmed: false },
  plan: {
    scope: 'Shortest paths.',
    personas: [
      { name: 'Reader', task: 'Read the papers.' },
      { name: 'Coder', task: 'Time the code.' },
    ],
  },
  attempts: [
    {
      id: '1a2b3c4d-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
      phase: 'needs-research',
      status: 'succeeded',
      harness: 'claude',
      model: null,
      startedAt: at(700),
      finishedAt: at(690),
      summary: { text: 'A heap wins on large graphs.', trimmed: false },
      delegation: { text: 'Two helpers read papers.', trimmed: false },
      sources: [{ title: 'Heap paper', url: 'https://example.org/heap' }],
      transcript: true,
    },
  ],
  candidates: [
    {
      id: 'heap',
      title: 'Heap Dijkstra',
      recommendation: { text: 'Use a binary heap.', trimmed: false },
      checks: ['It beats the scan above 10,000 nodes.'],
      sources: ['https://example.org/heap'],
      kind: 'main',
    },
  ],
  chosen: 'heap',
  coordinator: {
    objective: { text: 'Show that the heap wins.', trimmed: false },
    harness: 'claude',
    model: null,
    startedAt: at(680),
    stoppedAt: null,
    planApproved: true,
    session: null,
    actions: [],
    olderActions: 0,
  },
  tasks: [
    {
      id: 'task-1',
      title: 'Time the heap',
      state: 'done',
      harness: 'claude',
      model: null,
      attempts: 1,
      versions: 1,
      outcome: 'accepted',
    },
  ],
  messages: [
    {
      id: 'm-1',
      at: at(650),
      from: 'coordinator',
      to: 'person',
      kind: 'note',
      text: { text: 'The heap is 2x faster.', trimmed: false },
      status: null,
      answer: null,
    },
  ],
  olderMessages: 0,
  results: [
    {
      direction: 'heap',
      checks: [
        {
          check: 1,
          result: 'passed',
          value: '2x faster',
          reason: { text: 'It beats the scan.', trimmed: false },
          ruling: null,
        },
      ],
      answer: null,
    },
  ],
  sessions: [],
  pods: [
    {
      lease: 'lease-1',
      gpu: 'NVIDIA L40S',
      state: 'ended',
      tasks: ['task-1'],
      requestedAt: at(660),
      costUsd: 0.55,
    },
  ],
};

const lab: HistoryLabRun = {
  kind: 'lab',
  entry: {
    id: '20261020T100000000Z-abcdef',
    kind: 'lab',
    at: at(60),
    question: 'Can probes find the CoT gap?',
    direction: null,
    bytes: 1024,
    tasks: 0,
  },
  question: 'Can probes find the CoT gap?',
  startedAt: at(600),
  plan: {
    reading: { text: 'Read the gap with probes.', trimmed: false },
    cost: { text: 'Nothing costs money.', trimmed: false },
    facts: [
      {
        claim: 'Qwen3.5 SAEs exist.',
        source: null,
        sourceDate: null,
        listedAt: at(590),
      },
    ],
  },
  directions: [
    {
      id: 'd-1',
      title: 'The probe gap',
      bar: 'The gap shrinks 30%.',
      state: 'closed',
      verdict: 'holds-up',
      evidence: 'Gap 34% smaller.',
      handle: 'claude-1',
    },
  ],
  runs: [],
  posts: [],
  olderPosts: 3,
};

await test('History, a run of it, and Start over have their own pages', () => {
  assert.deepEqual(parseRoute('#/history'), { page: 'history' });
  assert.deepEqual(parseRoute('#/history/current'), {
    page: 'history-run',
    id: 'current',
  });
  assert.deepEqual(parseRoute('#/history/20261020T100000000Z-abcdef'), {
    page: 'history-run',
    id: '20261020T100000000Z-abcdef',
  });
  assert.deepEqual(parseRoute('#/history/..%2Fx'), { page: 'unknown' });
  assert.deepEqual(parseRoute('#/start-over'), { page: 'start-over' });
  assert.equal(kindName({ kind: 'lab' }), "A lab's run");
});

await test('a project whose current run is from the earlier research flow opens it in History, with Start a lab', () => {
  const page = text(render(snapshot({ researchRun: true }), '#/'));
  assert.match(page, /The current run/);
  assert.match(page, /earlier research flow\. It shows here read only/);
  assert.match(page, /Start a lab/);
  // Without a research-flow run, the project without a lab asks for its question.
  assert.match(text(render(snapshot(), '#/')), /has no lab yet/);
});

await test('Start over says what it keeps and what it moves into History, and History reads only with a key', () => {
  const page = text(render(snapshot(), '#/start-over'));
  assert.match(page, /Start over moves this run into History/);
  assert.match(page, /the question, which you can change/);
  assert.match(page, /the lab: its plan, directions, board, runs, and checks/);
  assert.match(page, /deletes nothing/);
  const signedOut = render(snapshot(), '#/start-over', false);
  assert.match(signedOut, /<button[^>]*disabled=""[^>]*>Start over/);
  assert.match(text(render(snapshot(), '#/history')), /Reading the runs/);
  assert.doesNotMatch(
    text(render(snapshot(), '#/history', false)),
    /Reading the runs/,
  );
});

await test("a research-flow run and a lab's run show their records, read only", () => {
  const shown = text(
    renderToStaticMarkup(<ResearchRun run={research} now={now} />),
  );
  for (const words of [
    'Does a heap beat a scan?',
    'A heap wins on large graphs.',
    'Heap Dijkstra',
    'Chosen',
    'Show that the heap wins.',
    'you approved its plan',
    'task-1 Time the heap',
    'Check 1: passed',
    'The heap is 2x faster.',
    'lease-1',
    '$0.55',
  ])
    assert.ok(shown.includes(words), words);
  const labShown = text(renderToStaticMarkup(<LabRun run={lab} />));
  assert.match(labShown, /Holds up The probe gap · claude-1/);
  assert.match(labShown, /unverified \(no source\)/);
  assert.match(labShown, /3 older posts are not shown/);
});
