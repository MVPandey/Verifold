/**
 * Who waits on whom in a lab with threads, for what, and since when. It reads
 * posts and threads only, so nothing holds a wait as state: a wait ends when
 * the record shows its end.
 */
import type { Post } from '../board.ts';
import type { Thread } from './schema.ts';

export interface Wait {
  /** The author of the ask or the objection. */
  readonly waiter: string;
  /** An agent ID, or `person`. */
  readonly on: string;
  /** The post that waits for a reply. */
  readonly post: string;
  readonly reason: 'ask' | 'objection';
  readonly thread: string | null;
  readonly since: string;
}

/** The reply that ends a wait on `post`: an answer, the person's own reply to an ask that is no objection, or for an objection a rerun of its target or a check that holds it. */
function ends(reply: Post, post: Post): boolean {
  if (reply.kind === 'answer') return reply.replyTo === post.id;
  if (post.kind === 'ask')
    return (
      reply.author === 'person' &&
      reply.kind !== 'objection' &&
      reply.replyTo === post.id
    );
  return (
    post.replyTo === reply.replyTo &&
    (reply.kind === 'rerun' ||
      (reply.kind === 'check' && reply.outcome === 'holds'))
  );
}

/**
 * The waits now, oldest first. An ask waits on who it names. An objection
 * waits on the author of its target. A closed thread ends its waits. An
 * objection to a post of Verifold, or of its own author, waits on no one.
 */
export function openWaits(
  posts: readonly Post[],
  threads: readonly Thread[],
): readonly Wait[] {
  const closed = new Set(
    threads
      .filter((thread) => thread.state === 'closed')
      .map((thread) => thread.id),
  );
  const byId = new Map(posts.map((post) => [post.id, post]));
  return posts.flatMap((post, index) => {
    const target = post.replyTo ? byId.get(post.replyTo) : undefined;
    const on =
      post.kind === 'ask'
        ? post.mentions[0]
        : post.kind === 'objection' && target?.author !== post.author
          ? target?.author
          : undefined;
    if (
      (post.kind !== 'ask' && post.kind !== 'objection') ||
      !on ||
      on === 'verifold' ||
      (post.thread && closed.has(post.thread)) ||
      posts.slice(index + 1).some((reply) => ends(reply, post))
    )
      return [];
    return [
      {
        waiter: post.author,
        on,
        post: post.id,
        reason: post.kind,
        thread: post.thread ?? null,
        since: post.at,
      },
    ];
  });
}
