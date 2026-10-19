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
import { changeWorkspace } from './storage.ts';

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

function isResults(name: string): boolean {
  return /^results(-[a-z0-9-]{1,80})?\.json$/.test(name);
}

export interface ArchivedRun {
  readonly id: string;
  /** When the run was archived. */
  readonly at: string;
  readonly bytes: number;
  readonly tasks: number;
  /** The direction that the run had, if it chose one. */
  readonly direction: string | null;
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

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
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

/** The archives of this project, newest first. An unreadable one is skipped. */
export async function listArchives(root: string): Promise<ArchivedRun[]> {
  let names: string[];
  try {
    names = await readdir(folder(root));
  } catch {
    return [];
  }
  const runs: ArchivedRun[] = [];
  for (const id of names.filter(validArchiveId).sort().reverse()) {
    try {
      const path = join(folder(root), id);
      const tasks = await readdir(join(path, 'tasks')).catch(() => []);
      const saved = parseWorkspace(
        JSON.parse(await readFile(join(path, 'workspace.json'), 'utf8')),
      );
      runs.push({
        direction:
          saved.candidates.find((idea) => idea.id === saved.selectedId)
            ?.title ?? null,
        id,
        at: (await lstat(path)).mtime.toISOString(),
        bytes: await size(path),
        tasks: tasks.filter((name) => /^task-[1-9]\d{0,5}$/.test(name)).length,
      });
    } catch {
      /* Skip an archive that cannot be read. */
    }
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
