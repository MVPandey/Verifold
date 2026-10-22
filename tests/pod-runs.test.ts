import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    log: () => Promise.resolve({ bytes: 0, head: Buffer.alloc(0), tail: null }),
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
    /The run's files stay on the pod in \/root\/verifold\/run-1-[0-9a-f]{8} until its lease ends\./,
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

await test('a pod run whose job cannot be read for 10 minutes gets a stop, and a stop that cannot reach the pod says so', async (t) => {
  const unreachable = (): Promise<never> =>
    Promise.reject(
      new Error('ssh: connect to host 10.0.0.1 port 22: timed out'),
    );
  for (const answers of [false, true]) {
    const fx = await fakeRuns(
      t,
      { 'out/a.txt': 'fine\n' },
      {
        minuteMs: 20,
        minutes: 60,
        state: unreachable,
        // The pod answers no read. It answers the stop only when `answers`.
        stop: () => (answers ? Promise.resolve() : unreachable()),
      },
    );
    const run = await fx.start(['out']);
    await until(() => fx.ledger.get(run.id)?.status === 'interrupted');
    const ended = fx.ledger.get(run.id);
    assert.match(
      ended?.note ?? '',
      /Verifold could not reach the pod for 10 minutes/,
    );
    // The job got a stop, although no read of it worked.
    assert.ok(fx.calls.stops.includes('KILL'));
    if (answers) {
      // The pod answered the stop, so the outputs came back and its copy went.
      assert.deepEqual(
        ended?.outputs.map((output) => output.path),
        ['out/a.txt'],
      );
      assert.equal(fx.calls.remove, 1);
      assert.doesNotMatch(ended?.note ?? '', /to stop the job/);
    } else {
      assert.match(
        ended?.note ?? '',
        /Verifold could not reach the pod to stop the job\. The job can continue to run until the pod stops\./,
      );
      assert.deepEqual(ended?.outputs, []);
    }
  }
});

await test('a pod run that stops after the upload, or whose start fails, leaves no copy on the pod', async (t) => {
  // A cancel that comes during the upload.
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
  // A start that fails: the job gets a stop, then its copy goes.
  const failed = await fakeRuns(
    t,
    {},
    {
      startJob: () =>
        Promise.reject(new Error('The pod did not start the run.')),
    },
  );
  const run = await failed.start([]);
  assert.equal(run.status, 'failed');
  assert.match(
    run.note ?? '',
    /The run did not start: The pod did not start the run\./,
  );
  assert.ok(failed.calls.stops.includes('KILL'));
  assert.equal(failed.calls.remove, 1);
});

await test('a new owner takes no outputs from a pod run that did not start, and its copy leaves the pod', async (t) => {
  const fx = await fixture(t);
  const lease = await fx.lease();
  const pods = fx.compute.podRuns();
  // As if an earlier owner copied the commit to the pod, then stopped before the job started.
  const folder = 'run-1-0000cccc';
  const tree = await mkdtemp(join(fx.dir, 'tree-'));
  await writeFile(join(tree, 'results.txt'), 'committed\n');
  await pods.send(lease, folder, tree);
  const record = join(fx.root, '.verifold', 'lab', 'runs', 'r-1');
  await mkdir(record, { recursive: true });
  await writeFile(
    join(record, 'run.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'r-1',
      agent: 'a-1',
      key: 'r-1',
      direction: 'd-1',
      harness: 'claude',
      commit: git(fx.root, 'rev-parse', 'HEAD').trim(),
      command: 'echo new > results.txt',
      why: 'A test.',
      status: 'queued',
      exitCode: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      minutes: 5,
      want: ['results.txt'],
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
  const { ledger } = fx.ledger();
  await ledger.load(true);
  await ledger.pending;
  const run = ledger.get('r-1');
  assert.equal(run?.status, 'interrupted');
  // The committed file on the pod is no output of a job that never ran.
  assert.deepEqual(run?.outputs, []);
  assert.match(run?.note ?? '', /Verifold stopped before the run started\./);
  assert.ok(!(await readdir(join(fx.pod, 'verifold'))).includes(folder));
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
      '\n[Verifold cut 2040 bytes of the log here. The last 1000 bytes follow.]\n',
    ),
  );
  const last = Buffer.from('\nend [HF_TOKEN] \xfd\n', 'latin1');
  assert.ok(log.subarray(log.length - last.length).equals(last));
  assert.ok(!log.includes(secret));
});
