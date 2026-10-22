/**
 * Read-only records of the research flow that came before the lab: a research
 * attempt and its report. The old research runner writes them; History and
 * the desk read them. A record is Verifold's own file, but a harness that can
 * write in the project can write it too, so each one is checked before use.
 */
import { parseCandidates, type Candidate } from './contracts.ts';
import { validateModel } from './harness.ts';
import {
  object,
  sourceUrl,
  text,
  type ResearchState,
} from './research-contracts.ts';

export interface AttemptRecord {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly host: 'claude' | 'codex';
  readonly model: string | null;
  readonly phase: ResearchState['phase'];
  readonly requestedSessionId: string | null;
  readonly nativeSessionId: string | null;
  readonly startedAt: string;
  readonly observedAt?: string;
  readonly finishedAt: string | null;
  /** `interrupted`: the owner stopped during the attempt. Its outcome is unknown. */
  readonly status:
    | 'started'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
}

export function validAttemptId(id: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    id,
  );
}

function timestamp(value: unknown): string {
  const result = text(value, 'attempt timestamp', 30);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error('Invalid attempt timestamp.');
  return new Date(result).toISOString();
}

function session(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 'native session', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result))
    throw new Error('Invalid native session.');
  return result;
}

export function parseAttempt(value: unknown, id: string): AttemptRecord {
  const data = object(value);
  if (
    data.schemaVersion !== 1 ||
    data.attemptId !== id ||
    (data.host !== 'claude' && data.host !== 'codex') ||
    (data.status !== 'started' &&
      data.status !== 'succeeded' &&
      data.status !== 'failed' &&
      data.status !== 'cancelled' &&
      data.status !== 'interrupted') ||
    (data.phase !== 'needs-plan' &&
      data.phase !== 'awaiting-plan-review' &&
      data.phase !== 'needs-research' &&
      data.phase !== 'directions')
  )
    throw new Error('Invalid attempt record.');
  validateModel(data.model === null ? undefined : data.model);
  if (data.model !== null && typeof data.model !== 'string')
    throw new Error('Missing requested model.');
  const finishedAt =
    data.finishedAt === null ? null : timestamp(data.finishedAt);
  // An interrupted attempt has no known finish time.
  if (
    (data.status === 'started' || data.status === 'interrupted') !==
    (finishedAt === null)
  )
    throw new Error('Inconsistent attempt outcome.');
  return {
    schemaVersion: 1,
    attemptId: id,
    host: data.host,
    model: data.model,
    phase: data.phase,
    status: data.status,
    requestedSessionId: session(data.requestedSessionId),
    nativeSessionId: session(data.nativeSessionId),
    startedAt: timestamp(data.startedAt),
    finishedAt,
    ...(data.observedAt === undefined
      ? {}
      : { observedAt: timestamp(data.observedAt) }),
  };
}

export interface ResearchReport {
  readonly summary: string;
  readonly delegation: string;
  readonly sources: readonly { readonly title: string; readonly url: string }[];
  readonly candidates: readonly Candidate[];
}

export function parseReport(value: unknown): ResearchReport {
  const data = object(value);
  if (
    !Array.isArray(data.sources) ||
    data.sources.length < 2 ||
    data.sources.length > 50
  ) {
    throw new Error('Research needs 2 to 50 web sources.');
  }
  const sources = data.sources.map((value: unknown) => {
    const source = object(value);
    return {
      title: text(source.title, 'source title', 500),
      url: sourceUrl(source.url),
    };
  });
  const candidates = parseCandidates(data.candidates);
  const urls = new Set(sources.map(({ url }) => url));
  for (const candidate of candidates) {
    if (
      !candidate.sources?.length ||
      candidate.sources.some((url) => !urls.has(url))
    ) {
      throw new Error(
        'Each direction must reference sources in the research report.',
      );
    }
  }
  return {
    summary: text(data.summary, 'research summary'),
    delegation: text(data.delegation, 'delegation report'),
    sources,
    candidates,
  };
}
