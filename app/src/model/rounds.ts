import type { PostRequest, PostView, RoundEnd, RoundView } from '../api/types.ts';
import { clock, duration } from './format.ts';
import { split, titleOf } from './posts.ts';

/** The minutes that a round stays open: at least and at most, as the server's `MAX_ROUND_MINUTES`, and the first choice. */
export const ROUND_MINUTES = { least: 1, most: 15, first: 10 } as const;

/**
 * Return the post that opens a round with the person's question, in a thread of its own, or `null` for an empty
 * question or minutes that a round does not take. The first line is the question, and the rest is its detail.
 */
export function roundRequest(text: string, minutes: number): PostRequest | null {
  const { headline, body } = split(text);
  const fits =
    Number.isInteger(minutes) && minutes >= ROUND_MINUTES.least && minutes <= ROUND_MINUTES.most;
  if (!headline || !fits) return null;
  return {
    kind: 'round',
    text: headline,
    ...(body ? { body } : {}),
    minutes,
    new_thread: titleOf(headline),
  };
}

const ENDS = {
  time: 'its time came',
  entered: 'every agent that was asked entered',
  opener: 'its opener closed it',
} as const satisfies Record<RoundEnd, string>;

/**
 * Return when a round closes, or when and why it closed, such as "Closes at 14:10, in 7 min" or "Closed at 14:10:
 * every agent that was asked entered". A round that closed because its time came closed at that time, also when
 * Verifold recorded the close later, as after a restart.
 */
export function roundTime(view: RoundView, now: Date): string {
  if (view.open) {
    const left = Math.max(
      1,
      Math.ceil((new Date(view.closes_at).getTime() - now.getTime()) / 60_000),
    );
    return `Closes at ${clock(view.closes_at)}, in ${duration(left)}`;
  }
  const why = view.closed?.why ?? 'time';
  const at = why === 'time' ? view.closes_at : (view.closed?.at ?? view.closes_at);
  return `Closed at ${clock(at)}: ${ENDS[why]}`;
}

/** Return how many agents entered among the ones that entered and the ones that the round waits for, as "2 of 5 entered". */
export function enteredLine(view: RoundView): string {
  const count = view.entries.length;
  return `${count} of ${count + view.not_entered.length} entered`;
}

/** One row of a round's table: an agent, and its entry, or `null` for an agent that did not enter. */
export interface RoundRow {
  readonly agent: string;
  readonly entry: PostView | null;
}

/** Return the rows of a round's table: each entry in the order that it came, then each agent that did not enter. */
export function roundRows(view: RoundView): readonly RoundRow[] {
  return [
    ...view.entries.map((entry) => ({ agent: entry.post.author, entry })),
    ...view.not_entered.map((agent) => ({ agent, entry: null })),
  ];
}
