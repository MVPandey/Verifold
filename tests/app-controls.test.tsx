import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Agent,
  Call,
  CheckItem,
  Direction,
  Lab,
  Post,
  Run,
  RunDetail,
  Snapshot,
  Work,
} from '../src/protocol/api.ts';
import { checkWords } from '../src/app/answer.ts';
import {
  isDirectionDiff,
  isRunDetail,
  load,
  paths,
  type Loaded,
} from '../src/app/api.ts';
import { Screen } from '../src/app/App.tsx';
import {
  byNumber,
  filledPosts,
  joinPosts,
  type OlderPosts,
} from '../src/app/board.ts';
import { intentFor, unansweredAfter } from '../src/app/intent.ts';
import {
  ControlsContext,
  labControls,
  type LabControls,
} from '../src/app/controls.ts';
import { controls } from './app-controls-fixture.ts';
import {
  enterCompletes,
  insertMention,
  mentionLimit,
  mentionMatches,
  mentionNames,
  mentionQuery,
} from '../src/app/mentions.ts';
import { href, parseRoute } from '../src/app/route.ts';
import {
  followRun,
  retryAfter,
  runState,
  runTimes,
  runWhere,
  size,
} from '../src/app/runs.ts';
import { lineKinds } from '../src/app/screens/DiffPage.tsx';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
import type { LabActions } from '../src/app/screens/LabHome.tsx';
import { labHours, validHours } from '../src/app/screens/Notice.tsx';
import { proofHref } from '../src/app/components/BoardThread.tsx';
import { sameSend, type Send } from '../src/app/components/Composer.tsx';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

function agent(
  id: string,
  handle: string,
  harness: 'claude' | 'codex',
  fields: Partial<Agent> = {},
): Agent {
  return {
    id,
    handle,
    harness,
    model: harness === 'claude' ? 'claude-opus-5-5[1m]' : 'gpt-6-astra',
    direction: null,
    check: null,
    status: 'idle',
    until: null,
    live: { state: 'idle', text: 'Idle', since: null },
    turns: { turns: [], more: false },
    spendUsd: null,
    ...fields,
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
    runs: null,
    noise: null,
    buildsOn: [],
    state: 'open',
    verdict: 'open',
    disputed: false,
    evidence: null,
    agent: agentId,
    openedBy: 'a-0',
    openedAt: ago(180),
    stoppedAt: null,
    head: 'a3f9c2e',
    ...fields,
  };
}

function post(
  id: string,
  author: string,
  kind: Post['kind'],
  text: string,
  fields: Partial<Post> = {},
): Post {
  return {
    id,
    at: ago(70),
    author,
    handle: author === 'a-2' ? 'claude-2' : author === 'a-3' ? 'codex-1' : null,
    harness: author === 'a-2' ? 'claude' : author === 'a-3' ? 'codex' : null,
    kind,
    direction: 'd-2',
    text,
    replyTo: null,
    mentions: [],
    proof: [],
    ...fields,
  };
}

function run(id: string, fields: Partial<Run> = {}): Run {
  return {
    id,
    agent: 'a-2',
    direction: 'd-2',
    status: 'done',
    command: 'python probe_train.py --seed 1',
    why: 'Seed 1 of the bar.',
    where: 'local',
    commit: 'a3f9c2e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7',
    exitCode: 0,
    queuedAt: ago(90),
    startedAt: ago(88),
    endedAt: ago(69),
    metrics: { gap: 0.34, loss: null },
    note: null,
    ...fields,
  };
}

const checker: CheckItem = {
  id: 'k-1',
  post: 'p-9',
  direction: 'd-2',
  run: 'r-3',
  harness: 'codex',
  agent: 'a-7',
  handle: 'codex-2',
  sameHarness: false,
  blind: true,
  state: 'done',
  outcome: 'holds',
  method: 'rerun',
  result: 'p-20',
  note: null,
  queuedAt: ago(60),
  startedAt: ago(58),
  endedAt: ago(40),
};

function story(fields: Partial<Lab> = {}): Snapshot {
  const lab: Lab = {
    question: 'Can cheap training make the CoT faithful?',
    postLimit: 4000,
    startedAt: ago(600),
    agentsHere: true,
    paused: null,
    budget: null,
    money: { plansUsd: 3.1, gpuUsd: 4.2, gpuLimitUsd: 25 },
    needsYou: [],
    answered: [],
    directions: [
      direction('d-2', 'The CoT matches what probes read inside', 'a-2', {
        evidence: { text: 'Gap 34% smaller', post: 'p-9', run: 'r-3' },
      }),
      direction('d-3', 'The answer follows what the CoT says', 'a-3'),
      direction('d-5', 'An old line of attack', 'a-5', {
        state: 'stopped',
        verdict: 'ruled-out',
      }),
    ],
    agents: [
      agent('a-2', 'claude-2', 'claude', { direction: 'd-2' }),
      agent('a-3', 'codex-1', 'codex', { direction: 'd-3' }),
      agent('a-5', 'claude-5', 'claude', { direction: 'd-5' }),
      agent('a-7', 'codex-2', 'codex', { check: 'k-1' }),
    ],
    plan: null,
    board: {
      posts: [
        post('p-9', 'a-2', 'claim', 'The gap is 34% smaller on seed 1.', {
          proof: [
            { type: 'run', run: 'r-3' },
            {
              type: 'diff',
              direction: null,
              from: 'a'.repeat(40),
              to: 'b'.repeat(40),
              paths: ['probe.py'],
            },
          ],
        }),
        post('p-10', 'a-3', 'objection', 'One seed can be luck.', {
          replyTo: 'p-9',
        }),
      ],
      more: true,
    },
    disputes: [{ post: 'p-9', objections: ['p-10'], check: 'k-1' }],
    runs: [run('r-3')],
    checks: [checker],
    signoff: null,
    works: [],
    away: null,
    omitted: {},
    ...fields,
  };
  return {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 3,
    at: ago(0),
    project: 'CoT faithfulness',
    lab,
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
  skip: ok,
  questions: ok,
};
const agentStub: AgentActions = {
  message: ok,
  turns: () => Promise.resolve({ error: 'not in this test' }),
  turn: () => Promise.resolve({ error: 'not in this test' }),
  thread: () => Promise.resolve({ error: 'not in this test' }),
};
/** The page for a route, with the lab's controls or, as a tab without a token, without them. */
function render(
  snapshot: Snapshot,
  hash: string,
  given: LabControls | null = controls,
): string {
  return renderToStaticMarkup(
    <ControlsContext.Provider value={given}>
      <Screen
        state={{ snapshot, connection: 'live', retrying: false }}
        route={parseRoute(hash)}
        now={now}
        actions={actions}
        agentActions={agentStub}
      />
    </ControlsContext.Provider>,
  );
}

/** Visible text, with tags removed and entities decoded, so assertions read as the page reads. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

await test('routes: a run, an agent and its turns, a diff with or without a proof, and a figure', () => {
  assert.deepEqual(parseRoute(href.runPage('r-12')), {
    page: 'run',
    id: 'r-12',
  });
  assert.deepEqual(parseRoute(href.agent('a-7')), { page: 'agent', id: 'a-7' });
  assert.deepEqual(parseRoute(href.agentTurn('a-7', '0a1b2c3d.toolu_01#2')), {
    page: 'agent-turn',
    agent: 'a-7',
    turn: '0a1b2c3d.toolu_01#2',
  });
  assert.deepEqual(parseRoute(href.diff('d-2')), {
    page: 'diff',
    direction: 'd-2',
  });
  assert.deepEqual(parseRoute(href.diff('d-2', 'p-9.1')), {
    page: 'diff',
    direction: 'd-2',
    proof: 'p-9.1',
  });
  assert.deepEqual(parseRoute(href.figure('p-9.0')), {
    page: 'figure',
    proof: 'p-9.0',
  });
  for (const hash of [
    '#/run/r-0',
    '#/run/x-1',
    '#/agent/a-0',
    '#/agent/a-7/turn/not-a-turn',
    '#/d/d-2/diff/p-9',
    '#/d/d-2/diff/p-9.10',
    '#/d/../diff',
    '#/figure/p-9',
    '#/figure/p-9.10',
    '#/figure/results/fig.png',
    '#/figure/..',
  ])
    assert.deepEqual(parseRoute(hash), { page: 'unknown' }, hash);
});

await test('the message box completes open agents, open directions and @all, and puts a name in with one space after it', () => {
  const lab = story().lab;
  assert.ok(lab);
  const names = mentionNames(lab);
  assert.deepEqual(
    names.map((name) => name.value),
    ['@claude-2', '@codex-1', '@d-2', '@d-3', '@all'],
  );
  assert.equal(
    names[0]?.note,
    'Claude, The CoT matches what probes read inside',
  );
  // A name starts after a space or at the start, never inside a word such as an email address.
  assert.deepEqual(mentionQuery('ask @cl', 7), { start: 4, query: 'cl' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(mentionQuery('me@cl', 5), null);
  assert.equal(mentionQuery('ask @cl now', 11), null);
  assert.deepEqual(
    mentionMatches(names, 'CL').map((name) => name.value),
    ['@claude-2'],
  );
  assert.deepEqual(
    mentionMatches(names, 'd-').map((name) => name.value),
    ['@d-2', '@d-3'],
  );
  const many = Array.from({ length: 20 }, (_, index) => ({
    value: `@d-${index}`,
    note: '',
  }));
  assert.equal(mentionMatches(many, 'd').length, mentionLimit);
  assert.deepEqual(insertMention('ask @cl', 4, 7, '@claude-2'), {
    text: 'ask @claude-2 ',
    caret: 14,
  });
  // Text after the caret keeps its own space.
  assert.deepEqual(insertMention('ask @cl now', 4, 7, '@claude-2'), {
    text: 'ask @claude-2 now',
    caret: 14,
  });
});

await test('a run reads in plain words: its state, its times, where it ran, and file sizes', () => {
  assert.equal(runState(run('r-1'), now), 'Done in 19 min');
  assert.equal(
    runState(run('r-1', { exitCode: 2 }), now),
    'Ended with exit 2 after 19 min',
  );
  assert.equal(
    runState(run('r-1', { status: 'running', endedAt: null }), now),
    'Running for 1 h 28 min',
  );
  assert.equal(
    runState(
      run('r-1', { status: 'queued', startedAt: null, endedAt: null }),
      now,
    ),
    'Waits to start · 1 h 30 min',
  );
  assert.equal(
    runState(run('r-1', { status: 'failed', exitCode: null }), now),
    'Failed after 19 min',
  );
  assert.equal(
    runState(run('r-1', { status: 'timed-out', exitCode: null }), now),
    'Stopped at its time limit after 19 min',
  );
  assert.equal(runState(run('r-1', { status: 'cancelled' }), now), 'Cancelled');
  assert.match(runTimes(run('r-1')), /^Started \d\d:\d\d, ended \d\d:\d\d\.$/);
  assert.match(
    runTimes(run('r-1', { startedAt: null, endedAt: null })),
    /^Queued \d\d:\d\d\.$/,
  );
  assert.equal(runWhere(run('r-1')), 'This computer');
  assert.equal(
    runWhere(run('r-1', { where: { pod: 'pod-1', gpu: 'H100 SXM' } })),
    'Pod pod-1 (H100 SXM)',
  );
  assert.equal(size(820), '820 B');
  assert.equal(size(14 * 1024), '14 KB');
  assert.equal(size(3.2 * 1024 * 1024), '3.2 MB');
});

await test('the run page shows the run from the snapshot while its read loads, and says when a view leaves the run out', () => {
  const page = text(render(story(), href.runPage('r-3')));
  assert.match(page, /The CoT matches what probes read inside/);
  assert.match(page, /Run r-3 Done in 19 min/);
  assert.match(page, /Command python probe_train\.py --seed 1/);
  assert.match(page, /Why Seed 1 of the bar\./);
  assert.match(page, /Commit a3f9c2e1b2c3/);
  assert.match(page, /Where This computer/);
  assert.match(page, /Ran by claude-2 · Claude/);
  assert.match(page, /Metrics Name Value gap 0\.34 loss Not a number/);
  const html = render(story(), href.runPage('r-3'));
  // The way back marks the run on its direction's page.
  assert.match(html, /href="#\/d\/d-2\/run\/r-3"/);
  assert.match(html, /href="#\/agent\/a-2"/);
  // No Cancel before the read says the run can be cancelled.
  assert.doesNotMatch(page, /Cancel the run/);
  assert.match(
    text(render(story(), href.runPage('r-40'), null)),
    /This view of the lab leaves out this run\./,
  );
  assert.match(text(render(story(), href.runPage('r-40'))), /Reading the run…/);
});

await test("the direction page's menu opens its changes, and stops it only where Verifold runs the agents", () => {
  const html = render(story(), href.direction('d-2'));
  assert.match(html, /aria-label="More actions"/);
  assert.match(html, /href="#\/d\/d-2\/diff"[^>]*>Files and changes/);
  assert.match(text(html), /Stop this direction/);
  // A tab without controls, a lab that only shows here, and a stopped direction have no Stop.
  assert.doesNotMatch(
    text(render(story(), href.direction('d-2'), null)),
    /Stop this direction/,
  );
  const shown = story();
  assert.ok(shown.lab);
  assert.doesNotMatch(
    text(
      render(
        { ...shown, lab: { ...shown.lab, agentsHere: false } },
        href.direction('d-2'),
      ),
    ),
    /Stop this direction/,
  );
  assert.doesNotMatch(
    text(render(story(), href.direction('d-5'))),
    /Stop this direction/,
  );
});

await test('an agent that stopped by itself too often can start again from its line, also while its call waits', () => {
  const agents = [
    agent('a-2', 'claude-2', 'claude', {
      direction: 'd-2',
      status: 'crashed',
      live: {
        state: 'ended',
        text: 'Stopped by itself too often',
        since: ago(5),
      },
    }),
  ];
  const crashed = story({ agents });
  const page = text(render(crashed, href.direction('d-2')));
  assert.match(page, /Stopped by itself too often Start again/);
  assert.doesNotMatch(
    text(render(crashed, href.direction('d-2'), null)),
    /Start again/,
  );
  // The call stays open for the person, and the agent hears the answer when it starts again.
  const waiting: Call = {
    id: 'c-4',
    at: ago(3),
    kind: 'access',
    question: 'Let me install scikit-learn?',
    why: 'The probes need it.',
    askers: [
      {
        agent: 'a-2',
        handle: 'claude-2',
        direction: 'd-2',
        why: 'The probes need it.',
      },
    ],
    byVerifold: false,
    options: [
      { label: 'Allow', usd: null, minutes: null, effect: null },
      { label: 'Deny', usd: null, minutes: null, effect: null },
    ],
    pick: 0,
    undoMinutes: 10,
    wordsLimit: 2000,
    applying: false,
    state: 'open',
    answer: null,
    words: null,
    undoUntil: null,
    note: null,
    post: 'p-12',
  };
  const both = text(
    render(story({ agents, needsYou: [waiting] }), href.direction('d-2')),
  );
  assert.match(both, /Waiting for your answer/);
  assert.match(both, /Stopped by itself too often Start again/);
});

await test('the lab home: open a direction, open disputes pinned, how a check went, older posts, and Reply', () => {
  const html = render(story(), href.lab);
  const page = text(html);
  assert.match(page, /Open a direction yourself/);
  assert.match(page, /Open the direction/);
  // The dispute: the post, its row, the first doubt, and where its check is.
  assert.match(
    page,
    /Disputed p-9 by claude-2, the evidence of The CoT matches what probes read inside ?: The gap is 34% smaller on seed 1\. codex-1 objects: One seed can be luck\. Codex reran it, and it held\. What codex-2 did/,
  );
  // How the check of a post with a run went, on the post itself.
  assert.match(
    page,
    /The gap is 34% smaller on seed 1\..*Codex reran it, and it held\. What codex-2 did/,
  );
  assert.match(html, /href="#\/agent\/a-7"/);
  // Proof chips lead to the run's page and to the diff that the post cites.
  assert.match(html, /<a class="proof" href="#\/run\/r-3">Run r-3<\/a>/);
  assert.match(
    html,
    /<a class="proof" href="#\/d\/d-2\/diff\/p-9\.1">Diff<\/a>/,
  );
  assert.match(page, /Show older posts/);
  assert.match(page, /Reply/);
  // The message box completes names.
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-autocomplete="list"/);
  // Without controls, none of them shows.
  const bare = text(render(story(), href.lab, null));
  assert.doesNotMatch(bare, /Open a direction yourself|Show older posts|Reply/);
});

await test('a proof chip leads to its run, its figure, its diff, or its direction, and a file is no link without one', () => {
  const lone = post('p-1', 'a-2', 'claim', 'x', { direction: null });
  assert.equal(proofHref(lone, { type: 'run', run: 'r-9' }, 0), '#/run/r-9');
  assert.equal(
    proofHref(
      lone,
      {
        type: 'file',
        direction: null,
        path: 'probe.py',
        commit: 'a3f9c2e',
        bytes: 9,
      },
      1,
    ),
    null,
  );
  const placed = post('p-2', 'a-2', 'claim', 'x');
  // A figure opens its own view, which Verifold finds by the post and the place.
  assert.equal(
    proofHref(
      lone,
      {
        type: 'figure',
        direction: null,
        path: 'gap.png',
        commit: 'a3f9c2e',
        bytes: 9,
      },
      0,
    ),
    '#/figure/p-1.0',
  );
  // A file leads to the direction that holds it.
  assert.equal(
    proofHref(
      placed,
      {
        type: 'file',
        direction: null,
        path: 'probe.py',
        commit: 'a3f9c2e',
        bytes: 9,
      },
      1,
    ),
    '#/d/d-2',
  );
});

await test('the figure page reads the figure with the lab controls, leads back to its post, and asks for Verifold without them', () => {
  const html = render(story(), href.figure('p-9.0'));
  const page = text(html);
  assert.match(page, /A figure/);
  assert.match(page, /Reading the figure…/);
  assert.match(html, /<a class="back" href="#\/post\/p-9">/);
  assert.match(page, /The post/);
  // A tab without a token reads nothing.
  const bare = text(render(story(), href.figure('p-9.0'), null));
  assert.match(bare, /Open this page from Verifold to see the figure\./);
  assert.doesNotMatch(bare, /Reading the figure/);
});

await test('the lab home offers more time when the budget ended, and lists background actions with one Dismiss for failures', () => {
  const works: Work[] = [
    {
      action: 'lab-direction-add',
      label: 'Opening "Probes on Gemma"',
      at: ago(1),
      error: null,
    },
    {
      action: 'lab-pause',
      label: 'Pausing the lab',
      at: ago(3),
      error: 'An agent did not park in time.',
    },
    // An answer's failure shows on its call, and a bring-in's on its page.
    {
      action: 'lab-call-answer',
      label: 'Applying your answer',
      at: ago(2),
      error: 'RunPod refused.',
      call: 'c-4',
    },
    {
      action: 'lab-bring',
      label: 'Bringing in the files',
      at: ago(2),
      error: 'A file changed.',
      direction: 'd-2',
    },
  ];
  const page = text(
    render(
      story({ paused: { at: ago(4), reason: 'deadline' }, works }),
      href.lab,
    ),
  );
  assert.match(page, /The time budget ended, so the lab is paused\./);
  assert.match(page, /Give 2 more hours Give 8 more hours/);
  assert.match(
    page,
    /Opening "Probes on Gemma"\. It started at \d\d:\d\d and goes on in the background\./,
  );
  assert.match(
    page,
    /Pausing the lab did not finish: An agent did not park in time\. Dismiss/,
  );
  assert.doesNotMatch(page, /RunPod refused|A file changed/);
  // A pause by the person gives no more time.
  assert.doesNotMatch(
    text(render(story({ paused: { at: ago(4), reason: 'person' } }), href.lab)),
    /more hours/,
  );
});

await test("a checker's page names its check and its turns, and an agent that the lab leaves out says so", () => {
  const page = text(render(story(), href.agent('a-7')));
  assert.match(
    page,
    /codex-2 Codex GPT-6 Astra · Checks p-9 in The CoT matches what probes read inside ?, without the author's reasoning/,
  );
  assert.match(page, /Codex reran it, and it held\./);
  assert.match(page, /codex-2 has no turns yet\./);
  assert.match(
    text(render(story(), href.agent('a-99'))),
    /This agent is not in the lab\./,
  );
  assert.match(
    text(render(story({ omitted: { agents: 3 } }), href.agent('a-99'))),
    /This view of a large lab leaves out this agent\./,
  );
});

await test("a checker's turn opens with a way back to the checker", () => {
  const html = render(story(), href.agentTurn('a-7', '0a1b2c3d.t1'));
  assert.match(html, /href="#\/agent\/a-7"/);
  assert.match(text(html), /codex-2 A turn of codex-2/);
});

await test("the diff page names what it shows, and lines read as added, removed, or a hunk's head", () => {
  assert.match(
    text(render(story(), href.diff('d-2'))),
    /Files and changes What this direction changed since it started\. Reading the changes…/,
  );
  assert.match(
    text(render(story(), href.diff('d-2', 'p-9.1'))),
    /The diff that p-9 cites The changes that p-9 points to as proof\./,
  );
  assert.match(
    text(render(story(), href.diff('d-2'), null)),
    /Open this page from Verifold to read its changes\./,
  );
  // `---` and `+++` name the files in a file's header. In a hunk they are removed and added lines.
  assert.deepEqual(
    lineKinds([
      'diff --git a/probe.py b/probe.py',
      'index 1111111..2222222 100644',
      '--- a/probe.py',
      '+++ b/probe.py',
      '@@ -1,3 +1,3 @@',
      ' context',
      '-old line',
      '+new line',
      '--- a removed line that starts with --',
      '+++ an added line that starts with ++',
      '\\ No newline at end of file',
      'diff --git a/gap.py b/gap.py',
      '--- a/gap.py',
      '+++ b/gap.py',
      '@@ -0,0 +1 @@',
      '+x = 1',
    ]),
    [
      null,
      null,
      null,
      null,
      'hunk',
      null,
      'del',
      'add',
      'del',
      'add',
      null,
      null,
      null,
      null,
      'hunk',
      'add',
    ],
  );
  // A diff without its header starts at its first hunk.
  assert.deepEqual(lineKinds(['@@ -1 +1 @@', '---x', '+++y']), [
    'hunk',
    'del',
    'add',
  ]);
});

await test('a lab start takes a question and whole hours within the limit', () => {
  assert.equal(validHours('8'), 8);
  assert.equal(validHours(' 24 '), 24);
  assert.equal(validHours(String(labHours.max)), labHours.max);
  for (const bad of ['0', '-1', '1.5', '', 'ten', String(labHours.max + 1)])
    assert.equal(validHours(bad), null, bad);
  const empty: Snapshot = {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 1,
    at: ago(0),
    project: 'cot',
    lab: null,
    trimmed: false,
    question: null,
  };
  const page = render(empty, href.lab);
  assert.match(
    text(page),
    /Your question .*Time budget, in hours .*Start the lab/,
  );
  assert.match(page, /value="8"/);
  assert.doesNotMatch(page, /open the desk|href="\/"/);
});

await test('the controls send the desk actions with their keys, and read with the token', async (t) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      init,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ posts: [], more: false }), { status: 200 }),
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const sent = labControls('t0k3n');
  await sent.addDirection(
    { title: 'Probes on Gemma', harness: 'codex', bar: '' },
    'k1',
  );
  await sent.addDirection(
    { title: 'Probes on Gemma', harness: 'claude', bar: 'beats 0.3' },
    'k2',
  );
  await sent.stopDirection('d-2', 'k3');
  await sent.restartAgent('a-2', 'k4');
  await sent.cancelRun('r-3', 'k5');
  await sent.moreTime(2, 'k6');
  const failure: Work = {
    action: 'lab-pause',
    label: 'Pausing the lab',
    at: '2026-10-20T21:57:00.000Z',
    error: 'An agent did not park in time.',
  };
  await sent.dismiss([failure], 'k7');
  await sent.reply('p-9', 'Which seed?', 'k8');
  const bodies = calls.map((call) => [
    call.url,
    JSON.parse(
      typeof call.init?.body === 'string' ? call.init.body : '',
    ) as unknown,
  ]);
  assert.deepEqual(bodies, [
    [
      '/api/v1/actions/lab-direction-add',
      { title: 'Probes on Gemma', harness: 'codex', key: 'k1' },
    ],
    [
      '/api/v1/actions/lab-direction-add',
      {
        title: 'Probes on Gemma',
        harness: 'claude',
        bar: 'beats 0.3',
        key: 'k2',
      },
    ],
    ['/api/v1/actions/lab-direction-stop', { direction: 'd-2', key: 'k3' }],
    ['/api/v1/actions/lab-agent-restart', { agent: 'a-2', key: 'k4' }],
    ['/api/v1/actions/lab-run-cancel', { run: 'r-3', key: 'k5' }],
    ['/api/v1/actions/lab-budget', { hours: 2, key: 'k6' }],
    // Only the action and its start name a failure.
    [
      '/api/v1/actions/lab-dismiss',
      {
        works: [{ action: 'lab-pause', at: '2026-10-20T21:57:00.000Z' }],
        key: 'k7',
      },
    ],
    [
      '/api/v1/actions/lab-post',
      { text: 'Which seed?', replyTo: 'p-9', key: 'k8' },
    ],
  ]);
  calls.length = 0;
  const board = await sent.board('p-9');
  assert.deepEqual(board, { value: { posts: [], more: false } });
  assert.equal(calls[0]?.url, '/api/v1/board?before=p-9');
  assert.deepEqual(calls[0]?.init?.headers, { Authorization: 'Bearer t0k3n' });
  assert.equal(paths.run('r-3'), '/api/v1/runs/r-3');
  assert.equal(paths.diff('d-2'), '/api/v1/directions/d-2/diff');
  assert.equal(
    paths.diff('d-2', { proof: 'p-9.1', file: 'src/a b.py' }),
    '/api/v1/directions/d-2/diff?proof=p-9.1&file=src%2Fa+b.py',
  );
  // A read that sends something else says so.
  assert.deepEqual(await sent.run('r-3'), {
    error: 'Verifold sent something this page cannot read. Reload it.',
  });
});

/** The lab of a story, which always has one. */
function labOf(snapshot: Snapshot): Lab {
  assert.ok(snapshot.lab);
  return snapshot.lab;
}

await test('older posts join the newest page with no post left out, and a gap reads the posts in between first', () => {
  const p = (n: number): Post => post(`p-${n}`, 'a-2', 'claim', `Post ${n}`);
  const ids = (posts: readonly Post[]): string[] =>
    posts.map((entry) => entry.id);
  const older: OlderPosts = {
    posts: [p(1), p(2), p(3)],
    more: true,
    anchor: 'p-4',
  };
  // The anchor is still on the newest page: one list, oldest first.
  assert.deepEqual(joinPosts(older, [p(4), p(5)]), {
    posts: [p(1), p(2), p(3), p(4), p(5)],
    gap: null,
  });
  // New posts pushed the anchor out: the newest page alone, until the posts between are read.
  const pushed = joinPosts(older, [p(8), p(9)]);
  assert.deepEqual(ids(pushed.posts), ['p-8', 'p-9']);
  assert.equal(pushed.gap, 'p-8');
  // The pages before p-8 reached the anchor, so the older posts end before p-8 now.
  const filled = filledPosts(
    older,
    [
      [p(6), p(7)],
      [p(4), p(5)],
    ],
    'p-8',
  );
  assert.ok(filled);
  assert.equal(filled.anchor, 'p-8');
  assert.equal(filled.more, true);
  assert.deepEqual(ids(joinPosts(filled, [p(8), p(9)]).posts), [
    'p-1',
    'p-2',
    'p-3',
    'p-4',
    'p-5',
    'p-6',
    'p-7',
    'p-8',
    'p-9',
  ]);
  // Pages that never reached the anchor give the older posts up.
  assert.equal(filledPosts(older, [[p(6), p(7)]], 'p-8'), null);
  // By number, so p-10 comes after p-9, and a post read twice shows once.
  assert.deepEqual(ids(byNumber([[p(10), p(9)], [p(9)]])), ['p-9', 'p-10']);
  assert.deepEqual(joinPosts(null, [p(1)]), { posts: [p(1)], gap: null });
});

await test('a run page reads a running run again, and after a failed read tries again, less often each time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const detail = (status: Run['status']): RunDetail => ({
    run: run('r-3', { status }),
    handle: 'claude-2',
    harness: 'claude',
    minutes: 30,
    outputs: [],
    moreOutputs: 0,
    log: null,
    cancelable: status === 'running',
  });
  const answers: Loaded<RunDetail>[] = [
    { error: 'one' },
    { error: 'two' },
    { error: 'three' },
    { value: detail('running') },
    { value: detail('done') },
  ];
  const shown: string[] = [];
  let reads = 0;
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };
  const wait = async (ms: number): Promise<void> => {
    t.mock.timers.tick(ms);
    await settle();
  };
  const controller = new AbortController();
  followRun(
    () => {
      reads++;
      return Promise.resolve(answers.shift() ?? { error: 'no more' });
    },
    (loaded) =>
      shown.push('error' in loaded ? loaded.error : loaded.value.run.status),
    controller.signal,
  );
  await settle();
  assert.deepEqual(shown, ['one']);
  // 5 s after the first failure, then 10 s, then 20 s.
  await wait(4_999);
  assert.equal(reads, 1);
  await wait(1);
  assert.deepEqual(shown, ['one', 'two']);
  await wait(9_999);
  assert.equal(reads, 2);
  await wait(1);
  assert.deepEqual(shown, ['one', 'two', 'three']);
  await wait(20_000);
  // A read that works goes back to every 5 s while the run runs.
  assert.deepEqual(shown, ['one', 'two', 'three', 'running']);
  await wait(5_000);
  assert.deepEqual(shown, ['one', 'two', 'three', 'running', 'done']);
  // A run that ended is not read again.
  await wait(60_000);
  assert.equal(reads, 5);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 10].map(retryAfter),
    [5_000, 10_000, 20_000, 30_000, 30_000, 30_000],
  );
  // An abort stops the reads, even after failures.
  const stopped = new AbortController();
  let tries = 0;
  followRun(
    () => {
      tries++;
      return Promise.resolve({ error: 'down' });
    },
    () => undefined,
    stopped.signal,
  );
  await settle();
  stopped.abort();
  await wait(60_000);
  assert.equal(tries, 1);
});

await test("a checker's page describes its own check, and a checker that the snapshot left out says it ended", () => {
  const base = labOf(story());
  // A newer check of the same post, by another checker, still runs.
  const newer: CheckItem = {
    ...checker,
    id: 'k-2',
    harness: 'claude',
    agent: 'a-8',
    handle: 'claude-9',
    state: 'running',
    outcome: null,
    result: null,
    endedAt: null,
  };
  assert.equal(checkWords(newer), 'Claude reruns it now');
  const two = story({
    checks: [checker, newer],
    agents: [...base.agents, agent('a-8', 'claude-9', 'claude')],
  });
  const own = text(render(two, href.agent('a-7')));
  assert.match(own, /Codex reran it, and it held\./);
  assert.doesNotMatch(own, /Claude reruns it now/);
  assert.match(
    text(render(two, href.agent('a-8'))),
    /claude-9 Claude .*Checks p-9 .*Claude reruns it now\./,
  );
  // The snapshot keeps only the newest checkers that ended, so codex-2 is not in it.
  const ended = story({
    agents: base.agents.filter((entry) => entry.id !== 'a-7'),
  });
  const gone = text(render(ended, href.agent('a-7')));
  assert.match(
    gone,
    /codex-2 Codex · Checks p-9 in The CoT matches what probes read inside ?, without the author's reasoning/,
  );
  assert.match(gone, /Codex reran it, and it held\./);
  assert.match(
    gone,
    /codex-2 ended\. This view shows only the newest checkers that ended, so it leaves out what codex-2 did\./,
  );
  // Nothing links to its page: not the post's check, and not the dispute.
  const home = render(ended, href.lab);
  assert.doesNotMatch(home, /href="#\/agent\/a-7"/);
  assert.match(text(home), /Codex reran it, and it held\./);
  // A run whose agent the snapshot leaves out names it without a link.
  const runPage = render(story({ agents: [] }), href.runPage('r-3'));
  assert.match(text(runPage), /Ran by a-2/);
  assert.doesNotMatch(runPage, /href="#\/agent\/a-2"/);
});

await test('Enter puts a name in only while the person typed the start of it, and a whole name comes first', () => {
  const names = [
    { value: '@d-10', note: '' },
    { value: '@d-1', note: '' },
    { value: '@claude-2', note: '' },
  ];
  assert.deepEqual(
    mentionMatches(names, 'd-1').map((name) => name.value),
    ['@d-1', '@d-10'],
  );
  const claude = { value: '@claude-2', note: '' };
  assert.equal(enterCompletes('cl', claude), true);
  assert.equal(enterCompletes('', claude), true);
  // The whole name is typed, so Enter sends.
  assert.equal(enterCompletes('claude-2', claude), false);
  assert.equal(enterCompletes('Claude-2', claude), false);
  // The person moved to a longer name: Enter puts it in.
  assert.equal(enterCompletes('d-1', { value: '@d-10', note: '' }), true);
});

await test('a send after a lost answer keeps its key only for the same text to the same post', () => {
  let made = 0;
  const key = (): string => `k${++made}`;
  const first = intentFor<Send>(
    null,
    { text: 'Which seed?', to: 'p-9' },
    key,
    sameSend,
  );
  const lost = unansweredAfter(first, { lost: 'Verifold did not answer.' });
  assert.equal(
    intentFor(lost, { text: 'Which seed?', to: 'p-9' }, key, sameSend).key,
    first.key,
  );
  // The same words as a reply to another post, or to the lab, are another intent.
  assert.notEqual(
    intentFor(lost, { text: 'Which seed?', to: 'p-10' }, key, sameSend).key,
    first.key,
  );
  assert.notEqual(
    intentFor(lost, { text: 'Which seed?', to: null }, key, sameSend).key,
    first.key,
  );
});

await test("a read that Verifold refuses shows Verifold's own reason when it gave one", async (t) => {
  const answers: Response[] = [
    Response.json({ error: 'p-9 cites no diff.' }, { status: 404 }),
    Response.json({ error: 'Name a run such as r-3.' }, { status: 400 }),
    new Response(null, { status: 404 }),
    new Response('not json', { status: 500 }),
  ];
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(answers.shift() ?? new Response(null, { status: 500 }));
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.deepEqual(
    await load('tok', paths.diff('d-2', { proof: 'p-9.0' }), isDirectionDiff),
    { error: 'p-9 cites no diff.' },
  );
  assert.deepEqual(await load('tok', paths.run('r-0'), isRunDetail), {
    error: 'Name a run such as r-3.',
  });
  assert.deepEqual(await load('tok', paths.run('r-9'), isRunDetail), {
    error: 'Verifold no longer has this. The lab may have moved on.',
  });
  assert.deepEqual(await load('tok', paths.run('r-9'), isRunDetail), {
    error: 'Verifold could not send this. Try again.',
  });
});
