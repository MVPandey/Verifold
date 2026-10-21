import type { ReactNode } from 'react';
import type { Direction } from '../../protocol/api.ts';
import {
  shownVerdict,
  verdictLabels,
  type ShownVerdict,
} from '../../ui/lab-lines.ts';
import { Check, Cross, Ring, Up, Warning } from './Icons.tsx';

const icons: Record<ShownVerdict, () => ReactNode> = {
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
      {verdictLabels[shown]}
    </span>
  );
}
