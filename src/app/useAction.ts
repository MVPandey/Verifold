import { useRef, useState } from 'react';
import type { ActOutcome } from './api.ts';
import { intentFor, unansweredAfter, type Intent } from './intent.ts';

/**
 * Run a lab action for the person: one key per intent, the same key again
 * when a retry follows a lost answer, and Verifold's reason when it said no.
 * `submit` resolves to true when the action ran.
 */
export function useAction<T>(
  run: (value: T, key: string) => Promise<ActOutcome>,
): {
  readonly busy: boolean;
  readonly error: string | null;
  readonly submit: (value: T) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unanswered = useRef<Intent<T> | null>(null);
  const submit = async (value: T): Promise<boolean> => {
    const intent = intentFor(unanswered.current, value);
    setBusy(true);
    const outcome = await run(intent.value, intent.key);
    setBusy(false);
    unanswered.current = unansweredAfter(intent, outcome);
    setError(
      'ok' in outcome
        ? null
        : 'lost' in outcome
          ? outcome.lost
          : outcome.refused,
    );
    return 'ok' in outcome;
  };
  return { busy, error, submit };
}
