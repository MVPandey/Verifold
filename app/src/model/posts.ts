import type { PermissionShown, Post, PostRequest, QuestionShown, Standing } from '../api/types.ts';

/** The look of a standing's chip, as the stylesheet names it. */
export type ChipTone = 'ok' | 'hold' | 'dis' | 'con' | 'none';

export interface Chip {
  readonly label: string;
  readonly tone: ChipTone;
}

/** The most characters in a headline, as the server takes it. */
const HEADLINE_LIMIT = 1000;
const TITLE_LIMIT = 80;
const LIST_LIMIT = 200;

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

/** Return a headline as a list shows it: whole, or its first 200 characters. The post's thread shows all of it. */
export function clip(headline: string): string {
  return headline.length <= LIST_LIMIT ? headline : `${headline.slice(0, LIST_LIMIT - 1)}…`;
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
 * first. The answer also names the option as its `choice`, so Verifold can tell a press from words that only start
 * like an option. Words alone are the whole answer.
 */
export function personAnswer(ask: Post, choice: string | null, words: string): PostRequest | null {
  const typed = split(words);
  const text = choice ?? typed.headline;
  if (!text) return null;
  const body = choice ? words.trim() : typed.body;
  return {
    kind: 'answer',
    thread: ask.thread,
    reply_to: ask.id,
    text,
    ...(body ? { body } : {}),
    ...(choice ? { choice } : {}),
  };
}

/**
 * Return text in the parts that a box shows: each run of at least `least` blank lines as its length, and the text
 * between such runs as it is. A line with nothing but spaces and tabs is blank.
 *
 * A long run of blank lines can push the end of a command out of sight, so the box names the run instead.
 */
export function gaps(text: string, least = 5): readonly (string | number)[] {
  const parts: (string | number)[] = [];
  let kept: string[] = [];
  let blank: string[] = [];
  const close = (): void => {
    if (blank.length >= least) {
      if (kept.length > 0) parts.push(kept.join('\n'));
      parts.push(blank.length);
      kept = [];
    } else {
      kept.push(...blank);
    }
    blank = [];
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      blank.push(line);
    } else {
      close();
      kept.push(line);
    }
  }
  close();
  if (kept.length > 0) parts.push(kept.join('\n'));
  return parts;
}

/** The choices of an ask that belong together, under a label that says whose they are. */
export interface ChoiceGroup {
  readonly label: string | null;
  readonly options: readonly { readonly key: string; readonly label: string }[];
}

/**
 * Return the choices of an ask in groups: for a harness's request, the harness's own answers apart from Verifold's
 * grant, each group with its label, so the two never look the same. Each choice has a stable key.
 */
export function choiceGroups(
  choices: readonly string[],
  shown: PermissionShown | QuestionShown | null,
): readonly ChoiceGroup[] {
  const keyed = (labels: readonly string[], ids: readonly string[] = []): ChoiceGroup['options'] =>
    labels.map((label, index) => ({ key: `${index}:${ids[index] ?? label}`, label }));
  if (choices.length === 0) return [];
  // The ask about a request that is too long to show has Verifold's own choice only.
  if (shown === null || (shown.type === 'permission' && shown.notes.includes('too_long'))) {
    return [{ label: null, options: keyed(choices) }];
  }
  if (shown.type === 'question')
    return [{ label: 'The harness’s options', options: keyed(choices) }];
  const own = shown.grant === null ? choices : choices.slice(0, -1);
  const harness = { label: 'The harness’s answers', options: keyed(own, shown.ids) };
  if (shown.grant === null) return [harness];
  const grant = {
    label: 'Verifold’s grant for every agent',
    options: keyed(choices.slice(-1), ['grant']),
  };
  return own.length > 0 ? [harness, grant] : [grant];
}

/**
 * Return what an ask carries for its author's harness: a permission request, a question to its user, or nothing.
 *
 * Verifold records it on the ask, and no agent can. So an agent's own ask that only looks like one carries nothing.
 */
export function harnessRequest(post: Post): 'permission' | 'question' | null {
  return post.kind === 'ask' ? (post.request ?? null) : null;
}

/** Return whether an ask is a harness's permission request. */
export function isPermission(post: Post): boolean {
  return harnessRequest(post) === 'permission';
}
