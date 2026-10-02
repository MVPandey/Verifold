import { execFile } from 'node:child_process';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

/** A second process for the project, or a project that the running owner holds. The message is safe to show. */
export class OwnerConflict extends Error {}

export interface ProjectOwner {
  readonly ownerId: string;
  /** Remove the owner record if this process still holds it. */
  release(): Promise<void>;
}

interface OwnerRecord {
  readonly ownerId: string;
  readonly pid: number;
  readonly processStart: string | null;
  readonly startedAt: string;
}

/** The start time of a process, so a reused PID cannot pass for the owner. Null when `ps` is unavailable. */
async function processStart(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await promisify(execFile)(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 2000, maxBuffer: 1024 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Only the fields that decide ownership. An unreadable record has no owner. */
async function readOwner(path: string): Promise<OwnerRecord | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.ownerId === 'string' &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0
    ? {
        ownerId: record.ownerId,
        pid: record.pid as number,
        processStart:
          typeof record.processStart === 'string' ? record.processStart : null,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
      }
    : null;
}

async function alive(record: OwnerRecord): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
  const start = await processStart(record.pid);
  // Without a start time on either side, a live PID counts as the owner.
  return (
    record.processStart === null ||
    start === null ||
    start === record.processStart
  );
}

function since(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : `, started ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Make this process the only owner of the project. A record from a stopped
 * process, or from a reused PID, is moved aside and kept as evidence.
 */
export async function claimOwner(
  root: string,
  version: string,
): Promise<ProjectOwner> {
  const path = join(root, '.verifold', 'owner.json');
  const ownerId = randomUUID();
  const record = JSON.stringify({
    schemaVersion: 1,
    ownerId,
    pid: process.pid,
    processStart: await processStart(process.pid),
    startedAt: new Date().toISOString(),
    version,
  });
  for (let tries = 0; tries < 3; tries++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(record);
      } finally {
        await file.close();
      }
      return {
        ownerId,
        release: async () => {
          if ((await readOwner(path))?.ownerId === ownerId)
            await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error;
    }
    const current = await readOwner(path);
    if (current && (await alive(current)))
      throw new OwnerConflict(
        `Verifold already runs in this project (process ${current.pid}${since(current.startedAt)}). Use that terminal, or type /open there to open the desk.`,
      );
    try {
      await rename(
        path,
        join(root, '.verifold', `owner-${Date.now()}-${tries}.stale.json`),
      );
    } catch (error) {
      // Another process moved the stale record first. Try to claim again.
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
  throw new OwnerConflict(
    'Another Verifold process claimed this project at the same time. Try again.',
  );
}
