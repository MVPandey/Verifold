import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Compute } from '../src/core/compute.ts';
import { KeyStore } from '../src/core/credentials.ts';
import {
  RunLedger,
  noPodsText,
  runLimits,
  type PodRuns,
  type RunRecord,
} from '../src/core/runs.ts';
import { secretGuard, type SecretGuard } from '../src/core/runpod.ts';
import type { PodRunState } from '../src/core/pod-shell.ts';
import { allocate, snapshot, type Workspace } from '../src/core/workspaces.ts';
import { fakePod, type FakePod } from './fake-pod.ts';
import { labQueue } from './wait.ts';

const secret = 'hf_SECRETVALUE0123456789';

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

interface Fixture extends FakePod {
  readonly workspace: Workspace;
  /**
   * Wait for the work in the lab's queue, such as the saves after a run
   * ends. Its agent hears the end before the last save, so a test waits for
   * this before another ledger reads the records.
   */
  settled(): Promise<void>;
  /** The ledger that the lease's stop asks to end its runs. */
  ledger(minuteMs?: number): { ledger: RunLedger; ended: RunRecord[] };
  /** A ready lease of d-1, whose pod has the secret HF_TOKEN. */
  lease(): Promise<string>;
  start(
    ledger: RunLedger,
    command: string,
    extra?: {
      readonly want?: string[];
      readonly lease?: string;
      readonly minutes?: number;
    },
  ): Promise<RunRecord>;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const owner: { ledger?: RunLedger } = {};
  const fake = await fakePod(t, {
    runsStop: (lease) => owner.ledger?.podStops(lease) ?? Promise.resolve(),
  });
  const root = fake.root;
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'README.md'), '# Project\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '--quiet', '-m', 'start');
  const workspace = await allocate(root, {
    name: 'd-1-alpha',
    writable: ['.'],
    inputs: [],
    light: true,
  });
  await fake.compute.setSecret('HF_TOKEN', secret, true);
  const queue = labQueue();
  let calls = 0;
  const made: Fixture = {
    ...fake,
    workspace,
    settled: queue.settled,
    ledger: (minuteMs) => {
      const ended: RunRecord[] = [];
      const ledger = new RunLedger(root, {
        sandbox: null,
        pods: fake.compute.podRuns(),
        pollMs: 50,
        ...(minuteMs ? { minuteMs } : {}),
        serial: queue.serial,
        ended: (run) => {
          ended.push(run);
          return true;
        },
      });
      owner.ledger = ledger;
      t.after(() => ledger.close());
      return { ledger, ended };
    },
    lease: async () => {
      const lease = await fake.compute.leases.request({
        by: 'agent',
        gpu: 'NVIDIA RTX A5000',
        hours: 1,
        directions: ['d-1'],
        reason: 'Train on a GPU.',
        secrets: ['HF_TOKEN'],
      });
      await fake.compute.leases.approve(lease.id, 'verifold');
      await fake.compute.leases.poll();
      assert.equal(fake.compute.leases.get(lease.id).state, 'ready');
      return lease.id;
    },
    start: async (ledger, command, extra = {}) =>
      ledger.start({
        agent: 'a-1',
        key: `call-${++calls}`,
        direction: 'd-1',
        harness: 'claude',
        workspace,
        commit: (await snapshot(root, workspace, 'Verifold: test')).commit,
        command,
        why: 'A test.',
        minutes: extra.minutes ?? 5,
        want: extra.want ?? [],
        where: 'pod',
        ...(extra.lease ? { lease: extra.lease } : {}),
      }),
  };
  return made;
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('The expected state did not arrive.');
    await delay(20);
  }
}

/** The process group of a pod run's job, from its job file. The file goes when the run ends, so a test reads it while the job runs. */
async function jobGroup(fx: Fixture, folder: string): Promise<number> {
  return Number(
    await readFile(join(fx.pod, 'verifold', '.runs', `${folder}.pid`), 'utf8'),
  );
}

/** No process of the group is left. */
function gone(group: number): boolean {
  try {
    process.kill(-group, 0);
    return false;
  } catch {
    return true;
  }
}

await test('a pod run copies its commit to the pod, runs there, and brings back its outputs, metrics, and log without secrets', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  await writeFile(
    join(fx.root, fx.workspace.path, 'train.sh'),
    [
      'echo "training"',
      'echo "METRIC acc=0.7"',
      `echo "token=${secret}"`,
      'printf \'{"f1": 0.4}\' > metrics.json',
      'mkdir -p out',
      'echo hi > out/a.txt',
      'echo "$VERIFOLD_RUN $VERIFOLD_COMMIT" > out/env.txt',
      `echo "${secret}" > out/leak.txt`,
      `echo x > "out/${secret}.txt"`,
      'ln -s /etc/hosts out/link',
      // More output than one read of the job's log holds.
      "head -c 70000 /dev/zero | tr '\\0' 'x'",
      'echo',
      'echo "the end"',
    ].join('\n'),
  );
  const { ledger, ended } = fx.ledger();
  const started = await fx.start(ledger, 'sh train.sh', {
    want: ['out', 'missing.txt'],
  });
  assert.deepEqual(started.where, { pod: lease, gpu: 'NVIDIA RTX A5000' });
  await until(() => ended.length === 1);
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'done');
  assert.equal(run?.exitCode, 0);
  assert.deepEqual(run?.metrics, { acc: 0.7, f1: 0.4 });
  // A link and a file with a secret's value stay on the pod.
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out/a.txt', 'out/env.txt'],
  );
  assert.match(
    run?.note ?? '',
    /Verifold kept no copy of out\/leak\.txt, because it holds the value of a pod secret\./,
  );
  assert.match(
    run?.note ?? '',
    /Verifold kept no copy of 1 file whose name holds the value of a pod secret\./,
  );
  assert.match(run?.note ?? '', /No output file at missing\.txt\./);
  assert.doesNotMatch(JSON.stringify(run), /SECRETVALUE/);
  const record = join(fx.root, '.verifold', 'lab', 'runs', 'r-1');
  assert.equal(
    await readFile(join(record, 'outputs', 'out', 'env.txt'), 'utf8'),
    `r-1 ${run?.commit}\n`,
  );
  const log = await readFile(join(record, 'log.txt'), 'utf8');
  assert.match(log, /^training\nMETRIC acc=0\.7\ntoken=\[HF_TOKEN\]\n/);
  assert.match(log, /x{70000}\nthe end\n$/);
  assert.doesNotMatch(log, /SECRETVALUE/);
  assert.equal(run?.log.cut, false);
  // Nothing of the run's copy stays, on the pod or in the project, and its job files go too.
  assert.ok(
    !(await readdir(join(fx.pod, 'verifold'))).includes(run?.folder ?? ''),
  );
  assert.deepEqual(
    readdirSync(join(fx.pod, 'verifold', '.runs')).filter((name) =>
      name.startsWith(`${run?.folder}.`),
    ),
    [],
  );
  assert.deepEqual(
    (await readdir(join(fx.root, '.verifold', 'workspaces'))).filter((name) =>
      name.startsWith('run-'),
    ),
    [],
  );
});

await test('a pod run that is cancelled or past its time stops with its process group', async (t) => {
  const fx = await fixture(t);
  await fx.lease();
  const { ledger, ended } = fx.ledger();
  const first = await fx.start(
    ledger,
    'echo partial > part.txt; sleep 30 & sleep 30',
    { want: ['part.txt'] },
  );
  await until(() => ledger.get('r-1')?.status === 'running');
  const group = await jobGroup(fx, first.folder);
  await delay(300);
  ledger.cancel('r-1', 'person', 'Wrong seed.');
  await until(() => ended.length === 1);
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'cancelled');
  assert.equal(run?.cancelledBy, 'person');
  assert.match(run?.note ?? '', /Cancelled: Wrong seed\./);
  // What the job wrote before the stop comes back.
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['part.txt'],
  );
  assert.ok(gone(group));
  // A run past its time limit stops the same way. Its ledger reads r-1 as it ended.
  await fx.settled();
  const timed = fx.ledger(500);
  await timed.ledger.load(true);
  const second = await fx.start(timed.ledger, 'sleep 30', { minutes: 1 });
  const lateGroup = await jobGroup(fx, second.folder);
  await until(() => timed.ended.length === 1);
  const late = timed.ledger.get('r-2');
  assert.equal(late?.status, 'timed-out');
  assert.ok(gone(lateGroup));
});

await test('ending a lease ends its runs first, and they bring their outputs back', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  const { ledger, ended } = fx.ledger();
  await fx.start(ledger, 'echo partial > part.txt; sleep 30', {
    want: ['part.txt'],
  });
  await until(() => ledger.get('r-1')?.status === 'running');
  await delay(300);
  await fx.compute.leases.end(lease, 'person', 'done');
  assert.equal(ended.length, 1);
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'interrupted');
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['part.txt'],
  );
  assert.equal(fx.compute.leases.get(lease).state, 'ended');
});

await test('a new owner finishes the pod runs that an earlier owner left', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  const pods = fx.compute.podRuns();
  // As if an earlier owner started two runs and then crashed: one ended meanwhile, one still runs.
  const left = async (
    id: string,
    folder: string,
    command: string,
    want: string[],
  ): Promise<void> => {
    const tree = await mkdtemp(join(fx.dir, 'tree-'));
    await writeFile(join(tree, 'README.md'), 'x\n');
    await pods.send(lease, folder, tree);
    await pods.start(lease, folder, command);
    const record = join(fx.root, '.verifold', 'lab', 'runs', id);
    await mkdir(record, { recursive: true });
    const commit = git(fx.root, 'rev-parse', 'HEAD').trim();
    await writeFile(
      join(record, 'run.json'),
      JSON.stringify({
        schemaVersion: 1,
        id,
        agent: 'a-1',
        key: id,
        direction: 'd-1',
        harness: 'claude',
        commit,
        command,
        why: 'A test.',
        status: 'running',
        exitCode: null,
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        endedAt: null,
        minutes: 5,
        want,
        metrics: {},
        outputs: [],
        config: 'x',
        output: null,
        log: { bytes: 0, cut: false },
        process: null,
        cancelledBy: null,
        note: null,
        told: false,
        folder,
        where: { pod: lease, gpu: 'NVIDIA RTX A5000' },
      }),
    );
  };
  await left(
    'r-1',
    'run-1-0000aaaa',
    'echo "METRIC acc=1"; echo done > out.txt',
    ['out.txt'],
  );
  await left('r-2', 'run-2-0000bbbb', 'echo begun > out.txt; sleep 30', [
    'out.txt',
  ]);
  for (let tries = 0; tries < 100; tries++) {
    if ((await pods.state(lease, 'run-1-0000aaaa')).state === 'done') break;
    await delay(50);
  }
  const group = await jobGroup(fx, 'run-2-0000bbbb');
  const { ledger } = fx.ledger();
  await ledger.load(true);
  // The jobs are read in the background, so the start does not wait for the pod.
  assert.equal(ledger.get('r-1')?.status, 'running');
  await ledger.pending;
  const done = ledger.get('r-1');
  assert.equal(done?.status, 'done');
  assert.equal(done?.exitCode, 0);
  assert.deepEqual(done?.metrics, { acc: 1 });
  assert.deepEqual(
    done?.outputs.map((output) => output.path),
    ['out.txt'],
  );
  const stopped = ledger.get('r-2');
  assert.equal(stopped?.status, 'interrupted');
  assert.match(stopped?.note ?? '', /Verifold stopped while the run ran\./);
  assert.deepEqual(
    stopped?.outputs.map((output) => output.path),
    ['out.txt'],
  );
  assert.ok(gone(group));
  // Their agents hear of them as they end.
  assert.equal(done?.told, true);
  assert.equal(stopped?.told, true);
});

await test('a pod run needs a ready lease of its direction', async (t) => {
  const fx = await fixture(t);
  const { ledger } = fx.ledger();
  await assert.rejects(
    fx.start(ledger, 'true'),
    /d-1 has no ready pod\. Ask for one with verifold_request_pod\./,
  );
  const other = await fx.compute.leases.request({
    by: 'agent',
    gpu: 'NVIDIA RTX A5000',
    hours: 1,
    directions: ['d-2'],
    reason: 'Another direction.',
  });
  await assert.rejects(
    fx.start(ledger, 'true', { lease: other.id }),
    /lease-1 is no lease of d-1\./,
  );
  // A lease of directions keeps them in its record.
  const again = new Compute(fx.root, {
    store: new KeyStore({
      home: fx.home,
      platform: 'linux',
      secretTool: join(fx.dir, 'none'),
    }),
  });
  await again.load();
  assert.deepEqual(again.leases.get(other.id).directions, ['d-2']);
  assert.deepEqual(again.leases.get(other.id).tasks, []);
  // A ledger without pods refuses pod runs.
  const local = new RunLedger(fx.root, {
    sandbox: null,
    serial: (work) => Promise.resolve(work()),
    ended: () => true,
  });
  await assert.rejects(fx.start(local, 'true'), new RegExp(noPodsText));
});

/**
 * A ledger whose pod is a local folder: the job has already written
 * `files` there, and the copy back takes them. `fetch` can fail on one
 * path after it copied it, and can close the lease while it copies.
 */
async function fakeRuns(
  t: test.TestContext,
  files: Record<string, string>,
  options: {
    readonly failOn?: string;
    readonly closeDuring?: boolean;
    /** The lease's secrets. By default, HF_TOKEN. */
    readonly secrets?: Readonly<Record<string, string>>;
    /** Changes the guard that the run gets, to watch or act during the copy. */
    readonly wrap?: (guard: SecretGuard) => SecretGuard;
    /** Called after each copy back, with the folder that it went to. */
    readonly fetched?: (folder: string) => void;
    /** The pod's parts that a test changes: the upload, the job's start, its reads, and its stops. */
    readonly send?: () => Promise<void>;
    readonly startJob?: () => Promise<void>;
    readonly state?: () => Promise<PodRunState>;
    readonly stop?: (signal: 'TERM' | 'KILL') => Promise<void>;
    readonly log?: () => Promise<{
      readonly bytes: number;
      readonly head: Buffer;
      readonly tail: Buffer | null;
    }>;
    /** One minute of the ledger, and the run's time limit in minutes. */
    readonly minuteMs?: number;
    readonly minutes?: number;
  } = {},
): Promise<{
  root: string;
  ledger: RunLedger;
  ended: RunRecord[];
  calls: { guard: number; remove: number; stops: string[] };
  start(want: string[]): Promise<RunRecord>;
}> {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-podfake-')),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const pod = join(base, 'pod');
  await mkdir(root);
  await mkdir(pod);
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'README.md'), '# Project\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '--quiet', '-m', 'start');
  const workspace = await allocate(root, {
    name: 'd-1-alpha',
    writable: ['.'],
    inputs: [],
    light: true,
  });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(pod, path, '..'), { recursive: true });
    await writeFile(join(pod, path), text);
  }
  const calls = { guard: 0, remove: 0, stops: [] as string[] };
  let closed = false;
  const runs: PodRuns = {
    pick: () => ({ lease: 'lease-1', gpu: 'NVIDIA A40' }),
    // A closed lease has no secrets left to read.
    guard: () => {
      calls.guard++;
      const guard = secretGuard(
        closed ? {} : (options.secrets ?? { HF_TOKEN: secret }),
      );
      return Promise.resolve(options.wrap ? options.wrap(guard) : guard);
    },
    send: options.send ?? (() => Promise.resolve()),
    start: options.startJob ?? (() => Promise.resolve()),
    state:
      options.state ??
      (() =>
        Promise.resolve({ state: 'done', exit: 0, tail: Buffer.alloc(0) })),
    stop: (_lease, _run, signal) => {
      calls.stops.push(signal);
      return options.stop ? options.stop(signal) : Promise.resolve();
    },
    log:
      options.log ??
      (() => Promise.resolve({ bytes: 0, head: Buffer.alloc(0), tail: null })),
    metrics: () => Promise.resolve(''),
    remove: () => {
      calls.remove++;
      return Promise.resolve();
    },
    fetch: async (_lease, _run, paths, folder) => {
      for (const path of paths) {
        if (!existsSync(join(pod, path))) continue;
        if (options.closeDuring) closed = true;
        await cp(join(pod, path), join(folder, path), { recursive: true });
        if (path === options.failOn) throw new Error('The copy broke off.');
      }
      options.fetched?.(folder);
    },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const ended: RunRecord[] = [];
  const ledger = new RunLedger(root, {
    sandbox: null,
    pods: runs,
    pollMs: 20,
    ...(options.minuteMs ? { minuteMs: options.minuteMs } : {}),
    serial: <T>(work: () => T | Promise<T>): Promise<T> => {
      const next = queue.then(work, work);
      queue = next.catch(() => {});
      return next;
    },
    ended: (run) => {
      ended.push(run);
      return true;
    },
  });
  t.after(() => ledger.close());
  return {
    root,
    ledger,
    ended,
    calls,
    start: async (want) =>
      ledger.start({
        agent: 'a-1',
        key: 'call-1',
        direction: 'd-1',
        harness: 'claude',
        workspace,
        commit: (await snapshot(root, workspace, 'Verifold: test')).commit,
        command: 'true',
        why: 'A test.',
        minutes: options.minutes ?? 5,
        want,
        where: 'pod',
      }),
  };
}

await test('a copy that breaks off keeps no file with a secret, and the files of the run stay on the pod', async (t) => {
  const fx = await fakeRuns(
    t,
    {
      'out/a.txt': 'fine\n',
      'out/leak.txt': `token ${secret}\n`,
      'other/b.txt': 'other\n',
    },
    { failOn: 'out' },
  );
  await fx.start(['out', 'other']);
  await until(() => fx.ended.length === 1);
  const run = fx.ledger.get('r-1');
  // The entry that failed lost nothing of the other entry.
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out/a.txt', 'other/b.txt'],
  );
  assert.match(
    run?.note ?? '',
    /Verifold could not copy out back: The copy broke off\./,
  );
  assert.match(
    run?.note ?? '',
    /Verifold kept no copy of out\/leak\.txt, because it holds the value of a pod secret\./,
  );
  assert.match(
    run?.note ?? '',
    /The run's files stay on the pod in \/root\/verifold\/run-1-[0-9a-f]{8} and \/root\/verifold\/\.runs until its lease ends\./,
  );
  assert.doesNotMatch(run?.note ?? '', /No output file at out\b/);
  assert.equal(fx.calls.remove, 0);
});

await test('a lease that closes during the copy back still keeps the secrets out of the outputs', async (t) => {
  const fx = await fakeRuns(
    t,
    { 'out/leak.txt': `token ${secret}\n`, 'out/a.txt': 'fine\n' },
    { closeDuring: true },
  );
  await fx.start(['out']);
  await until(() => fx.ended.length === 1);
  const run = fx.ledger.get('r-1');
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out/a.txt'],
  );
  // The guard came once, when the run started.
  assert.equal(fx.calls.guard, 1);
  assert.equal(fx.calls.remove, 1);
});

await test('a guard finds a secret value that starts in one part and ends in a later one, and stays sure', () => {
  const guard = secretGuard({ HF_TOKEN: secret });
  const split = guard.stream();
  assert.equal(split.longest, Buffer.byteLength(secret));
  assert.equal(split.holds(Buffer.from(`head ${secret.slice(0, 7)}`)), false);
  assert.equal(split.holds(Buffer.from(`${secret.slice(7)} tail`)), true);
  // Once it found a value, it stays true.
  assert.equal(split.holds(Buffer.from('clean')), true);
  const clean = guard.stream();
  assert.equal(clean.holds(Buffer.from(`head ${secret.slice(0, 7)}`)), false);
  assert.equal(clean.holds(Buffer.from(`not ${secret.slice(7)}`)), false);
  // A value across three small parts.
  const three = guard.stream();
  assert.equal(three.holds(Buffer.from(secret.slice(0, 5))), false);
  assert.equal(three.holds(Buffer.from(secret.slice(5, 12))), false);
  assert.equal(three.holds(Buffer.from(secret.slice(12))), true);
  assert.equal(guard.stream().holds(Buffer.from(`a ${secret} b`)), true);
  const none = secretGuard({}).stream();
  assert.equal(none.longest, 0);
  assert.equal(none.holds(Buffer.from(secret)), false);
});

await test('an output with a secret value across two copy parts keeps no copy, and a long output keeps its hash', async (t) => {
  // The value starts 5 bytes before the end of the first part that Verifold copies.
  const span = `${'y'.repeat(runLimits.copyPart - 5)}${secret}\n`;
  const long = 'x'.repeat(runLimits.copyPart * 2 + 1234);
  const fx = await fakeRuns(t, { 'out/span.txt': span, 'out/long.txt': long });
  await fx.start(['out']);
  await until(() => fx.ended.length === 1);
  const run = fx.ledger.get('r-1');
  assert.deepEqual(run?.outputs, [
    {
      path: 'out/long.txt',
      bytes: long.length,
      sha256: createHash('sha256').update(long).digest('hex'),
    },
  ]);
  assert.match(
    run?.note ?? '',
    /Verifold kept no copy of out\/span\.txt, because it holds the value of a pod secret\./,
  );
  // No part of it stays in the run's record.
  const outputs = join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'outputs');
  assert.equal(existsSync(join(outputs, 'out', 'span.txt')), false);
  assert.equal(
    (await readFile(join(outputs, 'out', 'long.txt'), 'utf8')) === long,
    true,
  );
});

await test('a held copy leaves no temporary file and no empty folder', async (t) => {
  const fx = await fakeRuns(t, {
    'out/sub/leak.txt': `token ${secret}\n`,
    'out/a.txt': 'fine\n',
  });
  await fx.start(['out']);
  await until(() => fx.ended.length === 1);
  const run = fx.ledger.get('r-1');
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out/a.txt'],
  );
  const record = join(fx.root, '.verifold', 'lab', 'runs', 'r-1');
  assert.deepEqual(
    (await readdir(join(record, 'outputs'), { recursive: true })).sort(),
    ['out', join('out', 'a.txt')],
  );
  assert.deepEqual(
    (await readdir(record)).filter((name) => name.endsWith('.part')),
    [],
  );
});

await test('a secret value longer than one copy part never reaches the disk', async (t) => {
  const value = randomBytes(runLimits.copyPart / 2 + 600).toString('hex');
  let root = '';
  let looked = 0;
  const fx = await fakeRuns(
    t,
    { 'out/big.txt': `${'y'.repeat(100)}${value}${'z'.repeat(100)}` },
    {
      secrets: { BIG: value },
      // At each part, what reached the disk so far holds no byte of the value.
      wrap: (guard) => ({
        ...guard,
        stream: () => {
          const scan = guard.stream();
          return {
            longest: scan.longest,
            holds: (part) => {
              const record = join(root, '.verifold', 'lab', 'runs', 'r-1');
              for (const name of readdirSync(record))
                if (name.endsWith('.part')) {
                  looked++;
                  assert.match(
                    readFileSync(join(record, name), 'latin1'),
                    /^y*$/,
                  );
                }
              return scan.holds(part);
            },
          };
        },
      }),
    },
  );
  root = fx.root;
  await fx.start(['out']);
  await until(() => fx.ended.length === 1);
  const run = fx.ledger.get('r-1');
  assert.ok(looked > 0);
  assert.deepEqual(run?.outputs, []);
  assert.match(
    run?.note ?? '',
    /Verifold kept no copy of out\/big\.txt, because it holds the value of a pod secret\./,
  );
  const record = join(fx.root, '.verifold', 'lab', 'runs', 'r-1');
  assert.equal(existsSync(join(record, 'outputs', 'out', 'big.txt')), false);
  assert.deepEqual(
    (await readdir(record)).filter((name) => name.endsWith('.part')),
    [],
  );
});

await test('an output that grows past the limit while Verifold copies it stops the outputs, with a note', async (t) => {
  const limit = runLimits.outputBytes;
  runLimits.outputBytes = 3 * runLimits.copyPart;
  t.after(() => {
    runLimits.outputBytes = limit;
  });
  let grow: number | null = null;
  const fx = await fakeRuns(
    t,
    { 'out/grow.txt': 'g'.repeat(runLimits.copyPart + 10) },
    {
      fetched: (folder) => {
        const path = join(folder, 'out', 'grow.txt');
        if (grow === null && existsSync(path)) grow = openSync(path, 'a');
      },
      // After its checks, during the copy, the file grows past the limit.
      wrap: (guard) => ({
        ...guard,
        stream: () => {
          const scan = guard.stream();
          return {
            longest: scan.longest,
            holds: (part) => {
              if (grow !== null) {
                writeSync(grow, Buffer.alloc(3 * runLimits.copyPart, 'g'));
                closeSync(grow);
                grow = null;
              }
              return scan.holds(part);
            },
          };
        },
      }),
    },
  );
  t.after(() => {
    if (grow !== null) closeSync(grow);
  });
  await fx.start(['out']);
  await until(() => fx.ended.length === 1);
  const run = fx.ledger.get('r-1');
  assert.deepEqual(run?.outputs, []);
  assert.match(
    run?.note ?? '',
    new RegExp(`The outputs stop at ${runLimits.outputFiles} files, 3 MB,`),
  );
  assert.doesNotMatch(run?.note ?? '', /No output file at/);
  const record = join(fx.root, '.verifold', 'lab', 'runs', 'r-1');
  assert.equal(existsSync(join(record, 'outputs', 'out', 'grow.txt')), false);
  assert.deepEqual(
    (await readdir(record)).filter((name) => name.endsWith('.part')),
    [],
  );
});

await test('a secret that a cut splits does not reach the log', async (t) => {
  // The guard's edges: the end of a value at the start, and its start at the end.
  const guard = secretGuard({ HF_TOKEN: secret });
  assert.equal(
    guard.hide(`${secret.slice(9)} rest`, { start: true }),
    '[HF_TOKEN] rest',
  );
  assert.equal(
    guard.hide(`head ${secret.slice(0, 5)}`, { end: true }),
    'head [HF_TOKEN]',
  );
  assert.equal(guard.hide(`a ${secret} b`), 'a [HF_TOKEN] b');
  // On a pod: the window of the job's log that the record keeps while the run runs starts inside the value.
  const fx = await fixture(t);
  await fx.lease();
  const { ledger, ended } = fx.ledger();
  await fx.start(
    ledger,
    `printf '%s' "${secret}"; head -c 65526 /dev/zero | tr '\\0' 'y'; sleep 30`,
  );
  const log = join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt');
  let text = '';
  for (
    let tries = 0;
    tries < 200 && !text.includes('y'.repeat(65526));
    tries++
  ) {
    text = await readFile(log, 'utf8').catch(() => '');
    await delay(50);
  }
  assert.ok(text.startsWith(`[HF_TOKEN]${'y'.repeat(65526)}`));
  assert.ok(!text.includes(secret.slice(-10)));
  ledger.cancel('r-1', 'person');
  await until(() => ended.length === 1);
});

/** The record of a pod run that an earlier owner left, as r-1 in the project. */
async function leftRun(
  root: string,
  run: {
    readonly folder: string;
    readonly lease: string;
    readonly status: 'queued' | 'running';
    readonly want: readonly string[];
  },
): Promise<void> {
  const record = join(root, '.verifold', 'lab', 'runs', 'r-1');
  await mkdir(record, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    join(record, 'run.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'r-1',
      agent: 'a-1',
      key: 'r-1',
      direction: 'd-1',
      harness: 'claude',
      commit: git(root, 'rev-parse', 'HEAD').trim(),
      command: 'sh job.sh',
      why: 'A test.',
      status: run.status,
      exitCode: null,
      queuedAt: now,
      startedAt: run.status === 'running' ? now : null,
      endedAt: null,
      minutes: 5,
      want: run.want,
      metrics: {},
      outputs: [],
      config: 'x',
      output: null,
      log: { bytes: 0, cut: false },
      process: null,
      cancelledBy: null,
      note: null,
      told: false,
      folder: run.folder,
      where: { pod: run.lease, gpu: 'NVIDIA RTX A5000' },
    }),
  );
}

/** A pod that does not answer over SSH. */
function unreachable(): Promise<never> {
  return Promise.reject(
    new Error('ssh: connect to host 10.0.0.1 port 22: timed out'),
  );
}

await test('a pod run whose job cannot be read for 10 minutes gets one stop, and a stop that cannot reach the pod says so', async (t) => {
  for (const answers of [false, true]) {
    const box: { stops?: readonly string[] } = {};
    const fx = await fakeRuns(
      t,
      { 'out/a.txt': 'fine\n' },
      {
        minuteMs: 20,
        minutes: 60,
        // No read works. When `answers`, a stop reaches the pod, and the reads after it show that the job ended.
        state: () =>
          answers && box.stops?.includes('KILL')
            ? Promise.resolve({
                state: 'done' as const,
                exit: 137,
                tail: Buffer.alloc(0),
              })
            : unreachable(),
        stop: () => (answers ? Promise.resolve() : unreachable()),
      },
    );
    box.stops = fx.calls.stops;
    const run = await fx.start(['out']);
    await until(() => fx.ledger.get(run.id)?.status === 'interrupted');
    const ended = fx.ledger.get(run.id);
    assert.match(
      ended?.note ?? '',
      /Verifold could not reach the pod for 10 minutes/,
    );
    // One SIGKILL: the copy back sends no second one.
    assert.deepEqual(fx.calls.stops, ['KILL']);
    if (answers) {
      assert.deepEqual(
        ended?.outputs.map((output) => output.path),
        ['out/a.txt'],
      );
      assert.equal(fx.calls.remove, 1);
      assert.doesNotMatch(ended?.note ?? '', /to stop the job|files stay/);
    } else {
      assert.match(
        ended?.note ?? '',
        /Verifold could not reach the pod to stop the job\. The job can continue to run until the pod stops\./,
      );
      assert.deepEqual(ended?.outputs, []);
      assert.equal(fx.calls.remove, 0);
    }
  }
});

await test('a pod run that stops after the upload, or whose upload or start fails, keeps the pod clean and the log of its start', async (t) => {
  // A cancel during the upload: the job did not start, so the copy goes, with no stop.
  const owner: { ledger?: RunLedger } = {};
  const cancelled = await fakeRuns(
    t,
    {},
    {
      send: () => {
        owner.ledger?.cancel('r-1', 'person');
        return Promise.resolve();
      },
    },
  );
  owner.ledger = cancelled.ledger;
  assert.equal((await cancelled.start([])).status, 'cancelled');
  assert.equal(cancelled.calls.remove, 1);
  assert.deepEqual(cancelled.calls.stops, []);
  // An upload that breaks off leaves a part, which goes too.
  const broken = await fakeRuns(
    t,
    {},
    { send: () => Promise.reject(new Error('The copy to the pod broke off.')) },
  );
  assert.equal((await broken.start([])).status, 'failed');
  assert.equal(broken.calls.remove, 1);
  // A start that fails: one stop, a read that shows the end, the log that says why, and then the files go.
  const failed = await fakeRuns(
    t,
    { 'out/a.txt': 'from the commit\n' },
    {
      startJob: () =>
        Promise.reject(new Error('The pod did not start the run.')),
      log: () =>
        Promise.resolve({
          bytes: 29,
          head: Buffer.from('bash: train.sh: No such file\n'),
          tail: null,
        }),
    },
  );
  const run = await failed.start(['out']);
  assert.equal(run.status, 'failed');
  assert.match(
    run.note ?? '',
    /The run did not start: The pod did not start the run\./,
  );
  assert.deepEqual(failed.calls.stops, ['KILL']);
  // The copy of the commit is no output.
  assert.deepEqual(run.outputs, []);
  assert.equal(
    await readFile(
      join(failed.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt'),
      'utf8',
    ),
    'bash: train.sh: No such file\n',
  );
  assert.equal(failed.calls.remove, 1);
  // A start that fails on a pod that does not answer the stop: the files stay, and the note says that the job can still run.
  const lost = await fakeRuns(
    t,
    {},
    { startJob: unreachable, stop: unreachable },
  );
  const kept = await lost.start([]);
  assert.match(
    kept.note ?? '',
    /The job can continue to run until the pod stops\./,
  );
  assert.equal(lost.calls.remove, 0);
});

await test('a pod run whose log does not come back keeps its files on the pod, and says so', async (t) => {
  const fx = await fakeRuns(
    t,
    { 'out/a.txt': 'fine\n' },
    { log: () => Promise.reject(new Error('ssh: connection reset')) },
  );
  const run = await fx.start(['out']);
  await until(() => fx.ended.length === 1);
  const ended = fx.ledger.get(run.id);
  assert.equal(ended?.status, 'done');
  assert.match(
    ended?.note ?? '',
    /Verifold could not copy the log back: ssh: connection reset/,
  );
  assert.match(
    ended?.note ?? '',
    /The run's files stay on the pod in \/root\/verifold\/run-1-[0-9a-f]{8} and \/root\/verifold\/\.runs until its lease ends\./,
  );
  assert.equal(fx.calls.remove, 0);
  // The outputs came back all the same.
  assert.deepEqual(
    ended?.outputs.map((output) => output.path),
    ['out/a.txt'],
  );
});

await test('a pod run whose job does not end after its stop keeps its files on the pod', async (t) => {
  const grace = runLimits.graceMs;
  runLimits.graceMs = 0;
  t.after(() => {
    runLimits.graceMs = grace;
  });
  const fx = await fakeRuns(
    t,
    { 'out/a.txt': 'fine\n' },
    {
      minuteMs: 100,
      minutes: 60,
      // The job runs on, whatever stop it gets.
      state: () =>
        Promise.resolve({
          state: 'running' as const,
          exit: null,
          tail: Buffer.alloc(0),
        }),
    },
  );
  const run = await fx.start(['out']);
  fx.ledger.cancel(run.id, 'person');
  await until(() => fx.ledger.get(run.id)?.status === 'cancelled');
  const ended = fx.ledger.get(run.id);
  assert.match(
    ended?.note ?? '',
    /The job on the pod did not end after SIGKILL\./,
  );
  assert.match(ended?.note ?? '', /The run's files stay on the pod/);
  assert.ok(fx.calls.stops.includes('KILL'));
  assert.equal(fx.calls.remove, 0);
});

await test('a stop that cannot reach the pod ends the run after a minute, and says that the job can still run', async (t) => {
  const grace = runLimits.graceMs;
  runLimits.graceMs = 0;
  t.after(() => {
    runLimits.graceMs = grace;
  });
  const fx = await fakeRuns(
    t,
    {},
    { minuteMs: 100, minutes: 60, state: unreachable, stop: unreachable },
  );
  const run = await fx.start([]);
  fx.ledger.cancel(run.id, 'person');
  await until(() => fx.ledger.get(run.id)?.status === 'cancelled');
  const ended = fx.ledger.get(run.id);
  assert.match(
    ended?.note ?? '',
    /Verifold could not reach the pod to stop the job\. The job can continue to run until the pod stops\./,
  );
  assert.doesNotMatch(
    ended?.note ?? '',
    /did not end after SIGKILL|for 10 minutes/,
  );
  assert.equal(fx.calls.remove, 0);
});

await test('a new owner takes no outputs from a pod run that did not start, and its copy leaves the pod', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  // As if an earlier owner copied the commit to the pod, then stopped before the job started.
  const folder = 'run-1-0000cccc';
  const tree = await mkdtemp(join(fx.dir, 'tree-'));
  await writeFile(join(tree, 'results.txt'), 'committed\n');
  await fx.compute.podRuns().send(lease, folder, tree);
  await leftRun(fx.root, {
    folder,
    lease,
    status: 'queued',
    want: ['results.txt'],
  });
  const { ledger } = fx.ledger();
  await ledger.load(true);
  await ledger.pending;
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'interrupted');
  // The committed file on the pod is no output of a job that did not run.
  assert.deepEqual(run?.outputs, []);
  assert.match(run?.note ?? '', /Verifold stopped before the run started\./);
  assert.ok(!(await readdir(join(fx.pod, 'verifold'))).includes(folder));
});

await test('a new owner takes no outputs from a queued pod run whose job it cannot read, also when its stop reaches the pod', async (t) => {
  const fx = await fakeRuns(
    t,
    { 'out.txt': 'from the commit\n' },
    { state: () => Promise.reject(new Error('ssh: connection reset')) },
  );
  await leftRun(fx.root, {
    folder: 'run-1-0000dddd',
    lease: 'lease-1',
    status: 'queued',
    want: ['out.txt'],
  });
  await fx.ledger.load(true);
  await fx.ledger.pending;
  const run = fx.ledger.get('r-1');
  assert.equal(run?.status, 'interrupted');
  assert.deepEqual(run?.outputs, []);
  assert.deepEqual(fx.calls.stops, ['KILL']);
  // No read showed the end of the job, so its files stay.
  assert.equal(fx.calls.remove, 0);
});

await test('a new owner takes the outputs and the log of a queued pod run whose job ran, and says that its end is not known', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  // As if an earlier owner started the job and stopped before it saved that, and the pod then started again: the job's files stay, with no exit code.
  const folder = 'run-1-0000eeee';
  const tree = await mkdtemp(join(fx.dir, 'tree-'));
  await writeFile(join(tree, 'README.md'), 'x\n');
  await fx.compute.podRuns().send(lease, folder, tree);
  await writeFile(join(fx.pod, 'verifold', folder, 'out.txt'), 'result\n');
  const runs = join(fx.pod, 'verifold', '.runs');
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, `${folder}.log`), 'epoch 1 done\n');
  // A process number that no process has.
  await writeFile(join(runs, `${folder}.wrap`), '999999\n');
  await leftRun(fx.root, {
    folder,
    lease,
    status: 'queued',
    want: ['out.txt'],
  });
  const { ledger } = fx.ledger();
  await ledger.load(true);
  await ledger.pending;
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'interrupted');
  assert.deepEqual(
    run?.outputs.map((output) => output.path),
    ['out.txt'],
  );
  assert.match(
    run?.note ?? '',
    /The job on the pod ended without an exit code, so how it ended is not known\./,
  );
  assert.equal(
    await readFile(
      join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt'),
      'utf8',
    ),
    'epoch 1 done\n',
  );
  // The job ended, and every copy worked, so its files left the pod.
  assert.ok(!existsSync(join(fx.pod, 'verifold', folder)));
  assert.deepEqual(
    readdirSync(runs).filter((name) => name.startsWith(`${folder}.`)),
    [],
  );
});

await test('a pod log keeps the bytes that the job wrote, and its cut line counts them', async (t) => {
  const bytes = runLimits.logBytes;
  const tail = runLimits.logTail;
  runLimits.logBytes = 3000;
  runLimits.logTail = 1000;
  t.after(() => {
    runLimits.logBytes = bytes;
    runLimits.logTail = tail;
  });
  const fx = await fixture(t);
  await fx.lease();
  const { ledger, ended } = fx.ledger();
  // Bytes that are not UTF-8 at the start and at the end, a secret near the end, and more than the log keeps: 5040 bytes.
  await fx.start(
    ledger,
    `printf 'start\\377\\376\\n'; head -c 5000 /dev/zero | tr '\\0' 'x'; printf '\\nend %s \\375\\n' "${secret}"`,
  );
  await until(() => ended.length === 1);
  assert.equal(ledger.get('r-1')?.status, 'done');
  const log = await readFile(
    join(fx.root, '.verifold', 'lab', 'runs', 'r-1', 'log.txt'),
  );
  assert.ok(
    log.subarray(0, 8).equals(Buffer.from('start\xff\xfe\n', 'latin1')),
  );
  assert.ok(
    log.includes(
      '\n[Verifold cut 2040 bytes of the log here. The end of the log follows.]\n',
    ),
  );
  const last = Buffer.from('\nend [HF_TOKEN] \xfd\n', 'latin1');
  assert.ok(log.subarray(log.length - last.length).equals(last));
  assert.ok(!log.includes(secret));
});

/** A lease of d-1 whose pod is ready. */
async function readyLease(fake: FakePod): Promise<string> {
  const lease = (
    await fake.compute.leases.request({
      by: 'agent',
      gpu: 'NVIDIA RTX A5000',
      hours: 1,
      directions: ['d-1'],
      reason: 'Train on a GPU.',
    })
  ).id;
  await fake.compute.leases.approve(lease, 'verifold');
  await fake.compute.leases.poll();
  assert.equal(fake.compute.leases.get(lease).state, 'ready');
  return lease;
}

/** End a process that a test started, with its group. */
function kill(child: { readonly pid?: number | undefined }): void {
  try {
    process.kill(-(child.pid ?? 0), 'SIGKILL');
  } catch {
    // It ended already.
  }
}

/** The child ended, by a signal or with a code. */
function ended(child: {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

await test('a pod that Verifold stops takes no new run until its state changes, and an answer that does not come back keeps it out until a poll reads the pod', async (t) => {
  const hold = { on: false };
  let copying = (): void => {};
  const copies = new Promise<void>((resolve) => {
    copying = resolve;
  });
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const box: { fake?: FakePod } = {};
  // What holds each lease at the moment Verifold tells of its change.
  const atChange: (string | undefined)[] = [];
  const fake = await fakePod(t, {
    runsStop: async () => {
      if (!hold.on) return;
      copying();
      await held;
    },
    onChange: (lease) =>
      atChange.push(box.fake?.compute.leases.closing()[lease.id]),
  });
  box.fake = fake;
  const lease = await readyLease(fake);
  const pods = fake.compute.podRuns();
  // RunPod refuses the stop: no run starts until a poll reads that the pod still runs.
  process.env.FAKE_ACTION_REFUSES = '1';
  await assert.rejects(
    fake.compute.leases.stop(lease, 'person', 'a test.'),
    /RunPod answered with 500/,
  );
  delete process.env.FAKE_ACTION_REFUSES;
  assert.deepEqual(fake.compute.view().closing, { [lease]: 'stopping' });
  assert.throws(() => pods.pick('d-1'), /The pod of lease-1 stops now/);
  await fake.compute.leases.poll();
  assert.equal(fake.compute.leases.get(lease).state, 'ready');
  assert.deepEqual(fake.compute.view().closing, {});
  assert.deepEqual(pods.pick('d-1'), { lease, gpu: 'NVIDIA RTX A5000' });
  // RunPod stops the pod, but its answer does not come back: no run starts until a poll reads the pod.
  process.env.FAKE_ACTION_FAILS = '1';
  await assert.rejects(
    fake.compute.leases.stop(lease, 'person', 'a test.'),
    /RunPod answered with 500/,
  );
  delete process.env.FAKE_ACTION_FAILS;
  assert.deepEqual(fake.compute.view().closing, { [lease]: 'stopping' });
  assert.throws(
    () => pods.pick('d-1'),
    /The pod of lease-1 stops now, so no run starts on it\./,
  );
  await fake.compute.leases.poll();
  assert.equal(fake.compute.leases.get(lease).state, 'stopped');
  assert.deepEqual(fake.compute.view().closing, {});
  // The hold ended before Verifold told of the new state.
  assert.equal(atChange.at(-1), undefined);
  await fake.compute.leases.start(lease, 'person', 'a test.');
  await fake.compute.leases.poll();
  assert.equal(fake.compute.leases.get(lease).state, 'ready');
  // A second pod waits for the person.
  const second = (
    await fake.compute.leases.request({
      by: 'agent',
      gpu: 'NVIDIA RTX A5000',
      hours: 1,
      directions: ['d-1'],
      reason: 'A second GPU.',
    })
  ).id;
  // While the stop runs, the lease still reads as ready, but no run starts on it.
  hold.on = true;
  const stop = fake.compute.leases.stop(lease, 'person', 'a test.');
  await copies;
  assert.equal(fake.compute.leases.get(lease).state, 'ready');
  assert.deepEqual(fake.compute.view().closing, { [lease]: 'stopping' });
  // A named lease gets the reason of its own state.
  assert.throws(() => pods.pick('d-1', lease), /The pod of lease-1 stops now/);
  assert.throws(
    () => pods.pick('d-1', second),
    /The pod of lease-2 is not ready yet\. Verifold wakes you when it is\./,
  );
  // With no lease named, the agent hears of the pod that it waits for.
  assert.throws(
    () => pods.pick('d-1'),
    /The pod of d-1 is not ready yet\. Verifold wakes you when it is\./,
  );
  release();
  await stop;
  assert.equal(fake.compute.leases.get(lease).state, 'stopped');
  assert.deepEqual(fake.compute.view().closing, {});
  assert.equal(atChange.at(-1), undefined);
});

await test('ending a stopped lease shows as ending, and a poll ends it when the answer of RunPod does not come back', async (t) => {
  const fake = await fakePod(t);
  const lease = await readyLease(fake);
  await fake.compute.leases.stop(lease, 'person', 'a test.');
  process.env.FAKE_ACTION_FAILS = '1';
  await assert.rejects(fake.compute.leases.end(lease, 'person', 'a test.'));
  delete process.env.FAKE_ACTION_FAILS;
  assert.deepEqual(fake.compute.view().closing, { [lease]: 'ending' });
  await fake.compute.leases.poll();
  assert.equal(fake.compute.leases.get(lease).state, 'ended');
  assert.deepEqual(fake.compute.view().closing, {});
});

await test('after a start, no run starts on an open lease until recovery reads its pod, and recovery stops a pod that ran as a stop does', async (t) => {
  const fake = await fakePod(t);
  const lease = await readyLease(fake);
  // As after a restart: the record says ready, and the pod runs.
  await fake.compute.load();
  fake.compute.leases.holdForRecovery();
  const pods = fake.compute.podRuns();
  assert.throws(
    () => pods.pick('d-1'),
    /Verifold checks the pod of lease-1 after its start\./,
  );
  assert.throws(
    () => pods.pick('d-1', lease),
    /Verifold checks the pod of lease-1 after its start\./,
  );
  // Recovery stops the pod, but RunPod's answer does not come back: the lease stays out of runs.
  process.env.FAKE_ACTION_FAILS = '1';
  await fake.compute.leases.recover();
  delete process.env.FAKE_ACTION_FAILS;
  assert.deepEqual(fake.compute.view().closing, { [lease]: 'stopping' });
  assert.throws(() => pods.pick('d-1'), /The pod of lease-1 stops now/);
  await fake.compute.leases.poll();
  assert.equal(fake.compute.leases.get(lease).state, 'stopped');
  assert.deepEqual(fake.compute.view().closing, {});
  assert.throws(() => pods.pick('d-1'), /The pod of lease-1 stopped/);
});

await test('a stop of the pod that begins while a run saves its record ends the run before its job starts', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  const { ledger } = fx.ledger();
  let saving = (): void => {};
  const inSave = new Promise<void>((resolve) => {
    saving = resolve;
  });
  let go = (): void => {};
  const saved = new Promise<void>((resolve) => {
    go = resolve;
  });
  // The first save of the run waits until the pod stopped.
  const ledgerSave = ledger as unknown as {
    save(run: RunRecord): Promise<void>;
  };
  const save = ledgerSave.save.bind(ledger);
  let first = true;
  ledgerSave.save = async (run) => {
    if (first && run.status === 'queued') {
      first = false;
      saving();
      await saved;
    }
    return save(run);
  };
  const started = fx.start(ledger, 'sleep 30', { lease });
  await inSave;
  await fx.compute.leases.stop(lease, 'person', 'a test.');
  go();
  const run = await started;
  await until(() => {
    const status = ledger.get(run.id)?.status;
    return status !== 'queued' && status !== 'running';
  });
  assert.equal(ledger.get(run.id)?.status, 'interrupted');
  assert.doesNotMatch(ledger.get(run.id)?.note ?? '', /does not run now/);
  // The pod got no job for the run.
  assert.ok(!existsSync(join(fx.pod, 'verifold', '.runs', `${run.folder}.sh`)));
});

/**
 * A /proc for the fake pod: a boot ID and a stat line for each process,
 * with its state, its group, and its start time at field 22.
 */
async function fakeProc(
  fx: Fixture,
  boot: string,
  processes: readonly {
    readonly pid: number;
    readonly start: number;
    readonly state?: string;
    readonly group?: number;
  }[],
): Promise<void> {
  const proc = join(fx.dir, 'proc');
  await rm(proc, { recursive: true, force: true });
  await mkdir(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
  await writeFile(
    join(proc, 'sys', 'kernel', 'random', 'boot_id'),
    `${boot}\n`,
  );
  for (const entry of processes) {
    await mkdir(join(proc, String(entry.pid)), { recursive: true });
    // The name of a process can hold a parenthesis and a space.
    await writeFile(
      join(proc, String(entry.pid), 'stat'),
      `${entry.pid} (sle) ep) ${entry.state ?? 'S'} 1 ${entry.group ?? entry.pid} ${'0 '.repeat(16)}${entry.start} 0 0 0\n`,
    );
  }
  process.env.FAKE_PROC = proc;
}

/** The job files of a pod run, as an earlier start left them. */
async function jobFiles(
  fx: Fixture,
  folder: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const runs = join(fx.pod, 'verifold', '.runs');
  await mkdir(runs, { recursive: true });
  for (const [name, text] of Object.entries(files))
    await writeFile(join(runs, `${folder}.${name}`), `${text}\n`);
}

await test('a process with the number of a pod job but another boot or start time, a zombie, or a job that ended before its start was read is not the job', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  // A process that is not the job, in a process group of its own.
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => kill(other));
  const pid = other.pid ?? 0;
  const folder = 'run-1-0000abcd';
  await jobFiles(fx, folder, {
    wrap: String(pid),
    pid: String(pid),
    log: 'epoch 1',
  });
  const pods = fx.compute.podRuns();
  await fakeProc(fx, 'boot-a', [{ pid, start: 500 }]);
  for (const id of ['boot-a 400 400', 'boot-b 500 500', 'boot-a 400 ended']) {
    await jobFiles(fx, folder, { id });
    assert.equal((await pods.state(lease, folder)).state, 'gone');
    // KILL here: a stop that reached the process would end it with SIGKILL.
    await pods.stop(lease, folder, 'KILL');
  }
  // A zombie with the wrapper's number and start time does not run.
  await fakeProc(fx, 'boot-a', [{ pid, start: 500, state: 'Z' }]);
  await jobFiles(fx, folder, { id: 'boot-a 500 500' });
  assert.equal((await pods.state(lease, folder)).state, 'gone');
  // A link in place of .id counts as no file, so the state is read as before.
  await rm(join(fx.pod, 'verifold', '.runs', `${folder}.id`));
  await fakeProc(fx, 'boot-a', [{ pid, start: 500 }]);
  await jobFiles(fx, folder, { id: 'boot-a 500 500' });
  // The same boot and start time: this is the job, so it runs, and a stop reaches its group.
  assert.equal((await pods.state(lease, folder)).state, 'running');
  await pods.stop(lease, folder, 'TERM');
  await until(() => ended(other));
  assert.equal(other.signalCode, 'SIGTERM');
});

await test("when a job's own process ended, a stop reaches only the processes of its group that started with it or later", async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  const later = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const before = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    kill(later);
    kill(before);
  });
  // The job's number: no process has it now.
  const job = 999_999;
  await fakeProc(fx, 'boot-a', [
    { pid: later.pid ?? 0, group: job, start: 600 },
    { pid: before.pid ?? 0, group: job, start: 400 },
  ]);
  const folder = 'run-1-0000abcd';
  await jobFiles(fx, folder, {
    wrap: String(job),
    pid: String(job),
    id: 'boot-a 500 500',
    log: 'epoch 1',
  });
  await fx.compute.podRuns().stop(lease, folder, 'TERM');
  await until(() => ended(later), 5000);
  assert.equal(later.signalCode, 'SIGTERM');
  // The process that started before the job got no signal: the first that ends it is the test's own.
  before.kill('SIGKILL');
  await until(() => ended(before));
  assert.equal(before.signalCode, 'SIGKILL');
});

await test(
  'a pod job keeps the boot ID and the start times of its wrapper and its job',
  {
    skip: existsSync('/proc/self/stat') ? false : 'This computer has no /proc.',
  },
  async (t) => {
    const fx = await fixture(t);
    const lease = await fx.lease();
    const { ledger } = fx.ledger();
    const run = await fx.start(ledger, 'sleep 30', { lease });
    const runs = join(fx.pod, 'verifold', '.runs');
    await until(() => existsSync(join(runs, `${run.folder}.id`)));
    const [boot, wrapper, job] = readFileSync(
      join(runs, `${run.folder}.id`),
      'utf8',
    )
      .trim()
      .split(' ');
    assert.equal(
      boot,
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    );
    const started = (file: string): string | undefined => {
      const line = readFileSync(
        `/proc/${readFileSync(join(runs, file), 'utf8').trim()}/stat`,
        'utf8',
      );
      return line.slice(line.lastIndexOf(') ') + 2).split(' ')[19];
    };
    assert.equal(wrapper, started(`${run.folder}.wrap`));
    assert.equal(job, started(`${run.folder}.pid`));
    ledger.cancel(run.id, 'person');
    await until(() => ledger.get(run.id)?.status === 'cancelled');
  },
);
