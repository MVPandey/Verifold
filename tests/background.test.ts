import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  connectControl,
  newControl,
  removeSocket,
  serveControl,
  type FromOwner,
  type ToOwner,
} from '../src/server/control.ts';
import { runCli, type CliIO } from '../src/cli/commands.ts';
import { claimOwner, liveOwner } from '../src/core/owner.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import type { LabScreen } from '../src/server/screen.ts';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// An owner in these tests starts harness processes from PATH, such as the
// agent that plans a lab. Fake claude and codex commands that stop at once
// come first for the whole file, so no test reaches a real harness and no
// test depends on the harnesses that this computer has.
const fakeBin = await mkdtemp(join(tmpdir(), 'verifold-fake-bin-'));
for (const name of ['claude', 'codex'])
  await writeFile(join(fakeBin, name), '#!/bin/sh\nexit 1\n', {
    mode: 0o700,
  });
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;
// An owner reads the person's profile in the home folder for each prompt. These tests use an empty home of their own.
const fakeHome = await mkdtemp(join(tmpdir(), 'verifold-fake-home-'));
process.env.HOME = fakeHome;
process.on('exit', () => {
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (await check()) return;
    await wait(20);
  }
  assert.fail('The condition did not come true in 10 s.');
}

/** A project with a workspace, desk page fixtures, and a keys folder, all in one temporary folder. */
async function project(t: test.TestContext): Promise<{
  root: string;
  keys: string;
  assets: URL;
}> {
  const base = await mkdtemp(join(tmpdir(), 'verifold-background-'));
  // An owner's lab can still save a session record after the owner stopped, so removal retries (#247).
  t.after(() =>
    rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  const root = join(base, 'project');
  await mkdir(root);
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
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
  }));
  const assets = join(base, 'assets');
  await mkdir(join(assets, 'cli', 'vendor'), { recursive: true });
  await mkdir(join(assets, 'ui'));
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
    await writeFile(join(assets, 'cli', name), 'fixture asset');
  for (const name of [
    'purify.js',
    'idiomorph.js',
    'xterm.js',
    'xterm.css',
    'addon-fit.js',
  ])
    await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
  await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
  await writeFile(join(assets, 'ui', 'token.js'), 'fixture module');
  return {
    root,
    keys: join(base, 'home', '.verifold', 'credentials', 'owners'),
    assets: pathToFileURL(`${assets}/cli/`),
  };
}

await test('the control channel refuses a wrong or late key, and carries messages both ways', async (t) => {
  const control = await newControl();
  t.after(() => removeSocket(control));
  const received: ToOwner[] = [];
  const server = await serveControl(
    control,
    {
      attached: (send) => send({ progress: 'Welcome.' }),
      message: (message) => received.push(message),
    },
    200,
  );
  t.after(() => server.close());
  // A wrong key closes the connection before any message.
  const wrong: FromOwner[] = [];
  const intruder = await connectControl(
    { ...control, token: 'f'.repeat(64) },
    (message) => wrong.push(message),
  );
  intruder.send({ stop: true });
  await intruder.closed;
  assert.deepEqual(wrong, []);
  // A connection that does not give the key in time is closed.
  const { createConnection } = await import('node:net');
  const silent = createConnection(control.socket);
  await once(silent, 'close');
  // The right key gets the messages, and its lines reach the owner.
  const shown: FromOwner[] = [];
  const terminal = await connectControl(control, (message) =>
    shown.push(message),
  );
  terminal.send({ line: '/help' });
  terminal.send({ stop: true });
  await until(() => received.length === 2);
  server.send({ url: 'http://127.0.0.1:1/#abc' });
  // An owner with the app's build passes its URL on, and the old desk's URL, for a terminal that attached with --desk.
  server.send({
    url: 'http://127.0.0.1:1/#abc',
    app: 'http://127.0.0.1:1/app/#abc',
    desk: 'http://127.0.0.1:1/desk#abc',
  });
  await until(() => shown.length === 3);
  assert.deepEqual(received, [{ line: '/help' }, { stop: true }]);
  assert.deepEqual(shown, [
    { progress: 'Welcome.' },
    { url: 'http://127.0.0.1:1/#abc' },
    {
      url: 'http://127.0.0.1:1/#abc',
      app: 'http://127.0.0.1:1/app/#abc',
      desk: 'http://127.0.0.1:1/desk#abc',
    },
  ]);
  terminal.close();
  await terminal.closed;
});

await test('a terminal starts the team in the background, detaches, attaches again, and verifold stop stops it', async (t) => {
  const { root, keys, assets } = await project(t);
  const owner = new AbortController();
  t.after(() => owner.abort());
  const opened: string[] = [];
  let ownerDone: Promise<void> | undefined;
  let input = '';
  const background = {
    keys,
    start: (folder: string, line: string): Promise<void> => {
      input = line;
      // The test runs the owner in this process. The executable spawns it detached.
      ownerDone = runCli(
        ['owner', '--workspace', folder],
        folder,
        {
          interactive: false,
          ask: () => Promise.reject(new Error('No prompts')),
          out: () => assert.fail('The owner prints nothing.'),
          browse: (url) => {
            opened.push(url);
            return Promise.resolve(true);
          },
          deskAssets: assets,
          background: {
            keys,
            start: () =>
              Promise.reject(new Error('The owner starts no owner.')),
            input: () => Promise.resolve(line),
          },
        },
        owner.signal,
      );
      return Promise.resolve();
    },
    input: () => Promise.reject(new Error('A terminal has no owner input.')),
  };
  const terminal = (
    lines: string[],
    urls: string[],
    typed: ((line: string) => void)[],
  ): CliIO => ({
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: (value) => urls.push(value),
    progress: (line) => lines.push(line),
    listen: (onLine) => typed.push(onLine),
    background,
  });
  const lines: string[] = [];
  const urls: string[] = [];
  const typed: ((line: string) => void)[] = [];
  const first = new AbortController();
  const attached = runCli(
    ['ui'],
    root,
    terminal(lines, urls, typed),
    first.signal,
  );
  await until(() => urls.length === 1 && opened.length === 1);
  const url = new URL((JSON.parse(urls[0] ?? '{}') as { url: string }).url);
  const token = url.hash.slice(1);
  // The terminal asked for the app. This test package has no app build, so the owner opened the old desk and said so.
  assert.match(opened[0] ?? '', /\/desk#launch-[0-9a-f]+$/);
  await until(() =>
    lines.includes(
      'This Verifold has no app build, so the old desk opened in your browser.',
    ),
  );
  // The terminal asked the owner to open the desk, and the owner used a one-time code.
  assert.match(opened[0] ?? '', /#launch-[0-9a-f]+$/);
  assert.ok(
    lines.some((line) =>
      line.startsWith('Verifold now works in the background'),
    ),
  );
  // A typed line reaches the owner, and its answer comes back.
  await until(() => typed.length === 1);
  typed[0]?.('/help');
  await until(() =>
    lines.some((line) => line.includes('Ctrl+C leaves this terminal')),
  );
  // The key is in no project file, no log, and no command line.
  const key = (JSON.parse(input) as { token: string }).token;
  const running = await liveOwner(root);
  assert.ok(running);
  const saved = join(keys, `${running.ownerId}.json`);
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  assert.equal((await stat(keys)).mode & 0o777, 0o700);
  assert.ok((await readFile(saved, 'utf8')).includes(key));
  // The terminal gets the line from the owner, and the owner's log gets it on its own, a moment apart.
  await until(async () =>
    (
      await readFile(join(root, '.verifold', 'owner.log'), 'utf8').catch(
        () => '',
      )
    ).includes('Commands in this terminal'),
  );
  for (const name of ['owner.json', 'owner.log'])
    for (const secret of [key, token])
      assert.ok(
        !(await readFile(join(root, '.verifold', name), 'utf8')).includes(
          secret,
        ),
        `${name} holds a key`,
      );
  // Ctrl+C detaches. The team keeps working.
  first.abort();
  await attached;
  assert.match(lines.at(-1) ?? '', /^Detached\. The team keeps working\./);
  assert.ok(await liveOwner(root));
  // A second terminal attaches to the same owner, without a second owner.
  // --lab in a project that has an owner starts nothing, and says where to start a lab.
  const again: string[] = [];
  const againUrls: string[] = [];
  const second = runCli(
    ['ui', '--no-open', '--lab'],
    root,
    terminal(again, againUrls, []),
  );
  await until(() => againUrls.length === 1);
  assert.equal(againUrls[0], urls[0]);
  assert.ok(
    again.some((line) =>
      line.startsWith('Verifold already works in the background'),
    ),
  );
  assert.ok(
    again.includes(
      "--lab is no longer needed for a new project, which starts a lab after setup. Here it starts a lab on the project's question.",
    ),
  );
  assert.ok(
    again.includes(
      'Verifold already works in the background, so --lab started nothing. Type /app, then start the lab there.',
    ),
  );
  assert.equal(existsSync(join(root, '.verifold', 'lab.json')), false);
  assert.equal(opened.length, 1);
  // A terminal that asks for another profile hears that the running owner keeps its own.
  const other: string[] = [];
  const third = runCli(
    ['--app', '--no-open', '--agency-dir', join(root, 'other-profile')],
    root,
    terminal(other, [], []),
  );
  await until(() =>
    other.some((line) =>
      line.startsWith(
        `The running Verifold uses the profile in ${join(fakeHome, '.verifold', 'agency')}, so stop it with verifold stop`,
      ),
    ),
  );
  assert.ok(
    !again.some((line) => line.startsWith('The running Verifold uses')),
  );
  // --desk prints the old desk's URL, without the app's.
  const deskLines: string[] = [];
  const deskUrls: string[] = [];
  const fourth = runCli(
    ['ui', '--desk', '--no-open'],
    root,
    terminal(deskLines, deskUrls, []),
  );
  await until(() => deskUrls.length === 1);
  const printed = JSON.parse(deskUrls[0] ?? '{}') as {
    url: string;
    app?: string;
  };
  assert.equal(new URL(printed.url).pathname, '/desk');
  assert.equal(new URL(printed.url).hash, url.hash);
  assert.equal(printed.app, undefined);
  await until(() =>
    deskLines.includes('Open the printed URL to use the old desk.'),
  );
  // verifold stop stops the owner. The attached terminal says so and ends.
  const said: string[] = [];
  await runCli(['stop'], root, {
    interactive: false,
    ask: () => Promise.reject(new Error('No prompts')),
    out: (value) => said.push(value),
    background,
  });
  assert.deepEqual(said, ['Verifold stopped.']);
  await second;
  await third;
  await fourth;
  assert.equal(again.at(-1), 'Verifold stopped.');
  await ownerDone;
  assert.equal(await liveOwner(root), null);
  assert.equal(existsSync(saved), false);
  assert.equal(
    existsSync(dirname((JSON.parse(input) as { socket: string }).socket)),
    false,
  );
  assert.equal(existsSync(join(root, '.verifold', 'owner.json')), false);
});

await test("a request's change shows in the terminal that started with --desk, and the owner's log keeps only its ID and reason", async (t) => {
  const { root, keys, assets } = await project(t);
  // A Claude Code for this test alone: it asks to write a file, with the content of the change.
  const bin = await mkdtemp(join(tmpdir(), 'verifold-request-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(
    join(bin, 'claude'),
    `#!${process.execPath}
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const input = { file_path: 'notes.md', content: 'first change line\\nsecond change line' };
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize')
    return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type === 'user') {
    out({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'fake-model', permissionMode: 'default' });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Write', input }] } });
    return out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'tool-1', input, description: 'It saves the notes.' } });
  }
  if (message.type === 'control_response') {
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true }] } });
    out({ type: 'result', subtype: 'success' });
  }
});
`,
    { mode: 0o700 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const owner = new AbortController();
  t.after(() => owner.abort());
  const opened: string[] = [];
  let ownerDone: Promise<void> | undefined;
  const background = {
    keys,
    start: (folder: string, line: string): Promise<void> => {
      ownerDone = runCli(
        ['owner', '--workspace', folder],
        folder,
        {
          interactive: false,
          ask: () => Promise.reject(new Error('No prompts')),
          out: () => assert.fail('The owner prints nothing.'),
          browse: (url) => {
            opened.push(url);
            return Promise.resolve(true);
          },
          deskAssets: assets,
          background: {
            keys,
            start: () =>
              Promise.reject(new Error('The owner starts no owner.')),
            input: () => Promise.resolve(line),
          },
        },
        owner.signal,
      );
      return Promise.resolve();
    },
    input: () => Promise.reject(new Error('A terminal has no owner input.')),
  };
  const lines: string[] = [];
  const fed: string[] = [];
  const urls: string[] = [];
  const typed: ((line: string) => void)[] = [];
  const attached = runCli(['ui', '--desk', '--no-open'], root, {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: (value) => urls.push(value),
    progress: (line) => lines.push(line),
    feed: (line) => fed.push(line),
    listen: (onLine) => typed.push(onLine),
    background,
  });
  await until(() => urls.length === 1 && typed.length === 1);
  // The owner sends the old desk's URL, and the terminal prints it.
  const printed = JSON.parse(urls[0] ?? '{}') as { url: string; app?: string };
  assert.equal(new URL(printed.url).pathname, '/desk');
  assert.equal(printed.app, undefined);
  typed[0]?.('/start Save the notes');
  await until(() => fed.some((line) => line.includes('│ second change line')));
  const request = fed.find((line) => line.includes('needs you'));
  assert.match(
    request ?? '',
    /needs you: R1: Claude Code asks to use Write: notes\.md Read the change before you answer\.\n {2}Why: It saves the notes\.\n {2}│ first change line\n {2}│ second change line\nType a to allow once or d to deny\.$/,
  );
  // The log gets one line for the request: its ID and why it asks. The change and the file stay in the terminal.
  const log = join(root, '.verifold', 'owner.log');
  const requestLog = async (): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line.includes('needs you'));
  await until(async () => (await requestLog()).length > 0);
  const [logged, ...more] = await requestLog();
  assert.match(
    logged ?? '',
    /Z {2}\d\d:\d\d {2}Claude Code · needs you: R1\. Why: It saves the notes\.$/,
  );
  assert.deepEqual(more, []);
  typed[0]?.('d');
  await until(() => fed.some((line) => line.includes('decision: You denied')));
  // In this terminal, /open opens the old desk, as Enter on an empty line does.
  typed[0]?.('/open');
  await until(() => lines.includes('The old desk opened in your browser.'));
  assert.match(opened.at(-1) ?? '', /\/desk#launch-[0-9a-f]+$/);
  await runCli(['stop'], root, {
    interactive: false,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
    background,
  });
  await attached;
  await ownerDone;
  assert.ok(!(await readFile(log, 'utf8')).includes('change line'));
});

await test('verifold stop says when nothing runs, and points to an older owner in a terminal', async (t) => {
  const { root, keys } = await project(t);
  const io = (out: string[]): CliIO => ({
    interactive: false,
    ask: () => Promise.reject(new Error('No prompts')),
    out: (value) => out.push(value),
    background: {
      keys,
      start: () => Promise.reject(new Error('stop starts nothing')),
      input: () => Promise.reject(new Error('No input')),
    },
  });
  const out: string[] = [];
  // Its help is its own, not the whole command list.
  await runCli(['stop', '--help'], root, io(out));
  assert.match(
    out.pop() ?? '',
    /^verifold stop \[--workspace path\]\n\nStops the team/,
  );
  // The full help lists the main commands first and the older ones under their own heading.
  await runCli(['--help'], root, io(out));
  const help = out.pop() ?? '';
  assert.match(
    help,
    /verifold pods \[stop <lease\|all>\][^\n]*\n\nOlder commands, for the old desk and the research flow:\nverifold ui [\s\S]*verifold session --prompt/,
  );
  // A bare verifold opens the app. --desk opens the old desk, for this release.
  assert.match(
    help,
    /^verifold \[--no-open\] \[--desk\] +Open Verifold in your browser/m,
  );
  assert.match(help, /--desk opens the old desk instead, for this release\./);
  assert.doesNotMatch(help, /--app\b/);
  assert.doesNotMatch(help, /runs no experiments|older flow/);
  assert.match(help, /task agents run the experiments/);
  await runCli(['stop'], root, io(out));
  assert.deepEqual(out, ['Verifold does not run in this project.']);
  const owner = await claimOwner(root, 'test');
  t.after(() => owner.release());
  await assert.rejects(
    runCli(['stop'], root, io(out)),
    /runs in this project in a terminal \(process \d+\)\. Press Ctrl\+C in that terminal/,
  );
  // An attach also names that terminal, and starts no second owner.
  await assert.rejects(
    runCli(['ui', '--no-open'], root, { ...io(out), interactive: true }),
    /in another terminal \(process \d+\)/,
  );
});

await test('without a terminal, the desk runs in this process, and Stop in the desk ends it', async (t) => {
  const { root, keys, assets } = await project(t);
  const started: string[] = [];
  const urls: string[] = [];
  const done = runCli(['ui', '--no-open'], root, {
    interactive: false,
    ask: () => Promise.reject(new Error('No prompts')),
    out: (value) => urls.push(value),
    deskAssets: assets,
    background: {
      keys,
      start: (folder) => {
        started.push(folder);
        return Promise.resolve();
      },
      input: () => Promise.reject(new Error('No input')),
    },
  });
  await until(() => urls.length === 1);
  const url = new URL((JSON.parse(urls[0] ?? '{}') as { url: string }).url);
  assert.ok(existsSync(join(root, '.verifold', 'owner.json')));
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  // The owner's desk offers Stop the team in the top bar, not in Records.
  const records = (await (
    await fetch(`${url.origin}/api/view?view=records`, { headers })
  ).json()) as { html: string; stoppable: boolean };
  assert.equal(records.stoppable, true);
  assert.doesNotMatch(records.html, /data-action="stop"/);
  const shell = await (await fetch(url.origin)).text();
  assert.match(
    shell,
    /<button id="stop-team" class="stop-button" type="button" data-action="stop" data-confirm="Click again to stop the agents and pods" hidden>Stop the team<\/button>/,
  );
  const response = await fetch(`${url.origin}/api/action`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${url.hash.slice(1)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'stop' }),
  });
  assert.equal(response.status, 200);
  await done;
  assert.deepEqual(started, []);
  assert.equal(existsSync(join(root, '.verifold', 'owner.json')), false);
});

await test('verifold owner runs only with the control that Verifold gives it', async (t) => {
  const { root, keys } = await project(t);
  await assert.rejects(
    runCli(['owner'], root, {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      background: {
        keys,
        start: () => Promise.reject(new Error('No owner')),
        input: () => Promise.resolve('{"socket":"/tmp/x.sock"}'),
      },
    }),
    /runs only when Verifold starts it/,
  );
  assert.equal(existsSync(join(root, '.verifold', 'owner.json')), false);
});

await test('an owner that setup started starts a lab on the question of setup, and no research', async (t) => {
  const { root, keys, assets } = await project(t);
  const control = await newControl();
  t.after(() => removeSocket(control));
  const owner = new AbortController();
  const done = runCli(
    ['owner'],
    root,
    {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      browse: () => Promise.resolve(true),
      deskAssets: assets,
      background: {
        keys,
        start: () => Promise.reject(new Error('The owner starts no owner.')),
        input: () =>
          Promise.resolve(
            JSON.stringify({
              ...control,
              research: { topic: 'Do months lie on a circle?' },
            }),
          ),
      },
    },
    owner.signal,
  );
  // A check that fails still stops the owner. Hooks run after the test's own end, which stops it first.
  t.after(async () => {
    owner.abort();
    await done.catch(() => {});
  });
  // The question comes from setup: the project has no research record yet.
  await until(() => existsSync(join(root, '.verifold', 'lab.json')));
  const lab = JSON.parse(
    await readFile(join(root, '.verifold', 'lab.json'), 'utf8'),
  ) as { question: string };
  assert.equal(lab.question, 'Do months lie on a circle?');
  // The question stays with the project too, so Home offers it again after
  // Start over. It is saved once the lab runs, so it can come a moment later.
  const read = async (): Promise<{
    research?: { topic: string; autonomy: string };
  }> =>
    JSON.parse(
      await readFile(join(root, '.verifold', 'workspace.json'), 'utf8'),
    ) as { research?: { topic: string; autonomy: string } };
  await until(async () => (await read()).research !== undefined);
  const workspace = await read();
  assert.equal(workspace.research?.topic, 'Do months lie on a circle?');
  // Research is autonomous unless the person chose otherwise, as everywhere in the project.
  assert.equal(workspace.research?.autonomy, 'autonomous');
  // The lab's first agent, on the project's harness, plans it. No research step starts, and the lab has a time budget.
  const started = JSON.parse(
    await readFile(join(root, '.verifold', 'lab.json'), 'utf8'),
  ) as {
    opener: string | null;
    budget: { hours: number } | null;
    directions: { title: string; agent: string }[];
  };
  assert.equal(started.directions[0]?.title, 'Plan the lab');
  assert.equal(started.opener, started.directions[0]?.agent);
  assert.equal(started.budget?.hours, 8);
  assert.equal(existsSync(join(root, '.verifold', 'runs')), false);
  owner.abort();
  await done.catch(() => {});
});

await test('an owner started with --lab in a project without a lab starts one on its saved question', async (t) => {
  const { root, keys, assets } = await project(t);
  await changeWorkspace(root, (current) => ({
    ...current!,
    research: {
      topic: 'Do weekdays lie on a circle?',
      autonomy: 'autonomous',
      phase: 'needs-plan',
    },
  }));
  const control = await newControl();
  t.after(() => removeSocket(control));
  const owner = new AbortController();
  const done = runCli(
    ['owner'],
    root,
    {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      browse: () => Promise.resolve(true),
      deskAssets: assets,
      background: {
        keys,
        start: () => Promise.reject(new Error('The owner starts no owner.')),
        input: () => Promise.resolve(JSON.stringify({ ...control, lab: true })),
      },
    },
    owner.signal,
  );
  t.after(async () => {
    owner.abort();
    await done.catch(() => {});
  });
  await until(() => existsSync(join(root, '.verifold', 'lab.json')));
  const lab = JSON.parse(
    await readFile(join(root, '.verifold', 'lab.json'), 'utf8'),
  ) as { question: string };
  assert.equal(lab.question, 'Do weekdays lie on a circle?');
  owner.abort();
  await done.catch(() => {});
});

await test('a lab that cannot start leaves the owner running and says why', async (t) => {
  const { root, keys, assets } = await project(t);
  const control = await newControl();
  t.after(() => removeSocket(control));
  const owner = new AbortController();
  const done = runCli(
    ['owner'],
    root,
    {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      browse: () => Promise.resolve(true),
      deskAssets: assets,
      background: {
        keys,
        start: () => Promise.reject(new Error('The owner starts no owner.')),
        input: () =>
          Promise.resolve(
            JSON.stringify({
              ...control,
              research: { topic: 'x'.repeat(5000) },
            }),
          ),
      },
    },
    owner.signal,
  );
  // A check that fails still stops the owner. Hooks run after the test's own end, which stops it first.
  t.after(async () => {
    owner.abort();
    await done.catch(() => {});
  });
  const log = join(root, '.verifold', 'owner.log');
  await until(
    async () =>
      existsSync(log) &&
      (await readFile(log, 'utf8')).includes('Verifold started no lab'),
  );
  assert.ok(await liveOwner(root));
  assert.equal(existsSync(join(root, '.verifold', 'lab.json')), false);
  owner.abort();
  await done.catch(() => {});
});

await test('an owner with a question of setup in a project that has a lab starts nothing new and says so', async (t) => {
  const { root, keys, assets } = await project(t);
  await mkdir(join(root, '.verifold', 'lab', 'agents'), { recursive: true });
  await writeFile(
    join(root, '.verifold', 'lab.json'),
    JSON.stringify({
      schemaVersion: 1,
      question: 'The first question.',
      startedAt: '2026-10-19T12:00:00.000Z',
      pausedAt: null,
      handles: { claude: 0, codex: 0 },
      directions: [],
    }),
  );
  const control = await newControl();
  t.after(() => removeSocket(control));
  const owner = new AbortController();
  const done = runCli(
    ['owner'],
    root,
    {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      browse: () => Promise.resolve(true),
      deskAssets: assets,
      background: {
        keys,
        start: () => Promise.reject(new Error('The owner starts no owner.')),
        input: () =>
          Promise.resolve(
            JSON.stringify({
              ...control,
              research: { topic: 'Another question.' },
            }),
          ),
      },
    },
    owner.signal,
  );
  // A check that fails still stops the owner. Hooks run after the test's own end, which stops it first.
  t.after(async () => {
    owner.abort();
    await done.catch(() => {});
  });
  const log = join(root, '.verifold', 'owner.log');
  await until(
    async () =>
      existsSync(log) &&
      (await readFile(log, 'utf8')).includes('This project has a lab already'),
  );
  const lab = JSON.parse(
    await readFile(join(root, '.verifold', 'lab.json'), 'utf8'),
  ) as { question: string };
  assert.equal(lab.question, 'The first question.');
  owner.abort();
  await done.catch(() => {});
});

await test('an attached terminal gets the lab for its live view, and its text goes to the board', async (t) => {
  const { root, keys, assets } = await project(t);
  await mkdir(join(root, '.verifold', 'lab', 'agents'), { recursive: true });
  await writeFile(
    join(root, '.verifold', 'lab.json'),
    JSON.stringify({
      schemaVersion: 1,
      question: 'Do months lie on a circle?',
      startedAt: new Date().toISOString(),
      pausedAt: null,
      handles: { claude: 0, codex: 0 },
      directions: [],
    }),
  );
  const owner = new AbortController();
  let ownerDone: Promise<void> | undefined;
  t.after(async () => {
    owner.abort();
    await ownerDone?.catch(() => {});
  });
  const background = {
    keys,
    start: (folder: string, line: string): Promise<void> => {
      ownerDone = runCli(
        ['owner', '--workspace', folder],
        folder,
        {
          interactive: false,
          ask: () => Promise.reject(new Error('No prompts')),
          out: () => assert.fail('The owner prints nothing.'),
          browse: () => Promise.resolve(true),
          deskAssets: assets,
          background: {
            keys,
            start: () =>
              Promise.reject(new Error('The owner starts no owner.')),
            input: () => Promise.resolve(line),
          },
        },
        owner.signal,
      );
      return Promise.resolve();
    },
    input: () => Promise.reject(new Error('A terminal has no owner input.')),
  };
  const lines: string[] = [];
  const screens: (LabScreen | null)[] = [];
  const typed: ((line: string) => void)[] = [];
  const terminal = new AbortController();
  const attached = runCli(
    ['ui', '--no-open'],
    root,
    {
      interactive: true,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      progress: (line) => lines.push(line),
      listen: (onLine) => typed.push(onLine),
      screens: { show: (screen) => screens.push(screen) },
      background,
    },
    terminal.signal,
  );
  // The owner builds screens only while a terminal is attached, and sends them to it.
  await until(() => screens.some((screen) => screen !== null));
  const screen = screens.find((entry) => entry !== null);
  assert.equal(screen?.project, 'project');
  assert.match(screen?.origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(screen?.directions, []);
  assert.equal(screen?.call, null);
  // Text that is not a command goes to the lab's board as the person's post.
  await until(() => typed.length === 1);
  typed[0]?.('Try weekdays too @all');
  await until(() => lines.includes('Your message is on the board.'));
  const board = join(root, '.verifold', 'board');
  const posts = await Promise.all(
    (await readdir(board)).map((name) => readFile(join(board, name), 'utf8')),
  );
  assert.ok(posts.some((post) => post.includes('Try weekdays too @all')));
  terminal.abort();
  await attached;
});

await test('a terminal without a background owner gets the same live view of its lab', async (t) => {
  const { root, assets } = await project(t);
  await mkdir(join(root, '.verifold', 'lab', 'agents'), { recursive: true });
  await writeFile(
    join(root, '.verifold', 'lab.json'),
    JSON.stringify({
      schemaVersion: 1,
      question: 'Do weekdays lie on a circle?',
      startedAt: new Date().toISOString(),
      pausedAt: null,
      handles: { claude: 0, codex: 0 },
      directions: [],
    }),
  );
  const lines: string[] = [];
  const screens: (LabScreen | null)[] = [];
  const typed: ((line: string) => void)[] = [];
  const browsed: string[] = [];
  let unfollow: (() => void) | undefined;
  const stop = new AbortController();
  const done = runCli(
    ['ui', '--no-open'],
    root,
    {
      interactive: true,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      progress: (line) => lines.push(line),
      browse: (url) => {
        browsed.push(url);
        return Promise.resolve(true);
      },
      listen: (onLine) => typed.push(onLine),
      // The terminal of an in-process desk owns its watch of the lab.
      screens: {
        serve: (follow) => {
          unfollow = follow((screen) => screens.push(screen));
        },
      },
      deskAssets: assets,
    },
    stop.signal,
  );
  t.after(async () => {
    stop.abort();
    await done.catch(() => {});
  });
  await until(() => screens.some((screen) => screen !== null));
  assert.equal(screens.find((entry) => entry !== null)?.project, 'project');
  await until(() => typed.length === 1);
  typed[0]?.('/app c-1');
  // This package build in the tests has no app, so the old desk opens, and the terminal says so.
  await until(() =>
    lines.includes(
      'This Verifold has no app build, so the old desk opened in your browser.',
    ),
  );
  assert.match(browsed[0] ?? '', /\/desk#launch-[0-9a-f]+$/);
  typed[0]?.('/desk');
  await until(() => lines.includes('The old desk opened in your browser.'));
  assert.match(browsed[1] ?? '', /\/desk#launch-[0-9a-f]+$/);
  typed[0]?.('A note for the lab');
  await until(() => lines.includes('Your message is on the board.'));
  unfollow?.();
  stop.abort();
  await done;
});

await test('a terminal that attaches gets a fresh screen, not the one from before it was away', async (t) => {
  const { root, keys, assets } = await project(t);
  await mkdir(join(root, '.verifold', 'lab', 'agents'), { recursive: true });
  await writeFile(
    join(root, '.verifold', 'lab.json'),
    JSON.stringify({
      schemaVersion: 1,
      question: 'Do months lie on a circle?',
      startedAt: new Date().toISOString(),
      pausedAt: null,
      handles: { claude: 0, codex: 0 },
      directions: [],
    }),
  );
  const owner = new AbortController();
  let ownerDone: Promise<void> | undefined;
  t.after(async () => {
    owner.abort();
    await ownerDone?.catch(() => {});
  });
  const background = {
    keys,
    start: (folder: string, line: string): Promise<void> => {
      ownerDone = runCli(
        ['owner', '--workspace', folder],
        folder,
        {
          interactive: false,
          ask: () => Promise.reject(new Error('No prompts')),
          out: () => assert.fail('The owner prints nothing.'),
          browse: () => Promise.resolve(true),
          deskAssets: assets,
          background: {
            keys,
            start: () =>
              Promise.reject(new Error('The owner starts no owner.')),
            input: () => Promise.resolve(line),
          },
        },
        owner.signal,
      );
      return Promise.resolve();
    },
    input: () => Promise.reject(new Error('A terminal has no owner input.')),
  };
  const attach = (
    screens: (LabScreen | null)[],
    urls: string[],
    signal: AbortSignal,
  ): Promise<void> =>
    runCli(
      ['ui', '--no-open'],
      root,
      {
        interactive: true,
        ask: () => Promise.reject(new Error('No prompts')),
        out: (value) => urls.push(value),
        progress: () => {},
        listen: () => {},
        screens: { show: (screen) => screens.push(screen) },
        background,
      },
      signal,
    );
  const first: (LabScreen | null)[] = [];
  const urls: string[] = [];
  const away = new AbortController();
  const attached = attach(first, urls, away.signal);
  await until(() => first.some((screen) => screen !== null) && urls.length > 0);
  assert.equal(first.find((screen) => screen !== null)?.paused, null);
  away.abort();
  await attached;
  // While no terminal looks, the person pauses the lab in the app.
  const url = new URL((JSON.parse(urls[0] ?? '{}') as { url: string }).url);
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    'Content-Type': 'application/json',
  };
  const paused = await fetch(`${url.origin}/api/v1/actions/lab-pause`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.ok(paused.status === 200 || paused.status === 202);
  await until(async () => {
    const snapshot = (await (
      await fetch(`${url.origin}/api/v1/snapshot`, { headers })
    ).json()) as { lab: { paused: unknown } | null };
    return snapshot.lab?.paused !== null;
  });
  // The next terminal's first screen is the lab as it is now.
  const second: (LabScreen | null)[] = [];
  const back = new AbortController();
  const again = attach(second, [], back.signal);
  await until(() => second.length > 0);
  assert.equal(second[0]?.paused, 'person');
  back.abort();
  await again;
});

await test('a workspace that does not read stops the launch before any owner starts, since Verifold cannot tell which settings the project uses', async (t) => {
  const { root, keys, assets } = await project(t);
  await writeFile(join(root, '.verifold', 'workspace.json'), '{ broken');
  const started: string[] = [];
  const io: CliIO = {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
    progress: () => {},
    browse: () => Promise.resolve(true),
    deskAssets: assets,
    background: {
      keys,
      start: (folder) => {
        started.push(folder);
        return Promise.reject(new Error('No owner starts.'));
      },
      input: () => Promise.reject(new Error('No input')),
    },
  };
  await assert.rejects(
    runCli([], root, io),
    /cannot tell which settings this project uses/,
  );
  assert.deepEqual(started, []);
  assert.equal(await liveOwner(root), null);
});
