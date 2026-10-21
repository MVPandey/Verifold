import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Call,
  Direction,
  Lab,
  Snapshot,
} from '../src/protocol/api.ts';
import { labActions } from '../src/app/actions.ts';
import {
  callView,
  costLine,
  decideId,
  effectLines,
  optionForKey,
  optionOrder,
  returnFocus,
  typing,
  undoLeft,
} from '../src/app/call.ts';
import { parseRoute } from '../src/app/route.ts';
import { Screen } from '../src/app/App.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();
const later = (minutes: number): string =>
  new Date(now + minutes * 60_000).toISOString();

function agent(
  id: string,
  handle: string,
  harness: 'claude' | 'codex',
  direction: string,
): Agent {
  return {
    id,
    handle,
    harness,
    model: null,
    direction,
    check: null,
    status: 'idle',
    until: null,
    live: { state: 'idle', text: 'Between turns', since: ago(5) },
    turns: { turns: [], more: false },
    spendUsd: null,
  };
}

function direction(id: string, title: string, agentId: string): Direction {
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
    agent: agentId,
    openedBy: 'a-0',
    openedAt: ago(120),
    stoppedAt: null,
    head: 'a3f9c2e',
  };
}

/** The H100 call of the v9 canvas's call artboard. */
function call(fields: Partial<Call> = {}): Call {
  return {
    id: 'c-4',
    at: ago(12),
    kind: 'cost',
    question: 'Rent an H100 for the probe reruns?',
    why: 'The filter shrank the gap 34% on one seed. Seeds 2 and 3 need a GPU.',
    askers: [
      {
        agent: 'a-2',
        handle: 'claude-2',
        direction: 'd-2',
        why: 'The filter shrank the gap 34% on one seed. Seeds 2 and 3 need a GPU.',
      },
      {
        agent: 'a-4',
        handle: 'codex-2',
        direction: 'd-4',
        why: 'One seed can be luck; rerun with a length-matched control.',
      },
    ],
    byVerifold: false,
    options: [
      {
        label: 'Rent 1 H100 for 3 hours',
        usd: 11.97,
        minutes: 180,
        effect: {
          type: 'pod',
          gpu: 'H100 SXM',
          hours: 3,
          secrets: 0,
          missing: 0,
        },
      },
      {
        label: 'Rent 1 A100 for 5 hours',
        usd: 8.95,
        minutes: 300,
        effect: {
          type: 'pod',
          gpu: 'A100 80GB',
          hours: 5,
          secrets: 0,
          missing: 0,
        },
      },
      { label: 'Use this Mac', usd: 0, minutes: 540, effect: null },
    ],
    pick: 0,
    undoMinutes: 10,
    state: 'open',
    answer: null,
    words: null,
    undoUntil: null,
    note: null,
    post: 'p-12',
    ...fields,
  };
}

function lab(fields: Partial<Lab> = {}): Lab {
  return {
    question: 'Can cheap training make a CoT faithful?',
    startedAt: ago(600),
    agentsHere: true,
    paused: null,
    budget: null,
    money: { plansUsd: 3.1, gpuUsd: 4.2, gpuLimitUsd: 25 },
    needsYou: [call()],
    answered: [],
    directions: [
      direction('d-2', 'The CoT matches what probes read inside', 'a-2'),
      direction('d-4', 'Gains survive pressure from a monitor', 'a-4'),
    ],
    agents: [
      agent('a-2', 'claude-2', 'claude', 'd-2'),
      agent('a-4', 'codex-2', 'codex', 'd-4'),
    ],
    plan: {
      post: 'p-1',
      at: ago(300),
      reading: 'Can a cheap fine-tune make the CoT say what drives the answer?',
      cost: 'Nothing costs money yet.',
      directions: ['d-2', 'd-4'],
      facts: [
        {
          claim: 'H100 $3.99/h, A100 $1.79/h',
          source: 'https://www.runpod.io/pricing',
          sourceDate: '2026-10-08',
          listedAt: ago(300),
        },
        {
          claim: 'Qwen3.5-9B has official SAEs',
          source: null,
          sourceDate: null,
          listedAt: ago(300),
        },
      ],
    },
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

const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
const actions: LabActions = {
  post: ok,
  pause: ok,
  answer: ok,
  words: ok,
  undo: ok,
};

function render(state: Snapshot, hash = '#/call/c-4'): string {
  return renderToStaticMarkup(
    <Screen
      state={{ snapshot: state, connection: 'live', retrying: false }}
      route={parseRoute(hash)}
      now={now}
      actions={actions}
    />,
  );
}

/** Visible text, with tags removed and entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** The markup of the dialog alone. */
function dialog(html: string): string {
  const start = html.indexOf('<dialog');
  assert.ok(start >= 0, 'no dialog');
  return html.slice(start, html.indexOf('</dialog>') + '</dialog>'.length);
}

await test('a call has its own address, and other call addresses do not exist', () => {
  assert.deepEqual(parseRoute('#/call/c-4'), { page: 'call', id: 'c-4' });
  assert.deepEqual(parseRoute('#/call/c-123456'), {
    page: 'call',
    id: 'c-123456',
  });
  for (const hash of [
    '#/call/c-0',
    '#/call/c-1234567',
    '#/call/x',
    '#/call/../c-4',
    '#/call/c-4/more',
  ])
    assert.deepEqual(parseRoute(hash), { page: 'unknown' }, hash);
});

await test('the call opens as a modal dialog over the lab: who asked and when, the question, the options, the facts, and a box for the words', () => {
  const html = render(snapshot());
  // The lab home stays underneath, with the Decide link that focus returns to.
  assert.match(html, new RegExp(`id="${decideId}"`));
  const box = dialog(html);
  assert.match(
    box,
    /<dialog class="call" aria-labelledby="([^"]+)" aria-modal="true">/,
  );
  const label = /aria-labelledby="([^"]+)"/.exec(box)?.[1] ?? '';
  assert.match(
    box,
    new RegExp(
      `<h2 id="${label}" class="call__title">Rent an H100 for the probe reruns\\?</h2>`,
    ),
  );
  const page = text(box);
  assert.match(page, /Needs you · asked by claude-2 and codex-2 · 12 min ago/);
  assert.match(page, /The filter shrank the gap 34% on one seed\./);
  // A joined asker's own reason shows under the first one.
  // The thread link ends the last reason.
  assert.match(
    page,
    /codex-2: One seed can be luck; rerun with a length-matched control\. See the thread/,
  );
  // Each option: its label, cost and time, and what it does in Verifold's words.
  assert.match(
    page,
    /Rent 1 H100 for 3 hours \$11\.97 · about 3 h The agents' pick/,
  );
  // Each option says what it does; the last line says how to take it back.
  assert.match(page, /Starts a pod with H100 SXM for 3 hours\./);
  assert.doesNotMatch(page, /Undo ends the pod/);
  assert.match(page, /Use this Mac \$0 · about 9 h/);
  assert.equal(page.match(/The agents' pick/g)?.length, 1);
  // Keyboard users learn the number keys from the buttons.
  assert.match(box, /aria-keyshortcuts="1"/);
  assert.match(box, /aria-keyshortcuts="3"/);
  // The facts behind it: the money, and the plan's checked facts with their sources.
  assert.match(
    page,
    /GPU spent so far: \$4\.20 of this lab's \$25\. Plans so far: about \$3\.10\./,
  );
  assert.match(
    page,
    /H100 \$3\.99\/h, A100 \$1\.79\/h · https:\/\/www\.runpod\.io\/pricing, 2026-10-08/,
  );
  assert.match(
    page,
    /Qwen3\.5-9B has official SAEs · unverified \(no source\)/,
  );
  assert.match(page, /Or tell them what to do instead/);
  assert.match(box, /<textarea[^>]*maxLength="2000"/);
  assert.match(
    page,
    /Undo within 10 minutes stops the GPU, and you pay only the minutes used\. If you don't answer, nothing is bought\./,
  );
  // A call with no pod says plainly how long its answer can be undone.
  const scope = call({
    kind: 'scope',
    question: 'Stop the helix direction?',
    options: [
      {
        label: 'Stop it',
        usd: null,
        minutes: null,
        effect: { type: 'stop', direction: 'd-2' },
      },
      { label: 'Keep it', usd: null, minutes: null, effect: null },
    ],
  });
  const other = text(dialog(render(snapshot({ needsYou: [scope] }))));
  assert.match(
    other,
    /Stops "The CoT matches what probes read inside"\. Its runs and pods end\./,
  );
  assert.match(
    other,
    /Your answer applies at once\. You can undo it for 10 minutes\. If you don't answer, nothing happens\./,
  );
});

await test("the agents' pick comes first, and the number keys follow the order shown", () => {
  const advised = call({ pick: 2 });
  const order = optionOrder(advised);
  assert.deepEqual(order, [2, 0, 1]);
  assert.equal(optionForKey('1', order, false), 2);
  assert.equal(optionForKey('2', order, false), 0);
  assert.equal(optionForKey('3', order, false), 1);
  assert.equal(optionForKey('4', order, false), null);
  assert.equal(optionForKey('a', order, false), null);
  assert.equal(optionForKey('Enter', order, false), null);
  // In the words box a number is text, not a choice.
  assert.equal(optionForKey('1', order, true), null);
  assert.equal(typing({ tagName: 'TEXTAREA' }), true);
  assert.equal(typing({ tagName: 'BUTTON' }), false);
  assert.equal(typing(null), false);
  // With no pick, the agents' order stays.
  assert.deepEqual(optionOrder(call({ pick: null })), [0, 1, 2]);
  const page = text(dialog(render(snapshot({ needsYou: [advised] }))));
  assert.ok(
    page.indexOf('Use this Mac') < page.indexOf('Rent 1 H100'),
    'the pick shows first',
  );
  assert.match(page, /Use this Mac \$0 · about 9 h The agents' pick/);
});

await test("Verifold's deadline call says who asks, and after words it says that an option is still needed", () => {
  const deadline = call({
    id: 'c-9',
    kind: 'go',
    question: 'The time budget of 8 hours ended. Continue 4 more hours?',
    why: 'The time budget ended.',
    askers: [],
    byVerifold: true,
    options: [
      {
        label: 'Continue 4 more hours',
        usd: null,
        minutes: 240,
        effect: { type: 'hours', hours: 4 },
      },
      { label: 'End the lab', usd: null, minutes: null, effect: null },
    ],
    pick: null,
    undoMinutes: 0,
    words: 'Keep going, but stop the helix direction.',
    post: null,
  });
  const page = text(
    dialog(render(snapshot({ needsYou: [deadline] }), '#/call/c-9')),
  );
  assert.match(page, /Needs you · Verifold asks · 12 min ago/);
  assert.match(page, /Gives the lab 4 more hours\./);
  assert.match(
    page,
    /Your words went to the lab\. Pick an option to give it more time or end it\./,
  );
  assert.match(page, /Your answer applies at once, and it has no undo\./);
  assert.doesNotMatch(page, /See the thread/);
});

await test('a pod option says when a pod secret must be stored first', () => {
  const needs = call({
    options: [
      {
        label: 'Rent 1 H100 for 3 hours',
        usd: 11.97,
        minutes: 180,
        effect: {
          type: 'pod',
          gpu: 'H100 SXM',
          hours: 3,
          secrets: 2,
          missing: 1,
        },
      },
      { label: 'Use this Mac', usd: 0, minutes: 540, effect: null },
    ],
  });
  const page = text(dialog(render(snapshot({ needsYou: [needs] }))));
  assert.match(
    page,
    /Needs 1 pod secret stored in Compute first\. Open the desk to store it\./,
  );
});

await test('an answer can be undone in the dialog and on the lab home while its window is open, and not after', () => {
  const chosen = call({
    state: 'answered',
    answer: { option: 0, at: ago(5) },
    undoUntil: later(5),
  });
  const open = snapshot({ needsYou: [], answered: [chosen] });
  const page = text(dialog(render(open)));
  assert.match(page, /Answered/);
  assert.match(
    page,
    /You chose “Rent 1 H100 for 3 hours”\. Undo 5 min left\. Undo ends the pod\. The minutes billed so far stay billed\. Then the call asks again\./,
  );
  assert.match(page, /Back to the lab/);
  // On the lab home, the undo line names the call.
  const home = text(render(open, '#/'));
  assert.match(
    home,
    /You chose “Rent 1 H100 for 3 hours” on “Rent an H100 for the probe reruns\?”\. Undo 5 min left\./,
  );
  assert.equal(undoLeft(chosen, now), 5);
  // After the window: the choice, with no undo, and nothing on the home.
  const closed = snapshot({
    needsYou: [],
    answered: [{ ...chosen, undoUntil: ago(1) }],
  });
  const after = text(dialog(render(closed)));
  assert.match(after, /You chose “Rent 1 H100 for 3 hours”\./);
  assert.doesNotMatch(after, /Undo/);
  assert.doesNotMatch(text(render(closed, '#/')), /You chose/);
});

await test('words, a withdrawn call, an undo in progress, and an unknown call each say what became of the call', () => {
  const words = call({
    state: 'answered',
    words: 'Run one seed on the A100 first, then decide.',
  });
  const answered = text(
    dialog(render(snapshot({ needsYou: [], answered: [words] }))),
  );
  assert.match(answered, /You answered in your own words:/);
  assert.match(answered, /Run one seed on the A100 first, then decide\./);
  assert.match(
    answered,
    /claude-2 and codex-2 get your words with the next turn\. No option applied\./,
  );
  assert.equal(
    callView(lab({ needsYou: [], answered: [words] }), 'c-4').kind,
    'words',
  );

  const withdrawn = call({
    state: 'withdrawn',
    note: 'Its direction closed.',
  });
  assert.match(
    text(dialog(render(snapshot({ needsYou: [], answered: [withdrawn] })))),
    /Verifold withdrew this call: Its direction closed\./,
  );

  const undoing = call({ state: 'undoing', answer: { option: 0, at: ago(2) } });
  assert.match(
    text(dialog(render(snapshot({ needsYou: [undoing] })))),
    /Undoing your answer\./,
  );

  const gone = text(dialog(render(snapshot(), '#/call/c-77')));
  assert.match(gone, /This call is not in the lab/);
});

await test("Verifold's words for each kind of effect, as the desk says them", () => {
  const home = lab();
  const asked = call();
  assert.deepEqual(
    effectLines({ type: 'stop', direction: 'd-2' }, asked, home),
    {
      does: 'Stops "The CoT matches what probes read inside". Its runs and pods end.',
      undo: 'Undo opens it again with its agent. Runs and pods that ended do not come back.',
    },
  );
  assert.equal(
    effectLines(
      { type: 'open', title: 'Gemma check', harness: 'codex', bar: '3 seeds' },
      asked,
      home,
    ).does,
    'Opens "Gemma check" with a new Codex agent.',
  );
  assert.equal(
    effectLines({ type: 'hours', hours: 1 }, asked, home).does,
    'Gives the lab 1 more hour.',
  );
  // Domains: Codex cannot limit the network, so the line says so for its shell.
  const domains = effectLines(
    { type: 'domains', domains: ['pypi.org', 'huggingface.co'] },
    asked,
    home,
  );
  assert.equal(
    domains.does,
    "Lets claude-2's shell reach pypi.org, huggingface.co. Codex cannot limit the network to pypi.org, huggingface.co, so codex-2's shell can reach any website.",
  );
  assert.equal(
    domains.undo,
    'Undo takes these domains back. Either way, claude-2 and codex-2 continue their conversations in new processes.',
  );
  assert.equal(
    costLine({ label: 'x', usd: null, minutes: null, effect: null }),
    '',
  );
  assert.equal(
    costLine({ label: 'x', usd: 2, minutes: 45, effect: null }),
    '$2 · about 45 min',
  );
});

await test("the call's actions are the desk's actions, sent with the intent's key", async (t) => {
  const sent: { url: string; auth: string | null; body: unknown }[] = [];
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
      auth: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(Response.json({ ok: true }));
  };
  const run = labActions('t0ken');
  assert.deepEqual(await run.answer('c-4', 1, 'k1'), { ok: true });
  assert.deepEqual(await run.words('c-4', 'Do this instead.', 'k2'), {
    ok: true,
  });
  assert.deepEqual(await run.undo('c-4', 'k3'), { ok: true });
  assert.deepEqual(sent, [
    {
      url: '/api/v1/actions/lab-call-answer',
      auth: 'Bearer t0ken',
      body: { call: 'c-4', option: 1, key: 'k1' },
    },
    {
      url: '/api/v1/actions/lab-call-words',
      auth: 'Bearer t0ken',
      body: { call: 'c-4', text: 'Do this instead.', key: 'k2' },
    },
    {
      url: '/api/v1/actions/lab-call-undo',
      auth: 'Bearer t0ken',
      body: { call: 'c-4', key: 'k3' },
    },
  ]);
  // Without a token nothing is sent, and the page says why.
  assert.deepEqual(await labActions(null).answer('c-4', 0, 'k4'), {
    refused: 'This tab has no access key.',
  });
  assert.equal(sent.length, 3);
});

await test('after the dialog closes, focus goes to the Decide link only when it went nowhere', () => {
  const focused: string[] = [];
  const element = (id: string) => ({ focus: () => focused.push(id) });
  const body = {};
  // The browser returned focus to the Decide link it came from: nothing to do.
  returnFocus({
    activeElement: { id: 'needs-decide' },
    body,
    getElementById: (id) => element(id),
  });
  assert.deepEqual(focused, []);
  // The page opened on the call's address: focus was nowhere, so it goes to Decide.
  returnFocus({
    activeElement: body,
    body,
    getElementById: (id) => element(id),
  });
  returnFocus({
    activeElement: null,
    body,
    getElementById: (id) => element(id),
  });
  assert.deepEqual(focused, [decideId, decideId]);
  // No call waits any more, so no Decide link: nothing breaks.
  returnFocus({ activeElement: body, body, getElementById: () => null });
  assert.deepEqual(focused, [decideId, decideId]);
});
