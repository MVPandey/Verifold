import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Agent, Direction, StartView } from '../src/protocol/api.ts';
import { shareChoices, shareLabel } from '../src/app/ask.ts';
import { DirectionRow } from '../src/app/components/DirectionRow.tsx';
import { AskForm, ShareChoice } from '../src/app/screens/AskPage.tsx';

const text = (element: ReactElement): string =>
  renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

const where: StartView = {
  folder: '~/project',
  files: false,
  hours: 8,
  maxHours: 168,
  questionLimit: 4000,
  agents: { host: 'claude' },
  gpuUsd: null,
  gpuLimits: false,
  started: false,
};

await test('the Ask page shows the share of long shots as one chip, Mixed by default', () => {
  const page = text(
    <AskForm
      where={where}
      tools={[]}
      profileError={null}
      onRetry={() => {}}
      start={{
        read: () => Promise.resolve({ error: 'unused' }),
        start: () => Promise.resolve({ refused: 'unused' }),
      }}
      now={Date.UTC(2026, 10, 1, 10)}
      connection="live"
    />,
  );
  assert.match(page, /Long shots: 1 agent in 4/);
  // The choice stays closed until the person opens it.
  assert.doesNotMatch(page, /How far from known work/);
});

await test('the three choices say what each one does, and the chosen one is checked', () => {
  assert.deepEqual(
    shareChoices.map((choice) => choice.value),
    ['close', 'mixed', 'far'],
  );
  assert.equal(shareLabel('close'), 'Close to known work');
  assert.equal(shareLabel('far'), 'Long shots: 1 agent in 2');
  const html = renderToStaticMarkup(
    <ShareChoice share="far" onChange={() => {}} />,
  );
  assert.equal(html.match(/checked=""/g)?.length, 1);
  const page = text(<ShareChoice share="far" onChange={() => {}} />);
  assert.match(page, /Close to known work · No agent works on long shots\./);
  assert.match(page, /Mixed · 1 agent in 4 works on long shots\./);
  assert.match(page, /Far · 1 agent in 2 works on long shots\./);
  assert.match(page, /Verifold draws them at random/);
});

const direction = {
  id: 'd-1',
  title: 'Controls',
  bar: null,
  runs: null,
  noise: null,
  buildsOn: [],
  state: 'open',
  verdict: 'open',
  disputed: false,
  evidence: null,
  agent: 'a-1',
  openedBy: 'person',
  openedAt: '2026-11-01T10:00:00.000Z',
  stoppedAt: null,
  head: 'abc',
} as Direction;

const agent = (helpers: Agent['helpers']): Agent =>
  ({
    id: 'a-1',
    handle: 'agent-3',
    harness: 'claude',
    model: null,
    direction: 'd-1',
    check: null,
    status: 'idle',
    until: null,
    live: null,
    helpers,
    turns: { items: [], more: false },
    spendUsd: null,
  }) as unknown as Agent;

const row = (helpers: Agent['helpers']): string =>
  text(
    <DirectionRow
      direction={direction}
      agent={agent(helpers)}
      now={Date.UTC(2026, 10, 1, 10)}
    />,
  );

await test("an agent's row says how many helpers run, and when one stopped with no result", () => {
  const helper = (state: 'running' | 'done' | 'lost') => ({
    label: 'agent-3.1',
    title: 'Scan the prior work',
    state,
  });
  assert.doesNotMatch(row([]), /helper/);
  assert.doesNotMatch(row(undefined), /helper/);
  assert.doesNotMatch(row([helper('done')]), /helper/);
  assert.match(row([helper('running'), helper('running')]), /2 helpers/);
  assert.match(row([helper('lost')]), /1 helper stopped with no result/);
});
