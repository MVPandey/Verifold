import { lstat, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readMemory } from '../core/agency.ts';
import { parseWorkspace, type Workspace } from '../core/contracts.ts';
import {
  parseAttempt,
  parseReport,
  validAttemptId,
  type AttemptRecord,
  type ResearchReport,
} from '../core/research-records.ts';

export { validAttemptId, type AttemptRecord };

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
    await appendAttempt(entry.name);
  }
  const latest = workspace.research?.latestAttempt;
  if (
    latest &&
    validAttemptId(latest) &&
    !attempts.some((attempt) => attempt.id === latest)
  )
    await appendAttempt(latest);

  async function appendAttempt(id: string): Promise<void> {
    let record: AttemptRecord | null = null;
    try {
      const path = await attemptDirectory(root, id);
      record = parseAttempt(
        JSON.parse(
          await readMemory(join(path, 'attempt.json'), 4000),
        ) as unknown,
        id,
      );
    } catch {
      // Old, incomplete, or inaccessible records cannot establish an outcome.
    }
    const age = record?.observedAt
      ? Date.now() - Date.parse(record.observedAt)
      : Infinity;
    attempts.push({
      id,
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
