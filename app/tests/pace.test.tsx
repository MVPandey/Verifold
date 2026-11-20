import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Api } from '../src/api/client.ts';
import type { AgentView, CapLine, LabView, Move, PauseLine, SeatLimits } from '../src/api/types.ts';
import { stateLine } from '../src/model/agents.ts';
import { askLine, details, doneLine, powerOf, yesLabel } from '../src/model/coordinator.ts';
import { clock } from '../src/model/format.ts';
import {
  capLine,
  labCapLine,
  limitsLine,
  nearLimit,
  nextTime,
  pauseLine,
  seatLines,
} from '../src/model/pace.ts';
import { LabPaceControls, SeatPaceControls } from '../src/ui/Pace.tsx';
import { ProfileSheet } from '../src/ui/Profile.tsx';
import { Top } from '../src/ui/Top.tsx';
import { HARNESSES, agentView, labView, postView, result } from './fixtures.ts';

const NOW = new Date('2026-11-06T14:12:00Z');
const RESETS = '2026-11-06T14:40:00Z';
const UNTIL = '2026-11-06T16:30:00Z';

const LIMITS: SeatLimits = {
  windows: [
    { label: 'weekly', used_percent: 41, resets_at: '2026-11-11T10:00:00Z' },
    { label: '5-hour', used_percent: 62.4, resets_at: RESETS },
  ],
  status: 'allowed',
};

const PAUSED: PauseLine = {
  by: 'agent-1',
  since: '2026-11-06T14:05:00Z',
  until: UNTIL,
  why: 'No release.',
};

const SHARE: CapLine = {
  tokens_per_hour: 10_000_000,
  spent: 3_100_000,
  hour_ends: '2026-11-06T15:00:00Z',
  by: 'person',
  share: true,
};

function top(lab: LabView): string {
  return renderToStaticMarkup(
    <Top
      folder="~/code/sort-bench"
      route={{ page: 'lab' }}
      open={{
        lab,
        threads: [],
        harnesses: HARNESSES,
        needs: 0,
        now: NOW,
        api: {} as Api,
        onChange: () => undefined,
      }}
    />,
  );
}

function profile(view: AgentView, lab: LabView = labView({ agents: [view] })): string {
  return renderToStaticMarkup(
    <ProfileSheet
      view={view}
      lab={lab}
      threads={[]}
      now={NOW}
      api={{} as Api}
      invitation={null}
      onInvitation={() => undefined}
      onChange={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe('the pace and the usage limits of a seat', () => {
  it('say the fullest window with its reset, the pause, and the limit per hour', () => {
    assert.equal(limitsLine(LIMITS, NOW), `62% of the 5-hour limit, resets ${clock(RESETS)}`);
    assert.equal(limitsLine(null, NOW), null);
    assert.equal(limitsLine({ windows: [], status: null }, NOW), null);
    assert.equal(
      limitsLine({ windows: [], status: 'reached' }, NOW),
      'The provider refuses its requests',
    );
    assert.equal(
      limitsLine(
        { windows: [{ label: 'weekly', used_percent: 100, resets_at: null }], status: 'reached' },
        NOW,
      ),
      'The provider refuses its requests: 100% of the weekly limit',
    );
    assert.equal(pauseLine(PAUSED, NOW), `Paused by the coordinator until ${clock(UNTIL)}`);
    assert.equal(pauseLine({ by: 'person', since: UNTIL }, NOW), 'Paused by you');
    assert.equal(capLine(SHARE), '3M of its 10M tokens this hour');
    assert.equal(
      capLine({ tokens_per_hour: 500, hour_ends: UNTIL, by: 'person' }),
      '0 of its 500 tokens this hour',
    );
    assert.equal(labCapLine(null), 'No limit of tokens per hour for the lab.');
    assert.equal(
      labCapLine({ ...SHARE, by: 'agent-1', share: false }),
      'Spent 3M of 10M tokens this hour. The coordinator set this limit.',
    );
  });

  it('show in one seat line, in a fixed order, and none for a seat that left', () => {
    const view = agentView('agent-1', { pause: PAUSED, limits: LIMITS, cap: SHARE });

    assert.deepEqual(seatLines(view, NOW), [
      `Paused by the coordinator until ${clock(UNTIL)}`,
      `62% of the 5-hour limit, resets ${clock(RESETS)}`,
      '3M of its 10M tokens this hour',
    ]);
    assert.deepEqual(seatLines(agentView('agent-2'), NOW), []);
    const left = { at: NOW.toISOString(), agent: 'agent-1', by: 'person', reason: '' };
    assert.deepEqual(seatLines({ ...view, left }, NOW), []);
    assert.equal(nearLimit(LIMITS), false);
    assert.equal(
      nearLimit({
        windows: [{ label: '5-hour', used_percent: 91, resets_at: null }],
        status: null,
      }),
      true,
    );
    assert.equal(nearLimit({ windows: [], status: 'reached' }), true);
    assert.equal(nearLimit(null), false);
  });

  it('read a time of day as the next such time', () => {
    const at = nextTime('16:30', NOW);
    assert.ok(at !== null);
    assert.equal(clock(at), '16:30');
    assert.ok(new Date(at) > NOW);
    const early = nextTime(clock(new Date(NOW.getTime() - 60_000).toISOString()), NOW);
    assert.ok(early !== null && new Date(early).getTime() - NOW.getTime() > 23 * 3_600_000);
    assert.equal(nextTime('25:00', NOW), null);
    assert.equal(nextTime('soon', NOW), null);
  });

  it('show on the member list, in the color of a wait when the seat is near its limit', () => {
    const near: SeatLimits = {
      windows: [{ label: '5-hour', used_percent: 91, resets_at: RESETS }],
      status: null,
    };
    const lab = labView({
      agents: [
        agentView('agent-1', { pause: PAUSED }),
        agentView('agent-2', { limits: near }),
        agentView('agent-3', { coordinator: true, cap: SHARE }),
      ],
    });

    const html = top(lab);

    assert.ok(
      html.includes(`<p class="f-pace">Paused by the coordinator until ${clock(UNTIL)}</p>`),
    );
    assert.ok(
      html.includes(`<p class="f-pace near">91% of the 5-hour limit, resets ${clock(RESETS)}</p>`),
    );
    assert.ok(html.includes('<p class="f-pace">3M of its 10M tokens this hour</p>'));
    // The panel of the lab's time has the lab's limit and the coordinator's.
    assert.ok(html.includes('No limit of tokens per hour for the lab.'));
    assert.ok(html.includes('Tokens per hour for the coordinator'));
  });

  it('give the person the pause, the resume, and the limit of a seat in its profile', () => {
    const paused = profile(
      agentView('agent-1', {
        pause: PAUSED,
        cap: { ...SHARE, share: false, by: 'agent-1', why: 'Spend slower.' },
      }),
    );
    assert.ok(paused.includes('>Resume</button>'));
    assert.ok(!paused.includes('>Pause</button>'));
    assert.ok(paused.includes('<span class="i-why">Why: No release.</span>'));
    assert.ok(paused.includes('<span class="i-why">Why: Spend slower.</span>'));
    assert.ok(paused.includes('>Remove limit</button>'));

    const free = profile(agentView('agent-1'));
    assert.ok(free.includes('>Pause</button>'));
    assert.ok(free.includes('Pause until'));
    assert.ok(!free.includes('>Remove limit</button>'));
    assert.ok(!free.includes('Pace and limits'));
    // The coordinator's share is the person's setting, which the panel of the lab's time changes.
    assert.ok(!profile(agentView('agent-1', { cap: SHARE })).includes('>Remove limit</button>'));

    const desk = renderToStaticMarkup(
      <SeatPaceControls
        api={{} as Api}
        view={agentView('agent-1', { desk: true })}
        now={NOW}
        onChange={() => undefined}
      />,
    );
    assert.equal(desk, '');
  });

  it('let the person remove the lab’s limit and set the coordinator’s', () => {
    const html = renderToStaticMarkup(
      <LabPaceControls
        api={{} as Api}
        lab={labView({ lab_cap: { ...SHARE, share: false } })}
        onChange={() => undefined}
      />,
    );

    assert.ok(html.includes('Spent 3M of 10M tokens this hour.'));
    assert.ok(html.includes('>Remove limit</button>'));
    assert.ok(html.includes('value="10000000"'));
  });

  it('start from the default limit of the coordinator with a server from before pace', () => {
    const { version, jobs, permissions, reviewers, votes, reruns, disk } = labView().settings;
    const settings = { version, jobs, permissions, reviewers, votes, reruns, disk };
    const html = renderToStaticMarkup(
      <LabPaceControls api={{} as Api} lab={labView({ settings })} onChange={() => undefined} />,
    );

    assert.ok(html.includes('value="10000000"'));
  });

  it('show the wait of a seat that its pace holds in the server’s words', () => {
    const activity = {
      state: 'waiting',
      detail: 'Paused by you.',
      at: null,
      waits_for: 'pace',
    } as const;

    assert.deepEqual(stateLine(activity, NOW), { text: 'Paused by you.', dot: 'idle' });
    assert.deepEqual(stateLine({ ...activity, detail: '' }, NOW), {
      text: 'Its pause or its limit holds its next turn.',
      dot: 'idle',
    });
  });
});

describe('a request of pace from the coordinator', () => {
  const around = {
    lab: labView({ agents: [agentView('agent-1'), agentView('agent-2')] }),
    harnesses: HARNESSES,
    asks: [],
    now: NOW,
  };

  it('says what it asks with the app’s own words and shows the why in the coordinator’s', () => {
    const pause: Move = { type: 'pause', agent: 'agent-2', until: UNTIL, why: 'No release.' };
    const cap: Move = { type: 'cap', tokens_per_hour: 2_000_000, why: 'Spend slower.' };
    const back: Move = { type: 'cap', agent: 'agent-2', tokens_per_hour: null };
    const resume: Move = { type: 'resume', agent: 'agent-2' };

    assert.deepEqual(
      [pause, cap, back, resume].map((move) => [askLine(move), yesLabel(move), powerOf(move)]),
      [
        ['Asks you to pause a seat', 'Pause the seat', 'pace'],
        ['Asks you for a limit of 2M tokens per hour', 'Set the limit', 'pace'],
        ['Asks you to take back its limit of tokens per hour', 'Take the limit back', 'pace'],
        ['Asks you to resume a seat', 'Resume the seat', 'pace'],
      ],
    );
    assert.deepEqual(details(pause, around), [
      { label: 'The seat to pause', value: 'Agent 2', theirs: true },
      { label: 'Until', value: clock(UNTIL) },
      { label: 'While it is paused', value: 'It finishes its turn. Only your posts wake it.' },
      { label: 'Why, in the coordinator’s words', value: 'No release.', theirs: true },
    ]);
    assert.deepEqual(details({ type: 'pause', agent: 'agent-2' }, around)[1], {
      label: 'Until',
      value: 'You or the coordinator resume it',
    });
    assert.deepEqual(details(cap, around).slice(0, 2), [
      { label: 'For', value: 'The whole lab', theirs: false },
      { label: 'Tokens per hour', value: '2M' },
    ]);
    assert.deepEqual(details(back, around).slice(0, 2), [
      { label: 'For', value: 'Agent 2', theirs: true },
      { label: 'Tokens per hour', value: 'No limit of the coordinator' },
    ]);
    assert.deepEqual(details(resume, around), [
      { label: 'The seat to resume', value: 'Agent 2', theirs: true },
    ]);
    const done = (move: Move): string =>
      doneLine(
        postView({
          ...result('p-1', { thread: 't-2', text: 'Pace.' }),
          kind: 'request',
          move,
        }),
      );
    assert.deepEqual([pause, resume, cap, back].map(done), [
      'Paused a seat',
      'Resumed a seat',
      'Set a limit of 2M tokens per hour',
      'Took back a limit of tokens per hour',
    ]);
  });
});
