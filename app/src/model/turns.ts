import { PERSON } from '../api/types.ts';
import type { Agent, Post, PostView, Thread, ThreadSummary } from '../api/types.ts';

/** What a post does to the post that it touches. The mark beside a turn takes its shape and color from this. */
export type MarkTone = 'claim' | 'bad' | 'good' | 'turn' | 'answer' | 'ask' | 'quiet';

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

/** The title of the thread that a lab opens with, as `QUESTION_TITLE` in the server's `protocol/threads.py`. */
const QUESTION_TITLE = 'The question';

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
    case 'message':
      return 'quiet';
  }
}

/** What `act` needs besides the post and the post that it answers. */
export interface ActContext {
  /** Names an author inside a sentence. */
  readonly called: (authorId: string) => string;
  /** The post's author, or `null` for the person and for an author that the lab does not list. */
  readonly author: Agent | null;
  /** The ID of the question's thread, or `null` when the lab has none. */
  readonly question: string | null;
}

/**
 * Return a turn as one line, such as "objected to Agent 1’s result".
 *
 * The line comes only from the post's kind, its check outcome and method, its `accepts`, and the post that it
 * replies to. `to` is that post, or `null` when the page does not have it. Every kind names the post that it
 * replies to, so a reply reads right where the indent stops. A rerun is "blind" only from the blind checker that
 * Verifold started for that post. A proposal is an answer only in the question's thread.
 */
export function act(post: Post, to: Post | null, context: ActContext): string {
  const them = to ? context.called(to.author) : 'a post';
  const theirs = to ? `${them}’s ${NOUNS[to.kind]}` : 'a post';
  const reply = post.reply_to === null ? '' : ` in reply to ${theirs}`;
  switch (post.kind) {
    case 'result':
      return `posted a result${reply}`;
    case 'proposal':
      return `${post.thread === context.question ? 'proposed an answer' : 'made a proposal'}${reply}`;
    case 'plan':
      return `posted a plan${reply}`;
    case 'ruled_out':
      return `ruled out a lead${reply}`;
    case 'objection':
      return `objected to ${theirs}`;
    case 'ask':
      return `asked a question${reply}`;
    case 'answer':
      return post.accepts ? `accepted ${theirs}` : `answered ${them}`;
    case 'check': {
      const blind = context.author?.checks != null && context.author.checks === post.reply_to;
      return `${checked(post.method, theirs, blind)}: it ${post.outcome === 'holds' ? 'holds' : 'fails'}`;
    }
    case 'message':
      return post.reply_to === null ? 'added a note' : `replied to ${them}`;
  }
}

function checked(
  method: 'rerun' | 'code_read' | 'ratings',
  theirs: string,
  blind: boolean,
): string {
  switch (method) {
    case 'rerun':
      return `reran ${theirs}${blind ? ' blind' : ''}`;
    case 'code_read':
      return `read the code of ${theirs}`;
    case 'ratings':
      return `rated ${theirs}`;
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
  checkedFamily: string | null,
): string | null {
  if (author === null) return null;
  if (author.checks !== null) {
    const other = checkedFamily !== null && checkedFamily !== author.model.family;
    return other ? 'outside checker, other model family' : 'outside checker';
  }
  if (thread.id === question) return null;
  return thread.opened_by === author.id ? 'leads this thread' : 'visiting';
}

/**
 * Return the thread that holds the person's question, by the server's rule (`question_thread` in
 * `society/views.py`): the lab's first thread, when the person opened it with the question's title.
 */
export function questionThread(threads: readonly ThreadSummary[]): ThreadSummary | null {
  const first = threads.find((summary) => summary.thread.id === 't-1')?.thread;
  const holds = first?.opened_by === PERSON && first.title === QUESTION_TITLE;
  return holds ? (threads.find((summary) => summary.thread === first) ?? null) : null;
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

/**
 * Return the result or proposal that a thread stands on: the newest one that is not Conceded, or else the newest
 * one. A ruled-out lead is not something that a thread stands on.
 */
export function headClaim(posts: readonly PostView[]): PostView | null {
  const claims = posts
    .filter((item) => item.post.kind === 'result' || item.post.kind === 'proposal')
    .reverse();
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
