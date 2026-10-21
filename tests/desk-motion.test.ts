import test from 'node:test';
import assert from 'node:assert/strict';
import { changes } from '../src/desk/desk-motion.ts';

await test('motion shows only what changed since the last render', () => {
  const before = new Map([
    ['task-1', 'running'],
    ['task-2', 'open'],
  ]);
  const now = new Map([
    ['task-1', 'done'],
    ['task-2', 'open'],
    ['task-3', 'done'],
  ]);
  // A task that just ended is a change. A task that is new to the map is not.
  assert.deepEqual(changes(before, now), ['task-1']);
  // The first render has nothing to compare, so nothing moves.
  assert.deepEqual(changes(new Map(), now), []);
  assert.deepEqual(changes(now, now), []);
});
