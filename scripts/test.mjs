import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = (await readdir('tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `tests/${name}`);
if (!files.length) throw new Error('No test files found');
// A hung test fails after 3 minutes with its name. On CI, TAP prints each
// failure with its details at once, so a later hang cannot hide them, and the
// whole run stops after 10 minutes instead of at the job limit.
const result = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--test',
    '--test-timeout=180000',
    ...(process.env.CI ? ['--test-reporter=tap'] : []),
    ...files,
  ],
  { stdio: 'inherit', timeout: 600_000, killSignal: 'SIGKILL' },
);
if (result.error && result.signal !== 'SIGKILL') throw result.error;
if (result.signal === 'SIGKILL')
  console.error(
    'The tests did not finish in 10 minutes. A test file kept running; see the last results above.',
  );
process.exitCode = result.status ?? 1;
