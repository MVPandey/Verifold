import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { createApi } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type {
  Deliverable,
  DeliverableOffer,
  LeaseLine,
  Post,
  RerunLine,
} from '../src/api/types.ts';
import {
  addHint,
  askHint,
  authorLeft,
  changeHint,
  deliverCounts,
  deliverLine,
  isDocked,
  isNewSentence,
  offerLine,
  offerState,
  offersReplyHint,
  removeQuestion,
  removedHeading,
  rerunFact,
  stateLine,
  threadFacts,
} from '../src/model/deliverables.ts';
import type { ThreadFact } from '../src/model/deliverables.ts';
import { clock, dayClock } from '../src/model/format.ts';
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
    state: 'waiting',
    decided_at: null,
    standing: 'open',
    disputed_by: null,
    conceded_to: null,
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
    disputed: [],
    open_asks: [],
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
      state: 'accepted',
      decided_at: '2026-11-06T14:20:00Z',
    }),
  ],
});
const NONE = deliverable('d-3', { text: 'A list of what was ruled out, with the numbers.' });
const LIST = [OFFERED, ACCEPTED, NONE];

const OPEN_LAB = { state: 'open', out_of_time: false, deliverables_told_at: null } as const;
const CLOSING_LAB = { ...OPEN_LAB, state: 'closing' } as const;
const CLOSED_LAB = { ...OPEN_LAB, state: 'closed' } as const;

function panel(list: readonly Deliverable[], agents = AGENTS): string {
  return renderToStaticMarkup(
    <Deliverables
      api={{} as Api}
      list={list}
      lab={OPEN_LAB}
      agents={agents}
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
    // Edit sits with the sentence that it edits.
    assert.ok(
      html.includes(
        '<li class="d-offered"><div class="d-head"><p class="d-text">A one-page answer that I can read in five minutes.</p>' +
          '<button type="button" class="linkbtn" aria-label="Edit this deliverable">Edit</button></div>' +
          '<p class="d-state"><i></i>Offered, not accepted yet</p>',
      ),
    );
    assert.ok(
      html.includes(
        `<small>Offered by Maren. Revised 12 times, last at ${clock('2026-11-06T14:10:00Z')}.</small>`,
      ),
    );
    assert.ok(html.includes('<p class="d-note">The answer, without the numbers.</p>'));
    assert.ok(html.includes('<a href="#/thread/t-4">Open the thread with every offer</a>'));
    assert.ok(html.includes(`<i></i>Accepted by you at ${clock('2026-11-06T14:20:00Z')}</p>`));
    assert.ok(html.includes('<li class="d-none">'));
    assert.ok(html.includes('<i></i>No file yet</p></li>'));
    assert.ok(html.includes('<button type="button" class="d-add">Add a deliverable</button>'));
  });

  it('shows the detail of an offer under its note, where the person decides about it', () => {
    const body = 'It has **no** numbers yet.\n\n- one table\n- one chart';
    const html = panel([{ ...OFFERED, offers: [offer('p-5', 'agent-1', { body })] }]);
    // The detail is behind the fold that a post in a thread has, between the note and what the person decided.
    // The fold parses it as Markdown when the person opens it, and it has the switch to the exact text.
    assert.ok(
      html.includes(
        '<p class="d-note">The answer, without the numbers.</p><details class="f-detail"><summary class="f-open"><span class="closed">Read the detail</span>',
      ),
    );
    assert.ok(
      html.includes(
        '<div class="f-words"><div class="words"><div class="body"><p>It has **no** numbers yet.</p><p>- one table\n- one chart</p></div><button type="button" class="linkbtn as-toggle">Show as written</button></div></div></details><p class="d-facts">',
      ),
    );
    // The files stay in their rows above the note. The fold lists none again.
    assert.equal(
      html.split('answer.md').length - 1,
      panel([OFFERED]).split('answer.md').length - 1,
    );
    // An offer without a detail has no fold.
    assert.equal(panel([OFFERED]).includes('f-detail'), false);
    assert.equal(
      panel([{ ...OFFERED, offers: [offer('p-5', 'agent-1', { body: '' })] }]).includes('f-detail'),
      false,
    );
  });

  it('opens a file as a page at the offered version, and names the link by the element that shows the path', () => {
    const html = panel([OFFERED]);
    const [, path, read, labelled] =
      /<code id="([^"]+)">answer\.md<\/code>.*?<a id="([^"]+)" href="#\/file\/p-5\/answer\.md" aria-labelledby="([^"]+)">Read<\/a>/.exec(
        html,
      ) ?? [];
    assert.ok(path && read);
    assert.equal(labelled, `${read} ${path}`);
    assert.ok(panel([ACCEPTED]).includes('href="#/file/p-7/pairs%2Frun_pairs.py"'));
  });

  it('shows what the person decided about each offer beside it, and names each button by the offer’s author', () => {
    const html = panel(LIST);
    const buttons = (item: string): string[] => {
      const part = html.slice(html.indexOf(`<li class="d-${item}">`));
      const row = /<p class="k-buttons">(.*?)<\/p>/.exec(part)?.[1] ?? '';
      return [...row.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/button>/g)].map(
        (match) => `${match[2] ?? ''} | ${match[1] ?? ''}`,
      );
    };
    assert.deepEqual(buttons('offered'), [
      'Accept | Accept the offer by Maren',
      'Ask for changes | Ask for changes to the offer by Maren',
    ]);
    assert.deepEqual(buttons('accepted'), [
      'Take the acceptance back | Take the acceptance back from the offer by Agent 2',
    ]);
    assert.ok(html.includes('<div class="d-offer d-o-waiting">'));
    assert.ok(html.includes('<span class="d-ostate">Waits for your decision</span>'));
    assert.ok(html.includes(`<div class="d-offer d-o-accepted">`));
    assert.ok(
      html.includes(
        `<span class="d-ostate">Accepted by you at ${clock('2026-11-06T14:20:00Z')}</span>`,
      ),
    );
    // No control marks a deliverable as met: the person decides about offers.
    assert.equal(/Mark|Done|Met/.test(html.replace(/Maren/g, '')), false);
  });

  it('keeps an acceptance beside a request for changes to another offer', () => {
    const at = '2026-11-06T14:25:00Z';
    const several = deliverable('d-1', {
      state: 'accepted',
      decided_at: '2026-11-06T14:20:00Z',
      thread: 't-4',
      offers: [
        offer('p-5', 'agent-1', { state: 'accepted', decided_at: '2026-11-06T14:20:00Z' }),
        offer('p-6', 'agent-2', { note: 'Shorter.', state: 'changes_asked', decided_at: at }),
      ],
    });
    const html = panel([several]);
    assert.ok(html.includes(`<i></i>Accepted by you at ${clock('2026-11-06T14:20:00Z')}</p>`));
    assert.ok(html.includes('<div class="d-offer d-o-changes_asked">'));
    assert.ok(html.includes(`<span class="d-ostate">You asked for changes at ${clock(at)}</span>`));
    assert.ok(
      html.includes(
        '<button type="button" aria-label="Accept this one instead, the offer by Agent 2">Accept this one instead</button>' +
          '<button type="button" aria-label="Ask for changes to the offer by Agent 2">Ask for changes</button>',
      ),
    );
    const asked = panel([
      { ...several, state: 'changes_asked', decided_at: at, offers: several.offers.slice(1) },
    ]);
    assert.ok(asked.includes(`<li class="d-changes_asked">`));
    assert.ok(asked.includes(`<i></i>You asked for changes at ${clock(at)}</p>`));
    assert.ok(
      asked.includes('class="go" aria-label="Accept the offer by Agent 2">Accept</button>'),
    );
  });

  it('says when the author of an offer left the lab, and offers no request for changes that nobody hears', () => {
    const gone = agentView('agent-2', {
      left: { at: '2026-11-06T14:15:00Z', by: 'agent-2', reason: '' },
    });
    const html = panel([{ ...OFFERED, offers: [offer('p-6', 'agent-2')] }], [MAREN, gone]);
    assert.ok(html.includes('<span>Its author left the lab</span>'));
    assert.ok(html.includes('>Accept</button></p>'));
    assert.equal(html.includes('Ask for changes'), false);
  });

  it('says beside an offer that a rerun of it is wanted or taken, and that a check holds', () => {
    const wanted = {
      post: 'p-5',
      thread: 't-4',
      asked_by: ['person'],
      asked_at: '2026-11-06T14:12:00Z',
      taken_by: [] as string[],
      held_by: [] as LeaseLine[],
      open_to: 'reviewer' as const,
    };
    const waits = offer('p-5', 'agent-1');
    const fact = (item: DeliverableOffer, lines: readonly RerunLine[]): string | null =>
      rerunFact(item, lines, AGENTS, NOW);
    assert.equal(fact(waits, []), null);
    assert.equal(fact(waits, [wanted]), 'A rerun is wanted');
    assert.equal(fact(waits, [{ ...wanted, taken_by: ['agent-2'] }]), 'An agent took its rerun');
    // The agent that took it holds it until its lease ends, and the panel says so until then.
    const until = '2026-11-06T14:40:00Z';
    const held = {
      ...wanted,
      taken_by: ['agent-2'],
      held_by: [{ agent: 'agent-2', since: NOW.toISOString(), until }],
    };
    assert.equal(fact(waits, [held]), `Its rerun is held by Agent 2 until ${dayClock(until, NOW)}`);
    assert.equal(
      rerunFact(waits, [held], AGENTS, new Date('2026-11-06T14:40:00Z')),
      'An agent took its rerun',
    );
    assert.equal(fact(waits, [{ ...wanted, post: 'p-9' }]), null);
    assert.equal(fact({ ...waits, standing: 'held_up' }, []), 'Held up by an independent rerun');
    assert.equal(fact({ ...waits, standing: 'checked' }, []), 'Checked by an agent');
    assert.equal(fact({ ...waits, standing: 'disputed' }, []), null);
    const html = renderToStaticMarkup(
      <Deliverables
        api={{} as Api}
        list={[OFFERED]}
        lab={{ ...OPEN_LAB, reruns_wanted: [wanted] }}
        agents={AGENTS}
        now={NOW}
        reload={() => undefined}
        onClose={() => undefined}
      />,
    );
    assert.ok(
      html.includes(
        '<span class="d-ostate">Waits for your decision</span><span>A rerun is wanted</span></p>',
      ),
    );
  });

  it('says when the author of an offer accepted an objection to it, and makes no primary action of accepting it', () => {
    const html = panel([
      {
        ...OFFERED,
        offers: [offer('p-5', 'agent-1', { standing: 'conceded', conceded_to: 'p-8' })],
      },
    ]);
    assert.ok(
      html.includes(
        '<span class="d-disputed">Its author accepted an objection to it <a href="#/thread/t-4/p-8">Read why</a></span>',
      ),
    );
    assert.ok(
      html.includes('<button type="button" aria-label="Accept the offer by Maren">Accept</button>'),
    );
    const disputed = panel([
      {
        ...OFFERED,
        offers: [offer('p-5', 'agent-1', { standing: 'disputed', disputed_by: 'p-8' })],
      },
    ]);
    assert.equal(disputed.includes('class="go"'), false);
  });

  it('shows under a deliverable the other work in its thread that is open, each with a link', () => {
    const wanted = {
      post: 'p-11',
      thread: 't-4',
      asked_by: ['agent-2'],
      asked_at: '2026-11-06T14:12:00Z',
      taken_by: [] as string[],
      held_by: [] as LeaseLine[],
      open_to: 'reviewer' as const,
    };
    const item = { ...OFFERED, disputed: ['p-9'], open_asks: ['p-10'] };
    const facts = (of: Deliverable, lines: readonly RerunLine[]): readonly ThreadFact[] =>
      threadFacts(of, lines, AGENTS, NOW);
    assert.deepEqual(
      facts(item, [wanted, { ...wanted, post: 'p-5' }, { ...wanted, thread: 't-9' }]),
      [
        { text: 'An agent disputes a post in the thread', post: 'p-9' },
        { text: 'A question in the thread has no answer', post: 'p-10' },
        { text: 'A rerun of a post in the thread is wanted', post: 'p-11' },
      ],
    );
    assert.deepEqual(facts(item, [{ ...wanted, taken_by: ['agent-2'] }]).at(-1), {
      text: 'An agent took the rerun of a post in the thread',
      post: 'p-11',
    });
    const until = '2026-11-06T14:40:00Z';
    const lease = { agent: 'agent-2', since: NOW.toISOString(), until };
    assert.deepEqual(facts(item, [{ ...wanted, taken_by: ['agent-2'], held_by: [lease] }]).at(-1), {
      text: `The rerun of a post in the thread is held by Agent 2 until ${dayClock(until, NOW)}`,
      post: 'p-11',
    });
    assert.deepEqual(facts(OFFERED, []), []);
    const html = panel([item]);
    assert.ok(
      html.includes(
        '<ul class="d-work"><li>An agent disputes a post in the thread <a href="#/thread/t-4/p-9">Read it</a></li>' +
          '<li>A question in the thread has no answer <a href="#/thread/t-4/p-10">Read it</a></li></ul>',
      ),
    );
  });

  it('lists the removed deliverables that have offers in one folded line, each with the link to its thread', () => {
    const removed = {
      id: 'd-4',
      text: 'A chart of the fees.',
      removed_at: '2026-11-06T14:22:00Z',
      thread: 't-7',
      active: false,
    };
    const html = renderToStaticMarkup(
      <Deliverables
        api={{} as Api}
        list={[NONE]}
        removed={[removed]}
        lab={OPEN_LAB}
        agents={AGENTS}
        now={NOW}
        reload={() => undefined}
        onClose={() => undefined}
      />,
    );
    assert.equal(removedHeading(1), '1 removed deliverable with offers');
    assert.equal(removedHeading(2), '2 removed deliverables with offers');
    assert.ok(
      html.includes('<li class="d-gone"><details><summary>1 removed deliverable with offers '),
    );
    assert.ok(html.includes('<p class="d-note">A chart of the fees.</p>'));
    assert.ok(
      html.includes(
        `Removed at ${clock('2026-11-06T14:22:00Z')}. <a href="#/thread/t-7">Open the thread with its offers</a>`,
      ),
    );
    assert.equal(panel([NONE]).includes('d-gone'), false);
  });

  it('says when an agent disputes an offer, with a link to the objection', () => {
    const html = panel([
      {
        ...OFFERED,
        offers: [offer('p-5', 'agent-1', { standing: 'disputed', disputed_by: 'p-8' })],
      },
    ]);
    assert.ok(
      html.includes(
        '<span class="d-disputed">Disputed by an agent <a href="#/thread/t-4/p-8">Read why</a></span>',
      ),
    );
    assert.equal(panel([OFFERED]).includes('d-disputed'), false);
  });

  it('shows an agent’s words as text and in no name of a control, and says what a deliverable is when the person stated none', () => {
    const html = panel([
      deliverable('d-1', {
        text: '<img src=x>',
        state: 'offered',
        offers: [
          offer('p-5', 'agent-1', { note: 'NOTE"><script>alert(1)</script>', files: ['<b>.md'] }),
        ],
      }),
    ]);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<script'), false);
    assert.ok(html.includes('>&lt;b&gt;.md</code>'));
    // The note and the path are in elements of their own, and in no `aria-label`.
    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1] ?? '');
    assert.equal(
      labels.some((label) => label.includes('NOTE') || label.includes('.md')),
      false,
    );

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

describe('what a change to the list does, in words', () => {
  const now = new Date('2026-11-06T14:30:00Z');

  it('says what a new deliverable and a request for changes do to a close, by the state of the lab', () => {
    assert.equal(addHint(OPEN_LAB), 'The agents get a post about it.');
    assert.equal(
      addHint(CLOSING_LAB),
      'An agent says that the lab is done. Adding this ends that close, and the lab goes on.',
    );
    assert.equal(
      addHint(CLOSED_LAB),
      'The agents closed the lab. Adding this opens the lab again.',
    );
    assert.equal(askHint(OPEN_LAB), 'The agent gets it as a reply to its offer.');
    assert.equal(
      askHint(CLOSING_LAB),
      'An agent says that the lab is done. Asking for changes ends that close, and the lab goes on.',
    );
    assert.equal(
      askHint(CLOSED_LAB),
      'The agents closed the lab. Asking for changes opens the lab again.',
    );
  });

  it('says when a new sentence or a removal sends no post', () => {
    assert.ok(changeHint(OPEN_LAB, now).startsWith('The agents get a post about the change.'));
    assert.ok(
      changeHint(CLOSING_LAB, now).startsWith(
        'An agent says that the lab is done, so this change sends no post, and that close stands.',
      ),
    );
    assert.ok(
      changeHint(CLOSED_LAB, now).startsWith(
        'The agents closed the lab, so this change sends no post, and the lab stays closed.',
      ),
    );
    const told = (at: string): string => changeHint({ ...OPEN_LAB, deliverables_told_at: at }, now);
    assert.ok(
      told('2026-11-06T14:29:01Z').startsWith(
        'The agents were told of a change in the last minute',
      ),
    );
    assert.ok(told('2026-11-06T14:29:00Z').startsWith('The agents get a post about the change.'));
  });

  it('says in a lab that is out of time that the agents get a post when the lab has time again', () => {
    const late = { ...OPEN_LAB, out_of_time: true };
    const later = ' The lab is out of time: the agents get the post when the lab has time again.';
    assert.ok(addHint(late).endsWith(later));
    assert.ok(askHint(late).endsWith(later));
    assert.ok(changeHint(late, now).endsWith(later));
    assert.ok(
      addHint({ ...CLOSED_LAB, out_of_time: true }).endsWith(`opens the lab again.${later}`),
    );
    // A change that sends no post says nothing about when a post comes.
    assert.equal(
      changeHint({ ...CLOSED_LAB, out_of_time: true }, now).includes('out of time'),
      false,
    );
  });

  it('names a standing acceptance before it removes a deliverable', () => {
    assert.equal(removeQuestion(NONE), 'Remove this deliverable? Its offers stay as posts.');
    assert.equal(
      removeQuestion(ACCEPTED),
      'Remove this deliverable? You accepted an offer for it. Its offers stay as posts.',
    );
  });

  it('says who gets the person’s post in the thread of a deliverable’s offers', () => {
    const some = offersReplyHint(['agent-1', 'agent-2'], AGENTS, 'open');
    assert.equal(
      some,
      'Your post goes to Maren, Agent 2: the agents that offered files here or watch this thread.',
    );
    assert.ok(offersReplyHint(['agent-1'], AGENTS, 'closed').endsWith(' The lab stays closed.'));
    assert.ok(offersReplyHint(['agent-1'], AGENTS, 'closing').endsWith(' The close stands.'));
    const none = offersReplyHint([], AGENTS, 'open');
    assert.equal(
      none,
      'No agent that offered files here or watches this thread is in the lab, so every agent that is not on call gets your post.',
    );
    assert.ok(offersReplyHint([], AGENTS, 'closed').endsWith(' It opens the lab again.'));
    assert.ok(
      offersReplyHint([], AGENTS, 'closing').endsWith(' It ends the close, and the lab goes on.'),
    );
  });

  it('says what the person decided about one offer', () => {
    const at = '2026-11-06T14:20:00Z';
    assert.equal(offerState(offer('p-5', 'agent-1'), now), 'Waits for your decision');
    assert.equal(
      offerState(offer('p-5', 'agent-1', { state: 'changes_asked', decided_at: at }), now),
      `You asked for changes at ${clock(at)}`,
    );
    assert.equal(
      offerState(offer('p-5', 'agent-1', { state: 'accepted', decided_at: at }), now),
      `Accepted by you at ${clock(at)}`,
    );
    assert.equal(authorLeft(offer('p-5', 'agent-1'), AGENTS), false);
  });

  it('makes room for one docked panel, also across a switch from one panel to the other', () => {
    assert.equal(isDocked(null, true), false);
    assert.equal(isDocked('deliver', false), true);
    assert.equal(isDocked('deliver', true), true);
    // The page asks once, with the panel that is docked. So talk → deliver → talk never drops the room.
    assert.deepEqual(
      (['talk', 'deliver', 'powers', 'deliver', null] as const).map((panel) =>
        isDocked(panel, true),
      ),
      [true, true, true, true, false],
    );
    // A tab of the panel for the coordinator shows only while an agent holds the seat.
    assert.equal(isDocked('talk', false), false);
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

  it('shows no card for the thread of a deliverable’s offers until the person opens it from the panel', () => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const offers = summary({
      thread: {
        id: 't-4',
        title: 'Deliverable d-1: A one-page answer.',
        opened_by: 'agent-1',
        deliverable: 'd-1',
      },
    });
    const work = summary({ thread: { id: 't-2', title: 'Sorted input', opened_by: 'agent-1' } });
    const render = (open: string | null): string =>
      renderToStaticMarkup(
        <LabPage
          api={{ thread: () => new Promise(() => undefined) } as unknown as Api}
          data={{
            setup: null,
            lab: labView({ agents: AGENTS, deliverables: [OFFERED] }),
            threads: [...threads, work, offers],
            needs: [],
            report: null,
            answer: null,
            conversation: null,
            version: 1,
            error: null,
            reload: () => undefined,
          }}
          now={NOW}
          open={open}
          post={null}
        />,
      );
    const surfaced = renderToStaticMarkup(
      <LabPage
        api={{} as Api}
        data={{
          setup: null,
          lab: labView({
            agents: AGENTS,
            removed_deliverables: [
              {
                id: 'd-1',
                text: 'A one-page answer.',
                removed_at: '2026-11-06T14:22:00Z',
                thread: 't-4',
                active: true,
              },
            ],
          }),
          threads: [...threads, work, offers],
          needs: [],
          report: null,
          answer: null,
          conversation: null,
          version: 1,
          error: null,
          reload: () => undefined,
        }}
        now={NOW}
        open={null}
        post={null}
      />,
    );
    // The thread of a removed deliverable is a normal card once a post came there after the removal.
    assert.ok(surfaced.includes('id="card-t-4"'));
    assert.ok(surfaced.slice(surfaced.indexOf('id="card-t-4"')).includes('No result yet'));
    const wall = render(null);
    assert.ok(wall.includes('id="card-t-2"'));
    assert.equal(wall.includes('id="card-t-4"'), false);
    const opened = render('t-4');
    assert.ok(opened.includes('<section id="card-t-4" class="f-card'));
    // The thread is no line of work, so its card counts no results.
    assert.equal(opened.slice(opened.indexOf('id="card-t-4"')).includes('No result yet'), false);
    assert.ok(opened.slice(opened.indexOf('id="card-t-2"')).includes('No result yet'));
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
