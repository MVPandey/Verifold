import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectMemory, type LabProgress } from '../src/cli/memory.ts';
import { ResultsStore, type Results } from '../src/cli/results.ts';
import { changeWorkspace } from '../src/cli/storage.ts';
import type { TaskRecord } from '../src/cli/tasks.ts';

const at = '2026-10-12T14:00:00.000Z';

/** The results of a legacy project, read the way the owner reads them for the memory. */
function ownerResults(root: string): () => Promise<Results | null> {
  return async () => {
    const store = new ResultsStore(root);
    await store.load();
    return store.current();
  };
}

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
  const memory = new ProjectMemory(
    root,
    () => Promise.resolve(tasks),
    () => null,
    ownerResults(root),
  );
  await memory.write();
  const read = (name: string): Promise<string> =>
    readFile(join(root, 'memory', name), 'utf8');
  assert.match(
    await read('README.md'),
    /^# Project memory\n\nRead this first\.[\s\S]*<!-- verifold:readme -->\nQuestion: Is the heap version of Dijkstra faster on road graphs\?\nDirection: Heap against a scan\nThis run: 2 tasks, 1 done\./,
  );
  assert.match(
    await read('README.md'),
    /- direction\.md: the chosen direction/,
  );
  // A task that needs the specification gets this file as an input.
  assert.match(
    await read('direction.md'),
    /<!-- verifold:direction -->\nDirection: Heap against a scan\n\nCompare a binary heap with a linear scan\.\n\nChecks:\n1\. Same paths on 200 queries\.\n2\. Faster above 100,000 nodes\.\n<!-- \/verifold:direction -->/,
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

/**
 * The exact files for a legacy project and for a lab. The text comes from
 * Verifold before the memory stopped importing the task and results modules,
 * so a change here changes what the agents and the person read.
 */
await test('the memory files keep their exact text for a legacy project and for a lab', async (t) => {
  const later = '2026-10-13T09:30:00.000Z';
  const workspace = (root: string, selected: boolean): Promise<unknown> =>
    changeWorkspace(root, () => ({
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
      selectedId: selected ? 'heap' : null,
    }));
  const attempt = (versions: object[]): object => ({
    number: 1,
    revision: 1,
    claim: 'c',
    startedAt: at,
    endedAt: at,
    workspace: null,
    session: null,
    restrictions: [],
    outcome: null,
    note: null,
    versions,
  });
  const version = (
    number: number,
    decision: object | null,
    extra: object = {},
  ): object => ({
    number,
    commit: 'c',
    at,
    turn: 'completed',
    files: [
      {
        path: 'src/heap.py',
        bytes: 1,
        sha256: 'a'.repeat(64),
        status: 'added',
      },
    ],
    skipped: [],
    decision,
    ...extra,
  });
  const files = (root: string, names: readonly string[]): Promise<string[]> =>
    Promise.all(
      names.map((name) => readFile(join(root, 'memory', name), 'utf8')),
    );
  const pinned = {
    legacy: {
      'README.md':
        '# Project memory\n\nRead this first. It says what this project asks, what was done, decided, and found, also in earlier runs. The other files hold the details. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:readme -->\nQuestion: Is the heap version of Dijkstra faster on road graphs?\nDirection: Heap against a scan\nThis run: 4 tasks, 1 done.\n\n- direction.md: the chosen direction and its checks.\n- progress.md: what is done, what runs, and what comes next.\n- decisions.md: who decided what, and when.\n- findings.md: the check results with their evidence, and the answer.\n- notes.md: notes from the agents.\n- tasks/: one file for each task.\n<!-- /verifold:readme -->\n',
      'progress.md':
        '# Progress\n\nWhat is done, what runs, and what comes next. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:progress -->\n## Done\n\n- Implement the heap version (task-1), Claude Code. Accepted 2026-10-12 14:00: src/heap.py. Details: tasks/2026-10-12-implement-the-heap-version.md\n\n## Working\n\n- Benchmark both versions (task-2), Codex: its agent works.\n- Plot the timings (task-3), Claude Code: a version waits for review.\n\n## Next\n\n- Write the summary (task-4), a draft for the person, waits for task-2, task-3.\n<!-- /verifold:progress -->\n',
      'decisions.md':
        '# Decisions\n\nWho decided what, and when. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:decisions -->\nChosen direction: Heap against a scan. Compare a binary heap with a linear scan.\n\n- 2026-10-12 14:00: The person accepted version 1 of Implement the heap version: src/heap.py.\n- 2026-10-13 09:30: The coordinator asked Plot the timings for changes to version 1: Use a log scale..\n- 2026-10-13 09:30: The person rejected version 2 of Plot the timings.\n- 2026-10-13 09:30: The person ruled on check 2: failed. Two graphs are slower, so no.\n- 2026-10-13 09:30: The person asked for more work: Add one more graph..\n<!-- /verifold:decisions -->\n',
      'findings.md':
        '# Findings\n\nThe results of the checks, with their evidence, and the answer. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:findings -->\nDirection: Heap against a scan\n\n- Check 1: Same paths on 200 queries.\n  - Result: passed. 0 differences Evidence: results/bench.csv.\n- Check 2: Faster above 100,000 nodes.\n  - Result: failed. Faster on 7 of 9 graphs Evidence: results/bench.csv.\n\nAnswer (waits for the person): The heap wins above 100,000 nodes, not below.\n- The heap is 3 times faster on the largest graph. Evidence: results/bench.csv.\n<!-- /verifold:findings -->\n',
      'tasks/2026-10-12-implement-the-heap-version.md':
        '# Implement the heap version\n\nVerifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:task -->\nTask task-1, revision 1: done. Claude Code.\n\nObjective: Time both versions on 9 road graphs.\nExpected output: results/bench.csv\nMay write to: results\n\n- Version 1, 2026-10-12 14:00: src/heap.py. Accepted. The agent said: The heap is in src/heap.py.\n<!-- /verifold:task -->\n',
      'tasks/2026-10-12-plot-the-timings.md':
        '# Plot the timings\n\nVerifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:task -->\nTask task-3, revision 1: review. Claude Code.\n\nObjective: Time both versions on 9 road graphs.\nExpected output: results/bench.csv\nMay write to: results\n\n- Version 1, 2026-10-12 14:00: src/heap.py. Changes asked by the coordinator.\n- Version 2, 2026-10-12 14:00: src/heap.py. Rejected.\n<!-- /verifold:task -->\n',
    },
    lab: {
      'README.md':
        '# Project memory\n\nRead this first. It says what this project asks, what was done, decided, and found, also in earlier runs. The other files hold the details. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:readme -->\nQuestion: Is the heap version of Dijkstra faster on road graphs?\nDirection: not chosen yet\nThis run: a lab with 2 directions, 1 open; progress.md lists them with their verdicts.\n\n- direction.md: the chosen direction and its checks.\n- progress.md: what is done, what runs, and what comes next.\n- decisions.md: who decided what, and when.\n- findings.md: the check results with their evidence, and the answer.\n- notes.md: notes from the agents.\n- tasks/: one file for each task.\n<!-- /verifold:readme -->\n',
      'progress.md':
        "# Progress\n\nWhat is done, what runs, and what comes next. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:progress -->\n## Lab directions\n\n- d-1 Months and weekdays are circles, claude-1 (Claude Code): leading. Evidence: A probe places 78% of months right. (p-3, r-1). Holds up if: a probe places 60% of months right.\n- d-2 It's only word frequency, codex-1 (Codex): closed by its agent, ruled out.\n<!-- /verifold:progress -->\n",
      'decisions.md':
        '# Decisions\n\nWho decided what, and when. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:decisions -->\nNo direction is chosen yet.\n<!-- /verifold:decisions -->\n',
      'findings.md':
        '# Findings\n\nThe results of the checks, with their evidence, and the answer. Verifold keeps the part between its markers up to date. Write your own notes outside them.\n\n<!-- verifold:findings -->\nNo direction is chosen yet, so no check has a result.\n<!-- /verifold:findings -->\n',
    },
  };

  // A legacy project: tasks in each state, decisions of both kinds of author, a ruling, and an answer.
  const legacy = await mkdtemp(join(tmpdir(), 'verifold-memory-'));
  t.after(() => rm(legacy, { recursive: true, force: true }));
  await workspace(legacy, true);
  await writeFile(
    join(legacy, '.verifold', 'results.json'),
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
        {
          check: 2,
          result: 'judgement',
          value: 'Faster on 7 of 9 graphs',
          evidence: ['results/bench.csv'],
          reason: 'Two small graphs are slower.',
          question: 'Does 7 of 9 count?',
          at,
          ruling: {
            result: 'failed',
            reason: 'Two graphs are slower, so no.',
            at: later,
          },
        },
      ],
      answer: {
        statement: 'The heap wins above 100,000 nodes, not below.',
        claims: [
          {
            text: 'The heap is 3 times faster on the largest graph.',
            evidence: ['results/bench.csv'],
          },
        ],
        at: later,
        decision: { kind: 'more', at: later, note: 'Add one more graph.' },
      },
    }),
  );
  const base = task('task-x', 'open').assignment;
  const tasks = [
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
        attempt([
          version(
            1,
            { kind: 'accepted', files: ['src/heap.py'], at },
            { reply: 'The heap is in src/heap.py.' },
          ),
        ]),
      ],
    }),
    task('task-2', 'running', { assignment: { ...base, host: 'codex' } }),
    task('task-3', 'review', {
      assignment: { ...base, title: 'Plot the timings', dependencies: [] },
      attempts: [
        attempt([
          version(1, {
            kind: 'changes',
            at: later,
            note: 'Use a log scale.',
            by: 'coordinator',
          }),
          version(2, { kind: 'rejected', at: later }),
        ]),
      ],
    }),
    task('task-4', 'open', {
      assignment: {
        ...base,
        title: 'Write the summary',
        draft: true,
        dependencies: ['task-2', 'task-3'],
      },
    }),
  ];
  await new ProjectMemory(
    legacy,
    () => Promise.resolve(tasks),
    () => null,
    ownerResults(legacy),
  ).write();
  const legacyNames = Object.keys(pinned.legacy);
  assert.deepEqual(
    Object.fromEntries(
      (await files(legacy, legacyNames)).map((text, index) => [
        legacyNames[index],
        text,
      ]),
    ),
    pinned.legacy,
  );

  // A lab: one open direction with evidence and a bar, one closed with no evidence.
  const lab = await mkdtemp(join(tmpdir(), 'verifold-memory-'));
  t.after(() => rm(lab, { recursive: true, force: true }));
  await workspace(lab, false);
  const progress: LabProgress = [
    {
      id: 'd-1',
      title: 'Months and weekdays are circles',
      open: true,
      state: 'open',
      agent: 'claude-1 (Claude Code)',
      bar: 'a probe places 60% of months right',
      verdict: 'leading',
      evidence: {
        text: 'A probe places 78% of months right.',
        post: 'p-3',
        run: 'r-1',
      },
    },
    {
      id: 'd-2',
      title: "It's only word frequency",
      open: false,
      state: 'closed by its agent',
      agent: 'codex-1 (Codex)',
      bar: null,
      verdict: 'ruled out',
      evidence: null,
    },
  ];
  await new ProjectMemory(
    lab,
    () => Promise.resolve([]),
    () => progress,
  ).write();
  const labNames = Object.keys(pinned.lab);
  assert.deepEqual(
    Object.fromEntries(
      (await files(lab, labNames)).map((text, index) => [
        labNames[index],
        text,
      ]),
    ),
    pinned.lab,
  );
});
