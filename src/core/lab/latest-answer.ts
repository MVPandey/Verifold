import type { Call } from './schema.ts';

/**
 * The latest time to answer a call so that its longest option can still end by
 * `deadline`, as an ISO time. Null: no deadline, or no option gives minutes.
 * An option that adds hours moves the deadline, so it does not count. This
 * knows nothing of a GPU queue, so a screen must say "about".
 */
export function latestAnswer(
  call: Pick<Call, 'options'>,
  deadline: string | null,
): string | null {
  if (!deadline) return null;
  const minutes = Math.max(
    0,
    ...call.options.map((option) =>
      option.effect?.type === 'hours' ? 0 : (option.minutes ?? 0),
    ),
  );
  return minutes
    ? new Date(Date.parse(deadline) - minutes * 60_000).toISOString()
    : null;
}
