import type { Terminal } from './terminals.ts';
import type { AgentTools } from './session-hosts.ts';
import {
  loadPaused,
  refusal,
  resumableTask,
  SessionActionError,
  startInput,
  SessionManager,
  type PausedSession,
  type SessionEvent,
  type SessionManagerOptions,
  type SessionView,
} from './session.ts';

/** "Agents at once" when the project does not set it. */
export const defaultAgents = 3;

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** Every slot is taken. The caller can wait and try again; nothing failed. */
export class PoolFullError extends SessionActionError {}

export interface SessionPoolOptions
  extends Omit<SessionManagerOptions, 'onEvent' | 'requests'> {
  /** One event of one worker. `view` is that worker's session. */
  readonly onEvent?: (event: SessionEvent, view: SessionView | null) => void;
  /** "Agents at once" at start. The default is `defaultAgents`. */
  readonly agents?: number;
  /**
   * Called when the person's own session finds every slot taken. A lab parks
   * an agent that had its turn. Tasks never call it: a lab run has no tasks.
   */
  readonly makeRoom?: () => Promise<unknown>;
}

/**
 * The workers of one project owner: one slot for each worker that ran, each
 * one session manager with its own session, launch, native ID, and record.
 * Tasks, plain sessions, and lab agents share the slots, but one run has
 * either tasks or a lab, never both. At most `limit` of them run at once. A start takes its slot before its first await,
 * so two starts can never take the same slot or pass the limit together.
 * Request IDs share one counter, so an answer reaches exactly one worker.
 */
export class SessionPool {
  private readonly root: string;
  private readonly options: SessionPoolOptions;
  private readonly requests = { next: 1 };
  private readonly slots: SessionManager[] = [];
  /** Slots that a start took and whose session is not active yet. */
  private readonly taken = new Set<SessionManager>();
  /** The owner closes the pool: no new start takes a slot. */
  private closing = false;
  private pausedList: PausedSession[] = [];
  /** Whether a task session that is not in a slot can resume. A record does not change until a slot resumes it. */
  private readonly resumable = new Map<string, boolean>();
  /** "Agents at once". A lower limit stops no worker; new starts wait until fewer run. */
  limit: number;

  constructor(root: string, options: SessionPoolOptions) {
    this.root = root;
    this.options = options;
    this.limit = options.agents ?? defaultAgents;
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

  /** `limit` workers run or start, so no other worker can start. */
  get full(): boolean {
    return (
      this.slots.filter((slot) => slot.active || this.taken.has(slot)).length >=
      this.limit
    );
  }

  async load(): Promise<void> {
    this.pausedList = await loadPaused(this.root);
  }

  /** Forget the ended sessions and read the paused ones again, after Start over or a restore. */
  async forget(): Promise<void> {
    for (const slot of this.slots) slot.forget();
    await this.load();
  }

  paused(): readonly PausedSession[] {
    return this.pausedList;
  }

  /** Start a plain session in a free slot. Returns its ID. */
  start(input: Parameters<SessionManager['start']>[0]): Promise<string> {
    return this.withRoom(
      () => {
        startInput(input);
        return Promise.resolve();
      },
      async (slot) => {
        await slot.start(input);
        return slot.view()?.record.id ?? fail('The session did not start.');
      },
    );
  }

  startTask(
    input: Parameters<SessionManager['startTask']>[0],
  ): Promise<string> {
    return this.use((slot) => slot.startTask(input));
  }

  async resume(id: unknown): Promise<void> {
    await this.withRoom(
      () => this.check(id, 'resume'),
      (slot) => slot.resume(id),
      id,
    );
    this.pausedList = this.pausedList.filter((entry) => entry.id !== id);
  }

  /** A task session that stopped with an earlier owner can resume for its next turn. */
  async canResume(id: string): Promise<boolean> {
    if (this.slot(id)) return false;
    let known = this.resumable.get(id);
    if (known === undefined) {
      known = await resumableTask(this.root, id);
      this.resumable.set(id, known);
    }
    return known;
  }

  async resumeTask(
    id: string,
    input: { readonly prompt: string; readonly tools?: AgentTools },
  ): Promise<void> {
    await this.use((slot) => {
      this.resumable.delete(id);
      return slot.resumeTask(id, input);
    });
  }

  /**
   * Start a lab agent's session in a free slot. Returns its ID. A full pool
   * throws `PoolFullError` before anything starts. The lab makes its own room.
   */
  startAgent(
    input: Parameters<SessionManager['startAgent']>[0],
  ): Promise<string> {
    return this.use((slot) => slot.startAgent(input));
  }

  /** Continue a lab agent's paused session in a free slot, with its tools and the domains of its shell. */
  resumeAgent(
    id: string,
    tools: AgentTools,
    network?: readonly string[],
  ): Promise<void> {
    return this.use((slot) => slot.resume(id, tools, network), id);
  }

  /**
   * Pause a live session and free its slot. Its native session stays, so it
   * can resume later. Returns false when its record could not be saved.
   */
  park(id: string): Promise<boolean> {
    return this.slot(id)?.close() ?? Promise.resolve(true);
  }

  async restart(id: unknown): Promise<void> {
    await this.withRoom(
      () => this.check(id, 'restart'),
      (slot) => slot.restart(id),
      id,
    );
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

  /** The native terminal of a worker, while the person holds it. */
  terminal(id: unknown): Terminal | null {
    return this.slot(id)?.terminal ?? null;
  }

  takeTerminal(id: string, lease: string): Promise<void> {
    return this.live(id).takeTerminal(lease);
  }

  /** The lab hands its agent's session to the harness's own terminal. */
  takeAgentTerminal(id: string, lease: string): Promise<void> {
    return this.live(id).takeTerminal(lease, true);
  }

  returnFromTerminal(id: unknown): void {
    this.live(id).returnFromTerminal();
  }

  continueTask(id: string, text: string): void {
    this.live(id).continueTask(text);
  }

  /** Add a message to the running turn of a worker. False when that worker runs no turn. */
  steer(id: string, text: string, done: (taken: boolean) => void): boolean {
    return this.slot(id)?.steer(text, done) ?? false;
  }

  endTask(id: string, reason: string): void {
    this.live(id).endTask(reason);
  }

  /** Pause or end every worker. Returns false when a record could not be saved. */
  async close(): Promise<boolean> {
    this.closing = true;
    const saved = await Promise.all(this.slots.map((slot) => slot.close()));
    return saved.every(Boolean);
  }

  /** The slot of a session. A session resumes in the slot that holds its record, so it is in one slot only. */
  private slot(id: unknown): SessionManager | undefined {
    return this.slots.find((slot) => slot.view()?.record.id === id);
  }

  private live(id: unknown): SessionManager {
    const slot = this.slot(id);
    if (!slot?.view()?.live) fail('That session is not running.');
    return slot;
  }

  /** Refuse a resume or restart that cannot happen, before a lab agent gives its slot for it. */
  private async check(
    id: unknown,
    action: 'resume' | 'restart',
  ): Promise<void> {
    const reason = await refusal(this.root, id, action);
    if (reason) fail(reason);
  }

  /**
   * A start of the person's own session. A pool with room takes the slot at
   * once, before any await. A full pool checks the input first, so no lab
   * agent gives its slot for a start that cannot happen, then asks the lab to
   * park an agent that had its turn. A close that comes meanwhile wins.
   */
  private async withRoom<T>(
    check: () => Promise<void>,
    start: (slot: SessionManager) => Promise<T>,
    session?: unknown,
  ): Promise<T> {
    if (this.full && this.options.makeRoom) {
      await check();
      if (!this.closing) await this.options.makeRoom();
    }
    return this.use(start, session);
  }

  /**
   * Take a free slot at once, before any await, and run a start in it. The
   * slot counts as taken until the start ends. A resume of `session` takes
   * the slot that holds its record when that slot is free.
   */
  private async use<T>(
    start: (slot: SessionManager) => Promise<T>,
    session?: unknown,
  ): Promise<T> {
    if (this.closing) fail('Verifold is stopping. Start it again first.');
    const slot = this.free(session);
    this.taken.add(slot);
    try {
      return await start(slot);
    } finally {
      this.taken.delete(slot);
    }
  }

  /** A slot for one more worker: the free slot that holds `session`, a slot whose worker ended, or a new one. */
  private free(session?: unknown): SessionManager {
    if (this.full)
      throw new PoolFullError(
        `${this.limit} ${this.limit === 1 ? 'agent runs' : 'agents run'}, the most that "Agents at once" allows. Wait for one to end, or raise the setting in Compute.`,
      );
    const open = (slot: SessionManager): boolean =>
      !slot.active && !this.taken.has(slot);
    const idle =
      (session === undefined
        ? undefined
        : this.slots.find(
            (slot) => open(slot) && slot.view()?.record.id === session,
          )) ?? this.slots.find(open);
    if (idle) return idle;
    const slot: SessionManager = new SessionManager(this.root, {
      ...this.options,
      requests: this.requests,
      onEvent: (event) => this.options.onEvent?.(event, slot.view()),
    });
    this.slots.push(slot);
    return slot;
  }
}
