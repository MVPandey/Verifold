/**
 * A digest in a lab with threads: the threads that the agent follows, what is
 * addressed to it, and one line for each new thread. `verifold_board` still
 * reads anything. Nothing here holds state.
 */
import {
  clip,
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

/** The first lines that fit in `room` characters, each with its newline. */
function fitted(lines: readonly string[], room: number): readonly string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > room) break;
    kept.push(line);
  }
  return kept;
}

/** One thread in one line. Agents wrote its texts, so they are quoted. */
export function threadLine(thread: Thread): string {
  return `- ${thread.id} [${thread.state}] ${JSON.stringify(thread.title)}${thread.outcome ? ` Outcome from ${thread.outcome.post}: ${JSON.stringify(thread.outcome.text)}` : ''}`;
}

/** One line for each thread, within the room that thread lines have. */
export function threadLines(threads: readonly Thread[]): readonly string[] {
  return fitted(threads.map(threadLine), threadRoom);
}

/** Whether a post speaks to the agent: a mention, the person's `@all`, or a reply to its post. */
function addressed(post: Post, agent: string, get: Board['get']): boolean {
  return (
    post.mentions.includes(agent) ||
    post.mentions.includes('all') ||
    (post.replyTo !== undefined && get(post.replyTo)?.author === agent)
  );
}

/** The newest `threadLimits.index` of `items` as lines, and how many more wait. */
function indexLines<T>(
  items: readonly T[],
  line: (item: T) => string,
  more: string,
): readonly string[] {
  const shown = items.slice(-threadLimits.index);
  const left = items.length - shown.length;
  return [...shown.map(line), ...(left ? [`- ${left} ${more}`] : [])];
}

/** One line for each new thread that the agent does not follow, within `threadLimits.index`. */
function newThreadLines(
  threads: readonly Thread[],
  agent: BoardAgent,
  read: ReadState,
  name: (author: string) => string,
): readonly string[] {
  return indexLines(
    threads.filter(
      (thread) =>
        thread.opening &&
        number(thread.opening) > read.readThrough &&
        thread.openedBy !== agent.id &&
        !follows(thread, agent.id),
    ),
    (thread) =>
      `- [new thread] ${thread.id} ${JSON.stringify(thread.title)} from ${name(thread.openedBy)}: ${JSON.stringify(thread.why)}`,
    'more new threads. verifold_board with view threads lists them.',
  );
}

/**
 * One line for each unread proposal of another agent, in every agent's digest,
 * so that an agent outside its thread can object before its window ends.
 */
function proposalLines(
  posts: readonly Post[],
  threads: ReadonlyMap<string, Thread>,
  agent: BoardAgent,
  read: ReadState,
  objectionMs: number,
  name: (author: string) => string,
): readonly string[] {
  return indexLines(
    posts.filter(
      (post) =>
        post.kind === 'proposal' &&
        post.author !== agent.id &&
        number(post.id) > read.readThrough,
    ),
    (post) => {
      const title = post.thread ? threads.get(post.thread)?.title : undefined;
      const end = new Date(Date.parse(post.at) + objectionMs).toISOString();
      return `- [${post.alien ? 'long shot' : 'proposal'}] ${post.id}${post.thread ? ` on ${post.thread}` : ''}${title ? ` ${JSON.stringify(title)}` : ''} from ${name(post.author)}: ${JSON.stringify(clip(post.text, threadLimits.proposalLine))} ${post.alien ? 'It stays open. Take it up if you work on long shots.' : `Its objection window ends at ${end}.`}`;
    },
    'more new proposals. verifold_board with view threads lists their threads.',
  );
}

/**
 * An agent's digest. Posts in threads that it follows, posts addressed to it,
 * posts about its direction, and posts with no thread or direction come, the
 * addressed ones first. Other posts count as read: `verifold_board` reads
 * them. The lines on threads and proposals come first, within `threadRoom`
 * characters, which the budget of the posts leaves free.
 */
export function threadDigest(
  board: Pick<Board, 'digest' | 'get' | 'list'>,
  threads: readonly Thread[],
  agent: BoardAgent,
  read: ReadState,
  objectionMs: number,
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
  const name = options.name ?? ((author) => author);
  return {
    ...digest,
    lines: [
      ...fitted(
        [
          ...newThreadLines(threads, agent, read, name),
          ...proposalLines(board.list(), byId, agent, read, objectionMs, name),
          ...threads
            .filter((thread) => inDigest.has(thread.id))
            .map(threadLine),
        ],
        threadRoom,
      ),
      ...digest.lines,
    ],
  };
}
