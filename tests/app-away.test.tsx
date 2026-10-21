import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Away,
  Call,
  Direction,
  Lab,
  SearchHit,
  SearchResult,
  Snapshot,
} from '../src/protocol/api.ts';
import { appActions } from '../src/app/actions.ts';
import {
  events,
  freshMemory,
  notesFor,
  notifyLine,
  notifyState,
} from '../src/app/notify.ts';
import {
  hitAction,
  isSearchKey,
  isSearchResult,
  nextHit,
  searchKeyLabel,
  searchPath,
} from '../src/app/search.ts';
import { AwayDigest } from '../src/app/components/AwayDigest.tsx';
import { LabHome, type LabActions } from '../src/app/screens/LabHome.tsx';
import { Hit } from '../src/app/screens/SearchDialog.tsx';
import { ToolsContext, type AppTools } from '../src/app/tools.ts';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

function direction(
  id: string,
  title: string,
  fields: Partial<Direction> = {},
): Direction {
  return {
    id,
    title,
    bar: null,
    runs: 3,
    noise: null,
    buildsOn: [],
    state: 'open',
    verdict: 'open',
    disputed: false,
    evidence: null,
    agent: 'a-1',
    openedBy: 'a-0',
    openedAt: ago(600),
    stoppedAt: null,
    head: 'a3f9c2e',
    ...fields,
  };
}

function call(id: string, question: string): Call {
  return {
    id,
    at: ago(12),
    kind: 'cost',
    question,
    why: 'Seeds 2 and 3 need a GPU.',
    askers: [
      { agent: 'a-1', handle: 'claude-2', direction: 'd-1', why: 'Seeds.' },
    ],
    byVerifold: false,
    options: [{ label: 'Use this Mac', usd: 0, minutes: 60, effect: null }],
    pick: 0,
    state: 'open',
    answer: null,
    words: null,
    undoUntil: null,
    note: null,
    post: null,
  };
}

/** The news of the "Back after a night" artboard. */
const away: Away = {
  since: ago(9 * 60),
  spentThen: { plansUsd: 1.2, gpuUsd: 0 },
  news: {
    lines: [
      {
        direction: 'd-1',
        title: 'The CoT names what drives the answer',
        mark: 'holds-up',
        said: 'Holds up (cue named 64% vs 41%). 2 new posts.',
      },
      {
        direction: 'd-3',
        title: 'The answer follows the CoT',
        mark: 'ruled-out',
        said: 'Ruled out (planted errors barely move the answer).',
      },
    ],
    moreLines: 2,
    counts: '7 posts, 2 runs ended (1 failed: r-2)',
    cost: 'Spent since then: ≈$9.40 (Claude Code ≈$6.60, GPU $2.80).',
  },
};

function lab(fields: Partial<Lab> = {}): Lab {
  return {
    question: 'Can cheap training make a CoT faithful?',
    postLimit: 4000,
    startedAt: ago(1200),
    agentsHere: true,
    paused: null,
    budget: null,
    money: { plansUsd: 7.8, gpuUsd: 13.4, gpuLimitUsd: 25 },
    needsYou: [call('c-4', 'Rent an H100 for the probe reruns?')],
    answered: [],
    directions: [
      direction('d-1', 'The CoT names what drives the answer', {
        verdict: 'holds-up',
      }),
      direction('d-3', 'The answer follows the CoT', {
        verdict: 'ruled-out',
      }),
    ],
    agents: [],
    plan: null,
    board: { posts: [], more: false },
    disputes: [],
    runs: [],
    checks: [],
    signoff: null,
    works: [],
    away: null,
    omitted: {},
    ...fields,
  };
}

function snapshot(fields: Partial<Lab> = {}): Snapshot {
  return {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 3,
    at: ago(0),
    project: 'CoT faithfulness',
    lab: lab(fields),
    trimmed: false,
  };
}

const actions: LabActions = {
  post: () => Promise.resolve({ ok: true }),
  pause: () => Promise.resolve({ ok: true }),
  answer: () => Promise.resolve({ ok: true }),
  words: () => Promise.resolve({ ok: true }),
  undo: () => Promise.resolve({ ok: true }),
};

const tools: AppTools = {
  openSearch: () => {},
  dismissAway: () => Promise.resolve({ ok: true }),
  notify: { state: 'off', toggle: () => {} },
};

function home(shown: Snapshot, provided: AppTools | null): string {
  const page = shown.lab ? (
    <LabHome
      snapshot={shown}
      lab={shown.lab}
      connection="live"
      now={now}
      actions={actions}
    />
  ) : null;
  return renderToStaticMarkup(
    provided ? (
      <ToolsContext.Provider value={provided}>{page}</ToolsContext.Provider>
    ) : (
      page
    ),
  );
}

await test('the away digest says what changed in the words of the desk, links each direction, and offers Dismiss only when the page can dismiss it', () => {
  const html = renderToStaticMarkup(
    <AwayDigest away={away} now={now} onDismiss={tools.dismissAway} />,
  );
  assert.match(
    html,
    /<h2 id="away-title" class="away__title">While you were away<\/h2>/,
  );
  assert.match(html, /, 9 h ago\.<\/p>/);
  assert.match(
    html,
    /<li class="away__line away__line--holds-up"><span class="away__mark"><svg[^]*?<\/svg><\/span><span class="away__text"><a class="away__direction" href="#\/d\/d-1">The CoT names what drives the answer<\/a><span class="away__said">Holds up \(cue named 64% vs 41%\)\. 2 new posts\.<\/span>/,
  );
  assert.match(html, /href="#\/d\/d-3"/);
  assert.match(html, /2 more directions changed too\. Their rows are below\./);
  assert.match(html, /7 posts, 2 runs ended \(1 failed: r-2\)\./);
  assert.match(html, /Spent since then: ≈\$9\.40/);
  assert.match(html, />Dismiss<\/button>/);
  // Without a way to dismiss, as in a desk view of one session, no button shows.
  assert.doesNotMatch(
    renderToStaticMarkup(<AwayDigest away={away} now={now} onDismiss={null} />),
    /Dismiss/,
  );
});

await test('a quiet time away says so, and a server from before the news shows only the time away', () => {
  const quiet = (cost: string): string =>
    renderToStaticMarkup(
      <AwayDigest
        away={{
          ...away,
          news: { lines: [], moreLines: 0, counts: '', cost },
        }}
        now={now}
        onDismiss={null}
      />,
    );
  assert.match(
    quiet('Spent since then: ≈$0.40 (Claude Code ≈$0.40).'),
    /No post, run, or call came\./,
  );
  assert.match(quiet(''), /Nothing changed\./);
  // An older server sends only when the person left and the costs then.
  const older: Away = { since: away.since, spentThen: away.spentThen };
  const html = renderToStaticMarkup(
    <AwayDigest away={older} now={now} onDismiss={null} />,
  );
  assert.match(html, /While you were away/);
  assert.doesNotMatch(html, /away__lines|Nothing changed|No post/);
});

await test("the lab home puts the digest first, and shows search, Dismiss, and the notification line only with the app's tools", () => {
  const html = home(snapshot({ away }), tools);
  const digest = html.indexOf('While you were away');
  const needs = html.indexOf('Needs you');
  assert.ok(digest > 0 && needs > digest, 'The digest comes before Needs you.');
  assert.match(
    html,
    /<button type="button" class="button button--search" aria-keyshortcuts="Meta\+K Control\+K">/,
  );
  assert.match(html, />Dismiss<\/button>/);
  assert.match(
    html,
    /Get a desktop notification for each call and each settled direction/,
  );
  assert.match(html, />Turn on<\/button>/);
  // Rendered without the tools, as other tests do, the page shows none of their controls.
  const bare = home(snapshot({ away }), null);
  assert.match(bare, /While you were away/);
  assert.doesNotMatch(bare, /button--search|Dismiss|desktop notification/);
  // No time away: no digest.
  assert.doesNotMatch(home(snapshot(), tools), /While you were away/);
  // Notes on, blocked, or not in this browser.
  const on = home(snapshot(), {
    ...tools,
    notify: { state: 'on', toggle: () => {} },
  });
  assert.match(on, /Desktop notifications are on[^]*>Turn off<\/button>/);
  const blocked = home(snapshot(), {
    ...tools,
    notify: { state: 'blocked', toggle: () => {} },
  });
  assert.match(blocked, /The browser blocks notifications from this page/);
  assert.doesNotMatch(blocked, /Turn on|Turn off/);
  const none = home(snapshot(), {
    ...tools,
    notify: { state: 'unavailable', toggle: () => {} },
  });
  assert.doesNotMatch(none, /class="notify"/);
});

await test('notifications are off by default, ask nothing on load, and come once per event while the page is in the background', () => {
  assert.equal(notifyState(false, 'granted'), 'off');
  assert.equal(notifyState(true, 'granted'), 'on');
  assert.equal(notifyState(true, 'default'), 'off');
  assert.equal(notifyState(true, 'denied'), 'blocked');
  assert.equal(notifyState(false, 'unsupported'), 'unavailable');
  assert.equal(notifyLine('unavailable'), null);
  assert.equal(notifyLine('blocked')?.button, null);

  // The first lab that the page sees only primes the memory: old events never notify.
  const first = notesFor(freshMemory, snapshot().lab, 'Lab', true, true);
  assert.deepEqual(first.notes, []);
  assert.equal(first.memory.primed, true);
  // A new call while the page is in the background: one note that opens the call.
  const asked = lab({
    needsYou: [
      call('c-4', 'Rent an H100 for the probe reruns?'),
      call('c-5', 'Open a direction for Gemma?'),
    ],
  });
  const second = notesFor(first.memory, asked, 'Lab', true, true);
  assert.deepEqual(second.notes, [
    {
      key: 'call:c-5',
      title: 'Lab needs you',
      body: 'Open a direction for Gemma?',
      route: '#/call/c-5',
    },
  ]);
  // The same call again: no second note.
  assert.deepEqual(notesFor(second.memory, asked, 'Lab', true, true).notes, []);
  // A direction that settles while the person looks: no note, now or later.
  const settled = lab({
    directions: [
      ...lab().directions,
      direction('d-4', 'Gains survive a monitor', { verdict: 'holds-up' }),
    ],
  });
  const looking = notesFor(second.memory, settled, 'Lab', false, true);
  assert.deepEqual(looking.notes, []);
  assert.deepEqual(
    notesFor(looking.memory, settled, 'Lab', true, true).notes,
    [],
  );
  // With notes off, an event is seen but shows nothing.
  const off = notesFor(second.memory, settled, 'Lab', true, false);
  assert.deepEqual(off.notes, []);
  // A settled direction notifies once, when notes are on.
  const told = notesFor(second.memory, settled, 'Lab', true, true);
  assert.deepEqual(
    told.notes.map((note) => [note.key, note.body, note.route]),
    [
      [
        'settled:d-4:holds-up',
        '"Gains survive a monitor" holds up.',
        '#/d/d-4',
      ],
    ],
  );
  assert.deepEqual(
    events(lab(), 'Lab').map((note) => note.key),
    ['call:c-4', 'settled:d-1:holds-up', 'settled:d-3:ruled-out'],
  );
  // No lab: nothing changes.
  assert.equal(
    notesFor(first.memory, null, 'Lab', true, true).memory,
    first.memory,
  );
});

const hits: Record<string, SearchHit> = {
  onBoard: {
    type: 'post',
    id: 'p-9',
    at: ago(30),
    kind: 'claim',
    label: 'Claim',
    author: 'claude-2',
    direction: 'd-2',
    snippet: [
      { text: 'The gap is 34% smaller on ', mark: false },
      { text: 'seed', mark: true },
      { text: ' 1.', mark: false },
    ],
    whole: null,
    cut: false,
  },
  older: {
    type: 'post',
    id: 'p-2',
    at: ago(600),
    kind: 'objection',
    label: 'Objection',
    author: 'codex-2',
    direction: null,
    snippet: [{ text: '…the control CoTs were shorter.', mark: false }],
    whole: 'A long objection. The control CoTs were shorter.',
    cut: false,
  },
  cut: {
    type: 'post',
    id: 'p-1',
    at: ago(700),
    kind: 'plan',
    label: 'Plan of record',
    author: 'claude-1',
    direction: null,
    snippet: [{ text: 'How I read it', mark: false }],
    whole: null,
    cut: true,
  },
  short: {
    type: 'post',
    id: 'p-3',
    at: ago(500),
    kind: 'question',
    label: 'Message',
    author: 'You',
    direction: null,
    snippet: [{ text: 'Try Gemma.', mark: false }],
    whole: null,
    cut: false,
  },
  run: {
    type: 'run',
    id: 'r-3',
    at: ago(40),
    author: 'claude-2',
    direction: 'd-2',
    summary: 'exit 0 in 19 min',
    snippet: [
      { text: 'python probe_train.py --', mark: false },
      { text: 'seed', mark: true },
      { text: ' 1', mark: false },
    ],
  },
  call: {
    type: 'call',
    id: 'c-4',
    at: ago(12),
    label: 'Cost call',
    author: 'claude-2',
    state: 'waits for you',
    open: true,
    snippet: [{ text: 'Rent an H100 for the probe reruns?', mark: false }],
  },
};

await test('the search key, what each hit opens, and the arrow keys between the box and the hits', () => {
  const key = (
    fields: Partial<{
      key: string;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
    }>,
  ) =>
    isSearchKey({
      key: 'k',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...fields,
    });
  assert.equal(key({ metaKey: true }), true);
  assert.equal(key({ ctrlKey: true, key: 'K' }), true);
  assert.equal(key({}), false);
  assert.equal(key({ metaKey: true, altKey: true }), false);
  assert.equal(searchKeyLabel('MacIntel'), '⌘K');
  assert.equal(searchKeyLabel('Win32'), 'Ctrl+K');
  assert.equal(searchKeyLabel('Linux x86_64'), 'Ctrl+K');

  const board = new Set(['p-9']);
  assert.deepEqual(hitAction(hits.onBoard as SearchHit, board), {
    type: 'go',
    route: '#/',
    post: 'p-9',
  });
  assert.deepEqual(hitAction(hits.older as SearchHit, board), { type: 'read' });
  assert.deepEqual(hitAction(hits.run as SearchHit, board), {
    type: 'go',
    route: '#/d/d-2',
    post: null,
  });
  assert.deepEqual(hitAction(hits.call as SearchHit, board), {
    type: 'go',
    route: '#/call/c-4',
    post: null,
  });

  // -1 is the box: down goes to the first hit, up from the first goes back.
  assert.equal(nextHit(-1, 3, 'ArrowDown'), 0);
  assert.equal(nextHit(2, 3, 'ArrowDown'), 2);
  assert.equal(nextHit(0, 3, 'ArrowUp'), -1);
  assert.equal(nextHit(-1, 3, 'ArrowUp'), -1);
  assert.equal(nextHit(1, 3, 'Enter'), 1);

  assert.equal(searchPath('seed probe'), '/api/v1/search?q=seed%20probe');
  const result: SearchResult = {
    q: 'seed',
    note: '1 hit, the newest first.',
    total: 1,
    hits: [hits.run as SearchHit],
  };
  assert.equal(isSearchResult(result), true);
  assert.equal(isSearchResult({ hits: [] }), false);
});

await test('a hit is a link to its page, or opens the whole of an older post in place, and marks what matched', () => {
  const render = (hit: SearchHit, open = false): string =>
    renderToStaticMarkup(
      <Hit
        hit={hit}
        action={hitAction(hit, new Set(['p-9']))}
        open={open}
        onGo={() => {}}
        onRead={() => {}}
      />,
    );
  const onBoard = render(hits.onBoard as SearchHit);
  assert.match(onBoard, /<a class="hit__open" href="#\/" data-hit="">/);
  assert.match(onBoard, /<span class="chip chip--claim">Claim<\/span>/);
  assert.match(onBoard, /smaller on <mark>seed<\/mark> 1\./);

  const closed = render(hits.older as SearchHit);
  assert.match(
    closed,
    /<button type="button" class="hit__open" data-hit="" aria-expanded="false">/,
  );
  assert.match(closed, /Show the whole post/);
  assert.doesNotMatch(closed, /A long objection/);
  const opened = render(hits.older as SearchHit, true);
  assert.match(
    opened,
    /aria-expanded="true"[^]*Hide the whole post[^]*<p class="hit__whole">A long objection\./,
  );

  assert.match(
    render(hits.cut as SearchHit, true),
    /Its whole text is in \.verifold\/board\/p-1\.json\./,
  );
  // A short older post shows all of its text already, so it opens nothing.
  assert.match(
    render(hits.short as SearchHit),
    /<div class="hit__open hit__open--plain">/,
  );

  const run = render(hits.run as SearchHit);
  assert.match(run, /href="#\/d\/d-2"/);
  assert.match(
    run,
    /<code class="hit__text hit__text--code">python probe_train\.py --<mark>seed<\/mark> 1<\/code>/,
  );
  assert.match(run, /exit 0 in 19 min/);
  assert.match(
    render(hits.call as SearchHit),
    /href="#\/call\/c-4"[^]*waits for you/,
  );
});

await test("the app's own actions: the search, Dismiss, and the look, each with the desk's token", async (t) => {
  const sent: {
    url: string;
    method: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  globalThis.fetch = (input, init) => {
    sent.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(
      Response.json(
        init?.method === 'POST'
          ? { ok: true }
          : {
              q: 'a b',
              note: 'No post, run, or call has these words.',
              total: 0,
              hits: [],
            },
      ),
    );
  };
  const run = appActions('t0ken');
  assert.deepEqual(await run.dismissAway('k1'), { ok: true });
  assert.deepEqual(await run.look(), { ok: true });
  const found = await run.search('a b', new AbortController().signal);
  assert.ok('value' in found);
  assert.equal(found.value.total, 0);
  assert.deepEqual(
    sent.map((entry) => [entry.method, entry.url, entry.auth]),
    [
      ['POST', '/api/v1/actions/lab-away-dismiss', 'Bearer t0ken'],
      ['POST', '/api/v1/actions/lab-look', 'Bearer t0ken'],
      ['GET', '/api/v1/search?q=a%20b', 'Bearer t0ken'],
    ],
  );
  assert.deepEqual(sent[0]?.body, { key: 'k1' });
  // The look makes its own key each time.
  assert.match(
    String((sent[1]?.body as { key?: unknown }).key),
    /^[0-9a-f]{32}$/,
  );
  // Without a token, nothing goes out.
  const none = appActions(null);
  assert.ok('refused' in (await none.dismissAway('k2')));
  assert.ok('error' in (await none.search('a', new AbortController().signal)));
  assert.equal(sent.length, 3);
});
