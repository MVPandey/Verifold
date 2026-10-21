import type { ReactNode } from 'react';
import { Check } from './Icons.tsx';

/**
 * One line about the lab as a whole. `ok`: nothing needs the person.
 * `plan`: the lab is planning or working. `muted`: paused or reconnecting.
 */
export function StatusBar({
  tone,
  children,
}: {
  readonly tone: 'ok' | 'plan' | 'muted';
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div role="status" className={`status status--${tone}`}>
      {tone === 'ok' ? (
        <Check size={18} />
      ) : (
        <span className="dot" aria-hidden="true" />
      )}
      <span>{children}</span>
    </div>
  );
}
