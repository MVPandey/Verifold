import { escapeHtml as e } from '../ui/dom.ts';
import { markdownHtml } from './markdown.ts';
import type { Candidate, Workspace } from './contracts.ts';
import type { DeskSnapshot, DeskAttempt } from './desk-records.ts';
import type { ResearchReport } from './research.ts';
import type { ResearchSource, ResearchView } from './research-runner.ts';
import { object } from './research-contracts.ts';
import type { SetupPrompt, SetupView } from './setup-bridge.ts';
import {
  forPerson,
  isDraft,
  isQuestion,
  replaced,
  type TaskAttempt,
  type TaskRecord,
  type TaskVersion,
} from './tasks.ts';
import type { Message } from './messages.ts';
import type { CheckResult, Results } from './results.ts';
import type { ComputeView } from './compute.ts';
import type { ArchivedRun } from './archive.ts';
import { placeNames } from './credentials.ts';
import {
  asker,
  diskRate,
  isOpen,
  isRunning,
  maxCost,
  spent,
  usd,
  type Lease,
} from './leases.ts';
import { agentId, proofRef, runId } from './board.ts';
import {
  coordinatorLimits,
  directionObjective,
  type CoordinatorAction,
  type CoordinatorView,
} from './coordinator.ts';
import { defaultAgents } from './workers.ts';
import type { BringList, LabView } from './lab.ts';
import { labWorks } from './team.ts';
import {
  answerPanel,
  bringPanel,
  diffPanel,
  stateOf,
  labCallNeeds,
  minutesText,
  renderLab,
  renderLabStart,
  renderLabWork,
  runPanel,
  searchPanel,
  type Away,
  type LabDiff,
  type LabWork,
  type Panel,
} from './desk-lab.ts';
import { scratch } from './workspaces.ts';
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
  /** As many agents run as "Agents at once" allows. */
  readonly full?: boolean;
  /** "Agents at once" of this project. */
  readonly agents?: number;
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
  /** The runs that Start over moved to the archive, newest first. Only a project owner has them. */
  readonly archives?: readonly ArchivedRun[];
  /** The lab of a project owner. Null: the project has none yet. */
  readonly lab?: LabView | null;
  /** The lab actions that run in the background, and the ones that failed there. */
  readonly labWorks?: readonly LabWork[];
  /** The person can start a lab on this run now: the run's guard allows it, and this desk runs the lab. */
  readonly labCanStart?: boolean;
  /** The session of the lab agent or checker that the agent panel shows. */
  readonly labAgent?: SessionView | null;
  /** What the direction of the diff panel changed. */
  readonly labDiff?: LabDiff | null;
  /** The files that the bring-in panel's direction can bring in, once Verifold took its commit. */
  readonly labBring?: BringList | null;
  /** The person came back to the lab after a while: Home lists what changed. */
  readonly labAway?: Away | null;
}

export interface TaskView {
  readonly list: readonly TaskRecord[];
  /** The task that the page shows. */
  readonly selected: TaskRecord | null;
  /** Live sessions that wait for a follow-up. */
  readonly idle: readonly string[];
  /** Task sessions that paused when Verifold stopped. The next turn resumes them. */
  readonly resumable?: readonly string[];
  /** The latest messages, oldest first. */
  readonly messages?: readonly Message[];
}

/** The views of the desk. The rail lists them in this order, except Needs you, which the top bar opens. */
export const deskViews = [
  'home',
  'research',
  'tasks',
  'task',
  'results',
  'compute',
  'records',
  'needs',
] as const;
export type DeskView = (typeof deskViews)[number];

/** What the side panel shows: one item, or the form for a new one. */
export const deskPanels = [
  'worker',
  'attempt',
  'direction',
  'coordinator',
  'new-task',
  // A lab's depth: a run, a direction's diff, an agent, and its search.
  'run',
  'diff',
  'agent',
  'search',
  // A lab's answer, and a bring-in of a direction's files.
  'answer',
  'bring',
] as const;
export type DeskPanel = (typeof deskPanels)[number];

/** The view and the panel that the person opened. The page keeps them, not the project. */
export interface DeskFrame {
  readonly view: DeskView;
  readonly panel: DeskPanel | null;
  /** When the page went to the background for a while. Home lists what changed after it. */
  readonly since?: string;
  /** The direction that the direction panel or a lab's diff panel shows. */
  readonly direction?: string;
  /** The run of a lab's run panel, such as r-3. */
  readonly run?: string;
  /** The diff that a post cites, which a lab's diff panel shows, by its place, such as p-12.0. */
  readonly proof?: string;
  /** The agent or checker of a lab's agent panel, such as a-2. */
  readonly agent?: string;
  /** The person cleared finished tasks: done and cancelled tasks leave the map and the rail. */
  readonly hideFinished?: boolean;
  /** The words of a lab's search panel. */
  readonly q?: string;
}

/** The frame from the query of /api/view, or null when a value is unknown. No view means Home. */
export function parseFrame(
  view: string | null,
  panel: string | null,
  since: string | null = null,
  direction: string | null = null,
  finished: string | null = null,
  run: string | null = null,
  agent: string | null = null,
  proof: string | null = null,
  q: string | null = null,
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
  // A search has at most 100 printable characters.
  const words = q === null || ([...q].length <= 100 && !/\p{Cc}/u.test(q));
  return shown &&
    (panel === null || opened) &&
    (since === null || time) &&
    idea &&
    (finished === null || finished === 'hidden') &&
    (run === null || runId.test(run)) &&
    (agent === null || agentId.test(agent)) &&
    (proof === null || proofRef(proof) !== null) &&
    words
    ? {
        view: shown,
        panel: opened,
        ...(since ? { since } : {}),
        ...(direction ? { direction } : {}),
        ...(finished ? { hideFinished: true } : {}),
        ...(run ? { run } : {}),
        ...(agent ? { agent } : {}),
        ...(proof ? { proof } : {}),
        ...(q ? { q } : {}),
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
      return 'Planning research';
    case 'awaiting-plan-review':
      return 'Plan waits for you';
    case 'needs-research':
      return 'Searching sources';
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
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Stopped, result unknown';
    default:
      return 'Result unknown';
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

/** A clock time. Another day than today adds its weekday within a week, or its date. */
function clock(value: string): string {
  const date = new Date(value);
  const hours = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (date.toDateString() === new Date().toDateString()) return hours;
  const day =
    Math.abs(Date.now() - date.getTime()) < 6 * 86_400_000
      ? date.toLocaleDateString('en-GB', { weekday: 'short' })
      : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${day} ${hours}`;
}

function elapsed(since: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(since).getTime()) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/** The time since a moment, in whole minutes or hours and minutes. */
function duration(since: string): string {
  return minutesText(
    Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000)),
  );
}

/** The first sentence of a text, or its start, as a lead of at most `max` characters. */
function lead(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // A first sentence of up to three words, such as "Bottom line.", is a label. The lead takes the sentence after it too.
  const sentence =
    /^(?:[^\s.!?]+(?: [^\s.!?]+){0,2}[.!?] )?.+?[.!?](?=\s|$)/.exec(
      flat,
    )?.[0] ?? flat;
  if (sentence.length <= max) return sentence;
  return `${flat.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/** Markdown as plain text, for a lead. The full text renders as Markdown. */
function plain(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      // An underscore inside a word, as in HF_TOKEN, is text, not emphasis.
      .replace(/[*`~|]|(?<!\w)_+|_+(?!\w)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
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

/** Text in full up to a few lines, so a short message or reply reads at once. Longer text folds. */
function inFull(id: string, text: string): string {
  return text.length <= 600
    ? `<p class="pre">${e(text)}</p>`
    : more(id, text, 200);
}

/** Markdown in full up to a few lines, like inFull. Longer Markdown folds. */
function inFullMd(id: string, markdown: string): string {
  return markdown.length <= 600
    ? `<div class="md">${markdownHtml(markdown)}</div>`
    : moreMd(id, markdown, 200);
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
  '<p class="fine detail-only">Everything the agent reported: its messages, its tool calls with their input and output, and the steps of its helpers. It stays in this project.</p>';

/** The research step of this owner. Summary is the default level of detail. */
function renderResearch(
  view: ResearchView | undefined,
  attempt: string | undefined,
): string {
  if (!view?.step) return '';
  // A stopped agent has no current step, so its last one shows as past.
  const now = view.running ? researchNow(view.events) : '';
  return `<section class="card research-live" aria-labelledby="research-live-title"><div class="section-title"><h2 id="research-live-title">Research agent</h2><span class="status ${view.running ? 'active' : 'muted'}">${view.running ? 'Running' : 'Not running'}</span></div>
  <p class="research-step">${view.running ? `${e(view.step)}${view.startedAt ? `, for ${e(elapsed(view.startedAt))}` : ''}` : `Last step: ${e(view.step)}`}</p>
  ${detailSwitch}
  ${now ? `<p class="research-summary summary-only">Now: ${e(now)}.</p>` : ''}
  ${attempt ? `${transcriptSlot(`attempt:${attempt}`, 'Research transcript')}${transcriptNote}` : ''}
  ${view.running ? '<p class="fine">If you cancel, Verifold keeps what this step saved.</p><div class="actions"><button type="button" data-action="cancel-research">Cancel research</button></div>' : ''}</section>`;
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
  // A lab run has no research steps.
  if (!research || workspace.selectedId || live.lab) return '';
  const home = place === 'home';
  if (research.running)
    return home
      ? `<section class="card lead"><h2>Research is running</h2><p>${e(research.step ? `${research.step}.` : 'A research step runs.')} Follow it in Plan.</p><p class="fine">If you cancel, Verifold keeps what this step saved.</p><div class="actions"><button type="button" class="primary" data-view="research">Follow the research</button><button type="button" data-action="cancel-research">Cancel research</button></div></section>`
      : '';
  const phase = workspace.research?.phase;
  if (phase === undefined)
    return `<section class="card lead"><h2>Start research</h2><p>Write the question that research should explore. The harness plans the research first.</p><label class="field" for="research-topic">Question</label><textarea id="research-topic" rows="3" maxlength="4000"></textarea><label class="check" for="research-guided"><input type="checkbox" id="research-guided" checked> Stop at the plan for my approval</label><div class="actions"><button type="button" class="primary" data-action="research" data-research="start">Start research</button></div></section>`;
  if (home) return '';
  switch (phase) {
    case 'awaiting-plan-review':
      return `<section class="card needs"><h2>Review the plan</h2><p>Read the plan below. Approve it to start the source search. To change it, write to research in the message box.</p><div class="actions"><button type="button" class="primary" data-action="research" data-research="approve">Approve the plan</button></div></section>`;
    case 'directions':
      return `<section class="card needs"><h2>Choose a direction</h2><p>Choose one of the directions below. The coordinator then drafts the plan for it. To change the directions first, write to research in the message box.</p></section>`;
    default:
      return `<section class="card needs"><h2>Continue research</h2><p>Research stopped before this step ended. Continue it from the saved point.</p><div class="actions"><button type="button" class="primary" data-action="research" data-research="continue">Continue research</button></div></section>`;
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

/** Verifold's own tools that a plain name does not explain. */
const toolNames: Record<string, string> = {
  verifold_pod_run: 'Pod command',
  verifold_pod_job: 'Pod job check',
};

/** A harness tool name for the person: "mcp__verifold__verifold_pod_copy" is "Pod copy". */
function toolName(tool: string): string {
  const bare = tool.replace(/^mcp__\w+?__/, '');
  if (!bare.startsWith('verifold_')) return bare;
  const words = bare.slice('verifold_'.length).replace(/_/g, ' ');
  return toolNames[bare] ?? `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A tool event, "tool: input", with the tool name for the person. */
function toolEvent(text: string): string {
  const split = text.indexOf(': ');
  return split < 0
    ? toolName(text)
    : `${toolName(text.slice(0, split))}${text.slice(split)}`;
}

/** Events in order, with each run of the same tool call as one entry: the latest, its index, and the count. */
function repeats(
  events: readonly SessionEvent[],
): { item: SessionEvent; index: number; count: number }[] {
  const out: { item: SessionEvent; index: number; count: number }[] = [];
  events.forEach((event, index) => {
    const last = out.at(-1);
    if (
      last?.item.kind === 'tool' &&
      event.kind === 'tool' &&
      last.item.text === event.text
    )
      out[out.length - 1] = { item: event, index, count: last.count + 1 };
    else out.push({ item: event, index, count: 1 });
  });
  return out;
}

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
  idle: ['Waits for your next message', 'muted'],
  ended: ['Ended', 'muted'],
  failed: ['Stopped with an error', 'failed'],
};

const paneSwitch =
  '<div class="seg pane-switch" role="group" aria-label="Agent view"><button type="button" data-pane="summary">Summary</button><button type="button" data-pane="details">Details</button><button type="button" data-pane="terminal">Terminal</button><button type="button" data-pane="commands">Commands</button></div>';

/** A lab agent or checker in the agent panel. `terminal`: its direction is open, so the person can take its terminal. */
interface LabAgentPane {
  readonly agent: string;
  readonly handle: string;
  readonly about: string;
  readonly checker: boolean;
  readonly terminal: boolean;
  /** This desk only shows the lab. */
  readonly readOnly: boolean;
}

/**
 * The worker's own terminal. While the person holds it, a framed terminal page
 * fills the slot. Otherwise the pane says what opening it does, or why it cannot open.
 * A lab agent's terminal opens through the lab, which gives it no turn meanwhile.
 */
function renderTerminal(
  view: SessionView,
  live: DeskSession,
  lab?: LabAgentPane,
): string {
  const { record } = view;
  const name = hostName(record.host);
  if (typeof live.terminals === 'string')
    return `<p class="notice">${e(live.terminals)}</p>`;
  if (lab && !lab.terminal && record.status !== 'terminal')
    return `<p class="fine">${lab.checker ? 'A checker has no terminal here: it works without the author.' : lab.readOnly ? 'This desk runs one session, so it opens no lab terminal. Run verifold in the project folder.' : 'Its direction ended, so its terminal does not open here.'}</p>`;
  if (lab && record.status !== 'terminal') {
    if (!view.live)
      return '<p class="fine">The agent has no process now. Its terminal opens between its turns, while its process runs.</p>';
    const busy =
      record.status === 'idle'
        ? ''
        : 'Open the terminal between turns. Wait for its turn to end.';
    return `<p class="fine">${record.host === 'claude' ? "Verifold stops its Claude Code process and opens Claude Code in a terminal on this conversation, with the lab's limits. While you work there, Verifold records no tool calls." : "Codex opens in a terminal for this session, with the lab's limits. Codex keeps reporting its events while you type."} The agent gets no turn while you hold it. When you return, its next turn follows.</p>${busy ? `<p class="notice" id="terminal-off">${busy}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="lab-terminal-open" data-agent="${e(lab.agent)}"${busy ? ' disabled aria-describedby="terminal-off"' : ''}>Open the terminal</button></div>`;
  }
  if (record.status === 'terminal')
    return `<p class="fine">${record.host === 'claude' ? 'You work in the Claude Code terminal. Verifold records no tool calls until you return.' : 'You work in the Codex terminal. Codex keeps reporting its events to Verifold.'}</p><div class="terminal-slot" data-session="${e(record.id)}" data-label="${e(name)} terminal"></div><div class="actions"><button type="button" class="primary" data-action="terminal-return" data-session="${e(record.id)}">Return to Verifold</button><button type="button" data-terminal-tab="${e(record.id)}">Open in new tab</button></div>`;
  if (!view.live)
    return '<p class="fine">The session ended. Start or resume a session to open its terminal.</p>';
  const off =
    record.status === 'idle'
      ? ''
      : 'Open the terminal between turns. Wait for the turn to end, or cancel it.';
  return `<p class="fine">${record.host === 'claude' ? `Verifold stops its Claude Code process and opens Claude Code in a terminal on this conversation${record.mode === 'strict' ? ', with the task limits' : ''}. While you work there, Verifold records no tool calls.` : `Codex opens in a terminal for this session${record.mode === 'strict' ? ', with the task limits' : ''}. Codex keeps reporting its events while you type.`}${record.task ? ' When you return, Verifold saves the task folder as a version.' : ' Return to Verifold to continue here.'}</p>${off ? `<p class="notice" id="terminal-off">${off}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="terminal-open" data-session="${e(record.id)}"${off ? ' disabled aria-describedby="terminal-off"' : ''}>Open the terminal</button></div>`;
}

/** The status of a live worker. A task worker that waits has a version to review. */
function workerStatus(record: SessionView['record']): [string, string] {
  if (record.task && record.status === 'idle') return ['In review', 'active'];
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
  return `<article class="request" aria-label="Request ${e(request.id)}"><p class="request-type"><span class="mark you" aria-hidden="true"></span>${e(workerName(record, tasks))} asks to use ${e(toolName(request.tool))}<span class="ref">${e(request.id)}</span></p>${requestBody(request)}</article>`;
}

/**
 * A lab agent or a checker in the panel: the worker panel of its session,
 * with the lab's terminal and a Message button that writes on the board.
 */
function labAgentPanel(
  lab: LabView,
  id: string | undefined,
  live: DeskSession,
  tasks: readonly TaskRecord[],
): Panel {
  const entry = lab.directions.find((item) => item.agent.id === id);
  const check = lab.checks.find((item) => item.agent === id);
  const handle = entry?.agent.handle ?? check?.handle;
  if (!id || !handle)
    return {
      kind: 'Agent',
      title: 'No such agent',
      sub: '',
      body: '<p class="empty-note">This agent is not in the lab, for example after Start over.</p>',
    };
  const pane: LabAgentPane = {
    agent: id,
    handle,
    about: entry
      ? entry.direction.title
      : `Checks ${check?.claim ?? ''} without the author's reasoning`,
    checker: !entry,
    terminal: lab.runs && entry?.direction.state === 'open',
    readOnly: !lab.runs,
  };
  return live.labAgent
    ? workerPanel(live.labAgent, live, tasks, pane)
    : {
        kind: pane.checker ? 'Checker' : 'Lab agent',
        title: handle,
        sub: `<span class="fine">${e(pane.about)}</span>`,
        body: '<p class="empty-note">It has no session yet. What it does shows here once it starts.</p>',
      };
}

/** One worker in full: its requests, its events, its transcript and terminal, and its controls. All harness text is escaped. */
function workerPanel(
  view: SessionView,
  live: DeskSession,
  tasks: readonly TaskRecord[],
  lab?: LabAgentPane,
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
  <div class="session-events pane-summary"><ol>${repeats(
    record.events.slice(-60),
  )
    .map(({ item: event, index, count }) => {
      // The position in the whole record stays the same as events arrive, so an open one stays open.
      const id = `event-${record.id}-${record.events.length - Math.min(60, record.events.length) + index}`;
      // A task agent gets each turn from Verifold, with the messages of the person and the coordinator in it.
      const label =
        event.kind === 'you' && record.task
          ? 'Verifold sent'
          : eventLabels[event.kind];
      const text =
        event.kind === 'tool'
          ? toolEvent(event.text)
          : event.kind === 'agent'
            ? event.text
            : named(event.text, tasks, live.tasks?.messages);
      return `<li class="event event-${e(event.kind)}"><span class="event-kind">${e(label)}</span><div class="event-text">${event.kind === 'agent' ? moreMd(id, text, 200) : more(id, text, 200)}${count > 1 ? `<span class="fine">${count} times</span>` : ''}</div><time datetime="${e(event.at)}">${e(clock(event.at))}</time></li>`;
    })
    .join('')}</ol></div>
  ${transcriptSlot(`session:${record.id}`, `${hostName(record.host)} transcript`, 'pane-details')}
  <div class="pane-terminal">${renderTerminal(view, live, lab)}</div>
  <div class="pane-commands">${record.commands.length ? auditTable([view], tasks, false) : '<p class="empty-note">This agent has run no commands yet.</p>'}</div>
  ${
    lab
      ? lab.terminal
        ? `<div class="actions"><button type="button" class="primary" data-lab-mention="@${e(lab.handle)}">Message</button></div><p class="fine">Your message goes on the board and wakes ${e(lab.handle)}.</p>`
        : ''
      : record.task
        ? `<p class="fine">It works in the folder of its task, in Strict mode.</p><div class="actions"><button type="button" data-task-select="${e(record.task.id)}">Open the task</button></div>`
        : running && record.status !== 'terminal'
          ? `<div class="actions"><button type="button" class="primary" data-message-to="session:${e(record.id)}">Write to it</button>${record.status === 'idle' ? '' : `<button type="button" data-action="cancel" data-session="${e(record.id)}">Cancel this turn</button>`}<button type="button" data-action="end" data-session="${e(record.id)}">End session</button></div><p class="fine">Your message reaches it during its turn, or starts its next turn.</p>`
          : ''
  }
  ${!running && record.nativeSessionId ? `<p class="fine">Native session: ${e(record.nativeSessionId)}. The record is in .verifold/sessions/${e(record.id)}.json.</p>` : ''}`;
  return {
    kind: lab
      ? lab.checker
        ? 'Checker'
        : 'Lab agent'
      : record.task
        ? 'Task agent'
        : 'Session',
    title: lab ? lab.handle : workerName(record, tasks),
    sub: `<span class="status ${tone}">${e(label)}</span>${lab ? ` <span class="fine">${e(lab.about)}</span>` : ''}`,
    body,
  };
}

/** Sessions that an earlier owner left open. Home offers Resume for each. */
function renderPaused(live: DeskSession): string {
  const paused = live.paused ?? [];
  if (!live.controllable || live.full || !paused.length) return '';
  return `<section class="card" aria-labelledby="paused-title"><h2 id="paused-title">${paused.some((entry) => entry.status === 'interrupted') ? 'Paused and interrupted sessions' : 'Paused sessions'}</h2><p class="fine">These sessions were open when Verifold stopped. Resume one to continue its conversation.</p><ul class="paused-list">${paused
    .slice(0, 10)
    .map(
      (entry) =>
        `<li><span class="paused-meta"><span>${e(hostName(entry.host))}</span><span>${e(time(entry.startedAt))}</span><span>${entry.status === 'interrupted' ? 'Stopped, result unknown' : 'Paused'}</span></span><span class="paused-request">${e(entry.request.length > 160 ? `${entry.request.slice(0, 160)}…` : entry.request)}</span><span class="actions"><button type="button" data-action="${entry.restart ? 'restart' : 'resume'}" data-session="${e(entry.id)}">${entry.restart ? 'Start again' : 'Resume'}</button></span></li>`,
    )
    .join('')}</ul></section>`;
}

const taskStates: Record<TaskRecord['state'], [string, string]> = {
  open: ['Not started', 'muted'],
  claimed: ['Starting', 'active'],
  running: ['Working', 'active'],
  review: ['In review', 'active'],
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

/** The face of a task in the rail when no live worker holds it. */
const taskFaces: Record<TaskRecord['state'], string> = {
  open: 'idle',
  claimed: 'working',
  running: 'working',
  review: 'idle',
  done: 'ended',
  cancelled: 'ended',
};

/** The heading of a version review after "Version N", by how its turn ended. */
const turnHeadings: Record<TaskVersion['turn'], string> = {
  completed: 'is ready for review',
  interrupted: 'came from a turn that you stopped',
  failed: 'came from a turn that failed',
  exited: 'came from a turn whose harness process exited',
  'time-limit': 'came from a turn that reached its time limit',
  stopped: 'came from a turn that Verifold stopped',
  terminal: 'came from your work in the terminal',
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
  ${field('output', 'What it should produce', area('output', 2, 2000, values?.output))}
  ${field('writable', 'Where it may write, one path per line', area('writable', 2, 4000, values?.writable.join('\n')))}
  <details id="${prefix}-more" class="more-fields"><summary>Input files, network, harness, and what it waits for</summary>
  ${field('inputs', 'Files that it gets, one path per line. Verifold copies them when you save.', area('inputs', 2, 4000, values?.inputs.map((input) => input.path).join('\n')))}
  ${field('network', 'Websites its commands may reach, one per line. Leave this empty for no network.', area('network', 2, 2000, values?.network?.domains.join('\n')))}
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
  }</details>`;
}

/** The latest version of a task in review: file list, one diff, and the decision. */
/** The decision on a version in review: what the agent says, then Accept, Ask for changes, and Reject. */
function reviewDecision(
  task: TaskRecord,
  version: TaskVersion,
  canChange: boolean,
  stale: string | undefined,
  why: string,
): string {
  const selectable = stale
    ? []
    : version.files.filter(
        (file) => file.inScope && file.regular && !scratch(file.path),
      );
  const scratchFiles = version.files.filter(
    (file) => file.inScope && file.regular && scratch(file.path),
  ).length;
  const outside = version.files.length - selectable.length - scratchFiles;
  // Accept counts fewer files than changed. Say which ones it leaves out.
  const leftOut =
    stale || selectable.length === version.files.length
      ? ''
      : `<p class="fine">Not ticked: ${[
          scratchFiles
            ? `${scratchFiles} scratch ${scratchFiles === 1 ? 'file' : 'files'}`
            : '',
          outside
            ? `${outside} ${outside === 1 ? 'file' : 'files'} that Accept cannot copy`
            : '',
        ]
          .filter(Boolean)
          .join(' and ')}. The file list shows them.</p>`;
  return `<section class="card decision" aria-labelledby="review-title"><div class="section-title"><h2 id="review-title" tabindex="-1">Version ${version.number} ${e(turnHeadings[version.turn])}</h2><span class="count">${e(since(version.at))}</span></div>
  ${version.note ? `<p class="notice">${e(version.note)}</p>` : ''}
  ${stale ? `<p class="notice">${e(stale)}</p>` : ''}
  ${version.conflicts?.length ? `<p class="notice">These files changed in your project after the task started, so Verifold copied nothing: ${e(version.conflicts.join(', '))}. Ask for changes, or reject the version.</p>` : ''}
  ${version.skipped.length ? `<p class="notice">These files are larger than 50 MB and are not in the version: ${e(version.skipped.join(', '))}.</p>` : ''}
  <p class="fine">${e(why)}</p>
  ${version.reply ? `<div class="agent-says"><p class="msg-meta"><strong>The agent says</strong></p>${inFullMd(`reply-${task.id}-${version.number}`, version.reply)}</div>` : '<p class="empty-note">The agent ended its turn without a reply.</p>'}
  ${version.files.length ? '' : '<p class="empty-note">This version changed no files.</p>'}
  <div class="actions"><button type="button" class="primary" data-action="task-accept" data-task="${e(task.id)}" data-version="${version.number}"${selectable.length ? '' : ' disabled'}>Accept ${selectable.length} ${selectable.length === 1 ? 'file' : 'files'}</button><button type="button" data-message-to="${e(task.id)}"${canChange ? '' : ' disabled aria-describedby="task-changes-off"'}>Ask for changes</button><button type="button" data-action="task-reject" data-task="${e(task.id)}" data-version="${version.number}" data-confirm="Click again to reject version ${version.number}">Reject</button></div>
  ${leftOut}
  ${canChange ? '<p class="fine">Ask for changes opens the message box to the agent. It makes a new version from what you write.</p>' : '<p class="fine" id="task-changes-off">This agent has ended, so it cannot make a new version. Accept the files that you want, or reject the version and start the task again.</p>'}</section>`;
}

/** The changed files of a version, to select for Accept, each with its diff. Scratch files fold under the others, not selected. */
function reviewFiles(
  task: TaskRecord,
  version: TaskVersion,
  stale: string | undefined,
): string {
  if (!version.files.length) return '';
  const marks = { added: '+', modified: 'M', deleted: '−' } as const;
  const item = (file: TaskVersion['files'][number], index: number): string => {
    const allowed = file.inScope && file.regular && !stale;
    const ticked = allowed && !scratch(file.path);
    return `<li><input type="checkbox" id="task-file-${version.number}-${index}" data-file="${e(file.path)}"${ticked ? ' checked' : allowed ? '' : ' disabled'} aria-label="Accept ${e(file.path)}"><button type="button" class="file-name" data-diff="${e(file.path)}" data-task="${e(task.id)}" data-version="${version.number}"><span class="change change-${file.change}" aria-label="${e(file.change)}">${marks[file.change]}</span>${e(file.path)}</button>${allowed || stale ? '' : `<span class="scope">${file.inScope ? 'Not a regular file' : 'Outside the writable paths'}</span>`}</li>`;
  };
  // The index keeps each checkbox ID stable while the view refreshes.
  const indexed = version.files.map((file, index) => ({ file, index }));
  const kept = indexed.filter(({ file }) => !scratch(file.path));
  const temporary = indexed.filter(({ file }) => scratch(file.path));
  const names = [...kept, ...temporary].map(({ file }) =>
    file.path.split('/').at(-1),
  );
  const list = (entries: typeof indexed): string =>
    `<ul class="review-files">${entries.map(({ file, index }) => item(file, index)).join('')}</ul>`;
  return `<section class="card"><details id="task-files"><summary><h2>${version.files.length} ${version.files.length === 1 ? 'file' : 'files'} changed</h2><span>${e(lead(names.join(', '), 90))}</span></summary><div class="review-grid">${kept.length ? list(kept) : ''}${
    temporary.length
      ? `<details id="task-scratch" class="scratch-files"><summary>${temporary.length} scratch ${temporary.length === 1 ? 'file' : 'files'}, not ticked</summary><p class="fine">Temporary output, such as files from a test run. Tick a file to accept it too.</p>${list(temporary)}</details>`
      : ''
  }<div class="diff-pane" data-task="${e(task.id)}" data-version="${version.number}" aria-live="polite"><p class="fine">Choose a file to see its changes.</p></div></div><p class="fine">Accept copies the ticked files into your project.</p></details></section>`;
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
function messageItem(
  message: Message,
  tasks: readonly TaskRecord[],
  messages: readonly Message[],
): string {
  const delivery =
    message.to === 'coordinator' && message.delivery === 'queued'
      ? 'Waits for the coordinator'
      : message.via === 'coordinator'
        ? 'Passed to the coordinator'
        : deliveryLabels[message.delivery];
  return `<li class="message"><p class="message-meta"><span>${e(sender(message.from, tasks))} to ${e(sender(message.to, tasks))}</span><span>${e(kindLabels[message.kind])}${message.status ? `, ${e(message.status)}` : ''}</span><span>${e(delivery)}</span><time datetime="${e(message.at)}">${e(clock(message.at))}</time></p>${message.about ? `<p class="fine">About ${e(sender(message.about.task, tasks))} version ${message.about.version}</p>` : ''}${more(`msg-${message.id}`, named(message.text, tasks, messages), 200)}${message.evidence?.length ? `<ul class="evidence">${message.evidence.map((item) => `<li>${e(item)}</li>`).join('')}</ul>` : ''}</li>`;
}

/** The answer to an open blocker or objection. A decision changes no file. Its reason goes to the task that raised it. */
function decideForm(message: Message): string {
  return `<label class="field" for="decide-${e(message.id)}">Your reason</label><input id="decide-${e(message.id)}" type="text" maxlength="2000"><div class="actions">${
    message.kind === 'objection'
      ? `<button type="button" data-action="task-decide" data-message="${e(message.id)}" data-decision="upheld">Uphold</button><button type="button" data-action="task-decide" data-message="${e(message.id)}" data-decision="overruled">Overrule</button>`
      : `<button type="button" data-action="task-decide" data-message="${e(message.id)}" data-decision="resolved">Resolve</button>`
  }</div><p class="fine">${message.kind === 'objection' ? 'Uphold it if the agent is right, or overrule it. ' : ''}The agent reads your decision and reason in its next turn.</p>`;
}

/** The answer to a question from the coordinator. Done answers without words. */
function answerForm(message: Message): string {
  return `<label class="field" for="decide-${e(message.id)}">Your answer</label><textarea id="decide-${e(message.id)}" rows="2" maxlength="2000"></textarea><div class="actions"><button type="button" class="primary" data-action="task-decide" data-message="${e(message.id)}" data-decision="resolved">Send answer</button><button type="button" data-action="task-decide" data-message="${e(message.id)}" data-decision="resolved" data-reason="Done.">Done</button></div>`;
}

/** Notes that the coordinator wrote to the person, newest first. */
function notesToPerson(
  messages: readonly Message[],
  tasks: readonly TaskRecord[],
): string {
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
    ? `<details id="coordinator-notes" open><summary>Notes to you (${notes.length})</summary><ul class="messages">${notes.map((message) => messageItem(message, tasks, messages)).join('')}</ul></details>`
    : '';
}

/**
 * The coordinator's latest note to the person, unless it is older than 12
 * hours or a task that it names changed after it.
 */
function currentNote(
  messages: readonly Message[],
  tasks: readonly TaskRecord[],
): Message | undefined {
  const note = messages
    .filter(
      (message) => message.from === 'coordinator' && message.to === 'person',
    )
    .at(-1);
  if (!note || Date.now() - Date.parse(note.at) > 12 * 3_600_000) return;
  const ids = new Set(note.text.match(/\btask-\d+\b/g));
  return tasks.some(
    (task) =>
      ids.has(task.id) && Date.parse(task.updatedAt) > Date.parse(note.at),
  )
    ? undefined
    : note;
}

/** One agent that the message box can write to. */
interface Recipient {
  readonly to: string;
  readonly name: string;
  readonly lead: boolean;
}

/**
 * The agents that take messages: the one that leads, then each task agent
 * that runs or waits for review. The coordinator leads while it runs. Before
 * a direction is chosen, research leads. After that, without a coordinator,
 * the person can start one.
 */
function recipients(workspace: Workspace, live: DeskSession): Recipient[] {
  const state = live.coordinator?.state;
  const coordinator = !!state && !state.stoppedAt;
  const research = !!live.research && !workspace.selectedId;
  return [
    ...(coordinator
      ? [{ to: 'coordinator', name: 'Coordinator', lead: true }]
      : []),
    ...(research
      ? [{ to: 'research', name: 'Research', lead: !coordinator }]
      : []),
    // Without a coordinator, the person's words can start one, as its objective.
    ...(!coordinator && !research && live.coordinator !== undefined
      ? [{ to: 'new-coordinator', name: 'A new coordinator', lead: true }]
      : []),
    ...(live.tasks?.list ?? [])
      .filter(
        (task) =>
          ['claimed', 'running', 'review'].includes(task.state) &&
          task.attempts.at(-1)?.session,
      )
      .map((task) => ({
        to: task.id,
        name: task.assignment.title,
        lead: false,
      })),
    ...plainSessions(live).map((view) => ({
      to: `session:${view.record.id}`,
      name: sessionName(view.record),
      lead: false,
    })),
    ...(live.controllable
      ? [{ to: 'new-agent', name: 'A new agent', lead: false }]
      : []),
  ];
}

/** The live sessions that the person started: not a task worker, a lab agent, or the coordinator. */
function plainSessions(live: DeskSession): SessionView[] {
  return (live.workers ?? []).filter(
    (view) =>
      view.live &&
      !view.record.task &&
      !view.record.agent &&
      view.record.mode !== 'coordinator',
  );
}

/** A session by its harness and the start of its first request, so two sessions differ. */
function sessionName(record: SessionRecord): string {
  const first = record.events.find((event) => event.kind === 'you')?.text;
  return `${hostName(record.host)}${first ? `: ${lead(first, 40)}` : ' session'}`;
}

/** How far a message from the person got, in words, and its tone. */
function messageState(
  message: Message,
  live: DeskSession,
): readonly [string, 'waiting' | 'delivered' | 'answered' | 'uncertain'] {
  if (message.answer) return ['Answered', 'answered'];
  if (message.delivery === 'uncertain')
    return ['Delivery not certain: the turn stopped', 'uncertain'];
  if (message.to === 'research')
    return message.delivery === 'queued'
      ? ['Waits for the next research step', 'waiting']
      : message.via === 'coordinator'
        ? ['Passed to the coordinator', 'delivered']
        : ['Delivered with a research step', 'delivered'];
  if (message.via === 'coordinator')
    return ['Passed to the coordinator: the agent has ended', 'delivered'];
  if (message.via === 'turn')
    return message.delivery === 'delivered'
      ? ['Delivered during its turn', 'delivered']
      : ['Sent. It arrives with the next step', 'waiting'];
  if (message.delivery !== 'queued')
    return ['Delivered with its next turn', 'delivered'];
  if (message.to !== 'coordinator')
    return ['Waits for its next turn', 'waiting'];
  const view = live.coordinator;
  const status = view?.session?.record.status;
  return [
    view?.state.stoppedAt
      ? 'Waits: the coordinator is stopped'
      : status === 'paused' || status === 'interrupted'
        ? 'Waits: the coordinator is paused'
        : view?.limitedUntil
          ? view.limitedBy === 'usage'
            ? `Waits for ${hostName(view.state.host)}'s usage window until ${clock(view.limitedUntil)}`
            : `Waits until ${clock(view.limitedUntil)}`
          : status === 'running' || status === 'starting'
            ? 'Waits for its current turn to end'
            : 'Waits for the coordinator',
    'waiting',
  ];
}

/** The person's messages to one agent, with their states and answers, and the coordinator's other notes. */
function thread(
  recipient: Recipient,
  messages: readonly Message[],
  live: DeskSession,
  shown: boolean,
  needsShown: boolean,
  notes: boolean,
): string {
  // The coordinator's drafts wait for the person under its thread, unless Needs you on the page lists them.
  const drafts =
    recipient.to === 'coordinator' && !needsShown
      ? (live.tasks?.list ?? []).filter(isDraft)
      : [];
  const asked = messages.filter(
    (message) => message.from === 'person' && message.to === recipient.to,
  );
  const answers = new Set(asked.map((message) => message.answer?.text));
  const items = messages
    .filter(
      (message) =>
        asked.includes(message) ||
        // The coordinator's notes show on Home only, so other pages do not repeat them.
        (notes &&
          recipient.to === 'coordinator' &&
          message.from === 'coordinator' &&
          message.to === 'person' &&
          message.kind === 'note' &&
          !answers.has(message.text.slice(0, 4000))),
    )
    .slice(-5);
  const row = (message: Message): string => {
    if (message.from !== 'person')
      return `<li class="dock-note"><p class="msg-meta"><strong>${e(recipient.name)}</strong><time datetime="${e(message.at)}">${e(clock(message.at))}</time></p>${inFull(`dock-${message.id}`, message.text)}</li>`;
    const [state, tone] = messageState(message, live);
    // The same reply can answer several messages. It shows under the last one.
    const next = items[items.indexOf(message) + 1];
    const answer =
      message.answer && next?.answer?.at !== message.answer.at
        ? `<div class="dock-answer"><p class="msg-meta"><strong>${e(recipient.name)}</strong><time datetime="${e(message.answer.at)}">${e(clock(message.answer.at))}</time></p>${inFull(`dock-answer-${message.id}`, message.answer.text)}</div>`
        : '';
    return `<li class="dock-msg"><p class="msg-meta"><strong>You</strong><time datetime="${e(message.at)}">${e(clock(message.at))}</time><span class="state ${tone}">${e(state)}</span></p>${inFull(`dock-${message.id}`, message.text)}${answer}</li>`;
  };
  if (recipient.to.startsWith('session:')) {
    const record = plainSessions(live).find(
      (view) => `session:${view.record.id}` === recipient.to,
    )?.record;
    const said = (record?.events ?? [])
      .filter((event) => event.kind === 'you' || event.kind === 'agent')
      .slice(-5);
    return `<ol class="dock-thread" data-thread="${e(recipient.to)}"${shown ? '' : ' hidden'}>${said
      .map(
        (event, index) =>
          `<li class="${event.kind === 'you' ? 'dock-msg' : 'dock-note'}"><p class="msg-meta"><strong>${event.kind === 'you' ? 'You' : e(record ? hostName(record.host) : 'Agent')}</strong><time datetime="${e(event.at)}">${e(clock(event.at))}</time></p>${inFull(`dock-${recipient.to}-${index}`, event.text)}</li>`,
      )
      .join('')}</ol>`;
  }
  const card = drafts.length
    ? `<li class="dock-drafts"><p class="msg-meta"><strong>The coordinator drafted ${drafts.length === 1 ? 'a task' : `${drafts.length} tasks`}</strong><span class="state waiting">Waits for you</span></p><ul class="drafts">${drafts.map(draftCard).join('')}</ul></li>`
    : '';
  return `<ol class="dock-thread" data-thread="${e(recipient.to)}"${shown ? '' : ' hidden'}>${items.map(row).join('')}${card}</ol>`;
}

/** What a draft task does, where it works, and the person's three choices. */
function draftCard(task: TaskRecord): string {
  const { assignment } = task;
  return `<li class="draft"><p><strong>${e(assignment.title)}</strong></p><p class="fine">${e(lead(assignment.objective, 220))}</p><p class="fine">${e(hostName(assignment.host))}${assignment.hostReason ? `: ${e(assignment.hostReason.replace(/[\s.!?]+$/, ''))}` : ''}. Writes ${e(assignment.writable.join(', '))}. Up to ${assignment.minutes} min for each turn.</p><div class="actions"><button type="button" class="primary" data-action="task-start" data-task="${e(task.id)}">Start it</button><button type="button" data-message-to="coordinator" data-about="${e(assignment.title)}">Change it</button><button type="button" class="quiet" data-task-select="${e(task.id)}">Write the task yourself</button></div></li>`;
}

/**
 * The message box at the bottom of Home, Plan, Work, a task, and Needs you.
 * It writes to the agent that leads, to the agent of the open task, or to
 * the agent that To names. The page shows the thread of the chosen agent.
 */
function renderDock(
  workspace: Workspace,
  live: DeskSession,
  prefer?: string,
  needsShown = false,
  notes = false,
): string {
  const list = recipients(workspace, live);
  const first = list.find((recipient) => recipient.to === prefer) ?? list[0];
  if (!first) return '';
  const messages = live.tasks?.messages ?? [];
  const hint = (recipient: Recipient): string =>
    recipient.to === 'coordinator'
      ? 'Write to the coordinator'
      : recipient.to === 'new-coordinator'
        ? 'Write the objective for a new coordinator'
        : recipient.to === 'new-agent'
          ? 'Write the first request for a new agent'
          : `Write to ${recipient.to === 'research' ? 'research' : recipient.name}`;
  return `<button type="button" class="dock-button" data-dock aria-controls="dock">Message the team</button><section class="dock" id="dock" aria-label="Message the team"><div class="dock-threads">${list.map((recipient) => thread(recipient, messages, live, recipient === first, needsShown, notes)).join('')}</div><div class="dock-row"><label class="dock-to" for="message-to"><span class="visually-hidden">To</span><select id="message-to">${list.map((recipient) => `<option value="${e(recipient.to)}" data-hint="${e(hint(recipient))}"${prefer && recipient === first ? ' selected' : ''}>${e(recipient.name)}</option>`).join('')}</select></label><label class="visually-hidden" for="message-text">Message</label><textarea id="message-text" rows="1" maxlength="4000" placeholder="${e(hint(first))}"></textarea><button type="button" class="primary" data-action="message">Send</button></div>${
    live.controllable
      ? `<div class="dock-new" data-for="new-agent"${first.to === 'new-agent' ? '' : ' hidden'}><label for="agent-host">Harness <select id="agent-host"><option value="claude"${workspace.host === 'codex' ? '' : ' selected'}>Claude Code</option><option value="codex"${workspace.host === 'codex' ? ' selected' : ''}>Codex</option></select></label><label for="agent-mode">Commands <select id="agent-mode"><option value="ask">Ask me first</option><option value="auto">Auto</option></select></label><span>In this project folder</span></div>`
      : ''
  }</section>`;
}

/** The plan waits for the person: the coordinator drafted tasks and ended its turn. */
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
  return `<label class="field" for="rule-${entry.check}">Your ruling and its reason</label><input id="rule-${entry.check}" type="text" maxlength="2000"><div class="actions">${button('passed', 'It passed')}${button('partial', 'It partly passed')}${button('failed', 'It failed')}</div><p class="fine">Your ruling is final. The coordinator gets it when it next wakes up.</p>`;
}

/**
 * A notice for each open objection that a check result rests on: the objection
 * is about a task whose accepted files, or the files of a task that waits for
 * it, are evidence for the check.
 */
function disputeNotes(
  entry: CheckResult,
  tasks: readonly TaskRecord[],
  messages: readonly Message[],
): string {
  return messages
    .filter((message) => {
      if (
        message.kind !== 'objection' ||
        message.status !== 'open' ||
        !message.about
      )
        return false;
      const reach = new Set([message.about.task]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const task of tasks)
          if (
            !reach.has(task.id) &&
            task.assignment.dependencies.some((id) => reach.has(id))
          ) {
            reach.add(task.id);
            grew = true;
          }
      }
      return tasks.some(
        (task) =>
          reach.has(task.id) &&
          task.artifacts?.some((artifact) =>
            artifact.files.some((file) => entry.evidence.includes(file.path)),
          ),
      );
    })
    .map(
      (message) =>
        `<p class="notice">An objection to ${e(sender(message.about?.task ?? '', tasks))} is open, and this result uses its files: ${e(lead(message.text, 160))}</p>`,
    )
    .join('');
}

/** How long a version waits for an idle coordinator before it is the person's to review. */
const reviewWaitMs = 30 * 60_000;

/**
 * Who decides on the latest version of a task in review. Every view uses this
 * one rule, so no two views disagree. A coordinator that works, has events
 * queued, or waits out its hourly limit reviews the version. An idle
 * coordinator with nothing queued reviews it only when something else wakes
 * it, so after 30 minutes the version goes to the person.
 */
function reviewOf(
  task: TaskRecord,
  coordinator: CoordinatorView | null | undefined,
): { version: TaskVersion; yours: boolean; why: string } | null {
  const version = task.attempts.at(-1)?.versions.at(-1);
  if (task.state !== 'review' || !version || version.decision) return null;
  if (!coordinator?.state || coordinator.state.stoppedAt)
    return {
      version,
      yours: true,
      why: 'No coordinator runs, so you review it.',
    };
  const idle =
    coordinator.session?.record.status === 'idle' &&
    !coordinator.waiting &&
    !coordinator.limitedUntil;
  const due = Date.parse(version.at) + reviewWaitMs;
  if (idle && Date.now() >= due)
    return {
      version,
      yours: true,
      why: 'The coordinator has not reviewed it in 30 minutes, and nothing wakes it now. You can decide.',
    };
  return {
    version,
    yours: false,
    why: idle
      ? `The coordinator reviews it when something wakes it. If it has not decided by ${clock(new Date(due).toISOString())}, the version comes to you. You can decide first.`
      : 'The coordinator reviews this version. You can decide first.',
  };
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
  for (const call of live.lab
    ? labCallNeeds(
        live.lab,
        live.compute?.secrets.map((secret) => secret.name) ?? null,
      )
    : [])
    items.push({ ...call, view: 'home' });
  // A lab agent whose process kept stopping waits for the person.
  for (const entry of live.lab?.runs ? live.lab.directions : [])
    if (entry.status === 'crashed')
      items.push({
        key: `lab-agent:${entry.agent.id}`,
        view: 'home',
        kind: 'Stopped agent',
        title: `${entry.agent.handle} stopped by itself`,
        why: `${stateOf(entry, clock).text}, so the lab does not start it again by itself.`,
        since: entry.agent.restarts.at(-1) ?? null,
        body: `<div class="actions"><button type="button" class="primary" data-action="lab-agent-restart" data-agent="${e(entry.agent.id)}">Start it again</button><button type="button" data-panel="agent" data-agent="${e(entry.agent.id)}" data-open-pane="summary">What it did</button></div>`,
      });
  // A terminal that the person holds keeps its agent from working.
  for (const entry of live.lab?.runs ? live.lab.directions : [])
    if (entry.status === 'terminal' && entry.agent.session)
      items.push({
        key: `lab-terminal:${entry.agent.id}`,
        view: 'home',
        kind: 'Terminal',
        title: `You hold ${entry.agent.handle}'s terminal`,
        why: 'The agent gets no turn until you return the terminal to Verifold.',
        since: null,
        body: `<div class="actions"><button type="button" class="primary" data-action="terminal-return" data-session="${e(entry.agent.session)}">Return it to Verifold</button><button type="button" data-panel="agent" data-agent="${e(entry.agent.id)}" data-open-pane="terminal">Open the terminal</button></div>`,
      });
  // A lab run has no research to continue.
  if (
    live.research &&
    !live.research.running &&
    !workspace.selectedId &&
    !live.lab
  ) {
    if (phase === 'awaiting-plan-review')
      items.push({
        key: `research-plan:${latest ?? ''}`,
        view: 'research',
        kind: 'Research plan',
        title: 'Review the plan',
        why: 'You asked research to stop at its plan.',
        since,
        body: '<div class="actions"><button type="button" class="primary" data-action="research" data-research="approve">Approve the plan</button><button type="button" data-view="research">Read the plan</button></div>',
      });
    else if (phase === 'directions')
      items.push({
        key: `direction:${latest ?? ''}`,
        view: 'research',
        kind: 'Direction',
        title: 'Choose a direction',
        why: 'The coordinator plans the work after you choose.',
        since,
        body: '<div class="actions"><button type="button" class="primary" data-view="research">Compare the directions</button></div>',
      });
    else if (phase)
      items.push({
        key: `research-stopped:${latest ?? ''}`,
        view: 'research',
        kind: 'Stopped work',
        title: 'Research stopped before its step ended',
        why: 'Continue it to pick up from the saved point.',
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
      why: 'It paused when Verifold stopped. Resume it to continue.',
      since: null,
      body: '<div class="actions"><button type="button" class="primary" data-action="coordinator-resume">Resume the coordinator</button></div>',
    });
  if (planWaits(coordinator, tasks))
    items.push({
      key: `task-plan:${state?.created ?? 0}`,
      view: workspace.selectedId ? 'research' : 'home',
      kind: 'Plan',
      title: 'The plan waits for you',
      why: 'No task starts until you start the work.',
      since:
        tasks
          .filter((task) => task.assignment.by === 'coordinator')
          .map((task) => task.createdAt)
          .sort()
          .at(-1) ?? null,
      // The need opens the plan, so the person reads it before deciding.
      body: workspace.selectedId
        ? '<div class="actions"><button type="button" class="primary" data-view="research" data-focus="plan-card-title">Read the plan</button></div>'
        : '<div class="actions"><button type="button" class="primary" data-panel="coordinator" data-focus="plan-title">Read the plan</button></div>',
    });
  const workers = live.workers ?? (live.session ? [live.session] : []);
  for (const worker of workers)
    for (const request of worker.record.requests.slice(0, 10))
      items.push({
        key: `request:${worker.record.id}:${request.id}`,
        view: 'home',
        ...(worker.record.task ? { task: worker.record.task.id } : {}),
        kind: 'Permission',
        title: `${workerName(worker.record, tasks)} asks to use ${toolName(request.tool)}`,
        why: `It waits for your answer before it continues. Request ${request.id}.`,
        since: request.at,
        body: requestBody(request),
      });
  for (const message of messages) {
    const text = named(message.text, tasks, messages);
    if (isQuestion(message)) {
      // The first sentence or line is the title, and the rest follows it.
      const [, first = text, rest = ''] =
        /^\s*([^\n]*?[.?!:])(?:\s+|$)([\s\S]*)$/.exec(text) ??
        /^\s*([^\n]*)\n?([\s\S]*)$/.exec(text) ??
        [];
      if (message.status === 'open')
        items.push({
          key: `question:${message.id}`,
          view: 'home',
          kind: 'Question',
          title: lead(first, 90),
          why: 'The coordinator waits for your answer.',
          since: message.at,
          body: `${rest.trim() || first.length > 90 ? `<p class="pre">${e(first.length > 90 ? text : rest.trim())}</p>` : ''}${answerForm(message)}`,
        });
      continue;
    }
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
      title: lead(text, 160),
      why: `From ${from}. ${coordinated ? 'The coordinator already overruled two objections from this task, so this one is yours.' : 'No coordinator runs, so this one is yours.'}`,
      since: message.at,
      body: `${lead(text, 160) === text.replace(/\s+/g, ' ').trim() ? '' : `<details class="more" id="need-${e(message.id)}"><summary>Read the whole message</summary><p class="pre">${e(text)}</p></details>`}${message.evidence?.length ? `<ul class="evidence">${message.evidence.map((item) => `<li>${e(item)}</li>`).join('')}</ul>` : ''}${decideForm(message)}`,
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
        why: 'The evidence does not decide it. You do.',
        since: entry.at,
        body: `<p class="fine">${e(idea?.gates[entry.check - 1] ?? '')}</p><p><span class="tag reading">The coordinator says</span> ${e(entry.value)}</p>${disputeNotes(entry, tasks, messages)}${judgementForm(entry)}`,
      });
  if (results?.answer && !results.answer.decision)
    items.push({
      key: `answer:${results.answer.at}`,
      view: 'results',
      kind: 'Sign-off',
      title: 'The answer waits for your sign-off',
      why: 'Accept the answer, or ask for more work.',
      since: results.answer.at,
      body: '<div class="actions"><button type="button" class="primary" data-view="results">Read the answer</button></div>',
    });
  for (const task of tasks) {
    const attempt = task.attempts.at(-1);
    const review = reviewOf(task, coordinator);
    const open = `<div class="actions"><button type="button" class="primary" data-task-select="${e(task.id)}">Open the task</button></div>`;
    if (review?.yours)
      items.push({
        key: `review:${task.id}:${attempt?.number ?? 0}:${review.version.number}`,
        view: 'tasks',
        task: task.id,
        kind: 'Review',
        title: `Version ${review.version.number} of ${task.assignment.title} waits for your review`,
        why: review.why,
        since: review.version.at,
        body: open,
      });
    else if (
      !coordinated &&
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
        why: `${attempt.outcome === 'start-failed' ? `${hostName(task.assignment.host)} did not start.` : 'Verifold could not prepare the task folder.'} No coordinator runs, so only you can start it again.`,
        since: attempt.endedAt,
        body: open,
      });
  }
  const compute = live.compute;
  if (compute)
    for (const lease of compute.leases) {
      const missing = missingSecrets(lease, compute);
      if (lease.state === 'requested' && missing.length)
        items.push({
          key: `lease-secret:${lease.id}`,
          view: 'compute',
          kind: 'GPU pod',
          title: `Add a secret: ${missing.join(', ')}`,
          why: `${asks(lease)} for a ${lease.gpu} pod that needs it. The pod waits until you add it in Compute.`,
          since: lease.requestedAt,
          body: `<div class="why"><span class="tag reading">${lease.requestedBy === 'person' ? 'Your reason' : `${asker(lease)} says`}</span> ${e(lease.reason)}</div>
  <div class="actions"><button type="button" class="primary" data-view="compute">Add it in Compute</button><button type="button" data-action="compute-lease-deny" data-lease="${e(lease.id)}">Deny the pod</button></div>`,
        });
      else if (lease.state === 'requested')
        items.push({
          key: `lease:${lease.id}`,
          view: 'compute',
          kind: 'GPU pod',
          title: `${asks(lease)} for a ${lease.gpu} pod`,
          why: compute.settings.askBeforePod
            ? 'You approve each pod. Nothing is billed until you do.'
            : 'It does not fit your limits right now, for example because a pod already runs. Nothing is billed until you approve it.',
          since: lease.requestedAt,
          body: leaseRequest(lease, compute, tasks),
        });
      if (lease.notice)
        items.push({
          key: `lease-notice:${lease.id}:${lease.history.at(-1)?.at ?? ''}`,
          view: 'compute',
          kind: 'GPU pod',
          title: lease.notice,
          why: 'Verifold changed a pod. Dismiss this when you have read it.',
          since: lease.history.at(-1)?.at ?? null,
          body: `<div class="actions"><button type="button" data-action="compute-lease-dismiss" data-lease="${e(lease.id)}">Dismiss</button><button type="button" data-view="compute">Open Compute</button></div>`,
        });
    }
  // A draft is optional work, so the decisions that hold the team up come first.
  for (const task of tasks.filter(isDraft))
    items.push({
      key: `draft:${task.id}:${task.revision}`,
      view: 'tasks',
      task: task.id,
      kind: 'Draft task',
      title: task.assignment.title,
      why: task.assignment.extra
        ? 'An add-on from research. It starts when you start it.'
        : 'You asked the coordinator for new work. It starts when you start it.',
      since: task.updatedAt,
      body: `<ul class="drafts">${draftCard(task)}</ul>`,
    });
  // A notice about a pod is news, not a decision, and a version that the idle coordinator left
  // is a sign of the stop, so the team can still be stopped beside them.
  if (
    coordinated &&
    state.planApproved &&
    results?.answer?.decision?.kind !== 'accepted' &&
    items.every(
      (item) =>
        item.key.startsWith('lease-notice:') || item.key.startsWith('review:'),
    )
  ) {
    const stalled = stalledTeam(live, tasks, messages);
    if (stalled) items.push(stalled);
  }
  // A lab's Needs-you line shows the first: a call, a stopped agent, a missing secret, then a pod outside the limits.
  return live.lab ? labOrder(items) : items;
}

/**
 * What this lab's pods cost so far, and the project's limit. Pods of tasks,
 * and of earlier labs before Start over, are not this lab's.
 */
export function labGpu(
  compute: ComputeView,
  startedAt: string,
): { spent: number; limit: number | null } {
  const now = Date.now();
  return {
    spent: compute.leases
      .filter(
        (lease) =>
          lease.directions?.length &&
          Date.parse(lease.requestedAt) >= Date.parse(startedAt),
      )
      .reduce((sum, lease) => sum + spent(lease, now), 0),
    limit: compute.settings.limitUsd,
  };
}

/** The order of a lab's needs. The sort is stable, so each kind keeps its own order. */
function labOrder(items: readonly Need[]): Need[] {
  const order = [
    'lab-call:',
    'lab-agent:',
    'lease-secret:',
    'lease:',
    'request:',
    'lab-terminal:',
  ];
  const rank = (key: string): number => {
    const index = order.findIndex((prefix) => key.startsWith(prefix));
    return index < 0 ? order.length : index;
  };
  return [...items].sort((a, b) => rank(a.key) - rank(b.key));
}

/** The secrets that a lease names and this computer does not store. */
function missingSecrets(lease: Lease, compute: ComputeView): string[] {
  return (lease.secrets ?? []).filter(
    (name) => !compute.secrets.some((secret) => secret.name === name),
  );
}

/**
 * The team stopped, and nothing wakes it: the coordinator waits, no agent
 * works, and no event, wakeup, or pod is on its way. A coordinator note to the
 * person is not a question, so this item is the only thing that tells the
 * person. Null while anything can still move the work on.
 */
function stalledTeam(
  live: DeskSession,
  tasks: readonly TaskRecord[],
  messages: readonly Message[],
): Need | null {
  const coordinator = live.coordinator;
  const record = coordinator?.session?.record;
  const busy = (status: string): boolean =>
    status === 'starting' || status === 'running' || status === 'terminal';
  const workers = live.workers ?? (live.session ? [live.session] : []);
  if (
    !coordinator ||
    !record ||
    busy(record.status) ||
    record.status === 'paused' ||
    record.status === 'interrupted' ||
    coordinator.waiting > 0 ||
    coordinator.limitedUntil ||
    tasks.some(
      (task) => task.state === 'running' || task.state === 'claimed',
    ) ||
    workers.some((worker) => busy(worker.record.status)) ||
    live.compute?.leases.some(isRunning)
  )
    return null;
  const note = messages
    .filter(
      (message) => message.from === 'coordinator' && message.to === 'person',
    )
    .at(-1);
  // The time of the last change, so the item keeps its key, and notifies once, while nothing moves.
  const at =
    [record.events.at(-1)?.at, note?.at, ...tasks.map((task) => task.updatedAt)]
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
  const open = tasks.filter(
    (task) => task.state !== 'done' && task.state !== 'cancelled',
  ).length;
  // The coordinator looked at GPU pods, and Verifold has no RunPod key to start one.
  const noKey =
    !!live.compute &&
    !live.compute.key &&
    coordinator.state.actions.some(
      (action) =>
        action.tool === 'verifold_compute' ||
        action.tool === 'verifold_request_pod',
    );
  const text = note
    ? named(note.text, tasks, messages).replace(/\s+/g, ' ').trim()
    : '';
  return {
    key: `stalled:${at ?? ''}`,
    view: 'home',
    kind: 'Stopped work',
    title: 'The team stopped',
    why: 'No agent works, and the coordinator waits until you write to it.',
    since: at,
    body: `${note ? `<p><span class="tag reading">The coordinator wrote at ${e(since(note.at))}</span> ${e(lead(text, 300))}</p>${lead(text, 300) === text ? '' : `<details class="more"><summary>Read the whole note</summary><p class="pre">${e(named(note.text, tasks, messages))}</p></details>`}` : ''}<p class="fine">${open ? `${open === 1 ? '1 task is' : `${open} tasks are`} not done.` : 'Every task is done. The coordinator has not proposed the answer.'}${noKey ? ' No RunPod key is saved, so no task can use a GPU pod.' : ''}</p><div class="actions"><button type="button" class="primary" data-message-to="coordinator">Write to the coordinator</button>${noKey ? '<button type="button" data-view="compute">Open Compute</button>' : ''}</div>`,
  };
}

/** What the person approves for a lease: its cost, what is left after it, what the pod allows, and the coordinator's reason. */
function leaseRequest(
  lease: Lease,
  compute: ComputeView,
  tasks: readonly TaskRecord[],
): string {
  const cost = maxCost(lease.rate, lease.diskGb, lease.hours);
  const left = compute.budget.left;
  return `<dl class="facts"><div><dt>For</dt><dd>${e(podFor(lease, tasks))}</dd></div>${lease.secrets?.length ? `<div><dt>Secrets</dt><dd>${lease.secrets.map((name) => `<code>${e(name)}</code>`).join(', ')}, as environment variables on the pod</dd></div>` : ''}<div><dt>GPU</dt><dd>${e(lease.gpu)}, one GPU, Secure Cloud</dd></div><div><dt>Image</dt><dd><code>${e(lease.image)}</code></dd></div><div><dt>Rate</dt><dd>${usd(lease.rate)} per hour, the list price when the request came</dd></div><div><dt>At most</dt><dd>${lease.hours} ${lease.hours === 1 ? 'hour' : 'hours'}, ${usd(cost)} with the disk</dd></div>${left === null ? '' : `<div><dt>Left after it</dt><dd>${usd(Math.max(0, left - cost))} of ${usd(compute.settings.limitUsd ?? 0)}</dd></div>`}</dl>
  <div class="why"><span class="tag reading">${lease.requestedBy === 'person' ? 'Your reason' : `${asker(lease)} says`}</span> ${e(lease.reason)}</div>
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
  return `<div class="view"><div class="view-head"><h1 id="view-title" tabindex="-1">Needs you</h1><p>${items.length ? `${items.length} ${items.length === 1 ? 'item waits' : 'items wait'} for you` : 'Nothing needs you right now.'}</p></div>
  <p class="notify"><span id="notify-state"></span><button type="button" id="notify" hidden>Turn on desktop notifications</button></p>
  ${items.length ? `<section class="card needs" aria-labelledby="view-title">${renderNeedList(items)}</section>` : '<section class="card"><p class="fine">Questions, approvals, and stopped work show here when they need you.</p></section>'}</div>`;
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
    return '<section class="card"><h2>The coordinator drafts the plan</h2><p>No task starts before you start the work.</p></section>';
  return `<section class="card"><h2>The coordinator runs the team</h2><p>${needs ? `${needs} ${needs === 1 ? 'item needs' : 'items need'} you above.` : 'Nothing needs you. Follow the tasks in Work.'}</p></section>`;
}

/** Each coordinator tool in plain words: what it did, and what it tried when Verifold refused. */
const actionWords: Record<string, readonly [string, string]> = {
  create_task: ['Created a task', 'create a task'],
  revise_task: ['Changed', 'change'],
  start_task: ['Started', 'start'],
  stop_task: ['Stopped', 'stop'],
  cancel_task: ['Cancelled', 'cancel'],
  accept: ['Accepted a version of', 'accept a version of'],
  request_changes: ['Asked for changes to', 'ask for changes to'],
  reject: ['Rejected a version of', 'reject a version of'],
  post: ['Wrote to', 'write to'],
  ask: ['Asked you a question', 'ask you a question'],
  note: ['Kept a note in memory/notes.md', 'keep a note in memory/notes.md'],
  report_check: ['Reported check', 'report check'],
  propose_answer: ['Proposed the answer', 'propose the answer'],
  state: ['Read the state of the work', 'read the state of the work'],
  read: ['Read a file of', 'read a file of'],
  compute: ['Read the GPU settings', 'read the GPU settings'],
  request_pod: ['Asked for a GPU pod for', 'ask for a GPU pod for'],
  start_pod: ['Started a GPU pod', 'start a GPU pod'],
  stop_pod: ['Stopped a GPU pod', 'stop a GPU pod'],
  end_lease: ['Ended a GPU pod', 'end a GPU pod'],
};

/** What the coordinator did with a blocker or an objection, by its decision. */
const decisionWords: Record<string, string> = {
  resolved: 'Answered the blocker from',
  upheld: 'Upheld the objection from',
  overruled: 'Overruled the objection from',
};

/** A coordinator action as a sentence for the person, with the title of its task. */
function actionSentence(
  action: CoordinatorAction,
  tasks: readonly TaskRecord[],
  messages: readonly Message[] = [],
): string {
  const name = action.tool.replace(/^verifold_/, '');
  let input: Record<string, unknown> = {};
  try {
    input = object(JSON.parse(action.input));
  } catch {
    // An input that is not an object leaves the sentence without its task.
  }
  if (name === 'decide') {
    const message = messages.find((entry) => entry.id === input.message);
    const decided =
      typeof input.decision === 'string'
        ? decisionWords[input.decision]
        : undefined;
    return action.ok && message && decided
      ? `${decided} ${sender(message.from, tasks)}.`
      : `${action.ok ? 'Settled' : 'Tried to settle'} ${message ? `a message from ${sender(message.from, tasks)}` : 'a message'}${action.ok ? '' : '. Verifold refused it'}.`;
  }
  const [done, tried] = actionWords[name] ?? [
    `Used the tool ${action.tool}`,
    `use the tool ${action.tool}`,
  ];
  const id =
    typeof input.task === 'string'
      ? input.task
      : name === 'post' && typeof input.to === 'string'
        ? input.to
        : undefined;
  const title =
    id === 'person'
      ? 'you'
      : (tasks.find((task) => task.id === id)?.assignment.title ??
        (typeof input.title === 'string' ? input.title : id));
  const what =
    action.tool === 'verifold_report_check' &&
    typeof input.check === 'number' &&
    typeof input.result === 'string'
      ? ` ${input.check}: ${input.result}`
      : title
        ? `${action.tool === 'verifold_create_task' ? ':' : ''} ${title}`
        : '';
  return action.ok
    ? `${done}${what}.`
    : `Tried to ${tried}${what}. Verifold refused it.`;
}

const coordinatorStates: Record<string, string> = {
  starting: 'Starting',
  running: 'Working',
  idle: 'Waiting',
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
      body: `<p class="fine">The coordinator splits an objective into tasks, starts them, and reviews each version. It works only through Verifold's task tools and gives a reason for each action. It cannot run commands or edit files.</p>
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
  // An idle coordinator names the version that waits, with the same rule as the other views.
  const pending = tasks.flatMap((task) => {
    const review = reviewOf(task, view);
    return review ? [{ title: task.assignment.title, ...review }] : [];
  });
  const left = pending.find((entry) => entry.yours) ?? pending[0];
  const idle = left
    ? `Idle. ${left.yours ? `Version ${left.version.number} of ${left.title} waits for your review.` : `It reviews version ${left.version.number} of ${left.title} when something wakes it.`}`
    : 'Idle. Nothing new to review.';
  // What the coordinator does or waits for comes first. A pause or the hourly limit has its own notice.
  const now =
    paused || view.limitedUntil
      ? ''
      : planning
        ? 'It works now.'
        : view.waiting
          ? `${view.waiting} ${view.waiting === 1 ? 'change waits' : 'changes wait'} for its next turn.`
          : idle;
  const plan = state.planApproved
    ? ''
    : `<div class="subcard${waits ? ' needs' : ''}" role="region" aria-labelledby="plan-title"><h3 id="plan-title" tabindex="-1">${waits ? 'The plan waits for you' : planned.length ? 'The coordinator drafts the plan' : 'No plan yet'}</h3><p>No task starts before you start the work. To change the plan, write to the coordinator, or edit a task in Work.</p>${planned.length ? `<ul>${planned.map((task) => `<li><strong>${e(task.assignment.title)}</strong>: ${e(lead(task.assignment.objective, 200))}${task.assignment.dependencies.length ? ` (waits for ${e(task.assignment.dependencies.map((id) => sender(id, tasks)).join(', '))})` : ''}</li>`).join('')}</ul>` : '<p class="empty-note">The coordinator has not created tasks yet.</p>'}<div class="actions"><button type="button" class="primary" data-action="coordinator-approve"${waits ? '' : ' disabled'}>Start the work</button>${planning ? '<p class="fine">The coordinator still drafts the plan.</p>' : ''}</div></div>`;
  return {
    kind: 'Agent',
    title: 'Coordinator',
    sub: `<span class="status ${paused || session?.status === 'failed' ? 'muted' : 'active'}">${e(status)}</span>`,
    body: `${now ? `<p class="coordinator-now">${e(now)}</p>` : ''}<p class="session-meta"><span>${e(hostName(state.host))}</span><span>Model: ${e(state.model ?? 'harness default')}</span><span class="detail-only">${state.created} of ${coordinatorLimits.tasks} tasks created</span><span class="detail-only">${wakeups} of ${coordinatorLimits.wakeupsPerHour} turns this hour</span></p>
  ${view.limitedUntil ? `<p class="notice">${view.limitedBy === 'usage' ? `The coordinator waits for ${e(hostName(state.host))}'s usage window until ${e(clock(view.limitedUntil))}. The window is used up, so a turn would fail.` : `The coordinator used its turns for this hour. It continues at ${e(clock(view.limitedUntil))}.`}</p>` : ''}
  ${paused ? '<p class="notice">The coordinator paused when Verifold stopped. Resume it to continue with the same conversation.</p>' : ''}
  ${plan}
  ${notesToPerson(messages, tasks)}
  <details id="coordinator-objective-view"><summary>Objective</summary><p class="pre">${e(state.objective)}</p></details>
  <details id="coordinator-actions"${actions.length ? ' open' : ''}><summary>What it did (${state.actions.length})</summary>${actions.length ? `${detailSwitch}<ul class="actions-log">${actions.map((action, index) => `<li><span class="mark ${action.ok ? 'done' : 'failed'}" aria-hidden="true"></span><div><p>${e(actionSentence(action, tasks, messages))}</p>${action.reason ? `<div class="why"><span class="tag reading">The coordinator's reason</span>${more(`action-${state.actions.length - 1 - index}`, named(action.reason, tasks, messages), 120)}</div>` : ''}<p class="fine detail-only">Tool: <code>${e(action.tool)}</code>. Verifold's reply: ${e(action.result)}</p></div><time datetime="${e(action.at)}">${e(clock(action.at))}</time></li>`).join('')}</ul>` : '<p class="empty-note">No actions yet.</p>'}<p class="fine">Verifold records each result. The reasons come from the coordinator.</p></details>
  ${session ? `<details id="coordinator-transcript"><summary>Transcript</summary>${transcriptSlot(`session:${session.id}`, 'Coordinator transcript', '')}</details>` : ''}
  <div class="actions">${paused ? '<button type="button" class="primary" data-action="coordinator-resume">Resume the coordinator</button>' : ''}<button type="button" data-action="coordinator-stop" data-confirm="Click again to stop the coordinator">Stop the coordinator</button></div>
  <p class="fine">If you stop it, the agents finish their turns, and their versions wait for your review.</p>`,
  };
}

/** A name for a sender or a receiver of a message. */
function sender(id: string, tasks: readonly TaskRecord[]): string {
  if (id === 'coordinator') return 'Coordinator';
  if (id === 'person') return 'You';
  return tasks.find((task) => task.id === id)?.assignment.title ?? id;
}

/**
 * Task and message IDs in a text, as names for the person: "task-2" becomes
 * the task title in quotes, and "objection m-4" becomes "the objection from"
 * its task. An ID inside a path, a code span, or another word stays.
 */
function named(
  text: string,
  tasks: readonly TaskRecord[],
  messages: readonly Message[] = [],
): string {
  const quote = (id: string): string => {
    const title = tasks.find((task) => task.id === id)?.assignment.title;
    return title ? `"${title}"` : id;
  };
  return text
    .replace(
      /\b(your |the )?(objection|blocker|question) (m-\d+)\b/g,
      (_, owner: string | undefined, kind: string, id: string) => {
        const from = messages.find((message) => message.id === id)?.from;
        if (owner === 'your ' || !from) return `${owner ?? 'the '}${kind}`;
        const name =
          from === 'coordinator'
            ? 'the coordinator'
            : from === 'person'
              ? 'you'
              : quote(from);
        return `the ${kind} from ${name}`;
      },
    )
    .replace(/(?<![\w/.`-])task-\d+(?![\w/`-]|\.\w)/g, quote);
}

/** What the agents and the coordinator write to each other, newest first, for Records. Nobody posts in it. */
function renderFeed(
  messages: readonly Message[],
  tasks: readonly TaskRecord[],
): string {
  const feed = messages
    .filter((message) => message.from !== 'person' && message.to !== 'person')
    .reverse();
  const row = (message: Message): string =>
    `<li class="feed-row">${avatar(message.from === 'coordinator' ? 'coordinator' : 'task', '')}<div class="feed-body"><p class="feed-head"><strong>${e(sender(message.from, tasks))}</strong><span class="feed-to">to ${e(sender(message.to, tasks))}</span><span class="chip ${message.kind}">${e(kindLabels[message.kind])}${message.status ? `, ${e(message.status)}` : ''}</span><time datetime="${e(message.at)}">${e(since(message.at))}</time></p>${more(`feed-${message.id}`, named(message.text, tasks, messages), 140)}</div></li>`;
  return `<section class="card" aria-labelledby="feed-title"><div class="section-title"><h2 id="feed-title">Messages between agents</h2><span class="count">${feed.length}</span></div>${
    feed.length
      ? `<ul class="feed">${feed.slice(0, 8).map(row).join('')}</ul>${feed.length > 8 ? `<details id="feed-more"><summary>${feed.length - 8} older messages</summary><ul class="feed">${feed.slice(8).map(row).join('')}</ul></details>` : ''}`
      : '<p class="empty-note">None yet. Each task page shows its own messages.</p>'
  }</section>`;
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
      ? `The coordinator acted ${acted} ${acted === 1 ? 'time' : 'times'}. Its panel gives the reasons.`
      : '',
    posted
      ? `${posted} ${posted === 1 ? 'message' : 'messages'} between agents, in Records.`
      : '',
  ].filter(Boolean);
  return `<section class="card" aria-labelledby="since-title"><div class="section-title"><h2 id="since-title">Since you left at ${e(since(left))}</h2><span class="count">From Verifold's records</span></div>
  ${shown.length ? `<ul class="since">${shown.map((event) => `<li><span class="mark ${event.mark}" aria-hidden="true"></span><span>${e(event.text)}</span><time datetime="${e(event.at)}">${e(clock(event.at))}</time></li>`).join('')}</ul>${events.length > shown.length ? `<p class="fine">The latest ${shown.length} of ${events.length} changes.</p>` : ''}` : '<p class="empty-note">Nothing changed while you were away.</p>'}
  ${totals.length ? `<p class="fine">${totals.map(e).join(' ')}</p>` : ''}</section>`;
}

/** The note of an attempt. A failed start says what it means first, and the error of the harness folds. */
function attemptNote(
  attempt: TaskAttempt,
  host: TaskRecord['assignment']['host'],
): string {
  if (
    attempt.outcome !== 'start-failed' &&
    attempt.outcome !== 'allocation-failed'
  )
    return `<p class="notice">${e(attempt.note ?? '')}</p>`;
  return `<p class="notice">${attempt.outcome === 'start-failed' ? `${e(hostName(host))} did not start` : 'Verifold could not prepare the task folder'}, so the task did not run. Its messages wait for the next start. Start it again when you are ready.</p><details class="more"><summary><span class="more-hint"><span class="closed">Show the error</span><span class="opened">Hide the error</span></span></summary><p class="pre">${e(attempt.note ?? '')}</p></details>`;
}

/** The pod of a task: its lease, GPU, state, and end, and what the pod allows. */
function taskPod(task: string, compute: ComputeView | undefined): string {
  const lease = compute?.leases.findLast(
    (entry) =>
      entry.tasks.includes(task) &&
      (isOpen(entry) || entry.state === 'requested'),
  );
  if (!lease) return '';
  return `<p class="pod-line"><strong>Pod:</strong> ${e(lease.gpu)}, ${e(leaseStates[lease.state].toLowerCase())}${lease.deadline ? `, ends ${e(since(lease.deadline))}` : ''}. <button type="button" class="row-button" data-view="compute">Open Compute</button></p><p class="fine">The pod runs any command of this task as root, on a machine with internet access. Files that the task copies to it leave this computer. The agent reaches the pod only through Verifold's pod tools.</p>`;
}

/**
 * One task as a page: what the person decides first, then the files, the
 * details, what the agent did, the messages, and the history. Tasks show by
 * title, never by ID.
 */
function renderTaskPage(
  task: TaskRecord | null,
  view: TaskView,
  live: DeskSession,
  host: string,
  needKeys: ReadonlySet<string>,
): string {
  const back =
    '<div class="view-head"><button type="button" class="quiet back" data-view="tasks">← Back to the map</button></div>';
  if (!task)
    return `<div class="view">${back}<h1 id="view-title" tabindex="-1">No task</h1><p class="empty-note">This task is not in the list.</p></div>`;
  const all = view.list;
  const name = (id: string): string => sender(id, all);
  const others = all.filter((entry) => entry.id !== task.id);
  const attempt = task.attempts.at(-1);
  const version = attempt?.versions.at(-1);
  const assignment = task.assignment;
  const waiting = assignment.dependencies.filter(
    (id) => all.find((entry) => entry.id === id)?.state !== 'done',
  );
  const [stale] = replaced(attempt, all);
  const used = stale
    ? `This version used ${name(stale.task)} version ${stale.used}, but ${name(stale.task)} now has version ${stale.current}.`
    : undefined;
  // A draft opens with its form, so the person can write the task themselves.
  const editForm = `<details id="task-edit"${isDraft(task) ? ' open' : ''}><summary><h2>${task.state === 'done' ? 'Revise the task' : 'Change the task'}</h2></summary><p class="fine">${task.state === 'done' ? 'A revision opens the task again. Its accepted files stay in the record, and tasks that used them show when a newer version replaces them.' : 'A change makes a new revision. Earlier attempts keep the revision that they ran.'}</p>${taskForm('task-edit', assignment, others, host)}<label class="field" for="task-edit-reason">Why it changes</label><input id="task-edit-reason" type="text" maxlength="500"><div class="actions"><button type="button" data-action="task-edit" data-task="${e(task.id)}">Save revision ${task.revision + 1}</button></div></details>`;
  const artifact = task.artifacts?.at(-1);
  const blocked = waiting.length
    ? `This task waits for ${waiting.map(name).join(', ')}.`
    : live.full
      ? `${live.agents ?? defaultAgents} agents already work, the most that "Agents at once" allows. Wait for one to finish, or end a session.`
      : undefined;
  const workers = live.workers ?? (live.session ? [live.session] : []);
  const agent =
    attempt?.session &&
    workers.some((worker) => worker.record.id === attempt.session)
      ? `<button type="button" data-worker="${e(attempt.session)}">Follow its agent</button>`
      : '';
  // A failed start can move to the other harness of the team.
  const team = live.coordinator?.state;
  const moveTo =
    attempt?.outcome === 'start-failed' && team
      ? [team.host, ...(team.helper ? [team.helper] : [])].find(
          (other) => other !== assignment.host,
        )
      : undefined;
  const cancel = `<button type="button" data-action="task-cancel" data-task="${e(task.id)}" data-confirm="Click again to cancel this task">Cancel task</button>`;
  let first = '';
  switch (task.state) {
    case 'open':
      first = `<section class="card decision"><h2>${isDraft(task) ? 'The coordinator drafted this task for you' : waiting.length ? 'The task waits' : team && !team.stoppedAt ? 'Not started' : 'Ready to start'}</h2>${blocked ? `<p class="notice" id="task-blocked">${e(blocked)}</p>` : !isDraft(task) && team && !team.stoppedAt ? '<p class="fine">The coordinator starts it when it is ready. You can start it now yourself.</p>' : ''}${moveTo ? `<div class="actions"><button type="button" class="primary" data-action="task-switch-host" data-task="${e(task.id)}"${blocked ? ' disabled aria-describedby="task-blocked"' : ''}>Run it on ${e(hostName(moveTo))}</button></div><p class="fine">Its start on ${e(hostName(assignment.host))} failed. The other harness of the team can run it.</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="task-start" data-task="${e(task.id)}"${blocked ? ' disabled aria-describedby="task-blocked"' : ''}>Start task</button>${isDraft(task) ? `<button type="button" data-message-to="coordinator" data-about="${e(assignment.title)}">Change it</button>` : ''}${cancel}</div></section>`;
      break;
    case 'claimed':
      first =
        '<section class="card decision"><h2>Starting</h2><p>Verifold prepares the task folder.</p></section>';
      break;
    case 'running': {
      const step = lastStep(task, workers);
      const quiet =
        step && Date.now() - Date.parse(step.at) >= 5 * 60_000
          ? ` <span class="now-quiet">Last update ${e(duration(step.at))} ago</span>`
          : '';
      first = `<section class="card decision"><div class="section-title"><h2>The agent works</h2>${attempt ? `<span class="count">For ${e(duration(attempt.startedAt))}</span>` : ''}</div><p class="now-step">${e(step?.text ?? 'Working')}${quiet}</p><div class="actions"><button type="button" class="primary" data-message-to="${e(task.id)}">Message</button><button type="button" data-action="task-stop" data-task="${e(task.id)}">Stop the turn</button>${agent}</div><p class="fine">Your message reaches the agent during its turn. If you stop the turn, its work becomes a version for review.</p></section>`;
      break;
    }
    case 'review':
      first =
        version && !version.decision
          ? `${reviewDecision(
              task,
              version,
              !!attempt?.session &&
                (view.idle.includes(attempt.session) ||
                  !!view.resumable?.includes(attempt.session)),
              used &&
                `${used} It cannot be accepted. Reject it and start the task again, so it uses the new files.`,
              reviewOf(task, live.coordinator)?.why ?? '',
            )}${reviewFiles(task, version, used)}`
          : `<section class="card decision"><p class="notice">${e(attempt?.note ?? 'No version is ready.')}</p><div class="actions">${cancel}</div></section>`;
      break;
    case 'done':
      first = `<section class="card decision"><h2>Done</h2><p>${artifact ? `Version ${artifact.version} was accepted with ${fileCount(artifact.files.length)}.` : 'A version was accepted.'} Tasks that wait for this one get its files.</p>${artifact?.files.length ? `<details id="done-files-${e(task.id)}"><summary>Show the files</summary><ul class="file-list">${artifact.files.map((file) => `<li><code>${e(file.path)}</code></li>`).join('')}</ul></details>` : ''}${used ? `<p class="notice">${e(used)} Revise this task, so it runs again with the new files.</p>` : ''}</section>`;
      break;
    case 'cancelled':
      first =
        '<section class="card decision"><h2>Cancelled</h2><p>Its records stay in the project.</p></section>';
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
  const received = attempt?.consumed ?? [];
  const story =
    task.state === 'review' && version
      ? `${hostName(assignment.host)} made version ${version.number} at ${since(version.at)}.${received.length ? ` It received files from ${[...new Set(received.map((used) => name(used.task)))].join(', ')}.` : ''}`
      : '';
  const details = `<details id="task-details"><summary><h2>What the task asks</h2></summary>
    ${assignment.hostReason ? `<p class="host-why"><span class="map-label">Why this harness</span> ${e(assignment.hostReason)}</p>` : ''}
    <dl class="task-fields"><dt>Objective</dt><dd>${more(`objective-${task.id}`, assignment.objective, 220)}</dd><dt>Expected output</dt><dd>${more(`output-${task.id}`, assignment.output, 160)}</dd><dt>Input files</dt><dd>${assignment.inputs.length ? assignment.inputs.map((input) => `<code>${e(input.path)}</code>`).join(' ') : 'None'}</dd><dt>May write to</dt><dd>${assignment.writable.map((path) => `<code>${e(path === '.' ? 'the whole project' : path)}</code>`).join(' ')}</dd><dt>Network</dt><dd>${assignment.network ? `${e(assignment.network.domains.join(', '))}: ${e(assignment.network.reason)}${assignment.host === 'codex' ? ' (Codex cannot limit the network to these domains.)' : ''}` : 'None for shell commands'}</dd>${assignment.dependencies.length ? `<dt>Waits for</dt><dd>${e(assignment.dependencies.map(name).join(', '))}</dd>` : ''}${received.length ? `<dt>Received</dt><dd>${e(received.map((used) => `${name(used.task)} version ${used.version}`).join(', '))}</dd>` : ''}<dt>Harness</dt><dd>${e(hostName(assignment.host))}, model ${e(assignment.model ?? 'harness default')}, ${assignment.minutes} min for each turn</dd></dl>
    ${attempt?.restrictions.length ? `<h3>What the harness enforces</h3><ul>${attempt.restrictions.map((entry) => `<li>${e(entry)}</li>`).join('')}</ul><p class="fine">Claude Code or Codex enforces these limits, so the agent cannot ignore them.</p>` : ''}</details>`;
  const activity = attempt?.session
    ? `<details id="task-activity"><summary><h2>What the agent did</h2></summary>${transcriptSlot(`session:${attempt.session}`, `${hostName(assignment.host)} transcript`, '')}${agent ? `<div class="actions">${agent}</div>` : ''}</details>`
    : '';
  const messages = `<details id="task-messages"${thread.some((message) => message.status === 'open') ? ' open' : ''}><summary><h2>Messages</h2><span>${thread.length}</span></summary>${thread.length ? `<ul class="messages">${thread.map((message) => `${messageItem(message, all, view.messages ?? [])}${message.status === 'open' && !needKeys.has(`message:${message.id}`) ? `<li class="decide"><p class="fine">The coordinator settles this one. You can settle it first.</p>${decideForm(message)}</li>` : ''}`).join('')}</ul>` : '<p class="empty-note">No messages yet.</p>'}</details>`;
  return `<div class="view task-page">${back}
  <div class="task-title"><h1 id="view-title" tabindex="-1">${e(assignment.title)}</h1></div>
  ${story ? `<p class="task-lead">${e(story)}</p>` : ''}
  ${attempt?.note && task.state !== 'review' ? attemptNote(attempt, assignment.host) : ''}
  ${first}
  ${taskPod(task.id, live.compute)}
  <section class="card task-more" aria-label="More about this task">${details}${activity}${messages}${task.state === 'open' || task.state === 'done' ? editForm : ''}${history.length || notes.length ? `<details id="task-history"><summary><h2>History</h2><span>${history.length + notes.length}</span></summary><ul>${[...history, ...notes].join('')}</ul></details>` : ''}</section></div>`;
}

const fileKinds: readonly (readonly [string, RegExp])[] = [
  [
    'code',
    /\.(py|ipynb|[cm]?js|jsx|tsx?|c|h|cc|cpp|hpp|rs|go|java|kt|scala|rb|php|sh|jl|r|swift|cs|lua|sql)$/i,
  ],
  [
    'results',
    /\.(json|jsonl|csv|tsv|parquet|npy|npz|h5|hdf5|pkl|log|png|jpe?g|svg)$/i,
  ],
  ['notes', /\.(md|txt|rst|tex|pdf|html?)$/i],
];

/** What a done task hands to the tasks that wait for it, from the files of its last accepted version. */
function handoffWords(task: TaskRecord): string {
  const files = task.artifacts?.at(-1)?.files ?? [];
  const kinds = fileKinds
    .filter(([, pattern]) => files.some((file) => pattern.test(file.path)))
    .map(([kind]) => kind);
  if (kinds.length === 1 || kinds.length === 2) return kinds.join(' and ');
  return files.length ? 'files' : '';
}

/** A shell command in plain words: the program that it runs, and the file that the program gets. */
function commandStep(command: string): string {
  const step = command
    .split(/\n|&&|\|\||;/)
    .map((part) => part.trim())
    .find((part) => part && !/^(cd|export|set|source)\b/.test(part));
  const [program = '', ...rest] = (step ?? '').split(/\s+/);
  const name = program.split('/').at(-1) ?? '';
  if (!/^[\w.+-]+$/.test(name) || /^(for|while|if|do|then|case)$/.test(name))
    return 'Running a command';
  // A script comes first, then any other file: `python -m cProfile -o out.prof bench.py` runs bench.py.
  const files = rest.filter((word) => /^[\w./-]+\.\w+$/.test(word));
  const script =
    files.find((word) => /\.(py|js|mjs|cjs|ts|sh|r|jl|rb|pl)$/i.test(word)) ??
    files[0];
  return `Running ${name}${script ? ` ${script.split('/').at(-1)}` : ''}`;
}

/** A tool call in plain words, for a Now line. The tool name and the full input stay in the transcript. */
function toolStep(tool: string, action = ''): string {
  const path = action.split(', ')[0]?.split(/[\\/]/).filter(Boolean).at(-1);
  switch (tool.replace(/^mcp__\w+?__/, '')) {
    case 'Bash':
    case 'Command':
      return commandStep(action);
    case 'Read':
      return path ? `Reading ${path}` : 'Reading a file';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'File change':
      return path ? `Writing ${path}` : 'Writing a file';
    case 'Grep':
    case 'Glob':
      return 'Searching the files';
    case 'WebSearch':
    case 'Web search':
      return 'Searching the web';
    case 'WebFetch':
      return 'Reading a web page';
    case 'Task':
    case 'Agent':
      return 'Starting a helper agent';
    case 'verifold_post':
      return 'Writing a note';
    case 'verifold_block':
      return 'Asking for help';
    case 'verifold_object':
      return 'Raising an objection';
    case 'verifold_pod_run':
    case 'verifold_pod_job':
    case 'verifold_pod_copy':
      return 'Working on the GPU pod';
    default:
      return 'Working';
  }
}

/** The latest step of research in plain words, from the harness events that Verifold observed. */
function researchNow(events: ResearchView['events']): string | null {
  const codex: Record<string, string> = {
    'a command': 'Running a command',
    'web search': 'Searching the web',
    'an MCP tool': 'Using a tool',
    'native agent coordination': 'Working with helper agents',
    'a file change': 'Writing a file',
  };
  for (const event of events.toReversed()) {
    if (event.kind !== 'tool') continue;
    const asked = /requested (\S+?)( in a native subagent)?\.$/.exec(
      event.text,
    );
    if (asked)
      return `${toolStep(asked[1] ?? '')}${asked[2] ? ' (a helper agent)' : ''}`;
    const started = /^Codex started (.+)\.$/.exec(event.text)?.[1];
    if (started && Object.hasOwn(codex, started)) return codex[started] ?? null;
  }
  return null;
}

/** A session event as a Now line: the agent's own words, or its tool call in plain words. */
function nowText(event: {
  readonly kind: string;
  readonly text: string;
}): string {
  if (event.kind === 'agent') return plain(event.text);
  if (event.kind !== 'tool') return event.text;
  // Tool events read "Tool: input".
  const split = event.text.indexOf(': ');
  return split < 0
    ? toolStep(event.text)
    : toolStep(event.text.slice(0, split), event.text.slice(split + 2));
}

/** A task agent's latest step and when it came, or null before its first step. */
function lastStep(
  task: TaskRecord,
  workers: readonly SessionView[],
): { readonly text: string; readonly at: string } | null {
  if (task.state !== 'running' && task.state !== 'claimed') return null;
  const attempt = task.attempts.at(-1);
  const record = workers.find(
    (worker) => worker.record.id === attempt?.session,
  )?.record;
  const last = record?.events.filter((event) => event.kind !== 'status').at(-1);
  if (last) return { text: lead(nowText(last), 110), at: last.at };
  return task.state === 'claimed' && attempt
    ? { text: 'Preparing the task folder', at: attempt.startedAt }
    : null;
}

/** Whose turn it is in a task, and whether the turn is the person's. */
function taskTurn(
  task: TaskRecord,
  all: readonly TaskRecord[],
  coordinator: CoordinatorView | null | undefined,
): [string, boolean] {
  const coordinated = !!coordinator?.state && !coordinator.state.stoppedAt;
  const waiting = task.assignment.dependencies.filter(
    (id) => all.find((entry) => entry.id === id)?.state !== 'done',
  );
  switch (task.state) {
    case 'open':
      if (isDraft(task)) return ['Draft, waits for you', true];
      return waiting.length
        ? [
            waiting.length === 1
              ? `Waits for ${all.find((entry) => entry.id === waiting[0])?.assignment.title ?? waiting[0]}`
              : `Waits for ${waiting.length} tasks`,
            false,
          ]
        : [coordinated ? 'Not started' : 'Ready to start', !coordinated];
    case 'claimed':
      return ['Starting', false];
    case 'running':
      return ['Working', false];
    case 'review': {
      const review = reviewOf(task, coordinator);
      return (review ? !review.yours : coordinated)
        ? ['The coordinator reviews it', false]
        : ['Waits for your review', true];
    }
    case 'done':
      return ['Done', false];
    case 'cancelled':
      return ['Cancelled', false];
  }
}

/** A task that the person can clear from the map: done or cancelled. */
function finished(task: TaskRecord): boolean {
  return task.state === 'done' || task.state === 'cancelled';
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
  needs: readonly Need[],
  hideFinished = false,
): string {
  const tasks = hideFinished
    ? view.list.filter((task) => !finished(task))
    : view.list;
  const state = live.coordinator?.state;
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
    const [turn, yours] = taskTurn(task, tasks, live.coordinator);
    const attempt = task.attempts.at(-1);
    const version = attempt?.versions.at(-1);
    const time =
      task.state === 'running' && attempt
        ? `For ${duration(attempt.startedAt)}`
        : version
          ? `Version ${version.number}${version.decision ? `, ${version.decision.kind === 'accepted' ? 'accepted' : version.decision.kind === 'changes' ? 'changes asked' : 'rejected'}` : ', in review'}`
          : '';
    const raised = needs.filter((item) => item.task === task.id).length;
    // An arrow comes from each task that the map shows. A cleared one leaves no arrow.
    const shownFrom = task.assignment.dependencies.filter((id) =>
      tasks.some((other) => other.id === id),
    );
    const from = shownFrom.length ? shownFrom.join(' ') : 'objective';
    // The page moves a dot with these words along the arrows of a task that just ended.
    const gives = task.state === 'done' ? handoffWords(task) : '';
    return `<button type="button" class="map-box" data-task-select="${e(task.id)}" data-node="${e(task.id)}" data-state="${task.state}"${isDraft(task) ? ' data-draft' : ''} data-host="${e(task.assignment.host)}"${gives ? ` data-gives="${e(gives)}"` : ''} data-from="${e(from)}"><span class="map-title"><span class="mark ${taskMarks[task.state]}" aria-hidden="true"></span>${e(task.assignment.title)}${state && task.assignment.host !== state.host ? `<span class="host-chip">${e(hostName(task.assignment.host))}</span>` : ''}</span><span class="map-turn${yours || raised ? ' yours' : ''}">${e(raised && !yours ? `${raised} ${raised === 1 ? 'item needs' : 'items need'} you` : turn)}</span>${time ? `<span class="map-meta">${e(time)}</span>` : ''}</button>`;
  };
  // A running box pulses in the color of its harness. The legend names the colors when the team mixes harnesses.
  const hosts = [...new Set(tasks.map((task) => task.assignment.host))].sort(
    (a, b) => Number(b === state?.host) - Number(a === state?.host),
  );
  const legend =
    hosts.length > 1
      ? `<p class="map-legend" aria-hidden="true">${hosts.map((host) => `<span class="map-key" data-host="${e(host)}">${e(hostName(host))}</span>`).join('')}</p>`
      : '';
  return `${legend}<div class="map" data-map><div class="map-col"><div class="map-root" data-node="objective"><span class="map-label">Objective</span><span class="map-title">${e(lead(objective, 140))}</span></div></div>${Array.from(
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

/**
 * Who works now: each task agent that runs or waits for review, with its
 * harness, its time, its latest step, and one action. At most four rows show;
 * the rest fold.
 */
function renderNowStrip(view: TaskView, live: DeskSession): string {
  const workers = live.workers ?? (live.session ? [live.session] : []);
  const order = { running: 0, claimed: 0, review: 1 } as const;
  const rows = view.list
    .filter(
      (task): task is TaskRecord & { state: keyof typeof order } =>
        task.state in order,
    )
    .sort((a, b) => order[a.state] - order[b.state]);
  const sessions = plainSessions(live);
  const reviewing = rows.filter((task) => task.state === 'review').length;
  const working = rows.length - reviewing + sessions.length;
  const row = (task: TaskRecord): string => {
    const attempt = task.attempts.at(-1);
    const version = attempt?.versions.at(-1);
    const step = lastStep(task, workers);
    const [turn, yours] = taskTurn(task, view.list, live.coordinator);
    const busy = task.state !== 'review';
    // A quiet agent keeps its latest step, with the time since it.
    const quiet =
      step && Date.now() - Date.parse(step.at) >= 5 * 60_000
        ? `Last update ${duration(step.at)} ago`
        : '';
    const line = busy
      ? (step?.text ?? 'Working')
      : version && !version.decision
        ? yours
          ? `Version ${version.number} waits for your review`
          : `The coordinator reviews version ${version.number}`
        : turn;
    const action = busy
      ? attempt?.session
        ? `<button type="button" data-message-to="${e(task.id)}">Message</button>`
        : ''
      : `<button type="button"${yours ? ' class="primary"' : ''} data-task-select="${e(task.id)}">Review</button>`;
    return `<li class="now-row" data-state="${task.state}" data-host="${e(task.assignment.host)}"><span class="mark ${taskMarks[task.state]}" aria-hidden="true"></span><div class="now-main"><p class="now-head"><button type="button" class="row-button" data-task-select="${e(task.id)}">${e(task.assignment.title)}</button><span class="now-meta">${e(hostName(task.assignment.host))}${busy && attempt ? `, ${e(duration(attempt.startedAt))}` : ''}</span></p><p class="now-step${!busy && yours ? ' yours' : ''}">${e(line)}${quiet ? ` <span class="now-quiet">${e(quiet)}</span>` : ''}</p></div>${action}</li>`;
  };
  const session = (view: SessionView): string => {
    const { record } = view;
    const last = record.events
      .filter((event) => event.kind !== 'status')
      .at(-1);
    return `<li class="now-row" data-state="${record.status === 'idle' ? 'idle' : 'running'}" data-host="${e(record.host)}"><span class="mark ${record.status === 'idle' ? 'open' : 'working'}" aria-hidden="true"></span><div class="now-main"><p class="now-head"><button type="button" class="row-button" data-worker="${e(record.id)}">${e(sessionName(record))}</button><span class="now-meta">${e(modeLabel(record))}, ${e(duration(record.startedAt))}</span></p><p class="now-step">${e(record.status === 'idle' ? 'Waits for your next message' : last ? lead(nowText(last), 110) : 'Working')}</p></div><button type="button" data-message-to="session:${e(record.id)}">Message</button></li>`;
  };
  const list = [...rows.map(row), ...sessions.map(session)];
  const count = [
    working
      ? `${working} ${working === 1 ? 'agent works' : 'agents work'}`
      : '',
    reviewing
      ? `${reviewing} ${reviewing === 1 ? 'version waits' : 'versions wait'} for review`
      : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `<section class="card now-strip" aria-labelledby="now-title"><div class="section-title"><h2 id="now-title">Now</h2>${count ? `<span class="count">${e(count)}</span>` : ''}</div>${
    list.length
      ? `<ul class="now-list">${list.slice(0, 4).join('')}</ul>${list.length > 4 ? `<details id="now-more"><summary>${list.length - 4} more</summary><ul class="now-list">${list.slice(4).join('')}</ul></details>` : ''}`
      : '<p class="empty-note">No agent works now.</p>'
  }</section>`;
}

function fileCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** The done tasks, newest first, with the version and the files that the project got. */
function renderFinished(tasks: readonly TaskRecord[]): string {
  const done = tasks
    .filter((task) => task.state === 'done')
    .map((task) => ({ task, artifact: task.artifacts?.at(-1) }))
    .sort((a, b) =>
      (b.artifact?.at ?? b.task.updatedAt).localeCompare(
        a.artifact?.at ?? a.task.updatedAt,
      ),
    );
  if (!done.length) return '';
  const row = ({ task, artifact }: (typeof done)[number]): string =>
    `<li><span class="mark done" aria-hidden="true"></span><div><button type="button" class="row-button" data-task-select="${e(task.id)}">${e(task.assignment.title)}</button><p class="fine">${artifact ? `Version ${artifact.version} accepted at ${e(clock(artifact.at))}, ${fileCount(artifact.files.length)}` : 'Done'}</p></div></li>`;
  return `<section class="card" aria-labelledby="finished-title"><div class="section-title"><h2 id="finished-title">Finished</h2><span class="count">${done.length} ${done.length === 1 ? 'task' : 'tasks'}</span></div><ul class="finished">${done.slice(0, 6).map(row).join('')}</ul>${done.length > 6 ? `<details id="finished-more"><summary>${done.length - 6} more</summary><ul class="finished">${done.slice(6).map(row).join('')}</ul></details>` : ''}</section>`;
}

/** Work: who works now, the map of the tasks, and the finished work. A box opens the task. */
function renderTasksView(
  view: TaskView,
  live: DeskSession,
  objective: string,
  offerCoordinator: boolean,
  needs: readonly Need[],
  hideFinished: boolean,
): string {
  const cleared = view.list.filter(finished).length;
  const clear = cleared
    ? `<button type="button" class="quiet" data-finished="${hideFinished ? 'shown' : 'hidden'}">${hideFinished ? `Show finished (${cleared})` : 'Clear finished'}</button>`
    : '';
  const done = view.list.filter((task) => task.state === 'done').length;
  return `<div class="view wide"><div class="view-head"><h1 id="view-title" tabindex="-1">Work</h1><button type="button" class="quiet" data-panel="new-task">Write a task yourself</button></div>
  ${
    view.list.length || plainSessions(live).length
      ? renderNowStrip(view, live)
      : ''
  }${
    view.list.length
      ? `<section class="card map-card" aria-labelledby="map-title"><div class="section-title"><h2 id="map-title">The map</h2><span class="count">${view.list.length} ${view.list.length === 1 ? 'task' : 'tasks'}, ${done} done</span>${clear}</div>${renderMap(view, live, objective, needs, hideFinished)}${hideFinished && cleared ? `<p class="fine">${cleared} finished ${cleared === 1 ? 'task is' : 'tasks are'} not on the map. Finished lists the done ones.</p>` : ''}</section>${renderFinished(view.list)}`
      : '<section class="card empty-state"><h2>No tasks yet</h2><p class="fine">After you choose a direction, the coordinator plans tasks for it. You can also write to the coordinator in the message box.</p></section>'
  }
  ${offerCoordinator ? '<section class="card"><h2>Coordinator</h2><p class="fine">After you choose a direction, the coordinator plans the tasks for it. You can also start it now with your own objective.</p><div class="actions"><button type="button" data-panel="coordinator">Open the coordinator</button></div></section>' : ''}</div>`;
}

/** One tool call in the audit, with the agent that asked for it. */
interface AuditRow {
  readonly command: CommandEntry;
  readonly view: SessionView;
  /** The same untagged call with the same result, one after the other, such as a pod job check, shows once. */
  readonly times: number;
}

/** The latest 200 commands and every tagged command, newest first. A tagged command never drops out of the audit. */
function auditRows(views: readonly SessionView[]): AuditRow[] {
  const all = views
    .flatMap((view) =>
      view.record.commands.map((command) => ({ command, view, times: 1 })),
    )
    .sort((a, b) => b.command.at.localeCompare(a.command.at));
  const latest = new Set(all.slice(0, 200));
  const rows: AuditRow[] = [];
  for (const row of all.filter(
    (entry) => latest.has(entry) || entry.command.risk.length > 0,
  )) {
    const last = rows.at(-1);
    if (
      last &&
      last.view === row.view &&
      !row.command.risk.length &&
      !last.command.risk.length &&
      last.command.tool === row.command.tool &&
      last.command.action === row.command.action &&
      result(last.command) === result(row.command)
    )
      rows[rows.length - 1] = { ...last, times: last.times + 1 };
    else rows.push(row);
  }
  return rows.slice(0, 700);
}

const auditFilter =
  '<div class="seg" role="group" aria-label="Commands to show"><button type="button" data-records="all">All commands</button><button type="button" data-records="tagged">Tagged only</button></div>';

/**
 * The tool calls of the agents, with who let each one run. A tag comes from the
 * command text and asks for no decision, so the audit stays off Home and the rail.
 */
function auditTable(
  views: readonly SessionView[],
  tasks: readonly TaskRecord[],
  withAgent: boolean,
): string {
  const rows = auditRows(views);
  const total = views.reduce(
    (sum, view) => sum + view.record.commands.length,
    0,
  );
  const tagged = views.reduce(
    (sum, view) =>
      sum +
      view.record.commands.filter((command) => command.risk.length).length,
    0,
  );
  const head = `<thead><tr><th scope="col">Time</th>${withAgent ? '<th scope="col">Agent</th>' : ''}<th scope="col">Command</th><th scope="col">Approved by</th><th scope="col">Tags</th><th scope="col">Result</th><th scope="col">Review</th></tr></thead>`;
  // The 20 latest stay in view. The other tagged ones and the older ones fold, each under its count.
  const inView = rows.slice(0, 20);
  const older = rows.slice(20);
  const taggedOlder = older.filter((row) => row.command.risk.length > 0);
  const plainOlder = older.filter((row) => !row.command.risk.length);
  const counts = new Map<string, number>();
  for (const view of views)
    for (const command of view.record.commands)
      for (const tag of command.risk)
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const byTag = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => `${tag} ${count}`)
    .join(', ');
  const table = (list: readonly AuditRow[]): string =>
    `<div class="table"><table class="audit">${head}<tbody>${list.map(auditRow).join('')}</tbody></table></div>`;
  return `<div class="section-title">${auditFilter}<span class="count">${total} recorded, ${tagged} tagged${byTag ? `: ${e(byTag)}` : ''}</span></div><p class="fine">Tags come from the command text alone. They mark commands worth a look, not findings. Each row is a command that an agent asked for, not every process that it started.</p>${tagged ? '' : '<p class="fine tagged-none">No command has a tag.</p>'}${table(inView)}${taggedOlder.length ? `<details id="audit-tagged"><summary>${taggedOlder.length} older tagged ${taggedOlder.length === 1 ? 'command' : 'commands'}</summary>${table(taggedOlder)}</details>` : ''}${plainOlder.length ? `<details id="audit-more"><summary>${plainOlder.length} older ${plainOlder.length === 1 ? 'command' : 'commands'} without a tag</summary>${rows.length < total ? '<p class="fine">This list holds the latest 200 commands and every tagged one.</p>' : ''}${table(plainOlder)}</details>` : ''}`;

  function auditRow({ command, view, times }: AuditRow): string {
    const { record } = view;
    return `<tr${command.risk.length ? ' class="tagged"' : ''}><td>${e(clock(command.at))}</td>${withAgent ? `<td><span class="agent-name" title="${e(workerName(record, tasks))}">${e(workerName(record, tasks))}</span>${record.task ? `<span class="fine">${e(hostName(record.host))}</span>` : ''}</td>` : ''}<td><span class="audit-tool">${e(toolName(command.tool))}</span><code>${e(command.action.length > 300 ? `${command.action.slice(0, 300)}…` : command.action || 'Not reported')}</code>${times > 1 ? `<span class="fine">${times} times, the latest at ${e(clock(command.at))}</span>` : ''}${command.review?.rationale ? `<span class="fine">Reviewer: ${e(command.review.rationale)}</span>` : ''}</td><td data-label="Approved by">${e(decisionLabel(command, record.host))}</td><td data-label="Tags">${command.risk.length ? command.risk.map((tag) => `<span class="risk">${e(tag)}</span>`).join(' ') : '<span class="fine">None</span>'}</td><td data-label="Result">${e(result(command))}</td><td data-label="Review">${needsReview(command) ? `<button type="button" data-action="review" data-command="${e(command.id)}">Mark reviewed</button>` : command.reviewedAt ? 'Reviewed' : '<span class="fine">Not needed</span>'}</td></tr>`;
  }
}

/** Results: the checks of the chosen direction with their results, then the answer and the sign-off. */
function renderResultsView(workspace: Workspace, live: DeskSession): string {
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  const head = `<div class="view-head"><h1 id="view-title" tabindex="-1">Answer</h1><p>${idea ? `Direction: ${e(idea.title)}` : 'No direction yet'}</p></div>`;
  if (!idea)
    return `<div class="view">${head}<section class="card empty-state"><h2>No direction yet</h2><p class="fine">The answer shows here after you choose a direction and the team works on it.</p></section></div>`;
  const results = resultsOf(workspace, live);
  const answer = results?.answer;
  const open = (results?.checks ?? []).filter(
    (entry) => entry.result === 'judgement' && !entry.ruling,
  ).length;
  const checks = idea.gates
    .map((gate, index) => {
      const entry = results?.checks.find((saved) => saved.check === index + 1);
      const outcome = entry?.ruling?.result ?? entry?.result;
      // The name of the check leads. A long rule folds after its first lines.
      const [, name = '', rule = gate] =
        /^([^:\n]{1,60}):\s*([\s\S]*)$/.exec(gate) ?? [];
      return `<li class="check-row" data-result="${outcome ?? 'none'}"><span class="check-num">${index + 1}</span><div class="check-body">${name ? `<p class="check-name">${e(name)}</p>` : ''}<div class="check-text">${more(`check-text-${index + 1}`, rule, 200)}</div>${
        entry
          ? `<p class="check-value"><span class="tag reading">The coordinator says</span> ${e(entry.value)}</p><p class="fine">Evidence: ${entry.evidence.map((path) => `<code>${e(path)}</code>`).join(' ')}</p>${disputeNotes(entry, live.tasks?.list ?? [], live.tasks?.messages ?? [])}<div class="why"><span class="tag reading">The coordinator's reason</span>${more(`check-reason-${index + 1}`, entry.reason, 120)}</div>${entry.ruling ? `<p class="ruling">You ruled: ${e(outcomeLabels[entry.ruling.result].toLowerCase())}. ${e(entry.ruling.reason)}</p>` : entry.result === 'judgement' ? `<p class="ruling-question"><strong>${e(entry.question ?? 'It needs your judgement.')}</strong></p>${judgementForm(entry)}` : ''}`
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
        : `<div class="sign-off">${open ? `<p class="notice">Settle the ${open} open ${open === 1 ? 'judgement' : 'judgements'} below first.</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="coordinator-answer" data-decision="accepted"${open ? ' disabled' : ''}>Accept the answer</button></div><label class="field" for="answer-note">What more work is needed</label><textarea id="answer-note" rows="3" maxlength="4000"></textarea><div class="actions"><button type="button" data-action="coordinator-answer" data-decision="more">Ask for more work</button></div></div>`;
  // The answer leads. The checks under it show what it rests on.
  return `<div class="view">${head}
  ${
    answer
      ? `<section class="card answer" aria-labelledby="answer-title"><div class="section-title"><h2 id="answer-title">The answer</h2><span class="tag reading">Proposed by the coordinator</span></div><p class="statement">${e(answer.statement)}</p><ol class="claims">${answer.claims.map((claim) => `<li><p>${e(claim.text)}</p>${claim.evidence.length ? `<p class="fine">Evidence: ${claim.evidence.map((item) => (/^https?:\/\//.test(item) ? link(item) : `<code>${e(item)}</code>`)).join(' ')}</p>` : ''}</li>`).join('')}</ol>${signOff}</section>`
      : '<section class="card"><h2>The answer</h2><p class="fine">The coordinator proposes the answer when the checks have results. You sign it off here.</p></section>'
  }
  <section class="card" aria-labelledby="checks-title"><div class="section-title"><h2 id="checks-title">The checks</h2><span class="count">${results?.checks.length ?? 0} of ${idea.gates.length} reported</span></div><ol class="checks">${checks}</ol><p class="fine">Each result points to accepted files. The values and reasons come from the coordinator, so compare them with the files.</p></section></div>`;
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

/** What a pod is for: the titles of its tasks, or its lab directions. */
function podFor(lease: Lease, tasks: readonly TaskRecord[]): string {
  if (lease.directions?.length)
    return `The lab's ${lease.directions.join(', ')}`;
  return lease.tasks.length
    ? lease.tasks.map((task) => sender(task, tasks)).join(', ')
    : 'No task';
}

/** "You asked", or "The coordinator asks", for a lease request. */
function asks(lease: Lease): string {
  return `${asker(lease)} ${lease.requestedBy === 'person' ? 'asked' : 'asks'}`;
}

/** The pods card: what is spent and reserved, the open leases with their controls, and earlier leases. */
function renderPods(
  compute: ComputeView,
  tasks: readonly TaskRecord[],
): string {
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
    return `<tr data-state="${lease.state}"><th scope="row">${e(podFor(lease, tasks))}</th><td>${e(lease.gpu)}</td><td>${e(leaseStates[lease.state])}${idle >= 5 ? `<span class="fine">Idle ${idle} min</span>` : ''}</td><td>${usd(spent(lease, now))}${isRunning(lease) ? `<span class="fine">${usd(lease.rate + diskRate(lease.diskGb))} per hour</span>` : ''}</td><td>${lease.deadline && isOpen(lease) ? e(since(lease.deadline)) : lease.end ? e(lease.end.reason) : '—'}</td><td class="row-actions">${actions}</td></tr>`;
  };
  const current = compute.leases.filter(
    (lease) => isOpen(lease) || lease.state === 'requested',
  );
  const earlier = compute.leases.filter((lease) => !current.includes(lease));
  const head =
    '<thead><tr><th scope="col">For</th><th scope="col">GPU</th><th scope="col">Status</th><th scope="col">Cost so far</th><th scope="col">Ends</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>';
  return `<section class="card" aria-labelledby="pods-title"><div class="section-title"><h2 id="pods-title">Pods</h2>${budget.rate ? `<span class="count">${usd(budget.rate)} per hour now</span>` : ''}</div>
  ${settings.limitUsd === null ? '' : `<p>Spent ${usd(budget.spent)}. Held for running pods ${usd(budget.reserved)}. Left ${usd(Math.max(0, budget.left ?? 0))} of ${usd(settings.limitUsd)}.</p>`}
  ${compute.problem ? `<p class="notice">${e(compute.problem.text)} (${e(since(compute.problem.at))})</p>` : ''}
  ${current.length ? `<div class="table"><table class="leases">${head}<tbody>${[...current].reverse().map(row).join('')}</tbody></table></div>` : `<p class="fine">No pod runs. The coordinator asks for a pod when a task needs a GPU. ${compute.settings.askBeforePod ? 'You approve each pod in Needs you.' : 'A pod that fits your limits starts at once. Other requests wait for you in Needs you.'}</p>`}
  ${earlier.length ? `<details id="earlier-leases"><summary>Earlier pods (${earlier.length})</summary><div class="table"><table class="leases">${head}<tbody>${[...earlier].reverse().slice(0, 30).map(row).join('')}</tbody></table></div></details>` : ''}
  <p class="fine">Cost counts every minute that a pod runs, disk included. If RunPod bills more, Verifold shows RunPod's figure.</p></section>`;
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

/** Pod secrets: the stored names, a form for a new one, and the requests that wait for one. */
function renderSecrets(
  compute: ComputeView,
  tasks: readonly TaskRecord[],
): string {
  const waiting = compute.leases.filter(
    (lease) =>
      lease.state === 'requested' && missingSecrets(lease, compute).length,
  );
  const missing = [
    ...new Set(waiting.flatMap((lease) => missingSecrets(lease, compute))),
  ];
  const form = `<div class="fields"><label class="field" for="secret-name">Name<input id="secret-name" type="text" autocomplete="off" spellcheck="false" maxlength="64" pattern="[A-Z][A-Z0-9_]*" value="${e(missing[0] ?? '')}" placeholder="HF_TOKEN"></label><label class="field" for="secret-value">Value<input id="secret-value" type="password" autocomplete="off" spellcheck="false" maxlength="1024"></label></div>
  ${compute.keyring ? `<label class="check" for="secret-file"><input type="checkbox" id="secret-file"> Keep it in a private file instead of ${e(placeNames[compute.keyring])}</label>` : ''}
  <div class="actions"><button type="button" class="primary" data-action="compute-secret-save"${compute.keyring ? '' : ' data-file="always"'}>Save the secret</button></div>`;
  const list = compute.secrets.length
    ? `<ul class="secrets">${compute.secrets.map((secret) => `<li><span><code>${e(secret.name)}</code> <span class="fine">in ${e(placeNames[secret.place])}, saved ${e(since(secret.savedAt))}</span></span><button type="button" data-action="compute-secret-remove" data-secret="${e(secret.name)}" data-confirm="Click again to remove ${e(secret.name)}">Remove</button></li>`).join('')}</ul>`
    : '';
  return `<section class="card${missing.length ? ' lead' : ''}" aria-labelledby="secrets-title"><h2 id="secrets-title">Secrets for pods</h2>
  ${missing.length ? `<p>${waiting.length === 1 ? 'The pod' : 'The pods'} for ${e(waiting.map((lease) => podFor(lease, tasks)).join(' and '))} ${waiting.length === 1 ? 'waits' : 'wait'} for ${missing.map((name) => `<code>${e(name)}</code>`).join(' and ')}.</p>` : compute.secrets.length ? '' : '<p class="fine">A pod gets a secret, such as an HF_TOKEN for gated models, only when its request names it.</p>'}
  ${list}
  ${missing.length ? form : `<details id="secret-add"><summary>Add a secret</summary>${form}</details>`}
  <p class="fine">Agents never see the values. Verifold hides them in the output of pod commands. Use a token with the least access that the work needs, such as a read-only token.</p></section>`;
}

/** Compute: the RunPod key, the limits that only the person sets, and the GPUs that leases can use. */
function renderComputeView(
  compute: ComputeView,
  tasks: readonly TaskRecord[],
  agents: number,
): string {
  const { key, settings, gpus } = compute;
  const agentsCard = `<section class="card" aria-labelledby="agents-title"><h2 id="agents-title">Agents at once</h2><p>Up to ${agents} ${agents === 1 ? 'agent runs' : 'agents run'} tasks and sessions at the same time. Each agent uses your Claude Code or Codex plan, so more agents reach the plan's usage limit sooner.</p><details id="agents-edit"><summary>Change it</summary><label class="field" for="team-agents">Agents at once, 1 to 8<input id="team-agents" type="number" min="1" max="8" step="1" value="${agents}"></label><div class="actions"><button type="button" data-action="compute-agents">Save</button></div></details></section>`;
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
  // The spend limit leads. The other limits fold, and they stay in the page, so each save sends them all.
  const limitsForm = `<div class="fields">${number('compute-limit', 'Spend limit for this project, USD', settings.limitUsd, 1, 10_000)}</div>
  <details id="compute-more" class="more-fields"><summary>More limits</summary>
  <div class="fields">${number('compute-rate', 'Highest rate of one pod, USD per hour', settings.maxUsdPerHour, 0.1, 50, 0.01)}${number('compute-hours', 'Hours for one pod, at most', settings.maxHoursPerLease, 1, 24)}${number('compute-idle', 'Stop an idle pod after, in minutes', settings.idleMinutes, 5, 240)}<label class="field" for="compute-pods">Pods at the same time<select id="compute-pods"><option value="1"${settings.maxRunningPods === 1 ? ' selected' : ''}>1</option><option value="2"${settings.maxRunningPods === 2 ? ' selected' : ''}>2</option></select></label>${number('compute-disk', 'Disk of each pod, GB', settings.diskGb, 10, 500)}</div>
  <label class="field" for="compute-images">RunPod images that pods can use, one on each line</label><textarea id="compute-images" rows="2" maxlength="2000">${e(settings.images.join('\n'))}</textarea>
  <label class="check" for="compute-ask"><input type="checkbox" id="compute-ask"${settings.askBeforePod ? ' checked' : ''}> Ask me before each pod starts</label>
  <p class="fine">If this is off, a pod that fits these limits starts as soon as the coordinator asks, even while you're away. You can stop it in Compute.</p></details>
  <div class="actions"><button type="button" class="primary" data-action="compute-settings">Save the limits</button></div>
  <p class="fine">Only you can change these limits. RunPod erases the disk of a pod when the pod stops.</p>`;
  const head = `<div class="view-head"><h1 id="view-title" tabindex="-1">Compute</h1><p>GPU pods on RunPod for your tasks</p></div>`;
  const keyLine = key
    ? `<section class="card" aria-labelledby="key-title"><h2 id="key-title">RunPod key</h2>${keyCard}</section>`
    : '';
  // Setup asks one thing at a time: the key, then the spend limit, then the GPUs.
  const step = !key
    ? 1
    : settings.limitUsd === null
      ? 2
      : settings.gpuTypes.length
        ? 0
        : 3;
  const later = (from: number): string =>
    `<ol class="later-steps" start="${from}">${[
      'Set a spend limit',
      'Choose the GPUs that pods can use',
    ]
      .slice(from - 2)
      .map((text) => `<li>${text}</li>`)
      .join('')}</ol>`;
  if (step === 1)
    return `<div class="view">${head}<section class="card lead" aria-labelledby="setup-title"><p class="step-count">Step 1 of 3</p><h2 id="setup-title">Store a RunPod key</h2><p>Pods run on your RunPod account. Verifold needs a key to start and stop them.</p>${keyForm(compute.keyring)}${later(2)}</section>${agentsCard}</div>`;
  if (step === 2)
    return `<div class="view">${head}<section class="card lead" aria-labelledby="setup-title"><p class="step-count">Step 2 of 3</p><h2 id="setup-title">Set a spend limit</h2><p>Pods stay off until you set one. Verifold stops every pod before this project spends more.</p>${limitsForm}${later(3)}</section>${keyLine}${agentsCard}</div>`;
  if (step === 3)
    return `<div class="view">${head}<section class="card lead" aria-labelledby="setup-title"><p class="step-count">Step 3 of 3</p><h2 id="setup-title">Choose the GPUs that pods can use</h2>${gpuCard}<details id="compute-limits-edit"><summary>Change the limits</summary>${limitsForm}</details></section>${keyLine}${agentsCard}</div>`;
  const allowed = settings.gpuTypes
    .map((id) => `<code>${e(id)}</code>`)
    .join(', ');
  return `<div class="view">${head}
  ${compute.leases.some((lease) => lease.state === 'requested' && missingSecrets(lease, compute).length) ? renderSecrets(compute, tasks) : ''}
  ${renderPods(compute, tasks)}
  <section class="card" aria-labelledby="limits-title"><h2 id="limits-title">Limits</h2><p>Up to ${usd(settings.limitUsd ?? 0)} for this project, ${usd(settings.maxUsdPerHour)} per hour for one pod, ${settings.maxHoursPerLease} ${settings.maxHoursPerLease === 1 ? 'hour' : 'hours'} for one pod. ${settings.askBeforePod ? 'You approve each pod.' : 'A pod inside these limits starts without asking.'}</p><details id="compute-limits-edit"><summary>Change the limits</summary>${limitsForm}</details></section>
  <section class="card" aria-labelledby="gpus-title"><h2 id="gpus-title">GPUs</h2><p>Pods can use ${allowed}.</p><details id="compute-gpus-edit"${gpus ? ' open' : ''}><summary>Change the GPUs</summary>${gpuCard}</details></section>
  ${compute.leases.some((lease) => lease.state === 'requested' && missingSecrets(lease, compute).length) ? '' : renderSecrets(compute, tasks)}
  ${keyLine}
  ${agentsCard}</div>`;
}

/** The record of this owner: every worker's commands, then every research attempt. */
/** A size in bytes, in the largest unit that keeps a whole number in front. */
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** This run and the archived ones: Start over moves the run to the archive, and Restore brings one back. */
function renderRuns(
  archives: readonly ArchivedRun[],
  tasks: readonly TaskRecord[],
): string {
  return `<section class="card" aria-labelledby="runs-title"><div class="section-title"><h2 id="runs-title">Runs</h2><span class="count">${archives.length} archived</span></div>
  <div class="run-now"><p><strong>This run</strong> <span class="fine">${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}</span></p><p class="fine">Start over archives this run and starts research again from the same question. Nothing is deleted.</p><details id="run-parts"><summary>What moves and what stays</summary><p class="fine">The tasks and their versions, the messages, the coordinator and its log, the results, the research attempts, and the session records move to the archive. The question, the brief, your settings, the memory, and the files that you accepted into the project stay.</p></details><div class="actions"><button type="button" data-action="start-over" data-confirm="Click again to archive this run and start over">Start over</button></div></div>
  ${archives.length ? `<ul class="archives">${archives.map((run) => `<li><span><strong>${e(time(run.at))}</strong>${run.direction ? ` ${e(run.direction)}` : ''} <span class="fine">${run.tasks} ${run.tasks === 1 ? 'task' : 'tasks'}, ${e(bytes(run.bytes))}</span></span><button type="button" data-action="restore" data-archive="${e(run.id)}" data-confirm="Click again to restore this run">Restore</button></li>`).join('')}</ul><p class="fine">Restore brings an archived run back. The current run moves to the archive first, so nothing is lost.</p>` : ''}</section>`;
}

function renderRecords(
  snapshot: DeskSnapshot,
  workers: readonly SessionView[],
  tasks: readonly TaskRecord[],
  messages: readonly Message[],
  shown: string | undefined,
  archives: readonly ArchivedRun[] | undefined,
): string {
  const { attempts } = snapshot;
  const logged = workers.filter((worker) => worker.record.commands.length);
  return `<div class="view"><div class="view-head"><h1 id="view-title" tabindex="-1">Records</h1><p>Messages, commands, research, and earlier runs</p></div>
  ${renderFeed(messages, tasks)}
  <section class="card commands" aria-labelledby="commands-title"><h2 id="commands-title">Commands</h2>${logged.length ? auditTable(logged, tasks, true) : '<p class="empty-note">No commands yet.</p>'}</section>
  <section class="card history" aria-labelledby="history-title"><div class="section-title"><h2 id="history-title">Research attempts</h2><span class="count">${attempts.length}</span></div>${snapshot.historyLimited ? '<p class="notice">This list shows the latest 200 research steps. The project files keep all of them.</p>' : ''}${attempts.length ? `<ol>${attempts.map((attempt) => `<li><button type="button" data-attempt="${e(attempt.id)}" aria-pressed="${attempt.id === shown}"><span class="attempt-title">${e(attempt.record ? phaseLabel(attempt.record.phase) : 'Unrecorded attempt')}</span><span class="attempt-status">${e(outcome(attempt))}</span><span class="attempt-reference">${e(attempt.id.slice(0, 8))}${attempt.record ? ` <time datetime="${e(attempt.record.startedAt)}">${e(time(attempt.record.startedAt))}</time>` : ''}</span></button></li>`).join('')}</ol>` : '<p class="empty-note">Each research step shows here.</p>'}</section>${archives ? `${renderRuns(archives, tasks)}<section class="card" aria-labelledby="memory-title"><h2 id="memory-title">Project memory</h2><p>Verifold keeps <code>memory/</code> in your project folder: <code>README.md</code> (read first), <code>progress.md</code>, <code>decisions.md</code>, <code>findings.md</code>, <code>notes.md</code>, and one file for each task under <code>tasks/</code>.</p><p class="fine">Every agent starts from <code>README.md</code>, also after Start over. Verifold rewrites only the part between its markers. Your own text outside them stays.</p></section>` : ''}</div>`;
}

/** The summary and the sources of one research report. Source links are validated before rendering. */
function findingsBody(report: ResearchReport, attempt: string): string {
  const source = (item: ResearchReport['sources'][number], index: number) =>
    `<li><a id="source-${e(attempt)}-${index}" href="${e(item.url)}" target="_blank" rel="noopener noreferrer">${e(item.title)}</a><span>${e(new URL(item.url).hostname)}</span></li>`;
  const rest = report.sources.slice(5);
  return `<div class="prose">${moreMd(`findings-${attempt}`, report.summary, 400)}</div><ol class="sources">${report.sources.slice(0, 5).map(source).join('')}</ol>${rest.length ? `<details id="sources-${e(attempt)}"><summary>All ${report.sources.length} sources</summary><ol class="sources" start="6">${rest.map((item, index) => source(item, index + 5)).join('')}</ol></details>` : ''}<details id="delegation"><summary>How research split the work</summary><div class="prose md">${markdownHtml(report.delegation)}</div></details><p class="fine">Each link shows where a claim came from. Read the source before you rely on the claim.</p>`;
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

/** The plan of the chosen direction waits for the person: the work has not started, and no research step runs. */
function redraftable(workspace: Workspace, live: DeskSession): boolean {
  const state = live.coordinator?.state;
  return (
    live.research !== undefined &&
    !live.research.running &&
    !!workspace.selectedId &&
    !(state && !state.stoppedAt && state.planApproved)
  );
}

/** The work on the chosen direction started, and no research step runs, so the direction can change. */
function changeable(workspace: Workspace, live: DeskSession): boolean {
  const state = live.coordinator?.state;
  return (
    live.research !== undefined &&
    !live.research.running &&
    !!workspace.selectedId &&
    !!state &&
    !state.stoppedAt &&
    state.planApproved
  );
}

/** How a direction relates to the plan. */
function directionRole(
  idea: Candidate,
  workspace: Workspace,
  live: DeskSession,
): string {
  if (idea.id === workspace.selectedId)
    return redraftable(workspace, live) ? 'In the plan' : 'Chosen';
  return idea.kind === 'main'
    ? 'Recommended'
    : idea.kind === 'extra'
      ? 'Add-on'
      : idea.kind === 'alternative'
        ? 'Alternative'
        : 'Proposed';
}

/**
 * The plan that waits for the person: the direction, its checks, and the
 * tasks that the coordinator drafted, with one approval that starts the work.
 */
function renderPlanCard(workspace: Workspace, live: DeskSession): string {
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  const view = live.coordinator;
  const state = view?.state;
  if (!idea || !state || state.stoppedAt || state.planApproved) return '';
  const all = live.tasks?.list ?? [];
  const drafted = all.filter(
    (task) =>
      task.assignment.by === 'coordinator' && task.state !== 'cancelled',
  );
  const status = view.session?.record.status;
  const drafting = status === 'running' || status === 'starting';
  const others = workspace.candidates.filter(
    (candidate) => candidate.id !== idea.id,
  );
  const extras = drafted.filter((task) => task.assignment.extra);
  // The coordinator ends its draft turn with a summary for the person.
  const summary = drafting
    ? undefined
    : view.session?.record.events.findLast((event) => event.kind === 'agent')
        ?.text;
  const line = (task: TaskRecord): string =>
    `<strong>${e(task.assignment.title)}</strong> <span class="fine">${e(hostName(task.assignment.host))}${task.assignment.dependencies.length ? `, after ${e(task.assignment.dependencies.map((id) => sender(id, all)).join(', '))}` : ''}</span>${task.assignment.hostReason ? `<span class="fine host-why">${e(task.assignment.hostReason)}</span>` : ''}`;
  return `<section class="card plan${drafting ? '' : ' needs'}" aria-labelledby="plan-card-title"><div class="section-title"><h2 id="plan-card-title" tabindex="-1">The plan</h2><span class="status ${drafting ? 'active' : 'muted'}">${drafting ? 'The coordinator drafts it' : 'Waits for you'}</span></div>
  <h3>Direction</h3><p><strong>${e(idea.title)}</strong></p>${more(`plan-case-${idea.id}`, idea.recommendation, 280)}
  <h3>Checks</h3><ol class="checks-list">${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ol>
  <h3>The work</h3>${
    drafted.length > extras.length
      ? `<ol class="plan-tasks">${drafted
          .filter((task) => !task.assignment.extra)
          .map((task) => `<li>${line(task)}</li>`)
          .join('')}</ol>`
      : `<p class="empty-note">${drafting ? 'The coordinator drafts the tasks.' : 'No tasks yet. Write to the coordinator in the message box.'}</p>`
  }
  ${summary ? `<div class="note"><p class="msg-meta"><strong>The coordinator's summary</strong></p>${more('plan-summary', summary, 400)}</div>` : ''}
  ${extras.length ? `<h3>Extras</h3><p class="fine">Add-ons that you can include. Tick the ones that you want. Verifold cancels the others when you start the work.</p><ul class="plan-extras">${extras.map((task) => `<li><label><input type="checkbox" data-extra="${e(task.id)}"> ${line(task)}</label></li>`).join('')}</ul>` : ''}
  <div class="actions"><button type="button" class="primary" data-action="coordinator-approve"${drafting || !drafted.length ? ' disabled' : ''}>Start the work</button></div>
  <p class="fine">No task starts before you start the work. To change the draft, write to the coordinator in the message box.</p>
  ${others.length ? `<h3>Other directions</h3><ul class="plan-others">${others.map((other) => `<li><div><strong>${e(other.title)}</strong> <span class="tag">${e(directionRole(other, workspace, live))}</span><p class="fine">${e(lead(plain(other.recommendation), 160))}${other.kind === 'extra' ? ' To add it, write to the coordinator.' : ''}</p></div>${redraftable(workspace, live) && other.kind !== 'extra' ? `<button type="button" data-action="redraft" data-idea="${e(other.id)}" data-confirm="Click again to draft the plan for this direction">Use this instead</button>` : ''}</li>`).join('')}</ul>` : ''}</section>`;
}

/** Research can still take a choice of direction: no direction yet, and no step runs. */
function choosable(workspace: Workspace, live: DeskSession): boolean {
  return (
    live.research !== undefined &&
    !live.lab &&
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
    sub: `<span class="status ${chosen ? 'active' : 'muted'}">${e(directionRole(idea, workspace, live))}</span>`,
    body: `<div class="md">${markdownHtml(idea.recommendation)}</div>
    <h3>Checks</h3><ul class="checks-list">${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul>
    <p class="fine">The coordinator plans tasks that test these checks.</p>
    ${idea.sources?.length ? `<h3>Sources</h3><ol class="sources">${idea.sources.map((source) => `<li>${link(source)}</li>`).join('')}</ol>` : ''}
    ${choosable(workspace, live) ? `<div class="actions"><button type="button" class="primary" data-action="select" data-idea="${e(idea.id)}">Choose this direction</button></div><p class="fine">The coordinator then drafts the plan for it. No task starts before you start the work.</p>` : !chosen && redraftable(workspace, live) ? `<div class="actions"><button type="button" data-action="redraft" data-idea="${e(idea.id)}" data-confirm="Click again to draft the plan for this direction">Use this instead</button></div><p class="fine">The coordinator stops its draft and drafts the plan for this direction. No task has started.</p>` : !chosen && changeable(workspace, live) ? `<div class="actions"><button type="button" data-action="change-direction" data-idea="${e(idea.id)}" data-confirm="Click again to stop the work and change the direction">Change to this direction</button></div><p class="fine">The coordinator and the running agents stop. Their work waits for your review, and finished work stays. Then the coordinator plans this direction for you to approve.</p>` : ''}`,
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
  return `<div class="view"><div class="view-head"><h1 id="view-title" tabindex="-1">Plan</h1><p>${e(workspace.selectedId ? 'Direction chosen' : phaseLabel(research?.phase))}</p></div>
  ${research?.topic ? `<p class="question">${e(research.topic)}</p>` : ''}
  ${live.lab ? `<p class="notice">${e(labWorks)}</p>` : ''}
  ${renderDecision(workspace, live, 'research')}
  ${renderPlanCard(workspace, live)}
  ${workspace.candidates.length ? `<section class="card" aria-labelledby="directions-title"><div class="section-title"><h2 id="directions-title">Compare the directions</h2><span class="count">${workspace.candidates.length} proposed</span></div><div class="table"><table class="compare"><thead><tr><th scope="col">Direction</th><th scope="col">Why</th><th scope="col">Checks</th><th scope="col">Sources</th></tr></thead><tbody>${workspace.candidates.map((idea) => `<tr${workspace.selectedId === idea.id ? ' class="chosen"' : ''}><th scope="row"><button type="button" class="row-button" data-direction="${e(idea.id)}" aria-pressed="${shown === idea.id}">${e(idea.title)}</button><span class="selected-label">${e(directionRole(idea, workspace, live))}</span></th><td data-label="Why">${e(lead(plain(idea.recommendation), 150))}</td><td data-label="Checks">${idea.gates.length}</td><td data-label="Sources">${idea.sources?.length ?? 0}</td></tr>`).join('')}</tbody></table></div><p class="fine">${choosable(workspace, live) ? 'Open a direction to read its case and its checks, and to choose it.' : 'Open a direction to read its case and its checks.'}</p></section>` : ''}
  ${renderResearch(live.research, research?.latestAttempt)}
  ${renderSources(live.research?.sources ?? [], live.research?.running === true)}
  ${research?.plan ? `<section class="card"><details id="research-plan"${research.phase === 'awaiting-plan-review' ? ' open' : ''}><summary><h2>Research plan</h2><span>Proposed roles</span></summary><div class="prose md">${markdownHtml(research.plan.scope)}</div><ul class="roles">${research.plan.personas.map((persona) => `<li><strong>${e(persona.name)}</strong><span>${e(persona.task)}</span></li>`).join('')}</ul><p class="fine">Research proposed these roles. Verifold did not see them run.</p></details></section>` : ''}
  <section class="card findings" aria-labelledby="findings-title"><div class="section-title"><h2 id="findings-title">Sources and findings</h2>${chosen ? `<span class="count">Attempt ${e(chosen.id.slice(0, 8))}</span>` : ''}</div>
  ${report ? findingsBody(report, chosen?.id ?? '') : `<div class="empty-note"><p>${chosen ? 'This step has no report.' : 'No research yet.'}</p><p>${chosen ? 'Planning steps and stopped steps can have no report. Their files stay in the project.' : 'Sources and findings show here after research.'}</p></div>`}</section>
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
      ? '<p class="notice">Verifold does not know how this step ended. Make sure that research is not still running before you start it again.</p>'
      : chosen.activity === 'recent'
        ? `<p class="fine">${live.research ? 'Research is running now. Follow it in Plan.' : 'Research is running in another Verifold process. This desk shows its result when it ends.'}</p>`
        : record?.status === 'interrupted'
          ? '<p class="notice">Verifold stopped during this attempt, so its outcome is unknown. Continue research to run the step again from the saved checkpoint.</p>'
          : record?.status === 'failed' || record?.status === 'cancelled'
            ? '<p class="notice">Verifold kept the files of this step. Look at them before you continue.</p>'
            : '<p class="fine">Verifold checked the result and saved it.</p>';
  const body = `${state}${report ? `<h3>Sources and findings</h3>${findingsBody(report, chosen.id)}` : ''}<details id="attempt-identity"><summary>Harness and session details</summary><dl><dt>Verifold attempt</dt><dd>${e(chosen.id)}</dd><dt>Harness</dt><dd>${e(record?.host ?? 'Unknown')}</dd><dt>Requested model</dt><dd>${e(record ? (record.model ?? 'The harness default') : 'Unknown')}</dd><dt>Native session</dt><dd>${e(record?.nativeSessionId ?? 'Not reported')}</dd><dt>Requested session</dt><dd>${e(record ? (record.requestedSessionId ?? 'New session requested') : 'Unknown')}</dd>${record ? `<dt>Started</dt><dd>${e(time(record.startedAt))}</dd><dt>Finished</dt><dd>${e(record.finishedAt ? time(record.finishedAt) : 'Not recorded')}</dd>` : ''}</dl></details>${live.research?.step && chosen.id === workspace.research?.latestAttempt ? '<p class="fine">Plan shows the transcript of this step under Details.</p>' : `<details id="attempt-transcript"><summary>Harness transcript</summary>${transcriptSlot(`attempt:${chosen.id}`, 'Attempt transcript', '')}</details>`}`;
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
export const deskPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Verifold</title><link rel="icon" href="/symbol.webp"><link rel="stylesheet" href="/desk.css"><script type="module" src="/desk-client.js"></script></head><body><a class="skip" href="#view">Skip to the main view</a><header class="topbar"><button id="menu" class="icon-button menu-button" type="button" aria-label="Show the views and the team" aria-expanded="false">☰</button><a class="brand" href="/" aria-label="Verifold research desk"><img src="/symbol.webp" alt="" width="26" height="26"><span>verifold</span></a><div class="project"><strong id="project-title">Research desk</strong><span class="stage" id="stage" hidden></span></div><span class="spacer"></span><span id="action-status" role="status"></span><span id="observation"></span><span id="connection" role="status">Connecting…</span><button id="needs" class="needs-button" type="button" data-view="needs" hidden><span class="needs-label">Needs you</span><span class="count" id="needs-count">0</span></button><button id="stop-team" class="stop-button" type="button" data-action="stop" data-confirm="Click again to stop the agents and pods" hidden>Stop the team</button><button id="theme" class="icon-button" type="button" aria-label="Switch the color theme" title="Switch the color theme">◐</button></header><div class="connection-note" id="connection-note" hidden><span id="connection-message"></span><button id="retry" type="button">Refresh</button></div><div id="content" class="frame"><main id="view" class="solo" tabindex="-1"><div class="empty"><h1>Opening your research desk</h1><p>Reading the selected project. This does not start research.</p></div></main></div></body></html>`;

/** The stages of a project, from the question to the answer. Home draws them as an arc. */
const stageNames = ['Ask', 'Plan', 'Work', 'Answer'] as const;

interface Progress {
  /** The index of the current stage in stageNames. */
  readonly current: number;
  /** A short note for each stage. */
  readonly notes: readonly string[];
  /** The current stage waits for a decision of the person. */
  readonly waits: boolean;
  /** An agent works on the current stage. */
  readonly working: boolean;
  /** After the plan is approved: the planned tasks, and how many of them are done or cancelled. */
  readonly work?: { readonly done: number; readonly total: number };
}

/** Where the project is, from the records that the desk reads. Nothing here is stored. */
function progress(workspace: Workspace, live: DeskSession): Progress {
  const notes = ['Asked', '', '', ''];
  const research = workspace.research;
  const searching = live.research?.running === true;
  // A chosen direction comes first: an older flow can choose one without a research record.
  if (!workspace.selectedId) {
    if (!research) {
      notes[0] = 'No question yet';
      return { current: 0, notes, waits: false, working: false };
    }
    // A question that no research step took yet, such as one that a lab keeps, is still asked.
    if (
      !searching &&
      !research.latestAttempt &&
      research.phase === 'needs-plan'
    )
      return { current: 0, notes, waits: false, working: false };
    // Research, its optional plan stop, and a choice of direction belong to the plan.
    const waits =
      !searching &&
      (research.phase === 'awaiting-plan-review' ||
        research.phase === 'directions');
    notes[1] = searching
      ? 'Research runs'
      : waits
        ? 'Waits for you'
        : 'Stopped';
    return { current: 1, notes, waits, working: searching };
  }
  const coordinator = live.coordinator;
  const tasks = live.tasks?.list ?? [];
  const status = coordinator?.session?.record.status;
  const coordinating = status === 'running' || status === 'starting';
  const state = coordinator?.state;
  if (!state?.planApproved) {
    const waits = planWaits(coordinator, tasks);
    const started = !!state && !state.stoppedAt;
    notes[1] = !started ? 'Not started' : waits ? 'Waits for you' : 'Drafting';
    return { current: 1, notes, waits, working: started && coordinating };
  }
  notes[1] = 'Approved';
  const planned = tasks.filter((task) => task.assignment.by === 'coordinator');
  const settled = planned.filter(
    (task) => task.state === 'done' || task.state === 'cancelled',
  ).length;
  notes[2] = `${settled} of ${planned.length} done`;
  const work = { done: settled, total: planned.length };
  // A proposed answer waits for the person's sign-off. A request for more work returns to the work.
  const answer = resultsOf(workspace, live)?.answer;
  if (answer && answer.decision?.kind !== 'more') {
    notes[3] = answer.decision ? 'Accepted' : 'Waits for you';
    return { current: 3, notes, waits: !answer.decision, working: false, work };
  }
  if (planned.length && settled === planned.length) {
    notes[3] = 'Tasks done';
    return { current: 3, notes, waits: false, working: false, work };
  }
  const working =
    coordinating || (live.workers ?? []).some((worker) => worker.live);
  return { current: 2, notes, waits: false, working, work };
}

/** The current stage in words: the top bar shows it, and the arc says it to screen readers. */
function stageText(at: Progress): string {
  const note = at.notes[at.current];
  return `${stageNames[at.current] ?? ''}${note ? `: ${note.toLowerCase()}` : ''}`;
}

type Point = readonly [number, number];

const arcPoints: readonly Point[] = [
  [90, 60],
  [370, 40],
  [650, 66],
  [930, 44],
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
  research: 'Plan',
  tasks: 'Work',
  results: 'Answer',
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

/** The rail: the views and the team. At phone width it becomes a menu. */
function renderRail(
  frame: DeskFrame,
  live: DeskSession,
  tasks: readonly TaskRecord[],
  needs: readonly Need[],
): string {
  const workers = live.workers ?? (live.session ? [live.session] : []);
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
        ? ['you', '◆ The plan waits for you']
        : (live.tasks?.messages ?? []).some(
              (message) => isQuestion(message) && message.status === 'open',
            )
          ? ['you', '◆ Waits for your answer']
          : status === 'paused' || status === 'interrupted'
            ? ['paused', 'Paused']
            : status === 'failed'
              ? ['failed', 'Failed']
              : status === 'running' || status === 'starting'
                ? ['working', 'Working']
                : ['idle', coordinatorStates[status] ?? 'Waiting'];
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
  // Each lab agent with its direction. Its row opens the lab.
  for (const entry of live.lab?.directions ?? [])
    if (entry.direction.state === 'open') {
      const { face, text: line } = stateOf(entry, clock);
      team.push(
        member(
          'session',
          face,
          `${entry.agent.handle}: ${entry.direction.title}`,
          e(line),
          'data-view="home"',
        ),
      );
    }
  const listed = new Set<string>();
  const add = (worker: SessionView): void => {
    const { record } = worker;
    listed.add(record.id);
    const requests = record.requests.length;
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
        requests
          ? `◆ ${requests} ${requests === 1 ? 'request waits' : 'requests wait'} for you`
          : e(label),
        `data-worker="${e(record.id)}" aria-pressed="${record.id === shown}"`,
      ),
    );
  };
  // Each task keeps its place in the team. Its worker's slot can go to another task, so a task without a live worker shows its own state.
  for (const task of tasks) {
    if (task.state === 'cancelled' || (frame.hideFinished && finished(task)))
      continue;
    const session = task.attempts.at(-1)?.session;
    const worker = workers.find(
      (entry) => entry.live && entry.record.id === session,
    );
    if (worker) add(worker);
    else
      team.push(
        member(
          'task',
          isDraft(task) ? 'you' : taskFaces[task.state],
          task.assignment.title,
          isDraft(task)
            ? '◆ Draft, waits for you'
            : e(taskStates[task.state][0]),
          `data-task-select="${e(task.id)}" aria-pressed="${frame.view === 'task' && live.tasks?.selected?.id === task.id}"`,
        ),
      );
  }
  // Sessions that the person started, and any live worker that no listed task holds.
  for (const worker of workers)
    if (!listed.has(worker.record.id) && (worker.live || !worker.record.task))
      add(worker);
  return `<nav class="rail" id="rail" aria-label="Views and team"><ul class="views">${railViews
    .filter(
      (view) =>
        (view !== 'tasks' || live.tasks) &&
        (view !== 'compute' || live.compute),
    )
    .map(
      (view) =>
        `<li><button type="button" data-view="${view}"${view === frame.view || (view === 'tasks' && frame.view === 'task') ? ' aria-current="page"' : ''}>${viewIcons[view]}<span>${viewNames[view]}</span>${count(view)}</button></li>`,
    )
    .join(
      '',
    )}${live.lab ? `<li><button type="button" data-panel="search" data-focus="lab-search" aria-pressed="${frame.panel === 'search'}" aria-keyshortcuts="Meta+K Control+K">${viewIcons.research}<span>Search</span></button></li>` : ''}</ul>
  <div class="rail-team"><div class="rail-title"><h2>Team</h2></div>${team.length ? `<ul class="team">${team.join('')}</ul>` : '<p class="fine">No agent works now.</p>'}</div>
</nav>`;
}

/**
 * Home: where the project is, what waits for the person, what the team does,
 * what changed since the person left, and the one box to the coordinator.
 */
/** What happens now, in one line: the step, who works on it, and how far the work is. */
function renderNow(
  workspace: Workspace,
  live: DeskSession,
  needs: readonly Need[],
): string {
  const tasks = (live.tasks?.list ?? []).filter(
    (task) => task.state !== 'cancelled',
  );
  const state = live.coordinator?.state;
  const answer = resultsOf(workspace, live)?.answer;
  const held = live.coordinator;
  const usage =
    held?.limitedBy === 'usage' && held.limitedUntil
      ? `The coordinator waits for ${hostName(held.state.host)}'s usage window until ${clock(held.limitedUntil)}.`
      : '';
  const done = tasks.filter((task) => task.state === 'done').length;
  const running = tasks.filter(
    (task) => task.state === 'running' || task.state === 'claimed',
  );
  let line = '';
  let sub = '';
  if (live.research?.running) {
    line = `Research: ${live.research.step ?? 'working'}.`;
    sub = live.research.startedAt
      ? `For ${elapsed(live.research.startedAt)}.`
      : '';
  } else if (answer?.decision?.kind === 'accepted')
    line = 'You accepted the answer.';
  else if (answer && !answer.decision) line = 'The answer waits for you.';
  else if (state && !state.stoppedAt && !state.planApproved)
    line = planWaits(live.coordinator, live.tasks?.list ?? [])
      ? 'The plan waits for you.'
      : usage || 'The coordinator drafts the plan.';
  else if (running.length) {
    line = `${running.map((task) => `${task.assignment.title} runs on ${hostName(task.assignment.host)}`).join('. ')}.`;
    sub = `${done} of ${tasks.length} tasks done.${usage ? ` ${usage}` : ''}`;
  } else if (needs.length) {
    line = 'Nothing runs. The team waits for you.';
    sub = tasks.length ? `${done} of ${tasks.length} tasks done.` : '';
  } else if (tasks.length) {
    // Without a session record yet, the coordinator is starting, as the rail says.
    const status = live.coordinator?.session?.record.status ?? 'starting';
    const working = status === 'running' || status === 'starting';
    line = usage
      ? `No task runs. ${usage}`
      : state && !state.stoppedAt && working
        ? 'No task runs. The coordinator works.'
        : 'No task runs.';
    // The coordinator's latest note says what it waits for, while it is current.
    const messages = live.tasks?.messages ?? [];
    const note = currentNote(messages, tasks);
    sub = `${done} of ${tasks.length} tasks done.${note ? ` The coordinator wrote at ${clock(note.at)}: "${lead(named(note.text, tasks, messages), 140)}"` : ''}`;
  }
  return line
    ? `<section class="card now-card" aria-label="Now"><p class="now-line"><span class="map-label">Now</span> ${e(line)}</p>${sub ? `<p class="fine">${e(sub)}</p>` : ''}</section>`
    : '';
}

/** The answer on Home, under the question: its statement, and the place to read it in full. */
function renderHomeAnswer(workspace: Workspace, live: DeskSession): string {
  const answer = resultsOf(workspace, live)?.answer;
  if (!answer || answer.decision?.kind === 'more') return '';
  return `<section class="card answer-home" aria-labelledby="home-answer-title"><div class="section-title"><h2 id="home-answer-title">The answer</h2><span class="tag reading">Proposed by the coordinator</span></div><p class="statement">${e(answer.statement)}</p>${answer.decision?.kind === 'accepted' ? `<p class="notice-ok">You accepted the answer at ${e(since(answer.decision.at))}.</p>` : '<div class="actions"><button type="button" class="primary" data-view="results" data-focus="answer-title">Read the answer</button></div><p class="fine">Read it with its checks and evidence. Then accept it, or ask for more work.</p>'}</section>`;
}

/** Home's card of what waits for the person, or nothing. */
function needsCard(needs: readonly Need[]): string {
  return needs.length
    ? `<section class="card needs" aria-labelledby="needs-title"><h2 id="needs-title">Needs you</h2>${renderNeedList(needs)}</section>`
    : '';
}

/** The work on Home after the person started it: the task map, and the results of the checks. */
function renderHomeWork(
  workspace: Workspace,
  live: DeskSession,
  needs: readonly Need[],
  hideFinished: boolean,
): string {
  const view = live.tasks;
  const state = live.coordinator?.state;
  if (!view?.list.length || !state?.planApproved) return '';
  const idea = workspace.candidates.find(
    (candidate) => candidate.id === workspace.selectedId,
  );
  // D92: the checks live in Answer. Home says how many have a result.
  const results = resultsOf(workspace, live);
  const checks = idea?.gates.length
    ? `<button type="button" class="quiet" data-view="results">${results?.checks.length ?? 0} of ${idea.gates.length} checks have a result</button>`
    : '';
  return `<section class="card map-card" aria-labelledby="home-map-title"><div class="section-title"><h2 id="home-map-title">The work</h2>${checks}<button type="button" class="quiet" data-view="tasks">Open the tasks</button></div>${renderMap(view, live, idea?.title ?? state.objective, needs, hideFinished)}</section>`;
}

function renderHome(
  snapshot: DeskSnapshot,
  live: DeskSession,
  at: Progress,
  researching: boolean,
  needs: readonly Need[],
  left: string | undefined,
  hideFinished: boolean,
): string {
  const { workspace } = snapshot;
  const tasks = live.tasks?.list ?? [];
  let lead: string;
  if (live.research && !workspace.selectedId)
    lead = renderDecision(workspace, live, 'home');
  // The Now line says what the coordinator does. A card shows only when no coordinator runs.
  else if (workspace.selectedId && live.coordinator !== undefined)
    lead =
      !live.coordinator?.state || live.coordinator.state.stoppedAt
        ? renderTeamNext(live.coordinator, needs.length, tasks)
        : '';
  else if (researching)
    lead =
      '<section class="card lead"><h2>Research is running</h2><p>Research runs in a terminal. The results show here when this step ends.</p><p class="fine">To stop it, press Ctrl+C in that terminal.</p></section>';
  else {
    const next = nextResearchAction(workspace);
    lead = `<section class="card lead"><h2>Continue your research</h2><p>${e(next.instruction)}</p><p class="fine">Run in your project terminal</p><div class="command"><code>${e(next.command)}</code><button id="copy-command" type="button" data-command="${e(next.command)}" aria-label="Copy next command">Copy</button></div><p class="fine">${live.controllable ? 'Opening the desk starts nothing. To start an agent, pick A new agent in the message box.' : 'This desk shows saved work. It starts nothing.'}</p></section>`;
  }
  // A run that no team owns yet can start a lab instead, while no research step runs.
  // A lab start that runs or failed in the background shows here, also when the offer does not.
  const labStart = `${renderLabWork(live.labWorks ?? [], clock)}${
    live.labCanStart ? renderLabStart(workspace.research?.topic) : ''
  }`;
  return `<div class="masthead"><h1 id="view-title" tabindex="-1">Home</h1>${workspace.research?.topic ? `<p class="question">${e(workspace.research.topic)}</p>` : ''}${renderArc(at)}</div>
  <div class="view">${labStart}${renderNow(workspace, live, needs)}${needsCard(needs)}${renderHomeAnswer(workspace, live)}${lead}${left ? renderSince(left, snapshot, live, needs.length) : ''}${renderHomeWork(workspace, live, needs, hideFinished)}${renderPodsLine(live.compute)}${renderPaused(live)}</div>`;
}

/** The side panel for one item, or a form for a new one, or why the item is gone. */
function renderPanel(
  panel: DeskPanel,
  workspace: Workspace,
  live: DeskSession,
  chosen: DeskAttempt | undefined,
  report: ResearchReport | null,
  messages: readonly Message[],
  frame: DeskFrame,
): string {
  const { direction } = frame;
  const tasks = live.tasks?.list ?? [];
  const gone = (kind: string, title: string, text: string): Panel => ({
    kind,
    title,
    sub: '',
    body: `<p class="empty-note">${text}</p>`,
  });
  let shown: Panel;
  const lab = live.lab;
  if (
    panel === 'run' ||
    panel === 'diff' ||
    panel === 'agent' ||
    panel === 'search' ||
    panel === 'answer' ||
    panel === 'bring'
  )
    shown = !lab
      ? gone('Lab', 'No lab', 'This project has no lab.')
      : panel === 'run'
        ? runPanel(lab, frame.run, clock)
        : panel === 'diff'
          ? diffPanel(lab, direction, frame.proof, live.labDiff ?? null)
          : panel === 'search'
            ? searchPanel(lab, frame.q, clock)
            : panel === 'answer'
              ? answerPanel(lab, clock)
              : panel === 'bring'
                ? bringPanel(lab, direction, live.labBring ?? null, clock)
                : labAgentPanel(lab, frame.agent, live, tasks);
  else if (panel === 'worker')
    shown = live.session
      ? workerPanel(live.session, live, tasks)
      : gone(
          'Agent',
          'No session',
          'No agent session is open. To start one, choose A new agent in the message box.',
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
    shown =
      live.lab && !live.coordinator?.state
        ? gone('Agent', 'Coordinator', labWorks)
        : coordinatorPanel(
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
          'Each research step shows here.',
        );
  else
    shown = {
      kind: '',
      title: 'Write a task yourself',
      sub: '',
      body: live.tasks
        ? `<div id="task-new">${taskForm('task-new', null, live.tasks.list, workspace.host)}<div class="actions"><button type="button" class="primary" data-action="task-create">Create task</button></div></div>`
        : '<p class="empty-note">This desk only reads saved work. Run verifold in the project directory to create tasks.</p>',
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
  /** The tab icon shows the part of the planned tasks that is done. */
  work: { done: number; total: number } | null;
  /** A project owner runs the team, so the top bar offers Stop the team. */
  stoppable: boolean;
  /** The project has a lab. Its owner keeps the person's last look, so the page sends no time away of its own. */
  lab: boolean;
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
    ((frame.view === 'tasks' || frame.view === 'task') && !live.tasks) ||
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
          ? renderComputeView(
              live.compute,
              live.tasks?.list ?? [],
              live.agents ?? defaultAgents,
            )
          : view === 'research'
            ? renderResearchView(
                workspace,
                live,
                report,
                chosen,
                frame.panel === 'direction' ? frame.direction : undefined,
              )
            : view === 'task' && live.tasks
              ? renderTaskPage(
                  live.tasks.selected,
                  live.tasks,
                  live,
                  workspace.host,
                  new Set(needs.map((item) => item.key)),
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
                    // Before a direction and a coordinator, Tasks offers to start one with your own objective. A lab run has no coordinator.
                    live.coordinator !== undefined &&
                      !live.lab &&
                      !workspace.selectedId &&
                      !live.coordinator?.state,
                    needs,
                    frame.hideFinished === true,
                  )
                : view === 'records'
                  ? renderRecords(
                      snapshot,
                      workers,
                      tasks,
                      live.tasks?.messages ?? [],
                      frame.panel === 'attempt' ? chosen?.id : undefined,
                      live.archives,
                    )
                  : view === 'home' && live.lab
                    ? renderLab(live.lab, clock, {
                        needs,
                        works: live.labWorks ?? [],
                        gpu: live.compute
                          ? labGpu(live.compute, live.lab.state.startedAt)
                          : null,
                        extra: `${renderPodsLine(live.compute)}${renderPaused(live)}`,
                        away: live.labAway ?? null,
                      })
                    : renderHome(
                        snapshot,
                        live,
                        at,
                        active.length > 0,
                        needs,
                        frame.since,
                        frame.hideFinished === true,
                      );
  // In a lab, Home has its own box: posts go to the board.
  const dock =
    (view === 'home' && !live.lab) ||
    view === 'research' ||
    view === 'tasks' ||
    view === 'task' ||
    view === 'needs'
      ? renderDock(
          workspace,
          live,
          view === 'task' ? live.tasks?.selected?.id : undefined,
          // Home and Needs you list what waits for the person.
          view === 'needs' || (view === 'home' && needs.length > 0),
          view === 'home',
        )
      : '';
  const html = `${renderRail({ view, panel: frame.panel, ...(frame.hideFinished ? { hideFinished: true } : {}) }, live, tasks, needs)}<main id="view" tabindex="-1">${main}</main>${dock}${frame.panel ? renderPanel(frame.panel, workspace, live, chosen, report, messages, frame) : ''}`;
  return {
    html,
    observation: '',
    title: snapshot.project,
    // A lab's header says where it stands. The research arc does not apply to it.
    stage: live.lab ? '' : stageText(at),
    needs: needs.map(({ key, title }) => ({ key, title })),
    work: at.work ?? null,
    stoppable: live.archives !== undefined,
    lab: Boolean(live.lab),
  };
}

const setupSteps = ['Question', 'Quick questions', 'Brief'] as const;

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
  const suggestions = hint?.suggestions?.length
    ? `<div class="choices suggestions">${hint.suggestions
        .map(
          (value) =>
            `<button type="button" class="choice" ${answer(value)}><span class="choice-label">${e(value)}</span></button>`,
        )
        .join('')}</div><p class="setup-note">Or write your own answer.</p>`
    : '';
  return `<section class="setup-prompt"><div class="md" id="setup-question">${markdownHtml(prompt.question)}</div>${suggestions}${field}${hint?.note ? `<p class="setup-note">${e(hint.note)}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="setup" data-prompt="${prompt.id}" data-field="setup-answer">Continue</button>${(
    hint?.actions ?? []
  )
    .map(
      (action) =>
        `<button type="button"${action.value === '/cancel' ? ' class="quiet"' : ''} ${answer(action.value)}>${e(action.label)}</button>`,
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
  const line = (entry: SetupView['lines'][number]): string =>
    entry.source === 'tool' || entry.source === 'you'
      ? `<span class="event-text">${e(entry.text)}</span>`
      : `<div class="event-text md">${markdownHtml(entry.text)}</div>`;
  // One question at a time: what Verifold and the harness said since the last answer, then the question.
  // The review shows the brief itself, so the harness text above it would repeat the brief.
  const answered = view.lines.findLastIndex((entry) => entry.source === 'you');
  const said = view.prompt
    ? view.lines
        .slice(answered + 1)
        .filter(
          (entry) =>
            entry.source !== 'tool' &&
            !(view.prompt?.kind === 'review' && entry.source === 'agent'),
        )
    : [];
  // The log keeps the latest 60 lines, newest first, in a scroll area. A long line folds behind Show all.
  const logged = view.lines
    .map((entry, index) => ({ entry, index }))
    .slice(-60)
    .reverse();
  const html =
    page(`<div class="setup"><h1 id="view-title" tabindex="-1">New project</h1>
  <ol class="setup-steps" aria-label="Setup steps">${setupSteps
    .map(
      (name, index) =>
        `<li data-state="${index < current ? 'done' : index === current ? 'current' : 'next'}"${index === current ? ' aria-current="step"' : ''}>${e(name)}</li>`,
    )
    .join('')}</ol>
  ${view.busy ? `<p class="setup-busy" role="status">${e(view.busy.label)}, for ${e(elapsed(view.busy.startedAt))}</p>` : ''}
  ${said.map((entry) => `<div class="setup-said">${line(entry)}</div>`).join('')}
  ${view.prompt ? renderSetupPrompt(view.prompt) : ''}
  ${
    view.lines.length
      ? `<details class="setup-log" id="setup-log"><summary>Setup log (${view.lines.length})</summary>${detailSwitch}<ol class="setup-lines" reversed>${logged
          .map(
            ({ entry, index }) =>
              `<li class="event setup-${entry.source}"><span class="event-kind">${setupLabels[entry.source]}</span><div class="event-text">${entry.source === 'tool' || entry.source === 'you' ? more(`setup-line-${index}`, entry.text) : moreMd(`setup-line-${index}`, entry.text)}</div><time datetime="${e(entry.at)}">${e(clock(entry.at))}</time></li>`,
          )
          .join(
            '',
          )}</ol>${transcriptSlot('setup', 'Harness transcript')}</details>`
      : ''
  }
  ${view.outcome === 'done' ? '<p class="notice">Setup is complete. The project desk opens here.</p>' : ''}
  ${view.outcome === 'stopped' ? `<p class="notice">${e(view.error ?? 'Setup stopped.')}</p><p class="fine">Run verifold again in your terminal to start over.</p>` : ''}</div>`);
  return {
    html,
    observation: view.step ? `Setup step: ${view.step}` : '',
    title: 'New project',
    stage: view.step ? `Setup: ${view.step.toLowerCase()}` : 'Setup',
  };
}
