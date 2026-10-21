import type { Lab, Post } from '../protocol/api.ts';
import { onBoard } from './call.ts';
import { href } from './route.ts';

export interface Thread {
  readonly root: Post;
  /** Every reply below the root, at any depth, oldest first. */
  readonly replies: readonly Post[];
}

/**
 * Where a link to a post on the lab home's board (`#/board/<id>`) leads:
 * the post, brought into view, and then the lab home's own address, so a
 * later change does not bring it back. A post that the board leaves out,
 * as after a smaller snapshot, opens on its own page instead.
 */
export function boardLink(
  lab: Lab,
  post: string,
): { readonly show: string | null; readonly route: string } {
  return onBoard(lab, post)
    ? { show: post, route: href.lab }
    : { show: null, route: href.post(post) };
}

/**
 * Group posts into threads, oldest first. A reply joins the thread of the
 * post it answers. A reply to a post outside the page starts its own thread.
 */
export function threads(posts: readonly Post[]): readonly Thread[] {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const rootOf = (post: Post): Post => {
    let current = post;
    const seen = new Set<string>();
    while (current.replyTo && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.replyTo);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const grouped = new Map<string, { root: Post; replies: Post[] }>();
  for (const post of posts) {
    const root = rootOf(post);
    const thread = grouped.get(root.id) ?? { root, replies: [] };
    if (post !== root) thread.replies.push(post);
    grouped.set(root.id, thread);
  }
  return [...grouped.values()];
}

/**
 * Posts read on request, older than the snapshot's page of the board. They
 * end right before the post `anchor`: the first post of the snapshot's page
 * when the first of them was read.
 */
export interface OlderPosts {
  readonly posts: readonly Post[];
  /** Posts older than these exist. */
  readonly more: boolean;
  readonly anchor: string;
}

/** The number of a post's ID: 12 for p-12. */
function postNumber(post: Post): number {
  return Number(post.id.slice(2));
}

/** Posts from several reads as one list, oldest first. A post read twice shows once, with its last copy. */
export function byNumber(lists: readonly (readonly Post[])[]): readonly Post[] {
  const byId = new Map<string, Post>();
  for (const list of lists) for (const post of list) byId.set(post.id, post);
  return [...byId.values()].sort((a, b) => postNumber(a) - postNumber(b));
}

/**
 * The older posts and the snapshot's newest page as one list, with no post
 * left out. New posts can push the anchor out of the snapshot's page. Then
 * the posts between the two are in neither list, and `gap` names the post
 * to read pages before until the anchor shows again. Until then, `posts` is
 * the newest page alone.
 */
export function joinPosts(
  older: OlderPosts | null,
  newest: readonly Post[],
): { readonly posts: readonly Post[]; readonly gap: string | null } {
  const first = newest[0];
  if (!older || !first) return { posts: newest, gap: null };
  return newest.some((post) => post.id === older.anchor)
    ? { posts: byNumber([older.posts, newest]), gap: null }
    : { posts: newest, gap: first.id };
}

/**
 * `older` with the pages that filled its gap, now ending before `anchor`.
 * Null when the pages never reached the old anchor: the older posts are
 * then out of reach, and the board shows the newest page alone.
 */
export function filledPosts(
  older: OlderPosts,
  pages: readonly (readonly Post[])[],
  anchor: string,
): OlderPosts | null {
  const reached = pages.some((page) =>
    page.some((post) => post.id === older.anchor),
  );
  return reached
    ? { posts: byNumber([older.posts, ...pages]), more: older.more, anchor }
    : null;
}
