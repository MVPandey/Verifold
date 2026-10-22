import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import {
  cardMarkdown,
  loadSettings,
  parseCard,
  personProfile,
  prepareAgency,
  profileReader,
  saveAgencyFile,
  saveAgencyPreferences,
  withProfileLock,
  writeSettings,
} from '../src/core/agency.ts';
import { monthFolder } from '../src/core/gpu-month.ts';
import { monthKey } from '../src/core/leases.ts';
import {
  Compute,
  computeDefaults,
  profileMoneyDefaults,
} from '../src/core/compute.ts';
import { KeyStore } from '../src/core/credentials.ts';
import {
  claudeChoices,
  detectHarnesses,
  type HarnessStatus,
} from '../src/core/detect.ts';
import type { HarnessRequest } from '../src/core/harness.ts';
import { nextStep, opening, type ChatLine } from '../src/core/profile-chat.ts';
import { initializeProject } from '../src/cli/initialization.ts';
import { createProject } from '../src/cli/project.ts';
import { runCli } from '../src/cli/commands.ts';
import { startDesk } from '../src/server/desk.ts';
import { FirstRun, shortlist } from '../src/server/setup.ts';
import type { SetupView } from '../src/protocol/api.ts';

const key = 'rpa_TESTKEY0123456789abcdefWXYZ';
const signal = new AbortController().signal;
const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

async function folder(t: test.TestContext, name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `verifold-${name}-`));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** Every file under a folder, as text. */
async function everything(path: string): Promise<string> {
  const names = await readdir(path, { recursive: true }).catch(() => []);
  return (
    await Promise.all(
      names.map((name) => readFile(join(path, name), 'utf8').catch(() => '')),
    )
  ).join('\n');
}

await test('the profile settings read older ones, keep each part on a change, and refuse bad values', async (t) => {
  const agency = join(await folder(t, 'agency'), 'agency');
  assert.deepEqual(await loadSettings(agency), {
    agency: null,
    money: null,
    unreadMoney: null,
    steps: {},
  });
  // An older version saved one harness, its model, and a helper.
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({ host: 'codex', model: 'gpt-6-astra', helper: 'claude' }),
  );
  assert.deepEqual((await loadSettings(agency)).agency, {
    host: 'codex',
    model: 'gpt-6-astra',
    helper: 'claude',
  });
  await withProfileLock(agency, signal, () =>
    writeSettings(agency, (current) => ({
      ...current,
      agency: {
        host: 'claude',
        model: 'fable',
        helper: 'codex',
        helperModel: 'gpt-6.1-sol',
      },
      money: { ...profileMoneyDefaults, gpuTypes: ['NVIDIA L40S'] },
      steps: { money: 'done', about: 'skipped' },
    })),
  );
  // The terminal's own setup changes only the agents: the limits and the steps stay.
  await saveAgencyPreferences(agency, { host: 'claude' }, signal);
  const settings = await loadSettings(agency);
  assert.deepEqual(settings.agency, { host: 'claude' });
  assert.deepEqual(settings.money, {
    ...profileMoneyDefaults,
    gpuTypes: ['NVIDIA L40S'],
  });
  assert.deepEqual(settings.steps, { money: 'done', about: 'skipped' });
  // The file keeps the fields that an older version reads.
  const raw = JSON.parse(
    await readFile(join(agency, 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(raw.host, 'claude');
  assert.equal((await stat(join(agency, 'settings.json'))).mode & 0o777, 0o600);
  // A helper's model goes with its helper only.
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({ host: 'claude', helperModel: 'gpt-6.1-sol' }),
  );
  assert.deepEqual((await loadSettings(agency)).agency, { host: 'claude' });
  for (const [content, error] of [
    [{ host: 'other' }, /claude or codex/],
    [{ host: 'claude', model: 'bad model!' }, /valid identifier/],
  ] as const) {
    await saveAgencyFile(agency, 'settings.json', JSON.stringify(content));
    await assert.rejects(loadSettings(agency), error);
  }
  // GPU limits that are not valid read as not set, with the reason. The rest still loads.
  for (const money of [
    { ...profileMoneyDefaults, limitUsd: -5 },
    { ...profileMoneyDefaults, gpuTypes: ['bad/gpu'] },
    'a lot',
  ]) {
    await saveAgencyFile(
      agency,
      'settings.json',
      JSON.stringify({ host: 'codex', money, steps: ['odd'] }),
    );
    const read = await loadSettings(agency);
    assert.deepEqual(read.agency, { host: 'codex' });
    assert.equal(read.money, null);
    assert.deepEqual(read.unreadMoney?.saved, money);
    assert.ok(read.unreadMoney?.reason);
    assert.deepEqual(read.steps, {});
  }
  // The file keeps them until a save of new limits replaces them.
  await saveAgencyPreferences(agency, { host: 'claude' }, signal);
  assert.equal(
    (
      JSON.parse(await readFile(join(agency, 'settings.json'), 'utf8')) as {
        money: unknown;
      }
    ).money,
    'a lot',
  );
  await withProfileLock(agency, signal, () =>
    writeSettings(agency, (current) => ({
      ...current,
      money: profileMoneyDefaults,
    })),
  );
  const fixed = await loadSettings(agency);
  assert.deepEqual(fixed.money, profileMoneyDefaults);
  assert.equal(fixed.unreadMoney, null);
  // Limits saved before the monthly limit existed have none: Verifold does not invent one.
  const older: Record<string, unknown> = { ...profileMoneyDefaults };
  delete older.monthUsd;
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({ host: 'claude', money: older }),
  );
  assert.deepEqual((await loadSettings(agency)).money, {
    ...profileMoneyDefaults,
    monthUsd: null,
  });
});

await test('the card round-trips through USER.md, and a profile in free form goes to the planner only', async (t) => {
  const agency = join(await folder(t, 'card'), 'agency');
  const card = {
    workOn: 'Interpretability, alignment, CoT faithfulness',
    explore: 'Cheap training fixes for faithful CoT that scale.',
    talk: 'Short and direct. Numbers first.',
  };
  assert.deepEqual(parseCard(cardMarkdown(card)), card);
  // A line of a field that looks like a heading stays in its field.
  const headings = {
    workOn: '# x\nProbes',
    explore: '## Talk to me\n\\# kept as typed',
    talk: 'Short.',
  };
  assert.deepEqual(parseCard(cardMarkdown(headings)), headings);
  assert.equal(parseCard('# Research profile\n\nI study graphs.'), null);
  // Other sections are not part of the card. A missing field is empty.
  assert.deepEqual(
    parseCard('## Talk to me\n\nTables.\n\n## Notes\n\nPrivate.'),
    { workOn: '', explore: '', talk: 'Tables.' },
  );
  assert.equal(await personProfile(agency), null);
  await saveAgencyFile(agency, 'USER.md', cardMarkdown(card));
  const person = await personProfile(agency);
  assert.equal(person?.style, 'Short and direct. Numbers first.');
  assert.match(
    person?.whole ?? '',
    /^The person works on: Interpretability.*\nThey want the agents to explore: Cheap.*\nHow they want agents to write to them: Short/,
  );
  // No heading reads as an order to the agent.
  assert.doesNotMatch(person?.whole ?? '', /You work on/);
  // The lab's reader reads USER.md again only when it changed.
  const read = profileReader(agency);
  const first = await read();
  assert.equal(await read(), first);
  await saveAgencyFile(
    agency,
    'USER.md',
    cardMarkdown({ ...card, talk: 'Tables over text.' }),
  );
  assert.equal((await read())?.style, 'Tables over text.');
  await saveAgencyFile(agency, 'USER.md', 'I study graphs.\n');
  assert.deepEqual(await personProfile(agency), {
    whole: 'I study graphs.',
    style: null,
  });
});

/** Fake Claude Code and Codex programs for detection. */
async function fakeHarnesses(
  t: test.TestContext,
  claude: { readonly plan: string; readonly loggedIn: boolean } | null,
  codex: 'in' | 'out' | null,
): Promise<{ claude: string; codex: string; config: string }> {
  const base = await folder(t, 'detect');
  const config = join(base, 'claude-config');
  await mkdir(config);
  const paths = { claude: join(base, 'claude'), codex: join(base, 'codex') };
  if (claude)
    await writeFile(
      paths.claude,
      `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (args === '--version') console.log('2.1.304 (Claude Code)');
else if (args === 'auth status') console.log(JSON.stringify({ loggedIn: ${claude.loggedIn}, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.com', orgId: 'org-SECRET-ID', orgName: 'Private Org', subscriptionType: ${JSON.stringify(claude.plan)} }, null, 2));
else process.exit(2);
`,
      { mode: 0o700 },
    );
  if (codex)
    await writeFile(
      paths.codex,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli 0.160.0');
else if (args[0] === 'login') console.error(${JSON.stringify(codex === 'in' ? 'Logged in using ChatGPT' : 'Not logged in')});
else if (args[0] === 'app-server') {
  const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
  onLine((line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') out({ id: message.id, result: {} });
    if (message.method !== 'model/list') return;
    if (!message.params.cursor) return out({ id: message.id, result: { data: [
      { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true },
      { id: 'preview', model: 'gpt-6-astra-preview', hidden: true },
    ], nextCursor: 'page-2' } });
    out({ id: message.id, result: { data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra' }], nextCursor: null } });
  });
}
`,
      { mode: 0o700 },
    );
  return { ...paths, config };
}

await test('detection reads versions, sign-in and models, offers Fable on a Max plan only, and keeps no account fields', async (t) => {
  const fakes = await fakeHarnesses(t, { plan: 'max', loggedIn: true }, 'in');
  await writeFile(
    join(fakes.config, 'settings.json'),
    JSON.stringify({ model: 'opus[1m]' }),
  );
  const found = await detectHarnesses({
    claude: fakes.claude,
    codex: fakes.codex,
    claudeConfig: fakes.config,
  });
  const [claude, codex] = found;
  assert.deepEqual(
    { ...claude, models: claude?.models.map((model) => model.id) },
    {
      harness: 'claude',
      installed: true,
      version: '2.1.304',
      signedIn: true,
      plan: 'max',
      models: ['opus[1m]', 'fable', 'sonnet'],
    },
  );
  assert.equal(
    claude?.models[0]?.label,
    'Opus, 1M context (your Claude Code default)',
  );
  // The most capable Codex model comes first, from the second page. Hidden models stay out.
  assert.deepEqual(codex?.models, [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra, the most capable' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol, the Codex default' },
  ]);
  assert.equal(codex?.signedIn, true);
  assert.equal(codex?.version, '0.160.0');
  // Verifold reads no account fields.
  assert.doesNotMatch(
    JSON.stringify(found),
    /person@example|SECRET|Private Org/,
  );

  // A Pro plan that is signed out gets no Fable. A missing Codex is not installed.
  const other = await fakeHarnesses(t, { plan: 'pro', loggedIn: false }, null);
  const [pro, none] = await detectHarnesses({
    claude: other.claude,
    codex: other.codex,
    claudeConfig: other.config,
  });
  assert.equal(pro?.signedIn, false);
  assert.deepEqual(
    pro?.models.map((model) => model.id),
    ['opus', 'sonnet'],
  );
  assert.equal(pro?.models[0]?.label, 'Opus');
  assert.deepEqual(none, {
    harness: 'codex',
    installed: false,
    version: null,
    signedIn: null,
    plan: null,
    models: [],
  });
  // A signed-out Codex is not asked for its models.
  const out = await fakeHarnesses(t, null, 'out');
  const [, signedOut] = await detectHarnesses({
    claude: out.claude,
    codex: out.codex,
    claudeConfig: out.config,
  });
  assert.equal(signedOut?.signedIn, false);
  assert.deepEqual(signedOut?.models, []);
});

await test('detection stops the Codex app-server and removes its socket folder when Codex never listens or refuses to start', async (t) => {
  /** Whether any process of the group still runs. */
  const running = (group: number): boolean => {
    try {
      process.kill(-group, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** A signed-in fake Codex whose app-server saves its process group and socket, then never listens or refuses `initialize`. */
  const fake = async (
    name: 'silent' | 'refusing',
  ): Promise<{ readonly codex: string; readonly server: string }> => {
    const base = await folder(t, `detect-${name}`);
    const codex = join(base, 'codex');
    const server = join(base, 'server.json');
    await writeFile(
      codex,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli 0.160.0');
else if (args[0] === 'login') console.error('Logged in using ChatGPT');
else if (args[0] === 'app-server') {
  // The watchdog that starts this server leads its process group.
  require('node:fs').writeFileSync(${JSON.stringify(server)}, JSON.stringify({ group: process.ppid, listen: args[args.indexOf('--listen') + 1] }));
  ${
    name === 'silent'
      ? 'setInterval(() => {}, 60_000);'
      : `const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
  onLine((line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') out({ id: message.id, error: { code: -32600, message: 'refused' } });
  });`
  }
}
`,
      { mode: 0o700 },
    );
    return { codex, server };
  };
  // A Codex that never listens holds detection for its whole 10 seconds, so both run at once.
  await Promise.all(
    (['silent', 'refusing'] as const).map(async (name) => {
      const { codex, server } = await fake(name);
      const [, found] = await detectHarnesses({
        claude: join(dirname(codex), 'no-claude'),
        codex,
        claudeConfig: dirname(codex),
      });
      assert.equal(found?.signedIn, true, name);
      assert.deepEqual(found?.models, [], name);
      const { group, listen } = JSON.parse(await readFile(server, 'utf8')) as {
        readonly group: number;
        readonly listen: string;
      };
      t.after(() => {
        if (running(group)) process.kill(-group, 'SIGKILL');
      });
      await until(() => Promise.resolve(!running(group)));
      await until(() =>
        Promise.resolve(!existsSync(dirname(listen.replace(/^unix:\/\//, '')))),
      );
    }),
  );
});

/** A fake harness run: it answers each call with the next reply and keeps the requests. */
function fakeRun(replies: string[]): {
  readonly run: (request: HarnessRequest) => Promise<{ text: string }>;
  readonly requests: HarnessRequest[];
} {
  const requests: HarnessRequest[] = [];
  return {
    requests,
    run: (request) => {
      requests.push(request);
      const text = replies.shift();
      return text === undefined
        ? Promise.reject(new Error('claude exited with status 1.'))
        : Promise.resolve({ text });
    },
  };
}

const you = (text: string): ChatLine => ({
  from: 'you',
  text,
  suggestions: [],
});
const asks = (text: string): ChatLine => ({
  from: 'claude',
  text,
  suggestions: [],
});

await test('the About-you agent asks at most two follow-ups with three suggestions, drafts the card, and changes it from a note', async () => {
  const harness = { host: 'claude' as const, model: 'opus[1m]' };
  const fake = fakeRun([
    JSON.stringify({
      question: 'How should the agents talk to you?',
      suggestions: [
        'Short and direct',
        'Show the reasoning',
        'Like a paper',
        'A fourth',
      ],
    }),
    JSON.stringify({ question: 'A third question?' }),
    '```json\n{"card": {"workOn": "Interpretability", "explore": "Probes", "talk": "Short"}}\n```',
    JSON.stringify({
      card: {
        workOn: 'Interpretability',
        explore: 'Probes and SAEs',
        talk: 'Short',
      },
    }),
  ]);
  const first = [
    ...opening,
    you('Interpretability. I want to explore probes.'),
  ];
  const step = await nextStep({
    lines: first,
    card: null,
    note: null,
    harness,
    signal,
    run: fake.run,
  });
  assert.deepEqual(step, {
    question: 'How should the agents talk to you?',
    suggestions: ['Short and direct', 'Show the reasoning', 'Like a paper'],
  });
  const asked = fake.requests[0];
  assert.equal(asked?.host, 'claude');
  // The chat answers from the prompt alone.
  assert.equal(asked?.textOnly, true);
  assert.equal(asked?.model, 'opus[1m]');
  assert.match(asked?.prompt ?? '', /"questionsLeft":2/);
  assert.match(asked?.prompt ?? '', /I want to explore probes/);
  // The agent works in an empty private folder that is gone afterwards.
  assert.match(asked?.cwd ?? '', /verifold-profile-/);
  await assert.rejects(stat(asked?.cwd ?? ''), { code: 'ENOENT' });

  // After two follow-ups, a question is refused: only the card can come.
  const two = [
    ...first,
    asks('How should the agents talk to you?'),
    you('Short'),
    asks('Anything else?'),
    you('No'),
  ];
  await assert.rejects(
    nextStep({
      lines: two,
      card: null,
      note: null,
      harness,
      signal,
      run: fake.run,
    }),
    /did not send a card or a question/,
  );
  assert.match(fake.requests[1]?.prompt ?? '', /"questionsLeft":0/);
  const drafted = await nextStep({
    lines: two,
    card: null,
    note: null,
    harness,
    signal,
    run: fake.run,
  });
  assert.deepEqual(drafted, {
    card: { workOn: 'Interpretability', explore: 'Probes', talk: 'Short' },
  });
  // A note changes the card that the person sees.
  const revised = await nextStep({
    lines: two,
    card: { workOn: 'Interpretability', explore: 'Probes', talk: 'Short' },
    note: 'Add SAEs.',
    harness,
    signal,
    run: fake.run,
  });
  assert.deepEqual(revised, {
    card: {
      workOn: 'Interpretability',
      explore: 'Probes and SAEs',
      talk: 'Short',
    },
  });
  assert.match(fake.requests[3]?.prompt ?? '', /"note":"Add SAEs\."/);
  assert.match(fake.requests[3]?.prompt ?? '', /"questionsLeft":0/);

  // Without an agent, Verifold asks how to talk, then fills the card from the answers.
  assert.deepEqual(
    await nextStep({
      lines: first,
      card: null,
      note: null,
      harness: null,
      signal,
    }),
    {
      question: 'How should the agents talk to you?',
      suggestions: ['Short and direct', 'Show the reasoning', 'Like a paper'],
      asks: 'talk',
    },
  );
  assert.deepEqual(
    await nextStep({
      lines: [
        ...first,
        {
          from: 'verifold',
          text: 'How should the agents talk to you?',
          suggestions: [],
          asks: 'talk',
        },
        you('Tables.'),
      ],
      card: null,
      note: null,
      harness: null,
      signal,
    }),
    {
      card: {
        workOn: 'Interpretability. I want to explore probes.',
        explore: '',
        talk: 'Tables.',
      },
    },
  );
  await assert.rejects(
    nextStep({
      lines: first,
      card: { workOn: 'x', explore: '', talk: '' },
      note: 'More.',
      harness: null,
      signal,
    }),
    /No agent is signed in/,
  );
});

/**
 * A fake RunPod API: the key check and the GPU catalog, with the common
 * types and one that is not common.
 */
async function fakeRunPod(t: test.TestContext): Promise<string> {
  const server = createServer((request, response) => {
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${key}`) {
      json(401, { status: 401, detail: 'invalid key' });
      return;
    }
    if (request.url === '/v2/pods?limit=1') {
      json(200, { pods: [], pagination: { hasNextPage: false } });
      return;
    }
    if (request.url?.startsWith('/v2/catalog/gpus')) {
      json(200, {
        gpus: [
          {
            id: 'NVIDIA GeForce RTX 4090',
            name: 'RTX 4090',
            memory: 24,
            secure: true,
            price: { secure: 0.74 },
            availability: 'HIGH',
          },
          {
            id: 'NVIDIA H100 80GB HBM3',
            name: 'H100 SXM',
            memory: 80,
            secure: true,
            price: { secure: 4.49 },
            availability: 'LOW',
          },
          {
            id: 'NVIDIA RTX A5000',
            name: 'RTX A5000',
            memory: 24,
            secure: true,
            price: { secure: 0.27 },
            availability: 'HIGH',
          },
        ],
      });
      return;
    }
    json(404, { status: 404, detail: 'no route' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  return `http://127.0.0.1:${address.port}`;
}

/** Desk page files and an app build, as fixtures. */
async function assets(base: string): Promise<{ desk: URL; app: URL }> {
  const desk = join(base, 'assets', 'cli');
  await mkdir(join(desk, 'vendor'), { recursive: true });
  await mkdir(join(base, 'assets', 'ui'));
  for (const name of [
    'desk.css',
    'desk-client.js',
    'desk-transcript.js',
    'desk-terminal.js',
    'desk-terminals.js',
    'desk-lease.js',
    'desk-map.js',
    'desk-motion.js',
    'manrope.ttf',
    'symbol.webp',
  ])
    await writeFile(join(desk, name), 'fixture asset');
  for (const name of [
    'purify.js',
    'idiomorph.js',
    'xterm.js',
    'xterm.css',
    'addon-fit.js',
  ])
    await writeFile(join(desk, 'vendor', name), 'fixture');
  await writeFile(join(base, 'assets', 'ui', 'dom.js'), 'fixture module');
  await writeFile(join(base, 'assets', 'ui', 'token.js'), 'fixture module');
  const app = join(base, 'app');
  await mkdir(join(app, 'assets'), { recursive: true });
  await writeFile(
    join(app, 'index.html'),
    '<!doctype html><div id="root"></div>',
  );
  await writeFile(join(app, 'assets', 'index-abc.js'), 'x');
  return {
    desk: pathToFileURL(`${desk}/`),
    app: pathToFileURL(`${app}/`),
  };
}

const claudeFound: HarnessStatus = {
  harness: 'claude',
  installed: true,
  version: '2.1.304',
  signedIn: true,
  plan: 'max',
  models: claudeChoices('opus[1m]', 'max'),
};

const codexMissing: HarnessStatus = {
  harness: 'codex',
  installed: false,
  version: null,
  signedIn: null,
  plan: null,
  models: [],
};

/** Wait until `check` holds, for at most 10 seconds. */
async function until(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error('The condition did not hold in time.');
    await delay(25);
  }
}

await test('the first run through the API: agents, a conversation that ends in a card, a key that no answer holds, and limits that new projects copy', async (t) => {
  const base = await folder(t, 'first-run');
  const agency = join(base, 'agency');
  const home = join(base, 'home');
  const url = await fakeRunPod(t);
  const store = (): KeyStore =>
    new KeyStore({
      home,
      platform: 'linux',
      secretTool: join(base, 'no-secret-tool'),
    });
  const folderCompute = new Compute(join(base, 'here'), {
    store: store(),
    url,
  });
  await folderCompute.load();
  const fake = fakeRun([
    JSON.stringify({
      question: 'How should the agents talk to you?',
      suggestions: ['Short and direct', 'Show the reasoning', 'Like a paper'],
    }),
    JSON.stringify({
      card: { workOn: 'Interpretability', explore: 'Probes', talk: 'Short.' },
    }),
    JSON.stringify({
      card: {
        workOn: 'Interpretability and alignment',
        explore: 'Probes and SAEs',
        talk: 'Short.',
      },
    }),
  ]);
  const owner = new AbortController();
  const files = await assets(base);
  const desk = await startDesk(
    null,
    owner.signal,
    files.desk,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      appRoot: files.app,
      firstRun: new FirstRun({
        directory: agency,
        compute: folderCompute,
        signal: owner.signal,
        harness: fake.run,
        detect: () => Promise.resolve([claudeFound, codexMissing]),
        installed: () => Promise.resolve(['claude']),
      }),
    },
  );
  t.after(async () => {
    owner.abort();
    await desk.closed;
  });
  const origin = new URL(desk.url).origin;
  const token = new URL(desk.url).hash.slice(1);
  const said: string[] = [];
  const read = async (): Promise<SetupView> => {
    const response = await fetch(`${origin}/api/v1/setup`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    said.push(text);
    assert.equal(response.status, 200, text);
    return JSON.parse(text) as SetupView;
  };
  const act = async (
    name: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${origin}/api/v1/actions/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    said.push(text);
    return { status: response.status, text };
  };
  assert.equal((await fetch(`${origin}/api/v1/setup`)).status, 401);
  const fresh = await read();
  assert.deepEqual(fresh.steps, {
    agents: null,
    about: null,
    skills: null,
    money: null,
  });
  await until(async () => !(await read()).agents.checking);

  // Step 1: the agents.
  const found = await read();
  assert.deepEqual(
    found.agents.tools.map((tool) => [tool.harness, tool.use, tool.model]),
    [
      ['claude', true, 'opus[1m]'],
      ['codex', false, null],
    ],
  );
  assert.equal(
    (
      await act('setup-agents', {
        claude: { use: false },
        codex: { use: false },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await act('setup-agents', {
        claude: { use: true, model: 'fable' },
        codex: { use: false },
      })
    ).status,
    200,
  );
  assert.deepEqual((await loadSettings(agency)).agency, {
    host: 'claude',
    model: 'fable',
  });

  // Step 2: an answer, a question with suggestions, an answer, then the card.
  assert.equal(
    (await act('setup-say', { text: 'Interpretability. Probes.' })).status,
    202,
  );
  await until(async () => (await read()).about.busy === null);
  const asked = await read();
  assert.equal(asked.about.harness, 'claude');
  assert.deepEqual(asked.about.lines.at(-1), {
    from: 'claude',
    text: 'How should the agents talk to you?',
    suggestions: ['Short and direct', 'Show the reasoning', 'Like a paper'],
  });
  // The agent runs on the harness and model of the agents step.
  assert.equal(fake.requests[0]?.model, 'fable');
  await act('setup-say', { text: 'Short.' });
  await until(async () => (await read()).about.card !== null);
  // A note changes the card as the person edited it.
  const edited = {
    workOn: 'Interpretability and alignment',
    explore: 'Probes',
    talk: 'Short.',
  };
  await act('setup-say', { text: 'Add SAEs.', card: edited });
  await until(
    async () => (await read()).about.card?.explore === 'Probes and SAEs',
  );
  assert.match(
    fake.requests[2]?.prompt ?? '',
    /"workOn":"Interpretability and alignment"/,
  );
  const card = (await read()).about.card;
  assert.ok(card);
  assert.equal((await act('setup-about', { card })).status, 200);
  assert.deepEqual(
    parseCard(await readFile(join(agency, 'USER.md'), 'utf8')),
    card,
  );
  const afterAbout = await read();
  assert.equal(afterAbout.about.saved, 'card');
  assert.equal(afterAbout.steps.about, 'done');
  assert.match(
    await readFile(join(agency, 'profile-state.json'), 'utf8'),
    /"accepted"/,
  );

  // Step 3: a wrong key is refused without an echo; the right one is stored, and the prices load.
  const wrong = 'rpa_WRONGKEY0123456789abcdef0000';
  const refused = await act('setup-key', { runpodKey: wrong, file: true });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /did not accept the key/);
  assert.doesNotMatch(refused.text, /WRONGKEY/);
  const stored = await act('setup-key', { runpodKey: key, file: true });
  assert.equal(stored.status, 200, stored.text);
  await until(async () => (await read()).money.prices !== null);
  const money = await read();
  assert.equal(money.money.key?.last4, 'WXYZ');
  // The common GPUs, the dearest first. A type that is not common stays out.
  assert.deepEqual(
    money.money.prices?.gpus.map((gpu) => [gpu.id, gpu.usdPerHour]),
    [
      ['NVIDIA H100 80GB HBM3', 4.49],
      ['NVIDIA GeForce RTX 4090', 0.74],
    ],
  );
  assert.deepEqual(money.money.limits, profileMoneyDefaults);
  // No project spent on pods this month yet.
  assert.deepEqual(money.money.month, { spentUsd: 0, problem: null });
  const limits = {
    limitUsd: 25,
    maxUsdPerHour: 4,
    maxHoursPerLease: 4,
    idleMinutes: 15,
    maxRunningPods: 1,
    gpuTypes: ['NVIDIA GeForce RTX 4090'],
    monthUsd: 60,
  };
  const tooLong = await act('setup-money', { ...limits, maxHoursPerLease: 30 });
  assert.equal(tooLong.status, 409);
  assert.match(tooLong.text, /hours of a lease/);
  const noMonth = await act('setup-money', { ...limits, monthUsd: 0 });
  assert.equal(noMonth.status, 409);
  assert.match(noMonth.text, /the monthly limit in USD as a number from 1/);
  assert.equal((await act('setup-money', limits)).status, 200);
  assert.equal((await read()).steps.money, 'done');
  assert.equal((await read()).money.limits.monthUsd, 60);
  // An empty field means no monthly limit.
  assert.equal(
    (await act('setup-money', { ...limits, monthUsd: '' })).status,
    200,
  );
  assert.equal((await read()).money.limits.monthUsd, null);
  assert.equal((await act('setup-money', limits)).status, 200);
  // No answer, and no file of the profile, holds the key.
  for (const text of said) assert.doesNotMatch(text, /TESTKEY/);
  assert.doesNotMatch(await everything(agency), /TESTKEY/);

  // A new project starts with the profile's limits, so an agent can rent an allowed GPU within them.
  const quiet = {
    interactive: false,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
  };
  const project = join(base, 'project');
  await initializeProject(
    project,
    base,
    { host: 'claude', agencyDir: agency, setupOnly: true },
    quiet,
    signal,
  );
  const copied = JSON.parse(
    await readFile(
      join(project, '.verifold', 'compute', 'settings.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(copied.limitUsd, 25);
  assert.equal(copied.maxUsdPerHour, 4);
  assert.deepEqual(copied.gpuTypes, ['NVIDIA GeForce RTX 4090']);
  // The monthly limit stays in the profile: each check reads it there.
  assert.equal('monthUsd' in copied, false);
  const pods = new Compute(project, { store: store(), url });
  await pods.load();
  const pod = {
    gpu: 'NVIDIA GeForce RTX 4090',
    hours: 1,
    directions: ['d-1'],
    reason: 'A probe sweep.',
  };
  assert.ok((await pods.podCost(pod)) > 0);
  // A GPU that the person did not allow is refused.
  await assert.rejects(
    pods.podCost({ ...pod, gpu: 'NVIDIA H100 80GB HBM3' }),
    /Ask for an allowed GPU type/,
  );

  // "No GPUs for now": a new project has pods off.
  assert.equal(
    (await act('setup-money', { ...limits, limitUsd: null })).status,
    200,
  );
  const off = join(base, 'project-off');
  await initializeProject(
    off,
    base,
    { host: 'claude', agencyDir: agency, setupOnly: true },
    quiet,
    signal,
  );
  const none = new Compute(off, { store: store(), url });
  await none.load();
  await assert.rejects(none.podCost(pod), /Pods are off/);

  // Skipping marks only the steps without a record.
  await act('setup-skip', { step: 'all' });
  assert.deepEqual((await read()).steps, {
    agents: 'done',
    about: 'done',
    skills: 'skipped',
    money: 'done',
  });
});

await test('without a signed-in agent, Verifold asks the questions and the card comes from the answers', async (t) => {
  const base = await folder(t, 'first-run-local');
  const compute = new Compute(join(base, 'here'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await compute.load();
  const setup = new FirstRun({
    directory: join(base, 'agency'),
    compute,
    signal,
    harness: () => Promise.reject(new Error('No harness runs here.')),
    detect: () =>
      Promise.resolve([{ ...claudeFound, signedIn: false }, codexMissing]),
    installed: () => Promise.resolve(['claude']),
  });
  assert.equal(await setup.act({ action: 'setup-say', text: 'Graphs.' }), 202);
  const wait = async (): Promise<SetupView> => {
    for (;;) {
      const view = await setup.view();
      if (!view.about.busy) return view;
      await delay(10);
    }
  };
  const asked = await wait();
  assert.equal(asked.about.harness, null);
  assert.equal(asked.about.lines.at(-1)?.from, 'verifold');
  await setup.act({ action: 'setup-say', text: 'Tables.' });
  assert.deepEqual((await wait()).about.card, {
    workOn: 'Graphs.',
    explore: '',
    talk: 'Tables.',
  });
  // A note needs an agent: the card is edited instead.
  await setup.act({ action: 'setup-say', text: 'More.' });
  assert.match((await wait()).about.error ?? '', /No agent is signed in/);
  // The same intent key gets the same answer once.
  const key = 'a'.repeat(32);
  assert.equal(await setup.act({ action: 'setup-restart', key }), 200);
  assert.equal(await setup.act({ action: 'setup-restart', key }), 200);
  assert.equal((await setup.view()).about.lines.length, 1);
  await assert.rejects(
    setup.act({
      action: 'setup-about',
      card: { workOn: '', explore: '', talk: '' },
    }),
    /at least one field/,
  );
});

await test('the conversation takes one answer at a time, a save holds it, the style answer is "Talk to me", and starting again leaves the saved card out', async (t) => {
  const base = await folder(t, 'first-run-turns');
  const agency = join(base, 'agency');
  const compute = new Compute(join(base, 'here'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await compute.load();
  // A harness that answers when the test says so.
  const waiting: ((text: string) => void)[] = [];
  const requests: HarnessRequest[] = [];
  const setup = new FirstRun({
    directory: agency,
    compute,
    signal,
    harness: (request) => {
      requests.push(request);
      return new Promise((resolve) =>
        waiting.push((text) => resolve({ text })),
      );
    },
    detect: () => Promise.resolve([claudeFound, codexMissing]),
    installed: () => Promise.resolve(['claude']),
  });
  const answer = async (text: string): Promise<void> => {
    await until(() => Promise.resolve(waiting.length === 1));
    waiting.shift()?.(text);
    await until(async () => (await setup.view()).about.busy === null);
  };
  // Two answers at once: the second is refused before any wait.
  const first = setup.act({ action: 'setup-say', text: 'Interpretability.' });
  await assert.rejects(
    setup.act({ action: 'setup-say', text: 'Twice.' }),
    /still writes/,
  );
  assert.equal(await first, 202);
  await answer(
    JSON.stringify({
      question: 'How should the agents write to you?',
      suggestions: ['Short'],
      asks: 'talk',
    }),
  );
  assert.equal((await setup.view()).about.lines.at(-1)?.asks, 'talk');
  await setup.act({ action: 'setup-say', text: 'Short and direct.' });
  await answer(JSON.stringify({ question: 'Anything else to explore?' }));
  await setup.act({ action: 'setup-say', text: 'Probes and SAEs.' });
  await answer('not a card');
  assert.match((await setup.view()).about.error ?? '', /did not send a card/);
  // The card from the answers: the answer to the style question is "Talk to me".
  await setup.act({ action: 'setup-fill' });
  const card = {
    workOn: 'Interpretability.',
    explore: 'Probes and SAEs.',
    talk: 'Short and direct.',
  };
  assert.deepEqual((await setup.view()).about.card, card);
  // A save holds the conversation: an answer meanwhile is refused.
  const saving = setup.act({ action: 'setup-about', card });
  await assert.rejects(
    setup.act({ action: 'setup-say', text: 'During the save.' }),
    /being saved/,
  );
  assert.equal(await saving, 200);
  // An older Verifold can read the settings: they name a lead harness.
  assert.deepEqual((await loadSettings(agency)).agency, { host: 'claude' });
  // Starting again leaves the saved card out: an answer is an answer, and a question comes.
  assert.deepEqual((await setup.view()).about.card, card);
  await setup.act({ action: 'setup-restart' });
  const fresh = await setup.view();
  assert.equal(fresh.about.card, null);
  assert.equal(fresh.about.saved, 'card');
  await setup.act({ action: 'setup-say', text: 'Graphs now.' });
  await until(() => Promise.resolve(waiting.length === 1));
  const input = JSON.parse(
    (requests.at(-1)?.prompt ?? '').split('The input, as JSON:\n')[1] ?? '{}',
  ) as Record<string, unknown>;
  assert.equal(input.questionsLeft, 2);
  assert.equal(input.card, undefined);
  assert.equal(input.note, undefined);
  await answer(JSON.stringify({ question: 'Which graphs?' }));
  assert.equal((await setup.view()).about.lines.at(-1)?.text, 'Which graphs?');
  // The saved card stays saved until a new one replaces it.
  assert.deepEqual(
    parseCard(await readFile(join(agency, 'USER.md'), 'utf8')),
    card,
  );
  // A skip of everything keeps the lead harness, and the record that the person chose no agents.
  await setup.act({ action: 'setup-skip', step: 'all' });
  const raw = JSON.parse(
    await readFile(join(agency, 'settings.json'), 'utf8'),
  ) as { host: string; steps: Record<string, string> };
  assert.equal(raw.host, 'claude');
  assert.equal(raw.steps.agents, 'skipped');
});

await test('settings that a skip writes first name a lead harness, and limits that are not valid show a notice until a save replaces them', async (t) => {
  const base = await folder(t, 'first-run-lead');
  const agency = join(base, 'agency');
  const compute = new Compute(join(base, 'here'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await compute.load();
  const setup = (installed: readonly ('claude' | 'codex')[]): FirstRun =>
    new FirstRun({
      directory: agency,
      compute,
      signal,
      detect: () => Promise.resolve([claudeFound, codexMissing]),
      installed: () => Promise.resolve(installed),
    });
  await setup(['claude', 'codex']).act({ action: 'setup-skip', step: 'all' });
  assert.deepEqual((await loadSettings(agency)).agency, {
    host: 'claude',
    helper: 'codex',
  });
  await rm(join(agency, 'settings.json'));
  await setup(['codex']).act({ action: 'setup-skip', step: 'agents' });
  assert.deepEqual((await loadSettings(agency)).agency, { host: 'codex' });
  // Limits that are not valid: the step still opens, says why, and a save replaces them.
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({ host: 'codex', money: { limitUsd: -5 } }),
  );
  const run = setup(['codex']);
  const view = await run.view();
  assert.match(
    view.money.unreadable ?? '',
    /^The saved GPU limits are not valid: .+ They show the defaults until you save new ones\.$/,
  );
  assert.deepEqual(view.money.limits, profileMoneyDefaults);
  assert.equal(
    await run.act({ action: 'setup-money', ...profileMoneyDefaults }),
    200,
  );
  assert.equal((await run.view()).money.unreadable, null);
});

await test('a key stored while the prices load reads them once more after the read that runs', async (t) => {
  const base = await folder(t, 'first-run-prices');
  let reads = 0;
  const ends: (() => void)[] = [];
  const compute = {
    keySaved: () => true,
    setKey: () => Promise.resolve(),
    refreshGpus: () => {
      reads += 1;
      return new Promise<void>((resolve) => ends.push(resolve));
    },
  } as unknown as Compute;
  const setup = new FirstRun({
    directory: join(base, 'agency'),
    compute,
    signal,
    detect: () => Promise.resolve([]),
    installed: () => Promise.resolve([]),
  });
  const first = setup.act({ action: 'setup-prices' });
  assert.equal(
    await setup.act({ action: 'setup-key', runpodKey: key, file: true }),
    200,
  );
  assert.equal(reads, 1);
  // The read with the key before ends, so the read with the new key starts.
  ends.shift()?.();
  await until(() => Promise.resolve(reads === 2));
  ends.shift()?.();
  assert.equal(await first, 200);
});

await test('a new project keeps the compute settings of its folder, and a failed setup removes only what it made', async (t) => {
  const base = await folder(t, 'create');
  const workspace = {
    schemaVersion: 1 as const,
    visibility: 'private' as const,
    profile: {
      name: 'Researcher',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  };
  const limits = { ...computeDefaults, limitUsd: 25 };
  const kept = join(base, 'kept');
  const settings = join(kept, '.verifold', 'compute', 'settings.json');
  await mkdir(join(kept, '.verifold', 'compute'), { recursive: true });
  await writeFile(settings, '{"set": "here before"}');
  await createProject(kept, workspace, 'Q', undefined, signal, true, limits);
  assert.equal(await readFile(settings, 'utf8'), '{"set": "here before"}');
  // A setup that fails after the limits were written removes them and the folder that it made.
  const failed = join(base, 'failed');
  const made = join(failed, '.verifold', 'compute', 'settings.json');
  const stop = {
    throwIfAborted: () => {
      if (existsSync(made)) throw new Error('Stopped.');
    },
  } as unknown as AbortSignal;
  await assert.rejects(
    createProject(failed, workspace, 'Q', undefined, stop, true, limits),
    /Stopped/,
  );
  assert.equal(existsSync(made), false);
  assert.equal(existsSync(join(failed, '.verifold', 'compute')), false);
});

await test('verifold in a folder without a project starts the first run without a project or an owner', async (t) => {
  const base = await folder(t, 'start');
  const root = join(base, 'new-folder');
  await mkdir(root);
  const files = await assets(base);
  const owner = new AbortController();
  const out: string[] = [];
  const progress: string[] = [];
  const opened: string[] = [];
  const io = {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: (value: string) => {
      out.push(value);
    },
    progress: (value: string) => {
      progress.push(value);
    },
    browse: (url: string) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    deskAssets: files.desk,
    appAssets: files.app,
    compute: {
      store: {
        home: join(base, 'home'),
        platform: 'linux' as const,
        secretTool: join(base, 'no-secret-tool'),
      },
    },
  };
  // A bare verifold in a new folder opens the app's first run. --app is the default.
  const running = runCli(
    ['--agency-dir', join(base, 'agency')],
    root,
    io,
    owner.signal,
  );
  t.after(async () => {
    owner.abort();
    await running.catch(() => {});
  });
  await until(() => Promise.resolve(out.length > 0));
  const shown = JSON.parse(out[0] ?? '{}') as { url: string; app: string };
  assert.match(shown.app, /\/app\/#[0-9a-f]{64}$/);
  // The browser gets a one-time code for the app, never the token.
  assert.match(opened[0] ?? '', /\/app\/#launch-[0-9a-f]{48}$/);
  assert.match(progress.join('\n'), /Set up Verifold in your browser/);
  const url = new URL(shown.url);
  const view = await fetch(`${url.origin}/api/v1/setup`, {
    headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
  });
  assert.equal(view.status, 200);
  const snapshot = (await (
    await fetch(`${url.origin}/api/v1/snapshot`, {
      headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
    })
  ).json()) as { project: string; lab: unknown };
  assert.equal(snapshot.project, '');
  assert.equal(snapshot.lab, null);
  // No project and no owner.
  await assert.rejects(stat(join(root, '.verifold')), { code: 'ENOENT' });
  owner.abort();
  await running;
  // Flags of project setup do not go with the app's first run, with or without --app.
  await assert.rejects(
    runCli(['--host', 'claude'], root, io),
    /Run it without --host, or run verifold init\./,
  );
  await assert.rejects(
    runCli(['--app', '--host', 'claude'], root, io),
    /Run it without --host/,
  );
  await assert.rejects(
    runCli(['--app', '--desk'], root, io),
    /Choose --app or --desk, not both\./,
  );
  // Without the app's build, a bare verifold sets up in the old desk, as --desk does.
  const urls: string[] = [];
  const lines: string[] = [];
  const stopSetup = new AbortController();
  const setup = runCli(
    ['--agency-dir', join(base, 'agency')],
    root,
    {
      ...io,
      out: (value: string) => {
        urls.push(value);
      },
      progress: (value: string) => {
        lines.push(value);
      },
      appAssets: pathToFileURL(`${join(base, 'no-app-build')}/`),
    },
    stopSetup.signal,
  );
  t.after(async () => {
    stopSetup.abort();
    await setup.catch(() => {});
  });
  await until(() => Promise.resolve(urls.length > 0));
  assert.equal(
    lines[0],
    'This Verifold has no app build, so setup opens in the old desk.',
  );
  const printed = JSON.parse(urls[0] ?? '{}') as { url: string; app?: string };
  assert.equal(new URL(printed.url).pathname, '/desk');
  assert.equal(printed.app, undefined);
  assert.match(opened.at(-1) ?? '', /\/desk#launch-[0-9a-f]{48}$/);
  stopSetup.abort();
  await setup.catch(() => {});
  await assert.rejects(stat(join(root, '.verifold')), { code: 'ENOENT' });
});

await test('verifold in a project opens the app, --desk opens the old desk, and /open and /desk open each', async (t) => {
  const base = await folder(t, 'launch');
  const root = join(base, 'project');
  await mkdir(root);
  await createProject(
    root,
    {
      schemaVersion: 1,
      visibility: 'private',
      profile: {
        name: 'Researcher',
        interests: ['Probes'],
        scholar: '',
        github: '',
        session: '',
      },
      host: 'claude',
      candidates: [],
      selectedId: null,
    },
    'Do probes see it?',
    undefined,
    new AbortController().signal,
    true,
  );
  const files = await assets(base);
  const agency = join(base, 'agency');
  // A setup that was done before: --desk then asks nothing in the terminal.
  await saveAgencyFile(
    agency,
    'profile-state.json',
    JSON.stringify({ schemaVersion: 1, status: 'skipped' }),
  );
  const launch = async (args: readonly string[]) => {
    const stop = new AbortController();
    const out: string[] = [];
    const progress: string[] = [];
    const opened: string[] = [];
    const typed: ((line: string) => void)[] = [];
    const running = runCli(
      [...args, '--no-open', '--agency-dir', agency],
      root,
      {
        interactive: true,
        ask: () => Promise.reject(new Error('No prompts')),
        out: (value: string) => {
          out.push(value);
        },
        progress: (value: string) => {
          progress.push(value);
        },
        browse: (url: string) => {
          opened.push(url);
          return Promise.resolve(true);
        },
        listen: (onLine: (line: string) => void) => {
          typed.push(onLine);
        },
        deskAssets: files.desk,
        appAssets: files.app,
        compute: {
          store: {
            home: join(base, 'home'),
            platform: 'linux' as const,
            secretTool: join(base, 'no-secret-tool'),
          },
        },
      },
      stop.signal,
    );
    t.after(async () => {
      stop.abort();
      await running.catch(() => {});
    });
    await until(() => Promise.resolve(out.length > 0 && typed.length > 0));
    return {
      shown: JSON.parse(out[0] ?? '{}') as { url: string; app?: string },
      progress,
      opened,
      type: (line: string) => typed[0]?.(line),
      stop: async () => {
        stop.abort();
        await running;
      },
    };
  };
  const app = await launch([]);
  const origin = new URL(app.shown.url).origin;
  assert.equal(app.shown.app, `${origin}/app/${new URL(app.shown.url).hash}`);
  assert.ok(
    app.progress.includes(
      'Open the printed URL to use Verifold. Keep this terminal open. Type /help for commands.',
    ),
  );
  // The printed URL leads to the app.
  const home = await fetch(`${origin}/`, { redirect: 'manual' });
  assert.equal(home.headers.get('location'), '/app/');
  app.type('/open');
  await until(() => Promise.resolve(app.opened.length === 1));
  assert.match(app.opened[0] ?? '', /\/app\/#launch-[0-9a-f]{48}$/);
  app.type('/desk');
  await until(() => Promise.resolve(app.opened.length === 2));
  assert.match(app.opened[1] ?? '', /\/desk#launch-[0-9a-f]{48}$/);
  await until(() =>
    Promise.resolve(
      app.progress.includes('The old desk opened in your browser.'),
    ),
  );
  await app.stop();
  const desk = await launch(['--desk']);
  assert.equal(new URL(desk.shown.url).pathname, '/desk');
  assert.equal(desk.shown.app, undefined);
  assert.ok(
    desk.progress.includes(
      'Open the printed URL to use the old desk. Keep this terminal open. Type /help for commands.',
    ),
  );
  // In this terminal, /open opens the old desk, as Enter on an empty line does. /app still opens the app.
  desk.type('/open');
  await until(() => Promise.resolve(desk.opened.length === 1));
  assert.match(desk.opened[0] ?? '', /\/desk#launch-[0-9a-f]{48}$/);
  desk.type('/app');
  await until(() => Promise.resolve(desk.opened.length === 2));
  assert.match(desk.opened[1] ?? '', /\/app\/#launch-[0-9a-f]{48}$/);
  await desk.stop();
  // A run of the earlier research flow opens in the old desk, and the terminal says why.
  const flow =
    "This project uses the earlier research flow, so it opens in the old desk. Its records also show read-only in the app's History.";
  await mkdir(join(root, '.verifold', 'coordinator'));
  await writeFile(join(root, '.verifold', 'coordinator', 'state.json'), '{}');
  const research = await launch([]);
  assert.equal(new URL(research.shown.url).pathname, '/desk');
  assert.equal(research.shown.app, undefined);
  assert.ok(research.progress.includes(flow));
  // The app shows that run in History.
  const place = new URL(research.shown.url);
  const shot = (await (
    await fetch(`${place.origin}/api/v1/snapshot`, {
      headers: { Authorization: `Bearer ${place.hash.slice(1)}` },
    })
  ).json()) as { researchRun?: boolean };
  assert.equal(shot.researchRun, true);
  await research.stop();
  // --app still opens the app there.
  const asked = await launch(['--app']);
  assert.ok(asked.shown.app);
  assert.ok(!asked.progress.includes(flow));
  await asked.stop();
  // A lab owns the project's run, so the project opens in the app again.
  await writeFile(
    join(root, '.verifold', 'lab.json'),
    JSON.stringify({
      schemaVersion: 1,
      question: 'Do probes see it?',
      startedAt: new Date().toISOString(),
      directions: [],
    }),
  );
  const lab = await launch([]);
  assert.ok(lab.shown.app);
  assert.ok(!lab.progress.includes(flow));
  await lab.stop();
});

await test('the price list shows the common GPUs that RunPod lists, else the cheapest that fit research', () => {
  const offer = (id: string, price: number, memoryGb = 80) => ({
    id,
    name: id,
    memoryGb,
    price,
    stock: 'HIGH' as const,
  });
  assert.deepEqual(
    shortlist([
      offer('NVIDIA RTX A5000', 0.27, 24),
      offer('NVIDIA L40S', 0.86, 48),
      offer('NVIDIA H200', 3.59, 141),
    ]).map((gpu) => gpu.id),
    ['NVIDIA H200', 'NVIDIA L40S'],
  );
  // Without a common type: the cheapest in stock with at least 24 GB.
  assert.deepEqual(
    shortlist([
      offer('Small', 0.1, 16),
      offer('Mid', 0.3, 24),
      { ...offer('Gone', 0.2, 48), stock: 'NONE' as const },
    ]).map((gpu) => gpu.id),
    ['Mid'],
  );
});

await test("the money step shows this month's spend from a read a few seconds old, and says when Verifold cannot tell it", async (t) => {
  const agency = join(await folder(t, 'month'), 'agency');
  await prepareAgency(agency);
  const gpu = monthFolder(agency);
  await mkdir(gpu);
  await writeFile(
    join(gpu, 'aaaaaaaaaaaaaaaa.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: '/elsewhere',
      month: monthKey(Date.now()),
      writtenAt: new Date().toISOString(),
      endedUsd: 12.5,
      open: [],
    }),
  );
  const compute = {
    view: () => ({ key: null, keyring: null, gpus: null, gpusAt: null }),
  } as unknown as Compute;
  const make = (): FirstRun =>
    new FirstRun({
      directory: agency,
      compute,
      signal,
      detect: () => Promise.resolve([]),
      installed: () => Promise.resolve([]),
    });
  const setup = make();
  assert.deepEqual((await setup.view()).money.month, {
    spentUsd: 12.5,
    problem: null,
  });
  // The page polls, so a read a few seconds old serves again.
  const broken = join(gpu, 'bbbbbbbbbbbbbbbb.json');
  await writeFile(broken, '{');
  assert.deepEqual((await setup.view()).money.month, {
    spentUsd: 12.5,
    problem: null,
  });
  // A new read cannot tell the spend of a record that it cannot read, and the step says so.
  assert.equal(
    (await make().view()).money.month?.problem,
    `Verifold can't read ${broken}, the GPU record of another project, so it can't tell what that project spent, and no new pod starts. If that project no longer exists, remove the file. If it does, open Verifold in that project, so it writes the file again.`,
  );
});
