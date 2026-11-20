import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { NO_CANDIDATES } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type {
  AllowanceView,
  DashboardMeta,
  HeadlineView,
  LabView,
  MeasureView,
  MoveView,
  Post,
} from '../src/api/types.ts';
import {
  FRAME_PATH,
  FRAME_SANDBOX,
  budgetStat,
  bylineParts,
  headlineMark,
  measureParts,
  measureValue,
  namedLine,
  rerunMark,
  sendPage,
  size,
  statusLine,
} from '../src/model/dashboard.ts';
import { clock } from '../src/model/format.ts';
import { moveWords } from '../src/model/moves.ts';
import { href, parseRoute } from '../src/model/route.ts';
import { act, tone } from '../src/model/turns.ts';
import { AgentPage, Byline, DashboardTab, LabTabs, StatusBar } from '../src/ui/Dashboard.tsx';
import { LabPage } from '../src/ui/LabPage.tsx';
import { DEFAULTS, FINDINGS, HARNESSES, agentView, labView, postView, result } from './fixtures.ts';

const now = new Date('2026-11-06T14:26:00Z');
const agents = [
  agentView('agent-1', { agent: { ...agentView('agent-1').agent, name: 'Rowan' }, acting: true }),
  agentView('agent-2', { agent: { ...agentView('agent-2').agent, name: 'Finch' } }),
  agentView('agent-3', { agent: { ...agentView('agent-3').agent, name: 'Nowcaster' } }),
];
const api = {} as Api;

function measure(changes: Partial<MeasureView> = {}): MeasureView {
  return {
    post: 'p-4',
    thread: 't-1',
    by: 'agent-3',
    label: 'Account value',
    value: '382.24',
    unit: '$',
    as_of: '2026-11-06T14:24:00Z',
    rerun_by: [],
    rerun_failed_by: [],
    standing: 'open',
    ...changes,
  };
}

function headline(changes: Partial<HeadlineView> = {}): HeadlineView {
  return {
    label: 'Account value',
    post: 'p-5',
    named_by: 'person',
    named_at: '2026-11-06T14:20:00Z',
    why: '',
    measure: measure(),
    ...changes,
  };
}

function allowance(changes: Partial<AllowanceView> = {}): AllowanceView {
  return {
    allowance: 'a-1',
    terms: {
      holder: 'agent-1',
      purpose: 'Place orders on the exchange',
      unit: '$',
      per_action: '10',
      total: '100',
      ends_at: '2026-11-06T21:35:00Z',
      check_above: null,
    },
    state: 'in_force',
    drafted_at: '2026-11-06T14:01:00Z',
    by: 'person',
    on: null,
    started_at: '2026-11-06T14:02:00Z',
    ended_at: null,
    drawn: '4.25',
    stopped: false,
    actions: [],
    ...changes,
  };
}

const META: DashboardMeta = {
  post: 'p-9',
  thread: 't-3',
  path: 'board.html',
  by: 'agent-3',
  at: '2026-11-06T14:23:00Z',
  size: 2_400,
  standing: 'open',
  versions: 3,
};

const BUDGET: LabView['budget'] = {
  tokens: 1_000_000,
  dollars: 200,
  spent_tokens: 380_000,
  spent_dollars: 30,
  tokens_left: 620_000,
  dollars_left: 170,
};

function lab(changes: Partial<LabView> = {}): LabView {
  return labView({ agents, ...changes });
}

describe('the marks on a measure', () => {
  it('say who reran a measure, whose rerun failed, or that nobody reran it, and never judge the number', () => {
    assert.deepEqual(rerunMark(measure(), agents), { text: 'not rerun', tone: 'quiet' });
    assert.deepEqual(rerunMark(measure({ rerun_by: ['agent-2'] }), agents), {
      text: 'rerun by Finch',
      tone: 'good',
    });
    assert.deepEqual(rerunMark(measure({ rerun_failed_by: ['agent-1'] }), agents), {
      text: 'the rerun by Rowan failed',
      tone: 'bad',
    });
    assert.deepEqual(
      rerunMark(
        measure({ rerun_by: ['agent-2', 'agent-1', 'agent-3'], standing: 'disputed' }),
        agents,
      ),
      { text: 'rerun by Finch, Rowan, and Nowcaster · disputed', tone: 'quiet' },
    );
  });

  it('shows the number exactly as the record holds it, with a unit of one sign first', () => {
    assert.equal(
      measureValue(measure({ value: '1234567890123456.123456' })),
      '$1234567890123456.123456',
    );
    assert.equal(measureValue(measure({ value: '-0.5', unit: 'USD' })), '-0.5 USD');
    assert.equal(measureValue(measure({ value: '12', unit: '' })), '12');
  });
});

describe('the status line', () => {
  it('is absent from a lab with no headline number, no allowance in force, and no budget', () => {
    assert.equal(statusLine(lab(), agents, now), null);
    assert.equal(
      statusLine(lab({ allowances: [allowance({ state: 'ended' })] }), agents, now),
      null,
    );
    assert.equal(
      renderToStaticMarkup(<StatusBar api={api} lab={lab()} now={now} reload={() => undefined} />),
      '',
    );
  });

  it('shows the headline number with its age and its mark alone', () => {
    const line = statusLine(lab({ headline_number: headline() }), agents, now);
    assert.deepEqual(line, {
      stats: [
        {
          key: 'headline',
          value: '$382.24',
          words: 'Account value · 2 min ago',
          mark: { text: 'not rerun', tone: 'quiet' },
        },
      ],
      pause: false,
    });
    const named = statusLine(lab({ headline_number: headline({ measure: null }) }), agents, now);
    assert.deepEqual(named?.stats, [
      { key: 'headline', value: 'No measure yet', words: 'Account value' },
    ]);
  });

  it('writes each amount with two digits after the point at most, and the board’s line does too', () => {
    const exact = headline({ measure: measure({ value: '119.7695', unit: 'USD' }) });
    const line = statusLine(
      lab({
        headline_number: exact,
        allowances: [
          allowance({
            drawn: '42.840',
            terms: { ...allowance().terms, unit: 'USD', total: '60.00' },
          }),
        ],
      }),
      agents,
      now,
    );
    assert.deepEqual(
      line?.stats.map((stat) => [stat.value, stat.words]),
      [
        ['119.77 USD', 'Account value · 2 min ago'],
        ['0 actions', '42.84 USD of 60 USD allowance used'],
      ],
    );
    assert.equal(headlineMark(exact, agents)?.text, 'Account value 119.77 USD · not rerun');
    const small = headline({ measure: measure({ value: '0.0123456', unit: '' }) });
    assert.equal(
      statusLine(lab({ headline_number: small }), agents, now)?.stats[0]?.value,
      '0.01235',
    );
    // The record keeps the exact number, and the thread shows it.
    assert.equal(measureValue(measure({ value: '119.7695', unit: 'USD' })), '119.7695 USD');
  });

  it('shows the actions of an allowance in force with how much is used, and the press that pauses every action', () => {
    const live = lab({ allowances: [allowance({ actions: [] })] });
    assert.deepEqual(statusLine(live, agents, now), {
      stats: [{ key: 'actions-a-1', value: '0 actions', words: '$4.25 of $100 allowance used' }],
      pause: true,
    });
    const two = statusLine(
      lab({
        allowances: [
          allowance(),
          allowance({
            allowance: 'a-2',
            terms: { ...allowance().terms, holder: 'agent-2', unit: 'USD' },
          }),
        ],
      }),
      agents,
      now,
    );
    assert.deepEqual(
      two?.stats.map((stat) => stat.words),
      ['Rowan: $4.25 of $100 allowance used', 'Finch: 4.25 USD of 100 USD allowance used'],
    );
  });

  it('shows the larger share of the budget that the lab spent', () => {
    assert.deepEqual(budgetStat(BUDGET), {
      key: 'budget',
      value: '38%',
      words: 'of the token budget spent',
    });
    assert.deepEqual(
      budgetStat({ ...BUDGET, spent_dollars: 190 })?.words,
      'of the dollar budget spent',
    );
    assert.equal(budgetStat(labView().budget), null);
    assert.deepEqual(statusLine(lab({ budget: BUDGET }), agents, now)?.stats.length, 1);
  });

  it('shows every part that exists, in order, and the press with its state', () => {
    const full = lab({
      headline_number: headline({ measure: measure({ rerun_by: ['agent-2'] }) }),
      allowances: [allowance()],
      budget: BUDGET,
    });
    assert.deepEqual(
      statusLine(full, agents, now)?.stats.map((stat) => stat.key),
      ['headline', 'actions-a-1', 'budget'],
    );
    const markup = renderToStaticMarkup(
      <StatusBar api={api} lab={full} now={now} reload={() => undefined} />,
    );
    assert.match(markup, /aria-label="Where the lab stands"/);
    assert.match(markup, /<b>\$382\.24<\/b>/);
    assert.match(markup, /rerun by Finch/);
    assert.match(markup, /Pause all actions/);
    const paused = renderToStaticMarkup(
      <StatusBar
        api={api}
        lab={{ ...full, actions_paused: '2026-11-06T14:25:00Z' }}
        now={now}
        reload={() => undefined}
      />,
    );
    assert.match(paused, /Let actions go on/);
    const noPress = renderToStaticMarkup(
      <StatusBar api={api} lab={lab({ budget: BUDGET })} now={now} reload={() => undefined} />,
    );
    assert.doesNotMatch(noPress, /Pause all actions/);
  });
});

describe('the frame of the dashboard', () => {
  it('loads the frame’s own page with a sandbox for scripts alone, and no token or page in its address', () => {
    const markup = renderToStaticMarkup(<AgentPage html="<b>382.24</b>" />);
    const frame = /<iframe [^>]*>/.exec(markup)?.[0] ?? '';

    assert.equal(FRAME_PATH, '/frame');
    assert.equal(FRAME_SANDBOX, 'allow-scripts');
    assert.match(frame, /src="\/frame"/);
    assert.match(frame, /sandbox="allow-scripts"/);
    assert.match(frame, /referrerPolicy="no-referrer"/i);
    // No address holds the page or a token, and the frame gets no power beyond its scripts.
    assert.doesNotMatch(
      frame,
      /token|382|srcdoc|allow-same-origin|allow-top|allow-popups|allow-forms|allow=/,
    );
  });

  it('posts the agents’ page into the frame as one message, and nothing else', () => {
    const sent: (readonly [string, string])[] = [];
    sendPage(
      { postMessage: (message, origin) => void sent.push([message, origin]) },
      '<b>382.24</b>',
    );
    sendPage(null, '<b>lost</b>');

    assert.deepEqual(sent, [['<b>382.24</b>', '*']]);
  });

  it('is the one frame of the app, and the app reads no message from it', async () => {
    const root = new URL('../../src/', import.meta.url);
    const files = (await readdir(root, { recursive: true })).filter((name) => /\.tsx?$/.test(name));
    const texts = await Promise.all(files.map((name) => readFile(new URL(name, root), 'utf8')));
    const all = texts.join('\n');

    assert.doesNotMatch(all, /addEventListener\(\s*['"]message['"]/);
    assert.doesNotMatch(all, /onmessage/);
    assert.equal(all.match(/<iframe/g)?.length, 1);
    assert.doesNotMatch(all, /srcDoc|dangerouslySetInnerHTML/);
  });
});

describe('the Dashboard tab', () => {
  it('has its own address beside the wall', () => {
    assert.deepEqual(parseRoute('#/dashboard'), { page: 'dashboard' });
    assert.equal(href({ page: 'dashboard' }), '#/dashboard');
    const tabs = renderToStaticMarkup(<LabTabs tab="dashboard" />);
    assert.match(tabs, /<a href="#\/dashboard" class="on" aria-current="page">Dashboard<\/a>/);
    assert.match(tabs, /<a href="#\/">Wall<\/a>/);
    assert.doesNotMatch(tabs, /Map/);
  });

  it('shows the board’s line above the page: who made it, its age, whose numbers they are, and the headline', () => {
    assert.deepEqual(bylineParts(META, agents, now), [
      'Made by Nowcaster, an agent',
      'Updated 3 min ago',
      "Numbers are the agents' own",
    ]);
    const marked = headlineMark(headline({ measure: measure({ rerun_by: ['agent-2'] }) }), agents);
    assert.deepEqual(marked, { text: 'Account value $382.24 · rerun by Finch', tone: 'good' });
    assert.deepEqual(headlineMark(headline({ measure: null }), agents), {
      text: 'Account value: no measure yet',
      tone: 'quiet',
    });
    const line = renderToStaticMarkup(
      <Byline
        meta={{ ...META, standing: 'disputed' }}
        headline={headline()}
        agents={agents}
        now={now}
      />,
    );
    assert.match(line, /Numbers are the agents’ own|Numbers are the agents&#x27; own/);
    assert.match(line, /href="#\/thread\/t-3\/p-9">3 versions<\/a>/);
    assert.match(line, /Disputed/);
    assert.match(line, /Account value \$382\.24 · not rerun|Account value \$382\.24 · Not rerun/);
  });

  it('says that no agent made a dashboard yet, and offers the person the labels of the measures', () => {
    const markup = renderToStaticMarkup(
      <DashboardTab
        api={api}
        lab={lab({ dashboard: null, measure_labels: ['Account value', 'Cash'] })}
        now={now}
        reload={() => undefined}
      />,
    );
    assert.match(markup, /No agent has made a dashboard yet/);
    assert.match(markup, /<option value="Account value">/);
    assert.match(markup, /<option value="Cash">/);
    assert.match(markup, /Name it/);
    assert.doesNotMatch(markup, /Take it back|<iframe/);
  });

  it('says who named the headline number, and the coordinator’s why', () => {
    assert.equal(
      namedLine(headline(), agents, now),
      `You named it ${clock('2026-11-06T14:20:00Z')}.`,
    );
    const byCoordinator = headline({
      named_by: 'agent-2',
      why: 'The person asked for the account.',
    });
    assert.equal(
      namedLine(byCoordinator, agents, now),
      `Finch, the coordinator, named it ${clock('2026-11-06T14:20:00Z')}. Why: The person asked for the account.`,
    );
  });
});

describe('the posts of the dashboard in a thread', () => {
  const measured = {
    ...result('p-4'),
    kind: 'measure',
    label: 'Account value',
    value: '382.24',
    unit: '$',
    as_of: '2026-11-06T14:24:00Z',
    script: 'value.py',
    output: 'value.out',
  } as Post;
  const version = {
    ...result('p-9'),
    kind: 'dashboard',
    size: 2_400,
    evidence: [{ type: 'file', path: 'board.html', commit: 'c'.repeat(40) }],
  } as Post;
  const named = {
    ...result('p-5'),
    kind: 'headline_number',
    label: 'Account value',
    why: 'It is the goal.',
  } as Post;

  it('say what each one did and show its facts', () => {
    const context = { called: () => 'Finch', author: null };
    assert.equal(act(measured, null, context), 'reported a measure');
    assert.equal(act(version, null, context), 'made a version of the dashboard');
    assert.equal(act(named, null, context), 'named the headline number');
    assert.equal(
      act({ ...named, label: '' } as Post, null, context),
      'took back the headline number',
    );
    assert.deepEqual([tone(measured), tone(version), tone(named)], ['claim', 'answer', 'quiet']);
    assert.deepEqual(measureParts(measured, now), [
      ['Holds for', clock('2026-11-06T14:24:00Z')],
      ['Script', 'value.py'],
      ['Output', 'value.out'],
    ]);
    assert.deepEqual(measureParts(version, now), [['Page', 'board.html · 2 KB']]);
    assert.deepEqual(measureParts(named, now), [['Why', 'It is the goal.']]);
    assert.deepEqual([size(900), size(1_000_000)], ['900 bytes', '1.0 MB']);
  });

  it('show the coordinator’s naming of the headline number in its log of moves', () => {
    const move: MoveView = {
      post: postView(named),
      kind: 'headline_number',
      at: '2026-11-06T14:20:00Z',
      by: 'agent-2',
      why: 'It is the goal.',
      agent: null,
      yes_by: null,
    };
    assert.deepEqual(moveWords(move, agents), {
      what: 'Named the headline number',
      seat: null,
      theirs: 'Account value',
      why: 'It is the goal.',
    });
  });
});

describe('the lab page', () => {
  function data(view: LabView): Parameters<typeof LabPage>[0]['data'] {
    return {
      setup: {
        folder: '~/code/account',
        harnesses: HARNESSES,
        question: view.question,
        defaults: DEFAULTS,
        defaults_from: null,
        findings_deliverable: FINDINGS,
      },
      lab: view,
      threads: [],
      needs: [],
      report: null,
      candidates: NO_CANDIDATES,
      version: 1,
      error: null,
      reload: () => undefined,
    };
  }

  it('puts the status line under the question and the tabs before the wall', () => {
    const view = lab({ headline_number: headline(), budget: BUDGET });
    const markup = renderToStaticMarkup(
      <LabPage api={api} data={data(view)} now={now} open={null} post={null} />,
    );
    const at = (text: string): number => markup.indexOf(text);

    assert.ok(at('Is sorted() faster?') < at('Where the lab stands'));
    assert.ok(at('Where the lab stands') < at('aria-label="The lab"'));
    assert.ok(at('aria-label="The lab"') < at('How the lab reads your question'));
    assert.doesNotMatch(markup, /No agent has made a dashboard yet/);
  });

  it('shows the Dashboard tab in place of the wall', () => {
    const view = lab({ dashboard: META, headline_number: headline() });
    const markup = renderToStaticMarkup(
      <LabPage api={api} data={data(view)} now={now} open={null} post={null} tab="dashboard" />,
    );

    assert.match(markup, /Made by Nowcaster, an agent/);
    assert.match(markup, /Loading the dashboard/);
    assert.doesNotMatch(markup, /How the lab reads your question/);
    assert.match(markup, /class="on" aria-current="page">Dashboard/);
  });
});
