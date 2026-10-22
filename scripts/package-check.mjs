import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
const directory = await mkdtemp(join(tmpdir(), 'verifold-package-'));
// Every process in this check finds the fake harnesses first, never a real one.
const environment = {
  ...process.env,
  PATH: `${join(directory, 'bin')}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
  npm_config_cache: join(directory, 'cache'),
};
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
};
try {
  const packed = run(
    'npm',
    ['pack', '--json', '--pack-destination', directory, '--ignore-scripts'],
    process.cwd(),
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout);
  assert.ok(manifest.files.some((file) => file.path === 'dist-cli/cli.js'));
  assert.ok(
    manifest.files.every(
      (file) =>
        // A layer module, at the top of its layer. core/lab/ holds parts of lab.js.
        /^dist-cli\/(?:[a-z]+|core\/lab)\/[a-z-]+\.js$/.test(file.path) ||
        /^dist-cli\/[a-z]+\/prompts\/[a-z-]+\.md$/.test(file.path) ||
        // The new app: its page, and the files that Vite names with a hash.
        /^dist-cli\/app\/assets\/[\w.-]+\.(js|css|ttf|webp)$/.test(file.path) ||
        [
          'dist-cli/cli.js',
          'dist-cli/app/index.html',
          'dist-cli/app/react.LICENSE.txt',
          'dist-cli/app/OFL-Manrope.txt',
          'dist-cli/ui/dom.js',
          'dist-cli/desk/desk.css',
          'dist-cli/desk/manrope.ttf',
          'dist-cli/desk/OFL-Manrope.txt',
          'dist-cli/desk/symbol.webp',
          'dist-cli/desk/vendor/purify.js',
          'dist-cli/desk/vendor/purify.LICENSE.txt',
          'dist-cli/desk/vendor/idiomorph.js',
          'dist-cli/desk/vendor/idiomorph.LICENSE.txt',
          'dist-cli/desk/vendor/xterm.js',
          'dist-cli/desk/vendor/xterm.css',
          'dist-cli/desk/vendor/xterm.LICENSE.txt',
          'dist-cli/desk/vendor/addon-fit.js',
          'dist-cli/desk/vendor/addon-fit.LICENSE.txt',
          'package.json',
          'README.md',
          'LICENSE',
          'LICENSING.md',
          'SECURITY.md',
        ].includes(file.path),
    ),
  );
  // Runtime dependencies come from the locked node_modules, so the install stays offline.
  // The terminal library is optional. Its prebuilt package for this platform comes along.
  const source = JSON.parse(await readFile('package.json', 'utf8'));
  const dependencies = [];
  for (const name of [
    ...Object.keys(source.dependencies ?? {}),
    ...Object.keys(source.optionalDependencies ?? {}),
    `@lydell/node-pty-${process.platform}-${process.arch}`,
  ]) {
    const dependency = run(
      'npm',
      [
        'pack',
        '--json',
        '--pack-destination',
        directory,
        '--ignore-scripts',
        join(process.cwd(), 'node_modules', name),
      ],
      process.cwd(),
    );
    assert.equal(dependency.status, 0, dependency.stderr);
    dependencies.push(
      join(directory, JSON.parse(dependency.stdout)[0].filename),
    );
  }
  await writeFile(
    join(directory, 'package.json'),
    '{"name":"consumer","private":true}',
  );
  const installed = run(
    'npm',
    [
      'install',
      '--offline',
      '--engine-strict',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(directory, manifest.filename),
      ...dependencies,
    ],
    directory,
  );
  assert.equal(installed.status, 0, installed.stderr);
  const metadata = JSON.parse(
    await readFile(
      join(directory, 'node_modules', 'verifold', 'package.json'),
      'utf8',
    ),
  );
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.publishConfig.registry, 'https://registry.npmjs.org/');
  // The desk renders harness Markdown with marked. DOMPurify, idiomorph, and xterm.js ship as vendored files.
  assert.deepEqual(Object.keys(metadata.dependencies ?? {}), ['marked']);
  // Terminal panes need the prebuilt PTY library. No install script builds it.
  assert.deepEqual(Object.keys(metadata.optionalDependencies ?? {}), [
    '@lydell/node-pty',
  ]);
  const pty = JSON.parse(
    await readFile(
      join(directory, 'node_modules', '@lydell', 'node-pty', 'package.json'),
      'utf8',
    ),
  );
  for (const script of ['preinstall', 'install', 'postinstall'])
    assert.equal(pty.scripts?.[script], undefined);
  const shell = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { spawn } = await import('@lydell/node-pty'); const term = spawn('/bin/sh', ['-c', 'echo pty-ok'], {}); let out = ''; term.onData((d) => { out += d; }); term.onExit(() => { console.log(out.trim()); });",
    ],
    directory,
  );
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /pty-ok/);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.equal(metadata.scripts[script], undefined);
  for (const required of ['LICENSE', 'LICENSING.md', 'SECURITY.md'])
    assert.ok(manifest.files.some((file) => file.path === required));
  // Each layer's loader lists its prompts. The tarball holds exactly those files.
  const packedPrompts = manifest.files
    .map((file) => file.path)
    .filter((path) => /^dist-cli\/[a-z]+\/prompts\/[a-z-]+\.md$/.test(path));
  const registered = [];
  for (const { path } of manifest.files) {
    const layer = /^dist-cli\/([a-z]+)\/prompts\.js$/.exec(path)?.[1];
    if (!layer) continue;
    const { promptIds } = await import(
      pathToFileURL(join(directory, 'node_modules/verifold', path)).href
    );
    registered.push(
      ...promptIds.map((id) => `dist-cli/${layer}/prompts/${id}.md`),
    );
  }
  assert.deepEqual(registered.sort(), packedPrompts.sort());
  assert.ok(registered.length > 0);
  const { runCli } = await import(
    pathToFileURL(
      join(directory, 'node_modules/verifold/dist-cli/cli/commands.js'),
    ).href
  );
  const root = join(directory, 'bare-launch');
  await mkdir(root);
  const agency = join(root, 'agency');
  // The old setup in the terminal, and the profile of an older project, are the old desk's (--desk). A bare launch in a project opens the app.
  for (const args of [
    [
      '--desk',
      '--setup-only',
      '--host',
      'codex',
      '--model',
      'default',
      '--agency-dir',
      agency,
      '--no-open',
    ],
    ['--no-open', '--agency-dir', agency],
    ['--desk', '--no-open', '--agency-dir', join(root, 'legacy-agency')],
  ]) {
    const previousWorkspace = args.includes('--setup-only')
      ? undefined
      : await readFile(join(root, '.verifold', 'workspace.json'));
    const owner = new AbortController();
    const results = [];
    await runCli(
      args,
      root,
      {
        interactive: true,
        ask: () => Promise.resolve('skip'),
        out: (value) => {
          results.push(value);
          if (value.startsWith('{')) {
            const desk = JSON.parse(value);
            assert.equal(new URL(desk.url).hostname, '127.0.0.1');
            assert.equal(desk.readOnly, false);
            // A bare launch prints the app's URL too. --desk prints the old desk's alone.
            if (args.includes('--desk')) {
              assert.equal(new URL(desk.url).pathname, '/desk');
              assert.equal(desk.app, undefined);
            } else assert.equal(new URL(desk.app).pathname, '/app/');
            owner.abort();
          }
        },
      },
      owner.signal,
      () =>
        Promise.reject(
          new Error(
            'Launch must not call a harness in setup-only or existing projects.',
          ),
        ),
    );
    assert.ok(results.some((value) => value.includes('"url":')));
    if (previousWorkspace)
      assert.deepEqual(
        await readFile(join(root, '.verifold', 'workspace.json')),
        previousWorkspace,
      );
  }
  assert.equal(
    JSON.parse(
      await readFile(join(root, 'legacy-agency', 'settings.json'), 'utf8'),
    ).host,
    'codex',
  );
  assert.match(await readFile(join(agency, 'settings.json'), 'utf8'), /codex/);
  const launchState = await readFile(
    join(root, '.verifold', 'workspace.json'),
    'utf8',
  );
  await writeFile(join(root, '.verifold', 'workspace.json'), 'broken');
  await assert.rejects(
    runCli(['--no-open'], root, {
      interactive: true,
      ask: () => Promise.reject(new Error('No reinitialization')),
      out: () => {},
    }),
  );
  assert.equal(
    await readFile(join(root, '.verifold', 'workspace.json'), 'utf8'),
    'broken',
  );
  assert.match(launchState, /codex/);

  const invoke = (...args) =>
    run(join(directory, 'node_modules', '.bin', 'verifold'), args, directory);
  assert.equal(invoke('--help').status, 0);
  assert.equal(invoke('--version').stdout.trim(), metadata.version);
  const profileStatus = invoke('profile', '--agency-dir', agency);
  assert.equal(profileStatus.status, 0, profileStatus.stderr);
  assert.equal(JSON.parse(profileStatus.stdout).status, 'skipped');
  assert.equal(JSON.parse(profileStatus.stdout).markdown, null);
  assert.notEqual(
    invoke('profile', '--setup', '--agency-dir', agency).status,
    0,
  );
  assert.notEqual(invoke('bad-command').status, 0);
  assert.notEqual(invoke('init').status, 0);
  await writeFile(
    join(directory, 'profile.json'),
    JSON.stringify({
      name: 'Package test',
      interests: ['Math'],
      scholar: '',
      github: '',
      session: '',
    }),
  );
  assert.equal(
    invoke('init', '--setup-only', '--profile', 'profile.json').status,
    0,
  );
  const request = invoke('recommend');
  assert.equal(request.status, 0);
  assert.equal(JSON.parse(request.stdout).kind, 'recommendation-request');
  await writeFile(
    join(directory, 'ideas.json'),
    JSON.stringify([
      {
        id: 'proof',
        title: 'Check theorem',
        recommendation: 'Checkable by a proof kernel',
        gates: ['Kernel acceptance'],
      },
    ]),
  );
  assert.equal(invoke('ideas', '--from', 'ideas.json').status, 0);
  assert.notEqual(invoke('select').status, 0);
  assert.equal(invoke('select', '--id', 'proof').status, 0);
  const handoff = invoke('handoff');
  assert.equal(handoff.status, 0);
  assert.equal(JSON.parse(handoff.stdout).executionAuthorized, false);
  assert.equal(invoke('view').status, 0);
  await mkdir(join(directory, 'bin'));
  const plan = {
    scope: 'Compare proof search.',
    personas: [
      { name: 'Prior art', task: 'Review prior art.' },
      { name: 'Skeptic', task: 'Challenge novelty.' },
    ],
  };
  const report = {
    summary: 'A bounded comparison is feasible.',
    delegation: 'Test host fixture, no real subagents.',
    sources: [
      { title: 'A', url: 'https://example.org/a' },
      { title: 'B', url: 'https://example.org/b' },
    ],
    candidates: [
      {
        id: 'comparison',
        title: 'Compare proof search',
        recommendation: 'Use a small reproducible baseline.',
        gates: ['Check proofs.'],
        sources: ['https://example.org/a'],
      },
    ],
  };
  const onboarding = {
    question: null,
    brief:
      'Compare proof search under fixed CPU compute; motivation: understand baseline failures. Background unknown.',
  };
  await writeFile(
    join(directory, 'bin', 'claude'),
    `#!/usr/bin/env node
async function main() {
// The first run's detection asks for the version and the sign-in.
if (process.argv[2] === '--version') return console.log('9.9.9 (Claude Code)');
if (process.argv[2] === 'auth') return console.log(JSON.stringify({ loggedIn: true, email: 'package@example.com', subscriptionType: 'pro' }));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const result = prompt.includes("research onboarding agent") ? ${JSON.stringify(onboarding)} : prompt.includes('Plan the research now.') ? ${JSON.stringify(plan)} : ${JSON.stringify(report)};
console.log(JSON.stringify({result: JSON.stringify(result), session_id: 'package-session'}));
}
main().catch(() => { process.exitCode = 1; });
`,
    { mode: 0o700 },
  );
  const research = invoke(
    'init',
    '--workspace',
    'research-project',
    '--agency-dir',
    join(directory, 'private-agency'),
    '--host',
    'claude',
    '--model',
    'fixture-model',
    '--topic',
    'Proof search',
    '--autonomy',
    'autonomous',
  );
  assert.equal(research.status, 0, research.stderr);
  const state = JSON.parse(research.stdout);
  assert.equal(state.research.phase, 'directions');
  assert.equal(state.model, 'fixture-model');
  assert.equal(state.context, onboarding.brief);
  for (const name of [
    'literature',
    'experiments',
    'results',
    'figures',
    'docs',
    'agents',
  ])
    assert.ok(
      (await stat(join(directory, 'research-project', name))).isDirectory(),
    );
  assert.match(
    await readFile(join(directory, 'research-project', '.verifold.md'), 'utf8'),
    /baseline failures/,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(directory, 'private-agency', 'settings.json'),
        'utf8',
      ),
    ).host,
    'claude',
  );
  assert.equal(state.research.sessionId, 'package-session');
  const attempt = JSON.parse(
    await readFile(
      join(
        directory,
        'research-project',
        '.verifold',
        'runs',
        state.research.latestAttempt,
        'attempt.json',
      ),
      'utf8',
    ),
  );
  assert.equal(attempt.attemptId, state.research.latestAttempt);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.model, 'fixture-model');
  assert.equal(attempt.requestedSessionId, 'package-session');
  assert.equal(attempt.nativeSessionId, 'package-session');
  assert.equal(state.selectedId, null);
  assert.equal(state.candidates[0].sources[0], 'https://example.org/a');
  assert.equal(
    invoke(
      'research',
      '--workspace',
      'research-project',
      '--feedback',
      'Prefer deterministic baselines.',
    ).status,
    0,
  );
  assert.equal(
    invoke('select', '--workspace', 'research-project', '--id', 'comparison')
      .status,
    0,
  );
  const literature = invoke(
    'literature',
    '--workspace',
    'research-project',
    '--memory',
  );
  assert.equal(literature.status, 0, literature.stderr);
  assert.equal(JSON.parse(literature.stdout).executionStarted, false);
  await writeFile(
    join(directory, 'bin', 'codex'),
    `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (process.argv[2] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
const { out, onLine } = require(${JSON.stringify(join(process.cwd(), 'tests', 'fixtures', 'codex-socket.cjs'))})(process.argv);
let strict = false;
onLine((line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  if (message.method === 'model/list') out({ id: message.id, result: { data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra' }], nextCursor: null } });
  if (message.method === 'config/read') out({ id: message.id, result: { config: {} } });
  if (message.method === 'thread/start') {
    // A task session asks for no approvals. Only then does this fake write output.
    strict = message.params.approvalPolicy === 'never';
    out({ id: message.id, result: { thread: { id: 'package-thread' }, approvalsReviewer: message.params.approvalsReviewer } });
  }
  if (message.method === 'turn/start') {
    out({ id: message.id, result: { turn: { id: 'turn-1' } } });
    if (strict) {
      require('node:fs').mkdirSync('results', { recursive: true });
      require('node:fs').writeFileSync('results/package.md', 'packaged task output\\n');
    }
    out({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'exec-1', command: 'curl -sI https://example.org', status: 'inProgress' } } });
    out({ method: 'item/autoApprovalReview/completed', params: { targetItemId: 'exec-1', review: { status: 'approved', riskLevel: 'low', rationale: 'Read-only request.' } } });
    out({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'exec-1', command: 'curl -sI https://example.org', status: 'completed', exitCode: 0 } } });
    out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
});
`,
    { mode: 0o700 },
  );
  const session = invoke(
    'session',
    '--workspace',
    'research-project',
    '--host',
    'codex',
    '--mode',
    'auto',
    '--prompt',
    'Check the example page.',
    '--no-open',
  );
  assert.equal(session.status, 0, session.stderr);
  const [deskLine, summaryLine] = session.stdout.trim().split('\n');
  assert.equal(JSON.parse(deskLine).readOnly, false);
  const summary = JSON.parse(summaryLine);
  assert.equal(summary.status, 'ended');
  assert.equal(summary.commands, 1);
  const sessionRecord = JSON.parse(await readFile(summary.record, 'utf8'));
  assert.equal(sessionRecord.nativeSessionId, 'package-thread');
  assert.equal(
    sessionRecord.commands[0].review.rationale,
    'Read-only request.',
  );
  assert.deepEqual(sessionRecord.commands[0].risk, ['Network']);
  const desk = spawn(
    process.execPath,
    [
      join(directory, 'node_modules', 'verifold', 'dist-cli', 'cli.js'),
      'ui',
      '--workspace',
      'research-project',
      '--no-open',
    ],
    { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(desk, 'close');
  const lines = createInterface({ input: desk.stdout });
  let diagnostics = '';
  desk.stderr.setEncoding('utf8').on('data', (chunk) => {
    diagnostics += chunk;
  });
  try {
    const output = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(10000) }).then(
        ([line]) => line,
      ),
      closed.then(() => {
        throw new Error(`Desk exited before startup: ${diagnostics}`);
      }),
    ]);
    const printed = JSON.parse(output);
    const url = new URL(printed.url);
    // The run of this project is from the research flow, so it opens in the old desk.
    assert.equal(url.pathname, '/desk');
    assert.equal(printed.app, undefined);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
    // The app's API answers with the token only. It shows this run in History.
    assert.equal((await fetch(`${url.origin}/api/v1/snapshot`)).status, 401);
    const snapshot = await (
      await fetch(`${url.origin}/api/v1/snapshot`, { headers })
    ).json();
    assert.equal(snapshot.researchRun, true);
    assert.equal(snapshot.lab, null);
    assert.equal((await fetch(`${url.origin}/api/view`)).status, 401);
    assert.equal(
      (await fetch(`${url.origin}/api/action`, { method: 'POST' })).status,
      401,
    );
    const view = async (query) =>
      (
        await (
          await fetch(`${url.origin}/api/view${query}`, { headers })
        ).json()
      ).html;
    // The coordinator's panel offers the chosen direction as its objective.
    assert.match(await view('?panel=coordinator'), /Compare proof search/);
    // The attempt panel shows the native session of the research attempt.
    assert.match(await view('?view=records&panel=attempt'), /package-session/);
    // `/` leads to the app. The old desk's page is at /desk for this release.
    const home = await fetch(`${url.origin}/`, { redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/app/');
    for (const path of [
      '/desk',
      '/desk-client.js',
      '/desk-transcript.js',
      '/desk-terminal.js',
      '/desk-terminals.js',
      '/desk-lease.js',
      '/desk-map.js',
      '/desk-motion.js',
      '/vendor/xterm.js',
      '/vendor/xterm.css',
      '/vendor/addon-fit.js',
      '/ui/dom.js',
      '/ui/token.js',
      '/desk.css',
      '/manrope.ttf',
      '/symbol.webp',
      '/vendor/purify.js',
      '/vendor/idiomorph.js',
    ]) {
      const asset = await fetch(url.origin + path);
      assert.equal(asset.status, 200, path);
      assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
    }
    // The new app: its page, and each file that the page loads.
    const appPage = await fetch(`${url.origin}/app/`);
    assert.equal(appPage.status, 200);
    const appHtml = await appPage.text();
    const appFiles = [
      ...appHtml.matchAll(/(?:src|href)="(\/app\/assets\/[\w.-]+)"/g),
    ].map((match) => match[1]);
    assert.ok(
      appFiles.some((path) => path.endsWith('.js')),
      appHtml,
    );
    assert.ok(
      appFiles.some((path) => path.endsWith('.css')),
      appHtml,
    );
    // The app's own icon, for the tab and for desktop notifications.
    const icon = appFiles.find((path) => path.endsWith('.webp'));
    assert.ok(icon, appHtml);
    let appCode = '';
    for (const path of appFiles) {
      const asset = await fetch(url.origin + path);
      assert.equal(asset.status, 200, path);
      const body = await asset.arrayBuffer();
      assert.ok(body.byteLength > 0, path);
      if (path.endsWith('.js')) appCode += Buffer.from(body).toString('utf8');
    }
    // The code imports the icon, so the build gives it the same file's URL for notifications.
    assert.ok(appCode.includes(icon), `The app's code does not name ${icon}.`);
    // The terminal page alone allows inline styles for xterm.js, and only the desk may frame it.
    const terminal = await fetch(
      `${url.origin}/terminal?session=20261003T000000000Z-aaaaaaaa`,
    );
    assert.equal(terminal.status, 200);
    assert.match(
      terminal.headers.get('content-security-policy') ?? '',
      /style-src 'self' 'unsafe-inline'.*frame-ancestors 'self'/,
    );
    assert.match(await terminal.text(), /desk-terminal\.js/);
    // A scoped task with the packed task prompt: create, run, review, accept.
    const action = async (body) => {
      const response = await fetch(`${url.origin}/api/action`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.text());
    };
    await action({
      action: 'task-create',
      title: 'Package task',
      objective: 'Write results/package.md.',
      writable: 'results',
      output: 'results/package.md',
      host: 'codex',
    });
    await action({ action: 'task-start', task: 'task-1' });
    let html = '';
    for (let tries = 0; tries < 100 && !html.includes('Version 1'); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      html = await view('?view=task');
    }
    assert.match(html, /Version 1/);
    await action({
      action: 'task-accept',
      task: 'task-1',
      version: 1,
      files: ['results/package.md'],
    });
    assert.equal(
      await readFile(
        join(directory, 'research-project', 'results', 'package.md'),
        'utf8',
      ),
      'packaged task output\n',
    );
    // The task ran the fake Codex, never a harness from the person's PATH.
    assert.match(await view('?panel=worker'), /Native session: package-thread/);
  } finally {
    lines.close();
    desk.kill('SIGTERM');
    const force = setTimeout(() => desk.kill('SIGKILL'), 5000);
    const [code] = await closed;
    clearTimeout(force);
    assert.equal(code, 0, diagnostics);
  }
  // A bare verifold in a folder without a project: the packed app's first run, with the fake harnesses only.
  {
    const folder = join(directory, 'first-run');
    await mkdir(folder);
    const agency = join(directory, 'first-run-agency');
    const before = {
      PATH: process.env.PATH,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    // Detection runs in this process, so it finds the fake harnesses first, and no Claude Code settings.
    process.env.PATH = environment.PATH;
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'no-claude-config');
    const stopStart = new AbortController();
    let shown;
    let typed;
    const opened = [];
    const started = runCli(
      ['--no-open', '--agency-dir', agency],
      folder,
      {
        interactive: true,
        ask: () => Promise.reject(new Error('No prompts')),
        out: (value) => {
          shown = JSON.parse(value);
        },
        browse: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
        listen: (onLine) => {
          typed = onLine;
        },
        compute: {
          store: {
            home: join(directory, 'first-run-home'),
            platform: 'linux',
            secretTool: join(directory, 'no-secret-tool'),
          },
        },
      },
      stopStart.signal,
    );
    try {
      for (let tries = 0; tries < 100 && !(shown && typed); tries++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(shown?.app, 'The first run printed no app URL.');
      const url = new URL(shown.url);
      const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
      assert.equal((await fetch(`${url.origin}/app/`)).status, 200);
      // /app in the terminal opens the app with a one-time code. The page trades it for the token, once.
      typed('/app');
      for (let tries = 0; tries < 100 && !opened.length; tries++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const launch = new URL(opened[0]);
      assert.equal(launch.pathname, '/app/');
      const code = /^#launch-([0-9a-f]{48})$/.exec(launch.hash)?.[1];
      assert.ok(code, launch.hash);
      const exchange = () =>
        fetch(`${url.origin}/api/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
      const traded = await exchange();
      assert.equal(traded.status, 200);
      assert.deepEqual(await traded.json(), { token: url.hash.slice(1) });
      assert.equal((await exchange()).status, 403);
      let setup;
      for (let tries = 0; tries < 200; tries++) {
        setup = await (
          await fetch(`${url.origin}/api/v1/setup`, { headers })
        ).json();
        if (!setup.agents.checking && setup.agents.tools.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(
        setup.agents.tools.map((tool) => [
          tool.harness,
          tool.version,
          tool.signedIn,
          tool.models[0]?.id,
        ]),
        [
          ['claude', '9.9.9', true, 'opus'],
          ['codex', '9.9.9', true, 'gpt-6-astra'],
        ],
      );
      assert.ok(!JSON.stringify(setup).includes('package@example.com'));
      const skipped = await fetch(`${url.origin}/api/v1/actions/setup-skip`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 'all' }),
      });
      assert.equal(skipped.status, 200, await skipped.text());
      assert.deepEqual(
        JSON.parse(await readFile(join(agency, 'settings.json'), 'utf8')).steps,
        {
          agents: 'skipped',
          about: 'skipped',
          skills: 'skipped',
          money: 'skipped',
        },
      );
      // No project starts without a question.
      await assert.rejects(stat(join(folder, '.verifold')));
    } finally {
      stopStart.abort();
      await started;
      process.env.PATH = before.PATH;
      if (before.CLAUDE_CONFIG_DIR === undefined)
        delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before.CLAUDE_CONFIG_DIR;
    }
  }
  // The background owner: its key arrives on stdin only, a hangup does not stop it, and verifold stop does.
  const home = join(directory, 'home');
  const socketFolder = await mkdtemp(join(tmpdir(), 'vf-'));
  const control = {
    socket: join(socketFolder, 'owner.sock'),
    token: randomBytes(32).toString('hex'),
  };
  const ownerEnvironment = { ...environment, HOME: home };
  const owner = spawn(
    process.execPath,
    [
      join(directory, 'node_modules', 'verifold', 'dist-cli', 'cli.js'),
      'owner',
      '--workspace',
      'research-project',
    ],
    {
      cwd: directory,
      env: ownerEnvironment,
      detached: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  const ownerClosed = once(owner, 'close');
  let ownerErrors = '';
  owner.stderr.setEncoding('utf8').on('data', (chunk) => {
    ownerErrors += chunk;
  });
  owner.stdin.end(`${JSON.stringify(control)}\n`);
  try {
    let socket;
    for (let tries = 0; tries < 100 && !socket; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket = await new Promise((resolve) => {
        const attempt = createConnection(control.socket);
        attempt.once('connect', () => resolve(attempt));
        attempt.once('error', () => resolve(undefined));
      });
    }
    assert.ok(socket, `The owner did not listen: ${ownerErrors}`);
    socket.write(`${JSON.stringify({ token: control.token })}\n`);
    const messages = createInterface({ input: socket });
    const [first] = await once(messages, 'line', {
      signal: AbortSignal.timeout(10000),
    });
    const urls = JSON.parse(first);
    assert.match(urls.url, /^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{64}$/);
    // The owner passes on the app's URL, and the old desk's for a terminal that attaches with --desk.
    const place = new URL(urls.url);
    assert.equal(urls.app, `${place.origin}/app/${place.hash}`);
    assert.equal(urls.desk, `${place.origin}/desk${place.hash}`);
    const command = run('ps', ['-o', 'command=', '-p', String(owner.pid)]);
    assert.ok(!command.stdout.includes(control.token));
    owner.kill('SIGHUP');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(owner.exitCode, null, ownerErrors);
    socket.end();
    const stopped = spawnSync(
      process.execPath,
      [
        join(directory, 'node_modules', 'verifold', 'dist-cli', 'cli.js'),
        'stop',
        '--workspace',
        'research-project',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: ownerEnvironment,
        timeout: 30000,
      },
    );
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout.trim(), 'Verifold stopped.');
    const [code] = await ownerClosed;
    assert.equal(code, 0, ownerErrors);
    const log = await readFile(
      join(directory, 'research-project', '.verifold', 'owner.log'),
      'utf8',
    ).catch(() => '');
    assert.ok(!log.includes(control.token));
    await assert.rejects(stat(control.socket));
  } finally {
    owner.kill('SIGKILL');
    await rm(socketFolder, { recursive: true, force: true });
  }
  console.log(
    `Packed CLI on Node ${process.versions.node} installed offline; legacy flow, fake-host research, session resume, a fake-host controlled session, a scoped task, selection, memory request, local desk, the first run, and background owner passed.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
