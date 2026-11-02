/**
 * Threads and post marks on the wire. These shape records for a snapshot or a
 * thread page, and hold no state.
 */
import type { openDisputes } from '../core/disputes.ts';
import {
  clip,
  type Post as BoardPost,
  type PostSearch,
} from '../core/board.ts';
import { checkBlock, citedDispute } from '../core/lab/post-rules.ts';
import { openWaits } from '../core/lab/waits.ts';
import { runActive, type RunRecord } from '../core/runs.ts';
import type { LabView, Thread as LabThread } from '../core/lab/schema.ts';
import type {
  Agent,
  Post,
  PostSearch as WireSearch,
  Recount,
  TakingPart,
  Thread,
  Wait,
} from '../protocol/api.ts';

/** The marks of a post on the wire. */
export type PostMarks = (
  post: BoardPost,
) => Pick<Post, 'disputed' | 'citesDisputed' | 'recountedBy' | 'noCheck'>;

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

/** The time of each author's newest post. Posts come oldest first. */
export function lastPostTimes(
  posts: readonly BoardPost[],
): ReadonlyMap<string, string> {
  return new Map(posts.map((post) => [post.author, post.at]));
}

/** Each agent's runs in one fact, from the whole ledger. A snapshot's `runs` keeps the newest only, so a long run can fall out of it. */
export function agentRunStates(
  ledger: readonly RunRecord[],
): ReadonlyMap<string, NonNullable<Agent['runState']>> {
  const states = new Map<string, NonNullable<Agent['runState']>>();
  for (const run of ledger) {
    const known = states.get(run.agent);
    const newer =
      run.endedAt !== null &&
      (!known?.ended || Date.parse(run.endedAt) >= Date.parse(known.ended.at));
    states.set(run.agent, {
      active: known?.active === true || runActive(run),
      ended:
        newer && run.endedAt
          ? { run: run.id, at: run.endedAt }
          : (known?.ended ?? null),
    });
  }
  return states;
}

/** A post's lookups on the wire. */
export function searchItem(search: PostSearch): WireSearch {
  return {
    lookups: search.lookups,
    at: search.at,
    helper: search.helper ?? null,
  };
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
    ...(entry.overturned ? { overturned: entry.overturned } : {}),
  };
}

/** Who wrote in a thread, over all of its posts, oldest first. */
export function takingPart(
  posts: readonly BoardPost[],
  handles: Readonly<Record<string, string>>,
): TakingPart {
  return {
    handles: [
      ...new Set(posts.flatMap((post) => handles[post.author] ?? [])),
    ].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    byPerson: posts[0]?.author === 'person',
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
  const runs = new Map(view.ledger.map((run) => [run.id, run]));
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
    const noCheck = view.handles[post.author]
      ? checkBlock(post, (id) => runs.get(id), view.checks)
      : null;
    return {
      ...(disputed.has(post.id) ? { disputed: true } : {}),
      ...(cites ? { citesDisputed: cites } : {}),
      ...(by ? { recountedBy: by } : {}),
      ...(noCheck ? { noCheck } : {}),
    };
  };
}
