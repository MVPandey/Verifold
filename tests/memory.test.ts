import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectMemory } from '../src/cli/memory.ts';
import { changeWorkspace } from '../src/cli/storage.ts';
import type { TaskRecord } from '../src/cli/tasks.ts';

const at = '2026-10-12T14:00:00.000Z';

function task(id: string, state: string, extra: object = {}): TaskRecord {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    state,
    createdAt: at,
    updatedAt: at,
    claim: null,
    attempts: [],
    assignment: {
      revision: 1,
      at,
      by: 'coordinator',
      reason: 'Part of the plan.',
      title:
        id === 'task-1'
          ? 'Implement the heap version'
          : 'Benchmark both versions',
      objective: 'Time both versions on 9 road graphs.',
      inputs: [],
      writable: ['results'],
      output: 'results/bench.csv',
      host: 'claude',
      model: null,
      minutes: 20,
      dependencies: id === 'task-1' ? [] : ['task-1'],
    },
    ...extra,
  } as TaskRecord;
}

await test('the project memory follows the records, keeps the person’s text and the notes, and keeps earlier runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-memory-'));
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
    research: {
      topic: 'Is the heap version of Dijkstra faster on road graphs?',
      autonomy: 'guided',
      phase: 'directions',
      plan: {
        scope: 'Scope.',
        personas: [
          { name: 'H', task: 'A.' },
          { name: 'S', task: 'B.' },
        ],
      },
    },
    candidates: [
      {
        id: 'heap',
        title: 'Heap against a scan',
        recommendation: 'Compare a binary heap with a linear scan.',
        gates: ['Same paths on 200 queries.', 'Faster above 100,000 nodes.'],
        kind: 'main',
      },
    ],
    selectedId: 'heap',
  }));
  await writeFile(
    join(root, '.verifold', 'results.json'),
    JSON.stringify({
      schemaVersion: 1,
      direction: 'heap',
      checks: [
        {
          check: 1,
          result: 'passed',
          value: '0 differences',
          evidence: ['results/bench.csv'],
          reason: 'Both agree.',
          at,
        },
      ],
      answer: null,
    }),
  );
  let tasks: TaskRecord[] = [
    task('task-1', 'done', {
      artifacts: [
        {
          version: 1,
          revision: 1,
          at,
          files: [{ path: 'src/heap.py', bytes: 1, sha256: 'a'.repeat(64) }],
        },
      ],
      attempts: [
        {
          number: 1,
          revision: 1,
          claim: 'c',
          startedAt: at,
          endedAt: at,
          workspace: null,
          session: null,
          restrictions: [],
          outcome: 'accepted',
          note: null,
          versions: [
            {
              number: 1,
              commit: 'c',
              at,
              turn: 'completed',
              files: [],
              skipped: [],
              reply: 'The heap is in src/heap.py.',
              decision: { kind: 'accepted', files: ['src/heap.py'], at },
            },
          ],
        },
      ],
    }),
    task('task-2', 'open'),
  ];
  const memory = new ProjectMemory(root, () => Promise.resolve(tasks));
  await memory.write();
  const read = (name: string): Promise<string> =>
    readFile(join(root, 'memory', name), 'utf8');
  assert.match(
    await read('README.md'),
    /^# Project memory\n\nRead this first\.[\s\S]*<!-- verifold:readme -->\nQuestion: Is the heap version of Dijkstra faster on road graphs\?\nDirection: Heap against a scan\nThis run: 2 tasks, 1 done\./,
  );
  assert.match(
    await read('progress.md'),
    /## Done\n\n- Implement the heap version \(task-1\), Claude Code\. Accepted 2026-10-12 14:00: src\/heap\.py\. Details: tasks\/2026-10-12-implement-the-heap-version\.md[\s\S]*## Next\n\n- Benchmark both versions \(task-2\), waits for task-1\./,
  );
  assert.match(
    await read('decisions.md'),
    /Chosen direction: Heap against a scan\.[\s\S]*- 2026-10-12 14:00: The person accepted version 1 of Implement the heap version: src\/heap\.py\./,
  );
  assert.match(
    await read('findings.md'),
    /- Check 1: Same paths on 200 queries\.\n {2}- Result: passed\. 0 differences Evidence: results\/bench\.csv\.\n- Check 2: Faster above 100,000 nodes\.\n {2}- Result: not reported yet/,
  );
  assert.match(
    await read('tasks/2026-10-12-implement-the-heap-version.md'),
    /Version 1, 2026-10-12 14:00: no files\. Accepted\. The agent said: The heap is in src\/heap\.py\./,
  );
  // The person's own text stays when Verifold writes its part again.
  const findings = await read('findings.md');
  await writeFile(
    join(root, 'memory', 'findings.md'),
    findings.replace(
      '# Findings',
      '# Findings\n\nMy note: graph sizes matter.',
    ),
  );
  // Notes from the agents add up, and the index shows the latest.
  assert.equal(
    await memory.note('Coordinator', 'Skip the USA graph; it takes hours.'),
    'Kept the note in memory/notes.md.',
  );
  await assert.rejects(memory.note('Coordinator', ' '), /Write the note/);
  await memory.write();
  assert.match(await read('findings.md'), /My note: graph sizes matter\./);
  assert.match(
    await read('notes.md'),
    /<!-- verifold:notes -->\n- \d{4}-\d\d-\d\d \d\d:\d\d, Coordinator: Skip the USA graph; it takes hours\.\n<!-- \/verifold:notes -->/,
  );
  assert.match(
    await read('README.md'),
    /Latest notes:\n- [^\n]*Skip the USA graph/,
  );
  // Before Start over, this run stays in the files as an earlier run. The new run writes below it.
  await memory.freeze('archived 2026-10-13 09:00');
  tasks = [];
  await memory.write();
  const progress = await read('progress.md');
  assert.match(
    progress,
    /## Earlier run, archived 2026-10-13 09:00\n\n## Done\n\n- Implement the heap version[\s\S]*<!-- verifold:progress -->\nNo tasks yet\.\n<!-- \/verifold:progress -->/,
  );
  assert.match(await read('notes.md'), /Skip the USA graph/);
  // The index for a prompt, cut to its limit.
  assert.match(await memory.digest(), /^# Project memory/);
  assert.match(
    await memory.digest(40),
    /\[Verifold: memory\/README\.md continues\.\]$/,
  );
});
