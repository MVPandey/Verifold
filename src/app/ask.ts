import type {
  ActionBodies,
  Harness,
  ProjectAgents,
  StartView,
} from '../protocol/api.ts';
import { act, load, type ActOutcome, type Loaded } from './api.ts';
import { due, harnessName, modelName, usd } from './format.ts';

/** The Ask page's read and its start. Each start takes the key of the person's intent (see intent.ts). */
export interface StartActions {
  readonly read: (signal?: AbortSignal) => Promise<Loaded<StartView>>;
  readonly start: (
    body: Omit<ActionBodies['project-start'], 'key'>,
    key: string,
  ) => Promise<ActOutcome>;
}

/** The server is Verifold itself. This check catches an older server without the Ask page. */
export function isStartView(value: unknown): value is StartView {
  if (typeof value !== 'object' || value === null) return false;
  const view = value as Record<string, unknown>;
  return (
    typeof view.folder === 'string' &&
    typeof view.files === 'boolean' &&
    typeof view.hours === 'number' &&
    typeof view.maxHours === 'number' &&
    typeof view.questionLimit === 'number' &&
    (view.agents === null || typeof view.agents === 'object') &&
    (view.gpuUsd === null || typeof view.gpuUsd === 'number') &&
    typeof view.gpuLimits === 'boolean' &&
    typeof view.started === 'boolean'
  );
}

export function startActions(token: string | null): StartActions {
  if (!token)
    return {
      read: () => Promise.resolve({ error: 'This tab has no access key.' }),
      start: () => Promise.resolve({ refused: 'This tab has no access key.' }),
    };
  return {
    read: (signal) => load(token, '/api/v1/start', isStartView, signal),
    start: (body, key) => act(token, 'project-start', body, key),
  };
}

/** The harnesses on this computer in the team's order: the lead, its helper, then the others. */
export function teamOrder<T extends { readonly harness: Harness }>(
  tools: readonly T[],
  agents: ProjectAgents | null,
): T[] {
  const rank = (harness: Harness): number =>
    harness === agents?.host ? 0 : harness === agents?.helper ? 1 : 2;
  return [...tools].sort((a, b) => rank(a.harness) - rank(b.harness));
}

/**
 * The team after the person uses a harness or not, or picks its model ('':
 * the harness's own default). The lead stays the lead: a new harness joins as
 * its helper, and when the lead leaves, its helper leads.
 */
export function withUse(
  agents: ProjectAgents | null,
  harness: Harness,
  use: boolean,
  model?: string,
): ProjectAgents | null {
  const member = (
    name: Harness,
    picked: string | undefined,
  ): { readonly harness: Harness; readonly model?: string } => ({
    harness: name,
    ...(picked ? { model: picked } : {}),
  });
  const team = [
    ...(agents ? [member(agents.host, agents.model)] : []),
    ...(agents?.helper ? [member(agents.helper, agents.helperModel)] : []),
  ];
  const at = team.findIndex((entry) => entry.harness === harness);
  if (!use) {
    if (at >= 0) team.splice(at, 1);
  } else if (at < 0) team.push(member(harness, model || undefined));
  else if (model !== undefined) team[at] = member(harness, model || undefined);
  const [lead, second] = team;
  return lead
    ? {
        host: lead.harness,
        ...(lead.model ? { model: lead.model } : {}),
        ...(second
          ? {
              helper: second.harness,
              ...(second.model ? { helperModel: second.model } : {}),
            }
          : {}),
      }
    : null;
}

/** Whole hours from 1 to `max`, from what the person typed, or null. */
export function validHours(text: string, max: number): number | null {
  const value = text.trim();
  if (!/^\d{1,4}$/.test(value)) return null;
  const hours = Number(value);
  return hours >= 1 && hours <= max ? hours : null;
}

function agentName(harness: ProjectAgents['host'], model?: string): string {
  return model
    ? `${harnessName(harness)} ${modelName(model)}`
    : harness === 'claude'
      ? 'Claude Code'
      : 'Codex';
}

/** The agents chip: "Claude Opus (1M) and Codex GPT-6 Astra". A harness without a model runs its own default. */
export function agentsLabel(agents: ProjectAgents): string {
  const lead = agentName(agents.host, agents.model);
  return agents.helper
    ? `${lead} and ${agentName(agents.helper, agents.helperModel)}`
    : lead;
}

/** The GPU chip: "GPUs up to $25", or "No GPUs". */
export function gpuLabel(limit: number | null): string {
  return limit === null ? 'No GPUs' : `GPUs up to ${usd(limit)}`;
}

/** The time chip: "Answer by Fri 18:00", the end of a time budget that starts now. */
export function dueLabel(hours: number, now: number): string {
  return `Answer by ${due(new Date(now + hours * 3_600_000).toISOString(), now)}`;
}

/**
 * A folder that the person typed: a full path, or one under the home folder
 * with `~/`. Anything else is not a folder that Verifold takes.
 */
export function validFolder(value: string): boolean {
  const path = value.trim();
  return path.length <= 4096 && (path.startsWith('/') || path.startsWith('~/'));
}

/**
 * After a Start whose answer was lost: did the project start? Yes when the
 * Verifold of this page says so, or no longer answers, because it handed
 * the project on. No when it answers and has started nothing.
 */
export function startedAfterLost(read: Loaded<StartView>): boolean {
  return !('value' in read) || read.value.started;
}
