/** What changed on the server: the board's last event, and the version of the agents' activity. */
export interface Change {
  readonly seq: number;
  readonly activity: number;
}

/** What the app does when the server reports a change, or when the stream drops and comes back. */
export interface ChangeWatcher {
  readonly onChange: (change: Change) => void;
  readonly onLost: () => void;
  readonly onBack: () => void;
}

/** Return the change in an event's data, or `null` for data that is not one. */
export function parseChange(data: unknown): Change | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    if (
      typeof value === 'object' &&
      value !== null &&
      'seq' in value &&
      'activity' in value &&
      typeof value.seq === 'number' &&
      typeof value.activity === 'number'
    ) {
      return { seq: value.seq, activity: value.activity };
    }
  } catch {
    // Data that is not JSON is not a change.
  }
  return null;
}

/**
 * Tell `watcher` about each change in the lab, until the returned function is called.
 *
 * Each message carries only the board's last event and the activity version, and the app reads the views again.
 * A browser's EventSource cannot set headers, so the token goes in the query, as the server expects. The browser
 * reconnects by itself after a drop.
 */
export function watchChanges(token: string, watcher: ChangeWatcher): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  let lost = false;
  source.addEventListener('change', (event: MessageEvent<unknown>) => {
    const change = parseChange(event.data);
    if (change) watcher.onChange(change);
  });
  source.addEventListener('error', () => {
    if (lost) return;
    lost = true;
    watcher.onLost();
  });
  source.addEventListener('open', () => {
    if (!lost) return;
    lost = false;
    watcher.onBack();
  });
  return () => {
    source.close();
  };
}
