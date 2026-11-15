import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { createApi } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type { AgentView, AnswerView, BadgeLine, PostView, VoteLine } from '../src/api/types.ts';
import {
  canMarkPromising,
  givenBy,
  hasBreakthrough,
  orderVotes,
  proposalRows,
  proposalsHeading,
  proposedLine,
  secondedBy,
  standingBadges,
  votesLeftOut,
  votesLine,
  waitingProposal,
  yourVote,
} from '../src/model/votes.ts';
import { Wall } from '../src/ui/LabPage.tsx';
import { Turns } from '../src/ui/Thread.tsx';
import { VoteDetail, Why } from '../src/ui/Votes.tsx';
import type { MarkActions } from '../src/ui/Votes.tsx';
import { DEFAULTS, HARNESSES, agentView, labView, postView, result, summary } from './fixtures.ts';

const named = (id: string, name: string, changes: Partial<AgentView> = {}): AgentView =>
  agentView(id, { agent: { ...agentView(id).agent, name }, ...changes });
const agents = [
  named('agent-1', 'Maren', { coordinator: true }),
  named('agent-2', 'Tessel'),
  named('agent-3', 'Quill'),
  named('agent-4', 'Ostra'),
];
const vote = (by: string, direction: 'up' | 'down', reason: string, minute: number): VoteLine => ({
  by,
  direction,
  reason,
  at: `2026-11-06T14:${String(minute).padStart(2, '0')}:00Z`,
});
const given = (by: string, reason = 'Worth the other pairs.') => ({
  by,
  reason,
  at: '2026-11-06T14:20:00Z',
});
/** A result of Ostra with four votes, in the order that they were cast, and the person's Promising badge. */
const voted: PostView = {
  ...postView(
    result('p-5', {
      author: 'agent-4',
      text: 'With depth counted, a pair fills up to $60 a side.',
    }),
    5,
  ),
  up: 3,
  down: 1,
  votes: [
    vote('agent-3', 'down', 'One pair only. I want the other 114.', 1),
    vote('agent-2', 'up', 'It matches my depth numbers for the same pair.', 2),
    vote('agent-1', 'up', 'It answers the person’s question with a number.', 3),
    vote('person', 'up', 'This is the size question that I asked.', 4),
  ],
  badges: [{ badge: 'promising', given: [given('person', 'Go on here.')] }],
};
const breakthrough: BadgeLine = {
  badge: 'breakthrough',
  given: [given('agent-3', 'It turns one hedge into a strategy.')],
  second: given('agent-1', 'It does.'),
};
/** A result with a Confirmed badge and a Breakthrough badge that stands. */
const broke: PostView = {
  ...postView(result('p-6', { author: 'agent-2', text: '88 of the other 114 pairs fill.' }), 6),
  standing: 'checked',
  up: 2,
  down: 0,
  votes: [
    vote('agent-1', 'up', 'This turns one hedge into a strategy with a size.', 5),
    vote('agent-4', 'up', 'My model held on pairs that I never saw.', 6),
  ],
  badges: [
    { badge: 'confirmed', given: [{ ...given('agent-3', 'p-9 repeats it.'), proof: 'p-9' }] },
    breakthrough,
  ],
};
/** A result with a Breakthrough badge that Quill proposed and nobody seconded yet. */
const proposed: PostView = {
  ...postView(result('p-7', { author: 'agent-4', text: 'The floor holds at $40.' }), 7),
  badges: [{ badge: 'breakthrough', given: [given('agent-3', 'It gives the size.')], waits: true }],
};
const actions: MarkActions = {
  onVote: () => Promise.resolve(),
  onBadge: () => Promise.resolve(),
};
const now = new Date('2026-11-06T14:26:00Z');
const thread = (posts: readonly PostView[], marks?: MarkActions): string =>
  renderToStaticMarkup(
    <Turns
      view={{
        thread: { id: 't-2', title: 'Do deadline pairs hedge?', opened_by: 'agent-2' },
        watching: false,
        members: [],
        posts,
      }}
      agents={agents}
      needs={[]}
      question={null}
      reruns={[]}
      seats={0}
      now={now}
      marks={marks}
      onRerun={() => Promise.resolve()}
      onSend={() => Promise.resolve()}
    />,
  );

describe('the votes of a post', () => {
  it('list the person’s vote first, then the coordinator’s, then the others as they were cast', () => {
    const order = orderVotes(voted.votes ?? [], agents).map((one) => one.by);

    assert.deepEqual(order, ['person', 'agent-1', 'agent-3', 'agent-2']);
    // Without a coordinator, only the person's vote moves. No count and no direction changes the order.
    const plain = agents.map((view) => ({ ...view, coordinator: false }));
    assert.deepEqual(
      orderVotes(voted.votes ?? [], plain).map((one) => one.by),
      ['person', 'agent-3', 'agent-2', 'agent-1'],
    );
  });

  it('say how many there are and which way the person voted', () => {
    assert.equal(votesLine(voted), '4 votes, yours is up. Show who and why');
    assert.equal(votesLine(broke), '2 votes. Show who and why');
    assert.equal(
      votesLine({ ...voted, up: 0, down: 1, votes: [vote('person', 'down', 'No.', 1)] }),
      '1 vote, yours is down. Show who and why',
    );
    assert.equal(votesLine({ ...voted, up: 0, down: 0, votes: [] }), 'Show who gave the badges');
    assert.equal(yourVote(voted)?.reason, 'This is the size question that I asked.');
    assert.equal(yourVote(broke), null);
    // The server lists the newest votes of a post, and the counts hold every vote.
    assert.equal(votesLeftOut(voted), 0);
    assert.equal(votesLeftOut({ ...voted, up: 20, down: 3 }), 19);
  });

  it('show under the post as two counts, with the person’s own vote on its count', () => {
    const html = thread([voted], actions);

    assert.ok(
      html.includes(
        '<button type="button" class="v-count mine" aria-label="3 up, with your vote" title="Vote up">',
      ),
    );
    assert.ok(
      html.includes('<button type="button" class="v-count" aria-label="1 down" title="Vote down">'),
    );
    assert.ok(
      html.includes('aria-expanded="false">4 votes, yours is up. Show who and why</button>'),
    );
    // The list is closed until the person opens it, so no reason shows.
    assert.equal(html.includes('One pair only'), false);
    // The person gave Promising already, so the page offers no second one.
    assert.equal(html.includes('Mark as promising'), false);
    assert.ok(thread([broke], actions).includes('Mark as promising'));
  });

  it('show without a control when the page gives no moves, and not at all on a bare post', () => {
    const html = thread([voted]);

    assert.ok(
      html.includes('<span class="v-count mine" role="img" aria-label="3 up, with your vote">'),
    );
    assert.equal(html.includes('<button type="button" class="v-count'), false);
    const bare = postView(result('p-8', { author: 'agent-2' }), 8);
    assert.equal(thread([bare]).includes('v-box'), false);
    // With moves, a post of another author has its two counts from the start.
    assert.ok(thread([bare], actions).includes('aria-label="0 up" title="Vote up"'));
    // The person votes on no post of their own. Such a post shows the votes that it got.
    const own = postView(result('p-9', { author: 'person' }), 9);
    assert.equal(thread([own], actions).includes('v-box'), false);
    const liked = { ...own, up: 1, votes: [vote('agent-2', 'up', 'Clear.', 1)] };
    assert.ok(
      thread([liked], actions).includes('<span class="v-count" role="img" aria-label="1 up">'),
    );
  });

  it('open as a list with each vote, the Coordinator mark, and who gave each badge', () => {
    const html = renderToStaticMarkup(
      <VoteDetail item={voted} agents={agents} actions={actions} run={() => undefined} />,
    );

    const names = [...html.matchAll(/<b>([^<]+)<\/b>/g)].map((match) => match[1]);
    assert.deepEqual(names, ['You', 'Maren', 'Quill', 'Tessel']);
    assert.ok(
      html.includes('<li class="you"><i class="v-arrow up" role="img" aria-label="Up"></i>'),
    );
    assert.ok(
      html.includes(
        '<b>Maren</b><span class="i-seat coord">Coordinator</span><span>It answers the person’s question with a number.</span>',
      ),
    );
    assert.ok(
      html.includes('<i class="v-arrow down" role="img" aria-label="Down"></i><b>Quill</b>'),
    );
    assert.equal(html.match(/i-seat coord/g)?.length, 1);
    // The person takes back their own vote and their own badge.
    assert.equal(html.match(/Take it back/g)?.length, 2);
    assert.ok(html.includes('<span class="v-badge">Promising</span>'));
    assert.ok(html.includes('Given by you. <q>Go on here.</q>'));
  });

  it('say who proposed and who seconded a Breakthrough badge, and let the person remove a badge', () => {
    const html = renderToStaticMarkup(
      <VoteDetail item={broke} agents={agents} actions={actions} run={() => undefined} />,
    );

    assert.ok(html.includes('Given by Quill. <q>p-9 repeats it.</q> It names p-9.'));
    assert.ok(html.includes('<span class="v-badge rare">Breakthrough</span>'));
    assert.ok(html.includes('Proposed by Quill, seconded by Maren as coordinator.'));
    assert.equal(html.match(/Remove it/g)?.length, 2);
    assert.equal(html.includes('Take it back'), false);
    assert.equal(givenBy(given('person'), agents), 'Given by you.');
    assert.equal(
      secondedBy({ ...breakthrough, second: given('person') }, agents),
      'Proposed by Quill, seconded by you.',
    );
    // Without moves, the list has no control.
    const read = renderToStaticMarkup(
      <VoteDetail item={broke} agents={agents} run={() => undefined} />,
    );
    assert.equal(read.includes('<button'), false);
  });

  it('take a reason of one line for a vote and for Promising', () => {
    const form = (asking: 'up' | 'down' | 'promising'): string =>
      renderToStaticMarkup(
        <Why asking={asking} onSend={() => Promise.resolve()} onCancel={() => undefined} />,
      );

    const up = form('up');
    assert.ok(up.includes('<i class="v-arrow up"></i>'));
    assert.ok(up.includes('maxLength="140"'));
    assert.ok(up.includes('placeholder="Why, in one line"'));
    // A vote needs a reason, so the button is off until the person writes one.
    assert.ok(up.includes('<button type="submit" class="v-vote" disabled="">Vote up</button>'));
    assert.ok(form('down').includes('>Vote down</button>'));
    assert.ok(form('promising').includes('>Mark as promising</button>'));
  });

  it('reach the page as text', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(
      <VoteDetail
        item={{ ...voted, votes: [vote('agent-2', 'up', hostile, 1)], badges: [] }}
        agents={agents}
        run={() => undefined}
      />,
    );

    assert.equal(html.includes('<img'), false);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});

describe('a badge', () => {
  it('stands beside where the post stands, and a Breakthrough outlines the post', () => {
    const html = thread([voted, broke], actions);

    assert.ok(
      html.includes(
        '<span class="f-st fs-none">Not checked</span><span class="v-badge">Promising</span></p>',
      ),
    );
    assert.ok(
      html.includes(
        '<span class="f-st fs-ok">Checked</span><span class="v-badge">Confirmed</span><span class="v-badge rare">Breakthrough</span></p>',
      ),
    );
    assert.ok(html.includes('<li id="p-6" class="f-turn claim v-break d0">'));
    assert.ok(html.includes('<li id="p-5" class="f-turn claim d0">'));
    assert.deepEqual(
      standingBadges(broke).map((line) => line.badge),
      ['confirmed', 'breakthrough'],
    );
    assert.equal(hasBreakthrough(broke), true);
    assert.equal(hasBreakthrough(voted), false);
  });

  it('is none while a Breakthrough waits for its second, and the person seconds or declines it', () => {
    const html = thread([proposed], actions);

    assert.equal(hasBreakthrough(proposed), false);
    assert.equal(waitingProposal(proposed)?.given[0]?.by, 'agent-3');
    assert.equal(html.includes('v-break'), false);
    assert.equal(html.includes('v-badge rare'), false);
    assert.ok(
      html.includes(
        'Proposed as a breakthrough by Quill. Waits for the coordinator or you. <q>It gives the size.</q>',
      ),
    );
    assert.ok(html.includes('placeholder="A line for your second (optional)"'));
    assert.ok(html.includes('<button type="submit" class="v-vote">Second it</button>'));
    assert.ok(html.includes('>Not this one</button>'));
    // Without moves, the proposal shows and nothing can be pressed.
    const read = thread([proposed]);
    assert.ok(read.includes('Proposed as a breakthrough by Quill.'));
    assert.equal(read.includes('Second it'), false);
  });

  it('waits for the person alone when the coordinator proposed it, wrote the post, or is not there', () => {
    const line = waitingProposal(proposed);
    assert.ok(line);
    const by = (proposer: string): BadgeLine => ({ ...line, given: [given(proposer)] });

    assert.equal(
      proposedLine(proposed, by('agent-1'), agents),
      'Proposed as a breakthrough by Maren. Waits for you.',
    );
    const theirs = { ...proposed, post: { ...proposed.post, author: 'agent-1' } };
    assert.equal(
      proposedLine(theirs, line, agents),
      'Proposed as a breakthrough by Quill. Waits for you.',
    );
    const none = agents.map((view) => ({ ...view, coordinator: false }));
    assert.equal(
      proposedLine(proposed, line, none),
      'Proposed as a breakthrough by Quill. Waits for you.',
    );
  });

  it('is the person’s to give as Promising once, on a post of another author', () => {
    assert.equal(canMarkPromising(voted), false);
    assert.equal(canMarkPromising(broke), true);
    assert.equal(canMarkPromising(postView(result('p-9', { author: 'person' }), 9)), false);
    // Promising from an agent leaves the person's own to give.
    const fromAgent = {
      ...voted,
      badges: [{ badge: 'promising' as const, given: [given('agent-2')] }],
    };
    assert.equal(canMarkPromising(fromAgent), true);
  });
});

describe('the lab page with votes and badges', () => {
  const lab = labView({
    agents,
    proposals: [
      {
        post: 'p-7',
        thread: 't-2',
        by: 'agent-3',
        reason: 'It gives the size.',
        at: '2026-11-06T14:14:00Z',
      },
    ],
    breakthrough_threads: ['t-3'],
  });
  const threads = [
    summary({ thread: { id: 't-1', title: 'The question', opened_by: 'person' } }),
    summary({ thread: { id: 't-2', title: 'Deadline pairs', opened_by: 'agent-2' } }),
    summary({ thread: { id: 't-3', title: 'Fill model', opened_by: 'agent-4' } }),
  ];
  const data = {
    setup: {
      folder: '~/code/kalshi',
      harnesses: HARNESSES,
      question: lab.question,
      defaults: DEFAULTS,
      defaults_from: null,
    },
    lab,
    threads,
    needs: [],
    report: null,
    answer: null as AnswerView | null,
    version: 1,
    error: null,
    reload: () => undefined,
  };
  const wall = (changes: Partial<typeof data> = {}): string => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const none = { view: null, error: null };
    return renderToStaticMarkup(
      <Wall
        api={{} as Api}
        data={{ ...data, ...changes }}
        now={now}
        open={null}
        post={null}
        questionRead={none}
        cardRead={none}
      />,
    );
  };

  it('marks the card of a thread that has a Breakthrough badge, and shows nothing else about votes', () => {
    const html = wall();

    assert.equal(html.match(/<span class="v-badge rare">Breakthrough<\/span>/g)?.length, 1);
    const card = html.slice(html.indexOf('id="card-t-3"'));
    assert.ok(card.indexOf('v-badge rare') < card.indexOf('</header>'));
    assert.equal(html.includes('v-count'), false);
    assert.equal(/\bvotes?\b/i.test(html), false);
  });

  it('lists a Breakthrough badge that waits among what waits for the person, with a link to its post', () => {
    const html = wall();

    assert.ok(html.includes('<p class="o-waits-head">Proposed for a Breakthrough badge (1)</p>'));
    assert.ok(
      html.includes(
        '<a class="o-wait" href="#/thread/t-2/p-7"><span><b>Quill</b> proposes a Breakthrough badge</span>',
      ),
    );
    assert.ok(html.includes('>12 min</time><em>Decide</em>'));
    assert.equal(proposalsHeading(2), 'Proposed for a Breakthrough badge (2)');
    assert.deepEqual(
      proposalRows(lab, now).map((row) => [row.name, row.waited]),
      [['Quill', '12 min']],
    );
    // It is none of the waits that the top bar counts, and it gives no agent a status.
    assert.equal(lab.waits.length, 0);
    assert.equal(wall({ lab: { ...lab, proposals: [] } }).includes('o-waits'), false);
  });

  it('marks the answer when it builds on a post with a Breakthrough badge', () => {
    const answer = postView(
      {
        ...result('p-10', { thread: 't-1', author: 'agent-1' }),
        kind: 'proposal',
      },
      10,
    );
    const marked = wall({
      answer: {
        answer,
        to_earlier_question: false,
        builds_on: [broke],
        results: 1,
        no_blind_rerun: [],
      },
    });
    const plain = wall({
      answer: {
        answer,
        to_earlier_question: false,
        builds_on: [voted],
        results: 1,
        no_blind_rerun: [],
      },
    });

    const block = (html: string): string =>
      html.slice(html.indexOf('The answer so far'), html.indexOf('f-steer'));
    assert.ok(block(marked).includes('<span class="v-badge rare">Breakthrough</span>'));
    assert.equal(block(plain).includes('v-badge'), false);
  });
});

describe('the API client and votes', () => {
  it('sends a vote with its reason, and a change to a badge', async () => {
    const calls: { input: string; body: unknown }[] = [];
    const api = createApi('secret', (input, init) => {
      const sent = typeof init.body === 'string' ? init.body : '';
      calls.push({ input, body: JSON.parse(sent) as unknown });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    await api.vote('p-5', 'up', 'This is what I asked.');
    await api.vote('p-5', 'none', '');
    await api.badge({ post: 'p-5', badge: 'promising', action: 'give', reason: 'Go on here.' });
    await api.badge({ post: 'p-7', badge: 'breakthrough', action: 'second', reason: '' });
    await api.badge({ post: 'p-7', badge: 'breakthrough', action: 'take_back', giver: 'agent-3' });

    assert.deepEqual(calls, [
      {
        input: '/api/votes',
        body: { post: 'p-5', direction: 'up', reason: 'This is what I asked.' },
      },
      { input: '/api/votes', body: { post: 'p-5', direction: 'none', reason: '' } },
      {
        input: '/api/badges',
        body: { post: 'p-5', badge: 'promising', action: 'give', reason: 'Go on here.' },
      },
      {
        input: '/api/badges',
        body: { post: 'p-7', badge: 'breakthrough', action: 'second', reason: '' },
      },
      {
        input: '/api/badges',
        body: { post: 'p-7', badge: 'breakthrough', action: 'take_back', giver: 'agent-3' },
      },
    ]);
  });

  it('reads the lab of a server from before votes', async () => {
    const api = createApi('secret', () =>
      Promise.resolve(new Response('{"agents": []}', { status: 200 })),
    );

    const lab = await api.lab();

    assert.deepEqual([lab.proposals, lab.breakthrough_threads], [[], []]);
  });
});

describe('the color of a Breakthrough badge', () => {
  it('is used by the badge and the outline of its post, and by nothing else', () => {
    const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const rules = css.split('}').filter((rule) => rule.includes('var(--rare'));
    // The selector of a rule is the text before its last brace, also inside a block of keyframes.
    const selectors = rules.map((rule) => (rule.split('{').at(-2) ?? '').trim().split('\n').pop());

    assert.ok(selectors.length > 0);
    for (const selector of selectors) {
      assert.ok(
        selector === 'from' ||
          selector === '40%' ||
          selector === 'to' ||
          /v-(badge\.rare|break)/.test(selector ?? ''),
        selector,
      );
    }
    // With reduced motion, only the outline shows.
    assert.ok(
      css.includes(
        '@media (prefers-reduced-motion: reduce) {\n  .v-badge.rare::after {\n    display: none;',
      ),
    );
  });
});
