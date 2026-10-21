import {
  protocolVersion,
  type ActionBodies,
  type ActionName,
  type ActionResult,
  type Snapshot,
} from '../protocol/api.ts';

/** The desk stores its token under this key too, so the desk and the app share one sign-in per tab. */
const tokenKey = 'verifold-desk-token';

function stored(): string | null {
  try {
    return sessionStorage.getItem(tokenKey);
  } catch {
    return null;
  }
}

function keep(token: string): void {
  try {
    sessionStorage.setItem(tokenKey, token);
  } catch {
    // Without storage the token lasts until the tab reloads.
  }
}

/**
 * The desk's access token. The URL fragment carries it, or a one-time launch
 * code that the desk exchanges for it, as on the desk's own page. The
 * fragment then becomes the app's route.
 */
export async function takeToken(): Promise<string | null> {
  const hash = location.hash.slice(1);
  if (/^[a-f0-9]{64}$/.test(hash)) {
    keep(hash);
    history.replaceState(null, '', `${location.pathname}#/`);
    return hash;
  }
  if (hash.startsWith('launch-')) {
    history.replaceState(null, '', `${location.pathname}#/`);
    const response = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: hash.slice(7) }),
    }).catch(() => null);
    const body: unknown = response?.ok ? await response.json() : null;
    if (
      typeof body === 'object' &&
      body !== null &&
      'token' in body &&
      typeof body.token === 'string' &&
      /^[a-f0-9]{64}$/.test(body.token)
    ) {
      keep(body.token);
      return body.token;
    }
  }
  return stored();
}

function isError(
  value: unknown,
): value is Extract<ActionResult, { error: string }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
  );
}

/** The server is Verifold itself. This check only catches a wrong endpoint or version. */
export function isSnapshot(value: unknown): value is Snapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocolVersion' in value &&
    value.protocolVersion === protocolVersion &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'rev' in value &&
    typeof value.rev === 'number'
  );
}

/** A random key, so a repeated action within a minute runs once. */
function actionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Run a lab action. Null when it ran or goes on in the background; else Verifold's reason. */
export async function act<Name extends ActionName>(
  token: string,
  name: Name,
  body: ActionBodies[Name],
): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/actions/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        name === 'lab-dismiss' || name === 'lab-away-dismiss'
          ? body
          : { ...body, key: actionKey() },
      ),
    });
    if (response.ok) return null;
    const result: unknown = await response.json().catch(() => null);
    return isError(result)
      ? result.error
      : 'Verifold could not run this. Try again.';
  } catch {
    return 'Verifold is not reachable. Check that it still runs.';
  }
}

export interface StreamEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

/**
 * Split Server-Sent Events text into whole events. Returns the events and
 * the unfinished rest. Comment lines, such as the heartbeat, are skipped.
 */
export function parseEvents(text: string): {
  readonly events: readonly StreamEvent[];
  readonly rest: string;
} {
  const blocks = text.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length) events.push({ event, data: data.join('\n'), id });
  }
  return { events, rest };
}

/** Read the event stream until it ends. Throws on a refused or broken stream. 401 throws `signedOut`. */
export async function readStream(
  token: string,
  signal: AbortSignal,
  onSnapshot: (snapshot: Snapshot) => void,
): Promise<void> {
  const response = await fetch('/api/v1/events', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal,
  });
  if (response.status === 401) throw signedOut;
  if (!response.ok || !response.body)
    throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseEvents(buffer);
    buffer = rest;
    for (const event of events) {
      if (event.event !== 'snapshot') continue;
      const snapshot: unknown = JSON.parse(event.data);
      if (!isSnapshot(snapshot)) throw new Error('Not a version 1 snapshot.');
      onSnapshot(snapshot);
    }
  }
}

/** The desk refused the token: the tab needs a new link from the terminal. */
export const signedOut = new Error('signed out');
