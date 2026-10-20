import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { number, object, runId } from './board.ts';
import { childEnvironment, type HarnessName } from './harness.ts';
import { processStart, signalGroup, stopRecordedProcess } from './owner.ts';
import { SessionActionError } from './session.ts';
import { credentialPaths } from './session-hosts.ts';
import { writePrivateFile } from './storage.ts';
import { checkoutAt, commitPattern, type Workspace } from './workspaces.ts';

/**
 * The lab's run ledger. An agent runs a command on a commit of its folder,
 * and Verifold keeps the record: the commit, the command, the log, the exit
 * code, the time, and the metrics. Other agents and the person check a claim
 * against it.
 *
 * A run works on its own copy of the commit, in `.verifold/workspaces/run-N`,
 * inside the computer's sandbox: it writes only in that folder, has no
 * network, and cannot read the credential paths. Its record, log, and copied
 * outputs stay in `.verifold/lab/runs/r-N/`, where the run cannot write. When
 * the process ends, Verifold moves the run's folder out of the sandbox's
 * writable path before it reads anything from it, so a process that outlived
 * the run cannot change a file into a link meanwhile. Every change of a record
 * runs in the lab's queue. The checkout, the process, and the copies run
 * outside it.
 */

export const runLimits = {
  /** Runs at once: for one agent, and for the whole lab. */
  perAgent: 2,
  perLab: 3,
  minutes: 240,
  defaultMinutes: 60,
  command: 2000,
  why: 280,
  /** Output paths that one run names. */
  outputPaths: 10,
  outputFiles: 200,
  outputBytes: 100 * 1024 * 1024,
  /** Files and folders that Verifold looks at for the outputs of one run. */
  outputEntries: 10_000,
  /** The log keeps its start up to this size. Past it, a cut line and the last `logTail` bytes. */
  logBytes: 20 * 1024 * 1024,
  logTail: 1024 * 1024,
  metrics: 50,
  metricsFile: 64 * 1024,
  /** Log bytes in an agent's run status. */
  statusLog: 16 * 1024,
  /** Log bytes that the desk shows. */
  deskLog: 1024 * 1024,
  /** After SIGTERM, a run's processes get this long before SIGKILL. */
  graceMs: 5_000,
};

export type RunStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'timed-out'
  | 'cancelled'
  | 'interrupted';

const statuses: readonly RunStatus[] = [
  'queued',
  'running',
  'done',
  'failed',
  'timed-out',
  'cancelled',
  'interrupted',
];

/** The run starts now or runs now. */
export function runActive(run: RunRecord): boolean {
  return run.status === 'queued' || run.status === 'running';
}

export const noSandboxText =
  'This computer has no sandbox for runs: sandbox-exec on macOS, or bubblewrap on Linux. Verifold runs nothing here.';

export interface RunOutput {
  /** The path in the run's folder, and in `outputs/`. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RunRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agent: string;
  /** The harness call that started the run, so a repeated call starts nothing. */
  readonly key: string;
  readonly direction: string;
  readonly harness: HarnessName;
  readonly commit: string;
  readonly command: string;
  readonly why: string;
  readonly status: RunStatus;
  /** The exit code that Verifold saw, or null when the process did not exit by itself. */
  readonly exitCode: number | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly minutes: number;
  /** The output paths that the agent named. */
  readonly want: readonly string[];
  /** A name whose value is not a finite number has null. */
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly outputs: readonly RunOutput[];
  /** SHA-256 of the commit and the command: two runs with the same one ran the same thing. */
  readonly config: string;
  /** SHA-256 of the copied outputs, or null when the run copied none. */
  readonly output: string | null;
  readonly log: { readonly bytes: number; readonly cut: boolean };
  /** The process group's leader. Its start time keeps a reused PID from passing for it. */
  readonly process: {
    readonly pid: number;
    readonly processStart: string | null;
  } | null;
  /** `person`, or the agent that cancelled it. */
  readonly cancelledBy: string | null;
  /** What else happened, such as a start that failed or an output that was not there. */
  readonly note: string | null;
  /** Its agent heard that it ended. After a restart, an agent that did not hears it then. */
  readonly told: boolean;
}

/** A path that the run's sandbox cannot read: a credential folder or file, by its real path. */
export interface DeniedPath {
  readonly path: string;
  readonly folder: boolean;
}

/** One run for the sandbox to start. */
export interface SandboxSpec {
  readonly command: string;
  /** The run's folder, by its real path: the only place where the run writes. */
  readonly folder: string;
  /** The working folder: the commit's files, inside `folder`. */
  readonly cwd: string;
  readonly denied: readonly DeniedPath[];
}

/** The program and arguments that start one run inside a sandbox. */
export type Sandbox = (spec: SandboxSpec) => {
  readonly file: string;
  readonly args: readonly string[];
};

/**
 * The macOS sandbox profile of a run. Everything is denied first. The run can
 * start programs, read files except the denied paths, and write only in its
 * folder. It has no network, no local sockets, no GPU, and none of the
 * system services that start programs outside the sandbox, such as launchd
 * or LaunchServices. Probed on macOS 26.6.
 */
function seatbeltProfile(denied: number): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow user-preference-read)',
    '(allow sysctl-read)',
    '(allow ipc-posix-sem ipc-posix-shm)',
    '(allow pseudo-tty)',
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.PowerManagement.control"))',
    '(allow file-read*)',
    // A later rule wins, so the denied paths stay closed.
    ...(denied
      ? [
          `(deny file-read* ${Array.from({ length: denied }, (_, index) => `(subpath (param "DENY_${index}"))`).join(' ')})`,
        ]
      : []),
    // The standard streams by path, such as `echo x > /dev/stderr`. A run has only its pipes open.
    '(allow file-write* (subpath (param "RUN")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))',
    '(allow file-ioctl (literal "/dev/null"))',
  ].join('\n');
}

/** A run inside `sandbox-exec`. The paths go in as parameters, so no path is quoted into the profile. */
export const seatbelt: Sandbox = (spec) => ({
  file: '/usr/bin/sandbox-exec',
  args: [
    '-p',
    seatbeltProfile(spec.denied.length),
    '-D',
    `RUN=${spec.folder}`,
    ...spec.denied.flatMap((entry, index) => [
      '-D',
      `DENY_${index}=${entry.path}`,
    ]),
    '/bin/sh',
    '-c',
    spec.command,
  ],
});

/**
 * A run inside bubblewrap: the system read-only, the run's folder writable,
 * the credential paths hidden, and no network. Its own PID namespace ends
 * every process of the run when the run ends.
 */
export function bubblewrap(bwrap: string): Sandbox {
  return (spec) => ({
    file: bwrap,
    args: [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      ...spec.denied.flatMap((entry) =>
        entry.folder
          ? ['--tmpfs', entry.path]
          : ['--ro-bind', '/dev/null', entry.path],
      ),
      '--bind',
      spec.folder,
      spec.folder,
      '--chdir',
      spec.cwd,
      '/bin/sh',
      '-c',
      spec.command,
    ],
  });
}

/** The sandbox of this computer: Seatbelt on macOS, bubblewrap on Linux when it is installed, or none. */
export function localSandbox(): Sandbox | null {
  if (process.platform === 'darwin')
    return existsSync('/usr/bin/sandbox-exec') ? seatbelt : null;
  if (process.platform === 'linux') {
    const bwrap = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'].find(
      (path) => existsSync(path),
    );
    return bwrap ? bubblewrap(bwrap) : null;
  }
  return null;
}

/** The credential paths that exist, by their real paths, so a link to one is closed too. */
export async function deniedPaths(home = homedir()): Promise<DeniedPath[]> {
  const found = new Map<string, DeniedPath>();
  for (const path of credentialPaths) {
    const real = await realpath(join(home, path.slice(2))).catch(() => null);
    if (!real) continue;
    const stats = await stat(real).catch(() => null);
    if (stats) found.set(real, { path: real, folder: stats.isDirectory() });
  }
  return [...found.values()];
}

/**
 * The environment of a run: a child's environment without the keys of the
 * harnesses and the cloud accounts, which a run without network cannot use,
 * and without Git's variables. Git in the run finds no repository above its
 * folder, so a script that records the commit reads `VERIFOLD_COMMIT`.
 */
function runEnvironment(run: RunRecord, folder: string): NodeJS.ProcessEnv {
  const environment = childEnvironment();
  for (const name of Object.keys(environment))
    if (
      /^(ANTHROPIC|OPENAI|CLAUDE|CODEX|AWS|AZURE|GOOGLE|GEMINI|GIT)_/.test(name)
    )
      delete environment[name];
  return {
    ...environment,
    TMPDIR: join(folder, 'tmp'),
    GIT_CEILING_DIRECTORIES: folder,
    VERIFOLD_RUN: run.id,
    VERIFOLD_COMMIT: run.commit,
  };
}

const metricName = /^[A-Za-z0-9_.-]{1,64}$/;
/** A metric line. A value that is no finite number, such as nan, counts as null. */
const metricLine = new RegExp(
  `^METRIC (${metricName.source.slice(1, -1)})=(\\S{1,64})$`,
);

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** A saved run record, or null when it is not valid. */
function parseRun(value: Record<string, unknown> | null): RunRecord | null {
  if (!value) return null;
  const text = (field: unknown): field is string => typeof field === 'string';
  const time = (field: unknown): field is string | null =>
    field === null || (text(field) && !Number.isNaN(Date.parse(field)));
  const log = object(value.log);
  const leader = value.process === null ? null : object(value.process);
  const metrics = object(value.metrics);
  const outputs = Array.isArray(value.outputs) ? value.outputs : null;
  if (
    value.schemaVersion !== 1 ||
    !text(value.id) ||
    !runId.test(value.id) ||
    !text(value.agent) ||
    !text(value.key) ||
    !text(value.direction) ||
    (value.harness !== 'claude' && value.harness !== 'codex') ||
    !text(value.commit) ||
    !commitPattern.test(value.commit) ||
    !text(value.command) ||
    !text(value.why) ||
    !statuses.includes(value.status as RunStatus) ||
    !(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
    !text(value.queuedAt) ||
    !time(value.queuedAt) ||
    !time(value.startedAt) ||
    !time(value.endedAt) ||
    !Number.isSafeInteger(value.minutes) ||
    !Array.isArray(value.want) ||
    !value.want.every(text) ||
    !metrics ||
    !outputs ||
    !text(value.config) ||
    !(value.output === null || text(value.output)) ||
    !log ||
    !Number.isSafeInteger(log.bytes) ||
    typeof log.cut !== 'boolean' ||
    (value.process !== null &&
      !(
        leader &&
        Number.isSafeInteger(leader.pid) &&
        (leader.processStart === null || text(leader.processStart))
      )) ||
    !(value.cancelledBy === null || text(value.cancelledBy)) ||
    !(value.note === null || text(value.note)) ||
    typeof value.told !== 'boolean'
  )
    return null;
  const shown = outputs.flatMap((entry: unknown) => {
    const item = object(entry);
    return item &&
      text(item.path) &&
      Number.isSafeInteger(item.bytes) &&
      text(item.sha256)
      ? [{ path: item.path, bytes: item.bytes as number, sha256: item.sha256 }]
      : [];
  });
  return {
    schemaVersion: 1,
    id: value.id,
    agent: value.agent,
    key: value.key,
    direction: value.direction,
    harness: value.harness,
    commit: value.commit,
    command: value.command,
    why: value.why,
    status: value.status as RunStatus,
    exitCode: value.exitCode as number | null,
    queuedAt: value.queuedAt,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    minutes: value.minutes as number,
    want: value.want,
    metrics: Object.fromEntries(
      Object.entries(metrics).flatMap(([name, metric]) =>
        metricName.test(name) &&
        (metric === null ||
          (typeof metric === 'number' && Number.isFinite(metric)))
          ? [[name, metric]]
          : [],
      ),
    ),
    outputs: shown,
    config: value.config,
    output: value.output,
    log: { bytes: log.bytes as number, cut: log.cut },
    process: leader
      ? {
          pid: leader.pid as number,
          processStart: leader.processStart as string | null,
        }
      : null,
    cancelledBy: value.cancelledBy,
    note: value.note,
    told: value.told,
  };
}

/** A run's ended state in a few words, such as "exit 0 in 6 min" or "timed out after 60 min". */
export function runSummary(run: RunRecord): string {
  const minutes =
    run.startedAt && run.endedAt
      ? Math.max(
          0,
          Math.round(
            (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60_000,
          ),
        )
      : null;
  const span = minutes === null ? '' : ` in ${minutes} min`;
  switch (run.status) {
    case 'queued':
      return 'starting';
    case 'running':
      return 'running';
    case 'done':
    case 'failed':
      return run.exitCode === null
        ? `failed${span}`
        : `exit ${run.exitCode}${span}`;
    case 'timed-out':
      return `timed out after ${run.minutes} min`;
    case 'cancelled':
      return `cancelled${span}`;
    case 'interrupted':
      return `interrupted${span}`;
  }
}

/** Up to `count` metrics, such as "acc=0.612, loss=1.2". */
export function metricsText(run: RunRecord, count = 3): string {
  return Object.entries(run.metrics)
    .slice(0, count)
    .map(([name, value]) => `${name}=${value ?? 'null'}`)
    .join(', ');
}

/**
 * The log of one run: its start up to `logBytes - logTail`, then the last
 * `logTail` bytes, kept in memory and written when the run ends. Writes go
 * one at a time, and the caller pauses its stream until each one ends, so the
 * memory stays bounded. `METRIC name=value` lines become metrics.
 */
class RunLog {
  private written = 0;
  bytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private writing: Promise<void> = Promise.resolve();
  private readonly partial = { out: '', err: '' };
  readonly metrics = new Map<string, number | null>();
  private readonly handle: FileHandle;

  constructor(handle: FileHandle) {
    this.handle = handle;
  }

  add(chunk: Buffer, stream: 'out' | 'err'): Promise<void> {
    this.bytes += chunk.length;
    this.scan(chunk, stream);
    const room = Math.max(
      0,
      runLimits.logBytes - runLimits.logTail - this.written,
    );
    const head = chunk.subarray(0, room);
    const rest = chunk.subarray(head.length);
    if (rest.length) {
      this.tail.push(rest);
      this.tailBytes += rest.length;
      while (
        this.tail.length > 1 &&
        this.tailBytes - (this.tail[0]?.length ?? 0) >= runLimits.logTail
      )
        this.tailBytes -= this.tail.shift()?.length ?? 0;
    }
    if (head.length) {
      this.written += head.length;
      this.writing = this.writing
        .then(async () => {
          await this.handle.write(head);
        })
        .catch(() => {
          /* A write that failed, such as on a full disk, leaves a gap. The run goes on. */
        });
    }
    return this.writing;
  }

  /** Lines of each stream. A line longer than 300 characters is no metric, and is skipped. */
  private scan(chunk: Buffer, stream: 'out' | 'err'): void {
    const lines = `${this.partial[stream]}${chunk.toString('latin1')}`.split(
      '\n',
    );
    const last = lines.pop() ?? '';
    this.partial[stream] = last.length > 300 ? '\0' : last;
    for (const line of lines) this.metric(line);
  }

  private metric(line: string): void {
    const match = metricLine.exec(line.replace(/\r$/, ''));
    if (!match?.[1] || !match[2]) return;
    if (!this.metrics.has(match[1]) && this.metrics.size >= runLimits.metrics)
      return;
    const value = Number(match[2]);
    this.metrics.set(match[1], Number.isFinite(value) ? value : null);
  }

  /** Write the end of the log and close it. Returns whether a part was cut. */
  async finish(): Promise<boolean> {
    for (const stream of ['out', 'err'] as const)
      this.metric(this.partial[stream]);
    await this.writing;
    let kept = Buffer.concat(this.tail);
    if (kept.length > runLimits.logTail)
      kept = kept.subarray(kept.length - runLimits.logTail);
    const cut = this.bytes - this.written - kept.length;
    try {
      if (cut > 0)
        await this.handle.write(
          `\n[Verifold cut ${cut} bytes of the log here. The last ${kept.length} bytes follow.]\n`,
        );
      if (kept.length) await this.handle.write(kept);
    } finally {
      await this.handle.close();
    }
    return cut > 0;
  }
}

/**
 * Read a file of a run's folder that no sandboxed process can change any
 * more: a regular file with one link on the folder's device, opened without
 * following a link, of at most `max` bytes. Null otherwise.
 */
async function readKept(
  path: string,
  device: number,
  max: number,
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.dev !== device ||
      stats.size > max
    )
      return null;
    const content = await handle.readFile();
    return content.length > max ? null : content;
  } finally {
    await handle.close();
  }
}

/** A run's process while it runs. */
interface Live {
  readonly pid: number;
  /** Why Verifold stopped it, when it did. */
  stop: 'timed-out' | 'cancelled' | 'interrupted' | null;
  timer: NodeJS.Timeout | undefined;
  kill: NodeJS.Timeout | undefined;
}

export interface RunLedgerOptions {
  /** Null: this computer has no sandbox, so local runs are refused. */
  readonly sandbox: Sandbox | null;
  /** The lab's queue. Every change of a record runs in it. */
  readonly serial: <T>(work: () => T | Promise<T>) => Promise<T>;
  /** A run ended. In the lab's queue. Returns true when its agent heard it. */
  readonly ended: (run: RunRecord) => boolean;
  /** One minute of a run's time limit. */
  readonly minuteMs?: number;
  /** The home folder whose credential paths a run cannot read. */
  readonly home?: string;
}

export class RunLedger {
  private readonly root: string;
  private readonly options: RunLedgerOptions;
  private readonly records = new Map<string, RunRecord>();
  private readonly live = new Map<string, Live>();
  /** Runs whose folder is made now. A stop that comes meanwhile waits here. */
  private readonly starting = new Map<string, Live['stop']>();
  /** The work of each run from its start to its end. Close waits for it. */
  private readonly work = new Set<Promise<void>>();
  private last = 0;
  /** Who cancelled each run that stops now, and why. */
  private readonly cancelled = new Map<string, string>();
  private readonly reasons = new Map<string, string>();
  /** The owner stops, or the lab moves: no run starts until the next load. */
  private closed = false;

  constructor(root: string, options: RunLedgerOptions) {
    this.root = root;
    this.options = options;
  }

  /** This computer can run commands in a sandbox. */
  get sandboxed(): boolean {
    return this.options.sandbox !== null;
  }

  list(): readonly RunRecord[] {
    return [...this.records.values()].sort(
      (a, b) => number(a.id) - number(b.id),
    );
  }

  get(id: unknown): RunRecord | undefined {
    return typeof id === 'string' ? this.records.get(id) : undefined;
  }

  /** The runs of an agent, or of the lab, that run now or start now. */
  running(agent?: string): number {
    return [...this.records.values()].filter(
      (run) => runActive(run) && (agent === undefined || run.agent === agent),
    ).length;
  }

  private get folder(): string {
    return join(this.root, '.verifold', 'lab', 'runs');
  }

  private paths(id: string): {
    readonly record: string;
    readonly folder: string;
    readonly kept: string;
  } {
    const workspaces = join(this.root, '.verifold', 'workspaces');
    return {
      record: join(this.folder, id),
      folder: join(workspaces, `run-${number(id)}`),
      // Outside the sandbox's writable path: a component that the run's folder name does not start.
      kept: join(workspaces, `run-${number(id)}.done`),
    };
  }

  /**
   * Read the records. With `recover`, in the project's owner: a run that an
   * earlier owner left starting or running ends as interrupted, its process
   * group stops when its PID and start time match, and its folder goes.
   */
  async load(recover: boolean): Promise<void> {
    this.records.clear();
    this.last = 0;
    this.closed = false;
    let names: string[] = [];
    try {
      names = await readdir(this.folder);
    } catch {
      /* No run yet. */
    }
    for (const name of names.filter((entry) => runId.test(entry))) {
      this.last = Math.max(this.last, number(name));
      let value: Record<string, unknown> | null = null;
      try {
        const path = join(this.folder, name, 'run.json');
        const stats = await lstat(path);
        if (stats.isFile() && stats.size <= 1_000_000)
          value = object(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        /* A record that cannot be read is skipped. */
      }
      const run = parseRun(value);
      if (run?.id === name) this.records.set(run.id, run);
    }
    if (!recover) return;
    for (const run of this.records.values()) {
      if (!runActive(run) || this.live.has(run.id) || this.starting.has(run.id))
        continue;
      if (run.process)
        await stopRecordedProcess(run.process.pid, run.process.processStart);
      // A folder that cannot go stays. The record ends all the same.
      await this.clear(run.id).catch(() => {});
      const next: RunRecord = {
        ...run,
        status: 'interrupted',
        endedAt: new Date().toISOString(),
        note: 'Verifold stopped while the run ran.',
      };
      this.records.set(run.id, next);
      await this.save(next).catch(() => {});
    }
  }

  /** Refuse a start past the limits. */
  room(agent: string): void {
    if (this.running(agent) >= runLimits.perAgent)
      fail(
        `You have ${runLimits.perAgent} runs that run now. Wait until one ends, or cancel one.`,
      );
    if (this.running() >= runLimits.perLab)
      fail(
        `The lab has ${runLimits.perLab} runs that run now. Wait until one ends.`,
      );
  }

  /**
   * Start a run of `command` on `commit` of the agent's folder. The record
   * comes first, in the lab's queue. Then the run's folder and its process,
   * outside it. Returns once the process started, or the run failed to
   * start. A repeated call with the same key gets the first run.
   */
  async start(input: {
    readonly agent: string;
    readonly key: string;
    readonly direction: string;
    readonly harness: HarnessName;
    readonly workspace: Workspace;
    readonly commit: string;
    readonly command: string;
    readonly why: string;
    readonly minutes: number;
    readonly want: readonly string[];
  }): Promise<RunRecord> {
    const sandbox = this.options.sandbox ?? fail(noSandboxText);
    const made = await this.options.serial(async () => {
      const known = [...this.records.values()].find(
        (run) => run.agent === input.agent && run.key === input.key,
      );
      if (known) return { run: known, known: true };
      if (this.closed)
        fail('Verifold stops or moves the lab now, so no run starts.');
      this.room(input.agent);
      const id = `r-${++this.last}`;
      const run: RunRecord = {
        schemaVersion: 1,
        id,
        agent: input.agent,
        key: input.key,
        direction: input.direction,
        harness: input.harness,
        commit: input.commit,
        command: input.command,
        why: input.why,
        status: 'queued',
        exitCode: null,
        queuedAt: new Date().toISOString(),
        startedAt: null,
        endedAt: null,
        minutes: input.minutes,
        want: input.want,
        metrics: {},
        outputs: [],
        config: createHash('sha256')
          .update(`${input.commit}\0${input.command}`)
          .digest('hex'),
        output: null,
        log: { bytes: 0, cut: false },
        process: null,
        cancelledBy: null,
        note: null,
        told: false,
      };
      await mkdir(this.paths(id).record, { recursive: true, mode: 0o700 });
      await this.save(run);
      this.records.set(id, run);
      this.starting.set(id, null);
      return { run, known: false };
    });
    if (made.known) return made.run;
    let started!: (run: RunRecord) => void;
    const ready = new Promise<RunRecord>((resolve) => {
      started = resolve;
    });
    const work = this.execute(made.run, sandbox, input.workspace, started)
      .catch(() => {
        /* The run's end records what failed. */
      })
      .finally(() => {
        this.work.delete(work);
        // The caller never waits for good, also when the end's record failed.
        started(this.records.get(made.run.id) ?? made.run);
      });
    this.work.add(work);
    return ready;
  }

  /** The run from its folder to its end. `started` gets the record once the process runs, or once the run ended. */
  private async execute(
    run: RunRecord,
    sandbox: Sandbox,
    workspace: Workspace,
    started: (run: RunRecord) => void,
  ): Promise<void> {
    const paths = this.paths(run.id);
    let log: RunLog | null = null;
    // Verifold stopped the run. Its exit code then does not count.
    let stop: Live['stop'] = null;
    let exit: { code: number | null; error: string | null } = {
      code: null,
      error: null,
    };
    // The process started, so its folder holds its work.
    let ran = false;
    try {
      await this.clear(run.id);
      const tree = join(paths.folder, 'tree');
      await mkdir(tree, { recursive: true, mode: 0o700 });
      await mkdir(join(paths.folder, 'tmp'), { mode: 0o700 });
      await checkoutAt(this.root, workspace, run.commit, tree);
      // A committed metrics.json is not this run's result. The run writes its own.
      await rm(join(tree, 'metrics.json'), { force: true }).catch(() => {});
      const folder = await realpath(paths.folder);
      const { file, args } = sandbox({
        command: run.command,
        folder,
        cwd: join(folder, 'tree'),
        denied: await deniedPaths(this.options.home),
      });
      log = new RunLog(await open(join(paths.record, 'log.txt'), 'w', 0o600));
      stop = this.starting.get(run.id) ?? null;
      if (stop) return;
      const child = spawn(file, args, {
        cwd: join(folder, 'tree'),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runEnvironment(run, folder),
      });
      const exited = new Promise<{ code: number | null; error: string | null }>(
        (resolve) => {
          child.once('error', (error) =>
            resolve({ code: null, error: error.message }),
          );
          child.once('exit', (code) => resolve({ code, error: null }));
        },
      );
      const current = log;
      // Every chunk reaches the log before its stream reads more.
      const ends = (
        [
          [child.stdout, 'out'],
          [child.stderr, 'err'],
        ] as const
      ).map(
        ([stream, name]) =>
          new Promise<void>((resolve) => {
            stream.on('data', (chunk: Buffer) => {
              stream.pause();
              void current
                .add(chunk, name)
                .catch(() => {
                  /* A log that cannot be written keeps the run going. */
                })
                .finally(() => stream.resume());
            });
            stream.once('end', resolve);
            stream.once('close', resolve);
            stream.once('error', () => resolve());
          }),
      );
      const pid = child.pid;
      if (pid !== undefined) {
        ran = true;
        const live: Live = {
          pid,
          stop: null,
          timer: undefined,
          kill: undefined,
        };
        this.live.set(run.id, live);
        // A stop that came while the folder was made.
        const late = this.starting.get(run.id);
        this.starting.delete(run.id);
        if (late) this.halt(run.id, late);
        live.timer = setTimeout(
          () => this.halt(run.id, 'timed-out'),
          run.minutes * (this.options.minuteMs ?? 60_000),
        );
        live.timer.unref();
        const begun = await processStart(pid);
        started(
          await this.options.serial(async () => {
            const next: RunRecord = {
              ...(this.records.get(run.id) ?? run),
              status: 'running',
              startedAt: new Date().toISOString(),
              process: { pid, processStart: begun },
            };
            this.records.set(run.id, next);
            await this.save(next).catch(() => {});
            return next;
          }),
        );
        exit = await exited;
        // A cancel from here on comes too late: the run ended.
        this.live.delete(run.id);
        clearTimeout(live.timer);
        clearTimeout(live.kill);
        stop = live.stop;
        // What is left of the group, such as a child in the background, stops with the run.
        signalGroup(pid, 'SIGKILL');
      } else exit = await exited;
      // A process outside the group can keep the pipes open: the log waits a few seconds at most.
      await Promise.race([
        Promise.all(ends),
        new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
      ]);
      child.stdout.destroy();
      child.stderr.destroy();
    } catch (error) {
      exit = {
        code: null,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    } finally {
      this.live.delete(run.id);
      this.starting.delete(run.id);
      const cut = (await log?.finish().catch(() => false)) ?? false;
      const kept: Collected = ran
        ? await this.keep(run).catch((error: unknown) => ({
            metrics: new Map(),
            outputs: [],
            note: `Verifold could not read the run's folder: ${error instanceof Error ? error.message : 'unknown error'}`,
          }))
        : { metrics: new Map(), outputs: [], note: null };
      await this.clear(run.id).catch(() => {});
      started(
        await this.options.serial(async () => {
          const metrics = [
            ...new Map([...(log?.metrics ?? []), ...kept.metrics]),
          ].slice(0, runLimits.metrics);
          const next: RunRecord = {
            ...(this.records.get(run.id) ?? run),
            status:
              stop ??
              (exit.error === null && exit.code === 0 ? 'done' : 'failed'),
            exitCode: stop ? null : exit.code,
            endedAt: new Date().toISOString(),
            metrics: Object.fromEntries(metrics),
            outputs: kept.outputs,
            output: kept.outputs.length
              ? createHash('sha256')
                  .update(
                    kept.outputs
                      .map((entry) => `${entry.path}\0${entry.sha256}\n`)
                      .join(''),
                  )
                  .digest('hex')
              : null,
            log: { bytes: log?.bytes ?? 0, cut },
            cancelledBy:
              stop === 'cancelled'
                ? (this.cancelled.get(run.id) ?? null)
                : null,
            note:
              [
                exit.error ? `The run did not start: ${exit.error}` : '',
                stop === 'cancelled' && this.reasons.get(run.id)
                  ? `Cancelled: ${this.reasons.get(run.id)}`
                  : '',
                kept.note ?? '',
              ]
                .filter(Boolean)
                .join(' ') || null,
          };
          this.cancelled.delete(run.id);
          this.reasons.delete(run.id);
          this.records.set(run.id, next);
          const saved = this.options.ended(next)
            ? { ...next, told: true }
            : next;
          this.records.set(run.id, saved);
          await this.save(saved).catch(() => {});
          return saved;
        }),
      );
    }
  }

  /**
   * After the run: move its folder out of the sandbox's writable path, then
   * read `metrics.json` and copy the named outputs from it. Only regular
   * files with one link count, and no link is followed.
   */
  private async keep(run: RunRecord): Promise<Collected> {
    const paths = this.paths(run.id);
    const collected: Collected = {
      metrics: new Map(),
      outputs: [],
      note: null,
    };
    try {
      await rename(paths.folder, paths.kept);
    } catch {
      return collected;
    }
    const top = await lstat(paths.kept);
    const tree = await lstat(join(paths.kept, 'tree')).catch(() => null);
    if (!top.isDirectory() || !tree?.isDirectory() || tree.dev !== top.dev)
      return {
        ...collected,
        note: 'The run replaced its folder, so Verifold took no metrics and no outputs.',
      };
    const base = join(paths.kept, 'tree');
    const json = await readKept(
      join(base, 'metrics.json'),
      top.dev,
      runLimits.metricsFile,
    );
    if (json) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = object(JSON.parse(json.toString('utf8')));
      } catch {
        collected.note = 'metrics.json is not a JSON object.';
      }
      for (const [name, value] of Object.entries(parsed ?? {}))
        if (
          metricName.test(name) &&
          (collected.metrics.has(name) ||
            collected.metrics.size < runLimits.metrics)
        )
          collected.metrics.set(
            name,
            typeof value === 'number' && Number.isFinite(value) ? value : null,
          );
    }
    const missing: string[] = [];
    const failed: string[] = [];
    const copied = new Set<string>();
    let bytes = 0;
    let entries = 0;
    let full = false;
    // One output that cannot be copied leaves the others and the metrics as they are.
    const copy = async (rel: string): Promise<void> => {
      if (full || copied.has(rel)) return;
      if (++entries > runLimits.outputEntries) {
        full = true;
        return;
      }
      const path = join(base, rel);
      const stats = await lstat(path).catch(() => null);
      if (!stats || stats.isSymbolicLink()) return;
      if (stats.isDirectory()) {
        let names: string[] = [];
        try {
          names = (await readdir(path)).sort();
        } catch {
          failed.push(rel);
        }
        for (const name of names) await copy(`${rel}/${name}`);
        return;
      }
      if (!stats.isFile()) return;
      if (
        collected.outputs.length >= runLimits.outputFiles ||
        bytes + stats.size > runLimits.outputBytes
      ) {
        full = true;
        return;
      }
      try {
        const content = await readKept(
          path,
          top.dev,
          runLimits.outputBytes - bytes,
        );
        if (!content) return;
        const target = join(paths.record, 'outputs', rel);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: 'wx', mode: 0o600 });
        copied.add(rel);
        bytes += content.length;
        collected.outputs.push({
          path: rel,
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      } catch {
        failed.push(rel);
      }
    };
    for (const rel of run.want) {
      // Each folder on the way is a real folder, not a link.
      let inside = true;
      const parts = rel.split('/');
      for (let index = 1; index < parts.length; index++) {
        const stats = await lstat(join(base, ...parts.slice(0, index))).catch(
          () => null,
        );
        if (!stats?.isDirectory()) inside = false;
      }
      const before = collected.outputs.length;
      if (inside) await copy(rel);
      if (collected.outputs.length === before && !full && !copied.has(rel))
        missing.push(rel);
    }
    const notes = [
      collected.note ?? '',
      missing.length ? `No output file at ${missing.join(', ')}.` : '',
      failed.length
        ? `Verifold could not copy ${failed.slice(0, 5).join(', ')}.`
        : '',
      full
        ? `The outputs stop at ${runLimits.outputFiles} files, ${runLimits.outputBytes / 1024 / 1024} MB, or ${runLimits.outputEntries} entries.`
        : '',
    ].filter(Boolean);
    return { ...collected, note: notes.length ? notes.join(' ') : null };
  }

  /**
   * Remove a run's folder and its kept copy. Neither removal follows a link.
   * A run can leave folders without write permission, so a removal that
   * fails makes the folders writable for their owner and tries once more.
   */
  private async clear(id: string): Promise<void> {
    const paths = this.paths(id);
    for (const path of [paths.folder, paths.kept])
      await rm(path, { recursive: true, force: true }).catch(async () => {
        await writable(path);
        await rm(path, { recursive: true, force: true });
      });
  }

  /**
   * Stop a run: SIGTERM to its process group, then SIGKILL after the grace
   * time. A run whose folder is made now stops before its process starts.
   */
  private halt(id: string, why: NonNullable<Live['stop']>): void {
    if (this.starting.has(id)) {
      if (!this.starting.get(id)) this.starting.set(id, why);
      return;
    }
    const live = this.live.get(id);
    if (!live || live.stop) return;
    live.stop = why;
    signalGroup(live.pid, 'SIGTERM');
    live.kill = setTimeout(
      () => signalGroup(live.pid, 'SIGKILL'),
      runLimits.graceMs,
    );
    live.kill.unref();
  }

  /**
   * Cancel a run that runs now. `by` is `person` or the agent that asked, and
   * `why` goes into the record's note. Call it in the lab's queue.
   */
  cancel(id: string, by: string, why = ''): void {
    const run = this.records.get(id) ?? fail(`No run ${id} is in the lab.`);
    if (!runActive(run)) fail(`${id} already ended: ${runSummary(run)}.`);
    if (!this.live.has(id) && !this.starting.has(id))
      fail(`${id} ends now. Read it again in a moment.`);
    if (!this.cancelled.has(id)) {
      this.cancelled.set(id, by);
      if (why) this.reasons.set(id, why);
    }
    this.halt(id, 'cancelled');
  }

  /**
   * Stop every run of this process as interrupted, and wait until each
   * record is final. No run starts until the next load.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.starting.keys(), ...this.live.keys()])
      this.halt(id, 'interrupted');
    await Promise.all(this.work);
  }

  /** The agent heard that the run ended. Call it in the lab's queue. */
  async told(id: string): Promise<void> {
    const run = this.records.get(id);
    if (!run || run.told) return;
    const next = { ...run, told: true };
    this.records.set(id, next);
    await this.save(next).catch(() => {});
  }

  /**
   * Up to `max` bytes of a run's log: its head or its tail, with the log's
   * size and whether that is only a part of it. Null when the run has no log.
   */
  async log(
    id: string,
    part: 'head' | 'tail',
    max: number,
  ): Promise<RunLogPart | null> {
    if (!this.records.has(id)) return null;
    let handle: FileHandle;
    try {
      handle = await open(
        join(this.paths(id).record, 'log.txt'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      return null;
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, max);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, part === 'head' ? 0 : size - length);
      return {
        text: buffer.toString('utf8'),
        bytes: size,
        partial: size > length,
      };
    } finally {
      await handle.close();
    }
  }

  private save(run: RunRecord): Promise<void> {
    return writePrivateFile(
      join(this.paths(run.id).record, 'run.json'),
      `${JSON.stringify(run, null, 2)}\n`,
    );
  }
}

/** Part of a run's log. */
export interface RunLogPart {
  readonly text: string;
  readonly bytes: number;
  /** The text is only a part of the log. */
  readonly partial: boolean;
}

/** What Verifold took from a run's folder after the run. */
interface Collected {
  readonly metrics: Map<string, number | null>;
  readonly outputs: RunOutput[];
  note: string | null;
}

/** Give the owner write and search permission on each folder under `path`, without following a link. */
async function writable(path: string): Promise<void> {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await writable(join(path, name));
}
