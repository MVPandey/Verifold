import type { Post, PostKind } from './board.ts';
import { verdictWords, type LabView, type Verdict } from './lab.ts';

/**
 * The lab's words for its posts, calls, and authors. The desk and the API
 * show them, and search matches on them, so the person finds a post by the
 * word that it shows.
 */
export const kindWords: Record<PostKind, string> = {
  plan: 'Plan of record',
  claim: 'Claim',
  evidence: 'Evidence',
  objection: 'Objection',
  question: 'Question',
  rerun: 'Rerun',
  'ruled-out': 'Ruled out',
  status: 'Note',
};

/** A post's kind in words. The person's question is a message. */
export function kindLabel(post: Post): string {
  return post.author === 'person' && post.kind === 'question'
    ? 'Message'
    : kindWords[post.kind];
}

export const callWords = {
  cost: 'Cost call',
  scope: 'Scope call',
  access: 'Access call',
  go: 'Go call',
} as const;

/** Who wrote a post or asked a call, in the lab's words. */
export function authorName(view: LabView, author: string): string {
  return author === 'person'
    ? 'You'
    : author === 'verifold'
      ? 'Verifold'
      : (view.handles[author] ?? author);
}

/** A direction's verdict in words. A direction with no verdict is not settled yet. */
export function verdictText(verdict: Verdict, disputed: boolean): string {
  return disputed
    ? 'Disputed'
    : verdict === 'open'
      ? 'Not settled'
      : verdictWords[verdict];
}

/** A count with its noun, such as "1 post" or "4 posts". */
export function counted(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
