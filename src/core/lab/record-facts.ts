/**
 * What a line check reads of the lab's own record. A plain line can say who
 * waits, what has no answer, or what has no verdict yet. No post says that, so
 * Verifold states it here from its records: a pure function, with no lab. No
 * model writes these lines, and they hold no text of an agent.
 */
import type { Post } from '../board.ts';
import { briefLimits } from '../lab-tools.ts';
import type { Check, Direction, Thread } from './schema.ts';
import type { Wait } from './waits.ts';
import { stateWord, verdictWord } from './words.ts';

/** What an agent posted, by kind, such as "2 result, 1 plan". A status says what it does, not what it found. */
function postCounts(author: string, posts: readonly Post[]): string {
  const counts = new Map<string, number>();
  for (const post of posts)
    if (post.author === author && post.kind !== 'status')
      counts.set(post.kind, (counts.get(post.kind) ?? 0) + 1);
  return (
    [...counts].map(([kind, count]) => `${count} ${kind}`).join(', ') || 'none'
  );
}

const checkWords = (check: Pick<Check, 'state' | 'outcome'>): string =>
  check.state === 'done'
    ? `ended: ${check.outcome ?? 'no outcome'}`
    : check.state === 'failed'
      ? 'stopped with no outcome'
      : 'waits or runs';

/**
 * The facts of the record for a line check: each direction with its state,
 * verdict, and posts, then each open wait, thread, and check of the cited
 * posts. `cited`: the posts of the lines. A cited post with no wait and no
 * check here has none. Bounded by `briefLimits.recordFacts`.
 */
export function recordFacts(records: {
  readonly cited: readonly Pick<Post, 'id' | 'thread'>[];
  readonly posts: readonly Post[];
  readonly directions: readonly Pick<
    Direction,
    'id' | 'agent' | 'state' | 'verdict'
  >[];
  readonly threads: readonly Pick<Thread, 'id' | 'state'>[];
  readonly waits: readonly Wait[];
  readonly checks: readonly Pick<Check, 'claim' | 'state' | 'outcome'>[];
  readonly name: (author: string) => string;
}): readonly string[] {
  const { cited, posts, directions, threads, waits, checks, name } = records;
  const ids = new Set(cited.map((post) => post.id));
  const citedThreads = new Set(cited.map((post) => post.thread));
  return [
    ...directions.map(
      (direction) =>
        `- ${name(direction.agent)} on ${direction.id}: ${stateWord(direction)}, ${verdictWord(direction)}. Its posts: ${postCounts(direction.agent, posts)}.`,
    ),
    ...waits
      .filter((wait) => ids.has(wait.post))
      .map(
        (wait) =>
          `- ${wait.post} of ${name(wait.waiter)} waits on ${wait.on === 'person' ? 'the person' : name(wait.on)}. No answer ended this ${wait.reason} yet.`,
      ),
    ...threads
      .filter((thread) => citedThreads.has(thread.id))
      .map((thread) => `- ${thread.id}: ${thread.state}.`),
    ...checks
      .filter((check) => ids.has(check.claim) && check.state !== 'dropped')
      .map((check) => `- A check of ${check.claim} ${checkWords(check)}.`),
  ].slice(0, briefLimits.recordFacts);
}
