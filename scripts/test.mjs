import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const names = (await readdir('tests')).filter((name) =>
  /\.test\.tsx?$/.test(name),
);
if (!names.length) throw new Error('No test files found');

// No test depends on the person's own Claude Code model.
const env = { ...process.env };
delete env.ANTHROPIC_MODEL;

/**
 * Run test files in one `node --test`. A hung test fails after 3 minutes
 * with its name. On CI, TAP prints each failure with its details at once, so
 * a later hang cannot hide them, and a run stops after 10 minutes instead of
 * at the job limit.
 */
function run(files, flags) {
  if (!files.length) return 0;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      ...flags,
      '--test',
      '--test-timeout=180000',
      ...(process.env.CI ? ['--test-reporter=tap'] : []),
      ...files.map((name) => `tests/${name}`),
    ],
    { env, stdio: 'inherit', timeout: 600_000, killSignal: 'SIGKILL' },
  );
  if (result.error && result.signal !== 'SIGKILL') throw result.error;
  if (result.signal === 'SIGKILL')
    console.error(
      'The tests did not finish in 10 minutes. A test file kept running; see the last results above.',
    );
  return result.status ?? 1;
}

// The app's .tsx tests need the loader that compiles JSX (scripts/tsx-hooks.mjs).
// Only they get it: its hooks would slow every module load in the other tests.
const status = [
  run(
    names.filter((name) => name.endsWith('.ts')),
    [],
  ),
  run(
    names.filter((name) => name.endsWith('.tsx')),
    ['--import', './scripts/tsx-register.mjs'],
  ),
];
process.exitCode = status.find((code) => code !== 0) ?? 0;
