import { useRef, useState } from 'react';
import type { ActOutcome } from './api.ts';
import { intentFor, unansweredAfter, type Intent } from './intent.ts';

/** A lab action on a page: whether it runs now, why it did not run, and a way to run it. */
export interface Action<T> {
  readonly busy: boolean;
  readonly error: string | null;
  readonly submit: (value: T) => Promise<boolean>;
}

/**
 * Run a lab action for the person: one key per intent, the same key again
 * when a retry follows a lost answer, and Verifold's reason when it said no.
 * `submit` resolves to true when the action ran. `same` says when two values
 * are one intent; by default, when they are the same value.
 */
export function useAction<T>(
  run: (value: T, key: string) => Promise<ActOutcome>,
  same?: (a: T, b: T) => boolean,
): Action<T> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unanswered = useRef<Intent<T> | null>(null);
  const submit = async (value: T): Promise<boolean> => {
    const intent = intentFor(unanswered.current, value, undefined, same);
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
