import type { ReactNode } from 'react';
import { useView, type ViewMode } from '../view-mode.ts';

const modes: readonly { mode: ViewMode; label: string }[] = [
  { mode: 'simple', label: 'Simple' },
  { mode: 'technical', label: 'Technical' },
];

/** The one switch of how a lab with threads reads. It changes every lab page. */
export function ViewSwitch(): ReactNode {
  const { mode, setMode } = useView();
  return (
    <div className="switch" role="group" aria-label="How the lab reads">
      {modes.map((entry) => (
        <button
          key={entry.mode}
          type="button"
          aria-pressed={mode === entry.mode}
          onClick={() => setMode(entry.mode)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
