/**
 * A thread's story for the person: pure rules over records, with no lab. A
 * story is a set of plain lines, so it goes through what a brief's line goes
 * through: cited posts, the number test, a line check, and the quote when a
 * line fails. It stays in the brief's record, which no agent can read. A
 * thread gets its story when it reaches an outcome, and when the person opens
 * one that has none, or that its story does not cover. A story records what
 * its session's prompt held, so a post that came later or moved in stays
 * outside it and shows.
 */
import type { Post, PostKind } from '../board.ts';
import { briefLimits } from '../lab-tools.ts';
import type { Thread, ThreadStory } from './schema.ts';

/** What one session tells of one thread, read when the session starts. */
export interface StoryJob {
  readonly thread: string;
  /** The post with the outcome in the prompt. Null: the thread has none. */
  readonly outcome: string | null;
  /** The posts that the prompt holds: the thread's newest, oldest first. */
  readonly posts: readonly string[];
}

/** The newest posts of each thread, as a prompt can hold them, oldest first. */
function newestByThread(
  posts: readonly Pick<Post, 'id' | 'thread'>[],
): ReadonlyMap<string, readonly string[]> {
  const own = new Map<string, string[]>();
  for (const post of posts)
    if (post.thread) {
      const ids = own.get(post.thread) ?? [];
      ids.push(post.id);
      own.set(post.thread, ids);
    }
  for (const [thread, ids] of own)
    own.set(thread, ids.slice(-briefLimits.storyPosts));
  return own;
}

/**
 * The threads that need a story now. Those that the person opened come first,
 * then the oldest. `asked`: threads that the person opened. A thread with no
 * post has nothing to tell.
 */
export function storiesDue(
  threads: readonly Thread[],
  posts: readonly Pick<Post, 'id' | 'thread'>[],
  stories: readonly ThreadStory[],
  asked: ReadonlySet<string>,
): readonly Thread[] {
  const own = newestByThread(posts);
  const told = new Map(stories.map((story) => [story.thread, story]));
  const due = threads.filter((thread) => {
    const ids = own.get(thread.id);
    if (!ids) return false;
    const story = told.get(thread.id);
    const outcome = thread.outcome?.post ?? null;
    if (asked.has(thread.id)) {
      const covered = new Set(story?.posts);
      if (
        !story ||
        story.outcome !== outcome ||
        ids.some((id) => !covered.has(id))
      )
        return true;
    }
    return outcome !== null && story?.outcome !== outcome;
  });
  return [
    ...due.filter((thread) => asked.has(thread.id)),
    ...due.filter((thread) => !asked.has(thread.id)),
  ];
}

/** What a session tells of a thread: its outcome and its newest posts now. */
export function storyJob(
  thread: Pick<Thread, 'id' | 'outcome'>,
  posts: readonly Pick<Post, 'id' | 'thread'>[],
): StoryJob {
  return {
    thread: thread.id,
    outcome: thread.outcome?.post ?? null,
    posts: newestByThread(posts).get(thread.id) ?? [],
  };
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
