import { turnIdPattern } from '../protocol/api.ts';

/**
 * The app's pages, from the URL fragment. The lab home is `#/`, a direction
 * is `#/d/<id>`, one turn of its agent is `#/d/<id>/turn/<turn>`, a call
 * opens over the lab at `#/call/<id>`, the answer is `#/answer`, and a
 * direction's bring-in is `#/d/<id>/bring`. The page that a later slice of
 * #282 builds (the first run) shows a short "comes in a later step" page
 * until then. Any other fragment is a page that does not exist.
 */
export type LaterPage = 'first-run';

export type Route =
  | { readonly page: 'lab' }
  | { readonly page: 'direction'; readonly direction: string }
  | {
      readonly page: 'turn';
      readonly direction: string;
      readonly turn: string;
    }
  | { readonly page: 'call'; readonly id: string }
  | { readonly page: 'answer' }
  | { readonly page: 'bring'; readonly direction: string }
  | { readonly page: 'first-run' }
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
  const direction = new RegExp(`^/d/(${id})$`).exec(path);
  if (direction?.[1]) return { page: 'direction', direction: direction[1] };
  const bring = new RegExp(`^/d/(${id})/bring$`).exec(path);
  if (bring?.[1]) return { page: 'bring', direction: bring[1] };
  const turn = new RegExp(`^/d/(${id})/turn/([^/]{1,400})$`).exec(path);
  if (turn?.[1] && turn[2]) {
    const decoded = decode(turn[2]);
    return decoded && turnIdPattern.test(decoded)
      ? { page: 'turn', direction: turn[1], turn: decoded }
      : { page: 'unknown' };
  }
  if (path === '/answer') return { page: 'answer' };
  if (path === '/first-run') return { page: 'first-run' };
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
} as const;
