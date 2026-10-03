import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { validateModel, type HarnessName } from './harness.ts';
import { processStart, stopRecordedProcess } from './owner.ts';
import {
  startHostSession,
  type HostEvent,
  type HostSession,
  type SessionMode,
} from './session-hosts.ts';
import {
  requestUpdate,
  TranscriptWriter,
  type TranscriptUpdate,
} from './transcript.ts';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'idle'
  /** The owner stopped. A later owner can resume the native session. */
  | 'paused'
  /** The owner stopped without a record of the end. The last turn has an unknown outcome. */
  | 'interrupted'
  | 'ended'
  | 'failed';

const statuses: readonly SessionStatus[] = [
  'starting',
  'running',
  'idle',
  'paused',
  'interrupted',
  'ended',
  'failed',
];

export interface SessionEvent {
  readonly at: string;
  /** `agent` text is a model claim. The other kinds come from the harness protocol or from Verifold. */
  readonly kind:
    | 'you'
    | 'agent'
    | 'tool'
    | 'request'
    | 'decision'
    | 'status'
    | 'notice';
  readonly text: string;
}

/** One tool call in the command record, keyed by the harness tool call ID. */
export interface CommandEntry {
  readonly id: string;
  readonly at: string;
  readonly tool: string;
  readonly action: string;
  readonly risk: readonly string[];
  /** Claude Code reported Auto mode when the call started. */
  readonly auto: boolean;
  /** The person's answer to a permission request for this call. */
  readonly asked?: 'pending' | 'allowed' | 'denied' | 'unanswered';
  readonly harnessDenied?: string;
  readonly review?: {
    readonly approved: boolean;
    readonly risk?: string;
    readonly rationale?: string;
  };
  /** `unknown`: the owner stopped while the call ran. */
  readonly outcome:
    | 'running'
    | 'ok'
    | 'failed'
    | 'declined'
    | 'denied'
    | 'unknown';
  readonly exitCode?: number;
  readonly reviewedAt?: string;
}

export interface PendingRequest {
  readonly id: string;
  readonly native: string;
  readonly toolId?: string;
  readonly tool: string;
  readonly action: string;
  /** The content that a write or edit would change. */
  readonly detail?: string;
  readonly reason?: string;
  readonly at: string;
}

/** One process start for a session. A resume adds a launch. */
export interface SessionLaunch {
  readonly id: string;
  readonly ownerId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** The harness process and its start time, so a later owner can stop it safely. */
  readonly pid: number | null;
  readonly processStart: string | null;
}

export interface SessionRecord {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly host: HarnessName;
  readonly model: string | null;
  readonly mode: SessionMode;
  /** The mode that the harness reports, which can differ from the requested mode. */
  readonly reportedMode: string | null;
  readonly nativeSessionId: string | null;
  readonly status: SessionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Claude Code's own estimate. It is not a bill. */
  readonly costUsd: number | null;
  readonly events: readonly SessionEvent[];
  readonly commands: readonly CommandEntry[];
  readonly requests: readonly PendingRequest[];
  /** Oldest first. The last launch is the current or the latest process. */
  readonly launches: readonly SessionLaunch[];
  /** A task session: the task and the claim that started it. */
  readonly task?: { readonly id: string; readonly claim: string };
  /** The task folder that a task session runs in, relative to the project. */
  readonly cwd?: string;
}

export interface SessionView {
  readonly record: SessionRecord;
  readonly live: boolean;
  readonly saveFailed: boolean;
}

/** A paused or interrupted session that a person can continue. */
export interface PausedSession {
  readonly id: string;
  readonly host: HarnessName;
  readonly status: 'paused' | 'interrupted';
  readonly startedAt: string;
  readonly request: string;
  /** No native conversation is known, so the session starts again instead of resuming. */
  readonly restart: boolean;
}

export interface SessionManagerOptions {
  readonly clientVersion: string;
  /** The project owner that launches sessions. Each launch records it. */
  readonly ownerId: string;
  /** Override host executables for an isolated installation or a test fixture. */
  readonly executables?: Partial<Record<HarnessName, string>>;
  readonly onEvent?: (event: SessionEvent) => void;
  /**
   * A turn of a task session ended, or its process exited. For an exit,
   * `detail` is the last notice, for example that the harness could not start.
   */
  readonly onTaskTurn?: (
    task: { readonly id: string; readonly claim: string },
    turn: 'completed' | 'interrupted' | 'failed' | 'exited',
    detail?: string,
  ) => void;
  /** Request IDs come from this counter. Managers that share it cannot show two requests with one ID. */
  readonly requests?: { next: number };
}

/** An action that the current session state does not allow. The message is safe to show. */
export class SessionActionError extends Error {}

export function hostName(host: HarnessName): string {
  return host === 'claude' ? 'Claude Code' : 'Codex';
}

/**
 * Remove terminal control sequences and bound text from the harness. Direction
 * controls are removed too, so they cannot reorder a displayed command.
 */
function clean(value: string, limit: number): string {
  const text = stripVTControlCharacters(value)
    // eslint-disable-next-line no-control-regex -- Harness text must not control the terminal.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Tags from the command text. They direct review; they do not prove what a command did. */
export function riskTags(tool: string, action: string, root: string): string[] {
  const text = action.toLowerCase();
  const tags: string[] = [];
  if (
    /^(webfetch|websearch|web search)$/i.test(tool) ||
    /\b(curl|wget|ssh|scp|rsync|git\s+(clone|fetch|pull|push))\b|https?:\/\//.test(
      text,
    )
  )
    tags.push('Network');
  if (
    /\b(pip3?|uv|npm|pnpm|yarn|brew|apt(-get)?|cargo|gem|conda)\s+(install|add|sync|i)\b/.test(
      text,
    )
  )
    tags.push('Install');
  if (
    /(^|[\s;&|])(rm|rmdir|unlink)\s|\bgit\s+(reset\s+--hard|clean)\b/.test(text)
  )
    tags.push('Deletes files');
  if (
    /\.claude\/settings|\.codex\/|\.git\/(config|hooks)|\.verifold\//.test(text)
  )
    tags.push('Settings files');
  if (
    /(^|[\s'"=])\.\.\//.test(action) ||
    (/^(write|edit|multiedit|notebookedit|file change)$/i.test(tool) &&
      action
        .split(', ')
        .some(
          (path) => isAbsolute(path) && relative(root, path).startsWith('..'),
        ))
  )
    tags.push('Outside folder');
  return tags;
}

/** Who let a command run, in words that do not claim more than the harness reported. */
export function decisionLabel(
  command: CommandEntry,
  host: HarnessName,
): string {
  if (command.asked)
    return {
      pending: 'Waits for you',
      allowed: 'You allowed',
      denied: 'You denied',
      unanswered: 'Not answered',
    }[command.asked];
  if (command.harnessDenied) return `Denied by ${hostName(host)}`;
  if (command.review)
    return command.review.approved
      ? 'Codex reviewer approved'
      : 'Codex reviewer denied';
  if (command.auto) return 'Auto, no person';
  // Only Codex commands and file changes run inside its sandbox.
  return host === 'codex' &&
    (command.tool === 'Command' || command.tool === 'File change')
    ? 'Ran in the sandbox'
    : 'No prompt';
}

/** A risky command that ran without a person's approval and has no review mark. */
export function needsReview(command: CommandEntry): boolean {
  return (
    !command.asked &&
    !command.harnessDenied &&
    !command.reviewedAt &&
    command.risk.length > 0 &&
    command.outcome !== 'denied' &&
    command.outcome !== 'declined'
  );
}

/** Plain words for the harness mode. */
export function modeLabel(record: SessionRecord): string {
  if (record.mode === 'strict') return 'Strict (task)';
  const reported = record.reportedMode;
  if (!reported)
    return record.mode === 'auto' ? 'Auto (requested)' : 'Ask me (requested)';
  if (record.host === 'codex')
    return reported === 'user'
      ? 'Ask me'
      : reported === 'auto_review'
        ? 'Auto (Codex reviewer)'
        : reported;
  return reported === 'auto'
    ? 'Auto'
    : reported === 'default'
      ? 'Ask me'
      : reported;
}

export function validSessionId(id: string): boolean {
  return /^\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(id);
}

function transcriptFile(root: string, id: string): string {
  return join(root, '.verifold', 'sessions', `${id}.transcript.jsonl`);
}

/** The private transcript of a session: full messages, tool inputs, and tool results. Null for an invalid ID. */
export function sessionTranscript(root: string, id: string): string | null {
  return validSessionId(id) ? transcriptFile(root, id) : null;
}

function nativeId(value: string): string | null {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) ? value : null;
}

async function writeRecord(root: string, record: SessionRecord): Promise<void> {
  if (!validSessionId(record.id)) throw new Error('Invalid session ID.');
  const state = join(root, '.verifold');
  if (!(await lstat(state)).isDirectory())
    throw new Error('.verifold must be a real directory.');
  const directory = join(state, 'sessions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Session records must use a real directory.');
  const temporary = join(
    directory,
    `.${record.id}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, `${record.id}.json`));
  } finally {
    await rm(temporary, { force: true });
  }
}

const eventKinds: readonly SessionEvent['kind'][] = [
  'you',
  'agent',
  'tool',
  'request',
  'decision',
  'status',
  'notice',
];
const outcomes: readonly CommandEntry['outcome'][] = [
  'running',
  'ok',
  'failed',
  'declined',
  'denied',
  'unknown',
];
const answers = ['pending', 'allowed', 'denied', 'unanswered'] as const;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseEvent(value: unknown): SessionEvent[] {
  const event = object(value);
  const kind = eventKinds.find((entry) => entry === event?.kind);
  return event &&
    kind &&
    typeof event.at === 'string' &&
    typeof event.text === 'string'
    ? [{ at: event.at, kind, text: clean(event.text, 4000) }]
    : [];
}

function parseCommand(value: unknown): CommandEntry[] {
  const command = object(value);
  const outcome = outcomes.find((entry) => entry === command?.outcome);
  if (
    !command ||
    !outcome ||
    typeof command.id !== 'string' ||
    typeof command.at !== 'string' ||
    typeof command.tool !== 'string' ||
    typeof command.action !== 'string' ||
    typeof command.auto !== 'boolean' ||
    !Array.isArray(command.risk) ||
    !command.risk.every((tag) => typeof tag === 'string')
  )
    return [];
  const asked = answers.find((entry) => entry === command.asked);
  const review = object(command.review);
  return [
    {
      id: clean(command.id, 200),
      at: command.at,
      tool: clean(command.tool, 80),
      action: clean(command.action, 2000),
      risk: command.risk.map((tag) => clean(tag, 40)),
      auto: command.auto,
      outcome,
      ...(asked ? { asked } : {}),
      ...(typeof command.harnessDenied === 'string'
        ? { harnessDenied: clean(command.harnessDenied, 80) }
        : {}),
      ...(review && typeof review.approved === 'boolean'
        ? {
            review: {
              approved: review.approved,
              ...(typeof review.risk === 'string'
                ? { risk: clean(review.risk, 40) }
                : {}),
              ...(typeof review.rationale === 'string'
                ? { rationale: clean(review.rationale, 1000) }
                : {}),
            },
          }
        : {}),
      ...(typeof command.exitCode === 'number'
        ? { exitCode: command.exitCode }
        : {}),
      ...(typeof command.reviewedAt === 'string'
        ? { reviewedAt: command.reviewedAt }
        : {}),
    },
  ];
}

function parseLaunch(value: unknown): SessionLaunch[] {
  const launch = object(value);
  return launch &&
    typeof launch.id === 'string' &&
    typeof launch.ownerId === 'string' &&
    typeof launch.startedAt === 'string' &&
    (launch.endedAt === null || typeof launch.endedAt === 'string')
    ? [
        {
          id: launch.id,
          ownerId: launch.ownerId,
          startedAt: launch.startedAt,
          endedAt: launch.endedAt,
          pid:
            Number.isSafeInteger(launch.pid) && (launch.pid as number) > 0
              ? (launch.pid as number)
              : null,
          processStart:
            typeof launch.processStart === 'string'
              ? launch.processStart
              : null,
        },
      ]
    : [];
}

/** A saved record. Harness processes can write in the project folder, so each field is checked. */
function parseRecord(value: unknown): SessionRecord | null {
  const record = object(value);
  if (!record || record.schemaVersion !== 2) return null;
  const id =
    typeof record.id === 'string' && validSessionId(record.id)
      ? record.id
      : null;
  const host =
    record.host === 'claude' || record.host === 'codex' ? record.host : null;
  const mode =
    record.mode === 'ask' || record.mode === 'auto' || record.mode === 'strict'
      ? record.mode
      : null;
  const task = object(record.task);
  const status = statuses.find((entry) => entry === record.status);
  const model =
    record.model === null || typeof record.model === 'string'
      ? record.model
      : undefined;
  if (
    !id ||
    !host ||
    !mode ||
    !status ||
    model === undefined ||
    typeof record.startedAt !== 'string'
  )
    return null;
  try {
    validateModel(model ?? undefined);
  } catch {
    return null;
  }
  return {
    schemaVersion: 2,
    id,
    host,
    model,
    mode,
    reportedMode:
      typeof record.reportedMode === 'string'
        ? clean(record.reportedMode, 40)
        : null,
    nativeSessionId:
      typeof record.nativeSessionId === 'string'
        ? nativeId(record.nativeSessionId)
        : null,
    status,
    startedAt: record.startedAt,
    endedAt: typeof record.endedAt === 'string' ? record.endedAt : null,
    costUsd:
      typeof record.costUsd === 'number' && Number.isFinite(record.costUsd)
        ? record.costUsd
        : null,
    events: list(record.events).flatMap(parseEvent).slice(-400),
    commands: list(record.commands).flatMap(parseCommand).slice(-1000),
    requests: [],
    launches: list(record.launches).flatMap(parseLaunch).slice(-50),
    ...(task &&
    typeof task.id === 'string' &&
    /^task-\d{1,6}$/.test(task.id) &&
    typeof task.claim === 'string' &&
    /^[0-9a-f]{16}$/.test(task.claim)
      ? { task: { id: task.id, claim: task.claim } }
      : {}),
    ...(typeof record.cwd === 'string' &&
    /^\.verifold\/workspaces\/[a-z0-9][a-z0-9-]{0,80}$/.test(record.cwd)
      ? { cwd: record.cwd }
      : {}),
  };
}

async function readRecord(
  root: string,
  id: string,
): Promise<SessionRecord | null> {
  try {
    const path = join(root, '.verifold', 'sessions', `${id}.json`);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.size > 16_000_000) return null;
    return parseRecord(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Whether the harness holds a conversation for this record. Codex reports a
 * thread. Claude Code takes its ID at launch, so only an observed event proves
 * that its conversation exists.
 */
function conversation(record: SessionRecord): boolean {
  return (
    record.nativeSessionId !== null &&
    (record.host === 'codex' ||
      record.reportedMode !== null ||
      record.events.some(
        (event) => event.kind !== 'you' && event.kind !== 'status',
      ))
  );
}

async function recordIds(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, '.verifold', 'sessions'));
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d{8}T\d{9}Z-[a-f0-9]{8}\.json$/.test(name))
    .map((name) => name.slice(0, -5))
    .sort()
    .reverse()
    .slice(0, 50);
}

/** Paused and interrupted sessions among the latest 50 records, newest first. */
export async function loadPaused(root: string): Promise<PausedSession[]> {
  const paused: PausedSession[] = [];
  for (const id of await recordIds(root)) {
    const record = await readRecord(root, id);
    // A task session belongs to its task. The task offers its own next step.
    if (
      (record?.status === 'paused' || record?.status === 'interrupted') &&
      !record.task &&
      record.events.some((event) => event.kind === 'you')
    )
      paused.push({
        id,
        host: record.host,
        status: record.status,
        startedAt: record.startedAt,
        request:
          record.events.find((event) => event.kind === 'you')?.text ?? '',
        restart: !conversation(record),
      });
  }
  return paused;
}

/**
 * After an owner stopped without a final record, mark its unfinished sessions
 * as interrupted. A harness process that outlived the owner stops first, but
 * only when its recorded start time matches. Call this only while holding the
 * project owner lock, so no other owner runs these sessions.
 */
export async function reconcileSessions(
  root: string,
  ownerId: string,
): Promise<{ readonly interrupted: number; readonly stopped: number }> {
  let interrupted = 0;
  let stopped = 0;
  for (const id of await recordIds(root)) {
    const record = await readRecord(root, id);
    const launch = record?.launches.at(-1);
    if (
      !record ||
      (record.status !== 'starting' &&
        record.status !== 'running' &&
        record.status !== 'idle') ||
      launch?.ownerId === ownerId
    )
      continue;
    const outlived =
      launch?.pid != null &&
      (await stopRecordedProcess(launch.pid, launch.processStart));
    if (outlived) stopped++;
    const now = new Date().toISOString();
    await writeRecord(root, {
      ...unanswered(record),
      status: 'interrupted',
      commands: record.commands.map((command) =>
        command.outcome === 'running'
          ? { ...command, outcome: 'unknown' }
          : command,
      ),
      events: [
        ...record.events,
        {
          at: now,
          kind: 'status' as const,
          text: `Verifold stopped without saving the end of this session.${outlived ? ' Its harness process was still running, and Verifold stopped it.' : ''} The last turn may have run commands that Verifold did not see. Their outcome is unknown.`,
        },
      ].slice(-400),
    });
    interrupted++;
  }
  return { interrupted, stopped };
}

/** Close the current launch. */
function ended(launches: readonly SessionLaunch[]): readonly SessionLaunch[] {
  const last = launches.at(-1);
  return last && last.endedAt === null
    ? launches.with(-1, { ...last, endedAt: new Date().toISOString() })
    : launches;
}

/** Requests that close without an answer, when a turn or the process ends. */
function unanswered(record: SessionRecord): SessionRecord {
  return {
    ...record,
    requests: [],
    commands: record.commands.map((command) =>
      command.asked === 'pending'
        ? { ...command, asked: 'unanswered' }
        : command,
    ),
  };
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

const taskSession =
  'This session belongs to a task. Use the task actions in the desk: accept, ask for changes, or reject.';

/** A new session record, before its first launch. */
function fresh(
  host: HarnessName,
  model: string | null,
  mode: SessionMode,
): SessionRecord {
  const now = new Date();
  return {
    schemaVersion: 2,
    id: `${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`,
    host,
    model,
    mode,
    reportedMode: null,
    // Claude Code takes its session ID at launch, so the record names it before the process starts.
    nativeSessionId: host === 'claude' ? randomUUID() : null,
    status: 'starting',
    startedAt: now.toISOString(),
    endedAt: null,
    costUsd: null,
    events: [],
    commands: [],
    requests: [],
    launches: [],
  };
}

/**
 * Owns one live harness session for one project. The desk and the terminal
 * call the same methods. Each change is saved to `.verifold/sessions/<id>.json`.
 */
export class SessionManager {
  private readonly root: string;
  private readonly options: SessionManagerOptions;
  private current: SessionRecord | null = null;
  private host: HostSession | null = null;
  /** Request IDs continue across sessions, so an old desk button cannot answer a new request. */
  private readonly requests: { next: number };
  private blocked: string | null = null;
  /** A launch is saving its record. No second start can begin. */
  private launching = false;
  /** The current launch sent a first request, so a turn runs when the harness reports its session. */
  private prompted = false;
  private pausedList: PausedSession[] = [];
  private dirty = false;
  private writing: Promise<void> | null = null;
  private saveFailed = false;
  /** The transcript file of the current launch. */
  private transcript: {
    readonly writer: TranscriptWriter;
    readonly apply: (update: TranscriptUpdate) => void;
  } | null = null;

  constructor(root: string, options: SessionManagerOptions) {
    this.root = root;
    this.options = options;
    this.requests = options.requests ?? { next: 1 };
  }

  view(): SessionView | null {
    return this.current
      ? {
          record: this.current,
          live: this.host !== null,
          saveFailed: this.saveFailed,
        }
      : null;
  }

  /** Read paused sessions from earlier owners. Call this once before clients attach. */
  async load(): Promise<void> {
    this.pausedList = await loadPaused(this.root);
  }

  paused(): readonly PausedSession[] {
    return this.pausedList;
  }

  /** Refuse new sessions while other work in this process uses the project. */
  block(reason: string | null): void {
    this.blocked = reason;
  }

  /** A session runs or is starting. */
  get active(): boolean {
    return this.host !== null || this.launching;
  }

  /** Why a new session is refused now, or null. */
  get blockedReason(): string | null {
    return this.blocked;
  }

  async start(input: {
    readonly host: unknown;
    readonly mode: unknown;
    readonly model?: unknown;
    readonly prompt: unknown;
  }): Promise<void> {
    this.ready();
    const host =
      input.host === 'claude' || input.host === 'codex'
        ? input.host
        : fail('Choose Claude Code or Codex.');
    const mode =
      input.mode === 'ask' || input.mode === 'auto'
        ? input.mode
        : fail('Choose Ask me or Auto.');
    const model =
      input.model === undefined || input.model === '' ? undefined : input.model;
    try {
      validateModel(model);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Invalid model.');
    }
    const prompt = this.text(input.prompt);
    this.current = fresh(host, model ?? null, mode);
    this.event('you', prompt);
    await this.launch(prompt);
  }

  /**
   * Start a strict session for a task, in its task folder. The harness limits
   * writes to that folder and asks nothing. Returns the session ID.
   */
  async startTask(input: {
    readonly host: HarnessName;
    readonly model?: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly task: { readonly id: string; readonly claim: string };
  }): Promise<string> {
    this.ready();
    const cwd = relative(this.root, input.cwd).split('\\').join('/');
    const record: SessionRecord = {
      ...fresh(input.host, input.model ?? null, 'strict'),
      task: input.task,
      cwd,
    };
    if (!parseRecord(record)?.cwd)
      fail('A task session needs its task folder.');
    this.current = record;
    this.event(
      'status',
      `Verifold started ${input.task.id} in its task folder, in Strict mode.`,
    );
    await this.launch(input.prompt);
    return record.id;
  }

  /** The ID of the live session when it waits for a follow-up. */
  idleSession(): string | null {
    return this.host && this.current?.status === 'idle'
      ? this.current.id
      : null;
  }

  /** Continue a paused session in a new harness process. */
  async resume(id: unknown): Promise<void> {
    this.ready();
    const saved =
      typeof id === 'string' && validSessionId(id)
        ? await readRecord(this.root, id)
        : null;
    if (
      (saved?.status !== 'paused' && saved?.status !== 'interrupted') ||
      !conversation(saved)
    )
      fail('That session cannot resume. Choose a paused session.');
    // Another start can begin while the record loads.
    this.ready();
    this.current = { ...saved, status: 'starting', endedAt: null };
    this.event(
      'status',
      'Verifold resumes this session in a new process. The events above come from the earlier launch.',
    );
    await this.launch();
    this.pausedList = this.pausedList.filter((entry) => entry.id !== saved.id);
  }

  /**
   * Run the first request of a paused or interrupted session again when no
   * native conversation is known. Claude Code keeps its session ID, so it
   * refuses the launch if that conversation exists after all.
   */
  async restart(id: unknown): Promise<void> {
    this.ready();
    const saved =
      typeof id === 'string' && validSessionId(id)
        ? await readRecord(this.root, id)
        : null;
    const prompt = saved?.events.find((event) => event.kind === 'you')?.text;
    if (
      (saved?.status !== 'paused' && saved?.status !== 'interrupted') ||
      conversation(saved) ||
      !prompt
    )
      fail(
        'That session cannot start again. Resume it, or start a new session.',
      );
    // Another start can begin while the record loads.
    this.ready();
    this.current = {
      ...saved,
      status: 'starting',
      endedAt: null,
      nativeSessionId: saved.host === 'claude' ? saved.nativeSessionId : null,
    };
    this.event(
      'status',
      'No conversation was recorded, so Verifold runs the first request again.',
    );
    await this.launch(prompt);
    this.pausedList = this.pausedList.filter((entry) => entry.id !== saved.id);
  }

  send(value: unknown): void {
    if (this.current?.task) fail(taskSession);
    this.continueTask(value);
  }

  /** Send the next turn. For a task session, only its task calls this, so each turn ends in a version. */
  continueTask(value: unknown): void {
    const text = this.text(value);
    if (!this.host || this.current?.status !== 'idle')
      fail('Wait for the current turn to end, or cancel it.');
    this.host.send(text);
    this.transcript?.apply(requestUpdate(text));
    this.patch((record) => ({ ...record, status: 'running' }));
    this.event('you', text);
  }

  cancel(): void {
    const record = this.current;
    if (!this.host || !record || record.status === 'idle')
      fail('Nothing is running.');
    this.host.interrupt(record.requests.map((request) => request.native));
    for (const request of record.requests)
      if (request.toolId)
        this.command(request.toolId, (command) =>
          command ? { ...command, asked: 'denied', outcome: 'denied' } : null,
        );
    this.patch((current) => ({ ...current, requests: [] }));
    this.event('status', 'You cancelled the current turn.');
  }

  end(reason = 'You ended the session.'): void {
    if (this.current?.task) fail(taskSession);
    this.endTask(reason);
  }

  /** End the session. For a task session, only its task calls this. */
  endTask(reason: string): void {
    if (!this.host) fail('No session is running.');
    this.host.close();
    this.host = null;
    this.patch((record) => ({
      ...unanswered(record),
      status: 'ended',
      endedAt: new Date().toISOString(),
      launches: ended(record.launches),
    }));
    this.event('status', reason);
  }

  answer(id: unknown, allow: boolean): void {
    const request = this.current?.requests.find((entry) => entry.id === id);
    if (!this.host || !request) fail('That request is no longer open.');
    this.host.answer(request.native, allow);
    this.patch((record) => ({
      ...record,
      requests: record.requests.filter((entry) => entry !== request),
    }));
    if (request.toolId)
      this.command(request.toolId, (command) =>
        command
          ? {
              ...command,
              asked: allow ? 'allowed' : 'denied',
              ...(allow ? {} : { outcome: 'denied' as const }),
            }
          : null,
      );
    this.event(
      'decision',
      `You ${allow ? 'allowed' : 'denied'} ${request.tool}: ${request.action}`,
    );
  }

  review(id: unknown): void {
    const command = this.current?.commands.find((entry) => entry.id === id);
    if (!command || !needsReview(command))
      fail('That command does not need a review.');
    this.command(command.id, (entry) =>
      entry ? { ...entry, reviewedAt: new Date().toISOString() } : null,
    );
  }

  /** Pause a live session and wait for its record. Returns false when the last save failed. */
  async close(): Promise<boolean> {
    this.pause();
    while (this.writing) await this.writing;
    await this.transcript?.writer.flushed();
    return !this.saveFailed;
  }

  /** Stop the harness and keep the native session, so a later owner can resume it. */
  private pause(): void {
    const record = this.current;
    if (!this.host || !record) return;
    this.host.close();
    this.host = null;
    // A task session ends with the owner. Its task keeps the work as a version.
    const resumable = record.nativeSessionId !== null && !record.task;
    this.patch((current) => ({
      ...unanswered(current),
      status: resumable ? 'paused' : 'ended',
      endedAt: new Date().toISOString(),
      launches: ended(current.launches),
    }));
    this.event(
      'status',
      `${record.status === 'running' ? 'The current turn stopped with Verifold. Its outcome is unknown. ' : ''}${resumable ? 'Verifold stopped, so the session paused. Run verifold in this folder to resume it.' : 'Verifold stopped before the harness reported a session, so the session ended.'}`,
    );
  }

  private ready(): void {
    if (this.blocked) fail(this.blocked);
    if (this.host || this.launching)
      fail('A session is already running. End it before you start another.');
  }

  /** Save the launch, then start the harness. A launch that cannot be saved does not start. */
  private async launch(prompt?: string): Promise<void> {
    const record = this.current;
    if (!record) return;
    const launch: SessionLaunch = {
      id: randomBytes(4).toString('hex'),
      ownerId: this.options.ownerId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      pid: null,
      processStart: null,
    };
    this.launching = true;
    try {
      this.patch((current) => ({
        ...current,
        launches: [...current.launches, launch].slice(-50),
      }));
      while (this.writing) await this.writing;
      if (this.saveFailed) {
        this.current = {
          ...record,
          status: 'failed',
          endedAt: new Date().toISOString(),
        };
        fail(
          'Verifold could not save the session record, so the harness did not start. Check .verifold/sessions/ and try again.',
        );
      }
      const writer = await TranscriptWriter.open(
        transcriptFile(this.root, record.id),
      );
      this.transcript = { writer, apply: writer.run() };
      if (prompt !== undefined) this.transcript.apply(requestUpdate(prompt));
      const executable = this.options.executables?.[record.host];
      const native = record.nativeSessionId;
      this.prompted = prompt !== undefined;
      this.host = startHostSession({
        host: record.host,
        cwd: record.cwd ? join(this.root, record.cwd) : this.root,
        mode: record.mode,
        clientVersion: this.options.clientVersion,
        ...(record.model ? { model: record.model } : {}),
        ...(prompt === undefined ? {} : { prompt }),
        ...(native && prompt === undefined
          ? { resume: native }
          : native
            ? { sessionId: native }
            : {}),
        ...(executable ? { executable } : {}),
        onEvent: (event) => this.onHost(record.id, launch.id, event),
      });
      const pid = this.host.pid;
      if (pid !== undefined) {
        this.identify(launch.id, { pid });
        // A later owner checks the start time before it stops a process with this PID.
        void processStart(pid).then((start) =>
          this.identify(launch.id, { processStart: start }),
        );
      }
    } finally {
      this.launching = false;
    }
  }

  /** Record the process of a launch, while that launch is still current. */
  private identify(
    launch: string,
    process: { readonly pid?: number; readonly processStart?: string | null },
  ): void {
    this.patch((current) => {
      const last = current.launches.at(-1);
      return last?.id === launch
        ? {
            ...current,
            launches: current.launches.with(-1, { ...last, ...process }),
          }
        : current;
    });
  }

  private text(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 100_000)
      fail('Write a message for the harness, up to 100,000 characters.');
    return value.trim();
  }

  private patch(change: (record: SessionRecord) => SessionRecord): void {
    if (!this.current) return;
    this.current = change(this.current);
    this.save();
  }

  private event(kind: SessionEvent['kind'], text: string): void {
    const event: SessionEvent = {
      at: new Date().toISOString(),
      kind,
      text: clean(text, 4000),
    };
    this.patch((record) => ({
      ...record,
      events: [...record.events, event].slice(-400),
    }));
    this.options.onEvent?.(event);
  }

  /** Update or create one command record. Returning null leaves a missing entry absent. */
  private command(
    id: string,
    change: (command: CommandEntry | undefined) => CommandEntry | null,
  ): void {
    this.patch((record) => {
      const index = record.commands.findIndex((entry) => entry.id === id);
      const next = change(index >= 0 ? record.commands[index] : undefined);
      if (!next) return record;
      return {
        ...record,
        commands:
          index >= 0
            ? record.commands.with(index, next)
            : [...record.commands, next].slice(-1000),
      };
    });
  }

  private fresh(id: string, tool: string, action: string): CommandEntry {
    const record = this.current;
    return {
      id: clean(id, 200),
      at: new Date().toISOString(),
      tool: clean(tool, 80),
      action: clean(action, 2000),
      risk: riskTags(tool, action, this.root),
      auto: record?.host === 'claude' && record.reportedMode === 'auto',
      outcome: 'running',
    };
  }

  private onHost(id: string, launch: string, event: HostEvent): void {
    const record = this.current;
    // An event from an earlier launch cannot change the current one.
    if (!record || record.id !== id || record.launches.at(-1)?.id !== launch)
      return;
    if (event.type === 'exit') {
      if (!this.host) return;
      this.host = null;
      this.patch((current) => ({
        ...unanswered(current),
        status: event.code === 0 ? 'ended' : 'failed',
        endedAt: new Date().toISOString(),
        launches: ended(current.launches),
      }));
      this.event(
        'status',
        `The ${hostName(record.host)} process exited${event.code === null ? '' : ` with code ${event.code}`}.`,
      );
      if (record.task)
        this.options.onTaskTurn?.(
          record.task,
          'exited',
          this.current?.events.findLast((entry) => entry.kind === 'notice')
            ?.text,
        );
      return;
    }
    if (!this.host) return;
    const name = hostName(record.host);
    switch (event.type) {
      case 'session': {
        const first = record.status === 'starting';
        this.patch((current) => ({
          ...current,
          nativeSessionId: nativeId(event.id),
          reportedMode: event.mode
            ? clean(event.mode, 40)
            : current.reportedMode,
          status: first ? (this.prompted ? 'running' : 'idle') : current.status,
        }));
        if (first)
          this.event(
            'status',
            this.prompted
              ? `${name} session started${event.model ? ` with ${event.model}` : ''}. Mode: ${modeLabel(this.current ?? record)}.`
              : `${name} is ready to continue the session. Send a follow-up.`,
          );
        else if (event.mode && event.mode !== record.reportedMode)
          this.event(
            'status',
            `${name} now reports the mode ${modeLabel(this.current ?? record)}.`,
          );
        break;
      }
      case 'mode':
        this.patch((current) => ({
          ...current,
          reportedMode: clean(event.mode, 40),
        }));
        this.event(
          'status',
          `${name} now reports the mode ${modeLabel(this.current ?? record)}.`,
        );
        break;
      case 'message':
        this.event('agent', event.text);
        break;
      case 'tool':
        this.command(
          event.id,
          (command) =>
            command ?? this.fresh(event.id, event.tool, event.action),
        );
        this.event('tool', `${event.tool}: ${event.action}`);
        break;
      case 'tool-end': {
        // A denied call also reports an error result. Its outcome stays Denied.
        const known = record.commands.find((entry) => entry.id === event.id);
        const denied =
          known?.asked === 'denied' || known?.harnessDenied !== undefined;
        this.command(event.id, (command) =>
          command
            ? {
                ...command,
                outcome: denied ? 'denied' : event.outcome,
                ...(event.exitCode === undefined
                  ? {}
                  : { exitCode: event.exitCode }),
              }
            : null,
        );
        if (!denied && event.outcome !== 'ok')
          this.event(
            'tool',
            `${event.outcome === 'failed' ? 'A tool call failed' : 'A tool call was declined'}${event.exitCode === undefined ? '' : ` (exit code ${event.exitCode})`}.`,
          );
        break;
      }
      case 'request': {
        const request: PendingRequest = {
          id: `R${this.requests.next++}`,
          native: event.id,
          tool: clean(event.tool, 80),
          action: clean(event.action, 2000),
          at: new Date().toISOString(),
          ...(event.toolId ? { toolId: event.toolId } : {}),
          ...(event.detail ? { detail: clean(event.detail, 4000) } : {}),
          ...(event.reason ? { reason: clean(event.reason, 1000) } : {}),
        };
        if (event.toolId)
          this.command(event.toolId, (command) => ({
            ...(command ??
              this.fresh(event.toolId ?? '', event.tool, event.action)),
            asked: 'pending',
          }));
        this.patch((current) => ({
          ...current,
          requests: [...current.requests, request],
        }));
        this.event(
          'request',
          `${request.id}: ${name} asks to use ${request.tool}: ${request.action}${request.detail ? ' Read the change on the desk before you answer.' : ''}`,
        );
        break;
      }
      case 'request-end': {
        const request = record.requests.find(
          (entry) => entry.native === event.id,
        );
        if (!request) break;
        this.patch((current) => ({
          ...current,
          requests: current.requests.filter((entry) => entry !== request),
        }));
        if (request.toolId)
          this.command(request.toolId, (command) =>
            command?.asked === 'pending'
              ? { ...command, asked: 'unanswered' }
              : (command ?? null),
          );
        this.event(
          'status',
          `${name} withdrew ${request.id} before you answered.`,
        );
        break;
      }
      case 'denied':
        this.command(event.toolId, (command) =>
          command
            ? {
                ...command,
                harnessDenied: clean(event.reason, 80),
                outcome: 'denied',
              }
            : null,
        );
        this.event('decision', `${name} denied a tool call (${event.reason}).`);
        break;
      case 'review':
        this.command(event.toolId, (command) => ({
          ...(command ??
            this.fresh(event.toolId, 'Command', event.action ?? '')),
          review: {
            approved: event.approved,
            ...(event.risk ? { risk: clean(event.risk, 40) } : {}),
            ...(event.rationale
              ? { rationale: clean(event.rationale, 1000) }
              : {}),
          },
        }));
        this.event(
          'decision',
          `The Codex reviewer ${event.approved ? 'approved' : 'denied'} ${event.action ?? 'a command'}.${event.risk ? ` Risk: ${event.risk}.` : ''}${event.rationale ? ` ${event.rationale}` : ''}`,
        );
        break;
      case 'turn-end':
        this.patch((current) => ({
          ...unanswered(current),
          status: 'idle',
          ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
        }));
        this.event(
          'status',
          record.task
            ? `The turn ${event.status === 'completed' ? 'ended' : event.status === 'interrupted' ? 'was stopped' : 'failed'}. Verifold saves the task folder as a version for review.`
            : `The turn ${event.status === 'completed' ? 'ended' : event.status === 'interrupted' ? 'was cancelled' : 'failed'}. Send a follow-up or end the session.`,
        );
        if (record.task) this.options.onTaskTurn?.(record.task, event.status);
        break;
      case 'notice':
        this.event('notice', event.text);
        break;
      case 'transcript':
        this.transcript?.apply(event.update);
        break;
    }
  }

  private save(): void {
    this.dirty = true;
    if (this.writing) return;
    this.writing = (async () => {
      while (this.dirty && this.current) {
        this.dirty = false;
        await writeRecord(this.root, this.current);
      }
      this.saveFailed = false;
    })()
      .catch(() => {
        // The next change retries. The desk shows that the record is not saved.
        this.saveFailed = true;
      })
      .finally(() => {
        this.writing = null;
      });
  }
}
