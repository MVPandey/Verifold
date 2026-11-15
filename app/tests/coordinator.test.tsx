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
  doneLine,
  minutesOf,
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
import { newSeat, seatChoice, setupChoices, startRequest } from '../src/model/setup.ts';
import { act } from '../src/model/turns.ts';
import { CoordinatorSeat, ForYou, OpenedForYou, Panel } from '../src/ui/Coordinator.tsx';
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
const AROUND = { agents: AGENTS, harnesses: HARNESSES, asks: [COMMAND] };
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
      agents={AGENTS}
      harnesses={HARNESSES}
      resting={false}
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
  const add: Move = {
    type: 'add_agent',
    seat: {
      harness: 'codex',
      count: 1,
      model: 'gpt-6.1-sol',
      effort: 'high',
      mode: null,
      role: 'maker side',
    },
  };
  const remove: Move = { type: 'remove_agent', agent: 'agent-2' };
  const setting: Move = { type: 'setting', key: 'jobs.at_exit', value: 'keep' };
  const question: Move = { type: 'question', question: 'Does it hold at size?', note: '' };

  it('says what each request asks for, and what its yes button does', () => {
    assert.deepEqual(
      [time, permission, add, remove, setting, question].map((move) => [
        askLine(move, AROUND),
        yesLabel(move, AROUND),
      ]),
      [
        ['Asks you for 120 more minutes', 'Give 120 min'],
        ['Asks you to answer “Allow once” to a permission request of Agent 2', 'Allow once'],
        [
          'Asks you to add an agent: Codex · gpt-6.1-sol · high effort · role: maker side',
          'Add the agent',
        ],
        ['Asks you to remove Agent 2', 'Remove Agent 2'],
        [
          'Asks you to change a setting. When Verifold exits, for the agents’ processes: Keep them',
          'Change it',
        ],
        ['Asks you to revise the question', 'Revise the question'],
      ],
    );
    // A request whose permission request the page does not have still reads as a sentence.
    const lost = { ...AROUND, asks: [] };
    assert.equal(askLine(permission, lost), 'Asks you to answer a permission request of an agent');
    assert.equal(yesLabel(permission, lost), 'Answer it so');
    assert.equal(pickedChoice(time, [COMMAND]), null);
    assert.equal(
      askLine({ type: 'setting', key: 'jobs.at_time_limit', value: 'finish' }, AROUND),
      'Asks you to change a setting. At the time limit, for the agents’ processes: Let them finish',
    );
  });

  it('says what each move did, who decided it, and which power covers it', () => {
    const done = (move: Move, by: string, agent: string | null = null): string => {
      const item = request('p-3', move, { waits: false, decision: decided(by, true, null) });
      return `${doneLine(item, agent, AROUND)}. ${decidedLine(item, AROUND)}`;
    };
    assert.equal(done(time, 'person'), 'Gave the lab 120 more minutes. You said yes.');
    assert.equal(
      done(permission, 'agent-1'),
      'Answered “Allow once” to a permission request of Agent 2. Agent 1 did it with the power “Answer permission requests”.',
    );
    assert.equal(
      done(add, 'agent-1', 'agent-2'),
      'Added an agent: Agent 2. Agent 1 did it with the power “Add or remove agents”.',
    );
    assert.ok(done(add, 'person').startsWith('Added an agent: Codex · gpt-6.1-sol'));
    assert.equal(done(remove, 'person'), 'Removed Agent 2. You said yes.');
    assert.ok(done(setting, 'person').startsWith('Changed a setting. When Verifold exits'));
    assert.equal(done(question, 'person'), 'Revised the question. You said yes.');
    const other = request('p-3', time, { waits: false, decision: decided('person', true, 45) });
    assert.equal(doneLine(other, null, AROUND), 'Gave the lab 45 more minutes');
    assert.equal(doneLine(said('p-1', 'agent-1', 'Hi'), null, AROUND), '');
    assert.equal(decidedLine(request('p-3', time), AROUND), '');
    assert.deepEqual([time, permission, add, remove, setting, question].map(powerOf), [
      'time',
      'permissions',
      'agents',
      'agents',
      'settings',
      'question',
    ]);
    assert.equal(
      doneLine(request('p-3', permission, { decision: decided('person') }), null, {
        ...AROUND,
        asks: [],
      }),
      'Answered a permission request of an agent',
    );
  });

  it('knows how a request stands and which way back the person has', () => {
    assert.equal(requestState(request('p-3', time)), 'waits');
    assert.equal(requestState(request('p-3', time, { waits: false })), 'ended');
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
    assert.equal(coordinatorOf(AGENTS), MAREN);
    assert.equal(coordinatorOf([TESSEL]), null);
    const left = { at: since, by: 'person', reason: '' };
    assert.equal(coordinatorOf([{ ...MAREN, left }]), null);
    assert.equal(leftLine(left).text, 'Left, removed by you');
    assert.equal(
      leftLine({ ...left, through: 'agent-1', reason: 'No line.' }).text,
      'Left, removed by the coordinator with your power: No line.',
    );
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
    const seat = { ...newSeat('codex'), powers: ['time', 'agents'] as const };
    assert.equal('powers' in seatChoice(seat), false);
    assert.deepEqual(seatChoice({ ...seat, coordinator: true }).powers, ['time', 'agents']);
    assert.equal('powers' in seatChoice({ ...newSeat('codex'), coordinator: true }), false);
    // A lab starts with the powers that the person ticked, and the saved choices for new labs hold none.
    const led = [{ ...seat, coordinator: true }];
    assert.deepEqual(startRequest('Q?', led, true, null).agents[0]?.powers, ['time', 'agents']);
    assert.equal('powers' in (setupChoices(led, true, null).agents[0] ?? {}), false);
  });
});

describe('the panel for the coordinator', () => {
  const time = request('p-3', { type: 'time', minutes: 120 });
  const command = request(
    'p-4',
    { type: 'permission', ask: 'p-7', option: 'once' },
    { waits: true },
  );
  const question = request('p-5', {
    type: 'question',
    question: 'Does it hold at size?',
    note: 'Size matters.',
  });

  it('shows the conversation as rows, says that every agent can read it, and counts what waits', () => {
    const body = 'Two lines are **alive**.\n\n- deadline pairs\n- maker side';
    const html = panel(
      view([
        said('p-1', 'person', 'Where are we?'),
        said('p-2', 'agent-1', 'Two lines are alive. <b>bold</b>', { body }),
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
    assert.ok(html.includes('<li id="k-p-2" class="k-say"><p class="k-who"><b>Agent 1</b>'));
    // An agent's words stay text, and a body goes through the Markdown component with its switch.
    assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
    assert.ok(html.includes('<strong>alive</strong>'));
    assert.ok(html.includes('Show as written'));
    assert.ok(html.includes('placeholder="Tell Agent 1 what you want"'));
    assert.ok(html.includes('Your message wakes Agent 1.'));
  });

  it('boxes a request with its heading, its reason, and its answers as buttons', () => {
    const html = panel(view([time, command, question]), 'talk');

    assert.ok(html.includes('<li id="k-p-3" class="k-say ask">'));
    assert.ok(html.includes('<p class="k-ask-head">Asks you for 120 more minutes</p>'));
    assert.ok(html.includes('<p class="k-text">The depth run needs about 90 minutes.</p>'));
    assert.ok(html.includes('<button type="button" class="go">Give 120 min</button>'));
    assert.ok(html.includes('<button type="button">Give another amount</button>'));
    assert.equal(html.split('<button type="button">Not now</button>').length - 1, 3);
    // A command stands in the labeled box of the permission request that the move names.
    assert.ok(html.includes('The command, exactly as the harness of Agent 2 sent it'));
    assert.ok(html.includes('<pre>kalshi orders list --paper</pre>'));
    assert.ok(html.includes('<button type="button" class="go">Allow once</button>'));
    assert.ok(html.includes('href="#/thread/t-2/p-7"'));
    assert.ok(
      html.includes('<figcaption>The new question</figcaption><pre>Does it hold at size?</pre>'),
    );
    assert.ok(html.includes('Why: Size matters.'));
    // Only a request for more time offers another amount.
    assert.equal(html.split('Give another amount').length - 1, 1);
  });

  it('says how a request ended, and offers the way back only where there is one', () => {
    const power = request(
      'p-3',
      {
        type: 'add_agent',
        seat: { harness: 'codex', count: 1, model: null, effort: null, mode: null },
      },
      {
        waits: false,
        decision: decided('agent-1'),
      },
    );
    const no = request(
      'p-4',
      { type: 'time', minutes: 30 },
      { waits: false, decision: decided('person', false) },
    );
    const ended = request('p-5', { type: 'time', minutes: 30 }, { waits: false });
    const yes = request(
      'p-6',
      { type: 'time', minutes: 30 },
      { waits: false, decision: decided('person') },
    );
    const deeds = [
      { request: power, agent: 'agent-2', undo: 'remove_agent' as const },
      { request: yes, agent: null, undo: null },
    ];
    const html = panel(view([power, no, ended, yes], { deeds }), 'talk');

    assert.ok(
      html.includes(
        'Added an agent: Agent 2. Agent 1 did it with the power “Add or remove agents”.',
      ),
    );
    assert.ok(html.includes('<button type="button">Remove it</button>'));
    assert.ok(html.includes('You said: not now.'));
    assert.ok(html.includes('This request ended when the coordinator seat changed.'));
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

  it('shows one switch for each power, off by default, and says that stopping stays with the person', () => {
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
    assert.ok(html.includes('Stopping the lab stays with you. No switch gives it away.'));
    // What the founder dropped stays out: no limits, and no warning under a power.
    assert.equal(html.includes('Limit:'), false);
    assert.equal(html.includes('k-warn'), false);
  });

  it('lists what was done for the person, newest first, with who decided it', () => {
    const added = request(
      'p-3',
      {
        type: 'add_agent',
        seat: { harness: 'codex', count: 1, model: null, effort: null, mode: null },
      },
      {
        waits: false,
        decision: decided('agent-1'),
      },
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

    assert.ok(
      html.indexOf('Added an agent: Agent 2') < html.indexOf('Gave the lab 30 more minutes'),
    );
    assert.ok(
      html.includes(
        '<span class="k-by">Agent 1 did it with the power “Add or remove agents”.</span>',
      ),
    );
    assert.ok(html.includes('<span class="k-by">You said yes.</span>'));
    assert.ok(html.includes('<button type="button">Remove it</button>'));
    assert.ok(html.includes('<button type="button">Take the minutes back</button>'));
    assert.ok(panel(view([]), 'log').includes('Nothing was done for you yet.'));
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
        onRerun={() => Promise.resolve()}
        onSend={() => Promise.resolve()}
      />,
    );
    const card = renderToStaticMarkup(
      <OpenedForYou summary={summary({ thread: thread.thread })} agents={AGENTS} />,
    );

    assert.equal(turns.split('for you, through the coordinator').length - 1, 1);
    assert.equal(card, '<span class="k-for">Opened for you by Agent 1</span>');
    assert.equal(renderToStaticMarkup(<OpenedForYou summary={summary()} agents={AGENTS} />), '');
    assert.equal(renderToStaticMarkup(<ForYou marked={undefined} />), '');
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
