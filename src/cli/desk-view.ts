import { escapeHtml as e } from '../ui/dom.ts';
import type { Workspace } from './contracts.ts';
import type { DeskSnapshot, DeskAttempt } from './desk-records.ts';
import type { ResearchReport } from './research.ts';

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

export const deskPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Verifold research desk</title><link rel="icon" href="/symbol.webp"><link rel="stylesheet" href="/desk.css"><script type="module" src="/desk-client.js"></script></head><body><a class="skip" href="#content">Skip to research</a><header class="topbar"><a class="brand" href="/" aria-label="Verifold research desk"><img src="/symbol.webp" alt="" width="36" height="36"><span>verifold</span></a><span class="desk-name">Research desk</span><div class="header-actions"><span class="privacy">Private workspace</span><button id="theme" type="button" aria-label="Switch color theme">Change theme</button></div></header><div class="connection-bar"><span id="connection" role="status">Connecting to your project…</span><span id="observation"></span><button id="retry" type="button">Refresh</button></div><main id="content" tabindex="-1"><div class="empty"><h1>Opening your research desk</h1><p>Reading the selected project. This does not start research.</p></div></main><footer>Research stays in your project. Your chosen harness owns its tools and permissions.</footer></body></html>`;

/** All research text is escaped. Source links are validated before rendering. */
export function renderDesk(
  snapshot: DeskSnapshot,
  selected: string | undefined,
  report: ResearchReport | null,
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
  <section class="brief-section"><details id="research-brief" open><summary><h2>Research brief</h2><span>Project context</span></summary>${workspace.context ? `<div class="prose">${e(workspace.context)}</div>` : '<p class="empty-note">No research brief is saved yet. Begin with a question in your project terminal.</p>'}</details></section>
  ${workspace.research?.plan ? `<section><details id="research-plan"><summary><h2>Research scope</h2><span>Proposed roles</span></summary><div class="prose">${e(workspace.research.plan.scope)}</div><ul class="roles">${workspace.research.plan.personas.map((persona) => `<li><strong>${e(persona.name)}</strong><span>${e(persona.task)}</span></li>`).join('')}</ul><p class="fine">These are proposed roles, not independently observed workers.</p></details></section>` : ''}
  <section class="findings"><div class="section-title"><h2>Sources and findings</h2>${chosen ? `<span class="count">Attempt ${e(chosen.id.slice(0, 8))}</span>` : ''}</div>
  ${report ? `<div class="prose">${e(report.summary)}</div><ol class="sources">${report.sources.map((source, index) => `<li><a id="source-${e(chosen?.id ?? '')}-${index}" href="${e(source.url)}" target="_blank" rel="noopener noreferrer">${e(source.title)}</a><span>${e(new URL(source.url).hostname)}</span></li>`).join('')}</ol><details id="delegation"><summary>Delegation reported by the model</summary><div class="prose">${e(report.delegation)}</div></details><p class="fine">Source links provide traceability. Scientific claims still need review.</p>` : `<div class="empty-note"><p>${chosen ? 'No readable source report is available for this attempt.' : 'Your source record starts here.'}</p><p>${chosen ? 'Planning, failed, and interrupted attempts may have no report. Their evidence remains in the project.' : 'Run research from your project terminal. Sources and findings will appear here when a report is saved.'}</p></div>`}</section>
  ${workspace.candidates.length ? `<section><div class="section-title"><h2>Research directions</h2><span class="count">${workspace.candidates.length} proposed</span></div>${workspace.candidates.map((idea) => `<article class="direction"><div class="direction-heading"><h3>${e(idea.title)}</h3>${workspace.selectedId === idea.id ? '<span class="selected-label">Selected</span>' : ''}</div><p>${e(idea.recommendation)}</p><details id="gates-${e(idea.id)}"><summary>Proposed verification gates</summary><ul>${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul></details></article>`).join('')}</section>` : ''}
  </div><aside aria-label="Research activity"><section class="next-action"><h2>Continue your research</h2><p>${e(next.instruction)}</p><p class="fine">Run in your project terminal</p><div class="command"><code>${e(next.command)}</code><button id="copy-command" type="button" data-command="${e(next.command)}" aria-label="Copy next command">Copy</button></div><p class="fine">The desk only reads saved work. Opening it never starts a harness.</p></section>
  <section class="attempt-detail"><div class="section-title"><h2>Selected attempt</h2>${chosen ? `<span class="status ${tone}">${e(outcome(chosen))}</span>` : ''}</div>
  ${chosen ? `<p>${e(record ? phaseLabel(record.phase) : 'No readable lifecycle record')}</p>${chosen.activity === 'unknown' ? '<p class="notice">The final outcome is unknown. Inspect the attempt files and confirm whether research is still active before retrying or removing a lock.</p>' : chosen.activity === 'recent' ? '<p class="fine">The research owner recently reported activity. The adapter provides lifecycle and final output, not live tool output.</p>' : record?.status === 'failed' || record?.status === 'cancelled' ? '<p class="notice">Available evidence is preserved. Inspect the attempt files and saved checkpoint before continuing.</p>' : '<p class="fine">The response passed validation and its checkpoint was saved.</p>'}<details id="attempt-identity"><summary>Harness and session details</summary><dl><dt>Verifold attempt</dt><dd>${e(chosen.id)}</dd><dt>Harness</dt><dd>${e(record?.host ?? 'Unknown')}</dd><dt>Requested model</dt><dd>${e(record ? (record.model ?? 'Harness default; resolved model unknown') : 'Unknown')}</dd><dt>Native session</dt><dd>${e(record?.nativeSessionId ?? 'Not reported')}</dd><dt>Requested session</dt><dd>${e(record ? (record.requestedSessionId ?? 'New session requested') : 'Unknown')}</dd>${record ? `<dt>Started</dt><dd>${e(time(record.startedAt))}</dd><dt>Finished</dt><dd>${e(record.finishedAt ? time(record.finishedAt) : 'Not recorded')}</dd>` : ''}</dl></details>` : '<p class="empty-note">No research attempts yet.</p>'}</section>
  <section class="history"><div class="section-title"><h2>Attempt history</h2><span class="count">${attempts.length}</span></div>${snapshot.historyLimited ? '<p class="notice">History scan is limited to 200 entries, plus the latest recorded attempt. Inspect the project files for the complete record.</p>' : ''}<ol>${attempts.map((attempt) => `<li><button type="button" data-attempt="${e(attempt.id)}" ${chosen?.id === attempt.id ? 'aria-pressed="true"' : 'aria-pressed="false"'}><span class="attempt-title">${e(attempt.record ? phaseLabel(attempt.record.phase) : 'Unrecorded attempt')}</span><span class="attempt-status">${e(outcome(attempt))}</span><span class="attempt-reference">${e(attempt.id.slice(0, 8))}${attempt.record ? ` <time datetime="${e(attempt.record.startedAt)}">${e(time(attempt.record.startedAt))}</time>` : ''}</span></button></li>`).join('')}</ol>${!attempts.length ? '<p class="empty-note">Each research request will appear here with its own identity.</p>' : ''}</section></aside></div>`;
  return { html, observation };
}
