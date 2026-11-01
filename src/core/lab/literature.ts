/**
 * What the lab read, from harness records: pure folds, with no lab. A lookup
 * comes from a harness's tool event, never from what an agent says. A harness
 * can log one call twice under one ID, so a lookup counts once for each call.
 * The reading map is what agents add with `verifold_source`.
 */
import { clip, object, type PostKind } from '../board.ts';
import { readingLimits } from '../lab-tools.ts';
import type { TranscriptUpdate } from '../transcript.ts';

export interface Lookup {
  readonly at: string;
  /** Its query or its address. */
  readonly title: string;
  readonly paper: boolean;
}

/** The lookups of one agent, with its subagents. */
export interface LookupRecord {
  readonly count: number;
  readonly papers: number;
  readonly last: Lookup | null;
  readonly lastPaper: Lookup | null;
  /** The newest calls, by launch and ID. Not saved: a call logs twice within one process. */
  readonly seen: readonly string[];
}

export const noLookups: LookupRecord = {
  count: 0,
  papers: 0,
  last: null,
  lastPaper: null,
  seen: [],
};

/** The tools that read the web, by the names that the harnesses report. */
const lookupTools: ReadonlySet<string> = new Set([
  'WebSearch',
  'WebFetch',
  'Web search',
]);

/** Sites that hold papers, and their subdomains. A model page or a price page is not a paper. */
const paperHost =
  /(?:^|\.)(?:arxiv\.org|alphaxiv\.org|biorxiv\.org|medrxiv\.org|openreview\.net|aclanthology\.org|doi\.org|semanticscholar\.org|scholar\.google\.com|proceedings\.mlr\.press|neurips\.cc|nips\.cc|jmlr\.org|thecvf\.com|ieeexplore\.ieee\.org|dl\.acm\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|ncbi\.nlm\.nih\.gov|ssrn\.com|transformer-circuits\.pub)$/;

/** Words in a search that asks for papers. */
const paperQuery =
  /\b(?:arxiv|preprints?|papers?|literature|et al|proceedings|neurips|icml|iclr|aclweb|doi|\d{4}\.\d{4,5})\b/i;

/** Whether a lookup reads a paper or searches for one: its address is on a paper site, or its query asks for papers. */
export function isPaperLookup(title: string): boolean {
  if (!/^https?:\/\//i.test(title)) return paperQuery.test(title);
  try {
    const url = new URL(title);
    return (
      paperHost.test(url.hostname) ||
      (url.hostname === 'huggingface.co' && url.pathname.startsWith('/papers'))
    );
  } catch {
    return false;
  }
}

/**
 * The call and its query, when a harness update reports a web lookup. Codex
 * starts a search with no query and gives it with the end of the call, so a
 * running call with no query waits for that update. A call that opens a page
 * can end with no query: it counts, with the site of its result.
 */
export function lookupOf(
  update: TranscriptUpdate,
): { readonly id: string; readonly title: string } | null {
  if (!update.id || !update.name || !lookupTools.has(update.name)) return null;
  const title =
    update.title ||
    (/"domain":\s*"([^"]+)"/.exec(update.output ?? '')?.[1] ?? '');
  return title || update.status !== 'running' ? { id: update.id, title } : null;
}

/** The record with one more lookup, or the same record for a call that it counted. `key` tells a call from every other call of the agent. */
export function withLookup(
  record: LookupRecord,
  key: string,
  title: string,
  at: string,
): LookupRecord {
  if (record.seen.includes(key)) return record;
  const paper = isPaperLookup(title);
  const lookup: Lookup = {
    at,
    title: clip(title, readingLimits.lookup),
    paper,
  };
  return {
    count: record.count + 1,
    papers: record.papers + (paper ? 1 : 0),
    last: lookup,
    lastPaper: paper ? lookup : record.lastPaper,
    seen: [...record.seen, key].slice(-readingLimits.seen),
  };
}

const newer = (a: Lookup | null, b: Lookup | null): Lookup | null =>
  a && b ? (Date.parse(a.at) >= Date.parse(b.at) ? a : b) : (a ?? b);

/** The lab's record: the sum of its agents' records. */
export function labLookups(records: readonly LookupRecord[]): LookupRecord {
  return records.reduce(
    (lab, record) => ({
      count: lab.count + record.count,
      papers: lab.papers + record.papers,
      last: newer(lab.last, record.last),
      lastPaper: newer(lab.lastPaper, record.lastPaper),
      seen: [],
    }),
    noLookups,
  );
}

/**
 * A post that shows "No search yet": a proposal or a ruled-out post whose
 * author made no lookup since its last such post. `previous`: the time of
 * that post. The mark blocks nothing.
 */
export function noSearchYet(
  kind: PostKind,
  last: Lookup | null,
  previous: string | undefined,
): boolean {
  if (kind !== 'proposal' && kind !== 'ruled-out') return false;
  return (
    !last ||
    (previous !== undefined && Date.parse(last.at) <= Date.parse(previous))
  );
}

function parseLookup(value: unknown): Lookup | null {
  const entry = object(value);
  return entry &&
    typeof entry.at === 'string' &&
    !Number.isNaN(Date.parse(entry.at)) &&
    typeof entry.title === 'string'
    ? {
        at: entry.at,
        title: entry.title.slice(0, readingLimits.lookup),
        paper: entry.paper === true,
      }
    : null;
}

const count = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;

/** A saved record, or null. A harness can write in the project, so every field is checked. */
export function parseLookups(value: unknown): LookupRecord | null {
  const entry = object(value);
  return entry
    ? {
        count: count(entry.count),
        papers: count(entry.papers),
        last: parseLookup(entry.last),
        lastPaper: parseLookup(entry.lastPaper),
        seen: [],
      }
    : null;
}

/** A paper on the reading map. */
export interface Source {
  /** `s-N`. */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** The paper's date, as its source gives it. */
  readonly date: string;
  readonly by: string;
  readonly at: string;
}

/** A saved paper, or null. */
export function parseSource(value: unknown): Source | null {
  const entry = object(value);
  return entry &&
    typeof entry.id === 'string' &&
    /^s-[1-9]\d{0,5}$/.test(entry.id) &&
    typeof entry.title === 'string' &&
    entry.title &&
    typeof entry.url === 'string' &&
    /^https?:\/\//i.test(entry.url) &&
    typeof entry.date === 'string' &&
    typeof entry.by === 'string' &&
    typeof entry.at === 'string' &&
    !Number.isNaN(Date.parse(entry.at))
    ? {
        id: entry.id,
        title: entry.title.slice(0, readingLimits.title),
        url: entry.url.slice(0, readingLimits.url),
        date: entry.date.slice(0, readingLimits.date),
        by: entry.by.slice(0, 20),
        at: entry.at,
      }
    : null;
}
