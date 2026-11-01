/**
 * The threads of a lab with threads: pure operations on their records. A
 * thread is a conversation with a subject. Its posts stay write-once files on
 * the board, and each post names its thread. The thread's record holds what
 * changes: its state, its outcome, its followers, and its reactions.
 * thread-store.ts keeps the records. A lab from before threads has none.
 */
import {
  agentId,
  boardLimits,
  clip,
  directionId,
  number,
  object,
  postId,
  threadId,
  type NewPost,
  type Post,
  type PostKind,
} from '../board.ts';
import { threadLimits } from '../lab-tools.ts';
import {
  fail,
  type Agreement,
  type Thread,
  type ThreadOutcome,
  type ThreadState,
} from './schema.ts';

/** The kinds that need a reply. One of them to a post in a closed thread opens that thread again. */
export const reopeningKinds: ReadonlySet<PostKind> = new Set([
  'objection',
  'answer',
  'check',
]);

/** The plan thread. Every agent reads it. The person's post with no thread lands here. */
export const planThread = 't-1';

const states: readonly ThreadState[] = [
  'open',
  'decided',
  'answered',
  'closed',
];

/** The plan thread of a new lab. */
export function planThreadRecord(at: string): Thread {
  return {
    id: planThread,
    title: 'The plan of record and messages from the person',
    state: 'open',
    why: 'Every agent reads this thread.',
    openedBy: 'verifold',
    at,
    followers: [],
    agreed: [],
  };
}

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const isAuthor = (value: unknown): value is string =>
  value === 'person' ||
  value === 'verifold' ||
  (typeof value === 'string' && agentId.test(value));

const isPost = (value: unknown): value is string =>
  typeof value === 'string' && postId.test(value);

function parseOutcome(value: unknown): ThreadOutcome | null {
  const entry = object(value);
  return entry &&
    typeof entry.text === 'string' &&
    entry.text.length <= boardLimits.text &&
    isPost(entry.post) &&
    isAuthor(entry.by) &&
    isTime(entry.at)
    ? { text: entry.text, post: entry.post, by: entry.by, at: entry.at }
    : null;
}

function parseAgreement(value: unknown): Agreement | null {
  const entry = object(value);
  return entry && isPost(entry.post) && isAuthor(entry.by) && isTime(entry.at)
    ? { post: entry.post, by: entry.by, at: entry.at }
    : null;
}

/** A thread from its file, or null when it is not valid. A harness can write in the project, so every field is checked. */
export function parseThread(value: unknown): Thread | null {
  const entry = object(value);
  const state = states.find((item) => item === entry?.state);
  if (
    !entry ||
    !state ||
    typeof entry.id !== 'string' ||
    !threadId.test(entry.id) ||
    typeof entry.title !== 'string' ||
    !entry.title ||
    entry.title.length > threadLimits.title ||
    typeof entry.why !== 'string' ||
    entry.why.length > threadLimits.why ||
    !isAuthor(entry.openedBy) ||
    !isTime(entry.at)
  )
    return null;
  const outcome = parseOutcome(entry.outcome);
  const list = (value: unknown): readonly unknown[] =>
    Array.isArray(value) ? value : [];
  return {
    id: entry.id,
    title: entry.title,
    state,
    why: entry.why,
    ...(typeof entry.direction === 'string' && directionId.test(entry.direction)
      ? { direction: entry.direction }
      : {}),
    openedBy: entry.openedBy,
    at: entry.at,
    ...(isPost(entry.opening) ? { opening: entry.opening } : {}),
    ...(outcome ? { outcome } : {}),
    ...(isPost(entry.overturned) ? { overturned: entry.overturned } : {}),
    followers: [
      ...new Set(
        list(entry.followers).filter(
          (item): item is string =>
            typeof item === 'string' && agentId.test(item),
        ),
      ),
    ].slice(-threadLimits.followers),
    agreed: list(entry.agreed)
      .flatMap((item) => parseAgreement(item) ?? [])
      .slice(-threadLimits.agreed),
  };
}

/** The post with its thread: a reply joins its target's thread, and the plan and the person's post with no thread go to the plan thread. */
export function placed(fields: NewPost, target: Post | undefined): NewPost {
  if (fields.thread) return fields;
  const thread =
    target?.thread ??
    (fields.kind === 'plan' || fields.author === 'person'
      ? planThread
      : undefined);
  return thread ? { ...fields, thread } : fields;
}

/** Whether `agent` reads the thread's posts in its digests. */
export function follows(thread: Thread, agent: string): boolean {
  return thread.id === planThread || thread.followers.includes(agent);
}

/** The thread with one more follower. */
export function followed(thread: Thread, agent: string): Thread {
  return thread.followers.includes(agent)
    ? thread
    : {
        ...thread,
        followers: [...thread.followers, agent].slice(-threadLimits.followers),
      };
}

/** The thread open again, with no outcome. */
function reopened(thread: Thread): Thread {
  const open: { -readonly [Key in keyof Thread]: Thread[Key] } = {
    ...thread,
    state: 'open',
  };
  delete open.outcome;
  return open;
}

/**
 * The thread after a post in it, or the same object when the post changes
 * nothing, so the store writes nothing. Its author and the agent that an ask
 * names follow it. An answer to the ask that opened the thread answers the
 * thread, and so does the person's own reply to it. An objection to the
 * proposal that decided the thread opens it again, and so does a reply of a
 * `reopeningKinds` kind in a closed thread.
 */
export function afterPost(
  thread: Thread,
  post: Post,
  target: Post | undefined,
): Thread {
  const asked = post.kind === 'ask' ? post.mentions : [];
  const next = [post.author, ...asked]
    .filter((id) => agentId.test(id))
    .reduce(
      followed,
      thread.opening ? thread : { ...thread, opening: post.id },
    );
  if (
    (thread.state === 'closed' && reopeningKinds.has(post.kind)) ||
    (thread.state === 'decided' &&
      post.kind === 'objection' &&
      post.replyTo === thread.outcome?.post)
  )
    return reopened(next);
  return (post.kind === 'answer' || post.author === 'person') &&
    target?.kind === 'ask' &&
    target.id === thread.opening &&
    thread.state === 'open'
    ? { ...next, state: 'answered', outcome: outcomeOf(post, post.at) }
    : next;
}

/** A thread's outcome keeps the post's text within a post's limit. The post holds the whole text. */
function outcomeOf(post: Post, at: string): ThreadOutcome {
  return {
    text: clip(post.text, boardLimits.text),
    post: post.id,
    by: post.author,
    at,
  };
}

/** The thread with one more reaction. A repeated reaction changes nothing. */
export function agreedWith(
  thread: Thread,
  post: string,
  by: string,
  at: string,
): Thread {
  return thread.agreed.some((entry) => entry.post === post && entry.by === by)
    ? thread
    : {
        ...thread,
        agreed: [...thread.agreed, { post, by, at }].slice(
          -threadLimits.agreed,
        ),
      };
}

/** The thread after a proposal became its decision. */
export function decided(thread: Thread, proposal: Post, at: string): Thread {
  return { ...thread, state: 'decided', outcome: outcomeOf(proposal, at) };
}

/**
 * The thread after the person overturned its decision: open again, and its
 * proposal never decides it again. Refuses a thread with no decision.
 */
export function overturned(thread: Thread): Thread {
  if (thread.state !== 'decided' || !thread.outcome)
    fail(`${thread.id} has no decision to overturn.`);
  const { outcome, ...rest } = thread;
  return { ...rest, state: 'open', overturned: outcome.post };
}

/**
 * The proposals whose objection window ended by `now`, oldest first, each with
 * its thread. A proposal with an objection never decides by itself: its author
 * posts a new proposal. A newer proposal can replace a decision. An answered
 * thread can still get a decision. A proposal in a closed thread stays as it
 * is, and so does one at or before a proposal that the person overturned. A
 * long shot stays open: agents choose what to take up.
 */
export function dueProposals(
  posts: readonly Post[],
  threads: readonly Thread[],
  now: number,
  windowMs: number,
): readonly { readonly thread: Thread; readonly proposal: Post }[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const objected = new Set(
    posts.flatMap((post) =>
      post.kind === 'objection' && post.replyTo ? [post.replyTo] : [],
    ),
  );
  return posts.flatMap((proposal) => {
    const thread = proposal.thread ? byId.get(proposal.thread) : undefined;
    return proposal.kind === 'proposal' &&
      !proposal.alien &&
      thread &&
      thread.state !== 'closed' &&
      !objected.has(proposal.id) &&
      Date.parse(proposal.at) + windowMs <= now &&
      number(proposal.id) >
        Math.max(
          number(
            (thread.state === 'decided' ? thread.outcome?.post : null) ?? 'p-0',
          ),
          number(thread.overturned ?? 'p-0'),
        )
      ? [{ thread, proposal }]
      : [];
  });
}

/** Words that say nothing about a subject. A title needs more than these. */
const emptyWords: ReadonlySet<string> = new Set(
  'a an and about for from in my new of on our some the this to update updates status result results progress note notes question questions issue issues misc general thread discussion work latest'.split(
    ' ',
  ),
);

/**
 * Refuse a title that says too little, or one that an open thread has. The
 * title of a thread tells a reader what the lab talks about, so an ID or a
 * word such as "Update" is no title.
 */
export function checkTitle(title: string, threads: readonly Thread[]): void {
  const specific = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(
      (word) =>
        word && !emptyWords.has(word) && !/^([a-z]+-)?\d[\d.]*$/.test(word),
    );
  if (specific.length < 2)
    fail(
      'Give a title that a reader understands alone: a specific plain question or subject, such as "Does the control beat chance on seed 2?".',
    );
  const same = threads.find(
    (thread) =>
      thread.state !== 'closed' &&
      thread.title.toLowerCase() === title.toLowerCase(),
  );
  if (same)
    fail(`${same.id} has this title. Post there with thread: ${same.id}.`);
}
