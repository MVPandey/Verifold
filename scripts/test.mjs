import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = (await readdir('tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `tests/${name}`);
if (!files.length) throw new Error('No test files found');
const result = spawnSync(
  process.execPath,
  // A test that hangs fails with its name instead of stopping CI at its job limit.
  ['--experimental-strip-types', '--test', '--test-timeout=180000', ...files],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
