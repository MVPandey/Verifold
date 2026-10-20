import DOMPurify from './vendor/purify.js';
import { Idiomorph } from './vendor/idiomorph.js';
import { requiredElement } from '../ui/dom.ts';
import { mountTranscripts, refreshTranscripts } from './desk-transcript.ts';
import { mountTerminals, placeTerminals } from './desk-terminals.ts';
import { viewLease } from './desk-lease.ts';
import { drawMap } from './desk-map.ts';
import { cardPlaces, showChanges, showTabIcon } from './desk-motion.ts';

const content = requiredElement(document, '#content', HTMLElement);
const connectionLabel = requiredElement(document, '#connection', HTMLElement);
const connectionNote = requiredElement(
  document,
  '#connection-note',
  HTMLElement,
);
const connectionMessage = requiredElement(
  document,
  '#connection-message',
  HTMLElement,
);
const observationLabel = requiredElement(document, '#observation', HTMLElement);
const actionLabel = requiredElement(document, '#action-status', HTMLElement);
/** Clears the status line after each action, so it never shows an old result. */
let actionTimer: ReturnType<typeof setTimeout> | undefined;
const projectTitle = requiredElement(document, '#project-title', HTMLElement);
const stageLabel = requiredElement(document, '#stage', HTMLElement);
const menuButton = requiredElement(document, '#menu', HTMLElement);
const needsButton = requiredElement(document, '#needs', HTMLElement);
const needsCount = requiredElement(document, '#needs-count', HTMLElement);
const stopButton = requiredElement(document, '#stop-team', HTMLElement);
/** The open view and panel. Like the selections, they last for this tab. */
let view = 'home';
let panel = '';
/** When the page last went to the background for 5 minutes or more. Home lists what changed after it. A lab's owner keeps the time away itself. */
let since: string | undefined;
/** The last view was of a project with a lab. */
let labShown = false;
let hiddenAt: number | undefined;
/** The words of the lab's search panel. They last for this tab. */
let searchQuery: string | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let selected: string | undefined;
let selectedTask: string | undefined;
let selectedWorker: string | undefined;
let selectedDirection: string | undefined;
/** The run, the agent, and the cited diff of a post (such as p-12.0), of the lab's panels. */
let selectedRun: string | undefined;
let selectedAgent: string | undefined;
let selectedProof: string | undefined;
/** The file of a lab diff that the diff pane shows, kept across page renders, with the diff's direction, proof, and newest commit. */
let shownLabDiff:
  | {
      readonly direction: string;
      readonly proof: string;
      /** The commit of a bring-in that the person looks at, or empty. */
      readonly bring: string;
      readonly to: string;
      readonly file: string;
      readonly text: string;
      readonly cut: boolean;
    }
  | undefined;
/** Each load of a lab file's diff gets the next number. Only the newest one shows. */
let labDiffLoads = 0;
/** The name that the person chose in the mention list, kept across refreshes. */
let mentionChoice: string | undefined;
/** The @name whose list the person closed with Escape. It stays closed until the name changes. */
let mentionClosed: string | undefined;
/** A name for the lab's message box from a view without it. It goes in once Home shows. */
let pendingMention: string | undefined;
/** The diff that the review pane shows, kept across page renders. */
let shownDiff:
  | {
      readonly task: string;
      readonly version: string;
      readonly file: string;
      readonly text: string;
      readonly cut: boolean;
      /** For an HTML file: the URL of its page on the page server. */
      readonly page?: string;
    }
  | undefined;
let detail = 'summary';
/** The view of the selected worker: summary, details, terminal, or commands. */
let pane = 'summary';
/** The commands that the audit shows: all, or tagged only. The choice lasts for this browser. */
let records = 'all';
/** Finished tasks on the map and in the rail: shown, or hidden after Clear finished. The choice lasts for this browser. */
let finished = 'shown';
let token = location.hash.slice(1);
const launch = token.startsWith('launch-') ? token.slice(7) : '';
try {
  if (/^[a-f0-9]{64}$/.test(token)) {
    sessionStorage.setItem('verifold-desk-token', token);
    history.replaceState(null, '', location.pathname);
  } else token = sessionStorage.getItem('verifold-desk-token') ?? '';
  view = sessionStorage.getItem('verifold-desk-view') ?? 'home';
  since = sessionStorage.getItem('verifold-desk-since') ?? undefined;
  searchQuery = sessionStorage.getItem('verifold-desk-q') ?? undefined;
  panel = sessionStorage.getItem('verifold-desk-panel') ?? '';
  selected = sessionStorage.getItem('verifold-desk-attempt') ?? undefined;
  selectedTask = sessionStorage.getItem('verifold-desk-task') ?? undefined;
  selectedWorker = sessionStorage.getItem('verifold-desk-worker') ?? undefined;
  selectedDirection =
    sessionStorage.getItem('verifold-desk-direction') ?? undefined;
  selectedRun = sessionStorage.getItem('verifold-desk-run') ?? undefined;
  selectedAgent = sessionStorage.getItem('verifold-desk-agent') ?? undefined;
  selectedProof = sessionStorage.getItem('verifold-desk-proof') ?? undefined;
  detail = localStorage.getItem('verifold-desk-detail') ?? 'summary';
  pane = localStorage.getItem('verifold-desk-pane') ?? 'summary';
  records = localStorage.getItem('verifold-desk-records') ?? 'all';
  finished = localStorage.getItem('verifold-desk-finished') ?? 'shown';
} catch {
  /* The original fragment still supports reload when storage is unavailable. */
}

/** Keep a choice for this tab. Without browser storage, it lasts until reload. */
function remember(key: string, value: string | undefined): void {
  try {
    if (value) sessionStorage.setItem(`verifold-desk-${key}`, value);
    else sessionStorage.removeItem(`verifold-desk-${key}`);
  } catch {
    /* The choice lasts until reload when browser storage is unavailable. */
  }
}

let lastHtml = '';
/** The view and the panel item of the last render, so a new one starts at its top. */
let rendered = { view: '', panel: '' };
/** Where focus goes after the next render: the view or panel that the person opened. */
let pendingFocus = '';
let pendingScroll: ScrollLogicalPosition = 'nearest';
/** The control that opened the panel. Focus returns to it when the panel closes. */
let opener: string | undefined;
/** Keys of the items in Needs you. The first view only records them, so opening the desk notifies nothing. */
let knownNeeds: Set<string> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let loading = false;
let stopped = false;
/** The person stopped Verifold from this page. Nothing restarts the updates. */
let ended = false;
let request: AbortController | undefined;
/** The last failed action, shown beside its control until the next action succeeds. */
let failure:
  | { readonly selector: string; readonly message: string }
  | undefined;

/** The switches of the page: Summary or Details, the pane of a worker, and the commands of the audit. Each choice lasts for this browser. */
function showDetail(): void {
  document.body.dataset.detail = detail;
  document.body.dataset.pane = pane;
  document.body.dataset.records = records;
  for (const button of content.querySelectorAll<HTMLElement>('[data-detail]'))
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.detail === detail),
    );
  for (const button of content.querySelectorAll<HTMLElement>('[data-pane]'))
    button.setAttribute('aria-pressed', String(button.dataset.pane === pane));
  for (const button of content.querySelectorAll<HTMLElement>('[data-records]'))
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.records === records),
    );
}

/** Stop ends Verifold and this desk. The page says so and asks the desk nothing more. */
function showStopped(): void {
  ended = true;
  stopped = true;
  clearTimeout(timer);
  request?.abort();
  const card = document.createElement('section');
  card.className = 'card';
  const title = document.createElement('h1');
  title.id = 'view-title';
  title.tabIndex = -1;
  title.textContent = 'Verifold is stopping';
  const text = document.createElement('p');
  text.textContent =
    'The agents pause. A task turn that runs now stops, and its work waits for your review. Pods stop after their results come back. To start again, run verifold in the project folder.';
  card.append(title, text);
  content.replaceChildren(card);
  stopButton.hidden = true;
  showConnection('You stopped Verifold.');
  title.focus();
}

function showFailure(): void {
  content.querySelector('.action-error')?.remove();
  const control = failure ? content.querySelector(failure.selector) : null;
  if (!failure || !control) return;
  const note = document.createElement('p');
  note.className = 'action-error';
  note.textContent = failure.message;
  (control.closest('.actions') ?? control).after(note);
}

/** The open view, with its task when it is a task page. A new one starts at its top. */
function viewKey(): string {
  return view === 'task' ? `task:${selectedTask ?? ''}` : view;
}

/** The query of /api/view. Only the open panel or task page sends its item. */
function viewQuery(): string {
  const query = new URLSearchParams();
  if (view !== 'home') query.set('view', view);
  if (panel) query.set('panel', panel);
  if (panel === 'attempt' && selected) query.set('attempt', selected);
  if (view === 'task' && selectedTask) query.set('task', selectedTask);
  // A worker that left its slot is not an error. The server shows another one.
  if (panel === 'worker' && selectedWorker) query.set('worker', selectedWorker);
  if (
    (panel === 'direction' || panel === 'diff' || panel === 'bring') &&
    selectedDirection
  )
    query.set('direction', selectedDirection);
  if (panel === 'run' && selectedRun) query.set('run', selectedRun);
  if (panel === 'agent' && selectedAgent) query.set('agent', selectedAgent);
  if (panel === 'diff' && selectedProof) query.set('proof', selectedProof);
  if (panel === 'search' && searchQuery) query.set('q', searchQuery);
  if (since && !labShown) query.set('since', since);
  // The lab's owner counts each refresh that the person can see as a look, so a return after a while lists what changed.
  if (!document.hidden) query.set('look', '1');
  if (finished === 'hidden') query.set('finished', 'hidden');
  return query.toString();
}

/** The item in the open panel. A change of item starts the panel at its top. */
function panelKey(): string {
  const item =
    panel === 'worker'
      ? selectedWorker
      : panel === 'attempt'
        ? selected
        : panel === 'direction'
          ? selectedDirection
          : panel === 'diff'
            ? `${selectedDirection ?? ''}:${selectedProof ?? ''}`
            : panel === 'bring'
              ? `bring:${selectedDirection ?? ''}`
              : panel === 'run'
                ? selectedRun
                : panel === 'agent'
                  ? selectedAgent
                  : '';
  return `${panel}:${item ?? ''}`;
}

/** A selector that finds the same control after a render. Most controls have data attributes, not IDs. */
function selectorOf(element: HTMLElement): string | undefined {
  if (element.id) return `#${CSS.escape(element.id)}`;
  if (element.matches('summary')) {
    const id = element.closest('details')?.id;
    return id ? `#${CSS.escape(id)} > summary` : undefined;
  }
  const data = Object.entries(element.dataset).filter(
    ([key]) => key !== 'armed',
  );
  return data.length
    ? `${element.localName}${data
        .map(
          ([key, value]) =>
            `[data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${CSS.escape(value ?? '')}"]`,
        )
        .join('')}`
    : undefined;
}

function showConnection(problem: string | undefined): void {
  connectionLabel.textContent =
    problem === undefined ? 'Connected' : 'Not connected';
  connectionMessage.textContent = problem ?? '';
  connectionNote.hidden = problem === undefined;
  document.body.dataset.connection =
    problem === undefined ? 'connected' : 'disconnected';
}

/**
 * The page changes in place, so an element can move from one state to the next.
 * The page owns some parts: the arrows of a map, a handoff in motion, and the
 * transcripts in their slots.
 */
const morphing = {
  morphStyle: 'innerHTML',
  ignoreActiveValue: true,
  callbacks: {
    // A shown page stays as it is, so a refresh does not load it again.
    beforeNodeMorphed: (node: Node, next: Node) =>
      !(
        node instanceof HTMLElement &&
        (node.matches('svg.map-links') ||
          // A run's log keeps the text that the page loaded into it.
          (node.matches('pre[data-run-log]') &&
            next instanceof HTMLElement &&
            next.dataset.runLog === node.dataset.runLog) ||
          (node.matches('.diff-pane[data-page]') &&
            next instanceof HTMLElement &&
            next.dataset.task === node.dataset.task &&
            next.dataset.version === node.dataset.version) ||
          // A lab diff keeps the file that the page loaded into it while the diff is the same.
          (node.matches('.lab-diff-pane[data-file]') &&
            next instanceof HTMLElement &&
            next.dataset.labDirection === node.dataset.labDirection &&
            next.dataset.diffProof === node.dataset.diffProof &&
            next.dataset.labTo === node.dataset.labTo))
      ),
    beforeNodeRemoved: (node: Node) =>
      !(
        node.parentElement?.classList.contains('transcript-slot') ||
        (node instanceof Element && node.classList.contains('handoff'))
      ),
  },
} as const;

/**
 * Update the rail, the view, and the panel. Typed text, open sections, checked
 * files, focus, and the scroll position of the view and the panel stay.
 */
async function render(html: string): Promise<void> {
  // Transcript panels keep their own open calls. Only page sections are restored here.
  const known = new Set(
    Array.from(
      content.querySelectorAll('details[id]'),
      (element) => element.id,
    ),
  );
  const open = new Set(
    Array.from(
      content.querySelectorAll('details[id][open]'),
      (element) => element.id,
    ),
  );
  const focused = document.activeElement;
  const inPanel =
    focused instanceof HTMLElement && focused.closest('.transcript')
      ? focused
      : null;
  const focusTarget =
    focused instanceof HTMLElement && !inPanel && content.contains(focused)
      ? selectorOf(focused)
      : undefined;
  // Keep the files that the person selected for Accept.
  const checked = new Map(
    Array.from(
      content.querySelectorAll<HTMLInputElement>('input[type="checkbox"][id]'),
      (box) => [box.id, box.checked],
    ),
  );
  // Keep text that the person typed while the view refreshes.
  const typed = new Map(
    Array.from(
      content.querySelectorAll<
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
  const scrolls = Array.from(
    content.querySelectorAll<HTMLElement>('#rail, #view, #panel-body'),
    (element) => [element, element.scrollTop] as const,
  );
  const places = cardPlaces(content);
  const opened = viewKey() !== rendered.view;
  const same = !opened && panelKey() === rendered.panel;
  // The local renderer escapes research text. Harness Markdown is sanitized
  // again in an inert template, before it reaches the live page.
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const fragment of template.content.querySelectorAll('.md'))
    fragment.innerHTML = DOMPurify.sanitize(fragment.innerHTML, {
      ADD_ATTR: ['target'],
    });
  const apply = (): void => {
    // A morph keeps the children of the focused element, so a panel that shows another item lets go of focus first.
    if (
      !same &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('#panel')
    )
      document.activeElement.blur();
    // A new view replaces the page: nothing on it carries over, and a morph can move a kept heading into it.
    // The morph returns a promise only when it waits for a new head. A morph of #content does not.
    if (opened) content.replaceChildren(template.content);
    else void Idiomorph.morph(content, template.content, morphing);
    showFailure();
    showDetail();
    for (const [id, value] of typed) {
      if (opened && id === 'message-to') continue;
      const field = document.getElementById(id);
      // A choice that left the list, such as an agent that ended, falls back to the server's choice.
      if (
        field instanceof HTMLSelectElement &&
        !Array.from(field.options).some((option) => option.value === value)
      )
        continue;
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      )
        field.value = value;
    }
    showThread();
    showReply();
    settleOpen();
    // A section that is new to the page keeps the state that the server gave it.
    for (const detail of content.querySelectorAll<HTMLDetailsElement>(
      'details[id]',
    ))
      if (known.has(detail.id)) detail.open = open.has(detail.id);
    for (const [id, value] of checked) {
      const box = document.getElementById(id);
      if (box instanceof HTMLInputElement && !box.disabled) box.checked = value;
    }
    // A view or a panel item that the person just opened starts at its top. A kept area keeps its place.
    for (const [before, top] of scrolls) {
      const element = document.getElementById(before.id);
      if (!element) continue;
      if (
        before.id !== 'rail' &&
        (before.id === 'view' ? opened : panelKey() !== rendered.panel)
      )
        element.scrollTop = 0;
      else if (element !== before) element.scrollTop = top;
    }
    rendered = { view: viewKey(), panel: panelKey() };
    showReview();
    showLabDiff();
    lookToBring();
    showRunLogs();
    drawMaps();
    mountTranscripts(content, () => token);
    mountTerminals(content);
    inPanel?.focus({ preventScroll: true });
    const target = focusTarget
      ? content.querySelector<HTMLElement>(focusTarget)
      : null;
    target?.focus({ preventScroll: true });
    if (
      caret &&
      (target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement)
    )
      target.setSelectionRange(caret[0] ?? null, caret[1] ?? null);
    // After focus returns: the names list follows the text at the cursor.
    showMentions();
    if (pendingMention && document.getElementById('lab-text')) {
      const name = pendingMention;
      pendingMention = undefined;
      mention(name);
    }
    lastHtml = html;
    showChanges(content, places, same);
  };
  // Another view cross-fades in. The first view and live updates do not.
  if (
    opened &&
    rendered.view &&
    'startViewTransition' in document &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    await document.startViewTransition(apply).updateCallbackDone;
  else apply();
}

/** The items in Needs you from a view reply, or nothing for setup. */
function needsFrom(
  reply: object,
): { key: string; title: string }[] | undefined {
  if (!('needs' in reply) || !Array.isArray(reply.needs)) return undefined;
  return reply.needs.flatMap((item: unknown) =>
    item &&
    typeof item === 'object' &&
    'key' in item &&
    typeof item.key === 'string' &&
    'title' in item &&
    typeof item.title === 'string'
      ? [{ key: item.key, title: item.title }]
      : [],
  );
}

/** The planned tasks and how many are done, or nothing before the plan is approved. */
function workFrom(reply: object): { done: number; total: number } | null {
  if (!('work' in reply) || !reply.work || typeof reply.work !== 'object')
    return null;
  const { done, total } = reply.work as Record<string, unknown>;
  return typeof done === 'number' && typeof total === 'number'
    ? { done, total }
    : null;
}

/**
 * One desktop notification for each new item, while the desk is in the
 * background. A click on it opens Needs you.
 */
function notifyNeeds(needs: readonly { key: string; title: string }[]): void {
  const known = knownNeeds;
  knownNeeds = new Set(needs.map((item) => item.key));
  if (
    !known ||
    !('Notification' in window) ||
    Notification.permission !== 'granted' ||
    (!document.hidden && document.hasFocus())
  )
    return;
  for (const item of needs.filter((entry) => !known.has(entry.key))) {
    const note = new Notification(
      `${projectTitle.textContent ?? 'Verifold'} needs you`,
      { body: item.title, tag: item.key, icon: '/symbol.webp' },
    );
    note.addEventListener('click', () => {
      window.focus();
      navigate({ view: 'needs' }, '#view-title');
      note.close();
    });
  }
}

/** The notification setting in Needs you says what the browser allows. */
function showNotify(): void {
  const button = document.getElementById('notify');
  const state = document.getElementById('notify-state');
  if (!button || !state) return;
  const permission =
    'Notification' in window ? Notification.permission : undefined;
  button.hidden = permission !== 'default';
  state.textContent =
    permission === 'granted'
      ? 'Desktop notifications are on. You get one for each new item while the desk is in the background.'
      : permission === 'denied'
        ? 'The browser blocks notifications from this desk. Allow them in its site settings.'
        : permission === 'default'
          ? 'Get a desktop notification for each new item while the desk is in the background.'
          : 'This browser cannot show desktop notifications.';
}

/**
 * Draw the arrows of each task map, from what a task waits for to the task.
 * The boxes say the same in words, so the arrows are decoration. A map or a
 * table that scrolls sideways marks the edge that has more.
 */
function drawMaps(): void {
  for (const map of content.querySelectorAll<HTMLElement>('[data-map]')) {
    drawMap(map);
    if (!shownMaps.has(map)) {
      shownMaps.add(map);
      showFrontier(map);
    }
    markEdge(map);
  }
  for (const table of content.querySelectorAll<HTMLElement>('.table'))
    markEdge(table);
}

/** Maps that the page showed already. A refresh keeps the place that the person scrolled to. */
const shownMaps = new WeakSet<HTMLElement>();

/** A deep plan opens at its first task that is not done, so the work of now is in view. */
function showFrontier(map: HTMLElement): void {
  if (map.scrollWidth <= map.clientWidth) return;
  const box = map.querySelector<HTMLElement>(
    '.map-box:not([data-state="done"]):not([data-state="cancelled"])',
  );
  const column = box?.closest<HTMLElement>('.map-col');
  // The column before it stays in view, so the arrows into the task show where it starts.
  const before = column?.previousElementSibling;
  if (column && before instanceof HTMLElement)
    map.scrollLeft = before.offsetLeft;
}

/** A map or a table wider than its frame fades at each edge that has more of it out of view. */
function markEdge(frame: HTMLElement): void {
  frame.classList.toggle('more-left', frame.scrollLeft > 2);
  frame.classList.toggle(
    'more-right',
    frame.scrollLeft + frame.clientWidth < frame.scrollWidth - 2,
  );
}

/** After the person opens a view or a panel, focus moves there, so keyboard and screen reader users follow. */
function focusPending(): void {
  if (!pendingFocus) return;
  const target =
    content.querySelector<HTMLElement>(pendingFocus) ??
    document.getElementById('view-title');
  pendingFocus = '';
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: pendingScroll });
}

async function refresh(): Promise<void> {
  if (loading || stopped) return;
  clearTimeout(timer);
  loading = true;
  const wanted = viewQuery();
  request = new AbortController();
  const deadline = setTimeout(() => request?.abort(), 5000);
  try {
    const response = await fetch(`/api/view${wanted ? `?${wanted}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: request.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(
          'Open the full desk URL printed in your terminal to connect.',
        );
      // The item left the project, or this tab kept a view that the desk does not know.
      if ((response.status === 404 || response.status === 400) && wanted) {
        view = 'home';
        panel = '';
        selected = undefined;
        selectedTask = undefined;
        searchQuery = undefined;
        remember('view', undefined);
        remember('panel', undefined);
        remember('q', undefined);
        throw new Error(
          'That item is no longer available. The desk shows Home.',
        );
      }
      throw new Error(
        'Verifold could not read the records of this project. Check the project folder, then refresh.',
      );
    }
    const reply: unknown = await response.json();
    if (
      !reply ||
      typeof reply !== 'object' ||
      !('html' in reply) ||
      typeof reply.html !== 'string' ||
      !('observation' in reply) ||
      typeof reply.observation !== 'string'
    )
      throw new Error(
        'The desk sent a page that the browser could not read. Refresh to try again.',
      );
    if (wanted !== viewQuery() || stopped) return;
    if (reply.html !== lastHtml) await render(reply.html);
    focusPending();
    const title =
      'title' in reply && typeof reply.title === 'string' ? reply.title : '';
    const stage =
      'stage' in reply && typeof reply.stage === 'string' ? reply.stage : '';
    const needs = needsFrom(reply);
    labShown = 'lab' in reply && reply.lab === true;
    projectTitle.textContent = title || 'Research desk';
    stageLabel.textContent = stage;
    stageLabel.hidden = !stage;
    // The tab title counts what waits for the person, so the count shows from another tab.
    document.title = `${needs?.length ? `(${needs.length}) ` : ''}${title ? `${title} – Verifold` : 'Verifold'}`;
    needsButton.hidden = needs === undefined;
    stopButton.hidden = !('stoppable' in reply && reply.stoppable === true);
    needsCount.textContent = String(needs?.length ?? 0);
    needsButton.classList.toggle('has', !!needs?.length);
    if (view === 'needs') needsButton.setAttribute('aria-current', 'page');
    else needsButton.removeAttribute('aria-current');
    if (needs) notifyNeeds(needs);
    showTabIcon(workFrom(reply), needs?.length ?? 0);
    showNotify();
    observationLabel.textContent = reply.observation;
    showConnection(undefined);
  } catch (error) {
    if (!stopped)
      showConnection(
        error instanceof Error &&
          error.name !== 'AbortError' &&
          error.name !== 'TypeError'
          ? error.message
          : 'The desk keeps the last page it showed and tries again.',
      );
  } finally {
    clearTimeout(deadline);
    loading = false;
    if (!stopped)
      timer = setTimeout(
        () => {
          void refresh();
        },
        wanted !== viewQuery() ? 0 : 2000,
      );
  }
}

function closeRail(): void {
  document.body.classList.remove('rail-open');
  menuButton.setAttribute('aria-expanded', 'false');
}

/** Open a view or a panel. A new view closes the panel. Focus moves to the new place after the next render. */
function navigate(
  next: { readonly view?: string; readonly panel?: string },
  focus: string,
  scroll: ScrollLogicalPosition = 'nearest',
): void {
  if (next.view !== undefined && next.view !== view) {
    view = next.view;
    panel = '';
  }
  if (next.panel !== undefined) panel = next.panel;
  remember('view', view === 'home' ? undefined : view);
  remember('panel', panel);
  pendingFocus = focus;
  pendingScroll = scroll;
  closeRail();
  void refresh();
}

/** Open one item: a task as its page, the others in the panel. Closing the panel returns focus to the control that opened it. */
function openItem(
  kind: 'task' | 'worker' | 'attempt' | 'direction',
  id: string,
  from: HTMLElement,
): void {
  if (kind === 'task') {
    selectedTask = id;
    remember('task', id);
    navigate({ view: 'task', panel: '' }, '#view-title', 'start');
    return;
  }
  if (kind === 'worker') selectedWorker = id;
  else if (kind === 'direction') selectedDirection = id;
  else selected = id;
  remember(kind, id);
  opener = selectorOf(from);
  navigate({ panel: kind }, '#panel-title');
}

function checked(id: string): boolean {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement && element.checked;
}

function field(id: string): string {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
    ? element.value
    : '';
}

/** The sessions in To, by their values. */
function sessionOptions(): string[] {
  const to = document.getElementById('message-to');
  return to instanceof HTMLSelectElement
    ? Array.from(to.options, (option) => option.value).filter((value) =>
        value.startsWith('session:'),
      )
    : [];
}

/** The sessions in To before the person started a new agent, until the new one shows. */
let knownSessions: Set<string> | undefined;

/** The message box shows the thread of the agent in To, and says whom the message goes to. */
function showThread(): void {
  const to = document.getElementById('message-to');
  const text = document.getElementById('message-text');
  if (!(to instanceof HTMLSelectElement)) return;
  // After a new agent starts, the box writes to it.
  const started = knownSessions
    ? sessionOptions().find((value) => !knownSessions?.has(value))
    : undefined;
  if (started) {
    to.value = started;
    knownSessions = undefined;
  }
  for (const row of content.querySelectorAll<HTMLElement>('[data-for]'))
    row.hidden = row.dataset.for !== to.value;
  // The first message to a new agent starts it.
  const send = content.querySelector('[data-action="message"]');
  if (send) send.textContent = to.value === 'new-agent' ? 'Start' : 'Send';
  for (const list of content.querySelectorAll<HTMLElement>('[data-thread]'))
    list.hidden = list.dataset.thread !== to.value;
  const hint = to.selectedOptions[0]?.dataset.hint;
  if (text instanceof HTMLTextAreaElement && hint) text.placeholder = hint;
}

/** Point the message box at one agent and put the cursor in it. `about` names a task at the start of an empty message. */
function writeTo(agent: string, about?: string): void {
  const to = document.getElementById('message-to');
  const text = document.getElementById('message-text');
  if (
    !(to instanceof HTMLSelectElement) ||
    !(text instanceof HTMLTextAreaElement) ||
    !Array.from(to.options).some((option) => option.value === agent)
  )
    return;
  to.value = agent;
  showThread();
  if (about && !text.value.trim()) text.value = `About "${about}": `;
  if (matchMedia('(max-width: 860px)').matches)
    document.body.classList.add('dock-open');
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

/** The Accept button counts the selected files. The diff pane shows the chosen file. */
function showReview(): void {
  const accept = content.querySelector<HTMLButtonElement>(
    '[data-action="task-accept"]',
  );
  if (accept) {
    const count = content.querySelectorAll('input[data-file]:checked').length;
    accept.textContent = `Accept ${count} ${count === 1 ? 'file' : 'files'}`;
    accept.disabled = count === 0;
  }
  const pane = content.querySelector<HTMLElement>('.diff-pane');
  if (
    !pane ||
    !shownDiff ||
    pane.dataset.task !== shownDiff.task ||
    pane.dataset.version !== shownDiff.version
  )
    return;
  for (const button of content.querySelectorAll<HTMLElement>('[data-diff]'))
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.diff === shownDiff.file),
    );
  if (shownDiff.page && pane.dataset.page === shownDiff.page) return;
  const [head, ...changes] = diffNodes(
    shownDiff.file,
    shownDiff.text,
    shownDiff.cut,
  );
  if (!head) return;
  if (!shownDiff.page) {
    delete pane.dataset.page;
    pane.replaceChildren(head, ...changes);
    return;
  }
  // An HTML file shows as its page, from the page server, with its changes folded under it.
  pane.dataset.page = shownDiff.page;
  const open = document.createElement('a');
  open.href = shownDiff.page;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open in a new tab';
  head.append(' ', open);
  const note = document.createElement('p');
  note.className = 'fine';
  note.textContent =
    "The agent made this page. It shows without scripts and can't reach the internet. A link that you click opens in a new tab.";
  const frame = document.createElement('iframe');
  frame.className = 'page-frame';
  frame.src = shownDiff.page;
  frame.title = `Page ${shownDiff.file}`;
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  const fold = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'The changes';
  fold.append(summary, ...changes);
  pane.replaceChildren(head, note, frame, fold);
}

/** A file's name, its diff with each line marked, and a note when the diff was cut. All text goes in as text. */
function diffNodes(file: string, text: string, cut: boolean): HTMLElement[] {
  const head = document.createElement('p');
  head.className = 'diff-head';
  const name = document.createElement('code');
  name.textContent = file;
  head.append(name);
  const pre = document.createElement('pre');
  pre.className = 'diff';
  for (const line of text.split('\n')) {
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
  const note = document.createElement('p');
  note.className = 'fine';
  note.textContent = 'The diff stops at 512 KB.';
  return cut ? [head, pre, note] : [head, pre];
}

/** The lab's diff pane shows the file that the person chose, and its button says so. */
function showLabDiff(): void {
  const pane = content.querySelector<HTMLElement>('.lab-diff-pane');
  if (!pane) return;
  // A diff of another direction or post does not show.
  const loaded = shownLabDiff;
  const shown =
    loaded &&
    loaded.direction === pane.dataset.labDirection &&
    loaded.proof === (pane.dataset.diffProof ?? '') &&
    loaded.bring === (pane.dataset.bringCommit ?? '')
      ? loaded
      : undefined;
  for (const button of content.querySelectorAll<HTMLElement>('[data-lab-diff]'))
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.labDiff === shown?.file),
    );
  const key = shown ? `${shown.file}@${shown.to}` : '';
  if (!shown || pane.dataset.file === key) return;
  pane.dataset.file = key;
  const nodes = diffNodes(shown.file, shown.text, shown.cut);
  // The branch moved after the list beside it was made. The list catches up at the next refresh.
  if (shown.to !== pane.dataset.labTo) {
    const note = document.createElement('p');
    note.className = 'fine';
    note.textContent = `This diff is at ${shown.to.slice(0, 7)}, newer than the list beside it. The list catches up in a moment.`;
    nodes.splice(1, 0, note);
  }
  pane.replaceChildren(...nodes);
}

/** The direction whose bring-in panel asked Verifold for its newest work since the panel opened. */
let bringLooked: string | undefined;

/**
 * A bring-in panel without files asks Verifold once for the direction's
 * newest work, so its files show. Its button tries again after a failure.
 */
function lookToBring(): void {
  if (panel !== 'bring') bringLooked = undefined;
  const id = content.querySelector<HTMLElement>('[data-lab-bring-look]')
    ?.dataset.labBringLook;
  if (!id || bringLooked === id) return;
  bringLooked = id;
  const button = content.querySelector<HTMLElement>(
    `[data-action="lab-bring-look"][data-lab-direction="${CSS.escape(id)}"]`,
  );
  if (button) void act(button);
}

/** Load the diff of one file of a lab diff into its pane. A later click wins over an earlier answer. */
async function loadLabDiff(button: HTMLElement): Promise<void> {
  const direction = button.dataset.labDirection ?? '';
  const file = button.dataset.labDiff ?? '';
  const proof = button.dataset.diffProof ?? '';
  const bring = button.dataset.bringCommit ?? '';
  const load = ++labDiffLoads;
  try {
    const response = await fetch(
      `/api/lab-diff?${new URLSearchParams({ direction, file, ...(proof ? { proof } : {}), ...(bring ? { bring } : {}) }).toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    const reply = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok || typeof reply.text !== 'string')
      throw new Error(
        typeof reply.error === 'string' ? reply.error : 'No diff.',
      );
    if (load !== labDiffLoads) return;
    shownLabDiff = {
      direction,
      proof,
      bring,
      to: typeof reply.to === 'string' ? reply.to : '',
      file,
      text: reply.text,
      cut: reply.cut === true,
    };
    showLabDiff();
  } catch (error) {
    actionLabel.textContent =
      error instanceof Error && error.name !== 'TimeoutError'
        ? error.message
        : 'The desk did not answer. Run verifold in the project folder to check that it still runs.';
  }
}

/** Show one pane of the worker panel: summary, details, terminal, or commands. The choice lasts for this browser. */
function choosePane(value: string): void {
  pane = ['details', 'terminal', 'commands'].includes(value)
    ? value
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

/**
 * Put a name, such as @claude-1, at the start of the lab's message box, and
 * the cursor after the text. From a view without the box, Home opens first.
 */
function mention(name: string): void {
  const text = document.getElementById('lab-text');
  if (!(text instanceof HTMLTextAreaElement)) {
    pendingMention = name;
    navigate({ view: 'home', panel: '' }, '#lab-text');
    return;
  }
  if (!text.value.split(/\s+/).includes(name))
    text.value = `${name} ${text.value}`.trimEnd() + ' ';
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

/** The @name that ends just before the cursor in the lab's message box, or nothing. */
function mentionWord(text: HTMLTextAreaElement): string | undefined {
  return /(?:^|\s)(@[\w-]*)$/.exec(
    text.value.slice(0, text.selectionStart),
  )?.[1];
}

/**
 * The names under the lab's message box: the ones that start with the
 * @name at the cursor. One of them is chosen, and Enter or Tab takes it.
 */
function showMentions(move = 0): void {
  const text = document.getElementById('lab-text');
  const list = document.getElementById('lab-mentions');
  if (!(text instanceof HTMLTextAreaElement) || !list) return;
  const word =
    document.activeElement === text
      ? mentionWord(text)?.toLowerCase()
      : undefined;
  if (word !== mentionClosed) mentionClosed = undefined;
  const items = Array.from(
    list.querySelectorAll<HTMLElement>('[role="option"]'),
  );
  // A whole name is done, also when a longer name starts with it.
  const done = items.some((item) => item.dataset.value === word);
  const shown = items.filter((item) => {
    const value = item.dataset.value ?? '';
    item.hidden =
      !word || done || word === mentionClosed || !value.startsWith(word);
    return !item.hidden;
  });
  list.hidden = !shown.length;
  text.setAttribute('aria-expanded', String(shown.length > 0));
  // The choice is kept by its name, so a refresh does not move it.
  const current = shown.findIndex(
    (item) => item.dataset.value === mentionChoice,
  );
  const next = shown.length
    ? (Math.max(current, 0) + move + shown.length) % shown.length
    : -1;
  mentionChoice = shown[next]?.dataset.value;
  for (const item of items)
    item.setAttribute('aria-selected', String(item === shown[next]));
  if (shown[next]) text.setAttribute('aria-activedescendant', shown[next].id);
  else text.removeAttribute('aria-activedescendant');
}

/** Take a name from the list: it replaces the @name at the cursor. */
function takeMention(item: HTMLElement): void {
  const text = document.getElementById('lab-text');
  const value = item.dataset.value;
  if (!(text instanceof HTMLTextAreaElement) || !value) return;
  const before = text.value.slice(0, text.selectionStart);
  const word = mentionWord(text) ?? '';
  const start = before.length - word.length;
  text.value = `${text.value.slice(0, start)}${value} ${text.value.slice(text.selectionStart)}`;
  const at = start + value.length + 1;
  text.setSelectionRange(at, at);
  text.focus();
  showMentions();
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
    // A deleted page has nothing to show.
    const page =
      /\.html?$/i.test(file) && !button.querySelector('.change-deleted')
        ? await fetch(
            `/api/page?${new URLSearchParams({ task, version, file }).toString()}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              cache: 'no-store',
              signal: AbortSignal.timeout(5000),
            },
          )
            .then((answer) => (answer.ok ? answer.json() : null))
            .then((value: unknown) =>
              typeof value === 'object' &&
              value !== null &&
              'url' in value &&
              typeof value.url === 'string'
                ? value.url
                : undefined,
            )
            .catch(() => undefined)
        : undefined;
    shownDiff = {
      task,
      version,
      file,
      text: reply.text,
      cut: reply.cut === true,
      ...(page ? { page } : {}),
    };
    showReview();
  } catch (error) {
    actionLabel.textContent =
      error instanceof Error && error.name !== 'TimeoutError'
        ? error.message
        : 'The desk did not answer. Run verifold in the project folder to check that it still runs.';
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
    case 'coordinator-approve':
      // The extras that the person ticked start with the plan. Verifold cancels the others.
      return {
        action,
        extras: Array.from(
          content.querySelectorAll<HTMLInputElement>(
            'input[data-extra]:checked',
          ),
          (box) => box.dataset.extra,
        ),
      };
    case 'task-create':
      return { action, ...taskBody('task-new') };
    case 'task-edit':
      return {
        action,
        task,
        reason: field('task-edit-reason'),
        ...taskBody('task-edit'),
      };
    case 'task-accept':
      return {
        action,
        task,
        version,
        files: Array.from(
          content.querySelectorAll<HTMLInputElement>(
            'input[data-file]:checked',
          ),
          (box) => box.dataset.file,
        ),
      };
    case 'task-reject':
      return { action, task, version };
    case 'coordinator-start':
      return {
        action,
        objective: field('coordinator-objective'),
        host: field('coordinator-host'),
        model: field('coordinator-model').trim(),
      };
    case 'coordinator-rule':
      return {
        action,
        check: Number(button.dataset.check),
        result: button.dataset.result,
        reason: field(`rule-${button.dataset.check ?? ''}`),
      };
    case 'coordinator-answer':
      return {
        action,
        decision: button.dataset.decision,
        note: field('answer-note'),
      };
    case 'task-decide':
      return {
        action,
        message: button.dataset.message,
        decision: button.dataset.decision,
        reason:
          button.dataset.reason ??
          field(`decide-${button.dataset.message ?? ''}`),
      };
    default:
      return { action, task };
  }
}

/** A direction opens in the background. Its form clears when the open ends well. */
let opening = false;

/**
 * After a view refresh: an open that went on in the background has ended
 * when the lab no longer shows it. One that worked clears its form. One
 * that failed keeps it, so the person can try again.
 */
function settleOpen(): void {
  if (!opening || content.querySelector('[data-lab-work="lab-direction-add"]'))
    return;
  opening = false;
  if (content.querySelector('[data-lab-failed="lab-direction-add"]')) return;
  for (const id of ['lab-title', 'lab-bar']) {
    const element = document.getElementById(id);
    if (element instanceof HTMLInputElement) element.value = '';
  }
}

/** The lab's message box says which post the next post answers, with a control to stop replying. */
function showReply(): void {
  const post = field('lab-reply');
  const note = document.getElementById('lab-reply-note');
  const line = document.getElementById('lab-replying');
  if (note) note.textContent = post ? `Replying to ${post}.` : '';
  if (line) line.hidden = !post;
}

/** Reply to a post, or stop replying with an empty `post`. Nothing goes to the server yet. */
function labReply(post: string): void {
  const reply = document.getElementById('lab-reply');
  if (reply instanceof HTMLInputElement) reply.value = post;
  showReply();
  document.getElementById('lab-text')?.focus();
}

/**
 * A lab request with a new key for each click. The desk runs a request with
 * a key that it saw in the last minute once, so a request that the network
 * sends twice does nothing twice.
 */
function labKeyed(body: Record<string, unknown>): Record<string, unknown> {
  const key = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return { ...body, key };
}

function labRequest(button: HTMLElement): Record<string, unknown> {
  const action = button.dataset.action ?? '';
  switch (action) {
    case 'lab-start':
      return {
        action,
        question: field('lab-question'),
        hours: field('lab-hours'),
      };
    case 'lab-budget':
      return { action, hours: button.dataset.hours };
    case 'lab-post':
      return {
        action,
        text: field('lab-text'),
        replyTo: field('lab-reply'),
      };
    case 'lab-terminal-open':
      return { action, agent: button.dataset.agent, lease: viewLease() };
    case 'lab-direction-add':
      return {
        action,
        title: field('lab-title'),
        harness: field('lab-harness'),
        bar: field('lab-bar'),
      };
    case 'lab-direction-stop':
      return { action, direction: button.dataset.labDirection };
    case 'lab-agent-restart':
      return { action, agent: button.dataset.agent };
    case 'lab-run-cancel':
      return { action, run: button.dataset.run };
    case 'lab-call-answer':
      return {
        action,
        call: button.dataset.call,
        option: button.dataset.option,
      };
    case 'lab-call-undo':
      return { action, call: button.dataset.call };
    case 'lab-bring-look':
      return { action, direction: button.dataset.labDirection };
    case 'lab-bring':
      return {
        action,
        direction: button.dataset.labDirection,
        commit: button.dataset.commit,
        files: [
          ...content.querySelectorAll<HTMLInputElement>(
            'input[data-bring-file]:checked',
          ),
        ].map((box) => box.dataset.bringFile),
      };
    case 'lab-signoff':
      return { action, note: field('lab-signoff-note') };
    default:
      return { action };
  }
}

/** The logs of runs that the person opened, by run ID, with the time that each one came. The newest 20 stay. */
const runLogs = new Map<
  string,
  { readonly text: string; readonly at: number }
>();
const loadingLogs = new Set<string>();
let logTimer: number | undefined;

/**
 * Fill each open run log from the ones loaded. A log older than 5 seconds
 * loads again, also while the view does not change.
 */
function showRunLogs(): void {
  clearTimeout(logTimer);
  const open = content.querySelectorAll<HTMLElement>(
    'details.run-log[open] [data-run-log]',
  );
  for (const pre of open) {
    const run = pre.dataset.runLog ?? '';
    const known = runLogs.get(run);
    if (known && pre.textContent !== known.text) pre.textContent = known.text;
    if ((!known || Date.now() - known.at > 5000) && !loadingLogs.has(run))
      void loadRunLog(run);
  }
  if (open.length) logTimer = window.setTimeout(showRunLogs, 5000);
}

/** Load the end of one run's log. */
async function loadRunLog(run: string): Promise<void> {
  loadingLogs.add(run);
  let text: string;
  try {
    const response = await fetch(
      `/api/run-log?${new URLSearchParams({ run }).toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    const reply = response.ok
      ? ((await response.json()) as Record<string, unknown>)
      : null;
    text =
      reply && typeof reply.text === 'string' && typeof reply.bytes === 'number'
        ? `${reply.partial === true ? `[The last part of a log of ${reply.bytes} bytes.]\n` : ''}${reply.text || '(The log is empty.)'}`
        : 'This run has no log.';
  } catch {
    text =
      'The desk did not answer. Run verifold in the project folder to check that it still runs.';
  } finally {
    loadingLogs.delete(run);
  }
  runLogs.delete(run);
  runLogs.set(run, { text, at: Date.now() });
  for (const old of [...runLogs.keys()].slice(0, -20)) runLogs.delete(old);
  showRunLogs();
}

/** A compute action. The RunPod key and secret values go only into this request body. */
function computeRequest(button: HTMLElement): Record<string, unknown> {
  const action = button.dataset.action ?? '';
  if (action === 'compute-key-save') {
    const box = document.getElementById('runpod-key-file');
    return {
      action,
      key: field('runpod-key').trim(),
      file:
        button.dataset.file === 'always' ||
        (box instanceof HTMLInputElement && box.checked),
    };
  }
  if (action === 'compute-secret-save') {
    const box = document.getElementById('secret-file');
    return {
      action,
      name: field('secret-name').trim(),
      value: field('secret-value').trim(),
      file:
        button.dataset.file === 'always' ||
        (box instanceof HTMLInputElement && box.checked),
    };
  }
  if (action === 'compute-secret-remove')
    return { action, secret: button.dataset.secret };
  if (action.startsWith('compute-lease-'))
    return { action, lease: button.dataset.lease };
  if (action === 'compute-agents')
    return { action, agents: Number(field('team-agents')) };
  if (action !== 'compute-settings') return { action };
  // Without the GPU table, the saved GPU list stays.
  const boxes = Array.from(
    content.querySelectorAll<HTMLInputElement>('input[data-gpu]'),
  );
  return {
    action,
    limitUsd: field('compute-limit'),
    maxUsdPerHour: field('compute-rate'),
    maxHoursPerLease: field('compute-hours'),
    idleMinutes: field('compute-idle'),
    maxRunningPods: field('compute-pods'),
    diskGb: field('compute-disk'),
    images: field('compute-images'),
    askBeforePod: checked('compute-ask'),
    ...(boxes.length
      ? {
          gpuTypes: boxes
            .filter((box) => box.checked)
            .map((box) => box.dataset.gpu),
        }
      : {}),
  };
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
  if (action === 'lab-reply' || action === 'lab-reply-clear') {
    labReply(action === 'lab-reply' ? (button.dataset.post ?? '') : '');
    return;
  }
  const body =
    action === 'cancel' || action === 'end' || action === 'terminal-return'
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
            : action === 'restore'
              ? { action, archive: button.dataset.archive }
              : action === 'resume' || action === 'restart'
                ? { action, session: button.dataset.session }
                : action === 'select' ||
                    action === 'redraft' ||
                    action === 'change-direction'
                  ? { action, idea: button.dataset.idea }
                  : action === 'research'
                    ? researchBody(button.dataset.research)
                    : action === 'message'
                      ? {
                          action,
                          to: field('message-to'),
                          text: field('message-text'),
                          // A new agent starts with the defaults under the box.
                          ...(field('message-to') === 'new-agent'
                            ? {
                                host: field('agent-host'),
                                mode: field('agent-mode'),
                              }
                            : {}),
                        }
                      : action === 'setup'
                        ? setupBody(button)
                        : action?.startsWith('task-') ||
                            action?.startsWith('coordinator-')
                          ? taskRequest(button)
                          : action?.startsWith('compute-')
                            ? computeRequest(button)
                            : action?.startsWith('lab-')
                              ? labKeyed(labRequest(button))
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
    ['check', button.dataset.check],
    ['result', button.dataset.result],
    ['lease', button.dataset.lease],
    ['archive', button.dataset.archive],
    ['lab-direction', button.dataset.labDirection],
    ['agent', button.dataset.agent],
    ['run', button.dataset.run],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `[data-${key}="${CSS.escape(value ?? '')}"]`)
    .join('');
  // A confirmed button shows its confirm text. Its own label is kept in `armed`.
  const name = (button.dataset.armed ?? button.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (button instanceof HTMLButtonElement) button.disabled = true;
  clearTimeout(actionTimer);
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
      // A compute action waits for RunPod, for up to 8 seconds. A slow lab
      // action answers within a few seconds and goes on in the background.
      signal: AbortSignal.timeout(
        action?.startsWith('compute-') || action?.startsWith('lab-')
          ? 15000
          : 5000,
      ),
    });
    const reply: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        reply &&
        typeof reply === 'object' &&
        'error' in reply &&
        typeof reply.error === 'string'
          ? reply.error
          : 'That did not work. Refresh, then try again.',
      );
    // A slow lab action goes on in the background. Its form stays, so nothing typed is lost if it fails.
    const pending =
      reply !== null &&
      typeof reply === 'object' &&
      'pending' in reply &&
      reply.pending === true;
    actionLabel.textContent = pending
      ? `Still working: ${name || 'the action'}. The lab shows how it ends.`
      : name
        ? `Done: ${name}`
        : 'Done';
    if (pending && body.action === 'lab-direction-add') opening = true;
    failure = undefined;
    if (action === 'stop') showStopped();
    // A new agent from the message box becomes the agent that the box writes to.
    if (body.action === 'message' && body.to === 'new-agent')
      knownSessions = new Set(sessionOptions());
    // A resumed session opens in the panel, and a new task opens as its page.
    if (action === 'resume' || action === 'restart') {
      selectedWorker = undefined;
      remember('worker', undefined);
      opener = undefined;
      navigate({ panel: 'worker' }, '#panel-title');
    } else if (action === 'task-create') {
      selectedTask = undefined;
      remember('task', undefined);
      opener = undefined;
      navigate({ view: 'task', panel: '' }, '#view-title', 'start');
    }
    for (const id of pending
      ? []
      : [
          'message-text',
          'setup-answer',
          'setup-feedback',
          'task-edit-reason',
          'answer-note',
          ...(body.action === 'coordinator-rule'
            ? [`rule-${String(body.check)}`]
            : []),
          ...(body.action === 'task-create'
            ? ['title', 'objective', 'inputs', 'writable', 'output'].map(
                (name) => `task-new-${name}`,
              )
            : []),
          ...(body.action === 'lab-post' ? ['lab-text', 'lab-reply'] : []),
          ...(body.action === 'lab-direction-add'
            ? ['lab-title', 'lab-bar']
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
        : 'The desk did not answer. Run verifold in the project folder to check that it still runs.';
    failure = { selector, message: actionLabel.textContent };
  } finally {
    // The key and secret fields are empty after each try, so a value stays on the page no longer than needed.
    const key = document.getElementById(
      action === 'compute-secret-save' ? 'secret-value' : 'runpod-key',
    );
    if (
      (action === 'compute-key-save' || action === 'compute-secret-save') &&
      key instanceof HTMLInputElement
    )
      key.value = '';
    showFailure();
    if (button instanceof HTMLButtonElement) button.disabled = false;
    // An error also stays next to its control until the next action.
    actionTimer = setTimeout(() => {
      actionLabel.textContent = '';
    }, 6000);
    void refresh();
  }
}

document.addEventListener('click', (event) => {
  const target =
    event.target instanceof Element
      ? event.target.closest('button, a.skip')
      : null;
  // On a phone the rail covers the view. A click beside it closes it.
  if (
    document.body.classList.contains('rail-open') &&
    !(event.target instanceof Element && event.target.closest('.rail, #menu'))
  ) {
    closeRail();
    return;
  }
  // A click on the line above the message box opens its thread. A click beside the box folds the thread, and on a phone it also closes the box.
  if (event.target instanceof Element && event.target.closest('.dock-threads'))
    document.body.classList.add('dock-expanded');
  else if (
    !(
      event.target instanceof Element &&
      event.target.closest('.dock, [data-dock], [data-message-to]')
    )
  )
    document.body.classList.remove('dock-open', 'dock-expanded');
  // A post that the search found opens on Home, with the search beside it. On a narrow screen the panel covers the board, so it closes.
  const found =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('a[data-post-link]')
      : null;
  if (found?.dataset.postLink) {
    event.preventDefault();
    navigate(
      {
        view: 'home',
        panel: matchMedia('(max-width: 860px)').matches ? '' : panel,
      },
      `#post-${CSS.escape(found.dataset.postLink)}`,
      'center',
    );
    return;
  }
  if (!(target instanceof HTMLElement)) return;
  if (target.matches('a.skip')) {
    event.preventDefault();
    document.getElementById('view')?.focus();
    return;
  }
  if (target.id === 'menu') {
    const open = document.body.classList.toggle('rail-open');
    target.setAttribute('aria-expanded', String(open));
    if (open)
      content
        .querySelector<HTMLElement>('.rail [aria-current="page"]')
        ?.focus();
    return;
  }
  if (target.dataset.view) {
    const focus = target.dataset.focus;
    navigate(
      { view: target.dataset.view },
      focus ? `#${CSS.escape(focus)}` : '#view-title',
      focus ? 'start' : 'nearest',
    );
    return;
  }
  if (target.dataset.panel) {
    // A lab panel names its item: a run, an agent, or a direction's diff.
    if (target.dataset.run) remember('run', (selectedRun = target.dataset.run));
    if (target.dataset.agent)
      remember('agent', (selectedAgent = target.dataset.agent));
    if (
      (target.dataset.panel === 'diff' || target.dataset.panel === 'bring') &&
      target.dataset.labDirection
    ) {
      remember('direction', (selectedDirection = target.dataset.labDirection));
      // A post's proof opens the diff that the post cites; a row opens the direction's.
      if (target.dataset.panel === 'diff')
        remember('proof', (selectedProof = target.dataset.proof));
    }
    if (target.dataset.openPane) choosePane(target.dataset.openPane);
    // A row's controls stay open, so the row keeps its place.
    if (!target.closest('.lab-row'))
      target.closest('details')?.removeAttribute('open');
    opener = selectorOf(target);
    const focus = target.dataset.focus;
    navigate(
      { panel: target.dataset.panel },
      focus ? `#${CSS.escape(focus)}` : '#panel-title',
      focus ? 'start' : 'nearest',
    );
    return;
  }
  if (target.hasAttribute('data-close-panel')) {
    navigate({ panel: '' }, opener ?? '#view-title');
    opener = undefined;
    return;
  }
  if (target.dataset.taskSelect) {
    openItem('task', target.dataset.taskSelect, target);
    return;
  }
  if (target.dataset.worker) {
    openItem('worker', target.dataset.worker, target);
    return;
  }
  if (target.dataset.attempt) {
    openItem('attempt', target.dataset.attempt, target);
    return;
  }
  if (target.dataset.direction) {
    openItem('direction', target.dataset.direction, target);
    return;
  }
  if (target.dataset.diff) void loadDiff(target);
  if (target.dataset.labDiff) void loadLabDiff(target);
  if (target.dataset.labMention) {
    mention(target.dataset.labMention);
    return;
  }
  if (target.dataset.messageTo) {
    writeTo(target.dataset.messageTo, target.dataset.about);
    return;
  }
  // On a phone the message box opens from a button.
  if (target.hasAttribute('data-dock')) {
    if (document.body.classList.toggle('dock-open'))
      document.getElementById('message-text')?.focus();
    return;
  }
  if (target.dataset.pane) choosePane(target.dataset.pane);
  // A new tab gets its own input lease, so it starts read-only. It keeps this tab's session storage.
  if (target.dataset.terminalTab)
    window.open(
      `/terminal?session=${encodeURIComponent(target.dataset.terminalTab)}`,
    );
  if (target.dataset.finished) {
    finished = target.dataset.finished === 'hidden' ? 'hidden' : 'shown';
    try {
      localStorage.setItem('verifold-desk-finished', finished);
    } catch {
      /* The choice lasts until reload when browser storage is unavailable. */
    }
    void refresh();
    return;
  }
  if (target.dataset.records) {
    records = target.dataset.records === 'tagged' ? 'tagged' : 'all';
    showDetail();
    try {
      localStorage.setItem('verifold-desk-records', records);
    } catch {
      /* The choice lasts until reload when browser storage is unavailable. */
    }
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
  if (target.id === 'notify' && 'Notification' in window)
    void Notification.requestPermission().then(showNotify);
  if (target.id === 'theme') {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
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
// `/` puts the cursor in the message box, outside a text field.
document.addEventListener('keydown', (event) => {
  const text = document.getElementById('message-text');
  if (
    event.key !== '/' ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    !(text instanceof HTMLTextAreaElement) ||
    (event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, [contenteditable], .terminal-screen',
      ))
  )
    return;
  event.preventDefault();
  if (matchMedia('(max-width: 860px)').matches)
    document.body.classList.add('dock-open');
  text.focus();
});
// Escape closes the phone menu, then the panel. In a text field it does nothing, so a draft stays.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // A search field clears itself on Escape. Here Escape keeps the words and closes the search.
  const searching =
    event.target instanceof HTMLElement &&
    event.target.id === 'lab-search' &&
    !event.isComposing;
  if (searching) event.preventDefault();
  if (document.body.classList.contains('rail-open')) {
    closeRail();
    menuButton.focus();
    return;
  }
  if (
    document.body.classList.contains('dock-open') ||
    document.body.classList.contains('dock-expanded')
  ) {
    document.body.classList.remove('dock-open', 'dock-expanded');
    return;
  }
  // In the search, Escape closes it. Its words stay for the next search.
  if (
    !panel ||
    document.body.classList.contains('t-locked') ||
    (!searching &&
      event.target instanceof Element &&
      event.target.closest('input, textarea, select'))
  )
    return;
  navigate({ panel: '' }, opener ?? '#view-title');
  opener = undefined;
});
content.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.dataset.file)
    showReview();
  if (
    event.target instanceof HTMLSelectElement &&
    event.target.id === 'message-to'
  )
    showThread();
});
// Writing opens the thread of the message box. A click on a button in the box does not, so the button stays in place.
content.addEventListener('focusin', (event) => {
  if (
    event.target instanceof HTMLElement &&
    (event.target.id === 'message-text' || event.target.id === 'message-to')
  )
    document.body.classList.add('dock-expanded');
});
// In the lab's message box, the names list takes the arrows, Enter, Tab, and Escape while it is open.
content.addEventListener('keydown', (event) => {
  if (
    !(event.target instanceof HTMLTextAreaElement) ||
    event.target.id !== 'lab-text' ||
    event.isComposing
  )
    return;
  const list = document.getElementById('lab-mentions');
  const chosen = list?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (list && !list.hidden) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      showMentions(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && chosen) {
      event.preventDefault();
      takeMention(chosen);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      mentionClosed = mentionWord(event.target)?.toLowerCase();
      showMentions();
      return;
    }
  }
  // Enter sends. Shift+Enter starts a new line.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const send = content.querySelector<HTMLElement>('[data-action="lab-post"]');
    if (send && !(send instanceof HTMLButtonElement && send.disabled))
      void act(send);
  }
});
content.addEventListener('input', (event) => {
  if (event.target instanceof HTMLElement && event.target.id === 'lab-text')
    showMentions();
});
// The lab's search asks the desk a moment after the person stops typing.
content.addEventListener('input', (event) => {
  if (
    !(event.target instanceof HTMLInputElement) ||
    event.target.id !== 'lab-search'
  )
    return;
  // The desk refuses control characters, such as a pasted tab, so they become spaces.
  const value = event.target.value.replace(/\p{Cc}/gu, ' ').trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = value || undefined;
    remember('q', searchQuery);
    void refresh();
  }, 250);
});
const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
/**
 * The K of ⌘K by the letter that the layout gives, so Colemak and Dvorak keep
 * their own shortcuts. A layout without Latin letters falls back to the key's
 * place. Autofill can send a keydown without a key.
 */
function isSearchKey(event: KeyboardEvent): boolean {
  const key = typeof event.key === 'string' ? event.key : '';
  return /^[a-z]$/i.test(key)
    ? key.toLowerCase() === 'k'
    : key.length === 1 && event.code === 'KeyK';
}
document.documentElement.classList.toggle('mac', mac);
// ⌘K, or Ctrl+K off a Mac, opens the lab's search from anywhere in the desk. In the search it selects the words.
document.addEventListener('keydown', (event) => {
  if (
    !isSearchKey(event) ||
    event.altKey ||
    event.shiftKey ||
    (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) ||
    (event.target instanceof Element &&
      event.target.closest('.terminal-screen'))
  )
    return;
  const trigger = content.querySelector<HTMLElement>('[data-panel="search"]');
  if (!trigger) return;
  event.preventDefault();
  const field = document.getElementById('lab-search');
  if (panel === 'search' && field instanceof HTMLInputElement) {
    field.focus();
    field.select();
    return;
  }
  // Closing the search returns focus to where it was, or to the view's title.
  const from = document.activeElement;
  opener =
    from instanceof HTMLElement && content.contains(from)
      ? selectorOf(from)
      : undefined;
  closeRail();
  navigate({ panel: 'search' }, '#lab-search');
});
// A press on a name takes it before the box loses focus.
content.addEventListener('mousedown', (event) => {
  const item =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('#lab-mentions [role="option"]')
      : null;
  if (!item) return;
  event.preventDefault();
  takeMention(item);
});
// 1, 2, or 3 chooses an option of the call that is open in Needs you, outside a text field.
document.addEventListener('keydown', (event) => {
  if (
    !['1', '2', '3'].includes(event.key) ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    (event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, [contenteditable], .terminal-screen',
      ))
  )
    return;
  const option = content.querySelector<HTMLElement>(
    `details[data-lab-call][open] [data-action="lab-call-answer"][data-option="${Number(event.key) - 1}"]`,
  );
  if (!option || (option instanceof HTMLButtonElement && option.disabled))
    return;
  event.preventDefault();
  void act(option);
});
// Enter sends a message. Shift+Enter starts a new line.
content.addEventListener('keydown', (event) => {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.isComposing ||
    !(event.target instanceof HTMLTextAreaElement) ||
    event.target.id !== 'message-text'
  )
    return;
  event.preventDefault();
  const send = content.querySelector<HTMLElement>('[data-action="message"]');
  if (send && !(send instanceof HTMLButtonElement && send.disabled))
    void act(send);
});
// A person who comes back after 5 minutes or more sees on Home what changed while they were away.
// In a lab, the owner keeps the last look and the page's look=1 counts it, so the page sets no since.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  if (
    !labShown &&
    hiddenAt !== undefined &&
    Date.now() - hiddenAt >= 5 * 60_000
  ) {
    since = new Date(hiddenAt).toISOString();
    remember('since', since);
  }
  hiddenAt = undefined;
  // A refresh at once counts the look.
  void refresh();
});
window.addEventListener('resize', drawMaps);
// A toggle does not bubble either. An opened run log loads at once.
content.addEventListener(
  'toggle',
  (event) => {
    if (
      event.target instanceof HTMLDetailsElement &&
      event.target.classList.contains('run-log')
    )
      showRunLogs();
  },
  true,
);
// A scroll does not bubble, so the page listens in the capture phase.
content.addEventListener(
  'scroll',
  (event) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.matches('[data-map], .table')
    )
      markEdge(event.target);
  },
  true,
);
window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(timer);
  request?.abort();
});
window.addEventListener('pageshow', () => {
  if (stopped && !ended) {
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
