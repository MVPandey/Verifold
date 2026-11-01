/**
 * Threads and post marks on the wire. These shape records for a snapshot or a
 * thread page, and hold no state.
 */
import type { Post as BoardPost } from '../core/board.ts';
import type { openDisputes } from '../core/disputes.ts';
import { citedDispute } from '../core/lab/post-rules.ts';
import type { LabView, Thread as LabThread } from '../core/lab/schema.ts';
import type { Post, Thread } from '../protocol/api.ts';

/** The marks of a post on the wire. */
export type PostMarks = (
  post: BoardPost,
) => Pick<Post, 'disputed' | 'citesDisputed' | 'recountedBy'>;

export const noMarks: PostMarks = () => ({});

/** A thread as the wire has it. */
export function threadItem(entry: LabThread): Thread {
  return {
    id: entry.id,
    title: entry.title,
    state: entry.state,
    why: entry.why,
    direction: entry.direction ?? null,
    openedBy: entry.openedBy,
    at: entry.at,
    outcome: entry.outcome ?? null,
    followers: [...entry.followers],
    agreed: entry.agreed.map(({ post, by, at }) => ({ post, by, at })),
  };
}

/**
 * The marks of a lab's posts: disputed, cites a disputed post, and recounted
 * by. A lab from before threads shows as it did, with no marks.
 */
export function postMarks(
  view: LabView,
  disputes: ReturnType<typeof openDisputes>,
): PostMarks {
  if (!view.threads?.length) return noMarks;
  const disputed = new Set(disputes.map((dispute) => dispute.target.id));
  const recounts = new Map<string, string[]>();
  for (const post of view.posts)
    if (post.kind === 'check' && post.replyTo)
      recounts.set(post.replyTo, [
        ...(recounts.get(post.replyTo) ?? []),
        view.handles[post.author] ?? post.author,
      ]);
  return (post) => {
    const cites = citedDispute(post, disputed);
    const by = recounts.get(post.id);
    return {
      ...(disputed.has(post.id) ? { disputed: true } : {}),
      ...(cites ? { citesDisputed: cites } : {}),
      ...(by ? { recountedBy: by } : {}),
    };
  };
}
