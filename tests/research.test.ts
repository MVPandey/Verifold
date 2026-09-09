import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCriteria, registerRun } from '../src/domain/research.ts';
import { exampleIdeas } from '../src/adapters/example-ideas.ts';
const idea = exampleIdeas[0];
if (!idea) throw new Error('Missing fixture');
const criteria = {
  metric: 'loss',
  baseline: 'commit:abc',
  threshold: 1,
  direction: 'lower' as const,
  seeds: [1, 2, 3],
  budgetUsd: 10,
};
await test('locked contract copies caller-owned seeds and cannot be amended', () => {
  const input = { ...criteria, seeds: [1, 2, 3] };
  const run = registerRun(
    idea,
    'R&D',
    input,
    'Manav',
    'run-1',
    '2026-09-08T00:00:00Z',
  );
  input.seeds.push(4);
  assert.deepEqual(run.criteria.seeds, [1, 2, 3]);
  assert.ok(Object.isFrozen(run.criteria));
  assert.ok(Object.isFrozen(run.events[0]));
  assert.equal(run.status, 'awaiting-adapter');
});
await test('reject invalid budgets, duplicate seeds and nonfinite thresholds', () => {
  for (const change of [
    { budgetUsd: -1 },
    { budgetUsd: Infinity },
    { budgetUsd: 1001 },
    { threshold: NaN },
    { seeds: [1, 1, 2] },
    { seeds: [1, 2] },
  ]) {
    assert.throws(() =>
      registerRun(
        idea,
        'Publication',
        { ...criteria, ...change },
        'Manav',
        'run',
        '2026-09-08',
      ),
    );
  }
});
await test('threshold equality passes; missing, repeated or foreign seeds stay inconclusive', () => {
  assert.equal(
    evaluateCriteria(
      criteria,
      [1, 2, 3].map((seed) => ({ seed, value: 1 })),
    ),
    'met',
  );
  assert.equal(
    evaluateCriteria(
      criteria,
      [1, 2, 3].map((seed) => ({ seed, value: 2 })),
    ),
    'not-met',
  );
  for (const seeds of [[1], [1, 1, 3], [1, 2, 4]])
    assert.equal(
      evaluateCriteria(
        criteria,
        seeds.map((seed) => ({ seed, value: 0 })),
      ),
      'inconclusive',
    );
  assert.equal(
    evaluateCriteria(
      criteria,
      [1, 2, 3].map((seed) => ({ seed, value: NaN })),
    ),
    'inconclusive',
  );
  assert.equal(
    evaluateCriteria(
      { ...criteria, direction: 'higher' },
      [1, 2, 3].map((seed) => ({ seed, value: 2 })),
    ),
    'met',
  );
});
