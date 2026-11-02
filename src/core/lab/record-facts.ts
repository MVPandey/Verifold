/**
 * What a line check and a number test read of the lab's own record. A plain
 * line can say who waits, what has no answer, or what has no verdict yet. No
 * post says that, so Verifold states it here from its records: pure functions,
 * with no lab. No model writes these lines, and they hold no text of a post.
 */
import type { Post } from '../board.ts';
import { briefLimits } from '../lab-tools.ts';
import { strayNumbers } from './brief.ts';
import { openObjections } from './post-rules.ts';
import type { Check, Direction, Thread } from './schema.ts';
import type { Wait } from './waits.ts';
import { stateWord, verdictWord } from './words.ts';

/** The records that the facts come from. */
export interface FactRecords {
  readonly posts: readonly Post[];
  readonly directions: readonly Pick<
    Direction,
    'id' | 'agent' | 'state' | 'verdict'
  >[];
  readonly threads: readonly Pick<Thread, 'id' | 'state'>[];
  /** Every open wait, of agents that ended too. */
  readonly waits: readonly Wait[];
  readonly checks: readonly Pick<
    Check,
    'claim' | 'result' | 'state' | 'outcome' | 'method' | 'blind' | 'objections'
  >[];
  readonly name: (author: string) => string;
}

/** The lines of the facts. `cut`: the list did not fit, so what it leaves out proves nothing. */
export interface RecordFacts {
  readonly lines: readonly string[];
  readonly cut: boolean;
}

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

/** How a check of Verifold stands, with how it ran and whether it was blind. */
function checkFact(check: FactRecords['checks'][number]): string {
  const end =
    check.state === 'done'
      ? `ended: ${check.outcome ?? 'no outcome'}`
      : check.state === 'failed'
        ? 'stopped with no outcome'
        : 'waits or runs';
  return `- Verifold's check of ${check.claim}: ${check.method ?? 'no method yet'}, ${check.blind ? 'blind' : 'not blind'}, ${end}.`;
}

/** The asks, objections, and check posts of the cited posts, open or closed. */
function postFacts(
  ids: ReadonlySet<string>,
  records: FactRecords,
): readonly string[] {
  const { posts, waits, checks, name } = records;
  const standing = new Set(
    [...openObjections(posts, checks).values()].flat().map((post) => post.id),
  );
  const aimed = (post: Post): boolean =>
    ids.has(post.id) || (post.replyTo !== undefined && ids.has(post.replyTo));
  const target = (post: Post): string =>
    post.replyTo ? ` on ${post.replyTo}` : '';
  return posts.filter(aimed).flatMap((post) => {
    const by = `${post.id} of ${name(post.author)}${target(post)}`;
    switch (post.kind) {
      case 'ask':
        return [
          `- Ask ${by}: ${waits.some((wait) => wait.post === post.id) ? 'no answer ended it yet' : 'it ended'}.`,
        ];
      case 'objection':
        return [
          `- Objection ${by}: ${standing.has(post.id) ? 'it stands' : 'it ended'}.`,
        ];
      case 'check':
        return [
          `- An agent's own check post ${by}: ${post.method ?? 'no method given'}, not blind, ${post.outcome ?? 'no outcome'}.`,
        ];
      default:
        return [];
    }
  });
}

/**
 * The facts of the record: the cited posts first, then the lab. Each ask,
 * objection, and check of a cited post, open or closed, its thread, and each
 * direction with its state, verdict, and posts. `cited`: the posts of the
 * lines. Bounded by `briefLimits.recordFacts`.
 */
export function recordFacts(
  cited: readonly Pick<Post, 'id' | 'thread'>[],
  records: FactRecords,
): RecordFacts {
  const { posts, directions, threads, checks, name } = records;
  const ids = new Set(cited.map((post) => post.id));
  const citedThreads = new Set(cited.map((post) => post.thread));
  const open = directions.filter(({ state }) => state === 'open').length;
  const lines = [
    ...postFacts(ids, records),
    ...checks
      .filter(
        (check) =>
          check.state !== 'dropped' &&
          (ids.has(check.claim) ||
            (check.result !== null && ids.has(check.result))),
      )
      .map(checkFact),
    ...threads
      .filter((thread) => citedThreads.has(thread.id))
      .map((thread) => `- ${thread.id}: ${thread.state}.`),
    `- The lab has ${directions.length} directions: ${open} open, ${directions.length - open} ended.`,
    ...directions.map(
      (direction) =>
        `- ${name(direction.agent)} on ${direction.id}: ${stateWord(direction)}, ${verdictWord(direction)}. Its posts: ${postCounts(direction.agent, posts)}.`,
    ),
  ];
  return {
    lines: lines.slice(0, briefLimits.recordFacts),
    cut: lines.length > briefLimits.recordFacts,
  };
}

/**
 * The numbers of a line that neither its posts nor its record facts hold. The
 * facts read the whole board, so `records` comes only for a number that the
 * posts do not hold.
 */
export function strayInRecord(
  plain: string,
  cited: readonly Pick<Post, 'id' | 'thread' | 'text' | 'at'>[],
  records: () => FactRecords,
): readonly string[] {
  const stray = strayNumbers(plain, cited);
  return stray.length
    ? strayNumbers(plain, cited, recordFacts(cited, records()).lines)
    : stray;
}
