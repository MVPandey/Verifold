/**
 * The app's pages, from the URL fragment. The lab home is `#/`, and a call
 * opens over it at `#/call/<id>`. The pages that later slices of #282 build
 * (a direction, the answer, the first run) show a short "comes in a later
 * step" page until then. Any other fragment is a page that does not exist.
 */
export type LaterPage = 'direction' | 'answer' | 'first-run';

export type Route =
  | { readonly page: 'lab' }
  | { readonly page: 'call'; readonly id: string }
  | { readonly page: LaterPage }
  | { readonly page: 'unknown' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '' || path === '/') return { page: 'lab' };
  const call = /^\/call\/(c-[1-9][0-9]{0,5})$/.exec(path);
  if (call?.[1]) return { page: 'call', id: call[1] };
  const match = /^\/(d)\/[A-Za-z0-9._-]{1,100}$/.exec(path);
  if (match) return { page: 'direction' };
  if (path === '/answer') return { page: 'answer' };
  if (path === '/first-run') return { page: 'first-run' };
  return { page: 'unknown' };
}

export const href = {
  lab: '#/',
  direction: (id: string): string => `#/d/${id}`,
  call: (id: string): string => `#/call/${id}`,
} as const;
