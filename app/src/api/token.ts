/** Where the app keeps the person's token for this tab. `sessionStorage` in the browser. */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'verifold-token';

/**
 * Return the person's token, and keep it for this tab.
 *
 * `verifold` prints a link with the token in the URL fragment, which the browser never sends to a server. The app
 * keeps the token in `store`, so a reload still works after the caller removes the fragment from the address bar.
 */
export function takeToken(hash: string, store: TokenStore): string | null {
  const fromLink = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (fromLink) {
    store.setItem(KEY, fromLink);
    return fromLink;
  }
  return store.getItem(KEY);
}
