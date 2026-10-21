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
import type { ActOutcome } from '../src/app/api.ts';
import { Screen, lookMs, sendLooks } from '../src/app/App.tsx';
import { clock } from '../src/app/format.ts';
import {
  events,
  freshMemory,
  notesFor,
  notifyLine,
  notifyState,
} from '../src/app/notify.ts';
import { boardLink } from '../src/app/board.ts';
import { parseRoute } from '../src/app/route.ts';
import {
  callRead,
  hitAction,
  isMac,
  isSearchKey,
  isSearchResult,
  nextHit,
  searchKey,
  searchPath,
} from '../src/app/search.ts';
import { AwayDigest } from '../src/app/components/AwayDigest.tsx';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
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
  // The key that this computer uses: ⌘K on a Mac, Ctrl+K elsewhere.
  assert.match(
    html,
    /<button type="button" class="button button--search" aria-keyshortcuts="(Meta|Control)\+K">/,
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

await test('notifications follow the uncut notify lists: no burst when a trimmed lab grows back, and a call past the cap still tells', () => {
  const ids = Array.from({ length: 60 }, (_, index) => `c-${index + 1}`);
  const calls = (count: number): Call[] =>
    ids.slice(0, count).map((id) => call(id, `Question ${id}?`));
  const feed = { calls: ids, holdsUp: ['d-1'], ruledOut: ['d-3'] };
  // The page loads while the lab is large: the snapshot keeps 5 of 60 calls and no direction.
  const small = lab({
    needsYou: calls(5),
    directions: [],
    omitted: { needsYou: 55, directions: 2 },
    notify: feed,
  });
  const loaded = notesFor(freshMemory, small, 'Lab', true, true);
  assert.deepEqual(loaded.notes, []);
  // The level returns to full: 50 calls and both directions show again, and none of them is new.
  const full = lab({
    needsYou: calls(50),
    omitted: { needsYou: 10 },
    notify: feed,
  });
  const back = notesFor(loaded.memory, full, 'Lab', true, true);
  assert.deepEqual(back.notes, []);
  // A new call past the cap of 50 is in no list, but the feed has it: one note, in plain words, that opens the lab.
  const past = lab({
    needsYou: calls(50),
    omitted: { needsYou: 11 },
    notify: { ...feed, calls: [...ids, 'c-61'] },
  });
  assert.deepEqual(notesFor(back.memory, past, 'Lab', true, true).notes, [
    {
      key: 'call:c-61',
      title: 'Lab needs you',
      body: 'Call c-61 waits for your answer.',
      route: '#/',
    },
  ]);
  // A direction that settles while the snapshot leaves it out goes by its ID.
  const settled = lab({
    directions: [],
    omitted: { directions: 3 },
    notify: { ...feed, ruledOut: ['d-3', 'd-7'] },
  });
  assert.deepEqual(
    notesFor(back.memory, settled, 'Lab', true, true).notes.map((note) => [
      note.key,
      note.body,
      note.route,
    ]),
    [['settled:d-7:ruled-out', 'Direction d-7 is ruled out.', '#/d/d-7']],
  );
});

const hits = {
  onBoard: {
    type: 'post',
    id: 'p-48',
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
  },
  older: {
    type: 'post',
    id: 'p-40',
    at: ago(600),
    kind: 'objection',
    label: 'Objection',
    author: 'codex-2',
    direction: null,
    snippet: [{ text: '…the control CoTs were shorter.', mark: false }],
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
    state: 'open',
    summary: 'waits for you',
    question: 'Rent an H100 for the probe reruns?',
    answer: null,
    note: null,
    snippet: [{ text: 'Rent an H100 for the probe reruns?', mark: false }],
  },
  answered: {
    type: 'call',
    id: 'c-1',
    at: ago(900),
    label: 'Go call',
    author: 'Verifold',
    state: 'answered',
    summary: 'you chose "Continue"',
    question: 'Continue 4 more hours?',
    answer: { option: 'Continue', at: ago(880) },
    note: 'The budget is 12 hours now.',
    snippet: [{ text: 'Continue 4 more hours? (Continue)', mark: false }],
  },
} satisfies Record<string, SearchHit>;

await test('the search key: ⌘K on a Mac, Ctrl+K elsewhere and never in a text box, by the letter that the layout gives', () => {
  const key = (
    fields: Partial<{
      key: string;
      code: string;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    }>,
    mac: boolean,
    typing = false,
  ): boolean =>
    isSearchKey(
      {
        key: 'k',
        code: 'KeyK',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...fields,
      },
      mac,
      typing,
    );
  // On a Mac only ⌘K, also in a text box, since ⌘K edits no text.
  assert.equal(key({ metaKey: true }, true), true);
  assert.equal(key({ metaKey: true }, true, true), true);
  assert.equal(key({ ctrlKey: true }, true), false);
  assert.equal(key({ metaKey: true, ctrlKey: true }, true), false);
  // Elsewhere only Ctrl+K, and not in a text box, where it is the box's own key.
  assert.equal(key({ ctrlKey: true }, false), true);
  assert.equal(key({ ctrlKey: true, key: 'K' }, false), true);
  assert.equal(key({ ctrlKey: true }, false, true), false);
  assert.equal(key({ metaKey: true }, false), false);
  assert.equal(key({}, false), false);
  assert.equal(key({ metaKey: true, altKey: true }, true), false);
  assert.equal(key({ ctrlKey: true, shiftKey: true }, false), false);
  // Dvorak puts K elsewhere: the letter counts. Without Latin letters, the key's place does.
  assert.equal(key({ metaKey: true, key: 'k', code: 'KeyV' }, true), true);
  assert.equal(key({ metaKey: true, key: 't', code: 'KeyK' }, true), false);
  assert.equal(key({ ctrlKey: true, key: 'л', code: 'KeyK' }, false), true);
  assert.equal(isMac('MacIntel'), true);
  assert.equal(isMac('iPad'), true);
  assert.equal(isMac('Win32'), false);
  assert.equal(isMac('Linux x86_64'), false);
  assert.deepEqual(searchKey(true), { label: '⌘K', aria: 'Meta+K' });
  assert.deepEqual(searchKey(false), { label: 'Ctrl+K', aria: 'Control+K' });

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
    hits: [hits.run],
  };
  assert.equal(isSearchResult(result), true);
  assert.equal(isSearchResult({ hits: [] }), false);
});

/** A snapshot at a small level: the board keeps the newest 5 of 50 posts, and the lists keep less. */
function trimmed(): Snapshot {
  const shown = snapshot({
    board: {
      posts: [44, 45, 46, 47, 48].map((number) => ({
        id: `p-${number}`,
        at: ago(60 - number),
        author: 'a-1',
        handle: 'claude-2',
        harness: 'claude',
        kind: 'claim',
        direction: 'd-1',
        text: `Claim ${number}.`,
        replyTo: null,
        mentions: [],
        proof: [],
      })),
      more: true,
    },
    omitted: { directions: 3, needsYou: 4 },
  });
  return { ...shown, trimmed: true };
}

const agentStub: AgentActions = {
  message: () => Promise.resolve({ ok: true }),
  turns: () => Promise.resolve({ error: 'not in this test' }),
  turn: () => Promise.resolve({ error: 'not in this test' }),
  thread: () => Promise.resolve({ error: 'not in this test' }),
};

function screen(shown: Snapshot, hash: string): string {
  return renderToStaticMarkup(
    <Screen
      state={{ snapshot: shown, connection: 'live', retrying: false }}
      route={parseRoute(hash)}
      now={now}
      actions={actions}
      agentActions={agentStub}
    />,
  );
}

await test('every hit opens from what this snapshot holds: a post on the board or on its own page, a run on its direction, and a call in its dialog or here', () => {
  // A trimmed snapshot: p-40 is among the newest 50 posts, but the board holds the newest 5.
  const small = trimmed();
  const lab = small.lab;
  assert.ok(lab);
  assert.deepEqual(hitAction(hits.onBoard, lab), {
    type: 'go',
    route: '#/board/p-48',
  });
  assert.deepEqual(hitAction(hits.older, lab), {
    type: 'go',
    route: '#/post/p-40',
  });
  assert.deepEqual(hitAction(hits.run, lab), {
    type: 'go',
    route: '#/d/d-2/run/r-3',
  });
  assert.deepEqual(hitAction(hits.call, lab), {
    type: 'go',
    route: '#/call/c-4',
  });
  // A call that the snapshot does not hold never opens the dialog, which could not show it.
  assert.deepEqual(hitAction(hits.answered, lab), { type: 'read' });

  // The board link: the lab home, which brings the post into view and then takes its own address.
  const home = screen(small, '#/board/p-48');
  assert.match(home, /id="post-p-48"/);
  assert.doesNotMatch(home, /Reading the post/);
  assert.deepEqual(boardLink(lab, 'p-48'), { show: 'p-48', route: '#/' });
  // A board link to a post that the board no longer holds opens the post's page instead.
  assert.deepEqual(boardLink(lab, 'p-40'), {
    show: null,
    route: '#/post/p-40',
  });
  // A post's page reads the post, whatever the board holds.
  for (const id of ['p-40', 'p-48']) {
    const page = screen(small, `#/post/${id}`);
    assert.match(page, /<h1 class="turn-head__title">A post<\/h1>/);
    assert.match(page, /Reading the post…/);
    assert.match(page, /<a class="back" href="#\/">/);
    assert.doesNotMatch(page, /id="post-p-4\d"/);
  }
});

await test('a hit is a link to its page, or shows a call that the snapshot leaves out in place, and marks what matched', () => {
  const board = trimmed().lab;
  assert.ok(board);
  const render = (hit: SearchHit, open = false): string =>
    renderToStaticMarkup(
      <Hit
        hit={hit}
        action={hitAction(hit, board)}
        open={open}
        onGo={() => {}}
        onRead={() => {}}
      />,
    );
  const onBoard = render(hits.onBoard);
  assert.match(
    onBoard,
    /<a class="hit__open" href="#\/board\/p-48" data-hit="">/,
  );
  assert.match(onBoard, /<span class="chip chip--claim">Claim<\/span>/);
  assert.match(onBoard, /smaller on <mark>seed<\/mark> 1\./);
  assert.match(render(hits.older), /<a class="hit__open" href="#\/post\/p-40"/);

  const run = render(hits.run);
  assert.match(run, /href="#\/d\/d-2\/run\/r-3"/);
  assert.match(
    run,
    /<code class="hit__text hit__text--code">python probe_train\.py --<mark>seed<\/mark> 1<\/code>/,
  );
  assert.match(run, /exit 0 in 19 min/);
  assert.match(render(hits.call), /href="#\/call\/c-4"[^]*waits for you/);

  // A call that the snapshot leaves out: a button that shows its question, its answer, and when.
  const closed = render(hits.answered);
  assert.match(
    closed,
    /<button type="button" class="hit__open" data-hit="" aria-expanded="false">/,
  );
  assert.match(closed, /Show the call/);
  assert.doesNotMatch(closed, /hit__read/);
  const opened = render(hits.answered, true);
  assert.match(opened, /aria-expanded="true"[^]*Hide the call/);
  assert.match(
    opened,
    new RegExp(
      `<div class="hit__read"><p class="hit__whole">Continue 4 more hours\\?</p><p class="hit__fine">You chose &quot;Continue&quot; at ${clock(ago(880))}\\. The budget is 12 hours now\\.</p></div>`,
    ),
  );
  // Where each kind of call stands.
  assert.equal(
    callRead({ ...hits.answered, answer: { words: 'Stop at 6.' }, note: null }),
    'You answered in your own words: "Stop at 6."',
  );
  assert.equal(
    callRead({
      ...hits.answered,
      state: 'withdrawn',
      answer: null,
      note: 'The direction stopped.',
    }),
    'Withdrawn. The direction stopped.',
  );
  assert.equal(
    callRead(hits.call),
    'It waits for your answer, but this view of a large lab leaves it out.',
  );
  assert.equal(
    callRead({ ...hits.answered, state: 'undoing', note: null }),
    'Verifold is undoing your answer.',
  );
});

await test('the page looks at once, each minute while it shows, and when it shows again, and stops for good after a refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  class Page extends EventTarget {
    visibilityState: DocumentVisibilityState = 'visible';
  }
  const page = new Page();
  let answer: ActOutcome = { ok: true };
  let looks = 0;
  const logged: unknown[] = [];
  t.mock.method(console, 'info', (line: unknown) => {
    logged.push(line);
  });
  const settle = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));
  const stop = sendLooks(() => {
    looks++;
    return Promise.resolve(answer);
  }, page);
  t.after(stop);
  assert.equal(looks, 1);
  t.mock.timers.tick(lookMs);
  assert.equal(looks, 2);
  // A hidden page does not look, and looks again when it shows.
  page.visibilityState = 'hidden';
  t.mock.timers.tick(lookMs);
  assert.equal(looks, 2);
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(looks, 3);
  // A lost answer is no refusal: the looks go on.
  answer = { lost: 'Verifold did not answer.' };
  t.mock.timers.tick(lookMs);
  await settle();
  t.mock.timers.tick(lookMs);
  assert.equal(looks, 5);
  // A refusal, as from a Verifold without looks, stops them, with one line in the console.
  answer = { refused: 'Verifold knows no such action.' };
  t.mock.timers.tick(lookMs);
  await settle();
  assert.equal(looks, 6);
  t.mock.timers.tick(lookMs * 5);
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(looks, 6);
  assert.deepEqual(logged, [
    "Verifold refused the page's look, so it sends no more: Verifold knows no such action.",
  ]);
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
