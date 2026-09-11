import { validateModel } from './harness.ts';
import { parseProfile } from '../domain/profile.ts';
import type { Profile } from '../domain/profile.ts';
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
}
export interface Workspace {
  readonly schemaVersion: 1;
  readonly visibility: 'private';
  readonly profile: Profile;
  readonly host: string;
  readonly model?: string;
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
    if (
      !Array.isArray(data.gates) ||
      !data.gates.length ||
      data.gates.length > 20
    )
      throw new Error('Each idea needs 1–20 proposed verification gates.');
    return {
      id,
      title: string(data.title, 'title'),
      recommendation: string(data.recommendation, 'recommendation'),
      gates: data.gates.map((gate: unknown) => string(gate, 'gate')),
      ...(data.sources === undefined
        ? {}
        : { sources: parseSources(data.sources) }),
    };
  });
  if (new Set(candidates.map((idea) => idea.id)).size !== candidates.length)
    throw new Error('Idea IDs must be unique.');
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
  return {
    schemaVersion: 1,
    visibility: 'private',
    profile: parseProfile(data.profile),
    host: string(data.host, 'host'),
    ...(data.model ? { model: data.model } : {}),
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

function parseContext(value: unknown): string {
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
