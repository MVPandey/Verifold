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
