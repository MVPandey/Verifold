/** The pages of the app, as the URL fragment names them. */
export type Route =
  | { readonly page: 'lab' }
  | { readonly page: 'needs' }
  | { readonly page: 'settings' }
  /** One file that backs a post, as a page. */
  | { readonly page: 'file'; readonly post: string; readonly path: string }
  /** The lab page with one thread open. `post` is the post to scroll to, or `null` for the thread's top. */
  | { readonly page: 'thread'; readonly id: string; readonly post: string | null };

/** Return the page that a URL fragment names. Anything else is the lab page. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'needs') return { page: 'needs' };
  if (path === 'settings') return { page: 'settings' };
  const [, filePost, filePath] = /^file\/(p-[1-9][0-9]*)\/(.+)$/.exec(path) ?? [];
  if (filePost && filePath) return { page: 'file', post: filePost, path: decode(filePath) };
  const [, id, post] = /^thread\/(t-[1-9][0-9]*)(?:\/(p-[1-9][0-9]*))?$/.exec(path) ?? [];
  return id ? { page: 'thread', id, post: post ?? null } : { page: 'lab' };
}

/** Return the URL fragment of a page. */
export function href(route: Route): string {
  switch (route.page) {
    case 'lab':
      return '#/';
    case 'needs':
      return '#/needs';
    case 'settings':
      return '#/settings';
    case 'file':
      return `#/file/${route.post}/${encodeURIComponent(route.path)}`;
    case 'thread':
      return route.post ? `#/thread/${route.id}/${route.post}` : `#/thread/${route.id}`;
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
