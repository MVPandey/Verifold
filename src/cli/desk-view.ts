import { escapeHtml as e } from '../ui/dom.ts';
import { markdownHtml } from './markdown.ts';
import type { Workspace } from './contracts.ts';
import type { DeskSnapshot, DeskAttempt } from './desk-records.ts';
import type { ResearchReport } from './research.ts';
import type { ResearchView } from './research-runner.ts';
import type { SetupPrompt, SetupView } from './setup-bridge.ts';
import { replaced, type TaskRecord, type TaskVersion } from './tasks.ts';
import { workerLimit } from './workers.ts';
import {
  decisionLabel,
  hostName,
  modeLabel,
  needsReview,
  type CommandEntry,
  type PausedSession,
  type SessionEvent,
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
}

export interface TaskView {
  readonly list: readonly TaskRecord[];
  /** The task that the page shows. */
  readonly selected: TaskRecord | null;
  /** Live sessions that wait for a follow-up. */
  readonly idle: readonly string[];
}

export function nextResearchAction(workspace: Workspace): {
  command: string;
  instruction: string;
} {
  if (workspace.selectedId)
    return {
      command: 'verifold handoff',
      instruction:
        'Print a pilot-planning request for the selected idea. Execution still needs approval.',
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
  return `<section class="research-live" aria-labelledby="research-live-title"><div class="section-title"><h2 id="research-live-title">Research</h2><span class="status ${view.running ? 'active' : 'muted'}">${view.running ? 'Running' : 'Not running'}</span></div>
  <p class="research-step">${e(view.step)}${view.running && view.startedAt ? ` · ${e(elapsed(view.startedAt))}` : ''}</p>
  ${detailSwitch}
  <p class="research-summary summary-only">${observed} harness ${observed === 1 ? 'event' : 'events'} observed.${last ? ` Latest: ${e(last.text)}` : ''}</p>
  ${attempt ? `${transcriptSlot(`attempt:${attempt}`, 'Research transcript')}${transcriptNote}` : ''}</section>`;
}

/** The research decision that waits for the person, with one primary action. */
function renderDecision(workspace: Workspace, live: DeskSession): string {
  const research = live.research;
  if (!research || workspace.selectedId) return '';
  if (research.running)
    return `<section class="next-action"><h2>Research is running</h2><p>${e(research.step ?? 'A research step runs.')}. Follow it in Research.</p><p class="fine">If you cancel, the saved checkpoint and the attempt files stay.</p><div class="actions"><button type="button" data-action="cancel-research">Cancel research</button></div></section>`;
  const feedback = (label: string): string =>
    `<label class="field" for="research-feedback">Changes</label><textarea id="research-feedback" rows="3" maxlength="4000" placeholder="${e(label)}"></textarea><div class="actions"><button type="button" data-action="research" data-research="feedback">Ask for changes</button></div>`;
  switch (workspace.research?.phase) {
    case undefined:
      return `<section class="next-action"><h2>Start research</h2><p>Write the question that research should explore. The harness plans the research first.</p><label class="field" for="research-topic">Question</label><textarea id="research-topic" rows="3" maxlength="4000"></textarea><label class="check" for="research-guided"><input type="checkbox" id="research-guided" checked> Stop at the plan for my approval</label><div class="actions"><button type="button" class="primary" data-action="research" data-research="start">Start research</button></div></section>`;
    case 'awaiting-plan-review':
      return `<section class="next-action"><h2>Review the plan</h2><p>Read the research scope. Approve it to start the source search, or ask for changes.</p><div class="actions"><button type="button" class="primary" data-action="research" data-research="approve">Approve the plan</button></div>${feedback('What should change in the plan?')}</section>`;
    case 'directions':
      return `<section class="next-action"><h2>Choose a direction</h2><p>Choose one direction under Research directions. The choice locks it for this project. You can ask for changes first.</p>${feedback('What should change in the directions?')}</section>`;
    default:
      return `<section class="next-action"><h2>Continue research</h2><p>Research stopped before this step ended. Continue from the saved checkpoint.</p><div class="actions"><button type="button" class="primary" data-action="research" data-research="continue">Continue research</button></div></section>`;
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
  idle: ['Waiting for a follow-up', 'success'],
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
    return ['Ready for review', 'success'];
  return sessionStatus[record.status] ?? ['Unknown', 'muted'];
}

/** The live session, its requests, and its controls. All harness text is escaped. */
function renderSession(live: DeskSession, defaultHost: string): string {
  const view = live.session;
  if (!view && !live.controllable) return '';
  const record = view?.record;
  const running = view?.live === true;
  const [label, tone] = record ? workerStatus(record) : ['', ''];
  const start = live.controllable && !live.full;
  const host = record?.host ?? (defaultHost === 'codex' ? 'codex' : 'claude');
  const workers = live.workers ?? (view ? [view] : []);
  const liveCount = workers.filter((worker) => worker.live).length;
  return `<section class="session" aria-labelledby="session-title"><div class="section-title"><h2 id="session-title">Workers</h2><span class="count">${liveCount} of ${workerLimit} running</span></div>
  ${
    workers.length > 1
      ? `<ul class="worker-list">${workers
          .map((worker) => {
            const [state, mood] = worker.live
              ? workerStatus(worker.record)
              : worker.record.status === 'failed'
                ? ['Stopped with an error', 'failed']
                : ['Ended', 'muted'];
            const waiting = worker.record.requests.length;
            const review = worker.record.commands.filter(needsReview).length;
            return `<li><button type="button" data-worker="${e(worker.record.id)}" aria-pressed="${worker.record.id === record?.id}"><span class="worker-name">${e(hostName(worker.record.host))}</span><span class="worker-task">${e(worker.record.task?.id ?? 'Plain session')}</span><span class="status ${mood}">${e(state)}</span>${waiting ? `<span class="worker-flag">${waiting} ${waiting === 1 ? 'request waits' : 'requests wait'} for you</span>` : ''}${review ? `<span class="worker-flag">${review} ${review === 1 ? 'command needs' : 'commands need'} review</span>` : ''}</button></li>`;
          })
          .join('')}</ul>`
      : ''
  }
  ${
    record
      ? `<div class="section-title worker-title"><h3>${e(hostName(record.host))}${record.task ? ` · ${e(record.task.id)}` : ''}</h3><span class="status ${tone}">${e(running ? label : record.status === 'failed' ? label : 'Ended')}</span></div><p class="session-meta"><span>${e(hostName(record.host))}</span><span>Mode: ${e(modeLabel(record))}</span><span>Model request: ${e(record.model ?? 'harness default')}</span>${record.costUsd === null ? '' : `<span>Cost estimate from Claude Code: $${e(record.costUsd.toFixed(2))}</span>`}</p>
  ${view?.saveFailed ? '<p class="notice">Verifold could not save the latest session record. The next change tries again.</p>' : ''}
  ${record.requests.length > 10 ? `<p class="notice">${record.requests.length} requests are open. The first 10 are shown.</p>` : ''}
  ${record.requests
    .slice(0, 10)
    .map(
      (request) =>
        `<article class="request" aria-label="Request ${e(request.id)}"><p class="request-type">${e(request.id)} · Needs you</p><p>${e(hostName(record.host))} asks to use ${e(request.tool)}.</p><code>${e(request.action)}</code>${request.detail ? `<p class="fine">Change to review:</p><code class="detail">${e(request.detail)}</code>` : ''}${request.reason ? `<p class="fine">Reason from the harness: ${e(request.reason)}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="answer" data-request="${e(request.id)}" data-decision="allow">Allow once</button><button type="button" data-action="answer" data-request="${e(request.id)}" data-decision="deny">Deny</button></div></article>`,
    )
    .join('')}
  ${paneSwitch}
  <ol class="session-events pane-summary">${record.events
    .slice(-60)
    .map(
      (event) =>
        `<li class="event event-${e(event.kind)}"><span class="event-kind">${e(eventLabels[event.kind])}</span>${event.kind === 'agent' ? `<div class="event-text md">${markdownHtml(event.text)}</div>` : `<span class="event-text">${e(event.text)}</span>`}<time datetime="${e(event.at)}">${e(clock(event.at))}</time></li>`,
    )
    .join('')}</ol>
  ${transcriptSlot(`session:${record.id}`, `${hostName(record.host)} transcript`, 'pane-details')}
  <div class="pane-terminal">${renderTerminal(view, live)}</div>
  ${
    record.task
      ? `<p class="fine">This session belongs to ${e(record.task.id)}. It runs in the task folder in Strict mode. Use the task actions under Tasks.</p>`
      : running && record.status !== 'terminal'
        ? record.status === 'idle'
          ? `<label class="field" for="follow-up">Follow-up</label><textarea id="follow-up" rows="3" maxlength="100000" placeholder="Ask the agent to continue or change course."></textarea><div class="actions"><button type="button" class="primary" data-action="send" data-session="${e(record.id)}">Send follow-up</button><button type="button" data-action="end" data-session="${e(record.id)}">End session</button></div>`
          : `<div class="actions"><button type="button" data-action="cancel" data-session="${e(record.id)}">Cancel this turn</button><button type="button" data-action="end" data-session="${e(record.id)}">End session</button></div>`
        : ''
  }
  ${!running && record.nativeSessionId ? `<p class="fine">Native session: ${e(record.nativeSessionId)}. The record is in .verifold/sessions/${e(record.id)}.json.</p>` : ''}`
      : ''
  }
  ${
    start && live.paused?.length
      ? `<div class="paused"><h3>${live.paused.some((paused) => paused.status === 'interrupted') ? 'Paused and interrupted sessions' : 'Paused sessions'}</h3><p class="fine">Verifold stopped while these sessions were open. Resume one to continue its conversation in a new harness process. If no conversation was recorded, start its first request again.</p><ul class="paused-list">${live.paused
          .slice(0, 10)
          .map(
            (paused) =>
              `<li><span class="paused-meta">${e(hostName(paused.host))} · ${e(time(paused.startedAt))} · ${paused.status === 'interrupted' ? 'Interrupted, outcome unknown' : 'Paused'}</span><span class="paused-request">${e(paused.request.length > 160 ? `${paused.request.slice(0, 160)}…` : paused.request)}</span><span class="actions"><button type="button" data-action="${paused.restart ? 'restart' : 'resume'}" data-session="${e(paused.id)}">${paused.restart ? 'Start again' : 'Resume'}</button></span></li>`,
          )
          .join('')}</ul></div>`
      : ''
  }
  ${
    start
      ? `<div class="start"><h3>${record ? 'Start another session' : 'Start a session'}</h3><p class="fine">${liveCount ? `${liveCount} of ${workerLimit} workers run. You can start ${workerLimit - liveCount} more. ` : ''}The harness runs in this project folder with its own sign-in and settings. In Ask me, each permission request comes here and to your terminal. Verifold records each tool call that the harness reports.</p><div class="fields"><label class="field" for="session-host">Harness<select id="session-host"><option value="claude"${host === 'claude' ? ' selected' : ''}>Claude Code</option><option value="codex"${host === 'codex' ? ' selected' : ''}>Codex</option></select></label><label class="field" for="session-mode">Commands<select id="session-mode"><option value="ask">Ask me</option><option value="auto">Auto</option></select></label><label class="field" for="session-model">Model<input id="session-model" type="text" maxlength="200" placeholder="Harness default"></label></div><label class="field" for="session-prompt">Request</label><textarea id="session-prompt" rows="4" maxlength="100000" placeholder="What should the harness do?"></textarea><div class="actions"><button type="button" class="primary" data-action="start">Start session</button></div></div>`
      : ''
  }</section>`;
}

const taskStates: Record<TaskRecord['state'], [string, string]> = {
  open: ['Open', 'muted'],
  claimed: ['Preparing', 'active'],
  running: ['Running', 'active'],
  review: ['Ready for review', 'success'],
  done: ['Done', 'muted'],
  cancelled: ['Cancelled', 'muted'],
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
  <div class="fields"><label class="field" for="${prefix}-host">Harness<select id="${prefix}-host"><option value="claude"${chosen === 'claude' ? ' selected' : ''}>Claude Code</option><option value="codex"${chosen === 'codex' ? ' selected' : ''}>Codex</option></select></label><label class="field" for="${prefix}-model">Model<input id="${prefix}-model" type="text" maxlength="200" placeholder="Harness default" value="${e(values?.model ?? '')}"></label><label class="field" for="${prefix}-minutes">Time limit for each turn, in minutes<input id="${prefix}-minutes" type="number" min="1" max="240" value="${values?.minutes ?? 30}"></label></div>
  ${
    others.length
      ? `<fieldset class="task-deps"><legend>Wait for these tasks to be done</legend>${others
          .map(
            (other) =>
              `<label class="check" for="${prefix}-dep-${e(other.id)}"><input type="checkbox" id="${prefix}-dep-${e(other.id)}" data-dep="${e(other.id)}"${values?.dependencies.includes(other.id) ? ' checked' : ''}> ${e(other.id)} · ${e(other.assignment.title)}</label>`,
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
  return `<div class="review" aria-labelledby="review-title"><h3 id="review-title">Version ${version.number} · ${e(turnLabels[version.turn])}</h3>
  ${version.note ? `<p class="notice">${e(version.note)}</p>` : ''}
  ${stale ? `<p class="notice">${e(stale)}</p>` : ''}
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

/** Scoped tasks: the list, one task with its next step, and a form for a new task. */
function renderTasks(view: TaskView, live: DeskSession, host: string): string {
  const task = view.selected;
  const others = view.list.filter((entry) => entry.id !== task?.id);
  let body = '';
  if (task) {
    const [label, tone] = taskStates[task.state];
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
        next = `<p>The harness works in the task folder. Follow it under Workers. Details shows the transcript.</p><div class="actions"><button type="button" data-action="task-stop" data-task="${e(task.id)}">Stop the turn</button></div><p class="fine">If you stop the turn, its work becomes a version for review.</p>`;
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
        .map(
          (saved) =>
            `<li>Version ${saved.number}: ${saved.decision?.kind === 'accepted' ? `accepted ${e(saved.decision.files?.join(', ') ?? '')}` : saved.decision?.kind === 'changes' ? `you asked for changes: ${e(saved.decision.note ?? '')}` : 'rejected'}</li>`,
        ),
    );
    const notes = task.attempts
      .filter((entry) => entry.note && entry !== attempt)
      .map(
        (entry) => `<li>Attempt ${entry.number}: ${e(entry.note ?? '')}</li>`,
      );
    body = `<article class="task" aria-labelledby="task-title"><div class="section-title"><h3 id="task-title">${e(task.assignment.title)}</h3><span class="status ${tone}">${e(label)}</span></div>
    <p class="session-meta"><span>${e(task.id)} · revision ${task.revision}</span><span>${e(hostName(task.assignment.host))}</span><span>Model: ${e(task.assignment.model ?? 'harness default')}</span><span>${task.assignment.minutes} min for each turn</span></p>
    <dl class="task-fields"><dt>Objective</dt><dd class="pre">${e(task.assignment.objective)}</dd><dt>Input files</dt><dd>${task.assignment.inputs.length ? task.assignment.inputs.map((input) => `<code>${e(input.path)}</code>`).join(' ') : 'None'}</dd><dt>May write to</dt><dd>${task.assignment.writable.map((path) => `<code>${e(path === '.' ? 'the whole project' : path)}</code>`).join(' ')}</dd><dt>Expected output</dt><dd class="pre">${e(task.assignment.output)}</dd>${task.assignment.dependencies.length ? `<dt>Waits for</dt><dd>${e(task.assignment.dependencies.join(', '))}</dd>` : ''}${attempt?.consumed?.length ? `<dt>Received</dt><dd>${e(attempt.consumed.map((used) => `${used.task} version ${used.version}`).join(', '))}</dd>` : ''}</dl>
    ${attempt?.note && task.state !== 'review' ? `<p class="notice">${e(attempt.note)}</p>` : ''}
    ${next}
    ${attempt?.restrictions.length ? `<details id="task-limits"><summary>What the harness enforces</summary><ul>${attempt.restrictions.map((entry) => `<li>${e(entry)}</li>`).join('')}</ul><p class="fine">Verifold sets these limits in the harness. A prompt alone is not a limit.</p></details>` : ''}
    ${history.length || notes.length ? `<details id="task-history"><summary>History</summary><ul>${[...history, ...notes].join('')}</ul></details>` : ''}</article>`;
  }
  return `<section class="tasks" aria-labelledby="tasks-title"><div class="section-title"><h2 id="tasks-title">Tasks</h2><span class="count">${view.list.length}</span></div>
  <p class="fine">A task runs your harness in its own copy of the project. The harness can write only to the paths that you allow. You review each version before any file reaches your project. Up to ${workerLimit} tasks and sessions run at the same time.</p>
  ${view.list.length ? `<ol class="task-list">${view.list.map((entry) => `<li><button type="button" data-task-select="${e(entry.id)}" aria-pressed="${entry.id === task?.id}"><span>${e(entry.id)} · ${e(entry.assignment.title)}</span><span class="attempt-status">${e(taskStates[entry.state][0])}</span></button></li>`).join('')}</ol>` : ''}
  ${body}
  <details id="task-new"${view.list.length ? '' : ' open'}><summary>New task</summary>${taskForm('task-new', null, view.list, host)}<div class="actions"><button type="button" class="primary" data-action="task-create">Create task</button></div></details></section>`;
}

/** Every tool call with who let it run. Summary first, then the full list. */
function renderCommands(view: SessionView | null): string {
  if (!view || !view.record.commands.length) return '';
  const { record } = view;
  const open = record.commands.filter(needsReview);
  const shown = record.commands.slice(-100);
  return `<section class="commands" aria-labelledby="commands-title"><div class="section-title"><h2 id="commands-title">Commands</h2><span class="count">${record.commands.length > shown.length ? `Latest ${shown.length} of ${record.commands.length}` : `${record.commands.length} recorded`}</span></div><p class="fine">${open.length ? `${open.length} risky ${open.length === 1 ? 'command ran' : 'commands ran'} without a person's approval and ${open.length === 1 ? 'waits' : 'wait'} for review.` : 'No tagged command waits for review.'} Tags come from the command text. The record shows the command that the agent asked for, not the processes that it started.</p><div class="table"><table><thead><tr><th scope="col">Time</th><th scope="col">Tool</th><th scope="col">Command or target</th><th scope="col">Approved by</th><th scope="col">Risk</th><th scope="col">Result</th><th scope="col">Review</th></tr></thead><tbody>${shown
    .map(
      (command) =>
        `<tr><td>${e(clock(command.at))}</td><td>${e(command.tool)}</td><td><code>${e(command.action.length > 300 ? `${command.action.slice(0, 300)}…` : command.action || 'Not reported')}</code>${command.review?.rationale ? `<span class="fine">Reviewer: ${e(command.review.rationale)}</span>` : ''}</td><td>${e(decisionLabel(command, record.host))}</td><td>${command.risk.length ? command.risk.map((tag) => `<span class="risk">${e(tag)}</span>`).join(' ') : '<span class="fine">None</span>'}</td><td>${e(result(command))}</td><td>${needsReview(command) ? `<button type="button" data-action="review" data-command="${e(command.id)}">Mark reviewed</button>` : command.reviewedAt ? 'Reviewed' : '<span class="fine">Not needed</span>'}</td></tr>`,
    )
    .join('')}</tbody></table></div></section>`;
}

/** The terminal page: xterm.js renders one harness terminal. It runs inside the desk, or alone in its own tab. */
export const terminalPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Verifold terminal</title><link rel="icon" href="/symbol.webp"><link rel="stylesheet" href="/vendor/xterm.css"><link rel="stylesheet" href="/desk.css"><script type="module" src="/desk-terminal.js"></script></head><body class="terminal-page"><div class="terminal-bar"><span id="terminal-state" role="status">Connecting…</span><button id="terminal-take" type="button" hidden>Take input here</button></div><div id="terminal" class="terminal-screen" role="application" aria-label="Harness terminal"></div></body></html>`;

export const deskPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Verifold research desk</title><link rel="icon" href="/symbol.webp"><link rel="stylesheet" href="/desk.css"><script type="module" src="/desk-client.js"></script></head><body><a class="skip" href="#content">Skip to research</a><header class="topbar"><a class="brand" href="/" aria-label="Verifold research desk"><img src="/symbol.webp" alt="" width="36" height="36"><span>verifold</span></a><span class="desk-name">Research desk</span><div class="header-actions"><span class="privacy">Private workspace</span><button id="theme" type="button" aria-label="Switch color theme">Change theme</button></div></header><div class="connection-bar"><span id="connection" role="status">Connecting to your project…</span><span id="action-status" role="status"></span><span id="observation"></span><button id="retry" type="button">Refresh</button></div><main id="content" tabindex="-1"><div class="empty"><h1>Opening your research desk</h1><p>Reading the selected project. This does not start research.</p></div></main><footer>Research stays in your project. Your chosen harness owns its tools and permissions.</footer></body></html>`;

/** All research text is escaped. Source links are validated before rendering. */
export function renderDesk(
  snapshot: DeskSnapshot,
  selected: string | undefined,
  report: ResearchReport | null,
  live: DeskSession = { session: null, controllable: false },
): { html: string; observation: string } {
  const { workspace, attempts } = snapshot;
  const active = attempts.filter((attempt) => attempt.activity === 'recent');
  const chosen =
    attempts.find(
      (attempt) =>
        attempt.id === (selected ?? workspace.research?.latestAttempt),
    ) ?? attempts[0];
  const record = chosen?.record;
  const next = nextResearchAction(workspace);
  const researching = active.length > 0;
  const choosable =
    live.research !== undefined &&
    !live.research.running &&
    !workspace.selectedId &&
    workspace.research?.phase === 'directions';
  const observation =
    active.length === 1 && active[0]?.record?.observedAt
      ? `Research owner last observed ${time(active[0].record.observedAt)}`
      : 'No single research owner recently observed';
  const tone =
    chosen?.activity === 'recent'
      ? 'active'
      : record?.status === 'succeeded'
        ? 'success'
        : record?.status === 'failed'
          ? 'failed'
          : 'muted';
  const html = `<div class="project-heading"><p class="project-name">${e(snapshot.project)}</p><h1>${e(workspace.research?.topic ?? 'What will you investigate?')}</h1><div class="project-meta"><span>${e(phaseLabel(workspace.research?.phase))}</span><span>${e(workspace.host === 'claude' ? 'Claude Code' : workspace.host === 'codex' ? 'Codex' : workspace.host)}</span><span>Model request: ${e(workspace.model ?? 'harness default')}</span></div></div>
  <div class="desk-grid"><div class="notebook">
  ${renderResearch(live.research, workspace.research?.latestAttempt)}${renderSession(live, workspace.host)}${live.tasks ? renderTasks(live.tasks, live, workspace.host) : ''}${renderCommands(live.session)}
  <section class="brief-section"><details id="research-brief" open><summary><h2>Research brief</h2><span>Project context</span></summary>${workspace.context ? `<div class="prose md">${markdownHtml(workspace.context)}</div>` : '<p class="empty-note">No research brief is saved yet. Begin with a question in your project terminal.</p>'}</details></section>
  ${workspace.research?.plan ? `<section><details id="research-plan"><summary><h2>Research scope</h2><span>Proposed roles</span></summary><div class="prose md">${markdownHtml(workspace.research.plan.scope)}</div><ul class="roles">${workspace.research.plan.personas.map((persona) => `<li><strong>${e(persona.name)}</strong><span>${e(persona.task)}</span></li>`).join('')}</ul><p class="fine">These are proposed roles, not independently observed workers.</p></details></section>` : ''}
  <section class="findings"><div class="section-title"><h2>Sources and findings</h2>${chosen ? `<span class="count">Attempt ${e(chosen.id.slice(0, 8))}</span>` : ''}</div>
  ${report ? `<div class="prose md">${markdownHtml(report.summary)}</div><ol class="sources">${report.sources.map((source, index) => `<li><a id="source-${e(chosen?.id ?? '')}-${index}" href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${e(source.title)}</a><span>${e(new URL(source.url).hostname)}</span></li>`).join('')}</ol><details id="delegation"><summary>Delegation reported by the model</summary><div class="prose md">${markdownHtml(report.delegation)}</div></details><p class="fine">Source links provide traceability. Scientific claims still need review.</p>` : `<div class="empty-note"><p>${chosen ? 'No readable source report is available for this attempt.' : 'Your source record starts here.'}</p><p>${chosen ? 'Planning, failed, and interrupted attempts may have no report. Their evidence remains in the project.' : 'Run research from your project terminal. Sources and findings will appear here when a report is saved.'}</p></div>`}</section>
  ${workspace.candidates.length ? `<section><div class="section-title"><h2>Research directions</h2><span class="count">${workspace.candidates.length} proposed</span></div>${workspace.candidates.map((idea) => `<article class="direction"><div class="direction-heading"><h3>${e(idea.title)}</h3>${workspace.selectedId === idea.id ? '<span class="selected-label">Selected</span>' : ''}</div><div class="md">${markdownHtml(idea.recommendation)}</div>${choosable ? `<div class="actions"><button type="button" data-action="select" data-idea="${e(idea.id)}" data-confirm="Click again to lock this direction">Choose this direction</button></div>` : ''}<details id="gates-${e(idea.id)}"><summary>Proposed verification gates</summary><ul>${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul></details></article>`).join('')}</section>` : ''}
  </div><aside aria-label="Research activity">${
    live.research && !workspace.selectedId
      ? renderDecision(workspace, live)
      : researching
        ? '<section class="next-action"><h2>Research is running</h2><p>Research runs in your terminal. The results appear here when this step ends.</p><p class="fine">To stop it, press Ctrl+C in that terminal. This also closes the desk.</p></section>'
        : `<section class="next-action"><h2>Continue your research</h2><p>${e(next.instruction)}</p><p class="fine">Run in your project terminal</p><div class="command"><code>${e(next.command)}</code><button id="copy-command" type="button" data-command="${e(next.command)}" aria-label="Copy next command">Copy</button></div><p class="fine">${live.controllable ? 'Opening the desk never starts a harness. Start one under Workers.' : 'The desk only reads saved work. Opening it never starts a harness.'}</p></section>`
  }
  <section class="attempt-detail"><div class="section-title"><h2>Selected attempt</h2>${chosen ? `<span class="status ${tone}">${e(outcome(chosen))}</span>` : ''}</div>
  ${chosen ? `<p>${e(record ? phaseLabel(record.phase) : 'No readable lifecycle record')}</p>${chosen.activity === 'unknown' ? '<p class="notice">The final outcome is unknown. Inspect the attempt files and confirm whether research is still active before retrying or removing a lock.</p>' : chosen.activity === 'recent' ? `<p class="fine">${live.research ? 'The research owner recently reported activity. Follow it in Research.' : 'The research owner recently reported activity. The adapter provides lifecycle and final output, not live tool output.'}</p>` : record?.status === 'interrupted' ? '<p class="notice">Verifold stopped during this attempt, so its outcome is unknown. Continue research to run the step again from the saved checkpoint.</p>' : record?.status === 'failed' || record?.status === 'cancelled' ? '<p class="notice">Available evidence is preserved. Inspect the attempt files and saved checkpoint before continuing.</p>' : '<p class="fine">The response passed validation and its checkpoint was saved.</p>'}<details id="attempt-identity"><summary>Harness and session details</summary><dl><dt>Verifold attempt</dt><dd>${e(chosen.id)}</dd><dt>Harness</dt><dd>${e(record?.host ?? 'Unknown')}</dd><dt>Requested model</dt><dd>${e(record ? (record.model ?? 'Harness default; resolved model unknown') : 'Unknown')}</dd><dt>Native session</dt><dd>${e(record?.nativeSessionId ?? 'Not reported')}</dd><dt>Requested session</dt><dd>${e(record ? (record.requestedSessionId ?? 'New session requested') : 'Unknown')}</dd>${record ? `<dt>Started</dt><dd>${e(time(record.startedAt))}</dd><dt>Finished</dt><dd>${e(record.finishedAt ? time(record.finishedAt) : 'Not recorded')}</dd>` : ''}</dl></details>${live.research?.step && chosen.id === workspace.research?.latestAttempt ? '<p class="fine">Its transcript is under Research. Choose Details there.</p>' : `<details id="attempt-transcript"><summary>Harness transcript</summary>${transcriptSlot(`attempt:${chosen.id}`, 'Attempt transcript', '')}</details>`}` : '<p class="empty-note">No research attempts yet.</p>'}</section>
  <section class="history"><div class="section-title"><h2>Attempt history</h2><span class="count">${attempts.length}</span></div>${snapshot.historyLimited ? '<p class="notice">History scan is limited to 200 entries, plus the latest recorded attempt. Inspect the project files for the complete record.</p>' : ''}<ol>${attempts.map((attempt) => `<li><button type="button" data-attempt="${e(attempt.id)}" ${chosen?.id === attempt.id ? 'aria-pressed="true"' : 'aria-pressed="false"'}><span class="attempt-title">${e(attempt.record ? phaseLabel(attempt.record.phase) : 'Unrecorded attempt')}</span><span class="attempt-status">${e(outcome(attempt))}</span><span class="attempt-reference">${e(attempt.id.slice(0, 8))}${attempt.record ? ` <time datetime="${e(attempt.record.startedAt)}">${e(time(attempt.record.startedAt))}</time>` : ''}</span></button></li>`).join('')}</ol>${!attempts.length ? '<p class="empty-note">Each research request will appear here with its own identity.</p>' : ''}</section></aside></div>`;
  return { html, observation };
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
} {
  if (!view)
    return {
      html: '<div class="empty"><h1>Setting up</h1><p>Verifold is starting setup.</p></div>',
      observation: '',
    };
  const current = view.step ? setupSteps.indexOf(view.step) : -1;
  const html = `<div class="project-heading"><p class="project-name">New project</p><h1>Set up a project</h1></div>
  <ol class="setup-steps" aria-label="Setup steps">${setupSteps
    .map(
      (name, index) =>
        `<li data-state="${index < current ? 'done' : index === current ? 'current' : 'next'}"${index === current ? ' aria-current="step"' : ''}>${e(name)}</li>`,
    )
    .join('')}</ol>
  <div class="setup">${detailSwitch}<ol class="setup-lines">${view.lines
    .slice(-60)
    .map(
      (line) =>
        `<li class="event setup-${line.source}"><span class="event-kind">${setupLabels[line.source]}</span>${line.source === 'tool' || line.source === 'you' ? `<span class="event-text">${e(line.text)}</span>` : `<div class="event-text md">${markdownHtml(line.text)}</div>`}<time datetime="${e(line.at)}">${e(clock(line.at))}</time></li>`,
    )
    .join('')}</ol>
  ${transcriptSlot('setup', 'Harness transcript')}
  ${view.busy ? `<p class="setup-busy" role="status">${e(view.busy.label)} · ${e(elapsed(view.busy.startedAt))}</p>` : ''}
  ${view.prompt ? renderSetupPrompt(view.prompt) : ''}
  ${view.outcome === 'done' ? '<p class="notice">Setup is complete. The project desk opens here.</p>' : ''}
  ${view.outcome === 'stopped' ? `<p class="notice">${e(view.error ?? 'Setup stopped.')}</p><p class="fine">Run verifold again in your terminal to start over.</p>` : ''}</div>`;
  return { html, observation: view.step ? `Setup step: ${view.step}` : '' };
}
