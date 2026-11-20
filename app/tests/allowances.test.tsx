import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { NO_CANDIDATES } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type {
  ActionView,
  AllowanceView,
  DeskView,
  LabView,
  Missed,
  PostView,
} from '../src/api/types.ts';
import {
  actionIds,
  allowanceHeading,
  amount,
  askEnds,
  draftFacts,
  meterPercent,
  minus,
  missedRow,
  requestWords,
  shownAllowances,
  stoppedAllowances,
  usedLine,
  usedShort,
} from '../src/model/allowances.ts';
import type { ActionPost } from '../src/model/allowances.ts';
import { actionLine } from '../src/model/desk.ts';
import { actingSwitch } from '../src/model/identity.ts';
import { modelSummary, newSeat, seatChoice, withSeat } from '../src/model/setup.ts';
import { act } from '../src/model/turns.ts';
import { AllowanceCard, MissedFold } from '../src/ui/Allowances.tsx';
import { DeskPanel } from '../src/ui/Desk.tsx';
import { LabPage } from '../src/ui/LabPage.tsx';
import { NeedsPage } from '../src/ui/NeedsPage.tsx';
import { ModeChange } from '../src/ui/Profile.tsx';
import { Modes } from '../src/ui/SeatForm.tsx';
import {
  DEFAULTS,
  FINDINGS,
  HARNESSES,
  OFFER,
  agentView,
  labView,
  postView,
  result,
} from './fixtures.ts';

const now = new Date('2026-11-06T14:26:00Z');
const rowan = agentView('agent-1', {
  agent: { ...agentView('agent-1').agent, name: 'Rowan' },
  acting: true,
});
const agents = [rowan, agentView('agent-2'), agentView('agent-3', { desk: true })];

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
    by: 'agent-3',
    on: 'p-7',
    started_at: '2026-11-06T14:02:00Z',
    ended_at: null,
    drawn: '4.25',
    stopped: false,
    actions: [],
    ...changes,
  };
}

function done(changes: Partial<ActionView> = {}): ActionView {
  return {
    post: 'p-9',
    thread: 't-1',
    agent: 'agent-1',
    at: '2026-11-06T14:10:00Z',
    what: 'Bought 50 YES, SOFR at 3.88% or lower, at 7c',
    cost: '3.75',
    undoable: false,
    offer_ends: '2026-11-06T15:00:00Z',
    state: 'allowed',
    needs: null,
    real_cost: '3.73',
    receipt: 'p-10',
    ...changes,
  };
}

function action(changes: Partial<ActionPost> = {}): PostView & { readonly post: ActionPost } {
  const post = result('p-12', {
    kind: 'action',
    text: 'Buy 625 YES on SOFR at 3.88% or lower, at up to 7c',
    builds_on: ['p-1'],
    cost: '46.60',
    undoable: false,
    offer_ends: '2026-11-06T18:38:00Z',
    allowance: 'a-1',
    allowed: false,
    needs: 'per_action',
    ...changes,
  }) as ActionPost;
  return { ...postView(post, 12), post };
}

function missed(changes: Partial<Missed> = {}): Missed {
  return {
    kind: 'answer',
    agent: 'agent-1',
    what: 'Its harness asks you a question',
    since: '2026-11-06T13:00:00Z',
    post: 'p-4',
    thread: 't-2',
    ended_at: '2026-11-06T13:01:00Z',
    ...changes,
  };
}

function data(
  lab: LabView,
  needs: readonly PostView[] = [],
): Parameters<typeof NeedsPage>[0]['data'] {
  return {
    setup: {
      folder: '~/code/sort-bench',
      harnesses: HARNESSES,
      question: lab.question,
      defaults: DEFAULTS,
      defaults_from: null,
      findings_deliverable: FINDINGS,
    },
    lab,
    threads: [],
    needs,
    report: null,
    candidates: NO_CANDIDATES,
    version: 1,
    error: null,
    reload: () => undefined,
  };
}

describe('the words of an allowance', () => {
  it('writes amounts as the record holds them, with a sign first and a code after', () => {
    assert.equal(amount('4.25', '$'), '$4.25');
    assert.equal(amount('4.25', 'USD'), '4.25 USD');
    assert.equal(amount('12', 'credits'), '12 credits');
    assert.equal(minus('100', '4.25'), '95.75');
    assert.equal(minus('10', '10'), '0');
    assert.equal(minus('0.1', '0.3'), '-0.2');
    assert.equal(minus('25', '0.000001'), '24.999999');
  });

  it('says whose the allowance is and what it is for, its bounds, what it used, and its meter', () => {
    const view = allowance({ terms: { ...allowance().terms, check_above: '5' } });

    assert.equal(
      allowanceHeading(view.terms, agents),
      'Allowance for Rowan: Place orders on the exchange',
    );
    // The person's words stand as written after the colon, whatever kind of phrase they are.
    for (const purpose of [
      'USDC transfers to the pool',
      'paper orders tomorrow',
      'Buy only. Never sell.',
    ]) {
      assert.equal(
        allowanceHeading({ ...view.terms, purpose }, agents),
        `Allowance for Rowan: ${purpose}`,
      );
    }
    assert.deepEqual(draftFacts(view.terms, now), [
      'Up to $10 an action',
      'Up to $100 in all',
      `Until ${new Date('2026-11-06T21:35:00Z').getHours().toString().padStart(2, '0')}:35`,
      'Above $5, a check by another agent first',
    ]);
    assert.match(usedLine(view, now), /^\$4\.25 of \$100 used · up to \$10 an action · until /);
    // The card writes two digits after the point, or none for a whole amount. The record keeps the amounts.
    const exact = allowance({
      drawn: '42.840',
      terms: { ...view.terms, unit: 'USD', total: '60.00', per_action: '5.000' },
    });
    assert.match(
      usedLine(exact, now),
      /^42\.84 USD of 60 USD used · up to 5 USD an action · until /,
    );
    assert.equal(usedShort(exact), '42.84 USD of 60 USD');
    assert.equal(meterPercent(view), 4.25);
    assert.equal(meterPercent(allowance({ drawn: '130' })), 100);
  });

  it('says what an action that waits for the person wants, what it can lose, why, and when its offer ends', () => {
    const lab = allowance();
    const above = requestWords(action(), lab, agents, now);
    const past = requestWords(action({ needs: 'total', cost: '5' }), lab, agents, now);
    const none = requestWords(
      action({ needs: 'none', allowance: null, undoable: true }),
      null,
      agents,
      now,
    );

    assert.equal(above.heading, 'An action above your limit');
    assert.equal(
      above.wants,
      'Rowan wants to act: Buy 625 YES on SOFR at 3.88% or lower, at up to 7c',
    );
    assert.equal(
      above.loses,
      'It can lose $46.60. Your allowance is $10 an action. It cannot be undone.',
    );
    assert.match(above.ends, /^The offer ends at \d\d:38, in 4 h 12 min\.$/);
    assert.equal(
      past.loses,
      'It can lose $5. Your allowance has $95.75 left of $100. It cannot be undone.',
    );
    assert.equal(none.heading, 'An action without an allowance');
    assert.equal(
      none.loses,
      'It can lose 46.60. Rowan holds no allowance in force. It can be undone.',
    );
  });

  it('keeps the drafts, the allowances in force, and the stopped ones in sight, and nothing else', () => {
    const lab = labView({
      allowances: [
        allowance({ allowance: 'a-3', state: 'draft' }),
        allowance({ allowance: 'a-2', stopped: true }),
        allowance({ allowance: 'a-1', state: 'replaced' }),
        allowance({ allowance: 'a-0', state: 'ended' }),
      ],
    });

    assert.deepEqual(
      shownAllowances(lab).map((view) => view.allowance),
      ['a-3', 'a-2'],
    );
    assert.deepEqual(
      stoppedAllowances(lab).map((view) => view.allowance),
      ['a-2'],
    );
    assert.deepEqual(shownAllowances(labView()), []);
  });

  it('says who missed what, when it ended, and how long it waited', () => {
    assert.match(
      missedRow(missed(), agents, now),
      /^Rowan: Its harness asks you a question\. Ended \d\d:01, after 1 min\.$/,
    );
    const ask = result('p-5', { kind: 'ask', ends_at: '2026-11-06T15:00:00Z' });
    assert.match(askEnds(ask, now) ?? '', /^It waits until \d\d:00, in 34 min\.$/);
    assert.equal(askEnds(result('p-6'), now), null);
    assert.deepEqual([...actionIds([action(), postView(result('p-2'))])], ['p-12']);
  });

  it('names an action in a thread and a draft of the desk in the desk chat', () => {
    const context = { called: () => 'Rowan', author: null };
    assert.equal(act(action().post, null, context), 'declared an action, which waits for you');
    assert.equal(
      act(action({ allowed: true, needs: null }).post, null, context),
      'declared an action, which its allowance allowed',
    );
    assert.equal(
      act(result('p-13', { kind: 'receipt', reply_to: 'p-12', cost: '3' }), action().post, context),
      'reported what Rowan’s action did',
    );
    const drafted = {
      on: 'p-7',
      at: '2026-11-06T14:01:00Z',
      kind: 'allowance' as const,
      post: null,
      thread: null,
      agent: null,
      deliverable: null,
      change: null,
      ends_at: null,
      allowance: 'a-1',
    };
    assert.equal(
      actionLine(drafted, agents),
      'Drafted the allowance a-1 for you. It starts when you confirm it.',
    );
  });
});

describe('the seat of an acting agent', () => {
  it('is no coordinator and no desk, and the one that the person ticked last stays', () => {
    const seat = newSeat('claude-code');
    const [acting] = withSeat([seat], 0, { ...seat, acting: true });
    assert.ok(acting);
    assert.deepEqual(seatChoice(acting), { harness: 'claude-code', count: 1, acting: true });
    assert.ok(modelSummary(acting, OFFER).endsWith('acting'));
    const [coordinator] = withSeat([acting], 0, { ...acting, coordinator: true });
    assert.equal(coordinator?.acting, false);
    const [back] = withSeat([{ ...acting, acting: false, desk: true }], 0, {
      ...acting,
      acting: true,
      desk: true,
    });
    assert.deepEqual([back?.acting, back?.desk], [true, false]);
  });

  it('has a switch for the person, except for an invited agent, the desk, and the coordinator', () => {
    assert.equal(actingSwitch(rowan)?.label, 'Take back the acting mark');
    assert.equal(actingSwitch(agentView('agent-2'))?.label, 'Make it an acting seat');
    assert.equal(actingSwitch(agentView('agent-3', { desk: true })), null);
    assert.equal(actingSwitch(agentView('agent-4', { coordinator: true })), null);
    const guest = agentView('agent-5');
    assert.equal(actingSwitch({ ...guest, agent: { ...guest.agent, harness: 'guest' } }), null);
  });

  it('shows each mode of the harness with its own name and description, as text', () => {
    const modes = [
      { value: 'plan', name: 'Plan', description: 'Reads <b>only</b> and asks before it edits.' },
      { value: 'auto', name: 'Auto' },
    ];
    const html = renderToStaticMarkup(
      <Modes
        entries={[
          { value: 'plan', label: 'Plan' },
          { value: 'auto', label: 'Auto' },
        ]}
        modes={modes}
        value="auto"
        onChange={() => undefined}
      />,
    );

    assert.ok(html.includes('<legend>Mode</legend>'));
    assert.ok(
      html.includes(
        '<b>Plan</b><small>Reads &lt;b&gt;only&lt;/b&gt; and asks before it edits.</small>',
      ),
    );
    assert.ok(html.includes('checked="" value="auto"/><span><b>Auto</b></span>'));
  });

  it('lets the person change the mode of a seat in a running lab, and says when it takes it', () => {
    const harness = HARNESSES[0];
    assert.ok(harness);
    const option = { ...harness, offer: { ...OFFER, modes: [{ value: 'plan', name: 'Plan' }] } };
    const html = renderToStaticMarkup(
      <ModeChange api={{} as Api} view={rowan} option={option} onChange={() => undefined} />,
    );
    const none = renderToStaticMarkup(
      <ModeChange api={{} as Api} view={rowan} option={null} onChange={() => undefined} />,
    );

    assert.ok(html.includes('<legend>Mode of its harness</legend>'));
    assert.ok(html.includes('Its session starts again in the new mode before its next turn.'));
    assert.equal(html.includes('Your auto mode answer'), false);
    assert.equal(none, '');
  });
});

describe('the cards of an allowance', () => {
  it('shows a draft with its terms, the press that starts it, and the note that the limit is recorded', () => {
    const html = renderToStaticMarkup(
      <AllowanceCard
        api={{} as Api}
        view={allowance({ state: 'draft', started_at: null, drawn: '0' })}
        lab={labView({ agents })}
        now={now}
        reload={() => undefined}
        onChange={() => undefined}
      />,
    );

    assert.ok(html.includes('<p class="a-kicker">Allowance · not started</p>'));
    assert.ok(html.includes('<h3>Allowance for Rowan: Place orders on the exchange</h3>'));
    assert.ok(html.includes('<li>Up to $10 an action</li><li>Up to $100 in all</li>'));
    assert.ok(html.includes('Confirm allowance</button>'));
    assert.ok(html.includes('Change</button>'));
    assert.ok(
      html.includes(
        '<p class="a-note"><b>Recorded, not enforced.</b> Rowan holds the key. The board counts what Rowan ' +
          'declares and stops Rowan at the limit.</p>',
      ),
    );
  });

  it('shows an allowance in force with what it used, its meter, its actions, and the presses that pause and end it', () => {
    const view = allowance({
      actions: [
        done(),
        done({ post: 'p-11', state: 'yes', real_cost: null, receipt: null, cost: '46.60' }),
      ],
    });
    const html = renderToStaticMarkup(
      <AllowanceCard
        api={{} as Api}
        view={view}
        lab={labView({ agents })}
        now={now}
        reload={() => undefined}
      />,
    );
    const paused = renderToStaticMarkup(
      <AllowanceCard
        api={{} as Api}
        view={view}
        lab={labView({ agents, actions_paused: '2026-11-06T14:20:00Z' })}
        now={now}
        reload={() => undefined}
      />,
    );

    assert.ok(html.includes('<p class="a-kicker">Allowance · in force</p>'));
    assert.ok(html.includes('aria-valuenow="4"'));
    assert.ok(html.includes('style="width:4.25%"'));
    assert.ok(html.includes('<span class="a-mark good">done</span>'));
    assert.ok(html.includes('<span class="a-amt">$3.73</span>'));
    assert.ok(html.includes('<span class="a-mark turn">you allowed it</span>'));
    assert.ok(html.includes('<span class="a-amt">$46.60</span>'));
    assert.ok(html.includes('Pause all actions</button>'));
    assert.ok(html.includes('End allowance</button>'));
    assert.ok(html.includes('An action already taken cannot be undone here.'));
    assert.equal(html.includes('Change</button>'), false);
    assert.ok(paused.includes('Let actions go on</button>'));
    assert.ok(paused.includes('You paused every action at '));
  });

  it('says that the board stopped a holder whose actions passed the total, and a long purpose wraps', () => {
    const long = `Place ${'very '.repeat(60)}long orders`;
    const view = allowance({
      stopped: true,
      drawn: '130',
      terms: { ...allowance().terms, purpose: long },
    });
    const html = renderToStaticMarkup(
      <AllowanceCard
        api={{} as Api}
        view={view}
        lab={labView({ agents })}
        now={now}
        reload={() => undefined}
      />,
    );
    const over = renderToStaticMarkup(
      <AllowanceCard
        api={{} as Api}
        view={allowance({ state: 'over' })}
        lab={labView({ agents })}
        now={now}
        reload={() => undefined}
      />,
    );

    assert.ok(html.includes('<details class="a-card a-live a-stopped"'));
    // A stopped allowance needs the person, so it shows opened.
    assert.ok(/<details class="a-card a-live a-stopped"[^>]* open=""/.test(html));
    assert.ok(html.includes('Allowance · stopped at its total'));
    assert.ok(
      html.includes(
        'Rowan’s actions passed the total, so the board stopped Rowan. End this allowance or confirm a new one to let Rowan go on.',
      ),
    );
    assert.ok(html.includes('style="width:100%"'));
    assert.ok(html.includes('No action yet.'));
    assert.equal(over.includes('End allowance'), false);
  });

  it('folds what the person missed with the line that nothing was done', () => {
    const html = renderToStaticMarkup(
      <MissedFold
        lab={labView({ agents, missed: [missed(), missed({ post: 'p-5' })] })}
        now={now}
      />,
    );

    assert.ok(html.includes('<details class="a-fold">'));
    // The fold is one line until the person opens it.
    assert.ok(html.includes('<summary><u>Missed while you were away · 2</u></summary>'));
    assert.ok(html.includes('Their time ended before you answered. Nothing was done.'));
    assert.ok(html.includes('href="#/thread/t-2/p-5"'));
    assert.equal(renderToStaticMarkup(<MissedFold lab={labView()} now={now} />), '');
  });
});

describe('the pages that show allowances and actions', () => {
  const lab = labView({
    agents,
    needs_you: 2,
    allowances: [allowance(), allowance({ allowance: 'a-0', stopped: true })],
    missed: [missed()],
    waits: [
      {
        kind: 'approval',
        agent: 'agent-1',
        what: 'Asks you to allow an action',
        since: '2026-11-06T14:14:00Z',
        post: 'p-12',
        thread: 't-1',
      },
    ],
  });

  it('puts what needs the person first: the stopped allowance, the action that waits, and then the fold', () => {
    const html = renderToStaticMarkup(
      <NeedsPage api={{} as Api} data={data(lab, [action()])} now={now} />,
    );

    assert.ok(
      html.includes('<p class="sub">2 waiting. Requests that pause an agent come first.</p>'),
    );
    const stopped = html.indexOf('Allowance · stopped at its total');
    const request = html.indexOf('<h3>An action above your limit</h3>');
    const fold = html.indexOf('Missed while you were away · 1');
    assert.ok(stopped > 0 && stopped < request && request < fold);
    assert.ok(html.includes('Allow this action</button>'));
    assert.ok(html.includes('<li class="a-ends">The offer ends at '));
  });

  it('shows an ask that ends with its end time', () => {
    const asked = result('p-5', {
      kind: 'ask',
      mentions: ['person'],
      text: 'Buy now?',
      choices: [],
      ends_at: '2026-11-06T15:00:00Z',
    });
    const html = renderToStaticMarkup(
      <NeedsPage api={{} as Api} data={data(labView({ agents }), [postView(asked)])} now={now} />,
    );

    assert.ok(html.includes('It waits until '));
  });

  it('shows the action as a card beside the wall and not as a row, with the allowance in force under it', () => {
    const html = renderToStaticMarkup(
      <LabPage api={{} as Api} data={data(lab, [action()])} now={now} open={null} post={null} />,
    );

    assert.ok(html.includes('Actions wait for you · 1'));
    assert.ok(html.includes('<h3>An action above your limit</h3>'));
    assert.equal(html.includes('Asks you to allow an action'), false);
    assert.ok(html.indexOf('An action above your limit') < html.indexOf('Allowance · in force'));
    assert.ok(html.includes('Missed while you were away · 1'));
  });

  it('folds the allowance in force to one line with its meter, and the status line holds the one pause', () => {
    const page = renderToStaticMarkup(
      <LabPage api={{} as Api} data={data(lab, [action()])} now={now} open={null} post={null} />,
    );
    const card = page.slice(page.indexOf('<details class="a-card a-live"'));
    const folded = card.slice(0, card.indexOf('</summary>'));

    // The allowance in force is one closed line: whose it is and what for, what it used, and its meter.
    assert.ok(
      card.startsWith(
        '<details class="a-card a-live" aria-label="Allowance: Allowance for Rowan: ',
      ),
    );
    assert.ok(folded.includes('<b>Allowance for Rowan: Place orders on the exchange</b>'));
    assert.ok(folded.includes('role="meter"'));
    assert.equal(folded.includes('Recorded, not enforced'), false);
    // Opened, it has the note that the limit is recorded, and no second press that pauses every action.
    assert.ok(card.includes('Recorded, not enforced.'));
    assert.equal(page.split('Pause all actions</button>').length - 1, 1);
    assert.ok(page.indexOf('Pause all actions</button>') < page.indexOf('<div class="f-steer">'));
  });

  it('shows a draft of the desk once, in the chat beside the wall, and not in the rail', () => {
    const drafted = allowance({ allowance: 'a-2', state: 'draft' });
    const page = renderToStaticMarkup(
      <LabPage
        api={{} as Api}
        data={data(labView({ ...lab, allowances: [drafted] }), [])}
        now={now}
        open={null}
        post={null}
      />,
    );

    assert.equal(page.split('Confirm allowance</button>').length - 1, 1);
    const chat = page.slice(page.indexOf('<section class="c-chat"'));
    assert.ok(chat.includes('Confirm allowance</button>'));
    assert.ok(chat.includes('Recorded, not enforced.'));
  });

  it('shows the desk’s draft in the desk chat under the person’s message that it rests on', () => {
    const message = result('p-7', {
      thread: 't-9',
      author: 'person',
      kind: 'message',
      text: 'Rowan may buy.',
    });
    const view: DeskView = {
      desk: 'agent-3',
      thread: {
        thread: { id: 't-9', title: 'The person and the desk', opened_by: 'person', desk: true },
        watching: false,
        members: [],
        posts: [postView(message, 7)],
      },
      actions: [
        {
          on: 'p-7',
          at: '2026-11-06T14:01:00Z',
          kind: 'allowance',
          post: null,
          thread: null,
          agent: null,
          deliverable: null,
          change: null,
          ends_at: null,
          allowance: 'a-1',
        },
      ],
    };
    const desk = agents[2];
    assert.ok(desk);
    const html = renderToStaticMarkup(
      <DeskPanel
        api={{} as Api}
        view={view}
        holder={desk}
        lab={labView({ agents, allowances: [allowance({ state: 'draft' })] })}
        now={now}
        onClose={() => undefined}
        reload={() => undefined}
      />,
    );

    assert.ok(html.includes('Drafted the allowance a-1 for you. It starts when you confirm it.'));
    assert.ok(html.includes('<li class="k-card">'));
    assert.ok(html.includes('Confirm allowance</button>'));
    assert.ok(html.includes('Recorded, not enforced.'));
  });
});
