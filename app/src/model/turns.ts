import { PERSON } from '../api/types.ts';
import type { Agent, Post, PostView, Thread, ThreadSummary } from '../api/types.ts';

/** What a post does to the post that it touches. The mark beside a turn takes its shape and color from this. */
export type MarkTone = 'claim' | 'bad' | 'good' | 'turn' | 'answer' | 'ask' | 'plan' | 'quiet';

const NOUNS = {
  message: 'note',
  plan: 'plan',
  result: 'result',
  ask: 'question',
  answer: 'answer',
  objection: 'objection',
  proposal: 'proposal',
  check: 'check',
  ruled_out: 'ruled-out lead',
} as const satisfies Record<Post['kind'], string>;

const CLAIMS: ReadonlySet<Post['kind']> = new Set(['result', 'proposal', 'ruled_out']);

/** Return whether a post states something that others can check: a result, a proposal, or a ruled-out lead. */
export function isClaim(post: Post): boolean {
  return CLAIMS.has(post.kind);
}

/** Return the tone of a post's mark. */
export function tone(post: Post): MarkTone {
  switch (post.kind) {
    case 'check':
      return post.outcome === 'holds' ? 'good' : 'bad';
    case 'objection':
      return 'bad';
    case 'answer':
      return post.accepts ? 'turn' : 'quiet';
    case 'result':
    case 'ruled_out':
      return 'claim';
    case 'proposal':
      return 'answer';
    case 'ask':
      return 'ask';
    case 'plan':
      return 'plan';
    case 'message':
      return 'quiet';
  }
}

/**
 * Return a turn as one line, such as "objected to Agent 1’s result".
 *
 * The line comes only from the post's kind, its check outcome and method, its `accepts`, and the post that it
 * replies to. `to` is that post, or `null` when the page does not have it. `called` names an author inside a
 * sentence.
 */
export function act(post: Post, to: Post | null, called: (authorId: string) => string): string {
  const them = to ? called(to.author) : null;
  const theirs = to ? `${them}’s ${NOUNS[to.kind]}` : null;
  switch (post.kind) {
    case 'result':
      return to ? 'followed up with a result' : 'posted a result';
    case 'proposal':
      return 'proposed an answer';
    case 'plan':
      return 'posted a plan';
    case 'ruled_out':
      return 'ruled out a lead';
    case 'objection':
      return theirs ? `objected to ${theirs}` : 'objected';
    case 'ask':
      return 'asked a question';
    case 'answer':
      if (!to) return post.accepts ? 'accepted an objection' : 'answered';
      return post.accepts ? `accepted ${theirs}` : `answered ${them}`;
    case 'check':
      return `${checked(post.method, theirs)}: it ${post.outcome === 'holds' ? 'holds' : 'fails'}`;
    case 'message':
      return them ? `replied to ${them}` : 'added a note';
  }
}

function checked(method: 'rerun' | 'code_read' | 'ratings', theirs: string | null): string {
  switch (method) {
    case 'rerun':
      return theirs ? `reran ${theirs} blind` : 'reran it blind';
    case 'code_read':
      return theirs ? `read the code of ${theirs}` : 'read the code';
    case 'ratings':
      return theirs ? `rated ${theirs}` : 'rated it';
  }
}

/**
 * Return what an author is to a thread: its lead, a visitor, or an outside checker. `null` for the person, for an
 * author that the lab does not list, and in the question's thread, which belongs to nobody.
 *
 * `checkedFamily` is the model family of the author whose post a checker answers, when the page has it.
 */
export function standingIn(
  author: Agent | null,
  thread: Thread,
  question: string | null,
  checkedFamily: string | null = null,
): string | null {
  if (author === null) return null;
  if (author.checks !== null) {
    const other = checkedFamily !== null && checkedFamily !== author.model.family;
    return other ? 'outside checker, other model family' : 'outside checker';
  }
  if (thread.id === question) return null;
  return thread.opened_by === author.id ? 'leads this thread' : 'visiting';
}

/** Return the thread that holds the person's question: the lab's first thread, when the person opened it. */
export function questionThread(threads: readonly ThreadSummary[]): ThreadSummary | null {
  return (
    threads.find((summary) => summary.thread.id === 't-1' && summary.thread.opened_by === PERSON) ??
    null
  );
}

/** Return whether a post is a status note: an agent's plain message in the question's thread. */
export function isStatusNote(post: Post, question: string | null): boolean {
  return post.thread === question && post.kind === 'message' && post.author !== PERSON;
}

/** A row of an opened thread: one turn at its depth, or a run of status notes that folds into one row. */
export type Row =
  | { readonly kind: 'turn'; readonly item: PostView; readonly depth: 0 | 1 | 2 }
  | { readonly kind: 'notes'; readonly items: readonly PostView[] };

/**
 * Return a thread's posts as rows. A reply sits under the post that it answers, and the indent stops at two
 * levels. A run of status notes that nobody answered folds into one row.
 */
export function rows(posts: readonly PostView[], question: string | null): readonly Row[] {
  const ids = new Set(posts.map((item) => item.post.id));
  const replies = new Map<string, PostView[]>();
  const roots: PostView[] = [];
  for (const item of posts) {
    const parent = item.post.reply_to;
    if (parent !== null && ids.has(parent))
      replies.set(parent, [...(replies.get(parent) ?? []), item]);
    else roots.push(item);
  }
  const out: Row[] = [];
  const walk = (item: PostView, depth: 0 | 1 | 2): void => {
    out.push({ kind: 'turn', item, depth });
    for (const reply of replies.get(item.post.id) ?? []) walk(reply, depth === 0 ? 1 : 2);
  };
  for (const root of roots) {
    const last = out.at(-1);
    if (!isStatusNote(root.post, question) || replies.has(root.post.id)) walk(root, 0);
    else if (last?.kind === 'notes')
      out[out.length - 1] = { kind: 'notes', items: [...last.items, root] };
    else out.push({ kind: 'notes', items: [root] });
  }
  return out;
}

/** Return the claim that a thread stands on: the newest one that is not Conceded, or else the newest one. */
export function headClaim(posts: readonly PostView[]): PostView | null {
  const claims = posts.filter((item) => isClaim(item.post)).reverse();
  return claims.find((item) => item.standing !== 'conceded') ?? claims[0] ?? null;
}

/** Return the lab's answer so far: the newest proposal in the question's thread that is not Conceded. */
export function answerSoFar(posts: readonly PostView[]): PostView | null {
  const proposals = posts.filter((item) => item.post.kind === 'proposal').reverse();
  return proposals.find((item) => item.standing !== 'conceded') ?? null;
}

/** The status of a closed card. `edge` colors the card's top edge. */
export interface CardStatus {
  readonly label: string;
  readonly edge: 'bad' | 'good' | 'none';
  readonly openAsks: string | null;
}

/**
 * Return a closed card's status from the counts in a thread's summary.
 *
 * The summary counts results by standing, and counts Held up with Checked. So the words here are counts, and a
 * closed card never says "Held up".
 */
export function cardStatus(summary: ThreadSummary): CardStatus {
  const { disputed, checked, not_checked: open, open_asks: asks } = summary;
  const openAsks = asks === 0 ? null : asks === 1 ? 'Open ask' : `${asks} open asks`;
  if (disputed > 0) return { label: `${disputed} disputed`, edge: 'bad', openAsks };
  if (checked > 0) {
    const label = open === 0 ? 'Checked' : `${checked} of ${checked + open} checked`;
    return { label, edge: 'good', openAsks };
  }
  return { label: open > 0 ? 'Not checked' : 'No result yet', edge: 'none', openAsks };
}
