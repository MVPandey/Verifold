import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { createApi } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type {
  ConversationView,
  Move,
  Post,
  PostView,
  PowerView,
  RequestAnswered,
  ThreadView,
} from '../src/api/types.ts';
import {
  POWER_WORDS,
  askLine,
  coordinatorOf,
  decidedLine,
  deedOf,
  details,
  doneLine,
  endedLine,
  minutesOf,
  newEnd,
  pickedChoice,
  powerLine,
  powerOf,
  requestState,
  tabs,
  talkLabel,
  undoLabel,
  yesLabel,
} from '../src/model/coordinator.ts';
import { leftLine } from '../src/model/agents.ts';
import { noteLabel, revisedBy } from '../src/model/question.ts';
import { newSeat, seatChoice, setupChoices, startRequest } from '../src/model/setup.ts';
import { act } from '../src/model/turns.ts';
import { CoordinatorSeat, ForYou, OpenedForYou, Panel, Refused } from '../src/ui/Coordinator.tsx';
import type { PageProps } from '../src/ui/hooks.ts';
import { NeedsPage } from '../src/ui/NeedsPage.tsx';
import { FactFields } from '../src/ui/SeatForm.tsx';
import { Turns } from '../src/ui/Thread.tsx';
import { HARNESSES, agentView, ask, labView, postView, result, summary } from './fixtures.ts';

const NOW = new Date('2026-11-06T14:30:00Z');
const MAREN = agentView('agent-1', { coordinator: true });
const TESSEL = agentView('agent-2');
const AGENTS = [MAREN, TESSEL];
const TALK = {
  id: 't-9',
  title: 'The person and the coordinator',
  opened_by: 'person',
  conversation: true,
};

function said(id: string, author: string, text: string, changes: Partial<Post> = {}): PostView {
  return postView(result(id, { kind: 'message', thread: 't-9', author, text, ...changes }));
}

function request(id: string, move: Move, changes: Partial<PostView> = {}): PostView {
  const post = {
    ...result(id, { thread: 't-9', text: 'The depth run needs about 90 minutes.' }),
    kind: 'request',
    move,
  } as Post;
  return { ...postView(post), waits: true, decision: null, ...changes };
}

function decided(by: string, yes = true, minutes: number | null = null): RequestAnswered {
  return { at: '2026-11-06T14:20:00Z', request: 'p-3', yes, by, minutes };
}

const COMMAND = postView(
  ask('p-7', 'agent-2', ['Allow once', 'Always allow', 'Reject'], 'permission', {
    type: 'permission',
    kind: 'execute',
    title: '',
    command: 'kalshi orders list --paper',
    given: '',
    answers: [],
    remembered: ['Always allow'],
    grant: null,
    ids: ['once', 'always', 'no'],
    notes: [],
    size: 0,
  }),
);
const LAB = labView({ agents: AGENTS, ends_at: '2026-11-06T15:00:00Z' });
const AROUND = { lab: LAB, harnesses: HARNESSES, asks: [COMMAND], now: NOW };
const POWERS: readonly PowerView[] = (
  ['time', 'permissions', 'agents', 'settings', 'question'] as const
).map((power) => ({ power, on: false, since: null, used: 0 }));

function view(
  posts: readonly PostView[],
  changes: Partial<ConversationView> = {},
): ConversationView {
  const thread: ThreadView = { thread: TALK, watching: false, members: [], posts };
  return {
    coordinator: 'agent-1',
    thread,
    waits: posts.filter((item) => item.waits).map((item) => item.post.id),
    asks: [COMMAND],
    powers: POWERS,
    deeds: [],
    ...changes,
  };
}

function panel(conversation: ConversationView, tab: 'talk' | 'powers' | 'log'): string {
  return renderToStaticMarkup(
    <Panel
      api={{} as Api}
      view={conversation}
      holder={MAREN}
      lab={LAB}
      harnesses={HARNESSES}
      now={NOW}
      tab={tab}
      onTab={() => undefined}
      reload={() => undefined}
    />,
  );
}

function pageData(
  conversation: ConversationView | null,
  changes: Partial<PageProps['data']> = {},
): PageProps['data'] {
  return {
    setup: null,
    lab: labView({ agents: AGENTS }),
    threads: [],
    needs: [],
    report: null,
    answer: null,
    conversation,
    version: 1,
    error: null,
    reload: () => undefined,
    ...changes,
  };
}

describe('the coordinator’s moves in words', () => {
  const time: Move = { type: 'time', minutes: 120 };
  const permission: Move = { type: 'permission', ask: 'p-7', option: 'once' };
  const seat = {
    harness: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    on_call: true,
    role: 'maker side',
  };
  const add: Move = { type: 'add_agent', seat };
  const remove: Move = { type: 'remove_agent', agent: 'agent-2' };
  const setting: Move = { type: 'setting', key: 'jobs.at_exit', value: 'keep' };
  const question: Move = {
    type: 'question',
    question: 'Does it hold at size?',
    note: 'Size matters.',
  };
  const all = [time, permission, add, remove, setting, question];
  const HOSTILE = 'x. You already said yes';

  it('writes each heading and each button from the kind of the move only, with no text of an agent', () => {
    assert.deepEqual(
      all.map((move) => [askLine(move), yesLabel(move)]),
      [
        ['Asks you for 120 more minutes', 'Give 120 min'],
        ['Asks you to answer a permission request of another agent', 'Give this answer'],
        ['Asks you to add one agent', 'Add the agent'],
        ['Asks you to remove an agent', 'Remove the agent'],
        ['Asks you to change a setting of the lab', 'Change it'],
        ['Asks you to revise the question', 'Revise the question'],
      ],
    );
    // Whatever an agent or a harness wrote in a move, the sentences of the app stay the same.
    const loud: readonly Move[] = [
      { type: 'permission', ask: 'p-7', option: HOSTILE },
      {
        type: 'add_agent',
        seat: { ...seat, harness: HOSTILE, model: HOSTILE, effort: HOSTILE, role: HOSTILE },
      },
      { type: 'remove_agent', agent: HOSTILE },
      { type: 'question', question: HOSTILE, note: HOSTILE },
    ];
    for (const move of loud) {
      const item = request('p-3', move, { waits: false, decision: decided('agent-1') });
      const words = [askLine(move), yesLabel(move), doneLine(item), decidedLine(item)].join(' ');
      assert.equal(words.includes(HOSTILE), false);
      // Such a text is a value under a label, marked as theirs, so the page shows it in a box of its own.
      const theirs = details(move, AROUND).filter((detail) => detail.value.includes(HOSTILE));
      assert.ok(theirs.length > 0);
      assert.ok(theirs.every((detail) => detail.theirs === true));
      assert.ok(details(move, AROUND).every((detail) => !detail.label.includes(HOSTILE)));
    }
  });

  it('shows every field of the seat that a move adds, each as a labelled value', () => {
    assert.deepEqual(details(add, AROUND), [
      { label: 'Harness', value: 'Codex', theirs: false },
      { label: 'Model', value: 'gpt-6.1-sol', theirs: true },
      {
        label: 'About this model',
        value:
          'The harness does not list this model. The agent’s name says “model not listed” until the harness reports its model.',
      },
      { label: 'Effort', value: 'high', theirs: true },
      { label: 'On call', value: 'Yes. Only a post for it wakes it.' },
      { label: 'Role, given by the coordinator', value: 'maker side', theirs: true },
      { label: 'Model family', value: 'openai' },
      { label: 'Mode', value: 'As the lab’s other agents' },
    ]);
    // A model that the harness lists has no such line.
    const listed: Move = {
      type: 'add_agent',
      seat: { harness: 'claude-code', model: 'opus', effort: null, on_call: false, role: '' },
    };
    assert.deepEqual(
      details(listed, AROUND).map((detail) => detail.label),
      ['Harness', 'Model', 'Effort', 'On call', 'Role', 'Model family', 'Mode'],
    );
    const plain: Move = {
      type: 'add_agent',
      seat: { harness: 'other', model: null, effort: null, on_call: false, role: '' },
    };
    assert.deepEqual(details(plain, AROUND, 'agent-2'), [
      { label: 'Harness', value: 'other', theirs: true },
      { label: 'Model', value: 'The harness’s default' },
      { label: 'Effort', value: 'The harness’s default' },
      { label: 'On call', value: 'No' },
      { label: 'Role', value: 'None' },
      { label: 'Model family', value: 'The family of its harness' },
      { label: 'Mode', value: 'As the lab’s other agents' },
      { label: 'The agent that joined', value: 'Agent 2', theirs: true },
    ]);
  });

  it('says what more time means: the new end of the lab, and what the lab has cost so far', () => {
    const fields = details(time, AROUND);
    assert.deepEqual(
      fields.map((detail) => detail.label),
      ['The lab ends now at', 'With these minutes it ends at', 'The lab’s cost so far'],
    );
    assert.equal(newEnd(LAB, 120, NOW)?.toISOString(), '2026-11-06T17:00:00.000Z');
    // After the end has passed, the minutes count from now. A lab without a time limit has no new end.
    const late = new Date('2026-11-06T16:00:00Z');
    assert.equal(newEnd(LAB, 30, late)?.toISOString(), '2026-11-06T16:30:00.000Z');
    assert.equal(newEnd(labView(), 30, NOW), null);
    assert.deepEqual(
      details(time, { ...AROUND, lab: labView() }).map((detail) => detail.label),
      ['The lab’s cost so far'],
    );
  });

  it('gives the other moves their fields in the app’s words', () => {
    assert.deepEqual(details(permission, AROUND), [
      { label: 'The agent that asks for the permission', value: 'Agent 2', theirs: true },
      { label: 'The answer that the coordinator would give', value: 'Allow once', theirs: true },
      { label: 'How long the answer holds', value: 'For this one time' },
    ]);
    // A request whose permission request the page does not have still shows what it names.
    assert.deepEqual(
      details(permission, { ...AROUND, asks: [] }).map((detail) => detail.value),
      ['Not known', 'once', 'For this one time'],
    );
    assert.equal(pickedChoice(time, [COMMAND]), null);
    assert.deepEqual(details(remove, AROUND), [
      { label: 'The agent to remove', value: 'Agent 2', theirs: true },
      { label: 'For how long', value: 'For good. Its posts stay.' },
    ]);
    assert.deepEqual(details(setting, AROUND), [
      { label: 'Setting', value: 'The agents’ processes when Verifold exits' },
      {
        label: 'New value',
        value:
          "Keep them. The next verifold in this folder pauses or resumes them with the lab's time.",
        theirs: false,
      },
      { label: 'The lab’s value now', value: 'Stop them' },
    ]);
    const limit: Move = { type: 'setting', key: 'jobs.at_time_limit', value: 'never' };
    assert.deepEqual(
      details(limit, AROUND).map((detail) => [detail.value, detail.theirs ?? false]),
      [
        ['The agents’ processes at the time limit, and when you stop the lab', false],
        ['never', true],
        ['Pause them', false],
      ],
    );
    assert.deepEqual(details(question, AROUND), [
      { label: 'The new question', value: 'Does it hold at size?', theirs: true },
      { label: 'The coordinator’s note', value: 'Size matters.', theirs: true },
    ]);
    assert.equal(details({ ...question, note: '' }, AROUND).length, 1);
  });

  it('says what each move did, who decided it, and which power covers it', () => {
    const done = (move: Move, by: string): string => {
      const item = request('p-3', move, { waits: false, decision: decided(by, true, null) });
      return `${doneLine(item)}. ${decidedLine(item)}`;
    };
    assert.equal(done(time, 'person'), 'Gave the lab 120 more minutes. You said yes.');
    assert.equal(
      done(permission, 'agent-1'),
      'Answered a permission request. The coordinator did it with the power “Answer permission requests”.',
    );
    assert.equal(
      done(add, 'agent-1'),
      'Added an agent. The coordinator did it with the power “Add or remove agents”.',
    );
    assert.equal(done(remove, 'person'), 'Removed an agent. You said yes.');
    assert.equal(done(setting, 'person'), 'Changed a setting of the lab. You said yes.');
    assert.equal(done(question, 'person'), 'Revised the question. You said yes.');
    const other = request('p-3', time, { waits: false, decision: decided('person', true, 45) });
    assert.equal(doneLine(other), 'Gave the lab 45 more minutes');
    assert.equal(doneLine(said('p-1', 'agent-1', 'Hi')), '');
    assert.equal(decidedLine(request('p-3', time)), '');
    assert.deepEqual(all.map(powerOf), [
      'time',
      'permissions',
      'agents',
      'agents',
      'settings',
      'question',
    ]);
  });

  it('knows how a request stands, why it ended, and which way back the person has', () => {
    assert.equal(requestState(request('p-3', time)), 'waits');
    const seatChanged = request('p-3', time, { waits: false, ended: 'seat' });
    const askAnswered = request('p-3', permission, { waits: false, ended: 'ask' });
    assert.equal(requestState(seatChanged), 'ended');
    assert.equal(endedLine(seatChanged), 'This request ended when the coordinator seat changed.');
    assert.equal(
      endedLine(askAnswered),
      'This request ended, because the permission request got its answer or ended.',
    );
    assert.equal(requestState(request('p-3', time, { decision: decided('person', false) })), 'no');
    assert.equal(requestState(request('p-3', time, { decision: decided('person') })), 'yes');
    assert.equal(requestState(request('p-3', time, { decision: decided('agent-1') })), 'done');
    const deed = { request: request('p-3', time), agent: null, undo: 'take_minutes' as const };
    assert.equal(undoLabel(deed), 'Take the minutes back');
    assert.equal(undoLabel({ ...deed, agent: 'agent-2', undo: 'remove_agent' }), 'Remove it');
    assert.equal(undoLabel({ ...deed, undo: null }), null);
    assert.equal(deedOf(view([], { deeds: [deed] }), 'p-3'), deed);
    assert.equal(deedOf(view([]), 'p-3'), null);
    assert.deepEqual(['90', ' 5 ', '0', '1.5', 'many', '99999'].map(minutesOf), [
      90,
      5,
      null,
      null,
      null,
      null,
    ]);
  });

  it('names the tabs with what waits, the powers, and the holder of the seat', () => {
    assert.deepEqual(
      tabs('Maren', 2).map(([, label]) => label),
      ['Conversation (2 wait for you)', 'What Maren may do', 'Done for you'],
    );
    assert.equal(tabs('Maren', 1)[0]?.[1], 'Conversation (1 waits for you)');
    assert.equal(tabs('Maren', 0)[0]?.[1], 'Conversation');
    assert.equal(talkLabel('Maren', 0), 'Talk to Maren');
    assert.equal(talkLabel('Maren', 1), 'Talk to Maren (1 waits for you)');
    assert.equal(talkLabel('Maren', 3), 'Talk to Maren (3 wait for you)');
    assert.equal(powerLine({ power: 'time', on: false, since: null, used: 0 }), null);
    const since = '2026-11-06T14:20:00Z';
    assert.ok(powerLine({ power: 'time', on: true, since, used: 1 })?.endsWith('Used 1 time.'));
    assert.ok(powerLine({ power: 'time', on: true, since, used: 0 })?.endsWith('Used 0 times.'));
    assert.ok(POWER_WORDS.permissions.what('Maren').includes('for one time'));
    // The settings power says what it leaves to the person: a value that lets processes run on after a stop.
    assert.ok(
      POWER_WORDS.settings
        .what('Maren')
        .includes('To let them run on after a stop, Maren asks you.'),
    );
    assert.ok(POWER_WORDS.time.what('Maren').includes('while the lab has time'));
    assert.equal(coordinatorOf(AGENTS), MAREN);
    assert.equal(coordinatorOf([TESSEL]), null);
    const left = { at: since, by: 'person', reason: '' };
    assert.equal(coordinatorOf([{ ...MAREN, left }]), null);
  });

  it('never puts the coordinator’s words after the person’s removal, and says who revised the question', () => {
    const left = { at: '2026-11-06T14:20:00Z', by: 'person', reason: '' };
    assert.equal(leftLine(left).text, 'Left, removed by you');
    assert.equal(
      leftLine({ ...left, reason: 'Off the question.' }).text,
      'Left, removed by you: Off the question.',
    );
    assert.equal(
      leftLine({ ...left, request: 'p-3' }).text,
      'Left, removed by you at the coordinator’s request',
    );
    assert.equal(
      leftLine({ ...left, request: 'p-3', through: 'agent-1' }).text,
      'Left, removed by the coordinator with the power “Add or remove agents”',
    );
    const version = { question: 'Q?', at: '2026-11-06T14:20:00Z', note: 'Size.', post: 'p-2' };
    assert.equal(revisedBy(version), null);
    assert.equal(revisedBy({ ...version, by: 'person' }), null);
    assert.equal(noteLabel(version), 'Why');
    assert.equal(
      revisedBy({ ...version, by: 'person', request: 'p-3' }),
      'Revised by you, at the coordinator’s request.',
    );
    const powered = { ...version, by: 'agent-1', request: 'p-3' };
    assert.equal(
      revisedBy(powered),
      'Revised by the coordinator, with the power “Revise the question”.',
    );
    assert.equal(noteLabel(powered), 'The coordinator’s reason');
  });

  it('says who answered a permission request through a request of the coordinator', () => {
    const context = { called: (id: string) => (id === 'agent-2' ? 'Agent 2' : id), author: null };
    const answer = (author: string): Post => ({
      ...result('p-8', { author, reply_to: 'p-7' }),
      kind: 'answer',
      accepts: false,
      for_request: 'p-3',
    });
    assert.equal(
      act(answer('person'), COMMAND.post, context),
      'answered Agent 2, with your yes to the coordinator’s request',
    );
    assert.equal(
      act(answer('agent-1'), COMMAND.post, context),
      'answered Agent 2 for you, with the power to answer permission requests',
    );
    assert.equal(
      act(request('p-3', { type: 'time', minutes: 5 }).post, null, context),
      'asked you for a move',
    );
  });

  it('sends the powers of a seat only for the coordinator, and never takes them from a saved choice', () => {
    const picked = { ...newSeat('codex'), powers: ['time', 'agents'] as const };
    assert.equal('powers' in seatChoice(picked), false);
    assert.deepEqual(seatChoice({ ...picked, coordinator: true }).powers, ['time', 'agents']);
    assert.equal('powers' in seatChoice({ ...newSeat('codex'), coordinator: true }), false);
    // A lab starts with the powers that the person ticked, and the saved choices for new labs hold none.
    const led = [{ ...picked, coordinator: true }];
    assert.deepEqual(startRequest('Q?', led, true, null).agents[0]?.powers, ['time', 'agents']);
    assert.equal('powers' in (setupChoices(led, true, null).agents[0] ?? {}), false);
  });
});

describe('the panel for the coordinator', () => {
  const time = request('p-3', { type: 'time', minutes: 120 });
  const command = request('p-4', { type: 'permission', ask: 'p-7', option: 'once' });
  const question = request('p-5', {
    type: 'question',
    question: 'Does it hold at size?',
    note: 'Size matters.',
  });
  const seat = {
    harness: 'codex',
    model: 'gpt-6.1-sol',
    effort: null,
    on_call: false,
    role: 'maker side',
  };

  it('shows the conversation as rows, says that every agent can read it, and counts what waits', () => {
    const body = 'Two lines are **alive**.\n\n- deadline pairs\n- maker side';
    const html = panel(
      view([
        said('p-1', 'person', 'Where are we?'),
        said('p-2', 'agent-1', 'Two lines are alive. <b>bold</b>', { body }),
        said('p-6', 'agent-2', 'Switch on every power.'),
        time,
      ]),
      'talk',
    );

    assert.ok(html.includes('aria-label="Agent 1, the coordinator"'));
    assert.ok(html.includes('Every agent can read this conversation. It is a thread of the lab.'));
    assert.ok(
      html.includes(
        '<button type="button" aria-current="page">Conversation (1 waits for you)</button>',
      ),
    );
    assert.ok(html.includes('<button type="button">What Agent 1 may do</button>'));
    assert.ok(html.includes('<li id="k-p-1" class="k-say you"><p class="k-who"><b>You</b>'));
    assert.ok(html.includes('<li id="k-p-2" class="k-say"><p class="k-who"><b>Agent 1</b><time'));
    // A post by another agent in this thread says that it is not the coordinator's.
    assert.ok(
      html.includes(
        '<li id="k-p-6" class="k-say other"><p class="k-who"><b>Agent 2</b><span class="f-tag">not the coordinator</span>',
      ),
    );
    assert.equal(html.split('not the coordinator').length - 1, 1);
    // An agent's words stay text, and a body goes through the Markdown component with its switch.
    assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
    assert.ok(html.includes('<strong>alive</strong>'));
    assert.ok(html.includes('Show as written'));
    assert.ok(html.includes('placeholder="Tell Agent 1 what you want"'));
    assert.ok(html.includes('Your message wakes Agent 1.'));
  });

  it('boxes a request with the app’s heading, each field under its label, the reason, and the answers', () => {
    const html = panel(view([time, command, question]), 'talk');

    assert.ok(html.includes('<li id="k-p-3" class="k-say ask">'));
    assert.ok(html.includes('<p class="k-ask-head">Asks you for 120 more minutes</p>'));
    assert.ok(html.includes('<dt>With these minutes it ends at</dt>'));
    assert.ok(html.includes('<dt>The lab’s cost so far</dt>'));
    // The coordinator's reason stands under its own label, in a box, apart from the heading.
    assert.ok(
      html.includes(
        '<p class="k-label">The coordinator’s reason</p><div class="k-reason"><p class="k-text">The depth run needs about 90 minutes.</p>',
      ),
    );
    assert.ok(html.includes('<button type="button" class="go">Give 120 min</button>'));
    assert.ok(html.includes('<button type="button">Give another amount</button>'));
    assert.equal(html.split('<button type="button">Not now</button>').length - 1, 3);
    // A command stands in the labeled box of the permission request that the move names.
    assert.ok(html.includes('The command, exactly as the harness of that agent sent it'));
    assert.ok(html.includes('<pre>kalshi orders list --paper</pre>'));
    assert.ok(
      html.includes(
        '<dt>The answer that the coordinator would give</dt><dd class="theirs">Allow once</dd>',
      ),
    );
    assert.ok(html.includes('<button type="button" class="go">Give this answer</button>'));
    assert.ok(html.includes('href="#/thread/t-2/p-7"'));
    assert.ok(
      html.includes('<dt>The new question</dt><dd class="theirs">Does it hold at size?</dd>'),
    );
    assert.ok(
      html.includes('<dt>The coordinator’s note</dt><dd class="theirs">Size matters.</dd>'),
    );
    // Only a request for more time offers another amount.
    assert.equal(html.split('Give another amount').length - 1, 1);
  });

  it('shows every field of the seat that a request would add', () => {
    const html = panel(view([request('p-3', { type: 'add_agent', seat })]), 'talk');

    for (const field of [
      '<dt>Harness</dt><dd>Codex</dd>',
      '<dt>Model</dt><dd class="theirs">gpt-6.1-sol</dd>',
      '<dt>Effort</dt><dd>The harness’s default</dd>',
      '<dt>On call</dt><dd>No</dd>',
      '<dt>Role, given by the coordinator</dt><dd class="theirs">maker side</dd>',
      '<dt>Model family</dt><dd>openai</dd>',
      '<dt>Mode</dt><dd>As the lab’s other agents</dd>',
    ]) {
      assert.ok(html.includes(field), field);
    }
    assert.ok(html.includes('<p class="k-ask-head">Asks you to add one agent</p>'));
    assert.ok(html.includes('<button type="button" class="go">Add the agent</button>'));
  });

  it('says how a request ended, and offers the way back only where there is one', () => {
    const power = request(
      'p-3',
      { type: 'add_agent', seat },
      { waits: false, decision: decided('agent-1') },
    );
    const no = request(
      'p-4',
      { type: 'time', minutes: 30 },
      { waits: false, decision: decided('person', false) },
    );
    const ended = request('p-5', { type: 'time', minutes: 30 }, { waits: false, ended: 'seat' });
    const yes = request(
      'p-6',
      { type: 'time', minutes: 30 },
      { waits: false, decision: decided('person') },
    );
    const closed = request(
      'p-8',
      { type: 'permission', ask: 'p-7', option: 'once' },
      { waits: false, ended: 'ask' },
    );
    const deeds = [
      { request: power, agent: 'agent-2', undo: 'remove_agent' as const },
      { request: yes, agent: null, undo: null },
    ];
    const html = panel(view([power, no, ended, yes, closed], { deeds }), 'talk');

    assert.ok(
      html.includes(
        'Added an agent. The coordinator did it with the power “Add or remove agents”.',
      ),
    );
    assert.ok(html.includes('<dt>The agent that joined</dt><dd class="theirs">Agent 2</dd>'));
    assert.ok(html.includes('<button type="button">Remove it</button>'));
    assert.ok(html.includes('You said: not now.'));
    assert.ok(html.includes('This request ended when the coordinator seat changed.'));
    assert.ok(
      html.includes('This request ended, because the permission request got its answer or ended.'),
    );
    assert.ok(html.includes('Gave the lab 30 more minutes. You said yes.'));
    assert.equal(html.includes('Take the minutes back'), false);
    assert.equal(html.includes('class="go"'), false);
  });

  it('lets the person answer an ask of the coordinator with a choice or in words', () => {
    const asked = postView({
      ...ask('p-2', 'agent-1', ['Size', 'Floor'], null),
      thread: 't-9',
      text: 'Size or floor?',
    });
    const html = panel(view([asked], { waits: ['p-2'] }), 'talk');
    const old = panel(view([asked], { waits: [] }), 'talk');

    assert.ok(html.includes('<li id="k-p-2" class="k-say ask">'));
    assert.ok(
      html.includes('<button type="button">Size</button><button type="button">Floor</button>'),
    );
    assert.ok(html.includes('placeholder="Or answer in your own words"'));
    assert.equal(old.includes('Or answer in your own words'), false);
    const open = postView({
      ...ask('p-2', 'agent-1', [], null),
      thread: 't-9',
      text: 'What matters most?',
    });
    assert.ok(
      panel(view([open], { waits: ['p-2'] }), 'talk').includes('placeholder="Your answer"'),
    );
  });

  it('shows one switch for each power, off by default, and says what stays with the person', () => {
    const on = POWERS.map((power) =>
      power.power === 'agents'
        ? { ...power, on: true, since: '2026-11-06T14:20:00Z', used: 1 }
        : power,
    );
    const html = panel(view([], { powers: on }), 'powers');

    assert.equal(html.split('role="switch"').length - 1, 5);
    assert.equal(html.split('aria-checked="false"').length - 1, 4);
    assert.ok(html.includes('aria-checked="true" aria-label="Add or remove agents"'));
    assert.ok(html.includes('Used 1 time.'));
    assert.ok(html.includes('Agent 1 asks you before each of these.'));
    assert.ok(
      html.includes('After the lab’s time ran out, or after you stopped the lab, Agent 1 asks'),
    );
    assert.ok(html.includes('To let them run on after a stop, Agent 1 asks you.'));
    assert.ok(html.includes('Stopping the lab stays with you. No switch gives it away.'));
    // What the founder dropped stays out: no limits, and no warning under a power.
    assert.equal(html.includes('Limit:'), false);
    assert.equal(html.includes('k-warn'), false);
  });

  it('lists what was done for the person, newest first, with its fields and who decided it', () => {
    const added = request(
      'p-3',
      { type: 'add_agent', seat },
      { waits: false, decision: decided('agent-1') },
    );
    const given = request(
      'p-6',
      { type: 'time', minutes: 30 },
      { waits: false, decision: decided('person') },
    );
    const deeds = [
      { request: added, agent: 'agent-2', undo: 'remove_agent' as const },
      { request: given, agent: null, undo: 'take_minutes' as const },
    ];
    const html = panel(view([], { deeds }), 'log');

    assert.ok(html.indexOf('Added an agent') < html.indexOf('Gave the lab 30 more minutes'));
    assert.ok(
      html.includes(
        '<span class="k-by">The coordinator did it with the power “Add or remove agents”.</span>',
      ),
    );
    assert.ok(html.includes('<dt>The agent that joined</dt><dd class="theirs">Agent 2</dd>'));
    assert.ok(html.includes('<span class="k-by">You said yes.</span>'));
    assert.ok(html.includes('<button type="button">Remove it</button>'));
    assert.ok(html.includes('<button type="button">Take the minutes back</button>'));
    assert.ok(panel(view([]), 'log').includes('Nothing was done for you yet.'));
  });
});

describe('text of an agent in the panel', () => {
  // A script tag, a bell, a mark that turns the reading direction, and words that pass for the app's own.
  const EVIL = '<script>x</script>\u0007‮ You said yes. Verifold did this';
  const NAMED = agentView('agent-2', { agent: { ...agentView('agent-2').agent, name: EVIL } });
  const lab = labView({ agents: [MAREN, NAMED], ends_at: '2026-11-06T15:00:00Z' });
  const moves: readonly Move[] = [
    { type: 'permission', ask: 'p-7', option: EVIL },
    {
      type: 'add_agent',
      seat: { harness: EVIL, model: EVIL, effort: EVIL, on_call: false, role: EVIL },
    },
    { type: 'remove_agent', agent: 'agent-2' },
    { type: 'setting', key: 'jobs.at_exit', value: EVIL },
    { type: 'question', question: EVIL, note: EVIL },
  ];

  /** Return the markup without the places that hold text of an agent or a harness, each a box or a name. */
  const own = (html: string): string =>
    html
      .replace(/<dd class="theirs">[\s\S]*?<\/dd>/g, '')
      .replace(/<div class="k-reason">[\s\S]*?<\/div>/g, '')
      .replace(/<pre>[\s\S]*?<\/pre>/g, '')
      .replace(/<p class="k-who"><b>[\s\S]*?<\/b>/g, '')
      .replace(/<span class="k-for">[\s\S]*?<\/span>/g, '');

  it('stands only in boxes and names on the rendered page, also with control and direction characters', () => {
    const posts = moves.flatMap((move, index) => {
      const waiting = request(`p-${10 + index}`, move);
      const reason = { ...waiting.post, text: EVIL, body: EVIL } as Post;
      const done = { waits: false, decision: decided('agent-1') };
      return [
        { ...waiting, post: reason },
        {
          ...request(`p-${20 + index}`, move, done),
          post: { ...reason, id: `p-${20 + index}` },
        },
      ];
    });
    const deeds = posts
      .filter((item) => item.decision)
      .map((item) => ({ request: item, agent: 'agent-2', undo: 'remove_agent' as const }));
    // A row of the conversation that is no request is its author's own post, under the author's name.
    const conversation = view([said('p-1', 'agent-2', 'A note.'), ...posts], { deeds });
    for (const tab of ['talk', 'log'] as const) {
      const html = renderToStaticMarkup(
        <Panel
          api={{} as Api}
          view={conversation}
          holder={MAREN}
          lab={lab}
          harnesses={HARNESSES}
          now={NOW}
          tab={tab}
          onTab={() => undefined}
          reload={() => undefined}
        />,
      );
      // The text is on the page as text, never as markup.
      assert.equal(html.includes('<script>'), false);
      assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
      // Outside the boxes and the names, no sentence, heading, or button of the app holds a word of it.
      const rest = own(html);
      for (const part of ['script', '\u0007', '‮', 'You said yes. Verifold did this']) {
        assert.equal(rest.includes(part), false, `${tab}: ${part}`);
      }
      assert.ok(rest.includes('Asks you to add one agent') || tab === 'log');
    }
  });

  it('shows a refusal of the server as the app’s sentence, with the server’s words in a box of their own', () => {
    const html = renderToStaticMarkup(
      <Refused text={`This computer has no harness with the key \`${EVIL}\`.`} />,
    );

    assert.ok(
      html.startsWith(
        '<div class="k-refused" role="alert"><p class="error">Verifold did not do this.</p>',
      ),
    );
    assert.ok(
      html.includes(
        '<figcaption>What the server said</figcaption><pre>This computer has no harness',
      ),
    );
    assert.equal(html.includes('<script>'), false);
    assert.equal(own(html).includes('script'), false);
    assert.equal(own(html).includes('‮'), false);
  });

  it('marks a post on the person’s behalf with the name of its author only in the mark', () => {
    const html = renderToStaticMarkup(<ForYou marked agents={[MAREN, NAMED]} author="agent-2" />);
    assert.ok(html.startsWith('<span class="k-for">posted for you by &lt;script&gt;'));
    assert.equal(own(html), '');
  });
});

describe('the coordinator in the seat', () => {
  it('offers the conversation when an agent holds the seat, and says so when none does', () => {
    const closed = renderToStaticMarkup(
      <CoordinatorSeat
        api={{} as Api}
        data={pageData(view([request('p-3', { type: 'time', minutes: 5 })]))}
        now={NOW}
      />,
    );
    const open = renderToStaticMarkup(
      <CoordinatorSeat api={{} as Api} data={pageData(null)} now={NOW} start="powers" />,
    );
    const none = renderToStaticMarkup(
      <CoordinatorSeat
        api={{} as Api}
        data={pageData(null, { lab: labView({ agents: [TESSEL] }) })}
        now={NOW}
        start="talk"
      />,
    );

    assert.ok(closed.includes('>Agent 1</button><span class="i-seat coord">Coordinator</span>'));
    assert.ok(closed.includes('aria-expanded="false">Talk to Agent 1 (1 waits for you)</button>'));
    assert.equal(closed.includes('k-panel'), false);
    assert.ok(open.includes('aria-expanded="true">Close the conversation</button>'));
    assert.ok(open.includes('<aside class="k-panel"'));
    assert.ok(none.includes('<b>No agent holds the coordinator seat.</b>'));
    assert.ok(
      none.includes(
        'Give the seat to an agent in the member list, or write to the whole lab here.',
      ),
    );
    assert.equal(none.includes('k-panel'), false);
  });

  it('shows a request on the Needs you page with its answers', () => {
    const item = request('p-3', { type: 'time', minutes: 120 });
    const html = renderToStaticMarkup(
      <NeedsPage api={{} as Api} data={pageData(view([item]), { needs: [item] })} now={NOW} />,
    );

    assert.ok(html.includes('<span class="kind">Asks you for a move</span>'));
    assert.ok(html.includes('Asks you for 120 more minutes'));
    assert.ok(html.includes('<button type="button" class="go">Give 120 min</button>'));
    assert.equal(html.includes('Send answer'), false);
  });

  it('marks a post that the coordinator wrote for the person, and a thread that it opened for the person', () => {
    const thread: ThreadView = {
      thread: { id: 't-1', title: 'Size', opened_by: 'agent-1', for_person: true },
      watching: false,
      members: [],
      posts: [
        postView(result('p-1', { kind: 'message', for_person: true })),
        postView(result('p-2')),
      ],
    };
    const turns = renderToStaticMarkup(
      <Turns
        view={thread}
        agents={AGENTS}
        needs={[]}
        question={null}
        reruns={[]}
        now={new Date('2026-11-06T14:26:00Z')}
        onRerun={() => Promise.resolve()}
        onSend={() => Promise.resolve()}
      />,
    );
    const card = renderToStaticMarkup(
      <OpenedForYou summary={summary({ thread: thread.thread })} agents={AGENTS} />,
    );

    assert.equal(turns.split('<span class="k-for">posted for you by Agent 1</span>').length - 1, 1);
    assert.equal(card, '<span class="k-for">Opened for you by Agent 1</span>');
    assert.equal(renderToStaticMarkup(<OpenedForYou summary={summary()} agents={AGENTS} />), '');
    assert.equal(
      renderToStaticMarkup(<ForYou marked={undefined} agents={AGENTS} author="agent-1" />),
      '',
    );
  });

  it('offers the powers at setup only for the seat of the coordinator', () => {
    const facts = { role: '', family: '', onCall: false, coordinator: false };
    const plain = renderToStaticMarkup(
      <FactFields value={facts} family="openai" onChange={() => undefined} />,
    );
    const seat = renderToStaticMarkup(
      <FactFields
        value={{ ...facts, coordinator: true, powers: ['time'] as const }}
        family="openai"
        onChange={() => undefined}
      />,
    );

    assert.equal(plain.includes('without asking you'), false);
    assert.ok(seat.includes('What the coordinator may do without asking you'));
    assert.equal(seat.split('type="checkbox" checked=""').length - 1, 2);
    assert.ok(seat.includes('Stopping the lab stays with you.'));
  });
});

describe('the coordinator’s calls to the API', () => {
  it('reads the conversation, switches a power, answers a request, and takes minutes back', async () => {
    const calls: [string, string | undefined][] = [];
    const api = createApi('secret', (input, init) => {
      calls.push([input, typeof init.body === 'string' ? init.body : undefined]);
      return Promise.resolve(new Response('{"powers": []}', { status: 200 }));
    });

    await api.conversation();
    await api.setPower('agents', true);
    await api.answerRequest('p 3', true);
    await api.answerRequest('p-3', true, 45);
    await api.answerRequest('p-3', false);
    await api.takeMinutesBack('p-3');

    assert.deepEqual(calls, [
      ['/api/conversation', undefined],
      ['/api/powers', '{"power":"agents","on":true}'],
      ['/api/requests/p%203', '{"yes":true}'],
      ['/api/requests/p-3', '{"yes":true,"minutes":45}'],
      ['/api/requests/p-3', '{"yes":false}'],
      ['/api/requests/p-3/minutes', '{}'],
    ]);
  });
});
