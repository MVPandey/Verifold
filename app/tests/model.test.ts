import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PostView } from '../src/api/types.ts';

import { costLine, labTotal, mark, stateLine, tone } from '../src/model/agents.ts';
import { duration, minutesBetween, money, tokens } from '../src/model/format.ts';
import { orderNeeds, pauses } from '../src/model/needs.ts';
import {
  isPermission,
  kindLabel,
  personAnswer,
  personMessage,
  split,
  standingChip,
  titleOf,
} from '../src/model/posts.ts';
import { href, parseRoute } from '../src/model/route.ts';
import { hasNew, markSeen, readSeen } from '../src/model/seen.ts';
import { AT_EXIT, labelOf, stopLine, valueAt } from '../src/model/settings.ts';
import {
  agentCount,
  effortsOf,
  firstPicks,
  initials,
  menuEntries,
  modeEntries,
  modelSummary,
  startRequest,
  step,
  withModel,
} from '../src/model/setup.ts';
import { endLine, MAX_MINUTES, moreTime, runStatus } from '../src/model/time.ts';
import {
  HARNESSES,
  OFFER,
  agentView,
  ask,
  labView,
  postView,
  result,
  summary,
} from './fixtures.ts';

function memoryStore(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

describe('format', () => {
  it('writes durations, token counts, and money for people', () => {
    assert.deepEqual(
      [
        duration(26),
        duration(60),
        duration(65),
        tokens(900),
        tokens(463_000),
        tokens(74_000_000),
        money(0.371),
      ],
      ['26 min', '1 h', '1 h 5 min', '900', '463k', '74M', '$0.37'],
    );
    assert.equal(minutesBetween('2026-11-06T14:00:00Z', new Date('2026-11-06T14:26:59Z')), 26);
    assert.equal(minutesBetween('2026-11-06T14:00:00Z', new Date('2026-11-06T13:00:00Z')), 0);
  });
});

describe('route', () => {
  it('reads each page from the fragment, and anything else is the lab', () => {
    assert.deepEqual(
      ['#/', '#/needs', '#/thread/t-12', '#/thread/x', '#token=abc', ''].map(parseRoute),
      [
        { page: 'lab' },
        { page: 'needs' },
        { page: 'thread', id: 't-12' },
        { page: 'lab' },
        { page: 'lab' },
        { page: 'lab' },
      ],
    );
    assert.equal(href({ page: 'thread', id: 't-3' }), '#/thread/t-3');
  });
});

describe('posts', () => {
  it('splits the first line into the headline and keeps the rest as the body', () => {
    assert.deepEqual(split('  Try sorted input.\n\nAlso reversed.  '), {
      headline: 'Try sorted input.',
      body: 'Also reversed.',
    });
    const long = split('x'.repeat(400));
    assert.equal(long.headline.length, 300);
    assert.equal(long.body, 'x'.repeat(400));
  });

  it('opens a new thread for a message to all agents, and posts in a thread for a reply', () => {
    assert.deepEqual(personMessage('Check sorted input.'), {
      kind: 'message',
      text: 'Check sorted input.',
      new_thread: 'Check sorted input.',
    });
    assert.deepEqual(personMessage('Why 28.6x?\nSee bench_c.', 't-3'), {
      kind: 'message',
      text: 'Why 28.6x?',
      body: 'See bench_c.',
      thread: 't-3',
    });
    assert.equal(personMessage('   '), null);
    assert.equal(titleOf(`${'word '.repeat(30)}`.trim()).length <= 80, true);
  });

  it('sends a chosen option as the answer and the words as its detail', () => {
    const asked = ask('p-4', 'agent-2', ['Allow once', 'Reject']);
    assert.deepEqual(personAnswer(asked, 'Allow once', ' Only this time. '), {
      kind: 'answer',
      thread: 't-2',
      reply_to: 'p-4',
      text: 'Allow once',
      body: 'Only this time.',
    });
    assert.deepEqual(personAnswer(asked, null, 'No, use pure Python.'), {
      kind: 'answer',
      thread: 't-2',
      reply_to: 'p-4',
      text: 'No, use pure Python.',
    });
    assert.equal(personAnswer(asked, null, ''), null);
  });

  it('names kinds and standings, and gives every result a chip', () => {
    assert.equal(
      kindLabel({
        ...result('p-2'),
        kind: 'check',
        outcome: 'fails',
        method: 'rerun',
        reply_to: 'p-1',
      }),
      'Check by rerun',
    );
    assert.deepEqual(standingChip(result('p-1'), 'open'), { label: 'Not checked', tone: 'none' });
    assert.deepEqual(standingChip(result('p-1'), 'held_up'), { label: 'Held up', tone: 'hold' });
    assert.equal(standingChip({ ...result('p-1'), kind: 'message' }, 'open'), null);
    assert.equal(isPermission(ask('p-1', 'agent-1')), true);
    assert.equal(isPermission(result('p-1')), false);
  });
});

describe('agents', () => {
  it('marks avatars with the agent number, C for checkers, and You for the person', () => {
    assert.deepEqual(['agent-12', 'checker-7', 'person', 'zed'].map(mark), ['12', 'C', 'You', 'Z']);
    const agents = [agentView('agent-1'), agentView('agent-2')];
    assert.deepEqual(
      ['agent-1', 'agent-2', 'person'].map((id) => tone(HARNESSES, agents, id)),
      ['cc', 'cx', 'you'],
    );
  });

  it('says what an agent does and what it costs', () => {
    const now = new Date('2026-11-06T14:12:00Z');
    const working = { state: 'working', detail: 'Run pytest', at: '2026-11-06T14:10:00Z' } as const;
    assert.deepEqual(stateLine(working, now), { text: 'Run pytest, 2 min', dot: 'live' });
    assert.deepEqual(stateLine({ state: 'stopped', detail: '', at: null }, now), {
      text: 'Stopped',
      dot: 'stop',
    });
    const priced = agentView('agent-1', { turns: 4, cost_usd: 0.37 });
    const unpriced = agentView('agent-2', {
      turns: 3,
      usage: { input_tokens: 461_000, cached_input_tokens: 0, output_tokens: 2_000 },
    });
    assert.equal(costLine(priced), '$0.37 over 4 turns');
    assert.equal(costLine(unpriced), '461k tokens in, 2k out over 3 turns. No price.');
    assert.equal(costLine(agentView('agent-3')), 'No turns yet');
    assert.equal(labTotal([priced, unpriced]), '$0.37 and 463k tokens');
    assert.equal(labTotal([priced]), '$0.37');
  });
});

describe('needs', () => {
  const waiting = { state: 'waiting', detail: '', at: null } as const;
  const needs = [
    postView({ ...ask('p-1', 'agent-1'), text: 'Which seed counts?' }),
    postView(ask('p-2', 'agent-2')),
    postView(ask('p-3', 'agent-3')),
  ];
  const ids = (items: readonly PostView[]): readonly string[] => items.map((item) => item.post.id);

  it('puts the permission requests of paused agents first, and keeps the rest in order', () => {
    const lab = labView({
      agents: [
        agentView('agent-1', { activity: waiting }),
        agentView('agent-2', { activity: waiting }),
      ],
    });
    assert.deepEqual(ids(orderNeeds(needs, lab)), ['p-2', 'p-1', 'p-3']);
    assert.deepEqual(
      needs.map((item) => pauses(item, lab)),
      [false, true, false],
    );
  });

  it('pauses nothing once the lab is out of time', () => {
    const lab = labView({
      out_of_time: true,
      agents: [agentView('agent-2', { activity: waiting })],
    });
    assert.deepEqual(ids(orderNeeds(needs, lab)), ['p-1', 'p-2', 'p-3']);
  });
});

describe('seen', () => {
  it('remembers the last post that the person saw in each thread', () => {
    const store = memoryStore();
    assert.equal(hasNew(summary(), readSeen(store, 'lab')), true);
    markSeen(store, 'lab', 't-1', 7);
    markSeen(store, 'lab', 't-1', 3);
    assert.deepEqual(readSeen(store, 'lab'), { 't-1': 7 });
    assert.equal(hasNew(summary(), readSeen(store, 'lab')), false);
    const fromPerson = summary({
      latest: {
        seq: 9,
        at: '2026-11-06T14:10:00Z',
        author: 'person',
        kind: 'message',
        text: 'Go on.',
      },
    });
    assert.equal(hasNew(fromPerson, readSeen(store, 'lab')), false);
  });

  it('treats damaged storage as nothing seen', () => {
    const store = memoryStore();
    store.setItem('verifold-seen:lab', '{not json');
    assert.deepEqual(readSeen(store, 'lab'), {});
    store.setItem('verifold-seen:lab', '{"t-1": "7", "t-2": 4}');
    assert.deepEqual(readSeen(store, 'lab'), { 't-2': 4 });
  });
});

describe('setup', () => {
  it('starts with one agent of each harness that this computer has', () => {
    const picks = firstPicks(HARNESSES);
    assert.deepEqual(
      picks.map((pick) => pick.count),
      [1, 0],
    );
    assert.equal(agentCount(step(step(picks, 'claude-code', 30), 'codex', -1)), 20);
  });

  it('sends only the choices that the person made', () => {
    const picks = [
      { harness: 'claude-code', count: 3, model: ' opus ', effort: '', mode: 'plan' },
      { harness: 'codex', count: 0, model: '', effort: 'low', mode: '' },
    ];
    assert.deepEqual(startRequest(' Is it faster? ', picks, false, 30), {
      question: 'Is it faster?',
      agents: [{ harness: 'claude-code', count: 3, model: 'opus', mode: 'plan' }],
      auto_mode: false,
      minutes: 30,
    });
    assert.equal('minutes' in startRequest('Q?', picks, true, null), false);
    assert.deepEqual(['Claude Code', 'Codex'].map(initials), ['CC', 'CX']);
  });

  it('names the choices with the names that the harness offered', () => {
    const pick = { harness: 'claude-code', count: 1, model: '', effort: '', mode: '' };
    assert.equal(modelSummary(pick, OFFER), 'Opus, High effort (your default)');
    assert.equal(
      modelSummary({ ...pick, model: 'default' }, OFFER),
      'Default (recommended), default effort',
    );
    assert.equal(modelSummary({ ...pick, model: 'haiku' }, OFFER), 'Haiku');
    assert.equal(modelSummary({ ...pick, effort: 'low' }, OFFER), 'Opus, Low effort');
    assert.equal(
      modelSummary({ ...pick, mode: 'plan' }, OFFER),
      'Opus, High effort (your default), Plan mode',
    );
    assert.equal(modelSummary(pick, null), 'Your default model and effort');
    assert.equal(modelSummary({ ...pick, effort: 'low' }, null), 'Your default model, low effort');
    assert.equal(modelSummary({ ...pick, model: 'gpt-x' }, null), 'gpt-x, default effort');
  });

  it("puts the person's own setting first in each menu, and sends nothing for it", () => {
    assert.deepEqual(menuEntries(OFFER.models, OFFER.model), [
      { value: '', label: 'Opus (your default)' },
      { value: 'default', label: 'Default (recommended)' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'sonnet', label: 'Sonnet' },
    ]);
    assert.deepEqual(menuEntries(OFFER.efforts, null)[0], { value: '', label: 'Your default' });
    assert.deepEqual(menuEntries([], 'opus'), []);
    assert.deepEqual(
      modeEntries(OFFER).map((entry) => entry.label),
      ['Your auto mode answer', 'Manual (your default)', 'Plan', 'Auto'],
    );
    assert.deepEqual(modeEntries({ ...OFFER, modes: [] }), []);
  });

  it('offers the effort levels of the chosen model, and drops a level that the model lacks', () => {
    const pick = { harness: 'claude-code', count: 1, model: '', effort: 'low', mode: '' };
    assert.deepEqual(effortsOf(OFFER, ''), { values: OFFER.efforts, current: 'high' });
    assert.deepEqual(effortsOf(OFFER, 'default').current, null);
    assert.deepEqual(effortsOf(OFFER, 'haiku').values, []);
    assert.deepEqual(effortsOf(OFFER, 'sonnet').values, []);
    assert.equal(withModel(pick, OFFER, 'default').effort, 'low');
    assert.deepEqual(withModel(pick, OFFER, 'haiku'), { ...pick, model: 'haiku', effort: '' });
  });
});

describe('time', () => {
  const now = new Date('2026-11-06T14:26:00Z');

  it('says how long the lab has run and when it ends', () => {
    assert.equal(runStatus(labView(), now), 'Running, 26 min');
    assert.equal(runStatus(labView({ out_of_time: true }), now), 'Out of time');
    assert.equal(endLine(labView(), now), 'No time limit.');
    assert.match(endLine(labView({ ends_at: '2026-11-06T14:38:00Z' }), now), /, in 12 min\.$/);
  });

  it('adds more time to what is left, up to a week', () => {
    assert.equal(moreTime(labView({ ends_at: '2026-11-06T14:38:00Z' }), 30, now), 42);
    assert.equal(
      moreTime(labView({ ends_at: '2026-11-06T14:00:00Z', out_of_time: true }), 30, now),
      30,
    );
    assert.equal(moreTime(labView({ ends_at: '2026-11-20T14:00:00Z' }), 60, now), MAX_MINUTES);
  });
});

describe('settings', () => {
  it('reads a setting by its key with dots, and finds nothing where a file has nothing', () => {
    const values = { jobs: { at_exit: 'keep' }, harnesses: ['odd'] };
    assert.equal(valueAt(values, 'jobs.at_exit'), 'keep');
    assert.equal(valueAt(values, 'jobs.at_time_limit'), undefined);
    assert.equal(valueAt(values, 'harnesses.0'), undefined);
    assert.equal(valueAt({}, 'jobs.at_exit'), undefined);
    assert.equal(labelOf(AT_EXIT, 'keep'), 'Keep them');
    assert.deepEqual(parseRoute('#/settings'), { page: 'settings' });
    assert.equal(href({ page: 'settings' }), '#/settings');
  });

  it('says what a stop does to the processes that agents left running', () => {
    const settings = labView().settings;
    assert.match(stopLine(settings), /pause until you give the lab more time/);
    assert.match(
      stopLine({ ...settings, jobs: { ...settings.jobs, at_time_limit: 'stop' } }),
      /stop too/,
    );
    assert.match(
      stopLine({ ...settings, jobs: { ...settings.jobs, at_time_limit: 'finish' } }),
      /continue until they end/,
    );
  });
});
