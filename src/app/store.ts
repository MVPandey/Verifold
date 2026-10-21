import type { Snapshot } from '../protocol/api.ts';
import { readStream, StreamStop } from './api.ts';

/**
 * - `connecting`: no snapshot and no failure yet.
 * - `live`: the stream is open.
 * - `reconnecting`: the stream dropped after a snapshot. The page shows the last one while it retries.
 * - `unreachable`: Verifold did not answer, or refused (403, 503). `retrying` says whether it tries again.
 * - `outdated`: Verifold speaks another protocol version. The page must reload.
 * - `signed-out`: the tab has no valid token.
 */
export type Connection =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'unreachable'
  | 'outdated'
  | 'signed-out';

export interface LabState {
  readonly snapshot: Snapshot | null;
  readonly connection: Connection;
  /** Only network failures retry. A refusal stops until the page reloads. */
  readonly retrying: boolean;
}

/** True when `next` is newer: a new epoch (Verifold started again), or a higher rev. */
export function newer(current: Snapshot | null, next: Snapshot): boolean {
  return !current || current.epoch !== next.epoch || next.rev > current.rev;
}

/** The app's one store: the newest snapshot and the stream's state. */
export class LabStore {
  private state: LabState = {
    snapshot: null,
    connection: 'connecting',
    retrying: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly retryMs: number;

  /** `retryMs`: the first wait before a retry. It doubles up to 15 s. Tests set it short. */
  constructor(retryMs = 1000) {
    this.retryMs = retryMs;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): LabState => this.state;

  private set(next: Partial<LabState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Take a snapshot when it is newer than the one shown. */
  accept(snapshot: Snapshot): void {
    if (newer(this.state.snapshot, snapshot))
      this.set({ snapshot, connection: 'live', retrying: false });
    else if (this.state.connection !== 'live')
      this.set({ connection: 'live', retrying: false });
  }

  /**
   * Follow the event stream until `signal` aborts. Network failures retry
   * with backoff. A refusal, another protocol version, or a bad token stops.
   */
  async follow(token: string | null, signal: AbortSignal): Promise<void> {
    if (!token) {
      this.set({ connection: 'signed-out', retrying: false });
      return;
    }
    let delay = this.retryMs;
    while (!signal.aborted) {
      try {
        await readStream(token, signal, (snapshot) => {
          this.accept(snapshot);
          delay = this.retryMs;
        });
      } catch (error) {
        if (error instanceof StreamStop) {
          this.set({
            connection:
              error.reason === 'refused' ? 'unreachable' : error.reason,
            retrying: false,
          });
          return;
        }
      }
      if (signal.aborted) return;
      this.set({
        connection: this.state.snapshot ? 'reconnecting' : 'unreachable',
        retrying: true,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      delay = Math.min(delay * 2, 15_000);
    }
  }
}
