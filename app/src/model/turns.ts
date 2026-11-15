import { PERSON } from '../api/types.ts';
import type { Agent, AgentView, Post, PostView, Thread, ThreadSummary } from '../api/types.ts';

/** What a post does to the post that it touches. The mark beside a turn takes its shape and color from this. */
export type MarkTone = 'claim' | 'bad' | 'good' | 'turn' | 'answer' | 'ask' | 'quiet';

const NOUNS = {
  message: 'message',
  plan: 'plan',
  result: 'result',
  ask: 'question',
  answer: 'answer',
  objection: 'objection',
  proposal: 'proposal',
  check: 'check',
  ruled_out: 'ruled-out lead',
  report: 'report',
  call: 'call',
  close: 'close',
  request: 'request',
  offer: 'offer',
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
    case 'offer':
      return 'answer';
    case 'ask':
    case 'call':
    case 'request':
      return 'ask';
    case 'close':
      return 'answer';
    case 'plan':
    case 'message':
    case 'report':
      return 'quiet';
  }
}

/** What `act` needs besides the post and the post that it answers. */
export interface ActContext {
  /** Names an author inside a sentence. */
  readonly called: (authorId: string) => string;
  /** The post's author, or `null` for the person and for an author that the lab does not list. */
  readonly author: Agent | null;
}

/**
 * Return a turn as one line, such as "objected to Agent 1’s result".
 *
 * The line comes only from the post's kind, its check outcome and method, its `accepts`, and the post that it
 * replies to. `to` is that post, or `null` when the page does not have it. Every kind names the post that it
 * replies to, so a reply reads right where the indent stops. A plan that replies to a call takes the call. A
 * rerun is "from a clean copy" when it is the check of its author's take: the author took the rerun and so was
 * given the clean copy of the post's pinned files. It is "blind" only from the checker that Verifold started for that post, in a lab from before
 * agents took reruns. A proposal is a proposed answer for the lab in any thread.
 */
export function act(post: Post, to: Post | null, context: ActContext): string {
  const them = to ? context.called(to.author) : 'a post';
  const theirs = to ? `${them}’s ${NOUNS[to.kind]}` : 'a post';
  const reply = post.reply_to === null ? '' : ` in reply to ${theirs}`;
  switch (post.kind) {
    case 'result':
      return `posted a result${reply}`;
    case 'proposal':
      return `proposed an answer${reply}`;
    case 'plan':
      // The caller's own plan takes nothing, as `takers` in the server's `society/standing.py` says.
      return to?.kind === 'call' && to.author !== post.author
        ? `took ${theirs}`
        : `posted a plan${reply}`;
    case 'call':
      return `called for an agent${reply}`;
    case 'close':
      return `said that the lab is done${reply}`;
    case 'ruled_out':
      return `ruled out a lead${reply}`;
    case 'objection':
      return `objected to ${theirs}`;
    case 'ask':
      return `asked a question${reply}`;
    case 'request':
      return 'asked you for a move';
    case 'offer':
      return `offered files for your deliverable ${post.deliverable}`;
    case 'answer':
      // The answer that carries out a coordinator's request: the person said yes to it, or a power decided it.
      if (post.for_request) {
        return post.author === PERSON
          ? `answered ${them}, with your yes to the coordinator’s request`
          : `answered ${them} for you, with the power to answer permission requests`;
      }
      if (post.accepts && to?.kind === 'close') return `agreed that the lab is done`;
      return post.accepts ? `accepted ${theirs}` : `answered ${them}`;
    case 'check': {
      const blind = context.author?.checks != null && context.author.checks === post.reply_to;
      const how = blind ? ' blind' : post.take != null ? ' from a clean copy' : '';
      return `${checked(post.method, theirs, how)}: it ${post.outcome === 'holds' ? 'holds' : 'fails'}`;
    }
    case 'report':
      return `reported to you${reply}`;
    case 'message':
      return post.reply_to === null ? 'posted a message' : `replied to ${them}`;
  }
}

/**
 * Return how many agents posted the check of an independent rerun of a post: a check from a clean copy, or the
 * check of a checker that Verifold started for the post, in a lab from before agents took reruns.
 */
export function rerunChecks(
  posts: readonly PostView[],
  agents: readonly AgentView[],
  postId: string,
): number {
  const checkers = new Set(
    agents.filter((view) => view.agent.checks === postId).map((view) => view.agent.id),
  );
  const authors = posts
    .map((item) => item.post)
    .filter(
      (post) =>
        post.kind === 'check' &&
        post.reply_to === postId &&
        (post.take != null || checkers.has(post.author)),
    )
    .map((post) => post.author);
  return new Set(authors).size;
}

function checked(method: 'rerun' | 'code_read' | 'ratings', theirs: string, how: string): string {
  switch (method) {
    case 'rerun':
      return `reran ${theirs}${how}`;
    case 'code_read':
      return `read the code of ${theirs}`;
    case 'ratings':
      return `rated ${theirs}`;
  }
}

/**
 * Return what an author is to a thread: its lead, a visitor, or an outside checker of a lab from before agents
 * took reruns. `null` for the person, for an author that the lab does not list, and in the question's thread,
 * which belongs to nobody.
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

/**
 * Return whether a post is an agent's plain message that can go in a fold. A post of the person, a post for the
 * whole lab or for the person, a post that names the person, and a post with a badge always show. So does a
 * post whose badge waits for its second or lapsed, because the post shows that too.
 */
export function isPlainMessage(item: PostView): boolean {
  const { post } = item;
  return (
    post.kind === 'message' &&
    post.author !== PERSON &&
    !post.to_lab &&
    !post.for_person &&
    !post.mentions.includes(PERSON) &&
    (item.badges ?? []).length === 0
  );
}

/** How far a row sits from the left: a post, a reply to it, and everything under that reply. */
export type Depth = 0 | 1 | 2;

/** A row of an opened thread: one turn at its depth, or a run of plain messages that folds into one row. */
export type Row =
  | { readonly kind: 'turn'; readonly item: PostView; readonly depth: Depth }
  | { readonly kind: 'fold'; readonly items: readonly PostView[]; readonly depth: Depth };

/**
 * Return a thread's posts as rows. A reply sits under the post that it answers, and the indent stops at two
 * levels. A run of agents' plain messages that nobody replied to folds into one row at its depth, in every
 * thread. The first post of the thread never folds, and neither does `target`, the post that the page opened on.
 * A message that has replies is a turn, with its replies under it. Without `folding`, every post is a turn: that
 * is the conversation with the coordinator, where the agent's messages are its words to the person.
 */
export function rows(
  posts: readonly PostView[],
  target: string | null = null,
  folding = true,
): readonly Row[] {
  const ids = new Set(posts.map((item) => item.post.id));
  const replies = new Map<string, PostView[]>();
  const roots: PostView[] = [];
  for (const item of posts) {
    const parent = item.post.reply_to;
    if (parent !== null && ids.has(parent))
      replies.set(parent, [...(replies.get(parent) ?? []), item]);
    else roots.push(item);
  }
  const first = posts[0]?.post.id;
  const out: Row[] = [];
  const walk = (item: PostView, depth: Depth): void => {
    const { id } = item.post;
    const last = out.at(-1);
    if (!folding || replies.has(id) || id === first || id === target || !isPlainMessage(item))
      out.push({ kind: 'turn', item, depth });
    else if (last?.kind === 'fold' && last.depth === depth)
      out[out.length - 1] = { ...last, items: [...last.items, item] };
    else out.push({ kind: 'fold', items: [item], depth });
    for (const reply of replies.get(id) ?? []) walk(reply, depth === 0 ? 1 : 2);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

/** Return how many messages the folds of a thread hold. */
export function foldedCount(list: readonly Row[]): number {
  return list.reduce((count, row) => count + (row.kind === 'fold' ? row.items.length : 0), 0);
}

/**
 * Return what a fold says: how many messages it holds and who wrote them, such as "7 messages from Keel, Basis,
 * and 2 others". The first two authors have their names, in the order of their first message. `called` names an
 * author inside a sentence.
 */
export function foldLabel(
  items: readonly PostView[],
  called: (authorId: string) => string,
): string {
  const names = [...new Set(items.map((item) => called(item.post.author)))];
  const [first = '', second = ''] = names;
  const others = names.length - 2;
  const who =
    others > 0
      ? `${first}, ${second}, and ${others === 1 ? '1 other' : `${others} others`}`
      : names.length === 2
        ? `${first} and ${second}`
        : first;
  return `${items.length === 1 ? '1 message' : `${items.length} messages`} from ${who}`;
}

/** Return the words of the control above a thread's posts, which shows every folded message or folds them again. */
export function unfoldLabel(count: number, shown: boolean): string {
  if (shown) return count === 1 ? 'Fold 1 message again' : `Fold ${count} messages again`;
  return count === 1 ? 'Show the folded message' : `Show the ${count} folded messages`;
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

/** The status of a closed card. `edge` colors the card's top edge. */
export interface CardStatus {
  readonly label: string;
  readonly edge: 'bad' | 'good' | 'none';
  readonly openAsks: string | null;
  /** Says that the thread has work that no agent has taken, or `null`. */
  readonly openCalls: string | null;
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
  const calls = summary.open_calls;
  const openCalls =
    calls === 0 ? null : calls === 1 ? 'Needs an agent' : `${calls} calls need an agent`;
  const rest = { openAsks, openCalls };
  if (disputed > 0) return { label: `${disputed} disputed`, edge: 'bad', ...rest };
  if (checked > 0) {
    const label = open === 0 ? 'Checked' : `${checked} of ${checked + open} checked`;
    return { label, edge: 'good', ...rest };
  }
  return { label: open > 0 ? 'Not checked' : 'No result yet', edge: 'none', ...rest };
}

/**
 * Return the line that says that the lab's agents consider it done, or `null` while no agent says so. The count
 * includes the agent that said it. An agent that stood behind the close and then left still counts.
 */
export function doneLine(lab: {
  readonly state: 'open' | 'closing' | 'closed';
  readonly close_agreed: number;
  readonly close_among: number;
}): string | null {
  if (lab.state === 'open') return null;
  const among = lab.close_among;
  const behind = `${lab.close_agreed + 1} of ${among} ${among === 1 ? 'agent' : 'agents'}`;
  return lab.state === 'closed'
    ? `The agents say that the lab is done (${behind}). You can still steer it.`
    : `An agent says that the lab is done (${behind} so far).`;
}
