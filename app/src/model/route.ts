/** The pages of the app, as the URL fragment names them. */
export type Route =
  | { readonly page: 'lab' }
  | { readonly page: 'needs' }
  | { readonly page: 'thread'; readonly id: string };

/** Return the page that a URL fragment names. Anything else is the lab page. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'needs') return { page: 'needs' };
  const id = /^thread\/(t-[1-9][0-9]*)$/.exec(path)?.[1];
  return id ? { page: 'thread', id } : { page: 'lab' };
}

/** Return the URL fragment of a page. */
export function href(route: Route): string {
  switch (route.page) {
    case 'lab':
      return '#/';
    case 'needs':
      return '#/needs';
    case 'thread':
      return `#/thread/${route.id}`;
  }
}
