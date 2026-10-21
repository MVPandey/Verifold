import type { Snapshot } from '../protocol/api.ts';
import { readStream, signedOut } from './api.ts';

/**
 * `connecting`: no snapshot yet. `live`: the stream is open. `reconnecting`:
 * the stream dropped, and the page shows the last snapshot. `signed-out`: the
 * tab has no valid token.
 */
export type Connection = 'connecting' | 'live' | 'reconnecting' | 'signed-out';

export interface LabState {
  readonly snapshot: Snapshot | null;
  readonly connection: Connection;
}

/** True when `next` is newer: a new epoch (Verifold started again), or a higher rev. */
export function newer(current: Snapshot | null, next: Snapshot): boolean {
  return !current || current.epoch !== next.epoch || next.rev > current.rev;
}

/** The app's one store: the newest snapshot and the stream's state. */
export class LabStore {
  private state: LabState = { snapshot: null, connection: 'connecting' };
  private readonly listeners = new Set<() => void>();

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
      this.set({ snapshot, connection: 'live' });
    else if (this.state.connection !== 'live') this.set({ connection: 'live' });
  }

  /** Follow the event stream until `signal` aborts. A dropped stream retries with backoff. */
  async follow(token: string | null, signal: AbortSignal): Promise<void> {
    if (!token) {
      this.set({ connection: 'signed-out' });
      return;
    }
    let delay = 1000;
    while (!signal.aborted) {
      try {
        await readStream(token, signal, (snapshot) => {
          this.accept(snapshot);
          delay = 1000;
        });
      } catch (error) {
        if (error === signedOut) {
          this.set({ connection: 'signed-out' });
          return;
        }
      }
      if (signal.aborted) return;
      if (this.state.snapshot) this.set({ connection: 'reconnecting' });
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
