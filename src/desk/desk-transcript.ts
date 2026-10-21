import DOMPurify from './vendor/purify.js';

/** One transcript entry as /api/transcript sends it. Text entries also carry rendered Markdown. */
interface Entry {
  readonly id: string;
  readonly order: number;
  readonly parent: string | null;
  readonly kind: string;
  readonly name?: string;
  readonly title?: string;
  readonly input?: string;
  readonly output?: string;
  readonly status?: string;
  readonly text?: string;
  readonly html?: string;
}

function readEntry(value: unknown): Entry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const optional = (key: string): boolean =>
    entry[key] === undefined || typeof entry[key] === 'string';
  return typeof entry.id === 'string' &&
    typeof entry.order === 'number' &&
    (entry.parent === null || typeof entry.parent === 'string') &&
    typeof entry.kind === 'string' &&
    ['name', 'title', 'input', 'output', 'status', 'text', 'html'].every(
      optional,
    )
    ? (entry as unknown as Entry)
    : null;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The first line of a text, and how many lines follow it. */
function firstLine(text: string): string {
  const lines = text.trimEnd().split('\n');
  const rest = lines.length - 1;
  const first = lines[0] ?? '';
  return `${first.length > 160 ? `${first.slice(0, 160)}…` : first}${rest ? `  … +${rest} ${rest === 1 ? 'line' : 'lines'}` : ''}`;
}

/** The elements of one entry. The page changes them in place when the entry changes. */
interface View {
  readonly root: HTMLElement;
  readonly children?: HTMLElement;
  readonly update: (entry: Entry) => void;
}

/**
 * One transcript panel, in the style of a coding CLI. It keeps its elements
 * between page renders, so open tool calls and the scroll position stay.
 */
class Panel {
  readonly root: HTMLElement;
  private readonly source: string;
  private readonly token: () => string;
  private readonly list: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly state: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly full: HTMLButtonElement;
  private readonly views = new Map<string, View>();
  private epoch = '';
  private last = 0;
  private busy = false;
  private failed = false;
  private scrollTop = 0;
  private follow = true;
  private tools = 0;

  constructor(source: string, label: string, token: () => string) {
    this.source = source;
    this.token = token;
    this.root = element('section', 'transcript');
    this.root.setAttribute('aria-label', label);
    const bar = element('div', 't-bar');
    bar.append(
      element('span', 't-heading', label),
      (this.state = element('span', 't-state')),
    );
    this.state.setAttribute('role', 'status');
    const open = element('button', 't-button', 'Open all');
    open.type = 'button';
    open.addEventListener('click', () => this.openAll(true));
    const close = element('button', 't-button', 'Close all');
    close.type = 'button';
    close.addEventListener('click', () => this.openAll(false));
    this.full = element('button', 't-button', 'Full screen');
    this.full.type = 'button';
    this.full.setAttribute('aria-pressed', 'false');
    this.full.addEventListener('click', () => this.fullScreen(!this.isFull));
    bar.append(open, close, this.full);
    this.scroller = element('div', 't-scroll');
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'log');
    this.scroller.setAttribute('aria-label', `${label}, newest at the end`);
    this.scroller.addEventListener('scroll', () => {
      this.scrollTop = this.scroller.scrollTop;
      this.follow =
        this.scroller.scrollHeight -
          this.scroller.scrollTop -
          this.scroller.clientHeight <
        40;
    });
    this.list = element('div', 't-list');
    this.empty = element('p', 't-empty', 'Waiting for the harness…');
    this.scroller.append(this.empty, this.list);
    this.root.append(bar, this.scroller);
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isFull) {
        this.fullScreen(false);
        this.full.focus();
      }
    });
  }

  get isFull(): boolean {
    return this.root.classList.contains('t-full');
  }

  /** Put the panel into a slot of the new page render. */
  attach(slot: HTMLElement): void {
    if (this.root.parentElement !== slot) slot.replaceChildren(this.root);
    this.scroller.scrollTop = this.follow
      ? this.scroller.scrollHeight
      : this.scrollTop;
  }

  get visible(): boolean {
    return (
      this.root.isConnected && (this.isFull || this.root.offsetParent !== null)
    );
  }

  fullScreen(on: boolean): void {
    this.root.classList.toggle('t-full', on);
    document.body.classList.toggle('t-locked', on);
    this.full.setAttribute('aria-pressed', String(on));
    this.full.textContent = on ? 'Exit full screen' : 'Full screen';
  }

  private openAll(open: boolean): void {
    for (const details of this.list.querySelectorAll<HTMLDetailsElement>(
      'details.t-tool, details.t-thinking',
    ))
      details.open = open;
  }

  /** Ask for the entries that changed since the last answer. */
  async poll(): Promise<void> {
    if (this.busy || !this.visible) return;
    this.busy = true;
    try {
      let more = true;
      for (let pages = 0; more && pages < 20; pages++) {
        const response = await fetch(
          `/api/transcript?source=${encodeURIComponent(this.source)}&after=${this.last}${this.epoch ? `&epoch=${this.epoch}` : ''}`,
          {
            headers: { Authorization: `Bearer ${this.token()}` },
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response.ok) throw new Error(String(response.status));
        const page = (await response.json()) as Record<string, unknown>;
        if (typeof page.epoch !== 'string' || typeof page.last !== 'number')
          throw new Error('Unreadable transcript');
        if (page.epoch !== this.epoch) {
          // The server started a new log, so the panel starts again.
          this.views.clear();
          this.list.replaceChildren();
          this.tools = 0;
          this.epoch = page.epoch;
        }
        this.last = page.last;
        more = page.more === true;
        const entries = Array.isArray(page.entries)
          ? page.entries.map(readEntry).filter((entry) => entry !== null)
          : [];
        this.apply(entries);
        this.empty.textContent =
          page.found === false
            ? 'Verifold did not save a transcript for this run.'
            : 'Waiting for the harness…';
      }
      this.failed = false;
    } catch {
      this.failed = true;
    } finally {
      this.busy = false;
      this.showState();
    }
  }

  private showState(): void {
    this.empty.hidden = this.views.size > 0;
    this.state.textContent = this.failed
      ? 'Not updated. Trying again…'
      : `${this.tools} tool ${this.tools === 1 ? 'call' : 'calls'}`;
  }

  private apply(entries: readonly Entry[]): void {
    const follow = this.follow;
    const added: [Entry, View][] = [];
    for (const entry of entries) {
      let view = this.views.get(entry.id);
      if (!view) {
        view = this.create(entry);
        this.views.set(entry.id, view);
        added.push([entry, view]);
        if (entry.kind === 'tool') this.tools++;
      }
      view.update(entry);
    }
    // Place new entries after all entries of the page exist, so a parent that changed later is found.
    for (const [entry, view] of added) {
      const container =
        (entry.parent ? this.views.get(entry.parent)?.children : undefined) ??
        this.list;
      let before: Element | null = null;
      for (
        let child = container.lastElementChild;
        child instanceof HTMLElement &&
        Number(child.dataset.order) > entry.order;
        child = child.previousElementSibling
      )
        before = child;
      container.insertBefore(view.root, before);
      if (entry.parent) this.countChild(entry.parent);
    }
    if (follow) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** A subagent call shows how many steps run under it. */
  private countChild(parent: string): void {
    const view = this.views.get(parent);
    const count = view?.children?.childElementCount ?? 0;
    const label = view?.root.querySelector<HTMLElement>(
      ':scope > summary .t-steps',
    );
    if (label) label.textContent = `${count} ${count === 1 ? 'step' : 'steps'}`;
  }

  private create(entry: Entry): View {
    switch (entry.kind) {
      case 'tool':
        return this.tool(entry);
      case 'thinking': {
        const root = element('details', 't-entry t-thinking');
        const summary = element('summary', '');
        summary.append(
          element('span', 't-mark', '✻'),
          element('span', 't-muted', 'Thinking'),
        );
        const body = element('div', 't-pre');
        root.append(summary, body);
        return {
          root: this.ordered(root, entry),
          update: (next) => {
            body.textContent = next.text ?? '';
          },
        };
      }
      case 'request': {
        const root = element('details', 't-entry t-request');
        const summary = element('summary', '');
        const line = element('span', 't-line');
        summary.append(
          element('span', 't-mark', entry.parent ? '↳' : '›'),
          line,
        );
        const body = element('div', 't-pre');
        root.append(summary, body);
        return {
          root: this.ordered(root, entry),
          update: (next) => {
            const text = next.text ?? '';
            line.textContent = `${entry.parent ? 'Prompt: ' : ''}${firstLine(text)}`;
            body.textContent = text;
          },
        };
      }
      case 'text': {
        const root = element('div', 't-entry t-text');
        const body = element('div', 'md');
        root.append(element('span', 't-mark', '⏺'), body);
        return {
          root: this.ordered(root, entry),
          update: (next) => {
            // The server renders Markdown and escapes HTML. The page sanitizes it again.
            body.innerHTML = DOMPurify.sanitize(next.html ?? '', {
              ADD_ATTR: ['target'],
            });
          },
        };
      }
      default: {
        const root = element('p', 't-entry t-note');
        return {
          root: this.ordered(root, entry),
          update: (next) => {
            root.textContent = next.text ?? '';
          },
        };
      }
    }
  }

  private ordered(root: HTMLElement, entry: Entry): HTMLElement {
    root.dataset.order = String(entry.order);
    return root;
  }

  /** A tool call: name and target when closed, then input, output, and subagent steps. */
  private tool(entry: Entry): View {
    const root = element('details', 't-entry t-tool');
    const summary = element('summary', '');
    const name = element('span', 't-name');
    const title = element('span', 't-title');
    const status = element('span', 't-status');
    const steps = element('span', 't-steps');
    const preview = element('span', 't-preview');
    summary.append(
      element('span', 't-mark', '⏺'),
      name,
      title,
      status,
      steps,
      preview,
    );
    const input = element('pre', 't-pre');
    const output = element('pre', 't-pre');
    const outputLabel = element('span', 't-label', 'Output');
    const children = element('div', 't-children');
    // Subagent steps come between the call and its result, as in the CLI.
    root.append(
      summary,
      element('span', 't-label', 'Input'),
      input,
      children,
      outputLabel,
      output,
    );
    return {
      root: this.ordered(root, entry),
      children,
      update: (next) => {
        root.dataset.status = next.status ?? 'running';
        name.textContent = next.name ?? 'Tool';
        title.textContent = next.title ? `(${next.title})` : '';
        status.textContent =
          next.status === 'running'
            ? 'Running'
            : next.status === 'failed'
              ? 'Failed'
              : '';
        input.textContent = next.input ?? '';
        output.textContent = next.output ?? '';
        outputLabel.hidden = output.hidden = next.output === undefined;
        preview.textContent =
          next.output === undefined ? '' : `⎿  ${firstLine(next.output)}`;
      },
    };
  }
}

const panels = new Map<string, Panel>();
let ticker: ReturnType<typeof setInterval> | undefined;

/**
 * Put a transcript panel into each `.transcript-slot` of the page. Panels keep
 * their state across renders. A panel without a slot stops asking for updates.
 */
export function mountTranscripts(main: HTMLElement, token: () => string): void {
  const used = new Set<string>();
  for (const slot of main.querySelectorAll<HTMLElement>('.transcript-slot')) {
    const source = slot.dataset.source;
    if (!source || used.has(source)) continue;
    used.add(source);
    let panel = panels.get(source);
    if (!panel) {
      panel = new Panel(
        source,
        slot.dataset.label ?? 'Harness transcript',
        token,
      );
      panels.set(source, panel);
    }
    panel.attach(slot);
    void panel.poll();
  }
  for (const [source, panel] of panels)
    if (!used.has(source)) {
      if (panel.isFull) panel.fullScreen(false);
      panels.delete(source);
    }
  ticker ??= setInterval(() => {
    if (document.hidden) return;
    for (const panel of panels.values()) void panel.poll();
  }, 1000);
}

/** Poll the panels at once, for example after the person switches to Details. */
export function refreshTranscripts(): void {
  for (const panel of panels.values()) void panel.poll();
}
