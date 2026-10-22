import type { ReactNode } from 'react';
import { Check } from './Icons.tsx';

/**
 * One line about the lab as a whole. `ok`: nothing needs the person.
 * `plan`: the lab is planning or working. `muted`: paused or reconnecting.
 * `need`: the lab waits for the person to act.
 */
export function StatusBar({
  tone,
  children,
}: {
  readonly tone: 'ok' | 'plan' | 'muted' | 'need';
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
