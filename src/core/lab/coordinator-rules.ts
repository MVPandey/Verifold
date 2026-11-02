/**
 * What the Coordinator's tools take and what they refuse: pure rules, with no
 * lab. These rules hold its reach. No tool of it can change a decision: it
 * cannot close a thread that holds an open objection, a wait, an open proposal,
 * or a long shot, replace an outcome, or move a post that a decision rests on.
 * A notice carries a kind and posts, and Verifold writes its words, so no words
 * of a model reach an agent. A thread's outcome quotes a post, and a filed
 * thread's title quotes the person, for the same reason. A refusal says what
 * to change.
 */
import {
  agentId,
  clip,
  object,
  postId,
  type Post,
  type PostKind,
} from '../board.ts';
import {
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
  type Check,
  type LineCheck,
  type LineProblem,
  type NoticeKind,
  type Thread,
  type Notice,
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

/** A line of `verifold_brief` or `verifold_story`. */
export interface DraftLine<Kind extends string> {
  readonly kind: Kind;
  readonly plain: string;
  readonly posts: readonly Post[];
}

/** An ID of the lab's records. */
const recordId = /\b(?:[prdtkcaqnl]|lease)-\d+\b/;

/** Words for the person, on one line. A person reads no IDs in them. */
function plainWords(value: unknown, limit: number, what: string): string {
  const words = oneLine(text(value, limit, what));
  if (recordId.test(words)) fail('Leave out IDs such as p-12 or d-3.');
  return words;
}

/** The lines of `verifold_brief` or `verifold_story`, checked. `kinds`: what a line can be. `most`: how many it can have. */
export function parseLines<Kind extends string>(
  value: unknown,
  post: (id: string) => Post | undefined,
  keepPlain: boolean,
  kinds: readonly Kind[],
  most: number,
): readonly DraftLine<Kind>[] {
  if (!Array.isArray(value) || !value.length || value.length > most)
    fail(`Give 1 to ${most} lines, the most important first.`);
  return value.map((item) => {
    const entry = object(item) ?? {};
    return {
      kind:
        kinds.find((kind) => kind === entry.kind) ??
        fail(`A line's kind is one of: ${kinds.join(', ')}.`),
      plain: keepPlain
        ? plainWords(entry.plain, briefLimits.plain, 'the plain line')
        : '',
      posts: citedPosts(entry.posts, post),
    };
  });
}

/**
 * The checks of a session's lines. Verifold reads the verdicts, so a line
 * passes only when each claim is supported and no caveat dropped out. It fails
 * closed: an answer that leaves out or repeats a line, or that does not list
 * its dropped caveats, is refused.
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
    if (checks.has(id)) fail(`Check ${id} once.`);
    if (!Array.isArray(entry.dropped))
      fail(`List the dropped caveats of ${id}, or give an empty list.`);
    if (entry.dropped.length > briefLimits.claims)
      fail(`Give ${id} at most ${briefLimits.claims} caveats.`);
    if (!Array.isArray(entry.claims) || !entry.claims.length)
      fail(`Split ${id} into its claims.`);
    if (entry.claims.length > briefLimits.claims)
      fail(`Give ${id} at most ${briefLimits.claims} claims.`);
    const problems = entry.claims.flatMap((claim): readonly LineProblem[] => {
      const part = object(claim) ?? {};
      const verdict =
        claimVerdicts.find((known) => known === part.verdict) ??
        fail(`A verdict is one of: ${claimVerdicts.join(', ')}.`);
      return verdict === 'supported'
        ? []
        : [
            {
              kind: verdict,
              claim: oneLine(text(part.claim, briefLimits.claim, 'the claim')),
            },
          ];
    });
    const dropped = entry.dropped.map(
      (caveat): LineProblem => ({
        kind: 'dropped-caveat',
        claim: oneLine(text(caveat, briefLimits.claim, 'the caveat')),
      }),
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

/** The kinds of post that say what a run or a check did. A plan, an ask, or a proposal tried nothing. */
const triedKinds: ReadonlySet<PostKind> = new Set([
  'result',
  'check',
  'rerun',
  'ruled-out',
  'claim',
  'evidence',
]);

/** The post that `verifold_tried` cites, checked. */
export function triedPost(post: Post | undefined): Post {
  return post && triedKinds.has(post.kind)
    ? post
    : fail(
        'Cite a result, check, rerun, or ruled-out post that is on the board.',
      );
}

/** A title for the person. It reaches no agent, and it holds no number that the posts do not hold. */
export function checkedTitle(
  value: unknown,
  threads: readonly Thread[],
  posts: readonly Post[],
): string {
  const title = plainWords(value, threadLimits.title, 'the title');
  checkTitle(title, threads);
  const stray = strayNumbers(title, posts);
  if (stray.length)
    fail(`No post of the thread holds these numbers: ${stray.join(', ')}.`);
  return title;
}

/** Why a thread keeps its title, or null. A thread with an outcome is a record of it. */
export function retitleRefusal(thread: Thread): string | null {
  if (thread.id === planThread) return 'The plan thread keeps its title.';
  return thread.outcome
    ? `${thread.id} has its outcome, so it keeps its title.`
    : null;
}

/** The title that agents read of a thread filed for a person's post: the person's own words. */
export function filedTitle(post: Post): string {
  return clip(oneLine(post.text), threadLimits.title);
}

/**
 * The posts with something open: each open ask or objection, and what each
 * one replies to.
 */
export function openPosts(
  posts: readonly Post[],
  checks: readonly Pick<Check, 'state' | 'objections'>[],
  waits: readonly Wait[],
): ReadonlySet<string> {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const open = [
    ...waits.flatMap((wait) => byId.get(wait.post) ?? []),
    ...[...openObjections(posts, checks).values()].flat(),
  ];
  return new Set(
    open.flatMap((post) => [post.id, ...(post.replyTo ? [post.replyTo] : [])]),
  );
}

/**
 * Why a post stays in its thread, or null. A plan and a proposal say what the
 * lab decides. A post that holds an outcome is the decision. A post with an
 * open objection or ask is in dispute. Anything else can move.
 */
export function stayRefusal(
  post: Post,
  threads: readonly Thread[],
  open: ReadonlySet<string>,
): string | null {
  if (post.kind === 'plan' || post.kind === 'proposal')
    return `${post.id} is a ${post.kind} post, so it stays in its thread.`;
  const held = threads.find((thread) => thread.outcome?.post === post.id);
  if (held) return `${post.id} holds the outcome of ${held.id}, so it stays.`;
  return open.has(post.id)
    ? `${post.id} has an open objection or ask, so it stays in its thread.`
    : null;
}

/** Why a post does not move to the thread `to`, or null. */
export function moveRefusal(
  post: Post,
  to: Thread,
  threads: readonly Thread[],
  open: ReadonlySet<string>,
): string | null {
  if (post.thread === to.id) return `${post.id} is in ${to.id} already.`;
  if (to.state === 'closed')
    return `${to.id} is closed. Move the post to an open thread.`;
  return stayRefusal(post, threads, open);
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

/**
 * A notice still holds: the wait that it named stands, or two of the agents
 * that may overlap still work. `waits`: the waits now. `working`: the agents
 * that work now. It reads records only, so a stale notice needs no cleanup.
 */
export function noticeStands(
  notice: Pick<Notice, 'kind' | 'posts' | 'to'>,
  waits: readonly Pick<Wait, 'post'>[],
  working: ReadonlySet<string>,
): boolean {
  if (notice.kind === 'overlap')
    return notice.to.filter((agent) => working.has(agent)).length >= 2;
  return (
    notice.kind !== 'missing-answer' ||
    notice.posts.some((post) => waits.some((wait) => wait.post === post))
  );
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
      text: `The Coordinator sees that ${cited} may cover the same work.`,
    };
  }
  if (kind === 'no-search') {
    const unmarked = posts.find((post) => !post.noSearch);
    if (unmarked) fail(`${unmarked.id} has no "No search yet" mark.`);
    return {
      kind,
      to: authors,
      text: `The Coordinator sees no search yet for ${cited}.`,
    };
  }
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
