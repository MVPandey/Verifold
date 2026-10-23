import type { Post } from './board.ts';
import type { Check, LabView } from './lab/schema.ts';
import { checkLimits } from './lab-tools.ts';

/**
 * The disputes that a check answers or can answer: each post with the
 * objections that a check took and no check answered yet, and its newest
 * check. The objections of a failed check count while the post can get one
 * more check, which takes them. An objection that no check took, because
 * its post cites no run or had its checks, stays a reply in its thread.
 */
export function openDisputes(view: LabView): {
  readonly target: Post;
  readonly objections: readonly Post[];
  readonly check: Check | null;
}[] {
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  const checks = view.checks.filter((check) => check.state !== 'dropped');
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
