import { escapeHtml as e } from '../ui/dom.ts';
import type { Workspace } from './contracts.ts';
import type { DeskSnapshot, DeskAttempt } from './desk-records.ts';
import type { ResearchReport } from './research.ts';
import {
  decisionLabel,
  hostName,
  modeLabel,
  needsReview,
  type CommandEntry,
  type SessionEvent,
  type SessionView,
} from './session.ts';

export interface DeskSession {
  readonly session: SessionView | null;
  /** The desk process owns a session manager, so the page can start and control a session. */
  readonly controllable: boolean;
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
  }
}

const sessionStatus: Record<string, [string, string]> = {
  starting: ['Starting', 'active'],
  running: ['Working', 'active'],
  idle: ['Waiting for a follow-up', 'success'],
  ended: ['Ended', 'muted'],
  failed: ['Stopped with an error', 'failed'],
};

/** The live session, its requests, and its controls. All harness text is escaped. */
function renderSession(live: DeskSession, defaultHost: string): string {
  const view = live.session;
  if (!view && !live.controllable) return '';
  const record = view?.record;
  const running = view?.live === true;
  const [label, tone] = record
    ? (sessionStatus[record.status] ?? ['Unknown', 'muted'])
    : ['', ''];
  const start = live.controllable && !running;
  const host = record?.host ?? (defaultHost === 'codex' ? 'codex' : 'claude');
  return `<section class="session" aria-labelledby="session-title"><div class="section-title"><h2 id="session-title">Harness session</h2>${record ? `<span class="status ${tone}">${e(running ? label : record.status === 'failed' ? label : 'Ended')}</span>` : ''}</div>
  ${
    record
      ? `<p class="session-meta"><span>${e(hostName(record.host))}</span><span>Mode: ${e(modeLabel(record))}</span><span>Model request: ${e(record.model ?? 'harness default')}</span>${record.costUsd === null ? '' : `<span>Cost estimate from Claude Code: $${e(record.costUsd.toFixed(2))}</span>`}</p>
  ${view?.saveFailed ? '<p class="notice">Verifold could not save the latest session record. The next change tries again.</p>' : ''}
  ${record.requests.length > 10 ? `<p class="notice">${record.requests.length} requests are open. The first 10 are shown.</p>` : ''}
  ${record.requests
    .slice(0, 10)
    .map(
      (request) =>
        `<article class="request" aria-label="Request ${e(request.id)}"><p class="request-type">${e(request.id)} · Needs you</p><p>${e(hostName(record.host))} asks to use ${e(request.tool)}.</p><code>${e(request.action)}</code>${request.detail ? `<p class="fine">Change to review:</p><code class="detail">${e(request.detail)}</code>` : ''}${request.reason ? `<p class="fine">Reason from the harness: ${e(request.reason)}</p>` : ''}<div class="actions"><button type="button" class="primary" data-action="answer" data-request="${e(request.id)}" data-decision="allow">Allow once</button><button type="button" data-action="answer" data-request="${e(request.id)}" data-decision="deny">Deny</button></div></article>`,
    )
    .join('')}
  <ol class="session-events">${record.events
    .slice(-60)
    .map(
      (event) =>
        `<li class="event event-${e(event.kind)}"><span class="event-kind">${e(eventLabels[event.kind])}</span><span class="event-text">${e(event.text)}</span><time datetime="${e(event.at)}">${e(clock(event.at))}</time></li>`,
    )
    .join('')}</ol>
  ${
    running
      ? record.status === 'idle'
        ? `<label class="field" for="follow-up">Follow-up</label><textarea id="follow-up" rows="3" maxlength="100000" placeholder="Ask the agent to continue or change course."></textarea><div class="actions"><button type="button" class="primary" data-action="send">Send follow-up</button><button type="button" data-action="end">End session</button></div>`
        : `<div class="actions"><button type="button" data-action="cancel">Cancel this turn</button><button type="button" data-action="end">End session</button></div>`
      : ''
  }
  ${!running && record.nativeSessionId ? `<p class="fine">Native session: ${e(record.nativeSessionId)}. The record is in .verifold/sessions/${e(record.id)}.json.</p>` : ''}`
      : ''
  }
  ${
    start
      ? `<div class="start"><h3>${record ? 'Start another session' : 'Start a session'}</h3><p class="fine">The harness runs in this project folder with its own sign-in and settings. In Ask me, each permission request comes here and to your terminal. Verifold records each tool call that the harness reports.</p><div class="fields"><label class="field" for="session-host">Harness<select id="session-host"><option value="claude"${host === 'claude' ? ' selected' : ''}>Claude Code</option><option value="codex"${host === 'codex' ? ' selected' : ''}>Codex</option></select></label><label class="field" for="session-mode">Commands<select id="session-mode"><option value="ask">Ask me</option><option value="auto">Auto</option></select></label><label class="field" for="session-model">Model<input id="session-model" type="text" maxlength="200" placeholder="Harness default"></label></div><label class="field" for="session-prompt">Request</label><textarea id="session-prompt" rows="4" maxlength="100000" placeholder="What should the harness do?"></textarea><div class="actions"><button type="button" class="primary" data-action="start">Start session</button></div></div>`
      : ''
  }</section>`;
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
  ${renderSession(live, workspace.host)}${renderCommands(live.session)}
  <section class="brief-section"><details id="research-brief" open><summary><h2>Research brief</h2><span>Project context</span></summary>${workspace.context ? `<div class="prose">${e(workspace.context)}</div>` : '<p class="empty-note">No research brief is saved yet. Begin with a question in your project terminal.</p>'}</details></section>
  ${workspace.research?.plan ? `<section><details id="research-plan"><summary><h2>Research scope</h2><span>Proposed roles</span></summary><div class="prose">${e(workspace.research.plan.scope)}</div><ul class="roles">${workspace.research.plan.personas.map((persona) => `<li><strong>${e(persona.name)}</strong><span>${e(persona.task)}</span></li>`).join('')}</ul><p class="fine">These are proposed roles, not independently observed workers.</p></details></section>` : ''}
  <section class="findings"><div class="section-title"><h2>Sources and findings</h2>${chosen ? `<span class="count">Attempt ${e(chosen.id.slice(0, 8))}</span>` : ''}</div>
  ${report ? `<div class="prose">${e(report.summary)}</div><ol class="sources">${report.sources.map((source, index) => `<li><a id="source-${e(chosen?.id ?? '')}-${index}" href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${e(source.title)}</a><span>${e(new URL(source.url).hostname)}</span></li>`).join('')}</ol><details id="delegation"><summary>Delegation reported by the model</summary><div class="prose">${e(report.delegation)}</div></details><p class="fine">Source links provide traceability. Scientific claims still need review.</p>` : `<div class="empty-note"><p>${chosen ? 'No readable source report is available for this attempt.' : 'Your source record starts here.'}</p><p>${chosen ? 'Planning, failed, and interrupted attempts may have no report. Their evidence remains in the project.' : 'Run research from your project terminal. Sources and findings will appear here when a report is saved.'}</p></div>`}</section>
  ${workspace.candidates.length ? `<section><div class="section-title"><h2>Research directions</h2><span class="count">${workspace.candidates.length} proposed</span></div>${workspace.candidates.map((idea) => `<article class="direction"><div class="direction-heading"><h3>${e(idea.title)}</h3>${workspace.selectedId === idea.id ? '<span class="selected-label">Selected</span>' : ''}</div><p>${e(idea.recommendation)}</p><details id="gates-${e(idea.id)}"><summary>Proposed verification gates</summary><ul>${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul></details></article>`).join('')}</section>` : ''}
  </div><aside aria-label="Research activity"><section class="next-action"><h2>Continue your research</h2><p>${e(next.instruction)}</p><p class="fine">Run in your project terminal</p><div class="command"><code>${e(next.command)}</code><button id="copy-command" type="button" data-command="${e(next.command)}" aria-label="Copy next command">Copy</button></div><p class="fine">${live.controllable ? 'Opening the desk never starts a harness. Start one in Harness session.' : 'The desk only reads saved work. Opening it never starts a harness.'}</p></section>
  <section class="attempt-detail"><div class="section-title"><h2>Selected attempt</h2>${chosen ? `<span class="status ${tone}">${e(outcome(chosen))}</span>` : ''}</div>
  ${chosen ? `<p>${e(record ? phaseLabel(record.phase) : 'No readable lifecycle record')}</p>${chosen.activity === 'unknown' ? '<p class="notice">The final outcome is unknown. Inspect the attempt files and confirm whether research is still active before retrying or removing a lock.</p>' : chosen.activity === 'recent' ? '<p class="fine">The research owner recently reported activity. The adapter provides lifecycle and final output, not live tool output.</p>' : record?.status === 'failed' || record?.status === 'cancelled' ? '<p class="notice">Available evidence is preserved. Inspect the attempt files and saved checkpoint before continuing.</p>' : '<p class="fine">The response passed validation and its checkpoint was saved.</p>'}<details id="attempt-identity"><summary>Harness and session details</summary><dl><dt>Verifold attempt</dt><dd>${e(chosen.id)}</dd><dt>Harness</dt><dd>${e(record?.host ?? 'Unknown')}</dd><dt>Requested model</dt><dd>${e(record ? (record.model ?? 'Harness default; resolved model unknown') : 'Unknown')}</dd><dt>Native session</dt><dd>${e(record?.nativeSessionId ?? 'Not reported')}</dd><dt>Requested session</dt><dd>${e(record ? (record.requestedSessionId ?? 'New session requested') : 'Unknown')}</dd>${record ? `<dt>Started</dt><dd>${e(time(record.startedAt))}</dd><dt>Finished</dt><dd>${e(record.finishedAt ? time(record.finishedAt) : 'Not recorded')}</dd>` : ''}</dl></details>` : '<p class="empty-note">No research attempts yet.</p>'}</section>
  <section class="history"><div class="section-title"><h2>Attempt history</h2><span class="count">${attempts.length}</span></div>${snapshot.historyLimited ? '<p class="notice">History scan is limited to 200 entries, plus the latest recorded attempt. Inspect the project files for the complete record.</p>' : ''}<ol>${attempts.map((attempt) => `<li><button type="button" data-attempt="${e(attempt.id)}" ${chosen?.id === attempt.id ? 'aria-pressed="true"' : 'aria-pressed="false"'}><span class="attempt-title">${e(attempt.record ? phaseLabel(attempt.record.phase) : 'Unrecorded attempt')}</span><span class="attempt-status">${e(outcome(attempt))}</span><span class="attempt-reference">${e(attempt.id.slice(0, 8))}${attempt.record ? ` <time datetime="${e(attempt.record.startedAt)}">${e(time(attempt.record.startedAt))}</time>` : ''}</span></button></li>`).join('')}</ol>${!attempts.length ? '<p class="empty-note">Each research request will appear here with its own identity.</p>' : ''}</section></aside></div>`;
  return { html, observation };
}
