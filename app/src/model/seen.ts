import { PERSON } from '../api/types.ts';
import type { ThreadSummary } from '../api/types.ts';

/** Where the app keeps what the person has seen. `localStorage` in the browser. */
export interface SeenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The last post that the person saw in each thread, by thread ID. */
export type Seen = Readonly<Record<string, number>>;

/** Return what the person has seen in the lab that opened at `lab`. Damaged storage counts as nothing seen. */
export function readSeen(store: SeenStore, lab: string): Seen {
  try {
    const stored: unknown = JSON.parse(store.getItem(key(lab)) ?? '{}');
    if (typeof stored !== 'object' || stored === null) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    );
  } catch {
    return {};
  }
}

/** Record that the person saw a thread up to post `seq`. */
export function markSeen(store: SeenStore, lab: string, thread: string, seq: number): void {
  const seen = readSeen(store, lab);
  if ((seen[thread] ?? 0) >= seq) return;
  store.setItem(key(lab), JSON.stringify({ ...seen, [thread]: seq }));
}

/** Return whether a thread has a post that the person has not seen. The person's own posts don't count. */
export function hasNew(summary: ThreadSummary, seen: Seen): boolean {
  const latest = summary.latest;
  return latest !== null && latest.author !== PERSON && latest.seq > (seen[summary.thread.id] ?? 0);
}

/**
 * Return whether the person chose to see every message of a thread, in the lab that opened at `lab`. `store`
 * gives the storage, and a browser can refuse it: storage that fails or is damaged counts as no choice.
 */
export function readUnfolded(store: () => SeenStore, lab: string, thread: string): boolean {
  try {
    return unfolded(store(), lab).includes(thread);
  } catch {
    return false;
  }
}

/** Record whether the person sees every message of a thread. When the storage fails, nothing is kept. */
export function markUnfolded(
  store: () => SeenStore,
  lab: string,
  thread: string,
  shown: boolean,
): void {
  try {
    const others = unfolded(store(), lab).filter((id) => id !== thread);
    store().setItem(unfoldedKey(lab), JSON.stringify(shown ? [...others, thread] : others));
  } catch {
    // The page still has the choice until it loads again.
  }
}

function unfolded(store: SeenStore, lab: string): readonly unknown[] {
  const stored: unknown = JSON.parse(store.getItem(unfoldedKey(lab)) ?? '[]');
  return Array.isArray(stored) ? (stored as readonly unknown[]) : [];
}

function key(lab: string): string {
  return `verifold-seen:${lab}`;
}

function unfoldedKey(lab: string): string {
  return `verifold-unfolded:${lab}`;
}
