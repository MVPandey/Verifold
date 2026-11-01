import type { Post } from './board.ts';
import { openObjections } from './lab/post-rules.ts';
import type { Check, LabView } from './lab/schema.ts';
import { checkLimits } from './lab-tools.ts';

/**
 * The objections that a check took and no check answered yet, by post, in a
 * lab from before threads. The objections of a failed check count while the
 * post can get one more check, which takes them. An objection that no check
 * took, because its post cites no run or had its checks, stays a reply in its
 * thread.
 */
function checkedObjections(
  view: LabView,
  checks: readonly Check[],
): ReadonlyMap<string, readonly Post[]> {
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  const answered = new Set(
    checks
      .filter((check) => check.state === 'done')
      .flatMap((check) => check.objections),
  );
  const open = new Map<string, Post[]>();
  for (const check of checks) {
    if (
      check.state === 'failed' &&
      checks.filter((entry) => entry.claim === check.claim).length >=
        checkLimits.perClaim
    )
      continue;
    for (const id of check.objections) {
      const objection = posts.get(id);
      if (!objection || answered.has(id)) continue;
      const list = open.get(check.claim) ?? [];
      if (!list.includes(objection))
        open.set(check.claim, [...list, objection]);
    }
  }
  return open;
}

/**
 * The open disputes: each post with its objections that stand, and its newest
 * check. In a lab with threads every objection counts until `openObjections`
 * ends it.
 */
export function openDisputes(view: LabView): {
  readonly target: Post;
  readonly objections: readonly Post[];
  readonly check: Check | null;
}[] {
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  const checks = view.checks.filter((check) => check.state !== 'dropped');
  const open = view.threads?.length
    ? openObjections(view.posts, checks)
    : checkedObjections(view, checks);
  return [...open].flatMap(([id, objections]) => {
    const target = posts.get(id);
    return target
      ? [
          {
            target,
            objections,
            check: checks.filter((check) => check.claim === id).at(-1) ?? null,
          },
        ]
      : [];
  });
}
