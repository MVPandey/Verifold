import { clip, type Post } from './board.ts';
import type { Call, LabView } from './lab.ts';
import { authorName, callWords, kindLabel } from './lab-words.ts';
import type { RunRecord } from './runs.ts';

/**
 * The lab's search, which the desk's panel and the API share: which posts,
 * runs, and calls match, and the part of each text that a hit shows.
 */

/** Hits that a search shows at most. */
export const searchLimit = 50;

/** Characters of a hit's text that show around its first match. */
export const snippetWidth = 160;

/**
 * UTF-8 bytes of whole post texts that one search shows. A hit past it shows
 * its start and where the whole post is, so the answer stays under its limit.
 */
export const searchTextBytes = 300_000;

/** The words of a search: one pattern for each word, and one that finds them all. */
export interface SearchWords {
  readonly each: readonly RegExp[];
  readonly any: RegExp;
}

/**
 * The words of a search as patterns that ignore case: one for each word,
 * and one that finds them all. Null when the search has no word.
 */
export function searchWords(q: string): SearchWords | null {
  const words = q.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return null;
  const sources = words.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return {
    each: sources.map((source) => new RegExp(source, 'iu')),
    any: new RegExp(sources.join('|'), 'giu'),
  };
}

/** A part of a hit's text: plain, or a match of the search. */
export interface SnippetPart {
  readonly text: string;
  readonly mark: boolean;
}

/** A text split at each match of `any`. */
export function markParts(text: string, any: RegExp): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const match of text.matchAll(any)) {
    if (match.index > at)
      parts.push({ text: text.slice(at, match.index), mark: false });
    parts.push({ text: match[0], mark: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}

/**
 * A text on one line around its first match, split at its matches. A text
 * cut at its start begins with "…". A cut never splits a character in two.
 */
export function snippetParts(text: string, any: RegExp): SnippetPart[] {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length <= snippetWidth) return markParts(flat, any);
  let start = Math.max(
    0,
    Math.min(flat.search(any) - 40, flat.length - snippetWidth),
  );
  if (/[\uDC00-\uDFFF]/u.test(flat.charAt(start))) start++;
  const parts = markParts(clip(flat.slice(start), snippetWidth), any);
  return start ? [{ text: '…', mark: false }, ...parts] : parts;
}

/** A post, run, or call that a search found, with the time that orders it. */
export type SearchHit =
  | { readonly at: string; readonly post: Post }
  | { readonly at: string; readonly run: RunRecord }
  | { readonly at: string; readonly call: Call };

/**
 * Search the lab: posts by their ID, kind, author, and text; runs by their
 * ID and command; and calls by their ID, kind, asker, question, options, and
 * the person's words. Each word must match, in any case. Returns every hit,
 * the newest first.
 */
export function searchLab(view: LabView, words: SearchWords): SearchHit[] {
  const found: SearchHit[] = [];
  const has = (text: string): boolean =>
    words.each.every((word) => word.test(text));
  for (const post of view.posts)
    if (
      has(
        `${post.id} ${post.kind} ${kindLabel(post)} ${authorName(view, post.author)} ${post.text}`,
      )
    )
      found.push({ at: post.at, post });
  for (const run of view.ledger)
    if (has(`${run.id} ${run.command}`))
      found.push({ at: run.startedAt ?? run.queuedAt, run });
  for (const call of view.state.calls)
    if (
      has(
        `${call.id} ${call.kind} ${callWords[call.kind]} ${authorName(view, call.by)} ${call.question} ${call.options.map((option) => option.label).join(' ')} ${call.words ?? ''}`,
      )
    )
      found.push({ at: call.at, call });
  found.sort((a, b) => b.at.localeCompare(a.at));
  return found;
}

/** The text of a call that a hit shows: its question and its options. */
export function callSearchText(call: Call): string {
  return `${call.question} (${call.options.map((option) => option.label).join(', ')})`;
}

/** Where a call stands, for a hit: "waits for you", or what the person chose. */
export function callState(call: Call): string {
  const chosen = call.answer
    ? call.options[call.answer.option]?.label
    : undefined;
  return call.state === 'open'
    ? 'waits for you'
    : call.state === 'withdrawn'
      ? 'withdrawn'
      : call.state === 'undoing'
        ? 'Verifold undoes your answer'
        : chosen === undefined && call.words
          ? `you answered "${clip(call.words, 120)}"`
          : `you chose "${chosen ?? ''}"`;
}

/** The note above the hits: what to type, none found, or how many. */
export function searchNote(words: SearchWords | null, found: number): string {
  return !words
    ? 'Type a word, an ID such as p-12 or r-3, or a part of a command.'
    : !found
      ? 'No post, run, or call has these words.'
      : found > searchLimit
        ? `The newest ${searchLimit} of ${found} hits. Add a word to find fewer.`
        : `${found} ${found === 1 ? 'hit' : 'hits'}, the newest first.`;
}
