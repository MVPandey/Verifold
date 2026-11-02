import type { ReactNode } from 'react';

/** Shows a plain line's cited posts in place, and goes back to the plain words. */
export function PlainToggle({
  original,
  onToggle,
}: {
  readonly original: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="see"
      aria-expanded={original}
      onClick={onToggle}
    >
      {original ? 'Plain words' : 'Original posts'}
    </button>
  );
}
