import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { number, object, runId } from './board.ts';
import { childEnvironment, type HarnessName } from './harness.ts';
import { processStart, signalGroup, stopRecordedProcess } from './owner.ts';
import { SessionActionError } from './session.ts';
import { credentialPaths } from './session-hosts.ts';
import { writePrivateFile } from './storage.ts';
import { checkoutAt, commitPattern, type Workspace } from './workspaces.ts';
import type { PodRunState } from './pod-shell.ts';
import type { SecretGuard } from './runpod.ts';

/**
 * The lab's run ledger. An agent runs a command on a commit of its folder,
 * and Verifold keeps the record: the commit, the command, the log, the exit
 * code, the time, and the metrics. Other agents and the person check a claim
 * against it.
 *
 * A run works on its own copy of the commit, in a folder under
 * `.verifold/workspaces` that no other run gets, inside the macOS sandbox: it
 * writes only in that folder, has no network, and cannot read the credential
 * paths. Other systems run nothing locally. Its record, log, and copied
 * outputs stay in `.verifold/lab/runs/r-N/`, where the run cannot write. When
 * the process ends, Verifold moves the run's folder out of the sandbox's
 * writable path before it reads anything from it, so a process that outlived
 * the run cannot change a file into a link meanwhile. Every change of a record
 * runs in the lab's queue. The checkout, the process, and the copies run
 * outside it.
 *
 * A run can also run on the GPU pod of a lease of its direction. Verifold
 * copies the commit to the pod, starts the command there as a job, and reads
 * its state until it ends. Then it copies the named outputs and metrics.json
 * back into the run's empty folder, and takes them with the same checks as a
 * local run's.
 */

export const runLimits = {
  /** Runs at once: for one agent, and for the whole lab. */
  perAgent: 2,
  perLab: 3,
  minutes: 240,
  /** A run on a pod can take a day. */
  podMinutes: 1440,
  defaultMinutes: 60,
  command: 2000,
  why: 280,
  /** Output paths that one run names. */
  outputPaths: 10,
  outputFiles: 200,
  outputBytes: 100 * 1024 * 1024,
  /** Files and folders that Verifold looks at for the outputs of one run. */
  outputEntries: 10_000,
  /** Verifold copies a kept output in parts of this size, so its memory does not grow with the output. */
  copyPart: 1024 * 1024,
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
  'Local runs need the macOS sandbox, and this computer has none, so Verifold runs nothing here. Use a pod.';

export const noPodsText =
  'This Verifold runs nothing on pods. Run on this computer instead.';

/** Where a run runs: this computer, or the pod of a lease with its GPU type. */
export type RunPlace = 'local' | { readonly pod: string; readonly gpu: string };

/** A run's place in a few words, such as "local" or "on lease-2 (NVIDIA A40)". */
export function placeText(run: RunRecord): string {
  return run.where === 'local'
    ? 'local'
    : `on ${run.where.pod} (${run.where.gpu})`;
}

/** The pod of a lease does not run now, so a pod run there cannot go on. */
export class PodGoneError extends SessionActionError {}

/**
 * The pod work of runs, by lease and by the run's folder name. Each call
 * needs the lease's pod ready, and throws a PodGoneError otherwise. No error
 * holds the value of a pod secret. The texts of a job come as the pod gives
 * them: the ledger hides them with the run's guard.
 */
export interface PodRuns {
  /** The lease of a direction's run: `lease` when it is one of the direction's, or its newest ready lease. A lease whose pod stops or ends now takes no run. */
  pick(
    direction: string,
    lease?: unknown,
  ): { readonly lease: string; readonly gpu: string };
  /** The guard of the lease's secrets, for one run. It needs no ready pod. */
  guard(lease: string): Promise<SecretGuard>;
  /** Copy the run's folder to the pod. */
  send(lease: string, run: string, folder: string): Promise<void>;
  /** Start the run's script as a job in its folder on the pod. */
  start(lease: string, run: string, script: string): Promise<void>;
  state(lease: string, run: string): Promise<PodRunState>;
  stop(lease: string, run: string, signal: 'TERM' | 'KILL'): Promise<void>;
  /** The job's log as the pod wrote it: its first `head` and last `tail` bytes, and its size on the pod. */
  log(
    lease: string,
    run: string,
    head: number,
    tail: number,
  ): Promise<{
    readonly bytes: number;
    readonly head: Buffer;
    readonly tail: Buffer | null;
  }>;
  /** The `METRIC` lines of the job's log. */
  metrics(lease: string, run: string): Promise<string>;
  /** Remove the run's folder on the pod. */
  remove(lease: string, run: string): Promise<void>;
  /** Copy the paths that exist back into `folder`. A path that does not exist is left out. */
  fetch(
    lease: string,
    run: string,
    paths: readonly string[],
    folder: string,
  ): Promise<void>;
}

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
  /**
   * The run's own folder under `.verifold/workspaces`, such as
   * `run-3-1a2b3c4d`. No other run gets it, also after Start over, so a
   * process that outlived an earlier run cannot write in a later one.
   */
  readonly folder: string;
  readonly where: RunPlace;
}

/** One run for the sandbox to start. */
export interface SandboxSpec {
  readonly command: string;
  /** The run's folder, by its real path: the only place where the run writes. */
  readonly folder: string;
  /** The working folder: the commit's files, inside `folder`. */
  readonly cwd: string;
  /** Real paths of credential folders and files that the run cannot read. */
  readonly denied: readonly string[];
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
    // A later rule wins, so the denied paths stay closed. The run's own
    // folder stays open also inside a denied folder, such as `.verifold` for
    // a checker's run.
    ...(denied
      ? [
          `(deny file-read* ${Array.from({ length: denied }, (_, index) => `(subpath (param "DENY_${index}"))`).join(' ')})`,
          '(allow file-read* (subpath (param "RUN")))',
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
    ...spec.denied.flatMap((path, index) => ['-D', `DENY_${index}=${path}`]),
    '/bin/sh',
    '-c',
    spec.command,
  ],
});

/**
 * The sandbox of this computer: Seatbelt on macOS, or none. Other systems
 * run nothing locally until a sandbox there closes local sockets too.
 */
export function localSandbox(): Sandbox | null {
  return process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
    ? seatbelt
    : null;
}

/**
 * The credential paths that exist, and `more`, by their real paths, so a
 * link to one is closed too. A path is absolute or under `~/`.
 */
export async function deniedPaths(
  home = homedir(),
  more: readonly string[] = [],
): Promise<string[]> {
  const found = new Set<string>();
  for (const path of [...credentialPaths, ...more]) {
    const real = await realpath(
      path.startsWith('~/') ? join(home, path.slice(2)) : path,
    ).catch(() => null);
    if (real) found.add(real);
  }
  return [...found];
}

/** Variables that point at local sockets and desktop sessions. A run has no use for them. */
const sessionVariables = [
  'SSH_AUTH_SOCK',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
];

/**
 * The environment of a run: a child's environment without the keys of the
 * harnesses and the cloud accounts, which a run without network cannot use,
 * without Git's variables, and without local sockets. Git in the run finds no
 * repository above its folder, so a script that records the commit reads
 * `VERIFOLD_COMMIT`.
 */
function runEnvironment(run: RunRecord, folder: string): NodeJS.ProcessEnv {
  const environment = childEnvironment();
  for (const name of Object.keys(environment))
    if (
      /^(ANTHROPIC|OPENAI|CLAUDE|CODEX|AWS|AZURE|GOOGLE|GEMINI|GIT)_/.test(
        name,
      ) ||
      sessionVariables.includes(name)
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

/** Add the metric of a `METRIC name=value` line, up to the limit of names. */
function addMetric(metrics: Map<string, number | null>, line: string): void {
  const match = metricLine.exec(line.replace(/\r$/, ''));
  if (!match?.[1] || !match[2]) return;
  if (!metrics.has(match[1]) && metrics.size >= runLimits.metrics) return;
  const value = Number(match[2]);
  metrics.set(match[1], Number.isFinite(value) ? value : null);
}

/** A saved run record, or null when it is not valid. */
export function parseRun(
  value: Record<string, unknown> | null,
): RunRecord | null {
  if (!value) return null;
  const text = (field: unknown): field is string => typeof field === 'string';
  const time = (field: unknown): field is string | null =>
    field === null || (text(field) && !Number.isNaN(Date.parse(field)));
  const log = object(value.log);
  const leader = value.process === null ? null : object(value.process);
  const metrics = object(value.metrics);
  const outputs = Array.isArray(value.outputs) ? value.outputs : null;
  // Records from before pod runs ran locally.
  const pod = value.where === undefined ? null : object(value.where);
  const where: RunPlace | null =
    value.where === undefined || value.where === 'local'
      ? 'local'
      : pod &&
          text(pod.pod) &&
          /^lease-\d{1,6}$/.test(pod.pod) &&
          text(pod.gpu) &&
          pod.gpu.length <= 100
        ? { pod: pod.pod, gpu: pod.gpu }
        : null;
  if (
    !where ||
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
    typeof value.told !== 'boolean' ||
    !text(value.folder) ||
    !/^run-[1-9]\d{0,5}-[0-9a-f]{8}$/.test(value.folder)
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
    folder: value.folder,
    where,
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
    addMetric(this.metrics, line);
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
 * Open a file of a run's folder that no sandboxed process can change any
 * more: a regular file with one link on the folder's device, opened without
 * following a link. Null otherwise. The caller reads at most its limit, and
 * closes the handle.
 */
async function openKept(
  path: string,
  device: number,
): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  let kept = false;
  try {
    const stats = await handle.stat();
    kept = stats.isFile() && stats.nlink === 1 && stats.dev === device;
  } finally {
    if (!kept) await handle.close();
  }
  return kept ? handle : null;
}

/** A small file of a run's folder, as `openKept` opens it. Null for one that is not kept, or that is larger than `max`. */
async function readKept(
  path: string,
  device: number,
  max: number,
): Promise<Buffer | null> {
  const handle = await openKept(path, device);
  if (!handle) return null;
  try {
    // One byte more than `max` shows a file that is too large.
    const content = Buffer.alloc(max + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        content,
        size,
        content.length - size,
        null,
      );
      if (bytesRead === 0) return content.subarray(0, size);
      size += bytesRead;
      if (size > max) return null;
    }
  } finally {
    await handle.close();
  }
}

/**
 * What a copy of a kept output gives: its size and hash; 'held' when it
 * holds a secret value; null when the file grew past the limit during the
 * copy.
 */
type Copied =
  | { readonly bytes: number; readonly sha256: string }
  | 'held'
  | null;

/**
 * Copy an open kept file to `target`, `runLimits.copyPart` bytes at a time,
 * and hash it on the way. The copy goes to a temporary file in `folder`, on
 * the same disk, and only a copy that is kept gets its parent folders and its
 * name, so nothing else stays in the outputs. With a guard, the last bytes
 * that a later part could make a secret value of wait: as many as the
 * longest value has, and one more. So no byte of a secret value reaches the
 * disk, and memory stays under a part and that many bytes.
 */
async function copyKept(
  handle: FileHandle,
  folder: string,
  target: string,
  max: number,
  guard: SecretGuard | undefined,
): Promise<Copied> {
  const temporary = join(folder, `.${randomUUID()}.part`);
  const scan = guard?.stream();
  const hold = scan ? scan.longest + 1 : 0;
  const hash = createHash('sha256');
  const part = Buffer.allocUnsafe(runLimits.copyPart);
  let waiting = Buffer.alloc(0);
  let bytes = 0;
  let copied: Copied = null;
  try {
    const out = await open(temporary, 'wx', 0o600);
    try {
      for (;;) {
        const { bytesRead } = await handle.read(part, 0, part.length, null);
        if (bytesRead === 0) {
          await out.writeFile(waiting);
          copied = { bytes, sha256: hash.digest('hex') };
          break;
        }
        bytes += bytesRead;
        if (bytes > max) break;
        const read = part.subarray(0, bytesRead);
        if (scan?.holds(read)) {
          copied = 'held';
          break;
        }
        hash.update(read);
        if (read.length >= hold) {
          await out.writeFile(waiting);
          await out.writeFile(read.subarray(0, read.length - hold));
          waiting = Buffer.from(read.subarray(read.length - hold));
        } else {
          const joined = Buffer.concat([waiting, read]);
          const free = Math.max(0, joined.length - hold);
          await out.writeFile(joined.subarray(0, free));
          waiting = joined.subarray(free);
        }
      }
    } finally {
      await out.close();
    }
    if (copied === null || copied === 'held') return copied;
    const made = await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await rename(temporary, target);
    } catch (error) {
      // The folders that this copy made go with it.
      if (made)
        await rm(made, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return copied;
  } finally {
    // A cleanup that fails changes nothing that the run's note says.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Plain reasons for a move of a run's folder that failed, by error code. */
const moveErrors: Readonly<Record<string, string>> = {
  ENOENT: 'the folder is not there',
  EACCES: 'no permission to move it',
  EPERM: 'no permission to move it',
  EBUSY: 'the folder is in use',
  EEXIST: 'a kept folder of that name is there already',
  ENOTEMPTY: 'a kept folder of that name is there already',
};

/** Why the move of a run's folder failed, in a few words. */
function moveError(error: unknown): string {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  return moveErrors[code] ?? 'the move failed';
}

/** A run's process while it runs. */
interface Live {
  /** The local process group's leader. Null for a job on a pod. */
  readonly pid: number | null;
  /** Why Verifold stopped it, when it did. */
  stop: 'timed-out' | 'cancelled' | 'interrupted' | null;
  timer: NodeJS.Timeout | undefined;
  kill: NodeJS.Timeout | undefined;
  /** A pod run's wait for its next read of the job. A stop ends the wait. */
  wake: (() => void) | undefined;
}

/** The log of a run that ended: its size, whether a part was cut, and its metrics. */
interface LogResult {
  readonly bytes: number;
  readonly cut: boolean;
  readonly metrics: ReadonlyMap<string, number | null>;
}

const noLog: LogResult = { bytes: 0, cut: false, metrics: new Map() };

/** What a run that left nothing behind gives. */
function noCollected(): { readonly kept: Collected; readonly log: LogResult } {
  return { kept: { metrics: new Map(), outputs: [], note: null }, log: noLog };
}

/** The note when the stop of a pod run's job did not reach its pod. */
const unreachedText =
  'Verifold could not reach the pod to stop the job. The job can continue to run until the pod stops.';

export interface RunLedgerOptions {
  /** Null: this computer has no sandbox, so local runs are refused. */
  readonly sandbox: Sandbox | null;
  /** The pods of the project's leases. Without it, pod runs are refused. */
  readonly pods?: PodRuns;
  /** The time between two reads of a pod run's job. */
  readonly pollMs?: number;
  /** How long the stop of a pod waits for its runs to copy their outputs back. */
  readonly podStopMs?: number;
  /** The lab's queue. Every change of a record runs in it. */
  readonly serial: <T>(work: () => T | Promise<T>) => Promise<T>;
  /**
   * A run ended. In the lab's queue. Returns true when its agent heard it.
   * Not called for a run that ended before its `start` call returned: that
   * call's caller tells the agent, then calls `told`.
   */
  readonly ended: (run: RunRecord) => boolean;
  /** One minute: of a run's time limit, of the time that a stopped job gets to end, and of the 10 minutes that a pod can be out of reach. */
  readonly minuteMs?: number;
  /** The home folder whose credential paths a run cannot read. */
  readonly home?: string;
  /** More paths that a run cannot read: absolute, or under `~/`. */
  readonly denyRead?: readonly string[];
  /** A line for the person, such as a record that could not be saved. */
  readonly progress?: (line: string) => void;
}

export class RunLedger {
  private readonly root: string;
  private readonly options: RunLedgerOptions;
  private readonly records = new Map<string, RunRecord>();
  private readonly live = new Map<string, Live>();
  /** Runs whose folder is made now. A stop that comes meanwhile waits here. */
  private readonly starting = new Map<string, Live['stop']>();
  /** The work of each run from its start to its end, by run ID. Close waits for it. */
  private readonly work = new Map<string, Promise<void>>();
  /** The record that each `start` call waits for, by run ID, until the run starts or ends. Its caller tells the agent how such a run ended. */
  private readonly waiting = new Map<string, Promise<RunRecord>>();
  /** The background work that ends the pod runs of an earlier owner. */
  private recovering: Promise<void> | null = null;
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

  /** The records of the runs. */
  private get store(): string {
    return join(this.root, '.verifold', 'lab', 'runs');
  }

  /** A run's record folder, with its log and outputs. */
  private record(id: string): string {
    return join(this.store, id);
  }

  /** A run's folder, where the sandbox writes, and where it moves when the run ends. */
  private trees(run: RunRecord): {
    readonly folder: string;
    readonly kept: string;
  } {
    const workspaces = join(this.root, '.verifold', 'workspaces');
    return {
      folder: join(workspaces, run.folder),
      // Outside the sandbox's writable path: a component that the run's folder name does not start.
      kept: join(workspaces, `${run.folder}.done`),
    };
  }

  /**
   * Read the records. With `recover`, in the project's owner: a run that an
   * earlier owner left starting or running ends. A local one ends as
   * interrupted, and its process group stops when its PID and start time
   * match. A pod run's job is read: a job that ended gives its result, and
   * one that runs stops. Its outputs come back, and its folder goes.
   */
  async load(recover: boolean): Promise<void> {
    this.records.clear();
    this.last = 0;
    this.closed = false;
    let names: string[] = [];
    try {
      names = await readdir(this.store);
    } catch {
      /* No run yet. */
    }
    for (const name of names.filter((entry) => runId.test(entry))) {
      this.last = Math.max(this.last, number(name));
      let value: Record<string, unknown> | null = null;
      try {
        const path = join(this.record(name), 'run.json');
        const stats = await lstat(path);
        if (stats.isFile() && stats.size <= 1_000_000)
          value = object(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        /* A record that cannot be read is skipped. */
      }
      const run = parseRun(value);
      if (run?.id === name) this.records.set(run.id, run);
    }
    this.recovering = null;
    if (!recover) return;
    const left = [...this.records.values()].filter(
      (run) =>
        runActive(run) && !this.live.has(run.id) && !this.starting.has(run.id),
    );
    for (const run of left.filter((entry) => entry.where === 'local')) {
      if (run.process)
        await stopRecordedProcess(run.process.pid, run.process.processStart);
      // A folder that cannot go stays. The record ends all the same.
      await this.clear(run).catch(() => {});
      const next: RunRecord = {
        ...run,
        status: 'interrupted',
        endedAt: new Date().toISOString(),
        note: 'Verifold stopped while the run ran.',
      };
      this.records.set(run.id, next);
      await this.save(next).catch(() => {});
    }
    // A pod run's job is read in the background: a pod that answers slowly holds up no start and no other run. Close waits for it.
    const pods = left.flatMap((run) =>
      run.where === 'local' ? [] : [this.recoverPod(run, run.where.pod)],
    );
    if (pods.length) this.recovering = Promise.all(pods).then(() => {});
  }

  /**
   * The background work that ends the pod runs of an earlier owner, or null
   * when there is none. Lease recovery waits for it, because it stops pods.
   */
  get pending(): Promise<void> | null {
    return this.recovering;
  }

  /**
   * A pod run that an earlier owner left, as owned background work: a job
   * that ended gives its exit code, and a job that runs stops as
   * interrupted. Then its outputs and log come back, as far as the pod still
   * answers, and the run ends in the lab's queue. A job that left no file
   * did not start, so its run takes no outputs and its copy goes.
   */
  private recoverPod(run: RunRecord, lease: string): Promise<void> {
    const work = (async () => {
      const pods = this.options.pods;
      let exit: Exit = { code: null, signal: null, error: null };
      let stop: Live['stop'] = 'interrupted';
      let note = 'Verifold stopped while the run ran.';
      // The pod answered, so its files can come back.
      let reached = false;
      // A SIGKILL that the pod answered reached the job's process group.
      let killed = false;
      // The job's state once a read showed its end. Null: no read did.
      let state: PodRunState | null = null;
      // The job ran: a read found its files. Without a read, only a run that was running did.
      let ran = run.status !== 'queued';
      // The job ended by itself before Verifold read it, so its exit code counts. A job that Verifold stopped is interrupted.
      let done = false;
      const guard = pods ? await pods.guard(lease) : null;
      if (pods)
        try {
          state = await pods.state(lease, run.folder);
          reached = true;
          ran = state.state !== 'none';
          done = state.state === 'done';
          if (state.state === 'running')
            state = await this.stopJob(pods, lease, run.folder);
        } catch (error) {
          note = `Verifold stopped while the run ran, and could not read its job on the pod after: ${error instanceof Error ? error.message : 'unknown error'}`;
          // A job that can still run gets a stop. A pod that answers it shows what the job did.
          const stopped = await this.stopLost(pods, lease, run.folder);
          if (stopped === 'unreached') note = `${note} ${unreachedText}`;
          if (stopped === 'stopped') {
            reached = true;
            killed = true;
            state = await this.endState(pods, lease, run.folder);
            if (state) ran = state.state !== 'none';
          }
        }
      if (done && state?.state === 'done') {
        stop = null;
        exit = { code: state.exit, signal: null, error: null };
      } else if (state?.state === 'gone')
        note = `${note} The job on the pod ended without an exit code, so how it ended is not known.`;
      else if (state?.state === 'none')
        note =
          run.status === 'queued'
            ? 'Verifold stopped before the run started.'
            : 'Verifold stopped while the run ran, and the pod has no file of its job.';
      let collected = noCollected();
      if (pods && guard && reached) {
        // A job that did not start leaves only the copy of the commit, which is no output.
        if (state?.state === 'none')
          await pods.remove(lease, run.folder).catch(() => {});
        else
          collected = await this.collectPod(
            run,
            pods,
            lease,
            guard,
            { killed, ended: state !== null },
            ran,
          );
      }
      // A folder that cannot go stays. The record ends all the same.
      await this.clear(run).catch(() => {});
      await this.end(run, {
        exit,
        stop,
        kept: {
          ...collected.kept,
          note:
            [stop ? note : '', collected.kept.note ?? '']
              .filter(Boolean)
              .join(' ') || null,
        },
        log: collected.log,
      });
    })()
      .catch(() => {
        /* The record stays as it was. The next start reads it again. */
      })
      .finally(() => this.work.delete(run.id));
    this.work.set(run.id, work);
    return work;
  }

  /**
   * Stop a pod run's job: SIGTERM to its process group, then SIGKILL after
   * the grace time, again each second until the job ends or a minute passed.
   * Returns its last state, or null when it did not end.
   */
  private async stopJob(
    pods: PodRuns,
    lease: string,
    folder: string,
  ): Promise<PodRunState | null> {
    const from = Date.now();
    await pods.stop(lease, folder, 'TERM').catch(() => {});
    while (Date.now() - from < (this.options.minuteMs ?? 60_000)) {
      await delay(500);
      const state = await pods.state(lease, folder).catch(() => null);
      if (state && state.state !== 'running') return state;
      if (Date.now() - from >= runLimits.graceMs)
        await pods.stop(lease, folder, 'KILL').catch(() => {});
    }
    return null;
  }

  /**
   * The state of a pod run's job once a read shows that it ended, after a
   * stop. Null when no read shows that within 10 seconds.
   */
  private async endState(
    pods: PodRuns,
    lease: string,
    folder: string,
  ): Promise<PodRunState | null> {
    for (let tries = 0; tries < 20; tries++) {
      const state = await pods.state(lease, folder).catch(() => null);
      if (state && state.state !== 'running') return state;
      await delay(Math.min(500, this.options.pollMs ?? 500));
    }
    return null;
  }

  /**
   * Stop the job of a pod run that Verifold lost sight of. `stopped`: the
   * pod answered the stop. `gone`: the pod does not run, so the job ended
   * with it. `unreached`: the pod did not answer, so the job can still run.
   */
  private stopLost(
    pods: PodRuns,
    lease: string,
    folder: string,
  ): Promise<'stopped' | 'gone' | 'unreached'> {
    return pods.stop(lease, folder, 'KILL').then(
      () => 'stopped' as const,
      (error: unknown) =>
        error instanceof PodGoneError
          ? ('gone' as const)
          : ('unreached' as const),
    );
  }

  /**
   * Refuse a pod run when the direction has no lease to run it on, before
   * the agent's folder is committed for it.
   */
  podFor(direction: string, lease?: unknown): void {
    (this.options.pods ?? fail(noPodsText)).pick(direction, lease);
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
   * Start a run of `command` on `commit` of the agent's folder, on this
   * computer or on a pod of the direction's leases. The record comes first,
   * in the lab's queue. Then the run's folder and its process or its job,
   * outside it. Returns once the process or the job started, or the run
   * failed to start. A repeated call with the same key gets the first run.
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
    /** Default: local. */
    readonly where?: 'local' | 'pod';
    /** On a pod: the lease to use. Default: the direction's newest ready lease. */
    readonly lease?: unknown;
    /** Real paths that a local run cannot read, besides the credential paths, such as the lab's records for a checker's run. */
    readonly deny?: readonly string[];
    /** Throws when the run may not start now. It runs in the lab's queue, in the step that records the run. */
    readonly may?: () => void;
  }): Promise<RunRecord> {
    const runner =
      input.where === 'pod'
        ? { pods: this.options.pods ?? fail(noPodsText) }
        : { sandbox: this.options.sandbox ?? fail(noSandboxText) };
    let started!: (run: RunRecord) => void;
    const ready = new Promise<RunRecord>((resolve) => {
      started = resolve;
    });
    const made = await this.options.serial(async () => {
      const known = [...this.records.values()].find(
        (run) => run.agent === input.agent && run.key === input.key,
      );
      if (known) return { run: known, known: true, lease: null };
      if (this.closed)
        fail('Verifold stops or moves the lab now, so no run starts.');
      input.may?.();
      this.room(input.agent);
      const place =
        'pods' in runner
          ? runner.pods.pick(input.direction, input.lease)
          : undefined;
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
        folder: `run-${number(id)}-${randomBytes(4).toString('hex')}`,
        where: place ? { pod: place.lease, gpu: place.gpu } : 'local',
      };
      // The run counts from the step that picked its pod, so a stop of that pod that begins while the record saves ends it too.
      this.records.set(id, run);
      this.starting.set(id, null);
      this.waiting.set(id, ready);
      try {
        await mkdir(this.record(id), { recursive: true, mode: 0o700 });
        await this.save(run);
      } catch (error) {
        this.records.delete(id);
        this.starting.delete(id);
        this.waiting.delete(id);
        throw error;
      }
      return { run, known: false, lease: place?.lease ?? null };
    });
    // A repeated call waits with the first one, so both get the run as it started, or as it ended at once.
    if (made.known)
      return (
        this.waiting.get(made.run.id) ??
        this.records.get(made.run.id) ??
        made.run
      );
    const report = (run: RunRecord): void => {
      this.waiting.delete(made.run.id);
      started(run);
    };
    const work = (
      'pods' in runner
        ? this.executePod(
            made.run,
            runner.pods,
            made.lease ?? '',
            input.workspace,
            report,
          )
        : this.execute(
            made.run,
            runner.sandbox,
            input.workspace,
            report,
            input.deny ?? [],
          )
    )
      .catch(() => {
        /* The run's end records what failed. */
      })
      .finally(() => {
        this.work.delete(made.run.id);
        // The caller never waits for good, also when the end's record failed.
        report(this.records.get(made.run.id) ?? made.run);
      });
    this.work.set(made.run.id, work);
    return ready;
  }

  /** The run's state as running, once its process or its job started. In the lab's queue. */
  private markRunning(
    run: RunRecord,
    process: RunRecord['process'],
  ): Promise<RunRecord> {
    return this.options.serial(async () => {
      const next: RunRecord = {
        ...(this.records.get(run.id) ?? run),
        status: 'running',
        startedAt: new Date().toISOString(),
        process,
      };
      this.records.set(run.id, next);
      await this.save(next).catch(() => {});
      return next;
    });
  }

  /** The run from its folder to its end. `started` gets the record once the process runs, or once the run ended. */
  private async execute(
    run: RunRecord,
    sandbox: Sandbox,
    workspace: Workspace,
    started: (run: RunRecord) => void,
    deny: readonly string[],
  ): Promise<void> {
    const paths = this.trees(run);
    let log: RunLog | null = null;
    // Verifold stopped the run. Its exit code then does not count.
    let stop: Live['stop'] = null;
    let exit: Exit = { code: null, signal: null, error: null };
    // The process started, so its folder holds its work.
    let ran = false;
    try {
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
        denied: [
          ...(await deniedPaths(this.options.home, this.options.denyRead)),
          ...deny,
        ],
      });
      log = new RunLog(
        await open(join(this.record(run.id), 'log.txt'), 'w', 0o600),
      );
      stop = this.starting.get(run.id) ?? null;
      if (stop) return;
      const child = spawn(file, args, {
        cwd: join(folder, 'tree'),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runEnvironment(run, folder),
      });
      const exited = new Promise<Exit>((resolve) => {
        child.once('error', (error) =>
          resolve({ code: null, signal: null, error: error.message }),
        );
        child.once('exit', (code, signal) =>
          resolve({ code, signal, error: null }),
        );
      });
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
          wake: undefined,
        };
        this.live.set(run.id, live);
        this.starting.delete(run.id);
        live.timer = setTimeout(
          () => this.halt(run.id, 'timed-out'),
          run.minutes * (this.options.minuteMs ?? 60_000),
        );
        live.timer.unref();
        started(
          await this.markRunning(run, {
            pid,
            processStart: await processStart(pid),
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
        signal: null,
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
      await this.clear(run).catch(() => {});
      started(
        await this.end(run, {
          exit,
          stop,
          kept,
          log: {
            bytes: log?.bytes ?? 0,
            cut,
            metrics: log?.metrics ?? new Map(),
          },
        }),
      );
    }
  }

  /**
   * A pod run from its folder to its end: copy the commit to the pod, start
   * the job, and read its state until it ends. A stop sends SIGTERM to the
   * job's process group, then SIGKILL after the grace time. At the end, the
   * outputs and the log come back. `started` gets the record once the job
   * runs, or once the run ended.
   */
  private async executePod(
    run: RunRecord,
    pods: PodRuns,
    lease: string,
    workspace: Workspace,
    started: (run: RunRecord) => void,
  ): Promise<void> {
    const tree = join(this.trees(run).folder, 'tree');
    let stop: Live['stop'] = null;
    let exit: Exit = { code: null, signal: null, error: null };
    let note: string | null = null;
    // The pod can hold the run's copy of the commit, or a part of one.
    let sent = false;
    // Verifold asked the pod to start the job. A start that fails can still have started it.
    let asked = false;
    // The job started, so the pod holds its work.
    let ran = false;
    // The pod answered to the end. A pod that does not answer gives nothing back.
    let reached = true;
    // A read showed the end of the job, and a SIGKILL reached its process group.
    let ended = false;
    let killed = false;
    let live: Live | undefined;
    // The lease's secrets as the run starts. They hide in its texts and keep its outputs clean to its end, also after the lease closes.
    let guard: SecretGuard | null = null;
    try {
      guard = await pods.guard(lease);
      await mkdir(tree, { recursive: true, mode: 0o700 });
      await checkoutAt(this.root, workspace, run.commit, tree);
      // A committed metrics.json is not this run's result. The run writes its own.
      await rm(join(tree, 'metrics.json'), { force: true }).catch(() => {});
      stop = this.starting.get(run.id) ?? null;
      if (stop) return;
      sent = true;
      await pods.send(lease, run.folder, tree);
      // The outputs come back into an empty folder.
      await rm(tree, { recursive: true, force: true });
      await mkdir(tree, { mode: 0o700 });
      stop = this.starting.get(run.id) ?? null;
      if (stop) return;
      asked = true;
      await pods.start(
        lease,
        run.folder,
        `export VERIFOLD_RUN=${run.id} VERIFOLD_COMMIT=${run.commit}\n${run.command}\n`,
      );
      ran = true;
      live = {
        pid: null,
        // A stop that came while the job started. Its first read sends it.
        stop: this.starting.get(run.id) ?? null,
        timer: undefined,
        kill: undefined,
        wake: undefined,
      };
      this.live.set(run.id, live);
      this.starting.delete(run.id);
      live.timer = setTimeout(
        () => this.halt(run.id, 'timed-out'),
        run.minutes * (this.options.minuteMs ?? 60_000),
      );
      live.timer.unref();
      started(await this.markRunning(run, null));
      ({ exit, note, reached, ended, killed } = await this.watch(
        run,
        pods,
        lease,
        live,
        guard,
      ));
      stop = live.stop;
    } catch (error) {
      exit = {
        code: null,
        signal: null,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    } finally {
      this.live.delete(run.id);
      this.starting.delete(run.id);
      clearTimeout(live?.timer);
      if (asked && (!ran || !reached)) {
        // A job whose start failed, or that Verifold lost sight of, must not hold the GPU unwatched. A pod that answers the stop gives the log back.
        const stopped = await this.stopLost(pods, lease, run.folder);
        if (stopped === 'unreached')
          note = note ? `${note} ${unreachedText}` : unreachedText;
        reached = stopped === 'stopped';
        killed = reached;
        ended =
          reached && (await this.endState(pods, lease, run.folder)) !== null;
      }
      // Only a job that started has outputs.
      const collected =
        asked && reached && guard
          ? await this.collectPod(
              run,
              pods,
              lease,
              guard,
              { killed, ended },
              ran,
            )
          : noCollected();
      // A job that Verifold did not ask to start leaves no copy of the commit on the pod.
      if (sent && !asked) await pods.remove(lease, run.folder).catch(() => {});
      await this.clear(run).catch(() => {});
      started(
        await this.end(run, {
          exit,
          stop,
          kept: {
            ...collected.kept,
            note:
              [note ?? '', collected.kept.note ?? '']
                .filter(Boolean)
                .join(' ') || null,
          },
          log: collected.log,
        }),
      );
    }
  }

  /**
   * Read a pod run's job until it ends. Each read keeps the end of its log
   * in log.txt. A stop sends SIGTERM, then SIGKILL after the grace time and
   * again with each read. A job that a stop does not end in a minute, a pod
   * that stops, or 10 minutes of failed reads end the run as interrupted.
   * `reached`: the pod answered to the end. `ended`: a read showed the end
   * of the job. `killed`: a SIGKILL reached the pod.
   */
  private async watch(
    run: RunRecord,
    pods: PodRuns,
    lease: string,
    live: Live,
    guard: SecretGuard,
  ): Promise<{
    readonly exit: Exit;
    readonly note: string | null;
    readonly reached: boolean;
    readonly ended: boolean;
    readonly killed: boolean;
  }> {
    const none: Exit = { code: null, signal: null, error: null };
    const minute = this.options.minuteMs ?? 60_000;
    let failing: number | null = null;
    let termAt: number | null = null;
    // A stop that reached the pod, and a SIGKILL that did.
    let stopped = false;
    let killed = false;
    const send = async (signal: 'TERM' | 'KILL'): Promise<void> => {
      try {
        await pods.stop(lease, run.folder, signal);
        stopped = true;
        if (signal === 'KILL') killed = true;
      } catch {
        /* The reads tell whether the pod answers. */
      }
    };
    for (;;) {
      if (live.stop && termAt === null) {
        termAt = Date.now();
        await send('TERM');
      } else if (termAt !== null && Date.now() - termAt >= runLimits.graceMs)
        await send('KILL');
      if (termAt !== null && Date.now() - termAt >= minute)
        return failing !== null || !stopped
          ? // The stop did not reach the pod. The run's end tries once more, and says when the job can still run.
            { exit: none, note: null, reached: false, ended: false, killed }
          : {
              exit: none,
              note: 'The job on the pod did not end after SIGKILL.',
              reached: true,
              ended: false,
              killed,
            };
      try {
        const state = await pods.state(lease, run.folder);
        failing = null;
        // The tail is cut from a longer log, and its end is still written.
        await writePrivateFile(
          join(this.record(run.id), 'log.txt'),
          guard.hideBytes(state.tail, { start: true, end: true }),
        ).catch(() => {});
        if (state.state === 'done')
          return {
            exit: { code: state.exit, signal: null, error: null },
            note: null,
            reached: true,
            ended: true,
            killed,
          };
        if (state.state !== 'running')
          return {
            exit: none,
            note: 'The job on the pod ended without an exit code, for example when the pod ran out of memory or started again.',
            reached: true,
            ended: true,
            killed,
          };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'unknown error';
        failing ??= Date.now();
        if (
          error instanceof PodGoneError ||
          Date.now() - failing >= 10 * minute
        ) {
          live.stop ??= 'interrupted';
          return {
            exit: none,
            note:
              error instanceof PodGoneError
                ? message
                : `Verifold could not reach the pod for 10 minutes: ${message}`,
            reached: false,
            ended: false,
            killed,
          };
        }
      }
      // A stop that came during the read is sent at once.
      if (live.stop && termAt === null) continue;
      // The next read, sooner while a stop waits for the job. A stop ends the wait.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          termAt === null ? (this.options.pollMs ?? 20_000) : 1_000,
        );
        timer.unref();
        live.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      live.wake = undefined;
    }
  }

  /**
   * After a pod run: stop what is left of its process group, unless a
   * SIGKILL reached it already. Then copy its metrics.json and each named
   * output back into its empty folder, one at a time, and take them as a
   * local run's, with the guard's check of each file. A job that did not
   * start right has no outputs: only its log comes back. Then copy its log
   * and its metric lines, hidden with the guard. The run's folder and job
   * files on the pod go only when every copy worked and a read showed the
   * end of the job. Otherwise they stay on the pod until the lease ends.
   */
  private async collectPod(
    run: RunRecord,
    pods: PodRuns,
    lease: string,
    guard: SecretGuard,
    job: { readonly killed: boolean; readonly ended: boolean },
    outputs = true,
  ): Promise<{ readonly kept: Collected; readonly log: LogResult }> {
    const notes: string[] = [];
    const tree = join(this.trees(run).folder, 'tree');
    // A process that the job left in the background stops with it, as for a local run.
    if (!job.killed) await pods.stop(lease, run.folder, 'KILL').catch(() => {});
    // A folder that cannot be made fails each copy below, and the note says so.
    await mkdir(tree, { recursive: true, mode: 0o700 }).catch(() => {});
    // Each entry comes on its own, so one that is too large or fails leaves the others.
    const failed: string[] = [];
    for (const path of outputs ? ['metrics.json', ...run.want] : [])
      try {
        await pods.fetch(lease, run.folder, [path], tree);
      } catch (error) {
        failed.push(path);
        notes.push(
          `Verifold could not copy ${path} back: ${guard.hide(error instanceof Error ? error.message : 'unknown error')}`,
        );
      }
    const kept: Collected = outputs
      ? await this.keep(run, guard, failed).catch((error: unknown) => ({
          metrics: new Map<string, number | null>(),
          outputs: [],
          note: `Verifold could not read the copied outputs: ${error instanceof Error ? error.message : 'unknown error'}`,
        }))
      : { metrics: new Map(), outputs: [], note: null };
    let log: LogResult = noLog;
    let logged = false;
    try {
      const head = runLimits.logBytes - runLimits.logTail;
      const got = await pods.log(lease, run.folder, head, runLimits.logTail);
      const metrics = new Map<string, number | null>();
      // The lines come from the end of a longer list.
      for (const line of guard
        .hide(await pods.metrics(lease, run.folder), { start: true })
        .split('\n'))
        addMetric(metrics, line);
      // The log keeps the pod's bytes. Hidden secrets change their size, so the cut line counts only the bytes that it leaves out.
      const start = guard.hideBytes(got.head, { end: true });
      await writePrivateFile(
        join(this.record(run.id), 'log.txt'),
        got.tail === null
          ? start
          : Buffer.concat([
              start,
              Buffer.from(
                `\n[Verifold cut ${Math.max(0, got.bytes - got.head.length - got.tail.length)} bytes of the log here. The end of the log follows.]\n`,
              ),
              guard.hideBytes(got.tail, { start: true, end: true }),
            ]),
      );
      log = { bytes: got.bytes, cut: got.tail !== null, metrics };
      logged = true;
    } catch (error) {
      notes.push(
        `Verifold could not copy the log back: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    // A job that can still run keeps the files that a later stop reads, and a failed copy keeps what it did not bring back.
    if (failed.length || !logged || !job.ended)
      notes.push(
        `The run's files stay on the pod in /root/verifold/${run.folder} and /root/verifold/.runs until its lease ends.`,
      );
    else await pods.remove(lease, run.folder).catch(() => {});
    return {
      kept: {
        ...kept,
        note: [...notes, kept.note ?? ''].filter(Boolean).join(' ') || null,
      },
      log,
    };
  }

  /** The record of a run that ended. */
  private result(
    run: RunRecord,
    outcome: {
      readonly exit: Exit;
      readonly stop: Live['stop'];
      readonly kept: Collected;
      readonly log: LogResult;
    },
  ): RunRecord {
    const { exit, stop, kept, log } = outcome;
    const metrics = [...new Map([...log.metrics, ...kept.metrics])].slice(
      0,
      runLimits.metrics,
    );
    return {
      ...run,
      status:
        stop ?? (exit.error === null && exit.code === 0 ? 'done' : 'failed'),
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
      log: { bytes: log.bytes, cut: log.cut },
      cancelledBy:
        stop === 'cancelled' ? (this.cancelled.get(run.id) ?? null) : null,
      note:
        [
          exit.error ? `The run did not start: ${exit.error}` : '',
          // Such as an out-of-memory kill or a crash: no exit code.
          exit.signal && !stop ? `Killed by ${exit.signal}.` : '',
          stop === 'cancelled' && this.reasons.get(run.id)
            ? `Cancelled: ${this.reasons.get(run.id)}`
            : '',
          kept.note ?? '',
        ]
          .filter(Boolean)
          .join(' ') || null,
    };
  }

  /**
   * Record a run's end in the lab's queue, then tell its agent. Two writes:
   * the end first, then that the agent heard it. So no reader of the
   * records, and no owner after a restart, finds a run running that its
   * agent knows ended. A crash between the two writes tells the agent once
   * more after the restart, and never loses the end: the agent hears it at
   * least once, not at most once. A write that fails says so in the
   * progress line.
   */
  private end(
    run: RunRecord,
    outcome: Parameters<RunLedger['result']>[1],
  ): Promise<RunRecord> {
    return this.options.serial(async () => {
      const next = this.result(this.records.get(run.id) ?? run, outcome);
      this.cancelled.delete(run.id);
      this.reasons.delete(run.id);
      this.records.set(run.id, next);
      await this.saveOrSay(
        next,
        `Verifold could not save the end of ${next.id}`,
      );
      // A run that ended before its start call returned: the caller tells the agent, and marks it as heard.
      if (this.waiting.has(run.id) || !this.options.ended(next)) return next;
      const told = { ...next, told: true };
      this.records.set(run.id, told);
      await this.saveOrSay(
        told,
        `Verifold could not save that the agent heard the end of ${next.id}, so it can hear it once more after a restart`,
      );
      return told;
    });
  }

  /** Save a record. A failure goes to the progress line, after `what`. */
  private async saveOrSay(run: RunRecord, what: string): Promise<void> {
    await this.save(run).catch((error: unknown) => {
      this.options.progress?.(
        `${what}: ${error instanceof Error ? error.message : 'unknown error'}.`,
      );
    });
  }

  /**
   * After the run: move its folder out of the sandbox's writable path, then
   * read `metrics.json` and copy the named outputs from it. Only regular
   * files with one link count, and no link is followed. With a guard, a file
   * whose name or content holds a secret value is not kept, whatever brought
   * it into the folder. `uncopied` are outputs that a pod run could not copy
   * back: they are not missing.
   */
  private async keep(
    run: RunRecord,
    guard?: SecretGuard,
    uncopied: readonly string[] = [],
  ): Promise<Collected> {
    const paths = this.trees(run);
    const collected: Collected = {
      metrics: new Map(),
      outputs: [],
      note: null,
    };
    try {
      await rename(paths.folder, paths.kept);
    } catch (error) {
      return {
        ...collected,
        note: `Verifold could not keep the run's folder (${moveError(error)}), so it read no metrics.json and kept no outputs.`,
      };
    }
    const top = await lstat(paths.kept);
    const tree = await lstat(join(paths.kept, 'tree')).catch(() => null);
    if (!top.isDirectory() || !tree?.isDirectory() || tree.dev !== top.dev)
      return {
        ...collected,
        note: 'The run replaced its folder, so Verifold read no metrics.json and kept no outputs.',
      };
    const base = join(paths.kept, 'tree');
    const json = await readKept(
      join(base, 'metrics.json'),
      top.dev,
      runLimits.metricsFile,
    );
    if (json && guard?.holds(json))
      collected.note =
        'metrics.json holds the value of a pod secret, so Verifold took no metrics from it.';
    else if (json) {
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
    // Files that hold a secret value in their content, and how many in their name, which no note shows.
    const held: string[] = [];
    let named = 0;
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
        // A folder counts as copied once a file in it is, also by an earlier, more specific entry.
        if (names.some((name) => copied.has(`${rel}/${name}`))) copied.add(rel);
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
        const handle = await openKept(path, top.dev);
        if (!handle) return;
        try {
          if (guard?.holds(rel)) {
            named++;
            copied.add(rel);
            return;
          }
          const record = this.record(run.id);
          const kept = await copyKept(
            handle,
            record,
            join(record, 'outputs', rel),
            runLimits.outputBytes - bytes,
            guard,
          );
          // The file grew past the limit while Verifold copied it.
          if (!kept) {
            full = true;
            return;
          }
          copied.add(rel);
          if (kept === 'held') {
            held.push(rel);
            return;
          }
          bytes += kept.bytes;
          collected.outputs.push({
            path: rel,
            bytes: kept.bytes,
            sha256: kept.sha256,
          });
        } finally {
          await handle.close();
        }
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
      if (
        collected.outputs.length === before &&
        !full &&
        !copied.has(rel) &&
        !uncopied.includes(rel)
      )
        missing.push(rel);
    }
    const notes = [
      collected.note ?? '',
      missing.length ? `No output file at ${missing.join(', ')}.` : '',
      held.length
        ? `Verifold kept no copy of ${held.slice(0, 5).join(', ')}, because ${held.length === 1 ? 'it holds' : 'they hold'} the value of a pod secret.`
        : '',
      named
        ? `Verifold kept no copy of ${named} ${named === 1 ? 'file' : 'files'} whose name holds the value of a pod secret.`
        : '',
      failed.length
        ? `Verifold could not copy ${failed.slice(0, 5).join(', ')}.`
        : '',
      full
        ? `The outputs stop at ${runLimits.outputFiles} files, ${runLimits.outputBytes / 1024 / 1024} MB, or ${runLimits.outputEntries} entries.`
        : '',
    ].filter(Boolean);
    // A path that the run made can hold a value too.
    const note = notes.join(' ');
    return {
      ...collected,
      note: note ? (guard ? guard.hide(note) : note) : null,
    };
  }

  /**
   * Remove a run's folder and its kept copy. Neither removal follows a link.
   * A run can leave folders without write permission, so a removal that
   * fails makes the folders writable for their owner and tries once more.
   */
  private async clear(run: RunRecord): Promise<void> {
    const paths = this.trees(run);
    for (const path of [paths.folder, paths.kept])
      await rm(path, { recursive: true, force: true }).catch(async () => {
        await writable(path);
        await rm(path, { recursive: true, force: true });
      });
  }

  /**
   * Stop a run: SIGTERM to its process group, then SIGKILL after the grace
   * time. A run whose folder is made now stops before its process starts. A
   * pod run's reads of its job send the signals.
   */
  private halt(id: string, why: NonNullable<Live['stop']>): void {
    if (this.starting.has(id)) {
      if (!this.starting.get(id)) this.starting.set(id, why);
      return;
    }
    const live = this.live.get(id);
    if (!live || live.stop) return;
    live.stop = why;
    if (live.pid === null) {
      live.wake?.();
      return;
    }
    const pid = live.pid;
    signalGroup(pid, 'SIGTERM');
    live.kill = setTimeout(
      () => signalGroup(pid, 'SIGKILL'),
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
    await Promise.all(this.work.values());
  }

  /**
   * The pod of a lease stops: its runs end as interrupted, and the stop
   * waits until their outputs and logs came back and each record is final,
   * or two minutes passed. The lease holds as stopping meanwhile, so `pick`
   * starts no run on it.
   */
  async podStops(lease: string): Promise<void> {
    const runs = [...this.records.values()].filter(
      (run) =>
        runActive(run) && run.where !== 'local' && run.where.pod === lease,
    );
    for (const run of runs) this.halt(run.id, 'interrupted');
    // The stop of the pod waits for the copies at most `podStopMs`, so a spend limit or an end is not held up for long.
    await Promise.race([
      Promise.all(
        runs.flatMap((run) => {
          const work = this.work.get(run.id);
          return work ? [work] : [];
        }),
      ),
      delay(this.options.podStopMs ?? 120_000, undefined, { ref: false }),
    ]);
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
        join(this.record(id), 'log.txt'),
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
      join(this.record(run.id), 'run.json'),
      `${JSON.stringify(run, null, 2)}\n`,
    );
  }
}

/** How a run's process ended, or why it did not start. */
interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: string | null;
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
