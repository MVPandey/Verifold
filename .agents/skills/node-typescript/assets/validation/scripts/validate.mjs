import { spawn } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('Run this gate with npm run validate.');
  process.exitCode = 1;
} else {
  const checks = ['format:check', 'lint', 'typecheck', 'test'];
  const results = await Promise.all(
    checks.map(
      (check) =>
        new Promise((resolve) => {
          // npm supplies its CLI path; avoid shell interpolation and extra runner dependencies.
          const child = spawn(process.execPath, [npmCli, 'run', check], {
            stdio: 'inherit',
            cwd: new URL('../', import.meta.url),
          });
          child.once('error', (error) => {
            console.error(`${check}: ${error.message}`);
            resolve({ check, passed: false });
          });
          child.once('close', (code, signal) => {
            resolve({ check, passed: code === 0 && signal === null });
          });
        }),
    ),
  );
  for (const { check, passed } of results) {
    console.log(`${passed ? 'PASS' : 'FAIL'}: ${check}`);
  }
  process.exitCode = results.every(({ passed }) => passed) ? 0 : 1;
}
