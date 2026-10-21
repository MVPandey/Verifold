import { useState, type ReactNode } from 'react';
import type { Turn } from '../../protocol/api.ts';
import { worked } from '../format.ts';
import { ChevronOpen, ChevronRight } from './Icons.tsx';

/**
 * One turn of an agent, folded to a line such as "Worked 6 min · 4 searches
 * · 3 pages". It opens to `children`, the turn's steps. Closed by default.
 */
export function ActivityFold({
  turn,
  now,
  children,
  defaultOpen = false,
}: {
  readonly turn: Turn;
  readonly now: number;
  readonly children?: ReactNode;
  readonly defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button
        type="button"
        className="fold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronOpen /> : <ChevronRight />}
        {worked(turn.counts, turn.startedAt, turn.endedAt, now)}
      </button>
      {open && children}
    </>
  );
}
