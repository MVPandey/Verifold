import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

await test('private-file gate rejects force-staged notes and permits public docs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  function run(command: string, args: string[]) {
    const result = spawnSync(command, args, {
      cwd: root,
      env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (result.error) throw result.error;
    return result;
  }
  function git(...args: string[]): void {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
  }
  function check() {
    return run(process.execPath, [resolve('scripts/check-private-files.mjs')]);
  }

  git('init', '--template=');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'validation.md'), 'Public instructions\n');
  await writeFile(
    join(root, '.gitignore'),
    '.local/agents/\ndocs/research/\ndocs/agent/\ndocs/product-direction.md\ndocs/landscape-cli-plan.md\n',
  );
  git('add', '.gitignore', 'docs/validation.md');
  assert.equal(check().status, 0);

  for (const path of [
    '.local/agents/notes.md',
    'docs/research/review.md',
    'docs/agent/plan.md',
    'docs/product-direction.md',
    'docs/landscape-cli-plan.md',
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'Private notes\n');
    assert.equal(
      check().status,
      0,
      'Ignored private files must remain allowed',
    );
    git('add', '--force', path);
    const result = check();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(JSON.stringify(path)));
    git('rm', '--cached', '--', path);
    assert.equal(check().status, 0);
  }
});
