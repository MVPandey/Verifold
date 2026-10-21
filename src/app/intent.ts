/**
 * One thing the person asked for, such as a post or a pause, with the key
 * that marks it. Verifold runs an action once per key within a minute, so a
 * retry with the same key cannot run it twice.
 */
export interface Intent<T> {
  readonly value: T;
  readonly key: string;
}

/** A random 32-character hex key for a new intent. */
export function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The intent for a submit. When the last attempt got no answer, as when the
 * network dropped, the same value keeps its key, so a lost response and a
 * retry run once. Any other value is a new intent with a new key. `same`
 * says when two values are the same, such as two lists with the same items.
 */
export function intentFor<T>(
  unanswered: Intent<T> | null,
  value: T,
  makeKey: () => string = newKey,
  same: (a: T, b: T) => boolean = Object.is,
): Intent<T> {
  return unanswered && same(unanswered.value, value)
    ? unanswered
    : { value, key: makeKey() };
}

/** The box after a send went through: empty, unless the person typed more meanwhile. */
export function afterSend(current: string, sent: string): string {
  return current === sent ? '' : current;
}

/** What to keep after an attempt: the intent when its answer was lost, so a retry reuses its key; nothing otherwise. */
export function unansweredAfter<T>(
  intent: Intent<T>,
  outcome: { readonly lost: string } | object,
): Intent<T> | null {
  return 'lost' in outcome ? intent : null;
}
