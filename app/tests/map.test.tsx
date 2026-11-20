import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { NO_CANDIDATES, NO_MAP } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type { AgentView, BranchView, IdeaView, MapView, Post } from '../src/api/types.ts';
import {
  branchCounts,
  challengedBy,
  emptyMark,
  hasMap,
  parentIdea,
  splitBranches,
  triedBy,
} from '../src/model/map.ts';
import { href, parseRoute } from '../src/model/route.ts';
import { partsOf } from '../src/model/tasks.ts';
import { act } from '../src/model/turns.ts';
import { LabTabs } from '../src/ui/Dashboard.tsx';
import { LabPage } from '../src/ui/LabPage.tsx';
import { MapTab } from '../src/ui/Map.tsx';
import { DEFAULTS, FINDINGS, HARNESSES, agentView, labView, result, summary } from './fixtures.ts';

const now = new Date('2026-11-06T14:26:00Z');
const agents = [named('agent-1', 'Rowan'), named('agent-2', 'Ladderwright')];

function named(id: string, name: string): AgentView {
  const view = agentView(id);
  return { ...view, agent: { ...view.agent, name } };
}

const RATE: IdeaView = {
  id: 'p-12',
  thread: 't-3',
  author: 'agent-1',
  at: '2026-11-06T12:26:00Z',
  text: 'Buy “SOFR at 3.88% or lower” after the repo benchmark falls 4 basis points',
  parent: 'b-4',
  branch: 'b-4',
  state: 'ruled_out',
  test: 'Count the comparable days on which SOFR fell the 4 points it needs.',
  rules_out: 'Fewer than 6 of 20 days, or a central forecast above 3.88%.',
  tries: [
    {
      post: 'p-14',
      thread: 't-3',
      kind: 'result',
      author: 'agent-1',
      text: '7 of 20 days.',
      at: '2026-11-06T13:00:00Z',
    },
  ],
  challenges: [
    {
      post: 'p-15',
      thread: 't-3',
      result: 'p-14',
      author: 'agent-2',
      text: 'On a wider sample: 5 of 31 days, forecast 3.89%.',
      outcome: 'fails',
    },
  ],
  ruled_out_by: ['p-16'],
};

const UNDER: IdeaView = {
  id: 'p-20',
  thread: 't-3',
  author: 'agent-2',
  at: '2026-11-06T14:00:00Z',
  text: 'Only on the days after a Treasury auction',
  parent: 'p-12',
  branch: 'b-4',
  test: 'Count the auction days.',
  rules_out: 'Fewer than 3 of 8.',
};

function branch(id: string, title: string, changes: Partial<BranchView> = {}): BranchView {
  return { id, title, added_by: 'p-2', ...changes };
}

const MAP: MapView = {
  branches: [
    branch('b-1', 'Public releases the market misprices', {
      ideas: 6,
      being_tried: 2,
      ruled_out: 3,
    }),
    branch('b-2', 'Rewards for resting orders', { ideas: 4, results: 1, ruled_out: 2 }),
    branch('b-3', 'Prices that contradict each other', { ideas: 5, ruled_out: 4 }),
    branch('b-4', 'Overnight interest rates', {
      ideas: 2,
      untried: 1,
      results: 1,
      ruled_out: 1,
      idea_list: [RATE, UNDER],
    }),
    branch('b-5', 'Sports before the start', { ideas: 3, ruled_out: 3 }),
    branch('b-6', 'Events with a fixed calendar', { no_idea_hours: 6 }),
    branch('b-7', 'Weather', { retired: true, retired_by: 'p-30', ideas: 1, untried: 1 }),
  ],
  sealed: 0,
  left_out: 0,
};

/** Return the words that a page shows, without its markup. */
function words(html: string): readonly string[] {
  return html
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

describe('the map', () => {
  it('counts a branch in one line and marks a branch without an idea with how long it has had none', () => {
    const [releases, , , rates, , calendar] = MAP.branches;
    assert.ok(releases && rates && calendar);
    assert.equal(branchCounts(releases), '6 ideas · 2 being tried · 3 ruled out');
    assert.equal(branchCounts(rates), '2 ideas · 1 result · 1 ruled out');
    assert.equal(emptyMark(calendar), 'No idea yet · 6 h');
    assert.equal(emptyMark(branch('b-8', 'New', { no_idea_hours: 0.4 })), 'No idea yet · 24 min');
    assert.equal(emptyMark(releases), null);
  });

  it('keeps the branches in the reading’s order, the retired ones apart, and finds the idea that an idea hangs on', () => {
    const { inForce, retired } = splitBranches(MAP);
    assert.deepEqual(
      inForce.map((item) => item.id),
      ['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'b-6'],
    );
    assert.deepEqual(
      retired.map((item) => item.id),
      ['b-7'],
    );
    assert.equal(parentIdea(MAP, UNDER)?.id, 'p-12');
    assert.equal(parentIdea(MAP, RATE), null);
    assert.equal(hasMap(MAP), true);
    assert.equal(hasMap(NO_MAP), false);
    assert.equal(hasMap(undefined), false);
  });

  it('says who tried an idea and who challenged it, each with a mark', () => {
    const name = (id: string): string => (id === 'agent-1' ? 'Rowan' : 'Ladderwright');
    assert.deepEqual(triedBy(RATE, name), [
      {
        post: 'p-14',
        thread: 't-3',
        who: 'Rowan',
        text: '7 of 20 days.',
        mark: 'result',
        tone: '',
      },
    ]);
    assert.deepEqual(challengedBy(RATE, name), [
      {
        post: 'p-15',
        thread: 't-3',
        who: 'Ladderwright',
        text: 'On a wider sample: 5 of 31 days, forecast 3.89%.',
        mark: 'fails',
        tone: 'fs-count-bad',
      },
    ]);
  });

  it('shows the branches folded with their counts in about 120 words', () => {
    const html = renderToStaticMarkup(<MapTab map={MAP} agents={agents} now={now} />);
    const folded = html.replace(/<ol class="m-ideas">[\s\S]*?<\/ol>/g, '');

    assert.ok(words(folded).length <= 130, String(words(folded).length));
    assert.ok(html.includes('<b>Overnight interest rates</b>'));
    assert.ok(html.includes('<span class="m-cnt m-empty">No idea yet · 6 h</span>'));
    assert.ok(html.indexOf('Public releases') < html.indexOf('Events with a fixed calendar'));
    // A branch without an idea has nothing to open.
    assert.equal(html.split('<details>').length - 1, 1);
    assert.ok(html.includes('Retired branches · 1'));
    assert.ok(html.includes('<em class="f-st fs-con">retired</em>'));
  });

  it('shows an idea’s card with its test, what rules it out, who tried it and who challenged it, and its thread', () => {
    const html = renderToStaticMarkup(<MapTab map={MAP} agents={agents} now={now} />);

    assert.ok(html.includes('<dt>The test</dt><dd>Count the comparable days on which SOFR fell'));
    assert.ok(html.includes('<dt>Rules it out</dt><dd>Fewer than 6 of 20 days'));
    assert.ok(html.includes('<dt>Tried by</dt>'));
    assert.ok(html.includes('<b>Rowan</b>: 7 of 20 days.'));
    assert.ok(html.includes('<dt>Challenged by</dt>'));
    assert.ok(html.includes('<em class="f-st fs-count-bad">fails</em>'));
    assert.ok(html.includes('<em class="f-st fs-count-bad">ruled out</em>'));
    assert.ok(html.includes(`href="${href({ page: 'thread', id: 't-3', post: 'p-12' })}"`));
    // The idea that hangs on another idea says which, and one that nobody tried says so.
    assert.ok(html.includes('<dt>Under</dt>'));
    assert.ok(html.includes('Nobody yet.'));
    // The ideas of a branch stay in the order that they were posted.
    assert.ok(html.indexOf('id="idea-p-12"') < html.indexOf('id="idea-p-20"'));
  });

  it('shows text from agents as text, never as markup', () => {
    const hostile = { ...RATE, text: '<img src=x onerror=alert(1)>', test: '<script>1</script>' };
    const map = {
      ...MAP,
      branches: [branch('b-4', '<b>x</b>', { ideas: 1, idea_list: [hostile] })],
    };
    const html = renderToStaticMarkup(<MapTab map={map} agents={agents} now={now} />);
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  });

  it('says so when the lab’s reading has no branches', () => {
    const html = renderToStaticMarkup(<MapTab map={NO_MAP} agents={agents} now={now} />);
    assert.equal(html, '<p class="empty">The lab’s reading has no branches yet.</p>');
  });

  it('opens on its own route, and a thread shows an idea’s test and what rules it out', () => {
    assert.deepEqual(parseRoute('#/map'), { page: 'map' });
    assert.equal(href({ page: 'map' }), '#/map');
    const idea: Post = {
      ...result('p-12'),
      kind: 'idea',
      parent: 'b-4',
      test: 'Count the days.',
      rules_out: 'Fewer than 6.',
    };
    assert.deepEqual(partsOf(idea), [
      ['The test', 'Count the days.'],
      ['Rules it out', 'Fewer than 6.'],
    ]);
    assert.equal(act(idea, null, { called: () => 'Rowan', author: null }), 'posted an idea');
  });
});

describe('the lab page with a map', () => {
  const data = {
    setup: {
      folder: '~/code/kalshi',
      harnesses: HARNESSES,
      question: 'Maximize the value of my account.',
      defaults: DEFAULTS,
      defaults_from: null,
      findings_deliverable: FINDINGS,
    },
    lab: labView({ agents }),
    threads: [
      summary({ thread: { id: 't-1', title: 'The question', opened_by: 'person' } }),
      summary({ thread: { id: 't-3', title: 'Overnight rates', opened_by: 'agent-1' } }),
    ],
    needs: [],
    report: null,
    candidates: NO_CANDIDATES,
    version: 1,
    error: null,
    reload: () => undefined,
  };

  it('has no tabs while the lab has no part of a dashboard and no branches, as before both', () => {
    const html = renderToStaticMarkup(
      <LabPage api={{} as Api} data={data} now={now} open={null} post={null} />,
    );
    assert.ok(!html.includes('aria-label="The lab"'));
    assert.ok(html.includes('id="card-t-3"'));
  });

  it('offers the Wall and the Map, and the Map tab shows the branches in place of the cards', () => {
    const wall = renderToStaticMarkup(
      <LabPage api={{} as Api} data={{ ...data, map: MAP }} now={now} open={null} post={null} />,
    );
    assert.ok(
      wall.includes(
        '<nav class="d-tabs" aria-label="The lab"><a href="#/" class="on" aria-current="page">Wall</a><a href="#/map">Map</a></nav>',
      ),
    );
    assert.ok(wall.includes('id="card-t-3"'));

    const map = renderToStaticMarkup(
      <LabPage
        api={{} as Api}
        data={{ ...data, map: MAP }}
        now={now}
        open={null}
        post={null}
        tab="map"
      />,
    );
    assert.ok(
      map.includes('<a href="#/">Wall</a><a href="#/map" class="on" aria-current="page">Map</a>'),
    );
    assert.ok(map.includes('Overnight interest rates'));
    assert.ok(!map.includes('id="card-t-3"'));
    assert.ok(!map.includes('How the lab reads your question'));
  });

  it('puts the tabs in one bar in a fixed order, each under its own condition', () => {
    const all = renderToStaticMarkup(<LabTabs tab="wall" dashboard map />);
    assert.ok(all.indexOf('>Wall<') < all.indexOf('>Dashboard<'));
    assert.ok(all.indexOf('>Dashboard<') < all.indexOf('>Map<'));
    assert.doesNotMatch(renderToStaticMarkup(<LabTabs tab="wall" map />), /Dashboard/);
    assert.equal(renderToStaticMarkup(<LabTabs tab="wall" />), '');
    // An open tab shows also when its slice has nothing yet, as on a link to it.
    assert.match(renderToStaticMarkup(<LabTabs tab="map" />), /Map/);
  });
});
