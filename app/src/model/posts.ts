import type { Post, PostRequest, Standing } from '../api/types.ts';

/** The look of a standing's chip, as the stylesheet names it. */
export type ChipTone = 'ok' | 'hold' | 'dis' | 'con' | 'none';

export interface Chip {
  readonly label: string;
  readonly tone: ChipTone;
}

const HEADLINE_LIMIT = 300;
const TITLE_LIMIT = 80;

/** Return the chip that says where a post stands, or `null` when there is nothing to say. Results always get one. */
export function standingChip(post: Post, standing: Standing): Chip | null {
  switch (standing) {
    case 'disputed':
      return { label: 'Disputed', tone: 'dis' };
    case 'conceded':
      return { label: 'Conceded', tone: 'con' };
    case 'held_up':
      return { label: 'Held up', tone: 'hold' };
    case 'checked':
      return { label: 'Checked', tone: 'ok' };
    case 'open':
      return post.kind === 'result' ? { label: 'Not checked', tone: 'none' } : null;
  }
}

/** Return the words that say how many posts build on a post, or `null` when none does. */
export function builtOnLabel(builtOnBy: readonly string[]): string | null {
  if (builtOnBy.length === 0) return null;
  return builtOnBy.length === 1 ? 'Built on by 1 post' : `Built on by ${builtOnBy.length} posts`;
}

/** Split the person's text into a headline and a body. The first line is the headline. */
export function split(text: string): { readonly headline: string; readonly body: string } {
  const trimmed = text.trim();
  const [first = '', ...rest] = trimmed.split('\n');
  const headline = first.trim();
  if (headline.length <= HEADLINE_LIMIT) return { headline, body: rest.join('\n').trim() };
  return { headline: `${headline.slice(0, HEADLINE_LIMIT - 1)}…`, body: trimmed };
}

/** Return a thread title from a headline: the headline itself, or its words up to about 80 characters. */
export function titleOf(headline: string): string {
  if (headline.length <= TITLE_LIMIT) return headline;
  const cut = headline.slice(0, TITLE_LIMIT - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * Return the post that sends the person's text to the agents, or `null` for empty text.
 *
 * In a thread the post goes to the thread. Without one, it opens a new thread. A post from the person that names
 * nobody is for every agent.
 */
export function personMessage(text: string, thread?: string): PostRequest | null {
  const { headline, body } = split(text);
  if (!headline) return null;
  const place = thread ? { thread } : { new_thread: titleOf(headline) };
  return { kind: 'message', text: headline, ...(body ? { body } : {}), ...place };
}

/**
 * Return the person's answer to an ask, or `null` when they gave no choice and no words.
 *
 * A chosen option is the headline and the person's words become the body, so an agent's harness reads the option
 * first. Words alone are the whole answer.
 */
export function personAnswer(ask: Post, choice: string | null, words: string): PostRequest | null {
  const typed = split(words);
  const text = choice ?? typed.headline;
  if (!text) return null;
  const body = choice ? words.trim() : typed.body;
  return { kind: 'answer', thread: ask.thread, reply_to: ask.id, text, ...(body ? { body } : {}) };
}

/** Return whether an ask is a harness's permission request, which pauses its agent until the person answers. */
export function isPermission(post: Post): boolean {
  return post.kind === 'ask' && post.text.startsWith('Permission needed:');
}
