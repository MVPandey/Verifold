import type { HarnessName } from './harness.ts';
import {
  loadPaused,
  SessionActionError,
  SessionManager,
  type PausedSession,
  type SessionEvent,
  type SessionManagerOptions,
  type SessionView,
} from './session.ts';

/** Runtime admission: at most this many harness sessions run at the same time. */
export const workerLimit = 2;

function fail(message: string): never {
  throw new SessionActionError(message);
}

export interface SessionPoolOptions
  extends Omit<SessionManagerOptions, 'onEvent' | 'requests'> {
  /** One event of one worker. `view` is that worker's session. */
  readonly onEvent?: (event: SessionEvent, view: SessionView | null) => void;
}

/**
 * The workers of one project owner: a fixed number of slots, each one session
 * manager with its own session, launch, native ID, and record. Tasks and plain
 * sessions share the slots. Request IDs share one counter, so an answer reaches
 * exactly one worker.
 */
export class SessionPool {
  private readonly root: string;
  private readonly slots: SessionManager[] = [];
  private pausedList: PausedSession[] = [];
  private blocked: string | null = null;

  constructor(root: string, options: SessionPoolOptions) {
    this.root = root;
    const requests = { next: 1 };
    for (let index = 0; index < workerLimit; index++) {
      const slot: SessionManager = new SessionManager(root, {
        ...options,
        requests,
        onEvent: (event) => options.onEvent?.(event, slot.view()),
      });
      this.slots.push(slot);
    }
  }

  /** Every worker with a session, live or ended, in slot order. */
  views(): SessionView[] {
    return this.slots.flatMap((slot) => {
      const view = slot.view();
      return view ? [view] : [];
    });
  }

  /** A worker by session ID. */
  view(id: string): SessionView | null {
    return this.slot(id)?.view() ?? null;
  }

  /** A worker runs or starts. */
  get active(): boolean {
    return this.slots.some((slot) => slot.active);
  }

  /** Every slot is in use, so no worker can start. */
  get full(): boolean {
    return this.slots.every((slot) => slot.active);
  }

  get blockedReason(): string | null {
    return this.blocked;
  }

  block(reason: string | null): void {
    this.blocked = reason;
    for (const slot of this.slots) slot.block(reason);
  }

  async load(): Promise<void> {
    this.pausedList = await loadPaused(this.root);
  }

  paused(): readonly PausedSession[] {
    return this.pausedList;
  }

  /** Start a plain session in a free slot. Returns its ID. */
  async start(input: Parameters<SessionManager['start']>[0]): Promise<string> {
    const slot = this.free();
    await slot.start(input);
    return slot.view()?.record.id ?? fail('The session did not start.');
  }

  startTask(input: {
    readonly host: HarnessName;
    readonly model?: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly task: { readonly id: string; readonly claim: string };
  }): Promise<string> {
    return this.free().startTask(input);
  }

  async resume(id: unknown): Promise<void> {
    await this.free().resume(id);
    this.pausedList = this.pausedList.filter((entry) => entry.id !== id);
  }

  async restart(id: unknown): Promise<void> {
    await this.free().restart(id);
    this.pausedList = this.pausedList.filter((entry) => entry.id !== id);
  }

  send(id: unknown, text: unknown): void {
    this.live(id).send(text);
  }

  cancel(id: unknown): void {
    this.live(id).cancel();
  }

  end(id: unknown, reason?: string): void {
    this.live(id).end(reason);
  }

  /** Request IDs are unique across workers, so the ID finds the worker. */
  answer(request: unknown, allow: boolean): void {
    const slot = this.slots.find((entry) =>
      entry.view()?.record.requests.some((open) => open.id === request),
    );
    if (!slot) fail('That request is no longer open.');
    slot.answer(request, allow);
  }

  review(command: unknown): void {
    const slot = this.slots.find((entry) =>
      entry.view()?.record.commands.some((logged) => logged.id === command),
    );
    if (!slot) fail('That command does not need a review.');
    slot.review(command);
  }

  /** The worker waits for a follow-up. */
  idle(id: string): boolean {
    return this.slot(id)?.idleSession() === id;
  }

  continueTask(id: string, text: string): void {
    this.live(id).continueTask(text);
  }

  endTask(id: string, reason: string): void {
    this.live(id).endTask(reason);
  }

  /** Pause or end every worker. Returns false when a record could not be saved. */
  async close(): Promise<boolean> {
    const saved = await Promise.all(this.slots.map((slot) => slot.close()));
    return saved.every(Boolean);
  }

  private slot(id: unknown): SessionManager | undefined {
    return this.slots.find((slot) => slot.view()?.record.id === id);
  }

  private live(id: unknown): SessionManager {
    const slot = this.slot(id);
    if (!slot?.view()?.live) fail('That session is not running.');
    return slot;
  }

  private free(): SessionManager {
    if (this.blocked) fail(this.blocked);
    return (
      this.slots.find((slot) => !slot.active) ??
      fail(
        `${workerLimit} workers are running. Wait for one to end, or end one before you start another.`,
      )
    );
  }
}
