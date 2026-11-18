import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Api } from '../src/api/client.ts';
import type {
  AgentActivity,
  BudgetLine,
  LabView,
  SavedChoice,
  SetupDefaults,
} from '../src/api/types.ts';
import { clock } from '../src/model/format.ts';
import { addHint } from '../src/model/deliverables.ts';
import { stateLine } from '../src/model/agents.ts';
import { wakes } from '../src/model/coordinator.ts';
import {
  amountField,
  bytes,
  diskLine,
  halted,
  haltWords,
  retryLine,
  spentLine,
  wholeField,
} from '../src/model/limits.ts';
import { pauses } from '../src/model/needs.ts';
import { quietBand } from '../src/model/status.ts';
import { startRequest } from '../src/model/setup.ts';
import { clockLine } from '../src/model/time.ts';
import { BudgetFields, LimitsPanel, budgetOf } from '../src/ui/Limits.tsx';
import { SetupPage } from '../src/ui/SetupPage.tsx';
import { DEFAULTS, HARNESSES, agentView, ask, labView, postView, FINDINGS } from './fixtures.ts';

const NOW = new Date('2026-11-06T14:26:00Z');

function budget(changes: Partial<BudgetLine>): BudgetLine {
  return {
    tokens: null,
    dollars: null,
    spent_tokens: 0,
    spent_dollars: 0,
    tokens_left: null,
    dollars_left: null,
    ...changes,
  };
}

const SPENT = labView({
  budget: budget({ tokens: 5_000_000, spent_tokens: 1_200_000, dollars: 20, spent_dollars: 3.4 }),
});

describe('the limits of a lab', () => {
  it('say what the lab spent against its budget, and say so when it has none', () => {
    assert.equal(spentLine(SPENT), 'Spent 1M of 5M tokens and $3.40 of $20.00.');
    assert.equal(spentLine(labView()), 'Spent 0 tokens. No budget.');
    // A lab without a budget in dollars shows the cost that the harnesses reported.
    assert.equal(
      spentLine(labView({ budget: budget({ spent_tokens: 900, spent_dollars: 0.5 }) })),
      'Spent 900 tokens and $0.50. No budget.',
    );
  });

  it('say what the files take against the disk limit', () => {
    const disk = {
      at: NOW.toISOString(),
      folders: {},
      reruns: 0,
      snapshots: 0,
      total: 13 * 1024 ** 3,
    };
    assert.equal(diskLine(labView()), 'Files: not measured yet. Limit: 100 GB.');
    assert.equal(diskLine(labView({ disk })), 'Files: 13.0 GB of 100 GB.');
    const none = labView({ disk, settings: { ...labView().settings, disk: { limit_gb: 0 } } });
    assert.equal(diskLine(none), 'Files: 13.0 GB. No limit.');
    assert.deepEqual(
      [bytes(900), bytes(820 * 1024 ** 2), bytes(150 * 1024 ** 3)],
      ['900 bytes', '820 MB', '150 GB'],
    );
  });

  it('stop the agents as the time limit does, and the clock says which limit', () => {
    const reached = labView({ limit: 'tokens' });
    assert.equal(clockLine(reached, NOW), 'Budget reached');
    assert.equal(clockLine(labView({ limit: 'disk' }), NOW), 'Disk limit reached');
    assert.equal(haltWords(reached), 'The lab reached its budget in tokens');
    assert.equal(haltWords(labView({ out_of_time: true })), 'The lab is out of time');
    assert.deepEqual([halted(reached), halted(labView())], [true, false]);
    assert.equal(
      quietBand({ ...reached, agents: [agentView('bo')] }, NOW)?.title,
      'The lab reached its budget in tokens',
    );
    assert.ok(
      addHint({ ...reached, reruns_wanted: [] }).endsWith(
        'the agents get the post when you raise it.',
      ),
    );
    const holder = agentView('bo', { coordinator: true });
    assert.equal(wakes(holder, reached), false);
    const waiting = agentView('bo', { activity: { state: 'waiting', detail: '', at: null } });
    const request = postView(ask('p-1', 'bo'));
    assert.equal(pauses(request, { ...reached, agents: [waiting] }), false);
  });

  it('read whole tokens and amounts of dollars, and refuse what no budget takes', () => {
    assert.deepEqual(
      ['5,000,000', '', '0', '1.5', 'many'].map((text) => wholeField(text, 10 ** 12)),
      [5_000_000, null, undefined, undefined, undefined],
    );
    assert.deepEqual(
      ['25', '2.50', '$3', '', '0', '1.234', '-1'].map((text) => amountField(text, 1_000_000)),
      [25, 2.5, 3, null, undefined, undefined, undefined],
    );
    assert.deepEqual(budgetOf({ tokens: '1000', dollars: '' }), { tokens: 1000, dollars: null });
    assert.equal(budgetOf({ tokens: 'x', dollars: '' }), null);
  });

  it('go into the start of a lab only when the person set them', () => {
    const request = startRequest('Q?', [], true, null, '', { tokens: 10_000, dollars: null });
    assert.deepEqual([request.budget_tokens, 'budget_dollars' in request], [10_000, false]);
    assert.equal('budget_tokens' in startRequest('Q?', [], true, null), false);
  });
});

describe('a seat whose harness failed', () => {
  const retry = (providerLimit: boolean, failures: number): AgentActivity => ({
    state: 'waiting',
    detail: '',
    at: NOW.toISOString(),
    waits_for: 'retry',
    retry: { failures, at: '2026-11-06T14:40:00Z', provider_limit: providerLimit },
  });

  it('says that it waits and when it tries again, and marks a provider’s limit', () => {
    const at = clock('2026-11-06T14:40:00Z');
    assert.equal(stateLine(retry(true, 1), NOW).text, `Provider limit, tries again at ${at}`);
    assert.equal(
      retryLine(retry(false, 3).retry ?? { failures: 0, at: '', provider_limit: false }, NOW),
      `Harness failed, tries again at ${at} (3 failures in a row)`,
    );
    assert.equal(stateLine(retry(false, 2), NOW).dot, 'stop');
    const limit: AgentActivity = { state: 'waiting', detail: '', at: null, waits_for: 'limit' };
    assert.equal(stateLine(limit, NOW).text, 'The lab reached a limit.');
  });
});

describe('the panel of the lab’s limits', () => {
  const api = {} as Api;

  it('shows what the lab spent, its files, and the fields that set the budget and the disk limit', () => {
    const html = renderToStaticMarkup(
      <LimitsPanel
        lab={{ ...SPENT, limit: 'dollars' } satisfies LabView}
        api={api}
        onChange={() => undefined}
      />,
    );
    assert.ok(html.includes('Spent 1M of 5M tokens and $3.40 of $20.00.'));
    assert.ok(html.includes('The lab reached its budget in dollars.'));
    assert.ok(html.includes('Files: not measured yet. Limit: 100 GB.'));
    assert.ok(html.includes('value="5000000"'));
    assert.ok(html.includes('Set budget'));
    assert.ok(html.includes('Disk limit in GB'));
    assert.ok(html.includes('so the lab can pass its budget by the turns that run then'));
  });

  it('says what a field needs when it holds no amount', () => {
    const html = renderToStaticMarkup(
      <BudgetFields value={{ tokens: 'lots', dollars: '' }} onChange={() => undefined} />,
    );
    assert.ok(html.includes('Type a whole number of tokens'));
  });
});

describe('the setup of a lab', () => {
  it('starts with the saved budget, which the person can change', () => {
    const html = renderToStaticMarkup(
      <SetupPage
        api={{} as Api}
        setup={{
          folder: '~/code',
          harnesses: HARNESSES,
          question: null,
          defaults: { ...DEFAULTS, budget_tokens: 2_000_000, budget_dollars: 12.5 },
          defaults_from: null,
          findings_deliverable: FINDINGS,
        }}
        onStarted={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    assert.ok(html.includes('How much may the agents spend?'));
    assert.ok(html.includes('value="2000000"'));
    assert.ok(html.includes('value="12.5"'));
  });

  it('says in one line when every seat is of one model family, and what an independent check is', () => {
    const setup = (agents: SetupDefaults['agents']): string =>
      renderToStaticMarkup(
        <SetupPage
          api={{} as Api}
          setup={{
            folder: '~/code',
            harnesses: HARNESSES.map((option) => ({ ...option, available: true })),
            question: null,
            defaults: { ...DEFAULTS, agents },
            defaults_from: null,
            findings_deliverable: FINDINGS,
          }}
          onStarted={() => undefined}
          onRefresh={() => undefined}
        />,
      );
    const seat = (changes: Partial<SavedChoice>): SavedChoice => ({
      harness: 'claude-code',
      count: 1,
      model: null,
      effort: null,
      mode: null,
      ...changes,
    });
    const line =
      'Every seat is of one model family, anthropic. An independent check is a check by an agent of another family, and without one no result can stand as held up.';
    assert.ok(setup([seat({ count: 2 })]).includes(line));
    // A lab of on-call seats has the line too, beside the line that says that no agent starts by itself.
    const called = setup([seat({ on_call: true })]);
    assert.ok(called.includes(line) && called.includes('Every seat is on call'));
    // Two families, or a seat whose family the person stated as another, say nothing.
    assert.ok(!setup(null).includes('one model family'));
    assert.ok(!setup([seat({ family: 'google' }), seat({})]).includes('one model family'));
  });
});
