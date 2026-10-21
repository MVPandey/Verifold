import type { Run } from '../protocol/api.ts';
import { clock, since, span } from './format.ts';

/** A run that waits or runs, so its page reads it again until it ends. */
export function runActive(run: Run): boolean {
  return run.status === 'queued' || run.status === 'running';
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
