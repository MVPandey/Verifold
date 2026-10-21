/**
 * Read-only records of the coordinator's team, from the research flow that
 * came before the lab: messages, the results of a direction, the
 * coordinator's state, and tasks with their versions. The old manager writes
 * them; History and the old manager read them. Paths in a record reach Git
 * and the file system, so each record is checked before use, and an
 * unreadable one reads as none.
 */
import type { HarnessName } from './harness.ts';
import { validDomain } from './session-hosts.ts';
import {
  leftOut,
  parseWorkspace as workspaceRecord,
  projectPath,
  type ChangedFile,
  type Workspace,
} from './workspaces.ts';

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

export type MessageKind =
  | 'note'
  | 'blocker'
  | 'objection'
  | 'withdrawal'
  | 'decision';

/**
 * How far a message got. A task worker gets its messages with its next turn:
 * `sent` with the turn, then `delivered` when that turn ends normally, or
 * `uncertain` when it fails or the process stops first. Verifold never resends
 * an uncertain message by itself. A message from the person to a running
 * worker goes into its turn: `sent`, then `delivered` when the harness takes
 * it in. Research gets its messages with its next step. `board`: the desk shows
 * it to the person.
 */
export type Delivery = 'queued' | 'sent' | 'delivered' | 'uncertain' | 'board';

export interface Message {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly at: string;
  /** `person`, `coordinator`, or a task ID. */
  readonly from: string;
  /** For a worker: the attempt that sent it. The harness pipe identifies it, never the message text. */
  readonly sender?: {
    readonly claim: string;
    readonly attempt: number;
    readonly revision: number;
  };
  /** `person`, `coordinator`, `research`, or a task ID. Only the person writes to research. */
  readonly to: string;
  /** The recipient task's revision when the message was sent. */
  readonly revision?: number;
  readonly kind: MessageKind;
  readonly text: string;
  /** An objection: the artifact version it is about, and its evidence. */
  readonly about?: { readonly task: string; readonly version: number };
  readonly evidence?: readonly string[];
  /** A withdrawal or decision: the objection or blocker that it closes. */
  readonly closes?: string;
  /** Blockers and objections stay open until a decision or a withdrawal closes them. */
  readonly status?: 'open' | 'withdrawn' | 'upheld' | 'overruled' | 'resolved';
  readonly delivery: Delivery;
  readonly deliveredAt?: string;
  /**
   * `turn`: Verifold added the message to the agent's running turn.
   * `coordinator`: research ended first, or the task's agent ended, so Verifold passed it to the coordinator.
   */
  readonly via?: 'turn' | 'coordinator';
  /** The recipient's next text after the message, a model claim. Messages from the person only. */
  readonly answer?: { readonly at: string; readonly text: string };
  /** The harness call that made it, so a repeated call adds nothing. */
  readonly key?: string;
}

const kinds: readonly MessageKind[] = [
  'note',
  'blocker',
  'objection',
  'withdrawal',
  'decision',
];

const deliveries: readonly Delivery[] = [
  'queued',
  'sent',
  'delivered',
  'uncertain',
  'board',
];

export function parseMessage(value: unknown): Message | null {
  const entry = object(value);
  if (
    !entry ||
    entry.schemaVersion !== 1 ||
    typeof entry.id !== 'string' ||
    !/^m-[1-9]\d{0,5}$/.test(entry.id) ||
    typeof entry.at !== 'string' ||
    typeof entry.from !== 'string' ||
    typeof entry.to !== 'string' ||
    typeof entry.text !== 'string' ||
    !kinds.includes(entry.kind as MessageKind) ||
    !deliveries.includes(entry.delivery as Delivery)
  )
    return null;
  // A harness that can write in the project can write here, so the fields that the desk shows are checked.
  const { via, answer, ...rest } = entry;
  const reply = object(answer);
  return {
    ...(rest as unknown as Message),
    ...(via === 'turn' || via === 'coordinator' ? { via } : {}),
    ...(reply && typeof reply.at === 'string' && typeof reply.text === 'string'
      ? { answer: { at: reply.at, text: reply.text } }
      : {}),
  };
}

/** The result of one check of the chosen direction. A judgement waits for the person. */
export type CheckOutcome = 'passed' | 'failed' | 'partial' | 'judgement';

export interface CheckResult {
  /** The check's place in the direction's list, from 1. */
  readonly check: number;
  readonly result: CheckOutcome;
  /** What the evidence shows, in the coordinator's words. */
  readonly value: string;
  /** Accepted project files that show it. */
  readonly evidence: readonly string[];
  /** Why the coordinator reports this result. A model claim. */
  readonly reason: string;
  /** For a judgement: what the person decides. */
  readonly question?: string;
  readonly at: string;
  /** The person's ruling on a judgement. It is final. */
  readonly ruling?: {
    readonly result: Exclude<CheckOutcome, 'judgement'>;
    readonly reason: string;
    readonly at: string;
  };
}

export interface Claim {
  readonly text: string;
  /** Accepted project files or web sources. */
  readonly evidence: readonly string[];
}

export interface Answer {
  readonly statement: string;
  readonly claims: readonly Claim[];
  readonly at: string;
  /** The person's sign-off, or a request for more work. */
  readonly decision?: {
    readonly kind: 'accepted' | 'more';
    readonly at: string;
    readonly note?: string;
  };
}

/** The results of one chosen direction. */
export interface Results {
  readonly schemaVersion: 1;
  /** The direction that these results belong to. */
  readonly direction: string;
  readonly checks: readonly CheckResult[];
  readonly answer: Answer | null;
}

/** The results of a direction in `results.json` or `results-<direction>.json`, or null when they are unreadable. */
export function parseResults(value: unknown): Results | null {
  const entry = object(value);
  return entry &&
    entry.schemaVersion === 1 &&
    typeof entry.direction === 'string' &&
    Array.isArray(entry.checks) &&
    'answer' in entry
    ? (entry as unknown as Results)
    : null;
}

/** One tool call of the coordinator, with its reason and Verifold's answer. */
export interface CoordinatorAction {
  /** The harness's call ID. A repeated call gets the same answer and changes nothing. */
  readonly key: string;
  readonly at: string;
  readonly tool: string;
  readonly input: string;
  readonly reason?: string;
  readonly ok: boolean;
  readonly result: string;
}

/** The fields of the coordinator's state that every reader needs. The old manager keeps its events typed. */
export interface CoordinatorRecord {
  readonly schemaVersion: 1;
  readonly objective: string;
  readonly host: HarnessName;
  readonly model: string | null;
  readonly helper?: HarnessName | null;
  readonly startedAt: string;
  readonly stoppedAt: string | null;
  readonly session: string | null;
  readonly created: number;
  readonly planApproved: boolean;
  readonly cursor: number;
  readonly wakeups: readonly string[];
  readonly events: readonly unknown[];
  readonly actions: readonly CoordinatorAction[];
}

/** The coordinator's `state.json`, or null when it is unreadable. */
export function parseCoordinator(value: unknown): CoordinatorRecord | null {
  const entry = object(value);
  return entry &&
    entry.schemaVersion === 1 &&
    typeof entry.objective === 'string' &&
    (entry.host === 'claude' || entry.host === 'codex') &&
    Array.isArray(entry.events) &&
    Array.isArray(entry.actions) &&
    Array.isArray(entry.wakeups) &&
    typeof entry.cursor === 'number' &&
    typeof entry.created === 'number' &&
    typeof entry.planApproved === 'boolean'
    ? (entry as unknown as CoordinatorRecord)
    : null;
}

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
  /** The domains that shell commands of the task may reach, and why. Absent or null: no network. */
  readonly network?: {
    readonly domains: readonly string[];
    readonly reason: string;
  } | null;
  /** Absent when the person wrote this revision. */
  readonly by?: 'coordinator';
  /** An add-on in the coordinator's draft plan. The person can leave it out before the work starts. */
  readonly extra?: true;
  /** New work that the coordinator wrote for the person after the work started. The person starts it. */
  readonly draft?: true;
  /** Why the coordinator gave the task its harness. */
  readonly hostReason?: string;
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
  /** The worker's last text in the turn. A model claim. */
  readonly reply?: string;
  readonly decision: {
    readonly kind: 'accepted' | 'rejected' | 'changes';
    readonly at: string;
    readonly files?: readonly string[];
    /** The person's changes, or the coordinator's reason. */
    readonly note?: string;
    /** Absent for the person. */
    readonly by?: 'coordinator';
  } | null;
  /** The last Accept found these targets changed in the project. */
  readonly conflicts?: readonly string[];
}

/** The files of one accepted version, copied when it was accepted. Later changes in the project do not change them. */
export interface TaskArtifact {
  readonly version: number;
  readonly revision: number;
  readonly at: string;
  readonly files: readonly TaskInput[];
}

/** The artifact version of a dependency that an attempt received. */
export interface ConsumedArtifact {
  readonly task: string;
  readonly version: number;
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
  /** Artifacts of the dependencies, copied into the workspace at the start. Absent in records before 0.8.0. */
  readonly consumed?: readonly ConsumedArtifact[];
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
  /** Each accepted version, oldest first. A new acceptance adds one and never changes an earlier one. */
  readonly artifacts?: readonly TaskArtifact[];
}

export function validTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^task-[1-9]\d{0,5}$/.test(id);
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
export function parseAssignment(value: unknown): Assignment | null {
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
    !entry.inputs.every(savedFile) ||
    !(entry.extra === undefined || entry.extra === true) ||
    !(entry.draft === undefined || entry.draft === true) ||
    !(entry.hostReason === undefined || text(entry.hostReason)) ||
    !(
      entry.network === undefined ||
      entry.network === null ||
      (Array.isArray(object(entry.network)?.domains) &&
        (object(entry.network)?.domains as unknown[]).every(
          (domain) => text(domain) && validDomain(domain),
        ) &&
        text(object(entry.network)?.reason))
    )
  )
    return null;
  return entry as unknown as Assignment;
}

/** A recorded file copy: a project path, its size, and its SHA-256. */
function savedFile(value: unknown): boolean {
  const item = object(value);
  return (
    !!item && savedPath(item.path) && count(item.bytes) && text(item.sha256)
  );
}

function parseWorkspace(value: unknown): Workspace | null | undefined {
  return value === null ? null : workspaceRecord(value);
}

/**
 * A version saved before Verifold left out environments and caches can list
 * thousands of their files. Reading the task drops them, so nobody accepts them
 * and the record shrinks with its next save.
 */
export function withoutLeftOut(task: TaskRecord): TaskRecord {
  if (
    !task.attempts.some((attempt) =>
      attempt.versions.some((version) =>
        version.files.some((file) => leftOut(file.path)),
      ),
    )
  )
    return task;
  return {
    ...task,
    attempts: task.attempts.map((attempt) => ({
      ...attempt,
      versions: attempt.versions.map((version) => ({
        ...version,
        files: version.files.filter((file) => !leftOut(file.path)),
      })),
    })),
  };
}

export function parseTask(value: unknown): TaskRecord | null {
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
    !Array.isArray(entry.attempts) ||
    !(
      entry.artifacts === undefined ||
      (Array.isArray(entry.artifacts) &&
        entry.artifacts.every((item) => {
          const artifact = object(item);
          return (
            !!artifact &&
            count(artifact.version) &&
            count(artifact.revision) &&
            text(artifact.at) &&
            Array.isArray(artifact.files) &&
            artifact.files.every(savedFile)
          );
        }))
    )
  )
    return null;
  for (const item of entry.attempts) {
    const attempt = object(item);
    if (
      !attempt ||
      !count(attempt.number) ||
      !count(attempt.revision) ||
      !(
        attempt.consumed === undefined ||
        (Array.isArray(attempt.consumed) &&
          attempt.consumed.every(
            (used) =>
              validTaskId(object(used)?.task) && count(object(used)?.version),
          ))
      ) ||
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
