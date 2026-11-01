/**
 * A digest in a lab with threads: the threads that the agent follows, what is
 * addressed to it, and one line for each new thread. `verifold_board` still
 * reads anything. Nothing here holds state.
 */
import {
  number,
  type Board,
  type BoardAgent,
  type Digest,
  type DigestOptions,
  type Post,
  type ReadState,
} from '../board.ts';
import { threadLimits } from '../lab-tools.ts';
import type { Thread } from './schema.ts';
import { follows } from './threads.ts';

/** Characters that the lines on threads take from a digest's budget, at most. */
const threadRoom = 20_000;

/** One thread in one line. Agents wrote its texts, so they are quoted. */
export function threadLine(thread: Thread): string {
  return `- ${thread.id} [${thread.state}] ${JSON.stringify(thread.title)}${thread.outcome ? ` Outcome from ${thread.outcome.post}: ${JSON.stringify(thread.outcome.text)}` : ''}`;
}

/** Whether a post speaks to the agent: a mention, the person's `@all`, or a reply to its post. */
function addressed(post: Post, agent: string, get: Board['get']): boolean {
  return (
    post.mentions.includes(agent) ||
    post.mentions.includes('all') ||
    (post.replyTo !== undefined && get(post.replyTo)?.author === agent)
  );
}

/** One line for each new thread that the agent does not follow, within `threadLimits.index`. */
function newThreadLines(
  threads: readonly Thread[],
  agent: BoardAgent,
  read: ReadState,
  name: (author: string) => string,
): readonly string[] {
  const fresh = threads.filter(
    (thread) =>
      thread.opening &&
      number(thread.opening) > read.readThrough &&
      thread.openedBy !== agent.id &&
      !follows(thread, agent.id),
  );
  const shown = fresh.slice(-threadLimits.index);
  return [
    ...shown.map(
      (thread) =>
        `- [new thread] ${thread.id} ${JSON.stringify(thread.title)} from ${name(thread.openedBy)}: ${JSON.stringify(thread.why)}`,
    ),
    ...(fresh.length > shown.length
      ? [
          `- ${fresh.length - shown.length} more new threads. verifold_board with view threads lists them.`,
        ]
      : []),
  ];
}

/**
 * An agent's digest. Posts in threads that it follows, posts addressed to it,
 * posts about its direction, and posts with no thread or direction come, the
 * addressed ones first. Other posts count as read: `verifold_board` reads
 * them. The lines on threads come first, and they use `threadRoom` of the
 * budget.
 */
export function threadDigest(
  board: Pick<Board, 'digest' | 'get'>,
  threads: readonly Thread[],
  agent: BoardAgent,
  read: ReadState,
  options: DigestOptions = {},
): Digest {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const get = (id: string): Post | undefined => board.get(id);
  const forYou = (post: Post): boolean => addressed(post, agent.id, get);
  const digest = board.digest(agent, read, {
    ...options,
    ...(options.budget === undefined
      ? {}
      : { budget: options.budget - threadRoom }),
    forYou,
    shows: (post) => {
      const thread = post.thread ? byId.get(post.thread) : undefined;
      return (
        forYou(post) ||
        (thread !== undefined && follows(thread, agent.id)) ||
        post.direction === agent.direction ||
        (!post.thread && !post.direction)
      );
    },
  });
  const inDigest = new Set(digest.shown.flatMap((post) => post.thread ?? []));
  return {
    ...digest,
    lines: [
      ...threads.filter((thread) => inDigest.has(thread.id)).map(threadLine),
      ...digest.lines,
      ...newThreadLines(
        threads,
        agent,
        read,
        options.name ?? ((author) => author),
      ),
    ],
  };
}
