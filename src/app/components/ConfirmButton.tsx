import { useEffect, useState, type ReactNode } from 'react';
import { useAction } from '../useAction.ts';
import type { ActOutcome } from '../api.ts';

/** How long the second click may wait before the button asks again. */
const confirmMs = 5_000;

/**
 * A button for an action that cannot be undone, such as stopping a
 * direction. The first click asks to click again, as the desk's buttons do.
 * The second click within a few seconds runs it. Verifold's reason shows
 * under the button when it says no. `onDone` runs after the action ran.
 */
export function ConfirmButton({
  label,
  confirm,
  run,
  onDone,
  className = 'button',
}: {
  readonly label: string;
  /** What the button says after the first click, such as "Click again to stop it". */
  readonly confirm: string;
  readonly run: (key: string) => Promise<ActOutcome>;
  readonly onDone?: () => void;
  readonly className?: string;
}): ReactNode {
  const [armed, setArmed] = useState(false);
  const action = useAction<null>((_, key) => run(key));
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), confirmMs);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={action.busy}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          void action.submit(null).then((ran) => {
            if (ran) onDone?.();
          });
        }}
      >
        {armed ? confirm : label}
      </button>
      {action.error && (
        <span role="alert" className="composer__error">
          {action.error}
        </span>
      )}
    </>
  );
}
