import type {
  ActionBodies,
  AgentTool,
  ProjectAgents,
  SetupView,
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
    typeof view.questionLimit === 'number'
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

/** The harnesses that the profile uses, the lead first, with their models. Null: the profile names none. */
export function profileAgents(
  tools: readonly AgentTool[],
): ProjectAgents | null {
  const [lead, second] = tools.filter((tool) => tool.use);
  if (!lead) return null;
  return {
    host: lead.harness,
    ...(lead.model ? { model: lead.model } : {}),
    ...(second
      ? {
          helper: second.harness,
          ...(second.model ? { helperModel: second.model } : {}),
        }
      : {}),
  };
}

function agentName(harness: ProjectAgents['host'], model?: string): string {
  return model
    ? `${harnessName(harness)} ${modelName(model)}`
    : harness === 'claude'
      ? 'Claude Code'
      : 'Codex';
}

/** The agents chip: "Claude Opus (1M) and Codex GPT-6 Astra". */
export function agentsLabel(agents: ProjectAgents | null): string {
  if (!agents) return 'Claude Code';
  const lead = agentName(agents.host, agents.model);
  return agents.helper
    ? `${lead} and ${agentName(agents.helper, agents.helperModel)}`
    : lead;
}

/**
 * The GPU limit of a new project: the profile's limit when the person set
 * the GPU money step, else none, because a project without the profile's
 * limits starts with pods off.
 */
export function profileGpu(view: SetupView): number | null {
  return view.steps.money === 'done' ? view.money.limits.limitUsd : null;
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
