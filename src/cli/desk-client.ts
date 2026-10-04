import DOMPurify from './vendor/purify.js';
import { requiredElement } from '../ui/dom.ts';
import { mountTranscripts, refreshTranscripts } from './desk-transcript.ts';
import { mountTerminals, placeTerminals } from './desk-terminals.ts';
import { viewLease } from './desk-lease.ts';

const main = requiredElement(document, '#content', HTMLElement);
const connectionLabel = requiredElement(document, '#connection', HTMLElement);
const observationLabel = requiredElement(document, '#observation', HTMLElement);
const actionLabel = requiredElement(document, '#action-status', HTMLElement);
let selected: string | undefined;
let selectedTask: string | undefined;
let selectedWorker: string | undefined;
/** The diff that the review pane shows, kept across page renders. */
let shownDiff:
  | {
      readonly task: string;
      readonly version: string;
      readonly file: string;
      readonly text: string;
      readonly cut: boolean;
    }
  | undefined;
let detail = 'summary';
/** The view of the selected worker: summary, details, or terminal. */
let pane = 'summary';
let token = location.hash.slice(1);
const launch = token.startsWith('launch-') ? token.slice(7) : '';
try {
  if (/^[a-f0-9]{64}$/.test(token)) {
    sessionStorage.setItem('verifold-desk-token', token);
    history.replaceState(null, '', location.pathname);
  } else token = sessionStorage.getItem('verifold-desk-token') ?? '';
  selected = sessionStorage.getItem('verifold-desk-attempt') ?? undefined;
  selectedTask = sessionStorage.getItem('verifold-desk-task') ?? undefined;
  selectedWorker = sessionStorage.getItem('verifold-desk-worker') ?? undefined;
  detail = localStorage.getItem('verifold-desk-detail') ?? 'summary';
  pane = localStorage.getItem('verifold-desk-pane') ?? 'summary';
} catch {
  /* The original fragment still supports reload when storage is unavailable. */
}

let lastHtml = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let loading = false;
let stopped = false;
let request: AbortController | undefined;
/** The last failed action, shown beside its control until the next action succeeds. */
let failure:
  | { readonly selector: string; readonly message: string }
  | undefined;

/** Details shows the harness transcripts. The choice lasts for this browser. */
function showDetail(): void {
  document.body.dataset.detail = detail;
  document.body.dataset.pane = pane;
  for (const button of main.querySelectorAll<HTMLElement>('[data-detail]'))
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.detail === detail),
    );
  for (const button of main.querySelectorAll<HTMLElement>('[data-pane]'))
    button.setAttribute('aria-pressed', String(button.dataset.pane === pane));
}

function showFailure(): void {
  main.querySelector('.action-error')?.remove();
  const control = failure ? main.querySelector(failure.selector) : null;
  if (!failure || !control) return;
  const note = document.createElement('p');
  note.className = 'action-error';
  note.textContent = failure.message;
  (control.closest('.actions') ?? control).after(note);
}

async function refresh(): Promise<void> {
  if (loading || stopped) return;
  clearTimeout(timer);
  loading = true;
  const wanted = selected;
  const wantedTask = selectedTask;
  request = new AbortController();
  const deadline = setTimeout(() => request?.abort(), 5000);
  const query = new URLSearchParams();
  if (wanted) query.set('attempt', wanted);
  if (wantedTask) query.set('task', wantedTask);
  // A worker that left its slot is not an error. The server shows another one.
  if (selectedWorker) query.set('worker', selectedWorker);
  try {
    const response = await fetch(
      `/api/view${query.size ? `?${query.toString()}` : ''}`,
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
      if (response.status === 404 && (wanted || wantedTask)) {
        selected = undefined;
        selectedTask = undefined;
        throw new Error(
          'That attempt or task is no longer available. Refreshing the project.',
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
    if (wanted !== selected || wantedTask !== selectedTask || stopped) return;
    if (view.html !== lastHtml) {
      // Transcript panels keep their own open calls. Only page sections are restored here.
      const open = new Set(
        Array.from(
          main.querySelectorAll('details[id][open]'),
          (element) => element.id,
        ),
      );
      const focused = document.activeElement;
      const inPanel =
        focused instanceof HTMLElement && focused.closest('.transcript')
          ? focused
          : null;
      const focusId = focused instanceof HTMLElement ? focused.id : '';
      const focusDetail = focused?.matches('summary')
        ? focused.closest('details')?.id
        : undefined;
      const focusAttempt =
        focused instanceof HTMLElement ? focused.dataset.attempt : undefined;
      // Keep the files that the person selected for Accept.
      const checked = new Map(
        Array.from(
          main.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id]'),
          (box) => [box.id, box.checked],
        ),
      );
      // Keep text that the person typed while the view refreshes.
      const typed = new Map(
        Array.from(
          main.querySelectorAll<
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          >('input[id], textarea[id], select[id]'),
          (field) => [field.id, field.value],
        ),
      );
      const caret =
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLInputElement
          ? [focused.selectionStart, focused.selectionEnd]
          : undefined;
      // The local renderer escapes research text. Harness Markdown is sanitized
      // again in an inert template, before it reaches the live page.
      const template = document.createElement('template');
      template.innerHTML = view.html;
      for (const fragment of template.content.querySelectorAll('.md'))
        fragment.innerHTML = DOMPurify.sanitize(fragment.innerHTML, {
          ADD_ATTR: ['target'],
        });
      main.replaceChildren(template.content);
      showFailure();
      showDetail();
      for (const [id, value] of typed) {
        const field = document.getElementById(id);
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field instanceof HTMLSelectElement
        )
          field.value = value;
      }
      if (lastHtml)
        for (const detail of main.querySelectorAll<HTMLDetailsElement>(
          'details[id]',
        ))
          detail.open = open.has(detail.id);
      for (const [id, value] of checked) {
        const box = document.getElementById(id);
        if (box instanceof HTMLInputElement && !box.disabled)
          box.checked = value;
      }
      showReview();
      mountTranscripts(main, () => token);
      mountTerminals(main);
      inPanel?.focus({ preventScroll: true });
      if (focusAttempt)
        main
          .querySelector<HTMLButtonElement>(
            `[data-attempt="${CSS.escape(focusAttempt)}"]`,
          )
          ?.focus({ preventScroll: true });
      else if (focusId) {
        const field = document.getElementById(focusId);
        field?.focus({ preventScroll: true });
        if (
          caret &&
          (field instanceof HTMLTextAreaElement ||
            field instanceof HTMLInputElement)
        )
          field.setSelectionRange(caret[0] ?? null, caret[1] ?? null);
      } else if (focusDetail)
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
        wanted !== selected || wantedTask !== selectedTask ? 0 : 2000,
      );
  }
}

function field(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
    ? element.value
    : '';
}

/** The Accept button counts the selected files. The diff pane shows the chosen file. */
function showReview(): void {
  const accept = main.querySelector<HTMLButtonElement>(
    '[data-action="task-accept"]',
  );
  if (accept) {
    const count = main.querySelectorAll('input[data-file]:checked').length;
    accept.textContent = `Accept ${count} ${count === 1 ? 'file' : 'files'}`;
    accept.disabled = count === 0;
  }
  const pane = main.querySelector<HTMLElement>('.diff-pane');
  if (
    !pane ||
    !shownDiff ||
    pane.dataset.task !== shownDiff.task ||
    pane.dataset.version !== shownDiff.version
  )
    return;
  for (const button of main.querySelectorAll<HTMLElement>('[data-diff]'))
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.diff === shownDiff.file),
    );
  const head = document.createElement('p');
  head.className = 'diff-head';
  const name = document.createElement('code');
  name.textContent = shownDiff.file;
  head.append(name);
  const pre = document.createElement('pre');
  pre.className = 'diff';
  for (const line of shownDiff.text.split('\n')) {
    const row = document.createElement('span');
    row.className = line.startsWith('@@')
      ? 'd-hunk'
      : line.startsWith('+++') || line.startsWith('---')
        ? 'd-meta'
        : line.startsWith('+')
          ? 'd-add'
          : line.startsWith('-')
            ? 'd-del'
            : '';
    row.textContent = `${line}\n`;
    pre.append(row);
  }
  pane.replaceChildren(head, pre);
  if (shownDiff.cut) {
    const note = document.createElement('p');
    note.className = 'fine';
    note.textContent = 'The diff is cut at 512 KB.';
    pane.append(note);
  }
}

/** Load the diff of one file in a version into the review pane. */
async function loadDiff(button: HTMLElement): Promise<void> {
  const task = button.dataset.task ?? '';
  const version = button.dataset.version ?? '';
  const file = button.dataset.diff ?? '';
  try {
    const response = await fetch(
      `/api/task-diff?${new URLSearchParams({ task, version, file }).toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    const reply = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof reply.text !== 'string')
      throw new Error(
        typeof reply.error === 'string' ? reply.error : 'No diff.',
      );
    shownDiff = {
      task,
      version,
      file,
      text: reply.text,
      cut: reply.cut === true,
    };
    showReview();
  } catch (error) {
    actionLabel.textContent =
      error instanceof Error && error.name !== 'TimeoutError'
        ? error.message
        : 'The desk did not answer. Check that Verifold still runs in your terminal.';
  }
}

/** The fields of a task form. */
function taskBody(prefix: string): Record<string, unknown> {
  const form = document.getElementById(prefix);
  return {
    title: field(`${prefix}-title`),
    objective: field(`${prefix}-objective`),
    inputs: field(`${prefix}-inputs`),
    writable: field(`${prefix}-writable`),
    output: field(`${prefix}-output`),
    host: field(`${prefix}-host`),
    model: field(`${prefix}-model`).trim(),
    minutes: field(`${prefix}-minutes`),
    network: {
      domains: field(`${prefix}-network`),
      reason: field(`${prefix}-network-reason`),
    },
    dependencies: Array.from(
      form?.querySelectorAll<HTMLInputElement>('input[data-dep]:checked') ?? [],
      (box) => box.dataset.dep,
    ),
  };
}

/** The request for one task button. */
function taskRequest(button: HTMLElement): Record<string, unknown> {
  const action = button.dataset.action ?? '';
  const task = button.dataset.task;
  const version = Number(button.dataset.version);
  switch (action) {
    case 'task-create':
      return { action, ...taskBody('task-new') };
    case 'task-edit':
      return {
        action,
        task,
        reason: field('task-edit-reason'),
        ...taskBody('task-edit'),
      };
    case 'task-changes':
      return { action, task, note: field('task-note') };
    case 'task-accept':
      return {
        action,
        task,
        version,
        files: Array.from(
          main.querySelectorAll<HTMLInputElement>('input[data-file]:checked'),
          (box) => box.dataset.file,
        ),
      };
    case 'task-reject':
      return { action, task, version };
    case 'task-message':
      return { action, to: button.dataset.to, text: field('task-message') };
    case 'coordinator-start':
      return {
        action,
        objective: field('coordinator-objective'),
        host: field('coordinator-host'),
        model: field('coordinator-model').trim(),
      };
    case 'coordinator-message':
      return { action, text: field('coordinator-message') };
    case 'task-decide':
      return {
        action,
        message: button.dataset.message,
        decision: button.dataset.decision,
        reason: field(`decide-${button.dataset.message ?? ''}`),
      };
    default:
      return { action, task };
  }
}

/** The answer to the open setup question. */
function setupBody(button: HTMLElement): Record<string, unknown> {
  const prompt = Number(button.dataset.prompt);
  const review = button.dataset.review;
  if (review)
    return {
      action: 'setup',
      prompt,
      value:
        review === 'feedback'
          ? { action: review, text: field('setup-feedback') }
          : review === 'edit'
            ? { action: review, brief: field('setup-edited') }
            : { action: review },
    };
  return {
    action: 'setup',
    prompt,
    value:
      button.dataset.value ??
      (button.dataset.field ? field(button.dataset.field) : ''),
  };
}

/** The research request for one decision button. */
function researchBody(kind: string | undefined): Record<string, unknown> {
  if (kind === 'approve') return { action: 'research', approve: true };
  if (kind === 'feedback')
    return { action: 'research', feedback: field('research-feedback') };
  if (kind !== 'start') return { action: 'research' };
  const guided = document.getElementById('research-guided');
  return {
    action: 'research',
    topic: field('research-topic'),
    autonomy:
      guided instanceof HTMLInputElement && !guided.checked
        ? 'autonomous'
        : 'guided',
  };
}

/** Send one session action. The server owns validation and the session state. */
async function act(button: HTMLElement): Promise<void> {
  const action = button.dataset.action;
  const body =
    action === 'start'
      ? {
          action,
          host: field('session-host'),
          mode: field('session-mode'),
          model: field('session-model').trim(),
          prompt: field('session-prompt'),
        }
      : action === 'send'
        ? { action, session: button.dataset.session, text: field('follow-up') }
        : action === 'cancel' ||
            action === 'end' ||
            action === 'terminal-return'
          ? { action, session: button.dataset.session }
          : action === 'terminal-open'
            ? { action, session: button.dataset.session, lease: viewLease() }
            : action === 'answer'
              ? {
                  action,
                  request: button.dataset.request,
                  decision: button.dataset.decision,
                }
              : action === 'review'
                ? { action, command: button.dataset.command }
                : action === 'resume' || action === 'restart'
                  ? { action, session: button.dataset.session }
                  : action === 'select'
                    ? { action, idea: button.dataset.idea }
                    : action === 'research'
                      ? researchBody(button.dataset.research)
                      : action === 'setup'
                        ? setupBody(button)
                        : action?.startsWith('task-') ||
                            action?.startsWith('coordinator-')
                          ? taskRequest(button)
                          : { action };
  const selector = [
    ['action', action],
    ['request', button.dataset.request],
    ['command', button.dataset.command],
    ['session', button.dataset.session],
    ['idea', button.dataset.idea],
    ['research', button.dataset.research],
    ['prompt', button.dataset.prompt],
    ['review', button.dataset.review],
    ['task', button.dataset.task],
    ['version', button.dataset.version],
    ['message', button.dataset.message],
    ['decision', button.dataset.decision],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `[data-${key}="${CSS.escape(value ?? '')}"]`)
    .join('');
  if (button instanceof HTMLButtonElement) button.disabled = true;
  actionLabel.textContent = 'Sending…';
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const reply: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        reply &&
        typeof reply === 'object' &&
        'error' in reply &&
        typeof reply.error === 'string'
          ? reply.error
          : 'The action failed. Refresh and try again.',
      );
    actionLabel.textContent = 'Done';
    failure = undefined;
    for (const id of [
      'session-prompt',
      'follow-up',
      'research-feedback',
      'setup-answer',
      'setup-feedback',
      'task-note',
      'task-edit-reason',
      'task-message',
      'coordinator-message',
      ...(body.action === 'task-create'
        ? ['title', 'objective', 'inputs', 'writable', 'output'].map(
            (name) => `task-new-${name}`,
          )
        : []),
    ]) {
      const element = document.getElementById(id);
      if (
        (element instanceof HTMLTextAreaElement ||
          element instanceof HTMLInputElement) &&
        body.action !== 'answer'
      )
        element.value = '';
    }
  } catch (error) {
    actionLabel.textContent =
      error instanceof Error && error.name !== 'TimeoutError'
        ? error.message
        : 'The desk did not answer. Check that Verifold still runs in your terminal.';
    failure = { selector, message: actionLabel.textContent };
  } finally {
    showFailure();
    if (button instanceof HTMLButtonElement) button.disabled = false;
    void refresh();
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
  if (target.dataset.taskSelect) {
    selectedTask = target.dataset.taskSelect;
    try {
      sessionStorage.setItem('verifold-desk-task', selectedTask);
    } catch {
      /* Selection still lasts until reload when browser storage is unavailable. */
    }
    connectionLabel.textContent = 'Opening task…';
    void refresh();
  }
  if (target.dataset.diff) void loadDiff(target);
  if (target.dataset.pane) {
    pane = ['details', 'terminal'].includes(target.dataset.pane)
      ? target.dataset.pane
      : 'summary';
    showDetail();
    placeTerminals();
    refreshTranscripts();
    try {
      localStorage.setItem('verifold-desk-pane', pane);
    } catch {
      /* The choice lasts until reload when browser storage is unavailable. */
    }
  }
  // A new tab gets its own input lease, so it starts read-only. It keeps this tab's session storage.
  if (target.dataset.terminalTab)
    window.open(
      `/terminal?session=${encodeURIComponent(target.dataset.terminalTab)}`,
    );
  if (target.dataset.worker) {
    selectedWorker = target.dataset.worker;
    try {
      sessionStorage.setItem('verifold-desk-worker', selectedWorker);
    } catch {
      /* Selection still lasts until reload when browser storage is unavailable. */
    }
    void refresh();
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
  if (target.dataset.detail) {
    detail = target.dataset.detail === 'details' ? 'details' : 'summary';
    showDetail();
    refreshTranscripts();
    try {
      localStorage.setItem('verifold-desk-detail', detail);
    } catch {
      /* The choice lasts until reload when browser storage is unavailable. */
    }
  }
  // An action that cannot be undone needs a second click within five seconds.
  if (target.dataset.confirm && !target.dataset.armed) {
    target.dataset.armed = target.textContent ?? '';
    target.textContent = target.dataset.confirm;
    setTimeout(() => {
      if (target.dataset.armed !== undefined) {
        target.textContent = target.dataset.armed;
        delete target.dataset.armed;
      }
    }, 5000);
    return;
  }
  if (target.dataset.action) void act(target);
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
main.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.dataset.file)
    showReview();
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

/** Exchange the one-time launch code for the access token, then load the desk. */
async function connect(): Promise<void> {
  if (launch) {
    history.replaceState(null, '', location.pathname);
    try {
      const response = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: launch }),
        cache: 'no-store',
      });
      const reply: unknown = await response.json();
      if (
        response.ok &&
        reply &&
        typeof reply === 'object' &&
        'token' in reply &&
        typeof reply.token === 'string'
      ) {
        token = reply.token;
        sessionStorage.setItem('verifold-desk-token', token);
      }
    } catch {
      /* The full URL printed in the terminal still connects. */
    }
  }
  await refresh();
}
void connect();
