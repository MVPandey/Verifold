import { constants } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  archiveFolder,
  archiveIds,
  archiveSize,
  isResults,
  readArchive,
  validArchiveId,
  type ArchiveInfo,
} from './archive.ts';
import { Board, object, runId, type Post } from './board.ts';
import { parseWorkspace, type Workspace } from './contracts.ts';
import type { HarnessName } from './harness.ts';
import { parseState, type LabState } from './lab/schema.ts';
import { readLeases, spent, type Lease } from './leases.ts';
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
import { isFolder } from './storage.ts';
import {
  parseAssignment,
  parseCoordinator,
  parseMessage,
  parseResults,
  parseTask,
  validMessageId,
  validTaskId,
  withoutLeftOut,
  type Assignment,
  type MessageKind,
  type TaskRecord,
  type TaskVersion,
} from './team-records.ts';
import { diffIn } from './workspaces.ts';

/**
 * History: the earlier runs of a project, read only. A run is a lab's run or
 * a run of the research flow that came before the lab (research attempts, the
 * coordinator, tasks, messages, and results). Start over moves a run into
 * `.verifold/archive/<id>/`. A project whose current run is from the research
 * flow shows it as `current`. Every read is bounded, and no read follows a
 * link out of the run's records. Harnesses could write in the project, so
 * each field of a record is checked before it leaves here: a bad entry reads
 * as null, and a read never fails on one.
 */

export const historyLimits = {
  runs: 100,
  attempts: 20,
  tasks: 100,
  /** The newest messages that a run shows. */
  messages: 200,
  /** The message files that History reads, and their size, as the research flow kept them. */
  messageFiles: 2000,
  messageBytes: 100_000,
  /** The results files that a run shows. */
  results: 20,
  sessions: 50,
  posts: 50,
  labRuns: 100,
  pods: 50,
  memoryFiles: 12,
  memoryBytes: 64 * 1024,
  /** The biggest task record that a run's summary reads. Opening the task reads it in full. */
  summaryBytes: 256 * 1024,
  /** The biggest task record, as the research flow kept them. */
  taskBytes: 32_000_000,
  /** The biggest other record file that History reads. */
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
  /** The size of an archived run. Only the list sizes runs: null in a run's own read. */
  readonly bytes: number | null;
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
  /** Null: the lab's record, `lab.json`, cannot be read. */
  readonly state: LabState | null;
  /** The newest posts, oldest first. */
  readonly posts: readonly Post[];
  /** The posts that read. */
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

/** A check of a direction's results. */
export interface ResultCheck {
  /** Its place in the direction's list, from 1. */
  readonly check: number;
  readonly result: string;
  readonly value: string;
  readonly reason: string;
  /** The person's ruling on a judgement. */
  readonly ruling: { readonly result: string; readonly reason: string } | null;
}

export interface ResultClaim {
  readonly text: string;
  readonly evidence: readonly string[];
}

/** The results of one direction. In its lists, null is an entry that cannot be read. */
export interface ResultsView {
  readonly direction: string;
  readonly checks: readonly (ResultCheck | null)[];
  /** Null: no answer yet. */
  readonly answer: {
    /** Null: the answer cannot be read. */
    readonly statement: string | null;
    readonly claims: readonly (ResultClaim | null)[];
    readonly decision: {
      readonly kind: 'accepted' | 'more';
      readonly note: string | null;
    } | null;
  } | null;
}

/** One tool call of the coordinator. */
export interface ActionView {
  readonly at: string;
  readonly tool: string;
  readonly reason: string | null;
  readonly ok: boolean;
  readonly result: string;
}

export interface CoordinatorView {
  readonly objective: string;
  readonly host: HarnessName;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly planApproved: boolean;
  /** Its session, whose transcript the turns read sends. */
  readonly session: string | null;
  /** Null: an action that cannot be read. */
  readonly actions: readonly (ActionView | null)[];
}

export interface MessageView {
  readonly id: string;
  readonly at: string;
  readonly from: string;
  readonly to: string;
  readonly kind: MessageKind;
  readonly text: string;
  readonly status: string | null;
  /** The recipient's next text after it, a model claim. */
  readonly answer: string | null;
}

/**
 * A task in a run's read. `read`: from its record. `large`: its record is
 * larger than a summary reads, so only its newest assignment shows: opening
 * the task reads the record in full. `unreadable`: its record cannot be read.
 */
export interface TaskSummary {
  readonly id: string;
  readonly record: 'read' | 'large' | 'unreadable';
  readonly title: string | null;
  readonly state: string | null;
  readonly host: HarnessName | null;
  readonly model: string | null;
  readonly attempts: number | null;
  readonly versions: number | null;
  /** How its newest attempt ended. */
  readonly outcome: string | null;
  readonly createdAt: string | null;
}

export interface TaskVersionView {
  readonly number: number;
  readonly at: string | null;
  /** How the harness turn ended. */
  readonly turn: string | null;
  readonly files: readonly {
    readonly path: string;
    readonly change: string | null;
    readonly inScope: boolean;
  }[];
  readonly reply: string | null;
  readonly decision: {
    readonly kind: 'accepted' | 'rejected' | 'changes';
    readonly note: string | null;
    readonly by: 'person' | 'coordinator';
  } | null;
}

export interface TaskAttemptView {
  readonly number: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
  /** Its session, whose transcript the turns read sends. */
  readonly session: string | null;
  readonly versions: readonly TaskVersionView[];
}

/** A task of a run in full. */
export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly state: string;
  readonly host: HarnessName;
  readonly model: string | null;
  readonly revision: number;
  readonly attempts: readonly TaskAttemptView[];
}

export interface PodView {
  readonly lease: string;
  readonly gpu: string;
  readonly state: string;
  readonly tasks: readonly string[];
  readonly requestedAt: string;
  /** What it cost. Null when its record does not say. */
  readonly costUsd: number | null;
}

export interface ResearchHistory {
  readonly kind: 'research';
  readonly info: HistoryRunInfo;
  readonly workspace: Workspace | null;
  /** The newest attempts, newest first. */
  readonly attempts: readonly HistoryAttempt[];
  /** The attempts that `attempts` does not hold. */
  readonly moreAttempts: number;
  readonly coordinator: CoordinatorView | null;
  /** In task order. */
  readonly tasks: readonly TaskSummary[];
  readonly moreTasks: number;
  /** The newest messages, oldest first. */
  readonly messages: readonly MessageView[];
  /** The run's messages that read. */
  readonly messageCount: number;
  readonly results: readonly ResultsView[];
  /** The results files that History did not read. */
  readonly moreResults: number;
  /** The person's own sessions, newest first. */
  readonly sessions: readonly HistorySession[];
  /** The pods of this run's tasks. */
  readonly pods: readonly PodView[];
  readonly morePods: number;
}

export type HistoryRun = LabHistory | ResearchHistory;

/** A text field of a record, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A time field of a record: text that reads as a time, or null. */
function time(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

/** A field that is one of `known`, or null. */
function oneOf<T extends string>(
  value: unknown,
  known: readonly T[],
): T | null {
  return known.find((entry) => entry === value) ?? null;
}

/** The text items of a list field. Not a list: none. */
function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** A flag field of a record: only `true` is set. */
function yes(value: unknown): boolean {
  return value === true;
}

function sessionOf(value: unknown): string | null {
  return typeof value === 'string' && validSessionId(value) ? value : null;
}

/**
 * The path of `parts` under `base`, a run's records, when each folder on the
 * way is a real folder and not a link, else null.
 */
async function under(
  base: string,
  parts: readonly string[],
): Promise<string | null> {
  let path = base;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    if (index < parts.length - 1 && !(await isFolder(path))) return null;
  }
  return path;
}

/**
 * A record under `base`: a JSON value from a regular file of at most
 * `bytes`, or null. Never through a link.
 */
async function readRecord(
  base: string,
  parts: readonly string[],
  bytes: number = historyLimits.recordBytes,
): Promise<unknown> {
  try {
    const path = await under(base, parts);
    const stats = path ? await lstat(path) : null;
    if (!path || !stats?.isFile() || stats.size > bytes) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Whether `parts` under `base` is a regular file. Never through a link. */
async function fileUnder(
  base: string,
  parts: readonly string[],
): Promise<boolean> {
  const path = await under(base, parts);
  return (
    path !== null && (await lstat(path).catch(() => null))?.isFile() === true
  );
}

/** The names in a real folder under `base`, or none. A link is not a folder. */
async function names(base: string, ...parts: string[]): Promise<string[]> {
  try {
    const path = await under(base, [...parts, '']);
    return path && (await isFolder(path)) ? await readdir(path) : [];
  } catch {
    return [];
  }
}

async function readWorkspace(folder: string): Promise<Workspace | null> {
  try {
    return parseWorkspace(
      await readRecord(folder, ['workspace.json'], 1_000_000),
    );
  } catch {
    return null;
  }
}

/** A lab's state in `folder`, the way its owner reads it: unreadable counts as none. */
async function labState(folder: string): Promise<LabState | null> {
  return parseState(object(await readRecord(folder, ['lab.json'])));
}

/**
 * Whether the records in `folder`, a project's `.verifold/`, hold a run of
 * the research flow. A lab project also keeps its question as research that
 * needs a plan, with no directions, so that alone is no sign. Nor is a
 * research step's lock: it stands only while the step runs.
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
  // Folders and files that only the research flow makes.
  return (
    (await names(folder, 'runs')).some((name) => validAttemptId(name)) ||
    (await names(folder, 'tasks')).some(validTaskId) ||
    (await names(folder, 'coordinator')).includes('state.json') ||
    (await names(folder, 'messages')).some(
      (name) => name.endsWith('.json') && validMessageId(name.slice(0, -5)),
    ) ||
    (await names(folder)).some(isResults)
  );
}

/**
 * Whether the project's current run is from the research flow: it has no
 * lab, and its records hold research attempts, directions, the coordinator,
 * tasks, messages, or results. A lab must not start on top of such a run.
 * A lab owns the run when its `lab.json` reads, the way the lab's owner reads
 * it, so a project with an unreadable one can still archive its run.
 */
export async function researchRunOnDisk(root: string): Promise<boolean> {
  const folder = join(root, '.verifold');
  if (await labState(folder)) return false;
  return researchIn(folder);
}

/** The files and folders in `.verifold/` that `researchRunOnDisk` reads. A folder changes when an entry comes or goes. */
const researchParts = [
  '.',
  'lab.json',
  'workspace.json',
  'runs',
  'tasks',
  'coordinator',
  'messages',
];

/**
 * `researchRunOnDisk`, read again only after a change: the snapshot asks
 * about once a second, and the watch looks only at the times of the few
 * files and folders that the answer depends on.
 */
export class ResearchRunWatch {
  private last: { readonly key: string; readonly value: boolean } | null = null;
  private readonly check: (root: string) => Promise<boolean>;

  /** `check`: the read itself. Tests count its calls. */
  constructor(check: (root: string) => Promise<boolean> = researchRunOnDisk) {
    this.check = check;
  }

  async read(root: string): Promise<boolean> {
    const stats = await Promise.all(
      researchParts.map((part) =>
        lstat(join(root, '.verifold', part)).catch(() => null),
      ),
    );
    const key = [
      root,
      ...stats.map((entry) =>
        entry ? `${entry.ino}:${entry.mtimeMs}:${entry.size}` : '-',
      ),
    ].join('\n');
    if (this.last?.key === key) return this.last.value;
    const value = await this.check(root);
    this.last = { key, value };
    return value;
  }
}

function infoOf(run: ArchiveInfo, bytes: number | null): HistoryRunInfo {
  return {
    id: run.id,
    kind: run.kind,
    at: run.at,
    question: run.question,
    direction: run.direction,
    bytes,
    tasks: run.tasks,
  };
}

async function currentInfo(root: string): Promise<HistoryRunInfo | null> {
  if (!(await researchRunOnDisk(root))) return null;
  const folder = join(root, '.verifold');
  const workspace = await readWorkspace(folder);
  return {
    id: 'current',
    kind: 'research',
    at: null,
    question: workspace?.research?.topic ?? null,
    direction:
      workspace?.candidates.find((idea) => idea.id === workspace.selectedId)
        ?.title ?? null,
    bytes: null,
    tasks: (await names(folder, 'tasks')).filter(validTaskId).length,
  };
}

/** The project's runs: the current research-flow run, if any, and the newest archived runs with their sizes. */
export async function historyIndex(root: string): Promise<HistoryIndex> {
  const ids = await archiveIds(root);
  const runs: HistoryRunInfo[] = [];
  for (const id of ids.slice(0, historyLimits.runs)) {
    const run = await readArchive(root, id);
    if (run)
      runs.push(infoOf(run, await archiveSize(root, id).catch(() => null)));
  }
  return {
    current: await currentInfo(root),
    runs,
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
  const run = await readArchive(root, id);
  return run
    ? { folder: archiveFolder(root, id), info: infoOf(run, null) }
    : null;
}

async function labHistory(
  folder: string,
  info: HistoryRunInfo,
): Promise<LabHistory> {
  // The board's folder passes the same check as every folder here: a link is not one.
  const board = new Board('', join(folder, 'board'));
  if (await isFolder(join(folder, 'board'))) await board.load();
  const posts = board.list();
  const agents = new Map<
    string,
    { readonly handle: string; readonly host: HarnessName }
  >();
  for (const name of (await names(folder, 'lab', 'agents')).filter((entry) =>
    /^a-[1-9]\d{0,3}\.json$/.test(entry),
  )) {
    const entry = object(await readRecord(folder, ['lab', 'agents', name]));
    if (
      entry &&
      `${String(entry.id)}.json` === name &&
      typeof entry.handle === 'string' &&
      (entry.host === 'claude' || entry.host === 'codex')
    )
      agents.set(String(entry.id), { handle: entry.handle, host: entry.host });
  }
  const runs: RunRecord[] = [];
  for (const name of (await names(folder, 'lab', 'runs')).filter((entry) =>
    runId.test(entry),
  )) {
    const run = parseRun(
      object(await readRecord(folder, ['lab', 'runs', name, 'run.json'])),
    );
    if (run?.id === name) runs.push(run);
  }
  runs.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  return {
    kind: 'lab',
    info,
    state: await labState(folder),
    posts: posts.slice(-historyLimits.posts),
    postCount: posts.length,
    agents,
    runs: runs.slice(-historyLimits.labRuns),
  };
}

async function attemptOf(folder: string, id: string): Promise<HistoryAttempt> {
  let record: AttemptRecord | null = null;
  let report: ResearchReport | null = null;
  try {
    record = parseAttempt(
      await readRecord(folder, ['runs', id, 'attempt.json'], 4000),
      id,
    );
  } catch {
    /* An old or broken record shows without its details. */
  }
  try {
    const value = await readRecord(folder, ['runs', id, 'report.json']);
    report = value === null ? null : parseReport(value);
  } catch {
    /* A report that does not parse shows as none. */
  }
  return {
    id,
    record,
    report,
    transcript: await fileUnder(folder, ['runs', id, 'transcript.jsonl']),
  };
}

const outcomes = [
  'accepted',
  'rejected',
  'cancelled',
  'allocation-failed',
  'start-failed',
] as const;

/** The newest assignment of a task, from its revision folders, or null. */
async function newestAssignment(
  folder: string,
  id: string,
): Promise<Assignment | null> {
  const newest = (await names(folder, 'tasks', id))
    .filter((name) => /^r[1-9]\d{0,5}$/.test(name))
    .reduce((top, name) => Math.max(top, Number(name.slice(1))), 0);
  return newest
    ? parseAssignment(
        await readRecord(
          folder,
          ['tasks', id, `r${newest}`, 'assignment.json'],
          1_000_000,
        ),
      )
    : null;
}

/**
 * A task's summary. A task record keeps every version with its files, so
 * only a small one is read here; opening the task reads it in full.
 */
async function taskSummary(folder: string, id: string): Promise<TaskSummary> {
  const path = await under(folder, ['tasks', id, 'task.json']);
  const stats = path ? await lstat(path).catch(() => null) : null;
  const large =
    stats?.isFile() === true && stats.size > historyLimits.summaryBytes;
  const task = large
    ? null
    : parseTask(
        await readRecord(
          folder,
          ['tasks', id, 'task.json'],
          historyLimits.summaryBytes,
        ),
      );
  if (task?.id === id)
    return {
      id,
      record: 'read',
      title: task.assignment.title,
      state: task.state,
      host: task.assignment.host,
      model: task.assignment.model,
      attempts: task.attempts.length,
      versions: task.attempts.reduce(
        (sum, attempt) => sum + attempt.versions.length,
        0,
      ),
      outcome: oneOf(task.attempts.at(-1)?.outcome, outcomes),
      createdAt: time(task.createdAt),
    };
  // Without its record, its newest assignment still names the task.
  const assignment = await newestAssignment(folder, id);
  return {
    id,
    record: large ? 'large' : 'unreadable',
    title: assignment?.title ?? null,
    state: null,
    host: assignment?.host ?? null,
    model: assignment?.model ?? null,
    attempts: null,
    versions: null,
    outcome: null,
    createdAt: null,
  };
}

const statuses = [
  'open',
  'withdrawn',
  'upheld',
  'overruled',
  'resolved',
] as const;

function checkOf(value: unknown): ResultCheck | null {
  const entry = object(value);
  const result = oneOf(entry?.result, [
    'passed',
    'failed',
    'partial',
    'judgement',
  ]);
  const ruling = object(entry?.ruling);
  const ruled = oneOf(ruling?.result, ['passed', 'failed', 'partial']);
  const reason = str(ruling?.reason);
  if (
    !entry ||
    !Number.isSafeInteger(entry.check) ||
    (entry.check as number) < 1 ||
    !result ||
    typeof entry.value !== 'string' ||
    typeof entry.reason !== 'string'
  )
    return null;
  return {
    check: entry.check as number,
    result,
    value: entry.value,
    reason: entry.reason,
    ruling: ruled && reason !== null ? { result: ruled, reason } : null,
  };
}

function claimOf(value: unknown): ResultClaim | null {
  const entry = object(value);
  return entry && typeof entry.text === 'string'
    ? { text: entry.text, evidence: texts(entry.evidence) }
    : null;
}

/** The results of a direction, each field checked, or null when the file is not results. */
function resultsOf(value: unknown): ResultsView | null {
  const entry = parseResults(value);
  if (!entry) return null;
  const answer: unknown = entry.answer;
  const shown = object(answer);
  const decision = object(shown?.decision);
  const kind = oneOf(decision?.kind, ['accepted', 'more']);
  return {
    direction: entry.direction,
    checks: entry.checks.map(checkOf),
    answer:
      answer === null
        ? null
        : {
            statement: str(shown?.statement),
            claims: Array.isArray(shown?.claims)
              ? shown.claims.map(claimOf)
              : [],
            decision: kind ? { kind, note: str(decision?.note) } : null,
          },
  };
}

function actionOf(value: unknown): ActionView | null {
  const action = object(value);
  const at = time(action?.at);
  const tool = str(action?.tool);
  const result = str(action?.result);
  if (!action || !at || tool === null || result === null) return null;
  return typeof action.ok === 'boolean'
    ? { at, tool, reason: str(action.reason), ok: action.ok, result }
    : null;
}

function coordinatorOf(value: unknown): CoordinatorView | null {
  const entry = parseCoordinator(value);
  return entry
    ? {
        objective: entry.objective,
        host: entry.host,
        model: str(entry.model),
        startedAt: time(entry.startedAt),
        stoppedAt: time(entry.stoppedAt),
        planApproved: entry.planApproved,
        session: sessionOf(entry.session),
        actions: entry.actions.map(actionOf),
      }
    : null;
}

/** A pod of a lease, each field checked, or null. */
function podOf(value: unknown, now: number): PodView | null {
  const lease = object(value);
  const tasks = Array.isArray(lease?.tasks) ? texts(lease?.tasks) : null;
  const requestedAt = time(lease?.requestedAt);
  if (
    !lease ||
    typeof lease.id !== 'string' ||
    typeof lease.gpu !== 'string' ||
    typeof lease.state !== 'string' ||
    !tasks ||
    !requestedAt
  )
    return null;
  let cost: number | null = null;
  try {
    cost = spent(value as Lease, now);
  } catch {
    /* A lease without its intervals has no cost to show. */
  }
  return {
    lease: lease.id,
    gpu: lease.gpu,
    state: lease.state,
    tasks,
    requestedAt,
    costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
  };
}

async function researchHistory(
  root: string,
  folder: string,
  info: HistoryRunInfo,
): Promise<ResearchHistory> {
  const workspace = await readWorkspace(folder);
  // The newest attempts by the times of their folders, so only those records are read.
  const timed: { readonly id: string; readonly at: number }[] = [];
  for (const id of (await names(folder, 'runs')).filter((name) =>
    validAttemptId(name),
  )) {
    const stats = await lstat(join(folder, 'runs', id)).catch(() => null);
    if (stats?.isDirectory()) timed.push({ id, at: stats.mtimeMs });
  }
  timed.sort((a, b) => b.at - a.at);
  const attempts: HistoryAttempt[] = [];
  for (const { id } of timed.slice(0, historyLimits.attempts))
    attempts.push(await attemptOf(folder, id));
  attempts.sort((a, b) =>
    (b.record?.startedAt ?? '').localeCompare(a.record?.startedAt ?? ''),
  );
  const taskIds = (await names(folder, 'tasks'))
    .filter(validTaskId)
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const tasks: TaskSummary[] = [];
  for (const id of taskIds.slice(0, historyLimits.tasks))
    tasks.push(await taskSummary(folder, id));
  // The messages as the research flow read them: the oldest files up to its limit. Only the ones that read count.
  const messages: MessageView[] = [];
  for (const name of (await names(folder, 'messages'))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -5))
    .filter(validMessageId)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
    .slice(0, historyLimits.messageFiles)) {
    const message = parseMessage(
      await readRecord(
        folder,
        ['messages', `${name}.json`],
        historyLimits.messageBytes,
      ),
    );
    if (message?.id === name)
      messages.push({
        id: message.id,
        at: message.at,
        from: message.from,
        to: message.to,
        kind: message.kind,
        text: message.text,
        status: oneOf(message.status, statuses),
        answer: message.answer?.text ?? null,
      });
  }
  const resultNames = (await names(folder)).filter(isResults).sort();
  const results: ResultsView[] = [];
  for (const name of resultNames.slice(0, historyLimits.results)) {
    const value = resultsOf(await readRecord(folder, [name], 2_000_000));
    if (value) results.push(value);
  }
  const sessions: HistorySession[] = [];
  for (const name of (await names(folder, 'sessions'))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -5))
    .filter(validSessionId)
    .sort()
    .reverse()) {
    if (sessions.length >= historyLimits.sessions) break;
    const path = await under(folder, ['sessions', `${name}.json`]);
    const record = path ? await readSessionRecord(path) : null;
    // The person's own sessions: a task's, a lab agent's, or the coordinator's session shows with its task, direction, or the coordinator.
    if (
      record &&
      !record.task &&
      !record.agent &&
      record.mode !== 'coordinator'
    )
      sessions.push({
        record,
        transcript: await fileUnder(folder, [
          'sessions',
          `${name}.transcript.jsonl`,
        ]),
      });
  }
  const coordinator = coordinatorOf(
    await readRecord(folder, ['coordinator', 'state.json']),
  );
  // Leases stay with the project. A pod belongs to this run when it served one of its tasks while the run lasted.
  const now = Date.now();
  const from = [
    ...attempts.flatMap((attempt) =>
      attempt.record ? [attempt.record.startedAt] : [],
    ),
    ...tasks.flatMap((task) => (task.createdAt ? [task.createdAt] : [])),
    ...(coordinator?.startedAt ? [coordinator.startedAt] : []),
  ].sort()[0];
  const until = info.at ?? new Date(now).toISOString();
  const ids = new Set(taskIds);
  const pods = from
    ? (await readLeases(join(root, '.verifold', 'compute', 'leases')))
        .map((lease) => podOf(lease, now))
        .filter(
          (pod): pod is PodView =>
            pod !== null &&
            pod.tasks.some((task) => ids.has(task)) &&
            pod.requestedAt >= from &&
            pod.requestedAt <= until,
        )
    : [];
  return {
    kind: 'research',
    info,
    workspace,
    attempts,
    moreAttempts: timed.length - attempts.length,
    coordinator,
    tasks,
    moreTasks: taskIds.length - tasks.length,
    messages: messages.slice(-historyLimits.messages),
    messageCount: messages.length,
    results,
    moreResults: Math.max(0, resultNames.length - historyLimits.results),
    sessions,
    pods: pods.slice(0, historyLimits.pods),
    morePods: Math.max(0, pods.length - historyLimits.pods),
  };
}

/** One run of History, or null when the project has no such run. */
export async function historyRun(
  root: string,
  id: string,
): Promise<HistoryRun | null> {
  const found = await runFolder(root, id);
  if (!found) return null;
  return found.info.kind === 'lab'
    ? labHistory(found.folder, found.info)
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
  const parts =
    kind === 'attempt'
      ? validAttemptId(name)
        ? ['runs', name, 'transcript.jsonl']
        : null
      : validSessionId(name)
        ? ['sessions', `${name}.transcript.jsonl`]
        : null;
  return parts && (await fileUnder(found.folder, parts))
    ? join(found.folder, ...parts)
    : null;
}

/** A task's record in a run's folder, read in full, or null. */
async function readTask(
  folder: string,
  task: string,
): Promise<TaskRecord | null> {
  const record = parseTask(
    await readRecord(
      folder,
      ['tasks', task, 'task.json'],
      historyLimits.taskBytes,
    ),
  );
  return record?.id === task ? withoutLeftOut(record) : null;
}

function versionOf(version: TaskVersion): TaskVersionView {
  const decision = object(version.decision);
  const kind = oneOf(decision?.kind, ['accepted', 'rejected', 'changes']);
  return {
    number: version.number,
    at: time(version.at),
    turn: oneOf(version.turn, [
      'completed',
      'interrupted',
      'failed',
      'exited',
      'time-limit',
      'stopped',
      'terminal',
    ]),
    files: version.files.map((file) => ({
      path: file.path,
      change: oneOf(file.change, ['added', 'modified', 'deleted']),
      inScope: yes(file.inScope),
    })),
    reply: str(version.reply),
    decision: kind
      ? {
          kind,
          note: str(decision?.note),
          by: decision?.by === 'coordinator' ? 'coordinator' : 'person',
        }
      : null,
  };
}

/** One task of a run in full, each field checked, or null when the run or the task is not there. */
export async function historyTask(
  root: string,
  id: string,
  task: string,
): Promise<TaskView | null> {
  const found = await runFolder(root, id);
  const record =
    found && validTaskId(task) ? await readTask(found.folder, task) : null;
  return record
    ? {
        id: record.id,
        title: record.assignment.title,
        objective: record.assignment.objective,
        state: record.state,
        host: record.assignment.host,
        model: record.assignment.model,
        revision: record.revision,
        attempts: record.attempts.map((attempt) => ({
          number: attempt.number,
          startedAt: time(attempt.startedAt),
          endedAt: time(attempt.endedAt),
          outcome: oneOf(attempt.outcome, outcomes),
          note: str(attempt.note),
          session: sessionOf(attempt.session),
          versions: attempt.versions.map(versionOf),
        })),
      }
    : null;
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
  const found = await runFolder(root, id);
  const record =
    found && validTaskId(task) ? await readTask(found.folder, task) : null;
  if (!found || !record) return null;
  for (const attempt of record.attempts)
    for (const entry of attempt.versions)
      if (entry.number === version && attempt.workspace) {
        const shown = entry.files.find((candidate) => candidate.path === file);
        if (!shown) return null;
        const workspace = attempt.workspace;
        const gitDir =
          workspace.kind === 'folder'
            ? await under(found.folder, [
                'tasks',
                'git',
                basename(workspace.path),
                '',
              ])
            : null;
        if (workspace.kind === 'folder' && !gitDir) return null;
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

/** True for the second and later bytes of a UTF-8 character. */
const inside = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/**
 * The start of a memory file, at most `bytes`, cut between characters, or
 * null when it is not a regular file of plain text.
 */
async function memoryText(
  path: string,
  bytes: number,
): Promise<{ readonly text: string; readonly cut: boolean } | null> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!file) return null;
  try {
    const stats = await file.stat();
    if (!stats.isFile()) return null;
    // A few bytes past the bound show where the last character ends.
    const buffer = Buffer.alloc(Math.min(stats.size, bytes + 4));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    let end = Math.min(bytesRead, bytes);
    while (end > 0 && end < bytesRead && inside(buffer[end])) end--;
    const text = buffer.subarray(0, end).toString('utf8');
    return text.includes('\0') ? null : { text, cut: end < stats.size };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** The project's memory files, as plain text: a long one shows its start. A file that is not plain text is left out. */
export async function memoryFiles(root: string): Promise<
  readonly {
    readonly name: string;
    readonly text: string;
    readonly cut: boolean;
  }[]
> {
  const found: { name: string; text: string; cut: boolean }[] = [];
  for (const name of (await names(root, 'memory'))
    .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/.test(entry))
    .sort((a, b) =>
      a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b),
    )
    .slice(0, historyLimits.memoryFiles)) {
    const shown = await memoryText(
      join(root, 'memory', name),
      historyLimits.memoryBytes,
    );
    if (shown) found.push({ name, ...shown });
  }
  return found;
}
