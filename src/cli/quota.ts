import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessName } from './harness.ts';

/** What a harness reported about its plan's usage window. */
export interface LimitSignal {
  /** The window is used up, so a new turn fails until it resets. */
  readonly exhausted: boolean;
  /** When the window resets (ISO time), if the harness said. */
  readonly resetsAt: string | null;
  readonly usedPercent: number | null;
  /** The harness's name for the window, for example `five_hour`. */
  readonly window: string | null;
}

/** The last usage signal of one harness account. */
export interface QuotaEntry {
  readonly exhausted: boolean;
  /** Work on this harness waits until this time. Null when the window is open. */
  readonly until: string | null;
  readonly usedPercent: number | null;
  readonly window: string | null;
  readonly seenAt: string;
  /** Used-up signals in a row without a reset time. Each one waits longer. */
  readonly backoff: number;
}

/** The waits for a used-up window without a reset time. */
const backoffMinutes = [15, 30, 60, 120];
/** A reset time can be a little early, so work waits this much longer by default. */
const resetGraceMs = 30_000;

function entry(value: unknown): QuotaEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  const time = (field: unknown): string | null =>
    typeof field === 'string' && Number.isFinite(Date.parse(field))
      ? field
      : null;
  if (typeof data.exhausted !== 'boolean' || !time(data.seenAt)) return null;
  return {
    exhausted: data.exhausted,
    until: time(data.until),
    usedPercent:
      typeof data.usedPercent === 'number' && Number.isFinite(data.usedPercent)
        ? data.usedPercent
        : null,
    window: typeof data.window === 'string' ? data.window.slice(0, 40) : null,
    seenAt: String(data.seenAt),
    backoff:
      Number.isInteger(data.backoff) && Number(data.backoff) >= 0
        ? Math.min(Number(data.backoff), backoffMinutes.length)
        : 0,
  };
}

/**
 * The usage windows of the harness accounts, in .verifold/quota.json. A
 * window belongs to the account, so every session of that harness waits for
 * it. Each record replaces the file atomically, one write at a time.
 */
export class Quota {
  private readonly root: string;
  private readonly graceMs: number;
  private entries: Partial<Record<HarnessName, QuotaEntry>> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(root: string, options: { readonly graceMs?: number } = {}) {
    this.root = root;
    this.graceMs = options.graceMs ?? resetGraceMs;
  }

  private get file(): string {
    return join(this.root, '.verifold', 'quota.json');
  }

  /** Read the saved windows. An unreadable record reads as none. */
  async load(): Promise<void> {
    this.entries = {};
    try {
      const stats = await lstat(this.file);
      if (!stats.isFile() || stats.size > 100_000) return;
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof value !== 'object' || value === null) return;
      const data = value as Record<string, unknown>;
      if (data.schemaVersion !== 1) return;
      for (const host of ['claude', 'codex'] as const) {
        const saved = entry(data[host]);
        if (saved) this.entries[host] = saved;
      }
    } catch {
      /* No record yet, or an unreadable one. */
    }
  }

  /**
   * Record a signal. A used-up window with a reset time waits until the reset
   * plus 30 s. Without a reset time, it waits 15, 30, 60, then 120 minutes. A
   * signal of an open window ends the wait.
   */
  record(host: HarnessName, signal: LimitSignal, now = Date.now()): void {
    const previous = this.entries[host];
    const reset = signal.resetsAt ? Date.parse(signal.resetsAt) : NaN;
    let until: number | null = null;
    let backoff = 0;
    if (signal.exhausted) {
      const waiting =
        previous?.exhausted && previous.until ? Date.parse(previous.until) : 0;
      if (Number.isFinite(reset) && reset > now) until = reset + this.graceMs;
      else if (waiting > now) {
        // Another session failed during the same wait. The wait stays as it is.
        until = waiting;
        backoff = previous?.backoff ?? 0;
      } else {
        // The check after the last wait failed too, so the next wait is longer.
        backoff = Math.min(
          (previous?.exhausted ? (previous.backoff ?? 0) : 0) + 1,
          backoffMinutes.length,
        );
        until = now + (backoffMinutes[backoff - 1] ?? 120) * 60_000;
      }
    }
    this.entries[host] = {
      exhausted: signal.exhausted,
      until: until === null ? null : new Date(until).toISOString(),
      usedPercent: signal.usedPercent,
      window: signal.window,
      seenAt: new Date(now).toISOString(),
      backoff,
    };
    const snapshot = { schemaVersion: 1, ...this.entries };
    this.writing = this.writing
      .then(() => this.save(snapshot))
      .catch(() => {
        /* The next signal writes the file again. The wait holds in memory. */
      });
  }

  /** The time until which work on `host` waits for its window, or null. */
  parked(host: HarnessName, now = Date.now()): string | null {
    const current = this.entries[host];
    return current?.exhausted &&
      current.until &&
      Date.parse(current.until) > now
      ? current.until
      : null;
  }

  view(): Readonly<Partial<Record<HarnessName, QuotaEntry>>> {
    return { ...this.entries };
  }

  /** Wait for the last write, for tests and shutdown. */
  settled(): Promise<void> {
    return this.writing;
  }

  private async save(value: unknown): Promise<void> {
    const folder = join(this.root, '.verifold');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(
      folder,
      `.quota.${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      } finally {
        await file.close();
      }
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
