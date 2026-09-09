import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'verifold-package-'));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(directory, 'cache') },
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
        file.path.startsWith('dist-cli/') ||
        ['package.json', 'README.md'].includes(file.path),
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
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(directory, manifest.filename),
    ],
    directory,
  );
  assert.equal(installed.status, 0, installed.stderr);
  const invoke = (...args) =>
    run(join(directory, 'node_modules', '.bin', 'verifold'), args, directory);
  assert.equal(invoke('--help').status, 0);
  assert.equal(invoke('--version').stdout.trim(), '0.1.0');
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
  assert.equal(invoke('init', '--profile', 'profile.json').status, 0);
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
  console.log(
    'Packed CLI installed offline; help, errors, private profile, host request, selection, handoff, and view passed.',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
