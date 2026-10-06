import { escapeHtml as e } from '../ui/dom.ts';
import { markdownHtml } from './markdown.ts';
import type { Candidate, Workspace } from './contracts.ts';
import type { DeskSnapshot, DeskAttempt } from './desk-records.ts';
import type { ResearchReport } from './research.ts';
import type { ResearchSource, ResearchView } from './research-runner.ts';
import type { SetupPrompt, SetupView } from './setup-bridge.ts';
import {
  forPerson,
  replaced,
  type TaskRecord,
  type TaskVersion,
} from './tasks.ts';
import type { Message } from './messages.ts';
import type { CheckResult, Results } from './results.ts';
import type { ComputeView } from './compute.ts';
import { placeNames } from './credentials.ts';
import {
  isOpen,
  isRunning,
  maxCost,
  spent,
  usd,
  type Lease,
} from './leases.ts';
import {
  coordinatorLimits,
  directionObjective,
  type CoordinatorView,
} from './coordinator.ts';
import { workerLimit } from './workers.ts';
import {
  decisionLabel,
  hostName,
  modeLabel,
  needsReview,
  type CommandEntry,
  type PausedSession,
  type PendingRequest,
  type SessionEvent,
  type SessionRecord,
  type SessionView,
} from './session.ts';

export interface DeskSession {
  /** The worker that the page shows in full. */
  readonly session: SessionView | null;
  /** Every worker with a session, live or ended. */
  readonly workers?: readonly SessionView[];
  /** Every worker slot is in use. */
  readonly full?: boolean;
  /** True when terminal panes work here, or why they do not. */
  readonly terminals?: true | string;
  /** The desk process owns a session manager, so the page can start and control a session. */
  readonly controllable: boolean;
  /** Sessions that an earlier owner paused. */
  readonly paused?: readonly PausedSession[];
  /** Research in this owner. Without it, research runs only from the CLI. */
  readonly research?: ResearchView;
  readonly tasks?: TaskView;
  /** The coordinator of this owner. Null: none has started in this project. */
  readonly coordinator?: CoordinatorView | null;
  /** RunPod key, limits, and GPUs. Only a project owner has them. */
  readonly compute?: ComputeView;
}

export interface TaskView {
  readonly list: readonly TaskRecord[];
  /** The task that the page shows. */
  readonly selected: TaskRecord | null;
  /** Live sessions that wait for a follow-up. */
  readonly idle: readonly string[];
  /** The latest messages, oldest first. */
  readonly messages?: readonly Message[];
}

/** The views of the desk. The rail lists them in this order, except Needs you, which the top bar opens. */
export const deskViews = [
  'home',
  'research',
  'tasks',
  'results',
  'compute',
  'records',
  'needs',
] as const;
export type DeskView = (typeof deskViews)[number];

/** What the side panel shows: one item, or the form for a new one. */
export const deskPanels = [
  'task',
  'worker',
  'attempt',
  'direction',
  'coordinator',
  'new-task',
  'new-session',
] as const;
export type DeskPanel = (typeof deskPanels)[number];

/** The view and the panel that the person opened. The page keeps them, not the project. */
export interface DeskFrame {
  readonly view: DeskView;
  readonly panel: DeskPanel | null;
  /** When the page went to the background for a while. Home lists what changed after it. */
  readonly since?: string;
  /** The direction that the direction panel shows. */
  readonly direction?: string;
}

/** The frame from the query of /api/view, or null when a value is unknown. No view means Home. */
export function parseFrame(
  view: string | null,
  panel: string | null,
  since: string | null = null,
  direction: string | null = null,
): DeskFrame | null {
  const shown = deskViews.find((entry) => entry === (view ?? 'home'));
  const opened = deskPanels.find((entry) => entry === panel) ?? null;
  const time =
    since !== null &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(since) &&
    Number.isFinite(Date.parse(since));
  // Direction IDs are lowercase slugs, as the research report contract says.
  const idea =
    direction === null || /^[a-z0-9][a-z0-9-]{0,79}$/.test(direction);
  return shown && (panel === null || opened) && (since === null || time) && idea
    ? {
        view: shown,
        panel: opened,
        ...(since ? { since } : {}),
        ...(direction ? { direction } : {}),
      }
    : null;
}

export function nextResearchAction(workspace: Workspace): {
  command: string;
  instruction: string;
} {
  if (workspace.selectedId)
    return {
      command: 'verifold',
      instruction:
        'The coordinator plans and runs the tasks for the chosen direction. Open the desk to approve its plan and follow the team.',
    };
  const phase = workspace.research?.phase;
  if (phase === 'directions')
    return {
      command: 'verifold select',
      instruction:
        'Use research --feedback to refine a direction, or select to choose one.',
    };
  if (phase === 'awaiting-plan-review')
    return {
      command: 'verifold research --approve',
      instruction:
        'Use research --feedback to revise the plan, or research --approve to continue.',
    };
  if (phase)
    return {
      command: 'verifold research',
      instruction: 'Use research to resume the saved research session.',
    };
  return {
    command: 'verifold research --topic "your question"',
    instruction: 'Use research --topic "your question" to begin.',
  };
}

function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case 'needs-plan':
      return 'Research planning';
    case 'awaiting-plan-review':
      return 'Plan awaiting review';
    case 'needs-research':
      return 'Source exploration';
    case 'directions':
      return 'Directions ready';
    default:
      return 'Ready to begin';
  }
}

function outcome(attempt: DeskAttempt): string {
  if (attempt.activity === 'recent') return 'Recently active';
  switch (attempt.record?.status) {
    case 'succeeded':
      return 'Response accepted';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted, outcome unknown';
    default:
      return 'Outcome unknown';
  }
}

function time(value: string): string {
  return new Date(value).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** A time of today as the clock time, an earlier one with its date. */
function since(value: string): string {
  return new Date(value).toDateString() === new Date().toDateString()
    ? clock(value)
    : time(value);
}

function clock(value: string): string {
  return new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function elapsed(since: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(since).getTime()) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/** The first sentence of a text, or its start, as a lead of at most `max` characters. */
function lead(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  if (sentence.length <= max) return sentence;
  return `${flat.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/** Markdown as plain text, for a lead. The full text renders as Markdown. */
function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Long text as its lead with Show all. Short text shows in full. The full
 * text is one click away, and the page keeps an open one open by its ID.
 * `full` is HTML, already escaped or sanitized Markdown.
 */
function fold(id: string, text: string, full: string, max: number): string {
  const short = lead(text, max);
  if (short === text.replace(/\s+/g, ' ').trim()) return full;
  return `<details class="more" id="${e(id)}"><summary><span class="lead">${e(short)}</span> <span class="more-hint"><span class="closed">Show all</span><span class="opened">Show less</span></span></summary>${full}</details>`;
}

/** Plain text, folded when it is long. */
function more(id: string, text: string, max = 160): string {
  return fold(id, text, `<p class="pre">${e(text)}</p>`, max);
}

/** Markdown, folded when it is long. The lead is plain text. */
function moreMd(id: string, markdown: string, max = 220): string {
  return fold(
    id,
    plain(markdown),
    `<div class="md">${markdownHtml(markdown)}</div>`,
    max,
  );
}

const detailSwitch =
  '<div class="seg detail-switch" role="group" aria-label="Level of detail"><button type="button" data-detail="summary">Summary</button><button type="button" data-detail="details">Details</button></div>';

/**
 * A place for a transcript panel. The page fills it from /api/transcript and
 * keeps the panel between renders. `detail` shows it only in Details.
 */
function transcriptSlot(
  source: string,
  label: string,
  visibility = 'detail-only',
): string {
  return `<div class="transcript-slot${visibility ? ` ${visibility}` : ''}" data-source="${e(source)}" data-label="${e(label)}"></div>`;
}

const transcriptNote =
  '<p class="fine detail-only">The transcript shows what the harness reported: messages, tool calls with their input and output, and subagent steps under the call that started them. It stays private in this project.</p>';

/** The research step of this owner. Summary is the default level of detail. */
function renderResearch(
  view: ResearchView | undefined,
  attempt: string | undefined,
): string {
  if (!view?.step) return '';
  const observed = view.events.filter((event) => event.kind === 'tool').length;
  const last = view.events.at(-1);
  return `<section class="card research-live" aria-labelledby="research-live-title"><div class="section-title"><h2 id="research-live-title">Research agent</h2><span class="status ${view.running ? 'active' : 'muted'}">${view.running ? 'Running' : 'Not running'}</span></div>
  <p class="research-step">${e(view.step)}${view.running && view.startedAt ? `, for ${e(elapsed(view.startedAt))}` : ''}</p>
  ${detailSwitch}
  <p class="research-summary summary-only">${observed} harness ${observed === 1 ? 'event' : 'events'} observed.${last ? ` Latest: ${e(last.text)}` : ''}</p>
  ${attempt ? `${transcriptSlot(`attempt:${attempt}`, 'Research transcript')}${transcriptNote}` : ''}
  ${view.running ? '<p class="fine">If you cancel, the saved checkpoint and the attempt files stay.</p><div class="actions"><button type="button" data-action="cancel-research">Cancel research</button></div>' : ''}</section>`;
}

/**
 * The research step for the person, with one primary action. Research shows
 * each decision beside the records that it is about. Home shows only the
 * status, because Needs you lists the decisions.
 */
function renderDecision(
  workspace: Workspace,
  live: DeskSession,
  place: 'home' | 'research',
): string {
  const research = live.research;
  if (!research || workspace.selectedId) return '';
  const home = place === 'home';
  if (research.running)
    return home
      ? `<section class="card lead"><h2>Research is running</h2><p>${e(research.step ? `${research.step}.` : 'A research step runs.')} Follow it in Research.</p><p class="fine">If you cancel, the saved checkpoint and the attempt files stay.</p><div class="actions"><button type="button" class="primary" data-view="research">Follow the research</button><button type="button" data-action="cancel-research">Cancel research</button></div></section>`
      : '';
  const phase = workspace.research?.phase;
  if (phase === undefined)
    return `<section class="card lead"><h2>Start research</h2><p>Write the question that research should explore. The harness plans the research first.</p><label class="field" for="research-topic">Question</label><textarea id="research-topic" rows="3" maxlength="4000"></textarea><label class="check" for="research-guided"><input type="checkbox" id="research-guided" checked> Stop at the plan for my approval</label><div class="actions"><button type="button" class="primary" data-action="research" data-research="start">Start research</button></div></section>`;
  if (home) return '';
  const feedback = (label: string): string =>
    `<label class="field" for="research-feedback">Changes</label><textarea id="research-feedback" rows="3" maxlength="4000" placeholder="${e(label)}"></textarea><div class="actions"><button type="button" data-action="research" data-research="feedback">Ask for changes</button></div>`;
  switch (phase) {
    case 'awaiting-plan-review':
      return `<section class="card needs"><h2>Review the plan</h2><p>Read the research scope below. Approve it to start the source search, or ask for changes.</p><div class="actions"><button type="button" class="primary" data-action="research" data-research="approve">Approve the plan</button></div>${feedback('What should change in the plan?')}</section>`;
    case 'directions':
      return `<section class="card needs"><h2>Choose a direction</h2><p>Choose one of the directions below. The choice locks it for this project. You can ask for changes first.</p>${feedback('What should change in the directions?')}</section>`;
    default:
      return `<section class="card needs"><h2>Continue research</h2><p>Research stopped before this step ended. Continue from the saved checkpoint.</p><div class="actions"><button type="button" class="primary" data-action="research" data-research="continue">Continue research</button></div></section>`;
  }
}

const eventLabels: Record<SessionEvent['kind'], string> = {
  you: 'You',
  agent: 'Agent says',
  tool: 'Verifold saw',
  request: 'Needs you',
  decision: 'Decision',
  status: 'Status',
  notice: 'Notice',
};

function result(command: CommandEntry): string {
  switch (command.outcome) {
    case 'running':
      return 'Running';
    case 'ok':
      return command.exitCode === undefined
        ? 'Done'
        : `Exit ${command.exitCode}`;
    case 'failed':
      return command.exitCode === undefined
        ? 'Failed'
        : `Failed, exit ${command.exitCode}`;
    case 'declined':
      return 'Declined';
    case 'denied':
      return 'Denied';
    case 'unknown':
      return 'Unknown';
  }
}

const sessionStatus: Record<string, [string, string]> = {
  starting: ['Starting', 'active'],
  terminal: ['You hold the terminal', 'active'],
  running: ['Working', 'active'],
  idle: ['Waiting for a follow-up', 'muted'],
  ended: ['Ended', 'muted'],
  failed: ['Stopped with an error', 'failed'],
};

const paneSwitch =
  '<div class="seg pane-switch" role="group" aria-label="Worker view"><button type="button" data-pane="summary">Summary</button><button type="button" data-pane="details">Details</button><button type="button" data-pane="terminal">Terminal</button></div>';

/**
 * The worker's own terminal. While the person holds it, a framed terminal page
 * fills the slot. Otherwise the pane says what opening it does, or why it cannot open.
 */
function renderTerminal(view: SessionView, live: DeskSession): string {
  const { record } = view;
  const name = hostName(record.host);
  if (typeof live.terminals === 'string')
    return `<p class="notice">${e(live.terminals)}</p>`;
  if (record.status === 'terminal')
    return `<p class="fine">${record.host === 'claude' ? 'You work in the Claude Code terminal. Verifold records no tool calls until you return.' : 'You work in the Codex terminal. Codex keeps reporting its events to Verifold.'}</p><div class="terminal-slot" data-session="${e(record.id)}" data-label="${e(name)} terminal"></div><div class="actions"><button type="button" class="primary" data-action="terminal-return" data-session="${e(record.id)}">Return to Verifold</button><button type="button" data-terminal-tab="${e(record.id)}">Open in new tab</button></div>`;
  if (!view.live)
    return '<p class="fine">The session ended. Start or resume a session to open its terminal.</p>';
  const off =
    record.status === 'idle'
      ? ''
      : 'Open the terminal between turns. Wait for the turn to end, or cancel it.';
  return `<p class="fine">${record.host === 'claude' ? `Verifold stops its Claude Code process and opens Claude Code in a terminal on this conversation${record.mode === 'strict' ? ', with the task limits' : ''}. While you work there, Verifold records no tool calls.` : `Codex opens in a terminal on this session${record.mode === 'strict' ? ', with the task limits' : ''}. Codex keeps reporting its events while you type.`}${record.task ? ' When you return, Verifold saves the task folder as a version.' : ' Return to Verifold to continue here.'}</p>${off ? `<p class="notice" id="terminal-off">${off}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="terminal-open" data-session="${e(record.id)}"${off ? ' disabled aria-describedby="terminal-off"' : ''}>Open the terminal</button></div>`;
}

/** The status of a live worker. A task worker that waits has a version to review. */
function workerStatus(record: SessionView['record']): [string, string] {
  if (record.task && record.status === 'idle')
    return ['Ready for review', 'active'];
  return sessionStatus[record.status] ?? ['Unknown', 'muted'];
}

/** A glyph for each kind of agent. The ring around it shows the state, and the text beside it says the state. */
const glyphs = {
  coordinator: '<img src="/symbol.webp" alt="">',
  research:
    '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/></svg>',
  task: '<svg viewBox="0 0 24 24"><path d="M3 4h6v6H3zM15 14h6v6h-6zM6 10v3a3 3 0 0 0 3 3h6"/></svg>',
  session: '<svg viewBox="0 0 24 24"><path d="M4 6l5 6-5 6M12 18h8"/></svg>',
} as const;

function avatar(kind: keyof typeof glyphs, state: string): string {
  return `<span class="avatar s-${state}" aria-hidden="true">${glyphs[kind]}</span>`;
}

/** A task worker has the name of its task. A plain session has the name of its harness. */
function workerName(
  record: SessionRecord,
  tasks: readonly TaskRecord[],
): string {
  const id = record.task?.id;
  if (!id) return `${hostName(record.host)} session`;
  return tasks.find((task) => task.id === id)?.assignment.title ?? id;
}

/** What a permission request asks for, and its answer. */
function requestBody(request: PendingRequest): string {
  return `<code class="request-action">${e(request.action)}</code>${request.detail ? `<p class="fine">Change to review:</p><code class="detail">${e(request.detail)}</code>` : ''}${request.reason ? `<p class="fine">Reason from the harness: ${e(request.reason)}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="answer" data-request="${e(request.id)}" data-decision="allow">Allow once</button><button type="button" data-action="answer" data-request="${e(request.id)}" data-decision="deny">Deny</button></div>`;
}

/** One permission request in the worker's panel. */
function requestItem(
  record: SessionRecord,
  request: PendingRequest,
  tasks: readonly TaskRecord[],
): string {
  return `<article class="request" aria-label="Request ${e(request.id)}"><p class="request-type"><span class="mark you" aria-hidden="true"></span>${e(workerName(record, tasks))} asks to use ${e(request.tool)}<span class="ref">${e(request.id)}</span></p>${requestBody(request)}</article>`;
}

/** What the side panel shows. `sub` is HTML, already escaped. */
interface Panel {
  readonly kind: string;
  readonly title: string;
  readonly sub: string;
  readonly body: string;
}

/** One worker in full: its requests, its events, its transcript and terminal, and its controls. All harness text is escaped. */
function workerPanel(
  view: SessionView,
  live: DeskSession,
  tasks: readonly TaskRecord[],
): Panel {
  const { record } = view;
  const running = view.live;
  const [label, tone] = running
    ? workerStatus(record)
    : record.status === 'failed'
      ? ['Stopped with an error', 'failed']
      : ['Ended', 'muted'];
  const body = `<p class="session-meta"><span>${e(hostName(record.host))}</span><span>Mode: ${e(modeLabel(record))}</span><span>Model request: ${e(record.model ?? 'harness default')}</span>${record.costUsd === null ? '' : `<span>Cost estimate from Claude Code: $${e(record.costUsd.toFixed(2))}</span>`}</p>
  ${view.saveFailed ? '<p class="notice">Verifold could not save the latest session record. The next change tries again.</p>' : ''}
  ${record.requests.length > 10 ? `<p class="notice">${record.requests.length} requests are open. The first 10 are shown.</p>` : ''}
  ${record.requests
    .slice(0, 10)
    .map((request) => requestItem(record, request, tasks))
    .join('')}
  ${paneSwitch}
  <ol class="session-events pane-summary">${record.events
    .slice(-60)
    .map((event, index, shown) => {
      // The position in the whole record stays the same as events arrive, so an open one stays open.
      const id = `event-${record.id}-${record.events.length - shown.length + index}`;
      return `<li class="event event-${e(event.kind)}"><span class="event-kind">${e(eventLabels[event.kind])}</span><div class="event-text">${event.kind === 'agent' ? moreMd(id, event.text, 200) : more(id, event.text, 200)}</div><time datetime="${e(event.at)}">${e(clock(event.at))}</time></li>`;
    })
    .join('')}</ol>
  ${transcriptSlot(`session:${record.id}`, `${hostName(record.host)} transcript`, 'pane-details')}
  <div class="pane-terminal">${renderTerminal(view, live)}</div>
  ${
    record.task
      ? `<p class="fine">It works in the folder of its task, in Strict mode.</p><div class="actions"><button type="button" data-task-select="${e(record.task.id)}">Open the task</button></div>`
      : running && record.status !== 'terminal'
        ? record.status === 'idle'
          ? `<label class="field" for="follow-up">Follow-up</label><textarea id="follow-up" rows="3" maxlength="100000" placeholder="Ask the agent to continue or change course."></textarea><div class="actions"><button type="button" class="primary" data-action="send" data-session="${e(record.id)}">Send follow-up</button><button type="button" data-action="end" data-session="${e(record.id)}">End session</button></div>`
          : `<div class="actions"><button type="button" data-action="cancel" data-session="${e(record.id)}">Cancel this turn</button><button type="button" data-action="end" data-session="${e(record.id)}">End session</button></div>`
        : ''
  }
  ${!running && record.nativeSessionId ? `<p class="fine">Native session: ${e(record.nativeSessionId)}. The record is in .verifold/sessions/${e(record.id)}.json.</p>` : ''}`;
  return {
    kind: record.task ? 'Task agent' : 'Session',
    title: workerName(record, tasks),
    sub: `<span class="status ${tone}">${e(label)}</span>`,
    body,
  };
}

/** Sessions that an earlier owner left open. Home offers Resume for each. */
function renderPaused(live: DeskSession): string {
  const paused = live.paused ?? [];
  if (!live.controllable || live.full || !paused.length) return '';
  return `<section class="card" aria-labelledby="paused-title"><h2 id="paused-title">${paused.some((entry) => entry.status === 'interrupted') ? 'Paused and interrupted sessions' : 'Paused sessions'}</h2><p class="fine">Verifold stopped while these sessions were open. Resume one to continue its conversation in a new harness process. If no conversation was recorded, start its first request again.</p><ul class="paused-list">${paused
    .slice(0, 10)
    .map(
      (entry) =>
        `<li><span class="paused-meta"><span>${e(hostName(entry.host))}</span><span>${e(time(entry.startedAt))}</span><span>${entry.status === 'interrupted' ? 'Interrupted, outcome unknown' : 'Paused'}</span></span><span class="paused-request">${e(entry.request.length > 160 ? `${entry.request.slice(0, 160)}…` : entry.request)}</span><span class="actions"><button type="button" data-action="${entry.restart ? 'restart' : 'resume'}" data-session="${e(entry.id)}">${entry.restart ? 'Start again' : 'Resume'}</button></span></li>`,
    )
    .join('')}</ul></section>`;
}

/** The form for a new plain session, or why no session can start. */
function startForm(live: DeskSession, defaultHost: string): string {
  if (!live.controllable)
    return '<p class="empty-note">This desk only reads saved work. Run verifold in the project directory to start sessions here.</p>';
  if (live.full)
    return `<p class="notice">${workerLimit} workers run. End a session, or accept, reject, or cancel a task version first.</p>`;
  const running = (live.workers ?? []).filter((worker) => worker.live).length;
  const host = defaultHost === 'codex' ? 'codex' : 'claude';
  return `<p class="fine">${running ? `${running} of ${workerLimit} workers run. You can start ${workerLimit - running} more. ` : ''}The harness runs in this project folder with its own sign-in and settings. In Ask me, each permission request comes here and to your terminal. Verifold records each tool call that the harness reports.</p><div class="fields"><label class="field" for="session-host">Harness<select id="session-host"><option value="claude"${host === 'claude' ? ' selected' : ''}>Claude Code</option><option value="codex"${host === 'codex' ? ' selected' : ''}>Codex</option></select></label><label class="field" for="session-mode">Commands<select id="session-mode"><option value="ask">Ask me</option><option value="auto">Auto</option></select></label><label class="field" for="session-model">Model<input id="session-model" type="text" maxlength="200" placeholder="Harness default"></label></div><label class="field" for="session-prompt">Request</label><textarea id="session-prompt" rows="5" maxlength="100000" placeholder="What should the harness do?"></textarea><div class="actions"><button type="button" class="primary" data-action="start">Start session</button></div>`;
}

const taskStates: Record<TaskRecord['state'], [string, string]> = {
  open: ['Open', 'muted'],
  claimed: ['Preparing', 'active'],
  running: ['Running', 'active'],
  review: ['Ready for review', 'active'],
  done: ['Done', 'muted'],
  cancelled: ['Cancelled', 'muted'],
};

/** The mark beside a task in the list. The state text beside it says the same. */
const taskMarks: Record<TaskRecord['state'], string> = {
  open: 'wait',
  claimed: 'working',
  running: 'working',
  review: 'review',
  done: 'done',
  cancelled: 'idle',
};

const turnLabels: Record<TaskVersion['turn'], string> = {
  completed: 'the turn ended',
  interrupted: 'you stopped the turn',
  failed: 'the turn failed',
  exited: 'the harness process exited',
  'time-limit': 'the time limit stopped the turn',
  stopped: 'Verifold stopped during the turn',
  terminal: 'you worked in the terminal',
};

/** A task form. The new-task form and the edit form share it, with different ID prefixes. */
function taskForm(
  prefix: 'task-new' | 'task-edit',
  values: TaskRecord['assignment'] | null,
  others: readonly TaskRecord[],
  host: string,
): string {
  const field = (name: string, label: string, control: string): string =>
    `<label class="field" for="${prefix}-${name}">${e(label)}</label>${control}`;
  const area = (name: string, rows: number, max: number, value = ''): string =>
    `<textarea id="${prefix}-${name}" rows="${rows}" maxlength="${max}">${e(value)}</textarea>`;
  const chosen = values?.host ?? (host === 'codex' ? 'codex' : 'claude');
  return `${field('title', 'Title', `<input id="${prefix}-title" type="text" maxlength="120" value="${e(values?.title ?? '')}">`)}
  ${field('objective', 'What should the agent do?', area('objective', 4, 8000, values?.objective))}
  ${field('inputs', 'Input files, one path per line (Verifold copies them now)', area('inputs', 2, 4000, values?.inputs.map((input) => input.path).join('\n')))}
  ${field('writable', 'Where it may write, one path per line', area('writable', 2, 4000, values?.writable.join('\n')))}
  ${field('output', 'What it should produce', area('output', 2, 2000, values?.output))}
  ${field('network', 'Domains that its shell commands may reach, one per line (empty: no network)', area('network', 2, 2000, values?.network?.domains.join('\n')))}
  ${field('network-reason', 'Why it needs them', `<input id="${prefix}-network-reason" type="text" maxlength="500" value="${e(values?.network?.reason ?? '')}">`)}
  <div class="fields"><label class="field" for="${prefix}-host">Harness<select id="${prefix}-host"><option value="claude"${chosen === 'claude' ? ' selected' : ''}>Claude Code</option><option value="codex"${chosen === 'codex' ? ' selected' : ''}>Codex</option></select></label><label class="field" for="${prefix}-model">Model<input id="${prefix}-model" type="text" maxlength="200" placeholder="Harness default" value="${e(values?.model ?? '')}"></label><label class="field" for="${prefix}-minutes">Time limit for each turn, in minutes<input id="${prefix}-minutes" type="number" min="1" max="240" value="${values?.minutes ?? 30}"></label></div>
  ${
    others.length
      ? `<fieldset class="task-deps"><legend>Wait for these tasks to be done</legend>${others
          .map(
            (other) =>
              `<label class="check" for="${prefix}-dep-${e(other.id)}"><input type="checkbox" id="${prefix}-dep-${e(other.id)}" data-dep="${e(other.id)}"${values?.dependencies.includes(other.id) ? ' checked' : ''}> ${e(other.assignment.title)} <span class="task-id">${e(other.id)}</span></label>`,
          )
          .join('')}</fieldset>`
      : ''
  }`;
}

/** The latest version of a task in review: file list, one diff, and the decision. */
function renderReview(
  task: TaskRecord,
  version: TaskVersion,
  canChange: boolean,
  stale: string | undefined,
): string {
  const selectable = stale
    ? []
    : version.files.filter((file) => file.inScope && file.regular);
  const marks = { added: '+', modified: 'M', deleted: '−' } as const;
  return `<div class="review" aria-labelledby="review-title"><h3 id="review-title">Version ${version.number}: ${e(turnLabels[version.turn])}</h3>
  ${version.note ? `<p class="notice">${e(version.note)}</p>` : ''}
  ${stale ? `<p class="notice">${e(stale)}</p>` : ''}
  ${version.reply ? `<div class="worker-reply"><p class="fine">The worker said (a model claim):</p>${more(`reply-${task.id}-${version.number}`, version.reply, 200)}</div>` : ''}
  ${version.conflicts?.length ? `<p class="notice">These files changed in your project after the task started, so Verifold copied nothing: ${e(version.conflicts.join(', '))}. Ask for changes, or reject the version.</p>` : ''}
  ${version.skipped.length ? `<p class="notice">These files are larger than 50 MB and are not in the version: ${e(version.skipped.join(', '))}.</p>` : ''}
  ${
    version.files.length
      ? `<div class="review-grid"><ul class="review-files">${version.files
          .map((file, index) => {
            const allowed = file.inScope && file.regular && !stale;
            return `<li><input type="checkbox" id="task-file-${version.number}-${index}" data-file="${e(file.path)}"${allowed ? ' checked' : ' disabled'} aria-label="Accept ${e(file.path)}"><button type="button" class="file-name" data-diff="${e(file.path)}" data-task="${e(task.id)}" data-version="${version.number}"><span class="change change-${file.change}" aria-label="${e(file.change)}">${marks[file.change]}</span>${e(file.path)}</button>${allowed || stale ? '' : `<span class="scope">${file.inScope ? 'Not a regular file' : 'Outside the writable paths'}</span>`}</li>`;
          })
          .join(
            '',
          )}</ul><div class="diff-pane" data-task="${e(task.id)}" data-version="${version.number}" aria-live="polite"><p class="fine">Choose a file to see its changes.</p></div></div>`
      : '<p class="empty-note">This version changed no files.</p>'
  }
  <div class="actions"><button type="button" class="primary" data-action="task-accept" data-task="${e(task.id)}" data-version="${version.number}"${selectable.length ? '' : ' disabled'}>Accept ${selectable.length} ${selectable.length === 1 ? 'file' : 'files'}</button></div>
  <label class="field" for="task-note">Changes</label><textarea id="task-note" rows="3" maxlength="4000" placeholder="What should change in the next version?"${canChange ? '' : ' disabled aria-describedby="task-note-off"'}></textarea>
  ${canChange ? '' : '<p class="fine" id="task-note-off">The harness session of this task ended. Reject this version, then start the task again.</p>'}
  <div class="actions"><button type="button" data-action="task-changes" data-task="${e(task.id)}"${canChange ? '' : ' disabled'}>Ask for changes</button><button type="button" data-action="task-reject" data-task="${e(task.id)}" data-version="${version.number}" data-confirm="Click again to reject version ${version.number}">Reject version</button></div></div>`;
}

const deliveryLabels: Record<Message['delivery'], string> = {
  queued: 'Waits for the next turn',
  sent: 'Sent with the current turn',
  delivered: 'Delivered',
  uncertain: 'Delivery uncertain',
  board: 'On the desk',
};

const kindLabels: Record<Message['kind'], string> = {
  note: 'Note',
  blocker: 'Blocker',
  objection: 'Objection',
  withdrawal: 'Withdrawal',
  decision: 'Decision',
};

/** One message: who sent it to whom, what it is, and how far it got. */
function messageItem(message: Message): string {
  const delivery =
    message.to === 'coordinator' && message.delivery === 'queued'
      ? 'Waits for the coordinator'
      : deliveryLabels[message.delivery];
  return `<li class="message"><p class="message-meta"><span>${e(message.id)}</span><span>${e(message.from)} to ${e(message.to)}</span><span>${e(kindLabels[message.kind])}${message.status ? `, ${e(message.status)}` : ''}</span><span>${e(delivery)}</span><time datetime="${e(message.at)}">${e(clock(message.at))}</time></p>${message.about ? `<p class="fine">About ${e(message.about.task)} version ${message.about.version}</p>` : ''}${more(`msg-${message.id}`, message.text, 200)}${message.evidence?.length ? `<ul class="evidence">${message.evidence.map((item) => `<li>${e(item)}</li>`).join('')}</ul>` : ''}</li>`;
}

/** The answer to an open blocker or objection. A decision changes no file. Its reason goes to the task that raised it. */
function decideForm(message: Message): string {
  return `<label class="field" for="decide-${e(message.id)}">Reason for your decision on ${e(message.id)}</label><input id="decide-${e(message.id)}" type="text" maxlength="2000"><div class="actions">${
    message.kind === 'objection'
      ? `<button type="button" data-action="task-decide" data-message="${e(message.id)}" data-decision="upheld">Uphold</button><button type="button" data-action="task-decide" data-message="${e(message.id)}" data-decision="overruled">Overrule</button>`
      : `<button type="button" data-action="task-decide" data-message="${e(message.id)}" data-decision="resolved">Resolve</button>`
  }</div><p class="fine">${message.kind === 'objection' ? 'Uphold when the objection is right. Overrule when it is wrong. ' : ''}Your decision and its reason go to the task that raised it, with its next turn. To change the work, revise the task.</p>`;
}

/** Notes that the coordinator wrote to the person, newest first. */
function notesToPerson(messages: readonly Message[]): string {
  const notes = messages
    .filter(
      (message) =>
        message.from === 'coordinator' &&
        message.to === 'person' &&
        message.kind === 'note',
    )
    .slice(-10)
    .reverse();
  return notes.length
    ? `<details id="coordinator-notes" open><summary>Notes to you (${notes.length})</summary><ul class="messages">${notes.map(messageItem).join('')}</ul></details>`
    : '';
}

/** The coordinator's task plan waits for the person: it has tasks, and the coordinator ended its turn. */
function planWaits(
  view: CoordinatorView | null | undefined,
  tasks: readonly TaskRecord[],
): boolean {
  const state = view?.state;
  const status = view?.session?.record.status;
  return (
    !!state &&
    !state.stoppedAt &&
    !state.planApproved &&
    status !== 'running' &&
    status !== 'starting' &&
    tasks.some((task) => task.assignment.by === 'coordinator')
  );
}

/** The results of the chosen direction, if the coordinator reported any. */
function resultsOf(workspace: Workspace, live: DeskSession): Results | null {
  const results = live.coordinator?.results;
  return results && results.direction === workspace.selectedId ? results : null;
}

const outcomeLabels = {
  passed: 'Passed',
  failed: 'Failed',
  partial: 'Partly passed',
  judgement: 'Needs your judgement',
} as const;

/** The person's ruling on a check that waits for their judgement. The options name outcomes, and none is the default. */
function judgementForm(entry: CheckResult): string {
  const button = (result: string, label: string): string =>
    `<button type="button" data-action="coordinator-rule" data-check="${entry.check}" data-result="${result}">${label}</button>`;
  return `<label class="field" for="rule-${entry.check}">Your ruling and its reason</label><input id="rule-${entry.check}" type="text" maxlength="2000"><div class="actions">${button('passed', 'It passed')}${button('partial', 'It partly passed')}${button('failed', 'It failed')}</div><p class="fine">Your ruling is final. The coordinator gets it with its next wakeup.</p>`;
}

/** A decision that only the person can make. Its key stays the same while it waits, so the page notifies once. */
interface Need {
  readonly key: string;
  /** The view that holds the item, for the count in the rail. */
  readonly view: DeskView;
  /** The task that the item is about. */
  readonly task?: string;
  readonly kind: string;
  readonly title: string;
  /** Why only the person can settle it. */
  readonly why: string;
  readonly since: string | null;
  /** HTML: the answer itself, or a button that opens the place of the decision. */
  readonly body: string;
}

/**
 * Every decision that waits for the person, from the records that the desk
 * reads. An item leaves when it is settled, never because the person saw it.
 */
function needsOf(snapshot: DeskSnapshot, live: DeskSession): Need[] {
  const { workspace } = snapshot;
  const items: Need[] = [];
  const tasks = live.tasks?.list ?? [];
  const messages = live.tasks?.messages ?? [];
  const latest = workspace.research?.latestAttempt;
  const record = snapshot.attempts.find((entry) => entry.id === latest)?.record;
  const since = record?.finishedAt ?? record?.startedAt ?? null;
  const phase = workspace.research?.phase;
  if (live.research && !live.research.running && !workspace.selectedId) {
    if (phase === 'awaiting-plan-review')
      items.push({
        key: `research-plan:${latest ?? ''}`,
        view: 'research',
        kind: 'Research plan',
        title: 'Review the plan',
        why: 'Guided research stops at its plan for your approval.',
        since,
        body: '<div class="actions"><button type="button" class="primary" data-action="research" data-research="approve">Approve the plan</button><button type="button" data-view="research">Read the scope</button></div>',
      });
    else if (phase === 'directions')
      items.push({
        key: `direction:${latest ?? ''}`,
        view: 'research',
        kind: 'Direction',
        title: 'Choose a direction',
        why: 'Only you choose the direction. The choice locks it for this project.',
        since,
        body: '<div class="actions"><button type="button" class="primary" data-view="research">Compare the directions</button></div>',
      });
    else if (phase)
      items.push({
        key: `research-stopped:${latest ?? ''}`,
        view: 'research',
        kind: 'Stopped work',
        title: 'Research stopped before its step ended',
        why: 'Only you can continue it. It continues from the saved checkpoint.',
        since,
        body: '<div class="actions"><button type="button" class="primary" data-action="research" data-research="continue">Continue research</button></div>',
      });
  }
  const coordinator = live.coordinator;
  const state = coordinator?.state;
  // A coordinator that has not stopped settles versions, blockers, and objections itself.
  const coordinated = !!state && !state.stoppedAt;
  const status = coordinator?.session?.record.status;
  if (coordinated && (status === 'paused' || status === 'interrupted'))
    items.push({
      key: `coordinator-paused:${state.session ?? ''}`,
      view: 'home',
      kind: 'Stopped work',
      title: 'The coordinator is paused',
      why: 'It paused when Verifold stopped. Only you can resume it.',
      since: null,
      body: '<div class="actions"><button type="button" class="primary" data-action="coordinator-resume">Resume the coordinator</button></div>',
    });
  if (planWaits(coordinator, tasks))
    items.push({
      key: `task-plan:${state?.created ?? 0}`,
      view: 'home',
      kind: 'Task plan',
      title: 'The task plan waits for you',
      why: "Guided research stops at the coordinator's task plan. No task starts before your approval.",
      since:
        tasks
          .filter((task) => task.assignment.by === 'coordinator')
          .map((task) => task.createdAt)
          .sort()
          .at(-1) ?? null,
      body: '<div class="actions"><button type="button" class="primary" data-panel="coordinator" data-focus="plan-title">Open the plan</button></div>',
    });
  const workers = live.workers ?? (live.session ? [live.session] : []);
  for (const worker of workers)
    for (const request of worker.record.requests.slice(0, 10))
      items.push({
        key: `request:${worker.record.id}:${request.id}`,
        view: 'home',
        ...(worker.record.task ? { task: worker.record.task.id } : {}),
        kind: 'Permission',
        title: `${workerName(worker.record, tasks)} asks to use ${request.tool}`,
        why: `It waits for your answer before it continues. Request ${request.id}.`,
        since: request.at,
        body: requestBody(request),
      });
  for (const message of messages) {
    if (
      message.status !== 'open' ||
      (coordinated && !forPerson(message, messages))
    )
      continue;
    const from =
      tasks.find((task) => task.id === message.from)?.assignment.title ??
      message.from;
    items.push({
      key: `message:${message.id}`,
      view: 'home',
      task: message.from,
      kind: kindLabels[message.kind],
      title: lead(message.text, 160),
      why: `From ${from}. ${coordinated ? 'The coordinator overruled two objections from this task, so this one goes to you.' : 'No coordinator runs, so only you can settle it.'}`,
      since: message.at,
      body: `${lead(message.text, 160) === message.text.replace(/\s+/g, ' ').trim() ? '' : `<details class="more" id="need-${e(message.id)}"><summary>Read the whole message</summary><p class="pre">${e(message.text)}</p></details>`}${message.evidence?.length ? `<ul class="evidence">${message.evidence.map((item) => `<li>${e(item)}</li>`).join('')}</ul>` : ''}${decideForm(message)}`,
    });
  }
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  const results = resultsOf(workspace, live);
  for (const entry of results?.checks ?? [])
    if (entry.result === 'judgement' && !entry.ruling)
      items.push({
        key: `judgement:${results?.direction ?? ''}:${entry.check}:${entry.at}`,
        view: 'results',
        kind: 'Judgement',
        title: `Check ${entry.check}: ${entry.question ?? 'needs your judgement'}`,
        why: 'The evidence does not settle it, so only you can decide it.',
        since: entry.at,
        body: `<p class="fine">${e(idea?.gates[entry.check - 1] ?? '')}</p><p><span class="tag reading">Its reading</span> ${e(entry.value)}</p>${judgementForm(entry)}`,
      });
  if (results?.answer && !results.answer.decision)
    items.push({
      key: `answer:${results.answer.at}`,
      view: 'results',
      kind: 'Sign-off',
      title: 'The answer waits for your sign-off',
      why: 'Only you accept the answer or ask for more work.',
      since: results.answer.at,
      body: '<div class="actions"><button type="button" class="primary" data-view="results">Read the answer</button></div>',
    });
  if (!coordinated)
    for (const task of tasks) {
      const attempt = task.attempts.at(-1);
      const version = attempt?.versions.at(-1);
      const open = `<div class="actions"><button type="button" class="primary" data-task-select="${e(task.id)}">Open the task</button></div>`;
      if (task.state === 'review' && version && !version.decision)
        items.push({
          key: `review:${task.id}:${attempt?.number ?? 0}:${version.number}`,
          view: 'tasks',
          task: task.id,
          kind: 'Review',
          title: `Version ${version.number} of ${task.assignment.title} waits for your review`,
          why: 'No coordinator runs, so only you can accept or reject it.',
          since: version.at,
          body: open,
        });
      else if (
        task.state === 'open' &&
        (attempt?.outcome === 'start-failed' ||
          attempt?.outcome === 'allocation-failed')
      )
        items.push({
          key: `task-failed:${task.id}:${attempt.number}`,
          view: 'tasks',
          task: task.id,
          kind: 'Stopped work',
          title: `${task.assignment.title} could not start`,
          why: `${attempt.note ?? 'Its harness did not start.'} No coordinator runs, so only you can start it again.`,
          since: attempt.endedAt,
          body: open,
        });
    }
  const compute = live.compute;
  if (compute)
    for (const lease of compute.leases) {
      if (lease.state === 'requested')
        items.push({
          key: `lease:${lease.id}`,
          view: 'compute',
          kind: 'GPU pod',
          title: `${lease.requestedBy === 'coordinator' ? 'The coordinator asks' : 'You asked'} for a ${lease.gpu} pod`,
          why: 'A pod costs money from the moment that RunPod creates it, so only you approve it. Nothing is billed before you do.',
          since: lease.requestedAt,
          body: leaseRequest(lease, compute),
        });
      if (lease.notice)
        items.push({
          key: `lease-notice:${lease.id}:${lease.history.at(-1)?.at ?? ''}`,
          view: 'compute',
          kind: 'GPU pod',
          title: lease.notice,
          why: 'Verifold acted on a pod. Dismiss this when you have read it.',
          since: lease.history.at(-1)?.at ?? null,
          body: `<div class="actions"><button type="button" data-action="compute-lease-dismiss" data-lease="${e(lease.id)}">Dismiss</button><button type="button" data-view="compute">Open Compute</button></div>`,
        });
    }
  return items;
}

/** What the person approves for a lease: its cost, what is left after it, what the pod allows, and the coordinator's reason. */
function leaseRequest(lease: Lease, compute: ComputeView): string {
  const cost = maxCost(lease.rate, lease.diskGb, lease.hours);
  const left = compute.budget.left;
  return `<dl class="facts"><div><dt>For</dt><dd>${lease.tasks.map((task) => e(task)).join(', ')}</dd></div><div><dt>GPU</dt><dd>${e(lease.gpu)}, one GPU, Secure Cloud</dd></div><div><dt>Image</dt><dd><code>${e(lease.image)}</code></dd></div><div><dt>Rate</dt><dd>${usd(lease.rate)} per hour, the list price when the request came</dd></div><div><dt>At most</dt><dd>${lease.hours} ${lease.hours === 1 ? 'hour' : 'hours'}, ${usd(cost)} with the disk</dd></div>${left === null ? '' : `<div><dt>Left after it</dt><dd>${usd(Math.max(0, left - cost))} of ${usd(compute.settings.limitUsd ?? 0)}</dd></div>`}</dl>
  <div class="why"><span class="tag reading">${lease.requestedBy === 'coordinator' ? 'Its reason' : 'Your reason'}</span> ${e(lease.reason)}</div>
  <p class="fine">The pod runs any command as root, with internet access. Files that a task copies to it leave this computer. RunPod erases the disk of the pod when the pod stops. Verifold stops the pod after ${compute.settings.idleMinutes} idle minutes and when Verifold stops, and deletes it at the end of the lease or at your spend limit.</p>
  <div class="actions"><button type="button" class="primary" data-action="compute-lease-approve" data-lease="${e(lease.id)}">Approve, up to ${usd(cost)}</button><button type="button" data-action="compute-lease-deny" data-lease="${e(lease.id)}">Deny</button></div>`;
}

/** The items that wait for the person, each with why it is theirs and its answer. */
function renderNeedList(items: readonly Need[]): string {
  return `<ul class="needs-list">${items
    .map(
      (item) =>
        `<li class="need"><div class="need-head"><span class="mark you" aria-hidden="true"></span><div><p class="need-kind">${e(item.kind)}</p><h3>${e(item.title)}</h3><p class="fine">${item.since ? `Since ${e(since(item.since))}. ` : ''}${e(item.why)}</p></div></div><div class="need-body">${item.body}</div></li>`,
    )
    .join('')}</ul>`;
}

/** Needs you: one list of every decision that only the person can make. */
function renderNeedsView(items: readonly Need[]): string {
  return `<div class="view"><div class="view-head"><h1 id="view-title" tabindex="-1">Needs you</h1><p>${items.length ? `${items.length} ${items.length === 1 ? 'item waits' : 'items wait'} for you` : 'Nothing waits for you'}</p></div>
  <p class="notify"><span id="notify-state"></span><button type="button" id="notify" hidden>Turn on desktop notifications</button></p>
  ${items.length ? `<section class="card needs" aria-labelledby="view-title">${renderNeedList(items)}</section>` : '<section class="card"><p><strong>Nothing needs you.</strong></p><p class="fine">An item shows here when only you can settle it: a plan to approve, a direction to choose, a permission request, an objection that comes to you, or work that stopped. It leaves when you settle it.</p></section>'}</div>`;
}

/** One line on Home while pods run, with the cost against the limit. */
function renderPodsLine(compute: ComputeView | undefined): string {
  const running = compute?.leases.filter(isRunning).length ?? 0;
  if (!compute || !running) return '';
  const { budget, settings } = compute;
  return `<section class="card pods-line"><p>${running === 1 ? '1 pod runs' : `${running} pods run`} at ${usd(budget.rate)} per hour. Spent ${usd(budget.spent)} of ${usd(settings.limitUsd ?? 0)}.</p><button type="button" data-view="compute">Open Compute</button></section>`;
}

/** What the coordinator does after a direction. Needs you lists what waits for the person. */
function renderTeamNext(
  view: CoordinatorView | null,
  needs: number,
  tasks: readonly TaskRecord[],
): string {
  const state = view?.state;
  const session = view?.session?.record;
  if (!state || state.stoppedAt)
    return '<section class="card lead"><h2>The coordinator is not running</h2><p>It plans and runs the tasks for the chosen direction.</p><div class="actions"><button type="button" class="primary" data-panel="coordinator">Start the coordinator</button></div></section>';
  if (
    planWaits(view, tasks) ||
    session?.status === 'paused' ||
    session?.status === 'interrupted'
  )
    return '';
  if (!state.planApproved)
    return '<section class="card"><h2>No task plan yet</h2><p>The coordinator writes the task plan. No task starts before you approve it.</p></section>';
  return `<section class="card"><h2>The coordinator runs the team</h2><p>${needs ? `${needs} ${needs === 1 ? 'item needs' : 'items need'} you above.` : 'Nothing needs you. Follow the work in the team feed and under Tasks.'}</p></section>`;
}

const coordinatorStates: Record<string, string> = {
  starting: 'Starting',
  running: 'Working',
  idle: 'Waiting for events',
  paused: 'Paused',
  interrupted: 'Interrupted',
  ended: 'Ended',
  failed: 'Failed',
};

/** The coordinator in full: its state, plan, actions, transcript, and controls, or the form that starts it. */
function coordinatorPanel(
  view: CoordinatorView | null,
  workspace: Workspace,
  host: string,
  tasks: readonly TaskRecord[],
  messages: readonly Message[],
): Panel {
  const state = view?.state;
  if (!state || state.stoppedAt) {
    const objective = directionObjective(workspace) ?? '';
    return {
      kind: 'Agent',
      title: 'Coordinator',
      sub: `<span class="status muted">${state ? 'Stopped' : 'Not started'}</span>`,
      body: `<p class="fine">The coordinator turns an objective into tasks for the workers. It starts them, reviews each version, and settles objections. It acts only through Verifold's task tools, so every action has the same checks as yours, and it gives a reason for each one. It cannot run commands or edit files.</p>
    <label class="field" for="coordinator-objective">Objective</label><textarea id="coordinator-objective" rows="5" maxlength="8000">${e(objective)}</textarea>
    ${objective ? '' : '<p class="fine">Choose a research direction first, or write the objective yourself.</p>'}
    <div class="fields"><label class="field" for="coordinator-host">Harness<select id="coordinator-host"><option value="claude"${host === 'codex' ? '' : ' selected'}>Claude Code</option><option value="codex"${host === 'codex' ? ' selected' : ''}>Codex</option></select></label><label class="field" for="coordinator-model">Model<input id="coordinator-model" type="text" maxlength="200" placeholder="Harness default"></label></div>
    <div class="actions"><button type="button" class="primary" data-action="coordinator-start">Start the coordinator</button></div>`,
    };
  }
  const session = view.session?.record;
  const status = session
    ? (coordinatorStates[session.status] ?? session.status)
    : 'Starting';
  const paused =
    session?.status === 'paused' || session?.status === 'interrupted';
  const hourAgo = Date.now() - 3_600_000;
  const wakeups = state.wakeups.filter((at) => Date.parse(at) > hourAgo).length;
  const actions = state.actions.slice(-20).reverse();
  const planned = tasks.filter((task) => task.assignment.by === 'coordinator');
  const planning =
    session?.status === 'running' || session?.status === 'starting';
  const waits = planWaits(view, tasks);
  const plan = state.planApproved
    ? ''
    : `<div class="subcard${waits ? ' needs' : ''}" role="region" aria-labelledby="plan-title"><h3 id="plan-title" tabindex="-1">${waits ? 'The task plan waits for you' : planned.length ? 'The coordinator makes its task plan' : 'No task plan yet'}</h3><p>No task starts until you approve the plan. To change it, write to the coordinator on Home, or edit a task under Tasks.</p>${planned.length ? `<ul>${planned.map((task) => `<li><strong>${e(task.id)}</strong> ${e(task.assignment.title)}: ${e(lead(task.assignment.objective, 200))}${task.assignment.dependencies.length ? ` (waits for ${e(task.assignment.dependencies.join(', '))})` : ''}</li>`).join('')}</ul>` : '<p class="empty-note">The coordinator has not created tasks yet.</p>'}<div class="actions"><button type="button" class="primary" data-action="coordinator-approve"${waits ? '' : ' disabled'}>Approve the plan</button>${planning ? '<p class="fine">The coordinator is still making its plan.</p>' : ''}</div></div>`;
  return {
    kind: 'Agent',
    title: 'Coordinator',
    sub: `<span class="status ${paused || session?.status === 'failed' ? 'muted' : 'active'}">${e(status)}</span>`,
    body: `<p class="session-meta"><span>${e(hostName(state.host))}</span><span>Model: ${e(state.model ?? 'harness default')}</span><span>${state.created} of ${coordinatorLimits.tasks} tasks created</span><span>${wakeups} of ${coordinatorLimits.wakeupsPerHour} wakeups this hour</span><span>${view.waiting} ${view.waiting === 1 ? 'event waits' : 'events wait'}</span></p>
  ${view.limitedUntil ? `<p class="notice">The coordinator used its wakeups for this hour. It continues at ${e(clock(view.limitedUntil))}.</p>` : ''}
  ${paused ? '<p class="notice">The coordinator paused when Verifold stopped. Resume it to continue with the same conversation.</p>' : ''}
  ${plan}
  ${notesToPerson(messages)}
  <details id="coordinator-objective-view"><summary>Objective</summary><p class="pre">${e(state.objective)}</p></details>
  <details id="coordinator-actions"${actions.length ? ' open' : ''}><summary>What it did (${state.actions.length})</summary>${actions.length ? `<ul class="actions-log">${actions.map((action, index) => `<li><span class="mark ${action.ok ? 'done' : 'failed'}" aria-hidden="true"></span><div><p><span class="tool">${e(action.tool.replace(/^verifold_/, ''))}</span> ${action.ok ? '' : '<strong>Verifold refused this.</strong> '}${e(action.result)}</p>${action.reason ? `<div class="why"><span class="tag reading">Its reason</span>${more(`action-${state.actions.length - 1 - index}`, action.reason, 120)}</div>` : ''}</div><time datetime="${e(action.at)}">${e(clock(action.at))}</time></li>`).join('')}</ul>` : '<p class="empty-note">No actions yet.</p>'}<p class="fine">Results come from Verifold. Reasons are the coordinator's reading, a model claim.</p></details>
  ${session ? `<details id="coordinator-transcript"><summary>Transcript</summary>${transcriptSlot(`session:${session.id}`, 'Coordinator transcript', '')}</details>` : ''}
  <div class="actions">${paused ? '<button type="button" class="primary" data-action="coordinator-resume">Resume the coordinator</button>' : ''}<button type="button" data-action="coordinator-stop" data-confirm="Click again to stop the coordinator">Stop the coordinator</button></div>
  <p class="fine">If you stop it, running workers finish their turns, and their versions wait for your review.</p>`,
  };
}

/** A name for a sender or a receiver of a message. */
function sender(id: string, tasks: readonly TaskRecord[]): string {
  if (id === 'coordinator') return 'Coordinator';
  if (id === 'person') return 'You';
  return tasks.find((task) => task.id === id)?.assignment.title ?? id;
}

/** One message between the person and the coordinator. */
function bubble(message: Message): string {
  const mine = message.from === 'person';
  const state = !mine
    ? '<span class="tag reading">Its reading</span>'
    : message.delivery === 'delivered'
      ? `<span>Read by the coordinator${message.deliveredAt ? ` at ${e(clock(message.deliveredAt))}` : ''}</span>`
      : '<span>Waits for the coordinator</span>';
  return `<li class="msg${mine ? ' mine' : ''}"><p class="msg-meta"><strong>${mine ? 'You' : 'Coordinator'}</strong><time datetime="${e(message.at)}">${e(since(message.at))}</time>${state}</p>${more(`talk-${message.id}`, message.text, 200)}</li>`;
}

/** The coordinator on Home: its latest note, the person's messages, and the one box to write to it. */
function renderCoordinatorHome(
  view: CoordinatorView,
  messages: readonly Message[],
): string {
  const status = view.session?.record.status;
  const talk = messages.filter(
    (message) =>
      (message.from === 'person' && message.to === 'coordinator') ||
      (message.from === 'coordinator' &&
        message.to === 'person' &&
        message.kind === 'note'),
  );
  const note = talk.findLast((message) => message.from === 'coordinator');
  // Messages after the latest note wait for their answer, so they show next to it.
  const waiting = talk.filter(
    (message) => message.from === 'person' && (!note || message.at > note.at),
  );
  const earlier = talk
    .filter((message) => message !== note && !waiting.includes(message))
    .slice(-20);
  return `<section class="card coordinator-home" aria-labelledby="coordinator-title"><div class="section-title"><h2 id="coordinator-title" tabindex="-1">The coordinator</h2><span class="status ${status === 'running' || status === 'starting' ? 'active' : 'muted'}">${e(coordinatorStates[status ?? 'starting'] ?? 'Starting')}</span></div>
  ${note ? `<div class="note"><p class="msg-meta"><strong>Its latest note</strong><time datetime="${e(note.at)}">${e(since(note.at))}</time><span class="tag reading">Its reading</span></p>${more(`note-${note.id}`, note.text, 280)}</div>` : '<p class="empty-note">No note yet. The coordinator writes a note at milestones and when you ask.</p>'}
  ${waiting.length ? `<ol class="convo">${waiting.map(bubble).join('')}</ol>` : ''}
  ${earlier.length ? `<details id="conversation"><summary>Earlier messages (${earlier.length})</summary><ol class="convo">${earlier.map(bubble).join('')}</ol></details>` : ''}
  <label class="field" for="coordinator-message">Message the coordinator</label><textarea id="coordinator-message" rows="2" maxlength="4000" placeholder="For example: why is the data synthetic?"></textarea>
  <div class="actions"><button type="button" data-action="coordinator-message">Send</button><button type="button" class="quiet" data-panel="coordinator">Its actions and controls</button></div>
  <p class="fine">It reads your message at its next wakeup and answers in a note here.</p></section>`;
}

/** The team feed: what the agents and the coordinator write to each other, newest first. Nobody posts in it. */
function renderFeed(
  messages: readonly Message[],
  tasks: readonly TaskRecord[],
): string {
  const feed = messages
    .filter((message) => message.from !== 'person' && message.to !== 'person')
    .slice(-12)
    .reverse();
  if (!feed.length) return '';
  return `<section class="card" aria-labelledby="feed-title"><div class="section-title"><h2 id="feed-title">Team feed</h2><span class="count">Newest first</span></div><ul class="feed">${feed
    .map(
      (message) =>
        `<li class="feed-row">${avatar(message.from === 'coordinator' ? 'coordinator' : 'task', '')}<div class="feed-body"><p class="feed-head"><strong>${e(sender(message.from, tasks))}</strong><span class="feed-to">to ${e(sender(message.to, tasks))}</span><span class="chip ${message.kind}">${e(kindLabels[message.kind])}${message.status ? `, ${e(message.status)}` : ''}</span><time datetime="${e(message.at)}">${e(since(message.at))}</time></p>${more(`feed-${message.id}`, message.text, 140)}</div></li>`,
    )
    .join(
      '',
    )}</ul><p class="fine">The agents and the coordinator write here. The panel of each task has its full messages.</p></section>`;
}

/** What changed after the person left, from Verifold's records. A list of facts, not a model summary. */
function renderSince(
  left: string,
  snapshot: DeskSnapshot,
  live: DeskSession,
  needs: number,
): string {
  const after = (at: string | null | undefined): at is string =>
    !!at && at > left;
  const events: { at: string; text: string; mark: string }[] = [];
  for (const attempt of snapshot.attempts) {
    const record = attempt.record;
    if (record && after(record.finishedAt))
      events.push({
        at: record.finishedAt,
        text: `${phaseLabel(record.phase)} ended: ${outcome(attempt).toLowerCase()}`,
        mark: record.status === 'succeeded' ? 'done' : 'failed',
      });
  }
  for (const task of live.tasks?.list ?? []) {
    const name = task.assignment.title;
    for (const attempt of task.attempts) {
      if (after(attempt.startedAt))
        events.push({
          at: attempt.startedAt,
          text: `${name} started`,
          mark: 'working',
        });
      for (const version of attempt.versions) {
        if (after(version.at))
          events.push({
            at: version.at,
            text: `${name} made version ${version.number}`,
            mark: 'settled',
          });
        const decision = version.decision;
        if (decision && after(decision.at))
          events.push({
            at: decision.at,
            text: `${decision.by === 'coordinator' ? 'The coordinator' : 'You'} ${decision.kind === 'accepted' ? 'accepted' : decision.kind === 'changes' ? 'asked for changes to' : 'rejected'} version ${version.number} of ${name}`,
            mark: decision.kind === 'accepted' ? 'done' : 'settled',
          });
      }
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const shown = events.slice(0, 12);
  const acted = (live.coordinator?.state?.actions ?? []).filter((action) =>
    after(action.at),
  ).length;
  const posted = (live.tasks?.messages ?? []).filter(
    (message) =>
      after(message.at) && message.from !== 'person' && message.to !== 'person',
  ).length;
  const totals = [
    needs
      ? `${needs} ${needs === 1 ? 'item needs' : 'items need'} you above.`
      : '',
    acted
      ? `The coordinator acted ${acted} ${acted === 1 ? 'time' : 'times'}. Its reasons are in its panel.`
      : '',
    posted
      ? `${posted} ${posted === 1 ? 'message' : 'messages'} in the team feed.`
      : '',
  ].filter(Boolean);
  return `<section class="card" aria-labelledby="since-title"><div class="section-title"><h2 id="since-title">Since you left at ${e(since(left))}</h2><span class="count">From Verifold's records</span></div>
  ${shown.length ? `<ul class="since">${shown.map((event) => `<li><span class="mark ${event.mark}" aria-hidden="true"></span><span>${e(event.text)}</span><time datetime="${e(event.at)}">${e(clock(event.at))}</time></li>`).join('')}</ul>${events.length > shown.length ? `<p class="fine">The latest ${shown.length} of ${events.length} changes.</p>` : ''}` : '<p class="empty-note">Nothing changed while you were away.</p>'}
  ${totals.length ? `<p class="fine">${totals.map(e).join(' ')}</p>` : ''}</section>`;
}

/** One task in full: its assignment, its next step, the review of its latest version, and its messages. */
/** The pod of a task: its lease, GPU, state, and end, and what the pod allows. */
function taskPod(task: string, compute: ComputeView | undefined): string {
  const lease = compute?.leases.findLast(
    (entry) =>
      entry.tasks.includes(task) &&
      (isOpen(entry) || entry.state === 'requested'),
  );
  if (!lease) return '';
  return `<p class="pod-line"><strong>Pod:</strong> ${e(lease.id)}, ${e(lease.gpu)}, ${e(leaseStates[lease.state].toLowerCase())}${lease.deadline ? `, ends ${e(since(lease.deadline))}` : ''}. <button type="button" class="row-button" data-view="compute">Open Compute</button></p><p class="fine">The pod runs any command of this task as root, on a machine with internet access. Files that the task copies to it leave this computer. Verifold runs SSH; the worker uses Verifold's pod tools.</p>`;
}

function taskPanel(
  task: TaskRecord,
  view: TaskView,
  live: DeskSession,
  host: string,
  needKeys: ReadonlySet<string>,
): Panel {
  const [label, tone] = taskStates[task.state];
  const others = view.list.filter((entry) => entry.id !== task.id);
  const attempt = task.attempts.at(-1);
  const version = attempt?.versions.at(-1);
  const waiting = task.assignment.dependencies.filter(
    (id) => view.list.find((entry) => entry.id === id)?.state !== 'done',
  );
  const [stale] = replaced(attempt, view.list);
  const used = stale
    ? `This version used ${stale.task} version ${stale.used}, but ${stale.task} now has version ${stale.current}.`
    : undefined;
  const editForm = `<details id="task-edit"><summary>${task.state === 'done' ? 'Revise the task' : 'Edit the task'}</summary><p class="fine">${task.state === 'done' ? 'A revision opens the task again. Its accepted files stay in the record, and tasks that used them show when a newer version replaces them.' : 'An edit makes a new revision. Earlier attempts keep the revision that they ran.'}</p>${taskForm('task-edit', task.assignment, others, host)}<label class="field" for="task-edit-reason">Why it changes</label><input id="task-edit-reason" type="text" maxlength="500"><div class="actions"><button type="button" data-action="task-edit" data-task="${e(task.id)}">Save revision ${task.revision + 1}</button></div></details>`;
  const artifact = task.artifacts?.at(-1);
  const blocked = waiting.length
    ? `This task waits for ${waiting.join(', ')}.`
    : live.full
      ? `${workerLimit} workers run. End a session, or accept, reject, or cancel a task version first.`
      : undefined;
  const agent =
    attempt?.session &&
    (live.workers ?? []).some((worker) => worker.record.id === attempt.session)
      ? `<button type="button" data-worker="${e(attempt.session)}">Follow its agent</button>`
      : '';
  let next = '';
  switch (task.state) {
    case 'open':
      next = `${blocked ? `<p class="notice" id="task-blocked">${e(blocked)}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="task-start" data-task="${e(task.id)}"${blocked ? ' disabled aria-describedby="task-blocked"' : ''}>Start task</button><button type="button" data-action="task-cancel" data-task="${e(task.id)}" data-confirm="Click again to cancel ${e(task.id)}">Cancel task</button></div>
        ${editForm}`;
      break;
    case 'claimed':
      next = '<p>Verifold prepares the task folder.</p>';
      break;
    case 'running':
      next = `<p>The harness works in the task folder. Follow its agent to see each step. Details there shows the transcript.</p><div class="actions">${agent}<button type="button" data-action="task-stop" data-task="${e(task.id)}">Stop the turn</button></div><p class="fine">If you stop the turn, its work becomes a version for review.</p>`;
      break;
    case 'review':
      next =
        version && !version.decision
          ? renderReview(
              task,
              version,
              !!attempt?.session && view.idle.includes(attempt.session),
              used &&
                `${used} It cannot be accepted. Reject it and start the task again, so it uses the new files.`,
            )
          : `<p class="notice">${e(attempt?.note ?? 'No version is ready.')}</p><div class="actions"><button type="button" data-action="task-cancel" data-task="${e(task.id)}" data-confirm="Click again to cancel ${e(task.id)}">Cancel task</button></div>`;
      break;
    case 'done':
      next = `<p>Done. ${artifact ? `Version ${artifact.version} was accepted: ${e(artifact.files.map((file) => file.path).join(', ') || 'no files')}.` : 'A version was accepted.'} Tasks that wait for this one receive these files.</p>${used ? `<p class="notice">${e(used)} Revise this task, so it runs again with the new files.</p>` : ''}${editForm}`;
      break;
    case 'cancelled':
      next = '<p>Cancelled. Its records stay in the project.</p>';
      break;
  }
  const history = task.attempts.flatMap((entry) =>
    entry.versions
      .filter((saved) => saved.decision)
      .map((saved) => {
        const decision = saved.decision;
        const who = decision?.by === 'coordinator' ? 'the coordinator' : 'you';
        const what =
          decision?.kind === 'accepted'
            ? `${who} accepted ${e(decision.files?.join(', ') ?? '')}`
            : decision?.kind === 'changes'
              ? `${who} asked for changes`
              : `${who} rejected it`;
        return `<li>Version ${saved.number}: ${what}${decision?.note ? `: ${e(decision.note)}` : ''}</li>`;
      }),
  );
  const notes = task.attempts
    .filter((entry) => entry.note && entry !== attempt)
    .map((entry) => `<li>Attempt ${entry.number}: ${e(entry.note ?? '')}</li>`);
  const thread = (view.messages ?? [])
    .filter((message) => message.to === task.id || message.from === task.id)
    .slice(-50);
  const body = `<p class="session-meta"><span>${e(hostName(task.assignment.host))}</span><span>Model: ${e(task.assignment.model ?? 'harness default')}</span><span>${task.assignment.minutes} min for each turn</span></p>
    <dl class="task-fields"><dt>Objective</dt><dd>${more(`objective-${task.id}`, task.assignment.objective, 220)}</dd><dt>Input files</dt><dd>${task.assignment.inputs.length ? task.assignment.inputs.map((input) => `<code>${e(input.path)}</code>`).join(' ') : 'None'}</dd><dt>May write to</dt><dd>${task.assignment.writable.map((path) => `<code>${e(path === '.' ? 'the whole project' : path)}</code>`).join(' ')}</dd><dt>Network</dt><dd>${task.assignment.network ? `${e(task.assignment.network.domains.join(', '))}: ${e(task.assignment.network.reason)}${task.assignment.host === 'codex' ? ' (Codex cannot limit the network to these domains.)' : ''}` : 'None for shell commands'}</dd><dt>Expected output</dt><dd>${more(`output-${task.id}`, task.assignment.output, 160)}</dd>${task.assignment.dependencies.length ? `<dt>Waits for</dt><dd>${e(task.assignment.dependencies.join(', '))}</dd>` : ''}${attempt?.consumed?.length ? `<dt>Received</dt><dd>${e(attempt.consumed.map((used) => `${used.task} version ${used.version}`).join(', '))}</dd>` : ''}</dl>
    ${attempt?.note && task.state !== 'review' ? `<p class="notice">${e(attempt.note)}</p>` : ''}
    ${next}
    ${task.state !== 'running' && agent ? `<div class="actions">${agent}</div>` : ''}
    ${live.coordinator?.state && !live.coordinator.state.stoppedAt ? `<label class="field" for="task-coordinator-message">Ask the coordinator about this task</label><textarea id="task-coordinator-message" rows="2" maxlength="3950"></textarea><div class="actions"><button type="button" data-action="coordinator-message" data-about="${e(task.id)}">Ask the coordinator</button></div><p class="fine">The coordinator gets your message with this task named. It answers in its note on Home.</p>` : ''}
    <details id="task-messages"${thread.some((message) => message.status === 'open') ? ' open' : ''}><summary>Messages (${thread.length})</summary>${thread.length ? `<ul class="messages">${thread.map((message) => `${messageItem(message)}${message.status === 'open' && !needKeys.has(`message:${message.id}`) ? `<li class="decide"><p class="fine">The coordinator settles this one. You can settle it first.</p>${decideForm(message)}</li>` : ''}`).join('')}</ul>` : '<p class="empty-note">No messages yet.</p>'}<label class="field" for="task-message">Message to this task's worker</label><textarea id="task-message" rows="2" maxlength="4000"></textarea><p class="fine">The worker receives it with its next turn. A message cannot change the task's paths, permissions, or limits.</p><div class="actions"><button type="button" data-action="task-message" data-task="${e(task.id)}" data-to="${e(task.id)}">Send</button></div></details>
    ${taskPod(task.id, live.compute)}
    ${attempt?.restrictions.length ? `<details id="task-limits"><summary>What the harness enforces</summary><ul>${attempt.restrictions.map((entry) => `<li>${e(entry)}</li>`).join('')}</ul><p class="fine">Verifold sets these limits in the harness. A prompt alone is not a limit.</p></details>` : ''}
    ${history.length || notes.length ? `<details id="task-history"><summary>History</summary><ul>${[...history, ...notes].join('')}</ul></details>` : ''}`;
  return {
    kind: 'Task',
    title: task.assignment.title,
    sub: `<span class="status ${tone}">${e(label)}</span><span>${e(task.id)}, revision ${task.revision}</span>`,
    body,
  };
}

/** Why a task exists: the coordinator's reason when it created the task, or the start of its objective. */
function taskWhy(task: TaskRecord): string {
  const reason = task.assignment.reason.replace(
    /^Created by the coordinator:\s*/,
    '',
  );
  return lead(
    reason && reason !== 'Created' ? reason : task.assignment.objective,
    140,
  );
}

/** What a task's agent does now: its latest step, or how long it has been quiet. */
function taskNow(
  task: TaskRecord,
  workers: readonly SessionView[],
): string | null {
  if (task.state !== 'running' && task.state !== 'claimed') return null;
  const session = task.attempts.at(-1)?.session;
  const record = workers.find((worker) => worker.record.id === session)?.record;
  const last = record?.events.filter((event) => event.kind !== 'status').at(-1);
  if (!last)
    return task.state === 'claimed' ? 'Preparing the task folder' : null;
  const quiet = Math.floor((Date.now() - Date.parse(last.at)) / 60_000);
  return quiet >= 5
    ? `No update in ${quiet} min`
    : lead(last.kind === 'agent' ? plain(last.text) : last.text, 110);
}

/** Whose turn it is in a task, and whether the turn is the person's. */
function taskTurn(
  task: TaskRecord,
  all: readonly TaskRecord[],
  coordinated: boolean,
): [string, boolean] {
  const waiting = task.assignment.dependencies.filter(
    (id) => all.find((entry) => entry.id === id)?.state !== 'done',
  );
  switch (task.state) {
    case 'open':
      return waiting.length
        ? [
            `Waits for ${waiting.map((id) => all.find((entry) => entry.id === id)?.assignment.title ?? id).join(', ')}`,
            false,
          ]
        : [
            coordinated ? "Coordinator's turn to start it" : 'Ready to start',
            !coordinated,
          ];
    case 'claimed':
      return ['Starting', false];
    case 'running':
      return ["Agent's turn", false];
    case 'review':
      return coordinated
        ? ["Coordinator's turn to review", false]
        : ['Your turn to review', true];
    case 'done':
      return ['Done', false];
    case 'cancelled':
      return ['Cancelled', false];
  }
}

/**
 * The plan as a map: the objective, then each task in the column of its
 * depth, with arrows from what it waits for. The page draws the arrows. Each
 * box says the same in words, so the map reads without them.
 */
function renderMap(
  view: TaskView,
  live: DeskSession,
  objective: string,
  shown: string | undefined,
  needs: readonly Need[],
): string {
  const tasks = view.list;
  const workers = live.workers ?? (live.session ? [live.session] : []);
  const state = live.coordinator?.state;
  const coordinated = !!state && !state.stoppedAt;
  const depth = new Map<string, number>();
  const measure = (task: TaskRecord, seen: ReadonlySet<string>): number => {
    const known = depth.get(task.id);
    if (known !== undefined) return known;
    const parents = task.assignment.dependencies
      .map((id) => tasks.find((entry) => entry.id === id))
      .filter((entry) => entry !== undefined && !seen.has(entry.id));
    const value =
      1 +
      Math.max(
        0,
        ...parents.map((parent) =>
          parent ? measure(parent, new Set([...seen, task.id])) : 0,
        ),
      );
    depth.set(task.id, value);
    return value;
  };
  for (const task of tasks) measure(task, new Set());
  const columns = Math.max(1, ...depth.values());
  const box = (task: TaskRecord): string => {
    const [turn, yours] = taskTurn(task, tasks, coordinated);
    const now = taskNow(task, workers);
    const version = task.attempts.at(-1)?.versions.at(-1);
    const raised = needs.filter((item) => item.task === task.id).length;
    const from = task.assignment.dependencies.length
      ? task.assignment.dependencies.join(' ')
      : 'objective';
    return `<button type="button" class="map-box" data-task-select="${e(task.id)}" aria-pressed="${task.id === shown}" data-node="${e(task.id)}" data-state="${task.state}" data-from="${e(from)}"><span class="map-title"><span class="mark ${taskMarks[task.state]}" aria-hidden="true"></span>${e(task.assignment.title)}</span><span class="map-turn${yours || raised ? ' yours' : ''}">${e(raised && !yours ? `${raised} ${raised === 1 ? 'item needs' : 'items need'} you` : turn)}</span>${now ? `<span class="map-now"><span class="map-label">Now</span> ${e(now)}</span>` : ''}<span class="map-why"><span class="map-label">Why</span> ${e(taskWhy(task))}</span><span class="map-meta"><span>${e(task.id)}</span>${version ? `<span>Version ${version.number}${version.decision ? `, ${version.decision.kind === 'accepted' ? 'accepted' : version.decision.kind === 'changes' ? 'changes asked' : 'rejected'}` : ', in review'}</span>` : ''}</span></button>`;
  };
  return `<div class="map" data-map><div class="map-col"><div class="map-root" data-node="objective"><span class="map-label">Objective</span><span class="map-title">${e(lead(objective, 140))}</span></div></div>${Array.from(
    { length: columns },
    (_, index) =>
      `<div class="map-col">${tasks
        .filter((task) => depth.get(task.id) === index + 1)
        .map(box)
        .join('')}</div>`,
  ).join(
    '',
  )}<svg class="map-links" aria-hidden="true"><defs><marker id="map-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z"/></marker></defs><g></g></svg></div>`;
}

/** Team now, on Home: each running task with what its agent does and why the task exists. */
function renderTeamNow(
  tasks: readonly TaskRecord[],
  workers: readonly SessionView[],
): string {
  const running = tasks.filter(
    (task) => task.state === 'running' || task.state === 'claimed',
  );
  if (!running.length) return '';
  return `<section class="card" aria-labelledby="now-title"><div class="section-title"><h2 id="now-title">Team now</h2><button type="button" class="quiet" data-view="tasks">See the plan</button></div><ul class="now-list">${running
    .map(
      (task) =>
        `<li><button type="button" data-task-select="${e(task.id)}">${avatar('task', 'working')}<span class="who"><span class="name">${e(task.assignment.title)}</span><span class="line"><span class="map-label">Now</span> ${e(taskNow(task, workers) ?? 'Working')}</span><span class="line"><span class="map-label">Why</span> ${e(taskWhy(task))}</span></span></button></li>`,
    )
    .join('')}</ul></section>`;
}

/** The tasks of this project as a live map. The panel shows one task in full. */
function renderTasksView(
  view: TaskView,
  live: DeskSession,
  objective: string,
  shown: string | undefined,
  offerCoordinator: boolean,
  needs: readonly Need[],
): string {
  const running = view.list.filter(
    (task) => task.state === 'running' || task.state === 'claimed',
  ).length;
  return `<div class="view wide"><div class="view-head"><h1 id="view-title" tabindex="-1">Tasks</h1><button type="button" class="primary" data-panel="new-task">New task</button></div>
  ${
    view.list.length
      ? `<section class="card map-card" aria-labelledby="map-title"><div class="section-title"><h2 id="map-title">The plan</h2><span class="count">${view.list.length} ${view.list.length === 1 ? 'task' : 'tasks'}, ${running} running</span></div>${renderMap(view, live, objective, shown, needs)}<p class="fine">Each box is a task. An arrow comes from what it waits for. A box opens the task.</p></section>`
      : '<section class="card empty-state"><h2>No tasks yet</h2><p class="fine">After you choose a direction, the coordinator plans tasks for it. You can also write a task yourself with New task.</p></section>'
  }
  <p class="fine">A task runs your harness in its own copy of the project. The harness can write only to the paths that you allow. You review each version before any file reaches your project. Up to ${workerLimit} tasks and sessions run at the same time.</p>
  ${offerCoordinator ? '<section class="card"><h2>Coordinator</h2><p class="fine">After you choose a direction, the coordinator plans the tasks for it. You can also start it now with your own objective.</p><div class="actions"><button type="button" data-panel="coordinator">Open the coordinator</button></div></section>' : ''}</div>`;
}

/** The tool calls of one worker, with who let each one run. */
function commandTable(view: SessionView, name: string): string {
  const { record } = view;
  const open = record.commands.filter(needsReview);
  const shown = record.commands.slice(-100);
  return `<div class="section-title"><h3>${e(name)}</h3><span class="count">${record.commands.length > shown.length ? `Latest ${shown.length} of ${record.commands.length}` : `${record.commands.length} recorded`}</span></div><p class="fine">${open.length ? `${open.length} risky ${open.length === 1 ? 'command ran' : 'commands ran'} without a person's approval and ${open.length === 1 ? 'waits' : 'wait'} for review.` : 'No tagged command waits for review.'} Tags come from the command text. The record shows the command that the agent asked for, not the processes that it started.</p><div class="table"><table><thead><tr><th scope="col">Time</th><th scope="col">Tool</th><th scope="col">Command or target</th><th scope="col">Approved by</th><th scope="col">Risk</th><th scope="col">Result</th><th scope="col">Review</th></tr></thead><tbody>${shown
    .map(
      (command) =>
        `<tr><td>${e(clock(command.at))}</td><td>${e(command.tool)}</td><td><code>${e(command.action.length > 300 ? `${command.action.slice(0, 300)}…` : command.action || 'Not reported')}</code>${command.review?.rationale ? `<span class="fine">Reviewer: ${e(command.review.rationale)}</span>` : ''}</td><td>${e(decisionLabel(command, record.host))}</td><td>${command.risk.length ? command.risk.map((tag) => `<span class="risk">${e(tag)}</span>`).join(' ') : '<span class="fine">None</span>'}</td><td>${e(result(command))}</td><td>${needsReview(command) ? `<button type="button" data-action="review" data-command="${e(command.id)}">Mark reviewed</button>` : command.reviewedAt ? 'Reviewed' : '<span class="fine">Not needed</span>'}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

/** Results: the checks of the chosen direction with their results, then the answer and the sign-off. */
function renderResultsView(workspace: Workspace, live: DeskSession): string {
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  const head = `<div class="view-head"><h1 id="view-title" tabindex="-1">Results</h1><p>${idea ? `Direction: ${e(idea.title)}` : 'No direction yet'}</p></div>`;
  if (!idea)
    return `<div class="view">${head}<section class="card empty-state"><h2>No direction yet</h2><p class="fine">Results show here after you choose a direction and the team works on it.</p></section></div>`;
  const results = resultsOf(workspace, live);
  const answer = results?.answer;
  const open = (results?.checks ?? []).filter(
    (entry) => entry.result === 'judgement' && !entry.ruling,
  ).length;
  const checks = idea.gates
    .map((gate, index) => {
      const entry = results?.checks.find((saved) => saved.check === index + 1);
      const outcome = entry?.ruling?.result ?? entry?.result;
      return `<li class="check-row" data-result="${outcome ?? 'none'}"><span class="check-num">${index + 1}</span><div class="check-body"><p class="check-text">${e(gate)}</p>${
        entry
          ? `<p class="check-value"><span class="tag reading">Its reading</span> ${e(entry.value)}</p><p class="fine">Evidence: ${entry.evidence.map((path) => `<code>${e(path)}</code>`).join(' ')}</p><div class="why"><span class="tag reading">Its reason</span>${more(`check-reason-${index + 1}`, entry.reason, 120)}</div>${entry.ruling ? `<p class="ruling">You ruled: ${e(outcomeLabels[entry.ruling.result].toLowerCase())}. ${e(entry.ruling.reason)}</p>` : entry.result === 'judgement' ? `<p class="ruling-question"><strong>${e(entry.question ?? 'It needs your judgement.')}</strong></p>${judgementForm(entry)}` : ''}`
          : ''
      }</div><span class="check-result">${outcome ? e(outcomeLabels[outcome]) : 'Not reported yet'}</span></li>`;
    })
    .join('');
  const signOff = !answer
    ? ''
    : answer.decision?.kind === 'accepted'
      ? `<p class="notice-ok">You accepted the answer at ${e(since(answer.decision.at))}.</p>`
      : answer.decision?.kind === 'more'
        ? `<p class="fine">You asked for more work at ${e(since(answer.decision.at))}: ${e(answer.decision.note ?? '')}</p>`
        : `<div class="sign-off">${open ? `<p class="notice">Settle the ${open} open ${open === 1 ? 'judgement' : 'judgements'} above first.</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="coordinator-answer" data-decision="accepted"${open ? ' disabled' : ''}>Accept the answer</button></div><label class="field" for="answer-note">What more work is needed</label><textarea id="answer-note" rows="3" maxlength="4000"></textarea><div class="actions"><button type="button" data-action="coordinator-answer" data-decision="more">Ask for more work</button></div></div>`;
  return `<div class="view">${head}
  <section class="card" aria-labelledby="checks-title"><div class="section-title"><h2 id="checks-title">The checks</h2><span class="count">${results?.checks.length ?? 0} of ${idea.gates.length} reported</span></div><ol class="checks">${checks}</ol><p class="fine">The coordinator reports each result with the accepted files that show it. Verifold checks that the files were accepted. The values and reasons are its reading.</p></section>
  ${
    answer
      ? `<section class="card answer" aria-labelledby="answer-title"><div class="section-title"><h2 id="answer-title">The answer</h2><span class="tag reading">The coordinator's reading</span></div><p class="statement">${e(answer.statement)}</p><ol class="claims">${answer.claims.map((claim) => `<li><p>${e(claim.text)}</p>${claim.evidence.length ? `<p class="fine">Evidence: ${claim.evidence.map((item) => (/^https?:\/\//.test(item) ? link(item) : `<code>${e(item)}</code>`)).join(' ')}</p>` : ''}</li>`).join('')}</ol>${signOff}</section>`
      : '<section class="card"><h2>The answer</h2><p class="fine">The coordinator proposes the answer when the checks have results. You sign it off here.</p></section>'
  }</div>`;
}

const leaseStates: Record<Lease['state'], string> = {
  requested: 'Waits for you',
  denied: 'Denied',
  starting: 'Starting',
  ready: 'Ready',
  stopped: 'Stopped',
  ended: 'Ended',
  failed: 'Failed',
};

/** The pods card: what is spent and reserved, the open leases with their controls, and earlier leases. */
function renderPods(compute: ComputeView): string {
  const { budget, settings } = compute;
  const now = Date.now();
  const row = (lease: Lease): string => {
    const actions =
      lease.state === 'ready' || lease.state === 'starting'
        ? `<button type="button" data-action="compute-lease-stop" data-lease="${e(lease.id)}">Stop</button><button type="button" data-action="compute-lease-end" data-lease="${e(lease.id)}">End</button>`
        : lease.state === 'stopped'
          ? `<button type="button" data-action="compute-lease-start" data-lease="${e(lease.id)}">Start</button><button type="button" data-action="compute-lease-end" data-lease="${e(lease.id)}">End</button>`
          : lease.state === 'requested'
            ? '<button type="button" data-view="needs">Decide</button>'
            : '';
    const idle =
      lease.state === 'ready' && lease.activeAt
        ? Math.floor((now - Date.parse(lease.activeAt)) / 60_000)
        : 0;
    return `<tr data-state="${lease.state}"><th scope="row">${e(lease.id)}</th><td>${lease.tasks.map((task) => e(task)).join(', ')}</td><td>${e(lease.gpu)}</td><td>${e(leaseStates[lease.state])}${idle >= 5 ? `<span class="fine">Idle ${idle} min</span>` : ''}</td><td>${usd(spent(lease, now))}${isRunning(lease) ? `<span class="fine">${usd(lease.rate)} per hour</span>` : ''}</td><td>${lease.deadline && isOpen(lease) ? e(since(lease.deadline)) : lease.end ? e(lease.end.reason) : '—'}</td><td class="row-actions">${actions}</td></tr>`;
  };
  const current = compute.leases.filter(
    (lease) => isOpen(lease) || lease.state === 'requested',
  );
  const earlier = compute.leases.filter((lease) => !current.includes(lease));
  const head =
    '<thead><tr><th scope="col">Lease</th><th scope="col">For</th><th scope="col">GPU</th><th scope="col">Status</th><th scope="col">Cost so far</th><th scope="col">Ends</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>';
  return `<section class="card" aria-labelledby="pods-title"><div class="section-title"><h2 id="pods-title">Pods</h2>${budget.rate ? `<span class="count">${usd(budget.rate)} per hour now</span>` : ''}</div>
  ${settings.limitUsd === null ? '' : `<p>Spent ${usd(budget.spent)}. Held for open leases ${usd(budget.reserved)}. Left ${usd(Math.max(0, budget.left ?? 0))} of ${usd(settings.limitUsd)}.</p>`}
  ${compute.problem ? `<p class="notice">${e(compute.problem.text)} (${e(since(compute.problem.at))})</p>` : ''}
  ${current.length ? `<div class="table"><table class="leases">${head}<tbody>${[...current].reverse().map(row).join('')}</tbody></table></div>` : `<p class="fine">No pod runs. The coordinator asks for a pod when a task needs a GPU, and you approve it in Needs you.</p>`}
  ${earlier.length ? `<details id="earlier-leases"><summary>Earlier leases (${earlier.length})</summary><div class="table"><table class="leases">${head}<tbody>${[...earlier].reverse().slice(0, 30).map(row).join('')}</tbody></table></div></details>` : ''}
  <p class="fine">Costs count each running minute at the billed rate, with the disk. When RunPod's bill is higher, Verifold uses it.</p></section>`;
}

const stockNames = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  NONE: 'None',
} as const;

/** The form for a new or replacement RunPod key. The key field is never filled by the server. */
function keyForm(keyring: ComputeView['keyring']): string {
  return `<label class="field" for="runpod-key">RunPod API key</label><input id="runpod-key" type="password" autocomplete="off" spellcheck="false" maxlength="256">
  ${keyring ? `<label class="check" for="runpod-key-file"><input type="checkbox" id="runpod-key-file"> Keep it in a private file instead of ${e(placeNames[keyring])}</label>` : '<p class="fine">This computer has no keyring that Verifold can use, so the key goes into a private file that only you can read.</p>'}
  <div class="actions"><button type="button" class="primary" data-action="compute-key-save"${keyring ? '' : ' data-file="always"'}>Check and save</button></div>
  <p class="fine">Verifold checks the key with one read-only call to RunPod before it saves it. Use a separate key for Verifold, so that you can revoke it alone in the RunPod console.</p>`;
}

/** Compute: the RunPod key, the limits that only the person sets, and the GPUs that leases can use. */
function renderComputeView(compute: ComputeView): string {
  const { key, settings, gpus } = compute;
  const keyCard = key
    ? `<p>The key is in ${e(placeNames[key.place])}. It ends in <code>${e(key.last4)}</code>.</p>
      ${key.problem ? `<p class="notice">The check at ${e(since(key.checkedAt ?? key.savedAt))} failed. ${e(key.problem)}</p>` : key.checkedAt ? `<p class="notice-ok">It worked at ${e(since(key.checkedAt))}.</p>` : ''}
      <div class="actions"><button type="button" data-action="compute-key-check">Check</button><button type="button" data-action="compute-key-remove">Remove</button></div>
      <details id="key-replace"><summary>Replace the key</summary>${keyForm(compute.keyring)}</details>`
    : keyForm(compute.keyring);
  const number = (
    id: string,
    label: string,
    value: number | null,
    min: number,
    max: number,
    step = 1,
  ): string =>
    `<label class="field" for="${id}">${e(label)}<input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${value ?? ''}"></label>`;
  const offered = new Set(gpus?.map((gpu) => gpu.id));
  // An allowed type that RunPod does not offer now stays in the list, so a save keeps it.
  const rows = [
    ...(gpus ?? []),
    ...settings.gpuTypes
      .filter((id) => !offered.has(id))
      .map((id) => ({ id, name: id, memoryGb: 0, price: 0, stock: null })),
  ];
  const gpuCard = !key
    ? '<p class="fine">Store a RunPod key to see the GPUs with their price and stock.</p>'
    : !gpus
      ? `${settings.gpuTypes.length ? `<p>Leases can use ${settings.gpuTypes.map((id) => `<code>${e(id)}</code>`).join(', ')}.</p>` : '<p class="fine">No GPU type is allowed yet.</p>'}<div class="actions"><button type="button" data-action="compute-gpus">Show the GPUs</button></div>`
      : `<div class="table"><table class="gpus"><thead><tr><th scope="col">Allow</th><th scope="col">GPU</th><th scope="col">Memory</th><th scope="col">Per hour</th><th scope="col">Stock</th></tr></thead><tbody>${rows
          .map((gpu) => {
            const box = `gpu-${gpu.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            return `<tr><td><input type="checkbox" id="${e(box)}" data-gpu="${e(gpu.id)}"${settings.gpuTypes.includes(gpu.id) ? ' checked' : ''} aria-label="Allow ${e(gpu.name)}"></td><th scope="row">${e(gpu.name)}</th><td>${gpu.memoryGb ? `${gpu.memoryGb} GB` : '—'}</td><td>${gpu.price ? `$${gpu.price.toFixed(2)}${gpu.price > settings.maxUsdPerHour ? ' <span class="tag over-cap">Above your cap</span>' : ''}` : 'Not offered now'}</td><td>${gpu.stock ? stockNames[gpu.stock] : '—'}</td></tr>`;
          })
          .join(
            '',
          )}</tbody></table></div><p class="fine">List prices for one GPU on Secure Cloud, from RunPod at ${e(since(compute.gpusAt ?? ''))}.</p><div class="actions"><button type="button" class="primary" data-action="compute-settings">Save the GPU choice</button><button type="button" data-action="compute-gpus">Refresh the prices</button></div>`;
  return `<div class="view"><div class="view-head"><h1 id="view-title" tabindex="-1">Compute</h1><p>GPU pods on RunPod for your tasks</p></div>
  ${renderPods(compute)}
  <section class="card" aria-labelledby="key-title"><h2 id="key-title">RunPod key</h2>${keyCard}</section>
  <section class="card" aria-labelledby="limits-title"><div class="section-title"><h2 id="limits-title">Limits</h2>${settings.limitUsd !== null ? `<span class="count">$${settings.limitUsd} for this project</span>` : ''}</div>
  ${settings.limitUsd === null ? '<p class="notice">Pods stay off until you set a spend limit.</p>' : ''}
  <div class="fields">${number('compute-limit', 'Spend limit for this project, USD', settings.limitUsd, 1, 10_000)}${number('compute-rate', 'Highest rate of one pod, USD per hour', settings.maxUsdPerHour, 0.1, 50, 0.01)}${number('compute-hours', 'Hours of one lease, at most', settings.maxHoursPerLease, 1, 24)}${number('compute-idle', 'Stop an idle pod after, in minutes', settings.idleMinutes, 5, 240)}<label class="field" for="compute-pods">Pods at the same time<select id="compute-pods"><option value="1"${settings.maxRunningPods === 1 ? ' selected' : ''}>1</option><option value="2"${settings.maxRunningPods === 2 ? ' selected' : ''}>2</option></select></label>${number('compute-disk', 'Disk of each pod, GB', settings.diskGb, 10, 500)}</div>
  <label class="field" for="compute-images">RunPod images that a lease can use, one on each line</label><textarea id="compute-images" rows="2" maxlength="2000">${e(settings.images.join('\n'))}</textarea>
  <div class="actions"><button type="button" class="primary" data-action="compute-settings">Save the limits</button></div>
  <p class="fine">Only you can change these limits. RunPod erases the disk of a pod when the pod stops.</p></section>
  <section class="card" aria-labelledby="gpus-title"><h2 id="gpus-title">GPUs</h2>${gpuCard}</section></div>`;
}

/** The record of this owner: every worker's commands, then every research attempt. */
function renderRecords(
  snapshot: DeskSnapshot,
  workers: readonly SessionView[],
  tasks: readonly TaskRecord[],
  shown: string | undefined,
): string {
  const { attempts } = snapshot;
  const logged = workers.filter((worker) => worker.record.commands.length);
  return `<div class="view"><div class="view-head"><h1 id="view-title" tabindex="-1">Records</h1><p>What the agents ran, and every research attempt</p></div>
  <section class="card commands" aria-labelledby="commands-title"><h2 id="commands-title">Commands</h2>${logged.length ? logged.map((worker) => commandTable(worker, workerName(worker.record, tasks))).join('') : '<p class="empty-note">No commands are recorded yet. Each tool call that a worker reports shows here.</p>'}</section>
  <section class="card history" aria-labelledby="history-title"><div class="section-title"><h2 id="history-title">Research attempts</h2><span class="count">${attempts.length}</span></div>${snapshot.historyLimited ? '<p class="notice">History scan is limited to 200 entries, plus the latest recorded attempt. Inspect the project files for the complete record.</p>' : ''}${attempts.length ? `<ol>${attempts.map((attempt) => `<li><button type="button" data-attempt="${e(attempt.id)}" aria-pressed="${attempt.id === shown}"><span class="attempt-title">${e(attempt.record ? phaseLabel(attempt.record.phase) : 'Unrecorded attempt')}</span><span class="attempt-status">${e(outcome(attempt))}</span><span class="attempt-reference">${e(attempt.id.slice(0, 8))}${attempt.record ? ` <time datetime="${e(attempt.record.startedAt)}">${e(time(attempt.record.startedAt))}</time>` : ''}</span></button></li>`).join('')}</ol>` : '<p class="empty-note">Each research request shows here with its own identity.</p>'}</section></div>`;
}

/** The summary and the sources of one research report. Source links are validated before rendering. */
function findingsBody(report: ResearchReport, attempt: string): string {
  return `<div class="prose">${moreMd(`findings-${attempt}`, report.summary, 400)}</div><ol class="sources">${report.sources.map((source, index) => `<li><a id="source-${e(attempt)}-${index}" href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${e(source.title)}</a><span>${e(new URL(source.url).hostname)}</span></li>`).join('')}</ol><details id="delegation"><summary>Delegation reported by the model</summary><div class="prose md">${markdownHtml(report.delegation)}</div></details><p class="fine">Source links provide traceability. Scientific claims still need review.</p>`;
}

/** A web address as a link with its host and path. Text that is not an http(s) address stays text. */
function link(address: string): string {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error();
    const shown = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
    return `<a href="${e(url.href)}" target="_blank" rel="noopener noreferrer">${e(shown.length > 80 ? `${shown.slice(0, 80)}…` : shown)}</a>`;
  } catch {
    return `<span>${e(address)}</span>`;
  }
}

/** The searches and pages of the current research step, newest first. They come from its transcript and stay in the desk. */
function renderSources(
  sources: readonly ResearchSource[],
  running: boolean,
): string {
  if (!sources.length) return '';
  const read = sources.filter((source) => source.kind === 'read').length;
  const searched = sources.length - read;
  const shown = [...sources].reverse().slice(0, 15);
  return `<section class="card" aria-labelledby="sources-live-title"><div class="section-title"><h2 id="sources-live-title">${running ? 'Sources so far' : 'Sources of the latest step'}</h2><span class="count">${searched} ${searched === 1 ? 'search' : 'searches'}, ${read} ${read === 1 ? 'page' : 'pages'} read</span></div><ul class="sources-live">${shown
    .map(
      (source) =>
        `<li><span class="chip">${source.kind === 'read' ? 'Read' : 'Searched'}</span>${source.kind === 'read' ? link(source.text) : `<span>${e(source.text)}</span>`}<time datetime="${e(source.at)}">${e(clock(source.at))}</time></li>`,
    )
    .join(
      '',
    )}</ul>${sources.length > shown.length ? `<p class="fine">The latest ${shown.length} of ${sources.length}.</p>` : ''}</section>`;
}

/** Research can still take a choice of direction: no direction yet, and no step runs. */
function choosable(workspace: Workspace, live: DeskSession): boolean {
  return (
    live.research !== undefined &&
    !live.research.running &&
    !workspace.selectedId &&
    workspace.research?.phase === 'directions'
  );
}

/** One direction in full: its case, its checks, its sources, and the choice. */
function directionPanel(
  idea: Candidate,
  workspace: Workspace,
  live: DeskSession,
): Panel {
  const chosen = workspace.selectedId === idea.id;
  return {
    kind: 'Direction',
    title: idea.title,
    sub: `<span class="status ${chosen ? 'active' : 'muted'}">${chosen ? 'Chosen' : workspace.selectedId ? 'Not chosen' : 'Proposed'}</span>`,
    body: `<div class="md">${markdownHtml(idea.recommendation)}</div>
    <h3>Its checks</h3><ul class="checks-list">${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul>
    <p class="fine">The coordinator gets these checks with the direction, and plans tasks that give evidence for them.</p>
    ${idea.sources?.length ? `<h3>Its sources</h3><ol class="sources">${idea.sources.map((source) => `<li>${link(source)}</li>`).join('')}</ol>` : ''}
    ${choosable(workspace, live) ? `<div class="actions"><button type="button" class="primary" data-action="select" data-idea="${e(idea.id)}" data-confirm="Click again to lock this direction">Choose this direction</button></div><p class="fine">The choice locks it for this project. Then the coordinator plans its tasks.</p>` : ''}`,
  };
}

/** The research record: the decision, the live step, the directions, the scope, the findings, and the brief. */
function renderResearchView(
  workspace: Workspace,
  live: DeskSession,
  report: ResearchReport | null,
  chosen: DeskAttempt | undefined,
  shown: string | undefined,
): string {
  const research = workspace.research;
  return `<div class="view"><div class="view-head"><h1 id="view-title" tabindex="-1">Research</h1><p>${e(phaseLabel(research?.phase))}</p></div>
  ${research?.topic ? `<p class="question">${e(research.topic)}</p>` : ''}
  ${renderDecision(workspace, live, 'research')}
  ${workspace.candidates.length ? `<section class="card" aria-labelledby="directions-title"><div class="section-title"><h2 id="directions-title">Compare the directions</h2><span class="count">${workspace.candidates.length} proposed</span></div><div class="table"><table class="compare"><thead><tr><th scope="col">Direction</th><th scope="col">Its case</th><th scope="col">Checks</th><th scope="col">Sources</th></tr></thead><tbody>${workspace.candidates.map((idea) => `<tr${workspace.selectedId === idea.id ? ' class="chosen"' : ''}><th scope="row"><button type="button" class="row-button" data-direction="${e(idea.id)}" aria-pressed="${shown === idea.id}">${e(idea.title)}</button>${workspace.selectedId === idea.id ? '<span class="selected-label">Chosen</span>' : ''}</th><td data-label="Its case">${e(lead(plain(idea.recommendation), 150))}</td><td data-label="Checks">${idea.gates.length}</td><td data-label="Sources">${idea.sources?.length ?? 0}</td></tr>`).join('')}</tbody></table></div><p class="fine">${choosable(workspace, live) ? 'Open a direction to read its case and its checks, and to choose it.' : 'Open a direction to read its case and its checks.'}</p></section>` : ''}
  ${renderResearch(live.research, research?.latestAttempt)}
  ${renderSources(live.research?.sources ?? [], live.research?.running === true)}
  ${research?.plan ? `<section class="card"><details id="research-plan"${research.phase === 'awaiting-plan-review' ? ' open' : ''}><summary><h2>Research scope</h2><span>Proposed roles</span></summary><div class="prose md">${markdownHtml(research.plan.scope)}</div><ul class="roles">${research.plan.personas.map((persona) => `<li><strong>${e(persona.name)}</strong><span>${e(persona.task)}</span></li>`).join('')}</ul><p class="fine">These are proposed roles, not independently observed workers.</p></details></section>` : ''}
  <section class="card findings" aria-labelledby="findings-title"><div class="section-title"><h2 id="findings-title">Sources and findings</h2>${chosen ? `<span class="count">Attempt ${e(chosen.id.slice(0, 8))}</span>` : ''}</div>
  ${report ? findingsBody(report, chosen?.id ?? '') : `<div class="empty-note"><p>${chosen ? 'No readable source report is available for this attempt.' : 'Your source record starts here.'}</p><p>${chosen ? 'Planning, failed, and interrupted attempts may have no report. Their evidence remains in the project.' : 'Sources and findings show here when research saves a report.'}</p></div>`}</section>
  <section class="card brief-section"><details id="research-brief"${research ? '' : ' open'}><summary><h2>Research brief</h2><span>Project context</span></summary>${workspace.context ? `<div class="prose md">${markdownHtml(workspace.context)}</div>` : '<p class="empty-note">No research brief is saved yet.</p>'}</details></section></div>`;
}

/** One research attempt in full: its outcome, its report, its identity, and its transcript. */
function attemptPanel(
  chosen: DeskAttempt,
  workspace: Workspace,
  live: DeskSession,
  report: ResearchReport | null,
): Panel {
  const record = chosen.record;
  const tone =
    chosen.activity === 'recent'
      ? 'active'
      : record?.status === 'succeeded'
        ? 'success'
        : record?.status === 'failed'
          ? 'failed'
          : 'muted';
  const state =
    chosen.activity === 'unknown'
      ? '<p class="notice">The final outcome is unknown. Inspect the attempt files and confirm whether research is still active before retrying or removing a lock.</p>'
      : chosen.activity === 'recent'
        ? `<p class="fine">${live.research ? 'The research owner recently reported activity. Follow it in Research.' : 'The research owner recently reported activity. The adapter provides lifecycle and final output, not live tool output.'}</p>`
        : record?.status === 'interrupted'
          ? '<p class="notice">Verifold stopped during this attempt, so its outcome is unknown. Continue research to run the step again from the saved checkpoint.</p>'
          : record?.status === 'failed' || record?.status === 'cancelled'
            ? '<p class="notice">Available evidence is preserved. Inspect the attempt files and saved checkpoint before continuing.</p>'
            : '<p class="fine">The response passed validation and its checkpoint was saved.</p>';
  const body = `${state}${report ? `<h3>Sources and findings</h3>${findingsBody(report, chosen.id)}` : ''}<details id="attempt-identity"><summary>Harness and session details</summary><dl><dt>Verifold attempt</dt><dd>${e(chosen.id)}</dd><dt>Harness</dt><dd>${e(record?.host ?? 'Unknown')}</dd><dt>Requested model</dt><dd>${e(record ? (record.model ?? 'Harness default; resolved model unknown') : 'Unknown')}</dd><dt>Native session</dt><dd>${e(record?.nativeSessionId ?? 'Not reported')}</dd><dt>Requested session</dt><dd>${e(record ? (record.requestedSessionId ?? 'New session requested') : 'Unknown')}</dd>${record ? `<dt>Started</dt><dd>${e(time(record.startedAt))}</dd><dt>Finished</dt><dd>${e(record.finishedAt ? time(record.finishedAt) : 'Not recorded')}</dd>` : ''}</dl></details>${live.research?.step && chosen.id === workspace.research?.latestAttempt ? '<p class="fine">Its transcript is in Research. Choose Details there.</p>' : `<details id="attempt-transcript"><summary>Harness transcript</summary>${transcriptSlot(`attempt:${chosen.id}`, 'Attempt transcript', '')}</details>`}`;
  return {
    kind: 'Research attempt',
    title: record ? phaseLabel(record.phase) : 'Unrecorded attempt',
    sub: `<span class="status ${tone}">${e(outcome(chosen))}</span><span>${e(chosen.id.slice(0, 8))}</span>`,
    body,
  };
}

/** The terminal page: xterm.js renders one harness terminal. It runs inside the desk, or alone in its own tab. */
export const terminalPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Verifold terminal</title><link rel="icon" href="/symbol.webp"><link rel="stylesheet" href="/vendor/xterm.css"><link rel="stylesheet" href="/desk.css"><script type="module" src="/desk-terminal.js"></script></head><body class="terminal-page"><div class="terminal-bar"><span id="terminal-state" role="status">Connecting…</span><button id="terminal-take" type="button" hidden>Take input here</button></div><div id="terminal" class="terminal-screen" role="application" aria-label="Harness terminal"></div></body></html>`;

/**
 * The desk shell. The page fills #content with the rail, one view, and the
 * panel, and keeps the top bar.
 */
export const deskPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Verifold</title><link rel="icon" href="/symbol.webp"><link rel="stylesheet" href="/desk.css"><script type="module" src="/desk-client.js"></script></head><body><a class="skip" href="#view">Skip to the main view</a><header class="topbar"><button id="menu" class="icon-button menu-button" type="button" aria-label="Show the views and the team" aria-expanded="false">☰</button><a class="brand" href="/" aria-label="Verifold research desk"><img src="/symbol.webp" alt="" width="26" height="26"><span>verifold</span></a><div class="project"><strong id="project-title">Research desk</strong><span class="stage" id="stage" hidden></span></div><span class="spacer"></span><span id="action-status" role="status"></span><span id="observation"></span><span id="connection" role="status">Connecting…</span><button id="needs" class="needs-button" type="button" data-view="needs" hidden><span class="needs-label">Needs you</span><span class="count" id="needs-count">0</span></button><button id="theme" class="icon-button" type="button" aria-label="Switch the color theme" title="Switch the color theme">◐</button></header><div class="connection-note" id="connection-note" hidden><span id="connection-message"></span><button id="retry" type="button">Refresh</button></div><div id="content" class="frame"><main id="view" class="solo" tabindex="-1"><div class="empty"><h1>Opening your research desk</h1><p>Reading the selected project. This does not start research.</p></div></main></div></body></html>`;

/** The stages of a project, from the question to the answer. Home draws them as an arc. */
const stageNames = [
  'Question',
  'Research',
  'Direction',
  'Plan',
  'Tasks',
  'Answer',
] as const;

interface Progress {
  /** The index of the current stage in stageNames. */
  readonly current: number;
  /** A short note for each stage. */
  readonly notes: readonly string[];
  /** The current stage waits for a decision of the person. */
  readonly waits: boolean;
  /** An agent works on the current stage. */
  readonly working: boolean;
}

/** Where the project is, from the records that the desk reads. Nothing here is stored. */
function progress(workspace: Workspace, live: DeskSession): Progress {
  const notes = ['Asked', '', '', '', '', ''];
  const research = workspace.research;
  const searching = live.research?.running === true;
  // A chosen direction comes first: an older flow can choose one without a research record.
  if (!workspace.selectedId) {
    if (!research) {
      notes[0] = 'Not asked yet';
      return { current: 0, notes, waits: false, working: false };
    }
    if (research.phase === 'directions') {
      notes[1] = 'Done';
      notes[2] = searching ? 'Revising' : 'Waits for you';
      return { current: 2, notes, waits: !searching, working: searching };
    }
    const waits = research.phase === 'awaiting-plan-review' && !searching;
    notes[1] = searching ? 'Running' : waits ? 'Waits for you' : 'Stopped';
    return { current: 1, notes, waits, working: searching };
  }
  notes[1] = 'Done';
  notes[2] = 'Chosen';
  const coordinator = live.coordinator;
  const tasks = live.tasks?.list ?? [];
  const status = coordinator?.session?.record.status;
  const coordinating = status === 'running' || status === 'starting';
  const state = coordinator?.state;
  if (!state?.planApproved) {
    const waits = planWaits(coordinator, tasks);
    const started = !!state && !state.stoppedAt;
    notes[3] = !started ? 'Not started' : waits ? 'Waits for you' : 'Planning';
    return { current: 3, notes, waits, working: started && coordinating };
  }
  notes[3] = 'Approved';
  const planned = tasks.filter((task) => task.assignment.by === 'coordinator');
  const settled = planned.filter(
    (task) => task.state === 'done' || task.state === 'cancelled',
  ).length;
  notes[4] = `${settled} of ${planned.length} done`;
  // A proposed answer waits for the person's sign-off. A request for more work returns to the tasks.
  const answer = resultsOf(workspace, live)?.answer;
  if (answer && answer.decision?.kind !== 'more') {
    notes[5] = answer.decision ? 'Accepted' : 'Waits for you';
    return { current: 5, notes, waits: !answer.decision, working: false };
  }
  if (planned.length && settled === planned.length) {
    notes[5] = 'Tasks done';
    return { current: 5, notes, waits: false, working: false };
  }
  const working =
    coordinating || (live.workers ?? []).some((worker) => worker.live);
  return { current: 4, notes, waits: false, working };
}

/** The current stage in words: the top bar shows it, and the arc says it to screen readers. */
function stageText(at: Progress): string {
  const note = at.notes[at.current];
  return `${stageNames[at.current] ?? ''}${note ? `: ${note.toLowerCase()}` : ''}`;
}

type Point = readonly [number, number];

const arcPoints: readonly Point[] = [
  [60, 62],
  [236, 40],
  [412, 66],
  [588, 42],
  [764, 64],
  [940, 44],
];

/** A smooth line through the points: Catmull-Rom segments drawn as cubic Bézier curves. */
function curve(points: readonly Point[]): string {
  const round = (value: number): number => Math.round(value * 10) / 10;
  return points
    .map((point, index) => {
      const previous = points[index - 1];
      if (!previous) return `M${point[0]} ${point[1]}`;
      const before = points[index - 2] ?? previous;
      const after = points[index + 1] ?? point;
      return `C${round(previous[0] + (point[0] - before[0]) / 6)} ${round(previous[1] + (point[1] - before[1]) / 6)}, ${round(point[0] - (after[0] - previous[0]) / 6)} ${round(point[1] - (after[1] - previous[1]) / 6)}, ${point[0]} ${point[1]}`;
    })
    .join(' ');
}

/** The project's arc on Home: the brand's folded ribbon, from the question to the answer. */
function renderArc(at: Progress): string {
  const reached = arcPoints.slice(0, at.current + 1);
  const now = stageText(at);
  return `<div class="arc"><svg viewBox="0 0 1000 132" role="img" aria-label="Project stage. ${e(now)}."><defs><linearGradient id="ribbon" x1="0" x2="1"><stop offset="0" stop-color="#4c1d95"/><stop offset="0.55" stop-color="#7c3aed"/><stop offset="1" stop-color="#b794f6"/></linearGradient></defs><path class="future" d="${curve(arcPoints.slice(at.current))}"/>${
    reached.length > 1
      ? `<path class="band" d="${curve(reached)}"/>${[-8, -4, 0, 4, 8]
          .map(
            (shift) =>
              `<path class="contour" d="${curve(reached.map(([x, y]) => [x, y + shift] as const))}"/>`,
          )
          .join('')}`
      : ''
  }${arcPoints
    .map(([x, y], index) => {
      const current = index === at.current;
      const state =
        index < at.current
          ? 'done'
          : current
            ? `current${at.waits ? ' you' : ''}`
            : 'future';
      return `${current && at.working ? `<circle class="pulse" cx="${x}" cy="${y}" r="10"/>` : ''}<circle class="node ${state}" cx="${x}" cy="${y}" r="${current ? 10 : 7}"/><text class="label${current ? ' current' : ''}" x="${x}" y="${y + 38}" text-anchor="middle">${stageNames[index] ?? ''}</text><text class="sub${current && at.waits ? ' you' : ''}" x="${x}" y="${y + 57}" text-anchor="middle">${e(at.notes[index] ?? '')}</text>`;
    })
    .join(
      '',
    )}</svg><p class="arc-caption${at.waits ? ' you' : ''}" aria-hidden="true">${e(now)}</p></div>`;
}

/** The views in the rail. The top bar opens Needs you. */
const railViews = [
  'home',
  'research',
  'tasks',
  'results',
  'compute',
  'records',
] as const;
type RailView = (typeof railViews)[number];

const viewNames: Record<RailView, string> = {
  home: 'Home',
  research: 'Research',
  tasks: 'Tasks',
  results: 'Results',
  compute: 'Compute',
  records: 'Records',
};

const viewIcons: Record<RailView, string> = {
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  research:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/></svg>',
  tasks:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h6v6H3zM15 14h6v6h-6zM6 10v3a3 3 0 0 0 3 3h6"/></svg>',
  results:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V5M19 20v-8M3 20h18"/></svg>',
  compute:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>',
  records:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM9 8h6M9 12h6M9 16h3"/></svg>',
};

/** One agent in the rail: its face, its name, and what it does now. `line` is HTML, already escaped. */
function member(
  kind: keyof typeof glyphs,
  state: string,
  name: string,
  line: string,
  target: string,
): string {
  return `<li><button type="button" ${target}>${avatar(kind, state)}<span class="who"><span class="name" title="${e(name)}">${e(name)}</span><span class="line">${line}</span></span></button></li>`;
}

/** The rail: the views, the team, and New. At phone width it becomes a menu. */
function renderRail(
  frame: DeskFrame,
  live: DeskSession,
  tasks: readonly TaskRecord[],
  needs: readonly Need[],
): string {
  const workers = live.workers ?? (live.session ? [live.session] : []);
  const running = workers.filter((worker) => worker.live).length;
  const shown = frame.panel === 'worker' ? live.session?.record.id : undefined;
  // Each view shows how many items for the person it holds.
  const count = (view: RailView): string => {
    const held = needs.filter((item) => item.view === view).length;
    return held
      ? `<span class="n"><span aria-hidden="true">◆ </span>${held}<span class="visually-hidden"> ${held === 1 ? 'item waits' : 'items wait'} for you</span></span>`
      : '';
  };
  const team: string[] = [];
  if (live.research?.running)
    team.push(
      member(
        'research',
        'working',
        'Research agent',
        e(live.research.step ?? 'Working'),
        'data-view="research"',
      ),
    );
  const coordinator = live.coordinator;
  if (coordinator?.state) {
    const status = coordinator.session?.record.status ?? 'starting';
    const [state, line] = coordinator.state.stoppedAt
      ? ['ended', 'Stopped']
      : planWaits(coordinator, tasks)
        ? ['you', '◆ The task plan waits for you']
        : status === 'paused' || status === 'interrupted'
          ? ['paused', 'Paused']
          : status === 'failed'
            ? ['failed', 'Failed']
            : status === 'running' || status === 'starting'
              ? ['working', 'Working']
              : ['idle', coordinatorStates[status] ?? 'Waiting for events'];
    team.push(
      member(
        'coordinator',
        state,
        'Coordinator',
        e(line),
        `data-panel="coordinator" aria-pressed="${frame.panel === 'coordinator'}"`,
      ),
    );
  }
  for (const worker of workers) {
    const { record } = worker;
    const requests = record.requests.length;
    const review = record.commands.filter(needsReview).length;
    const [label] = worker.live
      ? workerStatus(record)
      : [record.status === 'failed' ? 'Stopped with an error' : 'Ended'];
    const state = requests
      ? 'you'
      : !worker.live
        ? record.status === 'failed'
          ? 'failed'
          : 'ended'
        : record.status === 'idle'
          ? 'idle'
          : 'working';
    team.push(
      member(
        record.task ? 'task' : 'session',
        state,
        workerName(record, tasks),
        `${requests ? `◆ ${requests} ${requests === 1 ? 'request waits' : 'requests wait'} for you` : e(label)}${review ? `<span class="flag">${review} ${review === 1 ? 'command needs' : 'commands need'} review</span>` : ''}`,
        `data-worker="${e(record.id)}" aria-pressed="${record.id === shown}"`,
      ),
    );
  }
  const items = [
    live.tasks
      ? '<button type="button" data-panel="new-task">New task<small>Write a task. An agent runs it in its own copy of the project.</small></button>'
      : '',
    live.controllable
      ? '<button type="button" data-panel="new-session">New session<small>Start a Claude Code or Codex session that you control.</small></button>'
      : '',
  ].join('');
  return `<nav class="rail" id="rail" aria-label="Views and team"><ul class="views">${railViews
    .filter(
      (view) =>
        (view !== 'tasks' || live.tasks) &&
        (view !== 'compute' || live.compute),
    )
    .map(
      (view) =>
        `<li><button type="button" data-view="${view}"${view === frame.view ? ' aria-current="page"' : ''}>${viewIcons[view]}<span>${viewNames[view]}</span>${count(view)}</button></li>`,
    )
    .join('')}</ul>
  <div class="rail-team"><div class="rail-title"><h2>Team</h2>${live.controllable ? `<span class="count">${running} of ${workerLimit} workers run</span>` : ''}</div>${team.length ? `<ul class="team">${team.join('')}</ul>` : '<p class="fine">No agent works now.</p>'}</div>
  <div class="rail-foot">${items ? `<details id="new-menu" class="new-menu"><summary><span aria-hidden="true">+</span> New</summary><div class="menu">${items}</div></details>` : ''}<p class="fine">Research stays in this project.</p></div></nav>`;
}

/**
 * Home: where the project is, what waits for the person, what the team does,
 * what changed since the person left, and the one box to the coordinator.
 */
function renderHome(
  snapshot: DeskSnapshot,
  live: DeskSession,
  at: Progress,
  researching: boolean,
  needs: readonly Need[],
  left: string | undefined,
): string {
  const { workspace } = snapshot;
  const tasks = live.tasks?.list ?? [];
  const messages = live.tasks?.messages ?? [];
  let lead: string;
  if (live.research && !workspace.selectedId)
    lead = renderDecision(workspace, live, 'home');
  else if (workspace.selectedId && live.coordinator !== undefined)
    lead = renderTeamNext(live.coordinator, needs.length, tasks);
  else if (researching)
    lead =
      '<section class="card lead"><h2>Research is running</h2><p>Research runs in your terminal. The results show here when this step ends.</p><p class="fine">To stop it, press Ctrl+C in that terminal. This also closes the desk.</p></section>';
  else {
    const next = nextResearchAction(workspace);
    lead = `<section class="card lead"><h2>Continue your research</h2><p>${e(next.instruction)}</p><p class="fine">Run in your project terminal</p><div class="command"><code>${e(next.command)}</code><button id="copy-command" type="button" data-command="${e(next.command)}" aria-label="Copy next command">Copy</button></div><p class="fine">${live.controllable ? 'Opening the desk never starts a harness. To start one, choose New, then New session.' : 'The desk only reads saved work. Opening it never starts a harness.'}</p></section>`;
  }
  const coordinator = live.coordinator;
  const facts = `${left ? renderSince(left, snapshot, live, needs.length) : ''}${renderFeed(messages, tasks)}`;
  const talk =
    coordinator?.state && !coordinator.state.stoppedAt
      ? renderCoordinatorHome(coordinator, messages)
      : '';
  return `<div class="masthead"><h1 id="view-title" tabindex="-1">Home</h1>${workspace.research?.topic ? `<p class="question">${e(workspace.research.topic)}</p>` : ''}${renderArc(at)}</div>
  <div class="view">${needs.length ? `<section class="card needs" aria-labelledby="needs-title"><h2 id="needs-title">Needs you</h2>${renderNeedList(needs)}</section>` : ''}${lead}${renderTeamNow(tasks, live.workers ?? (live.session ? [live.session] : []))}${renderPodsLine(live.compute)}${facts && talk ? `<div class="home-grid"><div class="col">${facts}</div><div class="col">${talk}</div></div>` : `${talk}${facts}`}${renderPaused(live)}</div>`;
}

/** The side panel for one item, or a form for a new one, or why the item is gone. */
function renderPanel(
  panel: DeskPanel,
  workspace: Workspace,
  live: DeskSession,
  chosen: DeskAttempt | undefined,
  report: ResearchReport | null,
  needKeys: ReadonlySet<string>,
  messages: readonly Message[],
  direction: string | undefined,
): string {
  const tasks = live.tasks?.list ?? [];
  const gone = (kind: string, title: string, text: string): Panel => ({
    kind,
    title,
    sub: '',
    body: `<p class="empty-note">${text}</p>`,
  });
  let shown: Panel;
  if (panel === 'task')
    shown =
      live.tasks?.selected && live.tasks
        ? taskPanel(
            live.tasks.selected,
            live.tasks,
            live,
            workspace.host,
            needKeys,
          )
        : gone('Task', 'No task', 'This task is not in the list.');
  else if (panel === 'worker')
    shown = live.session
      ? workerPanel(live.session, live, tasks)
      : gone(
          'Agent',
          'No session',
          'No agent session is open. To start one, choose New, then New session.',
        );
  else if (panel === 'direction') {
    const idea =
      workspace.candidates.find((entry) => entry.id === direction) ??
      workspace.candidates[0];
    shown = idea
      ? directionPanel(idea, workspace, live)
      : gone(
          'Direction',
          'No direction yet',
          'Research proposes directions after it searches the sources.',
        );
  } else if (panel === 'coordinator')
    shown = coordinatorPanel(
      live.coordinator ?? null,
      workspace,
      workspace.host,
      tasks,
      messages,
    );
  else if (panel === 'attempt')
    shown = chosen
      ? attemptPanel(chosen, workspace, live, report)
      : gone(
          'Research attempt',
          'No attempts yet',
          'Each research request shows here with its own identity.',
        );
  else if (panel === 'new-task')
    shown = {
      kind: '',
      title: 'New task',
      sub: '',
      body: live.tasks
        ? `<div id="task-new">${taskForm('task-new', null, live.tasks.list, workspace.host)}<div class="actions"><button type="button" class="primary" data-action="task-create">Create task</button></div></div>`
        : '<p class="empty-note">This desk only reads saved work. Run verifold in the project directory to create tasks.</p>',
    };
  else
    shown = {
      kind: '',
      title: 'New session',
      sub: '',
      body: startForm(live, workspace.host),
    };
  return `<aside class="panel" id="panel" aria-labelledby="panel-title"><div class="panel-head"><div class="titles">${shown.kind ? `<p class="kind">${e(shown.kind)}</p>` : ''}<h2 id="panel-title" tabindex="-1">${e(shown.title)}</h2>${shown.sub ? `<p class="panel-sub">${shown.sub}</p>` : ''}</div><button type="button" class="icon-button" data-close-panel aria-label="Close the panel">✕</button></div><div class="panel-body" id="panel-body">${shown.body}</div></aside>`;
}

/**
 * The desk: the rail, the view that the person opened, and the panel.
 * All research text is escaped. Source links are validated before rendering.
 */
export function renderDesk(
  snapshot: DeskSnapshot,
  selected: string | undefined,
  report: ResearchReport | null,
  live: DeskSession = { session: null, controllable: false },
  frame: DeskFrame = { view: 'home', panel: null },
): {
  html: string;
  observation: string;
  title: string;
  stage: string;
  /** What waits for the person. The page counts it in the tab title and notifies about new keys. */
  needs: { key: string; title: string }[];
} {
  const { workspace, attempts } = snapshot;
  const active = attempts.filter((attempt) => attempt.activity === 'recent');
  const chosen =
    attempts.find(
      (attempt) =>
        attempt.id === (selected ?? workspace.research?.latestAttempt),
    ) ?? attempts[0];
  const tasks = live.tasks?.list ?? [];
  const messages = live.tasks?.messages ?? [];
  const workers = live.workers ?? (live.session ? [live.session] : []);
  const at = progress(workspace, live);
  // Without a project owner there are no tasks and no compute, so these views are not in the rail.
  const view =
    (frame.view === 'tasks' && !live.tasks) ||
    (frame.view === 'compute' && !live.compute)
      ? 'home'
      : frame.view;
  const needs = needsOf(snapshot, live);
  const main =
    view === 'needs'
      ? renderNeedsView(needs)
      : view === 'results'
        ? renderResultsView(workspace, live)
        : view === 'compute' && live.compute
          ? renderComputeView(live.compute)
          : view === 'research'
            ? renderResearchView(
                workspace,
                live,
                report,
                chosen,
                frame.panel === 'direction' ? frame.direction : undefined,
              )
            : view === 'tasks' && live.tasks
              ? renderTasksView(
                  live.tasks,
                  live,
                  workspace.candidates.find(
                    (idea) => idea.id === workspace.selectedId,
                  )?.title ??
                    live.coordinator?.state?.objective ??
                    'Your tasks',
                  frame.panel === 'task' ? live.tasks.selected?.id : undefined,
                  // Before a direction and a coordinator, Tasks offers to start one with your own objective.
                  live.coordinator !== undefined &&
                    !workspace.selectedId &&
                    !live.coordinator?.state,
                  needs,
                )
              : view === 'records'
                ? renderRecords(
                    snapshot,
                    workers,
                    tasks,
                    frame.panel === 'attempt' ? chosen?.id : undefined,
                  )
                : renderHome(
                    snapshot,
                    live,
                    at,
                    active.length > 0,
                    needs,
                    frame.since,
                  );
  // The top bar names the research owner only when exactly one reported recently.
  const observation =
    active.length === 1 && active[0]?.record?.observedAt
      ? `Research owner last observed ${time(active[0].record.observedAt)}`
      : '';
  const html = `${renderRail({ view, panel: frame.panel }, live, tasks, needs)}<main id="view" tabindex="-1">${main}</main>${frame.panel ? renderPanel(frame.panel, workspace, live, chosen, report, new Set(needs.map((item) => item.key)), messages, frame.direction) : ''}`;
  return {
    html,
    observation,
    title: snapshot.project,
    stage: stageText(at),
    needs: needs.map(({ key, title }) => ({ key, title })),
  };
}

const setupSteps = [
  'Connect',
  'Profile',
  'Project',
  'Interview',
  'Research mode',
] as const;

const setupLabels: Record<SetupView['lines'][number]['source'], string> = {
  verifold: 'Verifold',
  agent: 'Your harness',
  tool: 'Verifold saw',
  you: 'You',
};

/** The open setup question, with one primary action. */
function renderSetupPrompt(prompt: SetupPrompt): string {
  const answer = (value: string): string =>
    `data-action="setup" data-prompt="${prompt.id}" data-value="${e(value)}"`;
  if (prompt.kind === 'choice')
    return `<section class="setup-prompt" aria-labelledby="setup-question"><h2 id="setup-question">${e(prompt.question)}</h2><div class="choices">${prompt.choices
      .map(
        (choice) =>
          `<button type="button" class="choice${choice.value === prompt.initial ? ' default' : ''}" ${answer(choice.value)}><span class="choice-label">${e(choice.label)}${choice.value === prompt.initial ? ' <span class="fine">Default</span>' : ''}</span><span class="choice-description">${e(choice.description)}</span></button>`,
      )
      .join('')}</div></section>`;
  if (prompt.kind === 'review')
    return `<section class="setup-prompt review" aria-labelledby="setup-question"><h2 id="setup-question">Review the brief</h2><div class="prose md">${markdownHtml(prompt.brief)}</div><div class="actions"><button type="button" class="primary" data-action="setup" data-prompt="${prompt.id}" data-review="accept">Accept the brief</button></div><label class="field" for="setup-feedback">${prompt.final ? 'A final note for the brief' : 'Changes for your harness'}</label><textarea id="setup-feedback" rows="3" maxlength="4000"></textarea><div class="actions"><button type="button" data-action="setup" data-prompt="${prompt.id}" data-review="feedback">${prompt.final ? 'Add the note and accept' : 'Ask for changes'}</button></div><details id="setup-edit"><summary>Edit the brief yourself</summary><textarea id="setup-edited" rows="16" maxlength="11000">${e(prompt.brief)}</textarea><div class="actions"><button type="button" data-action="setup" data-prompt="${prompt.id}" data-review="edit">Accept my version</button></div></details><div class="actions"><button type="button" class="quiet" data-action="setup" data-prompt="${prompt.id}" data-review="cancel">Cancel setup</button></div></section>`;
  const { hint } = prompt;
  if (hint?.kind === 'confirm')
    return `<section class="setup-prompt"><div class="md">${markdownHtml(prompt.question)}</div><div class="actions"><button type="button" class="primary" ${answer('y')}>${e(hint.yes)}</button><button type="button" ${answer('n')}>${e(hint.no)}</button></div></section>`;
  const field = hint?.multiline
    ? `<textarea id="setup-answer" rows="4" maxlength="100000" aria-labelledby="setup-question"${hint.placeholder ? ` placeholder="${e(hint.placeholder)}"` : ''}></textarea>`
    : `<input id="setup-answer" type="text" maxlength="4000" aria-labelledby="setup-question"${hint?.placeholder ? ` placeholder="${e(hint.placeholder)}"` : ''}>`;
  return `<section class="setup-prompt"><div class="md" id="setup-question">${markdownHtml(prompt.question)}</div>${field}<div class="actions"><button type="button" class="primary" data-action="setup" data-prompt="${prompt.id}" data-field="setup-answer">Continue</button>${(
    hint?.actions ?? []
  )
    .map(
      (action) =>
        `<button type="button" ${answer(action.value)}>${e(action.label)}</button>`,
    )
    .join('')}</div></section>`;
}

/** Project setup in the desk, before the project exists. Harness and model text is escaped or sanitized Markdown. */
export function renderSetup(view: SetupView | null): {
  html: string;
  observation: string;
  title: string;
  stage: string;
} {
  const page = (body: string): string =>
    `<main id="view" class="solo" tabindex="-1">${body}</main>`;
  if (!view)
    return {
      html: page(
        '<div class="empty"><h1>Setting up</h1><p>Verifold is starting setup.</p></div>',
      ),
      observation: '',
      title: 'New project',
      stage: 'Setup',
    };
  const current = view.step ? setupSteps.indexOf(view.step) : -1;
  const html =
    page(`<div class="setup"><h1 id="view-title" tabindex="-1">Set up a project</h1>
  <ol class="setup-steps" aria-label="Setup steps">${setupSteps
    .map(
      (name, index) =>
        `<li data-state="${index < current ? 'done' : index === current ? 'current' : 'next'}"${index === current ? ' aria-current="step"' : ''}>${e(name)}</li>`,
    )
    .join('')}</ol>
  ${detailSwitch}<ol class="setup-lines">${view.lines
    .slice(-60)
    .map(
      (line) =>
        `<li class="event setup-${line.source}"><span class="event-kind">${setupLabels[line.source]}</span>${line.source === 'tool' || line.source === 'you' ? `<span class="event-text">${e(line.text)}</span>` : `<div class="event-text md">${markdownHtml(line.text)}</div>`}<time datetime="${e(line.at)}">${e(clock(line.at))}</time></li>`,
    )
    .join('')}</ol>
  ${transcriptSlot('setup', 'Harness transcript')}
  ${view.busy ? `<p class="setup-busy" role="status">${e(view.busy.label)}, for ${e(elapsed(view.busy.startedAt))}</p>` : ''}
  ${view.prompt ? renderSetupPrompt(view.prompt) : ''}
  ${view.outcome === 'done' ? '<p class="notice">Setup is complete. The project desk opens here.</p>' : ''}
  ${view.outcome === 'stopped' ? `<p class="notice">${e(view.error ?? 'Setup stopped.')}</p><p class="fine">Run verifold again in your terminal to start over.</p>` : ''}</div>`);
  return {
    html,
    observation: view.step ? `Setup step: ${view.step}` : '',
    title: 'New project',
    stage: view.step ? `Setup: ${view.step.toLowerCase()}` : 'Setup',
  };
}
