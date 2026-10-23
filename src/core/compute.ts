import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  KeyStore,
  validKey,
  type KeyPlace,
  type KeyStatus,
  type SecretStatus,
  type SecretStore,
} from './credentials.ts';
import { RunPod, hideSecrets, secretGuard, type GpuOffer } from './runpod.ts';
import {
  Leases,
  isOpen,
  maxCost,
  spent,
  usd,
  type Budget,
  type Lease,
  type MonthHooks,
  type MonthView,
} from './leases.ts';
import { PodShell, podLimits, type PodTarget } from './pod-shell.ts';
import { PodGoneError, type PodRuns } from './runs.ts';
import type { AgentTool } from './session-hosts.ts';
import { SessionActionError } from './session.ts';

/** Where a task works: its folder in this computer and the paths that it may write. */
export interface TaskPlace {
  readonly id: string;
  readonly folder: string;
  readonly writable: readonly string[];
}

/** GPU pod tools for workers. A project with pods on offers them to each new worker. */
export interface PodTools {
  readonly on: () => boolean;
  readonly specs: readonly AgentTool[];
  readonly call: (
    task: TaskPlace,
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string>;
}

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
  /** The person approves each pod. Otherwise a request inside the limits starts at once. */
  readonly askBeforePod: boolean;
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
  askBeforePod: false,
};

/** What the desk shows about compute. It holds no key. */
export interface ComputeView {
  readonly key: KeyStatus | null;
  /** The keyring of this computer, or null when the key can go only into a file. */
  readonly keyring: 'keychain' | 'secret-service' | null;
  /** The pod secrets of this computer, without their values. */
  readonly secrets: readonly SecretStatus[];
  readonly settings: ComputeSettings;
  /** Secure Cloud GPU types, after the person or the coordinator asked for them. */
  readonly gpus: readonly GpuOffer[] | null;
  readonly gpusAt: string | null;
  /** Every lease, oldest first. */
  readonly leases: readonly Lease[];
  /** The leases whose pod Verifold stops or deletes now, by lease ID. No run starts on them. */
  readonly closing?: Readonly<Record<string, 'stopping' | 'ending'>>;
  readonly budget: Budget;
  /** All projects' GPU spend this month against the person's monthly limit. Null or absent: no monthly limit, or not read yet. */
  readonly month?: MonthView | null;
  /** The last problem that a check of the pods met. */
  readonly problem: { readonly at: string; readonly text: string } | null;
}

/**
 * What this lab's pods cost so far, and the project's limit. Pods of tasks,
 * and of earlier labs before Start over, are not this lab's.
 */
export function labGpu(
  compute: ComputeView,
  startedAt: string,
): { spent: number; limit: number | null } {
  const now = Date.now();
  return {
    spent: compute.leases
      .filter(
        (lease) =>
          lease.directions?.length &&
          Date.parse(lease.requestedAt) >= Date.parse(startedAt),
      )
      .reduce((sum, lease) => sum + spent(lease, now), 0),
    limit: compute.settings.limitUsd,
  };
}

/** A pod for lab directions that a person's call starts. */
export interface LabPod {
  readonly gpu: unknown;
  readonly hours: unknown;
  readonly directions: readonly string[];
  readonly reason: string;
  readonly secrets?: unknown;
  /** USD: the most that the person approved. A lease that can cost more does not start. */
  readonly most?: number;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/**
 * Why a lease takes no run now, in the words an agent reads. `closing`: how
 * Verifold closes its pod now, from `Leases.closing`. `direction`: the
 * direction to name for a pod that is not ready yet, when the agent named no
 * lease.
 */
function notReadyText(
  lease: Lease,
  closing: 'stopping' | 'ending' | undefined,
  direction?: string,
): string {
  if (closing === 'stopping')
    return `The pod of ${lease.id} stops now, so no run starts on it.`;
  if (closing === 'ending')
    return `Verifold ends ${lease.id} now, so no run starts on it.`;
  if (lease.state === 'stopped')
    return `The pod of ${lease.id} stopped, for example after its idle minutes, and its disk was erased. End the lease with verifold_end_lease, then ask for a new pod, or ask the person to start it again in the project's settings.`;
  if (
    lease.state === 'starting' ||
    lease.state === 'requested' ||
    lease.state === 'ready'
  )
    return `The pod of ${direction ?? lease.id} is not ready yet. Verifold wakes you when it is.`;
  return `${lease.id} has ended. Ask for a new pod with verifold_request_pod.`;
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
      "Run a shell command as root on the task's GPU pod, in the task's folder there. Returns the exit code and the last 64 KB of output. Commands run for at most 10 minutes; with background: true the command starts as a job and the call returns its ID at once. Secrets that the person allowed for the pod, such as HF_TOKEN, are environment variables there. Use them, but do not print them or write them into files.",
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
        : fail('Verifold got an unreadable GPU list.');
  if (
    gpus.length > 30 ||
    !gpus.every((entry) => typeof entry === 'string' && gpuId.test(entry))
  )
    fail('Verifold got an unreadable GPU list.');
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
    askBeforePod: input.askBeforePod === true,
  };
}

/** A short fingerprint of a project's settings, which changes when any limit changes. */
export function settingsVersion(settings: ComputeSettings): string {
  return createHash('sha256')
    .update(JSON.stringify(settings))
    .digest('hex')
    .slice(0, 16);
}

/** Replace a project's compute settings in one step. */
export async function writeComputeSettings(
  root: string,
  settings: ComputeSettings,
): Promise<void> {
  const folder = join(root, '.verifold', 'compute');
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
    await rename(temporary, join(folder, 'settings.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The GPU limits in the person's profile. Each new project copies them into
 * its own compute settings. `limitUsd` null: pods are off.
 */
export type ProfileMoney = Pick<
  ComputeSettings,
  | 'limitUsd'
  | 'maxUsdPerHour'
  | 'maxHoursPerLease'
  | 'idleMinutes'
  | 'maxRunningPods'
  | 'gpuTypes'
> & {
  /**
   * What all projects together may spend on pods in one calendar month.
   * Null: no monthly limit. Projects do not copy it: each check reads it here.
   */
  readonly monthUsd: number | null;
};

/**
 * The first run's limits until the person changes them. No GPU type is
 * allowed until the person sees RunPod's prices.
 */
export const profileMoneyDefaults: ProfileMoney = {
  limitUsd: 25,
  maxUsdPerHour: 4,
  maxHoursPerLease: 4,
  idleMinutes: 15,
  maxRunningPods: 1,
  gpuTypes: [],
  monthUsd: 100,
};

/** Check the limits of a profile with the same checks as a project's limits. */
export function parseProfileMoney(
  input: Record<string, unknown>,
): ProfileMoney {
  const settings = parseSettings(
    {
      ...computeDefaults,
      limitUsd: input.limitUsd,
      maxUsdPerHour: input.maxUsdPerHour,
      maxHoursPerLease: input.maxHoursPerLease,
      idleMinutes: input.idleMinutes,
      maxRunningPods: input.maxRunningPods,
      gpuTypes: input.gpuTypes ?? [],
    },
    computeDefaults,
  );
  return {
    limitUsd: settings.limitUsd,
    maxUsdPerHour: settings.maxUsdPerHour,
    maxHoursPerLease: settings.maxHoursPerLease,
    idleMinutes: settings.idleMinutes,
    maxRunningPods: settings.maxRunningPods,
    gpuTypes: settings.gpuTypes,
    // Limits saved before the monthly limit existed have none.
    monthUsd:
      input.monthUsd === undefined ||
      input.monthUsd === null ||
      (typeof input.monthUsd === 'string' && !input.monthUsd.trim())
        ? null
        : number(input.monthUsd, 'the monthly limit in USD', 1, 100_000),
  };
}

/** The compute settings that a new project starts with: the profile's limits, without the monthly one. */
export function projectSettings(money: ProfileMoney): ComputeSettings {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest is every limit but the monthly one, which each check reads from the profile.
  const { monthUsd: _, ...limits } = money;
  return { ...computeDefaults, ...limits };
}

/**
 * The compute settings of a project and the RunPod key of this computer.
 * Settings live in `.verifold/compute/settings.json`. The key lives in the
 * key store, outside every project. Changes run one at a time.
 */
export class Compute {
  private readonly root: string;
  private readonly store: KeyStore;
  private readonly secretStore: SecretStore;
  /** The secret values of each lease whose pod has them, to hide them in the output of pod tools. */
  private readonly hidden = new Map<string, Readonly<Record<string, string>>>();
  private readonly url: string | undefined;
  private state: Omit<ComputeView, 'leases' | 'budget' | 'problem'> = {
    key: null,
    keyring: null,
    secrets: [],
    settings: computeDefaults,
    gpus: null,
    gpusAt: null,
  };
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private readonly shell: PodShell;
  /** When Verifold last told each pod's watchdog that it runs. */
  private readonly beats = new Map<string, number>();
  private readonly taskFolder:
    | ((task: string) => Promise<TaskPlace | null>)
    | undefined;
  private readonly runsStop: ((lease: string) => Promise<void>) | undefined;
  /** The pod leases of the project. The desk and the coordinator act on them. */
  readonly leases: Leases;

  /**
   * `url` is the RunPod API origin. Tests use a fake server, a fake key store,
   * and a clock. `onChange` gets one line for each lease change, and
   * whether the change wakes agents.
   */
  constructor(
    root: string,
    options: {
      readonly store?: KeyStore;
      readonly url?: string;
      readonly onChange?: (lease: Lease, line: string, wake: boolean) => void;
      readonly now?: () => number;
      /** The folder and writable paths of a task, for the copy back before a stop. */
      readonly taskFolder?: (task: string) => Promise<TaskPlace | null>;
      /** Before the pod of a lab lease stops: its runs end and copy back their outputs. */
      readonly runsStop?: (lease: string) => Promise<void>;
      /** The person's monthly GPU limit across projects. */
      readonly month?: MonthHooks;
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
    this.secretStore = this.store.secrets();
    this.url = options.url;
    this.taskFolder = options.taskFolder;
    this.runsStop = options.runsStop;
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
      ...(options.month ? { month: options.month } : {}),
      sshKey: (lease) => this.shell.newKey(lease.id),
      secrets: (lease) => this.secretValues(lease),
      prepare: async (lease, pod) => {
        if (!pod.ssh) throw new Error('No SSH yet.');
        const target = {
          lease: lease.id,
          host: pod.ssh.host,
          port: pod.ssh.port,
        };
        const logged = await new RunPod(await this.key(), this.url).logs(
          pod.id,
        );
        const pinned =
          (await this.shell.pin(target, logged)) === 'verified'
            ? 'Its SSH host key matches the key in its log.'
            : 'Its log shows no host key, so Verifold trusted the first key that it saw.';
        // The watchdog is a backstop. A pod without it still works, and the history says so.
        try {
          await this.shell.watch(
            target,
            lease.deadline ??
              new Date(Date.now() + lease.hours * 3_600_000).toISOString(),
          );
          this.beats.set(lease.id, Date.now());
          return `${pinned} Its watchdog stops it at the end of the lease, or 15 minutes after Verifold stops answering.`;
        } catch (error) {
          return `${pinned} Its watchdog did not start: ${error instanceof Error ? error.message : 'unknown error'}`;
        }
      },
      alive: async (lease) => {
        if (
          !lease.ssh ||
          Date.now() - (this.beats.get(lease.id) ?? 0) < 120_000
        )
          return;
        this.beats.set(lease.id, Date.now());
        await this.shell.beat({
          lease: lease.id,
          host: lease.ssh.host,
          port: lease.ssh.port,
        });
      },
      beforeStop: (lease) => this.copyBack(lease),
      closed: async (lease) => {
        this.hidden.delete(lease.id);
        await this.shell.forget(lease.id);
      },
    });
  }

  /** The values of a lease's secrets. A missing one stops the pod's start, and the lease waits for it. */
  private async secretValues(
    lease: Lease,
  ): Promise<Readonly<Record<string, string>>> {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of lease.secrets ?? []) {
      const value = await this.secretStore.read(name);
      if (value) values[name] = value;
      else missing.push(name);
    }
    if (missing.length)
      fail(
        `Store ${missing.length === 1 ? 'the secret' : 'the secrets'} ${missing.join(' and ')} first, with ${missing.map((name) => `\`verifold runpod secret set ${name}\``).join(' and ')}. The pod of ${lease.id} needs ${missing.length === 1 ? 'it' : 'them'}.`,
      );
    this.hidden.set(lease.id, values);
    return values;
  }

  /** The secret names of a lease that this computer does not store. */
  missingSecrets(lease: Lease): string[] {
    const stored = new Set(this.state.secrets.map((secret) => secret.name));
    return (lease.secrets ?? []).filter((name) => !stored.has(name));
  }

  /** Pods are on when a key is stored and the person set a spend limit. */
  podsOn(): boolean {
    return this.state.key !== null && this.state.settings.limitUsd !== null;
  }

  /** A RunPod key is stored on this computer, with or without a spend limit. */
  keySaved(): boolean {
    return this.state.key !== null;
  }

  /**
   * The pods part of an agent's state: the person's limits, the budget, the
   * leases, and the allowed GPUs now.
   */
  async describe(): Promise<string> {
    const view = this.view();
    const { settings, budget } = view;
    let offers: unknown;
    try {
      const catalog = await this.catalog();
      offers = settings.gpuTypes.map((id) => {
        const offer = catalog.find((entry) => entry.id === id);
        return offer
          ? {
              gpuType: id,
              memoryGb: offer.memoryGb,
              usdPerHour: offer.price,
              stock: offer.stock,
            }
          : { gpuType: id, offered: false };
      });
    } catch (error) {
      offers = `unknown: ${error instanceof Error ? error.message : 'RunPod did not answer.'}`;
    }
    const now = Date.now();
    return JSON.stringify({
      podsOn: settings.limitUsd !== null && view.key !== null,
      personApprovesEachPod: settings.askBeforePod,
      storedSecrets: view.secrets.map((secret) => secret.name),
      limits: {
        spendLimitUsd: settings.limitUsd,
        maxUsdPerHourPerPod: settings.maxUsdPerHour,
        maxHoursPerLease: settings.maxHoursPerLease,
        idleMinutesBeforeStop: settings.idleMinutes,
        podsAtOnce: settings.maxRunningPods,
        diskGb: settings.diskGb,
        images: settings.images,
      },
      budget: {
        spentUsd: Number(budget.spent.toFixed(2)),
        heldUsd: Number(budget.reserved.toFixed(2)),
        leftUsd: budget.left === null ? null : Number(budget.left.toFixed(2)),
      },
      ...(view.month
        ? {
            monthAllProjects: {
              limitUsd: view.month.limitUsd,
              spentUsd: Number(view.month.spentUsd.toFixed(2)),
              heldUsd: Number(view.month.heldUsd.toFixed(2)),
              leftUsd: Number(view.month.leftUsd.toFixed(2)),
            },
          }
        : {}),
      allowedGpus: offers,
      leases: view.leases.slice(-20).map((lease) => ({
        id: lease.id,
        state: lease.state,
        tasks: lease.tasks,
        ...(lease.directions ? { directions: lease.directions } : {}),
        gpuType: lease.gpu,
        usdPerHour: lease.rate,
        hours: lease.hours,
        endsAt: lease.deadline,
        costSoFarUsd: Number(spent(lease, now).toFixed(2)),
        ...(lease.end ? { ended: lease.end.reason } : {}),
      })),
    });
  }

  /**
   * An agent asks for a lease, for tasks or for lab directions. D90: a
   * request inside the person's limits starts at once, unless the person
   * approves each pod. A start that a limit refuses, such as the pods at
   * once, waits for the person. Returns the reply for the agent.
   */
  async requestPod(input: {
    readonly by: 'coordinator' | 'agent';
    readonly gpu: unknown;
    readonly hours: unknown;
    readonly tasks?: unknown;
    readonly directions?: unknown;
    readonly reason: string;
    readonly secrets?: unknown;
  }): Promise<string> {
    const lease = await this.leases.request(input);
    const what = `${lease.gpu} for ${lease.hours} ${lease.hours === 1 ? 'hour' : 'hours'} at ${usd(lease.rate)} per hour`;
    const missing = this.missingSecrets(lease);
    if (missing.length)
      return `Asked the person to store the secret ${missing.join(' and ')} for ${lease.id}: ${what}. ${this.view().settings.askBeforePod ? 'Then the person approves the pod.' : 'The pod starts when the secret is there, if it still fits the limits.'} Nothing is created before that. An event tells you when the pod starts.`;
    if (!this.view().settings.askBeforePod) {
      const started = await this.leases
        .approve(lease.id, 'verifold')
        .catch(() => null);
      if (started?.state === 'starting')
        return `Started ${lease.id} inside the person's limits: ${what}. An event tells you when the pod is ready.`;
      if (started?.state === 'failed')
        return `RunPod did not create the pod of ${lease.id}: ${started.end?.reason ?? 'no reason given'}.`;
    }
    return `Asked the person for ${lease.id}: ${what}. Nothing is created until the person approves it. An event tells you the decision.`;
  }

  /** What a lab lease for `input` can cost at most, after the checks of a request. It records nothing. */
  podCost(input: LabPod): Promise<number> {
    return this.leases.quote({ by: 'agent', ...input });
  }

  /**
   * The person picked a pod in a lab's call: the lease starts as one that the
   * person approved, when it can cost at most `most`. A start that fails
   * withdraws the request, so nothing waits, and the error says why.
   */
  async startPod(input: LabPod): Promise<Lease> {
    const { most, ...pod } = input;
    const lease = await this.leases.request({ by: 'agent', ...pod });
    let started: Lease;
    try {
      const cost = maxCost(lease.rate, lease.diskGb, lease.hours);
      if (most !== undefined && cost > most + 0.005)
        fail(
          `The pod can now cost up to ${usd(cost)}, more than the ${usd(most)} that you approved.`,
        );
      started = await this.leases.approve(lease.id, 'person');
    } catch (error) {
      await this.leases
        .end(lease.id, 'person', 'its pod could not start.')
        .catch(() => {});
      throw error;
    }
    if (started.state === 'failed')
      fail(
        `RunPod did not create the pod of ${started.id}: ${started.end?.reason ?? 'no reason given'}.`,
      );
    return started;
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
    const ready = leases.findLast((lease) => this.leases.usable(lease));
    if (ready)
      return { lease: ready.id, host: ready.ssh.host, port: ready.ssh.port };
    const closing = this.leases.closing();
    const held = leases.findLast((lease) => closing[lease.id]);
    fail(
      leases.some(
        (lease) => lease.state === 'starting' || lease.state === 'requested',
      )
        ? 'The pod of this task is not ready yet. Try again in a minute.'
        : held
          ? notReadyText(held, closing[held.id])
          : 'This task has no ready pod. Ask the coordinator for one with verifold_post.',
    );
  }

  /** One worker pod tool call. Its reply and its errors never hold the value of a pod secret. */
  private async podCall(
    task: TaskPlace,
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const hide = await this.hider(this.target(task.id).lease);
    try {
      return hide(await this.podTool(task, name, input));
    } catch (error) {
      if (error instanceof Error) error.message = hide(error.message);
      throw error;
    }
  }

  /** A function that hides the secret values of a lease's pod in a text. */
  private async hider(id: string): Promise<(text: string) => string> {
    const values = await this.leaseSecrets(id);
    return (text) => hideSecrets(text, values);
  }

  /** The secret values of a lease's pod, or none when they cannot be read. */
  private async leaseSecrets(
    id: string,
  ): Promise<Readonly<Record<string, string>>> {
    const lease = this.leases.list().find((entry) => entry.id === id);
    const values = this.hidden.get(id);
    if (values || !lease?.secrets?.length) return values ?? {};
    return this.secretValues(lease).catch(() => ({}));
  }

  /**
   * The pod work of lab runs. Each call needs the lease's pod ready, and no
   * error that it throws holds a secret value. The ledger hides a job's texts
   * with the run's guard.
   */
  podRuns(): PodRuns {
    const ready = (id: string): PodTarget => {
      const lease = this.leases.list().find((entry) => entry.id === id);
      if (lease?.state === 'ready' && lease.ssh)
        return { lease: lease.id, host: lease.ssh.host, port: lease.ssh.port };
      throw new PodGoneError(
        `The pod of ${id} does not run now${lease?.end ? `: ${lease.end.reason}` : '.'}`,
      );
    };
    // A run that works keeps its pod from the idle stop. A lease record is written at most once a minute for it.
    const touch = (id: string): void => {
      const lease = this.leases.list().find((entry) => entry.id === id);
      if (Date.now() - Date.parse(lease?.activeAt ?? '') >= 60_000)
        void this.leases.active(id).catch(() => undefined);
    };
    // Each call hides secrets in its error.
    const hidden = async <T>(
      id: string,
      work: (target: PodTarget) => Promise<T>,
    ): Promise<T> => {
      const hide = await this.hider(id);
      try {
        return await work(ready(id));
      } catch (error) {
        if (error instanceof Error) error.message = hide(error.message);
        throw error;
      }
    };
    return {
      pick: (direction, lease) => {
        const own = this.leases
          .list()
          .filter((entry) => entry.directions?.includes(direction));
        const closing = this.leases.closing();
        if (lease !== undefined) {
          const named =
            own.find((entry) => entry.id === lease) ??
            fail(
              `${typeof lease === 'string' ? lease.slice(0, 40) : 'That'} is no lease of ${direction}. Read your leases with verifold_compute.`,
            );
          if (this.leases.usable(named))
            return { lease: named.id, gpu: named.gpu };
          // A named lease gets the reason of its own state.
          fail(notReadyText(named, closing[named.id]));
        }
        const usable = own.findLast((entry) => this.leases.usable(entry));
        if (usable) return { lease: usable.id, gpu: usable.gpu };
        // A pod that comes first: the agent waits for it, also while another one stops.
        const waiting = own.findLast(
          (entry) => entry.state === 'starting' || entry.state === 'requested',
        );
        const held = own.findLast((entry) => closing[entry.id]);
        const stopped = own.findLast((entry) => entry.state === 'stopped');
        const shown = waiting ?? held ?? stopped;
        fail(
          shown
            ? notReadyText(shown, closing[shown.id], direction)
            : `${direction} has no ready pod. Ask for one with verifold_request_pod.`,
        );
      },
      guard: async (id) => secretGuard(await this.leaseSecrets(id)),
      send: (id, run, folder) =>
        hidden(id, async (target) => {
          void this.leases.active(id).catch(() => undefined);
          await this.shell.sendRun(target, run, folder);
        }),
      start: (id, run, script) =>
        hidden(id, async (target) => {
          // The pod has the lease's secrets in its container's environment, which an SSH session does not get.
          const names = this.leases.get(id).secrets ?? [];
          const secrets = names.length
            ? `for name in ${names.join(' ')}; do if [ -z "$(printenv "$name")" ]; then line=$(tr '\\0' '\\n' 2>/dev/null < /proc/1/environ | grep -m 1 "^$name="); [ -n "$line" ] && export "$line"; fi; done\n`
            : '';
          await this.shell.startRun(target, run, `${secrets}${script}`);
          void this.leases.active(id).catch(() => undefined);
        }),
      state: (id, run) =>
        hidden(id, async (target) => {
          const state = await this.shell.runState(target, run);
          touch(id);
          return state;
        }),
      stop: (id, run, signal) =>
        hidden(id, (target) => this.shell.stopRun(target, run, signal)),
      log: (id, run, head, tail) =>
        hidden(id, (target) => this.shell.runLog(target, run, head, tail)),
      metrics: (id, run) =>
        hidden(id, (target) => this.shell.runMetrics(target, run)),
      fetch: (id, run, paths, folder) =>
        hidden(id, async (target) => {
          const found = await this.shell.existing(target, run, paths);
          if (found.length)
            await this.shell.copyFrom(target, run, folder, ['.'], found);
        }),
      remove: (id, run) =>
        hidden(id, (target) => this.shell.removeRun(target, run)),
    };
  }

  /** One worker pod tool call. Each call counts as activity, so the idle stop waits. */
  private async podTool(
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

  /**
   * Before a pod stops: the lab runs on it end and copy their outputs back,
   * and the writable paths of each task of a lease come back from its pod.
   * Returns a notice when a copy failed.
   */
  private async copyBack(lease: Lease): Promise<string | null> {
    if (lease.directions?.length)
      await this.runsStop?.(lease.id).catch(() => undefined);
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
      secrets: await this.secretStore.list(),
    };
    await this.leases.load();
  }

  view(): ComputeView {
    return {
      ...this.state,
      leases: this.leases.list(),
      closing: this.leases.closing(),
      budget: this.leases.budget(),
      month: this.leases.month(),
      problem: this.leases.lastProblem(),
    };
  }

  /** Check the pods every 30 seconds, until close(). A secret stored in the terminal shows up here too. */
  watch(): void {
    this.timer ??= setInterval(() => {
      // A poll also reads the month across projects, once per tick.
      this.leases.poll().catch(() => {
        /* poll() keeps its problem for the view. */
      });
      void this.serial(() => this.readSecrets()).catch(() => undefined);
    }, 30_000);
    this.timer.unref();
  }

  /**
   * Read the stored secret names again. A new one starts the requests of the
   * coordinator and of lab agents that waited for it, when the person does not approve each pod and
   * the request still fits the limits. Otherwise the request waits in Needs you.
   */
  private async readSecrets(): Promise<void> {
    const before = new Set(this.state.secrets.map((secret) => secret.name));
    this.state = { ...this.state, secrets: await this.secretStore.list() };
    const added = this.state.secrets.some((secret) => !before.has(secret.name));
    if (!added || this.state.settings.askBeforePod) return;
    for (const lease of this.leases.list())
      if (
        lease.state === 'requested' &&
        lease.requestedBy !== 'person' &&
        lease.secrets?.length &&
        !this.missingSecrets(lease).length
      )
        await this.leases.approve(lease.id, 'verifold').catch(() => null);
  }

  /** Store a pod secret on this computer. `file` keeps it in a private file instead of the keyring. */
  setSecret(name: unknown, value: unknown, file: unknown): Promise<void> {
    return this.serial(async () => {
      const place: KeyPlace =
        file === true
          ? 'file'
          : (this.state.keyring ??
            fail(
              'This computer has no keyring that Verifold can use. Keep the secret in a private file instead.',
            ));
      await this.secretStore.save(name, value, place);
      await this.readSecrets();
    });
  }

  /** Remove a pod secret from this computer. A pod that has it keeps it until the lease ends. */
  removeSecret(name: unknown): Promise<void> {
    return this.serial(async () => {
      const using = this.leases
        .list()
        .filter(
          (lease) => isOpen(lease) && lease.secrets?.includes(String(name)),
        );
      if (using.length)
        fail(
          `End ${using.map((lease) => lease.id).join(' and ')} first. Its pod has this secret, and Verifold hides its value in the pod's output only while it is stored.`,
        );
      await this.secretStore.remove(name);
      await this.readSecrets();
    });
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
      await writeComputeSettings(this.root, settings);
      this.state = { ...this.state, settings };
    });
  }

  /**
   * Change the limits that `changes` names, and keep the others. `base`: the
   * version of the settings that the person edited. When the settings changed
   * since then, nothing is saved, so a newer change is never overwritten
   * unseen.
   */
  changeSettings(
    changes: Record<string, unknown>,
    base: unknown,
  ): Promise<void> {
    return this.serial(async () => {
      if (base !== undefined && base !== settingsVersion(this.state.settings))
        fail(
          'These settings changed while you edited them. Here is the new version.',
        );
      const settings = parseSettings(
        { ...this.state.settings, ...changes },
        this.state.settings,
      );
      await writeComputeSettings(this.root, settings);
      this.state = { ...this.state, settings };
    });
  }

  private async key(): Promise<string> {
    return (
      (await this.store.read()) ??
      fail(
        'Store a RunPod key first, under GPU money in your profile or with `verifold runpod key set`.',
      )
    );
  }
}
