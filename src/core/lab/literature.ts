/**
 * What the lab read, from harness records: pure folds, with no lab. A lookup
 * comes from a harness's report of a web read, never from what an agent says.
 * It counts when its result succeeds: a call that a harness denied or that
 * failed read nothing. A harness can log one call twice under one ID, so a
 * lookup counts once for each call. The reading map is what agents add with
 * `verifold_source`.
 */
import { clip, object, type PostKind } from '../board.ts';
import { readingLimits } from '../lab-tools.ts';
import type { WebRead } from '../transcript.ts';

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
  /** Calls with no result yet, and the newest calls that counted, by launch and ID. Not saved: a call logs within one process. */
  readonly pending: readonly { readonly key: string; readonly title: string }[];
  readonly seen: readonly string[];
}

export const noLookups: LookupRecord = {
  count: 0,
  papers: 0,
  last: null,
  lastPaper: null,
  pending: [],
  seen: [],
};

/** Sites that hold papers, and their subdomains. A model page or a price page is not a paper. */
const paperHost =
  /(?:^|\.)(?:arxiv\.org|alphaxiv\.org|biorxiv\.org|medrxiv\.org|openreview\.net|aclanthology\.org|doi\.org|semanticscholar\.org|scholar\.google\.com|proceedings\.mlr\.press|neurips\.cc|nips\.cc|jmlr\.org|thecvf\.com|ieeexplore\.ieee\.org|dl\.acm\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|ncbi\.nlm\.nih\.gov|ssrn\.com|transformer-circuits\.pub)$/;

/** Words in a search that asks for papers. */
const paperQuery =
  /\b(?:arxiv|preprints?|papers?|literature|et al|proceedings|neurips|icml|iclr|aclweb|doi|\d{4}\.\d{4,5})\b/i;

/** The address in a lookup with or without its scheme, or null for words that are no address. */
function addressOf(title: string): URL | null {
  if (!title || /\s/.test(title)) return null;
  try {
    return new URL(/^https?:\/\//i.test(title) ? title : `https://${title}`);
  } catch {
    return null;
  }
}

/** Whether a lookup reads a paper or searches for one: its address or bare site is a paper site, or its query asks for papers. */
export function isPaperLookup(title: string): boolean {
  const url = addressOf(title);
  if (
    url &&
    (paperHost.test(url.hostname) ||
      (url.hostname === 'huggingface.co' && url.pathname.startsWith('/papers')))
  )
    return true;
  return !/^https?:\/\//i.test(title) && paperQuery.test(title);
}

/**
 * The record after one report of a web read. `key` tells a call from every
 * other call of the agent. A call waits with its query until its result: a
 * success counts, and a failure drops it. A result of any other tool, or of a
 * call that counted, changes nothing and returns the same record.
 */
export function afterRead(
  record: LookupRecord,
  key: string,
  read: WebRead,
  at: string,
): LookupRecord {
  if (record.seen.includes(key)) return record;
  const waiting = record.pending.find((entry) => entry.key === key);
  if (!read.named && !waiting) return record;
  const pending = record.pending.filter((entry) => entry !== waiting);
  const title = read.title || (waiting?.title ?? '');
  if (read.status === 'running')
    return {
      ...record,
      pending: [...pending, { key, title }].slice(-readingLimits.seen),
    };
  if (read.status === 'failed') return { ...record, pending };
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
    pending,
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
      pending: [],
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
        pending: [],
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
