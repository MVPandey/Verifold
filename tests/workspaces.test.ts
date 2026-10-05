import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocate,
  changes,
  commitVersion,
  diff,
  inScope,
  integrate,
  overlaps,
  projectPath,
  release,
} from '../src/cli/workspaces.ts';

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Inside a Git hook, GIT_* variables point at the Verifold repository. They must not leak into fixtures.
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      ),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

async function write(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
}

async function folder(t: test.TestContext): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-workspace-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

await test('paths stay inside the project and scopes compare by folder', () => {
  assert.equal(projectPath('./results//run/'), 'results/run');
  assert.equal(projectPath('.'), '.');
  for (const bad of [
    '../x',
    '/etc/hosts',
    '.git/config',
    '.verifold',
    'a/*.md',
    '',
  ])
    assert.throws(() => projectPath(bad), /inside the project|Git or Verifold/);
  assert.ok(inScope('results/a.md', ['results']));
  assert.ok(!inScope('results-old/a.md', ['results']));
  assert.ok(inScope('src/a.ts', ['.']));
  assert.ok(overlaps(['results/run'], ['results']));
  assert.ok(!overlaps(['results'], ['src']));
});

await test('a Git workspace starts from uncommitted work, versions every output, and accepts only unchanged targets', async (t) => {
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, '.gitignore', '*.log\n/.verifold/\n');
  await write(root, 'README.md', 'project\n');
  await write(root, 'results/old.md', 'old\n');
  await write(root, 'src/a.txt', 'a\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  // Uncommitted work in the writable folder, and elsewhere.
  await write(root, 'results/old.md', 'old, edited by the person\n');
  await write(root, 'results/new.md', 'new and untracked\n');
  await write(root, 'src/a.txt', 'a, unrelated change\n');
  const input = join(root, 'input-copy.txt');
  await writeFile(input, 'recorded input\n');

  const workspace = await allocate(root, {
    name: 'task-1-r1-a1',
    writable: ['results'],
    inputs: [{ path: 'notes/input.txt', copy: input }],
  });
  assert.equal(workspace.kind, 'git');
  assert.equal(workspace.branch, 'verifold/task-1-r1-a1');
  const target = join(root, workspace.path);
  assert.equal(
    await readFile(join(target, 'results/old.md'), 'utf8'),
    'old, edited by the person\n',
  );
  assert.equal(
    await readFile(join(target, 'results/new.md'), 'utf8'),
    'new and untracked\n',
  );
  assert.equal(
    await readFile(join(target, 'notes/input.txt'), 'utf8'),
    'recorded input\n',
  );
  // Outside the writable paths, the worktree has the last commit.
  assert.equal(await readFile(join(target, 'src/a.txt'), 'utf8'), 'a\n');
  // The person's working folder is untouched.
  assert.match(run(root, 'status', '--porcelain'), / M results\/old.md/);
  assert.match(
    run(root, 'branch', '--list', 'verifold/*'),
    /verifold\/task-1-r1-a1/,
  );

  // The agent's work: an edit, a new file, an ignored log in scope, a file out of scope, and a link.
  await write(target, 'results/old.md', 'old, edited by the agent\n');
  await write(target, 'results/out.md', '# Output\n\n1.82 ms\n');
  await write(target, 'results/run.log', 'log\n');
  await write(target, 'src/outside.txt', 'not allowed\n');
  await symlink('/etc/hosts', join(target, 'results/link'));
  const version = await commitVersion(
    root,
    workspace,
    ['results'],
    'Version 1',
  );
  assert.deepEqual(version.skipped, []);
  const files = await changes(root, workspace, workspace.start, version.commit);
  assert.deepEqual(
    files.map((file) => [file.path, file.change, file.regular]).sort(),
    [
      ['results/link', 'added', false],
      ['results/old.md', 'modified', true],
      ['results/out.md', 'added', true],
      ['results/run.log', 'added', true],
      ['src/outside.txt', 'added', true],
    ],
  );
  const shown = await diff(
    root,
    workspace,
    workspace.start,
    version.commit,
    'results/out.md',
  );
  assert.match(shown.text, /^\+1\.82 ms$/m);
  assert.equal(shown.cut, false);

  // A target that changed after the start blocks the whole accept.
  await write(root, 'results/old.md', 'changed again by the person\n');
  assert.deepEqual(
    await integrate(root, workspace, version.commit, [
      'results/out.md',
      'results/old.md',
    ]),
    { conflicts: ['results/old.md'] },
  );
  assert.equal(existsSync(join(root, 'results/out.md')), false);
  await write(root, 'results/old.md', 'old, edited by the person\n');
  assert.deepEqual(
    await integrate(root, workspace, version.commit, [
      'results/out.md',
      'results/old.md',
    ]),
    { applied: ['results/out.md', 'results/old.md'] },
  );
  assert.equal(
    await readFile(join(root, 'results/old.md'), 'utf8'),
    'old, edited by the agent\n',
  );
  assert.equal(
    await readFile(join(root, 'src/a.txt'), 'utf8'),
    'a, unrelated change\n',
  );
  assert.equal(existsSync(join(root, 'src/outside.txt')), false);

  // Release removes the clean worktree. The branch keeps the versions.
  await write(target, 'results/late.md', 'not in a version\n');
  assert.equal(await release(root, workspace), false);
  await rm(join(target, 'results/late.md'));
  assert.equal(await release(root, workspace), true);
  assert.equal(existsSync(target), false);
  assert.match(
    run(root, 'log', '--format=%s', workspace.branch ?? ''),
    /Version 1/,
  );
});

await test('a folder workspace uses its own Git data, and deletions apply', async (t) => {
  const root = await folder(t);
  await write(root, 'out/a.txt', 'a\n');
  await write(root, 'out/b.txt', 'b\n');
  const workspace = await allocate(root, {
    name: 'task-2-r1-a1',
    writable: ['out'],
    inputs: [],
  });
  assert.equal(workspace.kind, 'folder');
  assert.equal(workspace.branch, null);
  const target = join(root, workspace.path);
  assert.equal(await readFile(join(target, 'out/a.txt'), 'utf8'), 'a\n');
  assert.ok(existsSync(join(root, '.verifold/tasks/git/task-2-r1-a1')));
  await write(target, 'out/a.txt', 'a, by the agent\n');
  await rm(join(target, 'out/b.txt'));
  // Caches that tools write stay out of the version, even inside writable paths.
  await write(target, 'out/__pycache__/m.cpython-312.pyc', 'cache');
  await write(target, 'out/.DS_Store', 'cache');
  await write(target, 'lib/__pycache__/x.cpython-312.pyc', 'cache');
  const version = await commitVersion(root, workspace, ['out'], 'Version 1');
  assert.deepEqual(
    (await changes(root, workspace, workspace.start, version.commit)).map(
      (file) => [file.path, file.change],
    ),
    [
      ['out/a.txt', 'modified'],
      ['out/b.txt', 'deleted'],
    ],
  );
  assert.deepEqual(
    await integrate(root, workspace, version.commit, [
      'out/a.txt',
      'out/b.txt',
    ]),
    { applied: ['out/a.txt', 'out/b.txt'] },
  );
  assert.equal(
    await readFile(join(root, 'out/a.txt'), 'utf8'),
    'a, by the agent\n',
  );
  assert.equal(existsSync(join(root, 'out/b.txt')), false);
  assert.equal(await release(root, workspace), true);
  assert.equal(existsSync(target), false);
});

await test('writable paths cannot lead outside the project, and names cannot repeat', async (t) => {
  const root = await folder(t);
  const outside = await folder(t);
  await symlink(outside, join(root, 'linked'));
  await assert.rejects(
    allocate(root, { name: 'task-3-r1-a1', writable: ['linked'], inputs: [] }),
    /leads outside the project/,
  );
  await allocate(root, { name: 'task-4-r1-a1', writable: ['out'], inputs: [] });
  await assert.rejects(
    allocate(root, { name: 'task-4-r1-a1', writable: ['out'], inputs: [] }),
    /already exists/,
  );
  await assert.rejects(
    allocate(root, { name: '../escape', writable: ['out'], inputs: [] }),
    /Invalid workspace name/,
  );
});

await test('Git gets no RunPod variables', async (t) => {
  const root = await folder(t);
  const log = join(await folder(t), 'seen.txt');
  run(root, 'init', '-q');
  // A clean filter runs inside each `git add` with Git's environment, so it shows what Git received.
  run(
    root,
    'config',
    'filter.probe.clean',
    `sh -c 'echo "key=\${RUNPOD_API_KEY:-none}" >> "${log}"; cat'`,
  );
  await write(root, '.gitattributes', '*.md filter=probe\n');
  await write(root, 'results/a.md', 'a\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  const saved = process.env.RUNPOD_API_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = saved;
  });
  process.env.RUNPOD_API_KEY = 'test-runpod-key';
  await writeFile(log, '');
  const workspace = await allocate(root, {
    name: 'task-6-r1-a1',
    writable: ['results'],
    inputs: [],
  });
  await write(join(root, workspace.path), 'results/b.md', 'b\n');
  await commitVersion(root, workspace, ['results'], 'Version 1');
  const seen = await readFile(log, 'utf8');
  assert.match(seen, /key=none/);
  assert.doesNotMatch(seen, /test-runpod-key/);
});

await test('Git variables from the environment cannot redirect a workspace to another repository', async (t) => {
  const decoy = await folder(t);
  run(decoy, 'init', '-q');
  await write(decoy, 'a.txt', 'a\n');
  run(decoy, 'add', '.');
  run(decoy, 'commit', '-qm', 'decoy');
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, 'results/a.md', 'a\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  // A Git hook sets variables like these for its own repository.
  const saved = { ...process.env };
  t.after(() => {
    for (const key of [
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_WORK_TREE',
      'GIT_AUTHOR_NAME',
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  process.env.GIT_DIR = join(decoy, '.git');
  process.env.GIT_INDEX_FILE = join(decoy, '.git', 'index');
  process.env.GIT_WORK_TREE = decoy;
  process.env.GIT_AUTHOR_NAME = 'Hook author';
  const workspace = await allocate(root, {
    name: 'task-5-r1-a1',
    writable: ['results'],
    inputs: [],
  });
  await write(join(root, workspace.path), 'results/b.md', 'b\n');
  const version = await commitVersion(
    root,
    workspace,
    ['results'],
    'Version 1',
  );
  for (const key of [
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_WORK_TREE',
    'GIT_AUTHOR_NAME',
  ])
    delete process.env[key];
  assert.equal(workspace.kind, 'git');
  assert.equal(run(decoy, 'branch', '--list', 'verifold/*').trim(), '');
  assert.equal(run(decoy, 'config', '--get', 'core.bare').trim(), 'false');
  assert.equal(run(decoy, 'log', '--format=%s').trim(), 'decoy');
  assert.match(run(root, 'branch', '--list', 'verifold/*'), /task-5-r1-a1/);
  assert.equal(
    run(root, 'log', '-1', '--format=%an', version.commit).trim(),
    'Verifold',
  );
});
