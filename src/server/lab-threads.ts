/**
 * Threads and post marks on the wire. These shape records for a snapshot or a
 * thread page, and hold no state.
 */
import type { openDisputes } from '../core/disputes.ts';
import { clip, type Post as BoardPost } from '../core/board.ts';
import { citedDispute } from '../core/lab/post-rules.ts';
import { openWaits } from '../core/lab/waits.ts';
import type { LabView, Thread as LabThread } from '../core/lab/schema.ts';
import type { Post, Recount, Thread, Wait } from '../protocol/api.ts';

/** The marks of a post on the wire. */
export type PostMarks = (
  post: BoardPost,
) => Pick<Post, 'disputed' | 'citesDisputed' | 'recountedBy'>;

export const noMarks: PostMarks = () => ({});

/** How many posts each thread has, and the time of its newest post. Posts come oldest first. */
export type ThreadActivity = ReadonlyMap<
  string,
  { readonly posts: number; readonly lastAt: string }
>;

export function threadActivity(posts: readonly BoardPost[]): ThreadActivity {
  const activity = new Map<string, { posts: number; lastAt: string }>();
  for (const post of posts)
    if (post.thread)
      activity.set(post.thread, {
        posts: (activity.get(post.thread)?.posts ?? 0) + 1,
        lastAt: post.at,
      });
  return activity;
}

/** A thread as the wire has it. */
export function threadItem(entry: LabThread, activity: ThreadActivity): Thread {
  const own = activity.get(entry.id);
  return {
    id: entry.id,
    title: entry.title,
    ...(entry.plainTitle ? { plainTitle: entry.plainTitle } : {}),
    state: entry.state,
    why: entry.why,
    direction: entry.direction ?? null,
    openedBy: entry.openedBy,
    at: entry.at,
    outcome: entry.outcome ?? null,
    followers: [...entry.followers],
    agreed: entry.agreed.map(({ post, by, at }) => ({ post, by, at })),
    posts: own?.posts ?? 0,
    lastAt: own?.lastAt ?? null,
  };
}

/** Characters of a wait's subject and text. */
const waitText = 160;

/**
 * The waits of a lab on the wire, waits on the person first, so a smaller
 * snapshot keeps them. A lab from before threads has none.
 */
export function waitItems(view: LabView): Wait[] {
  const threads = view.threads ?? [];
  if (!threads.length) return [];
  const titles = new Map(threads.map((entry) => [entry.id, entry.title]));
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  const items = openWaits(view.posts, threads).map((wait): Wait => {
    const text = clip(posts.get(wait.post)?.text ?? '', waitText);
    return {
      ...wait,
      waiterHandle: view.handles[wait.waiter] ?? null,
      onHandle: view.handles[wait.on] ?? null,
      subject: titles.get(wait.thread ?? '') ?? text,
      text,
    };
  });
  return [
    ...items.filter((wait) => wait.on === 'person'),
    ...items.filter((wait) => wait.on !== 'person'),
  ];
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
  const recounts = new Map<string, Recount[]>();
  for (const post of view.posts)
    if (post.kind === 'check' && post.replyTo && post.outcome)
      recounts.set(post.replyTo, [
        ...(recounts.get(post.replyTo) ?? []),
        {
          handle: view.handles[post.author] ?? post.author,
          outcome: post.outcome,
        },
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
