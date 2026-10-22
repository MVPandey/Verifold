import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type {
  Agent,
  AgentTool,
  Call,
  Direction,
  Lab,
  Post,
  SetupView,
  Snapshot,
  StartView,
} from '../src/protocol/api.ts';
import {
  agentsLabel,
  dueLabel,
  gpuLabel,
  isStartView,
  startedAfterLost,
  teamOrder,
  validFolder,
  validHours,
  withUse,
  type StartActions,
} from '../src/app/ask.ts';
import { threads } from '../src/app/board.ts';
import { intentFor, unansweredAfter } from '../src/app/intent.ts';
import { href, parseRoute } from '../src/app/route.ts';
import { Screen } from '../src/app/App.tsx';
import { BoardThread } from '../src/app/components/BoardThread.tsx';
import {
  FactsList,
  sourceLink,
  sourceName,
} from '../src/app/components/FactsList.tsx';
import { dayClock } from '../src/app/format.ts';
import { QuestionCard } from '../src/app/components/QuestionCard.tsx';
import { AskForm } from '../src/app/screens/AskPage.tsx';
import type { AgentActions } from '../src/app/screens/DirectionPage.tsx';
import { LabHome, type LabActions } from '../src/app/screens/LabHome.tsx';
import { NoLab } from '../src/app/screens/Notice.tsx';
import {
  answerOf,
  planQuestions,
  sameAnswers,
} from '../src/app/screens/Scoping.tsx';
import { openingRoute, pageRoute } from '../src/app/screens/Setup.tsx';
import type { SetupActions } from '../src/app/setup.ts';

/** A fixed "now": Tuesday 2026-10-20, 22:00 UTC. */
const now = Date.UTC(2026, 9, 20, 22, 0);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

/** The visible text of a render, without tags. */
function text(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const claude: AgentTool = {
  harness: 'claude',
  installed: true,
  version: '2.1.304',
  signedIn: true,
  plan: 'max',
  use: true,
  model: 'opus[1m]',
  models: [
    { id: 'opus[1m]', label: 'Opus, 1M context (your Claude Code default)' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
};

const codex: AgentTool = {
  harness: 'codex',
  installed: true,
  version: '0.160.0',
  signedIn: true,
  plan: null,
  use: true,
  model: 'gpt-6-astra',
  models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra, the most capable' }],
};

function setupView(fields: Partial<SetupView> = {}): SetupView {
  return {
    steps: { agents: 'done', about: 'done', money: 'done' },
    agents: { checking: false, tools: [claude, codex] },
    about: {
      lines: [],
      card: null,
      saved: null,
      text: null,
      harness: 'claude',
      busy: null,
      error: null,
      limits: { answer: 2000, workOn: 600, explore: 1000, talk: 400 },
    },
    money: {
      key: null,
      keyring: true,
      prices: null,
      reading: false,
      problem: null,
      limits: {
        limitUsd: 25,
        maxUsdPerHour: 4,
        maxHoursPerLease: 4,
        idleMinutes: 15,
        maxRunningPods: 1,
        gpuTypes: [],
      },
      unreadable: null,
    },
    ...fields,
  };
}

const actions: LabActions = {
  post: () => Promise.resolve({ ok: true }),
  pause: () => Promise.resolve({ ok: true }),
  answer: () => Promise.resolve({ ok: true }),
  words: () => Promise.resolve({ ok: true }),
  undo: () => Promise.resolve({ ok: true }),
  skip: () => Promise.resolve({ ok: true }),
  questions: () => Promise.resolve({ ok: true }),
};

const agentActions: AgentActions = {
  message: () => Promise.resolve({ ok: true }),
  turns: () => Promise.resolve({ error: 'not in this test' }),
  turn: () => Promise.resolve({ error: 'not in this test' }),
  thread: () => Promise.resolve({ error: 'not in this test' }),
};

const where: StartView = {
  folder: '~/research/cot-faithfulness',
  files: true,
  hours: 8,
  maxHours: 168,
  questionLimit: 4000,
  agents: {
    host: 'claude',
    model: 'opus[1m]',
    helper: 'codex',
    helperModel: 'gpt-6-astra',
  },
  gpuUsd: 25,
  gpuLimits: true,
  started: false,
};

const start: StartActions = {
  read: () => Promise.resolve({ value: where }),
  start: () => Promise.resolve({ ok: true, pending: true }),
};

await test("the Ask chips show the project's defaults as Verifold sends them: its agents with their models, the GPU limit, and when the answer is due", () => {
  assert.equal(
    agentsLabel({
      host: 'claude',
      model: 'opus[1m]',
      helper: 'codex',
      helperModel: 'gpt-6-astra',
    }),
    'Claude Opus (1M) and Codex GPT-6 Astra',
  );
  // A harness without a saved model runs its own default, so the chip names no model.
  assert.equal(
    agentsLabel({ host: 'claude', helper: 'codex' }),
    'Claude Code and Codex',
  );
  assert.equal(agentsLabel({ host: 'codex' }), 'Codex');
  assert.equal(gpuLabel(25), 'GPUs up to $25');
  assert.equal(gpuLabel(null), 'No GPUs');
  // The weekday and hour follow this computer's time zone.
  assert.match(dueLabel(8, now), /^Answer by (Tue|Wed) \d\d:00$/);
  assert.equal(validFolder('/Users/me/research'), true);
  assert.equal(validFolder('~/research/new'), true);
  assert.equal(validFolder('research/new'), false);
  assert.equal(isStartView(where), true);
  assert.equal(isStartView({ ...where, agents: null, gpuUsd: null }), true);
  // A view without the defaults cannot show what Start sends.
  assert.equal(
    isStartView({
      folder: 'x',
      files: false,
      hours: 8,
      maxHours: 168,
      questionLimit: 4000,
    }),
    false,
  );
  assert.deepEqual(parseRoute('#/ask'), { page: 'ask' });
});

await test('a change to the agents keeps the lead first: a harness that joins helps, and a model that the person leaves alone stays the harness default', () => {
  const codexLeads = { host: 'codex', helper: 'claude' } as const;
  // The editor lists the team in its order, the lead first.
  assert.deepEqual(
    teamOrder([claude, codex], codexLeads).map((tool) => tool.harness),
    ['codex', 'claude'],
  );
  assert.deepEqual(
    teamOrder([claude, codex], { host: 'claude' }).map((tool) => tool.harness),
    ['claude', 'codex'],
  );
  // A model for the helper leaves the lead as it was.
  assert.deepEqual(withUse(codexLeads, 'claude', true, 'sonnet'), {
    host: 'codex',
    helper: 'claude',
    helperModel: 'sonnet',
  });
  // A harness that joins helps the lead, with no model of its own.
  assert.deepEqual(withUse({ host: 'codex' }, 'claude', true), {
    host: 'codex',
    helper: 'claude',
  });
  assert.deepEqual(withUse(null, 'codex', true), { host: 'codex' });
  // "Its own default model" sends no model.
  assert.deepEqual(
    withUse({ host: 'claude', model: 'opus[1m]' }, 'claude', true, ''),
    { host: 'claude' },
  );
  // When the lead leaves, its helper leads.
  assert.deepEqual(withUse(codexLeads, 'codex', false), { host: 'claude' });
  assert.equal(withUse({ host: 'claude' }, 'claude', false), null);
});

await test('the hours box takes whole hours in range from what the person typed, and a lost Start asks Verifold whether the project started', () => {
  assert.equal(validHours('12', 168), 12);
  assert.equal(validHours(' 24 ', 168), 24);
  for (const typed of ['', ' ', '0', '169', '1.5', '-2', '1e2', 'eight'])
    assert.equal(validHours(typed, 168), null, typed);
  assert.equal(startedAfterLost({ value: { ...where, started: true } }), true);
  assert.equal(startedAfterLost({ value: where }), false);
  // A Verifold that no longer answers handed the project on.
  assert.equal(startedAfterLost({ error: 'Verifold does not answer.' }), true);
});

/** The Ask page with Verifold's defaults, and the profile's read or why it failed. */
function ask(
  fields: Partial<StartView> = {},
  profileError: string | null = null,
): ReactElement {
  return (
    <AskForm
      where={{ ...where, ...fields }}
      tools={profileError ? null : [claude, codex]}
      profileError={profileError}
      onRetry={() => {}}
      start={start}
      now={now}
      connection="live"
    />
  );
}

await test("the Ask page shows Verifold's defaults: the lead that it chose, the GPU limit, the folder that the agents may read, and what Start does", () => {
  const page = text(ask());
  assert.match(page, /What do you want to find out\?/);
  assert.match(
    page,
    /Claude Opus \(1M\) and Codex GPT-6 Astra GPUs up to \$25 Answer by (Tue|Wed) \d\d:00/,
  );
  assert.match(
    page,
    /These come from your profile\. Click one to change it for this project only\./,
  );
  assert.match(
    page,
    /In ~\/research\/cot-faithfulness\. The agents may read the files in it\. · Change/,
  );
  assert.match(
    page,
    /The planner first checks current facts, such as the newest models and today's GPU prices, and may ask you up to three questions\. No GPU is rented until you say yes\./,
  );
  // The canvas's "or say it in the question" is left out: no question changes a limit.
  assert.doesNotMatch(page, /say it in the question/);
  assert.doesNotMatch(page, /could not read your profile/);
  const html = renderToStaticMarkup(ask());
  // Start waits for a question.
  assert.match(
    html,
    /<button type="submit"[^>]*disabled=""[^>]*>Start<\/button>/,
  );
  assert.match(html, /aria-expanded="false"/);
  // An empty folder says nothing of files.
  assert.doesNotMatch(text(ask({ files: false })), /may read the files/);
  // Only Codex is signed in, so Verifold makes it the lead, and the chip shows it.
  assert.match(
    text(ask({ agents: { host: 'codex' }, gpuUsd: null, gpuLimits: false })),
    /Codex No GPUs Answer by/,
  );
  // The limit that Verifold sends shows, also when the first run skipped the GPU step.
  assert.match(text(ask({ gpuUsd: 40 })), /GPUs up to \$40/);
  assert.match(text(ask({ agents: null })), /Choose an agent/);
});

await test("an unreadable profile does not stop the Ask page: the person asks with Verifold's defaults, sees why, and can read the profile again", () => {
  const page = text(ask({}, 'settings.json is not valid JSON.'));
  assert.match(
    page,
    /Verifold could not read your profile: settings\.json is not valid JSON\. This project starts with the settings above\. Try again/,
  );
  assert.match(
    page,
    /Claude Opus \(1M\) and Codex GPT-6 Astra GPUs up to \$25/,
  );
  assert.match(page, /What do you want to find out\?/);
});

await test('the first run waits for the first snapshot before it leads anywhere, and without a project it ends on the Ask page', () => {
  const done = setupView();
  // Before the first snapshot, nobody knows whether a project exists.
  assert.equal(openingRoute(done, null, null), null);
  assert.equal(openingRoute(null, null, ''), null);
  assert.equal(openingRoute(done, null, ''), href.ask);
  assert.equal(openingRoute(done, null, 'cot'), href.setup('done'));
  // A step that the person opened stays open.
  assert.equal(openingRoute(done, 'agents', ''), null);
  assert.equal(
    openingRoute(
      setupView({ steps: { agents: 'done', about: null, money: null } }),
      null,
      '',
    ),
    href.setup('about'),
  );
  assert.equal(pageRoute('done', ''), href.ask);
  assert.equal(pageRoute('done', 'cot'), href.setup('done'));
  assert.equal(pageRoute('money', ''), href.setup('money'));
});

await test('a project without a lab shows why its lab did not start, and a box with its question and hours to start it', () => {
  const empty: Snapshot = {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 1,
    at: ago(0),
    project: 'cot',
    lab: null,
    trimmed: false,
    question: 'Do probes see faithfulness?',
    startProblem: 'Verifold found no agent tool that is signed in.',
  };
  const start = () => Promise.resolve({ ok: true as const });
  const html = renderToStaticMarkup(<NoLab snapshot={empty} onStart={start} />);
  const page = text(<NoLab snapshot={empty} onStart={start} />);
  assert.match(
    page,
    /cot has no lab yet The lab did not start: Verifold found no agent tool that is signed in\. Your question Do probes see faithfulness\? Time budget, in hours Start the lab/,
  );
  // The box holds the question, and the hours start at the lab's default.
  assert.match(html, />Do probes see faithfulness\?<\/textarea>/);
  assert.match(html, /value="8"/);
  assert.doesNotMatch(page, /later step/);
  // Without a question, the box is empty, and no page sends the person to the old desk.
  const none = renderToStaticMarkup(
    <NoLab
      snapshot={{ ...empty, question: null, startProblem: null }}
      onStart={start}
    />,
  );
  assert.match(
    text(
      <NoLab
        snapshot={{ ...empty, question: null, startProblem: null }}
        onStart={start}
      />,
    ),
    /Your question Time budget, in hours Start the lab/,
  );
  assert.doesNotMatch(none, /open the desk|href="\/"/);
});

await test('without a project, #/ask is the Ask page; with one, it leads to the lab', () => {
  const setup: SetupActions = {
    read: () => new Promise(() => {}),
  } as unknown as SetupActions;
  const empty: Snapshot = {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 1,
    at: ago(0),
    project: '',
    lab: null,
    trimmed: false,
  };
  const page = text(
    <Screen
      state={{ snapshot: empty, connection: 'live', retrying: false }}
      route={{ page: 'ask' }}
      now={now}
      actions={actions}
      agentActions={agentActions}
      setup={setup}
      start={start}
    />,
  );
  assert.match(page, /Reading your profile/);
  assert.match(page, /Profile/);
  assert.equal(
    renderToStaticMarkup(
      <Screen
        state={{
          snapshot: { ...empty, project: 'cot', lab: scopingLab() },
          connection: 'live',
          retrying: false,
        }}
        route={{ page: 'ask' }}
        now={now}
        actions={actions}
        agentActions={agentActions}
        setup={setup}
        start={start}
      />,
    ),
    '',
  );
});

function agent(
  id: string,
  handle: string,
  harness: 'claude' | 'codex',
  direction: string,
  fields: Partial<Agent> = {},
): Agent {
  return {
    id,
    handle,
    harness,
    model: harness === 'claude' ? 'opus[1m]' : 'gpt-6-astra',
    direction,
    check: null,
    status: 'idle',
    until: null,
    live: { state: 'idle', text: 'Between turns', since: ago(1) },
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
    openedBy: 'a-1',
    openedAt: ago(30),
    stoppedAt: null,
    head: 'a3f9c2e',
    ...fields,
  };
}

function question(id: string, fields: Partial<Call> = {}): Call {
  return {
    id,
    at: ago(5),
    kind: 'scope',
    question: 'Which models should the experiments use?',
    why: 'It has official SAEs, and a LoRA fits on one A100.',
    askers: [{ agent: 'a-1', handle: 'claude-1', direction: 'd-1', why: '' }],
    byVerifold: false,
    options: [
      {
        label: 'Qwen3.5-9B',
        detail: 'Newest small Qwen, with official SAEs.',
        usd: null,
        minutes: null,
        effect: null,
      },
      {
        label: 'Qwen3.8-27B',
        detail: 'Each run needs an H100.',
        usd: null,
        minutes: null,
        effect: null,
      },
    ],
    pick: 0,
    undoMinutes: 10,
    wordsLimit: 2000,
    state: 'open',
    answer: null,
    words: null,
    undoUntil: null,
    note: null,
    post: `p-${id.slice(2)}`,
    facts: [
      {
        claim: 'Qwen3.5-9B has official SAEs',
        source: 'https://huggingface.co/Qwen',
        sourceDate: '2026-04-27',
        listedAt: ago(5),
      },
    ],
    ...fields,
  };
}

/** A lab before its plan: the planner asked two questions, and an agent's other call waits. */
function scopingLab(fields: Partial<Lab> = {}): Lab {
  return {
    question: "Can cheap training make a model's chain of thought faithful?",
    postLimit: 4000,
    startedAt: ago(10),
    agentsHere: true,
    paused: null,
    budget: { hours: 8, deadline: ago(-470) },
    money: { plansUsd: 0.4, gpuUsd: 0, gpuLimitUsd: 25 },
    needsYou: [
      question('c-1'),
      question('c-2', {
        question: 'What does "frontier-lab scale" mean to you?',
        options: [
          {
            label: 'Under 1% of training',
            usd: null,
            minutes: null,
            effect: null,
          },
          { label: 'Works with RL', usd: null, minutes: null, effect: null },
        ],
        pick: 1,
        facts: [
          {
            claim: 'Qwen3.5-9B has official SAEs',
            source: 'https://huggingface.co/Qwen',
            sourceDate: '2026-04-27',
            listedAt: ago(5),
          },
          {
            claim: 'An H100 costs $3.99 an hour',
            source: null,
            sourceDate: null,
            listedAt: ago(5),
          },
        ],
      }),
    ],
    answered: [],
    directions: [direction('d-1', 'Plan the lab', 'a-1')],
    agents: [
      agent('a-1', 'claude-1', 'claude', 'd-1', {
        turns: {
          turns: [
            {
              id: '1a2b3c4d.#1',
              startedAt: ago(9),
              endedAt: ago(6),
              rev: 3,
              counts: {
                search: 6,
                page: 9,
                read: 0,
                command: 0,
                edit: 0,
                run: 0,
                post: 0,
                helper: 0,
                other: 2,
              },
              message: {
                text: "I've read the recent work. No cheap method keeps a chain of thought faithful once a monitor pushes against it. Two questions before I plan:",
                trimmed: false,
              },
            },
          ],
          more: false,
        },
      }),
    ],
    planner: 'a-1',
    plan: null,
    board: {
      posts: [
        {
          id: 'p-1',
          at: ago(5),
          author: 'verifold',
          handle: null,
          harness: null,
          kind: 'status',
          direction: 'd-1',
          text: 'claude-1 asks the person (c-1): Which models should the experiments use?',
          replyTo: null,
          mentions: [],
          proof: [],
        },
      ],
      more: false,
    },
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

function snapshot(lab: Lab): Snapshot {
  return {
    protocolVersion: 1,
    epoch: 'e1',
    rev: 3,
    at: ago(0),
    project: 'cot',
    lab,
    trimmed: false,
  };
}

await test("before the plan, the lab home is the planner's: its work folded, its message, the facts it checked, and its questions with options and words", () => {
  const [planner] = scopingLab().agents;
  assert.ok(planner);
  // The planner still reads while the person answers.
  const lab = scopingLab({
    agents: [
      {
        ...planner,
        status: 'working',
        live: { state: 'working', text: 'Reading a page', since: ago(1) },
      },
    ],
  });
  assert.deepEqual(
    planQuestions(lab).map((call) => call.id),
    ['c-1', 'c-2'],
  );
  const page = text(
    <LabHome
      snapshot={snapshot(lab)}
      lab={lab}
      connection="live"
      now={now}
      actions={actions}
      agentActions={agentActions}
    />,
  );
  assert.match(page, /Planning\. The planner keeps reading while you answer\./);
  assert.match(
    page,
    /You Can cheap training make a model's chain of thought faithful\?/,
  );
  assert.match(page, /Planner claude-1 · Claude Opus \(1M\)/);
  assert.match(page, /Worked 3 min · 6 searches · 9 pages/);
  assert.match(page, /Two questions before I plan:/);
  // Each fact once, with where it came from, or that it is unverified.
  assert.match(
    page,
    /Facts I checked Qwen3\.5-9B has official SAEs · huggingface\.co\/Qwen · 2026-04-27 · listed [^·]+ An H100 costs \$3\.99 an hour · unverified \(no source\) · listed /,
  );
  assert.equal(page.match(/Qwen3\.5-9B has official SAEs/g)?.length, 1);
  assert.match(
    page,
    /1\. Which models should the experiments use\? Qwen3\.5-9B \(recommended\) Newest small Qwen, with official SAEs\. Qwen3\.8-27B Each run needs an H100\./,
  );
  assert.match(page, /2\. What does "frontier-lab scale" mean to you\?/);
  assert.match(page, /Or answer in your own words/);
  assert.match(
    page,
    /Send answers Skip the questions\. Start with the planner's picks\./,
  );
  assert.match(page, /claude-1 reads your message during its turn/);
  // The questions are cards here, so neither the Needs-you line nor the board repeats them.
  assert.doesNotMatch(page, /Needs you/);
  assert.doesNotMatch(page, /asks the person \(c-1\)/);
  assert.doesNotMatch(page, /Directions show here/);
  const html = renderToStaticMarkup(
    <LabHome
      snapshot={snapshot(lab)}
      lab={lab}
      connection="live"
      now={now}
      actions={actions}
      agentActions={agentActions}
    />,
  );
  // The planner's pick is chosen until the person picks another.
  assert.match(
    html,
    /role="radio" aria-checked="true" class="question__option question__option--on"><b>Qwen3\.5-9B \(recommended\)/,
  );
  assert.match(
    html,
    /role="radio" aria-checked="true" class="question__option question__option--on"><b>Works with RL \(recommended\)/,
  );
  // Without the agent pages' actions, the home shows the lab as before.
  assert.doesNotMatch(
    text(
      <LabHome
        snapshot={snapshot(lab)}
        lab={lab}
        connection="live"
        now={now}
        actions={actions}
      />,
    ),
    /Send answers/,
  );
  // An idle planner with open questions waits for the person.
  const idle = scopingLab();
  assert.match(
    text(
      <LabHome
        snapshot={snapshot(idle)}
        lab={idle}
        connection="live"
        now={now}
        actions={actions}
        agentActions={agentActions}
      />,
    ),
    /The planner waits for your answers\./,
  );
});

await test("an answer in the person's own words replaces the options, and a call that is not the planner's waits on the Needs-you line", () => {
  const card = renderToStaticMarkup(
    <QuestionCard
      number={1}
      call={question('c-1')}
      choice={{ option: 0, words: '9B first, and try Gemma too' }}
      error={null}
      onChange={() => {}}
    />,
  );
  assert.doesNotMatch(card, /aria-checked="true"/);
  assert.match(card, /value="9B first, and try Gemma too"/);
  assert.deepEqual(answerOf({ option: 1, words: '  ' }), {
    words: null,
    option: 1,
  });
  assert.deepEqual(answerOf({ option: 1, words: ' Both ' }), {
    words: 'Both',
    option: 1,
  });
  // Send answers again after a lost answer: the same answers keep their key, so the lab takes them once.
  let made = 0;
  const make = (): string => `key-${++made}`;
  const sent = [
    { call: 'c-1', option: 0 },
    { call: 'c-2', words: 'Both' },
  ];
  const first = intentFor(null, sent, make, sameAnswers);
  const kept = unansweredAfter(first, { lost: 'Verifold did not answer.' });
  assert.equal(
    intentFor(
      kept,
      [
        { call: 'c-1', option: 0 },
        { call: 'c-2', words: 'Both' },
      ],
      make,
      sameAnswers,
    ).key,
    first.key,
  );
  assert.notEqual(
    intentFor(
      kept,
      [
        { call: 'c-1', option: 1 },
        { call: 'c-2', words: 'Both' },
      ],
      make,
      sameAnswers,
    ).key,
    first.key,
  );
  const access = question('c-3', {
    kind: 'access',
    question: 'Let me install packages?',
    askers: [{ agent: 'a-1', handle: 'claude-1', direction: 'd-1', why: '' }],
  });
  const lab = scopingLab({ needsYou: [question('c-1'), access] });
  const page = text(
    <LabHome
      snapshot={snapshot(lab)}
      lab={lab}
      connection="live"
      now={now}
      actions={actions}
      agentActions={agentActions}
    />,
  );
  assert.match(page, /Needs you Let me install packages\?/);
  assert.deepEqual(
    planQuestions(lab).map((call) => call.id),
    ['c-1'],
  );
  // After the plan, a scope call is an ordinary call again.
  assert.deepEqual(
    planQuestions({
      ...lab,
      plan: {
        post: 'p-2',
        at: ago(1),
        reading: 'r',
        cost: 'c',
        directions: [],
        facts: [],
      },
    }),
    [],
  );
});

function planPost(id: string, replyTo: string | null): Post {
  return {
    id,
    at: ago(id === 'p-3' ? 2 : 20),
    author: 'a-1',
    handle: 'claude-1',
    harness: 'claude',
    kind: 'plan',
    direction: 'd-1',
    text: 'How the planner reads it.',
    replyTo,
    mentions: [],
    proof: [],
  };
}

await test('the plan of record is a card that leads its thread: the reading, a table of directions, what changed, the facts, and the cost', () => {
  const lab = scopingLab({
    needsYou: [],
    directions: [
      direction('d-1', 'Names the cause', 'a-1', {
        bar: 'The CoT names the cue 20 points more often than a control',
        runs: 3,
        buildsOn: [{ text: 'Two 2025 methods', known: true }],
      }),
      direction('d-2', 'Follows the CoT', 'a-2', {
        bar: 'The answer follows a planted error',
        runs: 3,
      }),
    ],
    plan: {
      post: 'p-3',
      at: ago(2),
      reading: 'Can a cheap fine-tune make the CoT say what drives the answer?',
      cost: 'Nothing costs money yet. The first GPU asks you.',
      directions: ['d-1', 'd-2'],
      facts: [
        {
          claim: 'Qwen3.5-9B, with SAEs from April 27, 2026',
          source: 'https://huggingface.co/Qwen',
          sourceDate: '2026-04-27',
          listedAt: ago(2),
        },
        {
          claim: 'No paper shows a cheap fix that survives a monitor',
          source: null,
          sourceDate: null,
          listedAt: ago(2),
        },
      ],
      version: 2,
      previous: 'p-2',
      changed: 'Model: Qwen3-4B → Qwen3.5-9B, as you chose.',
    },
    board: {
      posts: [
        planPost('p-2', null),
        planPost('p-3', 'p-2'),
        {
          ...planPost('p-4', 'p-3'),
          author: 'person',
          handle: null,
          harness: null,
          kind: 'question',
          text: 'Add a second model family.',
        },
      ],
      more: false,
    },
  });
  const [thread] = threads(lab.board.posts);
  assert.ok(thread);
  const html = renderToStaticMarkup(<BoardThread thread={thread} lab={lab} />);
  const shown = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
  // The newest plan leads, as the plan of record. The plan before it is an earlier plan.
  assert.match(
    shown,
    /^ Cl Planner Plan of record · v2 \d\d:\d\d How I read it: Can a cheap fine-tune make the CoT say what drives the answer\?/,
  );
  assert.match(
    shown,
    /Direction Holds up if Builds on Names the cause The CoT names the cue 20 points more often than a control · 3 runs Two 2025 methods Follows the CoT The answer follows a planted error · 3 runs New/,
  );
  assert.match(
    shown,
    /Changed in v2 Model: Qwen3-4B → Qwen3\.5-9B, as you chose\. See v1/,
  );
  assert.match(html, /href="#\/board\/p-2">See v1<\/a>/);
  assert.match(html, /<details class="plan__facts" open="">/);
  assert.match(shown, /Facts checked \(2\) Qwen3\.5-9B/);
  // Each fact says when its plan listed it.
  assert.match(
    shown,
    /Qwen3\.5-9B, with SAEs from April 27, 2026 · huggingface\.co\/Qwen · 2026-04-27 · listed /,
  );
  // A plan that listed no facts kept those of an earlier plan, and says so.
  assert.match(
    renderToStaticMarkup(
      <BoardThread
        thread={thread}
        lab={{ ...lab, plan: { ...lab.plan!, factsCarried: true } }}
      />,
    )
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
    /Facts checked \(2\) · from an earlier plan Qwen3\.5-9B/,
  );
  assert.match(
    shown,
    /No paper shows a cheap fix that survives a monitor · unverified \(no source\)/,
  );
  assert.match(
    shown,
    /Nothing costs money yet\. The first GPU asks you\. Reply to change anything\./,
  );
  assert.match(shown, /Earlier plan How the planner reads it\./);
  assert.match(shown, /Add a second model family\./);
  // A first plan says nothing of a change.
  const first = {
    ...lab,
    plan: {
      ...lab.plan!,
      post: 'p-2',
      version: 1,
      previous: null,
      changed: null,
    },
  };
  const [only] = threads([planPost('p-2', null)]);
  assert.ok(only);
  assert.doesNotMatch(
    renderToStaticMarkup(<BoardThread thread={only} lab={first} />),
    /Changed in/,
  );
});

await test('a fact names its source as people read it: a link without the scheme, a long path cut, and a script never linked', () => {
  assert.equal(
    sourceName('https://www.runpod.io/pricing'),
    'runpod.io/pricing',
  );
  assert.equal(
    sourceName('https://huggingface.co/Qwen/'),
    'huggingface.co/Qwen',
  );
  const long = sourceName(
    'https://huggingface.co/Qwen/SAE-Res-Qwen3.5-9B-Base/tree/main/layer_20',
  );
  assert.equal(long.length, 44);
  // As the canvas cuts it.
  assert.equal(long, 'huggingface.co/Qwen/SAE-Res-Qwen3.5-9B-Base…');
  assert.equal(sourceLink('javascript:alert(1)'), null);
  assert.equal(
    sourceName('9 papers read, newest March 2026'),
    '9 papers read, newest March 2026',
  );
  const html = renderToStaticMarkup(
    <FactsList
      facts={[
        {
          claim: 'H100 $3.99 an hour',
          source: 'https://www.runpod.io/pricing',
          sourceDate: 'today 19:41',
          listedAt: ago(1),
        },
        {
          claim: 'Probe kit 3.2',
          source: 'javascript:alert(1)',
          sourceDate: null,
          listedAt: ago(1),
        },
        {
          claim: 'No cheap fix survives a monitor',
          source: '9 papers read, newest March 2026',
          sourceDate: null,
          listedAt: ago(1),
        },
      ]}
    />,
  );
  assert.match(
    html,
    /H100 \$3\.99 an hour <span class="facts__source">· <a href="https:\/\/www\.runpod\.io\/pricing" target="_blank" rel="noreferrer noopener">runpod\.io\/pricing<\/a> · today 19:41 · listed [^<]+<\/span>/,
  );
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /· javascript:alert\(1\) · listed [^<]+<\/span>/);
  assert.match(
    html,
    /· 9 papers read, newest March 2026 · listed [^<]+<\/span>/,
  );
});

await test('a time says its day as the pages write it: today, or the day with a fixed month, and the year in another year', () => {
  const today = new Date(2026, 9, 22, 12, 0).getTime();
  const at = (year: number, month: number, day: number): string =>
    new Date(year, month, day, 9, 5).toISOString();
  assert.equal(dayClock(at(2026, 9, 22), today), 'today at 09:05');
  assert.equal(dayClock(at(2026, 9, 19), today), 'on 19 Oct at 09:05');
  // A fixed month name: en-GB would give "Sept".
  assert.equal(dayClock(at(2026, 8, 3), today), 'on 3 Sep at 09:05');
  assert.equal(dayClock(at(2025, 9, 19), today), 'on 19 Oct 2025 at 09:05');
  // A fact says when its plan or call listed it, by the app's clock.
  assert.match(
    renderToStaticMarkup(
      <FactsList
        facts={[
          {
            claim: 'H100 $3.99 an hour',
            source: null,
            sourceDate: null,
            listedAt: at(2026, 9, 22),
          },
        ]}
        now={today}
      />,
    ),
    /· unverified \(no source\) · listed today at 09:05<\/span>/,
  );
});
