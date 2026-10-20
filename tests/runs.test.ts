import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  bubblewrap,
  RunLedger,
  runLimits,
  seatbelt,
  type RunRecord,
  type Sandbox,
} from '../src/cli/runs.ts';
import { allocate, snapshot, type Workspace } from '../src/cli/workspaces.ts';

/** No sandbox: the command runs as it is. Tests of the ledger use it on every platform. */
const open: Sandbox = (spec) => ({
  file: '/bin/sh',
  args: ['-c', spec.command],
});

function git(cwd: string, ...args: string[]): string {
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

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly workspace: Workspace;
  /** Commit the direction's folder, as the lab does before a run. */
  commit(): Promise<string>;
  ledger(options?: {
    readonly sandbox?: Sandbox | null;
    readonly minuteMs?: number;
  }): { ledger: RunLedger; ended: RunRecord[] };
  start(
    ledger: RunLedger,
    command: string,
    extra?: { readonly want?: string[]; readonly key?: string },
  ): Promise<RunRecord>;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-runs-')));
  const root = join(base, 'project');
  await mkdir(root);
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'README.md'), '# Project\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'start');
  const workspace = await allocate(root, {
    name: 'd-1-alpha',
    writable: ['.'],
    inputs: [],
    light: true,
  });
  let queue: Promise<unknown> = Promise.resolve();
  let calls = 0;
  const made: Fixture = {
    base,
    root,
    workspace,
    commit: async () =>
      (await snapshot(root, workspace, 'Verifold: test')).commit,
    ledger: (options = {}) => {
      const ended: RunRecord[] = [];
      const ledger = new RunLedger(root, {
        sandbox: options.sandbox === undefined ? open : options.sandbox,
        serial: <T>(work: () => T | Promise<T>): Promise<T> => {
          const next = queue.then(work, work);
          queue = next.catch(() => {});
          return next;
        },
        ended: (run) => {
          ended.push(run);
          return true;
        },
        ...(options.minuteMs ? { minuteMs: options.minuteMs } : {}),
        home: join(base, 'home'),
      });
      return { ledger, ended };
    },
    start: async (ledger, command, extra = {}) =>
      ledger.start({
        agent: 'a-1',
        key: extra.key ?? `call-${++calls}`,
        direction: 'd-1',
        harness: 'claude',
        workspace,
        commit: await made.commit(),
        command,
        why: 'A test.',
        minutes: 5,
        want: extra.want ?? [],
      }),
  };
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  return made;
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('The expected state did not arrive.');
    await delay(20);
  }
}

await test('a run records its commit, exit code, log, metrics, and outputs, and leaves no folder', async (t) => {
  const fx = await fixture(t);
  await writeFile(
    join(fx.root, fx.workspace.path, 'train.sh'),
    [
      'echo "training"',
      'echo "METRIC acc=0.61"',
      'echo "METRIC loss=nan" >&2',
      'echo "METRIC acc=0.62"',
      'printf \'{"f1": 0.5, "note": "x", "bad name": 1}\' > metrics.json',
      'mkdir -p out/sub',
      'echo hi > out/a.txt',
      'echo deep > out/sub/b.txt',
      'echo "$VERIFOLD_RUN $TMPDIR" > out/env.txt',
      'echo "${RUNPOD_API_KEY:-none} ${ANTHROPIC_API_KEY:-none}" >> out/env.txt',
      'echo "$VERIFOLD_COMMIT" >> out/env.txt',
      'git rev-parse --show-toplevel >/dev/null 2>&1 || echo "no repository" >> out/env.txt',
    ].join('\n'),
  );
  // A metrics.json in the commit is not the run's: the run replaces it, or it is gone.
  await writeFile(
    join(fx.root, fx.workspace.path, 'metrics.json'),
    '{"stale": 1}',
  );
  const { ledger, ended } = fx.ledger();
  t.after(() => ledger.close());
  const saved = {
    runpod: process.env.RUNPOD_API_KEY,
    key: process.env.ANTHROPIC_API_KEY,
  };
  process.env.RUNPOD_API_KEY = 'secret-runpod';
  process.env.ANTHROPIC_API_KEY = 'secret-anthropic';
  let started: RunRecord;
  try {
    started = await fx.start(ledger, 'sh train.sh', {
      want: ['out', 'missing.txt'],
    });
  } finally {
    for (const [name, value] of [
      ['RUNPOD_API_KEY', saved.runpod],
      ['ANTHROPIC_API_KEY', saved.key],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
  assert.equal(started.id, 'r-1');
  await until(() => ended.length === 1);
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'done');
  assert.equal(run?.exitCode, 0);
  assert.equal(
    run?.commit,
    git(join(fx.root, fx.workspace.path), 'rev-parse', 'HEAD').trim(),
  );
  assert.ok(run?.startedAt && run.endedAt);
  assert.deepEqual(run?.metrics, {
    acc: 0.62,
    loss: null,
    f1: 0.5,
    note: null,
  });
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out/a.txt', 'out/env.txt', 'out/sub/b.txt'],
  );
  assert.match(run?.output ?? '', /^[0-9a-f]{64}$/);
  assert.match(run?.config ?? '', /^[0-9a-f]{64}$/);
  assert.match(run?.note ?? '', /No output file at missing\.txt\./);
  const record = join(fx.root, '.verifold', 'lab', 'runs', 'r-1');
  assert.equal(
    await readFile(join(record, 'outputs', 'out', 'a.txt'), 'utf8'),
    'hi\n',
  );
  // The run has its own ID and temporary folder, and no RunPod or harness keys.
  const env = await readFile(join(record, 'outputs', 'out', 'env.txt'), 'utf8');
  assert.match(
    env,
    /^r-1 .*run-1\/tmp\nnone none\n[0-9a-f]{40}\nno repository\n$/,
  );
  assert.equal(env.split('\n')[2], run?.commit);
  const log = await readFile(join(record, 'log.txt'), 'utf8');
  // Both streams reach the log. Their lines can interleave in any order.
  assert.match(log, /^training$/m);
  assert.match(log, /^METRIC acc=0\.61$/m);
  assert.match(log, /^METRIC loss=nan$/m);
  assert.equal(
    ((await stat(join(record, 'log.txt'))).mode & 0o777).toString(8),
    '600',
  );
  // The record on disk is the same, and a new ledger reads it.
  const again = fx.ledger().ledger;
  await again.load(true);
  assert.deepEqual(again.get('r-1'), run);
  // Nothing of the run's folder stays.
  assert.equal(
    existsSync(join(fx.root, '.verifold', 'workspaces', 'run-1')),
    false,
  );
  assert.equal(
    existsSync(join(fx.root, '.verifold', 'workspaces', 'run-1.done')),
    false,
  );
  // The agent heard of it once.
  assert.equal(ended.length, 1);
  assert.equal(run?.told, true);
  const tail = await ledger.log('r-1', 'tail', 10);
  assert.deepEqual(tail, {
    text: log.slice(-10),
    bytes: log.length,
    partial: true,
  });
});

await test('an edit after the start does not change the run, and a failing command fails', async (t) => {
  const fx = await fixture(t);
  const file = join(fx.root, fx.workspace.path, 'value.txt');
  await writeFile(file, 'first\n');
  const { ledger, ended } = fx.ledger();
  t.after(() => ledger.close());
  await fx.start(ledger, 'sleep 0.3; cat value.txt; exit 3');
  await writeFile(file, 'second\n');
  await until(() => ended.length === 1);
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'failed');
  assert.equal(run?.exitCode, 3);
  const log = await readFile(
    join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt'),
    'utf8',
  );
  assert.equal(log, 'first\n');
});

await test('a run past its time limit stops with its whole process group', async (t) => {
  const fx = await fixture(t);
  const { ledger, ended } = fx.ledger({ minuteMs: 300 });
  t.after(() => ledger.close());
  await fx.start(ledger, 'sleep 30 & echo "child $!"; wait');
  await until(() => ended.length === 1);
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'timed-out');
  assert.equal(run?.exitCode, null);
  const log = await readFile(
    join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt'),
    'utf8',
  );
  const child = Number(/child (\d+)/.exec(log)?.[1]);
  assert.ok(child > 0);
  assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
});

await test('runs are cancelled, limited, and refused without a sandbox, and a repeated call starts nothing', async (t) => {
  const fx = await fixture(t);
  const { ledger, ended } = fx.ledger();
  t.after(() => ledger.close());
  const first = await fx.start(ledger, 'sleep 30', { key: 'same' });
  assert.equal(first.status, 'running');
  // The same harness call gets the same run.
  assert.equal((await fx.start(ledger, 'sleep 30', { key: 'same' })).id, 'r-1');
  await fx.start(ledger, 'sleep 30');
  await assert.rejects(
    fx.start(ledger, 'sleep 30'),
    /You have 2 runs that run now/,
  );
  ledger.cancel('r-1', 'person');
  await until(() => ended.length === 1);
  assert.equal(ledger.get('r-1')?.status, 'cancelled');
  assert.equal(ledger.get('r-1')?.cancelledBy, 'person');
  assert.throws(() => ledger.cancel('r-1', 'person'), /r-1 already ended/);
  assert.throws(() => ledger.cancel('r-9', 'person'), /No run r-9/);
  // The owner stops: the run that runs ends as interrupted, and no run starts until the next load.
  await ledger.close();
  assert.equal(ledger.get('r-2')?.status, 'interrupted');
  await assert.rejects(fx.start(ledger, 'true'), /stops or moves the lab/);
  await ledger.load(true);
  assert.equal((await fx.start(ledger, 'true')).id, 'r-3');
  const closed = fx.ledger({ sandbox: null }).ledger;
  await assert.rejects(fx.start(closed, 'true'), /no sandbox for runs/);
});

await test('a new owner ends a run that an earlier owner left running, with its process', async (t) => {
  const fx = await fixture(t);
  const earlier = fx.ledger();
  await fx.start(earlier.ledger, 'sleep 30');
  const pid = earlier.ledger.get('r-1')?.process?.pid ?? 0;
  assert.ok(pid > 0);
  // As if the earlier owner stopped without closing its ledger. Its run made a folder without write permission.
  const locked = join(
    fx.root,
    '.verifold',
    'workspaces',
    'run-1',
    'tree',
    'locked',
  );
  await mkdir(locked);
  await writeFile(join(locked, 'f'), 'x');
  await chmod(locked, 0o500);
  const next = fx.ledger();
  await next.ledger.load(true);
  const run = next.ledger.get('r-1');
  assert.equal(run?.status, 'interrupted');
  assert.equal(run?.told, false);
  assert.match(run?.note ?? '', /Verifold stopped while the run ran/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(
    existsSync(join(fx.root, '.verifold', 'workspaces', 'run-1')),
    false,
  );
  await earlier.ledger.close();
  // A process that only shows the lab reads the records and stops nothing.
  const viewer = fx.ledger().ledger;
  await viewer.load(false);
  assert.ok(viewer.get('r-1'));
});

await test('outputs leave out links and files with more than one link, and a long log keeps its start and its end', async (t) => {
  const fx = await fixture(t);
  const outside = join(fx.base, 'outside.txt');
  await writeFile(outside, 'private\n');
  const { ledger, ended } = fx.ledger();
  t.after(() => ledger.close());
  await fx.start(
    ledger,
    [
      'mkdir out',
      'echo ok > out/ok.txt',
      `ln -s ${outside} out/link.txt`,
      'echo two > out/two.txt && ln out/two.txt out/two-again.txt',
      `ln -s ${fx.base} folder-link`,
      `head -c ${runLimits.logBytes + 1000} /dev/zero | tr '\\0' 'a'`,
      'echo',
      'echo END',
    ].join('; '),
    { want: ['out', 'folder-link/outside.txt'] },
  );
  await until(() => ended.length === 1, 30_000);
  const run = ledger.get('r-1');
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out/ok.txt'],
  );
  assert.match(
    run?.note ?? '',
    /No output file at folder-link\/outside\.txt\./,
  );
  assert.equal(run?.log.cut, true);
  const path = join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt');
  const size = (await stat(path)).size;
  assert.ok(size <= runLimits.logBytes + 200, `log of ${size} bytes`);
  const tail = await ledger.log('r-1', 'tail', 100);
  assert.match(tail?.text ?? '', /\nEND\n$/);
  const head = await ledger.log('r-1', 'head', 10);
  assert.equal(head?.text, 'aaaaaaaaaa');
  const middle = await readFile(path, 'utf8');
  assert.match(
    middle,
    /\[Verifold cut \d+ bytes of the log here\. The last \d+ bytes follow\.\]/,
  );
});

await test('bubblewrap hides the credential paths, keeps the run in its folder, and has no network', () => {
  const start = bubblewrap('/usr/bin/bwrap')({
    command: 'make',
    folder: '/p/.verifold/workspaces/run-1',
    cwd: '/p/.verifold/workspaces/run-1/tree',
    denied: [
      { path: '/home/u/.ssh', folder: true },
      { path: '/home/u/.netrc', folder: false },
    ],
  });
  assert.equal(start.file, '/usr/bin/bwrap');
  const args = start.args.join(' ');
  assert.match(args, /--unshare-all/);
  assert.match(args, /--ro-bind \/ \//);
  assert.match(args, /--tmpfs \/home\/u\/\.ssh/);
  assert.match(args, /--ro-bind \/dev\/null \/home\/u\/\.netrc/);
  assert.match(
    args,
    /--bind \/p\/\.verifold\/workspaces\/run-1 \/p\/\.verifold\/workspaces\/run-1 --chdir \/p\/\.verifold\/workspaces\/run-1\/tree \/bin\/sh -c make$/,
  );
  assert.doesNotMatch(args, /--share-net/);
});

await test(
  'the macOS sandbox closes the credential paths, writes outside the run, and the network',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const fx = await fixture(t);
    const home = join(fx.base, 'home');
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, '.ssh', 'id_test'), 'not a key\n');
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(() => server.close());
    const port = (server.address() as { port: number }).port;
    const outside = join(fx.base, 'outside');
    await mkdir(outside);
    const { ledger, ended } = fx.ledger({ sandbox: seatbelt });
    t.after(() => ledger.close());
    await fx.start(
      ledger,
      [
        `cat ${home}/.ssh/id_test && echo READ-SECRET`,
        `ln -s ${home}/.ssh/id_test link && cat link && echo READ-LINK`,
        `ln ${home}/.ssh/id_test hard && echo MADE-HARD-LINK`,
        `echo x > ${outside}/x && echo WROTE-OUTSIDE`,
        `echo x > ${fx.root}/x && echo WROTE-PROJECT`,
        `cat ${fx.root}/README.md`,
        'echo inside > inside.txt && echo WROTE-INSIDE',
        'echo to-stderr > /dev/stderr && echo WROTE-STDERR',
        'echo tmp > "$TMPDIR/t" && echo WROTE-TMP',
        `/usr/bin/nc -z -w 2 127.0.0.1 ${port} && echo REACHED-NETWORK`,
        'launchctl list >/dev/null && echo REACHED-LAUNCHD',
        'echo DONE',
      ].join('; '),
      { want: ['inside.txt'] },
    );
    await until(() => ended.length === 1, 30_000);
    const log = await readFile(
      join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt'),
      'utf8',
    );
    assert.match(log, /# Project/);
    assert.match(log, /WROTE-INSIDE/);
    assert.match(log, /WROTE-TMP/);
    assert.match(log, /WROTE-STDERR/);
    assert.match(log, /DONE/);
    for (const word of [
      'READ-SECRET',
      'READ-LINK',
      'MADE-HARD-LINK',
      'WROTE-OUTSIDE',
      'WROTE-PROJECT',
      'REACHED-NETWORK',
      'REACHED-LAUNCHD',
    ])
      assert.doesNotMatch(log, new RegExp(word));
    assert.doesNotMatch(log, /not a key/);
    assert.equal(existsSync(join(outside, 'x')), false);
    assert.equal(existsSync(join(fx.root, 'x')), false);
    assert.deepEqual(
      ledger.get('r-1')?.outputs.map((output) => output.path),
      ['inside.txt'],
    );
  },
);

await test('a hard link to a file outside the run is no output', async (t) => {
  const fx = await fixture(t);
  const outside = join(fx.base, 'outside.txt');
  await writeFile(outside, 'private\n');
  const { ledger, ended } = fx.ledger();
  t.after(() => ledger.close());
  // Without a sandbox, the link can be made. The ledger still copies nothing through it.
  await fx.start(ledger, `ln ${outside} linked.txt`, { want: ['linked.txt'] });
  await until(() => ended.length === 1);
  assert.deepEqual(ledger.get('r-1')?.outputs, []);
  await assert.rejects(
    readFile(
      join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'outputs', 'linked.txt'),
    ),
  );
  // The outside file keeps its content: removing the run's folder only removed the link.
  assert.equal(await readFile(outside, 'utf8'), 'private\n');
});

await test('one output that cannot be copied leaves the other outputs and the metrics', async (t) => {
  const fx = await fixture(t);
  const { ledger, ended } = fx.ledger();
  t.after(() => ledger.close());
  await fx.start(
    ledger,
    [
      'echo "METRIC acc=0.5"',
      'printf \'{"f1": 0.25}\' > metrics.json',
      'mkdir -p out/locked',
      'echo a > out/a.txt',
      'echo b > out/locked/b.txt',
      'chmod 000 out/locked',
    ].join('; '),
    { want: ['out', 'out/a.txt'] },
  );
  await until(() => ended.length === 1);
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'done');
  assert.deepEqual(run?.metrics, { acc: 0.5, f1: 0.25 });
  // A path named twice is copied once.
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out/a.txt'],
  );
  assert.match(run?.note ?? '', /Verifold could not copy out\/locked\./);
  // The folder without permissions goes too.
  assert.equal(
    existsSync(join(fx.root, '.verifold', 'workspaces', 'run-1.done')),
    false,
  );
});
