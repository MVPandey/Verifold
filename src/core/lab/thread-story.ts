/**
 * A thread's story for the person: pure rules over records, with no lab. A
 * story is a set of plain lines, so it goes through what a brief's line goes
 * through: cited posts, the number test, a line check, and the quote when a
 * line fails. It stays in the brief's record, which no agent can read. A
 * thread gets its story when it reaches an outcome, and when the person opens
 * one that has none or that newer posts passed.
 */
import { number, type Post, type PostKind } from '../board.ts';
import type { Thread, ThreadStory } from './schema.ts';

/** The threads that need a story now, oldest first. `asked`: threads that the person opened. A thread with no post has nothing to tell. */
export function storiesDue(
  threads: readonly Thread[],
  posts: readonly Pick<Post, 'id' | 'thread'>[],
  stories: readonly ThreadStory[],
  asked: ReadonlySet<string>,
): readonly Thread[] {
  const newest = new Map<string, number>();
  for (const post of posts)
    if (post.thread) newest.set(post.thread, number(post.id));
  const told = new Map(stories.map((story) => [story.thread, story]));
  return threads.filter((thread) => {
    const last = newest.get(thread.id);
    if (last === undefined) return false;
    const story = told.get(thread.id);
    if (asked.has(thread.id) && (!story || story.through < last)) return true;
    return (
      thread.outcome !== undefined && story?.outcome !== thread.outcome.post
    );
  });
}

/** The kinds of a post that can change an outcome. */
const changing: ReadonlySet<PostKind> = new Set([
  'objection',
  'check',
  'rerun',
  'result',
  'ruled-out',
  'answer',
]);

/** The posts that the record ties to a thread's outcome after it: those that reply to the post of the outcome, or name it. Oldest first. */
export function laterPosts(
  thread: Pick<Thread, 'outcome'>,
  posts: readonly Post[],
  limit: number,
): readonly Post[] {
  const { outcome } = thread;
  if (!outcome) return [];
  const named = new RegExp(`\\b${outcome.post}\\b`);
  return posts
    .filter(
      (post) =>
        changing.has(post.kind) &&
        post.id !== outcome.post &&
        Date.parse(post.at) > Date.parse(outcome.at) &&
        (post.replyTo === outcome.post || named.test(post.text)),
    )
    .slice(-limit);
}
