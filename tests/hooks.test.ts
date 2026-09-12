import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

function invoke(
  cwd: string,
  command: string,
  args: readonly string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  // Git exports repository variables to hooks. Keep fixture commands in their own repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const result = spawnSync(command, [...args], {
    cwd,
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
    timeout: 10000,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = invoke(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(
  t: TestContext,
  gate: 'pass' | 'fail' = 'pass',
): Promise<{ root: string; head: string; previous: string }> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '--template=');
  git(root, 'config', 'user.name', 'Hook fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(
    join(root, 'Makefile'),
    gate === 'pass'
      ? 'validate:\n\t@printf passed > gate-ran\n'
      : 'validate:\n\t@printf failed > gate-ran\n\t@exit 7\n',
  );
  await writeFile(join(root, 'tracked.txt'), 'Initial\n');
  git(root, 'add', 'Makefile', 'tracked.txt');
  git(root, 'commit', '-m', 'Initial fixture');
  const previous = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'tracked.txt'), 'Current\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-m', 'Second fixture');
  const head = git(root, 'rev-parse', 'HEAD');
  await mkdir(join(root, '.git', 'hooks'));
  for (const name of ['pre-commit', 'pre-push']) {
    const path = join(root, '.git', 'hooks', name);
    await copyFile(resolve('.githooks', name), path);
    await chmod(path, 0o755);
  }
  return { root, head, previous };
}

async function noValidation(root: string): Promise<void> {
  await assert.rejects(readFile(join(root, 'gate-ran')), { code: 'ENOENT' });
}

await test('pre-commit validates a snapshot that matches the index', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'tracked.txt'), 'Staged change\n');
  git(root, 'add', 'tracked.txt');
  const result = invoke(root, 'git', ['commit', '-m', 'Validated change']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(root, 'gate-ran'), 'utf8'), 'passed');
  assert.equal(git(root, 'show', 'HEAD:tracked.txt'), 'Staged change');
});

for (const kind of ['unstaged', 'untracked'] as const) {
  await test(`pre-commit rejects ${kind} work before validation`, async (t) => {
    const { root, head } = await fixture(t);
    await writeFile(join(root, 'tracked.txt'), 'Staged change\n');
    git(root, 'add', 'tracked.txt');
    await writeFile(
      join(root, kind === 'unstaged' ? 'tracked.txt' : 'notes.txt'),
      'Uncommitted work\n',
    );
    const result = invoke(root, 'git', ['commit', '-m', 'Must not commit']);
    assert.notEqual(result.status, 0);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    await noValidation(root);
  });
}

await test('pre-commit refuses a commit when validation fails', async (t) => {
  const { root, head } = await fixture(t);
  await writeFile(
    join(root, 'Makefile'),
    'validate:\n\t@printf failed > gate-ran\n\t@exit 7\n',
  );
  git(root, 'add', 'Makefile');
  const result = invoke(root, 'git', ['commit', '-m', 'Must not commit']);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(root, 'gate-ran'), 'utf8'), 'failed');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
});

function pushLine(head: string): string {
  return `refs/heads/work ${head} refs/heads/work ${'0'.repeat(40)}\n`;
}

await test('pre-push validates the committed HEAD', async (t) => {
  const { root, head } = await fixture(t);
  const result = invoke(
    root,
    '.git/hooks/pre-push',
    ['origin', 'unused'],
    pushLine(head),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(root, 'gate-ran'), 'utf8'), 'passed');
});

for (const kind of ['staged', 'unstaged', 'untracked'] as const) {
  await test(`pre-push rejects ${kind} work before validation`, async (t) => {
    const { root, head } = await fixture(t);
    await writeFile(
      join(root, kind === 'untracked' ? 'notes.txt' : 'tracked.txt'),
      'Local change\n',
    );
    if (kind === 'staged') git(root, 'add', 'tracked.txt');
    const result = invoke(
      root,
      '.git/hooks/pre-push',
      ['origin', 'unused'],
      pushLine(head),
    );
    assert.notEqual(result.status, 0);
    await noValidation(root);
  });
}

await test('pre-push rejects a revision other than HEAD', async (t) => {
  const { root, previous } = await fixture(t);
  const result = invoke(
    root,
    '.git/hooks/pre-push',
    ['origin', 'unused'],
    pushLine(previous),
  );
  assert.notEqual(result.status, 0);
  await noValidation(root);
});

await test('pre-push propagates validation failure', async (t) => {
  const { root, head } = await fixture(t, 'fail');
  const result = invoke(
    root,
    '.git/hooks/pre-push',
    ['origin', 'unused'],
    pushLine(head),
  );
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(root, 'gate-ran'), 'utf8'), 'failed');
});
