import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { claimOwner, OwnerConflict } from '../src/cli/owner.ts';
import { changeWorkspace } from '../src/cli/storage.ts';
import { runCli } from '../src/cli/commands.ts';

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-owner-'));
  await mkdir(join(root, '.verifold'));
  return root;
}

await test('one process owns a project, and a second claim names the owner', async (t) => {
  const root = await folder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = await claimOwner(root, 'test');
  await assert.rejects(
    claimOwner(root, 'test'),
    (error) =>
      error instanceof OwnerConflict &&
      error.message.includes(`process ${process.pid}`),
  );
  await owner.release();
  const next = await claimOwner(root, 'test');
  await next.release();
  assert.deepEqual(await readdir(join(root, '.verifold')), []);
});

await test('a stopped or replaced owner does not block a new owner', async (t) => {
  const root = await folder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, '.verifold', 'owner.json');
  const stopped = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(
    path,
    JSON.stringify({ ownerId: 'old', pid: stopped, processStart: null }),
  );
  const owner = await claimOwner(root, 'test');
  assert.ok(
    (await readdir(join(root, '.verifold'))).some((name) =>
      name.endsWith('.stale.json'),
    ),
  );
  // Release removes only the record of this owner.
  await writeFile(
    path,
    JSON.stringify({ ownerId: 'someone', pid: stopped, processStart: null }),
  );
  await owner.release();
  assert.ok(existsSync(path));
  await writeFile(path, '{');
  await (await claimOwner(root, 'test')).release();
  if (process.platform !== 'win32') {
    // A live PID with another start time belongs to a different process.
    await writeFile(
      path,
      JSON.stringify({
        ownerId: 'old',
        pid: process.pid,
        processStart: 'Thu Jan  1 00:00:00 1970',
      }),
    );
    await (await claimOwner(root, 'test')).release();
  }
});

await test('a second verifold for the project stops before it opens a desk', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const owner = await claimOwner(root, 'test');
  const out: string[] = [];
  await assert.rejects(
    runCli(['ui', '--no-open'], root, {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: (value) => out.push(value),
    }),
    /already runs in this project/,
  );
  assert.deepEqual(out, []);
  await owner.release();
});
