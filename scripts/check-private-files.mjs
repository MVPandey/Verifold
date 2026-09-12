import { execFileSync } from 'node:child_process';

const paths = execFileSync(
  'git',
  ['ls-files', '--cached', '-z', '--full-name'],
  {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  },
).split('\0');
const privatePaths = paths.filter((path) =>
  /^(?:\.local\/agents(?:\/|$)|docs\/(?:research|agent)(?:\/|$)|docs\/(?:product-direction|landscape-cli-plan)\.md$)/.test(
    path,
  ),
);

if (privatePaths.length) {
  console.error(
    'Private research or coordination files are tracked. Move them to .local/agents/ and remove them from the Git index.',
  );
  for (const path of privatePaths) console.error(JSON.stringify(path));
  process.exitCode = 1;
}
