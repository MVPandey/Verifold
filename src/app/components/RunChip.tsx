import type { ReactNode } from 'react';
import type { Run } from '../../protocol/api.ts';

/** A run as a chip: "Run r-3", or with how it ended when that is not a clean exit. */
export function runLabel(run: Run): string {
  if (run.status !== 'done') return `Run ${run.id} · ${run.status}`;
  if (run.exitCode === 0) return `Run ${run.id}`;
  return run.exitCode === null
    ? `Run ${run.id} · ended`
    : `Run ${run.id} · exit ${run.exitCode}`;
}

/**
 * A run that a post or a turn names. A run that the snapshot leaves out
 * shows by its ID. `target`: on a page that a link to a run opens, the run
 * that the link named, or null. The chip then carries the ID that the link
 * scrolls to, and the named run is marked.
 */
export function RunChip({
  id,
  runs,
  target,
}: {
  readonly id: string;
  readonly runs: ReadonlyMap<string, Run>;
  readonly target?: string | null;
}): ReactNode {
  const run = runs.get(id);
  return (
    <span
      {...(target === undefined ? {} : { id: `run-${id}`, tabIndex: -1 })}
      className={id === target ? 'proof proof--target' : 'proof'}
    >
      {run ? runLabel(run) : `Run ${id}`}
    </span>
  );
}
