import type { Lab, SearchHit, SearchResult } from '../protocol/api.ts';
import { callView, onBoard } from './call.ts';
import { clock } from './format.ts';
import { href } from './route.ts';

/** The API path of a search. */
export function searchPath(q: string): string {
  return `/api/v1/search?q=${encodeURIComponent(q)}`;
}

export function isSearchResult(value: unknown): value is SearchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hits' in value &&
    Array.isArray(value.hits) &&
    'note' in value &&
    typeof value.note === 'string'
  );
}

/** A Mac, or an iPhone or iPad with a keyboard: ⌘ is the command key there. */
export function isMac(platform: string): boolean {
  return /Mac|iPhone|iPad/i.test(platform);
}

/** This computer is a Mac, as the browser says. */
export const onMac =
  typeof navigator !== 'undefined' && isMac(navigator.platform);

/** The search key: its label, and its name for `aria-keyshortcuts`. */
export function searchKey(mac: boolean): {
  readonly label: string;
  readonly aria: string;
} {
  return mac
    ? { label: '⌘K', aria: 'Meta+K' }
    : { label: 'Ctrl+K', aria: 'Control+K' };
}

/**
 * ⌘K on a Mac, and Ctrl+K elsewhere, opens the search. In a text box,
 * Ctrl+K stays the box's own key, such as "delete to the end of the line",
 * so it opens nothing there. ⌘K never edits text, so it opens the search
 * from anywhere. As on the desk, the K is the letter that the keyboard
 * layout gives, and a layout without Latin letters uses the key's place.
 */
export function isSearchKey(
  event: {
    readonly key: string;
    readonly code: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
  },
  mac: boolean,
  typing: boolean,
): boolean {
  // Autofill can send a keydown without a key.
  const key = typeof event.key === 'string' ? event.key : '';
  const k = /^[a-z]$/i.test(key)
    ? key.toLowerCase() === 'k'
    : key.length === 1 && event.code === 'KeyK';
  if (!k || event.altKey || event.shiftKey) return false;
  return mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey && !typing;
}

/**
 * What opening a hit does, from what this page's snapshot holds. `go`: a
 * link to the hit's page. A post opens on the lab home's board, or on its
 * own page when the board leaves it out. A run opens on its direction's
 * page, and a call in its dialog. `read`: a call that the snapshot leaves
 * out shows its question and answer in the search, since its dialog could
 * not.
 */
export type HitAction =
  | { readonly type: 'go'; readonly route: string }
  | { readonly type: 'read' };

export function hitAction(hit: SearchHit, lab: Lab): HitAction {
  switch (hit.type) {
    case 'post':
      return {
        type: 'go',
        route: onBoard(lab, hit.id) ? href.board(hit.id) : href.post(hit.id),
      };
    case 'run':
      return { type: 'go', route: href.run(hit.direction, hit.id) };
    case 'call':
      return callView(lab, hit.id).kind === 'missing'
        ? { type: 'read' }
        : { type: 'go', route: href.call(hit.id) };
  }
}

/** Where a call that the snapshot leaves out stands: its answer and when, for its view in the search. */
export function callRead(hit: Extract<SearchHit, { type: 'call' }>): string {
  const { answer } = hit;
  const said =
    hit.state === 'open'
      ? 'It waits for your answer, but this view of a large lab leaves it out.'
      : hit.state === 'undoing'
        ? 'Verifold is undoing your answer.'
        : hit.state === 'withdrawn'
          ? 'Withdrawn.'
          : !answer
            ? 'Answered.'
            : 'option' in answer
              ? `You chose "${answer.option}" at ${clock(answer.at)}.`
              : `You answered in your own words: "${answer.words}"`;
  return hit.note ? `${said} ${hit.note}` : said;
}

/**
 * The hit that an arrow key moves to: -1 is the search box. Down from the
 * box goes to the first hit, and up from the first hit back to the box.
 */
export function nextHit(index: number, count: number, key: string): number {
  if (key === 'ArrowDown') return Math.min(count - 1, index + 1);
  if (key === 'ArrowUp') return Math.max(-1, index - 1);
  return index;
}
