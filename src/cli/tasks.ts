import { createHash, randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateModel, type HarnessName } from './harness.ts';
import { loadPrompt } from './prompts.ts';
import { hostName, SessionActionError } from './session.ts';
import {
  allocate,
  changes,
  commitVersion,
  diff,
  inScope,
  integrate,
  overlaps,
  projectPath,
  release,
  type ChangedFile,
  type Workspace,
} from './workspaces.ts';

/**
 * Scoped tasks: what one worker must do, with its inputs, writable paths, and
 * limits. A start claims the task and allocates a workspace before any
 * harness runs. Each harness turn ends in a fixed version. The person accepts
 * selected files, asks for changes, or rejects the version. Tasks run one at a
 * time in this stage.
 */

export type TaskState =
  | 'open'
  | 'claimed'
  | 'running'
  | 'review'
  | 'done'
  | 'cancelled';

export interface TaskInput {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** One revision of a task. Its file is written once and never changes. */
export interface Assignment {
  readonly revision: number;
  readonly at: string;
  /** Why this revision exists. */
  readonly reason: string;
  readonly title: string;
  readonly objective: string;
  /** Copies are in the revision folder, so later edits in the project do not change them. */
  readonly inputs: readonly TaskInput[];
  readonly writable: readonly string[];
  readonly output: string;
  readonly host: HarnessName;
  readonly model: string | null;
  /** The time limit for one harness turn. */
  readonly minutes: number;
  readonly dependencies: readonly string[];
}

export interface VersionFile extends ChangedFile {
  readonly inScope: boolean;
}

export interface TaskVersion {
  readonly number: number;
  readonly commit: string;
  readonly at: string;
  /** How the harness turn ended. `stopped`: Verifold stopped while the turn ran. */
  readonly turn:
    | 'completed'
    | 'interrupted'
    | 'failed'
    | 'exited'
    | 'time-limit'
    | 'stopped'
    /** The person worked in the harness's own terminal. */
    | 'terminal';
  readonly files: readonly VersionFile[];
  /** Files above the size limit that the version does not hold. */
  readonly skipped: readonly string[];
  /** What the harness reported when it ended, for example that it could not start. */
  readonly note?: string;
  readonly decision: {
    readonly kind: 'accepted' | 'rejected' | 'changes';
    readonly at: string;
    readonly files?: readonly string[];
    readonly note?: string;
  } | null;
  /** The last Accept found these targets changed in the project. */
  readonly conflicts?: readonly string[];
}

export interface TaskAttempt {
  readonly number: number;
  readonly revision: number;
  readonly claim: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly workspace: Workspace | null;
  readonly session: string | null;
  /** The limits that the harness enforces for this attempt, as Verifold configured them. */
  readonly restrictions: readonly string[];
  readonly outcome:
    | 'accepted'
    | 'rejected'
    | 'cancelled'
    | 'allocation-failed'
    | 'start-failed'
    | null;
  readonly note: string | null;
  readonly versions: readonly TaskVersion[];
}

export interface TaskRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly state: TaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The current assignment. Each revision also has its own unchangeable file. */
  readonly assignment: Assignment;
  /** The owner that holds the task. A start sets it; the end of the attempt clears it. */
  readonly claim: {
    readonly id: string;
    readonly revision: number;
    readonly attempt: number;
    readonly ownerId: string;
    readonly at: string;
  } | null;
  readonly attempts: readonly TaskAttempt[];
}

/** The fields that a person writes for a task or a revision. */
export interface TaskInputFields {
  readonly title: unknown;
  readonly objective: unknown;
  readonly inputs?: unknown;
  readonly writable: unknown;
  readonly output: unknown;
  readonly host: unknown;
  readonly model?: unknown;
  readonly minutes?: unknown;
  readonly dependencies?: unknown;
}

/**
 * The part of the session owner that tasks use. A task session runs in the
 * workspace with strict limits, and its turns report back through `turnEnded`.
 */
export interface TaskSessions {
  /** Every worker slot is in use. */
  readonly full: boolean;
  startTask(input: {
    readonly host: HarnessName;
    readonly model?: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly task: { readonly id: string; readonly claim: string };
  }): Promise<string>;
  /** The session is live and waits for a follow-up. */
  idle(session: string): boolean;
  continueTask(session: string, text: string): void;
  cancel(session: string): void;
  endTask(session: string, reason: string): void;
  /** Hand the session to the person in its native terminal. */
  takeTerminal(session: string, lease: string): Promise<void>;
}

export interface TaskManagerOptions {
  readonly ownerId: string;
  readonly sessions: TaskSessions;
  /** One line for the owner terminal when a task changes state. */
  readonly progress?: (line: string) => void;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

const limits = {
  tasks: 200,
  inputs: 50,
  inputBytes: 1024 * 1024,
  inputTotal: 10 * 1024 * 1024,
  writable: 20,
  dependencies: 20,
};

function line(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(`Write the ${name}, up to ${max} characters.`);
  return value.trim();
}

function paths(value: unknown, name: string, max: number): string[] {
  const items =
    typeof value === 'string'
      ? value.split('\n')
      : Array.isArray(value)
        ? (value as unknown[])
        : value === undefined
          ? []
          : fail(`List the ${name} one per line.`);
  const found = new Set<string>();
  for (const item of items) {
    if (typeof item === 'string' && !item.trim()) continue;
    try {
      found.add(projectPath(item));
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Invalid path.');
    }
  }
  if (found.size > max) fail(`List at most ${max} ${name}.`);
  return [...found];
}

export function validTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^task-[1-9]\d{0,5}$/.test(id);
}

/**
 * Owns the tasks of one project. Every change runs in one queue, so a claim,
 * a version, and a decision cannot interleave.
 */
export class TaskManager {
  private readonly root: string;
  private readonly options: TaskManagerOptions;
  private queue: Promise<unknown> = Promise.resolve();
  /** The time limit of each running turn, by task. */
  private readonly limits = new Map<
    string,
    { readonly timer: NodeJS.Timeout; expired: boolean }
  >();

  constructor(root: string, options: TaskManagerOptions) {
    this.root = root;
    this.options = options;
  }

  private get directory(): string {
    return join(this.root, '.verifold', 'tasks');
  }

  /** Run one change after the previous one ends. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** All tasks, oldest first. */
  async list(): Promise<TaskRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const tasks: TaskRecord[] = [];
    for (const name of names
      .filter(validTaskId)
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .slice(0, limits.tasks)) {
      const task = await this.read(name);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async get(id: unknown): Promise<TaskRecord | null> {
    return validTaskId(id) ? this.read(id) : null;
  }

  /** Create a task from the person's fields. Returns its ID. */
  create(fields: TaskInputFields): Promise<string> {
    return this.serial(async () => {
      const existing = await this.list();
      if (existing.length >= limits.tasks)
        fail(`A project holds at most ${limits.tasks} tasks.`);
      const number =
        Math.max(0, ...existing.map((task) => Number(task.id.slice(5)))) + 1;
      const id = `task-${number}`;
      const folder = join(this.directory, id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      let assignment: Assignment;
      try {
        assignment = await this.assignment(id, 1, fields, 'Created', existing);
      } catch (error) {
        // A folder without task.json is not a task. Remove it, so the next create starts clean.
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
      const now = new Date().toISOString();
      await this.write({
        schemaVersion: 1,
        id,
        revision: 1,
        state: 'open',
        createdAt: now,
        updatedAt: now,
        assignment,
        claim: null,
        attempts: [],
      });
      this.options.progress?.(`Task ${id} created: ${assignment.title}.`);
      return id;
    });
  }

  /** A new revision. Earlier attempts keep the assignment of their own revision. */
  edit(
    id: unknown,
    fields: TaskInputFields & { readonly reason: unknown },
  ): Promise<void> {
    return this.serial(async () => {
      const task = await this.load(id);
      if (task.state !== 'open')
        fail(
          'Edit a task only while it is open. Reject or cancel its current version first.',
        );
      const reason = line(fields.reason, 'reason for the change', 500);
      let assignment: Assignment;
      try {
        assignment = await this.assignment(
          task.id,
          task.revision + 1,
          fields,
          reason,
          await this.list(),
        );
      } catch (error) {
        await rm(this.revisionFolder(task.id, task.revision + 1), {
          recursive: true,
          force: true,
        });
        throw error;
      }
      await this.write({
        ...task,
        revision: assignment.revision,
        assignment,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /**
   * Claim the task, allocate its workspace, and start a strict harness session
   * in it. Each step happens only after the previous one is saved.
   */
  start(id: unknown): Promise<void> {
    return this.serial(async () => {
      const task = await this.load(id);
      if (task.state !== 'open') fail('Only an open task can start.');
      const all = await this.list();
      for (const dependency of task.assignment.dependencies) {
        const other = all.find((entry) => entry.id === dependency);
        if (other?.state !== 'done')
          fail(
            `This task waits for ${dependency}${other ? ` (${other.assignment.title})` : ''}.`,
          );
      }
      for (const other of all)
        if (
          other.id !== task.id &&
          ['claimed', 'running', 'review'].includes(other.state) &&
          overlaps(other.assignment.writable, task.assignment.writable)
        )
          fail(
            `${other.id} can write to the same paths. Accept, reject, or cancel its version first.`,
          );
      if (this.options.sessions.full)
        fail(
          'Every worker is busy. End a session, or accept, reject, or cancel a task version first.',
        );
      const number = task.attempts.length + 1;
      const claim = {
        id: randomBytes(8).toString('hex'),
        revision: task.revision,
        attempt: number,
        ownerId: this.options.ownerId,
        at: new Date().toISOString(),
      };
      let current: TaskRecord = await this.write({
        ...task,
        state: 'claimed',
        claim,
        attempts: [
          ...task.attempts,
          {
            number,
            revision: task.revision,
            claim: claim.id,
            startedAt: claim.at,
            endedAt: null,
            workspace: null,
            session: null,
            restrictions: restrictions(task.assignment.host),
            outcome: null,
            note: null,
            versions: [],
          },
        ],
      });
      const end = async (
        outcome: 'allocation-failed' | 'start-failed',
        error: unknown,
      ): Promise<never> => {
        const note = error instanceof Error ? error.message : 'Unknown error.';
        await this.write(
          this.attempt({ ...current, state: 'open', claim: null }, () => ({
            outcome,
            note,
            endedAt: new Date().toISOString(),
          })),
        );
        fail(
          outcome === 'allocation-failed'
            ? `Verifold could not prepare the task folder: ${note}`
            : `The harness did not start: ${note}`,
        );
      };
      let workspace: Workspace;
      try {
        workspace = await allocate(this.root, {
          name: `${task.id}-r${task.revision}-a${number}-${randomBytes(2).toString('hex')}`,
          writable: task.assignment.writable,
          inputs: task.assignment.inputs.map((input) => ({
            path: input.path,
            copy: join(
              this.revisionFolder(task.id, task.revision),
              'inputs',
              input.path,
            ),
          })),
        });
      } catch (error) {
        return end('allocation-failed', error);
      }
      current = await this.write(
        this.attempt({ ...current, state: 'running' }, () => ({ workspace })),
      );
      let session: string;
      try {
        session = await this.options.sessions.startTask({
          host: task.assignment.host,
          ...(task.assignment.model ? { model: task.assignment.model } : {}),
          prompt: await prompt(task.assignment),
          cwd: join(this.root, workspace.path),
          task: { id: task.id, claim: claim.id },
        });
      } catch (error) {
        await release(this.root, workspace);
        return end('start-failed', error);
      }
      await this.write(this.attempt(current, () => ({ session })));
      this.limit(task.id, session, task.assignment.minutes);
      this.options.progress?.(
        `Task ${task.id} started with ${hostName(task.assignment.host)}. Follow it in the desk.`,
      );
    });
  }

  /** Stop the running turn. Its work becomes a version for review. */
  async stop(id: unknown): Promise<void> {
    const task = await this.load(id);
    const session = task.attempts.at(-1)?.session;
    if (task.state !== 'running' || !session)
      fail('No turn of this task is running.');
    this.options.sessions.cancel(session);
  }

  /**
   * A harness turn of a task session ended. Save the workspace as a version.
   * A claim that is no longer current cannot add a version.
   */
  turnEnded(
    binding: { readonly id: string; readonly claim: string },
    turn: 'completed' | 'interrupted' | 'failed' | 'exited' | 'terminal',
    detail?: string,
  ): Promise<void> {
    return this.serial(async () => {
      const task = await this.read(binding.id);
      if (!task || task.claim?.id !== binding.claim || task.state !== 'running')
        return;
      const expired = this.limits.get(task.id)?.expired === true;
      this.clearLimit(task.id);
      await this.version(
        task,
        expired && turn === 'interrupted' ? 'time-limit' : turn,
        detail,
      );
    });
  }

  /**
   * The person takes over the task in the harness's own terminal, with the
   * task's limits. The latest version counts as changes asked for, and the
   * terminal's end saves the next version.
   */
  openTerminal(id: unknown, lease: string): Promise<void> {
    return this.serial(async () => {
      const task = await this.load(id);
      const attempt = this.review(task);
      const session = attempt.session;
      if (!session || !this.options.sessions.idle(session))
        fail(
          'The harness session of this task ended. Reject this version, then start the task again.',
        );
      await this.options.sessions.takeTerminal(session, lease);
      this.clearLimit(task.id);
      await this.write(
        this.decide({ ...task, state: 'running' }, attempt, {
          kind: 'changes',
          note: 'You worked in the terminal.',
        }),
      );
    });
  }

  /** Send the person's changes as a new turn. The next version follows. */
  askForChanges(id: unknown, note: unknown): Promise<void> {
    return this.serial(async () => {
      const task = await this.load(id);
      const text = line(note, 'changes', 4000);
      const attempt = this.review(task);
      const session = attempt.session;
      if (!session || !this.options.sessions.idle(session))
        fail(
          'The harness session of this task ended. Reject this version, then start the task again.',
        );
      await this.write(
        this.decide({ ...task, state: 'running' }, attempt, {
          kind: 'changes',
          note: text,
        }),
      );
      this.options.sessions.continueTask(
        session,
        `The person reviewed your version and asks for changes:\n\n${text}\n\nKeep to the writable paths. End your turn with a short reply again.`,
      );
      this.limit(task.id, session, task.assignment.minutes);
    });
  }

  /**
   * Copy the selected files of the latest version into the project. If a
   * target changed since the start, nothing is copied and the version lists
   * the conflicts.
   */
  accept(
    id: unknown,
    version: unknown,
    files: unknown,
  ): Promise<
    | { readonly applied: readonly string[] }
    | { readonly conflicts: readonly string[] }
  > {
    return this.serial(async () => {
      const task = await this.load(id);
      const attempt = this.review(task);
      const latest = this.latest(attempt, version);
      const selected = Array.isArray(files)
        ? [...new Set(files as unknown[])]
        : fail('Select the files to accept.');
      const allowed = new Map(
        latest.files
          .filter((file) => file.inScope && file.regular)
          .map((file) => [file.path, file]),
      );
      if (
        !selected.length ||
        selected.some((file) => typeof file !== 'string' || !allowed.has(file))
      )
        fail(
          'Select files of this version that are inside the writable paths.',
        );
      const workspace =
        attempt.workspace ?? fail('This attempt has no workspace.');
      let result;
      try {
        result = await integrate(
          this.root,
          workspace,
          latest.commit,
          selected as string[],
        );
      } catch (error) {
        fail(
          `Copying the files failed: ${error instanceof Error ? error.message : 'unknown error'}. Check the listed files in the project before you try again.`,
        );
      }
      if ('conflicts' in result) {
        await this.write(
          this.attempt(task, () => ({
            versions: attempt.versions.map((entry) =>
              entry === latest
                ? { ...entry, conflicts: result.conflicts }
                : entry,
            ),
          })),
        );
        return result;
      }
      await this.finish(
        this.decide(task, attempt, { kind: 'accepted', files: result.applied }),
        'accepted',
        'done',
      );
      this.options.progress?.(
        `Task ${task.id}: you accepted ${result.applied.length} ${result.applied.length === 1 ? 'file' : 'files'}.`,
      );
      return result;
    });
  }

  /** Reject the latest version. The task opens again for a new attempt or an edit. */
  reject(id: unknown, version: unknown): Promise<void> {
    return this.serial(async () => {
      const task = await this.load(id);
      const attempt = this.review(task);
      this.latest(attempt, version);
      await this.finish(
        this.decide(task, attempt, { kind: 'rejected' }),
        'rejected',
        'open',
      );
    });
  }

  /** Cancel an open task, or a task in review with its current version. */
  cancel(id: unknown): Promise<void> {
    return this.serial(async () => {
      const task = await this.load(id);
      if (task.state === 'open')
        await this.write({
          ...task,
          state: 'cancelled',
          updatedAt: new Date().toISOString(),
        });
      else if (task.state === 'review')
        await this.finish(task, 'cancelled', 'cancelled');
      else fail('Stop the running turn first, or wait for the version.');
    });
  }

  /** The diff of one file in one version. */
  async diff(
    id: unknown,
    version: unknown,
    path: unknown,
  ): Promise<{ readonly text: string; readonly cut: boolean }> {
    const task = await this.load(id);
    for (const attempt of task.attempts)
      for (const entry of attempt.versions)
        if (entry.number === version && attempt.workspace) {
          const file = entry.files.find((candidate) => candidate.path === path);
          if (!file) fail('That file is not in this version.');
          return diff(
            this.root,
            attempt.workspace,
            attempt.workspace.start,
            entry.commit,
            file.path,
          );
        }
    fail('That version does not exist.');
  }

  /**
   * After the owner stops or crashes, settle tasks without a live turn: a
   * claim without a workspace opens again, and a running task saves its
   * workspace as a stopped version.
   */
  settle(): Promise<number> {
    return this.serial(async () => {
      for (const id of this.limits.keys()) this.clearLimit(id);
      let settled = 0;
      for (const task of await this.list()) {
        if (task.state === 'claimed') {
          const attempt = task.attempts.at(-1);
          if (attempt?.workspace) await release(this.root, attempt.workspace);
          await this.write(
            this.attempt({ ...task, state: 'open', claim: null }, () => ({
              outcome: 'allocation-failed',
              note: 'Verifold stopped while it prepared the task folder.',
              endedAt: new Date().toISOString(),
            })),
          );
          settled++;
        } else if (task.state === 'running') {
          await this.version(task, 'stopped');
          settled++;
        }
      }
      return settled;
    });
  }

  private async version(
    task: TaskRecord,
    turn: TaskVersion['turn'],
    detail?: string,
  ): Promise<void> {
    const attempt = task.attempts.at(-1);
    const workspace = attempt?.workspace;
    if (!attempt || !workspace) return;
    const number =
      task.attempts.reduce((count, entry) => count + entry.versions.length, 0) +
      1;
    const assignment = await this.revision(task.id, attempt.revision);
    try {
      const saved = await commitVersion(
        this.root,
        workspace,
        assignment.writable,
        `Verifold: ${task.id} version ${number}`,
      );
      const files = await changes(
        this.root,
        workspace,
        workspace.start,
        saved.commit,
      );
      await this.write(
        this.attempt({ ...task, state: 'review' }, (current) => ({
          versions: [
            ...current.versions,
            {
              number,
              commit: saved.commit,
              at: new Date().toISOString(),
              turn,
              files: files.map((file) => ({
                ...file,
                inScope: inScope(file.path, assignment.writable),
              })),
              skipped: saved.skipped,
              decision: null,
              ...(detail ? { note: detail.slice(0, 2000) } : {}),
            },
          ],
        })),
      );
      this.options.progress?.(
        `Task ${task.id}: version ${number} is ready for review in the desk.`,
      );
    } catch (error) {
      await this.write(
        this.attempt({ ...task, state: 'review' }, () => ({
          note: `Verifold could not save a version: ${error instanceof Error ? error.message : 'unknown error'}`,
        })),
      );
    }
  }

  /** End the attempt: end its session, remove a clean workspace, and clear the claim. */
  private async finish(
    task: TaskRecord,
    outcome: 'accepted' | 'rejected' | 'cancelled',
    state: TaskState,
  ): Promise<void> {
    const attempt = task.attempts.at(-1);
    if (attempt?.session && this.options.sessions.idle(attempt.session))
      this.options.sessions.endTask(
        attempt.session,
        `The task ${outcome === 'accepted' ? 'is done' : `was ${outcome}`}.`,
      );
    const kept = attempt?.workspace
      ? !(await release(this.root, attempt.workspace))
      : false;
    await this.write(
      this.attempt({ ...task, state, claim: null }, () => ({
        outcome,
        endedAt: new Date().toISOString(),
        ...(kept
          ? {
              note: 'The task folder has changes that are not in a version, so Verifold kept it.',
            }
          : {}),
      })),
    );
  }

  private review(task: TaskRecord): TaskAttempt {
    const attempt = task.attempts.at(-1);
    if (task.state !== 'review' || !attempt)
      fail('This task has no version to review.');
    return attempt;
  }

  private latest(attempt: TaskAttempt, number: unknown): TaskVersion {
    const latest = attempt.versions.at(-1);
    if (!latest || latest.number !== number || latest.decision)
      fail('Review the latest version of this task. Refresh the desk.');
    return latest;
  }

  private decide(
    task: TaskRecord,
    attempt: TaskAttempt,
    decision: Omit<NonNullable<TaskVersion['decision']>, 'at'>,
  ): TaskRecord {
    return this.attempt(task, () => ({
      versions: attempt.versions.map((entry, index) =>
        index === attempt.versions.length - 1
          ? {
              ...entry,
              decision: { ...decision, at: new Date().toISOString() },
            }
          : entry,
      ),
    }));
  }

  /** Change the latest attempt. */
  private attempt(
    task: TaskRecord,
    change: (attempt: TaskAttempt) => Partial<TaskAttempt>,
  ): TaskRecord {
    const last = task.attempts.at(-1);
    return last
      ? {
          ...task,
          attempts: task.attempts.with(-1, { ...last, ...change(last) }),
        }
      : task;
  }

  /** Stop the turn of this task's session when its time limit ends. */
  private limit(id: string, session: string, minutes: number): void {
    this.clearLimit(id);
    const entry = {
      timer: setTimeout(() => {
        entry.expired = true;
        try {
          this.options.sessions.cancel(session);
        } catch {
          /* The turn ended already. */
        }
      }, minutes * 60_000),
      expired: false,
    };
    entry.timer.unref();
    this.limits.set(id, entry);
  }

  private clearLimit(id: string): void {
    const entry = this.limits.get(id);
    if (entry) clearTimeout(entry.timer);
    this.limits.delete(id);
  }

  private revisionFolder(id: string, revision: number): string {
    return join(this.directory, id, `r${revision}`);
  }

  /** Check the fields and write the revision with its input copies. */
  private async assignment(
    id: string,
    revision: number,
    fields: TaskInputFields,
    reason: string,
    all: readonly TaskRecord[],
  ): Promise<Assignment> {
    const host =
      fields.host === 'claude' || fields.host === 'codex'
        ? fields.host
        : fail('Choose Claude Code or Codex.');
    const model =
      fields.model === undefined || fields.model === '' || fields.model === null
        ? undefined
        : fields.model;
    try {
      validateModel(model);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Invalid model.');
    }
    const minutes =
      fields.minutes === undefined || fields.minutes === ''
        ? 30
        : Number(fields.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240)
      fail('Set a time limit from 1 to 240 minutes.');
    const writable = paths(fields.writable, 'writable paths', limits.writable);
    if (!writable.length)
      fail('List at least one path where the task may write.');
    const inputs = paths(fields.inputs, 'input files', limits.inputs);
    const dependencies =
      fields.dependencies === undefined
        ? []
        : Array.isArray(fields.dependencies)
          ? [...new Set(fields.dependencies as unknown[])]
          : fail('Choose the tasks that must be done first.');
    if (dependencies.length > limits.dependencies)
      fail(`A task can wait for at most ${limits.dependencies} tasks.`);
    for (const dependency of dependencies)
      if (
        !validTaskId(dependency) ||
        !all.some((task) => task.id === dependency)
      )
        fail('A task to wait for does not exist.');
    if (dependencies.includes(id)) fail('A task cannot wait for itself.');
    if (cycle(id, dependencies.filter(validTaskId), all))
      fail(
        'These dependencies make a cycle. A task cannot wait for itself through other tasks.',
      );
    const assignment: Assignment = {
      revision,
      at: new Date().toISOString(),
      reason,
      title: line(fields.title, 'title', 120).replace(/\s+/g, ' '),
      objective: line(fields.objective, 'objective', 8000),
      inputs: await this.copyInputs(id, revision, inputs),
      writable,
      output: line(fields.output, 'expected output', 2000),
      host,
      model: model ?? null,
      minutes,
      dependencies: dependencies.filter(validTaskId),
    };
    const file = await open(
      join(this.revisionFolder(id, revision), 'assignment.json'),
      'wx',
      0o600,
    );
    try {
      await file.writeFile(`${JSON.stringify(assignment, null, 2)}\n`);
    } finally {
      await file.close();
    }
    return assignment;
  }

  /** Copy each input into the revision folder. A hash alone could not restore it later. */
  private async copyInputs(
    id: string,
    revision: number,
    inputs: readonly string[],
  ): Promise<TaskInput[]> {
    const folder = join(this.revisionFolder(id, revision), 'inputs');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const copied: TaskInput[] = [];
    let total = 0;
    for (const path of inputs) {
      const source = join(this.root, path);
      const stats = await lstat(source).catch(() => null);
      if (!stats?.isFile())
        fail(`The input ${path} is not a regular file in the project.`);
      total += stats.size;
      if (stats.size > limits.inputBytes || total > limits.inputTotal)
        fail('Each input can be up to 1 MB, and all inputs up to 10 MB.');
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await copyFile(source, join(folder, path));
      copied.push({
        path,
        bytes: stats.size,
        sha256: createHash('sha256')
          .update(await readFile(join(folder, path)))
          .digest('hex'),
      });
    }
    return copied;
  }

  private async revision(id: string, revision: number): Promise<Assignment> {
    const value: unknown = JSON.parse(
      await readFile(
        join(this.revisionFolder(id, revision), 'assignment.json'),
        'utf8',
      ),
    );
    return (
      parseAssignment(value) ??
      fail(`The assignment of ${id} revision ${revision} is unreadable.`)
    );
  }

  private async load(id: unknown): Promise<TaskRecord> {
    return (await this.get(id)) ?? fail('That task does not exist.');
  }

  private async read(id: string): Promise<TaskRecord | null> {
    try {
      const path = join(this.directory, id, 'task.json');
      const stats = await lstat(path);
      if (!stats.isFile() || stats.size > 4_000_000) return null;
      const task = parseTask(JSON.parse(await readFile(path, 'utf8')));
      return task?.id === id ? task : null;
    } catch {
      return null;
    }
  }

  private async write(task: TaskRecord): Promise<TaskRecord> {
    const next = { ...task, updatedAt: new Date().toISOString() };
    const folder = join(this.directory, task.id);
    const temporary = join(
      folder,
      `.task.${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      } finally {
        await file.close();
      }
      await rename(temporary, join(folder, 'task.json'));
    } finally {
      await rm(temporary, { force: true });
    }
    return next;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A path from a record, checked again before Git or the file system uses it. */
function savedPath(value: unknown): value is string {
  try {
    return text(value) && projectPath(value) === value;
  } catch {
    return false;
  }
}

/**
 * Records are Verifold's own files, but paths in them reach Git and the file
 * system. So each record is checked before use. An unreadable record is skipped.
 */
function parseAssignment(value: unknown): Assignment | null {
  const entry = object(value);
  if (
    !entry ||
    !count(entry.revision) ||
    !text(entry.at) ||
    !text(entry.reason) ||
    !text(entry.title) ||
    !text(entry.objective) ||
    !text(entry.output) ||
    (entry.host !== 'claude' && entry.host !== 'codex') ||
    !(entry.model === null || text(entry.model)) ||
    !count(entry.minutes) ||
    !Array.isArray(entry.writable) ||
    !entry.writable.every(savedPath) ||
    !Array.isArray(entry.dependencies) ||
    !entry.dependencies.every(validTaskId) ||
    !Array.isArray(entry.inputs) ||
    !entry.inputs.every((input) => {
      const item = object(input);
      return (
        !!item && savedPath(item.path) && count(item.bytes) && text(item.sha256)
      );
    })
  )
    return null;
  return entry as unknown as Assignment;
}

function parseWorkspace(value: unknown): Workspace | null | undefined {
  if (value === null) return null;
  const entry = object(value);
  return entry &&
    (entry.kind === 'git' || entry.kind === 'folder') &&
    text(entry.path) &&
    /^\.verifold\/workspaces\/[a-z0-9][a-z0-9-]{0,80}$/.test(entry.path) &&
    (entry.branch === null ||
      (text(entry.branch) &&
        /^verifold\/[a-z0-9][a-z0-9-]{0,80}$/.test(entry.branch))) &&
    text(entry.start) &&
    /^[0-9a-f]{40,64}$/.test(entry.start)
    ? (entry as unknown as Workspace)
    : undefined;
}

function parseTask(value: unknown): TaskRecord | null {
  const entry = object(value);
  const states: readonly TaskState[] = [
    'open',
    'claimed',
    'running',
    'review',
    'done',
    'cancelled',
  ];
  if (
    !entry ||
    entry.schemaVersion !== 1 ||
    !validTaskId(entry.id) ||
    !count(entry.revision) ||
    !states.includes(entry.state as TaskState) ||
    !parseAssignment(entry.assignment) ||
    !(
      entry.claim === null ||
      (object(entry.claim) && text(object(entry.claim)?.id))
    ) ||
    !Array.isArray(entry.attempts)
  )
    return null;
  for (const item of entry.attempts) {
    const attempt = object(item);
    if (
      !attempt ||
      !count(attempt.number) ||
      !count(attempt.revision) ||
      parseWorkspace(attempt.workspace) === undefined ||
      !Array.isArray(attempt.versions) ||
      !attempt.versions.every((version) => {
        const saved = object(version);
        return (
          !!saved &&
          count(saved.number) &&
          text(saved.commit) &&
          /^[0-9a-f]{40,64}$/.test(saved.commit) &&
          Array.isArray(saved.files) &&
          saved.files.every((file) => savedPath(object(file)?.path))
        );
      })
    )
      return null;
  }
  return entry as unknown as TaskRecord;
}

/** Whether the task would wait for itself through its dependencies. */
function cycle(
  id: string,
  dependencies: readonly string[],
  all: readonly TaskRecord[],
): boolean {
  const seen = new Set<string>();
  const stack = [...dependencies];
  while (stack.length) {
    const next = stack.pop() ?? '';
    if (next === id) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(
      ...(all.find((task) => task.id === next)?.assignment.dependencies ?? []),
    );
  }
  return false;
}

/** What the harness enforces in a strict task session. Reads are never limited. */
function restrictions(host: HarnessName): string[] {
  return host === 'claude'
    ? [
        'Shell commands can write only in the task folder and in temporary folders (Claude Code sandbox).',
        'File tools can edit only in the task folder. Claude Code denies other edits without a prompt (permission rules, dontAsk mode).',
        'Other tools that need permission are denied, except web search and web fetch.',
        'Reads are not limited. The harness can read files outside the task folder.',
      ]
    : [
        'Shell commands and file changes can write only in the task folder and in temporary folders (Codex workspace-write sandbox).',
        'Codex asks for no approvals. An action outside the sandbox fails (approval policy never).',
        'Codex does not report a command that its sandbox blocks, so the transcript can miss a blocked attempt.',
        'Reads are not limited. The harness can read files outside the task folder.',
      ];
}

async function prompt(assignment: Assignment): Promise<string> {
  return `${await loadPrompt('task-worker')}

Task: ${assignment.title}

Objective:
${assignment.objective}

Input files (copies in this folder):
${assignment.inputs.length ? assignment.inputs.map((input) => `- ${input.path}`).join('\n') : '- None'}

Writable paths:
${assignment.writable.map((path) => `- ${path === '.' ? 'the whole folder' : path}`).join('\n')}

Expected output:
${assignment.output}

Time limit for this turn: ${assignment.minutes} minutes.`;
}
