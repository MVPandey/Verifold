/**
 * The desk's access token in the browser. The terminal prints a URL whose
 * fragment holds the token, or a one-time launch code that the page
 * exchanges for it. A tab keeps the token in sessionStorage. The desk page,
 * its terminal page, and the new app share this module and this key.
 */
const key = 'verifold-desk-token';
const tokenShape = /^[a-f0-9]{64}$/;

/** This tab's token, or '' without one or without storage. */
export function storedToken(): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function keep(token: string): void {
  try {
    sessionStorage.setItem(key, token);
  } catch {
    // Without storage the token lasts until the tab reloads.
  }
}

/**
 * Read the URL fragment once, at load. A token is kept. A launch code comes
 * back to exchange. Either way the fragment becomes `fragment`, so the
 * secret leaves the address bar and the history.
 */
export function readFragment(fragment: string): {
  readonly token: string;
  readonly launch: string;
} {
  const hash = location.hash.slice(1);
  const launch = hash.startsWith('launch-') ? hash.slice(7) : '';
  if (tokenShape.test(hash)) keep(hash);
  if (launch || tokenShape.test(hash))
    history.replaceState(null, '', `${location.pathname}${fragment}`);
  return { token: storedToken(), launch };
}

/**
 * Exchange a launch code for the token, and keep it. Null when the code is
 * spent or unknown, when the desk is not reachable, or when the answer is cut
 * off: the full URL that the terminal printed still connects.
 */
export async function exchangeLaunch(code: string): Promise<string | null> {
  try {
    const response = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
    const reply: unknown = await response.json().catch(() => null);
    if (
      response.ok &&
      typeof reply === 'object' &&
      reply !== null &&
      'token' in reply &&
      typeof reply.token === 'string' &&
      tokenShape.test(reply.token)
    ) {
      keep(reply.token);
      return reply.token;
    }
  } catch {
    // The desk is not reachable.
  }
  return null;
}
