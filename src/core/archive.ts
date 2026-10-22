import { randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspace, type Workspace } from './contracts.ts';
import { changeWorkspace, exists } from './storage.ts';
import { validTaskId } from './team-records.ts';

/**
 * Start over and restore. A run is the record of one pass through the
 * question: its research attempts, tasks and their versions, messages, the
 * coordinator, the lab and its board, the results, and the session records. Start over moves these
 * into `.verifold/archive/<id>/` and keeps the question, the brief, the
 * settings, the compute records, and the project files. Nothing is deleted.
 * The caller makes sure that nothing runs.
 */

/** The parts of `.verifold/` that belong to a run. Results files are matched by name. */
const parts = [
  'runs',
  'tasks',
  'messages',
  'coordinator',
  'sessions',
  'lab.json',
  'lab',
  'board',
];

/** A results file of a run: `results.json`, or `results-<direction>.json`. */
export function isResults(name: string): boolean {
  return /^results(-[a-z0-9-]{1,80})?\.json$/.test(name);
}

/** What an archive says about its run. */
export interface ArchiveInfo {
  readonly id: string;
  /** When the run was archived. */
  readonly at: string;
  readonly tasks: number;
  /** The direction that the run had, if it chose one. */
  readonly direction: string | null;
  /** The question of the run. */
  readonly question: string | null;
  /** `lab`: a lab's run. `research`: a run of the research flow that came before the lab. */
  readonly kind: 'lab' | 'research';
}

export interface ArchivedRun extends ArchiveInfo {
  readonly bytes: number;
}

function folder(root: string): string {
  return join(root, '.verifold', 'archive');
}

/** The size of a file or a folder, without following links. */
async function size(path: string): Promise<number> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const name of await readdir(path)) total += await size(join(path, name));
  return total;
}

/** Archive sizes by folder, with the folder's time when it was sized. */
const sizes = new Map<
  string,
  { readonly mtime: number; readonly bytes: number }
>();

/**
 * An archive's size in bytes, its Git folders too. Start over writes an
 * archive once, so each one is sized once while its folder stays the same.
 */
export async function archiveSize(root: string, id: string): Promise<number> {
  const path = join(folder(root), id);
  const mtime = (await lstat(path)).mtimeMs;
  const known = sizes.get(path);
  if (known?.mtime === mtime) return known.bytes;
  const bytes = await size(path);
  if (sizes.size >= 1000) sizes.clear();
  sizes.set(path, { mtime, bytes });
  return bytes;
}

/**
 * A run's kind: `lab` when its records hold a lab's `lab.json`, readable or
 * not, else `research`. History and the archive list use this one rule.
 */
export async function runKind(records: string): Promise<'lab' | 'research'> {
  return (await exists(join(records, 'lab.json'))) ? 'lab' : 'research';
}

/** The run parts that exist now. */
async function present(root: string): Promise<string[]> {
  const state = join(root, '.verifold');
  const names = await readdir(state);
  return names.filter((name) => parts.includes(name) || isResults(name));
}

/** The research of a new run: the same question, without the plan, the session, or the directions. */
function fresh(workspace: Workspace): Workspace {
  const { research, ...rest } = workspace;
  return {
    ...rest,
    candidates: [],
    selectedId: null,
    ...(research
      ? {
          research: {
            topic: research.topic,
            autonomy: research.autonomy,
            phase: 'needs-plan' as const,
          },
        }
      : {}),
  };
}

/**
 * Move the current run into a new archive and give the workspace a fresh
 * research state. Returns the archive ID, or null when there was no run.
 */
export async function archiveRun(root: string): Promise<string | null> {
  const names = await present(root);
  if (!names.length) return null;
  const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`;
  const target = join(folder(root), id);
  await mkdir(target, { recursive: true, mode: 0o700 });
  // The workspace copy comes first, so an archive always says what its run was about.
  await copyFile(
    join(root, '.verifold', 'workspace.json'),
    join(target, 'workspace.json'),
  );
  for (const name of names)
    await rename(join(root, '.verifold', name), join(target, name));
  await changeWorkspace(root, (current) => {
    if (!current) throw new Error('The project has no workspace.');
    return fresh(current);
  });
  return id;
}

/** The IDs of this project's archives, newest first. */
export async function archiveIds(root: string): Promise<string[]> {
  try {
    return (await readdir(folder(root)))
      .filter(validArchiveId)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** An archive's folder. The caller checks the ID with `validArchiveId`. */
export function archiveFolder(root: string, id: string): string {
  return join(folder(root), id);
}

/**
 * One archive of this project, without its size, or null when it cannot be
 * read. The caller checks the ID. No read follows a link.
 */
export async function readArchive(
  root: string,
  id: string,
): Promise<ArchiveInfo | null> {
  try {
    const path = join(folder(root), id);
    const stats = await lstat(path);
    const saved = join(path, 'workspace.json');
    const file = await lstat(saved);
    if (!stats.isDirectory() || !file.isFile() || file.size > 1_000_000)
      return null;
    const workspace = parseWorkspace(JSON.parse(await readFile(saved, 'utf8')));
    const tasks = (
      await lstat(join(path, 'tasks')).catch(() => null)
    )?.isDirectory()
      ? await readdir(join(path, 'tasks'))
      : [];
    return {
      direction:
        workspace.candidates.find((idea) => idea.id === workspace.selectedId)
          ?.title ?? null,
      question: workspace.research?.topic ?? null,
      kind: await runKind(path),
      id,
      at: stats.mtime.toISOString(),
      tasks: tasks.filter(validTaskId).length,
    };
  } catch {
    return null;
  }
}

/** The archives of this project, newest first. An unreadable one is skipped. */
export async function listArchives(root: string): Promise<ArchivedRun[]> {
  const runs: ArchivedRun[] = [];
  for (const id of await archiveIds(root)) {
    const run = await readArchive(root, id);
    const bytes = run ? await archiveSize(root, id).catch(() => null) : null;
    if (run && bytes !== null) runs.push({ ...run, bytes });
  }
  return runs;
}

export function validArchiveId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{8}T\d{9}Z-[a-f0-9]{6}$/.test(id);
}

/**
 * Bring an archived run back. The current run moves into an archive first,
 * so nothing is lost. The workspace gets the research state of the archived
 * run; its question, brief, and settings stay as they are now.
 */
export async function restoreRun(root: string, id: unknown): Promise<void> {
  if (!validArchiveId(id)) throw new Error('Choose an archive from Records.');
  const source = join(folder(root), id);
  if (!(await exists(source))) throw new Error('That archive does not exist.');
  const saved = parseWorkspace(
    JSON.parse(await readFile(join(source, 'workspace.json'), 'utf8')),
  );
  await archiveRun(root);
  for (const name of await readdir(source))
    if (parts.includes(name) || isResults(name))
      await rename(join(source, name), join(root, '.verifold', name));
  await changeWorkspace(root, (current) => {
    if (!current) throw new Error('The project has no workspace.');
    return {
      ...current,
      candidates: saved.candidates,
      selectedId: saved.selectedId,
      ...(saved.research ? { research: saved.research } : {}),
    };
  });
  await rm(source, { recursive: true, force: true });
}
