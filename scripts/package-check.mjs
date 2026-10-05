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
        /^dist-cli\/cli\/[a-z-]+\.js$/.test(file.path) ||
        /^dist-cli\/cli\/prompts\/[a-z-]+\.md$/.test(file.path) ||
        [
          'dist-cli/cli.js',
          'dist-cli/domain/profile.js',
          'dist-cli/ui/dom.js',
          'dist-cli/cli/desk.css',
          'dist-cli/cli/manrope.ttf',
          'dist-cli/cli/OFL-Manrope.txt',
          'dist-cli/cli/symbol.webp',
          'dist-cli/cli/vendor/purify.js',
          'dist-cli/cli/vendor/purify.LICENSE.txt',
          'dist-cli/cli/vendor/xterm.js',
          'dist-cli/cli/vendor/xterm.css',
          'dist-cli/cli/vendor/xterm.LICENSE.txt',
          'dist-cli/cli/vendor/addon-fit.js',
          'dist-cli/cli/vendor/addon-fit.LICENSE.txt',
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
  // The desk renders harness Markdown with marked. DOMPurify and xterm.js ship as vendored files.
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
  const { runCli } = await import(
    pathToFileURL(
      join(directory, 'node_modules/verifold/dist-cli/cli/commands.js'),
    ).href
  );
  const root = join(directory, 'bare-launch');
  await mkdir(root);
  const agency = join(root, 'agency');
  for (const args of [
    [
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
    ['--no-open', '--agency-dir', join(root, 'legacy-agency')],
  ]) {
    const previousWorkspace =
      args[0] === '--setup-only'
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
const { out, onLine } = require(${JSON.stringify(join(process.cwd(), 'tests', 'fixtures', 'codex-socket.cjs'))})(process.argv);
let strict = false;
onLine((line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') out({ id: message.id, result: {} });
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
    const url = new URL(JSON.parse(output).url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
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
    assert.match(await view(''), /Compare proof search/);
    // The attempt panel shows the native session of the research attempt.
    assert.match(await view('?view=records&panel=attempt'), /package-session/);
    for (const path of [
      '/',
      '/desk-client.js',
      '/desk-transcript.js',
      '/desk-terminal.js',
      '/desk-terminals.js',
      '/desk-lease.js',
      '/vendor/xterm.js',
      '/vendor/xterm.css',
      '/vendor/addon-fit.js',
      '/ui/dom.js',
      '/desk.css',
      '/manrope.ttf',
      '/symbol.webp',
      '/vendor/purify.js',
    ]) {
      const asset = await fetch(url.origin + path);
      assert.equal(asset.status, 200, path);
      assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
    }
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
      html = await view('?view=tasks&panel=task');
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
  console.log(
    `Packed CLI on Node ${process.versions.node} installed offline; legacy flow, fake-host research, session resume, a fake-host controlled session, a scoped task, selection, memory request, and local desk passed.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
