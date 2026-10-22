import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  link,
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
  diffIn,
  gitEnvironment,
  inScope,
  integrate,
  leftOut,
  overlaps,
  parseWorkspace,
  projectPath,
  readCurrent,
  readFileAt,
  release,
  scratch,
  snapshot,
} from '../src/core/workspaces.ts';

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

/** A program that a repository's settings name. It writes `ran.txt` next to itself when it runs. */
async function settingsTool(
  t: test.TestContext,
): Promise<{ readonly tool: string; readonly marker: string }> {
  const tools = await folder(t);
  const marker = join(tools, 'ran.txt');
  const tool = join(tools, 'tool.sh');
  await writeFile(
    tool,
    `#!/bin/sh\necho "$0 $*" >> "${marker}"\necho converted\n`,
  );
  await chmod(tool, 0o755);
  return { tool, marker };
}

await test("Verifold's own diffs never run text-conversion or external diff programs, and a file monitor never runs", async (t) => {
  const { tool, marker } = await settingsTool(t);
  const settings = (dir: string): void => {
    run(dir, 'config', 'diff.x.textconv', tool);
    run(dir, 'config', 'diff.external', tool);
    run(dir, 'config', 'core.fsmonitor', tool);
  };
  const raw = (text: string): void => {
    assert.match(text, /^-one$/m);
    assert.match(text, /^\+two$/m);
    assert.doesNotMatch(text, /converted/);
  };

  // A Git project: the direction and task diffs read its worktrees, and History reads the project repository.
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, '.gitattributes', '*.txt diff=x\n');
  await write(root, 'results/a.txt', 'one\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  // After the fixture's own commits: from here on, only Verifold runs Git.
  settings(root);
  const workspace = await allocate(root, {
    name: 'task-7-r1-a1',
    writable: ['results'],
    inputs: [],
  });
  await write(join(root, workspace.path), 'results/a.txt', 'two\n');
  const version = await commitVersion(root, workspace, ['results'], 'V1');
  await write(join(root, workspace.path), 'results/b.txt', 'b\n');
  await snapshot(root, workspace, 'S1');
  assert.deepEqual(
    (await changes(root, workspace, workspace.start, version.commit)).map(
      (file) => file.path,
    ),
    ['results/a.txt'],
  );
  raw(
    (
      await diff(
        root,
        workspace,
        workspace.start,
        version.commit,
        'results/a.txt',
      )
    ).text,
  );
  raw(
    (await diffIn(root, null, workspace.start, version.commit, 'results/a.txt'))
      .text,
  );

  // A folder project: History reads a task folder's own Git directory.
  const plain = await folder(t);
  await write(plain, 'out/a.txt', 'one\n');
  const task = await allocate(plain, {
    name: 'task-8-r1-a1',
    writable: ['out'],
    inputs: [],
  });
  assert.equal(task.kind, 'folder');
  const gitDir = join(plain, '.verifold/tasks/git/task-8-r1-a1');
  run(plain, '--git-dir', gitDir, 'config', 'diff.x.textconv', tool);
  run(plain, '--git-dir', gitDir, 'config', 'diff.external', tool);
  run(plain, '--git-dir', gitDir, 'config', 'core.fsmonitor', tool);
  await write(join(plain, task.path), '.gitattributes', '*.txt diff=x\n');
  await write(join(plain, task.path), 'out/a.txt', 'two\n');
  const saved = await commitVersion(plain, task, ['out'], 'V1');
  raw(
    (await diffIn(plain, gitDir, task.start, saved.commit, 'out/a.txt')).text,
  );

  assert.equal(existsSync(marker), false);
});

await test("a submodule's diff shows its commits and runs no program from the submodule's settings", async (t) => {
  const { tool, marker } = await settingsTool(t);
  const sub = await folder(t);
  run(sub, 'init', '-q');
  await write(sub, '.gitattributes', '*.txt diff=x\n');
  await write(sub, 'a.txt', 'one\n');
  run(sub, 'add', '.');
  run(sub, 'commit', '-qm', 'one');
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, 'README.md', 'project\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  run(
    root,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    sub,
    'sub',
  );
  run(root, 'commit', '-qm', 'add the submodule');
  const from = run(root, 'rev-parse', 'HEAD').trim();
  await write(join(root, 'sub'), 'a.txt', 'two\n');
  run(join(root, 'sub'), 'commit', '-qam', 'two');
  run(root, 'add', 'sub');
  run(root, 'commit', '-qm', 'move the submodule');
  const to = run(root, 'rev-parse', 'HEAD').trim();
  // A person's own settings can ask for a submodule's full diff, which Git runs as a child `git diff` inside it.
  run(root, 'config', 'diff.submodule', 'diff');
  const own = join(root, '.git/modules/sub');
  run(root, '--git-dir', own, 'config', 'diff.x.textconv', tool);
  run(root, '--git-dir', own, 'config', 'diff.external', tool);

  const shown = (await diffIn(root, null, from, to, 'sub')).text;
  assert.match(shown, /^-Subproject commit [0-9a-f]{40}$/m);
  assert.match(shown, /^\+Subproject commit [0-9a-f]{40}$/m);
  assert.equal(existsSync(marker), false);
});

await test('Git gets no Git variables, in any case of letters', (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.Git_External_Diff = '/elsewhere/tool';
  process.env.git_dir = '/elsewhere/.git';
  const env = gitEnvironment();
  // The inherited Git variables are gone. Only the two that Verifold sets stay.
  assert.deepEqual(
    Object.keys(env)
      .filter((key) => key.toUpperCase().startsWith('GIT_'))
      .sort(),
    ['GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT'],
  );
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

await test('workspace commands use the repository Verifold set up, not one a .git link names', async (t) => {
  const other = await folder(t);
  run(other, 'init', '-q');
  await write(other, 'a.txt', 'a\n');
  run(other, 'add', '.');
  run(other, 'commit', '-qm', 'other');
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, 'results/a.md', 'a\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  const workspace = await allocate(root, {
    name: 'task-6-r1-a1',
    writable: ['results'],
    inputs: [],
  });
  const target = join(root, workspace.path);
  // The folder's own .git link now names the other repository.
  await writeFile(join(target, '.git'), `gitdir: ${join(other, '.git')}\n`);
  await write(target, 'results/b.md', 'b\n');
  const version = await commitVersion(
    root,
    workspace,
    ['results'],
    'Version 1',
  );
  // The commit, the reads, and the diff all use the repository Verifold made.
  assert.equal(
    run(root, 'log', '-1', '--format=%an', version.commit).trim(),
    'Verifold',
  );
  assert.equal(
    (
      await readFileAt(root, workspace, version.commit, 'results/b.md')
    )?.toString('utf8'),
    'b\n',
  );
  assert.match(
    (
      await diff(
        root,
        workspace,
        workspace.start,
        version.commit,
        'results/b.md',
      )
    ).text,
    /^\+b$/m,
  );
  // The other repository keeps its one commit and gains no branch.
  assert.equal(run(other, 'log', '--format=%s').trim(), 'other');
  assert.equal(run(other, 'branch', '--list', 'verifold/*').trim(), '');
});

await test('workspace commands use the recorded repository and its config', async (t) => {
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, 'results/a.md', 'a\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  const workspace = await allocate(root, {
    name: 'task-7-r1-a1',
    writable: ['results'],
    inputs: [],
  });
  const target = join(root, workspace.path);
  // A second repository has a content filter; the folder's link names it.
  const other = await folder(t);
  run(other, 'init', '-q');
  const marker = join(other, 'ran');
  run(other, 'config', 'filter.mark.clean', `sh -c 'touch ${marker}; cat'`);
  await write(target, '.gitattributes', '* filter=mark\n');
  await writeFile(join(target, '.git'), `gitdir: ${join(other, '.git')}\n`);
  await write(target, 'results/b.md', 'b\n');
  await commitVersion(root, workspace, ['results'], 'Version 1');
  assert.equal(existsSync(marker), false);
});

await test('a folder with its own Git data stays out of the commit, and its config never runs', async (t) => {
  const root = await folder(t);
  await write(root, 'exp/a.py', 'a\n');
  const workspace = await allocate(root, {
    name: 'task-8-r1-a1',
    writable: ['exp'],
    inputs: [],
  });
  const target = join(root, workspace.path);
  // A folder with its own Git data, and a commit, appears inside a writable path.
  const inner = join(target, 'exp', 'inner');
  run(root, 'init', '-q', inner);
  const marker = join(root, 'ran');
  run(inner, 'config', 'filter.mark.clean', `sh -c 'touch ${marker}; cat'`);
  await write(inner, '.gitattributes', '* filter=mark\n');
  await write(inner, 'secret.txt', 's\n');
  run(inner, 'add', '.');
  run(inner, 'commit', '-qm', 'inner');
  // The filter ran for the nested repository's own commit above. Clear its mark, so the test sees only what Verifold does next.
  await rm(marker, { force: true });
  await write(target, 'exp/b.py', 'b\n');
  const version = await commitVersion(root, workspace, ['exp'], 'Version 1');
  // The nested folder is left out of the commit, and nothing of it is recorded as a link.
  assert.ok(version.skipped.includes('exp/inner'));
  const files = await changes(root, workspace, workspace.start, version.commit);
  assert.ok(files.every((file) => !file.path.startsWith('exp/inner')));
  // The nested folder's content filter never ran.
  assert.equal(existsSync(marker), false);
});

await test("a worktree's repository is found again after a restart, and a wrong name is refused", async (t) => {
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, 'results/a.md', 'a\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  const start = run(root, 'rev-parse', 'HEAD').trim();
  // A worktree that Verifold did not make in this run, so nothing of it is held in memory.
  const path = join('.verifold', 'workspaces', 'w2');
  run(
    root,
    'worktree',
    'add',
    '--quiet',
    '-b',
    'verifold/w2',
    join(root, path),
    'HEAD',
  );
  const loaded = { kind: 'git', path, branch: 'verifold/w2', start } as const;
  // A record that names the wrong administrative folder is refused before the folder is read.
  await assert.rejects(
    readFileAt(
      root,
      { ...loaded, admin: 'not-the-one' },
      start,
      'results/a.md',
    ),
    /does not match/,
  );
  // With the right name, the file reads from the worktree's own repository.
  assert.equal(
    (await readFileAt(root, loaded, start, 'results/a.md'))?.toString('utf8'),
    'a\n',
  );
});

await test('a worktree is removed without reading its own Git data again', async (t) => {
  const root = await folder(t);
  run(root, 'init', '-q');
  await write(root, 'results/a.md', 'a\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  const workspace = await allocate(root, {
    name: 'task-9-r1-a1',
    writable: ['results'],
    inputs: [],
  });
  assert.equal(workspace.kind, 'git');
  assert.equal(await release(root, workspace), true);
  assert.equal(existsSync(join(root, workspace.path)), false);
});

await test('a version leaves out environments, caches, and what the task ignores', async (t) => {
  const root = await folder(t);
  await write(root, 'exp/a.py', 'a\n');
  const workspace = await allocate(root, {
    name: 'task-3-r1-a1',
    writable: ['exp'],
    inputs: [],
  });
  const target = join(root, workspace.path);
  await write(target, 'exp/a.py', 'a, by the agent\n');
  // The task's own .gitignore counts. The ignored log and build output stay out.
  await write(target, 'exp/.gitignore', 'build/\n*.log\n');
  await write(target, 'exp/build/out.bin', 'x');
  await write(target, 'exp/run.log', 'log');
  // Environments stay out, also under a name that no rule lists.
  await write(target, 'exp/.venv/pyvenv.cfg', 'home = /usr\n');
  await write(target, 'exp/.venv/lib/site.py', 'x');
  await write(target, 'exp/tools/pyvenv.cfg', 'home = /usr\n');
  await write(target, 'exp/tools/bin/python', 'x');
  await write(target, 'exp/node_modules/m/index.js', 'x');
  await write(target, 'exp/.pytest_cache/v/cache', 'x');
  const version = await commitVersion(root, workspace, ['exp'], 'Version 1');
  assert.deepEqual(
    (await changes(root, workspace, workspace.start, version.commit)).map(
      (file) => file.path,
    ),
    ['exp/.gitignore', 'exp/a.py'],
  );
  assert.equal(leftOut('exp/.venv/lib/site.py'), true);
  assert.equal(leftOut('exp/__pycache__/a.cpython-312.pyc'), true);
  assert.equal(leftOut('exp/venv.py'), false);
});

await test('scratch files are temporary output that Accept leaves out unless someone selects it', () => {
  for (const path of [
    'tests/artifacts/tmp/run-1/model.pt',
    'tmp/out.json',
    'exp/Temp/a.csv',
    'exp/.cache/hub/weights.bin',
    'exp/pytest-of-me/pytest-3/a.txt',
    'exp/notes.md~',
    'exp/upload.TMP',
  ])
    assert.equal(scratch(path), true, path);
  for (const path of [
    'results/tmp.csv',
    'experiments/temperature/a.py',
    'docs/template.md',
    'results/bench.csv',
  ])
    assert.equal(scratch(path), false, path);
});

await test('a rule from outside the writable paths keeps ignored output, up to the file limit', async (t) => {
  const root = await folder(t);
  const workspace = await allocate(root, {
    name: 'task-4-r1-a1',
    writable: ['exp'],
    inputs: [],
  });
  const target = join(root, workspace.path);
  // The top .gitignore is not the task's own, so its ignored output is kept.
  await write(target, '.gitignore', 'exp/data/\n');
  await write(target, 'exp/data/0.csv', '0\n');
  const version = await commitVersion(root, workspace, ['exp'], 'Version 1');
  assert.deepEqual(
    (await changes(root, workspace, workspace.start, version.commit)).map(
      (file) => file.path,
    ),
    ['.gitignore', 'exp/data/0.csv'],
  );
  // An ignored folder is one entry in Git's status. Its files still count.
  await Promise.all(
    Array.from({ length: 5001 }, (_, index) =>
      writeFile(join(target, `exp/data/${index + 1}.csv`), 'x'),
    ),
  );
  await assert.rejects(
    commitVersion(root, workspace, ['exp'], 'Version 2'),
    /more than 5000 files, so Verifold saved no version/,
  );
});

await test('a lab folder reads through Git: a link to a file outside, or a path through a linked folder, never reads that file', async (t) => {
  const root = await folder(t);
  const outside = await folder(t);
  await write(outside, 'secret.txt', 'SECRET\n');
  await write(root, 'notes.md', 'notes\n');
  const workspace = await allocate(root, {
    name: 'd-1-alpha',
    writable: ['.'],
    inputs: [],
    light: true,
  });
  const target = join(root, workspace.path);
  // An ignored file reads as it is now.
  await write(target, '.gitignore', 'out/\n');
  await write(target, 'out/table.csv', 'x,y\n');
  assert.equal(
    (await readCurrent(root, workspace, 'out/table.csv'))?.toString('utf8'),
    'x,y\n',
  );
  await symlink(join(outside, 'secret.txt'), join(target, 'link.txt'));
  await symlink(outside, join(target, 'linked'));
  assert.equal(await readCurrent(root, workspace, 'link.txt'), null);
  assert.equal(await readCurrent(root, workspace, 'linked/secret.txt'), null);
  // A commit keeps a link as a link, and a read at the commit does not follow it.
  const { commit } = await snapshot(root, workspace, 'Snapshot', ['link.txt']);
  assert.equal(await readFileAt(root, workspace, commit, 'link.txt'), null);
  assert.equal(
    await readFileAt(root, workspace, commit, 'linked/secret.txt'),
    null,
  );
  assert.equal(
    (await readFileAt(root, workspace, commit, 'notes.md'))?.toString('utf8'),
    'notes\n',
  );
  // A file over a bound reads as nothing, and one within it reads as it is.
  assert.equal(await readFileAt(root, workspace, commit, 'notes.md', 5), null);
  assert.equal(
    (await readFileAt(root, workspace, commit, 'notes.md', 6))?.toString(
      'utf8',
    ),
    'notes\n',
  );
});

await test('a lab folder leaves a file with a second hard link out of its commits and reads, and its message speaks of the folder', async (t) => {
  const root = await folder(t);
  const outside = await folder(t);
  await write(outside, 'secret.txt', 'SECRET\n');
  const workspace = await allocate(root, {
    name: 'd-1-alpha',
    writable: ['.'],
    inputs: [],
    light: true,
  });
  const target = join(root, workspace.path);
  await write(target, 'kept.txt', 'kept\n');
  // A hard link is a regular file to Git. Verifold leaves it out, named or not.
  await link(join(outside, 'secret.txt'), join(target, 'copy.txt'));
  await mkdir(join(target, 'nested'));
  await link(join(outside, 'secret.txt'), join(target, 'nested', 'deep.txt'));
  await assert.rejects(
    readCurrent(root, workspace, 'copy.txt'),
    /more than one hard link/,
  );
  const made = await snapshot(root, workspace, 'Snapshot', ['copy.txt']);
  assert.deepEqual([...made.linked].sort(), ['copy.txt', 'nested/deep.txt']);
  assert.equal(
    await readFileAt(root, workspace, made.commit, 'copy.txt'),
    null,
  );
  assert.equal(
    await readFileAt(root, workspace, made.commit, 'nested/deep.txt'),
    null,
  );
  assert.equal(
    (await readFileAt(root, workspace, made.commit, 'kept.txt'))?.toString(
      'utf8',
    ),
    'kept\n',
  );
  // Too many files: the message speaks of the direction's folder, not of a task.
  await mkdir(join(target, 'many'));
  await Promise.all(
    Array.from({ length: 5001 }, (_, index) =>
      writeFile(join(target, `many/${index}.csv`), 'x'),
    ),
  );
  await assert.rejects(
    snapshot(root, workspace, 'Snapshot'),
    /Your direction's folder changed more than 5000 files/,
  );
});

await test('a light lab folder copies up to the file limit and leaves the rest in the project', async (t) => {
  const root = await folder(t);
  await Promise.all(
    Array.from({ length: 5005 }, (_, index) =>
      write(root, `data/${String(index).padStart(5, '0')}.csv`, 'x'),
    ),
  );
  const workspace = await allocate(root, {
    name: 'd-1-alpha',
    writable: ['.'],
    inputs: [],
    light: true,
  });
  const target = join(root, workspace.path);
  assert.ok(existsSync(join(target, 'data/00000.csv')));
  assert.equal(existsSync(join(target, 'data/05004.csv')), false);
  // A task folder still refuses so many files.
  await assert.rejects(
    allocate(root, { name: 'task-1-r1-a1', writable: ['.'], inputs: [] }),
    /more than 5000 files/,
  );
});

await test('a workspace record takes a SHA-1 or a SHA-256 commit', () => {
  const record = (start: string): unknown => ({
    kind: 'git',
    path: '.verifold/workspaces/d-1-alpha',
    branch: 'verifold/d-1-alpha',
    start,
  });
  assert.ok(parseWorkspace(record('a'.repeat(40))));
  assert.ok(parseWorkspace(record('b'.repeat(64))));
  assert.equal(parseWorkspace(record('c'.repeat(50))), undefined);
  assert.equal(
    parseWorkspace({ ...(record('a'.repeat(40)) as object), path: '../x' }),
    undefined,
  );
});
