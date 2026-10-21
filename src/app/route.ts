/**
 * The app's pages, from the URL fragment. The lab home is `#/`. Pages that
 * later slices build (#282) show a short "comes later" page until then.
 */
export type Route =
  | { readonly page: 'lab' }
  | {
      readonly page: 'direction' | 'call' | 'run' | 'proof';
      readonly id: string;
    }
  | { readonly page: 'answer' | 'search' | 'projects' | 'unknown' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '' || path === '/') return { page: 'lab' };
  const match = /^\/(d|call|run|proof)\/([A-Za-z0-9._-]{1,100})$/.exec(path);
  if (match) {
    const [, kind = '', id = ''] = match;
    const page =
      kind === 'd'
        ? 'direction'
        : kind === 'call'
          ? 'call'
          : kind === 'run'
            ? 'run'
            : 'proof';
    return { page, id };
  }
  if (path === '/answer') return { page: 'answer' };
  if (path === '/search') return { page: 'search' };
  if (path === '/projects') return { page: 'projects' };
  return { page: 'unknown' };
}

export const href = {
  lab: '#/',
  direction: (id: string): string => `#/d/${id}`,
  call: (id: string): string => `#/call/${id}`,
  run: (id: string): string => `#/run/${id}`,
  proof: (id: string): string => `#/proof/${id}`,
  answer: '#/answer',
  search: '#/search',
  projects: '#/projects',
} as const;
