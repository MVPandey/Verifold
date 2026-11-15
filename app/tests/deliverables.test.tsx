import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { createApi } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type { Deliverable, DeliverableOffer, Post } from '../src/api/types.ts';
import {
  deliverCounts,
  deliverLine,
  isNewSentence,
  offerLine,
  stateLine,
} from '../src/model/deliverables.ts';
import { clock } from '../src/model/format.ts';
import { sentences, startRequest } from '../src/model/setup.ts';
import { act, tone } from '../src/model/turns.ts';
import { DeliverDoor, Deliverables } from '../src/ui/Deliverables.tsx';
import { LabPage } from '../src/ui/LabPage.tsx';
import { SetupPage } from '../src/ui/SetupPage.tsx';
import { DEFAULTS, HARNESSES, agentView, labView, result, summary } from './fixtures.ts';

const NOW = new Date('2026-11-06T14:30:00Z');
const MAREN = agentView('agent-1', {
  chosen_name: 'Maren',
  agent: { ...agentView('agent-1').agent, name: 'Maren' },
});
const TESSEL = agentView('agent-2');
const AGENTS = [MAREN, TESSEL];

function offer(
  post: string,
  by: string,
  changes: Partial<DeliverableOffer> = {},
): DeliverableOffer {
  return {
    post,
    by,
    at: '2026-11-06T14:10:00Z',
    note: 'The answer, without the numbers.',
    files: ['answer.md'],
    revised: 0,
    accepted: false,
    ...changes,
  };
}

function deliverable(id: string, changes: Partial<Deliverable> = {}): Deliverable {
  return {
    id,
    text: 'A one-page answer that I can read in five minutes.',
    state: 'none',
    decided_at: null,
    thread: null,
    offers: [],
    ...changes,
  };
}

const OFFERED = deliverable('d-1', {
  state: 'offered',
  thread: 't-4',
  offers: [offer('p-5', 'agent-1', { revised: 12 })],
});
const ACCEPTED = deliverable('d-2', {
  text: 'A script that runs the best strategy again on paper.',
  state: 'accepted',
  decided_at: '2026-11-06T14:20:00Z',
  thread: 't-5',
  offers: [
    offer('p-7', 'agent-2', {
      files: ['pairs/run_pairs.py', 'pairs/README.md'],
      note: 'Runs with one command.',
      accepted: true,
    }),
  ],
});
const NONE = deliverable('d-3', { text: 'A list of what was ruled out, with the numbers.' });
const LIST = [OFFERED, ACCEPTED, NONE];

function panel(list: readonly Deliverable[]): string {
  return renderToStaticMarkup(
    <Deliverables
      api={{} as Api}
      list={list}
      agents={AGENTS}
      now={NOW}
      reload={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe('the deliverables in words', () => {
  it('counts them by state, and counts the ones with changes asked only when there are some', () => {
    assert.deepEqual(deliverCounts(LIST), [
      { count: 1, label: 'accepted' },
      { count: 1, label: 'offered' },
      { count: 1, label: 'with no file yet' },
    ]);
    const asked = deliverable('d-4', { state: 'changes_asked' });
    assert.deepEqual(
      deliverCounts([asked, asked, NONE]).map((item) => `${item.count} ${item.label}`),
      ['0 accepted', '0 offered', '2 with changes asked', '1 with no file yet'],
    );
    assert.deepEqual(
      deliverCounts([]).map((item) => item.count),
      [0, 0, 0],
    );
  });

  it('gives the close banner plain counts, and nothing when the person stated none', () => {
    assert.equal(
      deliverLine(LIST),
      'Your deliverables: 1 accepted, 1 offered, 1 with no file yet.',
    );
    assert.equal(deliverLine([]), null);
  });

  it('says one state for each deliverable, with the time of the person’s decision', () => {
    const at = '2026-11-06T14:20:00Z';
    assert.equal(stateLine(NONE, NOW), 'No file yet');
    assert.equal(stateLine(OFFERED, NOW), 'Offered, not accepted yet');
    assert.equal(stateLine(ACCEPTED, NOW), `Accepted by you at ${clock(at)}`);
    assert.equal(
      stateLine(deliverable('d-4', { state: 'changes_asked', decided_at: at }), NOW),
      `You asked for changes at ${clock(at)}`,
    );
  });

  it('says who offered a file, and when it was written or last revised', () => {
    const at = clock('2026-11-06T14:10:00Z');
    assert.equal(
      offerLine(offer('p-5', 'agent-2'), AGENTS, NOW),
      `Offered by Agent 2. Written at ${at}.`,
    );
    assert.equal(
      offerLine(offer('p-5', 'agent-1', { revised: 1 }), AGENTS, NOW),
      `Offered by Maren. Revised once, last at ${at}.`,
    );
    assert.equal(
      offerLine(offer('p-5', 'agent-1', { revised: 12 }), AGENTS, NOW),
      `Offered by Maren. Revised 12 times, last at ${at}.`,
    );
  });

  it('takes a sentence that has words and is not the one that stands', () => {
    assert.equal(isNewSentence(' A script. '), true);
    assert.equal(isNewSentence('  '), false);
    assert.equal(isNewSentence(' A script. ', 'A script.'), false);
    assert.equal(isNewSentence('A longer script.', 'A script.'), true);
  });

  it('reads the setup’s field as one sentence on each line that has text', () => {
    assert.deepEqual(sentences(' A one-page answer. \n\n  \nA script.\n'), [
      'A one-page answer.',
      'A script.',
    ]);
    assert.deepEqual(sentences(''), []);
    assert.deepEqual(startRequest('Q?', [], true, null, 'A script.\n').deliverables, ['A script.']);
    assert.equal('deliverables' in startRequest('Q?', [], true, null), false);
    assert.equal('deliverables' in startRequest('Q?', [], true, null, ' \n'), false);
  });

  it('says what an offer does in its thread', () => {
    const post = { ...result('p-5'), kind: 'offer', deliverable: 'd-1' } as Post;
    const context = { called: (id: string) => id, author: null };
    assert.equal(act(post, null, context), 'offered files for your deliverable d-1');
    assert.equal(tone(post), 'answer');
  });
});

describe('the API client for deliverables', () => {
  it('states, changes, and removes a deliverable, and sends each decision with its offer', async () => {
    const calls: [string, string | undefined, unknown][] = [];
    const api = createApi('secret', (input, init) => {
      calls.push([input, init.method, init.body]);
      return Promise.resolve(new Response('{"agents": []}', { status: 200 }));
    });

    const lab = await api.addDeliverable('A script.');
    await api.changeDeliverable('d-1', 'A short script.');
    await api.removeDeliverable('d-1');
    await api.decideDeliverable('d-2', 'accept', 'p-5');
    await api.decideDeliverable('d-2', 'ask_changes', 'p-5', 'Add the numbers.');
    await api.decideDeliverable('d-2', 'take_back', 'p-5');
    // A server from before deliverables sends none, and the page must still load.
    const old = await api.lab();

    assert.deepEqual(calls.slice(0, 6), [
      ['/api/deliverables', 'POST', '{"text":"A script."}'],
      ['/api/deliverables/d-1', 'POST', '{"text":"A short script."}'],
      ['/api/deliverables/d-1', 'DELETE', undefined],
      ['/api/deliverables/d-2/decision', 'POST', '{"decision":"accept","offer":"p-5"}'],
      [
        '/api/deliverables/d-2/decision',
        'POST',
        '{"decision":"ask_changes","offer":"p-5","text":"Add the numbers."}',
      ],
      ['/api/deliverables/d-2/decision', 'POST', '{"decision":"take_back","offer":"p-5"}'],
    ]);
    assert.deepEqual(lab.agents, []);
    assert.deepEqual(old.deliverables, []);
  });
});

describe('the deliverables panel', () => {
  it('shows each deliverable with its sentence, one state, and the files that agents offered', () => {
    const html = panel(LIST);
    assert.ok(html.startsWith('<aside class="k-panel d-panel" aria-label="Deliverables">'));
    assert.ok(
      html.includes('What you want at the end of the lab. Every agent can read this list.'),
    );
    assert.ok(
      html.includes(
        '<li class="d-offered"><p class="d-text">A one-page answer that I can read in five minutes.</p>' +
          '<p class="d-state"><i></i>Offered, not accepted yet</p>',
      ),
    );
    // A file opens as a page, at the version that the offer's post pins.
    assert.ok(
      html.includes(
        `<span><code>answer.md</code><small>Offered by Maren. Revised 12 times, last at ${clock('2026-11-06T14:10:00Z')}.</small></span>` +
          '<a href="#/file/p-5/answer.md" aria-label="Read answer.md">Read</a>',
      ),
    );
    assert.ok(
      html.includes(
        '<a href="#/file/p-7/pairs%2Frun_pairs.py" aria-label="Read pairs/run_pairs.py">',
      ),
    );
    assert.ok(html.includes('<p class="d-note">The answer, without the numbers.</p>'));
    assert.ok(html.includes('<a href="#/thread/t-4">Open the thread with every offer</a>'));
    assert.ok(html.includes(`<i></i>Accepted by you at ${clock('2026-11-06T14:20:00Z')}</p>`));
    assert.ok(html.includes('<li class="d-none">'));
    assert.ok(
      html.includes(
        '<i></i>No file yet</p><p class="k-buttons"><button type="button">Edit</button></p>',
      ),
    );
    assert.ok(html.includes('<button type="button" class="d-add">Add a deliverable</button>'));
  });

  it('gives the person the buttons that fit the state, and no button that marks a deliverable as met', () => {
    const html = panel(LIST);
    const buttons = (item: string): string[] => {
      const part = html.slice(html.indexOf(`<li class="d-${item}">`));
      const row = /<p class="k-buttons">(.*?)<\/p>/.exec(part)?.[1] ?? '';
      return [...row.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1] ?? '');
    };
    assert.deepEqual(buttons('offered'), ['Accept', 'Ask for changes', 'Edit']);
    assert.deepEqual(buttons('accepted'), ['Take the acceptance back', 'Edit']);
    assert.deepEqual(buttons('none'), ['Edit']);
    assert.ok(html.includes('<button type="button" class="go">Accept</button>'));
  });

  it('gives each offer its own buttons when several agents offered files', () => {
    const several = deliverable('d-1', {
      state: 'accepted',
      decided_at: '2026-11-06T14:20:00Z',
      thread: 't-4',
      offers: [
        offer('p-5', 'agent-1', { accepted: true }),
        offer('p-6', 'agent-2', { note: 'Shorter.' }),
      ],
    });
    const html = panel([several]);
    assert.ok(html.includes('<div class="d-offer took">'));
    assert.ok(
      html.includes(
        '<p class="k-buttons"><button type="button">Take the acceptance back</button></p></div>',
      ),
    );
    assert.ok(
      html.includes(
        '<p class="d-note">Shorter.</p><p class="k-buttons"><button type="button">Accept this one instead</button>' +
          '<button type="button">Ask for changes</button><button type="button">Edit</button></p>',
      ),
    );
    const asked = panel([
      { ...several, state: 'changes_asked', offers: [offer('p-5', 'agent-1')] },
    ]);
    assert.ok(asked.includes(`<li class="d-changes_asked">`));
    assert.ok(asked.includes(`You asked for changes at ${clock('2026-11-06T14:20:00Z')}`));
    assert.ok(asked.includes('<button type="button" class="go">Accept</button>'));
  });

  it('shows an agent’s words as text, and says what a deliverable is when the person stated none', () => {
    const html = panel([
      deliverable('d-1', {
        text: '<img src=x>',
        state: 'offered',
        offers: [offer('p-5', 'agent-1', { note: '<script>alert(1)</script>', files: ['<b>.md'] })],
      }),
    ]);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<script'), false);
    assert.ok(html.includes('<code>&lt;b&gt;.md</code>'));

    const empty = panel([]);
    assert.ok(empty.includes('<li class="d-empty">You stated no deliverable.'));
    assert.ok(empty.includes('Add a deliverable'));
    const full = panel(Array.from({ length: 20 }, (_, index) => deliverable(`d-${index + 1}`)));
    assert.ok(
      full.includes(
        '<button type="button" class="d-add" disabled="">A lab has 20 deliverables at most</button>',
      ),
    );
  });
});

describe('the deliverables on the lab page', () => {
  const threads = [summary({ thread: { id: 't-1', title: 'The question', opened_by: 'person' } })];
  const page = (changes: Parameters<typeof labView>[0], start?: 'deliver' | 'talk'): string => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const data = {
      setup: null,
      lab: labView({ agents: [agentView('agent-1', { coordinator: true }), TESSEL], ...changes }),
      threads,
      needs: [],
      report: null,
      answer: null,
      conversation: null,
      version: 1,
      error: null,
      reload: () => undefined,
    };
    return renderToStaticMarkup(
      <LabPage api={{} as Api} data={data} now={NOW} open={null} post={null} panel={start} />,
    );
  };

  it('has one line under the answer with the counts, which opens the panel', () => {
    const html = page({ deliverables: LIST });
    assert.ok(
      html.includes(
        '<button type="button" class="d-door" aria-expanded="false"><span class="f-label">Deliverables</span>' +
          '<span class="d-sum"><span><b>1</b> accepted</span><span><b>1</b> offered</span>' +
          '<span><b>1</b> with no file yet</span></span><u>Open</u></button>',
      ),
    );
    assert.ok(html.indexOf('The answer so far') < html.indexOf('d-door'));
    assert.equal(html.includes('k-panel'), false);
    // A lab without deliverables still has the line, so the person can state one while the lab runs.
    const none = page({});
    assert.ok(none.includes('<span class="d-sum">You stated none</span><u>Add</u></button>'));
  });

  it('docks one panel at a time: the deliverables or the conversation with the coordinator', () => {
    const deliver = page({ deliverables: LIST }, 'deliver');
    assert.ok(deliver.includes('class="d-door on" aria-expanded="true"'));
    assert.ok(deliver.includes('<u>Close</u>'));
    assert.equal(deliver.split('class="k-panel').length, 2);
    assert.ok(deliver.includes('<aside class="k-panel d-panel"'));
    assert.ok(deliver.includes('aria-expanded="false">Talk to Agent 1</button>'));

    const talk = page({ deliverables: LIST }, 'talk');
    assert.equal(talk.split('class="k-panel').length, 2);
    assert.equal(talk.includes('d-panel'), false);
    assert.ok(talk.includes('class="d-door" aria-expanded="false"'));
    assert.ok(talk.includes('Close the conversation'));
  });

  it('adds the counts to the banner of a lab that the agents closed, as a fact and not a gate', () => {
    const close = { id: 'p-9', thread: 't-1', author: 'agent-1' };
    const closed = { state: 'closed' as const, close, close_agreed: 1, close_among: 2 };
    const html = page({ ...closed, deliverables: LIST });
    assert.ok(
      html.includes(
        'The agents say that the lab is done (2 of 2 agents). You can still steer it.' +
          '<span>Your deliverables: 1 accepted, 1 offered, 1 with no file yet.</span></a>',
      ),
    );
    assert.ok(page(closed).includes('You can still steer it.</a>'));
  });
});

describe('the deliverables on the setup screen', () => {
  it('has a field for one sentence on each line', () => {
    const setup = {
      folder: '~/code/sort-bench',
      harnesses: HARNESSES,
      question: null,
      defaults: DEFAULTS,
      defaults_from: null,
    };
    const html = renderToStaticMarkup(
      <SetupPage
        api={{} as Api}
        setup={setup}
        onStarted={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    assert.ok(
      html.includes('<h2 id="setup-deliverables">What do you want to hold at the end?</h2>'),
    );
    assert.ok(
      html.includes(
        '<textarea class="d-setup" aria-labelledby="setup-deliverables" rows="3"></textarea>',
      ),
    );
    assert.ok(html.indexOf('setup-deliverables') < html.indexOf('<h2>Agents</h2>'));
  });

  it('shows the line that opens the panel as one control', () => {
    const html = renderToStaticMarkup(
      <DeliverDoor list={[NONE]} open={false} onToggle={() => undefined} />,
    );
    assert.ok(html.startsWith('<button type="button" class="d-door" aria-expanded="false">'));
    assert.ok(html.includes('<b>1</b> with no file yet'));
  });
});
