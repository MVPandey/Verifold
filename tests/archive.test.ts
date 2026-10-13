import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveRun, listArchives, restoreRun } from '../src/cli/archive.ts';
import { changeWorkspace, loadWorkspace } from '../src/cli/storage.ts';

async function write(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
}

await test('Start over archives the run, keeps the question and the brief, and Restore brings it back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'R',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    context: 'The brief.',
    research: {
      topic: 'Is the heap version faster?',
      autonomy: 'guided',
      phase: 'directions',
      plan: {
        scope: 'Scope.',
        personas: [
          { name: 'Historian', task: 'Prior art.' },
          { name: 'Skeptic', task: 'Counterexamples.' },
        ],
      },
      sessionId: 'native-1',
      latestAttempt: '9f1c2b7e-1d2a-4c3b-8e5f-0a1b2c3d4e5f',
    },
    candidates: [
      {
        id: 'heap',
        title: 'Heap',
        recommendation: 'Compare.',
        gates: ['Same paths.'],
        kind: 'main',
      },
    ],
    selectedId: 'heap',
  }));
  // Nothing to archive yet: no run.
  assert.equal(await archiveRun(root), null);
  const run = {
    '.verifold/runs/a1/attempt.json': '{}',
    '.verifold/tasks/task-1/task.json': '{}',
    '.verifold/tasks/task-2/task.json': '{}',
    '.verifold/messages/m-1.json': '{}',
    '.verifold/coordinator/state.json': '{}',
    '.verifold/sessions/s.json': '{}',
    '.verifold/results.json': '{}',
    '.verifold/results-alt.json': '{}',
  };
  for (const [path, text] of Object.entries(run)) await write(root, path, text);
  // Settings and compute records stay with the project.
  await write(root, '.verifold/compute/settings.json', '{"keep": true}');
  const id = await archiveRun(root);
  assert.ok(id);
  const archived = join(root, '.verifold', 'archive', id);
  assert.deepEqual((await readdir(archived)).sort(), [
    'coordinator',
    'messages',
    'results-alt.json',
    'results.json',
    'runs',
    'sessions',
    'tasks',
    'workspace.json',
  ]);
  assert.deepEqual((await readdir(join(root, '.verifold'))).sort(), [
    'archive',
    'compute',
    'workspace.json',
  ]);
  // The new run keeps the question and the brief, and starts its research again.
  const fresh = await loadWorkspace(root);
  assert.deepEqual(fresh.research, {
    topic: 'Is the heap version faster?',
    autonomy: 'guided',
    phase: 'needs-plan',
  });
  assert.equal(fresh.context, 'The brief.');
  assert.deepEqual([fresh.candidates, fresh.selectedId], [[], null]);
  const [listed] = await listArchives(root);
  assert.equal(listed?.id, id);
  assert.equal(listed?.tasks, 2);
  assert.equal(listed?.direction, 'Heap');
  assert.ok((listed?.bytes ?? 0) > 0);
  // Restore moves the current run to the archive first, then brings the old run back where it was.
  await write(root, '.verifold/tasks/task-1/task.json', '{"next": true}');
  await assert.rejects(restoreRun(root, '../x'), /Choose an archive/);
  await restoreRun(root, id);
  assert.equal(
    await readFile(join(root, '.verifold/tasks/task-1/task.json'), 'utf8'),
    '{}',
  );
  const restored = await loadWorkspace(root);
  assert.equal(restored.selectedId, 'heap');
  assert.equal(restored.research?.phase, 'directions');
  const archives = await listArchives(root);
  assert.equal(archives.length, 1);
  assert.notEqual(archives[0]?.id, id);
  assert.equal(
    await readFile(
      join(
        root,
        '.verifold/archive',
        archives[0]?.id ?? '',
        'tasks/task-1/task.json',
      ),
      'utf8',
    ),
    '{"next": true}',
  );
  assert.equal(
    await readFile(join(root, '.verifold/compute/settings.json'), 'utf8'),
    '{"keep": true}',
  );
});
