import { validateModel } from './harness.ts';
import { parseProfile } from './profile.ts';
import type { Profile } from './profile.ts';
import {
  object as record,
  parseResearchState,
  sourceUrl,
} from './research-contracts.ts';
import type { ResearchState } from './research-contracts.ts';
export interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly recommendation: string;
  readonly gates: readonly string[];
  readonly sources?: readonly string[];
  /** The recommended direction, an add-on that fits beside it, or an alternative that replaces it. */
  readonly kind?: 'main' | 'extra' | 'alternative';
}

/** The direction that research recommends: the one marked main, else the first. */
export function mainDirection(
  candidates: readonly Candidate[],
): Candidate | undefined {
  return (
    candidates.find((candidate) => candidate.kind === 'main') ?? candidates[0]
  );
}
export interface Workspace {
  readonly schemaVersion: 1;
  readonly visibility: 'private';
  readonly profile: Profile;
  readonly host: string;
  readonly model?: string;
  /** The second harness of the team. The coordinator can give it tasks. The lead (`host`) runs research and the coordinator. */
  readonly helper?: 'claude' | 'codex';
  /** How many agents may run at the same time, 1 to 8. Absent means the default, 3. */
  readonly agents?: number;
  readonly context?: string;
  readonly candidates: readonly Candidate[];
  readonly selectedId: string | null;
  readonly research?: ResearchState;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000)
    throw new Error(`Invalid ${label}.`);
  return value.trim();
}
/** Validate recommendations provided by the host; recommendations never authorize execution. */
export function parseCandidates(value: unknown): readonly Candidate[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw new Error('Supply between 1 and 20 candidate ideas.');
  const candidates = value.map((item: unknown) => {
    const data = record(item);
    const id = string(data.id, 'idea ID');
    if (!/^[a-z0-9-]{1,80}$/.test(id))
      throw new Error(
        'Idea IDs must contain lowercase letters, digits, or hyphens.',
      );
    const kind = (['main', 'extra', 'alternative'] as const).find(
      (value) => value === data.kind,
    );
    // Older hosts and saved projects name the checks `gates`. The record keeps that field.
    const checks: unknown = data.checks ?? data.gates;
    if (!Array.isArray(checks) || !checks.length || checks.length > 20)
      throw new Error('Each idea needs 1 to 20 proposed checks.');
    return {
      id,
      title: string(data.title, 'title'),
      recommendation: string(data.recommendation, 'recommendation'),
      gates: checks.map((check: unknown) => string(check, 'check')),
      ...(data.sources === undefined
        ? {}
        : { sources: parseSources(data.sources) }),
      ...(kind ? { kind } : {}),
    };
  });
  if (new Set(candidates.map((idea) => idea.id)).size !== candidates.length)
    throw new Error('Idea IDs must be unique.');
  if (candidates.filter((idea) => idea.kind === 'main').length > 1)
    throw new Error('Mark at most one direction as main.');
  return candidates;
}
function parseSources(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > 30)
    throw new Error('Supply 1 to 30 source links per idea.');
  return [...new Set(value.map((item: unknown) => sourceUrl(item)))];
}
export function parseWorkspace(value: unknown): Workspace {
  const data = record(value);
  if (data.schemaVersion !== 1 || data.visibility !== 'private')
    throw new Error('Unsupported workspace version or visibility.');
  const candidates =
    Array.isArray(data.candidates) && data.candidates.length === 0
      ? []
      : parseCandidates(data.candidates);
  const selectedId =
    data.selectedId === null ? null : string(data.selectedId, 'selection');
  if (
    selectedId &&
    !candidates.some((candidate) => candidate.id === selectedId)
  )
    throw new Error('Selected idea is missing.');
  validateModel(data.model);
  const host = string(data.host, 'host');
  const helper = (['claude', 'codex'] as const).find(
    (name) => name === data.helper && name !== host,
  );
  if (data.agents !== undefined && !validAgents(data.agents))
    throw new Error('Agents at once must be a whole number from 1 to 8.');
  return {
    schemaVersion: 1,
    visibility: 'private',
    profile: parseProfile(data.profile),
    host,
    ...(data.model ? { model: data.model } : {}),
    ...(helper ? { helper } : {}),
    ...(data.agents === undefined ? {} : { agents: data.agents }),
    ...(data.context === undefined
      ? {}
      : { context: parseContext(data.context) }),
    candidates,
    selectedId,
    ...(data.research === undefined
      ? {}
      : { research: parseResearchState(data.research) }),
  };
}

/** A valid "Agents at once" setting: a whole number from 1 to 8. */
export function validAgents(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 8;
}

export function parseContext(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > 12000
  )
    throw new Error(
      'Research context must be nonempty text of at most 12000 bytes.',
    );
  return value;
}
