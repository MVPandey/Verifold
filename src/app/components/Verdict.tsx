import type { ReactNode } from 'react';
import type { Direction } from '../../protocol/api.ts';
import { Check, Cross, Ring, Up, Warning } from './Icons.tsx';

type Shown =
  | 'holds'
  | 'disputed'
  | 'ruled-out'
  | 'leading'
  | 'open'
  | 'stopped';

/** The label of a direction. An objection that no check settled shows over the verdict. */
export function shownVerdict(direction: Direction): Shown {
  if (direction.verdict === 'ruled-out') return 'ruled-out';
  if (direction.disputed) return 'disputed';
  if (direction.verdict === 'holds-up') return 'holds';
  if (direction.verdict === 'leading') return 'leading';
  return direction.state === 'open' ? 'open' : 'stopped';
}

const labels: Record<Shown, string> = {
  holds: 'Holds up',
  disputed: 'Disputed',
  'ruled-out': 'Ruled out',
  leading: 'Leading',
  open: 'Not settled',
  stopped: 'Stopped',
};

const icons: Record<Shown, () => ReactNode> = {
  holds: () => <Check />,
  disputed: () => <Warning />,
  'ruled-out': () => <Cross />,
  leading: () => <Up />,
  open: () => <Ring />,
  stopped: () => <Ring />,
};

/** A direction's verdict as a label with its mark: "Holds up", "Disputed". */
export function Verdict({
  direction,
}: {
  readonly direction: Direction;
}): ReactNode {
  const shown = shownVerdict(direction);
  return (
    <span className={`verdict verdict--${shown}`}>
      {icons[shown]()}
      {labels[shown]}
    </span>
  );
}
