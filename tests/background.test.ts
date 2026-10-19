import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
} from '../src/cli/control.ts';
import { runCli, type CliIO } from '../src/cli/commands.ts';
import { claimOwner, liveOwner } from '../src/cli/owner.ts';
import { changeWorkspace } from '../src/cli/storage.ts';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  t.after(() => rm(base, { recursive: true, force: true }));
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
  await until(() => shown.length === 2);
  assert.deepEqual(received, [{ line: '/help' }, { stop: true }]);
  assert.deepEqual(shown, [
    { progress: 'Welcome.' },
    { url: 'http://127.0.0.1:1/#abc' },
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
  const log = await readFile(join(root, '.verifold', 'owner.log'), 'utf8');
  assert.match(log, /Commands in this terminal/);
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
  const again: string[] = [];
  const againUrls: string[] = [];
  const second = runCli(
    ['ui', '--no-open'],
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
  assert.equal(opened.length, 1);
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
    /verifold pods \[stop <lease\|all>\][^\n]*\n\nOlder commands:\nverifold recommend[\s\S]*verifold session --prompt/,
  );
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
  const records = (await (
    await fetch(`${url.origin}/api/view?view=records`, { headers })
  ).json()) as { html: string };
  assert.match(
    records.html,
    /data-action="stop" data-confirm="Click again to stop the agents and pods">Stop the team</,
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
