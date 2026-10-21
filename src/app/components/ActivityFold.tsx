import type { ReactNode } from 'react';
import { Chevron } from './Icons.tsx';

/**
 * A turn folded into one line, as the Claude Code and Codex apps fold their
 * work: "Worked 24 min · 9 commands · 1 run". The fold is closed by default,
 * and opens to the turn's steps.
 */
export function ActivityFold({
  summary,
  open,
  controls,
  onToggle,
}: {
  readonly summary: string;
  readonly open: boolean;
  /** The ID of the step list that the fold shows. */
  readonly controls: string;
  readonly onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="fold"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Chevron to={open ? 'down' : 'right'} size={14} />
      {summary}
    </button>
  );
}
