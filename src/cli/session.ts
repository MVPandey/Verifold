import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { validateModel, type HarnessName } from './harness.ts';
import {
  startHostSession,
  type HostEvent,
  type HostSession,
  type SessionMode,
} from './session-hosts.ts';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'ended'
  | 'failed';

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
  readonly outcome: 'running' | 'ok' | 'failed' | 'declined' | 'denied';
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

export interface SessionRecord {
  readonly schemaVersion: 1;
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
}

export interface SessionView {
  readonly record: SessionRecord;
  readonly live: boolean;
  readonly saveFailed: boolean;
}

export interface SessionManagerOptions {
  readonly clientVersion: string;
  /** Override host executables for an isolated installation or a test fixture. */
  readonly executables?: Partial<Record<HarnessName, string>>;
  readonly onEvent?: (event: SessionEvent) => void;
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

function validSessionId(id: string): boolean {
  return /^\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(id);
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
  private nextRequest = 1;
  private blocked: string | null = null;
  private dirty = false;
  private writing: Promise<void> | null = null;
  private saveFailed = false;

  constructor(root: string, options: SessionManagerOptions) {
    this.root = root;
    this.options = options;
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

  /** Refuse new sessions while other work in this process uses the project. */
  block(reason: string | null): void {
    this.blocked = reason;
  }

  /** Why a new session is refused now, or null. */
  get blockedReason(): string | null {
    return this.blocked;
  }

  start(input: {
    readonly host: unknown;
    readonly mode: unknown;
    readonly model?: unknown;
    readonly prompt: unknown;
  }): void {
    if (this.blocked) fail(this.blocked);
    if (this.host)
      fail('A session is already running. End it before you start another.');
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
    const now = new Date();
    const id = `${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`;
    this.current = {
      schemaVersion: 1,
      id,
      host,
      model: model ?? null,
      mode,
      reportedMode: null,
      nativeSessionId: null,
      status: 'starting',
      startedAt: now.toISOString(),
      endedAt: null,
      costUsd: null,
      events: [],
      commands: [],
      requests: [],
    };
    const executable = this.options.executables?.[host];
    this.host = startHostSession({
      host,
      cwd: this.root,
      mode,
      prompt,
      clientVersion: this.options.clientVersion,
      ...(model ? { model } : {}),
      ...(executable ? { executable } : {}),
      onEvent: (event) => this.onHost(id, event),
    });
    // Host events arrive asynchronously, so the prompt is still the first event.
    this.event('you', prompt);
  }

  send(value: unknown): void {
    const text = this.text(value);
    if (!this.host || this.current?.status !== 'idle')
      fail('Wait for the current turn to end, or cancel it.');
    this.host.send(text);
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
    if (!this.host) fail('No session is running.');
    this.host.close();
    this.host = null;
    this.patch((record) => ({
      ...unanswered(record),
      status: 'ended',
      endedAt: new Date().toISOString(),
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

  /** End a live session and wait for its record. Returns false when the last save failed. */
  async close(): Promise<boolean> {
    if (this.host) this.end('Verifold closed, so the session ended.');
    while (this.writing) await this.writing;
    return !this.saveFailed;
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

  private onHost(id: string, event: HostEvent): void {
    const record = this.current;
    if (!record || record.id !== id) return;
    if (event.type === 'exit') {
      if (!this.host) return;
      this.host = null;
      this.patch((current) => ({
        ...unanswered(current),
        status: event.code === 0 ? 'ended' : 'failed',
        endedAt: new Date().toISOString(),
      }));
      this.event(
        'status',
        `The ${hostName(record.host)} process exited${event.code === null ? '' : ` with code ${event.code}`}.`,
      );
      return;
    }
    if (!this.host) return;
    const name = hostName(record.host);
    switch (event.type) {
      case 'session':
        this.patch((current) => ({
          ...current,
          nativeSessionId: nativeId(event.id),
          reportedMode: event.mode ? clean(event.mode, 40) : null,
          status: 'running',
        }));
        this.event(
          'status',
          `${name} session started${event.model ? ` with ${event.model}` : ''}. Mode: ${modeLabel(this.current ?? record)}.`,
        );
        break;
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
          id: `R${this.nextRequest++}`,
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
          `The turn ${event.status === 'completed' ? 'ended' : event.status === 'interrupted' ? 'was cancelled' : 'failed'}. Send a follow-up or end the session.`,
        );
        break;
      case 'notice':
        this.event('notice', event.text);
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
