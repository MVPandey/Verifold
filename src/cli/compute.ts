import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  KeyStore,
  validKey,
  type KeyPlace,
  type KeyStatus,
} from './credentials.ts';
import { RunPod, type GpuOffer } from './runpod.ts';
import { Leases, isOpen, type Budget, type Lease } from './leases.ts';
import { PodShell, podLimits, type PodTarget } from './pod-shell.ts';
import type { AgentTool } from './session-hosts.ts';
import type { PodTools, TaskPlace } from './tasks.ts';
import { SessionActionError } from './session.ts';

/** Limits for pods in one project. Only the person changes them. Without a spend limit, pods stay off. */
export interface ComputeSettings {
  readonly schemaVersion: 1;
  /** USD for the whole project. Null: pods are off. */
  readonly limitUsd: number | null;
  /** The highest rate of one pod, in USD per hour. */
  readonly maxUsdPerHour: number;
  readonly maxHoursPerLease: number;
  /** Minutes without a job before Verifold stops a pod. */
  readonly idleMinutes: number;
  readonly maxRunningPods: 1 | 2;
  /** RunPod GPU type IDs that a lease can use. */
  readonly gpuTypes: readonly string[];
  /** RunPod images that a lease can use. They start SSH with Verifold's key. */
  readonly images: readonly string[];
  /** The container disk of each pod, in GB. RunPod erases it when the pod stops. */
  readonly diskGb: number;
}

export const computeDefaults: ComputeSettings = {
  schemaVersion: 1,
  limitUsd: null,
  maxUsdPerHour: 1.5,
  maxHoursPerLease: 4,
  idleMinutes: 15,
  maxRunningPods: 1,
  gpuTypes: [],
  images: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
  diskGb: 50,
};

/** What the desk shows about compute. It holds no key. */
export interface ComputeView {
  readonly key: KeyStatus | null;
  /** The keyring of this computer, or null when the key can go only into a file. */
  readonly keyring: 'keychain' | 'secret-service' | null;
  readonly settings: ComputeSettings;
  /** Secure Cloud GPU types, after the person or the coordinator asked for them. */
  readonly gpus: readonly GpuOffer[] | null;
  readonly gpusAt: string | null;
  /** Every lease, oldest first. */
  readonly leases: readonly Lease[];
  readonly budget: Budget;
  /** The last problem that a check of the pods met. */
  readonly problem: { readonly at: string; readonly text: string } | null;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** A number from a form field or JSON, inside a range. `whole` asks for an integer. */
function number(
  value: unknown,
  name: string,
  min: number,
  max: number,
  whole = false,
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (whole && !Number.isInteger(parsed))
  )
    fail(
      `Give ${name} as ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}.`,
    );
  return parsed;
}

const gpuId = /^[A-Za-z0-9 ._()-]{1,100}$/;

/** The worker tools for a task's GPU pod. Verifold runs SSH; the worker never gets the key. */
export const podToolSpecs: readonly AgentTool[] = [
  {
    name: 'verifold_pod_run',
    description:
      "Run a shell command as root on the task's GPU pod, in the task's folder there. Returns the exit code and the last 64 KB of output. Commands run for at most 10 minutes; with background: true the command starts as a job and the call returns its ID at once.",
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', maxLength: 8000 },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600 },
        background: { type: 'boolean' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_pod_job',
    description:
      'Read the state, the exit code, and the last 64 KB of output of a background job on the pod.',
    inputSchema: {
      type: 'object',
      properties: { job: { type: 'string', pattern: '^job-[0-9a-f]{8}$' } },
      required: ['job'],
      additionalProperties: false,
    },
  },
  {
    name: 'verifold_pod_copy',
    description:
      "Copy files or folders between the task folder and the task's folder on the pod: to-pod, or from-pod into the writable paths only. At most 20 paths, 2,000 files, and 200 MB in one copy. The pod's disk is erased when the pod stops.",
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['to-pod', 'from-pod'] },
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ['direction', 'paths'],
      additionalProperties: false,
    },
  },
];
const image = /^runpod\/[a-z0-9][a-z0-9._/-]{0,150}(:[A-Za-z0-9._-]{1,128})?$/;

/** Check the settings that the person sent. A missing GPU list keeps the current one. */
export function parseSettings(
  input: Record<string, unknown>,
  current: ComputeSettings,
): ComputeSettings {
  const limit =
    input.limitUsd === null ||
    (typeof input.limitUsd === 'string' && !input.limitUsd.trim())
      ? null
      : number(input.limitUsd, 'the spend limit in USD', 1, 10_000);
  const images = (
    Array.isArray(input.images)
      ? input.images
      : typeof input.images === 'string'
        ? input.images.split('\n')
        : []
  )
    .map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  if (!images.length || images.length > 10)
    fail('Allow 1 to 10 images, one on each line.');
  for (const entry of images)
    if (!image.test(entry))
      fail(
        `Use RunPod images (runpod/…), because they start SSH with Verifold's key. ${entry.slice(0, 80)} is not one.`,
      );
  const gpus =
    input.gpuTypes === undefined
      ? current.gpuTypes
      : Array.isArray(input.gpuTypes)
        ? input.gpuTypes
        : fail('The desk sent an unreadable GPU list.');
  if (
    gpus.length > 30 ||
    !gpus.every((entry) => typeof entry === 'string' && gpuId.test(entry))
  )
    fail('The desk sent an unreadable GPU list.');
  const pods = number(input.maxRunningPods, 'the number of pods', 1, 2, true);
  return {
    schemaVersion: 1,
    limitUsd: limit,
    maxUsdPerHour: number(
      input.maxUsdPerHour,
      'the rate cap in USD per hour',
      0.1,
      50,
    ),
    maxHoursPerLease: number(
      input.maxHoursPerLease,
      'the hours of a lease',
      1,
      24,
      true,
    ),
    idleMinutes: number(input.idleMinutes, 'the idle minutes', 5, 240, true),
    maxRunningPods: pods === 2 ? 2 : 1,
    gpuTypes: [...new Set(gpus as string[])],
    images: [...new Set(images)],
    diskGb: number(input.diskGb, 'the disk size in GB', 10, 500, true),
  };
}

/**
 * The compute settings of a project and the RunPod key of this computer.
 * Settings live in `.verifold/compute/settings.json`. The key lives in the
 * key store, outside every project. Changes run one at a time.
 */
export class Compute {
  private readonly root: string;
  private readonly store: KeyStore;
  private readonly url: string | undefined;
  private state: Omit<ComputeView, 'leases' | 'budget' | 'problem'> = {
    key: null,
    keyring: null,
    settings: computeDefaults,
    gpus: null,
    gpusAt: null,
  };
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private readonly shell: PodShell;
  private readonly taskFolder:
    | ((task: string) => Promise<TaskPlace | null>)
    | undefined;
  /** The pod leases of the project. The desk and the coordinator act on them. */
  readonly leases: Leases;

  /**
   * `url` is the RunPod API origin. Tests use a fake server, a fake key store,
   * and a clock. `onChange` gets one line for each lease change.
   */
  constructor(
    root: string,
    options: {
      readonly store?: KeyStore;
      readonly url?: string;
      readonly onChange?: (lease: Lease, line: string) => void;
      readonly now?: () => number;
      /** The folder and writable paths of a task, for the copy back before a stop. */
      readonly taskFolder?: (task: string) => Promise<TaskPlace | null>;
      /** The `ssh`, `ssh-keyscan`, and `ssh-keygen` programs. Tests use fakes. */
      readonly programs?: {
        readonly ssh?: string;
        readonly keyscan?: string;
        readonly keygen?: string;
      };
    } = {},
  ) {
    this.root = root;
    this.store = options.store ?? new KeyStore();
    this.url = options.url;
    this.taskFolder = options.taskFolder;
    this.shell = new PodShell({
      root,
      credentials: this.store.folder,
      ...options.programs,
    });
    this.leases = new Leases(root, {
      client: async () => new RunPod(await this.key(), this.url),
      settings: () => this.state.settings,
      offer: async (gpu) =>
        (await this.catalog()).find((entry) => entry.id === gpu) ?? null,
      ...(options.onChange ? { onChange: options.onChange } : {}),
      ...(options.now ? { now: options.now } : {}),
      sshKey: (lease) => this.shell.newKey(lease.id),
      prepare: async (lease, pod) => {
        if (!pod.ssh) throw new Error('No SSH yet.');
        const logged = await new RunPod(await this.key(), this.url).logs(
          pod.id,
        );
        return (await this.shell.pin(
          { lease: lease.id, host: pod.ssh.host, port: pod.ssh.port },
          logged,
        )) === 'verified'
          ? 'Its SSH host key matches the key in its log.'
          : 'Its log shows no host key, so Verifold trusted the first key that it saw.';
      },
      beforeStop: (lease) => this.copyBack(lease),
      closed: (lease) => this.shell.forget(lease.id),
    });
  }

  /** Pods are on when a key is stored and the person set a spend limit. */
  podsOn(): boolean {
    return this.state.key !== null && this.state.settings.limitUsd !== null;
  }

  /** The worker tools for pods. */
  podTools(): PodTools {
    return {
      on: () => this.podsOn(),
      specs: podToolSpecs,
      call: (task, name, input) => this.podCall(task, name, input),
    };
  }

  /** The newest ready lease of a task, with where its pod answers SSH. */
  private target(task: string): PodTarget {
    const leases = this.leases
      .list()
      .filter((lease) => lease.tasks.includes(task));
    const ready = leases.findLast(
      (lease) => lease.state === 'ready' && lease.ssh,
    );
    if (ready?.ssh)
      return { lease: ready.id, host: ready.ssh.host, port: ready.ssh.port };
    fail(
      leases.some(
        (lease) => lease.state === 'starting' || lease.state === 'requested',
      )
        ? 'The pod of this task is not ready yet. Try again in a minute.'
        : 'This task has no ready pod. Ask the coordinator for one with verifold_post.',
    );
  }

  /** One worker pod tool call. Each call counts as activity, so the idle stop waits. */
  private async podCall(
    task: TaskPlace,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const target = this.target(task.id);
    await this.leases.active(target.lease);
    try {
      if (name === 'verifold_pod_run') {
        const command = input.command;
        if (
          typeof command !== 'string' ||
          !command.trim() ||
          command.length > podLimits.command
        )
          fail(`Give a command of up to ${podLimits.command} characters.`);
        if (input.background === true)
          return `Started ${await this.shell.start(target, task.id, command)} on the pod. Read its state and output with verifold_pod_job.`;
        const seconds =
          input.timeoutSeconds === undefined
            ? podLimits.commandSeconds
            : number(
                input.timeoutSeconds,
                'timeoutSeconds',
                1,
                podLimits.commandSeconds,
                true,
              );
        const result = await this.shell.run(target, task.id, command, seconds);
        return `${result.exit === null ? `The command ran out of its ${seconds} seconds.` : `Exit code ${result.exit}.`}\n${result.output}`;
      }
      if (name === 'verifold_pod_job') {
        const job = await this.shell.job(
          target,
          task.id,
          typeof input.job === 'string' ? input.job : '',
        );
        return `${job.state === 'done' ? `Done, exit code ${job.exit ?? 'unknown'}.` : job.state === 'running' ? 'Running.' : 'Unknown job.'}\n${job.output}`;
      }
      if (name === 'verifold_pod_copy') {
        const paths = Array.isArray(input.paths) ? input.paths : [];
        if (input.direction === 'to-pod') {
          const sent = await this.shell.copyTo(
            target,
            task.id,
            task.folder,
            paths,
          );
          return `Copied ${sent.files} files (${Math.ceil(sent.bytes / 1024)} KB) to the pod.`;
        }
        if (input.direction === 'from-pod') {
          const got = await this.shell.copyFrom(
            target,
            task.id,
            task.folder,
            task.writable,
            paths,
          );
          return `Copied ${got.copied.length} files from the pod${got.copied.length ? `: ${got.copied.slice(0, 20).join(', ')}` : ''}.${got.refused.length ? ` Refused, because they are not regular files inside the writable paths: ${got.refused.slice(0, 20).join(', ')}.` : ''}`;
        }
        fail('The direction is to-pod or from-pod.');
      }
      fail(`Verifold has no tool named ${name}.`);
    } finally {
      await this.leases.active(target.lease);
    }
  }

  /** Copy the writable paths of each task of a lease back from its pod. Returns a notice when a copy failed. */
  private async copyBack(lease: Lease): Promise<string | null> {
    if (!lease.ssh || !this.taskFolder) return null;
    const target = {
      lease: lease.id,
      host: lease.ssh.host,
      port: lease.ssh.port,
    };
    const problems: string[] = [];
    for (const task of lease.tasks) {
      const place = await this.taskFolder(task);
      if (!place) continue;
      const paths = place.writable.filter((path) => path !== '.');
      if (!paths.length) {
        problems.push(
          `${task} may write its whole folder, so only its worker copies results back.`,
        );
        continue;
      }
      try {
        await this.shell.copyFrom(
          target,
          task,
          place.folder,
          place.writable,
          paths,
        );
      } catch (error) {
        problems.push(
          `${task}: ${error instanceof Error ? error.message : 'the copy failed.'}`,
        );
      }
    }
    return problems.length
      ? `Before the pod of ${lease.id} stopped, Verifold could not copy back every result. ${problems.join(' ')}`
      : null;
  }

  private get file(): string {
    return join(this.root, '.verifold', 'compute', 'settings.json');
  }

  /** Read the settings and the key status. An unreadable settings file reads as the defaults. */
  async load(): Promise<void> {
    let settings = computeDefaults;
    try {
      const stats = await lstat(this.file);
      if (stats.isFile() && stats.size < 100_000) {
        const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value))
          settings = parseSettings(
            value as Record<string, unknown>,
            computeDefaults,
          );
      }
    } catch {
      /* No settings yet, or an unreadable file. */
    }
    this.state = {
      ...this.state,
      settings,
      key: await this.store.status(),
      keyring: await this.store.osPlace(),
    };
    await this.leases.load();
  }

  view(): ComputeView {
    return {
      ...this.state,
      leases: this.leases.list(),
      budget: this.leases.budget(),
      problem: this.leases.lastProblem(),
    };
  }

  /** Check the pods every 30 seconds, until close(). */
  watch(): void {
    this.timer ??= setInterval(() => {
      this.leases.poll().catch(() => {
        /* poll() keeps its problem for the view. */
      });
    }, 30_000);
    this.timer.unref();
  }

  /** Verifold stops: the pods stop, so billing stops. Returns a line for each pod that did not stop. */
  async close(): Promise<string[]> {
    clearInterval(this.timer);
    this.timer = undefined;
    return this.leases.close();
  }

  /** The Secure Cloud GPU types, read again when they are older than 10 minutes. */
  async catalog(): Promise<readonly GpuOffer[]> {
    const { gpus, gpusAt } = this.state;
    if (gpus && gpusAt && Date.now() - Date.parse(gpusAt) < 600_000)
      return gpus;
    const fresh = await new RunPod(await this.key(), this.url).gpus();
    this.state = {
      ...this.state,
      gpus: fresh,
      gpusAt: new Date().toISOString(),
    };
    return fresh;
  }

  /** Run one change after the earlier ones. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Check a new key with RunPod, then store it. `file` keeps it in a private file instead of the keyring. */
  setKey(key: unknown, file: unknown): Promise<void> {
    return this.serial(async () => {
      if (!validKey(key))
        fail('Paste a RunPod API key: 20 to 256 letters and digits.');
      const place: KeyPlace =
        file === true
          ? 'file'
          : (this.state.keyring ??
            fail(
              'This computer has no keyring that Verifold can use. Keep the key in a private file instead.',
            ));
      await new RunPod(key, this.url).check();
      await this.store.save(key, place);
      await this.store.noteCheck(null);
      this.state = { ...this.state, key: await this.store.status() };
    });
  }

  /** Check the stored key with one read-only call, and record the result. */
  checkKey(): Promise<void> {
    return this.serial(async () => {
      const key = await this.key();
      try {
        await new RunPod(key, this.url).check();
        await this.store.noteCheck(null);
      } catch (error) {
        if (error instanceof SessionActionError)
          await this.store.noteCheck(error.message);
        throw error;
      } finally {
        this.state = { ...this.state, key: await this.store.status() };
      }
    });
  }

  /** Remove the key from this computer. It stays valid at RunPod until the person revokes it. */
  removeKey(): Promise<void> {
    return this.serial(async () => {
      if (this.leases.list().some(isOpen))
        fail(
          'End the open leases first. Verifold needs the key to stop and delete their pods.',
        );
      await this.store.remove();
      this.state = { ...this.state, key: null, gpus: null, gpusAt: null };
    });
  }

  /** Read the Secure Cloud GPU types with their price and stock. */
  refreshGpus(): Promise<void> {
    return this.serial(async () => {
      const gpus = await new RunPod(await this.key(), this.url).gpus();
      this.state = { ...this.state, gpus, gpusAt: new Date().toISOString() };
    });
  }

  /** Save the limits that the person set. */
  saveSettings(input: Record<string, unknown>): Promise<void> {
    return this.serial(async () => {
      const settings = parseSettings(input, this.state.settings);
      const folder = join(this.root, '.verifold', 'compute');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if (!(await lstat(folder)).isDirectory())
        fail('.verifold/compute must be a folder, not a link.');
      const temporary = join(folder, `.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
        } finally {
          await handle.close();
        }
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.state = { ...this.state, settings };
    });
  }

  private async key(): Promise<string> {
    return (
      (await this.store.read()) ??
      fail(
        'Store a RunPod key first, in Compute or with `verifold runpod key set`.',
      )
    );
  }
}
