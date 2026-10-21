import type { SearchHit, SearchResult } from '../protocol/api.ts';
import { href } from './route.ts';

/** Characters of a search, as the API takes them. */
export const searchMax = 100;

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

/** ⌘K, or Ctrl+K off a Mac, opens the search from anywhere in the app. */
export function isSearchKey(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'k'
  );
}

/** The search key as the person's keyboard writes it. */
export function searchKeyLabel(platform: string): string {
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘K' : 'Ctrl+K';
}

/**
 * What opening a hit does. `go`: the app shows a page, and for a post on
 * the lab home's board, scrolls to it. `read`: an older post that the board
 * does not show opens its whole text in the search itself.
 */
export type HitAction =
  | {
      readonly type: 'go';
      readonly route: string;
      readonly post: string | null;
    }
  | { readonly type: 'read' };

export function hitAction(
  hit: SearchHit,
  board: ReadonlySet<string>,
): HitAction {
  switch (hit.type) {
    case 'post':
      return board.has(hit.id)
        ? { type: 'go', route: href.lab, post: hit.id }
        : { type: 'read' };
    case 'run':
      return { type: 'go', route: href.direction(hit.direction), post: null };
    case 'call':
      return { type: 'go', route: href.call(hit.id), post: null };
  }
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
