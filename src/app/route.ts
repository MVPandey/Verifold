import { turnIdPattern } from '../protocol/api.ts';
import type { SetupPage } from './setup.ts';

/**
 * The app's pages, from the URL fragment. The lab home is `#/`, a direction
 * is `#/d/<id>`, one turn of its agent is `#/d/<id>/turn/<turn>`, a call
 * opens over the lab at `#/call/<id>`, the answer is `#/answer`, and a
 * direction's bring-in is `#/d/<id>/bring`. `#/board/<id>` is the lab home
 * with a post of its board brought into view, and `#/post/<id>` is a post's
 * own page, with its replies. `#/d/<id>/run/<run>` is a direction's page
 * with a run marked in the turn that started it. The first run is
 * `#/setup/<step>`, and `#/setup` opens its first step without a record.
 * `#/ask` asks the question of a new project, while Verifold runs without
 * one. Any other fragment is a page that does not exist.
 */
export type Route =
  | {
      readonly page: 'lab';
      /** A post of the board to bring into view. */
      readonly post?: string;
    }
  | {
      readonly page: 'direction';
      readonly direction: string;
      /** A run to bring into view. */
      readonly run?: string;
    }
  | {
      readonly page: 'turn';
      readonly direction: string;
      readonly turn: string;
    }
  | { readonly page: 'call'; readonly id: string }
  | { readonly page: 'post'; readonly id: string }
  | { readonly page: 'answer' }
  | { readonly page: 'bring'; readonly direction: string }
  | {
      readonly page: 'setup';
      /** Null: the first step without a record, or the end. */
      readonly step: SetupPage | null;
    }
  | { readonly page: 'ask' }
  | { readonly page: 'unknown' };

/** A direction ID, such as d-2. It starts with a letter or digit, so ".." is never one. */
const id = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '' || path === '/') return { page: 'lab' };
  const call = /^\/call\/(c-[1-9][0-9]{0,5})$/.exec(path);
  if (call?.[1]) return { page: 'call', id: call[1] };
  const board = /^\/board\/(p-[1-9][0-9]{0,5})$/.exec(path);
  if (board?.[1]) return { page: 'lab', post: board[1] };
  const post = /^\/post\/(p-[1-9][0-9]{0,5})$/.exec(path);
  if (post?.[1]) return { page: 'post', id: post[1] };
  const direction = new RegExp(`^/d/(${id})$`).exec(path);
  if (direction?.[1]) return { page: 'direction', direction: direction[1] };
  const bring = new RegExp(`^/d/(${id})/bring$`).exec(path);
  if (bring?.[1]) return { page: 'bring', direction: bring[1] };
  const run = new RegExp(`^/d/(${id})/run/(r-[1-9][0-9]{0,5})$`).exec(path);
  if (run?.[1] && run[2])
    return { page: 'direction', direction: run[1], run: run[2] };
  const turn = new RegExp(`^/d/(${id})/turn/([^/]{1,400})$`).exec(path);
  if (turn?.[1] && turn[2]) {
    const decoded = decode(turn[2]);
    return decoded && turnIdPattern.test(decoded)
      ? { page: 'turn', direction: turn[1], turn: decoded }
      : { page: 'unknown' };
  }
  if (path === '/answer') return { page: 'answer' };
  if (path === '/ask') return { page: 'ask' };
  if (path === '/setup') return { page: 'setup', step: null };
  const setup = /^\/setup\/(agents|about|skills|money|done)$/.exec(path)?.[1];
  if (setup) return { page: 'setup', step: setup as SetupPage };
  return { page: 'unknown' };
}

export const href = {
  lab: '#/',
  direction: (id: string): string => `#/d/${id}`,
  turn: (direction: string, turn: string): string =>
    `#/d/${direction}/turn/${encodeURIComponent(turn)}`,
  call: (id: string): string => `#/call/${id}`,
  answer: '#/answer',
  bring: (direction: string): string => `#/d/${direction}/bring`,
  board: (post: string): string => `#/board/${post}`,
  post: (id: string): string => `#/post/${id}`,
  run: (direction: string, run: string): string =>
    `#/d/${direction}/run/${run}`,
  setup: (step?: SetupPage): string => (step ? `#/setup/${step}` : '#/setup'),
  ask: '#/ask',
} as const;

/**
 * Go to `route` in place of this page in the history, as a redirect does:
 * Back skips the page that was left.
 */
export function replaceRoute(route: string): void {
  history.replaceState(
    null,
    '',
    `${location.pathname}${location.search}${route}`,
  );
  dispatchEvent(new HashChangeEvent('hashchange'));
}
