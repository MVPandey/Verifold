import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type {
  AgentTool,
  SetupAbout,
  SetupSkills,
  SetupView,
} from '../src/protocol/api.ts';
import {
  allowedGpus,
  firstPage,
  isSetupView,
  pageAfter,
  pageBefore,
  planName,
  setupActions,
  shownSteps,
} from '../src/app/setup.ts';
import { AgentsStep } from '../src/app/screens/SetupAgents.tsx';
import { AboutStep } from '../src/app/screens/SetupAbout.tsx';
import { MoneyStep } from '../src/app/screens/SetupMoney.tsx';
import { SkillsStep, runsLine } from '../src/app/screens/SetupSkills.tsx';
import {
  DoneStep,
  UnsavedLine,
  leaveFor,
  stillOn,
} from '../src/app/screens/Setup.tsx';
import { StepHeader } from '../src/app/components/StepHeader.tsx';

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
    { id: 'fable', label: 'Fable, the most capable' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
};

const codex: AgentTool = {
  harness: 'codex',
  installed: true,
  version: '0.160.0',
  signedIn: false,
  plan: null,
  use: false,
  model: null,
  models: [],
};

const about: SetupAbout = {
  lines: [
    {
      from: 'verifold',
      text: 'What do you work on, and what would you like the agents to explore?',
      suggestions: [],
    },
  ],
  card: null,
  saved: null,
  text: null,
  harness: 'claude',
  busy: null,
  error: null,
  limits: { answer: 2000, workOn: 600, explore: 1000, talk: 400 },
};

function view(fields: Partial<SetupView> = {}): SetupView {
  return {
    steps: { agents: null, about: null, skills: null, money: null },
    agents: { checking: false, tools: [claude, codex] },
    about,
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
    },
    ...fields,
  };
}

const actions = setupActions(null);
const quiet = (): void => {};

/** Visible text, with tags removed and entities decoded. */
function text(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

await test('the first run opens its first step without a record, and each step leads to the next', () => {
  assert.equal(firstPage(view()), 'agents');
  assert.equal(
    firstPage(
      view({ steps: { agents: 'done', about: 'skipped', money: null } }),
    ),
    'money',
  );
  assert.equal(
    firstPage(
      view({ steps: { agents: 'done', about: 'done', money: 'skipped' } }),
    ),
    'done',
  );
  assert.equal(pageAfter('agents'), 'about');
  assert.equal(pageAfter('money'), 'done');
  assert.equal(planName('max'), 'Max plan');
  assert.equal(planName('team_premium'), 'Team premium plan');
  assert.ok(isSetupView(view()));
  assert.equal(isSetupView({ steps: {} }), false);
});

/** The bar's links: address, accessible name, and whether it is the current step. */
function barLinks(html: string): string[][] {
  return [
    ...html.matchAll(
      /<a href="([^"]+)" class="step__link" aria-label="([^"]+)"( aria-current="step")?/g,
    ),
  ].map(([, to, name, current]) => [
    to ?? '',
    name ?? '',
    current ? 'current' : '',
  ]);
}

const backButton =
  /<button type="button" class="button button--big">Back<\/button>/;

await test('Back opens the step before, and an older Verifold without a Skills step leaves it out going back and on', () => {
  assert.equal(pageBefore('agents'), null);
  assert.equal(pageBefore('about'), 'agents');
  assert.equal(pageBefore('money'), 'skills');
  const older = shownSteps({ agents: 'done', about: null, money: null });
  assert.deepEqual(older, ['agents', 'about', 'money']);
  assert.equal(pageAfter('about', older), 'money');
  assert.equal(pageBefore('money', older), 'about');
  // Skills opened by its address on an older Verifold still leads on.
  assert.equal(pageAfter('skills', older), 'money');
  assert.equal(pageBefore('skills', older), 'about');
  // Back shows on steps 2 to 4 only.
  const agents = renderToStaticMarkup(
    <AgentsStep
      view={view()}
      actions={actions}
      refresh={quiet}
      onSaved={quiet}
      onSkip={quiet}
      onOpen={quiet}
      onUnsaved={quiet}
    />,
  );
  assert.doesNotMatch(agents, backButton);
  for (const page of [
    <AboutStep
      key="about"
      view={view()}
      actions={actions}
      refresh={quiet}
      onSaved={quiet}
      onBack={quiet}
      onOpen={quiet}
      onUnsaved={quiet}
    />,
    <SkillsStep
      key="skills"
      view={view()}
      actions={actions}
      refresh={quiet}
      onDone={quiet}
      onBack={quiet}
      onOpen={quiet}
    />,
    <MoneyStep
      key="money"
      view={view()}
      actions={actions}
      refresh={quiet}
      onSaved={quiet}
      onBack={quiet}
      onOpen={quiet}
      onUnsaved={quiet}
    />,
  ])
    assert.match(renderToStaticMarkup(page), backButton);
  // The last page has its Change links instead.
  for (const project of ['', 'cot'])
    assert.doesNotMatch(
      renderToStaticMarkup(<DoneStep view={view()} project={project} />),
      backButton,
    );
});

await test('the step bar shows each step as it is: done, skipped, or not yet, with the current one marked', () => {
  const html = renderToStaticMarkup(
    <StepHeader
      step="about"
      steps={{ agents: 'done', about: null, skills: 'skipped', money: null }}
      onOpen={quiet}
      title="About you"
    />,
  );
  assert.match(html, /Step 2 of 4: About you/);
  assert.deepEqual(barLinks(html), [
    ['#/setup/agents', 'Agents, done', ''],
    ['#/setup/about', 'About you, not yet', 'current'],
    ['#/setup/skills', 'Skills (optional), skipped', ''],
    ['#/setup/money', 'GPU money, not yet', ''],
  ]);
  assert.deepEqual(
    [...html.matchAll(/class="(step__segment[^"]*)"/g)].map(([, name]) => name),
    [
      'step__segment step__segment--done',
      'step__segment',
      'step__segment step__segment--skipped',
      'step__segment',
    ],
  );
  // An older Verifold without a Skills step: three steps.
  const older = renderToStaticMarkup(
    <StepHeader
      step="money"
      steps={{ agents: 'done', about: 'done', money: null }}
      onOpen={quiet}
      title="GPU money"
    />,
  );
  assert.match(older, /Step 3 of 3: GPU money/);
  assert.deepEqual(
    barLinks(older).map(([to]) => to),
    ['#/setup/agents', '#/setup/about', '#/setup/money'],
  );
});

await test('a click on the step bar goes through the setup page, and a click with a modifier key opens the link the browser way', () => {
  const opened: string[] = [];
  const header = StepHeader({
    step: 'money',
    steps: { agents: 'done', about: 'done', skills: null, money: null },
    onOpen: (step) => opened.push(step),
    title: 'GPU money',
  }) as ReactElement<{ children: ReactElement<{ children: unknown }>[] }>;
  const nav = header.props.children[1];
  const links = nav?.props.children as ReactElement<{
    onClick: (event: object) => void;
  }>[];
  const click = (at: number, keys: object): boolean => {
    let prevented = false;
    links[at]?.props.onClick({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...keys,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  assert.equal(click(1, {}), true);
  assert.equal(click(0, { metaKey: true }), false);
  assert.equal(click(2, { button: 1 }), false);
  assert.deepEqual(opened, ['about']);
});

await test('Back and the bar ask first when the step has unsaved input, and a step that a request left meanwhile stays left', () => {
  assert.equal(leaveFor('about', 'money', false), 'open');
  assert.equal(leaveFor('about', 'money', true), 'ask');
  assert.equal(leaveFor('money', 'money', true), 'none');
  // Continue on Skills, then Back to About before the save answers: the answer opens nothing.
  assert.equal(stillOn('#/setup/skills', 'skills'), true);
  assert.equal(stillOn('#/setup/about', 'skills'), false);
  assert.equal(stillOn('#/ask', 'money'), false);
  const html = renderToStaticMarkup(
    <UnsavedLine onLeave={quiet} onStay={quiet} />,
  );
  assert.match(html, /role="alert"/);
  assert.match(
    text(<UnsavedLine onLeave={quiet} onStay={quiet} />),
    /Your changes on this step aren’t saved\. Leave without saving Stay/,
  );
  assert.match(
    html,
    /<button type="button" class="button button--small" autofocus="">Stay/,
  );
  // Both choices reach the page.
  const chose: string[] = [];
  const line = UnsavedLine({
    onLeave: () => chose.push('leave'),
    onStay: () => chose.push('stay'),
  }) as ReactElement<{ children: ReactElement<{ children: unknown }>[] }>;
  const buttons = line.props.children[1]?.props.children as ReactElement<{
    onClick: () => void;
  }>[];
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(chose, ['leave', 'stay']);
});

await test('the GPUs that agents may rent: those at or under the cap before a save, and the saved list after', () => {
  const priced = view({
    money: {
      ...view().money,
      prices: {
        at: new Date().toISOString(),
        gpus: [
          { id: 'h100', name: 'H100 SXM', memoryGb: 80, usdPerHour: 3.99 },
          { id: 'h200', name: 'H200', memoryGb: 141, usdPerHour: 4.39 },
          { id: 'a100', name: 'A100 SXM', memoryGb: 80, usdPerHour: 1.79 },
        ],
      },
    },
  });
  assert.deepEqual(allowedGpus(priced, 4), ['h100', 'a100']);
  assert.deepEqual(allowedGpus(priced, 2), ['a100']);
  const saved = view({
    steps: { agents: 'done', about: 'done', money: 'done' },
    money: {
      ...priced.money,
      limits: { ...priced.money.limits, gpuTypes: ['h200'] },
    },
  });
  assert.deepEqual(allowedGpus(saved, 4), ['h200']);
});

await test('the setup actions send the key of the intent, and the RunPod key only in its own field', async (t) => {
  const sent: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
  const live = setupActions('token');
  await live.runpodKey('rpa_KEY', true, 'k'.repeat(32));
  await live.say('Short.', null, 'a'.repeat(32));
  await live.about(null, 'b'.repeat(32));
  await live.read();
  assert.deepEqual(
    sent.map((entry) => [entry.url, entry.body]),
    [
      [
        '/api/v1/actions/setup-key',
        { runpodKey: 'rpa_KEY', file: true, key: 'k'.repeat(32) },
      ],
      ['/api/v1/actions/setup-say', { text: 'Short.', key: 'a'.repeat(32) }],
      ['/api/v1/actions/setup-about', { keep: true, key: 'b'.repeat(32) }],
      ['/api/v1/setup', null],
    ],
  );
  // Without a token every action is refused at once.
  assert.deepEqual(await actions.skip('all', 'c'.repeat(32)), {
    refused: 'This tab has no access key.',
  });
});

await test('step 1 shows each harness with its sign-in, its model and its use, and says how to sign in', () => {
  const page = text(
    <AgentsStep
      view={view()}
      actions={actions}
      refresh={quiet}
      onSaved={quiet}
      onSkip={quiet}
      onOpen={quiet}
      onUnsaved={quiet}
    />,
  );
  for (const expected of [
    /Step 1 of 4: Agents/,
    /Your agents/,
    /Claude Code 2\.1\.304 Signed in · Max plan/,
    /Fable is the most capable model\. Your Max plan includes it, so you can pick it here\./,
    /Codex 0\.160\.0 Signed out/,
    /Codex's own default/,
    /To sign in, run codex login in a terminal\./,
    /Your Codex settings keep their reasoning effort\./,
    /Check again/,
    /Your logins stay in Claude Code and Codex\. Verifold never sees them\./,
    /Continue/,
    /Skip setup\. Ask me later\./,
  ])
    assert.match(page, expected);
  const html = renderToStaticMarkup(
    <AgentsStep
      view={view()}
      actions={actions}
      refresh={quiet}
      onSaved={quiet}
      onSkip={quiet}
      onOpen={quiet}
      onUnsaved={quiet}
    />,
  );
  assert.match(html, /<option value="opus\[1m\]" selected="">/);
  // Claude Code is in use, Codex is not.
  assert.equal(html.match(/type="checkbox" checked=""/g)?.length, 1);
  // A harness that is not installed says so, with a link to install it.
  const missing = text(
    <AgentsStep
      view={view({
        agents: {
          checking: false,
          tools: [claude, { ...codex, installed: false, version: null }],
        },
      })}
      actions={actions}
      refresh={quiet}
      onSaved={quiet}
      onSkip={quiet}
      onOpen={quiet}
      onUnsaved={quiet}
    />,
  );
  assert.match(
    missing,
    /Verifold did not find Codex on this computer\. How to install Codex/,
  );
  assert.match(
    text(
      <AgentsStep
        view={view({ agents: { checking: true, tools: [] } })}
        actions={actions}
        refresh={quiet}
        onSaved={quiet}
        onSkip={quiet}
        onOpen={quiet}
        onUnsaved={quiet}
      />,
    ),
    /Looking for Claude Code and Codex on this computer\./,
  );
});

await test('step 2 is a conversation with chips, a card with what each agent reads, and ways on after a failed reply', () => {
  const step = (fields: Partial<SetupAbout>): string =>
    text(
      <AboutStep
        view={view({ about: { ...about, ...fields } })}
        actions={actions}
        refresh={quiet}
        onSaved={quiet}
        onBack={quiet}
        onOpen={quiet}
        onUnsaved={quiet}
      />,
    );
  const first = step({});
  assert.match(first, /Step 2 of 4: About you/);
  assert.match(
    first,
    /Verifold What do you work on, and what would you like the agents to explore\?/,
  );
  assert.match(
    renderToStaticMarkup(
      <AboutStep
        view={view()}
        actions={actions}
        refresh={quiet}
        onSaved={quiet}
        onBack={quiet}
        onOpen={quiet}
        onUnsaved={quiet}
      />,
    ),
    /placeholder="Answer in your own words"/,
  );
  assert.doesNotMatch(first, /Looks right/);
  const asked = step({
    lines: [
      ...about.lines,
      { from: 'you', text: 'Interpretability.', suggestions: [] },
      {
        from: 'claude',
        text: 'How should the agents talk to you?',
        suggestions: ['Short and direct', 'Show the reasoning', 'Like a paper'],
      },
    ],
  });
  assert.match(asked, /You Interpretability\./);
  assert.match(
    asked,
    /Claude How should the agents talk to you\? Short and direct Show the reasoning Like a paper/,
  );
  assert.match(
    step({ busy: new Date().toISOString() }),
    /Claude is writing · \d+ s/,
  );
  const failed = step({ error: 'The agent did not answer.' });
  assert.match(
    failed,
    /The agent did not answer\. Try again Fill the card from my answers/,
  );
  const card = {
    workOn: 'Interpretability, alignment',
    explore: 'Cheap training fixes',
    talk: 'Short and direct.',
  };
  const drafted = step({ card });
  assert.match(drafted, /Your profile Edit/);
  assert.match(
    drafted,
    /You work on Interpretability, alignment To explore Cheap training fixes Talk to me Short and direct\./,
  );
  assert.match(
    drafted,
    /The planner of each project reads all of it\. The other agents, and the checkers, get only “Talk to me”, so they don’t lean toward your views\./,
  );
  assert.match(drafted, /Looks right/);
  assert.match(
    renderToStaticMarkup(
      <AboutStep
        view={view({ about: { ...about, card } })}
        actions={actions}
        refresh={quiet}
        onSaved={quiet}
        onBack={quiet}
        onOpen={quiet}
        onUnsaved={quiet}
      />,
    ),
    /placeholder="Add anything else, in your own words"/,
  );
  // Without an agent, a note cannot change the card: the person edits it.
  const local = step({ card, harness: null });
  assert.match(local, /No agent is signed in, so edit the card to change it\./);
  // A saved card can be replaced by a new conversation.
  assert.match(step({ card, saved: 'card' }), /Start the conversation again/);
  // A profile from an earlier version: keep it, or write a new one.
  const older = step({ saved: 'text', text: 'I study graphs.' });
  assert.match(older, /Your profile from an earlier version I study graphs\./);
  assert.match(
    older,
    /Keep it Write a new one\. Saving it replaces this text\./,
  );
});

await test('step 4 asks for a key without one, and with one shows the prices with the GPUs that agents may rent', () => {
  const step = (
    money: Partial<SetupView['money']>,
    steps?: SetupView['steps'],
  ): string =>
    renderToStaticMarkup(
      <MoneyStep
        view={view({
          money: { ...view().money, ...money },
          ...(steps ? { steps } : {}),
        })}
        actions={actions}
        refresh={quiet}
        onSaved={quiet}
        onBack={quiet}
        onOpen={quiet}
        onUnsaved={quiet}
      />,
    );
  const none = step({});
  assert.match(none, /type="password"/);
  assert.match(
    none.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
    /Prices show here once you add a key\. Without a key, agents ask you before any rental\./,
  );
  const priced = step({
    key: { last4: 'WXYZ', place: 'keychain', problem: null },
    prices: {
      at: new Date().toISOString(),
      gpus: [
        { id: 'h200', name: 'H200', memoryGb: 141, usdPerHour: 4.39 },
        { id: 'h100', name: 'H100 SXM', memoryGb: 80, usdPerHour: 3.99 },
        { id: 'l40s', name: 'L40S', memoryGb: 48, usdPerHour: 1.09 },
      ],
    },
  });
  const shown = priced
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
  assert.match(shown, /RunPod key found , ending in WXYZ\./);
  assert.doesNotMatch(priced, /type="password"/);
  assert.match(
    shown,
    /H200 141 GB \$4\.39 H100 SXM 80 GB \$3\.99 L40S 48 GB \$1\.09/,
  );
  assert.match(shown, /read today at \d{2}:\d{2}/);
  // At or under the $4 cap: allowed. Above it: not.
  assert.match(priced, /aria-label="Allow H200"\/>/);
  assert.match(priced, /aria-label="Allow H100 SXM" checked=""/);
  assert.match(priced, /aria-label="Allow L40S" checked=""/);
  assert.match(priced, /value="25"/);
  assert.match(priced, /value="15"/);
  // The monthly limit across projects: empty for none, with this month's spend under it.
  assert.match(
    shown,
    /All projects together, each month \$ Nothing spent this month\. Leave it empty for no monthly limit\. Two projects that rent at the same moment can go over it by one pod’s cost\. Verifold then stops their pods\./,
  );
  const monthly = step({
    limits: { ...view().money.limits, monthUsd: 100 },
    month: { spentUsd: 37.2 },
  });
  assert.match(monthly, /value="100"/);
  assert.match(monthly, /aria-describedby="[^"]+"/);
  assert.match(
    monthly.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
    /Spent so far this month: \$37\.20\. Leave it empty/,
  );
  // When Verifold cannot tell the month's spend, the step says why instead of a figure.
  const unknown = step({
    limits: { ...view().money.limits, monthUsd: 100 },
    month: {
      spentUsd: 0,
      problem:
        "Verifold can't read /p/gpu/a.json, the GPU record of another project.",
    },
  })
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
  assert.match(
    unknown,
    /Verifold can't read \/p\/gpu\/a\.json, the GPU record of another project\. Leave it empty/,
  );
  assert.doesNotMatch(unknown, /Nothing spent this month/);
  assert.match(
    shown,
    /Claude and Codex usage comes out of your plans\. Each project shows what Claude Code estimates its work cost\. When a plan’s usage limit runs out, the agents on it wait until it resets\./,
  );
  assert.match(shown, /Finish setup No GPUs for now/);
  // Saved limits that are not valid: the step says so, with the defaults to save.
  const unread = step({
    unreadable:
      'The saved GPU limits are not valid: Give the spend limit in USD as a number from 1 to 10000. They show the defaults until you save new ones.',
  });
  assert.match(
    unread,
    /role="alert"[^>]*>The saved GPU limits are not valid: Give the spend limit/,
  );
});

await test('after the last step, each step says done or skipped, with a way to change it', () => {
  const done = text(
    <DoneStep
      view={view({
        steps: {
          agents: 'done',
          about: 'skipped',
          skills: null,
          money: 'done',
        },
      })}
      project=""
    />,
  );
  assert.match(done, /Setup is saved/);
  assert.match(
    done,
    /Your agents Done Change About you Skipped Set it up Skills Not yet Set it up GPU money Done Change/,
  );
  // Without a project, the first run ends on the Ask page.
  assert.match(done, /Ask your question/);
  assert.match(
    renderToStaticMarkup(
      <DoneStep
        view={view({
          steps: { agents: 'done', about: 'skipped', money: 'done' },
        })}
        project=""
      />,
    ),
    /href="#\/ask"/,
  );
  const set = text(
    <DoneStep
      view={view({ steps: { agents: 'done', about: 'done', money: 'done' } })}
      project="cot"
    />,
  );
  assert.match(set, /You’re set/);
  assert.match(set, /New projects start from this profile\./);
});

await test('step 3 shows the skills that fit, pinned with what they can run, and says that nothing installs until the person adds it', () => {
  assert.equal(pageAfter('about'), 'skills');
  assert.equal(pageAfter('skills'), 'money');
  assert.equal(
    firstPage(
      view({
        steps: { agents: 'done', about: 'done', skills: null, money: null },
      }),
    ),
    'skills',
  );
  const card = {
    id: '0123456789abcdef',
    name: 'transformer-lens',
    what: 'Inspects and patches a transformer’s activations.',
    repo: 'Orchestra-Research/AI-Research-SKILLs',
    commit: 'a'.repeat(40),
    path: '04-mechanistic-interpretability/transformer-lens',
    updated: '2026-10-01T10:00:00Z',
    license: 'MIT',
    runs: {
      scripts: [{ language: 'Python', files: 2 }],
      executables: 1,
      installs: ['pip install'],
      hosts: ['huggingface.co'],
    },
    state: 'new' as const,
  };
  const skills = (fields: Partial<SetupSkills>): SetupSkills => ({
    busy: null,
    search: {
      at: new Date().toISOString(),
      catalogs: [
        {
          repo: 'Orchestra-Research/AI-Research-SKILLs',
          commit: 'a'.repeat(40),
          problem: null,
        },
        {
          repo: 'openai/skills',
          commit: null,
          problem: 'GitHub answered 500.',
        },
      ],
      picker: 'claude',
    },
    cards: [
      card,
      { ...card, id: 'fedcba9876543210', name: 'saelens', state: 'added' },
    ],
    added: [],
    needsProfile: false,
    problem: null,
    ...fields,
  });
  const shown = text(
    <SkillsStep
      view={view({ skills: skills({}) })}
      actions={actions}
      refresh={quiet}
      onDone={quiet}
      onBack={quiet}
      onOpen={quiet}
    />,
  );
  assert.match(shown, /Step 3 of 4: Skills \(optional\)/);
  assert.match(shown, /Skills that fit your work/);
  assert.match(
    shown,
    /Verifold read 1 skill catalog today at \d\d:\d\d and matched them to your profile\. Claude Code picked these/,
  );
  assert.match(
    shown,
    /Orchestra-Research\/AI-Research-SKILLs @ aaaaaaa · updated 1 Oct 2026/,
  );
  assert.match(
    shown,
    /Can run Python scripts \(2 files\)\. 1 file is executable\. Its files name pip install\. Web hosts in its files: huggingface\.co\. No hooks\. License: MIT\./,
  );
  assert.match(shown, /Add .*saelens.*Added/);
  assert.match(
    shown,
    /Not read this time: openai\/skills \(GitHub answered 500\.\)/,
  );
  assert.match(
    shown,
    /Nothing installs until you add it\. An added skill is pinned to the version shown, and loads only for Verifold’s agents, not in your own Claude Code or Codex\. Read what each one can run before you add it\./,
  );
  assert.match(shown, /Continue Skip\. Ask me later\. Search again/);
  const markup = renderToStaticMarkup(
    <SkillsStep
      view={view({ skills: skills({}) })}
      actions={actions}
      refresh={quiet}
      onDone={quiet}
      onBack={quiet}
      onOpen={quiet}
    />,
  );
  assert.match(markup, /aria-pressed="true"[^>]*>Added</);
  assert.match(
    markup,
    /href="https:\/\/github\.com\/Orchestra-Research\/AI-Research-SKILLs\/tree\/a{40}\/04-mechanistic-interpretability\/transformer-lens"/,
  );
  // An update, a profile that is missing, and a search that runs.
  assert.match(
    text(
      <SkillsStep
        view={view({
          skills: skills({ cards: [{ ...card, state: 'update' }] }),
        })}
        actions={actions}
        refresh={quiet}
        onDone={quiet}
        onBack={quiet}
        onOpen={quiet}
      />,
    ),
    /Update/,
  );
  assert.match(
    text(
      <SkillsStep
        view={view({
          skills: skills({ search: null, cards: [], needsProfile: true }),
        })}
        actions={actions}
        refresh={quiet}
        onDone={quiet}
        onBack={quiet}
        onOpen={quiet}
      />,
    ),
    /this step needs About you first/,
  );
  assert.match(
    text(
      <SkillsStep
        view={view({
          skills: skills({ search: null, cards: [], busy: 'search' }),
        })}
        actions={actions}
        refresh={quiet}
        onDone={quiet}
        onBack={quiet}
        onOpen={quiet}
      />,
    ),
    /Reading the skill catalogs on GitHub/,
  );
  assert.equal(
    runsLine({ scripts: [], executables: 0, installs: [], hosts: [] }),
    'Has no scripts. No hooks.',
  );
  // A date that GitHub's limit kept out, and an update check without a profile.
  const updates = text(
    <SkillsStep
      view={view({
        skills: skills({
          needsProfile: true,
          added: [
            {
              id: card.id,
              name: card.name,
              repo: card.repo,
              commit: 'b'.repeat(40),
              path: card.path,
              addedAt: '2026-10-01T10:00:00Z',
            },
          ],
          cards: [{ ...card, updated: null, state: 'update' }],
        }),
      })}
      actions={actions}
      refresh={quiet}
      onDone={quiet}
      onBack={quiet}
      onOpen={quiet}
    />,
  );
  assert.match(updates, /@ aaaaaaa · updated: not read/);
  assert.match(
    updates,
    /Verifold read 1 skill catalog today at \d\d:\d\d to check your added skills for updates\./,
  );
  assert.match(updates, /this step needs About you first/);
  assert.match(updates, /Update/);
});
