import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  BringList,
  BringRead,
  Call,
  CheckItem,
  Direction,
  Lab,
  Post,
  Run,
  Snapshot,
} from '../src/protocol/api.ts';
import { agentActions, answerActions } from '../src/app/actions.ts';
import {
  answerStatus,
  bringKey,
  bringWork,
  broughtLine,
  checkLine,
  findings,
  firstTicked,
  runsLine,
  stillOpen,
  stoppedWithout,
  yourCalls,
} from '../src/app/answer.ts';
import { isBringRead, isFileDiff, paths } from '../src/app/api.ts';
import { clock } from '../src/app/format.ts';
import { href, parseRoute } from '../src/app/route.ts';
import { Screen } from '../src/app/App.tsx';
import {
  BringFiles,
  BringHistory,
  codeWarning,
} from '../src/app/screens/BringPage.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

function agent(id: string, handle: string, direction: string): Agent {
  return {
    id,
    handle,
    harness: handle.startsWith('codex') ? 'codex' : 'claude',
    model: null,
    direction,
    check: null,
    status: 'working',
    until: null,
    live: { state: 'working', text: 'Running plant_errors.py', since: ago(6) },
    turns: { turns: [], more: false },
    spendUsd: null,
  };
}

function direction(
  id: string,
  title: string,
  agentId: string,
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
    agent: agentId,
    openedBy: 'a-0',
    openedAt: ago(300),
    stoppedAt: null,
    head: 'a3f9c2e',
    brought: null,
    ...fields,
  };
}

function post(id: string, fields: Partial<Post> = {}): Post {
  return {
    id,
    at: ago(60),
    author: 'a-1',
    handle: 'claude-1',
    harness: 'claude',
    kind: 'claim',
    direction: 'd-1',
    text: 'A claim.',
    replyTo: null,
    mentions: [],
    proof: [],
    ...fields,
  };
}

function check(fields: Partial<CheckItem> = {}): CheckItem {
  return {
    id: 'k-1',
    post: 'p-5',
    direction: 'd-1',
    run: 'r-4',
    harness: 'codex',
    agent: 'a-9',
    handle: 'codex-9',
    sameHarness: false,
    blind: true,
    state: 'done',
    outcome: 'holds',
    method: 'rerun',
    result: 'p-6',
    note: null,
    queuedAt: ago(50),
    startedAt: ago(49),
    endedAt: ago(40),
    ...fields,
  };
}

function run(id: string, status: Run['status']): Run {
  return {
    id,
    agent: 'a-1',
    direction: 'd-1',
    status,
    command: 'python probe.py',
    why: 'Seed 1.',
    where: 'local',
    commit: 'a3f9c2e',
    exitCode: status === 'done' ? 0 : 1,
    queuedAt: ago(90),
    startedAt: ago(89),
    endedAt: ago(80),
    metrics: {},
    note: null,
  };
}

function answeredCall(id: string, fields: Partial<Call>): Call {
  return {
    id,
    at: ago(30),
    kind: 'cost',
    question: 'Rent an H100?',
    why: 'Seeds 2 and 3 need a GPU.',
    askers: [],
    byVerifold: false,
    options: [
      {
        label: 'Rent 1 H100 for 3 hours',
        usd: 11.97,
        minutes: 180,
        effect: null,
      },
      { label: 'Use this Mac', usd: 0, minutes: 540, effect: null },
    ],
    pick: 0,
    state: 'answered',
    answer: null,
    words: null,
    undoUntil: null,
    note: null,
    post: null,
    ...fields,
  };
}

/** The canvas's story: two directions hold up or lead, one is ruled out, one still runs. */
function lab(fields: Partial<Lab> = {}): Lab {
  return {
    question: 'Can cheap training make a CoT faithful?',
    signoffLimit: 280,
    startedAt: ago(600),
    agentsHere: true,
    paused: null,
    budget: null,
    money: { plansUsd: 7.8, gpuUsd: 13.4, gpuLimitUsd: 25 },
    needsYou: [],
    answered: [],
    directions: [
      direction('d-1', 'The CoT names what drives the answer', 'a-1', {
        verdict: 'holds-up',
        evidence: {
          text: 'Cue named 64% vs 41% for the control',
          post: 'p-5',
          run: 'r-4',
        },
        brought: { files: 2, lastAt: ago(20) },
      }),
      direction('d-2', 'The CoT matches what probes read inside', 'a-2', {
        verdict: 'leading',
        evidence: { text: 'Gap 34% smaller', post: 'p-9', run: null },
      }),
      direction('d-3', 'The answer follows what the CoT says', 'a-3', {
        verdict: 'ruled-out',
        evidence: {
          text: 'Planted errors barely move it',
          post: 'p-11',
          run: null,
        },
        state: 'closed',
      }),
      direction('d-4', 'Gains survive pressure from a monitor', 'a-4'),
    ],
    agents: [
      agent('a-1', 'claude-1', 'd-1'),
      agent('a-2', 'claude-2', 'd-2'),
      agent('a-3', 'codex-1', 'd-3'),
      agent('a-4', 'codex-2', 'd-4'),
    ],
    plan: {
      post: 'p-1',
      at: ago(300),
      reading: 'Can a cheap fine-tune make the CoT say what drives the answer?',
      cost: 'Nothing costs money yet.',
      directions: ['d-1', 'd-2', 'd-3', 'd-4'],
      facts: [
        {
          claim: 'H100 $3.99/h, A100 $1.79/h',
          source: 'https://www.runpod.io/pricing',
          sourceDate: '2026-10-08',
          listedAt: ago(300),
        },
        {
          claim: 'Qwen3.5-9B, February 2026',
          source: 'Hugging Face',
          sourceDate: null,
          listedAt: ago(300),
        },
        {
          claim: 'Unchecked guess',
          source: null,
          sourceDate: null,
          listedAt: ago(300),
        },
      ],
    },
    board: {
      posts: [
        post('p-9', {
          direction: 'd-2',
          proof: [{ type: 'run', run: 'r-3' }],
        }),
        post('p-11', {
          kind: 'ruled-out',
          direction: 'd-3',
          proof: [
            {
              type: 'figure',
              direction: 'd-3',
              path: 'figures/errors.png',
              commit: 'b1c2d3e',
              bytes: 10,
            },
          ],
        }),
      ],
      more: false,
    },
    disputes: [],
    runs: [run('r-3', 'done'), run('r-4', 'done'), run('r-7', 'failed')],
    checks: [check()],
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

function render(state: Snapshot, hash = '#/answer'): string {
  return renderToStaticMarkup(
    <Screen
      state={{ snapshot: state, connection: 'live', retrying: false }}
      route={parseRoute(hash)}
      now={now}
      actions={actions}
      agentActions={agentActions(null)}
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

await test('a finding is tagged only by what the lab records: runs make data, a post with no run is reasoning, and a missing post leaves it untagged', () => {
  const found = findings(lab());
  assert.deepEqual(
    found.map((finding) => [finding.key, finding.tag, finding.runs]),
    [
      // Holds up first, then leading, then ruled out, then the plan's sourced facts.
      ['d-1', 'data', ['r-4']],
      ['d-2', 'data', ['r-3']],
      ['d-3', 'reasoning', []],
      ['fact-0', 'literature', []],
      ['fact-1', 'literature', []],
    ],
  );
  // A fact with no source is unverified, so it is no finding.
  assert.ok(!found.some((finding) => finding.text === 'Unchecked guess'));
  // A source links only when it is a web address.
  assert.equal(found[3]?.source?.url, 'https://www.runpod.io/pricing');
  assert.equal(found[4]?.source?.url, null);
  // The rerun of d-1's evidence held; d-2's has none yet; a ruled-out note needs no check.
  assert.equal(found[0]?.check, 'Codex reran it, and it held');
  assert.equal(found[1]?.check, 'Not rerun yet');
  assert.equal(found[2]?.check, null);

  // The evidence post is older than this page, and no run is named: no tag.
  const older = findings(
    lab({
      directions: [
        direction('d-5', 'Old result', 'a-1', {
          verdict: 'holds-up',
          evidence: { text: 'From long ago', post: 'p-2', run: null },
        }),
      ],
      plan: null,
    }),
  );
  assert.equal(older[0]?.tag, null);
  assert.match(older[0]?.untagged ?? '', /older than this page shows/);
});

await test('a check line says how the newest rerun went, and nothing when the page leaves checks out', () => {
  assert.equal(checkLine(lab(), 'p-5'), 'Codex reran it, and it held');
  assert.equal(
    checkLine(lab({ checks: [check({ outcome: 'fails' })] }), 'p-5'),
    'Codex reran it, and it did not hold',
  );
  assert.equal(
    checkLine(
      lab({ checks: [check({ state: 'running', outcome: null })] }),
      'p-5',
    ),
    'Codex reruns it now',
  );
  assert.equal(checkLine(lab({ checks: [] }), 'p-5'), 'Not rerun yet');
  assert.equal(
    checkLine(lab({ checks: [], omitted: { checks: 4 } }), 'p-5'),
    null,
  );
});

await test("the answer's status, open items, calls, and runs read from the lab's records", () => {
  assert.equal(
    answerStatus(lab()),
    'The answer, draft · 1 of 4 directions hold up · 1 ruled out · 2 still open',
  );
  assert.equal(
    answerStatus(lab({ signoff: { at: ago(5), note: null, directions: [] } })),
    `Signed off at ${clock(ago(5))} · 1 of 4 directions hold up · 1 ruled out · 2 still open`,
  );
  assert.equal(
    answerStatus(lab({ directions: [] })),
    'The answer, draft · no direction yet',
  );
  assert.deepEqual(
    stillOpen(lab()).map((entry) => entry.id),
    ['d-4'],
  );
  assert.deepEqual(
    stoppedWithout(lab()).map((entry) => entry.id),
    [],
  );

  // Answered is newest first; the person's calls read oldest first. One still applies, one was withdrawn.
  const calls = yourCalls(
    lab({
      answered: [
        answeredCall('c-4', {
          answer: { option: 0, at: ago(5) },
          applying: true,
        }),
        answeredCall('c-3', { words: 'Use the A100 first.' }),
        answeredCall('c-2', {
          state: 'withdrawn',
          answer: { option: 1, at: ago(20) },
        }),
        answeredCall('c-1', { answer: { option: 1, at: ago(40) } }),
      ],
    }),
  );
  assert.deepEqual(calls, ['Use this Mac', '"Use the A100 first."']);

  assert.equal(
    runsLine(lab()),
    '3 runs, 1 failed or stopped. Verifold keeps every run.',
  );
  assert.equal(runsLine(lab({ runs: [] })), 'No run yet.');
  assert.equal(
    runsLine(lab({ omitted: { runs: 40 } })),
    '43 runs. Verifold keeps every run.',
  );
});

await test('the answer page shows the tagged findings, what is open, the calls, and the sign-off', () => {
  const html = render(snapshot());
  const shown = text(html);
  assert.match(
    html,
    /<h1 class="answer-head__title">Can cheap training make a CoT faithful\?<\/h1>/,
  );
  assert.match(shown, /The answer, draft · 1 of 4 directions hold up/);
  assert.match(html, /class="tag tag--data">Data</);
  assert.match(html, /class="tag tag--reasoning">Our reasoning</);
  assert.match(html, /class="tag tag--literature">Literature</);
  // A source links only as a web address, and reads short.
  assert.match(
    html,
    /href="https:\/\/www\.runpod\.io\/pricing" target="_blank" rel="noreferrer noopener">runpod\.io\/pricing<\/a> · 2026-10-08/,
  );
  // A finding reads as one paragraph: its evidence, then how its rerun went.
  assert.match(
    shown,
    /Cue named 64% vs 41% for the control\. Codex reran it, and it held\./,
  );
  assert.match(shown, /2 files brought in, last at/);
  assert.match(html, /href="#\/d\/d-1\/bring">Bring in files</);
  assert.match(shown, /Still open/);
  assert.match(
    shown,
    /Gains survive pressure from a monitor · codex-2: Running plant_errors\.py/,
  );
  assert.match(
    shown,
    /Your calls: none\. The agents made every choice, all on the board\./,
  );
  assert.match(html, /The answer in one line \(optional\)/);
  assert.match(html, /maxLength="280"/);
  assert.match(html, />Sign off<\/button>/);
  // No button for what does not exist.
  assert.doesNotMatch(shown, /Export|Ask a follow-up/);

  // After a sign-off with a line, the line is the title and the question follows.
  const signed = render(
    snapshot({ signoff: { at: ago(5), note: 'Partly yes.', directions: [] } }),
  );
  assert.match(signed, /<h1 class="answer-head__title">Partly yes\.<\/h1>/);
  assert.match(
    text(signed),
    /The question: Can cheap training make a CoT faithful\?/,
  );
  assert.match(
    text(signed),
    /You signed off at .*A new sign-off replaces it\./,
  );

  // A view that only shows the lab offers neither sign-off nor bring-in.
  const viewing = render(snapshot({ agentsHere: false }));
  assert.doesNotMatch(viewing, />Sign off<\/button>|Bring in files/);
  assert.match(
    text(viewing),
    /Run verifold in the project folder to sign off or bring files in\./,
  );

  // Nothing settled yet.
  const early = render(
    snapshot({
      directions: [
        direction('d-4', 'Gains survive pressure from a monitor', 'a-4'),
      ],
      plan: null,
    }),
  );
  assert.match(text(early), /Nothing is settled yet\./);
});

await test('a bring-in shows its files: code files start unticked with the warning, others say why they stay out, and a file that came in is done', () => {
  const list: BringList = {
    direction: 'd-1',
    branch: 'verifold/d-1-cue',
    commit: 'c'.repeat(40),
    working: true,
    newer: true,
    left: [
      {
        path: 'shared.md',
        why: "It is a file that Verifold can't copy safely.",
      },
    ],
    files: [
      {
        path: '.githooks/pre-commit',
        change: 'added',
        bytes: 20,
        ticked: false,
        out: null,
        why: 'It can run code through your tools, such as a Git hook or an editor task. Check its diff first.',
        since: null,
        code: true,
      },
      {
        path: '.Verifold/lab.json',
        change: 'added',
        bytes: 3,
        ticked: false,
        out: "Verifold's own records stay out.",
        why: null,
        since: null,
        code: false,
      },
      {
        path: 'a<b>.md',
        change: 'modified',
        bytes: 9,
        ticked: true,
        out: null,
        why: null,
        since: null,
        code: false,
      },
      {
        path: 'done.md',
        change: 'added',
        bytes: 5,
        ticked: false,
        out: null,
        why: null,
        since: ago(30),
        code: false,
      },
    ],
    omitted: 0,
  };
  const read: BringRead = { list, error: null, history: [] };
  const chosen = firstTicked(read);
  assert.deepEqual([...chosen], ['a<b>.md']);
  const files = (shown: Lab, ticks: ReadonlySet<string>): string =>
    renderToStaticMarkup(
      <BringFiles
        lab={shown}
        list={list}
        agentName="claude-1"
        chosen={ticks}
        onTick={() => {}}
        diffs={new Map()}
        onDiff={() => {}}
        onLook={() => {}}
        lookBusy={false}
      />,
    );
  const html = files(lab(), chosen);
  // The code file is unticked first and carries the warning, tied to its box.
  assert.match(
    html,
    /<input type="checkbox" id="([^"]+)" aria-describedby="\1-code"\/><label for="\1"><code>\.githooks\/pre-commit<\/code>/,
  );
  assert.match(
    html,
    /class="bring-file__code">This file can run code on your computer\./,
  );
  assert.ok(html.includes(codeWarning));
  // Ticking it makes the warning stand out.
  assert.match(
    files(lab(), new Set(['.githooks/pre-commit'])),
    /class="bring-file__code bring-file__code--ticked">/,
  );
  // A name is text, never markup.
  assert.match(html, /<code>a&lt;b&gt;\.md<\/code>/);
  assert.match(
    html,
    /type="checkbox" id="[^"]+" checked=""\/><label for="[^"]+"><code>a&lt;b&gt;/,
  );
  // Verifold's own records stay out, with the reason.
  assert.match(
    text(html),
    /Stays out: \.Verifold\/lab\.json Verifold's own records stay out\./,
  );
  // A file that came in with this content is done: its box is off.
  assert.match(
    html,
    /type="checkbox" id="[^"]+" disabled=""\/><label for="[^"]+"><code>done\.md/,
  );
  assert.match(text(html), /Brought in at /);
  assert.match(
    text(html),
    /Left out of this commit, so they cannot come in: shared\.md/,
  );
  assert.match(
    text(html),
    /claude-1 is working, so these are its files as of its last turn\./,
  );
  assert.match(html, />Show the newer files<\/button>/);

  // Without the lab's agents here, nothing can be ticked or looked at again.
  const viewing = files(lab({ agentsHere: false }), chosen);
  assert.equal((viewing.match(/disabled=""/g) ?? []).length, 3);
  assert.doesNotMatch(viewing, /Show the newer files/);

  const history = renderToStaticMarkup(
    <BringHistory
      history={[
        {
          at: ago(20),
          commit: 'd'.repeat(40),
          paths: ['a.md', 'b.md'],
          more: 3,
        },
      ]}
    />,
  );
  assert.match(
    text(history),
    /Brought in .*a\.md, b\.md and 3 more at ddddddd/,
  );
});

await test('the bring-in page opens from the answer, and reads its files when it opens', () => {
  const html = render(snapshot(), '#/d/d-1/bring');
  assert.match(html, /href="#\/answer"/);
  assert.match(
    html,
    /<h1 class="bring-head__title">The CoT names what drives the answer<\/h1>/,
  );
  assert.match(text(html), /Reading the files…/);
  // A direction that the lab does not have.
  assert.match(
    text(render(snapshot(), '#/d/d-9/bring')),
    /This direction is not in the lab/,
  );
});

await test('routes, links, and the reads and actions of the answer and bring-in pages', async (t) => {
  assert.deepEqual(parseRoute('#/answer'), { page: 'answer' });
  assert.deepEqual(parseRoute('#/d/d-2/bring'), {
    page: 'bring',
    direction: 'd-2',
  });
  assert.deepEqual(parseRoute('#/d/../bring'), { page: 'unknown' });
  assert.equal(href.bring('d-2'), '#/d/d-2/bring');
  assert.equal(paths.bring('d-2'), '/api/v1/directions/d-2/bring');
  assert.equal(
    paths.bringDiff('d-2', 'a b&c.md', 'c'.repeat(40)),
    `/api/v1/directions/d-2/bring/diff?file=a+b%26c.md&commit=${'c'.repeat(40)}`,
  );
  assert.ok(isBringRead({ list: null, error: null, history: [] }));
  assert.ok(!isBringRead({ list: { files: [] }, error: null, history: [] }));
  assert.ok(isFileDiff({ text: '+a', trimmed: false, commit: 'c' }));
  assert.ok(!isFileDiff({ text: '+a' }));

  // Without a token each one is refused at once.
  const none = answerActions(null);
  assert.ok('refused' in (await none.signOff('', 'k')));
  assert.ok('refused' in (await none.bring('d-1', 'c', ['a'], 'k')));
  assert.ok('error' in (await none.read('d-1')));

  // With one, they send the desk's actions with the person's key.
  const sent: unknown[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => {
    sent.push([
      url,
      init?.method ?? 'GET',
      typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    ]);
    return Promise.resolve(
      url.endsWith('/bring')
        ? new Response(JSON.stringify({ list: null, error: null, history: [] }))
        : new Response('{"ok":true}'),
    );
  });
  const some = answerActions('t');
  await some.signOff('', 'k1');
  await some.signOff('Partly yes.', 'k2');
  await some.look('d-1', 'k3');
  await some.bring('d-1', 'c'.repeat(40), ['a.md'], 'k4');
  assert.deepEqual(await some.read('d-1'), {
    value: { list: null, error: null, history: [] },
  });
  assert.deepEqual(sent, [
    ['/api/v1/actions/lab-signoff', 'POST', { key: 'k1' }],
    ['/api/v1/actions/lab-signoff', 'POST', { note: 'Partly yes.', key: 'k2' }],
    ['/api/v1/actions/lab-bring-look', 'POST', { direction: 'd-1', key: 'k3' }],
    [
      '/api/v1/actions/lab-bring',
      'POST',
      { direction: 'd-1', commit: 'c'.repeat(40), files: ['a.md'], key: 'k4' },
    ],
    ['/api/v1/directions/d-1/bring', 'GET', null],
  ]);
});

await test('the lab home links to the answer, and a bring-in refreshes when its direction or a bring-in action changes', () => {
  const home = render(snapshot(), '#/');
  assert.match(
    home,
    /<a class="section__link" href="#\/answer">The answer so far<\/a>/,
  );
  assert.match(
    render(
      snapshot({ signoff: { at: ago(5), note: null, directions: [] } }),
      '#/',
    ),
    /href="#\/answer">The answer<\/a>/,
  );

  const shown = lab();
  const d1 = shown.directions[0];
  assert.ok(d1);
  const base = bringKey(shown, d1);
  assert.notEqual(bringKey(shown, { ...d1, head: 'e5f6a7b' }), base);
  assert.notEqual(
    bringKey(shown, { ...d1, brought: { files: 3, lastAt: ago(1) } }),
    base,
  );
  const working = lab({
    works: [
      {
        action: 'lab-bring',
        label: 'Bringing in the files',
        at: ago(1),
        error: null,
      },
      {
        action: 'lab-call-answer',
        label: 'Applying your answer',
        at: ago(2),
        error: null,
      },
    ],
  });
  assert.notEqual(bringKey(working, d1), base);
  assert.equal(bringWork(working)?.label, 'Bringing in the files');
  assert.equal(bringWork(shown), null);
  assert.equal(
    broughtLine(d1),
    `2 files brought in, last at ${clock(ago(20))}`,
  );
  assert.equal(broughtLine({ ...d1, brought: null }), null);
});
