import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { changeWorkspace } from '../src/cli/storage.ts';
import { readDeskSnapshot, readDeskReport } from '../src/cli/desk-records.ts';

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-desk-'));
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
  return root;
}

async function attempt(
  root: string,
  changes: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const directory = join(root, '.verifold', 'runs', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'attempt.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: id,
      host: 'claude',
      model: null,
      phase: 'needs-plan',
      requestedSessionId: null,
      nativeSessionId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'started',
      ...changes,
    }),
  );
  return id;
}

await test('desk reads preserve state and distinguish recent observations, stale starts, and outcomes', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readFile(join(root, '.verifold', 'workspace.json'));
  assert.deepEqual((await readDeskSnapshot(root)).attempts, []);
  const recent = await attempt(root, { observedAt: new Date().toISOString() });
  const stale = await attempt(root, { observedAt: '2020-01-01T00:00:00.000Z' });
  const old = await attempt(root);
  const success = await attempt(root, {
    status: 'succeeded',
    finishedAt: new Date().toISOString(),
    nativeSessionId: 'native-1',
  });
  const invalid = await attempt(root, { attemptId: 'another-id' });
  const snapshot = await readDeskSnapshot(root);
  const byId = new Map(snapshot.attempts.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(recent)?.activity, 'recent');
  assert.equal(byId.get(stale)?.activity, 'unknown');
  assert.equal(byId.get(old)?.activity, 'unknown');
  assert.equal(byId.get(invalid)?.record, null);
  assert.equal(byId.get(success)?.record?.nativeSessionId, 'native-1');
  assert.equal(byId.get(success)?.activity, 'finished');
  assert.deepEqual(
    await readFile(join(root, '.verifold', 'workspace.json')),
    before,
  );
});

await test('desk rejects redirected workspace, run directories, and report files', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  await mkdir(outside);
  const state = join(root, '.verifold', 'workspace.json');
  await writeFile(join(outside, 'workspace.json'), await readFile(state));
  await rm(state);
  await symlink(join(outside, 'workspace.json'), state);
  await assert.rejects(readDeskSnapshot(root));
  await rm(state);
  await writeFile(state, await readFile(join(outside, 'workspace.json')));
  await symlink(outside, join(root, '.verifold', 'runs'));
  await assert.rejects(readDeskSnapshot(root), /real directories/);
  await rm(join(root, '.verifold', 'runs'));
  const id = await attempt(root);
  await symlink(
    join(outside, 'workspace.json'),
    join(root, '.verifold', 'runs', id, 'report.json'),
  );
  await assert.rejects(readDeskReport(root, id));
  await assert.rejects(
    readDeskReport(root, '../../outside'),
    /Invalid attempt ID/,
  );
  await writeFile(
    join(root, '.verifold', 'runs', id, 'attempt.json'),
    'x'.repeat(4001),
  );
  assert.equal((await readDeskSnapshot(root)).attempts[0]?.record, null);
});

await test('desk history has an explicit scan limit', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = join(root, '.verifold', 'runs');
  await mkdir(runs);
  for (let i = 0; i < 201; i++) await mkdir(join(runs, randomUUID()));
  const snapshot = await readDeskSnapshot(root);
  assert.equal(snapshot.attempts.length, 200);
  assert.equal(snapshot.historyLimited, true);
});
