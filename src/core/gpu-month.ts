import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings, prepareAgency, readMemory } from './agency.ts';
import {
  isOpen,
  leaseStart,
  monthKey,
  reserved,
  spent,
  type Lease,
  type MonthHooks,
  type OtherMonths,
} from './leases.ts';
import { missing, writePrivateFile } from './storage.ts';

/**
 * The monthly GPU limit across projects. Each project's owner keeps one
 * record in the `gpu/` folder of the person's profile, and reads every record
 * to check the limit. No owner writes the record of another project, so the
 * records need no lock. When Verifold cannot tell the limit or the spend of a
 * project, no new pod starts: spend that Verifold cannot read never counts as
 * nothing.
 */
export const monthLimits = {
  /** The most records that a check reads. */
  files: 200,
  /** The most bytes of one record. A record stays far under it by construction. */
  bytes: 64 * 1024,
  /** The most open leases that a record lists. Any more fold into its last entry. */
  open: 200,
  /** Records read at the same time. */
  reads: 8,
} as const;

/** An open lease in a record, as its owner counted it when it wrote the record. */
export interface OpenEntry {
  readonly id: string;
  readonly spentUsd: number;
  /** What the lease could still cost until `endsAt`. */
  readonly heldUsd: number;
  /** When the lease ends at the latest. */
  readonly endsAt: string;
}

/**
 * A project's record: `month`, the calendar month in which its owner wrote
 * it; `endedUsd`, what its leases that ended spent, for those that started in
 * `month`; and `open`, its open leases, which count in the month of a reader.
 */
export interface MonthRecord {
  readonly month: string;
  readonly endedUsd: number;
  readonly open: readonly OpenEntry[];
}

/** What the other projects spent and hold this month. */
export interface MonthRead {
  readonly spentUsd: number;
  readonly heldUsd: number;
  /** Why Verifold cannot tell the spend of the other projects. No new pod starts. */
  readonly unknown: string | null;
  /** Something the person should know, while the count still holds. */
  readonly problem: string | null;
}

/** The folder of the records in a profile folder. */
export function monthFolder(agency: string): string {
  return join(agency, 'gpu');
}

const fileName = /^[0-9a-f]{16}\.json$/;

/** Up in whole cents, so a record never counts less than its owner counted. */
function cents(usd: number): number {
  return Math.ceil(usd * 100 - 1e-9) / 100;
}

/** The first moment of the month of `now`, in this computer's time zone. */
function monthStart(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/**
 * A project's record for the month of `now`. Null: nothing counts in it, so
 * the project keeps no record. At most `monthLimits.open` entries, so a record
 * stays far under `monthLimits.bytes`.
 */
export function monthRecord(
  leases: readonly Lease[],
  now: number,
): MonthRecord | null {
  const month = monthKey(now);
  let endedUsd = 0;
  const open: OpenEntry[] = [];
  for (const lease of leases)
    if (isOpen(lease))
      open.push({
        id: lease.id,
        spentUsd: cents(spent(lease, now)),
        heldUsd: cents(reserved(lease, now)),
        endsAt:
          lease.deadline ??
          new Date(now + lease.hours * 3_600_000).toISOString(),
      });
    else if (monthKey(Date.parse(leaseStart(lease))) === month)
      endedUsd += spent(lease, now);
  if (!open.length && endedUsd <= 0) return null;
  const listed = open.slice(0, monthLimits.open - 1);
  const more = open.slice(monthLimits.open - 1);
  if (more.length)
    listed.push({
      id: 'more',
      spentUsd: cents(more.reduce((sum, entry) => sum + entry.spentUsd, 0)),
      heldUsd: cents(more.reduce((sum, entry) => sum + entry.heldUsd, 0)),
      endsAt: new Date(
        Math.max(...more.map((entry) => Date.parse(entry.endsAt))),
      ).toISOString(),
    });
  return { month, endedUsd: cents(endedUsd), open: listed };
}

function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function time(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

/** A record, checked. Null: the file is not one. */
function parseRecord(value: unknown): MonthRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    typeof data.month !== 'string' ||
    !/^\d{4}-\d{2}$/.test(data.month) ||
    !amount(data.endedUsd) ||
    !Array.isArray(data.open) ||
    data.open.length > monthLimits.open
  )
    return null;
  const open: OpenEntry[] = [];
  for (const item of data.open as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      entry.id.length > 40 ||
      !amount(entry.spentUsd) ||
      !amount(entry.heldUsd) ||
      !time(entry.endsAt)
    )
      return null;
    open.push({
      id: entry.id,
      spentUsd: entry.spentUsd,
      heldUsd: entry.heldUsd,
      endsAt: entry.endsAt,
    });
  }
  return { month: data.month, endedUsd: data.endedUsd, open };
}

/**
 * What a record counts in the month of `now`: its ended leases when it is a
 * record of that month, and each open lease that could run in that month.
 * An open lease holds until its end, even when its owner did not write again.
 */
function counted(
  record: MonthRecord,
  now: number,
): { readonly spentUsd: number; readonly heldUsd: number } {
  const start = monthStart(now);
  let spentUsd = record.month === monthKey(now) ? record.endedUsd : 0;
  let heldUsd = 0;
  for (const entry of record.open) {
    const ends = Date.parse(entry.endsAt);
    if (ends <= start) continue;
    spentUsd += entry.spentUsd;
    if (ends > now) heldUsd += entry.heldUsd;
  }
  return { spentUsd, heldUsd };
}

/** `work` for each item, at most `monthLimits.reads` at the same time, in the items' order. */
async function bounded<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++)
      results[index] = await work(items[index] as T);
  };
  await Promise.all(
    Array.from({ length: Math.min(monthLimits.reads, items.length) }, worker),
  );
  return results;
}

function unknown(line: string): MonthRead {
  return { spentUsd: 0, heldUsd: 0, unknown: line, problem: null };
}

/**
 * What the projects of the records in `folder` spent this month, and what
 * their open pods still hold, leaving out the record `skip`. A record that
 * cannot be read counts as its last content in `known`. Without one,
 * Verifold cannot tell that project's spend, and the read says why.
 */
export async function readMonth(
  folder: string,
  now: number,
  known: Map<string, MonthRecord> = new Map(),
  skip?: string,
): Promise<MonthRead> {
  let names: string[];
  try {
    if (!(await lstat(folder)).isDirectory())
      return unknown(
        `${folder} is not a folder, so Verifold can't tell what your projects spent on GPUs this month, and no new pod starts. Remove it, and Verifold makes the folder again.`,
      );
    names = (await readdir(folder)).filter(
      (name) => fileName.test(name) && name !== skip,
    );
  } catch (error) {
    if (missing(error))
      return { spentUsd: 0, heldUsd: 0, unknown: null, problem: null };
    return unknown(
      `Verifold can't read ${folder}, so it can't tell what your projects spent on GPUs this month, and no new pod starts: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  // A record that its owner last wrote two days before this month began counts nothing now: its leases ended before the month.
  const cutoff = monthStart(now) - 2 * 86_400_000;
  const recent = (
    await bounded(names, async (name) => {
      const info = await lstat(join(folder, name)).catch(() => null);
      return info && info.mtimeMs < cutoff ? null : name;
    })
  )
    .filter((name): name is string => name !== null)
    .sort();
  if (recent.length > monthLimits.files)
    return unknown(
      `${folder} holds the GPU records of ${recent.length.toString()} projects from this month, more than the ${monthLimits.files.toString()} that Verifold reads, so no new pod starts. Remove the records of projects that no longer exist.`,
    );
  const read = await bounded(recent, async (name) => {
    try {
      const record = parseRecord(
        JSON.parse(await readMemory(join(folder, name), monthLimits.bytes)),
      );
      if (!record) throw new Error('Not a GPU record.');
      known.set(name, record);
      return { name, record, fresh: true };
    } catch {
      return { name, record: known.get(name) ?? null, fresh: false };
    }
  });
  const lost = read.filter((entry) => !entry.record);
  const [first] = lost;
  if (first)
    return unknown(
      `Verifold can't read ${join(folder, first.name)}${lost.length > 1 ? ` and ${(lost.length - 1).toString()} more` : ''}, the GPU record of another project, so it can't tell what that project spent, and no new pod starts. If that project no longer exists, remove the file. If it does, open Verifold in that project, so it writes the file again.`,
    );
  let spentUsd = 0;
  let heldUsd = 0;
  for (const entry of read)
    if (entry.record) {
      const count = counted(entry.record, now);
      spentUsd += count.spentUsd;
      heldUsd += count.heldUsd;
    }
  const stale = read.filter((entry) => !entry.fresh).length;
  return {
    spentUsd,
    heldUsd,
    unknown: null,
    problem: stale
      ? `Verifold can't read the GPU record of ${stale.toString()} other ${stale === 1 ? 'project' : 'projects'} now, so it counts the spend that it read last.`
      : null,
  };
}

/** The person's limits in the profile are not valid. The message is the line for the person. */
class LimitsUnreadable extends Error {}

/**
 * The person's monthly limit in the profile at `agency`. Null: no monthly
 * limit, also without a profile or GPU limits. It throws when Verifold
 * cannot read the profile or its GPU limits.
 */
export async function profileMonthLimit(
  agency: string,
): Promise<number | null> {
  const settings = await loadSettings(agency);
  if (settings.unreadMoney)
    throw new LimitsUnreadable(
      "Your GPU limits in the profile can't be read. Set them again under GPU money.",
    );
  return settings.money?.monthUsd ?? null;
}

/**
 * The monthly limit for the owner of one project: it reads the limit from
 * the profile at each check, and it keeps the project's record in the
 * profile's `gpu/` folder.
 */
export class GpuMonth implements MonthHooks {
  private readonly agency: string;
  private readonly root: string;
  private readonly limit: () => Promise<number | null>;
  /** The last content of each other project's record that could be read. */
  private readonly known = new Map<string, MonthRecord>();
  /** This project's real path and the name of its record, once found. */
  private place: { readonly path: string; readonly name: string } | undefined;

  /**
   * `agency`: the profile folder. `root`: the project. `limit`: the person's
   * monthly limit now, or null for none. It throws when Verifold cannot read
   * it. By default it is read from the profile.
   */
  constructor(options: {
    readonly agency: string;
    readonly root: string;
    readonly limit?: () => Promise<number | null>;
  }) {
    this.agency = options.agency;
    this.root = options.root;
    this.limit = options.limit ?? (() => profileMonthLimit(this.agency));
  }

  /** This project's real path, and its record: 16 hex characters of a hash of that path. A failure is not kept. */
  private async where(): Promise<{
    readonly path: string;
    readonly name: string;
  }> {
    if (this.place) return this.place;
    const path = await realpath(this.root);
    this.place = {
      path,
      name: `${createHash('sha256').update(path).digest('hex').slice(0, 16)}.json`,
    };
    return this.place;
  }

  async others(now: number): Promise<OtherMonths | null> {
    let limit: number | null;
    try {
      limit = await this.limit();
    } catch (error) {
      return {
        unknown:
          error instanceof LimitsUnreadable
            ? error.message
            : `Verifold can't read your profile, so no new pod starts until it can check your monthly GPU limit: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
    if (limit === null) return null;
    let name: string;
    try {
      ({ name } = await this.where());
    } catch (error) {
      return {
        unknown: `Verifold can't find this project's folder, so it can't count its GPU spend, and no new pod starts: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
    const read = await readMonth(
      monthFolder(this.agency),
      now,
      this.known,
      name,
    );
    if (read.unknown) return { unknown: read.unknown };
    return {
      limitUsd: limit,
      spentUsd: read.spentUsd,
      heldUsd: read.heldUsd,
      problem: read.problem,
    };
  }

  async record(leases: readonly Lease[], now: number): Promise<void> {
    const folder = monthFolder(this.agency);
    const { path, name } = await this.where();
    const record = monthRecord(leases, now);
    // Nothing counts this month: the project writes nothing to the profile, and its old record goes.
    if (!record) {
      if ((await lstat(folder).catch(() => null))?.isDirectory())
        await rm(join(folder, name), { force: true });
      return;
    }
    // Each write checks the profile folder and its marker, so a folder that was removed comes back as Verifold's.
    await prepareAgency(this.agency);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(folder)).isDirectory())
      throw new Error(`${folder} must be a folder, not a link.`);
    await writePrivateFile(
      join(folder, name),
      `${JSON.stringify({
        schemaVersion: 1,
        project: path.slice(0, 1024),
        writtenAt: new Date(now).toISOString(),
        ...record,
      })}\n`,
      { sync: true },
    );
  }
}
