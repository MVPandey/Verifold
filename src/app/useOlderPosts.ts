import { useEffect, useRef, useState } from 'react';
import type { BoardPage, Post } from '../protocol/api.ts';
import type { Loaded } from './api.ts';
import { byNumber, filledPosts, joinPosts, type OlderPosts } from './board.ts';

/** Pages of older posts that a gap fill reads at most, before it gives the older posts up. */
const gapPages = 10;

/** The posts of a list that pages back, with a way to read older ones. */
export interface OlderList {
  /** Every post to show, oldest first. */
  readonly posts: readonly Post[];
  readonly more: boolean;
  /** The posts between the older pages and the newest page are being read. */
  readonly gap: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly show: () => Promise<void>;
}

/**
 * A list of posts: older pages read on request, then the newest page. When
 * new posts push the older pages' anchor out of the newest page, the posts
 * between are read before anything older shows again, so no post is ever
 * missing from the list, as with an agent's turns. `read` gives the page
 * before a post. It stays the same function while the list is the same list.
 * Null: nothing reads, as on a page without controls.
 */
export function useOlderPosts(
  newest: BoardPage,
  read:
    | ((before: string, signal?: AbortSignal) => Promise<Loaded<BoardPage>>)
    | null,
): OlderList {
  const [older, setOlder] = useState<OlderPosts | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, so two clicks in one frame read once.
  const loading = useRef(false);
  // A gap fill makes reads that started before it stale.
  const epoch = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const { posts, gap } = joinPosts(older, newest.posts);
  const anchor = older?.anchor ?? null;
  useEffect(() => {
    if (!read || !gap || !older) return;
    const controller = new AbortController();
    const mine = ++epoch.current;
    void (async () => {
      const pages: (readonly Post[])[] = [];
      let before = gap;
      for (let page = 0; page < gapPages; page++) {
        const loaded = await read(before, controller.signal);
        if (controller.signal.aborted || mine !== epoch.current) return;
        if ('error' in loaded) {
          // The list stays whole: the newest page alone, and "Show older posts" again.
          setOlder(null);
          setProblem(loaded.error);
          return;
        }
        pages.push(loaded.value.posts);
        const first = loaded.value.posts[0];
        if (
          !first ||
          !loaded.value.more ||
          loaded.value.posts.some((post) => post.id === older.anchor)
        )
          break;
        before = first.id;
      }
      setOlder(filledPosts(older, pages, gap));
    })();
    return () => controller.abort();
    // The fill depends on the gap and the anchor, not on each new `older`.
  }, [gap, anchor, read]);
  return {
    posts,
    more: read !== null && !gap && (older ? older.more : newest.more),
    gap: gap !== null,
    busy,
    problem,
    show: async () => {
      const first = posts[0];
      if (!read || !first || loading.current) return;
      loading.current = true;
      setBusy(true);
      const controller = new AbortController();
      pending.current = controller;
      const mine = epoch.current;
      const loaded = await read(first.id, controller.signal);
      loading.current = false;
      setBusy(false);
      if (controller.signal.aborted || mine !== epoch.current) return;
      if ('error' in loaded) {
        setProblem(loaded.error);
        return;
      }
      setProblem(null);
      setOlder((current) => ({
        posts: byNumber([loaded.value.posts, current?.posts ?? []]),
        more: loaded.value.more,
        anchor: current?.anchor ?? first.id,
      }));
    },
  };
}
