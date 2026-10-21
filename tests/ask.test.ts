import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeSettings } from '../src/core/agency.ts';
import { profileMoneyDefaults } from '../src/core/compute.ts';
import { loadWorkspace } from '../src/core/storage.ts';
import { askStart } from '../src/cli/ask-start.ts';
import { runCli, type CliIO } from '../src/cli/commands.ts';
import type { StartView } from '../src/protocol/api.ts';

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

  // The profile's harnesses come without their models, which the lab reads from the profile, and its limits are copied.
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
  assert.equal(workspace.model, undefined);
  assert.equal(workspace.helperModel, undefined);
  assert.equal(workspace.research?.topic, 'Do probes see faithfulness?');
  assert.equal(workspace.research?.phase, 'needs-plan');
  const limits = JSON.parse(
    await readFile(join(here, '.verifold', 'compute', 'settings.json'), 'utf8'),
  ) as { limitUsd: number | null; gpuTypes: string[] };
  assert.equal(limits.limitUsd, 30);
  assert.deepEqual(limits.gpuTypes, ['NVIDIA L40S']);
  // One start only.
  await assert.rejects(
    first.start.act({ question: 'Again?' }),
    /started already/,
  );

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

await test('the Ask page starts the project: the desk hands it to a background owner on the same port and token, and its lab starts with the hours asked', async (t) => {
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
  let ownerDone: Promise<void> | undefined;
  t.after(async () => {
    controller.abort();
    owner.abort();
    await ownerDone?.catch(() => {});
  });
  const out: string[] = [];
  const lines: string[] = [];
  const opened: string[] = [];
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
      start: (place, input) => {
        handoffs.push(input);
        ownerDone = runCli(
          ['owner', '--workspace', place],
          place,
          {
            interactive: false,
            ask: () => Promise.reject(new Error('The owner asks nothing.')),
            out: () => {},
            browse: () => Promise.resolve(true),
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
        return Promise.resolve();
      },
      input: () => Promise.reject(new Error('A terminal has no owner input.')),
    },
  };
  const running = runCli(
    ['--app', '--agency-dir', agency],
    root,
    io,
    controller.signal,
  );
  await until(() => Promise.resolve(out.length > 0));
  const shown = JSON.parse(out[0] ?? '{}') as { url: string };
  const url = new URL(shown.url);
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    'Content-Type': 'application/json',
  };
  const start = (await (
    await fetch(`${url.origin}/api/v1/start`, { headers })
  ).json()) as StartView;
  assert.equal(start.files, false);
  // Without a project, the lab's own actions are not there, and the start is.
  const refused = await fetch(`${url.origin}/api/v1/actions/project-start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: '' }),
  });
  assert.equal(refused.status, 409);
  const started = await fetch(`${url.origin}/api/v1/actions/project-start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: 'Can cheap fine-tunes keep a CoT faithful?',
      hours: 12,
    }),
  });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { ok: true, pending: true });
  // The owner serves the project on the same port, and the same token reads it.
  let snapshot: {
    project: string;
    lab: { question: string; budget: { hours: number } | null } | null;
  } | null = null;
  await until(async () => {
    const response = await fetch(`${url.origin}/api/v1/snapshot`, {
      headers,
    }).catch(() => null);
    if (!response?.ok) return false;
    snapshot = (await response.json()) as typeof snapshot;
    return Boolean(snapshot?.lab);
  });
  const seen = snapshot as unknown as {
    project: string;
    lab: { question: string; budget: { hours: number } | null };
  };
  assert.equal(seen.project, 'cot');
  assert.equal(seen.lab.question, 'Can cheap fine-tunes keep a CoT faithful?');
  assert.equal(seen.lab.budget?.hours, 12);
  assert.equal(handoffs.length, 1);
  const input = JSON.parse(handoffs[0] ?? '{}') as {
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
  assert.equal(input.agency, agency);
  // The tab in the browser moves with the project: no second tab opens.
  assert.equal(opened.length, 1);
  await until(() =>
    Promise.resolve(
      lines.includes('The app in your browser now shows the project.'),
    ),
  );
  // The start desk is gone: the owner's desk takes no second start.
  const again = await fetch(`${url.origin}/api/v1/actions/project-start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: 'Again?' }),
  });
  assert.equal(again.status, 404);
  controller.abort();
  await running;
});
