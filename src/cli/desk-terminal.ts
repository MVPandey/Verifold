import { Terminal } from './vendor/xterm.js';
import { FitAddon } from './vendor/addon-fit.js';
import { viewLease } from './desk-lease.ts';

/**
 * The terminal page: one harness terminal in xterm.js. It reads output from
 * the owner with long polls and sends input only while this view holds the
 * input lease. Terminal output is untrusted; xterm renders it as terminal
 * text, never as HTML.
 */

const screen = document.getElementById('terminal');
const state = document.getElementById('terminal-state');
const take = document.getElementById('terminal-take');
const session = new URLSearchParams(location.search).get('session') ?? '';
let token = '';
try {
  token = sessionStorage.getItem('verifold-desk-token') ?? '';
} catch {
  /* Without the token, the page says how to reconnect. */
}
const lease = viewLease();

if (
  !(screen instanceof HTMLElement) ||
  !(state instanceof HTMLElement) ||
  !(take instanceof HTMLButtonElement)
)
  throw new Error('The terminal page is incomplete.');

const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  scrollback: 5000,
  theme: { background: '#121016', foreground: '#ece8f3', cursor: '#c5a7ff' },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(screen);

let owner: string | null = null;
let ended = false;
let pending = '';
let flushing: ReturnType<typeof setTimeout> | undefined;

function show(text: string, canTake: boolean): void {
  if (!(state instanceof HTMLElement) || !(take instanceof HTMLButtonElement))
    return;
  state.textContent = text;
  take.hidden = !canTake;
}

function showOwner(): void {
  if (ended)
    show('The terminal has ended. Verifold continues the session.', false);
  else if (owner === lease) show('You hold input in this view.', false);
  else if (owner)
    show('Another view holds input. This view is read-only.', true);
  else show('Nobody holds input.', true);
}

async function post(body: Record<string, unknown>): Promise<void> {
  const response = await fetch('/api/terminal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session, lease, ...body }),
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const reply = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    throw new Error(
      typeof reply?.error === 'string'
        ? reply.error
        : 'The terminal did not accept that.',
    );
  }
}

/** Keystrokes go out in small batches, so one fast typist makes few requests. */
function flush(): void {
  flushing = undefined;
  const data = pending;
  pending = '';
  if (data)
    post({ input: data }).catch((error: unknown) =>
      show(
        error instanceof Error ? error.message : 'Input failed.',
        owner !== lease,
      ),
    );
}

terminal.onData((data) => {
  if (owner !== lease || ended) {
    showOwner();
    return;
  }
  pending += data;
  flushing ??= setTimeout(flush, 15);
});

function resize(): void {
  fit.fit();
  if (owner === lease && !ended)
    post({ cols: terminal.cols, rows: terminal.rows }).catch(() => {});
}
new ResizeObserver(() => resize()).observe(screen);

take.addEventListener('click', () => {
  fit.fit();
  post({ take: true, cols: terminal.cols, rows: terminal.rows })
    .then(() => {
      owner = lease;
      showOwner();
      terminal.focus();
    })
    .catch((error: unknown) =>
      show(error instanceof Error ? error.message : 'Input failed.', true),
    );
});

/** Read output from `after`. The owner answers at once when there is new output, or after a short wait. */
async function read(after: number): Promise<void> {
  if (!token) {
    show('Open the terminal from the desk, so this page can connect.', false);
    return;
  }
  let next = after;
  try {
    const response = await fetch(
      `/api/terminal?${new URLSearchParams({ session, after: String(after) }).toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 404) {
      ended = true;
      showOwner();
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const output = (await response.json()) as Record<string, unknown>;
    if (typeof output.next !== 'number' || typeof output.data !== 'string')
      throw new Error('Unreadable output.');
    if (output.cut === true && after > 0)
      terminal.write(
        '\r\n\x1b[2m[Verifold: older output is no longer kept]\x1b[0m\r\n',
      );
    terminal.write(output.data);
    next = output.next;
    owner = typeof output.owner === 'string' ? output.owner : null;
    ended = output.exited !== null && output.exited !== undefined;
    showOwner();
    if (ended) return;
  } catch {
    show('Not connected. Trying again…', false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  void read(next);
}

resize();
void read(0);
