import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readMemory } from './agency.ts';
import {
  archiveFolder,
  archiveIds,
  listArchives,
  readArchive,
  validArchiveId,
  type ArchivedRun,
} from './archive.ts';
import { Board, object, runId, type Post } from './board.ts';
import { parseWorkspace, type Workspace } from './contracts.ts';
import type { HarnessName } from './harness.ts';
import { parseState, type LabState } from './lab/schema.ts';
import { readLeases, type Lease } from './leases.ts';
import {
  parseAttempt,
  parseReport,
  validAttemptId,
  type AttemptRecord,
  type ResearchReport,
} from './research-records.ts';
import { parseRun, type RunRecord } from './runs.ts';
import {
  readSessionRecord,
  validSessionId,
  type SessionRecord,
} from './session.ts';
import {
  parseCoordinator,
  parseMessage,
  parseResults,
  parseTask,
  validTaskId,
  withoutLeftOut,
  type CoordinatorRecord,
  type Message,
  type Results,
  type TaskRecord,
} from './team-records.ts';
import { diffIn } from './workspaces.ts';

/**
 * History: the earlier runs of a project, read only. A run is a lab's run or
 * a run of the research flow that came before the lab (research attempts, the
 * coordinator, tasks, messages, and results). Start over moves a run into
 * `.verifold/archive/<id>/`. A project whose current run is from the research
 * flow shows it as `current`. Every read is bounded, and no read follows a
 * link out of the project's records.
 */

export const historyLimits = {
  runs: 100,
  attempts: 20,
  tasks: 100,
  messages: 200,
  sessions: 50,
  posts: 50,
  labRuns: 100,
  memoryFiles: 12,
  memoryBytes: 64 * 1024,
  /** The biggest record file that History reads. */
  recordBytes: 4_000_000,
} as const;

/** `lab`: a lab's run. `research`: a run of the research flow. */
export type HistoryKind = 'lab' | 'research';

/** An archived run, or `current`: the project's current run, from the research flow. */
export interface HistoryRunInfo {
  readonly id: string;
  readonly kind: HistoryKind;
  /** When Start over archived it. Null for the current run. */
  readonly at: string | null;
  readonly question: string | null;
  /** The direction that a research-flow run chose. */
  readonly direction: string | null;
  readonly bytes: number;
  readonly tasks: number;
}

export interface HistoryIndex {
  /** The current run when it is from the research flow, else null. */
  readonly current: HistoryRunInfo | null;
  /** Archived runs, newest first. */
  readonly runs: readonly HistoryRunInfo[];
  /** More archived runs exist than `runs` holds. */
  readonly more: boolean;
}

export interface LabHistory {
  readonly kind: 'lab';
  readonly info: HistoryRunInfo;
  readonly state: LabState;
  /** The newest posts, oldest first. */
  readonly posts: readonly Post[];
  readonly postCount: number;
  /** The handle and harness of each agent, by ID. */
  readonly agents: ReadonlyMap<
    string,
    { readonly handle: string; readonly host: HarnessName }
  >;
  /** The newest runs, oldest first. */
  readonly runs: readonly RunRecord[];
}

export interface HistoryAttempt {
  readonly id: string;
  /** Null: its record cannot be read. */
  readonly record: AttemptRecord | null;
  readonly report: ResearchReport | null;
  /** It has a transcript file. */
  readonly transcript: boolean;
}

export interface HistorySession {
  readonly record: SessionRecord;
  /** It has a transcript file. */
  readonly transcript: boolean;
}

export interface ResearchHistory {
  readonly kind: 'research';
  readonly info: HistoryRunInfo;
  readonly workspace: Workspace | null;
  /** Newest first. */
  readonly attempts: readonly HistoryAttempt[];
  readonly coordinator: CoordinatorRecord | null;
  /** In task order. */
  readonly tasks: readonly TaskRecord[];
  /** The newest messages, oldest first. */
  readonly messages: readonly Message[];
  readonly messageCount: number;
  readonly results: readonly Results[];
  /** The person's own sessions, newest first. */
  readonly sessions: readonly HistorySession[];
  /** The pods of this run's tasks. */
  readonly pods: readonly Lease[];
}

export type HistoryRun = LabHistory | ResearchHistory;

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A record: a JSON value from a regular file of at most `bytes`, or null. Never through a link. */
async function readRecord(
  path: string,
  bytes: number = historyLimits.recordBytes,
): Promise<unknown> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.size > bytes) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The names in a real folder, or none. A link is not a folder. */
async function names(path: string): Promise<string[]> {
  try {
    if (!(await lstat(path)).isDirectory()) return [];
    return await readdir(path);
  } catch {
    return [];
  }
}

async function readWorkspace(folder: string): Promise<Workspace | null> {
  try {
    return parseWorkspace(
      await readRecord(join(folder, 'workspace.json'), 1_000_000),
    );
  } catch {
    return null;
  }
}

/** A lab's state in `folder`, the way the owner reads it: unreadable counts as none. */
async function labState(folder: string): Promise<LabState | null> {
  return parseState(object(await readRecord(join(folder, 'lab.json'))));
}

/**
 * Whether the records in `folder`, a project's `.verifold/` or an archive,
 * hold a run of the research flow. A lab project also keeps its question as
 * research that needs a plan, with no directions, so that alone is no sign.
 */
async function researchIn(folder: string): Promise<boolean> {
  const workspace = await readWorkspace(folder);
  const research = workspace?.research;
  if (
    workspace &&
    (workspace.candidates.length > 0 ||
      workspace.selectedId !== null ||
      (research &&
        (research.phase !== 'needs-plan' ||
          research.plan ||
          research.sessionId ||
          research.latestAttempt)))
  )
    return true;
  for (const id of (await names(join(folder, 'runs'))).filter(validAttemptId))
    if (await exists(join(folder, 'runs', id, 'attempt.json'))) return true;
  for (const id of (await names(join(folder, 'tasks'))).filter(validTaskId))
    if (await exists(join(folder, 'tasks', id, 'task.json'))) return true;
  if (await exists(join(folder, 'coordinator', 'state.json'))) return true;
  if (
    (await names(join(folder, 'messages'))).some((name) =>
      /^m-[1-9]\d{0,5}\.json$/.test(name),
    )
  )
    return true;
  const top = await names(folder);
  return (
    top.some((name) => /^results(-[a-z0-9-]{1,80})?\.json$/.test(name)) ||
    top.includes('research.lock')
  );
}

/**
 * Whether the project's current run is from the research flow: it has no
 * lab, and its records hold research attempts, directions, the coordinator,
 * tasks, messages, or results. A lab must not start on top of such a run.
 */
export async function researchRunOnDisk(root: string): Promise<boolean> {
  const folder = join(root, '.verifold');
  if (await labState(folder)) return false;
  return researchIn(folder);
}

function infoOf(run: ArchivedRun): HistoryRunInfo {
  return {
    id: run.id,
    kind: run.kind,
    at: run.at,
    question: run.question,
    direction: run.direction,
    bytes: run.bytes,
    tasks: run.tasks,
  };
}

async function currentInfo(root: string): Promise<HistoryRunInfo | null> {
  if (!(await researchRunOnDisk(root))) return null;
  const folder = join(root, '.verifold');
  const workspace = await readWorkspace(folder);
  const tasks = (await names(join(folder, 'tasks'))).filter(validTaskId);
  return {
    id: 'current',
    kind: 'research',
    at: null,
    question: workspace?.research?.topic ?? null,
    direction:
      workspace?.candidates.find((idea) => idea.id === workspace.selectedId)
        ?.title ?? null,
    bytes: 0,
    tasks: tasks.length,
  };
}

/** The project's runs: the current research-flow run, if any, and the newest archived runs. */
export async function historyIndex(root: string): Promise<HistoryIndex> {
  const ids = await archiveIds(root);
  return {
    current: await currentInfo(root),
    runs: (await listArchives(root, historyLimits.runs)).map(infoOf),
    more: ids.length > historyLimits.runs,
  };
}

/** The records folder of a run, or null: `current` only while it is from the research flow. */
async function runFolder(
  root: string,
  id: string,
): Promise<{ readonly folder: string; readonly info: HistoryRunInfo } | null> {
  if (id === 'current') {
    const info = await currentInfo(root);
    return info ? { folder: join(root, '.verifold'), info } : null;
  }
  if (!validArchiveId(id)) return null;
  const folder = archiveFolder(root, id);
  try {
    if (!(await lstat(folder)).isDirectory()) return null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  const run = await readArchive(root, id);
  return run ? { folder, info: infoOf(run) } : null;
}

async function labHistory(
  folder: string,
  info: HistoryRunInfo,
  state: LabState,
): Promise<LabHistory> {
  const board = new Board('', join(folder, 'board'));
  await board.load();
  const posts = board.list();
  const agents = new Map<
    string,
    { readonly handle: string; readonly host: HarnessName }
  >();
  for (const name of (await names(join(folder, 'lab', 'agents'))).filter(
    (entry) => /^a-[1-9]\d{0,3}\.json$/.test(entry),
  )) {
    const entry = object(await readRecord(join(folder, 'lab', 'agents', name)));
    if (
      entry &&
      `${String(entry.id)}.json` === name &&
      typeof entry.handle === 'string' &&
      (entry.host === 'claude' || entry.host === 'codex')
    )
      agents.set(String(entry.id), { handle: entry.handle, host: entry.host });
  }
  const runs: RunRecord[] = [];
  for (const name of (await names(join(folder, 'lab', 'runs'))).filter(
    (entry) => runId.test(entry),
  )) {
    const run = parseRun(
      object(await readRecord(join(folder, 'lab', 'runs', name, 'run.json'))),
    );
    if (run?.id === name) runs.push(run);
  }
  runs.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  return {
    kind: 'lab',
    info,
    state,
    posts: posts.slice(-historyLimits.posts),
    postCount: posts.length,
    agents,
    runs: runs.slice(-historyLimits.labRuns),
  };
}

async function researchHistory(
  root: string,
  folder: string,
  info: HistoryRunInfo,
): Promise<ResearchHistory> {
  const workspace = await readWorkspace(folder);
  const attempts: HistoryAttempt[] = [];
  for (const id of (await names(join(folder, 'runs'))).filter(validAttemptId)) {
    let record: AttemptRecord | null = null;
    let report: ResearchReport | null = null;
    try {
      record = parseAttempt(
        await readRecord(join(folder, 'runs', id, 'attempt.json'), 4000),
        id,
      );
    } catch {
      /* An old or broken record shows without its details. */
    }
    try {
      const value = await readRecord(join(folder, 'runs', id, 'report.json'));
      report = value === null ? null : parseReport(value);
    } catch {
      /* A report that does not parse shows as none. */
    }
    attempts.push({
      id,
      record,
      report,
      transcript: await isFile(join(folder, 'runs', id, 'transcript.jsonl')),
    });
  }
  attempts.sort((a, b) =>
    (b.record?.startedAt ?? '').localeCompare(a.record?.startedAt ?? ''),
  );
  const tasks: TaskRecord[] = [];
  for (const id of (await names(join(folder, 'tasks')))
    .filter(validTaskId)
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .slice(0, historyLimits.tasks)) {
    const task = parseTask(
      await readRecord(join(folder, 'tasks', id, 'task.json'), 32_000_000),
    );
    if (task?.id === id) tasks.push(withoutLeftOut(task));
  }
  const messageNames = (await names(join(folder, 'messages')))
    .filter((name) => /^m-[1-9]\d{0,5}\.json$/.test(name))
    .sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5)));
  const messages: Message[] = [];
  for (const name of messageNames.slice(-historyLimits.messages)) {
    const message = parseMessage(
      await readRecord(join(folder, 'messages', name), 1_000_000),
    );
    if (message && `${message.id}.json` === name) messages.push(message);
  }
  const results: Results[] = [];
  for (const name of (await names(folder))
    .filter((entry) => /^results(-[a-z0-9-]{1,80})?\.json$/.test(entry))
    .sort()) {
    const value = parseResults(await readRecord(join(folder, name), 2_000_000));
    if (value) results.push(value);
  }
  const sessions: HistorySession[] = [];
  for (const name of (await names(join(folder, 'sessions')))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -5))
    .filter(validSessionId)
    .sort()
    .reverse()) {
    if (sessions.length >= historyLimits.sessions) break;
    const record = await readSessionRecord(
      join(folder, 'sessions', `${name}.json`),
    );
    // The person's own sessions: a task's or a lab agent's session is part of its task or direction.
    if (record && !record.task && !record.agent)
      sessions.push({
        record,
        transcript: await isFile(
          join(folder, 'sessions', `${name}.transcript.jsonl`),
        ),
      });
  }
  const coordinator = parseCoordinator(
    await readRecord(join(folder, 'coordinator', 'state.json')),
  );
  // Leases stay with the project. A pod belongs to this run when it served one of its tasks while the run lasted.
  const taskIds = new Set(tasks.map((task) => task.id));
  const from = [
    ...attempts.flatMap((attempt) =>
      attempt.record ? [attempt.record.startedAt] : [],
    ),
    ...tasks.map((task) => task.createdAt),
    ...(coordinator ? [coordinator.startedAt] : []),
  ].sort()[0];
  const until = info.at ?? new Date().toISOString();
  const pods = from
    ? (await readLeases(join(root, '.verifold', 'compute', 'leases'))).filter(
        (lease) =>
          lease.tasks.some((task) => taskIds.has(task)) &&
          lease.requestedAt >= from &&
          lease.requestedAt <= until,
      )
    : [];
  return {
    kind: 'research',
    info,
    workspace,
    attempts: attempts.slice(0, historyLimits.attempts),
    coordinator,
    tasks,
    messages,
    messageCount: messageNames.length,
    results,
    sessions,
    pods,
  };
}

/** One run of History, or null when the project has no such run. */
export async function historyRun(
  root: string,
  id: string,
): Promise<HistoryRun | null> {
  const found = await runFolder(root, id);
  if (!found) return null;
  const state = id === 'current' ? null : await labState(found.folder);
  return state
    ? labHistory(found.folder, found.info, state)
    : researchHistory(root, found.folder, found.info);
}

/**
 * The transcript file of a research attempt (`attempt:<id>`) or a session
 * (`session:<id>`) in a run, or null when the run or the source is not
 * there.
 */
export async function historyTranscript(
  root: string,
  id: string,
  source: string,
): Promise<string | null> {
  const found = await runFolder(root, id);
  const match = /^(attempt|session):(.{1,100})$/.exec(source);
  if (!found || !match) return null;
  const [, kind, name = ''] = match;
  const path =
    kind === 'attempt'
      ? validAttemptId(name)
        ? join(found.folder, 'runs', name, 'transcript.jsonl')
        : null
      : validSessionId(name)
        ? join(found.folder, 'sessions', `${name}.transcript.jsonl`)
        : null;
  return path && (await isFile(path)) ? path : null;
}

/** One task of a run in full, or null when the run or the task is not there. */
export async function historyTask(
  root: string,
  id: string,
  task: string,
): Promise<TaskRecord | null> {
  const found = await runFolder(root, id);
  if (!found || !validTaskId(task)) return null;
  const record = parseTask(
    await readRecord(
      join(found.folder, 'tasks', task, 'task.json'),
      32_000_000,
    ),
  );
  return record?.id === task ? withoutLeftOut(record) : null;
}

/**
 * The diff of one file of a task's version in a run. A task in the project
 * repository diffs there. A task folder diffs in its own Git directory,
 * which moves with its run. Null when the run, the task, the version, or
 * the file is not there.
 */
export async function historyTaskDiff(
  root: string,
  id: string,
  task: string,
  version: number,
  file: string,
): Promise<{
  readonly text: string;
  readonly cut: boolean;
  readonly commit: string;
} | null> {
  const record = await historyTask(root, id, task);
  const found = record ? await runFolder(root, id) : null;
  if (!record || !found) return null;
  for (const attempt of record.attempts)
    for (const entry of attempt.versions)
      if (entry.number === version && attempt.workspace) {
        const shown = entry.files.find((candidate) => candidate.path === file);
        if (!shown) return null;
        const workspace = attempt.workspace;
        const gitDir =
          workspace.kind === 'folder'
            ? join(found.folder, 'tasks', 'git', basename(workspace.path))
            : null;
        const diff = await diffIn(
          root,
          gitDir,
          workspace.start,
          entry.commit,
          shown.path,
        );
        return { ...diff, commit: entry.commit };
      }
  return null;
}

/** The project's memory files, as plain text. A file that cannot be read is left out. */
export async function memoryFiles(
  root: string,
): Promise<readonly { readonly name: string; readonly text: string }[]> {
  const folder = join(root, 'memory');
  const found: { name: string; text: string }[] = [];
  for (const name of (await names(folder))
    .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/.test(entry))
    .sort((a, b) =>
      a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b),
    )
    .slice(0, historyLimits.memoryFiles)) {
    try {
      found.push({
        name,
        text: await readMemory(join(folder, name), historyLimits.memoryBytes),
      });
    } catch {
      /* Too big, not plain text, or not a regular file. */
    }
  }
  return found;
}
