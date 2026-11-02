/**
 * What the Coordinator's tools take and what they refuse: pure rules, with no
 * lab. These rules hold its reach. It cannot close a thread that holds an open
 * objection, a wait, an open proposal, or a long shot, because that would
 * settle what is not its to settle. A notice carries a kind and posts, and
 * Verifold writes its words, so no words of a model reach an agent. A thread's
 * outcome quotes a post for the same reason. A refusal says what to change.
 */
import { agentId, object, postId, type Post } from '../board.ts';
import {
  briefKinds,
  briefLimits,
  claimVerdicts,
  noticeKinds,
  threadLimits,
} from '../lab-tools.ts';
import { strayNumbers } from './brief.ts';
import { openObjections } from './post-rules.ts';
import {
  fail,
  text,
  type BriefKind,
  type Check,
  type LineCheck,
  type NoticeKind,
  type Thread,
} from './schema.ts';
import { checkTitle, dueProposals, planThread } from './threads.ts';
import type { Wait } from './waits.ts';

const oneLine = (value: string): string => value.replace(/\s+/g, ' ');

/** The posts that a line cites, on the board and with no repeat. */
export function citedPosts(
  value: unknown,
  post: (id: string) => Post | undefined,
): readonly Post[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > briefLimits.linePosts
  )
    fail(`Cite 1 to ${briefLimits.linePosts} posts.`);
  const posts = value.map((id) =>
    typeof id === 'string' && postId.test(id)
      ? (post(id) ?? fail(`No post ${id} is on the board.`))
      : fail('Name posts such as p-12.'),
  );
  if (new Set(posts).size !== posts.length) fail('Cite each post once.');
  return posts;
}

/** A line of `verifold_brief`. */
export interface DraftLine {
  readonly kind: BriefKind;
  readonly plain: string;
  readonly posts: readonly Post[];
}

/** The lines of `verifold_brief`, checked. */
export function parseLines(
  value: unknown,
  post: (id: string) => Post | undefined,
): readonly DraftLine[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > briefLimits.lines
  )
    fail(`Give 1 to ${briefLimits.lines} lines.`);
  return value.map((item): DraftLine => {
    const entry = object(item) ?? {};
    return {
      kind:
        briefKinds.find((kind) => kind === entry.kind) ??
        fail(`A line's kind is one of: ${briefKinds.join(', ')}.`),
      plain: oneLine(text(entry.plain, briefLimits.plain, 'the plain line')),
      posts: citedPosts(entry.posts, post),
    };
  });
}

/**
 * The checks of a session's lines. Verifold reads the verdicts, so a line
 * passes only when each claim is supported and no caveat dropped out. Refuses
 * an answer that leaves out a line.
 */
export function parseChecks(
  value: unknown,
  ids: readonly string[],
): ReadonlyMap<string, Pick<LineCheck, 'state' | 'problems'>> {
  if (!Array.isArray(value)) fail('Give your check of each line in lines.');
  const checks = new Map<string, Pick<LineCheck, 'state' | 'problems'>>();
  for (const item of value) {
    const entry = object(item) ?? {};
    const id =
      ids.find((known) => known === entry.id) ??
      fail(`Name one of these lines: ${ids.join(', ')}.`);
    if (!Array.isArray(entry.claims) || !entry.claims.length)
      fail(`Split ${id} into its claims.`);
    if (entry.claims.length > briefLimits.claims)
      fail(`Give ${id} at most ${briefLimits.claims} claims.`);
    const problems = entry.claims.flatMap((claim): readonly string[] => {
      const part = object(claim) ?? {};
      const verdict =
        claimVerdicts.find((known) => known === part.verdict) ??
        fail(`A verdict is one of: ${claimVerdicts.join(', ')}.`);
      return verdict === 'supported'
        ? []
        : [
            `${verdict}: ${oneLine(text(part.claim, briefLimits.claim, 'the claim'))}`,
          ];
    });
    const dropped = (Array.isArray(entry.dropped) ? entry.dropped : [])
      .slice(0, briefLimits.claims)
      .map(
        (caveat) =>
          `dropped-caveat: ${oneLine(text(caveat, briefLimits.claim, 'the caveat'))}`,
      );
    const found = [...problems, ...dropped].slice(0, briefLimits.claims);
    checks.set(id, {
      state: found.length ? 'failed' : 'passed',
      problems: found,
    });
  }
  const left = ids.filter((id) => !checks.has(id));
  if (left.length) fail(`Check each line. These are left: ${left.join(', ')}.`);
  return checks;
}

/** A title of `verifold_thread`. A title reaches agents, so its numbers must come from the thread's posts. */
export function checkedTitle(
  value: unknown,
  thread: Thread,
  threads: readonly Thread[],
  posts: readonly Post[],
): string {
  if (thread.id === planThread) fail('The plan thread keeps its title.');
  const title = oneLine(text(value, threadLimits.title, 'the title'));
  checkTitle(title, threads);
  const stray = strayNumbers(
    title,
    posts.filter((post) => post.thread === thread.id),
  );
  if (stray.length)
    fail(`No post of ${thread.id} holds these numbers: ${stray.join(', ')}.`);
  return title;
}

/**
 * Why a post stays where it is, or null. The post that opens a thread or holds
 * its outcome stays, because the thread's record names it.
 */
export function moveRefusal(
  post: Post,
  to: Thread,
  threads: readonly Thread[],
): string | null {
  if (post.thread === to.id) return `${post.id} is in ${to.id} already.`;
  if (to.state === 'closed')
    return `${to.id} is closed. Move the post to an open thread.`;
  const held = threads.find(
    (thread) => thread.opening === post.id || thread.outcome?.post === post.id,
  );
  return held && held.id !== planThread
    ? `${post.id} opens ${held.id} or holds its outcome, so it stays there.`
    : null;
}

/**
 * Why a thread stays open, or null. An open objection, a wait, a proposal
 * that can still decide, or a long shot keeps it open: a close must not settle
 * any of them.
 */
export function closeRefusal(
  thread: Thread,
  posts: readonly Post[],
  threads: readonly Thread[],
  checks: readonly Pick<Check, 'state' | 'objections'>[],
  waits: readonly Wait[],
): string | null {
  if (thread.id === planThread) return 'The plan thread stays open.';
  if (thread.state === 'closed') return `${thread.id} is closed already.`;
  const own = posts.filter((post) => post.thread === thread.id);
  const disputed = openObjections(posts, checks);
  const dispute = own.find((post) => disputed.has(post.id));
  if (dispute)
    return `${dispute.id} has an open objection, and you settle no dispute. The thread stays open.`;
  const wait = waits.find((entry) => entry.thread === thread.id);
  if (wait)
    return `${wait.post} waits for an answer, so the thread stays open.`;
  const open =
    own.find((post) => post.alien) ??
    dueProposals(posts, threads, Infinity, 0).find(
      (entry) => entry.thread.id === thread.id,
    )?.proposal;
  return open
    ? `${open.id} is an open proposal, so the thread stays open.`
    : null;
}

/** A notice as agents read it: Verifold's words, and who gets it. */
export function noticeFrom(
  value: unknown,
  posts: readonly Post[],
  waits: readonly Wait[],
  name: (author: string) => string,
): {
  readonly kind: NoticeKind;
  readonly text: string;
  readonly to: readonly string[];
} {
  const kind =
    noticeKinds.find((known) => known === value) ??
    fail(`A notice's kind is one of: ${noticeKinds.join(', ')}.`);
  const authors = [...new Set(posts.map((post) => post.author))].filter((id) =>
    agentId.test(id),
  );
  const cited = posts
    .map((post) => `${post.id} of ${name(post.author)}`)
    .join(', ');
  if (kind === 'overlap') {
    if (authors.length < 2)
      fail('An overlap names posts of two or more agents.');
    return {
      kind,
      to: authors,
      text: `The Coordinator sees that ${cited} may cover the same work. Read them, and decide what to do.`,
    };
  }
  if (kind === 'no-search')
    return {
      kind,
      to: authors,
      text: `The Coordinator sees no search before the new idea in ${cited}. Search if you see fit.`,
    };
  const open = posts.map(
    (post) =>
      waits.find((wait) => wait.post === post.id) ??
      fail(`${post.id} waits for nothing now.`),
  );
  return {
    kind,
    to: [...new Set(open.map((wait) => wait.on))].filter((id) =>
      agentId.test(id),
    ),
    text: `The Coordinator sees no answer yet to ${cited}.`,
  };
}
