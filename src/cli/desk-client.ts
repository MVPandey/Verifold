import { requiredElement } from '../ui/dom.ts';

const main = requiredElement(document, '#content', HTMLElement);
const connectionLabel = requiredElement(document, '#connection', HTMLElement);
const observationLabel = requiredElement(document, '#observation', HTMLElement);
let selected: string | undefined;
let token = location.hash.slice(1);
try {
  if (/^[a-f0-9]{64}$/.test(token)) {
    sessionStorage.setItem('verifold-desk-token', token);
    history.replaceState(null, '', location.pathname);
  } else token = sessionStorage.getItem('verifold-desk-token') ?? '';
  selected = sessionStorage.getItem('verifold-desk-attempt') ?? undefined;
} catch {
  /* The original fragment still supports reload when storage is unavailable. */
}

let lastHtml = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let loading = false;
let stopped = false;
let request: AbortController | undefined;

async function refresh(): Promise<void> {
  if (loading || stopped) return;
  clearTimeout(timer);
  loading = true;
  const wanted = selected;
  request = new AbortController();
  const deadline = setTimeout(() => request?.abort(), 5000);
  try {
    const response = await fetch(
      `/api/view${wanted ? `?attempt=${encodeURIComponent(wanted)}` : ''}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: request.signal,
        cache: 'no-store',
      },
    );
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(
          'Open the full desk URL printed in your terminal to connect.',
        );
      if (response.status === 404 && wanted) {
        selected = undefined;
        throw new Error(
          'That attempt is no longer available. Refreshing the project.',
        );
      }
      throw new Error(
        'Project records are unavailable. Inspect the selected workspace, then refresh.',
      );
    }
    const view: unknown = await response.json();
    if (
      !view ||
      typeof view !== 'object' ||
      !('html' in view) ||
      typeof view.html !== 'string' ||
      !('observation' in view) ||
      typeof view.observation !== 'string'
    )
      throw new Error('The desk returned an unreadable view.');
    if (wanted !== selected || stopped) return;
    if (view.html !== lastHtml) {
      const open = new Set(
        Array.from(
          main.querySelectorAll('details[open]'),
          (element) => element.id,
        ),
      );
      const focused = document.activeElement;
      const focusId = focused instanceof HTMLElement ? focused.id : '';
      const focusDetail = focused?.matches('summary')
        ? focused.closest('details')?.id
        : undefined;
      const focusAttempt =
        focused instanceof HTMLElement ? focused.dataset.attempt : undefined;
      // This markup comes from the authenticated local renderer, which escapes research text.
      main.innerHTML = view.html;
      if (lastHtml)
        for (const detail of main.querySelectorAll('details'))
          detail.open = open.has(detail.id);
      if (focusAttempt)
        main
          .querySelector<HTMLButtonElement>(
            `[data-attempt="${CSS.escape(focusAttempt)}"]`,
          )
          ?.focus({ preventScroll: true });
      else if (focusId)
        document.getElementById(focusId)?.focus({ preventScroll: true });
      else if (focusDetail)
        document
          .getElementById(focusDetail)
          ?.querySelector('summary')
          ?.focus({ preventScroll: true });
      lastHtml = view.html;
    }
    observationLabel.textContent = view.observation;
    connectionLabel.textContent = 'Connected · updates automatically';
    document.body.dataset.connection = 'connected';
  } catch (error) {
    if (!stopped) {
      connectionLabel.textContent =
        error instanceof Error &&
        error.name !== 'AbortError' &&
        error.name !== 'TypeError'
          ? error.message
          : 'Disconnected · showing the last saved view. Reconnecting…';
      document.body.dataset.connection = 'disconnected';
    }
  } finally {
    clearTimeout(deadline);
    loading = false;
    if (!stopped)
      timer = setTimeout(
        () => {
          void refresh();
        },
        wanted !== selected ? 0 : 2000,
      );
  }
}

document.addEventListener('click', (event) => {
  const target =
    event.target instanceof Element
      ? event.target.closest('button, a.skip')
      : null;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches('a.skip')) {
    event.preventDefault();
    main.focus();
    return;
  }
  if (target.dataset.attempt) {
    selected = target.dataset.attempt;
    try {
      sessionStorage.setItem('verifold-desk-attempt', selected);
    } catch {
      /* Selection still lasts until reload when browser storage is unavailable. */
    }
    connectionLabel.textContent = 'Opening attempt…';
    void refresh();
  }
  if (target.id === 'retry') void refresh();
  if (target.id === 'theme') {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    target.textContent = dark ? 'Dark appearance' : 'Light appearance';
  }
  if (target.id === 'copy-command' && target.dataset.command) {
    void (
      navigator.clipboard
        ? navigator.clipboard.writeText(target.dataset.command)
        : Promise.reject(new Error('Clipboard unavailable'))
    )
      .then(() => {
        target.textContent = 'Copied';
      })
      .catch(() => {
        target.textContent = 'Select command to copy';
      });
  }
});
window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(timer);
  request?.abort();
});
window.addEventListener('pageshow', () => {
  if (stopped) {
    stopped = false;
    void refresh();
  }
});
void refresh();
