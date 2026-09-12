import { lstat, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readMemory } from './agency.ts';
import { parseWorkspace, type Workspace } from './contracts.ts';
import { validateModel } from './harness.ts';
import { object, text, type ResearchState } from './research-contracts.ts';
import { parseReport, type ResearchReport } from './research.ts';

export interface AttemptRecord {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly host: 'claude' | 'codex';
  readonly model: string | null;
  readonly phase: ResearchState['phase'];
  readonly requestedSessionId: string | null;
  readonly nativeSessionId: string | null;
  readonly startedAt: string;
  readonly observedAt?: string;
  readonly finishedAt: string | null;
  readonly status: 'started' | 'succeeded' | 'failed' | 'cancelled';
}

export interface DeskAttempt {
  readonly id: string;
  readonly record: AttemptRecord | null;
  readonly activity: 'recent' | 'finished' | 'unknown';
}

export interface DeskSnapshot {
  readonly project: string;
  readonly workspace: Workspace;
  readonly attempts: readonly DeskAttempt[];
  readonly historyLimited: boolean;
}

export function validAttemptId(id: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    id,
  );
}

function timestamp(value: unknown): string {
  const result = text(value, 'attempt timestamp', 30);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error('Invalid attempt timestamp.');
  return new Date(result).toISOString();
}

function session(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 'native session', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result))
    throw new Error('Invalid native session.');
  return result;
}

function parseAttempt(value: unknown, id: string): AttemptRecord {
  const data = object(value);
  if (
    data.schemaVersion !== 1 ||
    data.attemptId !== id ||
    (data.host !== 'claude' && data.host !== 'codex') ||
    (data.status !== 'started' &&
      data.status !== 'succeeded' &&
      data.status !== 'failed' &&
      data.status !== 'cancelled') ||
    (data.phase !== 'needs-plan' &&
      data.phase !== 'awaiting-plan-review' &&
      data.phase !== 'needs-research' &&
      data.phase !== 'directions')
  )
    throw new Error('Invalid attempt record.');
  validateModel(data.model === null ? undefined : data.model);
  if (data.model !== null && typeof data.model !== 'string')
    throw new Error('Missing requested model.');
  const finishedAt =
    data.finishedAt === null ? null : timestamp(data.finishedAt);
  if ((data.status === 'started') !== (finishedAt === null))
    throw new Error('Inconsistent attempt outcome.');
  return {
    schemaVersion: 1,
    attemptId: id,
    host: data.host,
    model: data.model,
    phase: data.phase,
    status: data.status,
    requestedSessionId: session(data.requestedSessionId),
    nativeSessionId: session(data.nativeSessionId),
    startedAt: timestamp(data.startedAt),
    finishedAt,
    ...(data.observedAt === undefined
      ? {}
      : { observedAt: timestamp(data.observedAt) }),
  };
}

async function realDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory())
    throw new Error('Desk records must use real directories.');
}

async function attemptDirectory(root: string, id: string): Promise<string> {
  if (!validAttemptId(id)) throw new Error('Invalid attempt ID.');
  const state = join(root, '.verifold');
  await realDirectory(state);
  await realDirectory(join(state, 'runs'));
  const directory = join(state, 'runs', id);
  await realDirectory(directory);
  return directory;
}

/** Read only bounded, fixed project records. Never follow a record symlink. */
export async function readDeskSnapshot(root: string): Promise<DeskSnapshot> {
  const state = join(root, '.verifold');
  await realDirectory(state);
  const workspace = parseWorkspace(
    JSON.parse(
      await readMemory(join(state, 'workspace.json'), 1_000_000),
    ) as unknown,
  );
  const attempts: DeskAttempt[] = [];
  let historyLimited = false;
  const runs = join(state, 'runs');
  try {
    await realDirectory(runs);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { project: basename(root), workspace, attempts, historyLimited };
    throw error;
  }
  const directory = await opendir(runs);
  let inspected = 0;
  for await (const entry of directory) {
    if (++inspected > 200) {
      historyLimited = true;
      break;
    }
    if (!validAttemptId(entry.name)) continue;
    let record: AttemptRecord | null = null;
    try {
      const path = await attemptDirectory(root, entry.name);
      record = parseAttempt(
        JSON.parse(
          await readMemory(join(path, 'attempt.json'), 4000),
        ) as unknown,
        entry.name,
      );
    } catch {
      // Old, incomplete, or inaccessible records cannot establish an outcome.
    }
    const age = record?.observedAt
      ? Date.now() - Date.parse(record.observedAt)
      : Infinity;
    attempts.push({
      id: entry.name,
      record,
      activity:
        record && record.status !== 'started'
          ? 'finished'
          : age >= 0 && age < 10000
            ? 'recent'
            : 'unknown',
    });
  }
  attempts.sort(
    (a, b) =>
      (b.record?.startedAt ?? '').localeCompare(a.record?.startedAt ?? '') ||
      a.id.localeCompare(b.id),
  );
  return { project: basename(root), workspace, attempts, historyLimited };
}

export async function readDeskReport(
  root: string,
  id: string,
): Promise<ResearchReport> {
  const directory = await attemptDirectory(root, id);
  return parseReport(
    JSON.parse(
      await readMemory(join(directory, 'report.json'), 1_000_000),
    ) as unknown,
  );
}
