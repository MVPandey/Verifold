import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSettings, writeSettings } from '../src/core/agency.ts';
import { profileMoneyDefaults } from '../src/core/compute.ts';
import { loadWorkspace } from '../src/core/storage.ts';
import type { HarnessStatus } from '../src/core/detect.ts';
import { askStart, defaultTeam } from '../src/cli/ask-start.ts';
import { expandHome, homeShown } from '../src/cli/project.ts';
import { runCli, type CliIO } from '../src/cli/commands.ts';
import type { SetupView, StartView } from '../src/protocol/api.ts';

// The lab that a start begins runs its first agent from PATH. Fake claude
// and codex commands that stop at once come first, so no test reaches a
// real harness.
const fakeBin = await mkdtemp(join(tmpdir(), 'verifold-fake-bin-'));
for (const name of ['claude', 'codex'])
  await writeFile(join(fakeBin, name), '#!/bin/sh\nexit 1\n', {
    mode: 0o700,
  });
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;
process.on('exit', () => {
  rmSync(fakeBin, { recursive: true, force: true });
});

async function folder(t: test.TestContext, name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `verifold-${name}-`));
  t.after(() =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  return path;
}

async function until(
  check: () => Promise<boolean>,
  ms = 15_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error('The condition did not hold in time.');
    await delay(25);
  }
}

/** A profile with both harnesses, their models, and GPU limits. */
async function profile(agency: string): Promise<void> {
  await writeSettings(agency, (current) => ({
    ...current,
    agency: {
      host: 'claude',
      model: 'opus[1m]',
      helper: 'codex',
      helperModel: 'gpt-6-astra',
    },
    money: {
      ...profileMoneyDefaults,
      limitUsd: 30,
      gpuTypes: ['NVIDIA L40S'],
    },
    steps: { agents: 'done', about: 'done', money: 'done' },
  }));
}

/** A harness as detection finds it. */
function found(
  harness: 'claude' | 'codex',
  fields: Partial<HarnessStatus> = {},
): HarnessStatus {
  return {
    harness,
    installed: true,
    version: '1.0.0',
    signedIn: true,
    plan: null,
    models: [{ id: harness === 'claude' ? 'opus' : 'gpt-6-astra', label: 'x' }],
    ...fields,
  };
}

await test("a new project's agents: the profile's team with its saved models, else the usable harnesses on this computer, Claude Code first, without pinned models", () => {
  const both = [found('claude'), found('codex')];
  assert.deepEqual(
    defaultTeam(
      { host: 'codex', model: 'gpt-6-astra', helper: 'claude' },
      both,
    ),
    { host: 'codex', model: 'gpt-6-astra', helper: 'claude' },
  );
  assert.deepEqual(defaultTeam(null, both), {
    host: 'claude',
    helper: 'codex',
  });
  // Only Codex is installed, or Claude Code is signed out: Codex leads alone.
  assert.deepEqual(
    defaultTeam(null, [found('claude', { installed: false }), found('codex')]),
    { host: 'codex' },
  );
  assert.deepEqual(
    defaultTeam(null, [found('claude', { signedIn: false }), found('codex')]),
    { host: 'codex' },
  );
  // A sign-in that Verifold cannot tell counts as usable.
  assert.deepEqual(defaultTeam(null, [found('claude', { signedIn: null })]), {
    host: 'claude',
  });
  assert.equal(
    defaultTeam(null, [
      found('claude', { signedIn: false }),
      found('codex', { installed: false }),
    ]),
    null,
  );
});

await test('a folder reads with ~ for the home folder, and a folder that the person types may start with ~/ or be a full path', () => {
  const home = homedir();
  assert.equal(homeShown(join(home, 'research', 'cot')), '~/research/cot');
  assert.equal(homeShown(home), '~');
  assert.equal(homeShown('/srv/research'), '/srv/research');
  assert.equal(homeShown(`${home}-old/cot`), `${home}-old/cot`);
  assert.equal(
    expandHome('~/research/new', '/srv'),
    join(home, 'research', 'new'),
  );
  assert.equal(expandHome('/srv/cot', '/elsewhere'), '/srv/cot');
  assert.equal(expandHome('cot', '/srv'), '/srv/cot');
});

await test('without a profile, or with one that does not read, a start takes the harnesses on this computer and no GPUs, and says so before it starts', async (t) => {
  const base = await folder(t, 'ask-detect');
  const here = join(base, 'here');
  await mkdir(here);
  const signal = new AbortController().signal;
  let detections = 0;
  const detect = (): Promise<readonly HarnessStatus[]> => {
    detections++;
    return Promise.resolve([
      found('claude', { signedIn: false }),
      found('codex'),
    ]);
  };
  const empty = askStart({
    root: here,
    agency: join(base, 'none'),
    signal,
    detect,
  });
  const view = await empty.start.view();
  assert.deepEqual(view.agents, { host: 'codex' });
  assert.equal(view.gpuUsd, null);
  assert.equal(view.gpuLimits, false);
  assert.equal(view.started, false);
  // Detection runs once for the page and its start.
  await empty.start.view();
  assert.equal(detections, 1);
  // A look that fails runs again at the next read.
  let failures = 1;
  const flaky = askStart({
    root: here,
    agency: join(base, 'none'),
    signal,
    detect: () =>
      failures-- > 0 ? Promise.reject(new Error('busy')) : detect(),
  });
  assert.equal((await flaky.start.view()).agents, null);
  assert.deepEqual((await flaky.start.view()).agents, { host: 'codex' });
  // A profile that stops reading later leaves the harnesses on this computer.
  const later = join(base, 'later');
  await profile(later);
  const changing = askStart({ root: here, agency: later, signal, detect });
  assert.equal((await changing.start.view()).agents?.host, 'claude');
  await writeFile(join(later, 'settings.json'), '{ not json');
  assert.deepEqual((await changing.start.view()).agents, { host: 'codex' });
  // A profile file that does not read gives the same defaults, so the page never waits on it.
  const broken = join(base, 'broken');
  await mkdir(broken);
  await writeFile(join(broken, 'settings.json'), '{ not json');
  const unread = askStart({ root: here, agency: broken, signal, detect });
  assert.deepEqual((await unread.start.view()).agents, { host: 'codex' });
  // Start without agents sends what the page showed: Codex, its own default model, no GPUs.
  assert.equal(await unread.start.act({ question: 'Q?' }), 202);
  assert.equal((await unread.start.view()).started, true);
  const workspace = await loadWorkspace(here);
  assert.equal(workspace.host, 'codex');
  assert.equal(workspace.model, undefined);
  assert.equal(workspace.helper, undefined);
  const limits = JSON.parse(
    await readFile(join(here, '.verifold', 'compute', 'settings.json'), 'utf8'),
  ) as { limitUsd: number | null };
  assert.equal(limits.limitUsd, null);
  // No usable harness: the start says what to do and starts nothing.
  const other = join(base, 'other');
  await mkdir(other);
  const none = askStart({
    root: other,
    agency: join(base, 'none'),
    signal,
    detect: () => Promise.resolve([found('claude', { signedIn: false })]),
  });
  assert.equal((await none.start.view()).agents, null);
  await assert.rejects(
    none.start.act({ question: 'Q?' }),
    /no agent tool that is signed in\. Sign in to Claude Code or Codex/,
  );
  assert.equal(existsSync(join(other, '.verifold')), false);
});

await test("a start makes the project from the profile, and the Ask page's own choices apply to it only", async (t) => {
  const base = await folder(t, 'ask-start');
  const agency = join(base, 'agency');
  await profile(agency);
  const here = join(base, 'here');
  await mkdir(here);
  await writeFile(join(here, 'notes.md'), 'Earlier notes\n');
  const signal = new AbortController().signal;
  const first = askStart({ root: here, agency, signal });
  const view: StartView = await first.start.view();
  assert.equal(view.files, true);
  assert.equal(view.hours, 8);
  assert.equal(view.maxHours, 168);
  assert.equal(view.questionLimit, 4000);
  // The page shows the profile's team with its saved models, and its GPU limit.
  assert.deepEqual(view.agents, {
    host: 'claude',
    model: 'opus[1m]',
    helper: 'codex',
    helperModel: 'gpt-6-astra',
  });
  assert.equal(view.gpuUsd, 30);
  assert.equal(view.gpuLimits, true);
  assert.equal(view.started, false);

  // Refused input starts nothing, and says why.
  await assert.rejects(first.start.act({ question: '  ' }), /the question/);
  await assert.rejects(
    first.start.act({ question: 'Q?', folder: 'relative/path' }),
    /full path/,
  );
  await assert.rejects(
    first.start.act({ question: 'Q?', hours: 0 }),
    /whole hours, from 1 to 168/,
  );
  await assert.rejects(
    first.start.act({
      question: 'Q?',
      agents: { host: 'codex', helper: 'codex' },
    }),
    /two different agents/,
  );
  await assert.rejects(
    first.start.act({ question: 'Q?', agents: { host: 'gemini' } }),
    /claude or codex/,
  );
  await assert.rejects(
    first.start.act({ question: 'Q?', gpuUsd: 0 }),
    /spend limit/,
  );
  assert.equal(existsSync(join(here, '.verifold')), false);

  // A start without changes takes what the page showed: the profile's team, models, and limits.
  assert.equal(
    await first.start.act({ question: 'Do probes see faithfulness?' }),
    202,
  );
  assert.deepEqual(await first.begun, {
    root: here,
    question: 'Do probes see faithfulness?',
    hours: 8,
  });
  const workspace = await loadWorkspace(here);
  assert.equal(workspace.host, 'claude');
  assert.equal(workspace.helper, 'codex');
  assert.equal(workspace.model, 'opus[1m]');
  assert.equal(workspace.helperModel, 'gpt-6-astra');
  assert.equal(workspace.research?.topic, 'Do probes see faithfulness?');
  assert.equal(workspace.research?.phase, 'needs-plan');
  const limits = JSON.parse(
    await readFile(join(here, '.verifold', 'compute', 'settings.json'), 'utf8'),
  ) as { limitUsd: number | null; gpuTypes: string[] };
  assert.equal(limits.limitUsd, 30);
  assert.deepEqual(limits.gpuTypes, ['NVIDIA L40S']);
  // The monthly limit stays in the profile: each check reads it there.
  assert.equal('monthUsd' in limits, false);
  // One start only, and the page's next read says that it went through.
  await assert.rejects(
    first.start.act({ question: 'Again?' }),
    /started already/,
  );
  assert.equal((await first.start.view()).started, true);

  // The Ask page's choices: one harness with its model, no GPUs, more hours, and a new folder.
  const elsewhere = join(base, 'new', 'project');
  const second = askStart({ root: here, agency, signal });
  assert.equal(
    await second.start.act({
      question: 'Another question?',
      folder: elsewhere,
      agents: { host: 'codex', model: 'gpt-6-astra' },
      gpuUsd: null,
      hours: 24,
    }),
    202,
  );
  assert.equal((await second.begun).hours, 24);
  const chosen = await loadWorkspace(elsewhere);
  assert.equal(chosen.host, 'codex');
  assert.equal(chosen.model, 'gpt-6-astra');
  assert.equal(chosen.helper, undefined);
  const off = JSON.parse(
    await readFile(
      join(elsewhere, '.verifold', 'compute', 'settings.json'),
      'utf8',
    ),
  ) as { limitUsd: number | null };
  assert.equal(off.limitUsd, null);
  // A folder with a project is refused.
  const third = askStart({ root: here, agency, signal });
  await assert.rejects(
    third.start.act({ question: 'Here again?' }),
    /could not start the project in .*Workspace already exists/,
  );
});

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

/** A run of `verifold --app` without a project, as the Ask page starts it. */
interface Asked {
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly agency: string;
  /** The terminal's JSON lines, its status lines, and the pages that it opened. */
  readonly out: string[];
  readonly lines: string[];
  readonly opened: string[];
  /** The pages that the background owner opened. */
  readonly ownerOpened: string[];
  /** What the terminal gave each background owner that it started. */
  readonly handoffs: string[];
  /** Stop the terminal's run, and wait for it. */
  readonly stop: () => Promise<void>;
}

/**
 * Run `verifold --app` with `args` in a folder without a project. The
 * background owner runs in this process. `taken`: another program takes the
 * port of the closed start desk before the owner opens its own.
 */
async function askByApp(
  t: test.TestContext,
  args: readonly string[],
  taken = false,
): Promise<Asked> {
  const base = await folder(t, 'ask-cli');
  const root = join(base, 'cot');
  await mkdir(root);
  const agency = join(base, 'agency');
  await profile(agency);
  const files = await assets(base);
  const keys = join(base, 'keys');
  const controller = new AbortController();
  const owner = new AbortController();
  const handoffs: string[] = [];
  const blockers: Server[] = [];
  let ownerDone: Promise<void> | undefined;
  t.after(async () => {
    controller.abort();
    owner.abort();
    await ownerDone?.catch(() => {});
    for (const blocker of blockers) blocker.close();
  });
  const out: string[] = [];
  const lines: string[] = [];
  const opened: string[] = [];
  const ownerOpened: string[] = [];
  const io: CliIO = {
    interactive: true,
    ask: () => Promise.reject(new Error('The terminal must not ask.')),
    out: (value) => out.push(value),
    progress: (line) => lines.push(line),
    browse: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    deskAssets: files.desk,
    appAssets: files.app,
    compute: {
      store: {
        home: join(base, 'home'),
        platform: 'linux',
        secretTool: join(base, 'no-secret-tool'),
      },
    },
    // The test runs the background owner in this process. The executable spawns it detached.
    background: {
      keys,
      start: async (place, input) => {
        handoffs.push(input);
        if (taken) {
          const { desk } = JSON.parse(input) as { desk: { port: number } };
          const blocker = createServer();
          blocker.listen(desk.port, '127.0.0.1');
          await once(blocker, 'listening');
          blockers.push(blocker);
        }
        ownerDone = runCli(
          ['owner', '--workspace', place],
          place,
          {
            interactive: false,
            ask: () => Promise.reject(new Error('The owner asks nothing.')),
            out: () => {},
            browse: (url) => {
              ownerOpened.push(url);
              return Promise.resolve(true);
            },
            deskAssets: files.desk,
            appAssets: files.app,
            // The owner's key store is a temporary one too, never this computer's.
            compute: {
              store: {
                home: join(base, 'home'),
                platform: 'linux',
                secretTool: join(base, 'no-secret-tool'),
              },
            },
            background: {
              keys,
              start: () => Promise.reject(new Error('No owner starts one.')),
              input: () => Promise.resolve(input),
            },
          },
          owner.signal,
        );
      },
      input: () => Promise.reject(new Error('A terminal has no owner input.')),
    },
  };
  const running = runCli(
    ['--app', ...args, '--agency-dir', agency],
    root,
    io,
    controller.signal,
  );
  await until(() => Promise.resolve(out.length > 0));
  const shown = JSON.parse(out[0] ?? '{}') as { url: string };
  const url = new URL(shown.url);
  return {
    url,
    headers: {
      Authorization: `Bearer ${url.hash.slice(1)}`,
      'Content-Type': 'application/json',
    },
    agency,
    out,
    lines,
    opened,
    ownerOpened,
    handoffs,
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}

/** Start the project from the Ask page over HTTP. */
async function startProject(
  run: Asked,
  body: Record<string, unknown>,
): Promise<void> {
  const started = await fetch(
    `${run.url.origin}/api/v1/actions/project-start`,
    { method: 'POST', headers: run.headers, body: JSON.stringify(body) },
  );
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { ok: true, pending: true });
}

/** Wait until a desk at `origin` serves a lab to the run's token. */
async function labAt(run: Asked, origin: string): Promise<void> {
  await until(async () => {
    const response = await fetch(`${origin}/api/v1/snapshot`, {
      headers: run.headers,
    }).catch(() => null);
    if (!response?.ok) return false;
    const snapshot = (await response.json()) as { lab: unknown };
    return Boolean(snapshot.lab);
  });
}

await test('the Ask page starts the project: the desk hands it to a background owner on the same port and token, and its lab starts with the hours asked', async (t) => {
  const run = await askByApp(t, []);
  const { url, headers } = run;
  const start = (await (
    await fetch(`${url.origin}/api/v1/start`, { headers })
  ).json()) as StartView;
  assert.equal(start.files, false);
  assert.equal(start.started, false);
  // Without a project, the lab's own actions are not there, and the start is.
  const refused = await fetch(`${url.origin}/api/v1/actions/project-start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: '' }),
  });
  assert.equal(refused.status, 409);
  await startProject(run, {
    question: 'Can cheap fine-tunes keep a CoT faithful?',
    hours: 12,
  });
  await labAt(run, url.origin);
  // The owner serves the project on the same port, and the same token reads it.
  const seen = (await (
    await fetch(`${url.origin}/api/v1/snapshot`, { headers })
  ).json()) as {
    project: string;
    lab: { question: string; budget: { hours: number } | null };
  };
  assert.equal(seen.project, 'cot');
  assert.equal(seen.lab.question, 'Can cheap fine-tunes keep a CoT faithful?');
  assert.equal(seen.lab.budget?.hours, 12);
  assert.equal(run.handoffs.length, 1);
  const input = JSON.parse(run.handoffs[0] ?? '{}') as {
    research: { topic: string; autonomy: string };
    desk: { port: number };
    hours: number;
    agency: string;
  };
  assert.equal(
    input.research.topic,
    'Can cheap fine-tunes keep a CoT faithful?',
  );
  assert.equal(input.research.autonomy, 'autonomous');
  assert.equal(input.desk.port, Number(url.port));
  assert.equal(input.hours, 12);
  assert.equal(input.agency, run.agency);
  // The tab in the browser moves with the project: no second tab opens.
  assert.equal(run.opened.length, 1);
  await until(() =>
    Promise.resolve(
      run.lines.includes('The page in your browser now shows the project.'),
    ),
  );
  assert.deepEqual(run.ownerOpened, []);
  // The start desk is gone: the owner's desk takes no second start.
  const again = await fetch(`${url.origin}/api/v1/actions/project-start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: 'Again?' }),
  });
  assert.equal(again.status, 404);
  await run.stop();
});

await test('an isolated project starts with its own settings in its folder: they are a copy of the global ones, the start records them, and the global settings do not change', async (t) => {
  const run = await askByApp(t, []);
  const { url, headers } = run;
  const root = join(dirname(run.agency), 'cot');
  const read = async (path: string): Promise<Response> =>
    fetch(`${url.origin}${path}`, { headers });
  const act = async (
    name: string,
    body: Record<string, unknown>,
  ): Promise<number> =>
    (
      await fetch(`${url.origin}/api/v1/actions/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    ).status;
  // Only profile=project is a scope of a read.
  assert.equal((await read('/api/v1/setup?profile=other')).status, 404);
  assert.equal(
    ((await (await read('/api/v1/setup')).json()) as SetupView).ownCopied,
    null,
  );
  // A read copies nothing: the person picks Isolated project first.
  assert.equal((await read('/api/v1/setup?profile=project')).status, 409);
  assert.equal((await read('/api/v1/start?profile=project')).status, 409);
  assert.equal(existsSync(join(root, '.verifold', 'agency')), false);
  assert.equal(await act('setup-copy-global', { profile: 'project' }), 200);
  const own = (await (
    await read('/api/v1/setup?profile=project')
  ).json()) as SetupView;
  assert.equal(own.scope, 'project');
  assert.equal(own.steps.agents, null);
  // The copy is in the folder, and the global settings say when it was made.
  assert.ok(existsSync(join(root, '.verifold', 'agency', 'settings.json')));
  assert.match(
    ((await (await read('/api/v1/setup')).json()) as SetupView).ownCopied ?? '',
    /^\d{4}-/,
  );
  // The project's own agents: Codex alone. The global settings keep their team.
  assert.equal(
    await act('setup-agents', {
      profile: 'project',
      claude: { use: false },
      codex: { use: true },
    }),
    200,
  );
  const where = (await (
    await read('/api/v1/start?profile=project')
  ).json()) as StartView;
  assert.deepEqual(where.agents, { host: 'codex' });
  assert.equal(where.gpuUsd, 30);
  // An isolated project stays in its folder.
  assert.equal(
    await act('project-start', {
      question: 'Elsewhere?',
      profile: 'project',
      folder: join(dirname(root), 'elsewhere'),
    }),
    409,
  );
  await startProject(run, {
    question: 'Can cheap fine-tunes keep a CoT faithful?',
    profile: 'project',
  });
  await labAt(run, url.origin);
  const workspace = await loadWorkspace(root);
  assert.equal(workspace.ownProfile, true);
  assert.equal(workspace.host, 'codex');
  assert.equal(
    (await loadSettings(join(root, '.verifold', 'agency'))).agency?.host,
    'codex',
  );
  assert.equal((await loadSettings(run.agency)).agency?.host, 'claude');
  // The owner gets the global folder, for the month across projects. It serves both settings, and the snapshot says the project has its own.
  const input = JSON.parse(run.handoffs[0] ?? '{}') as { agency: string };
  assert.equal(input.agency, run.agency);
  await until(async () => {
    const response = await read('/api/v1/setup?profile=project');
    return (
      response.ok && ((await response.json()) as SetupView).scope === 'project'
    );
  });
  assert.equal(
    ((await (await read('/api/v1/setup')).json()) as SetupView).scope,
    'global',
  );
  const seen = (await (await read('/api/v1/snapshot')).json()) as {
    ownProfile?: boolean;
  };
  assert.equal(seen.ownProfile, true);
  await run.stop();
});

await test('a project on the global settings drops an isolated copy that the person left in its folder, once the project exists', async (t) => {
  const run = await askByApp(t, []);
  const root = join(dirname(run.agency), 'cot');
  assert.equal(
    (
      await fetch(`${run.url.origin}/api/v1/actions/setup-copy-global`, {
        method: 'POST',
        headers: run.headers,
        body: JSON.stringify({ profile: 'project' }),
      })
    ).status,
    200,
  );
  assert.ok(existsSync(join(root, '.verifold', 'agency')));
  await startProject(run, { question: 'Do probes see faithfulness?' });
  await labAt(run, run.url.origin);
  assert.equal((await loadWorkspace(root)).ownProfile, undefined);
  assert.equal(existsSync(join(root, '.verifold', 'agency')), false);
  await run.stop();
});

await test('--no-open holds after the Ask page: when the owner gets a new port, the terminal prints its URL and opens no page', async (t) => {
  const run = await askByApp(t, ['--no-open'], true);
  assert.deepEqual(run.opened, []);
  await startProject(run, { question: 'Do probes see faithfulness?' });
  // The start desk's port is taken when the owner opens its desk, so the owner's URL is new.
  await until(() => Promise.resolve(run.out.length >= 2));
  const printed = JSON.parse(run.out[1] ?? '{}') as {
    url: string;
    app?: string;
  };
  const moved = new URL(printed.url);
  assert.notEqual(moved.port, run.url.port);
  // The new URL is the app's, as the person asked for the app.
  assert.equal(printed.app, `${moved.origin}/app/${moved.hash}`);
  await labAt(run, moved.origin);
  await until(() =>
    Promise.resolve(
      run.lines.includes('Open the printed URL to use Verifold.'),
    ),
  );
  assert.deepEqual(run.opened, []);
  assert.deepEqual(run.ownerOpened, []);
  await run.stop();
});
