import type { Run, RunDetail } from '../protocol/api.ts';
import type { Loaded } from './api.ts';
import { clock, since, span } from './format.ts';

/** How often a run's page reads a run that waits or runs, as the desk's run log does. */
export const runRefreshMs = 5_000;

/** The longest wait between two reads of a run after reads failed. */
export const runRetryMaxMs = 30_000;

/** A run that waits or runs, so its page reads it again until it ends. */
export function runActive(run: Run): boolean {
  return run.status === 'queued' || run.status === 'running';
}

/** How long to wait after `failures` reads in a row failed: 5 s, then twice as long each time, at most 30 s. */
export function retryAfter(failures: number): number {
  return Math.min(runRefreshMs * 2 ** Math.max(0, failures - 1), runRetryMaxMs);
}

/**
 * Read a run now, and again while it waits or runs, until `signal` aborts.
 * After a read that failed, the next read waits longer each time, so a
 * failure does not stop the reads. `show` gets each answer.
 */
export function followRun(
  read: (signal: AbortSignal) => Promise<Loaded<RunDetail>>,
  show: (loaded: Loaded<RunDetail>) => void,
  signal: AbortSignal,
): void {
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  const next = async (): Promise<void> => {
    const loaded = await read(signal);
    if (signal.aborted) return;
    show(loaded);
    failures = 'error' in loaded ? failures + 1 : 0;
    if (failures || ('value' in loaded && runActive(loaded.value.run)))
      timer = setTimeout(
        () => void next(),
        failures ? retryAfter(failures) : runRefreshMs,
      );
  };
  void next();
}

/** How a run stands, in a few words: "Running for 6 min", "Done in 19 min", "Ended with exit 1". */
export function runState(run: Run, now: number): string {
  const took =
    run.startedAt && run.endedAt
      ? span(Date.parse(run.endedAt) - Date.parse(run.startedAt))
      : null;
  switch (run.status) {
    case 'queued':
      return `Waits to start · ${since(run.queuedAt, now)}`;
    case 'running':
      return run.startedAt
        ? `Running for ${since(run.startedAt, now)}`
        : 'Running';
    case 'done':
      if (run.exitCode !== null && run.exitCode !== 0)
        return `Ended with exit ${run.exitCode}${took ? ` after ${took}` : ''}`;
      return took ? `Done in ${took}` : 'Done';
    case 'failed':
      return `Failed${run.exitCode === null ? '' : ` with exit ${run.exitCode}`}${took ? ` after ${took}` : ''}`;
    case 'timed-out':
      return `Stopped at its time limit${took ? ` after ${took}` : ''}`;
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Stopped when Verifold stopped';
  }
}

/** When a run started and ended: "Started 21:03, ended 21:22." or "Queued 21:03." */
export function runTimes(run: Run): string {
  const start = run.startedAt
    ? `Started ${clock(run.startedAt)}`
    : `Queued ${clock(run.queuedAt)}`;
  return `${start}${run.endedAt ? `, ended ${clock(run.endedAt)}` : ''}.`;
}

/** Where a run ran: this computer, or a pod with its GPU. */
export function runWhere(run: Run): string {
  return run.where === 'local'
    ? 'This computer'
    : `Pod ${run.where.pod} (${run.where.gpu})`;
}

/** A file size: "820 B", "14 KB", "3.2 MB". */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
