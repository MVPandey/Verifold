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
const directory = await mkdtemp(join(tmpdir(), 'verifold-package-'));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(directory, 'bin')}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      npm_config_cache: join(directory, 'cache'),
    },
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
        [
          'dist-cli/cli.js',
          'dist-cli/domain/profile.js',
          'dist-cli/ui/dom.js',
          'dist-cli/cli/desk.css',
          'dist-cli/cli/manrope.ttf',
          'dist-cli/cli/OFL-Manrope.txt',
          'dist-cli/cli/symbol.webp',
          'package.json',
          'README.md',
          'LICENSE',
          'LICENSING.md',
          'SECURITY.md',
        ].includes(file.path),
    ),
  );
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
  assert.deepEqual(Object.keys(metadata.dependencies ?? {}), []);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.equal(metadata.scripts[script], undefined);
  for (const required of ['LICENSE', 'LICENSING.md', 'SECURITY.md'])
    assert.ok(manifest.files.some((file) => file.path === required));
  const invoke = (...args) =>
    run(join(directory, 'node_modules', '.bin', 'verifold'), args, directory);
  assert.equal(invoke('--help').status, 0);
  assert.equal(invoke('--version').stdout.trim(), metadata.version);
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
  const desk = spawn(
    process.execPath,
    [
      join(directory, 'node_modules', 'verifold', 'dist-cli', 'cli.js'),
      'ui',
      '--workspace',
      'research-project',
      '--no-open',
    ],
    { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
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
    const view = await (
      await fetch(`${url.origin}/api/view`, { headers })
    ).json();
    assert.match(view.html, /Compare proof search/);
    assert.match(view.html, /package-session/);
    for (const path of [
      '/',
      '/desk-client.js',
      '/ui/dom.js',
      '/desk.css',
      '/manrope.ttf',
      '/symbol.webp',
    ]) {
      const asset = await fetch(url.origin + path);
      assert.equal(asset.status, 200, path);
      assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
    }
  } finally {
    lines.close();
    desk.kill('SIGTERM');
    const force = setTimeout(() => desk.kill('SIGKILL'), 5000);
    const [code] = await closed;
    clearTimeout(force);
    assert.equal(code, 0, diagnostics);
  }
  console.log(
    `Packed CLI on Node ${process.versions.node} installed offline; legacy flow, fake-host research, session resume, selection, memory request, and local desk passed.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
