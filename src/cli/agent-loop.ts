/**
 * The wake loop of a long-lived agent session. Events wait in the agent's
 * record. One digest at a time wakes the session, within an hourly limit, and
 * events that arrive close together join one digest. The record keeps the
 * events, the cursor of the last event that a digest carried, and the recent
 * wakeups. Its owner saves it, decides how a digest reads, and sends it.
 */

export interface WakeEvent {
  readonly kind: string;
  readonly text: string;
}

export type QueuedEvent<E extends WakeEvent> = E & {
  readonly seq: number;
  readonly at: string;
  /** A Verifold read failed in the turn that first carried the event, so it came once more. */
  readonly again?: true;
};

/** The fields of an agent's record that the loop changes. */
export interface WakeRecord<E extends WakeEvent> {
  readonly cursor: number;
  readonly wakeups: readonly string[];
  readonly events: readonly QueuedEvent<E>[];
}

export interface WakeLimits {
  readonly wakeupsPerHour: number;
  /** Events in one digest. The rest wait for the next one. */
  readonly digest: number;
  /** Events kept in the record. */
  readonly events: number;
  /** Events that arrive within this time join one wakeup. */
  readonly debounceMs: number;
}

export interface WakeOwner<E extends WakeEvent, R extends WakeRecord<E>> {
  /** The record while the agent takes events. Null when there is no agent or it is stopped. */
  record(): R | null;
  save(record: R): Promise<void>;
  /** The agent's session can take a turn now. */
  ready(record: R): boolean;
  /** Send one digest as a turn. Throw when nothing was sent: the events then wait for the next wakeup. */
  send(events: readonly QueuedEvent<E>[], left: number): void;
  /** A digest was sent. */
  sent?(events: readonly QueuedEvent<E>[]): Promise<void>;
}

export class WakeLoop<E extends WakeEvent, R extends WakeRecord<E>> {
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** The events of the current turn's digest, and whether a read of the state or a file failed in that turn. */
  private carried: {
    readonly events: readonly QueuedEvent<E>[];
    readFailed: boolean;
  } | null = null;
  private limited: string | null = null;
  private readonly owner: WakeOwner<E, R>;
  private readonly limits: WakeLimits;

  constructor(owner: WakeOwner<E, R>, limits: WakeLimits) {
    this.owner = owner;
    this.limits = limits;
  }

  /** The wakeup limit holds events until this time. */
  get limitedUntil(): string | null {
    return this.limited;
  }

  /** Run one change after the previous one ends. The owner runs all its record changes here too. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Add events for the next wakeup, and wake after `delay`. */
  add(
    events: readonly (E & { readonly again?: true })[],
    delay: number = this.limits.debounceMs,
  ): void {
    this.serial(async () => {
      const record = this.owner.record();
      if (!record) return;
      const first = (record.events.at(-1)?.seq ?? 0) + 1;
      const at = new Date().toISOString();
      // The schedule comes first: the events are in memory even if the save fails.
      const saving = this.owner.save({
        ...record,
        events: [
          ...record.events,
          ...events.map((event, index) => ({
            ...event,
            // One line, so the lines of a digest stay apart. It holds a whole message of up to 4000 characters.
            text: event.text.replace(/[\r\n]+/g, ' ').slice(0, 6000),
            seq: first + index,
            at,
          })),
        ].slice(-this.limits.events),
      });
      this.schedule(delay);
      await saving;
    }).catch(() => {
      /* The next save writes the events. */
    });
  }

  /** A Verifold read failed in the current turn. Its events come once more after the turn. */
  readFailed(): void {
    if (this.carried) this.carried.readFailed = true;
  }

  /** The session's turn ended, or its process stopped. New events wake it. */
  turnEnded(): void {
    // A failed read can hide what an event was about, so its events come once more.
    const carried = this.carried;
    this.carried = null;
    if (carried?.readFailed) {
      const again = carried.events.filter((event) => !event.again);
      if (again.length)
        this.add(again.map((event) => ({ ...event, again: true as const })));
    }
    this.schedule();
  }

  /** Wake after `delay`. A shorter delay replaces a longer one that waits. */
  schedule(delay: number = this.limits.debounceMs): void {
    if (!this.owner.record() || (this.timer && delay >= this.limits.debounceMs))
      return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.serial(() => this.wake()).catch(() => {
        /* The events wait for the next wakeup. */
      });
    }, delay);
    this.timer.unref();
  }

  /** Cancel a wakeup that waits. With `reset`, forget the wakeup limit too. */
  cancel(reset = false): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (reset) this.limited = null;
  }

  /** Stop the wakeups, and let the change that runs end. */
  async close(): Promise<void> {
    this.cancel();
    await this.queue;
  }

  /** Send the waiting events as one turn, within the hourly limit. */
  private async wake(): Promise<void> {
    const record = this.owner.record();
    if (!record) return;
    const waiting = record.events.filter((event) => event.seq > record.cursor);
    // A busy session gets the events when its turn ends.
    if (!waiting.length || !this.owner.ready(record)) return;
    const hour = Date.now() - 3_600_000;
    const recent = record.wakeups.filter((at) => Date.parse(at) > hour);
    if (recent.length >= this.limits.wakeupsPerHour) {
      const next = Date.parse(recent[0] ?? '') + 3_600_000 + 1000;
      this.limited = new Date(next).toISOString();
      this.schedule(Math.max(1000, next - Date.now()));
      return;
    }
    this.limited = null;
    const sent = waiting.slice(0, this.limits.digest);
    // The cursor is saved first, so a restart never repeats a digest.
    await this.owner.save({
      ...record,
      cursor: sent.at(-1)?.seq ?? record.cursor,
      wakeups: [...recent, new Date().toISOString()],
    });
    try {
      this.owner.send(sent, waiting.length - sent.length);
    } catch {
      // Nothing was sent, so the events wait for the next wakeup.
      const current = this.owner.record();
      if (current)
        await this.owner.save({
          ...current,
          cursor: record.cursor,
          wakeups: record.wakeups,
        });
      return;
    }
    this.carried = { events: sent, readFailed: false };
    await this.owner.sent?.(sent);
  }
}
