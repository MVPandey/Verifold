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
  /** Secure Cloud GPU types, after the person asked for them. */
  readonly gpus: readonly GpuOffer[] | null;
  readonly gpusAt: string | null;
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
  private state: ComputeView = {
    key: null,
    keyring: null,
    settings: computeDefaults,
    gpus: null,
    gpusAt: null,
  };
  private queue: Promise<unknown> = Promise.resolve();

  /** `url` is the RunPod API origin. Tests use a fake server and a fake key store. */
  constructor(
    root: string,
    options: { readonly store?: KeyStore; readonly url?: string } = {},
  ) {
    this.root = root;
    this.store = options.store ?? new KeyStore();
    this.url = options.url;
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
  }

  view(): ComputeView {
    return this.state;
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
